import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Registered } from './api.js';
import {
  assertLoadable,
  credentialFromRegistration,
  replaceCredential,
  writeNewCredential,
} from './credential-file.js';
import { generateKey } from './keys.js';
import { SP, ORG } from './stub.test-support.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nc-cred-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const registered = (over: Partial<Registered['registration']> = {}): Registered => ({
  principal: {
    id: SP,
    client_id: `sp_${SP}`,
    org_id: ORG,
    name: 'ci agent',
    allowed_audiences: ['https://govern.example.com'],
    scopes: ['module_api'],
    key_thumbprints: [],
    expires_at: '2027-01-25T00:00:00.000Z',
    revoked_at: null,
  },
  registration: {
    client_id: `sp_${SP}`,
    assertion_audience: 'https://auth.example.com',
    token_endpoint: 'https://auth.example.com/auth/oauth/token',
    ...over,
  },
});

const build = async () => {
  const key = await generateKey();
  const credential = credentialFromRegistration(registered(), key.privateJwk);
  if (credential === undefined) throw new Error('expected a credential');
  return credential;
};

describe('credentialFromRegistration', () => {
  it('returns undefined when the token endpoint or the assertion audience is null', async () => {
    const { privateJwk } = await generateKey();
    expect(credentialFromRegistration(registered({ token_endpoint: null }), privateJwk)).toBe(
      undefined
    );
    expect(credentialFromRegistration(registered({ assertion_audience: null }), privateJwk)).toBe(
      undefined
    );
  });
});

describe('writeNewCredential', () => {
  it('creates the file with mode 0600', async () => {
    const path = join(dir, 'c.json');
    await writeNewCredential(path, await build());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite an existing file, even one created after the caller checked', async () => {
    const path = join(dir, 'c.json');
    await writeFile(path, 'keep me');
    await expect(writeNewCredential(path, await build())).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe('keep me');
  });

  it('refuses a credential the SDK parser rejects, before creating anything', async () => {
    const path = join(dir, 'c.json');
    const credential = { ...(await build()), token_endpoint: 'http://auth.example.com/token' };
    await expect(writeNewCredential(path, credential)).rejects.toThrow('https');
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('writeNewCredential failure after the file is created', () => {
  it('removes the partial file so the path is free again', async () => {
    const credential = {
      ...(await build()),
      // Serialising runs after the exclusive open, so this fails with the file already created.
      toJSON: () => {
        throw new Error('cannot serialise');
      },
    };
    const out = join(dir, 'cred.json');
    await expect(writeNewCredential(out, credential)).rejects.toThrow('cannot serialise');
    expect(await readdir(dir)).toEqual([]);
    await writeNewCredential(out, await build());
    expect(await readdir(dir)).toEqual(['cred.json']);
  });
});

describe('replaceCredential', () => {
  it('renames a new 0600 file over the original (a new inode), leaving no temp file', async () => {
    const path = join(dir, 'c.json');
    await writeNewCredential(path, await build());
    const before = await stat(path);
    await replaceCredential(path, await build());
    const after = await stat(path);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['c.json']);
  });

  it('forces mode 0600 even when the original was looser', async () => {
    const path = join(dir, 'c.json');
    await writeNewCredential(path, await build());
    await chmod(path, 0o644);
    await replaceCredential(path, await build());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('leaves the original and no temp file when the credential is invalid', async () => {
    const path = join(dir, 'c.json');
    await writeNewCredential(path, await build());
    const before = await readFile(path);
    await expect(replaceCredential(path, { client_id: 'nope' })).rejects.toThrow();
    expect(Buffer.compare(await readFile(path), before)).toBe(0);
    expect(await readdir(dir)).toEqual(['c.json']);
  });

  it('removes its temp file when the rename fails', async () => {
    const target = join(dir, 'a-directory');
    await writeFile(join(dir, 'x'), '');
    await mkdir(target);
    await writeFile(join(target, 'inner'), '');
    // Renaming a file over a non-empty directory fails after the temp file was written.
    await expect(replaceCredential(target, await build())).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(['a-directory', 'x']);
  });
});

describe('assertLoadable', () => {
  it('accepts a credential built from a registration', async () => {
    assertLoadable(await build());
  });

  it('reports a field that looks like a secret without echoing its value', async () => {
    const credential = { ...(await build()), refresh_token: 'super-secret-value' };
    try {
      assertLoadable(credential);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain('refresh_token');
      expect(String(error)).not.toContain('super-secret-value');
    }
  });

  it('refuses a credential that carries key_file as well as private_jwk, as the SDK loader does', async () => {
    const credential = { ...(await build()), key_file: 'key.json' };
    expect(() => {
      assertLoadable(credential);
    }).toThrow(/exactly one of private_jwk and key_file/);
  });
});
