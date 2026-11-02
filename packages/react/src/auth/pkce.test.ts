import { describe, expect, it } from 'vitest';

import {
  base64UrlEncode,
  codeChallengeS256,
  newCodeVerifier,
  newState,
  randomBase64Url,
} from './pkce.js';

describe('PKCE', () => {
  it('T20-A1: the S256 challenge of the RFC 7636 appendix B verifier is the appendix B challenge', async () => {
    expect(await codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });

  it('encodes base64url without padding or the + and / characters', () => {
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(base64UrlEncode(new Uint8Array([1]))).toBe('AQ');
  });

  it('T20-A1: the verifier is 32 random bytes and the state 16, each fresh', () => {
    const verifiers = new Set(Array.from({ length: 20 }, newCodeVerifier));
    expect(verifiers.size).toBe(20);
    for (const verifier of verifiers) expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomBase64Url(3)).toHaveLength(4);
  });
});
