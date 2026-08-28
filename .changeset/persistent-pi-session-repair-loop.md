---
"@smartflow/cli": major
---

Make each Job bind one immutable task source, TaskManifest, canonical task path, and Provider configuration, and remove the public and persisted business Revision contract.

Every `smartflow_execute` call now creates a new Job. Automatic Review repair stays within the current Job and original task scope, starts a new independently fenced Worker attempt in the existing `gitWorkspace.current`, and restores the same logical PI session from the completed integrity-bound bundle. The completed PI JSONL remains byte-for-byte, may retain internal path strings, restores its original runtime-relative path, and intentionally has no `schemaVersion`.

Job artifacts now use flat `runs/{jobId}/...` paths instead of `revision-N` directories, Git snapshots use `RUN_BASELINE` and `RUN_RESULT`, and every Candidate covers the Run baseline through the latest result. Publish identity no longer includes Revision; `stateVersion`, fences, attempt/generation identity, content hashes, operation IDs, and file-level CAS continue to protect stale or duplicate work.

Changing the task, canonical path, Provider configuration, or authorized scope requires canceling the current Job and executing the new task source as a new Job. Out-of-scope Review feedback produces only a repair draft. Existing Revision state and artifacts are not migrated or read compatibly; recreate local Jobs after upgrading. A subsequent latest-only format cutover also removes application-level `schemaVersion` fields while retaining mutation `stateVersion` and the SQLite physical schema guard.
