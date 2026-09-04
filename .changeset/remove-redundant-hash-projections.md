---
"@smartflow/cli": patch
---

Remove duplicate task-source and task-manifest hash fields from repair continuations, omit the redundant confirmation request hash from manual-publish mutation payloads, and reuse the verified task-source `ArtifactRef.sha256` during review preparation instead of hashing the bytes twice.

Artifact reads still verify integrity against `ArtifactRef.sha256`, repair continuation identity remains bound by its referenced run and source attempt, and manual publish confirmation keeps its stable hash-derived request ID.
