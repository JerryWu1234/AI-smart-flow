---
"@smartflow/cli": major
---

Remove eight persisted or returned hash projections that had no production readers: the compiled TaskManifest hash, idempotent response hash, three repair-draft hashes, two approved-source drift diagnostics, and the manual-confirmation recovery hash.

Artifact integrity remains bound by `ArtifactRef.sha256`; idempotent replay still compares `requestHash` and returns the stored response; approved-source drift detection and the stable manual-confirmation request ID remain unchanged.

This is a latest-only format cutover. Existing daemon state and repair-draft output are not migrated or dual-read. Finish in-flight runs on the old version, then clear local daemon data with `pnpm clean:daemon-data` before using this release.
