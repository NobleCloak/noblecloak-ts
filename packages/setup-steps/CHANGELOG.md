# @noblecloak/setup-steps

## 0.1.0

### Minor Changes

- 6932969: New package: the first-run setup-step rule. `wizardSteps`, `wizardStepIds`, `inferFork`, `firstUnfinished`, `firstRunComplete`, `resolveWizardStart` and `setupProgress` (the "Setup n/N" count) read a structural subset of Core's `GET /organizations/{id}/setup` and derive the screens, their statuses, where setup opens and when the first run is complete. Pure TypeScript with no runtime dependencies and no validation: callers parse the response first. Screen copy stays in the app.
