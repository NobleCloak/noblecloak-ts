/**
 * An in-test authorization server, played through an injected `fetch`. It is the one hand-written fake of
 * the sign-in tests and follows the rules the module relies on: PKCE S256 only, public clients, an exact
 * redirect URI, `resource` required at authorize, no `scope` honoured, a single-use authorization code, a
 * single-use refresh token whose replay revokes the whole family, a 900 s access token measured by the
 * injected clock, revocation, and `error=access_denied` with the original `state`. It makes no network call.
 * Every host in it is a placeholder.
 */
import { base64UrlEncode } from '../auth/pkce.js';

export interface StubRequest {
  readonly url: string;
  readonly method: string;
  /** Header names are lower case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: URLSearchParams | null;
  readonly credentials: RequestCredentials | undefined;
  readonly mode: RequestMode | undefined;
}

export interface StubOptions {
  readonly issuer?: string;
  readonly resource?: string;
  readonly redirectUri?: string;
  readonly clientId?: string;
  readonly now?: () => number;
}

interface Family {
  revoked: boolean;
  current: string;
}

interface CodeGrant {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly issuedAt: number;
  used: boolean;
}

const CODE_LIFETIME_MS = 600_000;
const ACCESS_TOKEN_SECONDS = 900;

/** The address a `fetch` input names. */
export const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const sha256Base64Url = async (value: string): Promise<string> =>
  base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  );

export class StubAuthorizationServer {
  readonly issuer: string;
  readonly resource: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly requests: StubRequest[] = [];
  /** Authorize requests the stub refused, each with the reason. */
  readonly refusals: string[] = [];
  readonly fetch: typeof fetch;

  private readonly now: () => number;
  private readonly codes = new Map<string, CodeGrant>();
  private readonly families: Family[] = [];
  private readonly refreshTokens = new Map<string, Family>();
  private counter = 0;
  private dropNextRefreshResponse = false;
  private failNextTokenWith: { status: number; body: unknown } | null = null;
  private metadataStatus = 200;

  constructor(options: StubOptions = {}) {
    this.issuer = options.issuer ?? 'https://auth.example.test';
    this.resource = options.resource ?? 'https://govern.example.test';
    this.redirectUri = options.redirectUri ?? 'http://localhost:3000/approvals/callback';
    this.clientId = options.clientId ?? 'bnoauth_REPLACE_ME';
    this.now = options.now ?? Date.now;
    this.fetch = (input, init) => this.handle(input, init);
  }

  /** The authorize URL a module redirects to, as the stub would render it. */
  get authorizationEndpoint(): string {
    return `${this.issuer}/authorize`;
  }

  /** The requests made to one endpoint path (`/token`, `/revoke`, ...). */
  requestsTo(path: string): StubRequest[] {
    return this.requests.filter((request) => new URL(request.url).pathname === path);
  }

  /** The next refresh is processed (the token rotates) but its response is lost to the caller. */
  loseNextRefreshResponse(): void {
    this.dropNextRefreshResponse = true;
  }

  /** The next token request is answered with this status and body, whatever it asks. */
  failNextToken(status: number, body: unknown): void {
    this.failNextTokenWith = { status, body };
  }

  /** The metadata document is answered with this status. */
  setMetadataStatus(status: number): void {
    this.metadataStatus = status;
  }

  /**
   * Plays the person at the login and consent pages for an authorize URL: the callback URL the browser
   * would be sent to. Approve carries a code; Deny carries `error=access_denied`; both carry the original `state`.
   */
  authorize(authorizeUrl: string, decision: 'approve' | 'deny' = 'approve'): string {
    const url = new URL(authorizeUrl);
    const params = url.searchParams;
    const state = params.get('state') ?? '';
    const refuse = (reason: string): never => {
      this.refusals.push(reason);
      throw new Error(`stub authorize refused: ${reason}`);
    };
    if (params.get('response_type') !== 'code') refuse('response_type must be code');
    if (params.get('code_challenge_method') !== 'S256') refuse('only S256 is accepted');
    if (params.get('client_id') !== this.clientId) refuse('unknown client');
    if (params.get('redirect_uri') !== this.redirectUri) refuse('redirect_uri must match exactly');
    if (params.get('resource') !== this.resource) refuse('resource is required and must match');
    const challenge = params.get('code_challenge');
    if (challenge === null || challenge === '') refuse('code_challenge is required');
    const callback = new URL(this.redirectUri);
    if (decision === 'deny') {
      callback.searchParams.set('error', 'access_denied');
      callback.searchParams.set('state', state);
      return callback.toString();
    }
    this.counter += 1;
    const code = `code-${String(this.counter)}`;
    this.codes.set(code, {
      challenge: challenge ?? '',
      redirectUri: this.redirectUri,
      issuedAt: this.now(),
      used: false,
    });
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', state);
    return callback.toString();
  }

