import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { interruptedError } from './abortable.js';
import { CliError, EXIT } from './errors.js';
import type { Io } from './io.js';
import { openForRead } from './safe-open.js';
import { shownPath } from './terminal.js';

/**
 * Where `noblecloak login` keeps the sign-in: one JSON file, `auth.json`, in a directory of its own under
 * the person's home. The file holds a bearer token and a refresh token, so it is written 0600 in a 0700
 * directory, atomically (temp file and rename), and refused on read when another user can read it.
 *
 * The member names (`accessToken`, `refreshToken`, `expiresAt` in epoch milliseconds, `tokenType`, `scope`,
 * `authenticatedAt`, `issuer`, `orgId`, `sub`) are the ones the Claude Code plugin's own `auth.json` uses,
 * so the plugin can read this file with the code it has. `version`, `clientId` and `audience` are added: the
 * token is the CLI's (`noblecloak-cli`) and is bound to the admin API's audience, not the MCP gateway's, so
 * a reader must check them before it sends the token anywhere.
 */

/** The environment variable that replaces the directory. Tests set it; so can a person with a private disk. */
export const STATE_DIR_ENV = 'NOBLECLOAK_CLI_STATE_DIR';

export const LOGIN_FILE = 'auth.json';

/** The file's format version. A reader that does not know a newer one treats the file as not signed in. */
export const LOGIN_FORMAT = 1;

export interface StoredLogin {
  readonly version: typeof LOGIN_FORMAT;
  /** The authorization server that issued the tokens, without a trailing slash. */
  readonly issuer: string;
  /** The OAuth client the tokens were issued to: always `noblecloak-cli`. */
  readonly clientId: string;
  /** The audience the access token is bound to (the admin API). */
  readonly audience: string;
  readonly scope: string | undefined;
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  /** When the access token stops working, in epoch milliseconds. */
  readonly expiresAt: number;
  readonly tokenType: 'Bearer';
  /** When the person signed in (ISO 8601). */
  readonly authenticatedAt: string;
  /** The organization the sign-in is bound to, from the access token's `org_id`; absent when it had none. */
  readonly orgId: string | undefined;
  /** The person's id (the token's `sub`). Not an email. */
  readonly sub: string | undefined;
}

/** The directory: `$NOBLECLOAK_CLI_STATE_DIR`, else `~/.noblecloak/cli`. */
export function stateDir(io: Pick<Io, 'env'>): string {
  const override = io.env[STATE_DIR_ENV];
  return override !== undefined && override !== ''
    ? override
    : join(homedir(), '.noblecloak', 'cli');
}

export function loginFile(io: Pick<Io, 'env'>): string {
  return join(stateDir(io), LOGIN_FILE);
}

/** What a file this build will not use still tells: the server to ask, and the refresh token to revoke there. */
export interface Salvage {
  readonly issuer: string;
  readonly refreshToken: string;
}

export type LoginRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'found'; readonly login: StoredLogin }
  /**
   * There is a file, but it cannot be used: `reason` is a fixed phrase, never file content. `salvage` is set
   * when the file was refused only for its mode (it is the person's own file, with an issuer and a refresh
   * token in it), so the caller can still end that session on the server.
   */
  | { readonly kind: 'unusable'; readonly reason: string; readonly salvage?: Salvage };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalText = (record: Record<string, unknown>, name: string): string | undefined => {
  const value = record[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** Parses what `readLogin` read. Anything that is not a login this build understands is `undefined`. */
export function parseLogin(raw: unknown): StoredLogin | undefined {
  if (!isRecord(raw) || raw.version !== LOGIN_FORMAT) return undefined;
  const accessToken = optionalText(raw, 'accessToken');
  const issuer = optionalText(raw, 'issuer');
  const audience = optionalText(raw, 'audience');
  const clientId = optionalText(raw, 'clientId');
  const authenticatedAt = optionalText(raw, 'authenticatedAt');
  const expiresAt = raw.expiresAt;
  if (
    accessToken === undefined ||
    issuer === undefined ||
    audience === undefined ||
    clientId === undefined ||
    authenticatedAt === undefined ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt)
  ) {
    return undefined;
  }
  return {
    version: LOGIN_FORMAT,
    issuer,
    clientId,
    audience,
    scope: optionalText(raw, 'scope'),
    accessToken,
    refreshToken: optionalText(raw, 'refreshToken'),
    expiresAt,
    tokenType: 'Bearer',
    authenticatedAt,
    orgId: optionalText(raw, 'orgId'),
    sub: optionalText(raw, 'sub'),
  };
}

/** `{ salvage }` when `text` is JSON with an issuer and a refresh token, else nothing. */
function salvageOf(text: string): { salvage?: Salvage } {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw)) return {};
    const issuer = optionalText(raw, 'issuer');
    const refreshToken = optionalText(raw, 'refreshToken');
    return issuer === undefined || refreshToken === undefined
      ? {}
      : { salvage: { issuer, refreshToken } };
  } catch {
    return {};
  }
}

