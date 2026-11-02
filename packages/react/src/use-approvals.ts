/**
 * `useApprovals`: binds the headless store to React with `useSyncExternalStore`. The hook imports no CSS
 * and no component. The store is keyed on `(baseUrl, scope, enabled)`: a change creates a new store (its
 * snapshot starts at `loading`) and disposes the old one. `getToken`, `fetch`, `onSessionExpired` and `onFault` are
 * read through a ref, so an inline arrow function does not rebuild the store on every render.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { createApprovalsStore } from './approvals-store.js';
import { reportFault } from './fault.js';
import type {
  ApprovalsController,
  ApprovalsStore,
  UseApprovalsOptions,
} from './approvals-types.js';

interface Held {
  readonly key: string;
  readonly store: ApprovalsStore;
}

/** Binds the headless approvals store to React: returns the controller `<Approvals controller={…}/>` takes. */
export function useApprovals(options: UseApprovalsOptions): ApprovalsController {
  const latest = useRef(options);
  latest.current = options;

  const enabled = options.enabled !== false;
  const key = JSON.stringify([options.baseUrl, options.scope ?? null, enabled]);
  const held = useRef<Held | null>(null);
  if (held.current?.key !== key) {
    // Creating a store does nothing until it is subscribed, so a render that React discards leaks nothing.
    held.current = {
      key,
      store: createApprovalsStore({
        baseUrl: options.baseUrl,
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        enabled,
        getToken: (x) => latest.current.getToken(x),
        fetch: (input, init) => (latest.current.fetch ?? globalThis.fetch)(input, init),
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        ...(options.reconcileMs === undefined ? {} : { reconcileMs: options.reconcileMs }),
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

  // The previous store is disposed once the new one has committed. Disposing in a cleanup would end a
  // store that StrictMode re-mounts, so a store is disposed only when it has been replaced.
  const previous = useRef<ApprovalsStore | null>(null);
  useEffect(() => {
    if (previous.current !== null && previous.current !== store) previous.current.dispose();
    previous.current = store;
  }, [store]);

  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  const getServerSnapshot = useCallback(() => store.getServerSnapshot(), [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const refresh = useCallback(() => store.refresh(), [store]);
  const openDetail = useCallback(
    (id: string) => {
      store.openDetail(id);
    },
    [store]
  );
  const closeDetail = useCallback(() => {
    store.closeDetail();
  }, [store]);
  const retryDetail = useCallback(() => {
    store.retryDetail();
  }, [store]);
  const approve = useCallback<ApprovalsController['approve']>(
    (id, o) => store.approve(id, o),
    [store]
  );
  const deny = useCallback<ApprovalsController['deny']>((id, o) => store.deny(id, o), [store]);
  const loadMore = useCallback(() => store.loadMore(), [store]);
  const loadRecent = useCallback(() => store.loadRecent(), [store]);
  const loadMoreRecent = useCallback(() => store.loadMoreRecent(), [store]);
  const approveMany = useCallback(
    (ids: readonly string[], shown: ReadonlyMap<string, string>) => store.approveMany(ids, shown),
    [store]
  );

  return useMemo(
    () => ({
      ...snapshot,
      refresh,
      openDetail,
      closeDetail,
      retryDetail,
      approve,
      deny,
      loadMore,
      loadRecent,
      loadMoreRecent,
      approveMany,
    }),
    [
      snapshot,
      refresh,
      openDetail,
      closeDetail,
      retryDetail,
      approve,
      deny,
      loadMore,
      loadRecent,
      loadMoreRecent,
      approveMany,
    ]
  );
}
