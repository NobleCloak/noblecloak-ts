/**
 * Verification of a Resumption.
 *
 * A Resumption's `signature` is a JWS compact serialization (ES256, `kid` in the protected header)
 * whose payload is the JSON object without `signature`. A runtime verifies it against the key set at
 * `/.well-known/jwks.json` and checks that what it is about to run is what was approved: the
 * `tool_ref` and the `action_digest` (a digest binds the arguments, not the tool). The check uses the
 * platform's WebCrypto and has no dependency.
 */
import type { components } from './schema.js';

/** The signed payload of a Resumption: the object without its `signature`. */
export type ResumptionPayload = Omit<components['schemas']['Resumption'], 'signature'>;

/** A JSON Web Key Set, as served at `/.well-known/jwks.json`. */
export interface Jwks {
  readonly keys: readonly {
    readonly kty: string;
    readonly crv?: string;
    readonly kid?: string;
    readonly [member: string]: unknown;
  }[];
}

/** What the runtime is about to run. */
export interface ExpectedAction {
  readonly tool_ref: string;
  /** The argument digest of the arguments as the runtime will send them. */
  readonly arg_digest: string;
}

export type ResumptionErrorCode =
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_kid'
  | 'bad_signature'
  | 'expired'
  | 'not_approved'
  | 'tool_mismatch'
  | 'digest_mismatch'
  | 'replayed';

/** Why a Resumption was rejected. */
export class ResumptionError extends Error {
  readonly code: ResumptionErrorCode;

  constructor(code: ResumptionErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'ResumptionError';
    this.code = code;
  }
}

/**
 * Remembers which Resumptions a runtime has already acted on. A Resumption is a statement, not a
 * single-use credential: single use is the server's `/consume`. A runtime that must not run the same
 * Resumption twice (a retry after a crash, a duplicate push) keeps one of these.
 */
export interface ResumptionReplayGuard {
  /**
   * Records `key` and returns true the first time it is seen. Returns false for a key already
   * recorded. `expiresAt` lets an implementation forget the key afterwards.
   */
  firstUse(key: string, expiresAt: Date): boolean | Promise<boolean>;
}

/** A guard that keeps keys in memory until they expire. For one process; not shared. */
export class InMemoryReplayGuard implements ResumptionReplayGuard {
  readonly #seen = new Map<string, number>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  firstUse(key: string, expiresAt: Date): boolean {
    const now = this.#now().getTime();
    for (const [seen, until] of this.#seen) if (until <= now) this.#seen.delete(seen);
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, expiresAt.getTime());
    return true;
  }
}

export interface VerifyOptions {
  /** The current time. Defaults to now. */
  readonly now?: Date;
  /** Clock skew tolerated when checking expiry, in seconds. Defaults to 0. */
  readonly clockSkewSeconds?: number;
  /**
   * The resolutions a runtime acts on. Defaults to `['approved']`: a validly signed Resumption whose
   * resolution is `rejected` (or anything else) is rejected with `not_approved`, because the signature
   * proves who said it, not that the answer was yes.
   */
  readonly acceptResolutions?: readonly string[];
  /** When set, a Resumption already seen by the guard is rejected with `replayed`. */
  readonly replayGuard?: ResumptionReplayGuard;
}

