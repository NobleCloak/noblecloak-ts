import { createClient } from '@noblecloak/client';

import { baseUrl, creator } from './connect.js';
import { unwrap } from './problem.js';

export const toolRef = 'ext:travel:book';

// An administrator authors and publishes policies. The mock serves its token beside the others.
const tokens = (await (await fetch(`${baseUrl}/__mock/tokens`)).json()) as Record<string, string>;
const admin = createClient({ baseUrl, getToken: () => tokens.admin ?? '' });

// 1. The tool declares the facts a policy may test. Each fact is read from the arguments of a call.
unwrap(
  await creator.POST('/v1/tools', {
    body: {
      tool_ref: toolRef,
      transport: 'external',
      description: 'Book a trip.',
      side_effect_level: 'external',
      input_schema: { type: 'object' },
      owner_kind: 'org',
      show_arguments_to_approvers: true,
      facts: { amount: { path: '.amount', type: 'number' } },
    },
  })
);

// 2. A policy over that fact. The first rule that matches decides; `mode` decides when none does.
const { data: policy } = unwrap(
  await admin.POST('/v1/policies', {
    body: {
      kind: 'tool_invocation',
      subjects: [{ type: 'organization' }],
      targets: { tools: [toolRef] },
      config: {
        mode: 'ask',
        rules: [
          { when: [{ fact: 'amount', op: 'gt', value: 5000 }], then: 'deny' },
          { when: [{ fact: 'amount', op: 'lte', value: 50 }], then: 'always_allow' },
          {
            when: [{ fact: 'amount', op: 'lte', value: 500 }],
            then: 'ask',
            approvers: [{ role: 'team_lead' }],
          },
        ],
        approvers: [{ role: 'finance' }],
        exclude: ['requester'],
      },
    },
  })
);
unwrap(await admin.POST('/v1/policies/{id}/publish', { params: { path: { id: policy.id } } }));

// 3. Three calls, each carrying its arguments (not a digest of them), so the facts exist.
async function decide(args: { amount: number }) {
  const { data } = unwrap(
    await creator.POST('/v1/decisions', {
      body: { action: { tool_ref: toolRef, arguments: args } },
    })
  );
  return data;
}

export const tooLarge = await decide({ amount: 9000 });
export const small = await decide({ amount: 40 });
export const middling = await decide({ amount: 300 });
console.log(tooLarge.decision, small.decision, middling.decision); // deny allow step_up

// The approval lists what must be met and who may meet it: the rule's own approvers, not the policy's.
const approvalId = middling.approval?.id ?? '';
const { data: approval } = unwrap(
  await creator.GET('/v1/approvals/{id}', { params: { path: { id: approvalId } } })
);
export const requirements = approval.requirements ?? [];
console.log(JSON.stringify(requirements[0]?.approvers), JSON.stringify(requirements[0]?.exclude)); // [{"role":"team_lead"}] ["requester"]
