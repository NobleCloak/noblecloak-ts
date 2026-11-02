/**
 * The pending authorization record: the PKCE verifier and `returnTo` of one sign-in, kept in
 * `sessionStorage` under `nc.auth.pending.<state>` across the redirect. It is deleted on first read, treated
 * as absent after ten minutes (a sign-in left open longer than that is treated as stale) and removed on any failure.
 */

const PREFIX = 'nc.auth.pending.';

/** How long a pending record is honoured. */
export const PENDING_MAX_AGE_MS = 600_000;

export interface PendingRecord {
  readonly verifier: string;
  readonly returnTo: string | undefined;
  readonly createdAt: number;
}

const area = (): Storage | null => {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
};

/** Writes the record; false when this browser will not keep it (the redirect could not be completed). */
export function writePending(state: string, record: PendingRecord): boolean {
  try {
    const storage = area();
    if (storage === null) return false;
    storage.setItem(
      PREFIX + state,
      JSON.stringify({
        verifier: record.verifier,
        ...(record.returnTo === undefined ? {} : { returnTo: record.returnTo }),
        createdAt: record.createdAt,
      })
    );
    return true;
  } catch {
    return false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Reads and deletes the record for `state`; null when it is absent, unreadable or older than ten minutes. */
export function takePending(state: string, now: number): PendingRecord | null {
  try {
    const storage = area();
    if (storage === null) return null;
    const raw = storage.getItem(PREFIX + state);
    storage.removeItem(PREFIX + state);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const { verifier, returnTo, createdAt } = parsed;
    if (typeof verifier !== 'string' || typeof createdAt !== 'number') return null;
    if (now - createdAt > PENDING_MAX_AGE_MS) return null;
    return { verifier, returnTo: typeof returnTo === 'string' ? returnTo : undefined, createdAt };
  } catch {
    return null;
  }
}

/** Removes every pending record (sign-out). */
export function clearPending(): void {
  try {
    const storage = area();
    if (storage === null) return;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX) === true) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Nothing stored that could be removed.
  }
}
