# @noblecloak/policy-formats

## 0.2.1

### Patch Changes

- Updated dependencies [20a6b38]
- Updated dependencies [da6bdc6]
- Updated dependencies [2276872]
  - @noblecloak/client@0.13.0

## 0.2.0

### Minor Changes

- a208682: Rev 16 rules, approvers and exclude in Cedar and AGT. A `tool_invocation` policy with `rules`, `approvers` or `exclude` now exports instead of landing in `unsupported`. A policy with rules is written as one statement with the tightest outcome it can reach (its mode, every rule's result, and `ask` when a rule tests a fact other than by `exists`), marked `@noblecloak_encoding("rules_tightest")`; `rules`, `approvers` and `exclude` ride verbatim in `@noblecloak_rules`, `@noblecloak_approvers` and `@noblecloak_exclude`, so an import restores the exact policy, and each is reported `lossy` by member. The import recomputes the outcome and treats a body that no longer equals it as a conflict. `approval_routing` stays unsupported, with a reason that says it is an organisation setting. The dialect schemas are unchanged, and so are the existing golden files.

### Patch Changes

- Updated dependencies [a208682]
  - @noblecloak/client@0.12.0

## 0.1.5

### Patch Changes

- First release on the public npm registry. No code change: the versions step past the ones published to the organisation's package registry so that the public release is strictly newer.
- Updated dependencies
  - @noblecloak/client@0.11.1

## 0.1.4

### Patch Changes

- Updated dependencies [5cf6237]
  - @noblecloak/client@0.11.0

## 0.1.3

### Patch Changes

- Updated dependencies [40c58bd]
  - @noblecloak/client@0.10.0

## 0.1.2

### Patch Changes

- Updated dependencies [d427655]
  - @noblecloak/client@0.9.0

## 0.1.1

### Patch Changes

- Updated dependencies [ed41848]
  - @noblecloak/client@0.8.0

## 0.1.0

### Minor Changes

- b0add75: First release: NobleCloak `tool_invocation` policies to and from Cedar (NobleCloak dialect, every form) and
  AGT (an ACS manifest with an inline Cedar policy set bound at `pre_tool_call`, for AGT 5.0 and AGT main),
  client-side and pure. `exportCedar` and `exportAgt` return the file and a report of what each format
  cannot carry, also written as the file's leading comment block; `importCedar` and `importAgt` (from
  `@noblecloak/policy-formats/import`, which loads the optional peer `@cedar-policy/cedar-wasm` 4.14.0 on
  first use) return `PolicyWrite`s, what was unsupported, lossy or in conflict, and the file's origin
  (`{ format, digest }`). `canonicalPolicy` and `diffPolicies` compare policies; `detectFormat` tells the
  formats apart. A policy this package exported re-imports to the same canonical policy, and a file it wrote
  re-exports to the same bytes (with its
  comment block, when that export reported nothing beyond the policies the file holds).

  Rulings (David, 2026-10-22):

  - AGT export defaults to the latest release, 5.0 (manifest `0.3.1-beta`); `agtVersion: 'main'` writes
    `0.4.0-alpha.1`. Import accepts all six manifest versions the two engines accept.
  - `ask` and `escalate` are never written as a bare `permit` for an engine without approvals: in Cedar, and
    for AGT 5.0 unless `adviceAwareDispatcher: true`, they are a `forbid` marked
    `@noblecloak_encoding("fail_closed")`, reported as lossy. AGT main writes a `permit` with `@advice`
    escalate whose reason is `noblecloak.<mode>:<policy id>`.
  - `not_granted` is a `forbid` (a deny). `toolNames` maps `tool_ref`s to AGT tool names; without an entry
    the `tool_ref` is the name.

  Ruling (quarterback for David, 2026-10-23): a subject a format cannot express (in AGT: user, role, group,
  service) is dropped and reported, and the policy is exported for its other subjects, never omitted
  whole; a policy with no expressible subject is not exported.

- bde6fbe: Exports write no bidirectional control and no other default-ignorable code point raw (Trojan Source): a comment line,
  a Cedar string literal and a YAML scalar escape them visibly (`\uXXXX`, `\u{…}` in Cedar, `\UXXXXXXXX` in YAML above
  the Basic Multilingual Plane), with the interlinear annotation marks U+FFF9–FFFB, so a file reads as it evaluates. An
  import reads the escapes back, so every round trip holds. `commentSafe` (the rule for a comment line) is exported
  from the root entry.

### Patch Changes

- Updated dependencies [8d2f70d]
- Updated dependencies [cadb241]
- Updated dependencies [8b78e53]
- Updated dependencies [ea5f3f7]
- Updated dependencies [52347dd]
  - @noblecloak/client@0.7.0
