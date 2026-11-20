# @noblecloak/setup-steps

## 0.1.1

### Patch Changes

- 8f8f11e: Documentation only, no code changes. `@noblecloak/client`: the problem-code table lists all 46 codes of the contract (seven were missing) and the examples use the hosted API origin. `@noblecloak/react`: the mock implements revision 18, the import table lists the `permissions` and `connections` entries, the examples use the hosted origins, and the Quickstart holds the embed snippet. `@noblecloak/setup-steps`: says who uses the rule today and drops the first-release note. `@noblecloak/cli`: the README no longer names pre-production hosts. `@noblecloak/spec`: the contract's example audience and `servers` entry name `https://govern.noblecloak.com` (the `env` server variable is gone), and its header no longer says the file is generated.
- 8f8f11e: README only: every package README now has an Install section, a usage section (Quickstart, Usage or Use) and a License section. `@noblecloak/cards` and `@noblecloak/setup-steps` gain Install; `@noblecloak/cli` and `@noblecloak/react` gain Quickstart; `@noblecloak/policy-formats` and `@noblecloak/theme` gain Usage; `@noblecloak/react` and `@noblecloak/theme` state the licence under a License heading. No code changes.

## 0.1.0

### Minor Changes

- 6932969: New package: the first-run setup-step rule. `wizardSteps`, `wizardStepIds`, `inferFork`, `firstUnfinished`, `firstRunComplete`, `resolveWizardStart` and `setupProgress` (the "Setup n/N" count) read a structural subset of Core's `GET /organizations/{id}/setup` and derive the screens, their statuses, where setup opens and when the first run is complete. Pure TypeScript with no runtime dependencies and no validation: callers parse the response first. Screen copy stays in the app.
