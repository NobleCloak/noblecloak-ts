import { approver, creator } from './connect.js';
import { problemCode, unwrap } from './problem.js';
import { approvalId, digest } from './step-up.js';

const path = { id: approvalId };
const body = { expected_action_digest: digest };

// The agent asked for the approval, so it cannot give it.
const refused = await creator.POST('/v1/approvals/{id}/approve', { params: { path }, body });
if (refused.error === undefined) throw new Error('the creator resolved its own approval');
export const refusal = problemCode(refused.error);
console.log(refused.response.status, refusal); // 403 not_eligible

// A person can.
const { data: approval } = unwrap(
  await approver.POST('/v1/approvals/{id}/approve', { params: { path }, body })
);
export const state = approval.state;
console.log(state); // approved
