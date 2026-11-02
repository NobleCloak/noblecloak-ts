# Provenance

This tree is an export, with no history, of the authoring repository at `17f7b8b7efa932ef71fd9b833ceb10b1d4decaa6` (committed 2026-10-30).
It is produced by that repository's export script and checked there, on every change, before it is
published: a term scan over the whole tree, a scan of every package's tarball, a secret scan and the full
gate (format, lint, typecheck, test, build) on the exported tree itself.

The export leaves out the authoring layer, the release checklist and the export tooling. It rewrites the
repository name, the manifests' `repository.url`, the contributing guide's repository link and the
comments that named the authoring repository or pointed at the release checklist. It regenerates `bun.lock`
from the exported manifests.
