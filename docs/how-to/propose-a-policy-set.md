# Propose a policy set for your agent

An agent that runs governed tools needs more than a tool catalog. It needs its tools registered, a service
principal that proves who is calling, and policies that say what each tool may do. A **policy-set proposal** asks
for all three at once and lets one person, an administrator of the organisation, say yes or no to the whole
change. It is a single approval, and nothing changes until it is approved.

This guide follows one proposal from the request to its effect, against the mock, which needs no account. The
rules come from the contract (`@noblecloak/spec`, `openapi.yaml`): the section "Deployment-applied proposals" of the
API description, and the schema `PolicySetProposal`. Sections 1 to 5 describe the proposal as revision 14 introduced it;
section 6 adds what revision 18 allows (role rows, a set without an agent, and tool grants).

## 1. What a proposal is

The proposal is an approval for a reference that is not a tool: `tool:noblecloak:propose-policy-set`. The
namespace `tool:noblecloak:` belongs to the deployment. It names a change the deployment makes itself when the
approval is approved, so nothing you register can sit under it, it never appears in `GET /v1/tools`, and no
policy can target it (`422 policy_immutable`). A person opens the approval with `POST /v1/approvals`, an
administrator approves it, and the deployment then, in this order:

1. registers the tools of the proposal,
2. binds the agent to its service principal,
3. creates and publishes each policy.

If any step cannot be applied, **nothing is applied**. The approval resolves `rejected`, and its history says why.

A deployment lists what it applies in `GET /v1/capabilities`, as `deployment_applied`. A deployment that does not
list `tool:noblecloak:propose-policy-set` answers `422 approval_unroutable`. Only a deployment that authors and
publishes policies of its own applies it, which today means a hosted one; the mock is one.

## 2. What you send

The arguments are a `PolicySetProposal`:

- `agent`: `{ "id": ... }`, an agent of the organisation (`POST /v1/agents` declares one). Add `principal_id` to
  bind a service principal to it on approval.
- `tools`: up to 50 tools to register, each owned by the organisation (`owner_kind: org`) with a reference that
  starts `ext:`. They are the tools the policies below name, when they do not exist yet.
- `policies`: 1 to 50 entries, each with a `role`, a `rationale` of up to 500 characters, an `assessment` of what
  the tool can do, and the `policy` itself, a `tool_invocation` policy as `POST /v1/policies` takes it. An entry is
  one of two kinds:
  - a **baseline** is the organisation's policy for one tool: its one subject is the role `everyone`, which every
    caller holds;
  - a **tightening** is the agent's own policy for one tool: its one subject is the agent. It can only tighten what
    the baseline and the other policies in force give the agent.

The whole of `action.arguments` must fit `limits.approval_arguments_max_bytes` where the deployment advertises
one. The two caps of 50 keep a typical proposal well inside a limit of 32 KiB; an agent that needs more is
proposed in several sets.

```json
{
  "action": {
    "tool_ref": "tool:noblecloak:propose-policy-set",
    "arguments": {
      "agent": { "id": "agent_4f2c", "principal_id": "svc_adapter" },
      "tools": [
        {
          "tool_ref": "ext:crm:send_email",
          "transport": "external",
          "input_schema": { "type": "object" },
          "side_effect_level": "external",
          "owner_kind": "org"
        }
      ],
      "policies": [
        {
          "role": "baseline",
          "rationale": "Anyone in the organisation may send, so the organisation lets it through.",
          "assessment": {
            "side_effect_level": "external",
            "blast_radius": "one_record",
            "reversible": false,
            "external_party": true,
            "financial": false
          },
          "policy": {
            "kind": "tool_invocation",
            "subjects": [{ "type": "role", "id": "everyone" }],
            "targets": { "tools": ["ext:crm:send_email"] },
            "config": { "mode": "always_allow" }
          }
        },
        {
          "role": "tightening",
          "rationale": "This agent asks before it sends.",
          "assessment": {
            "side_effect_level": "external",
            "blast_radius": "one_record",
            "reversible": false,
            "external_party": true,
            "financial": false
          },
          "policy": {
            "kind": "tool_invocation",
            "subjects": [{ "type": "agent", "id": "agent_4f2c" }],
            "targets": { "tools": ["ext:crm:send_email"] },
            "config": { "mode": "ask" }
          }
        }
      ]
    }
  },
  "continuation": { "kind": "mcp_held", "delivery": "held" }
}
```

