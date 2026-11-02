import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadServicePrincipalCredential,
  parseServicePrincipalCredential,
  ServicePrincipalError,
} from './service-principal.js';
import { credential, ecKey, rsaKey, without } from './service-principal.test-support.js';

async function codeOf(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    if (error instanceof ServicePrincipalError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('parseServicePrincipalCredential', () => {
  it('accepts an EC P-256 credential and an RSA-2048 credential', async () => {
    const ec = credential(await ecKey());
    expect(parseServicePrincipalCredential(ec).client_id).toBe(ec.client_id);
    const rsa = credential(await rsaKey());
    expect(parseServicePrincipalCredential(rsa).private_jwk.kty).toBe('RSA');
  });

  it('carries org_id and ignores benign extra fields', async () => {
    const value = { ...credential(await ecKey()), org_id: 'org-1', name: 'agent', scopes: ['a'] };
    expect(parseServicePrincipalCredential(value).org_id).toBe('org-1');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('rejects %s as malformed', (_name, value) => {
    expect(() => parseServicePrincipalCredential(value)).toThrow(ServicePrincipalError);
  });

  it('rejects a client_id that is not sp_<uuid>', async () => {
    const value = credential(await ecKey(), { client_id: 'sp_nope' });
    expect(() => parseServicePrincipalCredential(value)).toThrow(/client_id/);
  });

  it('rejects a token_endpoint that is not https (loopback http is allowed)', async () => {
    const key = await ecKey();
    expect(() =>
      parseServicePrincipalCredential(
        credential(key, { token_endpoint: 'http://api.example.test/t' })
      )
    ).toThrow(/token_endpoint/);
    expect(() =>
      parseServicePrincipalCredential(credential(key, { token_endpoint: 'not a url' }))
    ).toThrow(/token_endpoint/);
    expect(() =>
      parseServicePrincipalCredential(credential(key, { token_endpoint: 'http://127.0.0.1:9/t' }))
    ).not.toThrow();
    expect(() =>
      parseServicePrincipalCredential(credential(key, { token_endpoint: 'http://localhost:9/t' }))
    ).not.toThrow();
  });

  it('rejects a missing assertion_audience', async () => {
    const value = { ...credential(await ecKey()), assertion_audience: '' };
    expect(() => parseServicePrincipalCredential(value)).toThrow(/assertion_audience/);
  });

  it('refuses a public-only key', async () => {
    const publicOnly = without((await ecKey()).privateJwk, 'd');
    const value = { ...credential(await ecKey()), private_jwk: publicOnly };
    expect(() => parseServicePrincipalCredential(value)).toThrow(/public/);
  });

  it('refuses an unsupported key type, curve and a short RSA key', async () => {
    const base = credential(await ecKey());
    const bad = (jwk: JsonWebKey) => () =>
      parseServicePrincipalCredential({ ...base, private_jwk: jwk });
    expect(bad({ kty: 'oct', k: 'AAAA' })).toThrow(/private_jwk/);
    expect(bad({ ...base.private_jwk, crv: 'P-384' })).toThrow(/P-256/);
    const small = (await rsaKey(1024)).privateJwk;
    expect(bad(small)).toThrow(/2048/);
  });

  it('measures the RSA modulus in bits: 2047 and 2040 are refused, 2048 is accepted even with a zero pad', async () => {
    const base = credential(await ecKey());
    const modulus = (bytes: number[]): string =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const rsa = (n: string): unknown => ({
      ...base,
      private_jwk: { kty: 'RSA', n, e: 'AQAB', d: 'x' },
    });
    const full = (length: number, first: number): number[] => [
      first,
      ...Array.from({ length: length - 1 }, () => 0xff),
    ];
    // 255 bytes (2040 bits) is 340 characters; 256 bytes with the top bit clear is 2047 bits.
    expect(() => parseServicePrincipalCredential(rsa(modulus(full(255, 0xff))))).toThrow(/2048/);
    expect(() => parseServicePrincipalCredential(rsa(modulus(full(256, 0x7f))))).toThrow(/2048/);
    expect(() => parseServicePrincipalCredential(rsa(modulus(full(256, 0x80))))).not.toThrow();
    expect(() =>
      parseServicePrincipalCredential(rsa(modulus([0, ...full(256, 0x80)])))
    ).not.toThrow();
    expect(() => parseServicePrincipalCredential(rsa('!!not base64!!'))).toThrow(/2048/);
  });

  it('refuses secret-looking extra fields', async () => {
    const base = credential(await ecKey());
    for (const field of ['client_secret', 'password', 'access_token', 'apiKey']) {
      expect(() => parseServicePrincipalCredential({ ...base, [field]: 'x' })).toThrow(field);
    }
  });

  it('never puts key material in an error message', async () => {
    const key = await ecKey();
    const value = { ...credential(key), client_secret: 'x', client_id: 'bad' };
    expect.hasAssertions();
    try {
      parseServicePrincipalCredential(value);
    } catch (error) {
      expect((error as Error).message).not.toContain(key.privateJwk.d ?? '');
    }
  });
});

describe('loadServicePrincipalCredential', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads inline JSON', async () => {
    const value = credential(await ecKey());
    const loaded = await loadServicePrincipalCredential(JSON.stringify(value));
    expect(loaded.client_id).toBe(value.client_id);
  });

  it('reads a file, and takes the source from NOBLECLOAK_SP_CREDENTIALS when none is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nc-sp-'));
    const value = credential(await ecKey());
    const file = join(dir, 'sp.json');
    await writeFile(file, JSON.stringify(value));
    expect((await loadServicePrincipalCredential(file)).client_id).toBe(value.client_id);
    const fromEnv = await loadServicePrincipalCredential(undefined, {
      env: { NOBLECLOAK_SP_CREDENTIALS: file },
    });
    expect(fromEnv.client_id).toBe(value.client_id);
    const inline = await loadServicePrincipalCredential(undefined, {
      env: { NOBLECLOAK_SP_CREDENTIALS: JSON.stringify(value) },
    });
    expect(inline.client_id).toBe(value.client_id);
  });

  it('resolves key_file relative to the credential file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nc-sp-'));
    const key = await ecKey();
    const rest = without(credential(key), 'private_jwk');
    await writeFile(join(dir, 'key.jwk.json'), JSON.stringify(key.privateJwk));
    await writeFile(join(dir, 'sp.json'), JSON.stringify({ ...rest, key_file: 'key.jwk.json' }));
    const loaded = await loadServicePrincipalCredential(join(dir, 'sp.json'));
    expect(loaded.private_jwk.d).toBe(key.privateJwk.d);
  });

  it('loads an operator-shaped sp.json: the extra fields are ignored and key_file is resolved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nc-sp-'));
    const key = await ecKey();
    await writeFile(join(dir, 'key.private.jwk.json'), JSON.stringify(key.privateJwk));
    const file = {
      ...without(credential(key), 'private_jwk'),
      id: '3f0c2a54-1b0e-4f4c-9d4e-0a1b2c3d4e5f',
      name: 'beta demo',
      audiences: ['https://govern.example.test'],
      scopes: ['module_api'],
      grant_type: 'client_credentials',
      expires_at: '2026-11-11T00:00:00Z',
      key_thumbprint: 'abc123',
      key_file: 'key.private.jwk.json',
    };
    await writeFile(join(dir, 'sp.json'), JSON.stringify(file));
    const loaded = await loadServicePrincipalCredential(join(dir, 'sp.json'));
    expect(loaded.client_id).toBe(file.client_id);
    expect(loaded.private_jwk.d).toBe(key.privateJwk.d);
  });

  it('refuses a credential with both private_jwk and key_file, or with neither', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nc-sp-'));
    const key = await ecKey();
    await writeFile(join(dir, 'key.jwk.json'), JSON.stringify(key.privateJwk));
    // The key file exists and is valid, so only the "exactly one" rule can refuse this.
    const both = JSON.stringify({ ...credential(key), key_file: join(dir, 'key.jwk.json') });
    await expect(loadServicePrincipalCredential(both)).rejects.toThrow(/exactly one of/);
    const rest = without(credential(key), 'private_jwk');
    await expect(loadServicePrincipalCredential(JSON.stringify(rest))).rejects.toThrow(
      /exactly one of/
    );
  });

  it('refuses a relative key_file in inline JSON, and reports a missing or malformed file', async () => {
    const key = await ecKey();
    const rest = without(credential(key), 'private_jwk');
    expect(
      await codeOf(loadServicePrincipalCredential(JSON.stringify({ ...rest, key_file: 'k.json' })))
    ).toBe('invalid_credential');
    const dir = await mkdtemp(join(tmpdir(), 'nc-sp-'));
    const missing = JSON.stringify({ ...rest, key_file: join(dir, 'absent.json') });
    expect(await codeOf(loadServicePrincipalCredential(missing))).toBe('credential_unreadable');
    await writeFile(join(dir, 'bad.json'), '{not json');
    const bad = JSON.stringify({ ...rest, key_file: join(dir, 'bad.json') });
    expect(await codeOf(loadServicePrincipalCredential(bad))).toBe('invalid_credential');
    expect(await codeOf(loadServicePrincipalCredential(join(dir, 'nope.json')))).toBe(
      'credential_unreadable'
    );
    expect(await codeOf(loadServicePrincipalCredential('{oops'))).toBe('invalid_credential');
  });

  it.each([
    ['a single-quoted .env value', (json: string) => `'${json}'`],
    ['a double-quoted value', (json: string) => `"${json.replace(/"/g, '\\"')}"`],
    ['a base64 CI secret', (json: string) => btoa(json)],
  ])('never echoes %s that is not a path, in the message or the cause', async (_name, wrap) => {
    const key = await ecKey();
    const json = wrap(JSON.stringify(credential(key)));
    const d = key.privateJwk.d ?? 'missing';
    for (const load of [
      () => loadServicePrincipalCredential(json),
      () => loadServicePrincipalCredential(undefined, { env: { NOBLECLOAK_SP_CREDENTIALS: json } }),
    ]) {
      let caught: unknown;
      try {
        await load();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ServicePrincipalError);
      const err = caught as ServicePrincipalError;
      expect(err.message).not.toContain(d);
      expect(err.message).not.toContain(json);
      expect(JSON.stringify(err.cause ?? '')).not.toContain(d);
    }
  });

  it('names a quoted value as JSON that does not start with "{"', async () => {
    const json = `'${JSON.stringify(credential(await ecKey()))}'`;
    expect(await codeOf(loadServicePrincipalCredential(json))).toBe('invalid_credential');
  });

  it('reads no environment when a source is passed, so a runtime without process can load inline JSON', async () => {
    const value = credential(await ecKey());
    const text = JSON.stringify(value);
    vi.stubGlobal('process', undefined);
    let loaded: Awaited<ReturnType<typeof loadServicePrincipalCredential>>;
    try {
      loaded = await loadServicePrincipalCredential(text);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(loaded.client_id).toBe(value.client_id);
  });

  it('says so when there is no source at all', async () => {
    expect(await codeOf(loadServicePrincipalCredential(undefined, { env: {} }))).toBe(
      'credential_missing'
    );
  });
});
