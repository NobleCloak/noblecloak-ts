/**
 * The `action-status` module entry: `useActionStatus` (the hook over the headless store), the `ActionStatus`
 * component, the module's types and `MODULE_ID`. It shows an approval to the principal that created it: its
 * state, who it waits on, since when, what a denial does and, once it is used, its outcome.
 */
export const MODULE_ID = 'action-status';

export type {
  ActionOutcome,
  ActionOutcomeResult,
  ActionState,
  ActionStatusController,
  ActionStatusFailure,
  ActionStatusState,
  OnDeny,
  OutcomeUnavailableReason,
  PendingOn,
  UseActionStatusOptions,
} from './action-status-types.js';

export { useActionStatus } from './use-action-status.js';
export { ActionStatus } from './components/ActionStatus.js';
export type {
  ActionStatusProps,
  ActionStatusWithIdProps,
  ActionStatusWithStatusProps,
} from './components/ActionStatus.js';
export type {
  ApprovalsLabelKey as ActionStatusLabelKey,
  ApprovalsLabels as ActionStatusLabels,
} from './components/labels.js';
export type { ModuleComponents as ActionStatusComponents } from './components/slots.js';
