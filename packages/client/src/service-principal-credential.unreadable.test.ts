import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadServicePrincipalCredential, ServicePrincipalError } from './service-principal.js';
import { credential, ecKey, without } from './service-principal.test-support.js';

async function failure(promise: Promise<unknown>): Promise<ServicePrincipalError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ServicePrincipalError) return error;
    throw error;
  }
  throw new Error('expected the load to fail');
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'nc-sp-unreadable-'));
}

const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadServicePrincipalCredential: an unreadable credential file', () => {
  it('words the whole message: resolved path, where it came from, the cause', async () => {
    const dir = await tempDir();
    const path = join(dir, 'absent.json');
    const err = await failure(loadServicePrincipalCredential(path));
    expect(err.code).toBe('credential_unreadable');
    expect(err.message).toBe(
      `Cannot read the service-principal credential file ${resolve(path)} (named by the path argument): no such file.`
    );
    expect(err.cause).toBe('ENOENT');
  });

  it('says the file is a directory (EISDIR)', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'a.d'));
    const err = await failure(loadServicePrincipalCredential(join(dir, 'a.d')));
    expect(err.message).toBe(
      `Cannot read the service-principal credential file ${join(dir, 'a.d')} (named by the path argument): it is a directory, not a file.`
    );
    expect(err.cause).toBe('EISDIR');
  });

  it.skipIf(!canChmod)('says permission was denied (EACCES)', async () => {
    const dir = await tempDir();
    const path = join(dir, 'locked.json');
    await writeFile(path, '{}');
    await chmod(path, 0o000);
    const err = await failure(loadServicePrincipalCredential(path));
    expect(err.code).toBe('credential_unreadable');
    expect(err.message).toContain(
      `${resolve(path)} (named by the path argument): permission denied.`
    );
    expect(err.cause).toBe('EACCES');
  });

  it('says a parent of the path is not a directory (ENOTDIR)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'plain.txt');
    await writeFile(file, 'x');
    const err = await failure(loadServicePrincipalCredential(join(file, 'inner.json')));
    expect(err.message).toContain('a parent of that path is not a directory');
  });

  it.skipIf(process.platform === 'win32')('says a symbolic link loops (ELOOP)', async () => {
    const dir = await tempDir();
    const path = join(dir, 'loop.json');
    await symlink(path, path);
    const err = await failure(loadServicePrincipalCredential(path));
    expect(err.message).toContain(resolve(path));
    expect(err.message).toContain('too many symbolic links');
  });

  it('resolves a relative path against the working directory and names the absolute path', async () => {
    const dir = await tempDir();
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const err = await failure(loadServicePrincipalCredential('./sp-credentials.json'));
    expect(err.message).toContain(join(dir, 'sp-credentials.json'));
    expect(err.message).not.toContain('./sp-credentials.json');
  });

  it('names the env var as where the path came from when the source was not passed', async () => {
    const dir = await tempDir();
    const path = join(dir, 'absent.json');
    const err = await failure(
      loadServicePrincipalCredential(undefined, { env: { NOBLECLOAK_SP_CREDENTIALS: path } })
    );
    expect(err.message).toBe(
      `Cannot read the service-principal credential file ${path} (named by the path in NOBLECLOAK_SP_CREDENTIALS): no such file.`
    );
  });

  it('escapes control and bidi characters in the path, so a message cannot move a cursor or flip text', async () => {
    const dir = await tempDir();
    const esc = String.fromCharCode(0x1b);
    const rlo = String.fromCharCode(0x202e);
    const path = join(dir, `a${esc}[31m${rlo}.json`);
    const err = await failure(loadServicePrincipalCredential(path));
    expect(err.message).toContain('a\\u001b[31m\\u202e.json');
    expect(err.message).not.toContain(esc);
    expect(err.message).not.toContain(rlo);
  });

  it('escapes NEL and the line separator in a path', async () => {
    const dir = await tempDir();
    const nel = String.fromCharCode(0x85);
    const ls = String.fromCharCode(0x2028);
    const err = await failure(loadServicePrincipalCredential(join(dir, `a${nel}b${ls}c.json`)));
    expect(err.message).toContain('a\\u0085b\\u2028c.json');
    expect(err.message).not.toContain(nel);
    expect(err.message).not.toContain(ls);
  });

  it('does not echo a bare token-alphabet name directly under the working directory', async () => {
    const dir = await tempDir();
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const err = await failure(loadServicePrincipalCredential('./Ab3x9QzL'));
    expect(err.message).not.toContain('Ab3x9QzL');
  });

  it('does not echo a 16-character-or-longer token-alphabet string even when its directory exists', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'sub'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const err = await failure(loadServicePrincipalCredential('sub/Ab3x+9QzLmN0pQr'));
    expect(err.message).not.toContain('Ab3x+9QzLmN0pQr');
  });

  it('does not carry the contents of a credential file it did read when the key file is missing', async () => {
    const dir = await tempDir();
    const key = await ecKey();
    const d = key.privateJwk.d ?? 'missing';
    const rest = without(credential(key), 'private_jwk');
    const path = join(dir, 'cred.json');
    await writeFile(path, JSON.stringify({ ...rest, key_file: 'absent-key.json', note: d }));
    const err = await failure(loadServicePrincipalCredential(path));
    expect(err.message).toContain(join(dir, 'absent-key.json'));
    expect(err.message).not.toContain(d);
    expect(err.message).not.toContain(rest.client_id);
  });
});

