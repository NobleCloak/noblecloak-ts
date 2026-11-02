import type { ApprovalSummary } from './approvals-types.js';

/**
 * Why a queue row may not be approved without being opened, or `undefined` when it may. Only a request that shows
 * no arguments (`arguments_state` `not_enabled`: the tool does not show them to approvers; `not_sent`: the agent
 * sent only a digest) has nothing an approver could have been shown, so only it can be approved from the queue.
 * An absent state is unknown (a stream event may omit it and a rev 5 service never sends it), not "nothing to show".
 */
export type BatchBlock = 'readable' | 'withheld' | 'unknown' | 'decided';

export function batchBlock(row: ApprovalSummary): BatchBlock | undefined {
  if (row.state !== 'pending') return 'decided';
  switch (row.arguments_state) {
    case 'not_enabled':
    case 'not_sent':
      return undefined;
    case 'shown':
      return 'readable';
    case 'withheld':
      return 'withheld';
    case 'final':
      return 'decided';
    default:
      return 'unknown';
  }
}
