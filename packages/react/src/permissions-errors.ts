/**
 * Mapping a failure to a `PermissionsError`. The approvals module's mapping decides the kind (from the problem code
 * when the contract documents it, else from the status; never from prose), and this module adds what the policy
 * routes need: a 422 `unsupported_policy_form` is `unprocessable`, a 409 `policy_conflict` carries its `policy_id`, and
 * every problem keeps its `detail` verbatim, since a 400 or a 422 names the refused member there.
 */
import { errorFromResponse, networkError, sessionError } from './approvals-errors.js';
import type { ExecErrors } from './approvals-exec.js';
import type { ApprovalsError } from './approvals-types.js';
import type { PermissionsError, PermissionsPreconditionCode } from './permissions-types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The same failure as a `PermissionsError`. Every member but the approvals-only ones (`current` on a conflict) is kept;
 * an approvals `precondition` cannot come from a response, and is read as a malformed answer if it ever does.
 */
function fromApprovals(error: ApprovalsError): PermissionsError {
  const base = {
    title: error.title,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.type === undefined ? {} : { type: error.type }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.reason === undefined ? {} : { reason: error.reason }),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  };
  const local = error.local === true ? { local: true as const } : {};
  if (error.kind === 'precondition')
    return { ...base, kind: 'malformed_response', code: error.code, ...local };
  return { ...base, kind: error.kind, code: error.code, ...local };
}

/** Maps an error response of a policy route. `body` is the parsed problem document, or the body as text. */
export function permissionsErrorFromResponse(
  status: number,
  body: unknown,
  retryAfter: string | null = null,
  now: number = Date.now()
): PermissionsError {
  const mapped = fromApprovals(errorFromResponse(status, body, retryAfter, now));
  const problem = isRecord(body) ? body : undefined;
  const detail = typeof problem?.detail === 'string' ? { detail: problem.detail } : {};
  const member = typeof problem?.member === 'string' ? { member: problem.member } : {};
  if (mapped.code === 'unsupported_policy_form')
    return { ...mapped, ...detail, ...member, kind: 'unprocessable', code: mapped.code };
  if (mapped.kind === 'conflict' && mapped.code === 'policy_conflict') {
    const policyId = problem?.policy_id;
    return {
      ...mapped,
      ...detail,
      ...member,
      ...(typeof policyId === 'string' && policyId !== '' ? { policyId } : {}),
    };
  }
  return { ...mapped, ...detail, ...member };
}

/** The request layer's error mapping for the permissions stores. */
export const PERMISSIONS_EXEC_ERRORS: ExecErrors<PermissionsError> = {
  fromResponse: (status, body, retryAfter) =>
    permissionsErrorFromResponse(status, body, retryAfter),
  network: (code, cause) => fromApprovals(networkError(code, cause)),
  session: () => fromApprovals(sessionError()),
};

const PRECONDITION_TITLES: Readonly<Record<PermissionsPreconditionCode, string>> = {
  read_only: 'Policies cannot be authored here.',
  publish_not_offered: 'Publishing is not offered here.',
  retire_not_offered: 'Retiring a policy is not offered here.',
  draft_changed: 'This draft changed since it was loaded.',
  no_pending_draft: 'This policy has no draft to publish.',
  unsaved_changes: 'Save the draft before publishing it.',
  pair_conflict: 'More than one published policy governs this pair.',
  kind_not_editable: 'Only tool invocation policies are edited here.',
  targets_not_stated: 'The service did not say which tools this policy governs.',
  runs_not_offered: 'A run cannot be named here.',
  not_loaded: 'The policy is not loaded yet.',
  write_in_flight: 'A change to this policy is already being sent.',
  tool_not_callable:
    'The tool is not callable (withdrawn, or of an unknown status); its cells are read-only.',
  rules_invalid: 'The rules or approvers hold something the service would refuse.',
  approval_routing_not_offered: 'The break-glass setting is not offered here.',
};

/** A refusal the store gives without a request. The title is for a log; a component shows its own words. */
export function precondition(code: PermissionsPreconditionCode): PermissionsError {
  return { kind: 'precondition', code, title: PRECONDITION_TITLES[code], local: true };
}

/** A malformed 200 body. */
export function malformedBody(status: number, what: string): PermissionsError {
  return {
    kind: 'malformed_response',
    code: 'invalid_body',
    title: `The service sent ${what} this client cannot read.`,
    status,
  };
}

/** A bug in this module stopped an operation. */
export function internalFault(cause: unknown): PermissionsError {
  return {
    kind: 'malformed_response',
    code: 'internal_error',
    title: 'An internal error stopped this operation.',
    local: true,
    cause,
  };
}

/** Whether a write's failure was the service refusing the caller (a 403): the store then stops offering writes. */
export function isWriteForbidden(error: PermissionsError): boolean {
  return error.kind === 'forbidden' && error.local !== true;
}
