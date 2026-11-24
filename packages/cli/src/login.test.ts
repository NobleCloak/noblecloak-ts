import { execFileSync } from 'node:child_process';
import { stat, readFile, writeFile, chmod, mkdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLoginHosts } from './login-config.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import { readLogin, writeLogin, LOGIN_FILE, type StoredLogin } from './login-store.js';
import {
  ADMIN_AUDIENCE,
  APP_URL,
  CODE,
  EMAIL,
  ORG,
  REFRESH_TOKEN,
  REFRESHED_TOKEN,
  accessToken,
  cleanState,
  freshSetup,
  goodSignIn,
  hostFlags,
  makeStateDir,
  runLogin,
  startLoginStub,
  visit,
  type LoginStub,
} from './login.test-support.js';

let stub: LoginStub;
let dir: string;

const NOT_TOLD =
  'Signed out here. The server was not told, so the session there may stay open until it expires.\n';

beforeEach(async () => {
  stub = await startLoginStub();
  dir = await makeStateDir();
});

afterEach(async () => {
  await stub.close();
  await cleanState(dir);
});

const login = (extra: string[] = [], options: Parameters<typeof runLogin>[3] = {}) =>
  runLogin(stub, ['login', ...hostFlags(stub), ...extra], dir, options);

const setupCmd = (extra: string[] = [], options: Parameters<typeof runLogin>[3] = {}) =>
  runLogin(stub, ['setup', ...hostFlags(stub), ...extra], dir, options);

/** A saved sign-in as `login` writes it, with `over` applied. */
function saved(over: Partial<StoredLogin> = {}): StoredLogin {
  return {
    version: 1,
    issuer: stub.url,
    clientId: 'noblecloak-cli',
    audience: ADMIN_AUDIENCE,
    scope: 'setup:read',
    accessToken: accessToken({}, 'saved'),
    refreshToken: REFRESH_TOKEN,
    expiresAt: Date.now() + 600_000,
    tokenType: 'Bearer',
    authenticatedAt: '2026-11-24T00:00:00.000Z',
    orgId: ORG,
    sub: 'user-sub-1',
    ...over,
  };
}

const seed = (over: Partial<StoredLogin> = {}) =>
  writeLogin({ env: { NOBLECLOAK_CLI_STATE_DIR: dir }, platform: process.platform }, saved(over));

const ioWith = (env: Record<string, string | undefined>): Io =>
  ({ env, stdout: () => undefined, stderr: () => undefined }) as unknown as Io;

const refusal = (fn: () => unknown): CliError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CliError) return error;
  }
  throw new Error('expected a CliError');
};

describe('flag and default resolution', () => {
  it('defaults to production: its authorization server, admin audience and app', () => {
    expect(resolveLoginHosts({}, ioWith({}))).toEqual({
      authUrl: 'https://auth.noblecloak.com',
      origin: 'https://auth.noblecloak.com',
      adminAudience: 'https://admin-api.noblecloak.com',
      appUrl: 'https://app.noblecloak.com',
    });
  });

  it('--deployment beta picks the beta hosts', () => {
    expect(resolveLoginHosts({ deployment: 'beta' }, ioWith({}))).toEqual({
      authUrl: 'https://api.beta.shared.bianoble.com',
      origin: 'https://api.beta.shared.bianoble.com',
      adminAudience: 'https://admin-api.beta.shared.bianoble.com',
      appUrl: 'https://shell.beta.shared.bianoble.com',
    });
  });

  it('NOBLECLOAK_DEPLOYMENT picks the deployment, and an explicit --deployment ignores the host variables', () => {
    const env = {
      NOBLECLOAK_DEPLOYMENT: 'beta',
      NOBLECLOAK_AUTH_URL: 'https://other.example.com',
      NOBLECLOAK_ADMIN_AUDIENCE: 'urn:other-admin',
    };
    expect(resolveLoginHosts({}, ioWith(env)).authUrl).toBe('https://other.example.com');
    expect(resolveLoginHosts({ deployment: 'beta' }, ioWith(env)).authUrl).toBe(
      'https://api.beta.shared.bianoble.com'
    );
  });

  it('a flag wins over the variable, and a self-hosted auth URL needs its own admin audience', () => {
    const env = { NOBLECLOAK_AUTH_URL: 'https://env.example.com' };
    expect(
      resolveLoginHosts(
        {
          'auth-url': 'https://flag.example.com/',
          'admin-audience': 'urn:admin',
          'app-url': 'https://app.example.com',
        },
        ioWith(env)
      )
    ).toEqual({
      authUrl: 'https://flag.example.com',
      origin: 'https://flag.example.com',
      adminAudience: 'urn:admin',
      appUrl: 'https://app.example.com',
    });
    const error = refusal(() =>
      resolveLoginHosts({ 'auth-url': 'https://flag.example.com' }, ioWith({}))
    );
    expect(error.exitCode).toBe(EXIT.usage);
    expect(error.message).toContain('--admin-audience');
    expect(error.message).toContain('NOBLECLOAK_ADMIN_AUDIENCE');
  });

  it('does not guess the app of a self-hosted deployment', () => {
    const hosts = resolveLoginHosts(
      { 'auth-url': 'https://flag.example.com', 'admin-audience': 'urn:admin' },
      ioWith({})
    );
    expect(hosts.appUrl).toBeUndefined();
  });

  it('refuses an unknown deployment, an insecure URL and an app URL with a path', () => {
    expect(refusal(() => resolveLoginHosts({ deployment: 'moon' }, ioWith({}))).message).toContain(
      'Unknown deployment "moon"'
    );
    expect(
      refusal(() =>
        resolveLoginHosts(
          { 'auth-url': 'http://auth.example.com', 'admin-audience': 'a' },
          ioWith({})
        )
      ).exitCode
    ).toBe(EXIT.usage);
    expect(
      refusal(() =>
        resolveLoginHosts(
          {
            'auth-url': 'https://a.example.com',
            'admin-audience': 'a',
            'app-url': 'https://app.example.com/x',
          },
          ioWith({})
        )
      ).message
    ).toContain('origin');
  });
});

