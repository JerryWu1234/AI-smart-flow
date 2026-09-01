---
"@jerrywu1234/smartflow": patch
---

Remove the unused stage-timing path from the observability logger. `StructuredLogger.stage()` had no callers anywhere in the workspace, and the `StageLogTimer` it returned was referenced only by that method and was never exported from the package index. Stage timing in the daemon goes through `MetricsRegistry.recordStage` instead.

Also drop three dead correlation fields from `CorrelationIds`. `effectId` had no occurrence outside its own declaration, `operationId` was never passed as a log correlation key, and `attemptId` was only supplied by the observability unit test. `projectId`, `jobId`, and `actionId` remain, as does the `stage`/`durationMs` pair on `LogEntry`, which daemon startup and other log sites set directly.

No behavior change.
