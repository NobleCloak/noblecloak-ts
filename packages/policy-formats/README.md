# @noblecloak/policy-formats

Converts NobleCloak `tool_invocation` policies to and from two foreign formats, with a report of everything
a format cannot carry:

- **Cedar**, in NobleCloak's dialect (`schemas/noblecloak.cedarschema`): every `tool_invocation` form.
- **AGT**: a Microsoft Agent Governance Toolkit manifest (an Agent Control Specification manifest in YAML)
  that binds one inline Cedar policy set, in AGT's dialect, at `pre_tool_call`. AGT 5.0 (the latest
  release) and AGT's main branch.

It is pure: no network and no React. It runs in a browser, in Node and in Bun. Nothing is lost silently:
each construct a format cannot carry is listed with a JSON-pointer path and a reason.

- **Install**
- **Export:** `exportCedar`, `exportAgt`
- **Import:** `importCedar`, `importAgt` (from `@noblecloak/policy-formats/import`)
- **Round trip:** `canonicalPolicy`, `diffPolicies`
- **What each format carries**
- **Schemas**, **License**

## Install

```sh
npm install @noblecloak/policy-formats
# Only to import files:
npm install @cedar-policy/cedar-wasm@4.14.0
```

Exporting needs nothing else. Importing parses Cedar with `@cedar-policy/cedar-wasm` 4.14.0, an optional
peer dependency of about 4.4 MB. The import entry loads it with a dynamic `import()` on the first call,
and the root entry never imports it, so an app that only exports never bundles it.

## Export

```ts
import { exportAgt, exportCedar } from '@noblecloak/policy-formats';

const cedar = exportCedar(policies); // policies: Policy[] as the API reads them
const agt = exportAgt(policies, tools, { agtVersion: '5.0' }); // tools: the tool inventory
// { text, lossy, unsupported, notes }
```

Each export returns the file and its report. `lossy` lists what was exported but is not enforced as
NobleCloak enforces it; `unsupported` lists what was not exported at all; `notes` holds file-wide
statements. The text opens with a comment block that says the same, so the file itself records what it
lost. A policy that is not a valid `tool_invocation` policy is not exported. A subject the format has no
principal for (in AGT: `user`, `role`, `group`, `service`) is dropped and reported in `unsupported`, and
the policy is exported for its other subjects. A narrower `permit` allows less; a narrower `forbid` still
denies its other subjects, where leaving the policy out would deny none of them (a dropped subject is then
governed by the other statements, and by the baseline if one is written). A policy with no expressible
subject is not exported. Importing such a file gives the narrower policy, which `diffPolicies` shows as a change.

`exportAgt` takes the organisation's **whole** set of `tool_invocation` policies and the tool inventory:
a manifest binds one policy per intervention point, so it replaces whatever is bound at `pre_tool_call`,
and AGT fails a call to a tool missing from the manifest's `tools` catalog closed. Its options:

| Option                  | Meaning                                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agtVersion`            | `'5.0'` (default): manifest version `0.3.1-beta`. `'main'`: `0.4.0-alpha.1`.                                                                                                                                         |
| `adviceAwareDispatcher` | Whether the host's Cedar dispatcher turns a permit's `@advice` escalate into an approval. Default `true` for `main`, `false` for `5.0`. When `false`, `ask` and `escalate` are written as a `forbid` (fail closed).  |
| `toolNames`             | `tool_ref` → the tool name AGT sees. AGT's adapters pass the framework's own tool name (for MCP, the bare tool name), so without an entry a statement matches only where the host passes the `tool_ref` as the name. |
| `resolver`              | The manifest's `approval` block, written as given. Absent, none is written.                                                                                                                                          |
| `baseline`              | `'allow'` adds a statement that permits every call no other statement forbids.                                                                                                                                       |

`exportCedar` takes `baseline` only.

## Import

```ts
import { importAgt, importCedar } from '@noblecloak/policy-formats/import';

