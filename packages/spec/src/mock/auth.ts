/**
 * Tokens for the mock. A real deployment accepts only tokens its platform issuer signed, with the
 * API's own URI as `aud`; the mock plays the issuer with a throwaway key of its own so the audience,
 * signature and expiry rules can be exercised.
 */
import { base64Url, generateSigningKey, jwksOf, signJws } from './jws.js';
import type { SigningKey } from './jws.js';

export interface TokenClaims {
  readonly sub: string;
  /** Absent on a token that names no organisation. */
  readonly org?: string;
  readonly aud: string;
  /** Seconds since the epoch. */
  readonly exp: number;
  readonly principal_kind: 'user' | 'service' | 'agent';
  /** Space-separated OAuth scopes. A service principal's token carries `module_api`. */
  readonly scope?: string;
  /** Proof-of-possession binding (RFC 9449): the token is DPoP-bound. */
  readonly cnf?: { readonly jkt: string };
  readonly entitlements?: readonly string[];
  /** The OAuth client the token was issued to (RFC 9068 `client_id`). Absent on a token that names none. */
  readonly client_id?: string;
}

/** The principal a verified token identifies. */
export interface Principal {
  readonly sub: string;
  /** The organisation claim; empty when the token names none (see `hasOrg`). */
  readonly org: string;
  readonly hasOrg: boolean;
  readonly kind: 'user' | 'service' | 'agent';
  readonly scopes: readonly string[];
  /** The token carries `cnf.jkt`: it can only be used with a DPoP proof. */
  readonly dpopBound: boolean;
  readonly entitlements: readonly string[];
  /** The `client_id` claim: the client the token was issued to; absent when the token names none. */
  readonly clientId?: string;
}

export type TokenFailure = 'unauthorized' | 'invalid_token' | 'wrong_audience';

const decoder = new TextDecoder();

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Issues and verifies mock access tokens. */
export class MockIssuer {
  readonly #key: SigningKey;

  private constructor(key: SigningKey) {
    this.#key = key;
  }

  static async create(): Promise<MockIssuer> {
    return new MockIssuer(await generateSigningKey('mock-issuer-1'));
  }

  /** The issuer's public key set, for tests that want to check a token themselves. */
  get jwks(): ReturnType<typeof jwksOf> {
    return jwksOf([this.#key]);
  }

  mint(claims: TokenClaims): Promise<string> {
    return signJws(claims as unknown as Record<string, never>, this.#key, { typ: 'at+jwt' });
  }

  /** Verifies `token` for audience `aud` at `now`. */
  async verify(
    token: string,
    aud: string,
    now: Date,
    checkAudience = true,
    /** Deliberate defects: skip the signature check, skip the expiry check. */
    skip: { readonly signature?: boolean; readonly expiry?: boolean } = {}
  ): Promise<Principal | TokenFailure> {
    const parts = token.split('.');
    if (parts.length !== 3) return 'invalid_token';
    const [header = '', body = '', signature = ''] = parts;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { ...this.#key.publicJwk, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        fromBase64Url(signature),
        new TextEncoder().encode(`${header}.${body}`)
      );
      if (!valid && skip.signature !== true) return 'invalid_token';
      const claims = JSON.parse(decoder.decode(fromBase64Url(body))) as TokenClaims;
      if (skip.expiry !== true && claims.exp * 1000 <= now.getTime()) return 'invalid_token';
      if (checkAudience && claims.aud !== aud) return 'wrong_audience';
      if (!isPrincipalKind(claims.principal_kind)) return 'invalid_token';
      return {
        sub: claims.sub,
        org: claims.org ?? '',
        hasOrg: typeof claims.org === 'string' && claims.org !== '',
        kind: claims.principal_kind,
        scopes: (claims.scope ?? '').split(/\s+/).filter((scope) => scope !== ''),
        dpopBound: typeof claims.cnf?.jkt === 'string',
        entitlements: claims.entitlements ?? [],
        ...(typeof claims.client_id === 'string' ? { clientId: claims.client_id } : {}),
      };
    } catch {
      return 'invalid_token';
    }
  }
}

function isPrincipalKind(value: unknown): boolean {
  return value === 'user' || value === 'service' || value === 'agent';
}

export { base64Url };
