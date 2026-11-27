import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { openForRead } from './safe-open.js';
import { callbackHeaders, failurePage, mismatchPage, successPage } from './callback-page.js';
import { assertSecureUrl, type Config } from './config.js';
import { interrupted, interruptedError, requestSignal, timeoutOnlySignal } from './abortable.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';

export const CLIENT_ID = 'noblecloak-cli';
export const ADMIN_SCOPE = 'service_principals:manage';

interface Endpoints {
  readonly authorization: string;
  readonly token: string;
  readonly revocation: string | undefined;
}

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

/**
 * What a sign-in asks for. `resource` is the audience the token is bound to (RFC 8707). `scope` is sent on
 * the authorize request when set. `requiredScope` is a scope the authorization server's metadata must
 * offer (when it lists `scopes_supported` at all), or the sign-in is refused before a browser opens.
 */
export interface SignInTarget {
  readonly resource: string;
  readonly scope: string | undefined;
  readonly requiredScope: string | undefined;
}

/** The sign-in of the `sp` commands: the admin API's audience and its `service_principals:manage` scope. */
export const adminTarget = (config: Config): SignInTarget => ({
  resource: config.adminAudience,
  scope: ADMIN_SCOPE,
  requiredScope: ADMIN_SCOPE,
});

/**
 * Reads the authorization server metadata and checks that it names the configured issuer and offers what
 * the sign-in needs.
 */
async function discover(
  config: Pick<Config, 'authUrl'>,
  io: Io,
  requiredScope: string | undefined
): Promise<Endpoints> {
  const url = `${config.authUrl}/.well-known/oauth-authorization-server`;
  let response: Response;
  // Built outside the try: a fault here is not a network failure.
  const signal = requestSignal(io);
  try {
    response = await io.fetch(url, {
      headers: { accept: 'application/json' },
      signal,
    });
  } catch {
    if (interrupted(io)) throw interruptedError('No sign-in was started.');
    throw new CliError(EXIT.failed, `Cannot reach the authorization server at ${config.authUrl}.`);
  }
  if (!response.ok) {
    throw new CliError(
      EXIT.failed,
      `The authorization server metadata at ${url} answered ${String(response.status)}.`
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (body === undefined && interrupted(io)) throw interruptedError('No sign-in was started.');
  const meta = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const text = (name: string): string | undefined =>
    typeof meta[name] === 'string' && meta[name] !== '' ? meta[name] : undefined;
  // RFC 8414 section 3.3: the metadata must name the issuer it was fetched for.
  const issuer = text('issuer');
  if (issuer?.replace(/\/+$/, '') !== config.authUrl) {
    throw new CliError(
      EXIT.failed,
      `The authorization server metadata names issuer ${issuer ?? '(none)'}, not ${config.authUrl}; refusing to sign in.`
    );
  }
  const authorization = text('authorization_endpoint');
  const token = text('token_endpoint');
  if (authorization === undefined || token === undefined) {
    throw new CliError(
      EXIT.failed,
      'The authorization server metadata has no authorization_endpoint or token_endpoint.'
    );
  }
  const scopes = meta.scopes_supported;
  if (requiredScope !== undefined && Array.isArray(scopes) && !scopes.includes(requiredScope)) {
    throw new CliError(
      EXIT.failed,
      `The deployment does not offer the ${requiredScope} scope: its admin API is not enabled.`
    );
  }
  assertSecureUrl(authorization, 'The authorization endpoint');
  assertSecureUrl(token, 'The token endpoint');
  const revocation = text('revocation_endpoint');
  if (revocation !== undefined) assertSecureUrl(revocation, 'The revocation endpoint');
  return { authorization, token, revocation };
}

/** A plain-text answer for a request that is not the sign-in callback: nothing from the request echoed. */
function reply(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(`${text}\n`);
}

/** An answer to the callback itself: a self-contained page, served with a CSP that allows no other origin. */
function replyPage(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, callbackHeaders);
  res.end(html);
}

/**
 * How the listener answers the browser. `page`: a NobleCloak page served from the loopback (the `sp` and
 * `starter` sign-in). `redirect`: the loopback never renders HTML. A good callback is held open until the
 * caller calls `release`, which redirects the tab to a hosted page (or answers plain text when there is no
 * page to go to); an error from the authorization server redirects at once to `errorLocation(code)`.
 */
type CallbackMode =
  | { readonly kind: 'page' }
  | {
      readonly kind: 'redirect';
      /** Where to send the tab for an authorization error; undefined answers plain text instead. */
      readonly errorLocation: (error: string | null) => string | undefined;
    };

interface Callback {
  readonly code: string;
  /**
   * Redirect mode: answers the held request (a 303 to `location`, else plain text) and closes the
   * listener. Idempotent. In page mode the page was already served and this does nothing.
   */
  readonly release: (location?: string) => void;
}

/** A 303 to a hosted page. The URL is the caller's own configuration: it holds no token, code or email. */
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, {
    location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-length': '0',
    connection: 'close',
  });
  res.end();
}