const decoder = new TextDecoder();

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new ResumptionError('malformed', 'not base64url');
  if (text.length % 4 === 1)
    throw new ResumptionError('malformed', 'not valid base64url: the length is impossible');
  const padded = text
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch (error) {
    throw new ResumptionError('malformed', 'not valid base64url', { cause: error });
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // atob drops the unused trailing bits of the last character, so `AB` and `AC` decode alike. Refuse
  // every spelling but the one canonical encoding of the bytes: a signature has exactly one text.
  if (toBase64Url(bytes) !== text) {
    throw new ResumptionError('malformed', 'not canonical base64url: unused trailing bits are set');
  }
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseJsonSegment(segment: string, what: string): Record<string, unknown> {
  const decoded = decoder.decode(base64UrlDecode(segment));
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch (error) {
    throw new ResumptionError('malformed', `${what} is not JSON`, { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ResumptionError('malformed', `${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Verifies a Resumption's JWS against a key set and against the action the runtime is about to run.
 * Resolves to the payload when everything holds; rejects with a {@link ResumptionError} otherwise.
 *
 * Checks, in order: structure; `alg` is ES256; `kid` names a key in `jwks`; the signature; the payload
 * has not expired; `resolution` is one of `options.acceptResolutions` (default `approved`);
 * `tool_ref` equals the expected one; `action_digest` equals the expected digest; and,
 * when a guard is given, that the approval's Resumption has not been seen (keyed on `approval_id`).
 */
export async function verifyResumption(
  jws: string,
  jwks: Jwks,
  expected: ExpectedAction,
  options: VerifyOptions = {}
): Promise<ResumptionPayload> {
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw new ResumptionError('malformed', 'a JWS compact serialization has three non-empty parts');
  }
  const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = parts;
  const header = parseJsonSegment(encodedHeader, 'the protected header');
  if (header.alg !== 'ES256') {
    throw new ResumptionError('unsupported_alg', `alg ${JSON.stringify(header.alg)} is not ES256`);
  }
  const kid = header.kid;
  if (typeof kid !== 'string' || kid === '')
    throw new ResumptionError('malformed', 'no kid in the header');
  const jwk = jwks.keys.find((key) => key.kid === kid);
  if (jwk === undefined) throw new ResumptionError('unknown_kid', `no key ${kid} in the key set`);
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    throw new ResumptionError('unknown_kid', `key ${kid} is not an EC P-256 key`);
  }

  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new ResumptionError('malformed', `key ${kid} has no x and y coordinates`);
  }

  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64UrlDecode(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );
  } catch (error) {
    if (error instanceof ResumptionError) throw error;
    // Only the failures WebCrypto reports for bad input mean "this is not a valid signature or key".
    // Anything else (WebCrypto or P-256 unavailable, a TypeError from the runtime) is the environment
    // and propagates as itself rather than looking like a forgery.
    if (error instanceof Error && (error.name === 'DataError' || error.name === 'OperationError')) {
      throw new ResumptionError('bad_signature', 'the signature could not be verified', {
        cause: error,
      });
    }
    throw error;
  }
  if (!valid)
    throw new ResumptionError('bad_signature', 'the signature does not match the payload');

  const raw = parseJsonSegment(encodedPayload, 'the payload');
  const expiresAt = Date.parse(typeof raw.expires_at === 'string' ? raw.expires_at : '');
  const now = (options.now ?? new Date()).getTime();
  if (Number.isNaN(expiresAt))
    throw new ResumptionError('malformed', 'the payload has no expires_at');
  if (expiresAt + (options.clockSkewSeconds ?? 0) * 1000 <= now) {
    throw new ResumptionError('expired', `the Resumption expired at ${String(raw.expires_at)}`);
  }
  const accepted = options.acceptResolutions ?? ['approved'];
  if (typeof raw.resolution !== 'string' || !accepted.includes(raw.resolution)) {
    throw new ResumptionError(
      'not_approved',
      `the resolution is ${JSON.stringify(raw.resolution)}, not one of ${JSON.stringify(accepted)}`
    );
  }
  if (raw.tool_ref !== expected.tool_ref) {
    throw new ResumptionError(
      'tool_mismatch',
      `approved for ${JSON.stringify(raw.tool_ref)}, about to run ${JSON.stringify(expected.tool_ref)}`
    );
  }
  if (raw.action_digest !== expected.arg_digest) {
    throw new ResumptionError(
      'digest_mismatch',
      'the arguments are not the ones that were approved'
    );
  }
  const payload = raw as unknown as ResumptionPayload;
  if (options.replayGuard !== undefined) {
    if (typeof payload.approval_id !== 'string' || payload.approval_id === '')
      throw new ResumptionError('malformed', 'the payload has no approval_id');
    // One Resumption exists per approval, so the approval is the key. The signature is not: ECDSA
    // admits a second valid signature for the same payload (s -> n - s), and the signature text
    // admitted other spellings of the same bytes before the canonical check above.
    // The key must outlive every moment the Resumption can still pass the expiry check above, which
    // is expires_at plus the skew; a guard that forgets it at expires_at would accept a duplicate.
    const keepUntil = new Date(expiresAt + (options.clockSkewSeconds ?? 0) * 1000);
    const fresh = await options.replayGuard.firstUse(payload.approval_id, keepUntil);
    if (!fresh) throw new ResumptionError('replayed', 'this Resumption was already acted on');
  }
  return payload;
}
