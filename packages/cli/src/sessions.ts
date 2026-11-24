import { assertSecureUrl } from './config.js';
import type { Io } from './io.js';
import { readLogin, sweepTempFiles, type Salvage } from './login-store.js';
import { endLogin } from './session.js';

/**
 * Asks the server a saved sign-in came from to revoke its refresh token. The issuer comes from a file, so it is
 * checked like a flag first: a file edited to point elsewhere never gets a token sent to a plain-http host, or
 * to a URL with a password in it. True when the server accepted; false (with a warning) otherwise.
 */
export async function endSession(io: Io, session: Salvage): Promise<boolean> {
  try {
    assertSecureUrl(session.issuer, 'The saved sign-in issuer');
  } catch {
    io.stderr(
      'warning: the saved sign-in names a server that is not https, or has a password in its URL; it was not contacted.\n'
    );
    return false;
  }
  return endLogin(io, { authUrl: session.issuer.replace(/\/+$/, '') }, session.refreshToken);
}

/** Sessions that stay open on the server unless someone revokes them. */
export interface Replaced {
  /** Refresh tokens held by the saved sign-in and by leftover temp files, each with the server to ask. */
  readonly sessions: readonly Salvage[];
  /** A saved file was there but named no session this build can read: one may be open that nobody can revoke. */
  readonly unknown: boolean;
  /** There was a saved file, or a leftover temp file, at all. */
  readonly present: boolean;
}

/**
 * What the state directory holds now: the saved sign-in (or what can be salvaged of one refused for its mode)
 * and the temp files a dead process left, which are removed. Call it under the sign-in lock.
 */
export async function replacedSessions(io: Io): Promise<Replaced> {
  const saved = await readLogin(io);
  const leftovers = await sweepTempFiles(io);
  const sessions: Salvage[] = [...leftovers];
  let unknown = false;
  if (saved.kind === 'found') {
    if (saved.login.refreshToken !== undefined) {
      sessions.push({ issuer: saved.login.issuer, refreshToken: saved.login.refreshToken });
    }
  } else if (saved.kind === 'unusable') {
    if (saved.salvage === undefined) unknown = true;
    else sessions.push(saved.salvage);
  }
  return { sessions, unknown, present: saved.kind !== 'none' || leftovers.length > 0 };
}