/**
 * Listens on 127.0.0.1 and resolves with the code of the first callback whose `state` matches. A request
 * with another path gets a plain-text 404 and one with another state gets the "response ignored" page; the
 * listener keeps waiting in both cases. Rejects with exit
 * code 3 on timeout, on an error from the authorization server (with the right `state`) or on cancel.
 */
function waitForCallback(
  io: Io,
  state: string,
  onListening: (redirectUri: string) => void,
  mode: CallbackMode = { kind: 'page' }
): Promise<Callback> {
  return new Promise<Callback>((resolve, reject) => {
    let settled = false;
    let held: ServerResponse | undefined;
    let closed = false;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // A request target that does not parse (a raw `GET http://[ HTTP/1.1`) would throw out of this
      // handler as an uncaught exception and take the sign-in down with it.
      if (!URL.canParse(req.url ?? '/', 'http://127.0.0.1')) {
        reply(res, 400, 'Bad request.');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/callback') {
        reply(res, 404, 'Not found.');
        return;
      }
      if (url.searchParams.get('state') !== state) {
        if (mode.kind === 'redirect') reply(res, 400, 'This response does not match the sign-in.');
        else replyPage(res, 400, mismatchPage());
        return;
      }
      // A second callback with the right state. In page mode finish() has already closed the server and every
      // connection, so this cannot be reached; in redirect mode the server stays up until `release` while the
      // first callback's tab is held, so this branch is the guard that keeps the code single-use. Plain
      // text, since no one sees it.
      if (settled) {
        reply(res, 409, 'This sign-in was already completed.');
        return;
      }
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || code === null || code === '') {
        if (mode.kind === 'redirect') {
          // Nothing from the query string reaches the page except a code the caller maps itself.
          const location = mode.errorLocation(url.searchParams.get('error'));
          if (location === undefined) reply(res, 400, 'Sign-in was not completed.');
          else redirect(res, location);
        } else {
          // The state matched, so this is the authorization server's answer. Its error text is shown
          // escaped and cut (see failurePage); nothing else from the query string is.
          replyPage(
            res,
            400,
            failurePage(url.searchParams.get('error'), url.searchParams.get('error_description'))
          );
        }
        finish(new CliError(EXIT.unauthenticated, 'Sign-in was not completed.'));
        return;
      }
      if (mode.kind === 'redirect') {
        // Hold the tab until the caller knows what to tell it: the code still has to be exchanged.
        held = res;
        finish(undefined, { code, release });
        return;
      }
      replyPage(res, 200, successPage());
      finish(undefined, { code, release });
    });

    function release(location?: string): void {
      if (closed) return;
      closed = true;
      const res = held;
      if (res !== undefined && !res.writableEnded) {
        if (location === undefined) reply(res, 200, 'Signed in. Return to your terminal.');
        else redirect(res, location);
      }
      server.close();
      server.closeIdleConnections();
      // A browser that keeps the connection open must not keep the command alive.
      setTimeout(() => {
        server.closeAllConnections();
      }, 2000).unref();
    }

    const timer = setTimeout(() => {
      finish(new CliError(EXIT.unauthenticated, 'Sign-in timed out waiting for the browser.'));
    }, io.signInTimeoutMs);
    const onAbort = (): void => {
      finish(new CliError(EXIT.unauthenticated, 'Sign-in was cancelled.'));
    };
    io.signal.addEventListener('abort', onAbort, { once: true });

    function finish(error?: CliError, value?: Callback): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      io.signal.removeEventListener('abort', onAbort);
      // A held tab (redirect mode, good callback) stays open until `release`.
      if (held === undefined) {
        closed = true;
        server.close();
        server.closeAllConnections();
      }
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolve(value);
    }

    server.on('error', () => {
      finish(new CliError(EXIT.failed, 'Cannot listen on 127.0.0.1 for the sign-in callback.'));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        finish(new CliError(EXIT.failed, 'Cannot listen on 127.0.0.1 for the sign-in callback.'));
        return;
      }
      onListening(`http://127.0.0.1:${String(address.port)}/callback`);
    });
    if (io.signal.aborted) onAbort();
  });
}

