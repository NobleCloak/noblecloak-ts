/**
 * `usePolicies`: binds the headless policies store to React with `useSyncExternalStore`. The hook imports no CSS and
 * no component. The store is keyed on `(baseUrl, enabled, readOnly, suggested)`: a change creates a new store (its
 * snapshot starts at `loading`) and disposes the old one. `getToken`, `fetch`, `onSessionExpired` and `onFault` are
 * read through a ref, so an inline arrow function does not rebuild the store on every render. `roles` shapes only the
 * matrix, so a change to it rebuilds the matrix and reads nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { reportFault } from './fault.js';
import { buildPermissionsMatrix } from './permissions-matrix.js';
import { createPoliciesStore } from './permissions-store.js';
import type { PoliciesController, PoliciesStore, UsePoliciesOptions } from './permissions-types.js';

interface Held {
  readonly key: string;
  readonly store: PoliciesStore;
}

/** Reads the organisation's policies and tools; returns the controller the permissions components take. */
export function usePolicies(options: UsePoliciesOptions): PoliciesController {
  const latest = useRef(options);
  latest.current = options;

  const enabled = options.enabled !== false;
  const readOnly = options.readOnly === true;
  const suggested = options.suggested === true;
  const key = JSON.stringify([options.baseUrl, enabled, readOnly, suggested]);
  const held = useRef<Held | null>(null);
  if (held.current?.key !== key) {
    // Creating a store does nothing until it is subscribed, so a render that React discards leaks nothing.
    held.current = {
      key,
      store: createPoliciesStore({
        baseUrl: options.baseUrl,
        enabled,
        readOnly,
        suggested,
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
  const previous = useRef<PoliciesStore | null>(null);
  useEffect(() => {
    if (previous.current !== null && previous.current !== store) previous.current.dispose();
    previous.current = store;
  }, [store]);

  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  const getServerSnapshot = useCallback(() => store.getServerSnapshot(), [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const rolesKey = JSON.stringify(options.roles ?? []);
  const matrix = useMemo(
    () =>
      snapshot.status === 'ready'
        ? buildPermissionsMatrix(snapshot, JSON.parse(rolesKey) as UsePoliciesOptions['roles'])
        : undefined,
    [snapshot, rolesKey]
  );

  const refresh = useCallback(() => store.refresh(), [store]);
  const setCell = useCallback<PoliciesStore['setCell']>(
    (subject, toolRef, mode, o) => store.setCell(subject, toolRef, mode, o),
    [store]
  );
  const create = useCallback<PoliciesStore['create']>((write) => store.create(write), [store]);
  const publish = useCallback<PoliciesStore['publish']>(
    (id, shown) => store.publish(id, shown),
    [store]
  );
  const retire = useCallback<PoliciesStore['retire']>((id) => store.retire(id), [store]);
  const discardDraft = useCallback<PoliciesStore['discardDraft']>(
    (id, shown) => store.discardDraft(id, shown),
    [store]
  );
  const editor = useCallback<PoliciesStore['editor']>((id) => store.editor(id), [store]);
  const simulation = useCallback<PoliciesStore['simulation']>(
    (id) => store.simulation(id),
    [store]
  );
  const effective = useCallback<PoliciesStore['effective']>(() => store.effective(), [store]);
  const latestOf = useCallback<PoliciesStore['latest']>((id) => store.latest(id), [store]);
  const saveImported = useCallback<PoliciesStore['saveImported']>(
    (write, o) => store.saveImported(write, o),
    [store]
  );

  return useMemo(
    () => ({
      ...snapshot,
      ...(matrix === undefined ? {} : { matrix }),
      refresh,
      setCell,
      create,
      publish,
      retire,
      discardDraft,
      editor,
      simulation,
      effective,
      latest: latestOf,
      saveImported,
    }),
    [
      snapshot,
      matrix,
      refresh,
      setCell,
      create,
      publish,
      retire,
      discardDraft,
      editor,
      simulation,
      effective,
      latestOf,
      saveImported,
    ]
  );
}
