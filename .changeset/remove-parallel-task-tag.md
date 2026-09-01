---
"@smartflow/cli": major
---

Retire the `[P]` parallel Task tag. It was parsed into `ParsedTask.parallel`, stored on every `ManifestTask`, and hashed into `tasksHash`, but nothing ever read it — there is no per-Task scheduler to influence, since the compiled manifest is handed to the Provider as a whole.

`[P]` is no longer a legal tag. The parser accepts only `[M01]`-style module labels and rejects anything else with `TASK_TAG_INVALID`, so a task line carrying `[P]` now fails to compile instead of silently recording a field no one consumes. The MCP tool instructions, README, and the Host task-file plan are updated to stop asking for it.

Breaking for persisted state. `manifestTaskSchema` is strict, and a manifest Artifact written by an earlier release still carries `parallel`, so re-parsing it throws on the unrecognized key. That happens on the recovery, review, repair, and worker read paths. Manifest Artifacts are not migrated or dual-read: clear local daemon data with `pnpm clean:daemon-data` before using this release, and let in-flight runs finish on the old version first.

Removing the field also changes `tasksHash` and the manifest hash for identical task sources. `sourceHash` is unaffected because it digests the raw approved bytes, so Host-side `approvedSourceHash` checks keep working.