interface Tokens {
  readonly accessToken: string | undefined;
  readonly refreshToken: string | undefined;
  /** Seconds the access token lives, when the response says. */
  readonly expiresIn: number | undefined;
  /** The scope the server granted, when the response says. */
  readonly scope: string | undefined;
}

/** Reads the members of a token response that this command keeps; never throws on a malformed body. */
function readTokens(parsed: unknown): Tokens {
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const text = (name: string): string | undefined => {
    const value = record[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const lifetime = record.expires_in;
  return {
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    expiresIn:
      typeof lifetime === 'number' && Number.isFinite(lifetime) && lifetime > 0
        ? lifetime
        : undefined,
    scope: text('scope'),
  };
}

async function exchangeCode(
  io: Io,
  resource: string,
  endpoints: Endpoints,
  form: { code: string; redirectUri: string; verifier: string }
): Promise<Tokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: form.code,
    redirect_uri: form.redirectUri,
    client_id: CLIENT_ID,
    code_verifier: form.verifier,
    // RFC 8707 lets the request name the resource again. The audience is bound at /authorize; a
    // server that ignores the parameter here still issues the same token.
    resource,
  });
  let response: Response;
  const signal = requestSignal(io);
  try {
    response = await io.fetch(endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal,
    });
  } catch {
    if (interrupted(io)) throw interruptedError('The sign-in was not completed.');
    throw new CliError(EXIT.failed, 'Cannot reach the token endpoint.');
  }
  // The response body is never printed: on success it holds the tokens.
  if (!response.ok) {
    throw new CliError(
      EXIT.unauthenticated,
      `Sign-in failed: the token endpoint answered ${String(response.status)}.`
    );
  }
  const parsed: unknown = await response.json().catch(() => undefined);
  if (parsed === undefined && interrupted(io)) {
    throw interruptedError('The sign-in was not completed.');
  }
  return readTokens(parsed);
}

/** Best effort: a failure here is a warning, never a failed exit. True when the server accepted the revoke. */
async function revokeRefreshToken(
  io: Io,
  endpoints: Endpoints,
  refreshToken: string
): Promise<boolean> {
  if (endpoints.revocation === undefined) {
    io.stderr(
      'warning: the deployment advertises no revocation endpoint; the session stays open.\n'
    );
    return false;
  }
  try {
    const response = await io.fetch(endpoints.revocation, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: 'refresh_token',
        client_id: CLIENT_ID,
      }),
      // Not io.signal: this runs after an interrupt too, and must still reach the server.
      signal: timeoutOnlySignal(io),
    });
    if (!response.ok) {
      io.stderr(
        `warning: could not end the session (revocation answered ${String(response.status)}).\n`
      );
    }
    return response.ok;
  } catch {
    io.stderr('warning: could not end the session (revocation endpoint unreachable).\n');
    return false;
  }
}

