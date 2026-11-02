/**
 * Turns a service-principal credential into access tokens (RFC 7523 `private_key_jwt` client
 * authentication on a `client_credentials` grant, RFC 8707 `resource`). WebCrypto only.
 */
import {
  parseServicePrincipalCredential,
  type PrivateJwk,
  type ServicePrincipalCredential,
} from './service-principal-credential.js';
import { ServicePrincipalError } from './service-principal-error.js';

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** Core accepts an assertion lifetime of at most 300 s. */
const ASSERTION_LIFETIME_SECONDS = 120;
const DEFAULT_REFRESH_SKEW_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface TokenSourceOptions {
  /** The origin of the API the token is for. It becomes the token request's `resource` (RFC 8707). */
  readonly audience: string;
  /** Scopes to ask for. Omitted: the token carries the principal's stored scopes. */
  readonly scopes?: readonly string[];
  /** A fetch implementation. Defaults to the global one. */
  readonly fetch?: typeof globalThis.fetch;
  /** The current time in milliseconds since the epoch. Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** How long before expiry a cached token is replaced. Default 30 000. Capped at half the token's life. */
  readonly refreshSkewMs?: number;
  /** Abort a token request after this long. Default 10 000. */
  readonly timeoutMs?: number;
}

export interface ServicePrincipalTokenSource {
  /** An access token for the audience: cached, refreshed shortly before expiry, one request for concurrent callers. */
  readonly getToken: () => Promise<string>;
  /** Drops the cached token, so the next `getToken` mints a new one. */
  readonly invalidate: () => void;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const encoder = new TextEncoder();
const json = (value: unknown): string => base64Url(encoder.encode(JSON.stringify(value)));

/** The RFC 7638 thumbprint, which is the key id when the JWK has none. */
async function thumbprint(jwk: PrivateJwk): Promise<string> {
  const members =
    jwk.kty === 'EC'
      ? `{"crv":"${String(jwk.crv)}","kty":"EC","x":"${String(jwk.x)}","y":"${String(jwk.y)}"}`
      : `{"e":"${String(jwk.e)}","kty":"RSA","n":"${String(jwk.n)}"}`;
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(members))));
}

interface Signer {
  readonly alg: 'ES256' | 'RS256';
  readonly kid: string;
  readonly sign: (input: string) => Promise<string>;
}

/** The JWK reduced to the members WebCrypto needs, without the undefined ones. */
function keyMembers(jwk: PrivateJwk, names: readonly (keyof JsonWebKey)[]): JsonWebKey {
  const out: Record<string, unknown> = {};
  for (const name of names) if (jwk[name] !== undefined) out[name] = jwk[name];
  return out;
}

async function createSigner(jwk: PrivateJwk): Promise<Signer> {
  const kid = typeof jwk.kid === 'string' && jwk.kid !== '' ? jwk.kid : await thumbprint(jwk);
  // Only the key's own members: a stray `use`/`key_ops`/`alg` would make WebCrypto refuse the import.
  if (jwk.kty === 'EC') {
    const key = await crypto.subtle.importKey(
      'jwk',
      keyMembers(jwk, ['kty', 'crv', 'x', 'y', 'd']),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    return {
      alg: 'ES256',
      kid,
      // WebCrypto's ECDSA output is the raw r||s that JWS (RFC 7518 §3.4) wants.
      sign: async (input) =>
        base64Url(
          new Uint8Array(
            await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(input))
          )
        ),
    };
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    keyMembers(jwk, ['kty', 'n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi']),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return {
    alg: 'RS256',
    kid,
    sign: async (input) =>
      base64Url(
        new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(input)))
      ),
  };
}

function checkAudience(audience: string): string {
  let url: URL;
  try {
    url = new URL(audience);
  } catch {
    throw new ServicePrincipalError(
      'invalid_credential',
      'audience must be the API origin, such as https://govern.example.com.'
    );
  }
  // Only a path, query or hash is wrong; the URL parser already normalizes the host case and a default port.
  if (url.origin === 'null' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ServicePrincipalError(
      'invalid_credential',
      'audience must be an origin (scheme, host and optional port; no path), such as https://govern.example.com.'
    );
  }
  return url.origin;
}

interface Cached {
  readonly token: string;
  /** Epoch milliseconds after which the token is no longer served from the cache. */
  readonly usableUntil: number;
}

