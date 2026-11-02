# noblecloak-ts

Governance UI modules, the module API contract, and runtime adapters for NobleCloak.

> Built to open-source standards: Apache-2.0, public-registry
> dependencies only, no credentials needed to install, build or test.

## Packages

| Package                      | Path                              | Status                            |
| ---------------------------- | --------------------------------- | --------------------------------- |
| `@noblecloak/spec`           | `packages/spec`                   | built, unpublished until the flip |
| `@noblecloak/client`         | `packages/client`                 | built, unpublished until the flip |
| `@noblecloak/cli`            | `packages/cli`                    | built, unpublished until the flip |
| `@noblecloak/react`          | `packages/react`                  | built, unpublished until the flip |
| `@noblecloak/theme`          | `packages/theme`                  | built, unpublished until the flip |
| `@noblecloak/policy-formats` | `packages/policy-formats`         | built, unpublished until the flip |
| `@noblecloak/cards`          | `packages/cards`                  | built, on no publish allowlist    |
| `@noblecloak/webhook`        | `packages/adapters/webhook`       | deferred (private, not in v1)     |
| `@noblecloak/ai-sdk`         | `packages/adapters/ai-sdk`        | deferred (private, not in v1)     |
| `@noblecloak/openai-agents`  | `packages/adapters/openai-agents` | deferred (private, not in v1)     |
| `n8n-nodes-noblecloak`       | `packages/adapters/n8n`           | deferred (private, not in v1)     |

`packages/skills` and `examples/next-app` are not published.

Published adapters live in their own repositories (`noblecloak-langgraph-ts`; `noblecloak-langgraph-py` is
reserved); `packages/adapters/` holds deferred, unpublished adapters. Documentation is not hosted from
this repository; it lives at docs.noblecloak.com, which renders the `/v1` reference from the
published `@noblecloak/spec` package.

## Five-minute builder path

This path fills in as the modules land. When it is complete it will be: install a module
(`bun add @noblecloak/react`), point it at an API, and see an approvals queue rendered against the
mock server. Until then, `examples/next-app` is the fixture the modules run against, and it already embeds
the approvals queue (`/approvals`, against the mock or a deployment; see its README):

```sh
bun install
bun run build
cd examples/next-app && bun run dev   # http://localhost:3000, GET /api/health, /approvals
```

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