/** A signed-in admin session. `end` revokes the refresh token, if the sign-in produced one. */
interface Session {
  readonly accessToken: string;
  end(): Promise<void>;
}

/** The authorize URL of one sign-in. `loginHint` is the SSO routing hint, set only when the person gave one. */
function authorizeUrl(
  endpoints: Endpoints,
  target: SignInTarget,
  request: {
    readonly redirectUri: string;
    readonly challenge: string;
    readonly state: string;
    readonly loginHint?: string | undefined;
  }
): URL {
  const authorize = new URL(endpoints.authorization);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', CLIENT_ID);
  authorize.searchParams.set('redirect_uri', request.redirectUri);
  authorize.searchParams.set('code_challenge', request.challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', request.state);
  authorize.searchParams.set('resource', target.resource);
  if (target.scope !== undefined) authorize.searchParams.set('scope', target.scope);
  if (request.loginHint !== undefined) authorize.searchParams.set('login_hint', request.loginHint);
  return authorize;
}

async function interactiveSignIn(
  io: Io,
  config: Pick<Config, 'authUrl'>,
  target: SignInTarget,
  open: boolean
): Promise<Session> {
  const endpoints = await discover(config, io, target.requiredScope);
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(24));
  let redirectUri = '';

  const { code } = await waitForCallback(io, state, (uri) => {
    redirectUri = uri;
    const authorize = authorizeUrl(endpoints, target, { redirectUri: uri, challenge, state });
    io.stderr(`Sign in to continue. Open this URL in your browser:\n${authorize.href}\n`);
    if (open) {
      try {
        io.openUrl(authorize.href);
      } catch {
        // The URL is printed above, so the user can open it by hand.
      }
    }
  });
  const tokens = await exchangeCode(io, target.resource, endpoints, {
    code,
    redirectUri,
    verifier,
  });
  const refresh = tokens.refreshToken;
  const end = async (): Promise<void> => {
    if (refresh !== undefined) await revokeRefreshToken(io, endpoints, refresh);
  };
  if (tokens.accessToken === undefined) {
    await end();
    throw new CliError(EXIT.unauthenticated, 'Sign-in failed: the token response has no token.');
  }
  return { accessToken: tokens.accessToken, end };
}

/**
 * Reads an admin access token from a file that only its owner can read (POSIX). The mode is taken from the
 * opened file (fstat), so a symlink to a protected file passes and one to an open file is refused, and the
 * file checked is the file read.
 */
async function tokenFromFile(io: Io, path: string): Promise<Session> {
  let text: string;
  try {
    const handle = await openForRead(path);
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new CliError(EXIT.usage, '--user-token-file is not a regular file.');
      }
      if (io.platform !== 'win32' && (info.mode & 0o077) !== 0) {
        throw new CliError(
          EXIT.usage,
          '--user-token-file is readable by its group or by others; run chmod 600 on it.'
        );
      }
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(EXIT.usage, '--user-token-file cannot be read.');
  }
  const accessToken = text.trim();
  if (accessToken === '') throw new CliError(EXIT.usage, '--user-token-file is empty.');
  return { accessToken, end: () => Promise.resolve() };
}

export interface SessionOptions {
  readonly userTokenFile: string | undefined;
  /** False for `--no-open`: print the sign-in URL only. */
  readonly open: boolean;
}

/**
 * Signs in for `target` (or reads the token file), runs `use` with the access token, then ends the
 * session: the refresh token is revoked whether `use` returned or threw. The session is never written to
 * disk.
 */
