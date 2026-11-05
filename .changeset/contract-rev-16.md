---
'@noblecloak/spec': minor
'@noblecloak/client': minor
'@noblecloak/react': patch
---

Contract rev 16 (release `contract-v1-rev16`): **fact-conditioned policies and approval requirements**. A tool declares facts read from the arguments of a call, a `tool_invocation` policy's rules decide by them, and the approval a policy raises names who may answer it. Every addition is optional on the wire, so a rev 15 server's responses still validate against rev 16's response schemas; a deployment that does not list a rev 16 feature refuses its members with 422 `unsupported_policy_form` and behaves as rev 15.

**Facts on a tool (feature `tools.facts`)**

- `Tool.facts`, `ToolWrite.facts` and `ToolPatch.facts` (a patch replaces the whole map; `null` clears it): a `ToolFacts` map from a `FactName` (`^[a-z][a-z0-9_]{0,62}$`, at most 32) to a `FactBinding` `{ path, type, description? }`. `path` is one or more `.key` / `[N]` segments; a wildcard or a recursive descent is refused with 400 `invalid_request` naming the binding in `member`. `type` is `number`, `string`, `boolean` or `count` (an array's length). Nothing is coerced; a path that selects nothing, or a value of another type, leaves the fact with no value. A call that sends only `arg_digest` has no facts.

**Rules (feature `policies.rules`)**

- `ToolInvocationConfig.rules`: up to 32 `PolicyRule`s `{ when, then, approvers? }`, `when` being 1 to 8 `PolicyCondition`s `{ fact, op, value? }` over `eq ne in not_in gt gte lt lte exists`, all of which must hold. Walked in order: a rule with a false condition is skipped; otherwise one with an unevaluable condition stops the walk and the policy asks (routed to that rule's `approvers` when it is an `ask` rule that has them, else to the organisation's administrators, never to the policy's `approvers`); otherwise it matches and its `then` (`always_allow`, `ask`, `deny`) is the result; no match gives `mode`. Policies still compose tightest-wins. A condition naming a fact a known target does not declare, or comparing a fact that is neither a `number` nor a `count`, is 400 `invalid_request` naming the condition's `fact` in `member`.
- A considered entry of a simulation gains `rule` (`{ index, then }`) and `missing_facts`, and a `Decision` (and a simulation's `SimulateResult`) gains `missing_facts`: on a `step_up`, the facts whose absence stopped the walk of a contributing policy.

**Approvers, requirements and the organisation's setting (feature `approvals.requirements`)**

- `ToolInvocationConfig.approvers` (`PolicyApprover`: `{ role }` or `{ user }`, each with an optional `when`), a rule's own `approvers` (only with `then: ask`), and `exclude: [requester]`. `approver_groups` is unchanged.
- `Approval.requirements`: one `ApprovalRequirement` `{ id, policies, approvers, exclude, needed, met, approvals }` per policy that asked (identical eligible sets and `exclude` are one requirement listing both policies; `approvers` is a list of `ApproverRef`, empty meaning the organisation's administrators; `needed` is always 1). An approval opened through `POST /v1/approvals` carries the requirements a decision of the same call would set, and a call that matches an open approval joins it: a pending one gains the requirements it lacks, an approved one is joined as it is and keeps those it was approved under (an approval binds the decision it answered; one approval per call identity at a time). An approve meets every unmet requirement the approver is eligible for, and while one stays unmet it answers 200 with the approval still `pending` and emits `approval.updated`; anyone eligible for an unmet requirement may reject. `waiting_on` counts those eligible for an unmet requirement.
- The new policy kind `approval_routing` (`ApprovalRoutingConfig` `{ org_admin_break_glass }`, organisation subject and every tool only, most recently published in force, `true` when none): an administrator may meet every requirement by break-glass. `Capabilities.policy_forms` gains `approval_routing`, and `tool_invocation.config_members` gains `rules`, `approvers` and `exclude`.
- `Problem.member` is also set on the 400 `invalid_request` of a fact binding or a condition.

**Mock and conformance**

- The mock advertises `tools.facts` on either deployment, `policies.rules` where it authors policies (hosted), and `approvals.requirements` where it also serves approvals. It decides a call by composing the matching policies when one of them carries `rules`, `approvers` or `exclude`, and keeps requirements on the approvals those decisions open. New breaks `rules_ignored`, `missing_fact_falls_to_mode`, `partial_approve_resolves`, `exclude_requester_ignored` and `break_glass_ignores_setting`, each with a row of the broken-mock matrix.
- New scenarios in `33-rev16-facts-rules-requirements.yaml`: `rev16-rules-decide-by-the-facts-of-the-call`, `rev16-requirements-met-one-by-one`, and the negatives `rev16-exclude-requester-refuses-the-requester` and `rev16-break-glass-follows-the-organisation-setting`. The features `tools.facts`, `policies.rules` and `approvals.requirements` are in the `FEATURES` a scenario may require.
- A deployment that vendors the scenarios and runs them nightly adds the four new ids to its expected-skips until it serves the features.

**React**

- `KNOWN_POLICY_KINDS` gains `approval_routing`, so a policy of that kind reads as a documented kind (`kindKnown`).
