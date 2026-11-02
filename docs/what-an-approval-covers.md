# What an approval covers

An approval is a narrow permission. This page says how narrow, for two readers: an **approver**, who
asks "what am I agreeing to?", and a **builder**, who asks "what does my runtime get to do with it?".
The rules come from the contract (`@noblecloak/spec`, `openapi.yaml`), and each section names where. For
the steps themselves, see [Your first governed tool](./how-to/first-governed-tool.md). For what the five modes of a
tool policy mean, and when a call needs an approval at all, see [The ladder](./the-ladder.md).

## The short version

An approval covers **one call**: one tool, with one set of arguments, in one scope, and it can be used
**once**. It does not cover a later call, the same tool with other arguments, or a call in another
scope, such as a delegated run's.

## An approval is bound to one call

- **The approver resolves the call they saw.** The approver's answer (a resolve) carries
  `expected_action_digest`, the digest of the call the person was shown, and it is required. If it does
  not match the approval's action, or another resolution won first, the answer is 409
  `approval_conflict` and this one is not applied. The same applies to each element of a batch, and to
  the shortcuts `POST /v1/approvals/{id}/approve` and `/deny`, which also require it.
  (`POST /v1/approvals/{id}/resolve`: `ResolveRequest`, `ResolveBatchItem`, `AliasResolveRequest`.)
- **The digest names the arguments exactly.** It is the lowercase hex SHA-256 of the RFC 8785 canonical
  form of the arguments as sent, before schema defaults. Change one value and the digest changes. It is
  the digest of the arguments alone: the approval names the tool separately, as `tool_ref`. (The API
  description, "Argument digest".)
- **The runtime proves it is running that call.** `POST /v1/approvals/{id}/consume` is the only route
  that consumes an approval. The server recomputes the identity from the action as the runtime is about
  to run it and answers 409 `approval_conflict` on a mismatch. It also checks that the `resume_token`
  binds this obligation. (`POST /v1/approvals/{id}/consume`.)
- **It is used once.** The server consumes the approval atomically and once, and the state becomes
  `consumed`. A replay is 409 `obligation_consumed`. Fetching the Resumption does not spend anything;
  `/consume` does.

For a builder: verify the Resumption against the arguments you are about to send, then consume, then
run. The approval is spent on the attempt, so a crash between consuming and running can never run the
tool twice; if you ran first and consumed later, a crash in between could let the call run again. If
`approval.resume_token_will_issue` is `false`, there is nothing for you to consume and you must not run
the action yourself: the deployment runs it.

## What the approver is shown

A tool's `show_arguments_to_approvers` setting is off unless it is set. When it is on, the people who
decide an approval of that tool see the call itself, as the caller sent it. No summary of it is written
for them. (The API description, "Who sees the arguments of an approval".)

The arguments appear only on `GET /v1/approvals/{id}`, and only when all of these hold:

- the tool has the setting on at the time of the read;
- the approval is not final (`consumed`, `rejected`, `expired` or `withdrawn`);
- the reader is the principal that created the approval or one eligible to approve it;
- the approval holds arguments to show: the request that opened it carried `arguments`, not only an
  `arg_digest`, and the tool had the setting on when it did. Turning the setting off clears the
  arguments already stored for the tool's open approvals, and turning it on again restores nothing.

When any of these fails, the reader sees the digest and nothing more. The one exception is a deployment
that cannot tell whether the reader is eligible to approve: it answers 503 `service_unavailable` with
`reason` `eligibility_lookup`, never the digest-only view, so a failed lookup is not a reading of "not
shown". The same 503 answers a list of approvals filtered to what the caller may resolve
(`approver=me`). `Approval.arguments_state` says why, in five values:

| `arguments_state` | What it means                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `shown`           | The arguments are in the response.                                                          |
| `not_enabled`     | The tool is not set to show its calls to approvers.                                         |
| `not_sent`        | The approval holds no arguments: it was opened with only a digest, or with the setting off. |
| `withheld`        | The reader is neither the creator nor eligible to approve.                                  |
| `final`           | The approval has reached a final state, and its arguments are cleared.                      |

