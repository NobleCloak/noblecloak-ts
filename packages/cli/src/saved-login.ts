import { stat } from 'node:fs/promises';
import { interrupted } from './abortable.js';
import { boolFlag, type ParsedFlags } from './args.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import { APP_URL_ENV, resolveSetupHosts, type SetupHosts } from './login-config.js';
import {
  UnsafeStateDir,
  accessTokenLive,
  deleteLogin,
  deleteLoginHolding,
  loginFile,
  readLogin,
  stateDir,
  unusableMessage,
  withLoginLock,
  writeLogin,
  type StoredLogin,
} from './login-store.js';
import { storedLoginOf, unreadableNote } from './login.js';
import { CLIENT_ID, refreshLogin } from './session.js';
import { endSession, replacedSessions } from './sessions.js';
import { readSetup, type SetupRead } from './setup-state.js';
import { jsonForTerminal, shownPath } from './terminal.js';

/** What the saved sign-in gave `setup`. */
export type SavedProgress =
  | { readonly kind: 'none' }
  /** The deployment has no admin audience on record (self-hosted, no `--admin-audience`): nothing to check a sign-in against. */
  | { readonly kind: 'skipped' }
  /** Saved for another deployment or app than the one asked about. */
  | { readonly kind: 'other_deployment' }
  | { readonly kind: 'unusable'; readonly reason: string }
  /**
   * The sign-in is over: the server said its refresh token is revoked, used or expired (the file is removed),
   * or it refused the access token on the setup read (the file is kept).
   */
  | { readonly kind: 'expired' }
  | { readonly kind: 'read'; readonly read: SetupRead };

/** The outcome of renewing under the lock. */
type Renewed =
  | { readonly kind: 'login'; readonly login: StoredLogin }
  | { readonly kind: 'expired' }
  | { readonly kind: 'none' };

/**
 * Brings the saved sign-in's access token up to date, with the lock held for the whole read, refresh and
 * write: a refresh token is single-use and the server revokes the whole family when one is replayed, so two
 * commands must not both present it. The file is read again under the lock, because another command may have
 * renewed it while this one waited. A refresh the server says is over deletes the file only if it still
 * holds the refresh token this command presented.
 */
async function renewUnderLock(
  io: Io,
  hosts: SetupHosts & { adminAudience: string }
): Promise<Renewed> {
  return withLoginLock(io, async () => {
    const now = await readLogin(io);
    if (now.kind !== 'found') return { kind: 'none' };
    let login = now.login;
    if (accessTokenLive(login, Date.now())) return { kind: 'login', login };
    const presented = login.refreshToken;
    if (presented === undefined) {
      await deleteLogin(io);
      return { kind: 'expired' };
    }
    const outcome = await refreshLogin(io, hosts, presented, login.audience);
    if (outcome.kind === 'ended') {
      await deleteLoginHolding(io, presented);
      return { kind: 'expired' };
    }
    login = storedLoginOf(
      hosts,
      outcome.tokens,
      Date.now(),
      {
        ...(login.orgId === undefined ? {} : { orgId: login.orgId }),
        ...(login.sub === undefined ? {} : { sub: login.sub }),
      },
      login.authenticatedAt
    );
    // Not saving costs the next run a refresh with a spent token, which the server refuses: say so.
    await writeLogin(io, login).catch(() => {
      io.stderr(
        `warning: could not save the renewed sign-in at ${shownPath(loginFile(io))}; run noblecloak login if the next command asks you to.\n`
      );
    });
    return { kind: 'login', login };
  });
}

/**
 * The setup progress through the saved sign-in: its access token when it still lives, else a refresh under
 * the lock. A refresh the server says is over (revoked, used or expired) removes the dead file. Any other
 * failure (a transient single sign-on refusal, the network, a 5xx) leaves the file alone and reads as
 * unreadable. Only an interrupt is thrown.
 */
export async function savedProgress(io: Io, hosts: SetupHosts): Promise<SavedProgress> {
  const adminAudience = hosts.adminAudience;
  if (adminAudience === undefined) return { kind: 'skipped' };
  const saved = await readLogin(io);
  if (saved.kind === 'none') return { kind: 'none' };
  if (saved.kind === 'unusable') return { kind: 'unusable', reason: saved.reason };
  let login = saved.login;
  if (
    login.issuer !== hosts.authUrl ||
    login.audience !== adminAudience ||
    login.clientId !== CLIENT_ID
  ) {
    return { kind: 'other_deployment' };
  }
  const orgId = login.orgId;
  if (orgId === undefined) return { kind: 'read', read: { kind: 'unreadable' } };
  try {
    if (!accessTokenLive(login, Date.now())) {
      const renewed = await renewUnderLock(io, { ...hosts, adminAudience });
      if (renewed.kind === 'none') return { kind: 'none' };
      if (renewed.kind === 'expired') return { kind: 'expired' };
      login = renewed.login;
    }
    const read = await readSetup(io, hosts.origin, orgId, login.accessToken);
    return read.kind === 'rejected' ? { kind: 'expired' } : { kind: 'read', read };
  } catch (error) {
    if (interrupted(io)) throw error;
    if (error instanceof UnsafeStateDir) {
      return { kind: 'unusable', reason: 'its directory is not owned by you or is open to others' };
    }
    if (!(error instanceof CliError)) throw error;
    return { kind: 'read', read: { kind: 'unreadable' } };
  }
}

