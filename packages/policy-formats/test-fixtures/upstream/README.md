# Upstream fixtures

Test fixtures copied byte for byte from the Microsoft Agent Governance Toolkit
(`github.com/microsoft/agent-governance-toolkit`), MIT License, Copyright (c) Microsoft Corporation. The
licence text is `LICENSE-agt`. They are used by the tests only and are not published (`files` in
`package.json` lists `dist`, `schemas`, `LICENSE` and `NOTICE`).

| Directory | Upstream ref |
| --- | --- |
| `agt-v5.0.0/` | tag `v5.0.0`, commit `c57d9d9a4849556a3c5347d359012d7a85bc3dfb` |
| `agt-main/` | `main`, commit `9c85646570e837aaa4d1709044ee2e10f2fefbf8` |

| File | Upstream path |
| --- | --- |
| `manifest.schema.json`, `approval.schema.json`, `cedar_advice.schema.json` | `policy-engine/spec/schema/` |
| `approval.cedar`, `agt_default.cedar` | `policy-engine/policy/cedar-lib/` |
| `readme-example.yaml` | the "Example manifest" block of `policy-engine/README.md` |
