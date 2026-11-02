# Skills

One directory per module, each holding the agent skill that installs and wires that module. This directory is
not a workspace and is not published. A skill is authored once here, in the Agent Skills
format (`SKILL.md` with `name` and `description` frontmatter, plus the scripts and templates it ships), and the
Claude Code plugin bundles it rather than keeping a copy.

| Skill                           | What it does                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`approvals`](./approvals/)     | Wires the Approvals module into a Next.js App Router app: the `/approvals` route, the provider, a token getter, the callback                    |
| [`permissions`](./permissions/) | Wires the Permissions module into a Next.js App Router app: the `/permissions` route, the provider with its roles, a token getter, the callback |
| [`connections`](./connections/) | Wires the Connections module into a Next.js App Router app: the `/connections` route, the provider, a token getter, the callback                |

## How a skill is tested

`bun run exercise:skill` (`scripts/skill-exercise.ts`) is the acceptance test of the approvals skill,
`bun run exercise:skill --skill permissions` that of the permissions skill and `bun run exercise:skill --skill connections`
that of the connections skill; CI runs the same script (`skill / approvals`, `skill / permissions`,
`skill / connections`). The permissions and connections runs have the mock stage only (`e2e/permissions.spec.ts`,
`e2e/connections.spec.ts`): the sign-in spec covers the approvals route. It packs the workspace's public packages and installs `@noblecloak/react`, `@noblecloak/client` and
`@noblecloak/theme` from those tarballs, scaffolds a fresh Next.js app with a pinned `create-next-app`, applies the skill with its own
script (`--source <tarballs>`, because the packages are not on npm until the public release; a user's steps
say `bun add @noblecloak/react`), then builds and end-to-end tests the app in both modes, and compares the
files the skill generated with the example's. It fails if a spec fails or the files differ (aliases
resolved; both sides formatted by prettier with fixed options and the binding imports sorted, so string and
template literals and the order of side-effect imports still count).
It writes the wall time of each step to `artifacts/skill-exercise-wall-time.json`.

The two modes run one after the other, each a build of its own because `next build` inlines the
`NEXT_PUBLIC_*` values (`e2eStages` in `scripts/skill-exercise.ts`). Mock mode runs `examples/next-app`'s
Playwright approvals spec against the mock server. Sign-in mode builds the app with the environment the
example's own sign-in build gets (`NC_E2E_MODE=oidc` in `playwright.config.ts`) and runs `e2e/signin.spec.ts`:
the sign-in callback's denied and granted paths through the generated `auth.ts`, `CallbackClient.tsx`,
`callback/page.tsx` and token getter. The test answers for the sign-in service and the API itself, so this
stage needs no sign-in service and no network. That spec's check that no policy was violated passes
trivially on the generated app, which has no content-security policy. Each mode serves the app on its own port
(3100 and 3101 by default; `NC_E2E_APP_PORT` and `NC_E2E_OIDC_APP_PORT`).

That figure is the script's own steps only: it excludes `bun install` and the Playwright browser install
(separate CI steps, listed in the file's `excludes`), and a local run is warm (turbo cache, installed
browser), so it is not comparable with the first CI run on cold caches. A run with `--skip-e2e` (both
builds, neither spec; the file lists the two specs under `skipped`), and a run in
which a step failed (the file then names it in `failedStep`, and the script still exits non-zero), are marked
`"complete": false` in the file and are not the acceptance result.

## What is not in a skill yet

`approvals` generates the route, the provider and token getter (with the switch between sign-in and mock
mode, `config.ts` and `ApprovalsExample.tsx`), the sign-in callback and the stylesheet import.
`examples/next-app` also has the content-security policy (`app/csp.ts`), `proxy.ts`, the health route and the
callback route's `Cache-Control: no-store` and `Referrer-Policy: no-referrer` headers (`next.config.ts`; the skill's steps have the user add them by hand). They are excluded from the
comparison and from the skill for now: generated middleware or configuration could clash with what the project
already has. They are the next step, not out of scope for good:
the aim is for the skill to provide the whole approvals surface. To widen it, add the file under
`approvals/templates/` and to `COMPARED_FILES` in `scripts/skill-compare.ts` (a test fails when the two lists
differ). Every file of the example under `app/approvals/` is in `COMPARED_FILES` or in `EXCLUDED_FILES` (the
example's unit tests, for now), and a test fails on one that is in neither, so a new example file there is
compared or excluded on purpose. The example's end-to-end tests that assert the policy are tagged `@csp`, and the one that asserts
the callback headers is tagged `@callback-headers`; the skill's run leaves both out (`SKILL_RUN_EXCLUDED_TAGS`
in `scripts/skill-compare.ts`) until the skill generates them, and the example's own run keeps them.
