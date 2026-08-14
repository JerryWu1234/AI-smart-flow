# SmartFlow 4.1 Requirements-to-Implementation Map

**Baseline**: Solution D / daemon-owned mechanical orchestration
**Date**: 2026-08-12
**Purpose**: Trace current requirements through tasks, production code, and executable evidence. Remaining “Open” rows are intentional installed-Pi/real-model evidence gaps; passing local tests do not close them.

## Solution D traceability

| Requirement | Task | Production implementation | Primary executable evidence | Current status |
|---|---|---|---|---|
| FR-042 — sole public `smartflow_execute → smartflow_review_turn*` Review orchestration path, four public states, bounded poll | T201, T205 | `packages/protocol/src/schema/mcp-tools.ts`; `apps/mcp-server/src/tools/review-turn.ts`; `apps/daemon/src/host-turn-coordinator.ts`; `apps/host-skill/src/workflow.ts` | `packages/protocol/src/schema/protocol.test.ts`; coordinator/Host workflow tests | Implemented — unanswered pauses return the embedded canonical result without calling an independent Run management API |
| FR-043 — Daemon owns mechanics; Host owns Reviewer/user interaction | T202, T205 | `apps/daemon/src/host-turn-coordinator.ts`; `apps/host-skill/src/workflow.ts` | policy, coordinator, and Host workflow tests | Implemented — Host executes only Reviewer callbacks and user-answer callbacks in the public Review flow |
| FR-044 — Reviewer CREATE/RESUME, durable Host ownership, atomic begin-before-path | T204, T205 | `apps/host-skill/src/reviewer.ts`; `apps/host-skill/src/workflow.ts`; `apps/daemon/src/host-turn-coordinator.ts`; `apps/daemon/src/review-coordinator.ts` | coordinator and Host workflow tests; protocol path guards; internal-owner integration regression | Implemented — one CAS mutation persists `REVIEWING + AWAITING_REVIEW`; cumulative `changedPaths` and owner/token bindings gate Review continuation |
| FR-045 — schema-v5 `hostTurn`, v4 migration, and `autoRepairRounds` | T203 | `packages/state-store/src/schema.ts`; `packages/state-store/src/state-store.ts`; `apps/daemon/src/project-runtime.ts` | `packages/state-store/src/schema.test.ts` | Implemented — v4 claim fields are removed during startup migration and ambiguous active Review state safely pauses |
| FR-046 — restart/single-deadline/durable pause | T204 | `apps/daemon/src/host-turn-coordinator.ts`; `apps/daemon/src/project-runtime.ts`; `apps/daemon/src/recovery-manager.ts` | coordinator tests; production repair-loop restart/deadline cases | Implemented — restart restores the single 30-minute Review deadline; no short lease or renewal loop remains |
| FR-047 — Project-wide CAS, stable child IDs, stale continuation | T204 | `ProjectMutationExecutor`; `HostTurnCoordinator.beginReview/submitReviewTurn`; `ProjectRuntime.recover` | coordinator atomic-begin/finalize, stale-owner, restart tests | Implemented — durable owner/token checks and one-operation transitions close partial primitive windows |
| FR-048 — deterministic accept/repair/invalid/15-round policy | T202, T206 | `packages/review/src/review-decision.ts`; `apps/daemon/src/host-turn-coordinator.ts`; `apps/daemon/src/project-runtime.ts` | `packages/review/src/review-decision.test.ts`; coordinator and production repair-loop tests | Implemented |
| FR-049 — typed `USER_INPUT_REQUIRED`; terminal-only `DONE` | T201, T204, T205 | review-turn schemas; `HostTurnCoordinator.requireUserInput/userInputRequired`; Host workflow callbacks | protocol/coordinator/Host workflow tests | Implemented — canonical result, mutable options, inspections, `COLLECT` forms, and complete `CONFIRM` answers are disjoint |
| FR-050 — exactly six public MCP tools; one Review path plus four independent Run management APIs | T201 | `apps/mcp-server/src/tools/index.ts`; `packages/protocol/src/schema/mcp-tools.ts`; `apps/mcp-server/src/server.ts` | `tests/contract/mcp-v5.test.ts`; `packages/protocol/src/schema/protocol.test.ts` | Implemented — the five named public Review-mechanics symbols, schemas, handlers, registrations, and aliases do not exist; those mechanics are Daemon-internal only |
| FR-051 — real pinned Pi SDK/Extension/RPC compatibility proven independently | T207, T208 / existing T190 | `packages/provider-pi/src/mcp-model-extension.ts`; `packages/provider-pi/src/runtime-resources.ts`; `packages/provider-pi/src/worker-entry.ts`; `packages/provider-pi/src/pi-provider.ts` | Mocked/export-shape tests complete; installed real Pi 0.83.0 host evidence absent | **Open** |

