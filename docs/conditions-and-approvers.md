# Conditions and approvers: deciding by what a call says, and who answers

A tool policy can look at the arguments of a call, not only at which tool it is. This page is for two readers: an
**administrator**, who writes "bookings over 500 need a team lead", and a **builder**, who asks "what must my
runtime send for that to work?". The rules come from the contract (`@noblecloak/spec`, `openapi.yaml`, revision
16), and each section names where. A deployment says which of it it serves in `GET /v1/capabilities`:
`tools.facts`, `policies.rules` and `approvals.requirements`. One that lists none behaves as before revision 16.

## Facts: what a tool lets a policy look at

A policy does not read a call's arguments directly. The **tool** declares **facts**: named values, each read from a
place in the arguments. A policy's conditions then name a fact.

- A fact has a name (lower-case letters, digits and underscores, starting with a letter), a **path** from the root
  of the arguments (`.amount`, `.target.env`, `.lines[0].price`: members and array positions, no wildcard) and a
  **type**: `number`, `string`, `boolean`, or `count` (the path names a list and the fact is its length).
- Nothing is converted. The text `"42"` is not a number, so a fact typed `number` has no value for it.
- A tool declares at most 32 facts. Writing a tool's facts replaces the whole set.
- A fact with no value is one whose path selects nothing, or selects a value of another type, or whose call carried no
  arguments at all.

Only the tool's own registration states a fact. A caller can never assert one: the deployment reads each fact from
the arguments it is given. (`Tool.facts`, `FactBinding`; [Connections](./connections.md) shows where a tool's facts
are set.)

## Rules: first match wins

A `tool_invocation` policy still has a `mode`, the outcome when nothing else applies. It may also carry **rules**, at
most 32. A rule says "when these conditions all hold, the result is this":

