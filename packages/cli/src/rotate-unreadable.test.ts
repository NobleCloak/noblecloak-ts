import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config, run } from './harness.test-support.js';
import { ORG, startStub, type Stub } from './stub.test-support.js';

// `sp rotate --credentials` reads its file through the client's unreadable-file message: the same cause
// words and the same secret rule as `starter`. Each failure here is before any sign-in or request.

let stub: Stub;
let dir: string;

beforeEach(async () => {
  stub = await startStub();
  dir = await mkdtemp(join(tmpdir(), 'nc-rotate-unreadable-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stub.close();
  await rm(dir, { recursive: true, force: true });
});

const rotate = (credentials: string): ReturnType<typeof run> =>
  run(stub, ['sp', 'rotate', '--credentials', credentials, ...config(stub)]);

describe('sp rotate --credentials: a file that cannot be read', () => {
  it('a missing file: exit 2, the full message names the path and the cause', async () => {
    const missing = join(dir, 'gone.json');
    const result = await rotate(missing);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `error: Cannot read the --credentials file ${missing}: no such file.\n`
    );
    expect(stub.requests).toEqual([]);
  });

  it('a directory: says it is a directory, not a file', async () => {
    const folder = join(dir, 'cred.d');
    await mkdir(folder);
    const result = await rotate(folder);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `error: Cannot read the --credentials file ${folder}: it is a directory, not a file.\n`
    );
  });

  it('a missing generated name suggests the one nearest file of the same principal', async () => {
    await writeFile(join(dir, 'noblecloak-sp-ci-agent-a1b2c3.json'), '{}');
    const typo = join(dir, 'noblecloak-sp-ci-agent-a1b2c4.json');
    const result = await rotate(typo);
    expect(result.stderr).toBe(
      `error: Cannot read the --credentials file ${typo}: no such file. Did you mean noblecloak-sp-ci-agent-a1b2c3.json?\n`
    );
  });

  it('a relative path is resolved against the working directory', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const result = await rotate('sub/gone.json');
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `error: Cannot read the --credentials file ${join(dir, 'sub', 'gone.json')}: no such file.\n`
    );
  });

  it.each([
    ['a token', 'ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'],
    ['a base64 value', 'c3VwZXItc2VjcmV0LXByaXZhdGUta2V5LW1hdGVyaWFs=='],
    ['a URL with credentials', 'https://svc:hunter2hunter2@example.com/cred'],
    ['a quoted JSON value', '{"private_jwk":{"d":"s3cr3t-key-material"}}'],
  ])('%s given as the path is not printed', async (_name, secret) => {
    const result = await rotate(secret);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('error: Cannot read the --credentials file: no such file.\n');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain(secret.slice(4, 20));
    expect(stub.requests).toEqual([]);
  });

  it('control characters in a shown path are escaped, so the message stays on one line', async () => {
    const rlo = String.fromCodePoint(0x202e);
    const result = await rotate(join(dir, `bad\u001b[31m${rlo}name.json`));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('bad\\u001b[31m\\u202ename.json');
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stderr).not.toContain('\u001b');
    expect(result.stderr).not.toContain(rlo);
  });

  it('a missing file with no extension in an existing directory is named', async () => {
    await mkdir(join(dir, 'secrets'));
    const missing = join(dir, 'secrets', 'noblecloak_sp');
    const result = await rotate(missing);
    expect(result.stderr).toBe(
      `error: Cannot read the --credentials file ${missing}: no such file.\n`
    );
  });

  it('a directory with a plain name is named', async () => {
    const folder = join(dir, 'sub');
    await mkdir(folder);
    const result = await rotate(folder);
    expect(result.stderr).toBe(
      `error: Cannot read the --credentials file ${folder}: it is a directory, not a file.\n`
    );
  });
});

describe('sp rotate --credentials: a file that is read', () => {
  it('a newline in its name cannot start a second line of the message', async () => {
    const path = join(dir, 'forged\nerror: sign in again.json');
    await writeFile(path, '{nope');
    const result = await rotate(path);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `error: --credentials ${join(dir, 'forged\\u000aerror: sign in again.json')} is not valid JSON.\n`
    );
    expect(stub.requests).toEqual([]);
  });

  it('a newline in the name of a file that lacks org_id and sp_id stays on one line', async () => {
    const path = join(dir, 'forged\nerror: sign in again.json');
    await writeFile(path, '{}');
    const result = await rotate(path);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      `--credentials ${join(dir, 'forged\\u000aerror: sign in again.json')} has no org_id or sp_id;`
    );
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
  });
});

const create = (out: string): ReturnType<typeof run> =>
  run(stub, [
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
    ...config(stub),
  ]);

describe('sp create --out: the path in a message', () => {
  it('an existing file with a newline in its name stays on one line', async () => {
    const out = join(dir, 'forged\nerror: x.json');
    await writeFile(out, '{}');
    const result = await create(out);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `error: --out ${join(dir, 'forged\\u000aerror: x.json')} already exists; choose a path that does not.\n`
    );
  });

  it('a missing directory with a newline in its name stays on one line', async () => {
    const out = join(dir, 'no\nsuch', 'cred.json');
    const result = await create(out);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `error: --out ${join(dir, 'no\\u000asuch', 'cred.json')}: its directory cannot be examined (ENOENT).\n`
    );
    expect(stub.requests).toEqual([]);
  });

  it('the "was not written" hint escapes a newline in the name', async () => {
    const abort = new AbortController();
    stub.hangs.set('POST service-principals', () => {
      abort.abort();
    });
    const out = join(dir, 'forged\nerror: x.json');
    const result = await run(
      stub,
      [
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
        ...config(stub),
      ],
      { signal: abort.signal }
    );
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(`(${join(dir, 'forged\\u000aerror: x.json')} was not written)`);
  });

  it('prints the credential path escaped and the export line quoted for the shell', async () => {
    const out = join(dir, "it's\nhere.json");
    const result = await create(out);
    expect(result.code, result.stderr).toBe(0);
    const lines = result.stdout.split('\n');
    expect(lines).toContain(
      `  credential ${join(dir, "it's\\u000ahere.json")} (mode 0600; never commit it)`
    );
    expect(result.stdout).toContain(
      `  export NOBLECLOAK_SP_CREDENTIALS='${join(dir, "it'\\''s\nhere.json")}'\n`
    );
  });
});