/** Reads the token endpoint's answer; throws a typed error for anything but a bearer token. */
async function readTokenResponse(response: Response): Promise<{ token: string; lifeMs: number }> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    // An unparseable body is a bad answer; a body that could not be read (the timeout aborted it, the
    // connection dropped) is no answer.
    if (!(cause instanceof SyntaxError)) {
      throw new ServicePrincipalError(
        'network_error',
        'The token response could not be read to the end.',
        { cause }
      );
    }
    body = undefined;
  }
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (!response.ok) {
    const oauthError = typeof record.error === 'string' ? record.error : undefined;
    if (oauthError === 'invalid_client') {
      throw new ServicePrincipalError(
        'invalid_client',
        "The token endpoint rejected the service principal (invalid_client): it is revoked or expired, or its key is not registered, or this machine's clock is more than 60 seconds off. Check the clock; otherwise rotate its key or create a new service principal.",
        { status: response.status, oauthError }
      );
    }
    if (oauthError !== undefined) {
      const description =
        typeof record.error_description === 'string' ? `: ${record.error_description}` : '';
      throw new ServicePrincipalError(
        'token_request_rejected',
        `The token endpoint refused the request (${oauthError}${description}).`,
        { status: response.status, oauthError }
      );
    }
    throw new ServicePrincipalError(
      'invalid_response',
      `The token endpoint answered ${String(response.status)} without an OAuth error.`,
      { status: response.status }
    );
  }
  const { access_token: token, token_type: type, expires_in: expiresIn } = record;
  if (
    typeof token !== 'string' ||
    token === '' ||
    typeof type !== 'string' ||
    type.toLowerCase() !== 'bearer' ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new ServicePrincipalError(
      'invalid_response',
      'The token endpoint answered 200 without a bearer access_token and a positive expires_in.',
      { status: response.status }
    );
  }
  return { token, lifeMs: expiresIn * 1000 };
}

/**
 * A `getToken` for a service principal. Each mint signs a new assertion (unique `jti`, 120 s lifetime,
 * `iss` = `sub` = `client_id`, `aud` = the credential's `assertion_audience`) and posts it with the
 * `resource`. The token is cached until shortly before it expires; concurrent callers share one request;
 * a failure is not cached. There is no refresh token: a new token is a new assertion.
 */
export function servicePrincipalTokenSource(
  credential: ServicePrincipalCredential,
  options: TokenSourceOptions
): ServicePrincipalTokenSource {
  const checked = parseServicePrincipalCredential(credential);
  const resource = checkAudience(options.audience);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? Date.now;
  const skew = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scope = options.scopes === undefined ? undefined : options.scopes.join(' ');

  let signer: Promise<Signer> | undefined;
  let cached: Cached | undefined;
  let inflight: Promise<string> | undefined;
  /** Bumped by `invalidate()`: a mint that started under an older generation does not write the cache. */
  let generation = 0;

  async function assertion(): Promise<string> {
    signer ??= createSigner(checked.private_jwk).catch((cause: unknown) => {
      signer = undefined;
      throw new ServicePrincipalError(
        'invalid_credential',
        'The private key could not be imported for signing.',
        { cause }
      );
    });
    const { alg, kid, sign } = await signer;
    const iat = Math.floor(clock() / 1000);
    const input = `${json({ alg, typ: 'JWT', kid })}.${json({
      iss: checked.client_id,
      sub: checked.client_id,
      aud: checked.assertion_audience,
      iat,
      exp: iat + ASSERTION_LIFETIME_SECONDS,
      jti: crypto.randomUUID(),
    })}`;
    return `${input}.${await sign(input)}`;
  }

  async function mint(): Promise<string> {
    const startedIn = generation;
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: checked.client_id,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: await assertion(),
      resource,
    });
    if (scope !== undefined) form.set('scope', scope);
    let response: Response;
    try {
      response = await fetchImpl(checked.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form.toString(),
        // A redirect would re-send the signed assertion to the Location; fail closed instead.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new ServicePrincipalError('network_error', 'The token request did not get an answer.', {
        cause,
      });
    }
    const { token, lifeMs } = await readTokenResponse(response);
    const refreshAt = Math.min(skew, lifeMs / 2);
    if (startedIn === generation) cached = { token, usableUntil: clock() + lifeMs - refreshAt };
    return token;
  }

  return {
    getToken: () => {
      if (cached !== undefined && clock() < cached.usableUntil)
        return Promise.resolve(cached.token);
      if (inflight === undefined) {
        const pending: Promise<string> = mint().finally(() => {
          // An invalidate() may have replaced `inflight` already; clear only our own.
          if (inflight === pending) inflight = undefined;
        });
        inflight = pending;
      }
      return inflight;
    },
    invalidate: () => {
      generation += 1;
      cached = undefined;
      inflight = undefined;
    },
  };
}
