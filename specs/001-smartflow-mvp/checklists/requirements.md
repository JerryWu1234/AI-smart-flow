# Specification Quality Checklist: SmartFlow MVP 4.1 / Review v2

**Purpose**: Validate specification completeness, Solution D ownership, Review v2 consistency, and implementation traceability
**Created**: 2026-08-05
**Updated**: 2026-08-11
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No hidden runtime requirements are sourced from authoring documents
- [x] Product behavior is separated from SDK and storage design details
- [x] User stories are prioritized and independently testable
- [x] All mandatory specification sections are complete
- [x] The superseded Host-orchestration ADR is preserved as history and linked to the current ADR

## Requirement Completeness

- [x] No unresolved clarification markers remain
- [x] Pi SDK selection and no-fallback behavior are explicit
- [x] Arbitrary workspace-local Shell/network access and filesystem isolation are independently specified
- [x] Project/user-data isolation is distinguished from read-only runtime bootstrap access
- [x] Broker, custom file operations, effect ledger and Worker tool-decision removal are explicit
- [x] Host MCP, Worker MCP and project-local Skill boundaries are explicit
- [x] Host reconnect, crash recovery, new Revision and new Task session rules are explicit
- [x] MCP process environment is the sole user source for one model/API endpoint
- [x] Supported API protocols and default context/output/thinking/deadline values are explicit
- [x] `models.json`, Provider selection and indirect credential configuration are explicitly forbidden
- [x] API Key non-persistence and redaction requirements are measurable
- [x] Timeout, process-tree termination and recovery-blocked behavior are explicit
- [x] MCP/API/UI/log absolute-path non-disclosure is explicit and measurable
- [x] Candidate, Review, automatic decision and Publish boundaries remain testable
- [x] Review input is exactly strict `ReviewResult={tasks: TaskReview[]}` with strict `TaskReview={id,completionPercentage,issues}` and Issue `{path,message,suggestedFix?}`
- [x] Review Task IDs uniquely and exactly cover bound `manifest.enabledTaskIds`; complete/incomplete Task issue invariants and per-Task `path + message` uniqueness are explicit
- [x] Issue schema trims and requires a non-empty path, rejects a leading `/`, any backslash, and empty/`.`/`..` slash-delimited segments without broader OS-path classification; concrete function/behavior, trigger, and impact are explicitly Reviewer prompt requirements rather than runtime natural-language validation
- [x] Overall Task/Candidate evidence hashes remain durable integrity bindings
- [x] Edge cases cover path escape, task source drift, concurrent Runs, Review format/coverage rejection, and Publish recovery

## Solution D Completeness