On a row of the approvals list, `shown` means that the single read would show the arguments. The list
never carries them.

Which value you are told depends on who you are. A reader who is neither the creator nor eligible to
approve is told `final` or `withheld` and never learns how the tool is set. The creator and an eligible
approver are told the first that applies of `final`, `not_enabled`, `not_sent` and `shown`. A response
with no `arguments_state` (a stream event may omit it) means the state is **unknown**, never `shown`.

For an approver: if you were not shown the call, you are approving a digest. Approve it only if you
have another way to know what it is. As advice, prefer to approve a call you were shown over a digest
you were not.

## What changed arguments do

A changed call cannot be approved by a card that showed the old one. Two rules combine:

- The approver's answer (resolve) carries the digest of the read the person saw
  (`expected_action_digest`). A different digest is a 409 `approval_conflict`.
- `@noblecloak/react` sends the digest of the read the person saw. What it does when the request
  changed since then depends on where the person decided. In a batch ("Approve selected"), each request
  goes with the digest the person confirmed. A request that changed since then is not approved: the
  module does not send it if it already knows of the change, and otherwise the server refuses the old
  digest with 409. Either way it counts as not approved and is never approved with the new digest. On
  the detail page, the module re-reads the request once, says that it changed, and enables the buttons
  again only after one acknowledgement. Either way a changed digest needs the person to look again.
  (See "What an approver is and is not shown" in the
  [`@noblecloak/react` README](../packages/react/README.md#what-an-approver-is-and-is-not-shown).)

If your runtime changes the arguments after approval, `/consume` refuses the call with 409
`approval_conflict`. Ask again with the new arguments; that opens a new approval for the new digest.

## What `on_deny` means for the requester

A policy that asks a person (`ask` or `escalate`) can say what the requester's run does if the person
denies: `resume` or `halt`. Since contract revision 9 the approval carries a snapshot of that choice,
`Approval.on_deny`, taken when the approval was created. Editing the policy later does not change an
approval that already exists.

- Only the **creator** reads it. Every other reader sees it absent.
- It is absent when no named policy matched, when the matching policy states none, and when the
  matching policy's mode is not `ask` or `escalate`.
- A deployment that does not implement `on_deny` omits it from every approval. Treat that as **not
  stated**: do not assume `resume`, and do not assume `halt`. When the field is absent, decide yourself
  what your run does on a denial, and make the same choice for every reason it can be absent: another
  reader, no named policy, a policy that states none, or a deployment that does not implement it.

(`Approval.on_deny`; `ToolInvocationConfig`; the API description, "Who is named on an approval".)

## When an approval ends

An approval ends in one of four states, and each says what happens to the next identical call (the same
tool and arguments, in the same scope):

- **`consumed`**: the call was used. The next identical call needs its own approval, and opens a fresh
  one.
- **`expired`** and **`withdrawn`**: the approval was never used. The next identical call opens a fresh
  one, so an old approval never carries over. Nothing is dispatched, escalated or resumed on expiry: if
  the person never answered, your run did not get permission. An approval can also expire after the
  person approved it and before your runtime consumed it. Then `/consume` answers 409
  `obligation_expired`, the approval was never used, and the call needs a new approval.
- **`rejected`**: a person said no. On a deployment that advertises `approvals.rejected_duplicate`
  (`GET /v1/capabilities`), the same call is not put to them again at once: see "A rejected call is not
  asked again at once". A deployment that does not advertise it frees the call as for `expired`.

(The API description, "Terminal states free the identity"; `POST /v1/approvals/{id}/withdraw`.)

## Who may decide

A policy that asks a person (`ask` or `escalate`) may name `approver_groups`. Together these groups form one
approval requirement, met by any eligible member of any listed group. When several approval-requiring
policies match one call, each contributes one requirement, and every requirement must be met. (Contract
revision 11; `ToolInvocationConfig.approver_groups`. The schema may grow.)

## When the call waits on your own sign-in

Some tool servers act as each user, with that user's own credential. Since contract revision 11 an
approval for such a tool can carry `blocked_on` with reason `credential_link_required` and the
`connection_id` of the server's registration: the call would run as you, and you have not linked a
credential to that server, have revoked your consent to its use, or your link stopped working. Only you,
the principal the call runs as, see it; an approver does not. The approval can still be decided, but the
deployment does not run the call, or issue its resume token, until you link: `POST
/v1/connections/{connection_id}/link` with your consent, then, for a server that signs in with OAuth,
`POST /v1/connections/{connection_id}/authorize`. Once your link is `linked` with consent given,
`blocked_on` is gone. A call that would open no approval is answered `deny` with reason
`credential_link_required` instead. (`Approval.blocked_on`; `Connection.my_link`.)

## A rejected call is not asked again at once

On a deployment that advertises `approvals.rejected_duplicate`, the default is this: an identical call
within 24 hours of a person rejecting it is answered `deny` with reason `rejected_duplicate`, names the
rejection in `rejected_approval_id`, and opens nothing; `POST /v1/approvals` answers it 409
`rejected_duplicate`. An organisation may choose otherwise with a policy of kind `duplicate_requests`:
`window_seconds` sets the window, and `after_rejection: ask_again` opens a fresh approval instead, which
carries `prior_rejections` (how many times the call was rejected within the window, and when last) so the
approver sees it was asked before; `max_reasks` caps how many rejections
are each followed by a re-ask (a re-ask that is withdrawn or expires is not a rejection and does not
count). After the window the call opens a fresh
approval.

- **Only a person's rejection counts.** An approval that ended `rejected` because the action it approved
  was refused when it ran does not.
- **A consumed approval resets the count.** Only rejections after the call's last consumed approval
  count.
- **It is not a security control.** It stops the same question being put again at once. Changed
  arguments are a different call, and are asked about as one.
- **Whose calls it covers.** Calls in a run, and calls a user makes in their own principal scope. A
  service principal's calls that name no run share one scope across every end user behind it, so they
  are not refused on another user's rejection.

(The API description, "Terminal states free the identity"; `DuplicateRequestsConfig`;
`Approval.prior_rejections`; `Decision.rejected_approval_id`.)

## What an approval does not cover

- **A later call.** An approval is consumed once (`POST /v1/approvals/{id}/consume`; a replay is 409
  `obligation_consumed`), so a second call, even an identical one, needs its own approval. While an
  approval is open (pending, or approved and not yet consumed), an identical call is matched to it
  (`created: false`) and does not open another (`POST /v1/approvals`). Identical calls in one batch
  (`POST /v1/decisions/batch`) are one approval too: the first opens it or joins the open one, and the
  rest join it. A `consumed`, `expired` or `withdrawn` approval frees the call, so the next identical call
  opens a fresh one; a `rejected` one frees it subject to the duplicate-requests policy (the API
  description, "Terminal states free the identity").
- **Other arguments.** A different digest is a different call, and it needs its own approval.
- **Another scope, and delegated runs.** An approval granted in one scope never satisfies a call in
  another. The scope is what separates calls, not the agent. A call that names a run (`run_id`) is in
  that run's scope; a call that names none is in the principal scope of the token it carries. So a
  sub-agent that calls with its parent's token and the same `run_id`, or with none when the parent named
  none, is in the parent's scope, and its identical call matches the parent's approval. A call in another
  run is kept apart (`POST /v1/runs`; a delegated run has a fresh `scope_id`). (`createApproval`;
  `Run.scope_id`.)
- **Anything the approver was not shown.** If `arguments_state` was not `shown`, the approver agreed to
  a digest, not to a reading of the call.

## Where the outcome is recorded

`Approval.outcome_record_id` names the record of what happened, and `GET /v1/records/{id}` reads it. It
is `null` until the approval has been consumed and the runtime has appended a record that names the
approval (`approval_id`); the first record linked stands. A runtime that never appends one leaves it
`null`, and the approver cannot tell from the approval what the call did. The record is the runtime's
own report: every record appended through the API is stamped `asserted`, so it is what the runtime said
happened, not a record the platform captured itself (`observed`). (`POST /v1/records`; `ApprovalLink`.)