/**
 * Reads the saved sign-in. The mode is taken from the opened file (fstat), so the file checked is the file
 * read; a file another user can read is refused, as `--user-token-file` is (POSIX only).
 */
export async function readLogin(io: Pick<Io, 'env' | 'platform'>): Promise<LoginRead> {
  const path = loginFile(io);
  let text: string;
  try {
    // Non-blocking, and a regular file only: a FIFO at this path would hang the command.
    const handle = await openForRead(path);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { kind: 'unusable', reason: 'it is not a regular file' };
      text = await handle.readFile('utf8');
      if (io.platform !== 'win32' && (info.mode & 0o077) !== 0) {
        const uid = process.getuid?.();
        return {
          kind: 'unusable',
          reason: 'it can be read by other users',
          ...(uid === info.uid ? salvageOf(text) : {}),
        };
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'none' };
    return { kind: 'unusable', reason: 'it cannot be read' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unusable', reason: 'it is not valid JSON' };
  }
  const login = parseLogin(parsed);
  return login === undefined
    ? { kind: 'unusable', reason: 'it is not a sign-in this version understands' }
    : { kind: 'found', login };
}

/** The sentence that says a saved sign-in cannot be used, with the file's path. */
export function unusableMessage(io: Pick<Io, 'env'>, reason: string): string {
  return `The saved sign-in at ${shownPath(loginFile(io))} cannot be used: ${reason}. Run noblecloak login again.`;
}

/** The state directory is not one this code may put a sign-in in. `code` is for the error line, never a path. */
export class UnsafeStateDir extends Error {
  readonly code = 'UNSAFE_DIR';
  constructor() {
    super('the state directory is not private');
    this.name = 'UnsafeStateDir';
  }
}

/**
 * Makes sure the state directory exists and is private. One this code creates is made 0700 (and only that
 * one: an existing directory is never chmod-ed, so `NOBLECLOAK_CLI_STATE_DIR=$HOME` cannot change the mode of
 * a home directory). An existing one must be a directory owned by the current user with no group or other
 * access, or it throws {@link UnsafeStateDir}.
 */
export async function ensureStateDir(io: Pick<Io, 'env' | 'platform'>): Promise<void> {
  const dir = stateDir(io);
  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined) {
    // The umask may have cleared bits mkdir was asked for; the directory is ours, so set the mode outright.
    await chmod(dir, 0o700);
    return;
  }
  const info = await stat(dir);
  const uid = process.getuid?.();
  if (
    !info.isDirectory() ||
    (uid !== undefined && info.uid !== uid) ||
    (io.platform !== 'win32' && (info.mode & 0o077) !== 0)
  ) {
    throw new UnsafeStateDir();
  }
}

