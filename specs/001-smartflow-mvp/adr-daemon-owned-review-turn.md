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
5. Schema-v5 `RunRecord.hostTurn` durably checkpoints only `AWAITING_REVIEW` or `AWAITING_USER_INPUT`; startup migration converts safe schema-v4 claim states and pauses ambiguous ones. `autoRepairRounds` durably tracks the current 15-round allowance.
6. Every turn is bound to `hostTurnId + turnToken + revision`. The worktree path is disclosed only after the same CAS mutation has moved the Run to `REVIEWING` and persisted `AWAITING_REVIEW`.
7. Project-wide CAS, deterministic operation request IDs, restart recovery, artifact/session binding, and one durable 30-minute deadline are Daemon responsibilities.
8. The public MCP surface is exactly six tools: `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`. The sole public Review orchestration path is `smartflow_execute → smartflow_review_turn*`; status, resume, cancel, and result are separate Run-management APIs, not Review continuations or a second Review orchestration path. Public `smartflow_resume` is for independent paused-Run recovery and cannot answer or bypass an active `hostTurn` checkpoint.
9. The `HostActionLoop` symbol and public symbols, schemas, handlers, registrations, and aliases for `smartflow_wait`, `smartflow_claim_action`, `smartflow_renew_action_claim`, `smartflow_submit_review`, and `smartflow_submit_leader_decision` do not exist. The Daemon does not recreate those primitives internally: Review begin and Review finalization are each one domain operation.

## Deterministic policy

- A Review that is `APPROVE`, exactly 100%, and has no blocking findings is automatically accepted and progressed to Publish.
- An incomplete Review with actionable blocking findings automatically starts repair using only their current fingerprints while fewer than 15 automatic repair rounds have run.
- An incomplete Review without actionable blocking findings pauses as `INVALID_REVIEW`; only cancel is legal.
- The fifteenth incomplete repair Review pauses as `AUTOMATIC_REPAIR_LIMIT`; the owning Host may grant another group by submitting `resume_review_decision` through `smartflow_review_turn` with the active `turnToken`. HostTurnCoordinator atomically re-evaluates the stored Review with a reset allowance and proceeds directly to repair or another real pause.
- Reviewer unavailable, deadline expiry, conflict, or any state whose safe continuation cannot be proven remains a durable pause.

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
