# ADR: Daemon-Owned Mechanical Review Turn

## Status

Accepted on 2026-08-11. This ADR supersedes [ADR: Host-Orchestrated Automatic Review Loop](adr-auto-review-loop.md) for current orchestration ownership while retaining its historical rationale.

## Context

The previous design required the Host/Leader to drive every wait, Action claim, Review submission, repair decision, and Publish transition through multiple primitive MCP calls. That made correctness depend on one live Host loop, duplicated retry/CAS behavior outside the Daemon, and left restart boundaries between claim, Review, and decision without one durable checkpoint.

At the same time, Reviewer execution cannot move into the Daemon: only the Host can create or restore the independent native Reviewer session, and only the Host may communicate with the user. The design therefore needs a boundary that centralizes deterministic mechanics without creating a second autonomous Reviewer or user-facing Leader.

## Decision

Adopt Solution D:

1. `smartflow_execute` starts the approved Run.
2. `smartflow_review_turn` becomes the preferred single continuation entry point and returns exactly `NOT_READY | REVIEW_REQUIRED | USER_INPUT_REQUIRED | DONE`.
3. The Daemon owns deterministic waiting, Review Action claim and renewal, Review result submission, automatic accept/repair/pause planning, approved-scope repair continuation, and Publish progression.
4. The Host owns only the capabilities the Daemon does not have: creating/restoring the independent Reviewer and interacting with the user.
5. A schema-v4 `RunRecord.hostTurn` durably checkpoints `CLAIMING`, `AWAITING_REVIEW`, or `AWAITING_USER_INPUT`; `autoRepairRounds` durably tracks the current 15-round allowance.
6. Every turn is bound to `hostTurnId + turnToken + revision`. The worktree path is disclosed only after a successful durable claim and only in `REVIEW_REQUIRED`.
7. Per-Run serialization, Project-wide CAS, stable child request IDs, restart recovery, deadline enforcement, and claim renewal are Daemon responsibilities.
8. The existing ten primitive tools remain public for compatibility and low-level control. With the composite tool, the public surface is exactly eleven tools.

## Deterministic policy

- A Review that is `APPROVE`, exactly 100%, and has no blocking findings is automatically accepted and progressed to Publish.
- An incomplete Review with actionable blocking findings automatically starts repair using only their current fingerprints while fewer than 15 automatic repair rounds have run.
- An incomplete Review without actionable blocking findings pauses as `INVALID_REVIEW`; only cancel is legal.
- The fifteenth incomplete repair Review pauses as `AUTOMATIC_REPAIR_LIMIT`; the user may grant another group through `resume_review_decision`, which resets the counter.
- Reviewer unavailable, deadline/renewal failure, conflict, or any state whose safe continuation cannot be proven remains a durable pause.

## Why this preserves Leader-only interaction

Mechanical transition planning is frozen product policy, not open-ended product judgment. The Daemon does not read user intent, invent repair scope, create a Reviewer, or answer a pause. It only validates current durable evidence and applies the specified transition. The Host remains the sole user-facing Leader and the sole executor of independent Reviewer sessions.

## Consequences

### Positive

- High-level Host integrations need only `execute` and repeated `review_turn` calls.
- Claim intent, Host ownership, retry, timeout, renewal, repair budget, and user pauses survive Daemon restart.
- Stale continuations are harmless and cannot redisclose a claimed worktree path.
- Automatic repair and Publish behavior has one tested implementation instead of being reconstructed by each Host.

### Costs

- `RunRecord` carries a durable Host-turn checkpoint and repair counter.
- The Daemon maintains per-Run queues and renewal/deadline timers.
- Both composite and primitive APIs must remain contract-compatible.
- Real pinned Pi SDK/RPC compatibility and real-model E2E evidence remain separate acceptance obligations; composite orchestration tests do not prove them.

## Rejected alternatives

- **Keep all mechanics in Host**: rejected because retries, CAS, and restart recovery remain duplicated and non-durable.
- **Let Daemon create Reviewer sessions**: rejected because it violates Host-only Reviewer execution and available runtime capabilities.
- **Remove primitive tools**: rejected because compatibility, diagnostics, and explicit low-level recovery still require them.
- **Return worktree paths from status/pause**: rejected because path authority must follow a current successful claim.
- **Treat every pause as terminal**: rejected because typed user choices and recovery are first-class nonterminal states.

## References

- Contract: [contracts/review-turn.md](contracts/review-turn.md)
- Data model: [data-model.md](data-model.md)
- Traceability: [implementation-map.md](implementation-map.md)
- Implementation tasks: T201–T210 in [tasks.md](tasks.md)
