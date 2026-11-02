import type { Approval, ApprovalCardOptions, CardViewer } from './model.js';

// The last group of each id holds a letter: a 12-digit run is the shape of an account ID, which the tree scan refuses.
export const APPROVAL_ID = '11111111-1111-4111-8111-11111111111a';
export const MESSAGE_ID = '22222222-2222-4222-8222-22222222222b';
export const APPROVALS_URL = `https://approvals.example.com/approvals/${APPROVAL_ID}`;
export const DIGEST = 'sha256:3f2a9c0d11';

/** The members every read carries, and nothing else. */
export function minimal(over: Partial<Approval> = {}): Approval {
  return {
    id: APPROVAL_ID,
    state: 'pending',
    tool_ref: 'payments.refund',
    obligation_kind: 'tool_invocation',
    action_digest: DIGEST,
    scope_id: 'scope-1',
    side_effect_level: 'write',
    created_at: '2026-10-30T09:00:00Z',
    ...over,
  };
}

/** A read with every member the facts table shows, the call and a history. */
export function full(over: Partial<Approval> = {}): Approval {
  return minimal({
    arguments: { amount: 42, ticket: 'T-9' },
    arguments_state: 'shown',
    policy: { id: 'pol-1', version: 3 },
    requester: { id: 'u-dana', kind: 'user', display_name: 'Dana Ruiz' },
    waiting_on: {
      count: 2,
      principals: [
        { id: 'u-priya', kind: 'user', display_name: 'Priya' },
        { id: 'u-sam', kind: 'user' },
      ],
    },
    agent: { id: 'agent-7', name: 'Payables Agent', parent: 'agent-1' },
    run: { id: 'run-5', kind: 'governed' },
    continuation_kind: 'resume_run',
    expires_at: '2026-10-31T09:00:00Z',
    ...over,
  });
}

export function options(over: Partial<ApprovalCardOptions> = {}): ApprovalCardOptions {
  return {
    blockCallInChat: false,
    approvalsUrl: APPROVALS_URL,
    capabilities: { resolutions: ['approved', 'rejected'] },
    ...over,
  };
}

export const OTHER_VIEWER: CardViewer = { principalId: 'u-priya' };
export const REQUESTER_VIEWER: CardViewer = { principalId: 'u-dana' };

export function priyaResolved(
  state: Approval['state'],
  resolution: string,
  reason?: string
): Partial<Approval> {
  return {
    state,
    resolution,
    approver: { id: 'u-priya', kind: 'user', display_name: 'Priya' },
    resolved_at: '2026-10-30T10:00:00Z',
    resolution_history: [
      {
        resolution,
        by: { id: 'u-priya', kind: 'user', display_name: 'Priya' },
        at: '2026-10-30T10:00:00Z',
        ...(reason === undefined ? {} : { reason }),
      },
    ],
  };
}
