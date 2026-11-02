/**
 * Browser sign-in for a public client: authorization code with PKCE (S256 only), `resource` on every
 * authorize request, the one `scope` of `BrowserAuthOptions.scope` (`approvals:resolve` unless the host says
 * otherwise), the access token in this object's memory and the refresh token only in the
 * one `RefreshTokenStore`. Nothing here runs at import: `window`, `document`, `sessionStorage` and
 * `crypto.subtle` are read inside functions the host calls, and nothing calls `signIn()` but the host.
 */
import { AuthError } from '../auth-types.js';
import { reportFault as reportUnhandled } from '../fault.js';
import type { AuthState, BrowserAuth, BrowserAuthOptions } from '../auth-types.js';
import { isSecureEndpoint, isSecureUrl, sameIssuer } from './issuer.js';
import { clearPending, takePending, writePending } from './pending.js';
import { codeChallengeS256, newCodeVerifier, newState } from './pkce.js';
import { sanitizeReturnTo } from './return-to.js';
import { sessionStorageRefreshStore } from './stores.js';

/**
 * Seams that the public options do not carry; tests use them, the host never sees them.
 *
 * @internal
 */
export interface BrowserAuthHooks {
  /** Navigates the page to the authorization endpoint. The default is `location.assign`. */
  readonly navigate?: (url: string) => void;
}

const WELL_KNOWN = '/.well-known/oauth-authorization-server';
const DEFAULT_ACCESS_TOKEN_SECONDS = 900;
/** A cached access token is renewed this long before it expires. */
const EXPIRY_SKEW_MS = 30_000;

/** The error codes of an authorization response (RFC 6749 section 4.1.2.1). */
const AUTHORIZATION_ERRORS: ReadonlySet<string> = new Set([
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
]);

const MESSAGE_ENDED = 'Your session ended. Sign in again.';
const MESSAGE_UNREACHABLE =
  'Could not reach the sign-in service. Your session is kept: reload the page to try again.';
const MESSAGE_TWO_TABS =
  'Your session ended. This can happen if the page was opened in two tabs. Sign in again.';
const MESSAGE_NO_PARAMETERS = 'This page is used only while signing in';
const MESSAGE_INVALID_TARGET =
  'the sign-in service does not accept this API as a target; the deployment is not configured for it';

interface Endpoints {
  readonly authorization: string;
  readonly token: string;
  readonly revocation: string | undefined;
}

interface Grant {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly expiresInMs: number;
}

type TokenOutcome =
  | { readonly kind: 'granted'; readonly grant: Grant }
  | { readonly kind: 'network' }
  | { readonly kind: 'rejected'; readonly error: string | undefined }
  | { readonly kind: 'server' };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The JSON body of a response, or null when it has none. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

const browserLocation = (): Location | undefined =>
  (globalThis as { location?: Location }).location;

/** Metadata that names another issuer or an insecure endpoint: a reload cannot fix it, so restore() shows it. */
class MisconfiguredError extends AuthError {}

/** An AuthError that keeps the underlying failure as its ES2022 `cause`, without widening the public AuthError constructor. */
function withCause(error: AuthError, cause: unknown): AuthError {
  error.cause = cause;
  return error;
}

/** The issuer as an absolute `https:` (or `http://localhost`) URL, so no token is sent over plain http elsewhere. */
function assertIssuer(issuer: string): string {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new AuthError('server_error', `issuer must be an absolute URL, got "${issuer}"`);
  }
  if (!isSecureUrl(url)) {
    throw new AuthError(
      'server_error',
      `issuer must use https (or http://localhost), got "${issuer}"`
    );
  }
  return issuer;
}

/** `resource` as an origin: absolute `https:` (or `http://localhost`), with no path, query or trailing slash. */
function assertResource(resource: string): string {
  const invalid = (reason: string): AuthError =>
    new AuthError('invalid_target', `resource ${reason}, got "${resource}"`);
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    throw invalid('must be an absolute URL');
  }
  if (!isSecureUrl(url)) throw invalid('must use https (or http://localhost)');
  if (url.origin !== resource) throw invalid('must be an origin: no path, query or trailing slash');
  return resource;
}

