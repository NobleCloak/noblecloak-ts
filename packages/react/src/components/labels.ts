/**
 * Every word the `<Approvals/>` component renders, with its English default. A host overrides any of
 * them through the `labels` prop. A value may hold `{name}` placeholders; the component fills them in.
 * Not words, and so not here: the month/day/hour layout of a timestamp (`Intl`, en-US, in UTC), and the
 * values the service sends (tool references, ids, states, resolutions, reasons).
 */
export const DEFAULT_LABELS = {
  // Queue
  queueHeading: 'Approval requests',
  queueLoading: 'Loading requests…',
  queueTruncated: 'Only the first requests are shown. More are waiting.',
  queueRetry: 'Try again',
  connectionConnecting: 'Connecting. The list may be out of date.',
  connectionLive: 'Live. New requests appear as they arrive.',
  connectionPolling: 'Checking for new requests every few seconds.',
  connectionOffline: 'Offline. The list may be out of date.',
  rowLevel: 'Level: {level}',
  rowDigest: 'Digest {digest}',
  rowSending: 'Sending your decision…',
  rowRequester: 'From {name}',
  rowSelect: 'Select {tool}',
  rowDecidedBy: '{resolution} by {name}',
  rowDecidedNobody: '{resolution}',
  queueShowMore: 'Show more requests',
  tabPending: 'Waiting for you',
  tabRecent: 'Recently decided',
  recentHeading: 'Recently decided requests',
  recentLoading: 'Loading decided requests…',
  recentEmpty: 'Nothing has been decided yet.',
  recentRetry: 'Try again',
  recentShowMore: 'Show older',
  recentMore: 'Older requests are available.',
  rowNoBatchReadable: 'Has a call to read: open it to decide.',
  rowNoBatchWithheld: 'Open this request to decide it.',
  rowNoBatchUnknown: 'Open it to read it before approving.',
  batchApproveSelected: 'Approve selected ({count})',
  batchPrompt:
    'Approve {count} requests as listed, without opening them? Each is approved only if it is still the one you see here.',
  batchConfirm: 'Confirm approving {count}',
  batchCancel: 'Cancel',
  batchSending: 'Sending your decisions…',
  batchDone:
    '{approved} approved. {failed} were not approved and are still in your queue or have changed.',
  batchAllApproved: '{approved} approved.',
  batchFailed: 'None of the selected requests could be approved.',
  ageNow: 'just now',
  ageMinutes: '{count} min ago',
  ageHours: '{count} h ago',
  ageDays: '{count} d ago',

  // Queue count: rendered by Approvals in its live region, not by the queue
  queueEmpty: 'No requests are waiting for you.',
  countOne: '1 request is waiting for you.',
  countMany: '{count} requests are waiting for you.',

  // Side-effect levels and obligation kinds
  levelRead: 'read',
  levelWrite: 'write',
  levelDelete: 'delete',
  levelExternal: 'external',
  levelAdmin: 'admin',
  obligationToolInvocation: 'Tool call',
  obligationSpending: 'Spending',

  // Detail
  detailHeadingFallback: 'Request details',
  detailClose: 'Close',
  detailLoading: 'Loading the request…',
  detailRefreshing: 'Updating…',
  detailNotFound: 'This request is gone, or you can no longer see it.',
  detailUnavailable:
    'The service is temporarily unavailable. This request cannot be decided until it loads.',
  detailRetryCountdown: 'Trying again in {seconds} seconds.',
  detailRetryingNow: 'Trying again now…',
  detailRetryNow: 'Try again',
  detailForbidden: 'You do not have access to this request.',
  signInAgain: 'Sign in again',

  // Facts about the request
  factTool: 'Tool',
  factLevel: 'Side-effect level',
  factKind: 'Kind',
  factWaitingOn: 'Approvers who can decide',
  factRequester: 'Requested by',
  factAgent: 'Agent',
  factAgentParent: 'Parent: {parent}',
  factRun: 'Run',
  factRunKind: 'Run kind: {kind}',
  factScope: 'Scope',
  factPolicy: 'Policy',
  factPolicyVersion: 'Version {version}',
  factContinuation: 'Continuation',
  factCreated: 'Created',
  factExpires: 'Expires',
  factState: 'State',
  factOutcome: 'Outcome',
  factDecidedBy: 'Decided by',
  factDecidedAt: 'Decided at',

  // The call
  callFullHeading: 'The full call, as returned for this request',
  callDigestOnlyLoaded:
    'The arguments of this call are not shown to you. You are approving the call identified by this digest.',
  callDigestOnlyResolved:
    'The arguments of this call are not shown. The call is identified by this digest.',
  callNoArgumentsReturned:
    'No arguments were returned for this request. The call is identified by this digest.',
  callNotEnabled:
    'This tool is not set to show its calls to approvers, so only the digest identifies the call. You are approving the call identified by this digest.',
  callNotSent:
    'The request that opened this approval did not carry the call itself, so none is shown. You are approving the call identified by this digest.',
  callWithheld: 'The call itself is not shown to you. The call is identified by this digest.',
  callDigestLabel: 'Digest',
  callCopyDigest: 'Copy digest',
  callCopied: 'Digest copied.',
  callCopyFailed: 'The digest could not be copied. Select it and copy it by hand.',
  callShowAll: 'Show all',
  callMoreCharacters: '{count} more characters',
  jsonMoreItems: '[… {count} items]',
  jsonMoreMembers: '{… {count} members}',
  callNestedNotShown: '{count} nested parts are shown only as counts.',
  callInexactNumbers:
    '{count} numbers in this call cannot be shown exactly by this browser, so it cannot be approved or denied here.',
  callDuplicateKey:
    'This call names the key "{key}" more than once, so the text below may differ from what is sent. It cannot be approved or denied here.',
  callTooLarge: 'This call is too large to display, so it cannot be approved or denied here.',

  // Times
  timeUtc: '{time} UTC',

  // History
  requirementsHeading: 'Requirements',
  requirementsMet: '{met} of {total} met',
  requirementWho: 'Who may satisfy it: {approvers}',
  requirementAdmins: 'Administrators of the organisation',
  requirementRoleApprover: 'role {id}',
  requirementUserApprover: 'user {id}',
  requirementExcludesRequester: "The requester can't satisfy it.",
  requirementMet: 'Met',
  requirementPending: 'Pending',
  requirementNotMet: 'Not met',
  requirementNeeded: '{count} approvals needed',
  requirementMetBy: 'Met by {by}',
  requirementMetByBreakGlass: 'Met by {by} (administrator override)',
  historyHeading: 'History',
  historyEntry: '{resolution} by {by}',

  // Deciding
  reasonLabel: 'Reason (optional)',
  approve: 'Approve',
  deny: 'Deny',
  confirmApprove: 'Confirm approval',
  confirmCancel: 'Cancel',
  confirmPrompt: 'This request has the {level} level. Confirm that you want to approve it.',
  sending: 'Sending your decision…',
  resultApproved: 'Approved. The request has left your queue.',
  resultDenied: 'Denied. The request has left your queue.',

  // Errors
  errorRender: 'Something went wrong showing this. Try again.',
  requestId: 'Request ID: {requestId}',
  errorUnauthorized: 'Your session has expired.',
  errorForbidden: 'You do not have access to this request.',
  errorNotEligible:
    'You are not eligible to decide this request. If you were just given the role that allows it, this can take up to a minute to take effect.',
  errorNotFound: 'This request is gone, or you can no longer see it.',
  errorInvalidRequest: 'The service did not accept this request.',
  errorRateLimited: 'There have been too many requests. Wait a moment, then try again.',
  errorRateLimitedAfter: 'There have been too many requests. Try again in {seconds} seconds.',
  errorUnavailable: 'The service is temporarily unavailable. Trying again.',
  errorUnavailableAfter: 'The service is temporarily unavailable. Try again in {seconds} seconds.',
  errorEligibilityLookup:
    'The service could not check whether you may decide this request, so nothing is shown or decided. Try again in a moment.',
  errorEligibilityLookupAfter:
    'The service could not check whether you may decide this request, so nothing is shown or decided. Try again in {seconds} seconds.',
  errorUnavailableDecision: 'The service is temporarily unavailable. Try again in a moment.',
  errorNetwork: 'The network connection failed.',
  errorTokenUnavailable: 'Could not get a token for this request; it was not sent.',
  errorUnsupported: 'This service does not support that action.',
  errorMalformed: 'The service sent a reply this page could not read.',
  errorPrecondition: 'Open the request and wait for it to load before deciding.',
  errorConflict:
    'This request changed while you were looking at it. Open it again to see the latest.',
  digestChangedAcknowledge: 'I have read the changed request',
  errorMayBeDecided: 'The request may already have been decided: check the queue.',
  errorAlreadyResolved: 'This request has already been decided.',
  errorExpired: 'This request has expired.',
  errorInFlight: 'A decision for this request is already being sent.',
  errorCurrentState: 'Its state now: {state}.',

  // Action status (the creator's view of one request)
  statusLoading: 'Loading the status of this request…',
  statusUpdating: 'Updating…',
  statusStale: 'This status may be out of date.',
  statusNotFound: 'This request is gone, or you can no longer see it.',
  statusForbidden: 'You do not have access to this request.',
  statusUnavailable:
    'The service is temporarily unavailable. The status will load when it is back.',
  statusError: 'The status of this request could not be read.',
  statusRetry: 'Try again',
  statusFactState: 'Status',
  statusFactSince: 'Requested',
  statusFactWaitingOn: 'Waiting on',
  statusFactOnDeny: 'If it is denied',
  statusFactOutcome: 'Outcome',
  statePending: 'Waiting for a decision',
  stateApproved: 'Approved, not yet used',
  stateRejected: 'Denied',
  stateConsumed: 'Approved and used',
  stateExpired: 'Expired without a decision',
  stateWithdrawn: 'Withdrawn',
  stateOther: 'Unknown status: {state}',
  waitingOnCount: '{count} can decide',
  waitingOnNone: 'No one the service knows of can decide',
  waitingOnUnknown: 'Unknown: the service did not say who can decide',
  onDenyResume: 'The run carries on without this action',
  onDenyHalt: 'The run stops',
  onDenyNotStated: 'Not stated: the service did not say what a denial does',
  outcomeLoading: 'Loading the outcome…',
  outcomeSucceeded: 'Succeeded',
  outcomeFailed: 'Failed',
  outcomeUnknown: 'Reported as unknown',
  outcomeRecorded: '{result}, recorded {time}',
  outcomeUnavailable: 'Outcome not available: {reason}',
  outcomeReasonNoRecord: 'no outcome has been recorded',
  outcomeReasonForbidden: 'you cannot read the outcome record',
  outcomeReasonNoOutcome: 'the record states no outcome',
  outcomeReasonNotFound: 'the outcome record was not found',
  outcomeReasonUnauthorized: 'your session has expired',
  outcomeReasonUnavailable: 'the outcome record could not be read',
  outcomeReasonMalformed: 'the outcome record is not one this version can read',
} as const;

/** The key of every string the component renders. */
export type ApprovalsLabelKey = keyof typeof DEFAULT_LABELS;

/** What a host passes as `labels`: any of the component's strings, each replaced by its own text. */
export type ApprovalsLabels = Partial<Readonly<Record<ApprovalsLabelKey, string>>>;

export type Translate = (
  key: ApprovalsLabelKey,
  values?: Readonly<Record<string, string | number>>
) => string;

/** Builds the lookup the component uses: the host's label when given, the default otherwise. */
export function createTranslate(labels: ApprovalsLabels | undefined): Translate {
  return (key, values) => {
    const template: string = labels?.[key] ?? DEFAULT_LABELS[key];
    if (values === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = values[name];
      return value === undefined ? whole : String(value);
    });
  };
}
