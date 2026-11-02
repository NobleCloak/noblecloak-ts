/** PKCE (RFC 7636) and random-value helpers. `crypto` is read inside the functions, never at import. */

/** Base64url without padding (RFC 4648 section 5). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** `byteLength` random bytes from the platform's secure generator, base64url encoded. */
export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** The S256 code challenge for a verifier: base64url(SHA-256(verifier)). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/** A code verifier: 32 random bytes, 43 characters. */
export const newCodeVerifier = (): string => randomBase64Url(32);

/** The `state` value: 16 random bytes. */
export const newState = (): string => randomBase64Url(16);
