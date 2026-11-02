# The ladder: the five modes of a tool policy

A tool policy says, for some subjects and some tools, how a call is decided. This page is for two readers: an
**administrator**, who asks "what does this setting do to a call?", and a **builder**, who asks "what will my
runtime see on the wire?". The rules come from the contract (`@noblecloak/spec`, `openapi.yaml`), and each section
names where. The Permissions module (`@noblecloak/react/permissions`) shows the same mapping in its legend.

## The five modes and what they mean on the wire

A `tool_invocation` policy has one `mode`. Each maps to a decision the runtime receives. The table is the contract's
own (`x-noblecloak-vocabulary.decision_from_policy_mode`); the module's `MODE_ON_THE_WIRE` is held equal to it by a
test.

| Mode           | On the wire                    | What it means                                                               |
| -------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `always_allow` | `allow`                        | The call runs without asking.                                               |
| `ask`          | `step_up`                      | The call waits for an approval that an eligible approver resolves.          |
| `escalate`     | `step_up`, routing `escalated` | The call waits for an approval, as with `ask`; the wire marks it escalated. |
| `deny`         | `deny`                         | Never.                                                                      |
| `not_granted`  | `deny`, reason `not_granted`   | No grant is held here. Provisional: no deployment implements it yet.        |

(`PolicyMode`; `x-noblecloak-vocabulary.decision_from_policy_mode`.)

## `ask`: who approves

`ask` is `step_up` on every invocation channel (interactive, headless and workflow) when approvals are served: the
channel never changes the decision. The approval is resolved by an **eligible approver**: never the principal that made the call, never a
service principal, and otherwise whoever the deployment's own rule says may resolve it. When the deployment cannot
open or route the approval, the call is denied with reason `approval_unroutable`, never silently allowed. (The API
description, "Vocabulary" and "Who sees the arguments of an approval".)

## Why `escalate` is `step_up` with routing

`escalate` and `ask` give the runtime the same decision, `step_up`: the call waits for an approval either way, and a
runtime does nothing different. The wire marks an escalated one with `routing: escalated`; the contract does not yet
say how escalated routing differs from an `ask`'s.
(`decision_from_policy_mode`: `escalate: { decision: step_up, routing: escalated }`.)

A deployment that does not enforce a mode refuses a policy that sets it with 422 `unsupported_policy_form`, whose
`member` names the member as a path into the body you sent (for example `config.mode`); `detail` stays prose, and is
what a rev 12 deployment, which sends no `member`, names it in. The module offers all five modes and shows that
reason next to the field `member` names, or above the editor.

## `not_granted` and `deny`

Both map to the decision `deny` (`decision_from_policy_mode`). `not_granted` maps to `{ decision: deny, reason:
not_granted }`: the subject holds no grant, and the denial carries the reason `not_granted`. `deny` maps to a plain
`deny`: the policy denies the call. `not_granted` is provisional: no deployment implements it yet, and one that does
not refuses a policy that sets it with 422 `unsupported_policy_form`. (`PolicyMode`;
`x-noblecloak-vocabulary.decision_from_policy_mode`.)

How several policies that match one call combine is a deployment's to state. One that advertises the feature
`policies.tightest_wins` composes `tool_invocation` modes tightest-wins across every entry that matched, whoever its
subject: `deny` (and `not_granted`, which composes as `deny`) over needing approval (`ask`, `escalate`) over
`always_allow`; a loosening comes only through an exemption the deployment defines, and the deployment's default
applies only when nothing matched. A deployment that does not advertise it states no rule, and the module then claims
none. (`Capabilities.features`: `policies.tightest_wins`; `ConsideredPolicies`.)

Which policies a call is held by depends on who the caller is. A caller holds the policies that name it, the
policies of the roles it holds, the organisation's, and one more role that every caller holds without being given it:
`everyone` (rev 13). A policy on `{ type: role, id: everyone }` is the organisation's baseline: it applies to a user,
an agent and a service principal alike, beside whatever their other subjects add. A policy that names an agent
applies to a call through the service principal bound to that agent (`PUT /v1/agents/{id}/principal`, for
administrators) and through nothing else; `actor.agent_id` on a request is a hint a deployment may show, and it
never selects a policy. An agent's policies are held under the same composition as any other, so they can only
tighten what the organisation allows. (`Agent.principal_id`, `ActorHint`; the API description, "Agent identity" and
"Reserved roles".)

## `on_deny`, expiry and approver groups

Three settings apply only to the modes that wait for an approval, `ask` and `escalate`; with `always_allow`, `deny`
or `not_granted` they are refused. The module clears them, with a note, when the mode changes to one that takes none.
(`ToolInvocationConfig`: its `if`/`then` legality matrix.)

| Setting           | Values                        | What it says                                                              |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `on_deny`         | `resume`, `halt`, or absent   | What the run does when the approval is denied.                            |
| `expires_after`   | an ISO 8601 duration (`PT1H`) | How long the approval may wait.                                           |
| `approver_groups` | group ids                     | Approver groups; the module reads them as a condition on who may approve. |

