import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadServicePrincipalCredential,
  parseServicePrincipalCredential,
  servicePrincipalTokenSource,
} from '@noblecloak/client/service-principal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USAGE } from './cli.js';
import { config, completeSignIn, run } from './harness.test-support.js';
import type * as CredentialFile from './credential-file.js';
import type * as Keys from './keys.js';
import {
  ACCESS_TOKEN,
  CODE,
  ORG,
  REFRESH_TOKEN,
  SP,
  principal,
  startStub,
  type Stub,
} from './stub.test-support.js';

// Records every key the command generates, so the secrets test knows each private `d` to look for.
const generated: Keys.GeneratedKey[] = [];
vi.mock('./keys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Keys>();
  return {
    ...actual,
    generateKey: async () => {
      const key = await actual.generateKey();
      generated.push(key);
      return key;
    },
  };
});

// Let a test make the local write fail after the server has accepted the request.
let replaceFails = false;
let writeFails = false;
vi.mock('./credential-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CredentialFile>();
  return {
    ...actual,
    writeNewCredential: async (path: string, credential: object) => {
      if (writeFails) throw Object.assign(new Error('disk'), { code: 'EIO' });
      await actual.writeNewCredential(path, credential);
    },
    replaceCredential: async (path: string, credential: object) => {
      if (replaceFails) throw Object.assign(new Error('disk'), { code: 'EIO' });
      await actual.replaceCredential(path, credential);
    },
  };
});

let stub: Stub;
let dir: string;

beforeEach(async () => {
  stub = await startStub();
  dir = await mkdtemp(join(tmpdir(), 'nc-cli-'));
  generated.length = 0;
  replaceFails = false;
  writeFails = false;
});

afterEach(async () => {
  await stub.close();
  await rm(dir, { recursive: true, force: true });
});

const createArgs = (out: string, extra: string[] = []): string[] => [
  'sp',
  'create',
  '--org',
  ORG,
  '--name',
  'ci agent',
  '--audience',
  'https://govern.example.com',
  '--out',
  out,
  ...extra,
];

const revocations = (): URLSearchParams[] =>
  stub.requests.filter((r) => r.path === '/auth/oauth/revoke').flatMap((r) => r.form ?? []);

const apiCalls = (): string[] =>
  stub.requests
    .filter((r) => r.path.startsWith('/organizations/'))
    .map((r) => `${r.method} ${r.path}`);

const spPath = `/organizations/${ORG}/service-principals`;

