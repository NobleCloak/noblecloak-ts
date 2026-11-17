/**
 * The setup wizard's step rule: which screens show for an org, each screen's status, the fork that
 * decides what completes Connect, Approve and Try it, and when the first run is complete. Pure: no
 * I/O, no React, no clock.
 *
 * Every status is derived from the setup state (see `types.ts`); nothing here stores anything.
 * Step 3 forks: `apps` (people using Claude, Cursor or another MCP app) and `own_agent` (something the
 * admin builds). The fork decides which Core signal completes Connect, Approve and Try it; Scan and
 * Invite do not depend on it. Core does not store the fork, so a caller holds the admin's pick and
 * `inferFork` guesses it from Core's own-agent outcomes when there is none.
 *
 * Only the structural fields of a screen live here (`id`, `keys`, `eventKey`, `required`, `skipKey`).
 * Screen copy (title, why, what to do) belongs to the app: see "Attaching copy" in the README.
 */

import {
  type SetupIntent,
  type SetupSignal,
  type SetupState,
  type SetupStepKey,
  type SetupStepRow,
  type StepAvailability,
} from './types.js';

/**
 * The `step_key` values a wizard sends with its events, in screen order except `scan`. `tools`,
 * `policy`, `people` and `ai_client` are Core step keys, so a funnel can join a view to that step's
 * `first_done_at`; `proof` is the last screen and has no Core step. The first entry is the entry
 * step until Scan is shown: when Core reports the `discover` step live and it is unfinished, Scan is
 * the first screen, so `scan` is also an entry key, and a consumer that decides "has the visitor
 * started the wizard" must accept it as well as the first entry. `scan` is last, out of screen
 * order, so that `tools` stays first: it is not a Core step key (Core's is `discover`).
 */
export const WIZARD_EVENT_STEP_KEYS = Object.freeze([
  'tools',
  'policy',
  'people',
  'ai_client',
  'proof',
  'scan',
] as const);
export type WizardEventStepKey = (typeof WIZARD_EVENT_STEP_KEYS)[number];

/** The screens in order, Scan first. Which of them show depends on the state: see `wizardStepIds`. */
export const WIZARD_STEP_IDS = Object.freeze([
  'scan',
  'connect',
  'approve',
  'invite',
  'try',
  'proof',
] as const);
export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

export interface WizardStepDef {
  readonly id: WizardStepId;
  /** The Core step keys this screen covers; the first is the one its status and availability are read from. */
  readonly keys: readonly SetupStepKey[];
  /**
   * The `step_key` sent with this screen's events: the Core step key the screen is judged by, or
   * `proof` / `scan`, which have no Core step of that name.
   */
  readonly eventKey: WizardEventStepKey;
  /** An optional screen may be skipped; a required one gates first-run completion. */
  readonly required: boolean;
  /** The Core step its Skip writes, or null for a screen that has no Skip. */
  readonly skipKey: SetupStepKey | null;
}

const STEP_DEFS: Record<WizardStepId, WizardStepDef> = {
  scan: { id: 'scan', keys: ['discover'], eventKey: 'scan', required: false, skipKey: 'discover' },
  connect: {
    id: 'connect',
    keys: ['tools', 'github'],
    eventKey: 'tools',
    required: true,
    skipKey: null,
  },
  approve: {
    id: 'approve',
    keys: ['policy', 'first_tool'],
    eventKey: 'policy',
    required: true,
    skipKey: null,
  },
  invite: {
    id: 'invite',
    keys: ['people'],
    eventKey: 'people',
    required: false,
    skipKey: 'people',
  },
  try: { id: 'try', keys: ['ai_client'], eventKey: 'ai_client', required: true, skipKey: null },
  proof: { id: 'proof', keys: [], eventKey: 'proof', required: false, skipKey: null },
};

/** The structural definition of each screen. Frozen, deeply: a consumer cannot change the shared rule. */
export const WIZARD_STEPS: Readonly<Record<WizardStepId, Readonly<WizardStepDef>>> = Object.freeze(
  Object.fromEntries(
    Object.entries(STEP_DEFS).map(([id, def]) => [
      id,
      Object.freeze({ ...def, keys: Object.freeze([...def.keys]) }),
    ])
  ) as Record<WizardStepId, WizardStepDef>
);

export type WizardStatus = 'done' | 'todo' | 'skipped' | 'unknown';

export const FORKS = ['apps', 'own_agent'] as const;
export type Fork = (typeof FORKS)[number];

export interface WizardStep extends WizardStepDef {
  /** The fork whose completion rules `status` was derived under. */
  fork: Fork;
  status: WizardStatus;
  /** The availability of the Core step this screen is read from; `live` when it reads none. */
  availability: StepAvailability;
}

function stepOf(state: SetupState, key: SetupStepKey): SetupStepRow | undefined {
  return state.steps.find((s) => s.key === key);
}

/** `done` / `skipped` / `unknown` as Core reports them; anything else (todo, dismissed, absent) is `todo`. */
function plainStatus(step: SetupStepRow | undefined): WizardStatus {
  if (!step) return 'unknown';
  return step.state === 'done' || step.state === 'skipped' || step.state === 'unknown'
    ? step.state
    : 'todo';
}

/** A signal Core reports as `done: boolean | null`: null is unknown, never done. */
function signalStatus(signal: SetupSignal): 'done' | 'todo' | 'unknown' {
  return signal.done === null ? 'unknown' : signal.done ? 'done' : 'todo';
}

