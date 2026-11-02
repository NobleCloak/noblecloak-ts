/**
 * `usePolicySimulate`: binds the simulation of one policy, held by the store behind `usePolicies`, to React with
 * `useSyncExternalStore`. The hook imports no CSS and no component. A simulation always answers for the caller: the
 * contract reads the principal from the token, never from the request.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type {
  PoliciesController,
  PolicySimulationController,
  PolicySimulationStore,
  SimulationInput,
} from './permissions-types.js';

/** Runs policy `id` in dry run for the caller, against its working version unless another is named. */
export function usePolicySimulate(
  policies: PoliciesController,
  id: string
): PolicySimulationController {
  const { simulation: simulationOf } = policies;
  const runsOffered = policies.facts?.runs === true;
  const simulation: PolicySimulationStore = useMemo(() => simulationOf(id), [simulationOf, id]);
  const subscribe = useCallback(
    (listener: () => void) => simulation.subscribe(listener),
    [simulation]
  );
  const getSnapshot = useCallback(() => simulation.getSnapshot(), [simulation]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const run = useCallback((input: SimulationInput) => simulation.run(input), [simulation]);

  return useMemo(() => ({ ...snapshot, runsOffered, run }), [snapshot, runsOffered, run]);
}
