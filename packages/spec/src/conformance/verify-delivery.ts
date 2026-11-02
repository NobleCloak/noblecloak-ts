/**
 * Verifies the signature of a webhook delivery (rev 12): a JWS compact serialization, ES256, `kid` in the
 * protected header, checked against a key set. It is the receiver's half of the Resumption scheme without the
 * Resumption's expiry and tool checks; the runner also compares the signed payload with the delivery it came
 * with. Failures are `ResumptionError`s with the codes `malformed`, `unsupported_alg`, `unknown_kid` and
 * `bad_signature`.
 */
import { ResumptionError } from '@noblecloak/client';
import type { Jwks } from '@noblecloak/client';

const decoder = new TextDecoder();

function decode(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new ResumptionError('malformed', 'not base64url');
  const padded = segment
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(segment.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch (error) {
    throw new ResumptionError('malformed', 'not valid base64url', { cause: error });
  }
}

function header(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(decoder.decode(decode(segment)));
    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ResumptionError) throw error;
  }
  throw new ResumptionError('malformed', 'the protected header is not a JSON object');
}

/** Resolves when `jws` is a valid ES256 signature, by a key of `jwks`, over its own header and payload. */
export async function verifyDeliverySignature(jws: string, jwks: Jwks): Promise<void> {
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((part) => part === ''))
    throw new ResumptionError('malformed', 'a JWS compact serialization has three non-empty parts');
  const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = parts;
  const protectedHeader = header(encodedHeader);
  if (protectedHeader.alg !== 'ES256')
    throw new ResumptionError('unsupported_alg', 'alg is not ES256');
  const jwk = jwks.keys.find((key) => key.kid === protectedHeader.kid);
  if (
    jwk?.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string'
  )
    throw new ResumptionError('unknown_kid', 'no EC P-256 key for the kid in the key set');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    decode(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!valid)
    throw new ResumptionError('bad_signature', 'the signature does not match the payload');
}
