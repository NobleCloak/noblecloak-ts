import { useCallback, useSyncExternalStore } from 'react';

import type { AuthState, BrowserAuth } from '../auth-types.js';

/** What the server renders: the type has no "not yet known" member, so signed out. */
const SERVER_SNAPSHOT: AuthState = { status: 'signed_out' };

const serverSnapshot = (): AuthState => SERVER_SNAPSHOT;

/** The current `AuthState` of `auth`, re-rendering on every change. It never signs anyone in. */
export function useAuthState(auth: BrowserAuth): AuthState {
  const subscribe = useCallback((listener: () => void) => auth.subscribe(listener), [auth]);
  const snapshot = useCallback(() => auth.getSnapshot(), [auth]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