describe('noblecloak login', () => {
  it('signs in, redirects the tab to the hosted page without HTML, and prints the Next line for an unfinished org', async () => {
    const run = await login();
    expect(run.code).toBe(0);

    // The loopback never renders HTML: a 303 with no body, to the hosted page, naming the org by id only.
    expect(run.answers).toHaveLength(1);
    const [answer] = run.answers;
    expect(answer?.status).toBe(303);
    expect(answer?.location).toBe(`${APP_URL}/cli/signed-in?org=${ORG}`);
    expect(answer?.body).toBe('');
    expect(answer?.contentType ?? '').not.toContain('html');

    expect(run.stdout).toMatch(
      /^✓ Signed in\n\nNext: finish setup \(\d+ of \d+ steps left\)\n {2}noblecloak setup {3}or {3}https:\/\/app\.example\.test\/setup\n\nIn Claude Code, run \/mcp to connect tools\.\n$/
    );
    expect(run.stderr).toContain('Opening your browser to sign in…');
    expect(run.stderr).toContain("(If it didn't open: ");
    // No org UUID, no restart step, no token anywhere in the output.
    for (const text of [run.stdout, run.stderr]) {
      expect(text).not.toContain(ORG);
      expect(text).not.toContain(stub.issued);
      expect(text).not.toContain(REFRESH_TOKEN);
      expect(text.toLowerCase()).not.toContain('restart');
    }
  });

  it('counts steps by the setup pill rule (n of N left)', async () => {
    const run = await login();
    // A fresh solo org: Connect, Approve, Try it and Proof are left.
    expect(run.stdout).toContain('Next: finish setup (4 of 4 steps left)');
  });

  it('prints only the /mcp line for a finished org', async () => {
    stub.setup = { status: 200, body: { success: true, data: freshSetup({ dismissed: true }) } };
    const run = await login();
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('✓ Signed in\n\nIn Claude Code, run /mcp to connect tools.\n');
    expect(run.stdout).not.toContain('Next:');
  });

  it('prints only the /mcp line, with no warning, for a member who is not an administrator', async () => {
    stub.setup = { status: 403, body: { error: { code: 'FORBIDDEN' } } };
    const run = await login();
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('✓ Signed in\n\nIn Claude Code, run /mcp to connect tools.\n');
    expect(run.stderr).not.toContain('warning');
  });

  it('says it could not read progress when the setup read fails, and still signs in', async () => {
    stub.setup = { status: 500, body: {} };
    const run = await login();
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(
      'warning: could not read your setup progress. Run noblecloak setup to continue.'
    );
    expect(run.stdout).not.toContain('Next:');
    expect(
      (await readLogin({ env: { NOBLECLOAK_CLI_STATE_DIR: dir }, platform: process.platform })).kind
    ).toBe('found');
  });

  it('reads the setup with the admin token against the organization the token names', async () => {
    await login();
    const read = stub.requests.find((r) => r.path === `/organizations/${ORG}/setup`);
    expect(read?.method).toBe('GET');
    expect(read?.authorization).toBe(`Bearer ${stub.issued}`);
  });

  it('asks for the setup:read scope on the admin audience, as noblecloak-cli, and sends no login hint without --email', async () => {
    await login();
    const [authorize] = stub.authorizeUrls;
    expect(authorize?.searchParams.get('client_id')).toBe('noblecloak-cli');
    expect(authorize?.searchParams.get('scope')).toBe('setup:read');
    expect(authorize?.searchParams.get('resource')).toBe(ADMIN_AUDIENCE);
    expect(authorize?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize?.searchParams.has('login_hint')).toBe(false);
    const exchange = stub.requests.find((r) => r.path === '/auth/oauth/token');
    expect(exchange?.form?.get('resource')).toBe(ADMIN_AUDIENCE);
  });

  it('--email is sent to the authorization server as the SSO hint and goes nowhere else', async () => {
    const run = await login(['--email', EMAIL]);
    expect(run.code).toBe(0);
    expect(stub.authorizeUrls[0]?.searchParams.get('login_hint')).toBe(EMAIL);
    expect(run.answers[0]?.location).not.toContain('maria');
    expect(run.stdout).not.toContain('maria');
    expect(await readFile(join(dir, LOGIN_FILE), 'utf8')).not.toContain('maria');
  });

  it('refuses an --email that is not an address, before any request', async () => {
    const run = await login(['--email', 'not an address']);
    expect(run.code).toBe(EXIT.usage);
    expect(run.stderr).toContain('--email must be an email address.');
    expect(stub.requests).toHaveLength(0);
  });

  it('saves the sign-in 0600 in a 0700 directory, in the format the plugin reads', async () => {
    const before = Date.now();
    await login();
    const file = join(dir, LOGIN_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 1,
      issuer: stub.url,
      clientId: 'noblecloak-cli',
      audience: ADMIN_AUDIENCE,
      scope: 'setup:read',
      accessToken: stub.issued,
      refreshToken: REFRESH_TOKEN,
      tokenType: 'Bearer',
      orgId: ORG,
      sub: 'user-sub-1',
    });
    expect(stored.expiresAt as number).toBeGreaterThanOrEqual(before + 900_000);
    expect(stored.expiresAt as number).toBeLessThanOrEqual(Date.now() + 900_000);
    expect(typeof stored.authenticatedAt).toBe('string');
    expect(stored).not.toHaveProperty('email');
  });

  it('revokes the refresh token of the sign-in it replaces', async () => {
    await seed({ refreshToken: 'older-refresh-token' });
    const run = await login();
    expect(run.code).toBe(0);
    const revoke = stub.requests.find((r) => r.path === '/auth/oauth/revoke');
    expect(revoke?.form?.get('token')).toBe('older-refresh-token');
    const stored = JSON.parse(await readFile(join(dir, LOGIN_FILE), 'utf8')) as StoredLogin;
    expect(stored.refreshToken).toBe(REFRESH_TOKEN);
  });

  it('keeps no tokens, codes or email in the hosted page URL', async () => {
    const run = await login(['--email', EMAIL]);
    const location = run.answers[0]?.location ?? '';
    expect([...new URL(location).searchParams.keys()]).toEqual(['org']);
    expect(location).not.toContain(stub.issued);
    expect(location).not.toContain('code');
  });

  it('redirects the tab to the hosted error page with a closed code when the server refuses', async () => {
    const run = await login([], {
      browser: (authorize) =>
        visit(authorize, { error: 'access_denied', error_description: 'secret <b>words</b>' }),
    });
    expect(run.code).toBe(EXIT.unauthenticated);
    expect(run.stderr).toContain('error: Sign-in was not completed.');
    expect(run.answers[0]?.status).toBe(303);
    expect(run.answers[0]?.location).toBe(`${APP_URL}/cli/signed-in?error=access_denied`);
    expect(run.answers[0]?.body).toBe('');
    expect(await stat(join(dir, LOGIN_FILE)).catch(() => undefined)).toBeUndefined();
  });

  it('forwards an error the hosted page has no copy for as unknown_error, never its text', async () => {
    const run = await login([], {
      browser: (authorize) => visit(authorize, { error: 'weird<script>alert(1)</script>' }),
    });
    expect(run.answers[0]?.location).toBe(`${APP_URL}/cli/signed-in?error=unknown_error`);
  });

  it('answers a callback with another state in plain text, and keeps waiting for the real one', async () => {
    const run = await login([], {
      browser: async (authorize, s) => {
        const wrong = await visit(authorize, { code: 'x' }, 'not-the-state');
        const right = await goodSignIn(authorize, s);
        return {
          ...right,
          body: `${String(wrong.status)}|${wrong.contentType ?? ''}|${wrong.body}`,
        };
      },
    });
    expect(run.code).toBe(0);
    const [answer] = run.answers;
    expect(answer?.body).toMatch(/^400\|text\/plain; charset=utf-8\|/);
    expect(answer?.body.toLowerCase()).not.toContain('<html');
    expect(answer?.status).toBe(303);
  });

  it('redirects the tab to the error page and exits 3 when the code exchange fails', async () => {
    // A challenge the verifier does not match: the token endpoint refuses the code.
    const run = await login([], {
      browser: (authorize, s) => {
        s.challenge = 'not-the-challenge';
        return visit(authorize, { code: CODE });
      },
    });
    expect(run.code).toBe(EXIT.unauthenticated);
    expect(run.stderr).toContain('Sign-in failed: the token endpoint answered 400.');
    expect(run.answers[0]?.location).toBe(`${APP_URL}/cli/signed-in?error=server_error`);
    expect(await stat(join(dir, LOGIN_FILE)).catch(() => undefined)).toBeUndefined();
  });

  it('answers plain text, still no HTML, and names no URL when the deployment has no known app', async () => {
    const run = await runLogin(
      stub,
      ['login', '--auth-url', stub.url, '--admin-audience', ADMIN_AUDIENCE],
      dir
    );
    expect(run.code).toBe(0);
    expect(run.answers[0]?.status).toBe(200);
    expect(run.answers[0]?.contentType).toBe('text/plain; charset=utf-8');
    expect(run.answers[0]?.body).toBe('Signed in. Return to your terminal.\n');
    expect(run.stdout).toContain('  noblecloak setup\n');
    expect(run.stdout).not.toContain('https://');
  });

  it('--no-open prints the URL on a line of its own and opens nothing', async () => {
    const run = await login(['--no-open'], { printedUrlOnly: true });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('Open this URL in your browser to sign in:\nhttp://127.0.0.1:');
    expect(run.launched).toEqual([]);
  });

  it('--json prints one object and no Next text', async () => {
    const run = await login(['--json']);
    expect(JSON.parse(run.stdout)).toEqual({
      signed_in: true,
      setup: 'unfinished',
      steps_left: 4,
      steps_total: 4,
    });
  });

  it('times out when the browser never comes back, exit 3', async () => {
    const run = await login([], {
      signInTimeoutMs: 100,
      browser: () => Promise.resolve(undefined),
    });
    expect(run.code).toBe(EXIT.unauthenticated);
    expect(run.stderr).toContain('Sign-in timed out waiting for the browser.');
  });

  it('refuses before a browser opens when the deployment does not offer setup:read', async () => {
    stub.scopesSupported = ['mcp'];
    const run = await login();
    expect(run.code).toBe(EXIT.failed);
    expect(run.stderr).toContain('does not offer the setup:read scope');
    expect(run.opened).toHaveLength(0);
  });

  it('says so, and sends the tab to the error page, when the sign-in cannot be saved', async () => {
    const blocker = join(dir, 'a-file');
    await writeFile(blocker, 'x');
    const run = await runLogin(stub, ['login', ...hostFlags(stub)], dir, {
      env: { NOBLECLOAK_CLI_STATE_DIR: join(blocker, 'inside') },
    });
    expect(run.code).toBe(EXIT.failed);
    expect(run.stderr).toContain('Signed in, but the sign-in could not be saved at ');
    expect(run.answers[0]?.location).toBe(`${APP_URL}/cli/signed-in?error=server_error`);
  });

  it('signs in, with no org on the page, when the token names no organization', async () => {
    stub.issued = accessToken({ org_id: undefined });
    const run = await login();
    expect(run.code).toBe(0);
    expect(run.answers[0]?.location).toBe(`${APP_URL}/cli/signed-in`);
    expect(run.stdout).not.toContain('Next:');
    expect(run.stderr).toContain('could not read your setup progress');
  });
});

