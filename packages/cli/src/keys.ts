import { createHash } from 'node:crypto';

/** The public half of a generated key: what the registration request carries. */
export interface PublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly alg: 'ES256';
  readonly use: 'sig';
}

/** The private key as the credential file stores it. `kid` is the RFC 7638 thumbprint. */
export interface PrivateJwk extends PublicJwk {
  readonly d: string;
  readonly kid: string;
}

export interface GeneratedKey {
  readonly publicJwk: PublicJwk;
  readonly privateJwk: PrivateJwk;
}

/** The RFC 7638 thumbprint of an EC key: SHA-256 over the members `crv`, `kty`, `x`, `y`, base64url. */
export function ecThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(canonical).digest('base64url');
}

/** Generates an EC P-256 key pair with WebCrypto and keeps only the exported JWK members. */
export async function generateKey(): Promise<GeneratedKey> {
  // Extractable because the private half must be exported into the credential file; the CryptoKey
  // itself goes out of scope when this function returns.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const exported = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const { x, y, d } = exported;
  if (x === undefined || y === undefined || d === undefined) {
    throw new Error('The runtime exported an incomplete EC key.');
  }
  const publicJwk: PublicJwk = { kty: 'EC', crv: 'P-256', x, y, alg: 'ES256', use: 'sig' };
  const kid = ecThumbprint(publicJwk);
  return { publicJwk, privateJwk: { ...publicJwk, d, kid } };
}
