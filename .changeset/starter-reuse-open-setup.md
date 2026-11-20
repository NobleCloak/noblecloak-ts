---
'@noblecloak/cli': patch
'@noblecloak/client': patch
---

`noblecloak starter` reuses the setup proposal the deployment opened when a service principal was created in the browser (a credential downloaded from the Team module), instead of opening a second one. `noblecloak sp create` never has a setup opened for it, so a credential from `sp create` is unchanged: the command declares its own agent. When the credential file has an `org_id` that is a UUID, the command reads the agent the deployment declares for the principal (`GET /v1/agents/{id}`). If that agent is bound to the principal, the setup is already applied and the command exits 13 without opening anything. Otherwise it opens the setup with the continuation the deployment stored on its own proposal, so the deployment answers with the proposal it already has open; the deployment matches per proposer and per continuation, so another administrator gets a second proposal, and whichever is approved second fails `policy_conflict` (reported as already set up). A 409 `rejected_duplicate` (an administrator rejected that proposal) exits 13 naming the rejected approval and says to create new credentials; the command does not fall back to a new agent. A 409 `continuation_conflict` is explained. The principal id is lower-cased once, as the deployment does. `--agent` and `--skip-setup` keep their meaning.

`@noblecloak/client`: `GovernanceApi.getAgent(id)` reads an agent (`GET /v1/agents/{id}`), and a `Problem` carries `rejectedApprovalId` from a 409 `rejected_duplicate`.
