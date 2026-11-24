# @noblecloak/cli

## 0.2.2

### Patch Changes

- 6d265a1: The page the browser shows after CLI sign-in is now a NobleCloak page, in light and dark, readable on a phone. It tells you to return to the terminal, where the command continues; when sign-in did not complete it says the command has stopped and to run it again, and shows the authorization server's error text (escaped). The page is one self-contained document served from 127.0.0.1 with a Content-Security-Policy that allows no script and no other origin. Exit codes and output are unchanged.
- 6d265a1: When a service-principal credential file or key file cannot be read, the error now names the absolute path it tried and the reason in words: "no such file", "permission denied", "it is a directory, not a file". For a missing `noblecloak-*.json` file it suggests the one nearest file of the same principal in the same directory. The error `code` (`credential_unreadable`) and `cause` (the fs error code) are unchanged, and the message never carries file contents. The path is shown only when the argument looks like a path (its file name has an extension, or it has a separator and its directory exists); a token, a base64 secret or JSON given in its place is not echoed, and control characters in a shown path are escaped. `noblecloak starter` prints the same text, and names `NOBLECLOAK_SP_CREDENTIALS` when the path came from it.
- 0ce98e3: `noblecloak starter` now says what to do while it waits: for the production and beta deployments it prints the Approvals URL, what the request is called there, how long it waits, and that Ctrl-C stops it and leaves the request open. A deployment given by explicit URLs keeps the old line without a link. `--json` output and exit codes are unchanged.
- Updated dependencies [6d265a1]
  - @noblecloak/client@0.14.2

## 0.2.1

### Patch Changes

- 8f8f11e: Documentation only, no code changes. `@noblecloak/client`: the problem-code table lists all 46 codes of the contract (seven were missing) and the examples use the hosted API origin. `@noblecloak/react`: the mock implements revision 18, the import table lists the `permissions` and `connections` entries, the examples use the hosted origins, and the Quickstart holds the embed snippet. `@noblecloak/setup-steps`: says who uses the rule today and drops the first-release note. `@noblecloak/cli`: the README no longer names pre-production hosts. `@noblecloak/spec`: the contract's example audience and `servers` entry name `https://govern.noblecloak.com` (the `env` server variable is gone), and its header no longer says the file is generated.
- 8f8f11e: README only: every package README now has an Install section, a usage section (Quickstart, Usage or Use) and a License section. `@noblecloak/cards` and `@noblecloak/setup-steps` gain Install; `@noblecloak/cli` and `@noblecloak/react` gain Quickstart; `@noblecloak/policy-formats` and `@noblecloak/theme` gain Usage; `@noblecloak/react` and `@noblecloak/theme` state the licence under a License heading. No code changes.
- 4a9cdca: `noblecloak starter` reuses the setup proposal the deployment opened when a service principal was created in the browser (a credential downloaded from the Team module), instead of opening a second one. `noblecloak sp create` never has a setup opened for it, so a credential from `sp create` is unchanged: the command declares its own agent. When the credential file has an `org_id` that is a UUID, the command reads the agent the deployment declares for the principal (`GET /v1/agents/{id}`). If that agent is bound to the principal, the setup is already applied and the command exits 13 without opening anything. Otherwise it opens the setup with the continuation the deployment stored on its own proposal, so the deployment answers with the proposal it already has open; the deployment matches per proposer and per continuation, so another administrator gets a second proposal, and whichever is approved second fails `policy_conflict` (reported as already set up). A 409 `rejected_duplicate` (an administrator rejected that proposal) exits 13 naming the rejected approval and says to create new credentials; the command does not fall back to a new agent. A 409 `continuation_conflict` is explained. The principal id is lower-cased once, as the deployment does. `--agent` and `--skip-setup` keep their meaning.

  `@noblecloak/client`: `GovernanceApi.getAgent(id)` reads an agent (`GET /v1/agents/{id}`), and a `Problem` carries `rejectedApprovalId` from a 409 `rejected_duplicate`.

- Updated dependencies [8f8f11e]
- Updated dependencies [4a9cdca]
  - @noblecloak/client@0.14.1

## 0.2.0

### Minor Changes

- 7ec6e0f: `noblecloak starter`, a starter agent that needs no model and no key but a service principal's. It signs you in for the govern audience, declares an agent and opens one `propose-policy-set` approval that binds the agent to the principal and grants it the sandbox's `tool:sandbox:create-note`; you approve it in Approvals. Then, as the principal, it opens an external run and an approval for one sandbox write with its exact arguments; you decide it in Approvals, and only if you approve it makes the one MCP `tools/call`. It checks before any approval that the principal can get a token for both the govern origin and the gateway audience, and exits with its own code for each way it can end: 10 no credentials, 11 an audience missing, 12 sandbox not available, 13 setup rejected, 14 write denied, 15 nobody decided in time, 16 approval already used. Its hosts default to production or, with `--deployment beta`, to beta; `--auth-url`, `--govern-url`, `--mcp-url` and `--gateway-audience` (and their `NOBLECLOAK_*` variables) replace any one. `--agent` reuses an agent, `--skip-setup` runs the write alone, `--wait` bounds each wait (the setup wait is cut to 840 seconds, inside the 15 minutes a freshly issued access token lasts; an older `--user-token-file` token may expire sooner). A wait that the network or a 5xx cuts is repeated until `--wait` is out. An explicit `--deployment` ignores the `NOBLECLOAK_*` host variables, and a credential for the other deployment is told to pass `--deployment`. The `sp` commands sign in exactly as before.

  `@noblecloak/client/governance-api`: `GovernanceApi.createApproval` (`POST /v1/approvals`) and `GovernanceApi.createAgent` (`POST /v1/agents`), with the `CreateApprovalRequest`, `ApprovalHandle`, `PolicySetProposal` and `Agent` types. A refused answer's `Problem` carries the body's `code` member as `refusalCode` (on `proposal_refused`, why) and its `reason` member as `reason` (on `service_unavailable`, the cause) when it has them; `code` stays the problem type.

### Patch Changes

- Updated dependencies [7ec6e0f]
  - @noblecloak/client@0.14.0

## 0.1.5

### Patch Changes

- Updated dependencies [5b4b045]
  - @noblecloak/client@0.13.1

## 0.1.4

### Patch Changes

- Updated dependencies [20a6b38]
- Updated dependencies [da6bdc6]
- Updated dependencies [2276872]
  - @noblecloak/client@0.13.0

## 0.1.3

### Patch Changes

- Updated dependencies [a208682]
  - @noblecloak/client@0.12.0

## 0.1.2

### Patch Changes

- First release on the public npm registry. No code change: the versions step past the ones published to the organisation's package registry so that the public release is strictly newer.
- Updated dependencies
  - @noblecloak/client@0.11.1

## 0.1.1

### Patch Changes

- Updated dependencies [5cf6237]
  - @noblecloak/client@0.11.0

## 0.1.0

### Minor Changes

- 719cf0a: Add `@noblecloak/cli`, the `noblecloak` command: `sp create`, `sp list`, `sp rotate` and `sp revoke` manage an organisation's service principals and write the credential file `@noblecloak/client/service-principal` loads.
