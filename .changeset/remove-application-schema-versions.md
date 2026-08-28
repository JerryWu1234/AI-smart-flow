---
"@jerrywu1234/smartflow": major
---

Remove application-level `schemaVersion` fields from ProjectState, TaskManifest, Git workspace snapshots and Candidates, durable Review and Leader decisions, and `doctor --json` output.

This is a latest-only format cutover: existing state and artifacts are not migrated, dual-read, or accepted through a compatibility path. Clear local daemon data with `pnpm clean:daemon-data` before using this release. SQLite retains its physical schema guard, advances from version 4 to 5, and removes the `document_schema_version` mirror column.

Canonical manifest, Candidate, Review, and Leader bytes and hashes change naturally with the new payloads. State mutation versions, fences, attempt and generation identity, artifact SHA checks, publish operation identity, and file-level CAS remain intact.
