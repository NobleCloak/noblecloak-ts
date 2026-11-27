import { boolFlag, stringFlag, type ParsedFlags } from './args.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import { resolveLoginHosts, type LoginHosts } from './login-config.js';
import {
  LOGIN_FORMAT,
  UnsafeStateDir,
  loginFile,
  stateDir,
  withLoginLock,
  writeLogin,
  type StoredLogin,
} from './login-store.js';
import { readSetup, type SetupRead } from './setup-state.js';
import { CLIENT_ID, endLogin, loginTarget, signInHeld, type LoginTokens } from './session.js';
import { endSession, replacedSessions, type Replaced } from './sessions.js';
import { forTerminal, jsonForTerminal, shownPath } from './terminal.js';

/**
 * The `error` codes the hosted signed-in page has its own copy for (noblesos-shell `src/cli/signedIn.ts`
 * `CLI_SIGN_IN_ERROR_CODES`, origin/main 802b22f). Any other value reaches the page as `unknown_error`: the
 * authorization server's text is never forwarded.
 */
const PAGE_ERROR_CODES: ReadonlySet<string> = new Set([
  'access_denied',
  'invalid_request',
  'unauthorized_client',
  'unsupported_response_type',
  'invalid_scope',
  'invalid_target',
  'server_error',
  'temporarily_unavailable',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Seconds an access token lives when the token response does not say (the server's own value). */
const DEFAULT_LIFETIME_SECONDS = 900;

/**
 * The organization and person an access token names. The token is read, not verified: a wrong claim here
 * only changes which organization the page and the setup read ask about, and the server decides what the
 * token may do. Never throws.
 */
export function tokenClaims(accessToken: string): { orgId?: string; sub?: string } {
  const payload = accessToken.split('.')[1];
  if (payload === undefined) return {};
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
  if (typeof claims !== 'object' || claims === null) return {};
  const record = claims as Record<string, unknown>;
  const orgId = record.org_id;
  const sub = record.sub;
  return {
    ...(typeof orgId === 'string' && UUID.test(orgId) ? { orgId: orgId.toLowerCase() } : {}),
    ...(typeof sub === 'string' && sub !== '' ? { sub } : {}),
  };
}

/** The saved form of a sign-in. */
export function storedLoginOf(
  hosts: Pick<LoginHosts, 'authUrl'> & { readonly adminAudience: string },
  tokens: LoginTokens,
  now: number,
  claims: { orgId?: string; sub?: string },
  authenticatedAt: string
): StoredLogin {
  return {
    version: LOGIN_FORMAT,
    issuer: hosts.authUrl,
    clientId: CLIENT_ID,
    audience: hosts.adminAudience,
    scope: tokens.scope,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now + (tokens.expiresIn ?? DEFAULT_LIFETIME_SECONDS) * 1000,
    tokenType: 'Bearer',
    authenticatedAt,
    orgId: claims.orgId,
    sub: claims.sub,
  };
}

/** The hosted page's URL, or undefined when the deployment's app is not known. */
export function signedInUrl(
  hosts: Pick<LoginHosts, 'appUrl'>,
  query: { org?: string | undefined; error?: string | undefined }
): string | undefined {
  if (hosts.appUrl === undefined) return undefined;
  const url = new URL('/cli/signed-in', hosts.appUrl);
  if (query.org !== undefined) url.searchParams.set('org', query.org);
  if (query.error !== undefined) url.searchParams.set('error', query.error);
  return url.href;
}

/** What `--email` may be: one line that looks like an address. It is a routing hint, never shown back. */
function emailFlag(flags: ParsedFlags): string | undefined {
  if (flags.email === undefined) return undefined;
  const value = stringFlag(flags, 'email')?.trim();
  if (
    value === undefined ||
    !/^[^\s@]+@[^\s@]+$/.test(value) ||
    forTerminal(value) !== value ||
    value.length > 254
  ) {
    throw new CliError(EXIT.usage, '--email must be an email address.');
  }
  return value;
}

const setupAddress = (hosts: Pick<LoginHosts, 'appUrl'>): string =>
  hosts.appUrl === undefined ? 'noblecloak setup' : `noblecloak setup   or   ${hosts.appUrl}/setup`;

/** The `Next` block of the terminal: what to do about setup, by what the setup read said. */
export function nextLines(hosts: Pick<LoginHosts, 'appUrl'>, read: SetupRead): string[] {
  if (read.kind !== 'unfinished') return [];
  return [
    `Next: finish setup (${String(read.left)} of ${String(read.total)} steps left)`,
    `  ${setupAddress(hosts)}`,
  ];
}

const MCP_LINES = ['In Claude Code, run /mcp to connect tools.'];

/**
 * The words for a setup read that could not give a count; undefined when nothing needs saying. `hint` is
 * what to do next, and is left out where the person is already doing it.
 */
export function unreadableNote(read: SetupRead, hint = true): string | undefined {
  if (read.kind === 'unreadable' || read.kind === 'rejected') {
    return `warning: could not read your setup progress.${hint ? ' Run noblecloak setup to continue.' : ''}`;
  }
  return undefined;
}

/**
 * `noblecloak login`: signs a person in with the authorization-code flow (PKCE, on a loopback) for the
 * admin API's `setup:read` scope, keeps the sign-in (login-store.ts), sends the browser tab to the hosted
 * signed-in page, and prints what to do next by the organization's setup state.
 */
export async function loginCommand(flags: ParsedFlags, io: Io): Promise<void> {
  const hosts = resolveLoginHosts(flags, io);
  const loginHint = emailFlag(flags);
  const json = boolFlag(flags, 'json');
  const open = !boolFlag(flags, 'no-open');

  const held = await signInHeld(io, hosts, loginTarget(hosts), {
    open,
    loginHint,
    announce: (url, opening) => {
      io.stderr(
        opening
          ? `Opening your browser to sign in…\n(If it didn't open: ${url})\n\n`
          : `Open this URL in your browser to sign in:\n${url}\n\n`
      );
    },
    errorLocation: (error) =>
      signedInUrl(hosts, {
        error: error !== null && PAGE_ERROR_CODES.has(error) ? error : 'unknown_error',
      }),
    failedLocation: signedInUrl(hosts, { error: 'server_error' }),
  });

  const claims = tokenClaims(held.tokens.accessToken);
  // What the state directory held before, and any temp file a dead process left: sessions that stay open on
  // the server unless they are revoked once the new sign-in is saved.
  let replaced: Replaced;
  try {
    replaced = await withLoginLock(io, async () => {
      const before = await replacedSessions(io);
      await writeLogin(
        io,
        storedLoginOf(hosts, held.tokens, Date.now(), claims, new Date().toISOString())
      );
      return before;
    });
  } catch (error) {
    held.release(signedInUrl(hosts, { error: 'server_error' }));
    // The server issued a refresh token that is now in no file: end it rather than leave it open.
    if (held.tokens.refreshToken !== undefined) await endLogin(io, hosts, held.tokens.refreshToken);
    if (error instanceof CliError) throw error;
    if (error instanceof UnsafeStateDir) {
      throw new CliError(
        EXIT.failed,
        `Signed in, but the sign-in was not saved: ${shownPath(stateDir(io))} must be a directory you own with no access for group or others.`
      );
    }
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    throw new CliError(
      EXIT.failed,
      `Signed in, but the sign-in could not be saved at ${shownPath(loginFile(io))}${code === undefined ? '' : ` (${code})`}.`
    );
  }
  held.release(signedInUrl(hosts, { org: claims.orgId }));
  for (const session of replaced.sessions) await endSession(io, session);
  if (replaced.unknown) {
    io.stderr(
      'warning: the earlier saved sign-in could not be read, so its session on the server may still be open.\n'
    );
  }

  const read: SetupRead =
    claims.orgId === undefined
      ? { kind: 'unreadable' }
      : await readSetup(io, hosts.origin, claims.orgId, held.tokens.accessToken);

  if (json) {
    io.stdout(
      `${jsonForTerminal({
        signed_in: true,
        setup: read.kind,
        ...(read.kind === 'unfinished' ? { steps_left: read.left, steps_total: read.total } : {}),
      })}\n`
    );
    return;
  }
  const note = unreadableNote(read);
  if (note !== undefined) io.stderr(`${note}\n`);
  const next = nextLines(hosts, read);
  io.stdout(
    `✓ Signed in\n\n${next.length === 0 ? '' : `${next.join('\n')}\n\n`}${MCP_LINES.join('\n')}\n`
  );
}
