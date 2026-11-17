# @noblecloak/setup-steps

The first-run setup-step rule, as one small package: which setup screens an org sees, each screen's
status, where `/setup` opens, when the first run is complete, and the "Setup n/N" count. One copy of the
rule, meant to be shared by noblesos-team's setup wizard, noblesos-shell's header pill and the CLI so they
cannot disagree. Those consumers switch to it in follow-up changes; until then each still holds its own copy.

It is pure TypeScript: no React, no `fetch`, no I/O, no clock, and **zero runtime dependencies**.

- **Screens:** `WIZARD_STEPS`, `WIZARD_STEP_IDS`, `WIZARD_EVENT_STEP_KEYS`, `wizardStepIds`, `wizardSteps`
- **Signals:** `toolsConnected`, `agentCredentials`, `scanShown`, `inferFork`, `FORKS`
- **Completion:** `firstUnfinished`, `firstRunComplete`
- **Where setup opens:** `resolveWizardStart`, `resolveInitialStep`, `NO_ARRIVAL`, `GITHUB_ERROR_CODES`
- **The pill:** `setupProgress`
- **Types and keys:** `SetupState`, `SetupStepRow`, `SetupArrival`, `SETUP_STEP_KEYS`, `isSetupStepKey`

## Use

```ts
import { firstRunComplete, setupProgress, wizardSteps } from '@noblecloak/setup-steps';

// `state` is the body of GET /organizations/{id}/setup, already parsed (see "Input" below).
const steps = wizardSteps(state); // the screens for this org, each with a status
firstRunComplete(steps); // every required screen is done

const pill = setupProgress(state); // { finished, total, stepKey, hidden }
if (!pill.hidden) console.log(`Setup ${pill.finished}/${pill.total}`);
```

`wizardSteps(state, fork)` reads the statuses under a fork: `apps` (people using Claude, Cursor or
another MCP app) or `own_agent` (something the admin builds). With no `fork` it uses `inferFork(state)`,
a guess from Core's own-agent outcomes, because Core does not store the fork. A caller that has the
admin's own pick passes it.

## What "n/N" means

N is the number of screens shown (Proof included; Scan only while Core reports the `discover` step
`live`; Invite only for the `team` intent). n is **not** the wizard's position: it is the count of
screens that are `done` or `skipped`, so a fresh org reads "Setup 0/4" while the wizard shows "Step 1 of
4". The pill is `hidden` when the checklist was dismissed or the first run is complete.

## Input: validate before you call

The rule takes `SetupState`, the structural subset of Core's setup read that it uses:
`steps[].key/state/availability`, `intent`, `app_authorized.done`, `setup_proposal_approved.done`,
`held_action_decided.done` and `dismissed`. It does **no validation**, so a malformed object gives a
wrong answer, not an error. Parse the response first (noblesos-team uses a zod schema) and apply the
degrade rules the types document:

- an unknown step `state` reads `unknown`, never done;
- an unknown `availability` reads `disabled`;
- an unknown `intent` reads `null`;
- a missing `app_authorized`, `setup_proposal_approved` or `held_action_decided` reads `{ done: null }`.

A richer object (extra members such as `lanes`, `detail` or `first_done_at`) is accepted unchanged, with
no cast: the rule reads only the members above. The members it does read are required, though. The
shell's setup snapshot must carry `steps[].availability`, `setup_proposal_approved` and
`held_action_decided` (defaulting each of the last two to `{ done: null }`) to satisfy `SetupState`;
do not cast around a missing one, because a cast turns a missing answer into a wrong one.

## What adopting it changes

- **The pill counts Scan and the fork.** Scan is a screen when Core reports `discover` live, so the pill's
  N includes it, and the pill reads statuses under the fork, so an own-agent org's Connect, Approve and
  Try it follow the own-agent signals.
- **The fork is a guess until it is stored.** For an own-agent admin who has no own-agent outcome yet (no
  approved setup proposal, no decided held action), a consumer that does not have the admin's pick, such
  as the pill, reads the `apps` fork. That holds until the fork is stored server-side; the wizard, which
  holds the pick, passes it as `fork`.

## Attaching copy

A screen here has structural fields only: `id`, `keys`, `eventKey`, `required`, `skipKey`. Titles, the
"why" sentence and the "what to do" list belong to the app, which keeps them in a record keyed by screen id
and merges the one for the fork in use:

```ts
import { wizardSteps, type WizardStepId } from '@noblecloak/setup-steps';

interface Copy {
  title: string;
  why: string;
  todo: readonly string[];
}

const COPY: Record<WizardStepId, Copy> = {/* scan, connect, approve, invite, try, proof */};
// Only the screens whose completion rule changes with the fork need a second entry.
const OWN_AGENT_COPY: Partial<Record<WizardStepId, Copy>> = {/* connect, approve, try */};

const screens = wizardSteps(state, fork).map((step) => ({
  ...step,
  ...COPY[step.id],
  ...(step.fork === 'own_agent' ? OWN_AGENT_COPY[step.id] : undefined),
}));
```

What stays in the app: that copy, the wait and poll rules (which screens poll Core, at what interval),
and `reachable` and `mayStayOpen`, the Proof navigation helpers.

## Release

The first npm version of this package is published by hand by a maintainer: `scripts/release.ts`
skips a package npm has never seen. Later versions go through the normal Changesets path.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
