---
"@jerrywu1234/smartflow": minor
---

Slim the Host-visible `smartflow_review_turn` protocol to its final three actionable states: `NOT_READY`, `USER_INPUT_REQUIRED`, and `DONE`.

`NOT_READY` now carries only a bounded `retryAfterMs`. Run identity and CAS bookkeeping stay inside the Daemon, so the turn output no longer duplicates `projectId`, `jobId`, `revision`, `stateVersion`, or phase-derived progress. Review execution is Daemon-owned; callers poll until a user decision is required or the shared result is done.

`USER_INPUT_REQUIRED` exposes the durable pause, legal submittable options, and one shared `result`. The duplicated top-level Review and repair draft, unroutable inspection markers, and constant required-input field tuple were removed. Review evidence is available through `result.review`; repair evidence is available through `result.repairDraft`.

Removing phase-derived progress also keeps the polling path from parsing the complete Task Manifest. A stale continuation reads no Run state, discloses no path, replays no side effect, and returns `NOT_READY`; the next real turn rereads state and verifies artifacts.