describe('noblecloak setup', () => {
  it('opens /setup on the deployment app and prints the URL', async () => {
    const run = await setupCmd();
    expect(run.code).toBe(0);
    expect(run.launched).toEqual([`${APP_URL}/setup`]);
    expect(run.stderr).toContain(
      `Opening setup in your browser…\n(If it didn't open: ${APP_URL}/setup)`
    );
    expect(run.stdout).toBe('');
  });

  it('opens the deployment default app with no flags but --deployment', async () => {
    const run = await runLogin(stub, ['setup', '--deployment', 'beta'], dir);
    expect(run.launched).toEqual(['https://shell.beta.shared.bianoble.com/setup']);
  });

  it('--no-open prints the URL and opens nothing', async () => {
    const run = await setupCmd(['--no-open']);
    expect(run.launched).toEqual([]);
    expect(run.stderr).toContain(
      `Open this URL in your browser to continue setup:\n${APP_URL}/setup`
    );
  });

  it('needs an app URL on a self-hosted deployment', async () => {
    const run = await runLogin(
      stub,
      ['setup', '--auth-url', stub.url, '--admin-audience', ADMIN_AUDIENCE],
      dir
    );
    expect(run.code).toBe(EXIT.usage);
    expect(run.stderr).toContain('Missing the app URL: pass --app-url or set NOBLECLOAK_APP_URL.');
    expect(run.launched).toEqual([]);
  });

  it('still opens the wizard when a browser opener fails', async () => {
    const run = await setupCmd([], { openUrlThrows: true });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(`(If it didn't open: ${APP_URL}/setup)`);
  });

  it('says how many steps are left when a sign-in is saved', async () => {
    await seed();
    const run = await setupCmd();
    expect(run.stdout).toBe('4 of 4 steps left.\n');
    const read = stub.requests.find((r) => r.path === `/organizations/${ORG}/setup`);
    expect(read?.authorization).toBe(`Bearer ${saved().accessToken}`);
    expect(stub.requests.some((r) => r.path === '/auth/oauth/token')).toBe(false);
  });

  it('says setup is finished for a finished org', async () => {
    await seed();
    stub.setup = { status: 200, body: { success: true, data: freshSetup({ dismissed: true }) } };
    const run = await setupCmd();
    expect(run.stdout).toBe('Setup is finished.\n');
    expect(run.launched).toEqual([`${APP_URL}/setup`]);
  });

  it('renews an expired access token with the refresh token and saves the rotated one', async () => {
    await seed({ expiresAt: Date.now() - 1000 });
    const run = await setupCmd();
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('4 of 4 steps left.\n');
    const refresh = stub.requests.find((r) => r.form?.get('grant_type') === 'refresh_token');
    expect(refresh?.form?.get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(refresh?.form?.get('client_id')).toBe('noblecloak-cli');
    expect(refresh?.form?.get('resource')).toBe(ADMIN_AUDIENCE);
    const stored = JSON.parse(await readFile(join(dir, LOGIN_FILE), 'utf8')) as StoredLogin;
    expect(stored.refreshToken).toBe(REFRESHED_TOKEN);
    expect(stored.orgId).toBe(ORG);
    expect(stored.expiresAt).toBeGreaterThan(Date.now());
    expect((await stat(join(dir, LOGIN_FILE))).mode & 0o777).toBe(0o600);
    const read = stub.requests.find((r) => r.path === `/organizations/${ORG}/setup`);
    expect(read?.authorization).toBe(`Bearer ${accessToken({}, 'refreshed')}`);
  });

  it('says the sign-in expired, and removes the dead file, when the refresh token is revoked', async () => {
    await seed({ expiresAt: Date.now() - 1000 });
    stub.refreshStatus = 400;
    const run = await setupCmd();
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(
      'Your sign-in has expired. Run noblecloak login to see your progress here.'
    );
    expect(run.stdout).toBe('');
    expect(run.launched).toEqual([`${APP_URL}/setup`]);
    expect(await stat(join(dir, LOGIN_FILE)).catch(() => undefined)).toBeUndefined();
  });

  it('says the sign-in expired when the access token is expired and there is no refresh token', async () => {
    await seed({ expiresAt: Date.now() - 1000, refreshToken: undefined });
    const run = await setupCmd();
    expect(run.stderr).toContain('Your sign-in has expired.');
    expect(stub.requests.some((r) => r.path === '/auth/oauth/token')).toBe(false);
  });

  it('says the sign-in expired, keeping the file, when the server refuses a token that looked live', async () => {
    await seed();
    stub.setup = { status: 401, body: { error: 'invalid_token' } };
    const run = await setupCmd();
    expect(run.stderr).toContain('Your sign-in has expired.');
    expect((await stat(join(dir, LOGIN_FILE))).isFile()).toBe(true);
  });

  it('keeps the saved sign-in and opens the wizard when the refresh fails for a reason that proves nothing', async () => {
    await seed({ expiresAt: Date.now() - 1000 });
    stub.refreshStatus = 503;
    const run = await setupCmd();
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain('expired');
    expect(run.launched).toEqual([`${APP_URL}/setup`]);
    expect((await stat(join(dir, LOGIN_FILE))).isFile()).toBe(true);
  });

  it('keeps the file, and does not say expired, when Core refuses a refresh for a transient single sign-on reason', async () => {
    await seed({ expiresAt: Date.now() - 1000 });
    stub.refreshStatus = 400;
    stub.refreshDescription = 'single sign-on session could not be verified';
    const run = await setupCmd();
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain('expired');
    expect(run.stderr).toContain('warning: could not read your setup progress.');
    expect(run.launched).toEqual([`${APP_URL}/setup`]);
    const stored = JSON.parse(await readFile(join(dir, LOGIN_FILE), 'utf8')) as StoredLogin;
    expect(stored.refreshToken).toBe(REFRESH_TOKEN);
  });

  it.each([
    ['refresh token is unknown'],
    ['refresh token has already been used'],
    ['refresh token has been revoked'],
    ['refresh token family has reached its maximum age'],
    ['refresh token is expired'],
    ['single sign-on session has expired'],
    ['single sign-on is no longer enabled'],
    ['this organization requires single sign-on'],
    ['authorization is no longer valid'],
  ])('reads "%s" as the end of the sign-in and removes the file', async (description) => {
    await seed({ expiresAt: Date.now() - 1000 });
    stub.refreshStatus = 400;
    stub.refreshDescription = description;
    const run = await setupCmd();
    expect(run.stderr).toContain('Your sign-in has expired.');
    expect(await stat(join(dir, LOGIN_FILE)).catch(() => undefined)).toBeUndefined();
  });

  it('keeps the file for a 400 with another error, a 400 with no description and a 401', async () => {
    await seed({ expiresAt: Date.now() - 1000 });
    for (const [status, error, description] of [
      [400, 'invalid_request', 'refresh token has been revoked'],
      [400, 'invalid_grant', ''],
      [401, 'invalid_client', 'refresh token has been revoked'],
      [400, 'invalid_grant', 'client is not registered'],
    ] as const) {
      stub.refreshStatus = status;
      stub.refreshError = error;
      stub.refreshDescription = description;
      const run = await setupCmd();
      expect(run.stderr).not.toContain('has expired');
      expect((await stat(join(dir, LOGIN_FILE))).isFile()).toBe(true);
    }
  });

  it('skips the count, and does not fail, on a self-hosted deployment with no --admin-audience', async () => {
    await seed();
    const run = await runLogin(
      stub,
      ['setup', '--auth-url', stub.url, '--app-url', APP_URL, '--no-open'],
      dir
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(stub.requests).toHaveLength(0);
    const json = await runLogin(
      stub,
      ['setup', '--auth-url', stub.url, '--app-url', APP_URL, '--no-open', '--json'],
      dir
    );
    expect(JSON.parse(json.stdout)).toEqual({
      url: `${APP_URL}/setup`,
      saved_sign_in: 'skipped',
      setup: null,
    });
  });

  it('warns when the setup read fails, and --json says why there is no count', async () => {
    await seed();
    stub.setup = { status: 500, body: {} };
    const run = await setupCmd();
    expect(run.stderr).toContain('warning: could not read your setup progress.\n');
    expect(run.stderr).not.toContain('Run noblecloak setup');
    const json = await setupCmd(['--json', '--no-open']);
    expect(JSON.parse(json.stdout)).toEqual({
      url: `${APP_URL}/setup`,
      saved_sign_in: 'read',
      setup: 'unreadable',
    });
  });

  it('--json names the reason when nothing is saved or the sign-in expired', async () => {
    const none = await setupCmd(['--json', '--no-open']);
    expect(JSON.parse(none.stdout)).toMatchObject({ saved_sign_in: 'none', setup: null });
    await seed({ expiresAt: Date.now() - 1000 });
    stub.refreshStatus = 400;
    const expired = await setupCmd(['--json', '--no-open']);
    expect(JSON.parse(expired.stdout)).toMatchObject({ saved_sign_in: 'expired', setup: null });
  });

  it('does not use a sign-in saved for another deployment', async () => {
    await seed({ issuer: 'https://auth.other.example.com' });
    const run = await setupCmd();
    expect(run.stderr).toContain('The saved sign-in is for another deployment.');
    expect(stub.requests.some((r) => r.path.includes('/setup'))).toBe(false);
  });

  it('does not use a saved sign-in that other users can read, and says where it is', async () => {
    await seed();
    await chmod(join(dir, LOGIN_FILE), 0o644);
    const run = await setupCmd();
    expect(run.stderr).toContain('it can be read by other users');
    expect(run.stderr).toContain(join(dir, LOGIN_FILE));
    expect(stub.requests).toHaveLength(0);
  });

  it('does not use a saved sign-in that is not valid', async () => {
    await writeFile(join(dir, LOGIN_FILE), '{ not json', { mode: 0o600 });
    const run = await setupCmd();
    expect(run.stderr).toContain('it is not valid JSON');
    expect(run.code).toBe(0);
  });

  it('--json prints the URL and the count', async () => {
    await seed();
    const run = await setupCmd(['--json', '--no-open']);
    expect(JSON.parse(run.stdout)).toEqual({
      url: `${APP_URL}/setup`,
      saved_sign_in: 'read',
      setup: 'unfinished',
      steps_left: 4,
      steps_total: 4,
    });
    expect(run.stderr).toBe('');
  });
});

describe('noblecloak logout', () => {
  it('revokes the refresh token and removes the file', async () => {
    await seed();
    const run = await runLogin(stub, ['logout'], dir);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('Signed out.\n');
    const revoke = stub.requests.find((r) => r.path === '/auth/oauth/revoke');
    expect(revoke?.form?.get('token')).toBe(REFRESH_TOKEN);
    expect(revoke?.form?.get('client_id')).toBe('noblecloak-cli');
    expect(await stat(join(dir, LOGIN_FILE)).catch(() => undefined)).toBeUndefined();
  });

  it('does not contact a server the file names over plain http, removes the file, and says the server was not told', async () => {
    await seed({ issuer: 'http://auth.example.com' });
    const run = await runLogin(stub, ['logout'], dir);
    expect(run.stderr).toContain('names a server that is not https, or has a password in its URL');
    expect(run.stdout).toBe(NOT_TOLD);
    expect(stub.requests).toHaveLength(0);
    expect(await stat(join(dir, LOGIN_FILE)).catch(() => undefined)).toBeUndefined();
  });

  it('does not contact a server whose URL carries a password', async () => {
    await seed({ issuer: 'https://user:secret@auth.example.com' });
    const run = await runLogin(stub, ['logout'], dir);
    expect(run.stdout).toBe(NOT_TOLD);
    expect(run.stderr).not.toContain('secret');
  });

  it('says the server was not told when the revoke fails, and still removes the file', async () => {
    await seed();
    await stub.close();
    const run = await runLogin(stub, ['logout'], dir);
    expect(run.stdout).toBe(NOT_TOLD);
    expect(await stat(join(dir, LOGIN_FILE)).catch(() => undefined)).toBeUndefined();
    stub = await startLoginStub();
  });

  it('revokes the session of a file it refuses for its mode, then removes it', async () => {
    await seed();
    await chmod(join(dir, LOGIN_FILE), 0o644);
    const run = await runLogin(stub, ['logout'], dir);
    expect(run.stdout).toBe('Signed out.\n');
    expect(stub.requests.find((r) => r.path === '/auth/oauth/revoke')?.form?.get('token')).toBe(
      REFRESH_TOKEN
    );
    expect(await stat(join(dir, LOGIN_FILE)).catch(() => undefined)).toBeUndefined();
  });

  it('revokes the refresh token a leftover temp file holds, and removes it', async () => {
    await mkdir(dir, { recursive: true });
    const temp = join(dir, 'auth.json.123.abcd.tmp');
    await writeFile(temp, JSON.stringify(saved({ refreshToken: 'from-a-temp-file' })), {
      mode: 0o600,
    });
    const run = await runLogin(stub, ['logout'], dir);
    expect(run.stdout).toBe('Signed out.\n');
    expect(stub.requests.find((r) => r.path === '/auth/oauth/revoke')?.form?.get('token')).toBe(
      'from-a-temp-file'
    );
    expect(await stat(temp).catch(() => undefined)).toBeUndefined();
  });

  it('--json says whether the server session was ended', async () => {
    await seed();
    const ended = await runLogin(stub, ['logout', '--json'], dir);
    expect(JSON.parse(ended.stdout)).toEqual({ signed_out: true, server_session_ended: true });
    await writeFile(join(dir, LOGIN_FILE), 'garbage', { mode: 0o600 });
    const unknown = await runLogin(stub, ['logout', '--json'], dir);
    expect(JSON.parse(unknown.stdout)).toEqual({ signed_out: true, server_session_ended: false });
  });

  it('says Signed out for a saved sign-in that has no refresh token, with nothing to revoke', async () => {
    await seed({ refreshToken: undefined });
    const run = await runLogin(stub, ['logout'], dir);
    expect(run.stdout).toBe('Signed out.\n');
    expect(stub.requests).toHaveLength(0);
  });

  it('says so when nobody is signed in', async () => {
    const run = await runLogin(stub, ['logout'], dir);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('You are not signed in.\n');
    expect(stub.requests).toHaveLength(0);
  });

  it('removes a file it cannot read, and does not claim the server session ended', async () => {
    await writeFile(join(dir, LOGIN_FILE), 'garbage', { mode: 0o600 });
    const run = await runLogin(stub, ['logout'], dir);
    expect(run.stdout).toBe(NOT_TOLD);
    expect(run.stdout).not.toBe('Signed out.\n');
    expect(await stat(join(dir, LOGIN_FILE)).catch(() => undefined)).toBeUndefined();
  });

  it('does not hang on a FIFO at the saved sign-in path, and removes it', async () => {
    execFileSync('mkfifo', [join(dir, LOGIN_FILE)]);
    const run = await runLogin(stub, ['logout'], dir);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(NOT_TOLD);
    expect(await stat(join(dir, LOGIN_FILE)).catch(() => undefined)).toBeUndefined();
  });
});

describe('the lock around the saved sign-in', () => {
  /** A refresh with a strict, Core-like server: single-use tokens, and a replay revokes the family. */
  const strict = async (): Promise<void> => {
    stub.strictRotation = true;
    stub.refreshDelayMs = 150;
    await seed({ expiresAt: Date.now() - 1000 });
  };

  it('lets two commands that need a refresh at once present the token once, and both read the new one', async () => {
    await strict();
    const [one, two] = await Promise.all([setupCmd(['--no-open']), setupCmd(['--no-open'])]);
    expect(stub.requests.filter((r) => r.form?.get('grant_type') === 'refresh_token')).toHaveLength(
      1
    );
    for (const run of [one, two]) {
      expect(run.stderr).not.toContain('expired');
      expect(run.stdout).toBe('4 of 4 steps left.\n');
    }
    expect(stub.familyRevoked).toBe(false);
    const stored = JSON.parse(await readFile(join(dir, LOGIN_FILE), 'utf8')) as StoredLogin;
    expect(stored.refreshToken).toBe('rotated-1');
  });

  it('removes the lock when it is done', async () => {
    await seed({ expiresAt: Date.now() - 1000 });
    await setupCmd(['--no-open']);
    expect(await stat(join(dir, 'auth.json.lock')).catch(() => undefined)).toBeUndefined();
  });

  it('deletes a dead file only if it still holds the refresh token it presented', async () => {
    await seed({ expiresAt: Date.now() - 1000 });
    stub.refreshStatus = 400;
    // Another writer (one that does not take the lock) replaces the file while the refresh is in flight.
    stub.onRefresh = async () => {
      await seed({ refreshToken: 'a-newer-sign-in' });
    };
    const run = await setupCmd(['--no-open']);
    expect(run.stderr).toContain('Your sign-in has expired.');
    const stored = JSON.parse(await readFile(join(dir, LOGIN_FILE), 'utf8')) as StoredLogin;
    expect(stored.refreshToken).toBe('a-newer-sign-in');
  });

  it('waits for a lock held by another command, then proceeds', async () => {
    await seed({ expiresAt: Date.now() - 1000 });
    const lock = join(dir, 'auth.json.lock');
    await writeFile(lock, 'someone-else', { mode: 0o600 });
    setTimeout(() => void rm(lock, { force: true }), 200);
    const run = await setupCmd(['--no-open']);
    expect(run.stdout).toBe('4 of 4 steps left.\n');
  });

  it('takes over a lock older than the stale limit', async () => {
    await seed({ expiresAt: Date.now() - 1000 });
    const lock = join(dir, 'auth.json.lock');
    await writeFile(lock, 'a-crashed-holder', { mode: 0o600 });
    await utimes(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const run = await setupCmd(['--no-open'], { lockStaleMs: 1000 });
    expect(run.stdout).toBe('4 of 4 steps left.\n');
  });

  it('gives up with a plain message when the lock is never released', async () => {
    await seed({ expiresAt: Date.now() - 1000 });
    await writeFile(join(dir, 'auth.json.lock'), 'someone-else', { mode: 0o600 });
    const run = await setupCmd(['--no-open'], { lockWaitMs: 150 });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('could not read your setup progress.');
    expect(stub.requests.some((r) => r.form?.get('grant_type') === 'refresh_token')).toBe(false);
  });
});

describe('the state directory', () => {
  it('refuses to save into a directory that others can enter, and leaves its mode alone', async () => {
    await chmod(dir, 0o755);
    const run = await login();
    expect(run.code).toBe(EXIT.failed);
    expect(run.stderr).toContain('Signed in, but the sign-in was not saved:');
    expect(run.stderr).toContain('with no access for group or others');
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    expect(await stat(join(dir, LOGIN_FILE)).catch(() => undefined)).toBeUndefined();
    // The refresh token the server issued is ended, not left open.
    expect(stub.requests.find((r) => r.path === '/auth/oauth/revoke')?.form?.get('token')).toBe(
      REFRESH_TOKEN
    );
  });

  it('makes a directory it creates 0700 whatever the umask', async () => {
    const inner = join(dir, 'made');
    // A umask that strips the owner's write bit: mkdir alone would make the directory 0500.
    const old = process.umask(0o222);
    try {
      const run = await runLogin(stub, ['login', ...hostFlags(stub)], dir, {
        env: { NOBLECLOAK_CLI_STATE_DIR: inner },
      });
      expect(run.code).toBe(0);
    } finally {
      process.umask(old);
    }
    expect((await stat(inner)).mode & 0o777).toBe(0o700);
  });
});

describe('what login replaces', () => {
  it('revokes the session of an earlier file it refuses for its mode', async () => {
    await seed({ refreshToken: 'older-refresh-token' });
    await chmod(join(dir, LOGIN_FILE), 0o644);
    const run = await login();
    expect(run.code).toBe(0);
    expect(stub.requests.find((r) => r.path === '/auth/oauth/revoke')?.form?.get('token')).toBe(
      'older-refresh-token'
    );
    expect((await stat(join(dir, LOGIN_FILE))).mode & 0o777).toBe(0o600);
  });

  it('warns that a session may be open when the earlier file cannot be read at all', async () => {
    await writeFile(join(dir, LOGIN_FILE), 'garbage', { mode: 0o600 });
    const run = await login();
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(
      'warning: the earlier saved sign-in could not be read, so its session on the server may still be open.'
    );
  });

  it('sweeps a leftover temp file and revokes the refresh token it holds', async () => {
    const temp = join(dir, 'auth.json.99.beef.tmp');
    await writeFile(temp, JSON.stringify(saved({ refreshToken: 'from-a-temp-file' })), {
      mode: 0o600,
    });
    const run = await login();
    expect(run.code).toBe(0);
    expect(stub.requests.find((r) => r.path === '/auth/oauth/revoke')?.form?.get('token')).toBe(
      'from-a-temp-file'
    );
    expect(await stat(temp).catch(() => undefined)).toBeUndefined();
  });
});

describe('a saved sign-in that is not a regular file, and a URL with a password', () => {
  it('refuses a FIFO as the saved sign-in without waiting on it', async () => {
    execFileSync('mkfifo', [join(dir, LOGIN_FILE)]);
    const run = await setupCmd(['--no-open']);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('it is not a regular file');
  });

  it('refuses a FIFO as --user-token-file without waiting on it', async () => {
    const fifo = join(dir, 'token-fifo');
    execFileSync('mkfifo', [fifo]);
    const run = await runLogin(
      stub,
      [
        'sp',
        'list',
        '--org',
        ORG,
        '--auth-url',
        stub.url,
        '--admin-audience',
        ADMIN_AUDIENCE,
        '--user-token-file',
        fifo,
      ],
      dir
    );
    expect(run.code).toBe(EXIT.usage);
    expect(run.stderr).toContain('--user-token-file is not a regular file.');
  });

  it('refuses an --auth-url with a username or password, without echoing it', async () => {
    const run = await runLogin(
      stub,
      ['login', '--auth-url', 'https://alice:hunter2@auth.example.com', '--admin-audience', 'a'],
      dir
    );
    expect(run.code).toBe(EXIT.usage);
    expect(run.stderr).toContain('must not contain a username or password');
    expect(run.stderr).not.toContain('hunter2');
    expect(run.stderr).not.toContain('alice');
  });
});

describe('the saved sign-in file', () => {
  const env = (): { env: Record<string, string>; platform: NodeJS.Platform } => ({
    env: { NOBLECLOAK_CLI_STATE_DIR: dir },
    platform: process.platform,
  });

  it('reads back what was written', async () => {
    const written = saved();
    await writeLogin(env(), written);
    expect(await readLogin(env())).toEqual({ kind: 'found', login: written });
  });

  it('reads as none when there is no file', async () => {
    expect(await readLogin(env())).toEqual({ kind: 'none' });
  });

  it('refuses a file of another format version', async () => {
    await writeFile(join(dir, LOGIN_FILE), JSON.stringify({ ...saved(), version: 2 }), {
      mode: 0o600,
    });
    expect(await readLogin(env())).toEqual({
      kind: 'unusable',
      reason: 'it is not a sign-in this version understands',
    });
  });

  it('refuses a file with a member of the wrong type', async () => {
    await writeFile(join(dir, LOGIN_FILE), JSON.stringify({ ...saved(), expiresAt: 'soon' }), {
      mode: 0o600,
    });
    expect((await readLogin(env())).kind).toBe('unusable');
  });

  it('keeps the plugin-compatible member names', async () => {
    await seed();
    const stored = JSON.parse(await readFile(join(dir, LOGIN_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    for (const name of [
      'accessToken',
      'refreshToken',
      'expiresAt',
      'tokenType',
      'scope',
      'authenticatedAt',
      'issuer',
      'orgId',
      'sub',
    ]) {
      expect(stored).toHaveProperty(name);
    }
  });
});
