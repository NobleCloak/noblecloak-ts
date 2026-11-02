/**
 * `useApprovalRequest`: binds the single-request store to React with `useSyncExternalStore`. The hook imports
 * no CSS and no component. The store is keyed on `(baseUrl, id, enabled)`: a change creates a new store (its
 * state starts at `loading`) and disposes the old one, whose late replies are dropped. `getToken`, `fetch`,
 * `onSessionExpired` and `onFault` are read through a ref, so an inline arrow function does not rebuild the
 * store on every render.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { createApprovalRequestStore } from './approval-request-store.js';
import type {
  ApprovalRequestController,
  ApprovalRequestStore,
  UseApprovalRequestOptions,
} from './approvals-types.js';
import { reportFault } from './fault.js';

interface Held {
  readonly key: string;
  readonly store: ApprovalRequestStore;
}

/** Reads one approval by id: its tool, digest, arguments (when the service allows them), lineage, policy and history. */
export function useApprovalRequest(
  id: string,
  options: UseApprovalRequestOptions
): ApprovalRequestController {
  const latest = useRef(options);
  latest.current = options;

  const enabled = options.enabled !== false;
  const key = JSON.stringify([options.baseUrl, id, enabled]);
  const held = useRef<Held | null>(null);
  if (held.current?.key !== key) {
    // Creating a store does nothing until it is subscribed, so a render that React discards leaks nothing.
    held.current = {
      key,
      store: createApprovalRequestStore(id, {
        baseUrl: options.baseUrl,
        enabled,
        getToken: (x) => latest.current.getToken(x),
        fetch: (input, init) => (latest.current.fetch ?? globalThis.fetch)(input, init),
        onSessionExpired: () => {
          latest.current.onSessionExpired?.();
        },
        // Always given, and read when the fault happens: a host that adds or removes `onFault` later does not lose faults.
        onFault: (fault: unknown) => {
          const handler = latest.current.onFault;
          if (handler === undefined) reportFault(fault);
          else handler(fault);
        },
      }),
    };
  }
  const store = held.current.store;

  // The previous store is disposed once the new one has committed (a StrictMode re-mount must not end a live one).
  const previous = useRef<ApprovalRequestStore | null>(null);
  useEffect(() => {
    if (previous.current !== null && previous.current !== store) previous.current.dispose();
    previous.current = store;
  }, [store]);

  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  const getServerSnapshot = useCallback(() => store.getServerSnapshot(), [store]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const retry = useCallback(() => {
    store.retry();
  }, [store]);

  return useMemo(() => ({ ...state, retry }), [state, retry]);
}
