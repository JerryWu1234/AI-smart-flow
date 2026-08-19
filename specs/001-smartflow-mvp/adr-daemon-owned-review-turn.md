# ADR: Daemon-Owned Mechanical Review Turn

## Status

Accepted on 2026-08-11. This ADR supersedes [ADR: Host-Orchestrated Automatic Review Loop](adr-auto-review-loop.md) for current orchestration ownership while retaining its historical rationale.

## Context

The previous design required the Host/Leader to drive every wait, Action claim, Review submission, repair decision, and Publish transition through multiple primitive MCP calls. That made correctness depend on one live Host loop, duplicated retry/CAS behavior outside the Daemon, and left restart boundaries between claim, Review, and decision without one durable checkpoint.

At the same time, Reviewer execution cannot move into the Daemon: only the Host can create or restore the independent native Reviewer session, and only the Host may communicate with the user. The design therefore needs a boundary that centralizes deterministic mechanics without creating a second autonomous Reviewer or user-facing Leader.

## Decision

Adopt Solution D:

1. `smartflow_execute` starts the approved Run.
2. `smartflow_review_turn` is the sole public Review continuation entry point and returns exactly `NOT_READY | REVIEW_REQUIRED | USER_INPUT_REQUIRED | DONE`.
3. The Daemon internally owns bounded polling, atomic Review begin/finalize, automatic accept/repair/pause planning, approved-scope repair continuation, and Publish progression.
4. The Host owns only the capabilities the Daemon does not have: creating/restoring the independent Reviewer and interacting with the user.
5. Schema-v6 `RunRecord.hostTurn` durably checkpoints only `AWAITING_REVIEW` or `AWAITING_USER_INPUT`; startup migration converts safe schema-v4/schema-v5 state and pauses ambiguous state. `autoRepairRounds` durably tracks the current 15-round allowance. Run state schema-v6 is independent of Review/Leader artifact schema version 2.
6. Every turn is bound to `hostTurnId + turnToken + revision`. The worktree path is disclosed only after the same CAS mutation has moved the Run to `REVIEWING` and persisted `AWAITING_REVIEW`.
7. Project-wide CAS, deterministic operation request IDs, restart recovery, artifact/session binding, and one durable 30-minute deadline are Daemon responsibilities.
8. The public MCP surface is exactly six tools: `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`. The sole public Review orchestration path is `smartflow_execute → smartflow_review_turn*`; status, resume, cancel, and result are separate Run-management APIs, not Review continuations or a second Review orchestration path. Public `smartflow_resume` is for independent paused-Run recovery and cannot answer or bypass an active `hostTurn` checkpoint.
9. The `HostActionLoop` symbol and public symbols, schemas, handlers, registrations, and aliases for `smartflow_wait`, `smartflow_claim_action`, `smartflow_renew_action_claim`, `smartflow_submit_review`, and `smartflow_submit_leader_decision` do not exist. The Daemon does not recreate those primitives internally: Review begin and Review finalization are each one domain operation.

## Deterministic policy

The submission envelope carries the Reviewer session separately; its `review.result` is the only Review data model:

```text
ReviewResult = { tasks: TaskReview[] }
TaskReview = { id, completionPercentage, issues }
Issue = { path, message, suggestedFix? }
```

The Daemon validates the complete payload and current turn/Candidate binding before writing any Review artifact, Leader artifact, or Run state. The Task IDs MUST be unique and exactly cover `manifest.enabledTaskIds`. A Task is 100% complete if and only if `issues` is empty; every incomplete Task has at least one Issue. Within one Task, `(path, message)` MUST be unique. For Issue paths, the strict schema trims and requires a non-empty value, rejects a leading `/`, any backslash, and any empty/`.`/`..` slash-delimited segment; it does not separately classify drive-qualified forms or inspect filesystem existence/type/symlinks. `message` and a present `suggestedFix` must be non-empty. The Reviewer prompt separately requires a concrete function or behavior, trigger, and impact. Any extra ReviewResult, TaskReview, or Issue field is invalid. Rejected payloads leave the Run and active checkpoint unchanged and produce no Review decision.

For a valid Review, `planReviewDecision()` has exactly three outcomes:

