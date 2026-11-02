import { argDigest } from '@noblecloak/client';

import { creator } from './connect.js';
import { unwrap } from './problem.js';

export const toolRef = 'ext:local:send_email';
export const args = { to: 'ada@example.com', subject: 'Your refund' };
export const digest = await argDigest(args);

const { data: decision } = unwrap(
  await creator.POST('/v1/decisions', {
    body: {
      action: { tool_ref: toolRef, arg_digest: digest },
      // How the runtime wants to hear that the approval resolved: it will pull the Resumption.
      continuation: { kind: 'webhook', delivery: 'pull' },
    },
  })
);

if (decision.decision !== 'step_up' || decision.approval === undefined) {
  throw new Error(`expected step_up with an approval, got ${decision.decision}`);
}

export const approvalId = decision.approval.id;
console.log(decision.decision, decision.approval.state, decision.approval.resume_token_will_issue);
// step_up pending true
