# noblecloak-ts

Governance UI modules, the module API contract, and runtime adapters for NobleCloak.

> Built to open-source standards: Apache-2.0, public-registry
> dependencies only, no credentials needed to install, build or test.

## Packages

| Package                      | Path                              | Status                        |
| ---------------------------- | --------------------------------- | ----------------------------- |
| `@noblecloak/spec`           | `packages/spec`                   | published on npm              |
| `@noblecloak/client`         | `packages/client`                 | published on npm              |
| `@noblecloak/cli`            | `packages/cli`                    | published on npm              |
| `@noblecloak/react`          | `packages/react`                  | published on npm              |
| `@noblecloak/theme`          | `packages/theme`                  | published on npm              |
| `@noblecloak/policy-formats` | `packages/policy-formats`         | published on npm              |
| `@noblecloak/cards`          | `packages/cards`                  | published on npm              |
| `@noblecloak/setup-steps`    | `packages/setup-steps`            | published on npm              |
| `@noblecloak/webhook`        | `packages/adapters/webhook`       | deferred (private, not in v1) |
| `@noblecloak/ai-sdk`         | `packages/adapters/ai-sdk`        | deferred (private, not in v1) |
| `@noblecloak/openai-agents`  | `packages/adapters/openai-agents` | deferred (private, not in v1) |
| `n8n-nodes-noblecloak`       | `packages/adapters/n8n`           | deferred (private, not in v1) |

`packages/skills` and `examples/next-app` are not published.

Published adapters live in their own repositories (`noblecloak-langgraph-ts`; `noblecloak-langgraph-py` is
public and not yet released); `packages/adapters/` holds deferred, unpublished adapters. Documentation is
not hosted from this repository; it lives at docs.noblecloak.com, whose approvals guides are copied from
this repository's `docs/`.

## Five-minute builder path

`examples/next-app` embeds the Approvals, Permissions and Connections modules and runs against the
reference mock server with no sign-in service, or against a deployment (see its README):

```sh
bun install
bun run build
cd examples/next-app && bun run dev   # http://localhost:3000, GET /api/health, /approvals
```

In your own app, install a module (`bun add @noblecloak/react`) and follow
[`packages/react/README.md`](packages/react/README.md).

## Development

Bun is the package manager (version pinned in `package.json` `packageManager`). Node (version in
`.node-version`) runs vitest and Next.js.

```sh
bun install --frozen-lockfile
bun run gate     # format:check, lint, typecheck, test (with 80% coverage thresholds), build
bun run guard    # private-dependency guard
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright 2026 NobleCloak. Licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE)
and [`NOTICE`](NOTICE).
