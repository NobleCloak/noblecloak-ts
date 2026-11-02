import { describe, expect, it } from 'vitest';
import { ecThumbprint, generateKey } from './keys.js';

describe('ecThumbprint', () => {
  it('matches an RFC 7638 thumbprint computed independently with openssl', () => {
    expect(
      ecThumbprint({
        crv: 'P-256',
        kty: 'EC',
        x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
        y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
      })
    ).toBe('oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U');
  });
});

describe('generateKey', () => {
  it('returns an ES256 pair: the public half has no private member and the kid is the thumbprint', async () => {
    const { publicJwk, privateJwk } = await generateKey();
    expect(Object.keys(publicJwk).sort()).toEqual(['alg', 'crv', 'kty', 'use', 'x', 'y']);
    expect(privateJwk.d).toMatch(/^[\w-]{43}$/);
    expect(privateJwk.kid).toBe(ecThumbprint(publicJwk));
    expect({ ...privateJwk, d: undefined, kid: undefined }).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      alg: 'ES256',
      use: 'sig',
    });
  });

  it('signs and verifies with the exported halves', async () => {
    const { publicJwk, privateJwk } = await generateKey();
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
    const signer = await crypto.subtle.importKey('jwk', privateJwk, algorithm, false, ['sign']);
    const verifier = await crypto.subtle.importKey('jwk', publicJwk, algorithm, false, ['verify']);
    const data = new TextEncoder().encode('payload');
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, data);
    expect(
      await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, signature, data)
    ).toBe(true);
  });
});