- `when` is one to eight conditions, and **all** must hold. For "or", write another rule.
- A condition names a fact and tests it: `eq`, `ne`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte` or `exists`. The four
  comparisons need a `number` or `count` fact.
- `then` is `always_allow`, `ask` or `deny`.

The deployment walks the rules **in order**. The first rule whose conditions all hold decides the policy's result and
the walk stops. When no rule matches, the result is the policy's `mode`. A rule with a false condition is skipped. Put
the narrowest rule first, as you would an exception.

Rules are legal with every mode. A policy in `deny` mode may carry an `always_allow` rule for a case it lets through.
(`ToolInvocationConfig.rules`, `PolicyRule`, `PolicyCondition`.)

### Across policies: still the tightest

Rules decide the result of **one** policy. When several policies match one call, their results still compose
tightest-wins: `deny` over a call that needs approval over `always_allow`. A rule that allows cannot loosen another
policy's `deny`. See [The ladder](./the-ladder.md#rules-within-a-policy). A simulation lists, for each policy that
matched, the rule that gave its result (`considered[].rule`) or the facts it lacked (`missing_facts`).

## A fact that has no value: the policy asks

When a condition needs a fact that has no value, the rule cannot be judged either way. The walk **stops**, and the
policy's result is `ask`. The answer names the facts it lacked in `missing_facts`.

This is deliberate, and it fails closed. If a missing value let the walk go on, a call could slip past a rule such as
"over 5000: deny" by leaving the amount out, and reach a looser rule below it. Asking sends the call to a person
instead of letting it through or refusing it unseen.

`exists` is the exception: a fact with no value does not exist, so the condition is false, not unjudgeable.

When the walk stops this way, the approval is routed to the stopping rule's own approvers if that rule asks and names
some, and otherwise to the organisation's administrators. It is never routed to the policy's own `approvers`, because
the facts that would have chosen among them are the ones missing.

## Where arguments come from

For facts to exist, the decision must carry the call's **arguments**. A call to `POST /v1/decisions` states its
action in one of two ways, never both:

- `arguments`: the arguments themselves. The service computes their digest, and reads the facts from them.
- `arg_digest`: only the digest of arguments the service never sees. Such a call **has no facts**, so any rule that
  needs one is unjudgeable and its policy asks.

So a runtime that wants rules to apply sends `arguments`. Sending only a digest keeps the arguments from the
service, at the price of asking about every call that a rule would have judged.

A tool that runs outside the gateway's view is evaluated without arguments, and so asks. A local tool in a coding
assistant is the usual case: the decision for it carries no arguments, so a rule that needs a fact asks. A tool
reached through the gateway has its arguments in view, and rules apply to it in full.

## Approvers and who may not approve

An approval needs someone who is allowed to decide it. A policy that asks names them with `approvers`, a list of
entries, each a **role** (everyone who holds it) or one **user**:

- `approvers` on the policy answer its `ask` outcomes: the mode, and any rule that asks and names no approvers of its
  own.
- A rule that asks can name its own `approvers`, which replace the policy's for the calls that rule decides.
- An entry can carry `when`, conditions on facts. It counts for a call only while they hold. An entry whose
  condition is false, or cannot be judged, is left out.
- With no entries in force, the organisation's administrators answer.

`exclude: [requester]` names who may **never** answer, whatever else makes them eligible: the principal that opened
the approval. That holds from every surface, and for an administrator under the break-glass setting below. It is
stricter than the rule that an agent's creator may approve only from an approver surface, and wins over it.
(`approvers`, `exclude`, `PolicyApprover`; [What an approval covers](./what-an-approval-covers.md#requirements) gives
the approval's side.)

## Requirements: every one must be met

Each policy whose result asks contributes one **requirement** to the approval. Two policies with the same approvers
and the same exclusion share one. The approval lists them in `requirements`, each with its approvers in force, whether
it is met, and who met it.

- **Every requirement must be met** before the approval is approved.
- **One person may meet several.** An approver satisfies every unmet requirement they are eligible for in one act.
  An approve that leaves one unmet leaves the approval `pending`, and records the requirements it did meet.
- **Any eligible reject rejects.** A person eligible for at least one unmet requirement can reject the approval,
  whatever has been met.
- A person eligible for none of the unmet requirements is refused with `403 not_eligible`.

### The break-glass setting

By default an organisation administrator may satisfy **every** requirement in one act, whether or not they are
listed. The approval records that as `basis: break_glass`, not `listed`. An organisation can turn this off: the
`approval_routing` policy carries the setting, `org_admin_break_glass`, and the most recently published one is in
force. With none published it is on. `exclude: requester` still applies: break-glass never lets the requester approve their
own call.

In the Permissions module the setting is a checkbox that publishes as soon as it is changed. It writes over the
published version, or over a draft the module itself wrote. While another administrator's draft of the
`approval_routing` policy is pending, the module refuses the change with `draft_changed` and leaves that draft as it
is, since publishing over it would send out that draft's other edits unseen. Deal with that draft first, then change
the setting. (`ApprovalRoutingConfig`, `ApprovalRequirement`.)

## A worked example: booking a trip

A travel tool takes `{ "amount": 300 }` and the organisation wants:

| Amount      | Result                                      |
| ----------- | ------------------------------------------- |
| over 5000   | refused                                     |
| 50 or less  | runs without asking                         |
| 51 to 500   | a team lead decides                         |
| 501 to 5000 | finance decides (no rule matches: the mode) |

and nobody approves their own booking. The snippet registers the tool with an `amount` fact, publishes one policy,
and makes three decisions. It runs against the mock (`bun docs/snippets/conditions.ts`, as in
[Your first governed tool](./how-to/first-governed-tool.md)), and is typechecked and run with the rest of the
snippets. It registers a tool, so a second run against the same mock fails with `400 invalid_request`: restart
`nc-mock` (or `POST /__mock/control` with `{"reset": true}`) before running it again.

<!-- snippet: conditions -->

```ts
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
```

What happens, call by call:

1. `{ "amount": 9000 }`: the first rule holds, so the result is `deny`.
2. `{ "amount": 40 }`: the first rule is false, the second holds: `allow`.
3. `{ "amount": 300 }`: the first two are false and the third holds: `step_up`. The approval it opens has one
   requirement, answered by the `team_lead` role, with `requester` excluded. The approvers are the **rule's**, not the
   policy's `finance`.

A call for 2000 matches no rule, so the mode applies and `finance` answers. A call that arrives as a digest only has no
`amount`: the first rule cannot be judged, the policy asks, `missing_facts` is `["amount"]`, and the requirement goes to
the organisation's administrators.

Where a second policy also matched the call and also asked, it would add a requirement of its own, and both would have
to be met. A person holding both roles could meet both at once.

## Where each piece comes from

`Tool.facts` and `FactBinding`; `ToolInvocationConfig` (`rules`, `approvers`, `exclude`), `PolicyRule`,
`PolicyCondition` and `PolicyApprover`; `Action` (`arguments` or `arg_digest`); `Decision.missing_facts`;
`Approval.requirements` and `ApprovalRequirement`; `ApprovalRoutingConfig`; and the capabilities `tools.facts`,
`policies.rules` and `approvals.requirements`. A deployment that does not list a capability refuses its members with
422 `unsupported_policy_form`.