/**
 * Whether a tool is connected, as Core's `tools` and `github` steps say it. Core's `tools` step
 * excludes GitHub (GitHub has its own step), so an org whose only tool is GitHub has `tools` todo and
 * `github` done: a tool is connected when either is done. When neither is done and either could not be
 * answered it is `unknown`, never `todo`. A skipped step counts as todo, since Connect cannot be skipped.
 */
export function toolsConnected(state: SetupState): 'done' | 'todo' | 'unknown' {
  const a = plainStatus(stepOf(state, 'tools'));
  const b = plainStatus(stepOf(state, 'github'));
  if (a === 'done' || b === 'done') return 'done';
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return 'todo';
}

/**
 * Whether the org has an active service principal, as Core's `automation` step says it. A skipped
 * step counts as todo, since Connect cannot be skipped.
 */
export function agentCredentials(state: SetupState): 'done' | 'todo' | 'unknown' {
  const s = plainStatus(stepOf(state, 'automation'));
  return s === 'skipped' ? 'todo' : s;
}

/**
 * Whether Scan shows: only when Core reports the `discover` step `live`. `coming_soon`, `assisted`,
 * `disabled` and an absent step all hide it.
 */
export function scanShown(state: SetupState): boolean {
  return stepOf(state, 'discover')?.availability === 'live';
}

/**
 * The screens for this intent, in order. `team` adds Invite; an unknown (null) intent reads as the
 * base steps. Scan is included only when `scan` is true (`scanShown`), and comes before Connect.
 */
export function wizardStepIds(intent: SetupIntent | null, scan = false): WizardStepId[] {
  return WIZARD_STEP_IDS.filter(
    (id) => (id !== 'invite' || intent === 'team') && (id !== 'scan' || scan)
  );
}

function statusOf(id: WizardStepId, state: SetupState, fork: Fork): WizardStatus {
  switch (id) {
    case 'scan':
      return plainStatus(stepOf(state, 'discover'));
    case 'connect': {
      // A tool is connected, and the fork's own half: an app holds a grant for the org (apps), or an
      // active service principal exists (own agent).
      const tools = toolsConnected(state);
      if (tools !== 'done') return tools;
      return fork === 'own_agent' ? agentCredentials(state) : signalStatus(state.app_authorized);
    }
    case 'approve': {
      if (fork === 'own_agent') return signalStatus(state.setup_proposal_approved);
      const s = plainStatus(stepOf(state, 'policy'));
      return s === 'skipped' ? 'todo' : s;
    }
    case 'invite':
      return plainStatus(stepOf(state, 'people'));
    case 'try': {
      if (fork === 'own_agent') return signalStatus(state.held_action_decided);
      const s = plainStatus(stepOf(state, 'ai_client'));
      return s === 'skipped' ? 'todo' : s;
    }
    case 'proof':
      return 'todo';
  }
}

/**
 * The fork to judge by when the admin has not picked one. Core does not store the fork, so this is a
 * guess from durable outcomes that only an own-agent run produces: an approved setup proposal or a
 * decided held action. Anything else reads as `apps`.
 *
 * Not used as evidence: an active service principal (an apps-fork org can hold one, for CI) and an
 * open setup proposal (a server-registration proposer opens one on the apps fork too). Those can
 * appear or disappear (a principal expires) without the org changing fork, so reading them would flip
 * a finished run back to incomplete.
 *
 * Invariant: an org whose first run is complete under one fork never reads incomplete because of the
 * guess. If the evidence says `own_agent` but only the apps reading is complete, the answer is `apps`.
 * The admin's own pick, when there is one, wins over all of this: pass it as `fork` to `wizardSteps`.
 */
export function inferFork(state: SetupState): Fork {
  const ownAgentOutcome =
    state.setup_proposal_approved.done === true || state.held_action_decided.done === true;
  if (!ownAgentOutcome) return 'apps';
  const appsComplete = firstRunComplete(wizardSteps(state, 'apps'));
  const ownComplete = firstRunComplete(wizardSteps(state, 'own_agent'));
  return appsComplete && !ownComplete ? 'apps' : 'own_agent';
}

/**
 * The wizard's screens with statuses read under `fork` (default: the one `inferFork` guesses from
 * Core's signals). Structural fields only: the fork never changes a screen's `eventKey`, `keys`,
 * `skipKey` or `required`, so events and the step count do not change with it.
 */
export function wizardSteps(state: SetupState, fork: Fork = inferFork(state)): WizardStep[] {
  return wizardStepIds(state.intent, scanShown(state)).map((id) => {
    const def = WIZARD_STEPS[id];
    const firstKey = def.keys.at(0);
    const source = firstKey === undefined ? undefined : stepOf(state, firstKey);
    return {
      ...def,
      fork,
      status: statusOf(id, state, fork),
      availability: source?.availability ?? 'live',
    };
  });
}

/** The first screen not done or skipped, or `proof` (the last) when every earlier screen is. */
export function firstUnfinished(steps: readonly WizardStep[]): WizardStepId {
  const hit = steps.find((s) => s.id !== 'proof' && s.status !== 'done' && s.status !== 'skipped');
  return hit?.id ?? 'proof';
}

/** First run is complete when every required screen is done. An unknown status is never done. */
export function firstRunComplete(steps: readonly WizardStep[]): boolean {
  return steps.filter((s) => s.required).every((s) => s.status === 'done');
}
