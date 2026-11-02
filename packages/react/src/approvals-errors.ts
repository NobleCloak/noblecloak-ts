/**
 * Mapping a failure to an `ApprovalsError`. The kind comes from the problem code when the code is one the
 * contract documents and from the HTTP status otherwise, never from prose. API problems are returned,
 * never thrown. Nothing here reads a response body beyond the problem document's own members.
 */
import type {
  ApprovalSummary,
  ApprovalsError,
  ApprovalsErrorKind,
  ConflictCode,
} from './approvals-types.js';

/**
 * The problem codes of the contract's `info.x-noblecloak-problem-types`, each with the kind this module
 * gives it. A test holds this list equal to the contract's. A code that is not here maps by status.
 */
export const PROBLEM_KINDS: Readonly<Record<string, ApprovalsErrorKind>> = {
  unauthorized: 'unauthorized',
  invalid_token: 'unauthorized',
  wrong_audience: 'unauthorized',
  dpop_unsupported: 'unauthorized',
  header_identity_rejected: 'unauthorized',
  forbidden: 'forbidden',
  organization_context_required: 'forbidden',
  insufficient_scope: 'forbidden',
  entitlement_required: 'forbidden',
  not_eligible: 'forbidden',
  not_owner: 'forbidden',
  not_found: 'not_found',
  not_available_on_deployment: 'not_found',
  invalid_request: 'invalid_request',
  identity_not_accepted: 'invalid_request',
  attestation_not_accepted: 'invalid_request',
  callback_unroutable: 'invalid_request',
  invalid_continuation: 'invalid_request',
  already_resolved: 'conflict',
  approval_conflict: 'conflict',
  already_resumed: 'conflict',
  obligation_consumed: 'conflict',
  obligation_expired: 'conflict',
  obligation_withdrawn: 'conflict',
  continuation_expired: 'conflict',
  continuation_conflict: 'conflict',
  governed_run_not_creatable: 'invalid_request',
  idempotency_key_reuse: 'invalid_request',
  continuation_unsupported: 'invalid_request',
  rate_limited: 'rate_limited',
  payload_too_large: 'invalid_request',
  batch_too_large: 'invalid_request',
  reserved_tool_ref: 'invalid_request',
  system_tool_ref: 'invalid_request',
  tool_ref_in_use: 'invalid_request',
  approval_unroutable: 'invalid_request',
  side_effect_level_downgrade: 'conflict',
  // Contract rev 10: the policy routes' refusals and the rejected-duplicate rule's 409.
  unsupported_policy_form: 'invalid_request',
  policy_conflict: 'conflict',
  rejected_duplicate: 'conflict',
  // Contract rev 11: a second registration of the same tool server.
  connection_exists: 'conflict',
  // Contract rev 13: a service principal already bound to another agent. No module calls the binding route yet;
  // the code is here so the table stays the contract's registry.
  principal_bound: 'conflict',
  // Contract rev 14: a refused policy-set proposal, and a policy aimed at a deployment-applied reference. Both are
  // 422s; no module opens a proposal or authors a policy yet, so the codes are here to keep the table the registry.
  proposal_refused: 'invalid_request',
  policy_immutable: 'invalid_request',
  internal_error: 'unavailable',
  service_unavailable: 'unavailable',
};