/** The sentence for a saved sign-in `setup` could not use; undefined when there is nothing to say. */
export function savedProgressNote(io: Io, progress: SavedProgress): string | undefined {
  if (progress.kind === 'expired') {
    return 'Your sign-in has expired. Run noblecloak login to see your progress here.';
  }
  if (progress.kind === 'unusable') return unusableMessage(io, progress.reason);
  if (progress.kind === 'other_deployment') {
    return 'The saved sign-in is for another deployment. Run noblecloak login to see your progress here.';
  }
  if (progress.kind === 'read') return unreadableNote(progress.read, false);
  return undefined;
}

/**
 * `noblecloak setup`: opens the setup wizard in the browser (it opens at the first unfinished step). When a
 * sign-in is saved it also says how many steps are left. It never needs the sign-in: an expired one only
 * costs the count.
 */
export async function setupCommand(flags: ParsedFlags, io: Io): Promise<void> {
  const hosts = resolveSetupHosts(flags, io);
  if (hosts.appUrl === undefined) {
    throw new CliError(EXIT.usage, `Missing the app URL: pass --app-url or set ${APP_URL_ENV}.`);
  }
  const url = `${hosts.appUrl}/setup`;
  const json = boolFlag(flags, 'json');
  const opening = !boolFlag(flags, 'no-open');
  if (!json) {
    io.stderr(
      opening
        ? `Opening setup in your browser…\n(If it didn't open: ${url})\n`
        : `Open this URL in your browser to continue setup:\n${url}\n`
    );
  }
  if (opening) {
    try {
      io.openUrl(url);
    } catch {
      // The URL is printed above, so the person can open it by hand.
    }
  }
  const progress = await savedProgress(io, hosts);
  const read = progress.kind === 'read' ? progress.read : undefined;
  if (json) {
    io.stdout(
      `${jsonForTerminal({
        url,
        // Why there is no count, when there is none: no saved sign-in, one that is expired, for another
        // deployment or unusable, or a read that failed.
        saved_sign_in: progress.kind,
        setup: read?.kind ?? null,
        ...(read?.kind === 'unfinished' ? { steps_left: read.left, steps_total: read.total } : {}),
      })}\n`
    );
    return;
  }
  const note = savedProgressNote(io, progress);
  if (note !== undefined) io.stderr(`${note}\n`);
  if (read?.kind === 'unfinished') {
    io.stdout(`${String(read.left)} of ${String(read.total)} steps left.\n`);
  } else if (read?.kind === 'finished') {
    io.stdout('Setup is finished.\n');
  }
}

/**
 * `noblecloak logout`: asks the server to end the saved sign-in and removes the file, under the lock. It
 * reaches the server named in the file, so it needs no flag. It ends the session of a file it refuses to use
 * for its mode too, and of any temp file a dead process left; a file it cannot read at all is deleted with a
 * warning, because the session it named may still be open.
 */
export async function logoutCommand(flags: ParsedFlags, io: Io): Promise<void> {
  const json = boolFlag(flags, 'json');
  // Nothing to lock, and no directory to make for it, when there has never been a sign-in.
  const exists = await stat(stateDir(io)).then(
    () => true,
    () => false
  );
  let outcome = { was: false, serverNotTold: false };
  if (exists) {
    outcome = await withLoginLock(io, async () => {
      const held = await replacedSessions(io);
      let serverNotTold = held.unknown;
      for (const session of held.sessions) {
        if (!(await endSession(io, session))) serverNotTold = true;
      }
      await deleteLogin(io);
      return { was: held.present, serverNotTold };
    }).catch((error: unknown) => {
      if (error instanceof UnsafeStateDir) {
        throw new CliError(
          EXIT.failed,
          `Cannot sign out: ${shownPath(stateDir(io))} must be a directory you own with no access for group or others.`
        );
      }
      throw error;
    });
  }
  const { was, serverNotTold } = outcome;
  if (json) {
    io.stdout(
      `${jsonForTerminal({ signed_out: was, server_session_ended: was && !serverNotTold })}\n`
    );
    return;
  }
  if (!was) io.stdout('You are not signed in.\n');
  else if (serverNotTold) {
    io.stdout(
      'Signed out here. The server was not told, so the session there may stay open until it expires.\n'
    );
  } else io.stdout('Signed out.\n');
}
