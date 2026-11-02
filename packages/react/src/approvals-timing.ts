/** Timer bookkeeping and the retry backoff shared by the stores. No React. */

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export type Timer = ReturnType<typeof setTimeout>;

export interface Backoff {
  next(): number;
  reset(): void;
}

/** 1 s doubling to 30 s with plus or minus 20% jitter, never above 30 s. */
export function createBackoff(): Backoff {
  let step = 0;
  return {
    next() {
      const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** step);
      step += 1;
      return Math.min(BACKOFF_MAX_MS, Math.round(base * (0.8 + Math.random() * 0.4)));
    },
    reset() {
      step = 0;
    },
  };
}

/** Starts a timer held in `set`, which drops it when it fires. */
export function after(set: Set<Timer>, ms: number, fn: () => void): Timer {
  const timer = setTimeout(() => {
    set.delete(timer);
    fn();
  }, ms);
  set.add(timer);
  return timer;
}

export function cancel(set: Set<Timer>, timer: Timer | undefined): void {
  if (timer === undefined) return;
  clearTimeout(timer);
  set.delete(timer);
}

export function clearAll(set: Set<Timer>): void {
  for (const timer of set) clearTimeout(timer);
  set.clear();
}