describe('sp create', () => {
  it('signs in on loopback with PKCE and the admin resource, writes a 0600 credential the SDK loads, and revokes the refresh token', async () => {
    const out = join(dir, 'cred.json');
    const result = await run(stub, [
      ...createArgs(out, ['--expires-in-days', '30']),
      ...config(stub),
    ]);
    expect(result.code, result.stderr).toBe(0);

    const authorize = result.opened[0];
    expect(authorize?.pathname).toBe('/auth/oauth/authorize');
    const params = authorize?.searchParams;
    const redirect = new URL(params?.get('redirect_uri') ?? '');
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(redirect.pathname).toBe('/callback');
    expect(redirect.search).toBe('');
    expect(params?.get('client_id')).toBe('noblecloak-cli');
    expect(params?.get('code_challenge_method')).toBe('S256');
    expect(params?.get('resource')).toBe('https://admin.example.com');
    expect(params?.get('scope')).toBe('service_principals:manage');
    expect(params?.get('response_type')).toBe('code');
    expect((params?.get('state') ?? '').length).toBeGreaterThanOrEqual(22); // 128 bits in base64url
    expect(stub.verifier?.length).toBeGreaterThanOrEqual(43);
    expect(
      createHash('sha256')
        .update(stub.verifier ?? '')
        .digest('base64url')
    ).toBe(params?.get('code_challenge'));
    const token = stub.requests.find((r) => r.path === '/auth/oauth/token');
    expect(token?.form?.get('resource')).toBe('https://admin.example.com');
    expect(token?.form?.get('redirect_uri')).toBe(redirect.href);

    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const file = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>;
    const credential = parseServicePrincipalCredential(file);
    expect(credential.client_id).toBe(`sp_${SP}`);
    expect(file).toMatchObject({ sp_id: SP, org_id: ORG, name: 'ci agent' });
    expect(file.private_jwk).toMatchObject({ kid: generated[0]?.privateJwk.kid });

    const post = stub.requests.find((r) => r.method === 'POST' && r.path === spPath);
    expect(post?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(post?.json).toMatchObject({
      name: 'ci agent',
      allowed_audiences: ['https://govern.example.com'],
      expires_in_days: 30,
    });
    expect(post?.json).not.toHaveProperty('scopes');
    expect(revocations().map((f) => f.get('token'))).toEqual([REFRESH_TOKEN]);
    expect(result.stdout).toContain(`export NOBLECLOAK_SP_CREDENTIALS=${out}`);
    expect(result.stdout).toContain(`sp_${SP}`);
  });

  it('sends only the public members of the key (no d, p, q, dp, dq, qi)', async () => {
    const out = join(dir, 'cred.json');
    await run(stub, [...createArgs(out), ...config(stub)]);
    const jwk = stub.requests.find((r) => r.method === 'POST' && r.path === spPath)?.json
      ?.public_jwk as Record<string, unknown>;
    expect(Object.keys(jwk).sort()).toEqual(['alg', 'crv', 'kty', 'use', 'x', 'y']);
    for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi']) expect(jwk).not.toHaveProperty(member);
  });

  it('writes a credential the SDK token source can use against the registered public key', async () => {
    const out = join(dir, 'cred.json');
    await run(stub, [...createArgs(out), ...config(stub)]);
    const credential = parseServicePrincipalCredential(JSON.parse(await readFile(out, 'utf8')));
    const source = servicePrincipalTokenSource(credential, {
      audience: 'https://govern.example.com',
    });
    // The stub verifies the ES256 assertion against the public JWK the CLI registered.
    await expect(source.getToken()).resolves.toBe('sp-access');
  });

  it('forwards --scope and --audience repeats', async () => {
    const out = join(dir, 'cred.json');
    await run(stub, [
      ...createArgs(out, ['--audience', 'https://other.example.com', '--scope', 'module_api']),
      ...config(stub),
    ]);
    expect(stub.requests.find((r) => r.path === spPath && r.method === 'POST')?.json).toMatchObject(
      {
        allowed_audiences: ['https://govern.example.com', 'https://other.example.com'],
        scopes: ['module_api'],
      }
    );
  });

  it('refuses an existing --out before any network call', async () => {
    const out = join(dir, 'cred.json');
    await writeFile(out, 'keep me');
    const result = await run(stub, [...createArgs(out), ...config(stub)]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('already exists');
    expect(stub.requests).toHaveLength(0);
    expect(result.opened).toHaveLength(0);
    expect(await readFile(out, 'utf8')).toBe('keep me');
  });

  it('refuses a --out whose directory does not exist before signing in', async () => {
    const result = await run(stub, [
      ...createArgs(join(dir, 'missing', 'cred.json')),
      ...config(stub),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('directory cannot be examined (ENOENT)');
    expect(stub.requests).toHaveLength(0);
    expect(result.opened).toHaveLength(0);
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses a --out in a directory that is not writable before signing in',
    async () => {
      await chmod(dir, 0o500);
      try {
        const result = await run(stub, [...createArgs(join(dir, 'cred.json')), ...config(stub)]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('not writable');
        expect(stub.requests).toHaveLength(0);
      } finally {
        await chmod(dir, 0o700);
      }
    }
  );

  it('refuses a --out whose parent is a file before signing in', async () => {
    const file = join(dir, 'plain-parent');
    await writeFile(file, 'x');
    const out = join(file, 'sub', 'cred.json');
    const result = await run(stub, [...createArgs(out), ...config(stub)]);
    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });

  it('names the cause, not "already exists", when --out cannot be examined', async () => {
    const file = join(dir, 'plain');
    await writeFile(file, 'x');
    const result = await run(stub, [...createArgs(join(file, 'cred.json')), ...config(stub)]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('cannot be examined (ENOTDIR)');
    expect(result.stderr).not.toContain('already exists');
    expect(stub.requests).toHaveLength(0);
  });

  it('writes no file and prints the revoke instruction when the registration has a null token_endpoint', async () => {
    stub.registration = { token_endpoint: null, assertion_audience: stub.url };
    const out = join(dir, 'cred.json');
    const result = await run(stub, [...createArgs(out), ...config(stub)]);
    expect(result.code).toBe(1);
    expect(await readdir(dir)).toEqual([]);
    expect(result.stderr).toContain(`noblecloak sp revoke --org ${ORG} --sp ${SP}`);
    expect(revocations()).toHaveLength(1);
  });

  it('writes no file and prints the revoke instruction when the assertion_audience is null', async () => {
    stub.registration = {
      token_endpoint: `${stub.url}/auth/oauth/token`,
      assertion_audience: null,
    };
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)]);
    expect(result.code).toBe(1);
    expect(await readdir(dir)).toEqual([]);
    expect(result.stderr).toContain(`--sp ${SP}`);
  });

  it('tells the user to revoke when the file cannot be created after the server accepted', async () => {
    writeFails = true;
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('(EIO)');
    expect(result.stderr).toContain(`noblecloak sp revoke --org ${ORG} --sp ${SP}`);
  });

  it('prints one JSON object with --json', async () => {
    const out = join(dir, 'cred.json');
    const result = await run(stub, [...createArgs(out, ['--json']), ...config(stub)]);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body).toMatchObject({ client_id: `sp_${SP}`, sp_id: SP, path: out });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });

  it.each([
    [['--org', 'not-a-uuid'], '--org must be a UUID'],
    [['--expires-in-days', '0'], '--expires-in-days'],
    [['--expires-in-days', '366'], '--expires-in-days'],
    [['--expires-in-days', '1.5'], '--expires-in-days'],
    [['--bogus'], 'bogus'],
  ])('refuses %j with exit 2', async (extra, message) => {
    const args = createArgs(join(dir, 'c.json')).concat(extra);
    const result = await run(stub, [...args, ...config(stub)]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(stub.requests).toHaveLength(0);
  });

  it('requires at least one audience and a name', async () => {
    const noAudience = await run(stub, [
      'sp',
      'create',
      '--org',
      ORG,
      '--name',
      'x',
      '--out',
      join(dir, 'a.json'),
      ...config(stub),
    ]);
    expect(noAudience.code).toBe(2);
    const noName = await run(stub, [
      'sp',
      'create',
      '--org',
      ORG,
      '--audience',
      'https://g.example.com',
      '--out',
      join(dir, 'b.json'),
      ...config(stub),
    ]);
    expect(noName.code).toBe(2);
    expect(noName.stderr).toContain('--name');
  });
});

describe('configuration', () => {
  it('exits 2 naming both the flag and the variable when the auth URL is missing', async () => {
    const result = await run(stub, createArgs(join(dir, 'c.json')));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--auth-url');
    expect(result.stderr).toContain('NOBLECLOAK_AUTH_URL');
  });

  it('exits 2 naming both the flag and the variable when the admin audience is missing', async () => {
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), '--auth-url', stub.url]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--admin-audience');
    expect(result.stderr).toContain('NOBLECLOAK_ADMIN_AUDIENCE');
  });

  it('reads both from the environment', async () => {
    const out = join(dir, 'c.json');
    const result = await run(stub, createArgs(out), {
      env: {
        NOBLECLOAK_AUTH_URL: `${stub.url}/`,
        NOBLECLOAK_ADMIN_AUDIENCE: 'https://admin.example.com',
      },
    });
    expect(result.code, result.stderr).toBe(0);
  });

  it('refuses a plain-http auth URL that is not loopback', async () => {
    const result = await run(stub, [
      ...createArgs(join(dir, 'c.json')),
      '--auth-url',
      'http://auth.example.com',
      '--admin-audience',
      'https://admin.example.com',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('https');
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses an auth URL that is not a URL', async () => {
    const result = await run(stub, [
      ...createArgs(join(dir, 'c.json')),
      '--auth-url',
      'nope',
      '--admin-audience',
      'x',
    ]);
    expect(result.code).toBe(2);
  });
});

describe('sign-in', () => {
  it('ignores a callback with the wrong state, keeps waiting, then accepts the right one', async () => {
    const out = join(dir, 'c.json');
    let wrongStatus = 0;
    const result = await run(stub, [...createArgs(out), ...config(stub)], {
      browser: async (authorize, s) => {
        const wrong = new URL(authorize.searchParams.get('redirect_uri') ?? '');
        wrong.searchParams.set('code', 'attacker-code');
        wrong.searchParams.set('state', 'wrong');
        wrongStatus = (await fetch(wrong)).status;
        await completeSignIn(authorize, s);
      },
    });
    expect(wrongStatus).toBe(400);
    expect(result.code, result.stderr).toBe(0);
    const exchanged = stub.requests.filter((r) => r.path === '/auth/oauth/token');
    expect(exchanged).toHaveLength(1);
    expect(exchanged[0]?.form?.get('code')).toBe(CODE);
  });

  it('answers other paths with 404 and accepts one callback only', async () => {
    let other = 0;
    let second = 0;
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)], {
      browser: async (authorize, s) => {
        const base = new URL(authorize.searchParams.get('redirect_uri') ?? '');
        other = (await fetch(new URL('/other', base))).status;
        await completeSignIn(authorize, s);
        const again = new URL(base);
        again.searchParams.set('code', 'second');
        again.searchParams.set('state', authorize.searchParams.get('state') ?? '');
        // The listener is closed after the first callback, so a second request cannot connect.
        second = await fetch(again).then(
          (r) => r.status,
          () => -1
        );
      },
    });
    expect(other).toBe(404);
    expect(second).toBe(-1);
    expect(result.code, result.stderr).toBe(0);
  });

  it('exits 3 on timeout and ends without a token to revoke', async () => {
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)], {
      signInTimeoutMs: 100,
      browser: () => Promise.resolve(),
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('timed out');
    expect(revocations()).toHaveLength(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it('exits 3 when the user cancels', async () => {
    const abort = new AbortController();
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)], {
      signal: abort.signal,
      browser: () => {
        abort.abort();
        return Promise.resolve();
      },
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('cancelled');
  });

  it('exits 3 when the command starts already cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)], {
      signal: abort.signal,
    });
    expect(result.code).toBe(3);
  });

  it('exits 3 when the authorization server reports an error with the right state', async () => {
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)], {
      browser: async (authorize) => {
        const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('state', authorize.searchParams.get('state') ?? '');
        await fetch(redirect);
      },
    });
    expect(result.code).toBe(3);
    expect(apiCalls()).toEqual([]);
  });

  it('exits 3 when the token endpoint refuses the code', async () => {
    stub.tokenStatus = 400;
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('400');
  });

  it('prints the URL and does not open a browser with --no-open', async () => {
    const result = await run(
      stub,
      [...createArgs(join(dir, 'c.json'), ['--no-open']), ...config(stub)],
      {
        printedUrlOnly: true,
      }
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('/auth/oauth/authorize?');
  });

  it('still succeeds when the opener throws, because the URL is printed', async () => {
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)], {
      openUrlThrows: true,
    });
    // The stand-in browser works from the URL on stderr, because the opener threw.
    expect(result.stderr).toContain('/auth/oauth/authorize?');
    expect(result.code, result.stderr).toBe(0);
  });

  it('fails with exit 1 when the metadata lacks the admin scope', async () => {
    stub.scopesSupported = ['module_api'];
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('service_principals:manage');
    expect(result.opened).toHaveLength(0);
  });

  it.each([
    ['names another issuer', 'https://evil.example.com'],
    ['names no issuer', null],
  ])('refuses before sign-in when the metadata %s', async (_name, issuer) => {
    stub.issuer = issuer;
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('issuer');
    expect(result.opened).toHaveLength(0);
    expect(stub.requests.map((r) => r.path)).toEqual(['/.well-known/oauth-authorization-server']);
  });

  it('accepts an issuer that differs from --auth-url only by a trailing slash', async () => {
    stub.issuer = `${stub.url}/`;
    const result = await run(stub, ['sp', 'list', '--org', ORG, ...config(stub)]);
    expect(result.code, result.stderr).toBe(0);
  });

  it('proceeds when the metadata lists no scopes at all', async () => {
    stub.scopesSupported = undefined;
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)]);
    expect(result.code, result.stderr).toBe(0);
  });
});

