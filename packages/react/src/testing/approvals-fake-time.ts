/** Fake-timer helpers for store tests that run the mock in this process. Not part of the published package. */
import { vi } from 'vitest';

const realImmediate = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Requests the in-process mock is still answering. The mock verifies a token with `crypto.subtle`, which
 * finishes on the libuv threadpool after an unpredictable number of event-loop turns (more on a loaded
 * 2-vCPU runner), so no fixed count of `setImmediate` yields is enough to let a response arrive before fake
 * time moves on. The helpers below wait for this counter instead of counting turns.
 */
let inFlight = 0;

export function trackInFlight<T>(request: Promise<T>): Promise<T> {
  inFlight += 1;
  const done = (): void => {
    inFlight -= 1;
  };
  request.then(done, done);
  return request;
}

/** Real-time ceiling on one wait, so a request that is held on purpose cannot hang a test forever. */
const SETTLE_CEILING_MS = 5000;

/**
 * Yields to real I/O until no in-process request is in flight, then twice more so the store's continuations
 * (microtasks queued by the response) have run and any request they start is seen. Waits on the counter,
 * never on a count of turns.
 */
async function settle(): Promise<void> {
  const deadline = performance.now() + SETTLE_CEILING_MS;
  let quiet = 0;
  while (quiet < 2 && performance.now() < deadline) {
    await realImmediate();
    quiet = inFlight === 0 ? quiet + 1 : 0;
  }
}

export function fakeTime(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date'],
    now: Date.parse('2026-10-05T12:00:00Z'),
  });
}

/** Advances fake time by `ms`, yielding to real I/O between steps so in-process responses arrive. */
export async function advance(ms: number, step = 50): Promise<void> {
  let left = ms;
  while (left > 0) {
    const now = Math.min(step, left);
    await vi.advanceTimersByTimeAsync(now);
    await settle();
    left -= now;
  }
  await vi.advanceTimersByTimeAsync(0);
  await settle();
}

/** Advances in small steps until `condition` holds; returns the fake milliseconds it took. */
export async function advanceUntil(
  condition: () => boolean,
  maxMs = 10_000,
  step = 25
): Promise<number> {
  await settle();
  for (let elapsed = 0; elapsed <= maxMs; elapsed += step) {
    if (condition()) return elapsed;
    await vi.advanceTimersByTimeAsync(step);
    await settle();
  }
  throw new Error(`the condition did not hold within ${String(maxMs)} ms of fake time`);
}
