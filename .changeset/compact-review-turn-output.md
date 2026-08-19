---
"@jerrywu1234/smartflow": minor
---

Slim the Host-visible `smartflow_review_turn` output to fields a caller can act on.

Removed from the wire: `projectId`, `jobId`, `revision`, and `stateVersion` from every
state (the caller supplies run identity and the Daemon owns CAS bookkeeping), `phase`
from `NOT_READY`, `reviewAttemptId` / `taskSourceHash` / `candidateHash` / `piSessionId`
from `REVIEW_REQUIRED`, the duplicated top-level `repairDraft` and the unroutable
`inspectionOptions` from `USER_INPUT_REQUIRED`, and the constant `fields` tuple from
`requiredInput`.

Every removed value stays inside the Daemon and its durable Review evidence, so attempt
fencing, approved-source drift detection, exact Task coverage, Reviewer/worker session
separation, artifact provenance, CAS, and idempotency are unchanged. No state schema
migration is required.
Also removed: the `progress` object from `NOT_READY` and from the `smartflow_status`
run summary. FR-042 requires `NOT_READY` to carry a bounded `retryAfterMs` and nothing
else, and no requirement ever asked either response to report Task completion. The field
was initial scaffolding whose value came from the Run phase alone: it read `0` before
`REVIEW_PENDING` and `total` from `REVIEW_PENDING` onward, so it claimed every approved
Task complete before the Reviewer had produced a verdict and fell back to `0` on the next
repair round. No per-Task execution state exists to compute anything better, and the
per-Task verdict a caller can act on already ships in `REVIEW_REQUIRED` and `DONE`.

Dropping it also removes work from the polling path: `status()` no longer reads and parses
the whole Task Manifest artifact, and a stale continuation no longer performs a Run state
read at all. Stale continuations still disclose no path, replay no side effect, and return
`NOT_READY`; the next real turn re-reads state and re-verifies artifacts.
