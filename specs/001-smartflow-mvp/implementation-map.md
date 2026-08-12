# SmartFlow 4.1 Requirements-to-Implementation Map

**Baseline**: Solution D / daemon-owned mechanical orchestration
**Date**: 2026-08-12
**Purpose**: Trace current requirements through tasks, production code, and executable evidence. Remaining “Open” rows are intentional installed-Pi/real-model evidence gaps; passing local tests do not close them.

## Solution D traceability

| Requirement | Task | Production implementation | Primary executable evidence | Current status |
|---|---|---|---|---|
| FR-042 — sole public `smartflow_execute → smartflow_review_turn*` Review orchestration path, four public states, bounded poll | T201, T205 | `packages/protocol/src/schema/mcp-tools.ts`; `apps/mcp-server/src/tools/review-turn.ts`; `apps/daemon/src/host-turn-coordinator.ts`; `apps/host-skill/src/workflow.ts` | `packages/protocol/src/schema/protocol.test.ts`; coordinator/Host workflow tests | Implemented — unanswered pauses return the embedded canonical result without calling an independent Run management API |
| FR-043 — Daemon owns mechanics; Host owns Reviewer/user interaction | T202, T205 | `apps/daemon/src/host-turn-coordinator.ts`; `apps/host-skill/src/workflow.ts` | policy, coordinator, and Host workflow tests | Implemented — Host executes only Reviewer callbacks and user-answer callbacks in the public Review flow |
| FR-044 — Reviewer CREATE/RESUME, durable Host ownership, claim-before-path | T204, T205 | `apps/host-skill/src/reviewer.ts`; `apps/host-skill/src/workflow.ts`; `apps/daemon/src/host-turn-coordinator.ts` | coordinator and Host workflow tests; protocol path guards; internal-owner integration regression | Implemented — cumulative `changedPaths` is forwarded and `hostTurn` ownership gates every internal Review mutation |
| FR-045 — schema-v4 `hostTurn` and `autoRepairRounds` | T203 | `packages/state-store/src/schema.ts`; `packages/state-store/src/test-fixture.ts`; `apps/daemon/src/project-runtime.ts` | `packages/state-store/src/schema.test.ts` | Implemented |
| FR-046 — restart/deadline/renew/retry/durable pause | T204 | `apps/daemon/src/host-turn-coordinator.ts`; `apps/daemon/src/project-runtime.ts` | coordinator tests; production repair-loop restart/renew cases | Implemented — lost successful claims reconcile from durable state and schedule from the actual claim lease |
| FR-047 — per-Run serialization, Project-wide CAS, stable child IDs, stale continuation | T204 | `HostTurnCoordinator.serialize/retryCas/childRequestId`; `ProjectMutationExecutor`; `ProjectRuntime.recover` | coordinator stale/CAS/concurrency/restart tests | Implemented — durable owner/token checks and internal authority payloads close ownership races |
| FR-048 — deterministic accept/repair/invalid/15-round policy | T202, T206 | `packages/review/src/review-decision.ts`; `apps/daemon/src/host-turn-coordinator.ts`; `apps/daemon/src/project-runtime.ts` | `packages/review/src/review-decision.test.ts`; coordinator and production repair-loop tests | Implemented |
| FR-049 — typed `USER_INPUT_REQUIRED`; terminal-only `DONE` | T201, T204, T205 | review-turn schemas; `HostTurnCoordinator.requireUserInput/userInputRequired`; Host workflow callbacks | protocol/coordinator/Host workflow tests | Implemented — canonical result, mutable options, inspections, `COLLECT` forms, and complete `CONFIRM` answers are disjoint |
| FR-050 — exactly six public MCP tools; one Review path plus four independent Run management APIs | T201 | `apps/mcp-server/src/tools/index.ts`; `packages/protocol/src/schema/mcp-tools.ts`; `apps/mcp-server/src/server.ts` | `tests/contract/mcp-v5.test.ts`; `packages/protocol/src/schema/protocol.test.ts` | Implemented — the five named public Review-mechanics symbols, schemas, handlers, registrations, and aliases do not exist; those mechanics are Daemon-internal only |
| FR-051 — real pinned Pi SDK/Extension/RPC compatibility proven independently | T207, T208 / existing T190 | `packages/provider-pi/src/mcp-model-extension.ts`; `packages/provider-pi/src/runtime-resources.ts`; `packages/provider-pi/src/worker-entry.ts`; `packages/provider-pi/src/pi-provider.ts` | Mocked/export-shape tests complete; installed real Pi 0.83.0 host evidence absent | **Open** |

## Success-criteria traceability