describe('exit codes', () => {
  it('maps 403 to 4 and still revokes the refresh token', async () => {
    stub.overrides.set('POST service-principals', {
      status: 403,
      body: { success: false, error: { code: 'FORBIDDEN', message: 'not an admin' } },
    });
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('FORBIDDEN');
    expect(revocations().map((f) => f.get('token'))).toEqual([REFRESH_TOKEN]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('maps a 401 from the API to 3', async () => {
    stub.overrides.set('POST service-principals', {
      status: 401,
      body: { error: 'invalid_token' },
    });
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)]);
    expect(result.code).toBe(3);
  });

  it('maps a 409 and a 400 to 1 and shows the server code and message', async () => {
    for (const [status, code] of [
      [409, 'CONFLICT'],
      [400, 'INVALID_PUBLIC_KEY'],
    ] as const) {
      stub.overrides.set('POST service-principals', {
        status,
        body: { success: false, error: { code, message: 'because' } },
      });
      const result = await run(stub, [...createArgs(join(dir, `${code}.json`)), ...config(stub)]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${code}: because`);
    }
  });

  it('maps an unparseable error body to 1', async () => {
    stub.overrides.set('POST service-principals', { status: 500, body: 'oops' });
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('UNKNOWN');
  });

  it('maps an unexpected success body to 1', async () => {
    stub.overrides.set('POST service-principals', {
      status: 201,
      body: { success: true, data: { id: 1 } },
    });
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unexpected response');
  });

  it('maps an unreachable server to 1', async () => {
    const result = await run(stub, [
      ...createArgs(join(dir, 'c.json')),
      '--auth-url',
      'http://127.0.0.1:1',
      '--admin-audience',
      'x',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Cannot reach');
  });

  it('maps an unreachable API (after a good sign-in) to 1 and still revokes the refresh token', async () => {
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)], {
      apiUnreachable: true,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Cannot reach the server');
    expect(result.stderr).toContain('the request was not sent');
    expect(revocations()).toHaveLength(1);
  });

  it('exits 2 for an unknown command and 0 for help', async () => {
    expect((await run(stub, ['nope'])).code).toBe(2);
    expect((await run(stub, ['sp', 'nope'])).code).toBe(2);
    for (const argv of [[], ['--help'], ['sp'], ['sp', '--help'], ['sp', 'list', '-h']]) {
      const help = await run(stub, argv);
      expect(help.code).toBe(0);
      expect(help.stdout).toBe(USAGE);
    }
  });

  it('exits 2 for a stray positional argument', async () => {
    const result = await run(stub, ['sp', 'list', 'extra', '--org', ORG, ...config(stub)]);
    expect(result.code).toBe(2);
  });
});

describe('sp list', () => {
  it('prints a table with shortened thumbprints', async () => {
    const result = await run(stub, ['sp', 'list', '--org', ORG, ...config(stub)]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(SP);
    expect(result.stdout).toContain('ci agent');
    expect(result.stdout).toContain('01234567');
    expect(result.stdout).not.toContain('0123456789abcdef');
    expect(apiCalls()).toEqual([`GET ${spPath}`]);
  });

  it('prints full thumbprints with --json', async () => {
    const result = await run(stub, ['sp', 'list', '--org', ORG, '--json', ...config(stub)]);
    const body = JSON.parse(result.stdout) as {
      service_principals: { key_thumbprints: string[] }[];
    };
    expect(body.service_principals[0]?.key_thumbprints[0]).toBe(
      '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'
    );
  });

  it('says so when there are none', async () => {
    stub.overrides.set('GET service-principals', {
      status: 200,
      body: { success: true, data: { service_principals: [] } },
    });
    const result = await run(stub, ['sp', 'list', '--org', ORG, ...config(stub)]);
    expect(result.stdout).toContain('No service principals');
  });

  it('exits 1 when the list is malformed', async () => {
    stub.overrides.set('GET service-principals', {
      status: 200,
      body: { success: true, data: {} },
    });
    const result = await run(stub, ['sp', 'list', '--org', ORG, ...config(stub)]);
    expect(result.code).toBe(1);
  });
});

describe('server text on the terminal', () => {
  // An escape sequence that clears the line and writes another name, a C1 CSI, a bell and a carriage return.
  const HOSTILE = 'evil\u001b[2K\rci agent\u009b31m\u0007';
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

  it('strips control characters from a name in the list table', async () => {
    stub.overrides.set('GET service-principals', {
      status: 200,
      body: { success: true, data: { service_principals: [principal({ name: HOSTILE })] } },
    });
    const result = await run(stub, ['sp', 'list', '--org', ORG, ...config(stub)]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('evil[2Kci agent31m');
    expect(result.stdout).not.toMatch(CONTROL);
  });

  it('strips them from the revoke prompt', async () => {
    stub.overrides.set('GET service-principals', {
      status: 200,
      body: { success: true, data: { service_principals: [principal({ name: HOSTILE })] } },
    });
    const result = await run(stub, ['sp', 'revoke', '--org', ORG, '--sp', SP, ...config(stub)], {
      stdinIsTTY: true,
      answers: ['n'],
    });
    expect(result.prompts[0]).toContain('evil[2Kci agent31m');
    expect(result.prompts[0]).not.toMatch(CONTROL);
  });

  it("strips them from a server error's code and message", async () => {
    stub.overrides.set('GET service-principals', {
      status: 403,
      body: { success: false, error: { code: 'FORBIDDEN\u001b[8m', message: HOSTILE } },
    });
    const result = await run(stub, ['sp', 'list', '--org', ORG, ...config(stub)]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('evil[2Kci agent31m');
    expect(result.stderr).not.toMatch(CONTROL);
  });

  // A name that starts a fake line of output, and one that reverses its own characters on screen.
  const FAKE_LINE = 'ci agent\nRevoked. Delete the local credential file';
  const REVERSED = 'ci \u202etnega\u202c agent\u2028';

  it('keeps a name with a newline or bidi marks on its own line in the table', async () => {
    stub.overrides.set('GET service-principals', {
      status: 200,
      body: {
        success: true,
        data: {
          service_principals: [principal({ name: FAKE_LINE }), principal({ name: REVERSED })],
        },
      },
    });
    const result = await run(stub, ['sp', 'list', '--org', ORG, ...config(stub)]);
    expect(result.code, result.stderr).toBe(0);
    // A header and one line per principal: the newline in the name did not add a line.
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(3);
    expect(result.stdout).toContain('ci agent Revoked. Delete the local credential file');
    expect(result.stdout).toContain('ci tnega agent');
    expect(result.stdout).not.toMatch(/[\u2028\u202a-\u202e]/);
  });

  it('keeps the revoke prompt and a server error on one line', async () => {
    stub.overrides.set('GET service-principals', {
      status: 200,
      body: { success: true, data: { service_principals: [principal({ name: FAKE_LINE })] } },
    });
    const prompted = await run(stub, ['sp', 'revoke', '--org', ORG, '--sp', SP, ...config(stub)], {
      stdinIsTTY: true,
      answers: ['n'],
    });
    expect(prompted.prompts[0]).not.toContain('\n');
    stub.overrides.set('GET service-principals', {
      status: 500,
      body: { success: false, error: { code: 'BOOM', message: 'failed\nRevoked.' } },
    });
    const failed = await run(stub, ['sp', 'list', '--org', ORG, ...config(stub)]);
    expect(failed.stderr).toContain('failed Revoked.');
  });

  it('keeps --json output parseable with the name intact', async () => {
    stub.overrides.set('GET service-principals', {
      status: 200,
      body: { success: true, data: { service_principals: [principal({ name: HOSTILE })] } },
    });
    const result = await run(stub, ['sp', 'list', '--org', ORG, '--json', ...config(stub)]);
    const body = JSON.parse(result.stdout) as { service_principals: { name: string }[] };
    expect(body.service_principals[0]?.name).toBe(HOSTILE);
    expect(result.stdout).not.toMatch(CONTROL);
  });
});

describe('sp rotate', () => {
  const seed = async (): Promise<string> => {
    const out = join(dir, 'cred.json');
    const created = await run(stub, [...createArgs(out), ...config(stub)]);
    expect(created.code, created.stderr).toBe(0);
    stub.requests.length = 0;
    return out;
  };

  it('replaces the file after a 2xx: new key, same mode, other fields kept, no temp files', async () => {
    const out = await seed();
    const before = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>;
    const result = await run(stub, [
      'sp',
      'rotate',
      '--credentials',
      out,
      '--revoke-previous',
      '--expires-in-days',
      '10',
      ...config(stub),
    ]);
    expect(result.code, result.stderr).toBe(0);
    const after = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>;
    expect((after.private_jwk as { d: string }).d).not.toBe(
      (before.private_jwk as { d: string }).d
    );
    expect((after.private_jwk as { kid: string }).kid).toBe(generated[1]?.privateJwk.kid);
    expect(after).toMatchObject({
      sp_id: SP,
      org_id: ORG,
      name: 'ci agent',
      client_id: `sp_${SP}`,
    });
    parseServicePrincipalCredential(after);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['cred.json']);
    const post = stub.requests.find((r) => r.path.endsWith('/rotate'));
    expect(post?.path).toBe(`${spPath}/${SP}/rotate`);
    expect(post?.json).toMatchObject({ revoke_previous: true, expires_in_days: 10 });
    expect(Object.keys(post?.json?.public_jwk as object).sort()).toEqual([
      'alg',
      'crv',
      'kty',
      'use',
      'x',
      'y',
    ]);
    expect(revocations()).toHaveLength(1);
  });

  it('does not send revoke_previous unless asked', async () => {
    const out = await seed();
    await run(stub, ['sp', 'rotate', '--credentials', out, ...config(stub)]);
    const post = stub.requests.find((r) => r.path.endsWith('/rotate'));
    expect(post?.json).not.toHaveProperty('revoke_previous');
    expect(post?.json).not.toHaveProperty('expires_in_days');
  });

  it.each([
    [403, 4],
    [401, 3],
    [409, 1],
    [500, 1],
  ])('leaves the file byte-identical on a %i answer (exit %i)', async (status, exit) => {
    const out = await seed();
    const before = await readFile(out);
    stub.overrides.set('POST rotate', {
      status,
      body: { success: false, error: { code: 'X', message: 'no' } },
    });
    const result = await run(stub, ['sp', 'rotate', '--credentials', out, ...config(stub)]);
    expect(result.code).toBe(exit);
    expect(Buffer.compare(await readFile(out), before)).toBe(0);
    expect(await readdir(dir)).toEqual(['cred.json']);
    expect(revocations()).toHaveLength(1);
  });

  it('leaves the file unchanged when the registration comes back with a null token_endpoint', async () => {
    const out = await seed();
    const before = await readFile(out);
    stub.registration = { token_endpoint: null, assertion_audience: stub.url };
    const result = await run(stub, ['sp', 'rotate', '--credentials', out, ...config(stub)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('issuer is unset');
    expect(Buffer.compare(await readFile(out), before)).toBe(0);
  });

  it('says the old file still works when the replacement fails after a plain rotation', async () => {
    const out = await seed();
    const before = await readFile(out);
    replaceFails = true;
    const result = await run(stub, ['sp', 'rotate', '--credentials', out, ...config(stub)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('left unchanged and still works');
    expect(result.stderr).toContain('Run the rotation again');
    expect(Buffer.compare(await readFile(out), before)).toBe(0);
  });

  it('says the principal must be revoked when the replacement fails after --revoke-previous', async () => {
    const out = await seed();
    replaceFails = true;
    const result = await run(stub, [
      'sp',
      'rotate',
      '--credentials',
      out,
      '--revoke-previous',
      ...config(stub),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('retired the previous keys');
    expect(result.stderr).toContain(`noblecloak sp revoke --org ${ORG} --sp ${SP}`);
    expect(result.stderr).toContain('create a new one');
    expect(result.stderr).not.toContain('Run the rotation again');
    expect(result.stderr).not.toContain('still works');
  });

  it('says the principal must be revoked when the issuer is unset after --revoke-previous', async () => {
    const out = await seed();
    stub.registration = { token_endpoint: null, assertion_audience: null };
    const result = await run(stub, [
      'sp',
      'rotate',
      '--credentials',
      out,
      '--revoke-previous',
      ...config(stub),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('issuer is unset');
    expect(result.stderr).toContain(`noblecloak sp revoke --org ${ORG} --sp ${SP}`);
    expect(result.stderr).not.toContain('Run the rotation again');
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses before any network call when the credential directory is not writable',
    async () => {
      const out = await seed();
      const before = await readFile(out);
      await chmod(dir, 0o500);
      try {
        const result = await run(stub, [
          'sp',
          'rotate',
          '--credentials',
          out,
          '--revoke-previous',
          ...config(stub),
        ]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('not writable');
        expect(stub.requests).toHaveLength(0);
        expect(Buffer.compare(await readFile(out), before)).toBe(0);
      } finally {
        await chmod(dir, 0o700);
      }
    }
  );

  it.each([
    ['no org_id', { sp_id: SP }],
    ['no sp_id', { org_id: ORG }],
    ['a bad sp_id', { org_id: ORG, sp_id: 'x' }],
  ])('refuses a file with %s before any network call', async (name, fields) => {
    const out = join(dir, 'c.json');
    await writeFile(out, JSON.stringify(fields));
    const result = await run(stub, ['sp', 'rotate', '--credentials', out, ...config(stub)]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(name === 'a bad sp_id' ? 'not a UUID' : 'no org_id or sp_id');
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses a file whose key is in a key_file, before any network call, and leaves it unchanged', async () => {
    const out = await seed();
    const seeded = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>;
    await writeFile(join(dir, 'key.json'), JSON.stringify(seeded.private_jwk));
    await writeFile(
      out,
      JSON.stringify({ ...seeded, private_jwk: undefined, key_file: 'key.json' })
    );
    // The SDK loads this form, so it is a credential a user can really have.
    await loadServicePrincipalCredential(out);
    const before = await readFile(out);
    const result = await run(stub, [
      'sp',
      'rotate',
      '--credentials',
      out,
      '--revoke-previous',
      ...config(stub),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('key_file');
    expect(stub.requests).toHaveLength(0);
    expect(Buffer.compare(await readFile(out), before)).toBe(0);
  });

  it('refuses an unreadable, non-JSON or non-object file', async () => {
    const bad = join(dir, 'bad.json');
    expect(
      (await run(stub, ['sp', 'rotate', '--credentials', join(dir, 'none.json'), ...config(stub)]))
        .code
    ).toBe(2);
    await writeFile(bad, '{nope');
    expect((await run(stub, ['sp', 'rotate', '--credentials', bad, ...config(stub)])).code).toBe(2);
    await writeFile(bad, '[]');
    expect((await run(stub, ['sp', 'rotate', '--credentials', bad, ...config(stub)])).code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('sp revoke', () => {
  it('is refused without --yes on a non-TTY, before any network call', async () => {
    const result = await run(stub, ['sp', 'revoke', '--org', ORG, '--sp', SP, ...config(stub)]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--yes');
    expect(stub.requests).toHaveLength(0);
  });

  it('calls the revoke route with --yes, without listing first', async () => {
    const result = await run(stub, [
      'sp',
      'revoke',
      '--org',
      ORG,
      '--sp',
      SP,
      '--yes',
      ...config(stub),
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(apiCalls()).toEqual([`POST ${spPath}/${SP}/revoke`]);
    expect(result.stdout).toContain('Delete the local credential file');
  });

  it('on a TTY shows the name and client_id and revokes after a yes', async () => {
    const result = await run(stub, ['sp', 'revoke', '--org', ORG, '--sp', SP, ...config(stub)], {
      stdinIsTTY: true,
      answers: ['y'],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts[0]).toContain('ci agent');
    expect(result.prompts[0]).toContain(`sp_${SP}`);
    expect(apiCalls()).toEqual([`GET ${spPath}`, `POST ${spPath}/${SP}/revoke`]);
  });

  it('does not revoke after a no', async () => {
    const result = await run(stub, ['sp', 'revoke', '--org', ORG, '--sp', SP, ...config(stub)], {
      stdinIsTTY: true,
      answers: ['n'],
    });
    expect(result.code).toBe(2);
    expect(apiCalls()).toEqual([`GET ${spPath}`]);
    expect(revocations()).toHaveLength(1);
  });

  it('exits 1 when the principal is not in the list', async () => {
    stub.overrides.set('GET service-principals', {
      status: 200,
      body: { success: true, data: { service_principals: [] } },
    });
    const result = await run(stub, ['sp', 'revoke', '--org', ORG, '--sp', SP, ...config(stub)], {
      stdinIsTTY: true,
      answers: ['y'],
    });
    expect(result.code).toBe(1);
    expect(apiCalls()).toEqual([`GET ${spPath}`]);
  });

  it('prints JSON with --json', async () => {
    const result = await run(stub, [
      'sp',
      'revoke',
      '--org',
      ORG,
      '--sp',
      SP,
      '--yes',
      '--json',
      ...config(stub),
    ]);
    expect(JSON.parse(result.stdout)).toEqual({ revoked: true, sp_id: SP, org_id: ORG });
  });
});

describe('interrupt and timeout', () => {
  const interruptOn = (key: string): AbortController => {
    const abort = new AbortController();
    stub.hangs.set(key, () => {
      abort.abort();
    });
    return abort;
  };

  it('Ctrl-C during a server call exits 3, still revokes the refresh token, and writes nothing', async () => {
    const abort = interruptOn('POST service-principals');
    const out = join(dir, 'c.json');
    const result = await run(stub, [...createArgs(out), ...config(stub)], {
      signal: abort.signal,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('Interrupted');
    expect(result.stderr).toContain('sp list');
    expect(result.stderr).toContain('If a new "ci agent" is listed');
    expect(revocations().map((f) => f.get('token'))).toEqual([REFRESH_TOKEN]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('Ctrl-C during a read says nothing was changed', async () => {
    const abort = interruptOn('GET service-principals');
    const result = await run(stub, ['sp', 'list', '--org', ORG, ...config(stub)], {
      signal: abort.signal,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('Interrupted. Nothing was changed.');
    expect(result.stderr).not.toContain('may or may not');
    expect(revocations()).toHaveLength(1);
  });

  it('Ctrl-C at the revoke prompt exits 3, revokes the refresh token and does not revoke the principal', async () => {
    const abort = new AbortController();
    const result = await run(stub, ['sp', 'revoke', '--org', ORG, '--sp', SP, ...config(stub)], {
      stdinIsTTY: true,
      signal: abort.signal,
      onPrompt: () => {
        abort.abort();
      },
    });
    expect(result.code).toBe(3);
    expect(result.prompts).toHaveLength(1);
    expect(result.stderr).toContain('was not revoked');
    expect(apiCalls()).toEqual([`GET ${spPath}`]);
    expect(revocations()).toHaveLength(1);
  });

  it('Ctrl-C during the code exchange exits 3', async () => {
    const abort = interruptOn('POST token');
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)], {
      signal: abort.signal,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('Interrupted');
    expect(apiCalls()).toEqual([]);
  });

  it('Ctrl-C while reading the authorization server metadata exits 3', async () => {
    const abort = interruptOn('GET metadata');
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)], {
      signal: abort.signal,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('No sign-in was started');
    expect(result.opened).toHaveLength(0);
  });

  it('a create that times out says it may have been applied, not that the server is unreachable', async () => {
    stub.hangs.set('POST service-principals', () => undefined);
    const out = join(dir, 'c.json');
    const result = await run(stub, [...createArgs(out), ...config(stub)], {
      requestTimeoutMs: 150,
    });
    expect(result.code).toBe(1);
    expect(apiCalls()).toEqual([`POST ${spPath}`]);
    expect(result.stderr).toContain('timed out before an answer arrived');
    expect(result.stderr).toContain('may or may not have applied the request');
    expect(result.stderr).toContain('If a new "ci agent" is listed');
    expect(result.stderr).toContain(`noblecloak sp revoke --org ${ORG} --sp <its id>`);
    expect(result.stderr).not.toContain('Cannot reach');
    expect(revocations()).toHaveLength(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a rotate --revoke-previous that times out says the file may now hold a retired key', async () => {
    const out = join(dir, 'cred.json');
    expect((await run(stub, [...createArgs(out), ...config(stub)])).code).toBe(0);
    const before = await readFile(out);
    stub.requests.length = 0;
    stub.hangs.set('POST rotate', () => undefined);
    const result = await run(
      stub,
      ['sp', 'rotate', '--credentials', out, '--revoke-previous', ...config(stub)],
      { requestTimeoutMs: 150 }
    );
    expect(result.code).toBe(1);
    expect(apiCalls()).toEqual([`POST ${spPath}/${SP}/rotate`]);
    expect(result.stderr).toContain('may or may not have applied the request');
    expect(result.stderr).toContain('the key in it was retired');
    expect(result.stderr).toContain(`noblecloak sp revoke --org ${ORG} --sp ${SP}`);
    expect(result.stderr).not.toContain('Cannot reach');
    expect(Buffer.compare(await readFile(out), before)).toBe(0);
  });

  it('a plain rotate whose connection drops says it may have been applied and the file still works', async () => {
    const out = join(dir, 'cred.json');
    expect((await run(stub, [...createArgs(out), ...config(stub)])).code).toBe(0);
    stub.resets.add('POST rotate');
    const result = await run(stub, ['sp', 'rotate', '--credentials', out, ...config(stub)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('failed before an answer arrived');
    expect(result.stderr).toContain('may or may not have applied the request');
    expect(result.stderr).toContain('its key still works either way');
    expect(result.stderr).not.toContain('Cannot reach');
  });

  it('a revoke whose connection drops says it may have been applied', async () => {
    stub.resets.add('POST revoke');
    const result = await run(stub, [
      'sp',
      'revoke',
      '--org',
      ORG,
      '--sp',
      SP,
      '--yes',
      ...config(stub),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('may or may not have applied the request');
    expect(result.stderr).not.toContain('Cannot reach');
  });

  it('a fault building the request signal is an unexpected failure, not an unreachable server', async () => {
    // A negative delay makes AbortSignal.timeout throw: a stand-in for a runtime without AbortSignal.any (Node before 20.3).
    const result = await run(stub, ['sp', 'list', '--org', ORG, ...config(stub)], {
      requestTimeoutMs: -1,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unexpected failure');
    expect(result.stderr).not.toContain('Cannot reach');
    expect(stub.requests).toHaveLength(0);
  });

  it('abandons a server call that never answers after the request timeout, and still ends the session', async () => {
    stub.hangs.set('GET service-principals', () => undefined);
    const result = await run(stub, ['sp', 'list', '--org', ORG, ...config(stub)], {
      requestTimeoutMs: 150,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Cannot reach the server');
    expect(revocations()).toHaveLength(1);
  });
});

describe('--user-token-file', () => {
  const tokenFile = async (mode: number, text = 'file-token\n'): Promise<string> => {
    const path = join(dir, 'token');
    await writeFile(path, text);
    await chmod(path, mode);
    return path;
  };

  it.skipIf(process.platform === 'win32').each([0o640, 0o604, 0o644, 0o660])(
    'refuses a file with mode %o that group or others can read',
    async (mode) => {
      const path = await tokenFile(mode);
      const result = await run(stub, [
        'sp',
        'list',
        '--org',
        ORG,
        '--user-token-file',
        path,
        ...config(stub),
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('chmod 600');
      expect(stub.requests).toHaveLength(0);
    }
  );

  it('uses the token as the bearer, with no sign-in and nothing to revoke', async () => {
    const path = await tokenFile(0o600);
    const result = await run(stub, [
      'sp',
      'list',
      '--org',
      ORG,
      '--user-token-file',
      path,
      ...config(stub),
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.opened).toHaveLength(0);
    expect(stub.requests.map((r) => r.authorization)).toEqual(['Bearer file-token']);
  });

  it.skipIf(process.platform === 'win32')(
    'follows a symlink and checks the target: 0600 passes, 0644 is refused',
    async () => {
      const target = await tokenFile(0o600);
      const link = join(dir, 'link');
      await symlink(target, link);
      const argv = ['sp', 'list', '--org', ORG, '--user-token-file', link, ...config(stub)];
      const ok = await run(stub, argv);
      expect(ok.code, ok.stderr).toBe(0);
      expect(stub.requests.map((r) => r.authorization)).toEqual(['Bearer file-token']);

      stub.requests.length = 0;
      await chmod(target, 0o644);
      const refused = await run(stub, argv);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('chmod 600');
      expect(stub.requests).toHaveLength(0);
    }
  );

  it('does not check the mode on windows', async () => {
    const path = await tokenFile(0o644);
    const result = await run(
      stub,
      ['sp', 'list', '--org', ORG, '--user-token-file', path, ...config(stub)],
      {
        platform: 'win32',
      }
    );
    expect(result.code, result.stderr).toBe(0);
  });

  it('refuses an empty or missing file', async () => {
    const empty = await tokenFile(0o600, '  \n');
    expect(
      (await run(stub, ['sp', 'list', '--org', ORG, '--user-token-file', empty, ...config(stub)]))
        .code
    ).toBe(2);
    expect(
      (
        await run(stub, [
          'sp',
          'list',
          '--org',
          ORG,
          '--user-token-file',
          join(dir, 'none'),
          ...config(stub),
        ])
      ).code
    ).toBe(2);
  });
});

describe('secrets', () => {
  // Every command path, error paths included, with output captured. None may print the private key, a
  // token, the code or the verifier.
  const secrets = (): string[] => [
    ...generated.map((k) => k.privateJwk.d),
    ACCESS_TOKEN,
    REFRESH_TOKEN,
    CODE,
    ...(stub.verifier === undefined ? [] : [stub.verifier]),
  ];

  const scenarios: [string, (out: string) => Promise<void> | void, (out: string) => string[]][] = [
    ['create', () => undefined, (out) => createArgs(out)],
    ['create --json', () => undefined, (out) => createArgs(out, ['--json'])],
    [
      'create 403',
      () => {
        stub.overrides.set('POST service-principals', {
          status: 403,
          body: { success: false, error: { code: 'FORBIDDEN', message: 'no' } },
        });
      },
      (out) => createArgs(out),
    ],
    [
      'create null registration',
      () => {
        stub.registration = { token_endpoint: null, assertion_audience: null };
      },
      (out) => createArgs(out),
    ],
    [
      'create token endpoint refuses the code',
      () => {
        stub.tokenStatus = 400;
      },
      (out) => createArgs(out),
    ],
    [
      'create unwritable',
      () => {
        writeFails = true;
      },
      (out) => createArgs(out),
    ],
    [
      'create 401',
      () => {
        stub.overrides.set('POST service-principals', {
          status: 401,
          body: { error: 'invalid_token' },
        });
      },
      (out) => createArgs(out),
    ],
    ['list', () => undefined, () => ['sp', 'list', '--org', ORG]],
    ['revoke', () => undefined, () => ['sp', 'revoke', '--org', ORG, '--sp', SP, '--yes']],
  ];

  it.each(scenarios)('%s prints no secret', async (_name, arrange, argvFor) => {
    await arrange(dir);
    const result = await run(stub, [...argvFor(join(dir, 'c.json')), ...config(stub)], {
      stdinIsTTY: true,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    for (const secret of secrets()) expect(output).not.toContain(secret);
    // The scenario really ran a sign-in, so the secrets existed to be leaked.
    expect(stub.verifier ?? '').not.toBe('');
  });

  // Prompts count as output: the bin writes them to stderr.
  const assertNoSecret = (
    result: { stdout: string; stderr: string; prompts: string[] },
    extra: string[] = []
  ): void => {
    const output = [result.stdout, result.stderr, ...result.prompts].join('\n');
    for (const secret of [...secrets(), ...extra]) expect(output).not.toContain(secret);
  };

  it('--user-token-file, on success and on a 403, prints no secret (the token included)', async () => {
    const path = join(dir, 'token');
    await writeFile(path, 'file-token\n');
    await chmod(path, 0o600);
    const argv = ['sp', 'list', '--org', ORG, '--user-token-file', path, ...config(stub)];
    const ok = await run(stub, argv);
    expect(ok.code, ok.stderr).toBe(0);
    assertNoSecret(ok, ['file-token']);
    stub.overrides.set('GET service-principals', {
      status: 403,
      body: { success: false, error: { code: 'FORBIDDEN', message: 'no' } },
    });
    const refused = await run(stub, argv);
    expect(refused.code).toBe(4);
    assertNoSecret(refused, ['file-token']);
    expect(stub.requests.every((r) => r.authorization === 'Bearer file-token')).toBe(true);
  });

  it('revoke confirmed at the prompt prints no secret', async () => {
    const result = await run(stub, ['sp', 'revoke', '--org', ORG, '--sp', SP, ...config(stub)], {
      stdinIsTTY: true,
      answers: ['y'],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toHaveLength(1);
    assertNoSecret(result);
    expect(stub.verifier ?? '').not.toBe('');
  });

  it('an interrupted create and a timed-out create print no secret', async () => {
    const abort = new AbortController();
    stub.hangs.set('POST service-principals', () => {
      abort.abort();
    });
    const interrupted = await run(stub, [...createArgs(join(dir, 'a.json')), ...config(stub)], {
      signal: abort.signal,
    });
    expect(interrupted.code).toBe(3);
    assertNoSecret(interrupted);
    expect(generated).toHaveLength(1);

    stub.hangs.set('POST service-principals', () => undefined);
    const timedOut = await run(stub, [...createArgs(join(dir, 'b.json')), ...config(stub)], {
      requestTimeoutMs: 150,
    });
    expect(timedOut.code).toBe(1);
    assertNoSecret(timedOut);
    expect(generated).toHaveLength(2);
  });

  it('an unreachable API prints no secret', async () => {
    const result = await run(stub, [...createArgs(join(dir, 'c.json')), ...config(stub)], {
      apiUnreachable: true,
    });
    expect(result.code).toBe(1);
    const output = `${result.stdout}\n${result.stderr}`;
    for (const secret of secrets()) expect(output).not.toContain(secret);
  });

  it('rotate, on success and on failure, prints no secret', async () => {
    const out = join(dir, 'cred.json');
    await run(stub, [...createArgs(out), ...config(stub)]);
    for (const status of [undefined, 500]) {
      if (status !== undefined) {
        stub.overrides.set('POST rotate', {
          status,
          body: { success: false, error: { code: 'X', message: 'no' } },
        });
      }
      const result = await run(stub, ['sp', 'rotate', '--credentials', out, ...config(stub)]);
      const output = `${result.stdout}\n${result.stderr}`;
      for (const secret of secrets()) expect(output).not.toContain(secret);
    }
    expect(generated.length).toBeGreaterThanOrEqual(3);
  });
});
