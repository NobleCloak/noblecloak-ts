/**
 * `useConnections`: binds the headless connections store to React with `useSyncExternalStore`. The hook imports no CSS
 * and no component. The store is keyed on `(baseUrl, enabled)`: a change creates a new store (its snapshot
 * starts at `loading`) and disposes the old one. `getToken`, `fetch`, `onSessionExpired`, `onFault`, `readOnly`, `returnTo`
 * and `onNavigate` are read through a ref, so an inline arrow function does not rebuild the store on every render.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { createConnectionsStore } from './connections-store.js';
import type {
  ConnectionsController,
  ConnectionsStore,
  UseConnectionsOptions,
} from './connections-types.js';
import { reportFault } from './fault.js';

interface Held {
  readonly key: string;
  readonly store: ConnectionsStore;
}

/** Reads the organisation's tool-server registrations; returns the controller the connections components take. */
export function useConnections(options: UseConnectionsOptions): ConnectionsController {
  const latest = useRef(options);
  latest.current = options;

  const enabled = options.enabled !== false;
  const readOnly = options.readOnly === true;
  // `readOnly` is read through the ref, not a key: a host that learns the role after the first render keeps its
  // store, and with it the result of an OAuth round trip the store has already taken from the address.
  const key = JSON.stringify([options.baseUrl, enabled]);
  const held = useRef<Held | null>(null);
  if (held.current?.key !== key) {
    // Creating a store does nothing until it is subscribed, so a render that React discards leaks nothing.
    held.current = {
      key,
      store: createConnectionsStore({
        baseUrl: options.baseUrl,
        enabled,
        get readOnly() {
          return latest.current.readOnly;
        },
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
        // Read when an authorization starts, so the page's latest choice is the one used.
        get returnTo() {
          return latest.current.returnTo;
        },
        get onNavigate() {
          return latest.current.onNavigate;
        },
      }),
    };
  }
  const store = held.current.store;

  // The previous store is disposed once the new one has committed (a StrictMode re-mount must not end a live one).
  const previous = useRef<ConnectionsStore | null>(null);
  useEffect(() => {
    if (previous.current !== null && previous.current !== store) previous.current.dispose();
    previous.current = store;
  }, [store]);

  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  const getServerSnapshot = useCallback(() => store.getServerSnapshot(), [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // The actions keep their identity for the life of the store, so a component that depends on one re-runs only when
  // the store changes.
  const actions = useMemo(
    () => ({
      reload: () => store.reload(),
      create: (input: Parameters<ConnectionsStore['create']>[0]) => store.create(input),
      rename: (id: string, name: string) => store.rename(id, name),
      remove: (id: string) => store.remove(id),
      refresh: (id: string) => store.refresh(id),
      updateToolFacts: (
        toolId: string,
        facts: Parameters<ConnectionsStore['updateToolFacts']>[1]
      ) => store.updateToolFacts(toolId, facts),
      rotateOrgCredential: (id: string, token: string) => store.rotateOrgCredential(id, token),
      link: (id: string, input: Parameters<ConnectionsStore['link']>[1]) => store.link(id, input),
      unlink: (id: string) => store.unlink(id),
      revokeConsent: (id: string) => store.revokeConsent(id),
      authorize: (id: string) => store.authorize(id),
      detail: (id: string) => store.detail(id),
      dismissReturn: () => {
        store.dismissReturn();
      },
    }),
    [store]
  );

  // The store reads `readOnly` when it acts; its snapshot is built again when the host changes it.
  useEffect(() => {
    store.noteOptions();
  }, [store, readOnly]);

  return useMemo(() => ({ ...snapshot, ...actions }), [snapshot, actions]);
}
