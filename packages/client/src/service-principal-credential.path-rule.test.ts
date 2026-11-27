import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  describeUnreadableFile,
  loadServicePrincipalCredential,
  ServicePrincipalError,
} from './service-principal.js';
import { credential, ecKey, without } from './service-principal.test-support.js';

const fsError = (code: string): Error =>
  Object.assign(new Error(`${code}: /leaked/path`), { code });

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nc-sp-pathrule-'));
  await mkdir(join(dir, 'secrets'));
  await mkdir(join(dir, 'sub'));
  await mkdir(join(dir, 'configs'));
  return dir;
}

const describeIt = (given: string, code = 'ENOENT'): Promise<string> =>
  describeUnreadableFile(given, fsError(code), { what: 'the file' }).then((d) => d.message);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('describeUnreadableFile: when the path is shown', () => {
  it('shows an absolute missing file with no extension whose directory exists', async () => {
    const dir = await tempDir();
    const path = join(dir, 'secrets', 'noblecloak_sp');
    expect(await describeIt(path)).toBe(`Cannot read the file ${path}: no such file.`);
  });

  it('shows a path whose directory exists even when the whole is 16+ characters of the token alphabet', async () => {
    const dir = await tempDir();
    const path = join(dir, 'secrets', 'credential');
    expect(path.length).toBeGreaterThan(16);
    expect(await describeIt(path)).toBe(`Cannot read the file ${path}: no such file.`);
  });

  it('shows a directory with a plain name', async () => {
    const dir = await tempDir();
    const path = join(dir, 'sub');
    expect(await describeIt(path, 'EISDIR')).toBe(
      `Cannot read the file ${path}: it is a directory, not a file.`
    );
  });

  it('shows a relative path of 16+ characters whose directory exists, resolved against the working directory', async () => {
    const dir = await tempDir();
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    expect(await describeIt('configs/credential')).toBe(
      `Cannot read the file ${join(dir, 'configs', 'credential')}: no such file.`
    );
  });

  it('shows the path for ENOTDIR and ELOOP', async () => {
    const dir = await tempDir();
    const path = join(dir, 'secrets', 'noblecloak_sp');
    expect(await describeIt(path, 'ENOTDIR')).toBe(
      `Cannot read the file ${path}: a parent of that path is not a directory.`
    );
    expect(await describeIt(path, 'ELOOP')).toBe(
      `Cannot read the file ${path}: too many symbolic links.`
    );
  });
});

describe('describeUnreadableFile: when the path stays hidden', () => {
  const jwk = Buffer.from(JSON.stringify({ kty: 'EC', d: 's3cr3t-private-key-material' })).toString(
    'base64'
  );
  const secrets: readonly (readonly [string, string])[] = [
    ['an absolute base64 value', '/Ab3x+9QzLmN0pQrStUvWw=='],
    ['a base64 value under an existing directory', 'sub/Ab3x+9QzLmN0pQrStUvWw=='],
    ['a base64 value under ./', './Ab3x+9QzLmN0pQrStUvWw=='],
    ['a GitHub token under an existing directory', 'sub/ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'],
    ['a bare token', 'ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'],
    ['a base64 JWK', jwk],
    ['a base64 JWK under an existing directory', `sub/${jwk}`],
    ['a URL with credentials', 'https://svc:hunter2hunter2@example.com/cred'],
    ['JSON', '{"private_jwk":{"d":"s3cr3t-key-material"}}'],
  ];

  it.each(secrets)('%s is not printed', async (_name, secret) => {
    const dir = await tempDir();
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const message = await describeIt(secret);
    expect(message).toBe('Cannot read the file: no such file.');
  });
});

describe('describeUnreadableFile: a backslash is a separator only where the platform says so', () => {
  it.skipIf(sep === '\\')(
    'a POSIX value with backslashes is one name and is not printed',
    async () => {
      const dir = await tempDir();
      vi.spyOn(process, 'cwd').mockReturnValue(dir);
      for (const value of ['Ab3x9Qz\\LmN0pQrStUvWw', 'C:\\secrets\\Ab3x9QzLmN0']) {
        expect(await describeIt(value)).toBe('Cannot read the file: no such file.');
      }
    }
  );
});

describe('loadServicePrincipalCredential: a key_file value is guarded against its credential file directory', () => {
  async function keyFileMessage(keyFile: string): Promise<string> {
    const dir = await tempDir();
    const credDir = join(dir, 'sub');
    const key = await ecKey();
    const rest = without(credential(key), 'private_jwk');
    const path = join(credDir, 'cred.json');
    await writeFile(path, JSON.stringify({ ...rest, key_file: keyFile }));
    try {
      await loadServicePrincipalCredential(path);
    } catch (error) {
      if (error instanceof ServicePrincipalError) return error.message;
      throw error;
    }
    throw new Error('expected the load to fail');
  }

  it.each(['./Ab3x9QzLmN0', '../Ab3x9QzLmN0'])('%s is not printed', async (keyFile) => {
    const message = await keyFileMessage(keyFile);
    expect(message).toBe('Cannot read the key file: no such file.');
  });

  it('a key file name that looks like a file is still shown', async () => {
    const message = await keyFileMessage('./key.jwk');
    expect(message).toContain('key.jwk');
  });
});
