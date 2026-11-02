/** ES256 JWS signing for the mock server and the fixture generator. The verifier is the client's. */
import { jcs } from '@noblecloak/client';
import type { JsonValue } from '@noblecloak/client';

const encoder = new TextEncoder();

/** An ES256 signing key and its public JWK. */
export interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: {
    readonly kty: 'EC';
    readonly crv: 'P-256';
    readonly x: string;
    readonly y: string;
    readonly kid: string;
    readonly alg: 'ES256';
    readonly use: 'sig';
  };
}

/** Base64url without padding. */
export function base64Url(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A fresh P-256 key. Nothing persists it: a mock restart rotates the key. */
export async function generateSigningKey(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: String(jwk.x),
      y: String(jwk.y),
      kid,
      alg: 'ES256',
      use: 'sig',
    },
  };
}

/** The key set that verifies signatures made with `keys`. */
export function jwksOf(keys: readonly SigningKey[]): { keys: SigningKey['publicJwk'][] } {
  return { keys: keys.map((key) => key.publicJwk) };
}

/**
 * Signs `payload` as a JWS compact serialization: protected header `{alg, kid}`, and the payload's JCS
 * form as the payload bytes, so a verifier in any language can reproduce the signing input.
 */
export async function signJws(
  payload: JsonValue,
  key: SigningKey,
  header: Record<string, string> = {}
): Promise<string> {
  const protectedHeader = base64Url(JSON.stringify({ alg: 'ES256', kid: key.kid, ...header }));
  const body = base64Url(jcs(payload));
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    encoder.encode(`${protectedHeader}.${body}`)
  );
  return `${protectedHeader}.${body}.${base64Url(new Uint8Array(signature))}`;
}
