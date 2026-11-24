---
'@noblecloak/cli': patch
---

`noblecloak starter` now says what to do while it waits: for the production and beta deployments it prints the Approvals URL, what the request is called there, how long it waits, and that Ctrl-C stops it and leaves the request open. A deployment given by explicit URLs keeps the old line without a link. `--json` output and exit codes are unchanged.