/** The scope the approvals module asks for unless the host says otherwise: what lets a person resolve an approval. */
export const DEFAULT_SCOPE = 'approvals:resolve';

/**
 * The `scope` parameter value: `DEFAULT_SCOPE` when the host gave none, nothing for an empty string, else the
 * given space-separated scope tokens (RFC 6749 section 3.3: printable ASCII without `"` and `\`, one space between tokens).
 */
function assertScope(scope: string | undefined): string | undefined {
  if (scope === undefined) return DEFAULT_SCOPE;
  if (scope === '') return undefined;
  if (!/^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(scope))
    throw new AuthError(
      'invalid_scope',
      `scope must be space-separated scope tokens (or '' for none), got "${scope}"`
    );
  return scope;
}

/** The callback address as `origin + pathname`, after the checks of an exact, fragment-free redirect URI. */
function assertRedirectUri(redirectUri: string): string {
  const invalid = (reason: string): AuthError => new AuthError('redirect_uri_mismatch', reason);
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw invalid('redirectUri must be an absolute URL');
  }
  if (redirectUri.includes('#') || redirectUri.includes('?') || redirectUri.includes('*')) {
    throw invalid('redirectUri must be exact: no wildcard, query or fragment');
  }
  const here = browserLocation();
  if (here !== undefined && here.origin !== url.origin) {
    throw invalid("redirectUri must be on this page's origin");
  }
  return url.origin + url.pathname;
}

function parseGrant(body: unknown): Grant | null {
  if (!isObject(body) || typeof body.access_token !== 'string' || body.access_token === '') {
    return null;
  }
  const seconds =
    typeof body.expires_in === 'number' && body.expires_in > 0
      ? body.expires_in
      : DEFAULT_ACCESS_TOKEN_SECONDS;
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' && body.refresh_token !== ''
        ? body.refresh_token
        : undefined,
    expiresInMs: seconds * 1000,
  };
}

/**
 * Builds the browser sign-in object with the test seams of `hooks`; `createBrowserAuth` is this with none.
 *
 * @internal
 */
