/**
 * The setup state the rule reads: the structural subset of Core's `GET /organizations/{id}/setup`.
 *
 * This package has no runtime dependencies and does no validation. The caller parses the response
 * (noblesos-team uses a zod schema) and passes the result in; the rule trusts these types. The
 * degrade rules the callers apply when they parse are part of the contract:
 *
 * - a step `state` the caller's build does not know reads `unknown` (never done);
 * - a step `availability` it does not know reads `disabled`;
 * - an `intent` it does not know reads `null`;
 * - a missing `app_authorized`, `setup_proposal_approved` or `held_action_decided` reads
 *   `{ done: null }` (unknown, never done).
 *
 * A caller's richer object (extra members such as `lanes`, `detail`, `first_done_at`) is accepted
 * as is: every member here is read-only and the rule reads nothing else.
 */

/** The org's answer to the welcome question (Core `setup/steps.ts` `SETUP_INTENTS`). */
export const SETUP_INTENTS = ['solo', 'team', 'company'] as const;
export type SetupIntent = (typeof SETUP_INTENTS)[number];

export const STEP_STATES = ['done', 'todo', 'skipped', 'dismissed', 'unknown'] as const;
export type StepState = (typeof STEP_STATES)[number];

export const STEP_AVAILABILITIES = ['live', 'assisted', 'coming_soon', 'disabled'] as const;
export type StepAvailability = (typeof STEP_AVAILABILITIES)[number];

/** The Core setup step keys, in checklist order. */
export const SETUP_STEP_KEYS = [
  'admin',
  'company',
  'github',
  'sso',
  'discover',
  'tools',
  'people',
  'policy',
  'ai_client',
  'automation',
  'first_tool',
] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

export function isSetupStepKey(value: string): value is SetupStepKey {
  return (SETUP_STEP_KEYS as readonly string[]).includes(value);
}

/** One row of Core's `steps`. `key` is a string: a key this build does not know is simply never read. */
export interface SetupStepRow {
  readonly key: string;
  readonly state: StepState;
  readonly availability: StepAvailability;
}

/** A Core signal reported as `done: boolean | null`: null is unknown, never done. */
export interface SetupSignal {
  readonly done: boolean | null;
}

export interface SetupState {
  readonly steps: readonly SetupStepRow[];
  readonly intent: SetupIntent | null;
  /** A non-house client holds a live grant for the org. */
  readonly app_authorized: SetupSignal;
  /** The own-agent fork's setup proposal was approved. */
  readonly setup_proposal_approved: SetupSignal;
  /** The own-agent fork's first held action was decided. */
  readonly held_action_decided: SetupSignal;
  readonly dismissed: boolean;
}
