import { PolicyFormatError } from './errors.js';
import type { PolicyOrigin } from './types.js';
import { hasLoneSurrogate } from './validate.js';

/** The largest file an import reads: 32 MiB (an export of 9,000 policies is about 9 MB). */
export const MAX_INPUT_BYTES = 32 * 1024 * 1024;

/**
 * The file as text (without a leading byte-order mark) and as the bytes its digest is computed over: bytes as
 * given, text as its UTF-8 encoding.
 */
export function readInput(input: string | Uint8Array): { text: string; bytes: Uint8Array } {
  // A string's UTF-8 form is never shorter than its UTF-16 length, so a long string is refused unencoded.
  const size = typeof input === 'string' ? input.length : input.byteLength;
  if (size > MAX_INPUT_BYTES)
    throw new PolicyFormatError(
      'parse_error',
      `the file is larger than ${String(MAX_INPUT_BYTES)} bytes, the most an import reads`
    );
  if (typeof input === 'string') {
    // No file holds an unpaired surrogate, and TextEncoder would digest U+FFFD in its place.
    if (hasLoneSurrogate(input))
      throw new PolicyFormatError('parse_error', 'the text holds an unpaired UTF-16 surrogate');
    const bytes = new TextEncoder().encode(input);
    if (bytes.byteLength > MAX_INPUT_BYTES)
      throw new PolicyFormatError(
        'parse_error',
        `the file is larger than ${String(MAX_INPUT_BYTES)} bytes, the most an import reads`
      );
    return { text: input.replace(/^\uFEFF/, ''), bytes };
  }
  try {
    // `ignoreBOM: false` drops a leading byte-order mark from the text; the digest keeps it.
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(input), bytes: input };
  } catch (error) {
    throw new PolicyFormatError('parse_error', 'the file is not UTF-8', [], { cause: error });
  }
}

/** `{ format, digest }`, the digest the lowercase hex SHA-256 of the file's bytes (WebCrypto). */
export async function originOf(
  format: PolicyOrigin['format'],
  bytes: Uint8Array
): Promise<PolicyOrigin> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  );
  return { format, digest: [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
}
