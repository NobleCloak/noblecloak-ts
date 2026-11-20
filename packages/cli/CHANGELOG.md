# @noblecloak/cli

## 0.2.1

### Patch Changes

- 8f8f11e: Documentation only, no code changes. `@noblecloak/client`: the problem-code table lists all 46 codes of the contract (seven were missing) and the examples use the hosted API origin. `@noblecloak/react`: the mock implements revision 18, the import table lists the `permissions` and `connections` entries, the examples use the hosted origins, and the Quickstart holds the embed snippet. `@noblecloak/setup-steps`: says who uses the rule today and drops the first-release note. `@noblecloak/cli`: the README no longer names pre-production hosts. `@noblecloak/spec`: the contract's example audience and `servers` entry name `https://govern.noblecloak.com` (the `env` server variable is gone), and its header no longer says the file is generated.
- 8f8f11e: README only: every package README now has an Install section, a usage section (Quickstart, Usage or Use) and a License section. `@noblecloak/cards` and `@noblecloak/setup-steps` gain Install; `@noblecloak/cli` and `@noblecloak/react` gain Quickstart; `@noblecloak/policy-formats` and `@noblecloak/theme` gain Usage; `@noblecloak/react` and `@noblecloak/theme` state the licence under a License heading. No code changes.
- Updated dependencies [8f8f11e]
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
