import { resolveInitialStep, type SetupArrival } from './arrival.js';
import {
  firstRunComplete,
  firstUnfinished,
  inferFork,
  wizardSteps,
  type Fork,
  type WizardStepId,
} from './steps.js';
import type { SetupState, SetupStepKey } from './types.js';

const KEY_TO_SCREEN: Partial<Record<SetupStepKey, WizardStepId>> = {
  tools: 'connect',
  github: 'connect',
  policy: 'approve',
  first_tool: 'approve',
  people: 'invite',
  ai_client: 'try',
  discover: 'scan',
};

export type WizardStart = { view: 'wizard'; step: WizardStepId } | { view: 'all' };

/**
 * Where `/setup` opens. A `?step=` value (Core's step keys, plus the one alias `integrations` that
 * `resolveInitialStep` maps) opens the screen covering it. `admin` and an unknown value open the
 * first unfinished screen. A key with no screen here (company, sso, automation, or people when
 * Invite is not shown, or discover when Scan is not shown) opens All steps, where its row is open.
 * Once the first run is complete or the checklist is dismissed there is no first run left to walk,
 * so `/setup` opens All steps. Statuses are read under `fork`: the admin's pick, else the inferred one.
 */
export function resolveWizardStart(
  arrival: SetupArrival,
  state: SetupState,
  fork: Fork = inferFork(state)
): WizardStart {
  const steps = wizardSteps(state, fork);
  if (firstRunComplete(steps) || state.dismissed) return { view: 'all' };
  const key = resolveInitialStep(arrival);
  if (key === null || key === 'admin') return { view: 'wizard', step: firstUnfinished(steps) };
  const screen = KEY_TO_SCREEN[key];
  if (screen === undefined || !steps.some((s) => s.id === screen)) return { view: 'all' };
  return { view: 'wizard', step: screen };
}
