/**
 * Test support for the permissions store and hooks: a subscribed store over the mock, and `untilState` to wait for a
 * snapshot of any of its stores. Not part of the published package.
 */
import { createPoliciesStore } from '../permissions-store.js';
import type { PoliciesSnapshot, PoliciesStore, UsePoliciesOptions } from '../permissions-types.js';

interface Subscribable<S> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): S;
}

/** Resolves with the first snapshot that satisfies `predicate`; rejects with the last one on timeout. */
export function untilState<S>(
  store: Subscribable<S>,
  predicate: (s: S) => boolean,
  timeoutMs = 5000
): Promise<S> {
  return new Promise((resolve, reject) => {
    // A store may notify inside `subscribe` (an editor starts its read there), so the listener cannot rely on
    // `unsubscribe` being assigned yet: it only records that it is done, and the caller unsubscribes after.
    let done = false;
    const check = (): boolean => {
      if (done) return true;
      const snapshot = store.getSnapshot();
      if (!predicate(snapshot)) return false;
      done = true;
      clearTimeout(timer);
      resolve(snapshot);
      return true;
    };
    const timer = setTimeout(() => {
      done = true;
      unsubscribe();
      reject(new Error(`timed out waiting: ${JSON.stringify(store.getSnapshot(), replacer)}`));
    }, timeoutMs);
    const unsubscribe = store.subscribe(() => {
      // Deferred and by closure: inside `subscribe` the binding does not exist yet.
      if (check())
        queueMicrotask(() => {
          unsubscribe();
        });
    });
    if (check()) unsubscribe();
  });
}

const replacer = (_key: string, value: unknown): unknown =>
  value instanceof Set ? [...(value as Set<unknown>)] : value;

/** A subscribed policies store: `close()` unsubscribes and disposes. */
export interface LivePolicies {
  readonly store: PoliciesStore;
  close(): void;
}

export function livePolicies(options: UsePoliciesOptions): LivePolicies {
  const store = createPoliciesStore(options);
  const unsubscribe = store.subscribe(() => undefined);
  return {
    store,
    close: () => {
      unsubscribe();
      store.dispose();
    },
  };
}

/** Waits until the store has settled on `ready`, `unavailable` or `error`. */
export function settled(store: PoliciesStore): Promise<PoliciesSnapshot> {
  return untilState(store, (s) => s.status !== 'loading' && s.status !== 'idle');
}
