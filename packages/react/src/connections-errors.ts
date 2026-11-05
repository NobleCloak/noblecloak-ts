/**
 * Mapping a failure to a `ConnectionsError`. The approvals module's mapping decides the kind (from the problem code
 * when the contract documents it, else from the status; never from prose), and this module adds what the connection
 * routes need: a 409 `connection_exists` carries the `connection_id` of the existing registration when the service
 * named it, and every problem keeps its `detail` verbatim, since a 400 names the refused member there.
 */
import { errorFromResponse, networkError, sessionError } from './approvals-errors.js';
import type { ExecErrors } from './approvals-exec.js';
import type { ApprovalsError } from './approvals-types.js';
import type { ConnectionsError, ConnectionsPreconditionCode } from './connections-types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The same failure as a `ConnectionsError`. Every member but the approvals-only ones (`current` on a conflict) is kept;
 * an approvals `precondition` cannot come from a response, and is read as a malformed answer if it ever does.
 */
function fromApprovals(error: ApprovalsError): ConnectionsError {
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

/** Maps an error response of a connection route. `body` is the parsed problem document, or the body as text. */
export function connectionsErrorFromResponse(
  status: number,
  body: unknown,
  retryAfter: string | null = null,
  now: number = Date.now()
): ConnectionsError {
  const mapped = fromApprovals(errorFromResponse(status, body, retryAfter, now));
  const problem = isRecord(body) ? body : undefined;
  const detail = typeof problem?.detail === 'string' ? { detail: problem.detail } : {};
  const member = typeof problem?.member === 'string' ? { member: problem.member } : {};
  if (mapped.kind === 'conflict' && mapped.code === 'connection_exists') {
    const existing = problem?.connection_id;
    return {
      ...mapped,
      ...detail,
      ...member,
      ...(typeof existing === 'string' && existing !== '' ? { connectionId: existing } : {}),
    };
  }
  return { ...mapped, ...detail, ...member };
}

/** The request layer's error mapping for the connections store. */
export const CONNECTIONS_EXEC_ERRORS: ExecErrors<ConnectionsError> = {
  fromResponse: (status, body, retryAfter) =>
    connectionsErrorFromResponse(status, body, retryAfter),
  network: (code, cause) => fromApprovals(networkError(code, cause)),
  session: () => fromApprovals(sessionError()),
};

const PRECONDITION_TITLES: Readonly<Record<ConnectionsPreconditionCode, string>> = {
  read_only: 'Only an administrator of the organisation does this.',
  owner_kind_not_offered: 'The service does not register connections of this owner kind.',
  oauth_not_offered: 'The OAuth round trip is not offered here.',
  links_not_offered: 'Per-user links are not offered here.',
  nothing_to_link: 'This registration takes no link.',
  consent_required: 'A link is sent only with consent.',
  not_loaded: 'The registration is not loaded.',
  write_in_flight: 'A change to this registration is already being sent.',
  cannot_navigate: 'There is no page to leave for the authorization and come back to.',
  facts_not_offered: 'Fact bindings are not offered here.',
};

/** A refusal the store gives without a request. The title is for a log; a component shows its own words. */
export function precondition(code: ConnectionsPreconditionCode): ConnectionsError {
  return { kind: 'precondition', code, title: PRECONDITION_TITLES[code], local: true };
}

/** A malformed 200 body. */
export function malformedBody(status: number, what: string): ConnectionsError {
  return {
    kind: 'malformed_response',
    code: 'invalid_body',
    title: `The service sent ${what} this client cannot read.`,
    status,
  };
}

/** A bug in this module stopped an operation. */
export function internalFault(cause: unknown): ConnectionsError {
  return {
    kind: 'malformed_response',
    code: 'internal_error',
    title: 'An internal error stopped this operation.',
    local: true,
    cause,
  };
}
