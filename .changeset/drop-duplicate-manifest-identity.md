---
"@smartflow/cli": major
---

Remove the duplicate `runId`, `tasksSha256`, and `tasksHash` fields from TaskManifest.

`runId` was always equal to `jobId` and `tasksSha256` always equal to `sourceHash`, both enforced by the schema's own `superRefine`; `tasksHash` digested `enabledTaskIds`, `allowNoChange`, and `tasks`, all of which the manifest already persists. No production code read any of the three.

This is a latest-only format cutover consistent with the earlier `schemaVersion` removal: canonical manifest bytes and `manifestHash` change, existing artifacts are not migrated or dual-read. Clear local daemon data with `pnpm clean:daemon-data` before using this release. Manifest identity binding is unaffected — it is carried by the `run.taskManifest` artifact SHA, which `taskManifestHash` and `baseTaskManifestHash` already use.