- [x] The only public Review orchestration path is `smartflow_execute → smartflow_review_turn*`
- [x] The public MCP surface is exactly `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`
- [x] `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result` are separate Run management APIs, not Review continuations or a second Review orchestration path; public `smartflow_resume` cannot answer or bypass an active `hostTurn`
- [x] Review begin/finalization, deterministic decision planning, approved-scope repair, and Publish scheduling are Daemon domain operations rather than callable wait/claim/renew/Leader primitives
- [x] The public and internal callable symbols, schemas, handlers, registrations, and aliases for the five legacy Review primitives and the `HostActionLoop` symbol do not exist
- [x] Public output is exactly `NOT_READY | REVIEW_REQUIRED | USER_INPUT_REQUIRED | DONE`
- [x] `DONE` is terminal-only; pauses/conflicts remain typed user-input states
- [x] Only atomically persisted `AWAITING_REVIEW` returns `REVIEW_REQUIRED` with `worktreePath`; stale/poll/pause/terminal outputs do not
- [x] Host owns Reviewer CREATE/RESUME and all user interaction; Daemon never creates a Reviewer
- [x] Daemon owns atomic begin/finalize and deterministic accept/repair/pause/Publish mechanics
- [x] Current Project state schema version 6 contains the durable `hostTurn` introduced by v5 and preserves explicit v4→v5→v6 startup migration
- [x] Durable Review artifact v2 includes direct task/Candidate/session bindings, `gate.result`, and in-artifact `reviewHash`; Leader v2 has only revision/reviewHash/decision/reason/decidedAt/decisionHash and no duplicate repair list or direct Candidate/task-source fields
- [x] Artifact v1 has no migration/fallback; strict v2 parse failure pauses or blocks the affected Run. A fresh Data Directory is an operator choice, and no runtime directory-format marker/probe is claimed
- [x] `hostTurnId + turnToken + revision` ownership and stale-continuation behavior are explicit
- [x] Per-Run serialization, Project-wide CAS, stable child request IDs, and at most four total CAS attempts (initial plus up to three retries) are explicit
- [x] One durable 30-minute Review deadline is explicit; no short lease, renewal loop, margin, or renewal-failure state exists
- [x] Mechanical plans are exactly `ACCEPT | REPAIR | PAUSE_REPAIR_LIMIT`
- [x] All enabled Tasks at 100% accept; a valid incomplete Review below 15 rounds repairs every current nested issue; at 15 rounds it durably pauses as `AUTOMATIC_REPAIR_LIMIT`
- [x] Schema-enforced Issue invariants and exact Task-coverage failures are rejected before Review/Leader artifact or state writes; Reviewer prompt quality requirements are not misrepresented as schema checks
- [x] Automatic repair budget is 15; on `resume_review_decision`, HostTurnCoordinator replans stored v2 Review with round base 0, commits `autoRepairRounds=1` for REPAIR, and lets RepairCoordinator advance or genuinely pause
- [x] Repair no-progress uses `run.recovery.repairRound` with failure IDs, Task/path scope, and Candidate-operation relevant-path hashes; strict scope shrink or relevant hash change is progress, while wording and unrelated-file changes are not
- [x] The default no-progress threshold is 15; reaching it produces operational `REPAIR_NO_PROGRESS` without adding another Review decision plan
- [x] Pi repair prompts consume every current `ReviewResult.tasks[].issues[]` with Task/path context and never a selected subset or stale Review
- [x] Restart recovery gives durable Host turn sole authority and rereads fresh state

## Feature Readiness

- [x] Every new functional requirement FR-042–FR-051 maps to a task, code path, and test/evidence row
- [x] Every new success criterion SC-016–SC-020 has explicit evidence status
- [x] Git Workspace, Revision and cleanup semantics are frozen
- [x] Pi process containment and official-tool ownership are frozen
- [x] In-memory Pi model registration and single-model scope are frozen
- [x] Reviewer binding and cumulative Candidate semantics are frozen
- [x] Atomic Publish, conflict response and PARTIAL/UNKNOWN behavior are frozen
- [x] Production-composition two-tool E2E is distinguished from real installed Pi/model evidence
- [ ] Real pinned Pi 0.83.0 Extension/RPC host compatibility has checked-in, reproducible evidence (T190/T208)
- [ ] Authorized real-model two-tool E2E has checked-in, auditable evidence (T192/T209)

## Completed Implementation Checks

- [x] `changedPaths`, `taskSourceHash`, and `candidateHash` from `REVIEW_REQUIRED` reach the packaged Host Reviewer callback (T205)
- [x] Review coverage rejects missing, duplicate, extra, unknown, and disabled Task IDs before durable writes
- [x] Review validation enforces complete/empty and incomplete/non-empty issue equivalence, safe project-relative Issue paths, and per-Task `path + message` uniqueness
- [x] A malformed or coverage-invalid current Review leaves `stateVersion`, phase, active owner/token, repair budget, and Review/Leader evidence unchanged; correction can reuse the same active turn
- [x] A paused active Review preserves its owning `hostTurnId` or uses an explicit authorized handoff before another Host can reclaim (T204)
- [x] A lost atomic-begin response replays the same durable owner/token/Review attempt/deadline without another mutation or a lease-renewal loop (T204)
- [x] Every advertised composite pause is self-contained, including required approval fields and inspection options, and unanswered pauses do not call the independent `smartflow_result` management API (T205)
- [x] Review/Leader artifact v2 strict parsing, operator-selected fresh-directory deployment, full nested-issue Pi prompts, and no-progress scope/hash positive and negative cases are covered; no runtime Data Directory format detection is claimed

## Notes

- SmartFlow 不新增通用 verify/gate 阶段；Pi 可以在 isolated workspace 内按任务需要运行项目命令。
- Mocked `registerProvider`、production-composition tests 和 gitignored `.smartflow-e2e` 产物都不能单独关闭真实 SDK/model 验收项。
- Runtime/API field shapes are defined in the plan, data model, and contracts; [implementation-map.md](../implementation-map.md) is the normative traceability index.
