import {
  firstRunComplete,
  firstUnfinished,
  WIZARD_STEPS,
  wizardSteps,
  type Fork,
  type WizardEventStepKey,
} from './steps.js';
import type { SetupState } from './types.js';

export interface SetupProgress {
  /** n: screens finished, `done` or `skipped` (the ones `firstUnfinished` passes over). Not the wizard's position. */
  finished: number;
  /** N: screens shown for this state, Proof included (Scan only when live, Invite only for `team`). */
  total: number;
  /** The `step_key` of the screen setup opens at. */
  stepKey: WizardEventStepKey;
  /** True when the checklist was dismissed or the first run is complete: show no pill. */
  hidden: boolean;
}

/**
 * What a "Setup n/N" pill shows. n is the count of finished screens, so a fresh org reads "Setup 0/4"
 * while the wizard shows "Step 1 of 4". `fork` defaults to the inferred one, as in `wizardSteps`.
 */
export function setupProgress(state: SetupState, fork?: Fork): SetupProgress {
  const steps = wizardSteps(state, fork);
  return {
    finished: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    total: steps.length,
    stepKey: WIZARD_STEPS[firstUnfinished(steps)].eventKey,
    hidden: state.dismissed || firstRunComplete(steps),
  };
}
