/**
 * Argument digests: `sha256(RFC 8785 JCS(arguments as sent))`, lowercase hex.
 *
 * Canonicalisation is the `canonicalize` package's (Apache-2.0), an implementation of RFC 8785.
 * "Arguments as sent" means before any schema default is applied.
 *
 * `canonicalize` follows `JSON.stringify` and so silently rewrites what it cannot represent (NaN
 * becomes `null`, a lone surrogate an escape, a `toJSON` result replaces the value). A digest the
 * server would compute differently is a digest that never matches, so {@link jcs} first refuses what
 * the platform refuses: a value that is not JSON, a number that is not finite, an integer outside
 * the exact range of a double, a lone surrogate, and nesting deeper than {@link MAX_NESTING_DEPTH}.
 *
 * A tool whose schema declares a `contentEncoding: base64` or `x-noblecloak-streaming: true` argument
 * contributes the SHA-256 of the decoded bytes, or of the stream, in place of the value. Use
 * {@link sha256Hex} to compute that, and put the result in the argument before canonicalising.
 */
import canonicalize from 'canonicalize';

/** A JSON value. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const encoder = new TextEncoder();

/** Maximum nesting of arrays and objects, the arguments object itself being depth 1. */
export const MAX_NESTING_DEPTH = 64;

export type DigestErrorCode =
  | 'unsupported_type'
  | 'non_finite_number'
  | 'integer_out_of_range'
  | 'invalid_string'
  | 'nesting_too_deep';

/** Why a value cannot be canonicalised. A TypeError, so a caller that catches TypeError still does. */
export class DigestError extends TypeError {
  readonly code: DigestErrorCode;

  constructor(code: DigestErrorCode, message: string) {
    super(message);
    this.name = 'DigestError';
    this.code = code;
  }
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function assertCanonicalisable(value: unknown, depth: number, ancestors: object[]): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new DigestError('non_finite_number', `${String(value)} is not representable in JSON`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new DigestError(
        'integer_out_of_range',
        `${String(value)} is an integer outside ±(2^53 - 1)`
      );
    }
    return;
  }
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value))
      throw new DigestError('invalid_string', 'a string contains a lone surrogate');
    return;
  }
  if (typeof value !== 'object')
    throw new DigestError('unsupported_type', `${typeof value} is not a JSON value`);
  if (ancestors.includes(value)) throw new DigestError('unsupported_type', 'cyclic value');
  if (depth + 1 > MAX_NESTING_DEPTH) {
    throw new DigestError(
      'nesting_too_deep',
      `nesting exceeds the maximum depth of ${String(MAX_NESTING_DEPTH)}`
    );
  }
  ancestors.push(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i))
        throw new DigestError('unsupported_type', `array hole at index ${String(i)}`);
      assertCanonicalisable(value[i], depth + 1, ancestors);
    }
  } else {
    const proto: unknown = Object.getPrototypeOf(value);
    if (
      (proto !== Object.prototype && proto !== null) ||
      typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ) {
      throw new DigestError('unsupported_type', 'only plain objects and arrays are JSON values');
    }
    for (const [key, child] of Object.entries(value)) {
      if (hasLoneSurrogate(key))
        throw new DigestError('invalid_string', 'a key contains a lone surrogate');
      assertCanonicalisable(child, depth + 1, ancestors);
    }
  }
  ancestors.pop();
}

/** The RFC 8785 canonical form of `value`. Throws a {@link DigestError} for a value that is not JSON. */
export function jcs(value: JsonValue): string {
  assertCanonicalisable(value, 0, []);
  const canonical = canonicalize(value);
  if (canonical === undefined)
    throw new DigestError('unsupported_type', 'value has no JSON representation');
  return canonical;
}

/** Lowercase hex SHA-256 of a string (as UTF-8) or of bytes. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The argument digest of `args`: lowercase hex SHA-256 of their canonical form. */
export function argDigest(args: JsonValue): Promise<string> {
  return sha256Hex(jcs(args));
}
