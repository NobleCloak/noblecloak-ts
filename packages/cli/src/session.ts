import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { open } from 'node:fs/promises';
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
 * Reads the authorization server metadata and checks that it names the configured issuer and offers what
 * the sign-in needs.
 */
async function discover(config: Config, io: Io): Promise<Endpoints> {
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
  if (Array.isArray(scopes) && !scopes.includes(ADMIN_SCOPE)) {
    throw new CliError(
      EXIT.failed,
      `The deployment does not offer the ${ADMIN_SCOPE} scope: its admin API is not enabled.`
    );
  }
  assertSecureUrl(authorization, 'The authorization endpoint');
  assertSecureUrl(token, 'The token endpoint');
  const revocation = text('revocation_endpoint');
  if (revocation !== undefined) assertSecureUrl(revocation, 'The revocation endpoint');
  return { authorization, token, revocation };
}

/** The pages the loopback listener answers with: plain text, nothing from the request echoed. */
function reply(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(`${text}\n`);
}

interface Callback {
  readonly code: string;
}

/**
 * Listens on 127.0.0.1 and resolves with the code of the first callback whose `state` matches. A request
 * with another path or another state gets a plain page and the listener keeps waiting. Rejects with exit
 * code 3 on timeout, on an error from the authorization server (with the right `state`) or on cancel.
 */
function waitForCallback(
  io: Io,
  state: string,
  onListening: (redirectUri: string) => void
): Promise<Callback> {
  return new Promise<Callback>((resolve, reject) => {
    let settled = false;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/callback') {
        reply(res, 404, 'Not found.');
        return;
      }
      if (url.searchParams.get('state') !== state) {
        reply(res, 400, 'This sign-in response does not match the request. It was ignored.');
        return;
      }
      if (settled) {
        reply(res, 409, 'This sign-in was already completed.');
        return;
      }
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || code === null || code === '') {
        reply(res, 400, 'Sign-in was not completed. Return to the terminal.');
        finish(new CliError(EXIT.unauthenticated, 'Sign-in was not completed.'));
        return;
      }
      reply(res, 200, 'Signed in. You can close this tab and return to the terminal.');
      finish(undefined, { code });
    });

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
      server.close();
      server.closeAllConnections();
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
}

async function exchangeCode(
  io: Io,
  config: Config,
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
    resource: config.adminAudience,
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
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const access = record.access_token;
  const refresh = record.refresh_token;
  return {
    accessToken: typeof access === 'string' && access !== '' ? access : undefined,
    refreshToken: typeof refresh === 'string' && refresh !== '' ? refresh : undefined,
  };
}

/** Best effort: a failure here is a warning, never a failed exit. */
async function revokeRefreshToken(
  io: Io,
  endpoints: Endpoints,
  refreshToken: string
): Promise<void> {
  if (endpoints.revocation === undefined) {
    io.stderr(
      'warning: the deployment advertises no revocation endpoint; the session stays open.\n'
    );
    return;
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
  } catch {
    io.stderr('warning: could not end the session (revocation endpoint unreachable).\n');
  }
}

/** A signed-in admin session. `end` revokes the refresh token, if the sign-in produced one. */
interface Session {
  readonly accessToken: string;
  end(): Promise<void>;
}

async function interactiveSignIn(io: Io, config: Config, open: boolean): Promise<Session> {
  const endpoints = await discover(config, io);
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(24));
  let redirectUri = '';

  const { code } = await waitForCallback(io, state, (uri) => {
    redirectUri = uri;
    const authorize = new URL(endpoints.authorization);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', CLIENT_ID);
    authorize.searchParams.set('redirect_uri', uri);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('resource', config.adminAudience);
    authorize.searchParams.set('scope', ADMIN_SCOPE);
    io.stderr(`Sign in to continue. Open this URL in your browser:\n${authorize.href}\n`);
    if (open) {
      try {
        io.openUrl(authorize.href);
      } catch {
        // The URL is printed above, so the user can open it by hand.
      }
    }
  });
  const tokens = await exchangeCode(io, config, endpoints, { code, redirectUri, verifier });
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
    const handle = await open(path, 'r');
    try {
      const { mode } = await handle.stat();
      if (io.platform !== 'win32' && (mode & 0o077) !== 0) {
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
 * Signs in (or reads the token file), runs `use` with the access token, then ends the session: the
 * refresh token is revoked whether `use` returned or threw. The session is never written to disk.
 */
export async function withSession<T>(
  io: Io,
  config: Config,
  options: SessionOptions,
  use: (accessToken: string) => Promise<T>
): Promise<T> {
  const session =
    options.userTokenFile === undefined
      ? await interactiveSignIn(io, config, options.open)
      : await tokenFromFile(io, options.userTokenFile);
  try {
    return await use(session.accessToken);
  } finally {
    await session.end();
  }
}
