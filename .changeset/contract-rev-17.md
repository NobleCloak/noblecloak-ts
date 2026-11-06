---
'@noblecloak/spec': minor
'@noblecloak/client': minor
---

Contract rev 17 (release `contract-v1-rev17`): **the `claude_agent_sdk` continuation kind**. `Continuation.kind` gains `claude_agent_sdk` for the Claude Agent SDK connector, which uses `delivery: pull`. Its `correlation` is documented as `{ session_id, tool_use_id, agent_id?, mode }` (`mode` `defer` or `retry`; a missing `agent_id` means the main agent) and stays opaque to the server, at most 8 KiB, echoed as sent. The seven existing kinds are unchanged and the enum stays closed: any other kind is still 400 `invalid_request`. The schema does not tie a kind to a delivery. `Capabilities` gains nothing, so a client learns whether a deployment accepts the kind by opening an approval with it.

A deployment that keeps its own list of kinds must add `claude_agent_sdk` before a Claude Agent SDK adapter opens approvals against it; until then it answers 400 `invalid_request`.

**Mock and conformance**

- The mock validates a request against the document's schemas, so it accepts and echoes the new kind and refuses an unknown one.
- New scenarios in `34-rev17-claude-agent-sdk.yaml`: `rev17-claude-agent-sdk-continuation-lifecycle` and the negative `rev17-unknown-continuation-kind-is-refused`. Both declare `serves_delivery: pull`, so a deployment that does not serve the pull delivery skips them. A deployment that vendors the scenarios and runs them nightly adds the two new ids to its expected-skips until it accepts the kind.
- `@noblecloak/client`: the generated `Continuation.kind` type gains `"claude_agent_sdk"`.