- If every Task is 100%, plan `ACCEPT` and progress to Publish.
- Otherwise, if `autoRepairRounds < 15`, plan `REPAIR`; the Daemon derives repair from every `tasks[].issues[]` entry. The Host/Leader cannot select a subset or add repair scope.
- Otherwise, plan `PAUSE_REPAIR_LIMIT`. The owning Host may grant another allowance by submitting `resume_review_decision` through `smartflow_review_turn` with the active `turnToken`. HostTurnCoordinator replans the stored v2 Review using a zero round base; a resulting `REPAIR` persists `autoRepairRounds: 1`, after which repair preparation may create the next Revision or enter a genuine repair pause.

Across valid incomplete rounds, `run.recovery.repairRound` stores `{ failureIds, tasks, relevantPathHashes }`. The stable problem set contains only failure IDs and `(TaskReview.id, Issue.path)`; relevant hashes come from Candidate operations (`newEntry.sha256` or `DELETED`). Strict problem-set reduction or a hash change for any Issue path in the two rounds is progress. The first round initializes `noProgressCount` to zero and the default pause threshold is 15. `message` and `suggestedFix` never participate, Result Snapshots are not reread for this comparison, and no-progress does not add a fourth Review decision.

Durable Review and Leader artifacts both use `schemaVersion: 2`. The Review artifact contains `revision`, `claimId`, `reviewAttemptId`, `taskSourceHash`, `candidateHash`, Reviewer/Pi session IDs, `gate`, and its in-artifact `reviewHash`; the hash covers the canonical body without itself. The Leader artifact contains only `revision`, `reviewHash`, `decision`, `reason`, `decidedAt`, and `decisionHash`; it has no direct Candidate/task-source fields or independently authored repair list. Artifact v1 is neither upgraded nor interpreted as v2: strict parsing fails and recovery pauses or blocks the affected Run. A fresh Data Directory is an operator deployment choice, not a runtime-enforced format boundary; the current runtime has no directory-version marker/probe. Reviewer unavailability, deadline expiry, conflict, or another state whose safe continuation cannot be proven remains an operational durable pause, not an additional `planReviewDecision()` outcome.

## Why this preserves Leader-only interaction

Mechanical transition planning is frozen product policy, not open-ended product judgment. The Daemon does not read user intent, invent repair scope, create a Reviewer, or answer a pause. It only validates current durable evidence and applies the specified transition. The Host remains the sole user-facing Leader and the sole executor of independent Reviewer sessions.

## Consequences

### Positive

- High-level Host integrations have one public Review orchestration path: `smartflow_execute` followed by repeated `smartflow_review_turn` calls.
- Host ownership, retry safety, one deadline, repair budget, and user pauses survive Daemon restart.
- Stale continuations are harmless and cannot redisclose the Review worktree path.
- Automatic repair and Publish behavior has one tested implementation instead of being reconstructed by each Host.

### Costs

- `RunRecord` carries a durable Host-turn checkpoint and repair counter.
- The Daemon maintains one deadline timer per active Review and owns the atomic Review, repair, and Publish operations.
- The six public MCP contracts and the Daemon-internal orchestration boundary must be tested separately. The `HostActionLoop` symbol and the five named public Review symbols, schemas, handlers, registrations, and aliases do not exist.
- Real pinned Pi SDK/RPC compatibility and real-model E2E evidence remain separate acceptance obligations; composite orchestration tests do not prove them.

## Rejected alternatives

- **Keep all mechanics in Host**: rejected because retries, CAS, and restart recovery remain duplicated and non-durable.
- **Let Daemon create Reviewer sessions**: rejected because it violates Host-only Reviewer execution and available runtime capabilities.
- **Expose public Review primitives or aliases**: rejected because either would create a second public Review orchestration path and split ownership again.
- **Use status/resume/cancel/result as Review orchestration**: rejected because these are separate Run-management APIs, not Review continuations. Public `smartflow_resume` handles independent paused-Run recovery and cannot answer or bypass an active `hostTurn`.
- **Return worktree paths from status/pause**: rejected because path authority exists only while a current `AWAITING_REVIEW` checkpoint is durably bound to the owning Host.
- **Treat every pause as terminal**: rejected because typed user choices and recovery are first-class nonterminal states.

## References

- Contract: [contracts/review-turn.md](contracts/review-turn.md)
- Data model: [data-model.md](data-model.md)
- Traceability: [implementation-map.md](implementation-map.md)
- Implementation tasks: T201–T210 in [tasks.md](tasks.md)
