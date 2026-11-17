import { isSetupStepKey, type SetupStepKey } from './types.js';

/**
 * How a visitor arrived at setup: the shell's redirect query, read once. An arrival signal, not live
 * state. `claim` is the GitHub re-claim handoff and is secret material in the app: this package only
 * tests whether it is present and never reads its members, so the app's own `{ id, secret }` type
 * is assignable and nothing here can log it.
 */
export interface SetupArrival {
  /** COO's `step` query value, unchanged (e.g. `integrations`). */
  step: string | null;
  /** A closed code from the shell, or `unknown_error`; never the raw query value. */
  error: string | null;
  pending: string | null;
  connected: string | null;
  checkoutReturn: boolean;
  claim: object | null;
}

export const NO_ARRIVAL: Readonly<SetupArrival> = Object.freeze({
  step: null,
  error: null,
  pending: null,
  connected: null,
  checkoutReturn: false,
  claim: null,
});

/** A Set whose mutators throw, so a shared export cannot be changed at runtime (`Object.freeze` alone does not stop `add`). */
function frozenSet(values: readonly string[]): ReadonlySet<string> {
  const set = new Set(values);
  const refuse = (): never => {
    throw new TypeError('This set is read-only');
  };
  Object.defineProperties(set, {
    add: { value: refuse },
    delete: { value: refuse },
    clear: { value: refuse },
  });
  return Object.freeze(set);
}

/** The shell's redirect error codes that come from the GitHub App install and re-claim path. */
export const GITHUB_ERROR_CODES: ReadonlySet<string> = frozenSet([
  'github_app_not_configured',
  'github_user_auth_required',
  'invalid_installation_id',
  'github_user_auth_failed',
  'installation_not_owned',
  'installation_lookup_failed',
  'github_app_signer_unavailable',
  'installation_admin_required',
  'installation_not_found',
  'installation_choice_required',
  'installation_suspended',
  'claim_store_unavailable',
]);

/**
 * Which Core step an arrival opens, or null for none. COO sends `step=integrations`, which is no Core
 * step key: it means GitHub when the return names GitHub (connected, pending or a GitHub install
 * error), otherwise Tools. A Checkout return opens People (the Invite tab).
 */
export function resolveInitialStep(arrival: SetupArrival): SetupStepKey | null {
  if (arrival.claim) return 'github';
  if (arrival.step !== null && isSetupStepKey(arrival.step)) return arrival.step;
  if (
    arrival.step === 'integrations' ||
    arrival.error !== null ||
    arrival.pending !== null ||
    arrival.connected !== null
  ) {
    const github =
      arrival.connected === 'github' ||
      arrival.pending === 'github' ||
      (arrival.error !== null && GITHUB_ERROR_CODES.has(arrival.error));
    return github ? 'github' : 'tools';
  }
  if (arrival.checkoutReturn) return 'people';
  return null;
}
