---
'@noblecloak/spec': minor
'@noblecloak/client': minor
---

Contract rev 17 (release `contract-v1-rev17`): **the `claude_agent_sdk` continuation kind**. `Continuation.kind` gains `claude_agent_sdk` for the Claude Agent SDK connector, which uses `delivery: pull`. Its `correlation` is documented as `{ session_id, tool_use_id, agent_id?, mode }` (`mode` `defer` or `retry`; a missing `agent_id` means the main agent) and stays opaque to the server, at most 8 KiB, echoed as sent. The seven existing kinds are unchanged and the enum stays closed: any other kind is still 400 `invalid_request`. The schema ties the new kind to `pull`: `claude_agent_sdk` with `push` or `held` is 400 `invalid_request`, and the seven earlier kinds keep every delivery. This is not a narrowing, because the kind did not exist before rev 17. `Capabilities` gains nothing, so a client learns whether a deployment accepts the kind by opening an approval with it.

A deployment that keeps its own list of kinds must add `claude_agent_sdk` before a Claude Agent SDK adapter opens approvals against it; until then it answers 400 `invalid_request`.

**Mock and conformance**

- The mock validates a request against the document's schemas, so it accepts and echoes the new kind and refuses an unknown one.
- New scenarios in `34-rev17-claude-agent-sdk.yaml`: `rev17-claude-agent-sdk-continuation-lifecycle` and the negatives `rev17-unknown-continuation-kind-is-refused` and `rev17-claude-agent-sdk-is-pull-only`. Each declares `serves_delivery` for the one delivery it sends (`pull`, `pull`, `held`), so a deployment that does not serve that delivery skips it. Nothing in `Capabilities` names the kind, so a deployment that serves pull but has not added the kind runs the lifecycle and the unknown-kind scenario (and the pull-only scenario too, if it serves held): it passes both negatives and fails the lifecycle at step 2 (`POST /v1/decisions`, 400 `invalid_request`); it does not skip the lifecycle. A deployment that vendors the scenarios adds `claude_agent_sdk` to its list of kinds in the same change that takes rev 17, or lists `rev17-claude-agent-sdk-continuation-lifecycle` among its expected failures until it does.
- `@noblecloak/client`: the generated `Continuation.kind` type gains `"claude_agent_sdk"`.