/** Writes the sign-in: a private directory, then a 0600 temp file renamed over the old one. */
export async function writeLogin(
  io: Pick<Io, 'env' | 'platform'>,
  login: StoredLogin
): Promise<void> {
  await ensureStateDir(io);
  const path = loginFile(io);
  const temp = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Removes the saved sign-in. A file that is not there is not an error. */
export async function deleteLogin(io: Pick<Io, 'env'>): Promise<void> {
  await rm(loginFile(io), { force: true });
}

/**
 * Removes the saved sign-in only if it still holds `refreshToken`: a command that found its refresh token
 * dead must not delete a sign-in another command wrote in the meantime. True when it deleted.
 */
export async function deleteLoginHolding(
  io: Pick<Io, 'env' | 'platform'>,
  refreshToken: string
): Promise<boolean> {
  const now = await readLogin(io);
  if (now.kind !== 'found' || now.login.refreshToken !== refreshToken) return false;
  await deleteLogin(io);
  return true;
}

/** The temp files `writeLogin` leaves when a process dies between writing and renaming. */
const TEMP_FILE = /^auth\.json\..+\.tmp$/;

/**
 * Removes the leftover `auth.json.*.tmp` files and returns what each one held, so the caller can revoke the
 * session it names. Call it under {@link withLoginLock}: a writer holds the lock for the whole of its write, so
 * any temp file seen then is a leftover. Never throws; a directory that is not there has none.
 */
export async function sweepTempFiles(io: Pick<Io, 'env'>): Promise<Salvage[]> {
  const dir = stateDir(io);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found: Salvage[] = [];
  for (const name of names.filter((n) => TEMP_FILE.test(n))) {
    const path = join(dir, name);
    try {
      const handle = await openForRead(path);
      try {
        if ((await handle.stat()).isFile()) {
          const salvage = salvageOf(await handle.readFile('utf8')).salvage;
          if (salvage !== undefined) found.push(salvage);
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Unreadable: removed below all the same.
    }
    await rm(path, { force: true }).catch(() => undefined);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------------------------------

const LOCK_FILE = 'auth.json.lock';
/** A holder's longest legitimate stretch: a metadata read and a token request, 30 s each, with margin. */
const LOCK_STALE_MS = 90_000;
const LOCK_WAIT_MS = 100_000;
const LOCK_POLL_MS = 25;

/**
 * Runs `work` while this process holds the saved sign-in's lock: an exclusive lock file in the state
 * directory (O_EXCL), as the Claude Code plugin takes around its own refresh. A refresh token is single-use
 * and the server revokes the whole family when one is replayed, so two commands must never present the same
 * one: whoever holds the lock reads the file, refreshes, and writes (or deletes); the others wait, then read
 * what the first wrote. A lock older than `io.lockStaleMs` (default 90 s) is a crashed holder's and is taken
 * over by rename, so exactly one waiter wins. Release only removes a lock that still holds this process's token.
 */
export async function withLoginLock<T>(
  io: Pick<Io, 'env' | 'platform' | 'signal'> & Partial<Pick<Io, 'lockStaleMs' | 'lockWaitMs'>>,
  work: () => Promise<T>
): Promise<T> {
  await ensureStateDir(io);
  const lockPath = join(stateDir(io), LOCK_FILE);
  const token = `${String(process.pid)}.${randomBytes(8).toString('hex')}`;
  const staleMs = io.lockStaleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + (io.lockWaitMs ?? LOCK_WAIT_MS);
  for (;;) {
    if (io.signal.aborted) throw interruptedError('Nothing was changed.');
    if (Date.now() >= deadline) {
      throw new CliError(
        EXIT.failed,
        'Another noblecloak command is using the saved sign-in. Try again in a moment.'
      );
    }
    try {
      await writeFile(lockPath, token, { mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      if (Date.now() - (await stat(lockPath)).mtimeMs > staleMs) {
        const stolen = `${lockPath}.stale.${String(process.pid)}.${randomBytes(4).toString('hex')}`;
        try {
          await rename(lockPath, stolen);
          await rm(stolen, { force: true });
        } catch {
          // Another waiter won the takeover.
        }
        continue;
      }
    } catch {
      // The lock went away between the failed create and the stat: try again at once.
      continue;
    }
    await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
  }
  try {
    return await work();
  } finally {
    const held = await openForRead(lockPath)
      .then(async (h) => {
        try {
          return await h.readFile('utf8');
        } finally {
          await h.close();
        }
      })
      .catch(() => undefined);
    if (held === token) await rm(lockPath, { force: true });
  }
}

/** True when the access token still has `marginMs` left at `now`. */
export function accessTokenLive(login: StoredLogin, now: number, marginMs = 30_000): boolean {
  return login.expiresAt - now > marginMs;
}
