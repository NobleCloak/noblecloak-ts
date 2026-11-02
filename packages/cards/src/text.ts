/**
 * Every fixed string a card shows. There is no generated text: a card is these strings with values from the
 * read (a name, an id, a time, a note the approver wrote) put in where a `{marker}` stands or after a separator. Changing a string here changes what a
 * card shows, so it bumps `CARD_MODEL_VERSION`.
 */
export const CARD_TEXT = {
  title: 'Approval request',
  approve: 'Approve',
  deny: 'Deny',
  noteLabel: 'Note (optional)',
  openInApprovals: 'Open in Approvals',
  viewFullCall: 'View the full call in Approvals',
  callUnreadable: 'The call could not be read. View the full call in Approvals.',
  callShortened: 'Shortened. View the full call in Approvals.',
  callBlocked: 'The call is not shown in chat.',
  callNotOnRead: 'The call was not sent with this request.',
  callFinal: 'The request is not waiting for a decision, so the call is not shown.',
  headlineAgent: '{agent} (for {requester}) is asking to call `{tool}`',
  headlineAgentAlone: '{agent} is asking to call `{tool}`',
  headlineRequester: '{requester} is asking to call `{tool}`',
  headlineTool: 'A request to call `{tool}`',
  headlineUnknown: 'An approval request',
  statusPending: 'Waiting for a decision',
  statusSelf: "You're approving your own agent's request",
  statusYouApproved: 'You approved',
  statusYouDenied: 'You denied',
  statusYouSeparator: ' · ',
  statusHandledApproved: 'Handled by {approver} · Approved',
  statusHandledDenied: 'Handled by {approver} · Denied',
  statusHandled: 'Handled by {approver}',
  statusApprovedUnnamed: 'Handled · Approved',
  statusDeniedUnnamed: 'Handled · Denied',
  statusWithdrawn: 'Withdrawn',
  statusExpired: 'Expired',
  statusClosed: 'Closed',
  statusUnknown: 'Status unknown',
  alreadyHandled: 'This request was already handled.',
  factTool: 'Tool',
  factLevel: 'Level',
  factKind: 'Kind',
  factRequester: 'Requester',
  factWaitingOn: 'Waiting on',
  factAgent: 'Agent',
  factAgentParent: 'parent {parent}',
  factRun: 'Run',
  factScope: 'Scope',
  factPolicy: 'Policy',
  factPolicyVersion: 'version {version}',
  factContinuation: 'Continuation',
  factCreated: 'Created',
  factExpires: 'Expires',
  factDigest: 'Digest',
  history: 'History',
  historyEntry: '{resolution} by {by} at {at}',
  historyReason: ' · {reason}',
  more: '…',
  summaryItems: '{count} item(s)',
  summaryMembers: '{count} member(s)',
} as const;

/** Puts `values` where the `{name}` markers of a fixed string stand. A marker with no value stays as written. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (marker, name: string) => values[name] ?? marker);
}
