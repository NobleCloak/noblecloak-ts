import {
  SETUP_STEP_KEYS,
  type SetupState,
  type SetupStepRow,
  type StepAvailability,
} from './types.js';

/** Core's availability per step key on a fresh org: `discover` is coming soon, `sso` is assisted. */
const AVAILABILITY: Partial<Record<(typeof SETUP_STEP_KEYS)[number], StepAvailability>> = {
  discover: 'coming_soon',
  sso: 'assisted',
};

/** Every Core step, `todo` and at its usual availability, with `over` replacing the named keys. */
export function steps(
  over: Partial<Record<string, Partial<Pick<SetupStepRow, 'state' | 'availability'>>>> = {}
): SetupStepRow[] {
  return SETUP_STEP_KEYS.map((key) => ({
    key,
    state: 'todo',
    availability: AVAILABILITY[key] ?? 'live',
    ...over[key],
  }));
}

/** A fresh team org: every step todo, no signal answered true. */
export function setupState(over: Partial<SetupState> = {}): SetupState {
  return {
    steps: steps(),
    intent: 'team',
    app_authorized: { done: false },
    setup_proposal_approved: { done: false },
    held_action_decided: { done: false },
    dismissed: false,
    ...over,
  };
}

/** An org whose only tool is GitHub: Core derives `tools` todo and `github` done. */
export function githubOnlyState(over: Partial<SetupState> = {}): SetupState {
  return setupState({ steps: steps({ github: { state: 'done' } }), ...over });
}

/** Apps fork, every required screen (and Invite) done. */
export function allDone(over: Partial<SetupState> = {}): SetupState {
  return setupState({
    steps: steps({
      tools: { state: 'done' },
      policy: { state: 'done' },
      ai_client: { state: 'done' },
      people: { state: 'done' },
    }),
    app_authorized: { done: true },
    ...over,
  });
}
