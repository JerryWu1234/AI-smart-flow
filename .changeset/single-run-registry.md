---
"@jerrywu1234/smartflow": patch
---

Collapse the duplicate run-reservation bookkeeping in the Claude Code CLI and Codex Desktop review adapters. Both tracked in-flight runs twice, in `activeRuns` and in a parallel `reservedRunIds` set with an identical lifecycle, so the duplicate-`runId` guard now reads `activeRuns` directly.

Run teardown in both adapters also drops the map entry unconditionally instead of matching on entry identity. The identity check could never fail on the existing code paths, but with `activeRuns` now backing the guard, a skipped delete would have wedged a `runId` into permanent `CLAUDE_RUN_ACTIVE`/`CODEX_RUN_ACTIVE` rejection.

The Codex CLI adapter keeps its `reservedRunIds` set. Its reservation is taken before the output cleanup and spawn complete, so `activeRuns` is genuinely empty during startup and cannot back the guard.

No behavior change.
