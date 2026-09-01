---
"@smartflow/cli": patch
---

Remove the write-only `jobId` field from `WorkerStartInput`. The Worker Provider SPI never read it: `PiProvider.start` and the Pi runtime resource builder consume `attemptId`, `generation`, `workspaceDir`, `prompt`, `providerRuntimeConfigHash`, `deadlineAt`, `resumeSession`, and `containment`. The Daemon still derives the containment registry path and protected read paths from its own Job identity, so Worker containment and Attempt persistence are unchanged.
