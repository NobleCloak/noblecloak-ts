/**
 * The `approvals` module entry: `useApprovals` (the hook over the headless store), `createApprovalsStore`,
 * the `Approvals` component, `useApprovalRequest` and `ApprovalRequest` (one request on its own), the
 * module's types and `MODULE_ID`.
 */
export const MODULE_ID = 'approvals';

export type {
  Approval,
  ApprovalDetailState,
  ApprovalDetailStatus,
  ApprovalRequestController,
  ApprovalSummary,
  ApprovalsConnection,
  ApprovalsController,
  ApprovalsError,
  ApprovalsErrorKind,
  ApprovalsSnapshot,
  ApprovalsStatus,
  ApprovalsStore,
  ArgumentsState,
  ConflictCode,
  JsonObject,
  ManyItemResult,
  ManyResult,
  RecentState,
  ResolveOptions,
  ResolveResult,
  UseApprovalRequestOptions,
  UseApprovalsOptions,
} from './approvals-types.js';

export { createApprovalsStore } from './approvals-store.js';
export { useApprovals } from './use-approvals.js';
export { useApprovalRequest } from './use-approval-request.js';
export { Approvals } from './components/Approvals.js';
export type { ApprovalsProps } from './components/Approvals.js';
export { ApprovalRequest } from './components/ApprovalRequest.js';
export type { ApprovalRequestProps } from './components/ApprovalRequest.js';
export type { ApprovalsLabelKey, ApprovalsLabels } from './components/labels.js';
export type { ModuleComponents as ApprovalsComponents } from './components/slots.js';