export function createBrowserAuthWith(
  options: BrowserAuthOptions,
  hooks: BrowserAuthHooks = {}
): BrowserAuth {
  assertIssuer(options.issuer);
  const resource = assertResource(options.resource);
  const scope = assertScope(options.scope);
  const callbackAddress = assertRedirectUri(options.redirectUri);
  const appOrigin = new URL(options.redirectUri).origin;
  const now = options.now ?? Date.now;
  /** A fault in a subscriber or in the host's store: `onFault` when the host gave one, otherwise reported like an uncaught exception. */
  const reportFault = (fault: unknown): void => {
    if (options.onFault === undefined) {
      reportUnhandled(fault);
      return;
    }
    try {
      options.onFault(fault);
    } catch {
      // A fault handler that throws has nowhere further to report to.
    }
  };
  const store = options.storage ?? sessionStorageRefreshStore(options.clientId);
  const navigate =
    hooks.navigate ??
    ((url: string): void => {
      globalThis.location.assign(url);
    });

  /** Every request of this module (the sign-in service and nothing else) is credential-free CORS. */
  const request = (url: string, init: RequestInit): Promise<Response> => {
    const send = options.fetch ?? globalThis.fetch.bind(globalThis);
    return send(url, { ...init, credentials: 'omit', mode: 'cors' });
  };

  let state: AuthState = { status: 'signed_out' };
  const listeners = new Set<() => void>();
  let accessToken: string | null = null;
  let expiresAt = 0;
  /** Bumped when the session ends (`endSession`, `signOut`), so a refresh answer that arrives later is dropped. */
  let epoch = 0;
  /** Bumped when a sign-in starts or the person signs out, so a code exchange that arrives later is dropped. A sign-in does not end the session, so a refresh in flight keeps its answer. */
  let flow = 0;
  let metadata: Promise<Endpoints> | null = null;
  let refreshing: Promise<string> | null = null;
  let restoring: Promise<void> | null = null;
  let completion: Promise<void> | null = null;
  let pageshowAttached = false;
  let pendingState: string | null = null;

  /** The state now; a read after an `await` must not use `state`, which the compiler has narrowed. */
  const current = (): AuthState => state;

  const setState = (next: AuthState): void => {
    if (
      state.status === 'signed_in' &&
      next.status === 'signed_in' &&
      state.returnTo === next.returnTo
    ) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (fault) {
        reportFault(fault);
      }
    }
  };

  /** The stored refresh token; a host store whose `get` throws counts as holding none, and the fault is reported. */
  const readStored = (): string | null => {
    try {
      return store.get();
    } catch (fault) {
      reportFault(fault);
      return null;
    }
  };

  const fail = (error: AuthError): void => {
    setState({ status: 'error', error });
  };

  const endSession = (message: string): void => {
    epoch += 1;
    accessToken = null;
    expiresAt = 0;
    try {
      store.clear();
    } catch (fault) {
      reportFault(fault);
    }
    setState({ status: 'signed_out', message });
  };

  function loadMetadata(): Promise<Endpoints> {
    metadata ??= fetchMetadata().catch((error: unknown) => {
      metadata = null;
      throw error;
    });
    return metadata;
  }

  async function fetchMetadata(): Promise<Endpoints> {
    // RFC 8414 section 3.1: the well-known segment goes between the origin and the issuer's path (for an issuer with no path this is {issuer}/.well-known/...).
    const issuer = new URL(options.issuer);
    const path = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/$/, '');
    let response: Response;
    try {
      response = await request(issuer.origin + WELL_KNOWN + path, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
    } catch {
      throw new AuthError('network', 'Could not reach the sign-in service. Try again.');
    }
    const body = await readJson(response);
    if (
      !response.ok ||
      !isObject(body) ||
      typeof body.authorization_endpoint !== 'string' ||
      typeof body.token_endpoint !== 'string'
    ) {
      throw new AuthError('server_error', 'The sign-in service answered with unusable metadata.');
    }
    // RFC 8414 section 3.3: the document must name the issuer it was asked about, and the endpoints that
    // receive the refresh token and the PKCE verifier must be https (or http://localhost).
    if (!sameIssuer(body.issuer, options.issuer)) {
      throw new MisconfiguredError(
        'server_error',
        'The sign-in service metadata names a different issuer than the one configured.'
      );
    }
    const revocation =
      typeof body.revocation_endpoint === 'string' ? body.revocation_endpoint : undefined;
    for (const endpoint of [body.authorization_endpoint, body.token_endpoint, revocation]) {
      if (endpoint !== undefined && !isSecureEndpoint(endpoint)) {
        throw new MisconfiguredError(
          'server_error',
          'The sign-in service metadata names an endpoint that is not https.'
        );
      }
    }
    // The refresh token and the PKCE verifier go only to the issuer's own origin: a metadata document cannot
    // redirect them to another host.
    for (const [name, endpoint] of [
      ['token_endpoint', body.token_endpoint],
      ['revocation_endpoint', revocation],
    ] as const) {
      if (endpoint !== undefined && new URL(endpoint).origin !== issuer.origin) {
        throw new MisconfiguredError(
          'server_error',
          `The sign-in service metadata names a ${name} on another origin than the issuer.`
        );
      }
    }
    return {
      authorization: body.authorization_endpoint,
      token: body.token_endpoint,
      revocation,
    };
  }

  /** One token-endpoint POST; the caller decides what each outcome means. It is never repeated. */
  async function postToken(
    endpoint: string,
    params: Record<string, string>
  ): Promise<TokenOutcome> {
    let response: Response;
    try {
      response = await request(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params).toString(),
      });
    } catch {
      return { kind: 'network' };
    }
    const body = await readJson(response);
    if (response.ok) {
      const grant = parseGrant(body);
      return grant === null ? { kind: 'server' } : { kind: 'granted', grant };
    }
    if (response.status === 400) {
      return {
        kind: 'rejected',
        error: isObject(body) && typeof body.error === 'string' ? body.error : undefined,
      };
    }
    return { kind: 'server' };
  }

  const applyGrant = (
    grant: Grant,
    returnTo: string | undefined,
    keepRefreshToken: boolean
  ): void => {
    // The rotated refresh token is stored before the new access token is used. A refresh response with no new
    // one leaves the stored one in place (RFC 6749 section 6); a code exchange with none leaves nothing to renew.
    // A host store that throws costs the persistence of the token, not the session: the new access token is
    // kept in memory, the fault is reported, and a reload would ask for a sign-in.
    try {
      if (grant.refreshToken !== undefined) store.set(grant.refreshToken);
      else if (!keepRefreshToken) store.clear();
    } catch (fault) {
      reportFault(fault);
    }
    accessToken = grant.accessToken;
    expiresAt = now() + grant.expiresInMs;
    setState(returnTo === undefined ? { status: 'signed_in' } : { status: 'signed_in', returnTo });
  };

  async function doRefresh(): Promise<string> {
    const startedIn = epoch;
    const refreshToken = readStored();
    if (refreshToken === null) {
      endSession(MESSAGE_ENDED);
      throw new AuthError('signed_out', 'There is no session to refresh.');
    }
    let endpoints: Endpoints;
    try {
      endpoints = await loadMetadata();
    } catch (error) {
      // The token was not presented and the session is not ended: the caller may try again. `restore()` reads
      // the cause to tell a metadata document that can never be accepted from one that is only unreachable.
      throw withCause(
        new AuthError(
          'metadata_unavailable',
          'The sign-in service configuration could not be loaded.'
        ),
        error
      );
    }
    const outcome = await postToken(endpoints.token, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: options.clientId,
    });
    if (epoch !== startedIn) throw new AuthError('signed_out', 'The session ended.');
    if (outcome.kind === 'granted') {
      applyGrant(outcome.grant, state.status === 'signed_in' ? state.returnTo : undefined, true);
      return outcome.grant.accessToken;
    }
    // The token was presented, so it is spent or may be: it is never presented again.
    if (outcome.kind === 'rejected' && outcome.error === 'invalid_grant') {
      endSession(MESSAGE_TWO_TABS);
      throw new AuthError('invalid_grant', MESSAGE_TWO_TABS);
    }
    endSession(MESSAGE_ENDED);
    if (outcome.kind === 'network') {
      throw new AuthError('network', 'Could not reach the sign-in service.');
    }
    throw new AuthError('server_error', 'The sign-in service refused to renew the session.');
  }

  /** At most one refresh at a time: callers in the same tab share it. */
  function refresh(): Promise<string> {
    refreshing ??= doRefresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** The callback, with any failure of the page or the host's store ending in the `error` state, never stranded in `completing`. */
  async function runCompletion(): Promise<void> {
    const startedFlow = flow;
    try {
      await completeCallback();
    } catch (error) {
      if (flow !== startedFlow) return;
      fail(
        error instanceof AuthError
          ? error
          : withCause(new AuthError('server_error', 'Sign-in could not be completed.'), error)
      );
    }
  }

  async function completeCallback(): Promise<void> {
    const here = browserLocation();
    if (here === undefined) {
      fail(new AuthError('server_error', 'completeSignIn runs in a browser.'));
      return;
    }
    if (here.origin + here.pathname !== callbackAddress) {
      fail(new AuthError('redirect_uri_mismatch', 'This is not the sign-in callback address.'));
      return;
    }
    setState({ status: 'completing' });
    const startedIn = flow;
    const params = new URLSearchParams(here.search);
    const code = params.get('code');
    const returnedState = params.get('state');
    const returnedError = params.get('error');
    // The code and the state leave the address bar before any request is made.
    globalThis.history.replaceState(globalThis.history.state, '', here.pathname);
    if (code === null && returnedState === null && returnedError === null) {
      fail(new AuthError('missing_callback_parameters', MESSAGE_NO_PARAMETERS));
      return;
    }
    if (returnedState === null || returnedState === '') {
      fail(new AuthError('state_mismatch', 'The sign-in response has no state.'));
      return;
    }
    const pending = takePending(returnedState, now());
    if (pending === null) {
      fail(
        new AuthError(
          'no_pending_request',
          'The sign-in request was not found or has expired. Try again.'
        )
      );
      return;
    }
    if (returnedError !== null) {
      if (returnedError === 'access_denied') setState({ status: 'denied' });
      else if (returnedError === 'invalid_target') {
        fail(new AuthError('invalid_target', MESSAGE_INVALID_TARGET));
      } else {
        // Only the codes of RFC 6749 section 4.1.2.1 are shown; anything else the address bar carried is not
        // put in a message.
        const known = AUTHORIZATION_ERRORS.has(returnedError) ? returnedError : 'unknown error';
        fail(new AuthError('server_error', `Sign-in failed: ${known}.`));
      }
      return;
    }
    if (code === null || code === '') {
      fail(new AuthError('missing_callback_parameters', 'The sign-in response has no code.'));
      return;
    }
    let endpoints: Endpoints;
    try {
      endpoints = await loadMetadata();
    } catch (error) {
      if (flow !== startedIn) return;
      fail(
        error instanceof AuthError
          ? error
          : withCause(
              new AuthError('server_error', 'Could not load the sign-in service configuration.'),
              error
            )
      );
      return;
    }
    // The code is single-use: this exchange is made once and never retried.
    const outcome = await postToken(endpoints.token, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: options.redirectUri,
      client_id: options.clientId,
      code_verifier: pending.verifier,
    });
    if (flow !== startedIn) return;
    if (outcome.kind === 'granted') {
      applyGrant(
        outcome.grant,
        pending.returnTo === undefined ? undefined : sanitizeReturnTo(pending.returnTo, appOrigin),
        false
      );
    } else if (outcome.kind === 'network') {
      fail(new AuthError('network', 'Could not reach the sign-in service. Try again.'));
    } else if (outcome.kind === 'rejected' && outcome.error === 'invalid_grant') {
      fail(
        new AuthError('invalid_grant', 'The sign-in code expired or was already used. Try again.')
      );
    } else {
      fail(new AuthError('server_error', 'The sign-in service refused the sign-in. Try again.'));
    }
  }

  /** A page restored from the back/forward cache while `redirecting` has not signed anyone in. */
  const onPageShow = (event: Event): void => {
    if ((event as Partial<PageTransitionEvent>).persisted === false) return;
    if (state.status !== 'redirecting') return;
    if (pendingState !== null) takePending(pendingState, now());
    // A person who was signed in when they started a sign-in is still signed in: they never left this tab's session.
    setState(accessToken === null ? { status: 'signed_out' } : { status: 'signed_in' });
  };

  const auth: BrowserAuth = {
    async signIn(returnTo) {
      flow += 1;
      completion = null;
      try {
        const endpoints = await loadMetadata();
        const verifier = newCodeVerifier();
        const challenge = await codeChallengeS256(verifier);
        const stateValue = newState();
        // One pending record at a time: an abandoned earlier sign-in leaves nothing behind.
        clearPending();
        const written = writePending(stateValue, {
          verifier,
          returnTo: returnTo === undefined ? undefined : sanitizeReturnTo(returnTo, appOrigin),
          createdAt: now(),
        });
        if (!written) {
          fail(new AuthError('server_error', 'This browser will not keep the sign-in state.'));
          return;
        }
        const target = new URL(endpoints.authorization);
        target.searchParams.set('response_type', 'code');
        target.searchParams.set('client_id', options.clientId);
        target.searchParams.set('redirect_uri', options.redirectUri);
        target.searchParams.set('code_challenge', challenge);
        target.searchParams.set('code_challenge_method', 'S256');
        target.searchParams.set('state', stateValue);
        target.searchParams.set('resource', resource);
        if (scope !== undefined) target.searchParams.set('scope', scope);
        pendingState = stateValue;
        // The listener is attached once and lives as long as the page; it acts only while `redirecting`.
        if (!pageshowAttached) {
          pageshowAttached = true;
          globalThis.addEventListener('pageshow', onPageShow);
        }
        setState({ status: 'redirecting' });
        navigate(target.toString());
      } catch (error) {
        fail(
          error instanceof AuthError
            ? error
            : withCause(
                new AuthError(
                  'server_error',
                  'Sign-in could not start in this browser (a secure context is required for the sign-in challenge).'
                ),
                error
              )
        );
      }
    },

    completeSignIn() {
      completion ??= runCompletion();
      return completion;
    },

    restore() {
      restoring ??= (async () => {
        if (state.status !== 'signed_out' || readStored() === null) return;
        setState({ status: 'completing' });
        let failure: unknown;
        await refresh().catch((error: unknown) => {
          failure = error;
          // An AuthError is an outcome the state shows; anything else is a fault the host should see.
          if (!(error instanceof AuthError)) reportFault(error);
        });
        // A metadata failure leaves the stored token alone; a token-endpoint failure ends the session (A7).
        if (current().status === 'completing') {
          // A service that is down is worth a reload; a metadata document that can never be accepted is shown as the error it is.
          if (failure instanceof AuthError && failure.cause instanceof MisconfiguredError) {
            fail(failure.cause);
          } else setState({ status: 'signed_out', message: MESSAGE_UNREACHABLE });
        }
      })().finally(() => {
        restoring = null;
      });
      return restoring;
    },

    getToken(getOptions) {
      if (refreshing !== null) return refreshing;
      if (accessToken === null) {
        return Promise.reject(new AuthError('signed_out', 'Not signed in.'));
      }
      if (getOptions?.forceRefresh !== true && now() < expiresAt - EXPIRY_SKEW_MS) {
        return Promise.resolve(accessToken);
      }
      return refresh();
    },

    async signOut() {
      // The session ends first: no store call below can stop sign-out from ending `signed_out`.
      epoch += 1;
      flow += 1;
      completion = null;
      accessToken = null;
      expiresAt = 0;
      const refreshToken = readStored();
      try {
        store.clear();
      } catch (fault) {
        reportFault(fault);
      }
      clearPending();
      setState({ status: 'signed_out' });
      if (refreshToken === null) return;
      // Revocation is best effort. It does not end the sign-in service's own session.
      try {
        const endpoints = await loadMetadata();
        if (endpoints.revocation === undefined) return;
        await request(endpoints.revocation, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: refreshToken,
            token_type_hint: 'refresh_token',
            client_id: options.clientId,
          }).toString(),
        });
      } catch {
        // The session is already gone here; a failed revocation leaves the token to expire on its own.
      }
    },

    getSnapshot: () => state,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return auth;
}

/**
 * Creates the browser sign-in object. It throws `AuthError('server_error')` when `issuer` is not an absolute
 * `https:` (or `http://localhost`) URL, `AuthError('invalid_target')` when `resource` is not an
 * origin (`https:`, or `http://localhost`) and `AuthError('redirect_uri_mismatch')` when `redirectUri` is not
 * an exact absolute URL on this page's origin, so a misconfiguration fails at construction and not at
 * sign-in. (On a server there is no page origin to compare, and that check is skipped.)
 */
export function createBrowserAuth(options: BrowserAuthOptions): BrowserAuth {
  return createBrowserAuthWith(options);
}
