import { vi } from 'vitest';

import type { AuthState, BrowserAuth } from '@noblecloak/react/auth';

export interface FakeAuth extends BrowserAuth {
  /** Moves to `state` and tells the subscribers. */
  set(state: AuthState): void;
  readonly signIn: ReturnType<typeof vi.fn<BrowserAuth['signIn']>>;
  readonly completeSignIn: ReturnType<typeof vi.fn<BrowserAuth['completeSignIn']>>;
  readonly restore: ReturnType<typeof vi.fn<BrowserAuth['restore']>>;
  readonly getToken: ReturnType<typeof vi.fn<BrowserAuth['getToken']>>;
}

/** A sign-in object in a given state whose calls are recorded and change nothing. */
export function fakeAuth(initial: AuthState): FakeAuth {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    signIn: vi.fn<BrowserAuth['signIn']>(() => Promise.resolve()),
    completeSignIn: vi.fn<BrowserAuth['completeSignIn']>(() => Promise.resolve()),
    restore: vi.fn<BrowserAuth['restore']>(() => Promise.resolve()),
    getToken: vi.fn<BrowserAuth['getToken']>(() => Promise.resolve('access-token')),
    signOut: () => Promise.resolve(),
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}