Approver groups are a condition, not a separate policy. A policy's groups together form one approval requirement,
met by any eligible member of any listed group; the schema may grow. (`ToolInvocationConfig.approver_groups`.)

## Drafts, versions and publishing

A policy is written as a draft and enforced only once published. Writing a published policy writes a draft as its
next version; reading the policy keeps returning the published version until the draft is published, and the
policy's versions list the draft (`published_at: null`). Publishing makes the pending draft the published version,
keeping its number. A `tool_invocation` policy's enforcement follows within the deployment's policy-cache interval.
Publishing a `tool_invocation` policy that would govern a (tool, subject) pair another published policy already
governs is 409 `policy_conflict`, whose `policy_id` names that policy: at most one published `tool_invocation` policy
governs each pair (a `duplicate_requests` policy never conflicts). Where a deployment advertises `policies.retire`,
an administrator retires a published policy: it leaves reads and lists, keeps its versions, and, within the
policy-cache interval, stops being enforced and is named on no new decision or approval; and discards a pending draft, or deletes a
policy never published. (`PUT /v1/policies/{id}`, `GET /v1/policies/{id}/versions`, `POST
/v1/policies/{id}/publish`, `POST /v1/policies/{id}/retire`, `DELETE /v1/policies/{id}/draft`.)

The module therefore shows, for each role and tool, the published policy that governs the pair, or "No policy" and
that the deployment's default applies, or, from a service that lists two published policies for one pair, that they
conflict (that cell cannot be edited). That table is what was authored; what a holder of the role actually gets is
the effective view (below).

## Simulate: what matched, and what it composed to

`POST /v1/policies/{id}/simulate` runs the decision in dry run against a version of the policy, for the caller: the
principal is the token's and is never read from the request. Nothing is opened or recorded. The answer lists what it
considered: every policy that matched the call (each matched subject included) and the deployment's defaults that
applied, with a null `id`; and `composed`, the decision they composed to. It states the inputs and the outcome,
never an order of precedence or why one entry won, and the module marks no entry as winning. (`SimulateRequest`,
`ConsideredPolicies`, `SimulateResult`.)

To see what policies would do before any of them is published, `POST /v1/policies/simulate` (rev 13) takes the
proposed bodies in the request, `policies`, each a policy as `POST /v1/policies` takes it, with the call to decide.
The bodies stand beside the policies in force and never replace one: there is nothing to replace, because a proposed
body has no id. An entry that comes from a proposed body has a null `id` and `version` and a `proposed_index`, its
place in your list; a deployment's default also has a null `id` and `version`, and is the one that carries `source`.
A body no deployment can enforce is refused as `POST /v1/policies` refuses it, with `member` naming the place in the
request (for example `policies[2].subjects[0].type`). Nothing is stored, opened or recorded. (`SimulateSetRequest`,
`ConsideredPolicies`.)

## Effective access: what a holder of a role would get

An administrator may simulate as a subject: `subject` names a role (that role plus the organisation), a user (the
deployment's view of that user, roles included) or the organisation alone. Anyone else is refused with 403, and a
subject type the deployment cannot simulate with 422 `unsupported_policy_form`, whose `member` is `subject`. An agent
is its own policies, `everyone` and the organisation's, and no user's or other role's; `{ type: role, id: everyone }`
gives the baseline on its own. Every holder of a subject other than the organisation also holds `everyone`: the
organisation alone holds only the organisation's policies. Each entry of `considered` may carry `contributed`: whether the deployment used it to
reach the decision. (`SimulateRequest.subject`, `ConsideredPolicies`.)

The module's "Effective access" view runs one such dry run per role (and organisation) and tool, for the rows on
screen, a few at a time, and shows the decision. Where the deployment advertises `policies.tightest_wins` it also
shows which entries set it ("Set by"): a subject and its policy, or the deployment's default. Where it does not, it
lists what matched and says nothing about which entry decided. The wire has no platform or tool subject, so a cell is
set by a role, the organisation or the deployment's default; an agent or user policy never applies to a holder of a
role. Simulate is a route of one policy: on the published basis the module runs it against a published policy at
its published version, so the answer is what the published policies give. With nothing published there is no policy
to name in that route, and a deployment of rev 13 or later answers the same question through `POST
/v1/policies/simulate`, which needs none (this module does not call it yet). It can also run it against one draft, as
if that draft were published. A user who is not an
administrator sees a note after one refused dry run, never one refusal per cell.

## Import and export

Policies can be exported to and imported from Cedar and AGT manifests; an import is saved as a draft and goes through
the same dry run and publish. See [Importing and exporting tool policies](./policy-import-export.md).

## Observe is an annotation, not a mode

A decision that was not enforced carries `enforced: false` and `would_be` set to the decision it would have been. It
is never a decision value and never a mode: a simulation is the dry run. (`x-noblecloak-vocabulary.annotations.observe`.)
