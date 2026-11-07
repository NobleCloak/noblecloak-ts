---
'@noblecloak/spec': minor
'@noblecloak/client': minor
---

Contract rev 17 (release `contract-v1-rev17`): **the `claude_agent_sdk` continuation kind**. `Continuation.kind` gains `claude_agent_sdk` for the Claude Agent SDK connector, which uses `delivery: pull`. Its `correlation` is documented as `{ session_id, tool_use_id, agent_id?, mode }` (`mode` `defer` or `retry`; a missing `agent_id` means the main agent) and stays opaque to the server, at most 8 KiB, echoed as sent. The seven existing kinds are unchanged and the enum stays closed: any other kind is still 400 `invalid_request`. The schema ties the new kind to `pull`: `claude_agent_sdk` with `push` or `held` is 400 `invalid_request`, and the seven earlier kinds keep every delivery. This is not a narrowing, because the kind did not exist before rev 17. `Capabilities.features` gains `continuations.claude_agent_sdk`, as rev 15 and rev 16 each added a feature: a deployment lists it iff it accepts the kind, so an adapter can read `capabilities()` at startup instead of learning from the first decision's 400, and a deployment that does not list it answers 400 `invalid_request` to the kind. The flag changes conformance (skip rather than fail) and discoverability, nothing on the wire.

A deployment that keeps its own list of kinds adds `claude_agent_sdk` and lists `continuations.claude_agent_sdk` in the same change; until then it answers 400 `invalid_request` and skips the lifecycle scenario.

**Mock and conformance**

- The mock validates a request against the document's schemas, so it accepts and echoes the new kind and refuses an unknown one. The mock lists `continuations.claude_agent_sdk` on either deployment wherever it serves approvals, iff its document lists the kind.
- New scenarios in `34-rev17-claude-agent-sdk.yaml`: `rev17-claude-agent-sdk-continuation-lifecycle` and the negatives `rev17-unknown-continuation-kind-is-refused` and `rev17-claude-agent-sdk-is-pull-only`. Each declares `serves_delivery` for the one delivery it sends (`pull`, `pull`, `held`), so a deployment that does not serve that delivery skips it. The lifecycle also declares `features: [continuations.claude_agent_sdk]` and uses `mode: retry`, so a deployment that has not adopted the kind skips it. The two negatives are not gated on the feature: a deployment that has not adopted the kind passes both.
- `@noblecloak/client`: the generated `Continuation.kind` type gains `"claude_agent_sdk"`.