| Criterion | Task/evidence | Current status |
|---|---|---|
| SC-016 — public four-state exclusivity and path disclosure only after claim | T201; protocol schema and coordinator claim/stale tests | Met locally |
| SC-017 — restart/CAS/renew/deadline do not duplicate claim, Review, repair, or Publish | T204; coordinator, integration, and production repair-loop tests | Met locally |
| SC-018 — exact six-tool public surface and sole two-tool Review orchestration path | T201, T205; protocol/MCP contract and Host workflow tests | Met locally — the registry exposes only `smartflow_execute`, `smartflow_review_turn`, and four independent Run management APIs |
| SC-019 — production composition completes automatic repair through `smartflow_execute` and `smartflow_review_turn` | T206; `tests/e2e/production-repair-loop.test.ts` | Met for the covered production-composition scenario |
| SC-020 — checked-in real installed Pi compatibility **and** authorized real-model two-tool evidence | T208/T190 plus T209/T192 | **Open** — neither evidence half may be omitted |

## Phase 12 task status

| Task | Mapping status |
|---|---|
| T201 | Complete: schema/path guards/exact six-tool public surface; the five named public Review-mechanics symbols, schemas, handlers, registrations, and aliases do not exist |
| T202 | Complete: deterministic decision policy |
| T203 | Complete: schema-v4 durable Host-turn fields |
| T204 | Complete: owner-preserving pauses, internal-mutation authority, lost-claim lease recovery, CAS, timers, and restart regressions |
| T205 | Complete: cumulative `changedPaths`, same Reviewer binding, self-contained pause protocol, and no independent `smartflow_result` fallback |
| T206 | Complete for its production-composition scenario |
| T207 | Complete for mocked/export-shape Pi hardening; does not close real-SDK evidence |
| T208 | **Open**: installed Pi 0.83.0 host compatibility |
| T209 | **Open**: authorized checked-in real-model E2E evidence |
| T210 | Complete when synchronized documentation passes ID/link/path/diff checks while preserving T208/T209 as the remaining open evidence gates |

## Persistent-state mapping

| Entity/invariant | Schema/owner | Current implementation/evidence |
|---|---|---|
| `HostTurn.CLAIMING` | `packages/state-store/src/schema.ts`; `HostTurnCoordinator.claimReview` | Durable intent and lost-response reconciliation use the committed claim lease |
| `HostTurn.AWAITING_REVIEW` | state schema; coordinator | Restart restores token/action/attempt and lease-aware renewal; deadline/renew tests exist |
| `HostTurn.AWAITING_USER_INPUT` | state schema; coordinator | Typed pause preserves and validates the prior owner unless an explicit handoff is added |
| `autoRepairRounds` | state schema; `HostTurnCoordinator.submitAnswer`; `ProjectRuntime.resume` | The owning Host submits `resume_review_decision` through `smartflow_review_turn` with the active `turnToken`; HostTurnCoordinator invokes Daemon resume mechanics internally and resets the counter to zero |
| Host ownership | `hostTurnId + turnToken + revision` | Enforced in `smartflow_review_turn` and every Daemon-internal Review mutation under the Project lock |
| Single recovery authority | `ProjectRuntime.recover` → `HostTurnCoordinator.recoverRun` | Fresh-state reread prevents general Run recovery from racing an active Host-turn checkpoint |

## Public-tool mapping

The public runtime set is exactly `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`. The only public Review orchestration path is `smartflow_execute → smartflow_review_turn*`. The latter four tools are separate Run management APIs, not Review continuations or alternate Review orchestration steps; public `smartflow_resume` handles independent paused-Run recovery and cannot answer or bypass an active `hostTurn`. Wait, Action claim/renew, Review submission, and Leader decision are Daemon-internal mechanics. The `HostActionLoop` symbol and public symbols, schemas, handlers, registrations, and aliases for `smartflow_wait`, `smartflow_claim_action`, `smartflow_renew_action_claim`, `smartflow_submit_review`, and `smartflow_submit_leader_decision` do not exist.

## Validation baseline at synchronization

Recorded automated suites passed unit 115/115, contract 9/9, integration 45/45, security 8/8, crash 24/24, and E2E 15 passed / 1 explicitly gated skip, plus build, typecheck, targeted ESLint, fixture syntax, and diff check. Final runtime-behavior review `semantic-review/2026-08-12-142925-pr-0.md` is `APPROVED` with no actionable P0/P1/P2 and confirms T204/T205 complete.

The opt-in real-Pi installed-package test was intentionally not authorized or run, and no redacted transcript is checked in. T208/T190 and T209/T192 remain open until the repository contains authorized, reproducible proof against the pinned installed Pi SDK and real model path.