  /** Whether the refresh family of `token` is revoked (a replay or a revocation). */
  isRevoked(token: string): boolean {
    return this.refreshTokens.get(token)?.revoked === true;
  }

  /** How many refresh families exist and how many are still live. */
  get liveFamilies(): number {
    return this.families.filter((family) => !family.revoked).length;
  }

  private newFamilyToken(family: Family): string {
    this.counter += 1;
    const token = `rt-${String(this.counter)}`;
    family.current = token;
    this.refreshTokens.set(token, family);
    return token;
  }

  private tokenResponse(family: Family): Response {
    this.counter += 1;
    return json(200, {
      access_token: `at-${String(this.counter)}`,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: this.newFamilyToken(family),
    });
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = urlOf(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const body = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null;
    this.requests.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body,
      credentials: init?.credentials,
      mode: init?.mode,
    });
    const path = new URL(url).pathname;
    if (path === '/.well-known/oauth-authorization-server') {
      if (this.metadataStatus !== 200) return json(this.metadataStatus, { error: 'server_error' });
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        registration_endpoint: `${this.issuer}/register`,
        revocation_endpoint: `${this.issuer}/revoke`,
      });
    }
    if (path === '/token') return this.token(body);
    if (path === '/revoke') return this.revoke(body);
    if (path === '/register') return this.register(init);
    return json(404, { error: 'not_found' });
  }

  private register(init?: RequestInit): Response {
    const metadata: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (typeof metadata !== 'object' || metadata === null) {
      return json(400, { error: 'invalid_client_metadata' });
    }
    this.counter += 1;
    return json(201, { ...metadata, client_id: `bnoauth_stub_${String(this.counter)}` });
  }

  private revoke(body: URLSearchParams | null): Response {
    const family = this.refreshTokens.get(body?.get('token') ?? '');
    if (family !== undefined) family.revoked = true;
    return json(200, {});
  }

  private async token(body: URLSearchParams | null): Promise<Response> {
    if (this.failNextTokenWith !== null) {
      const { status, body: failure } = this.failNextTokenWith;
      this.failNextTokenWith = null;
      return json(status, failure);
    }
    if (body?.get('client_id') !== this.clientId) {
      return json(400, { error: 'invalid_request' });
    }
    const grantType = body.get('grant_type');
    if (grantType === 'authorization_code') return this.exchangeCode(body);
    if (grantType === 'refresh_token') return this.refreshGrant(body);
    return json(400, { error: 'unsupported_grant_type' });
  }

  private async exchangeCode(body: URLSearchParams): Promise<Response> {
    const grant = this.codes.get(body.get('code') ?? '');
    const verifier = body.get('code_verifier') ?? '';
    if (grant === undefined || grant.used || this.now() - grant.issuedAt > CODE_LIFETIME_MS) {
      return json(400, { error: 'invalid_grant' });
    }
    grant.used = true;
    if (body.get('redirect_uri') !== grant.redirectUri || verifier === '') {
      return json(400, { error: 'invalid_request' });
    }
    if ((await sha256Base64Url(verifier)) !== grant.challenge) {
      return json(400, { error: 'invalid_grant' });
    }
    const family: Family = { revoked: false, current: '' };
    this.families.push(family);
    return this.tokenResponse(family);
  }

  private refreshGrant(body: URLSearchParams): Response {
    const presented = body.get('refresh_token') ?? '';
    const family = this.refreshTokens.get(presented);
    if (family === undefined || family.revoked) return json(400, { error: 'invalid_grant' });
    if (family.current !== presented) {
      // A rotated token presented again is a replay: the whole family is revoked.
      family.revoked = true;
      return json(400, { error: 'invalid_grant' });
    }
    const response = this.tokenResponse(family);
    if (this.dropNextRefreshResponse) {
      this.dropNextRefreshResponse = false;
      throw new TypeError('Failed to fetch');
    }
    return response;
  }
}