export async function withTargetSession<T>(
  io: Io,
  config: Pick<Config, 'authUrl'>,
  target: SignInTarget,
  options: SessionOptions,
  use: (accessToken: string) => Promise<T>
): Promise<T> {
  const session =
    options.userTokenFile === undefined
      ? await interactiveSignIn(io, config, target, options.open)
      : await tokenFromFile(io, options.userTokenFile);
  try {
    return await use(session.accessToken);
  } finally {
    await session.end();
  }
}

/** {@link withTargetSession} for the admin API: the sign-in of the `sp` commands. */
export function withSession<T>(
  io: Io,
  config: Config,
  options: SessionOptions,
  use: (accessToken: string) => Promise<T>
): Promise<T> {
  return withTargetSession(io, config, adminTarget(config), options, use);
}

// ---------------------------------------------------------------------------------------------------
// `noblecloak login`: a sign-in whose tokens are kept (see login-store.ts)
// ---------------------------------------------------------------------------------------------------

/** The scope that opens the one setup read on the admin API, and nothing else. */
export const SETUP_READ_SCOPE = 'setup:read';

/** The sign-in of `login`: the admin API's audience, asking for the setup read only. */
export const loginTarget = (config: Pick<Config, 'adminAudience'>): SignInTarget => ({
  resource: config.adminAudience,
  scope: SETUP_READ_SCOPE,
  requiredScope: SETUP_READ_SCOPE,
});

/** The tokens a sign-in produced, as `login` keeps them. */
export interface LoginTokens {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly expiresIn: number | undefined;
  readonly scope: string | undefined;
}

export interface HeldSignIn {
  readonly tokens: LoginTokens;
  /**
   * Answers the tab the browser left waiting on the loopback: a redirect to `location`, or plain text when
   * there is none. Call it once the command knows what the tab should say. Idempotent.
   */
  readonly release: (location?: string) => void;
}

export interface LoginSignInOptions {
  /** False for `--no-open`: print the URL only. */
  readonly open: boolean;
  /** The SSO routing hint (`--email`); sent to the authorization server only. */
  readonly loginHint: string | undefined;
  /** Prints what the person needs to see once the listener is up; `url` is the full authorize URL. */
  readonly announce: (url: string, opening: boolean) => void;
  /** Where the tab goes for an authorization error, by the `error` the server sent. */
  readonly errorLocation: (error: string | null) => string | undefined;
  /** Where the tab goes when the code exchange itself failed. */
  readonly failedLocation: string | undefined;
}

/**
 * Signs in with the loopback in redirect mode and returns the tokens with the tab still held. The caller
 * must call `release`. When the exchange fails, the tab is released here, to `failedLocation`.
 */
export async function signInHeld(
  io: Io,
  config: Pick<Config, 'authUrl'>,
  target: SignInTarget,
  options: LoginSignInOptions
): Promise<HeldSignIn> {
  const endpoints = await discover(config, io, target.requiredScope);
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(24));
  let redirectUri = '';
  const { code, release } = await waitForCallback(
    io,
    state,
    (uri) => {
      redirectUri = uri;
      const url = authorizeUrl(endpoints, target, {
        redirectUri: uri,
        challenge,
        state,
        loginHint: options.loginHint,
      });
      options.announce(url.href, options.open);
      if (options.open) {
        try {
          io.openUrl(url.href);
        } catch {
          // The URL is printed, so the person can open it by hand.
        }
      }
    },
    { kind: 'redirect', errorLocation: options.errorLocation }
  );
  let tokens: Tokens;
  try {
    tokens = await exchangeCode(io, target.resource, endpoints, { code, redirectUri, verifier });
  } catch (error) {
    release(options.failedLocation);
    throw error;
  }
  if (tokens.accessToken === undefined) {
    release(options.failedLocation);
    if (tokens.refreshToken !== undefined)
      await revokeRefreshToken(io, endpoints, tokens.refreshToken);
    throw new CliError(EXIT.unauthenticated, 'Sign-in failed: the token response has no token.');
  }
  return {
    tokens: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      scope: tokens.scope,
    },
    release,
  };
}