/** The kind a status alone gives, for an error whose code is unknown or absent. */
export function kindOfStatus(status: number): ApprovalsErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'invalid_request';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The last path segment of a problem `type` URI: the problem code. */
export function codeOfType(type: string): string {
  const path = type.split(/[?#]/, 1)[0] ?? '';
  const segment = path
    .split('/')
    .filter((part) => part !== '')
    .pop();
  return segment ?? '';
}

/** `Retry-After` as milliseconds: whole seconds or an HTTP date; `undefined` when absent or unreadable. */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The `reason` tokens the module acts on (rev 6): a 503 whose cause is a failed eligibility lookup. */
export const REASON_ELIGIBILITY_LOOKUP = 'eligibility_lookup';

const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The wait a problem body gives as `retry_after_seconds` (rev 6): a browser reads the body of a cross-origin
 * response and not, unless the server lists it, its `Retry-After` header. A value that is not a non-negative
 * whole number is not a wait. The header wins when both are readable.
 */
export function retryAfterBodyMs(problem: Record<string, unknown> | undefined): number | undefined {
  const seconds = problem?.retry_after_seconds;
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 0
    ? seconds * 1000
    : undefined;
}

interface Extras {
  readonly status?: number;
  readonly requestId?: string;
  readonly type?: string;
  readonly retryAfterMs?: number;
  readonly reason?: string;
  readonly local?: true;
  readonly cause?: unknown;
  readonly current?: ApprovalSummary;
}

/** Builds an error of `kind`, leaving out every member that is `undefined`. */
export function makeError(
  kind: ApprovalsErrorKind,
  code: string,
  title: string,
  extras: Extras = {}
): ApprovalsError {
  const out: Record<string, unknown> = { kind, code, title };
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as ApprovalsError;
}

/**
 * Maps an error response. `body` is the parsed problem document, or whatever the body was when it was
 * not JSON (a string). A 401, 429 or 5xx whose body is not a problem document keeps its status kind,
 * since each drives behaviour; otherwise a documented problem code decides the kind. Any other status
 * whose body is not a problem document is a `malformed_response`.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  retryAfter: string | null = null,
  now: number = Date.now()
): ApprovalsError {
  const problem = isRecord(body) ? body : undefined;
  const type = typeof problem?.type === 'string' ? problem.type : undefined;
  const requestId = typeof problem?.request_id === 'string' ? problem.request_id : undefined;
  const title =
    typeof problem?.title === 'string' && problem.title !== ''
      ? problem.title
      : `The service answered ${String(status)}.`;
  const wait = retryAfterMs(retryAfter, now) ?? retryAfterBodyMs(problem);
  // Only a well-formed token is kept, and only on a 503: it is a code, never prose shown to a person.
  const reason =
    status === 503 && typeof problem?.reason === 'string' && REASON_PATTERN.test(problem.reason)
      ? problem.reason
      : undefined;
  const extras: Extras = {
    status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(type === undefined ? {} : { type }),
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
    ...(reason === undefined ? {} : { reason }),
  };
  const statusKind = kindOfStatus(status);
  const driving = statusKind === 'unauthorized' || statusKind === 'rate_limited' || status >= 500;
  if (problem === undefined && !driving) {
    return makeError('malformed_response', 'not_a_problem_document', title, extras);
  }
  const code = type === undefined ? '' : codeOfType(type);
  const known = PROBLEM_KINDS[code];
  const kind = known ?? statusKind;
  return makeError(kind, code === '' ? kind : code, title, extras);
}

/** A response arrived with status 200 but its body is not the contract's shape. */
export function malformed(status: number, what: string): ApprovalsError {
  return makeError(
    'malformed_response',
    'invalid_body',
    `The service sent ${what} this client cannot read.`,
    {
      status,
    }
  );
}

/**
 * The request never produced a response. `code` is `network` for a failed fetch and `client_error` for
 * any other exception (a bug in the caller's fetch or in this module, not an outage); `cause` keeps it.
 */
export function networkError(
  code: 'network' | 'client_error' | 'token_unavailable' = 'network',
  cause?: unknown
): ApprovalsError {
  return makeError(
    'network',
    code,
    code === 'token_unavailable'
      ? 'A token could not be obtained.'
      : code === 'client_error'
        ? 'The request failed before it reached the service.'
        : 'The service could not be reached.',
    { local: true, cause }
  );
}

/**
 * A bug in this module stopped an operation: reported with the cause, and shown as a reply that could not be
 * handled, not as an outage and not as a request that may have been decided.
 */
export function internalError(cause: unknown): ApprovalsError {
  return makeError(
    'malformed_response',
    'internal_error',
    'An internal error stopped this operation.',
    { local: true, cause }
  );
}

/** No usable token: the session is over. */
export function sessionError(): ApprovalsError {
  return makeError('unauthorized', 'session_expired', 'Your session has expired.', { local: true });
}

/** An answer the store gives without a request. */
export function localConflict(code: ConflictCode): ApprovalsError {
  return makeError(
    'conflict',
    code,
    code === 'resolve_in_flight'
      ? 'A decision for this request is already being sent.'
      : 'This request has already been decided.',
    { local: true }
  );
}

export function detailNotRead(): ApprovalsError {
  return makeError(
    'precondition',
    'detail_not_read',
    'Open the request and read it before deciding.',
    {
      local: true,
    }
  );
}

/** The same failure as an `unavailable` error, for a detail state whose type admits no other kind. */
export function asUnavailable(
  error: ApprovalsError
): Extract<ApprovalsError, { kind: 'unavailable' }> {
  if (error.kind === 'unavailable') return error;
  return makeError('unavailable', error.code, error.title, {
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.type === undefined ? {} : { type: error.type }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.reason === undefined ? {} : { reason: error.reason }),
    ...(error.local === undefined ? {} : { local: error.local }),
  }) as Extract<ApprovalsError, { kind: 'unavailable' }>;
}

/** Whether a failure is one to retry on a timer: a server error, a rate limit or no response at all. */
export function isRetryable(error: ApprovalsError): boolean {
  return error.kind === 'unavailable' || error.kind === 'rate_limited' || error.kind === 'network';
}
