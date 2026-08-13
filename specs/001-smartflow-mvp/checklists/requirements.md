# Specification Quality Checklist: SmartFlow MVP 4.1

**Purpose**: Validate specification completeness, Solution D ownership, and implementation traceability
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
- [x] Edge cases cover path escape, task source drift, concurrent Runs and Publish recovery

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
- [x] Schema-v5 `hostTurn` covers `AWAITING_REVIEW | AWAITING_USER_INPUT`; startup migration removes schema-v4 claim/lease fields
- [x] `hostTurnId + turnToken + revision` ownership and stale-continuation behavior are explicit
- [x] Per-Run serialization, Project-wide CAS, stable child request IDs, and at most four total CAS attempts (initial plus up to three retries) are explicit
- [x] One durable 30-minute Review deadline is explicit; no short lease, renewal loop, margin, or renewal-failure state exists
- [x] Mechanical plans `ACCEPT | REPAIR | PAUSE_INVALID_REVIEW | PAUSE_REPAIR_LIMIT` are complete
- [x] Automatic repair budget is 15; the owning Host submits `resume_review_decision` through `smartflow_review_turn` with the active `turnToken`, and HostTurnCoordinator atomically re-evaluates stored Review and resets the counter for the next group
- [x] `INVALID_REVIEW` does not invent repair scope and offers only cancel
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

- [x] `changedPaths` from `REVIEW_REQUIRED` reaches the packaged Host Reviewer callback (T205)
- [x] A paused active Review preserves its owning `hostTurnId` or uses an explicit authorized handoff before another Host can reclaim (T204)
- [x] A lost atomic-begin response replays the same durable owner/token/Review attempt/deadline without another mutation or a lease-renewal loop (T204)
- [x] Every advertised composite pause is self-contained, including required approval fields and inspection options, and unanswered pauses do not call the independent `smartflow_result` management API (T205)

## Notes

- SmartFlow 不新增通用 verify/gate 阶段；Pi 可以在 isolated workspace 内按任务需要运行项目命令。
- Mocked `registerProvider`、production-composition tests 和 gitignored `.smartflow-e2e` 产物都不能单独关闭真实 SDK/model 验收项。
- Runtime/API field shapes are defined in the plan, data model, and contracts; [implementation-map.md](../implementation-map.md) is the normative traceability index.
