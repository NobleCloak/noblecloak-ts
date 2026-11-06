---
'@noblecloak/client': minor
---

A `@noblecloak/client/governance-api` subpath: `GovernanceApi`, the typed `/v1` operations a governed runtime calls (capabilities, jwks, createRun, decide, approvals get, wait, list and stream, resumption, consume, withdraw, appendRecord), each returning the unwrapped `data` or a `Problem`. A network failure, a 5xx or an unreadable body throws `ModuleApiError('unreachable')`; the `isPassThrough` option re-throws chosen errors (for example from `getToken`) unwrapped. `isTransient` is the one rule for which failures may be retried: `unreachable`, 5xx, 408 and 429. The main entry does not import the new subpath.