const result = await importCedar(fileBytesOrText);
// { policies: [{ key?, write }], unsupported, lossy, conflicts, notes, origin, options }
```

`policies[].write` is a `PolicyWrite` to save as a draft; `key` is the id of the policy that was exported
(absent for a statement written elsewhere). `origin` is `{ format, digest }`, the digest being the
lowercase hex SHA-256 of the file's bytes, for recording where a policy came from. Pass the file as a
`Uint8Array` (`await file.arrayBuffer()`): text read with `FileReader.readAsText` has lost a byte-order
mark and any invalid bytes, so its digest is not the file's. `options` (and, for
AGT, `tools`) are what `exportCedar`/`exportAgt` need to write the same file again.

A statement this package wrote imports exactly: its `@noblecloak_*` annotations carry what Cedar cannot.
**The body is authoritative**: when the effect, principal or tools disagree with the annotations, the
statement is a `conflict` and nothing of its policy is imported. The one sanctioned difference is
`@noblecloak_encoding("fail_closed")`, which marks an `ask` or `escalate` policy written as a `forbid`.
A statement written elsewhere imports by its body: `permit` → `always_allow`, `forbid` → `deny`, a `permit`
with `@advice` escalate → `ask`.

Errors: `PolicyFormatError` with `code` `parse_error` (not Cedar, not one YAML mapping, not UTF-8, or a
statement nested deeper than 64 brackets or longer than 2,048 tokens, which cedar-wasm 4.14.0
cannot parse without exhausting its memory, or a file over 32 MiB),
`invalid_input` (an export given two policies with one id, a tool name map that gives two tools one name)
or `cedar_unavailable` (the peer could not be loaded; pass `opts.cedar`, for example
`() => import('@cedar-policy/cedar-wasm/nodejs')`).

`detectFormat(text)` returns `'agt'`, `'cedar'` or `undefined` from the file's shape.

## Round trip

- **Model round trip:** for every policy a format supports, importing its export gives a policy whose
  `canonicalPolicy` equals the original's. `canonicalPolicy` is RFC 8785 JSON of the `PolicyWrite`
  members, with `targets` explicit, `subjects` sorted by type then id, `targets.tools` sorted with
  duplicates kept, and `approver_groups` in its own order.
- **File round trip:** for a file this package wrote, exporting what was imported (with the returned
  `options`, and `tools` for AGT) writes the same bytes, when the export reported nothing about policies
  the file does not hold: a `Not exported` line, unenforced targets or a member the export did not read
  is in the comment block only, so a re-export cannot write it again. The statements and the manifest
  are the same bytes either way. The printers are this package's own, not Cedar's formatter, so the bytes
  do not change with a cedar-wasm release.
- A file written elsewhere keeps its meaning, not its bytes: comments and layout are not kept, and the
  result's `notes` says so.

`diffPolicies(current, incoming)` lists the differences between two policies' canonical forms (subjects
and tools as sets), for showing what an import would change.

## What each format carries

Each exported statement carries `@noblecloak_policy` (the policy id), `@noblecloak_kind`,
`@noblecloak_mode` and, when present, `@noblecloak_name`, `@noblecloak_description`,
`@noblecloak_on_deny`, `@noblecloak_expires_after` and `@noblecloak_approver_groups`, then `@id` set to
`noblecloak.<mode>:<policy id>`. On AGT main that `@id` is the deny reason, and an `@advice` escalate
carries the same string as its `reason`, the one per-policy string that reaches an AGT approval resolver.

### Cedar (NobleCloak dialect)

| NobleCloak                                    | Cedar                                                                                         | Class                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `user`, `agent`, `service` subject            | `principal == NobleCloak::User::"<id>"` (`Agent`, `Service`)                                  | exact                                                       |
| `role`, `group` subject                       | `principal in NobleCloak::Role::"<key>"` (`Group`)                                            | exact (the evaluator needs membership entities)             |
| `organization` subject                        | unconstrained `principal`                                                                     | exact                                                       |
| one tool / several / all                      | `resource == NobleCloak::Tool::"<ref>"` / `when { [...].contains(resource) }` / unconstrained | exact                                                       |
| `always_allow`, `deny`                        | `permit`, `forbid`                                                                            | exact                                                       |
| `ask`, `escalate`                             | `forbid` + `@noblecloak_encoding("fail_closed")`                                              | lossy: a Cedar engine has no approval outcome, so it denies |
| `not_granted`                                 | `forbid`                                                                                      | lossy: denied without the reason `not_granted`              |
| `on_deny`, `expires_after`, `approver_groups` | annotations                                                                                   | lossy: not enforced                                         |
| `name`, `description`                         | annotations                                                                                   | exact                                                       |
| `duplicate_requests`, `spending`              | none                                                                                          | unsupported                                                 |

### AGT

| NobleCloak                                                 | AGT                                                                                                                   | Class                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `agent` subject                                            | `principal == Agent::"<id>"`                                                                                          | exact                                                                      |
| `organization` subject                                     | unconstrained `principal`                                                                                             | lossy: exact only when the manifest is deployed for the organisation alone |
| `user`, `role`, `group`, `service` subject                 | none (AGT names no end user)                                                                                          | unsupported: the subject is dropped, the policy exported for its others    |
| one tool / several / all                                   | `resource == Tool::"<name>"` / `when { [...].contains(resource) }` / unconstrained; every tool in the `tools` catalog | exact with `toolNames`; otherwise the `tool_ref` is the name               |
| `always_allow`, `deny`                                     | `permit`, `forbid`                                                                                                    | exact                                                                      |
| `ask`, `escalate` with an advice-aware dispatcher          | `permit` + `@advice` escalate                                                                                         | lossy: one approval path; ask and escalate are not told apart              |
| `ask`, `escalate` otherwise (AGT 5.0's bundled dispatcher) | `forbid` + `@noblecloak_encoding("fail_closed")`                                                                      | lossy: denied                                                              |
| `not_granted`                                              | `forbid`                                                                                                              | lossy: the reason                                                          |
| `on_deny`, `expires_after`, `approver_groups`              | annotations                                                                                                           | lossy: not enforced                                                        |
| `duplicate_requests`, `spending`                           | none                                                                                                                  | unsupported                                                                |

On import, AGT `rego`, `custom` and `test` policies, intervention points other than `pre_tool_call`,
`extends`, `annotators`, `policy_path`, conditions on `context`, and `@advice` `warn` or `transform` are
reported and not imported. The `approval` block is returned as `options.resolver`. A call no policy
matches is denied by both engines; neither export adds a permit unless `baseline: 'allow'` is passed.

## Schemas

`schemas/noblecloak.cedarschema` and `schemas/agt.cedarschema` (also exported as
`NOBLECLOAK_CEDAR_SCHEMA` and `AGT_CEDAR_SCHEMA`) describe the statements the exports write, for
validating an export with cedar-wasm's `validate`. Neither declares a request context; the AGT one is not
meant as an AGT `schema_path`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