describe('loadServicePrincipalCredential: a value that was never a path is not echoed', () => {
  async function secrets(): Promise<[string, string][]> {
    const key = await ecKey();
    const jwk = JSON.stringify(key.privateJwk);
    return [
      ['a base64 private JWK', btoa(jwk)],
      ['a base64url private JWK', btoa(jwk).replace(/\+/g, '-').replace(/\//g, '_')],
      ['a raw 43-character d', key.privateJwk.d ?? 'missing-d'],
      ['a ghp_ token', 'ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'],
      ['a long base64 string with a slash', `${'Zm9vYmFy'.repeat(4)}/YmF6${'Zm9v'.repeat(3)}`],
      ['a short base64 string with a slash', 'Zm9v/YmFy'],
      [
        'a base64 string that starts with a slash, so its directory exists',
        `/${'Zm9v'.repeat(12)}`,
      ],
      ['a 16-byte base64 secret under the root', '/Ab3x+9QzLmN0pQrStUvWw=='],
      ['a 24-character base64 string under the root', '/Ab3xQzLmN0pQrStUvWw+9aB'],
      ['a 10-character base64 string under the root', '/Ab3x+9QzL'],
      ['a postgres URL with a password', 'postgres://admin:S3cret@db.example.com'],
      [
        'an Azure connection string',
        'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=Zm9vYmFy==;EndpointSuffix=core.windows.net',
      ],
      ['a short bare word', 'hunter2'],
      ['a dotted token', `${'a'.repeat(30)}.${'b'.repeat(30)}.${'c'.repeat(43)}`],
    ];
  }

  it('through the path argument', async () => {
    for (const [name, secret] of await secrets()) {
      const err = await failure(loadServicePrincipalCredential(secret));
      expect(err.code, name).toBe('credential_unreadable');
      expect(err.message, name).not.toContain(secret);
      expect(err.message, name).toMatch(
        /^Cannot read the service-principal credential file \(named by the path argument\): /
      );
    }
  });

  it('through NOBLECLOAK_SP_CREDENTIALS', async () => {
    for (const [name, secret] of await secrets()) {
      const err = await failure(
        loadServicePrincipalCredential(undefined, { env: { NOBLECLOAK_SP_CREDENTIALS: secret } })
      );
      expect(err.message, name).not.toContain(secret);
      expect(err.message, name).toContain('(named by the path in NOBLECLOAK_SP_CREDENTIALS)');
    }
  });

  it('whatever its length: 255 and 256 characters are treated alike', async () => {
    for (const length of [255, 256]) {
      const secret = 'Ab1_'.repeat(length / 4 + 1).slice(0, length);
      const err = await failure(loadServicePrincipalCredential(secret));
      expect(err.message).not.toContain(secret.slice(0, 20));
    }
  });

  it('a key_file that holds JWK JSON, or a newline, is not echoed and cannot add a line', async () => {
    const dir = await tempDir();
    const key = await ecKey();
    const d = key.privateJwk.d ?? 'missing-d';
    const rest = without(credential(key), 'private_jwk');
    const path = join(dir, 'cred.json');
    for (const keyFile of [
      JSON.stringify(key.privateJwk),
      'k.json\nINJECTED line',
      'k\nINJECTED.json',
      `${d}\n`,
      '/Ab3x+9QzLmN0pQrStUvWw==',
    ]) {
      await writeFile(path, JSON.stringify({ ...rest, key_file: keyFile }));
      const err = await failure(loadServicePrincipalCredential(path));
      expect(err.code).toBe('credential_unreadable');
      expect(err.message).not.toContain(d);
      expect(err.message).not.toContain('INJECTED');
      expect(err.message).not.toContain('\n');
      expect(err.message).toMatch(/^Cannot read the key file: /);
    }
  });

  it('a path with a separator whose directory exists, or a name with an extension, is echoed', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'sub'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const noExtension = (await failure(loadServicePrincipalCredential('sub/creds'))).message;
    expect(noExtension).toContain(join(dir, 'sub', 'creds'));
    // A bare name with no separator and no extension is not shown, nor is one under a missing directory.
    expect((await failure(loadServicePrincipalCredential('creds'))).message).not.toContain('creds');
    expect((await failure(loadServicePrincipalCredential('gone/creds'))).message).not.toContain(
      'creds'
    );
    const upper = join(dir, 'CREDS.JSON');
    expect((await failure(loadServicePrincipalCredential(upper))).message).toContain(upper);
  });
});

describe('loadServicePrincipalCredential: a misspelled name next to noblecloak-*.json files', () => {
  const wanted = 'noblecloak-sp_1234-abcd1234.json';

  async function hint(dir: string, name = wanted): Promise<string> {
    return (await failure(loadServicePrincipalCredential(join(dir, name)))).message;
  }

  it('suggests the one nearest noblecloak-*.json file in that directory', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'noblecloak-sp_1234-abcd1235.json'), '{}');
    await writeFile(join(dir, 'unrelated.json'), '{}');
    expect(await hint(dir)).toBe(
      `Cannot read the service-principal credential file ${join(dir, wanted)} (named by the path argument): no such file. Did you mean noblecloak-sp_1234-abcd1235.json?`
    );
  });

  it('suggests nothing when no noblecloak-*.json file is there', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'unrelated.json'), '{}');
    expect(await hint(dir)).not.toContain('Did you mean');
  });

  it('does not suggest a sibling that is one edit away but not a noblecloak-*.json name', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'noblecloak-sp_1234-abcd1234.jsn'), '{}');
    expect(await hint(dir)).not.toContain('Did you mean');
  });

  it('does not suggest a noblecloak-*.json sibling that is more than two edits away', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'noblecloak-sp_1234-wxyz9876.json'), '{}');
    expect(await hint(dir)).not.toContain('Did you mean');
  });

  it('does not suggest another principal, even one edit away', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'noblecloak-sp_1235-abcd1234.json'), '{}');
    expect(await hint(dir)).not.toContain('Did you mean');
  });

  it('does not suggest a dev credential for a prod one, or the reverse', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'noblecloak-sp-prod.json'), '{}');
    expect(await hint(dir, 'noblecloak-sp-dev.json')).not.toContain('Did you mean');
  });

  it('does not suggest a same-principal sibling that is three edits away', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'noblecloak-sp_1234-abcd1xyz.json'), '{}');
    expect(await hint(dir)).not.toContain('Did you mean');
  });

  it.skipIf(process.platform === 'win32')('suggests a symlink to a credential file', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'real.json'), '{}');
    await symlink(join(dir, 'real.json'), join(dir, 'noblecloak-sp_1234-abcd1235.json'));
    expect(await hint(dir)).toContain('Did you mean noblecloak-sp_1234-abcd1235.json?');
  });

  it('suggests nothing when two files are equally near', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'noblecloak-sp_1234-abcd1231.json'), '{}');
    await writeFile(join(dir, 'noblecloak-sp_1234-abcd1232.json'), '{}');
    expect(await hint(dir, 'noblecloak-sp_1234-abcd1233.json')).not.toContain('Did you mean');
  });

  it('suggests nothing when the missing file is not a noblecloak-*.json name at all', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'noblecloak-sp_1234-abcd1235.json'), '{}');
    expect(await hint(dir, 'creds.json')).not.toContain('Did you mean');
  });

  it('does not suggest a directory named like a credential file', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'noblecloak-sp_1234-abcd1235.json'));
    expect(await hint(dir)).not.toContain('Did you mean');
  });

  it.skipIf(process.platform === 'win32')(
    'never suggests the very name that was asked for (a dangling symlink)',
    async () => {
      const dir = await tempDir();
      await symlink(join(dir, 'nowhere'), join(dir, wanted));
      expect(await hint(dir)).not.toContain('Did you mean');
    }
  );

  it('does not suggest when the directory itself is missing', async () => {
    const dir = await tempDir();
    const message = (await failure(loadServicePrincipalCredential(join(dir, 'no', wanted))))
      .message;
    expect(message).toContain('no such file');
    expect(message).not.toContain('Did you mean');
  });

  it.skipIf(!canChmod)(
    'gives no hint for a file that exists but cannot be read (EACCES)',
    async () => {
      const dir = await tempDir();
      const path = join(dir, wanted);
      await writeFile(path, '{}');
      await chmod(path, 0o000);
      await writeFile(join(dir, 'noblecloak-sp_1234-abcd1235.json'), '{}');
      const message = await hint(dir);
      expect(message).toContain('permission denied');
      expect(message).not.toContain('Did you mean');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'escapes control characters in a suggested name',
    async () => {
      const dir = await tempDir();
      await writeFile(join(dir, 'noblecloak-sp_1234-abcd123\u001b.json'), '{}');
      const message = await hint(dir);
      expect(message).toContain('Did you mean noblecloak-sp_1234-abcd123\\u001b.json?');
      // eslint-disable-next-line no-control-regex
      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  );
});

