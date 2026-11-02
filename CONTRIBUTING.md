# Contributing to noblecloak-ts

## Developer Certificate of Origin

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/):

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds the line. There is no CLA.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(client): …`, `fix(react): …`,
`chore: …`, `docs: …`.

## Changesets

A change to any publishable package under `packages/` needs a changeset. Run `bun run changeset`,
select the packages and the bump, and commit the generated `.changeset/*.md` with your change.
Examples and the private tooling workspace are not versioned.

## Releases

On every push to `main`, `publish.yml`'s `version` job runs `changesets/action`, which opens or
updates the "Version Packages" pull request from the pending changesets. That job publishes
nothing, and it is the only job in any workflow with `contents` or `pull-requests` write. The
`publish` job alone holds `id-token: write`, which npm trusted publishing needs. The
`publish-github-packages` job alone holds `packages: write`, which publishing to the NobleCloak
GitHub Packages registry needs. Neither installs or builds anything. Every job that holds a write
permission checks out with `persist-credentials: false`, so the token is not left in `.git/config`
for dependency code to read; `changesets/action` authenticates with the token it is handed.
`repo-policy.test.ts` enforces all of this. It needs the repository setting "Allow
GitHub Actions to create and approve pull requests" (Settings, Actions, General), which
`gh api repos/NobleCloak/noblecloak-ts/actions/permissions/workflow` reports as
`can_approve_pull_request_reviews: true`. Without it the job fails with a permissions error.

The version pull request is opened with the workflow's own `GITHUB_TOKEN`, and GitHub does not
start workflows for events that token causes. So `ci`, `stranger-install` and the other
pull-request checks do **not** run on it by themselves, and branch protection that requires them
keeps it unmergeable. Before merging it, a maintainer **closes and reopens** the pull request
(`gh pr close <n> && gh pr reopen <n>`); the reopen is a human event, so every pull-request
workflow runs on the head commit. Repeat after each new push by the bot. This step goes away if the
job moves to a GitHub App token, which needs a secret and so waits for the flip to public.

`publish.yml`'s `publish` job (`scripts/release.ts`) publishes each package version npm does not
have yet, from the tarballs the `pack` job built. A package npm has never seen is skipped with a
warning, because its first publish is manual. Before publishing
anything, the job reads each publishing package's packed `package.json` and checks every
`@noblecloak/*` entry in its `dependencies` and `peerDependencies`: the exact version must already
be on npm or be published by the same run. If one is not, for example `@noblecloak/react` needs a
`@noblecloak/theme` that was never seeded, the run publishes nothing and fails. Otherwise it
publishes dependencies before dependents and stops at the first failed publish.

`publish.yml`'s `publish-github-packages` job runs the same script with
`--registry https://npm.pkg.github.com`, only in the NobleCloak organisation and only when the
repository variable `PRIVATE_PUBLISH_ENABLED` is `true`. It reads only the job's own `github.token`.
It publishes the six public packages named in `GITHUB_PACKAGES_ALLOWLIST` in `scripts/release.ts`
and prints a skip for any other tarball. For each version it asks the registry: a 404 publishes, a
version the registry has is skipped, and any other error fails the run. It passes neither
`--provenance` nor `--access`, because GitHub Packages ignores `access` and gives a package the
visibility of the repository its `repository.url` names. It never publishes to npm.

## Local gate

CI runs the same five tasks. Run them before you open a pull request:

```sh
bun install --frozen-lockfile
bun run gate      # turbo run format:check lint typecheck test build
bun run guard     # no private dependencies, no GitHub Packages registry, Apache-2.0 everywhere
```

`bun install` also points git at `.githooks/` (the root `prepare` script sets `core.hooksPath`),
whose `pre-commit` hook runs `bun run guard`, so a private dependency is caught before it is
committed. CI runs the guard again.

Always use `bun run test`, never `bun test`: every package runs vitest with coverage, and each
package fails below 80% lines, functions, branches or statements.

## Working in `packages/spec`

These are scripts of the `packages/spec` package, not root scripts: run them from that directory
(`cd packages/spec && bun run <script>`).

```sh
bun run spec:lint                                    # Spectral, with the contract rules
bun run build:public                                 # check openapi.public.yaml and copy it into dist/
bun run conformance:mock                             # the suite against the mock, then the broken-mock matrix
```

`openapi.public.yaml` is the contract. It is generated by this repository's build (`bun run build` at the root
rewrites it); do not edit it by hand. A change to it comes with its scenarios and a regenerated
client (`bun run --cwd packages/client generate`).

## Rules the tree enforces

- No dependency outside the public npm registry, and no reference to `npm.pkg.github.com` in install
  configuration (`.npmrc`, `bunfig.toml`, `bun.lock`, `publishConfig`), which `bun run guard`
  enforces. `publish.yml` and `scripts/release.ts` name the registry only to publish to it.
  Everything here must install from the public npm registry with no credentials.
- Every `package.json` declares `"license": "Apache-2.0"` and `"author": "NobleCloak"`.
- No `any`. Type-only imports use `import type`. Relative imports end in `.js`.
- Dependencies are pinned to exact versions. Dependabot opens one grouped pull request per
  ecosystem per week (`.github/dependabot.yml`); a security fix or a superseding pull request may
  bump by hand, regenerating `bun.lock` with `bun install`. Dependabot does not move the bun version (`packageManager`), the Node version
  (`.node-version`) or the actionlint image digest in `ci.yml`; the weekly `toolchain-currency`
  workflow (`bun run check:toolchain`) fails when one lags, and the fix is a manual bump.

## Toolchain pins

Every version is the latest the registry offers, except those below. Each entry names what holds
it back and when to lift it. `repo-policy.test.ts` fails if a pin moves without this section
moving with it.

- **`typescript` 6.x**, at its latest release. `typescript-eslint` (and its
  `@typescript-eslint/typescript-estree`) declare a `typescript` peer range that stops short of 7,
  so the linter does not support TypeScript 7. The whole repository uses one TypeScript version;
  6 and 7 are never mixed. `repo-policy.test.ts` reads the installed linter's peer range, so the
  grouped Dependabot bump that brings a widened range fails that test. **Lift when** it does:
  move `typescript` to 7.x and delete the `typescript` entry from `ignore:` in
  `.github/dependabot.yml`. Upstream tracking issue:
  [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940).
- **`@types/node` 24.x** tracks the Node line in `.node-version` (24, the current LTS), so the
  types describe the runtime CI uses. A newer major describes APIs the pinned Node does not have.
  **Lift when** `.node-version` moves to a new LTS line (the weekly toolchain-currency workflow
  fails when one exists): bump both in the same pull request and delete the `@types/node` entry
  from `ignore:` in `.github/dependabot.yml`.