/** What a refresh came back with: new tokens, or the answer that the sign-in is over. */
export type RefreshOutcome =
  { readonly kind: 'refreshed'; readonly tokens: LoginTokens } | { readonly kind: 'ended' };

/**
 * The `error_description`s with which the token endpoint says a refresh token can never work again
 * (bianoble-core origin/main packages/auth-server/src/token-endpoint.ts, the refresh-token grant: unknown,
 * already used, revoked, another client's, past the family's maximum age, expired, and the single sign-on
 * refusals that end the session). Matched exactly.
 *
 * The same endpoint also answers 400 `invalid_grant` for failures that are not the token's fault and consume
 * nothing ("Fail closed: refuse without revoking"): 'single sign-on session could not be verified',
 * 'single sign-on requirement could not be checked', 'client is not registered'. Those are not in this list,
 * so they are never read as the end of the sign-in.
 */
const TERMINAL_REFRESH_REASONS: ReadonlySet<string> = new Set([
  'refresh token is unknown',
  'refresh token has already been used',
  'refresh token has been revoked',
  'refresh token was issued to another client',
  'refresh token family has reached its maximum age',
  'refresh token is expired',
  'single sign-on session has expired',
  'single sign-on is no longer enabled',
  'this organization requires single sign-on',
  'authorization is no longer valid',
]);

/**
 * Trades a stored refresh token for new tokens (the server rotates it: the old one is spent). `ended` is the
 * server saying the grant is gone: an `invalid_grant` whose description is one of
 * {@link TERMINAL_REFRESH_REASONS}. Any other refusal (another 400, a 401), a server error or a network
 * failure is a CliError, so a stored sign-in is never thrown away over something that proves nothing.
 */
export async function refreshLogin(
  io: Io,
  config: Pick<Config, 'authUrl'>,
  refreshToken: string,
  resource: string
): Promise<RefreshOutcome> {
  const endpoints = await discover(config, io, undefined);
  let response: Response;
  const signal = requestSignal(io);
  try {
    response = await io.fetch(endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        resource,
      }),
      signal,
    });
  } catch {
    if (interrupted(io)) throw interruptedError('Nothing was changed.');
    throw new CliError(EXIT.failed, 'Cannot reach the token endpoint.');
  }
  if (response.status === 400) {
    const body: unknown = await response.json().catch(() => undefined);
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (
      record.error === 'invalid_grant' &&
      typeof record.error_description === 'string' &&
      TERMINAL_REFRESH_REASONS.has(record.error_description)
    ) {
      return { kind: 'ended' };
    }
  }
  if (!response.ok) {
    throw new CliError(
      EXIT.failed,
      `The token endpoint answered ${String(response.status)} when the saved sign-in was renewed. It was kept.`
    );
  }
  const tokens = readTokens(await response.json().catch(() => undefined));
  if (tokens.accessToken === undefined) {
    throw new CliError(EXIT.failed, 'The token endpoint answered without a token.');
  }
  return {
    kind: 'refreshed',
    tokens: {
      accessToken: tokens.accessToken,
      // A server that does not rotate keeps the old token valid.
      refreshToken: tokens.refreshToken ?? refreshToken,
      expiresIn: tokens.expiresIn,
      scope: tokens.scope,
    },
  };
}

/** Best effort: asks the server to end a stored sign-in. Warnings only; never throws. True when it accepted. */
export async function endLogin(
  io: Io,
  config: Pick<Config, 'authUrl'>,
  refreshToken: string
): Promise<boolean> {
  let endpoints: Endpoints;
  try {
    endpoints = await discover(config, io, undefined);
  } catch {
    io.stderr('warning: could not reach the server to end the sign-in there.\n');
    return false;
  }
  return revokeRefreshToken(io, endpoints, refreshToken);
}