describe('loadServicePrincipalCredential: the key file', () => {
  it('names the key file path and the cause', async () => {
    const dir = await tempDir();
    const key = await ecKey();
    const rest = without(credential(key), 'private_jwk');
    const keyPath = join(dir, 'absent-key.json');
    const err = await failure(
      loadServicePrincipalCredential(JSON.stringify({ ...rest, key_file: keyPath }))
    );
    expect(err.code).toBe('credential_unreadable');
    expect(err.message).toBe(`Cannot read the key file ${keyPath}: no such file.`);
  });
});

describe('loadServicePrincipalCredential: unchanged for a file that reads', () => {
  it('still reports invalid JSON as invalid_credential, without a path', async () => {
    const dir = await tempDir();
    const path = join(dir, 'bad.json');
    await writeFile(path, '{not json');
    const err = await failure(loadServicePrincipalCredential(path));
    expect(err.code).toBe('invalid_credential');
    expect(err.message).toBe('The service-principal credential is not valid JSON.');
  });

  it('still reports a schema error as invalid_credential with the field message', async () => {
    const dir = await tempDir();
    const path = join(dir, 'schema.json');
    await writeFile(path, JSON.stringify({ client_id: 'nope' }));
    const err = await failure(loadServicePrincipalCredential(path));
    expect(err.code).toBe('invalid_credential');
    expect(err.message).toContain('exactly one of private_jwk');
  });
});