Only a person proposes: a service principal or an agent, yours included, is refused. The continuation is `mcp_held`,
because nothing resumes after the change is made.

## 3. What can be refused when you open it

A refusal is `422 proposal_refused`. Its `code` says why, and `member`, where the refusal has a part of your body
to name, is a path into the request as you sent it. Opening applies nothing.

| `code`              | The proposal…                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_a_user`        | was opened by a service principal or an agent.                                                                                                                                   |
| `shape`             | breaks the schema or a rule beyond it (a baseline for an agent, a policy for two tools, two policies for one tool and subject, a `config` member beyond `mode`, an `origin`, …). |
| `unknown_agent`     | names an agent that is none of the organisation's.                                                                                                                               |
| `principal_bound`   | binds a service principal that another agent already holds.                                                                                                                      |
| `tool_ref_in_use`   | registers a tool the organisation already has.                                                                                                                                   |
| `target_unknown`    | targets a tool that is neither registered nor in the proposal's `tools`.                                                                                                         |
| `baseline_exists`   | proposes a baseline for a tool that a published policy of `everyone` already governs.                                                                                            |
| `tightening_looser` | gives the agent a looser mode than the policies in force and the proposal's baselines compose to.                                                                                |

`baseline_exists` is deliberate: a proposal never loosens or replaces the organisation's baseline without anyone
choosing to. Propose a tightening instead. A proposal larger than the deployment keeps is `400 invalid_request`,
as for any approval that shows its arguments.

No check at open refuses a tightening because a published policy of the agent already governs the tool (by name,
or by `all`). Such a proposal may open, but approving it never applies it: it is refused with
`proposal_refused:policy_conflict`, unless a check run again refuses it first. At most one published policy governs a
tool for one subject. Change that
policy instead, or retire it before the proposal is approved.

## 4. What the approver sees

While the approval is pending, `GET /v1/approvals/{id}` shows an approver the proposal itself, in `arguments`, and
its `preview`:

- `preview.simulations`: for each tool the policies govern, the decision a call to it would get for the agent,
  with every proposed policy standing beside the policies in force (the same dry run as
  `POST /v1/policies/simulate`);
- `preview.loosening`: each baseline whose mode is looser than the mode the deployment gives the tool by default,
  as `{ tool_ref, from, to }`. An empty list says that approving loosens nothing.

The preview is computed when the approval is opened. It is read by a person who may approve, never by the person
who opened it with their own token and never by a user who may not approve.

## 5. Approving, and what happens next

An administrator of the organisation approves with `POST /v1/approvals/{id}/approve`. The person who proposed may
approve their own proposal only from the deployment's approver surface (see
`Capabilities.self_approval_from_approver_surface`), never with the token that opened it.

- **Applied.** The answer is the approval, `consumed`, with `resolution: approved`. The tools exist, the agent is
  bound, the policies are published, and a simulation by the bound service principal shows the tightening.
- **Not applied.** Approving runs the checks of step 3 again against the state of that moment, then applies the
  change. If one fails, or a policy to publish meets a published policy of the same tool and subject, nothing is
  applied. The answer is still `200`, and the approval is `rejected`: the last entry of its `resolution_history`
  has `by` the administrator whose approval the deployment refused, and `reason` of the form
  `proposal_refused:<code>`, for example `proposal_refused:policy_conflict`. The same proposal may be opened
  again once what refused it is fixed.
- **Denied.** `POST /v1/approvals/{id}/deny` applies nothing.

## 6. Revision 18: role rows, a set without an agent, and tool grants

Revision 18 lets the same reference carry a set of starter policies for the organisation. A deployment says what it
accepts in `GET /v1/capabilities`, as `proposals`: `row_kinds` (`baseline`, `tightening`, `role`) and `members`
(`tool_grants`). Absent means what revision 14 accepts, `baseline` and `tightening` and no member, and anything it does
not list is refused `shape`.

- **Role rows.** An entry may have the `role` `role`: a `tool_invocation` policy for one role of the organisation,
  with exactly one subject `{ "type": "role", "id": "<key>" }`, one tool and `mode` only. The key is a bare role key
  (for example `member`) that is not empty, has no whitespace before or after it, and is never `everyone` in any form:
  a policy of `everyone` is a baseline. Role rows need the organisation to hold the entitlement
  `policies.role_subjects` (listed in `Capabilities.entitlements`).
- **No agent.** `agent` is optional. A set without it carries baselines, role rows and `tools` only; a tightening or
  `tool_grants` without an agent is refused `shape`.
- **Tool grants.** `tool_grants` lists up to 50 tools the organisation already owns (`owner_kind: org`), granted on
  approval to the service principal in `agent.principal_id`, which they need. A grant cannot name one of the
  proposal's own `tools` or a `tool:noblecloak:` reference (`shape`). What a grant does beyond the visibility rule of
  `GET /v1/tools`, which it leaves unchanged, is the deployment's.

On approval, the grants are applied after the binding and before the policies, in the same all-or-nothing step.

The refusals at open that revision 18 adds or widens:

| `code`           | The proposal…                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `not_entitled`   | carries a role row, and the organisation does not hold `policies.role_subjects` (`member` names the first role row). |
| `target_unknown` | also: grants a tool the organisation does not own (a tool a principal owns included), or a withdrawn one.            |

Approving checks the entitlement again: if the organisation no longer holds it, nothing is applied and the approval
resolves `rejected` with the reason `proposal_refused:not_entitled`.

What the preview adds:

- `preview.simulations` is, for a set without an agent, the decision as `{ "type": "role", "id": "everyone" }`. No
  simulation shows what a role row does, since neither the agent nor `everyone` holds the role.
- `preview.loosening` also has an entry, with `subject`, for each role row that loosens what its role gets: where no
  published policy the role holds governs the tool, the row (with the set's baseline) against the default. An empty
  list still says that approving loosens nothing.
- `preview.ineffective` lists, as `{ tool_ref, subject }`, each role row whose mode is looser than a policy of
  `everyone` gives the same tool (a published one, or a baseline of the set): under tightest-wins the row changes
  nothing while that policy stands. It refuses nothing. Absent or empty means no row is shadowed.
- `preview.grants` lists the tools the set grants, as `{ tool_ref }`.

```json
{
  "action": {
    "tool_ref": "tool:noblecloak:propose-policy-set",
    "arguments": {
      "policies": [
        {
          "role": "baseline",
          "rationale": "Every caller asks before a refund.",
          "assessment": {
            "side_effect_level": "external",
            "blast_radius": "one_record",
            "reversible": false,
            "external_party": true,
            "financial": true
          },
          "policy": {
            "kind": "tool_invocation",
            "subjects": [{ "type": "role", "id": "everyone" }],
            "targets": { "tools": ["ext:crm:refund"] },
            "config": { "mode": "ask" }
          }
        },
        {
          "role": "role",
          "rationale": "Members never refund.",
          "assessment": {
            "side_effect_level": "external",
            "blast_radius": "one_record",
            "reversible": false,
            "external_party": true,
            "financial": true
          },
          "policy": {
            "kind": "tool_invocation",
            "subjects": [{ "type": "role", "id": "member" }],
            "targets": { "tools": ["ext:crm:refund"] },
            "config": { "mode": "deny" }
          }
        }
      ]
    }
  },
  "continuation": { "kind": "mcp_held", "delivery": "held" }
}
```

## 7. Undoing a trial

A tool that was registered stays registered; there is no route that deletes one. Unbind the agent with
`DELETE /v1/agents/{id}/principal` and retire each policy with `POST /v1/policies/{id}/retire`. The conformance
scenarios of `@noblecloak/spec` (`31-rev14-policy-set-proposal.yaml` and `35-rev18-proposal-role-rows-and-grants.yaml`)
do exactly that in their `cleanup`. The contract has no route that takes a grant back.
