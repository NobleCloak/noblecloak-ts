/**
 * `useEffectivePolicies`: binds the effective view held by the store behind `usePolicies` to React with
 * `useSyncExternalStore`. The hook imports no CSS and no component. Nothing is sent until cells are asked for
 * (`request`), and then only as an administrator may (see `EffectiveStore`).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type {
  EffectiveBasis,
  EffectiveRequest,
  EffectiveSnapshot,
  EffectiveStore,
} from './permissions-effective.js';
import type { PoliciesController } from './permissions-types.js';

/** What `useEffectivePolicies` returns: the effective cells and the actions that ask for them. */
export interface EffectivePoliciesController extends EffectiveSnapshot {
  readonly request: (cells: readonly EffectiveRequest[]) => void;
  readonly setBasis: (basis: EffectiveBasis) => void;
  readonly retry: () => void;
}

/** The effective view of the policies `policies` reads: what a holder of a role or of the organisation would get. */
export function useEffectivePolicies(policies: PoliciesController): EffectivePoliciesController {
  const { effective: effectiveOf } = policies;
  const store: EffectiveStore = useMemo(() => effectiveOf(), [effectiveOf]);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const request = useCallback(
    (cells: readonly EffectiveRequest[]) => {
      store.request(cells);
    },
    [store]
  );
  const setBasis = useCallback(
    (basis: EffectiveBasis) => {
      store.setBasis(basis);
    },
    [store]
  );
  const retry = useCallback(() => {
    store.retry();
  }, [store]);
  return useMemo(
    () => ({ ...snapshot, request, setBasis, retry }),
    [snapshot, request, setBasis, retry]
  );
}