## Success-criteria traceability

| Criterion | Task/evidence | Current status |
|---|---|---|
| SC-016 — public four-state exclusivity and path disclosure only after atomic durable begin | T201; protocol schema and coordinator atomic-begin/stale tests | Met locally |
| SC-017 — restart/CAS/deadline do not duplicate Review, repair, or Publish | T204; coordinator, integration, and production repair-loop tests | Met locally |
| SC-018 — exact six-tool public surface and sole two-tool Review orchestration path | T201, T205; protocol/MCP contract and Host workflow tests | Met locally — the registry exposes only `smartflow_execute`, `smartflow_review_turn`, and four independent Run management APIs |
| SC-019 — production composition completes automatic repair through `smartflow_execute` and `smartflow_review_turn` | T206; `tests/e2e/production-repair-loop.test.ts` | Met for the covered production-composition scenario |
| SC-020 — checked-in real installed Pi compatibility **and** authorized real-model two-tool evidence | T208/T190 plus T209/T192 | **Open** — neither evidence half may be omitted |

## Phase 12 task status

| Task | Mapping status |
|---|---|
| T201 | Complete: schema/path guards/exact six-tool public surface; the five named public Review-mechanics symbols, schemas, handlers, registrations, and aliases do not exist |
| T202 | Complete: deterministic decision policy |
| T203 | Complete: schema-v5 Host-turn fields and persisted v4→v5 migration |
| T204 | Complete: owner-preserving pauses, atomic Review begin/finalize, Project CAS, one durable deadline, and restart regressions |
| T205 | Complete: cumulative `changedPaths`, same Reviewer binding, self-contained pause protocol, and no independent `smartflow_result` fallback |
| T206 | Complete for its production-composition scenario |
| T207 | Complete for mocked/export-shape Pi hardening; does not close real-SDK evidence |
| T208 | **Open**: installed Pi 0.83.0 host compatibility |
| T209 | **Open**: authorized checked-in real-model E2E evidence |
| T210 | Complete when synchronized documentation passes ID/link/path/diff checks while preserving T208/T209 as the remaining open evidence gates |

## Persistent-state mapping

| Entity/invariant | Schema/owner | Current implementation/evidence |
|---|---|---|
| v4 migration boundary | `packages/state-store/src/schema.ts`; `StateStore.migrateState` | Safe v4 `CLAIMING/REVIEWING` data maps to v5 `AWAITING_REVIEW`; lease fields are removed and ambiguous Review state pauses |
| `HostTurn.AWAITING_REVIEW` | state schema; coordinator | One CAS mutation binds token/owner/review attempt/deadline; restart restores the same checkpoint without renewal |
| `HostTurn.AWAITING_USER_INPUT` | state schema; coordinator | Typed pause preserves and validates the prior owner unless an explicit handoff is added |
| `autoRepairRounds` | state schema; `ReviewCoordinator.finalizeStoredReview` | `resume_review_decision` atomically re-evaluates stored Review with a reset allowance and proceeds directly to repair or a real pause |
| Host ownership | `hostTurnId + turnToken + revision` | Enforced in `smartflow_review_turn` and every Daemon-internal Review mutation under the Project lock |
| Single recovery authority | `ProjectRuntime.recover` → `HostTurnCoordinator.recoverRun` | Fresh-state reread prevents general Run recovery from racing an active Host-turn checkpoint |

## Public-tool mapping

The public runtime set is exactly `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`. The only public Review orchestration path is `smartflow_execute → smartflow_review_turn*`. The latter four tools are separate Run management APIs, not Review continuations or alternate Review orchestration steps; public `smartflow_resume` handles independent paused-Run recovery and cannot answer or bypass an active `hostTurn`. The old wait/claim/renew/submission/Leader primitive symbols, schemas, handlers, registrations, and aliases do not exist. Review begin and Review-plus-decision finalization are each one Daemon domain operation.

## Validation baseline at synchronization

The schema-v5 Review simplification target matrix passes 63/63 across state migration (7), protocol (11), Host-turn coordination (11), MCP lifecycle (17), production repair-loop E2E (4), crash recovery (10), and Pi-runner integration (3). Post-lint affected regressions pass 22/22. Root `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `git diff --check` pass. A TypeScript source search reports zero matches for the removed wait/claim/renew/submit-review/report-unavailable/submit-leader callable schema and method symbols.

The opt-in real-Pi installed-package test was intentionally not authorized or run, and no redacted transcript is checked in. T208/T190 and T209/T192 remain open until the repository contains authorized, reproducible proof against the pinned installed Pi SDK and real model path.
