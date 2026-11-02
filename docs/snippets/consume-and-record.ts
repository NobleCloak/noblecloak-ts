import { creator } from './connect.js';
import { unwrap } from './problem.js';
import { args, approvalId, digest, toolRef } from './step-up.js';
import { resumeToken } from './resume.js';

if (resumeToken === undefined) throw new Error('the Resumption carries no resume_token');

// Consuming is the single-use gate: the server checks the action against the approval and spends it once.
const { data: consumed } = unwrap(
  await creator.POST('/v1/approvals/{id}/consume', {
    params: { path: { id: approvalId } },
    body: { resume_token: resumeToken, action: { tool_ref: toolRef, arg_digest: digest } },
  })
);
console.log(consumed.state); // consumed

// Run the tool. Here it only prints.
console.log(`sending "${args.subject}" to ${args.to}`);

// Close the loop: the record names the approval it followed.
const { data: record } = unwrap(
  await creator.POST('/v1/records', {
    body: {
      tool_ref: toolRef,
      decision: 'step_up',
      approval_id: approvalId,
      outcome: { status: 'succeeded', summary: 'email sent' },
    },
  })
);
export const linked = record.approval_link?.linked;
console.log(linked); // true
