---
'@noblecloak/policy-formats': minor
---

Rev 16 rules, approvers and exclude in Cedar and AGT. A `tool_invocation` policy with `rules`, `approvers` or `exclude` now exports instead of landing in `unsupported`. A policy with rules is written as one statement with the tightest outcome it can reach (its mode, every rule's result, and `ask` when a rule tests a fact other than by `exists`), marked `@noblecloak_encoding("rules_tightest")`; `rules`, `approvers` and `exclude` ride verbatim in `@noblecloak_rules`, `@noblecloak_approvers` and `@noblecloak_exclude`, so an import restores the exact policy, and each is reported `lossy` by member. The import recomputes the outcome and treats a body that no longer equals it as a conflict. `approval_routing` stays unsupported, with a reason that says it is an organisation setting. The dialect schemas are unchanged, and so are the existing golden files.
