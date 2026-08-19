# Composite Review Turn Contract — Review v2

**Status**: Current contract
**Date**: 2026-08-11
**Sole public Review orchestration**: `smartflow_execute → smartflow_review_turn*`

## Purpose and ownership

`smartflow_review_turn` is the only public Review continuation entry point after an approved Run starts. The Daemon internally owns bounded polling, atomic Review begin/finalize, accept/repair/pause planning, approved-scope repair continuation, and Publish progression. The Host remains the only component allowed to create/resume a Reviewer session or communicate with the user. The Daemon never creates or replaces a Reviewer.

The public MCP surface contains exactly six tools: `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`. The latter four are separate Run-management APIs, not Review continuations or a second Review orchestration path. Public `smartflow_resume` is an independent paused-Run recovery API; while an active `hostTurn` exists, it cannot submit a ReviewTurn answer or bypass ownership. The `HostActionLoop` and the old wait/claim/renew/submission/Leader primitive symbols, schemas, handlers, registrations, and aliases do not exist. The Daemon uses one atomic domain operation to begin Review and one to persist Review plus automatic decision.

## Input

```ts
interface ReviewTurnInput {
  requestId: string;
  projectId: string;
  jobId: string;
  hostTurnId: string;
  turnToken?: string;
  review?: {
    reviewerSessionId: string;
    result: ReviewResult;
  };
  answer?: ResumeAction | {
    action: ResumeAction;
    tasksPath?: string;
    approvedSourceHash?: string;
    approval: RevisionApproval;
  };
  reviewUnavailableReason?: string;
}

interface ReviewResult {
  tasks: TaskReview[];
}

interface TaskReview {
  id: string;
  completionPercentage: number;
  issues: Issue[];
}

interface Issue {
  path: string;
  message: string;
  suggestedFix?: string;
}
```

`ReviewResult`, `TaskReview`, and `Issue` are strict objects. `ReviewResult.tasks` contains each ID in the bound `manifest.enabledTaskIds` exactly once: missing, duplicate, extra, unknown, and disabled Task IDs are invalid. `completionPercentage` is an integer from 0 through 100. It equals 100 if and only if `issues` is empty; every incomplete Task has at least one issue. Within one Task, issues are unique by `path + message`.

An Issue contains no fields beyond those shown above. For `path`, the schema trims and requires a non-empty value, rejects a leading `/`, any backslash, and any empty/`.`/`..` slash-delimited segment; it does not separately classify drive-qualified forms or verify path existence/type/symlinks. `message` and a present `suggestedFix` must be non-empty. The schema does not judge message specificity; the Reviewer prompt separately requires the message to identify the concrete function or behavior, triggering condition, and impact. The Daemon validates the strict shape, exact Task coverage, Reviewer binding, Review attempt, Revision, and evidence bindings before writing a Review artifact, Leader artifact, repair Revision, or Project state. A schema- or coverage-invalid current continuation is rejected atomically: the entire Run, including `stateVersion`, phase, active `hostTurn`/token, `autoRepairRounds`, and durable evidence, remains unchanged so the owning Host can correct and resubmit against the same active turn.

`review`, `answer`, and `reviewUnavailableReason` are mutually exclusive. Any continuation requires the exact `turnToken` returned by the active turn. `hostTurnId` durably owns that turn; another Host cannot take it over implicitly.

## Four public states

```ts
type ReviewTurnOutput =
  | NotReady
  | ReviewRequired
  | UserInputRequired
  | Done;
```

The Host-visible output is a compact projection of Daemon state. It carries only what a caller can act on: Run identity the caller already supplied, Revision/`stateVersion` CAS bookkeeping, Review attempt identity, task-source/Candidate hashes, and Provider session identity all stay inside the Daemon and its durable evidence. Every guarantee below is unchanged by that projection.

### `NOT_READY`

Returns bounded `retryAfterMs` and nothing else. It never contains `worktreePath`, turn authority, Run phase internals, task-completion counts, or Reviewer internals. The Host waits for `retryAfterMs` and calls the composite tool again with a new request ID.

A stale `review`, `reviewUnavailableReason`, or `answer` continuation returns the current no-path `NOT_READY` state rather than replaying a side effect or redisclosing a worktree. This stale-continuation behavior is distinct from rejecting a malformed payload for the current active token.

### `REVIEW_REQUIRED`

Returned only after one CAS mutation has validated the current Review context, moved the Run to `REVIEWING`, and persisted `AWAITING_REVIEW`. It includes:

- `turnToken` and complete `changedPaths`;
- `reviewerSession: { mode: "CREATE" }` for the first round or `{ mode: "RESUME", reviewerSessionId }` thereafter;
- the bound `worktreePath`, disclosed only in this state;
- the fixed review `deadlineAt`.

The Host opens that worktree, rereads the synchronized Task and current files, executes exactly the requested Reviewer session mode, and submits one strict `ReviewResult` with the same `turnToken`. The bound Task manifest's `enabledTaskIds` define exact Review coverage and the Daemon enforces it. Review attempt identity, task-source/Candidate hashes, and the Pi session stay internal: the Daemon binds them itself and still rejects a reused attempt, a drifted task source, or a Reviewer session equal to the Pi session.

### `USER_INPUT_REQUIRED`

Returns a durable pause with `turnToken`, `pause.code`, `pause.message`, legal mutable `options`, the canonical paused `result`, and, when needed, `requiredInput`. Revision approval uses `mode: "COLLECT"` with a non-submit-ready `inputForm` when user values are missing, or `mode: "CONFIRM"` with a complete schema-valid `answer` when all values are available. It may include current Review evidence in `review`. An optional `worktreePath` is allowed only for a publish-related pause; non-publish pauses never disclose one.

The repair draft is carried once, inside `result.repairDraft`. Read-only `inspect_*` actions are not part of the wire: no tool accepts them, so durable pause evidence reaches the Host through `result.artifacts` and the independent `smartflow_result` API.

- `AUTOMATIC_REPAIR_LIMIT` may offer `resume_review_decision`; the owning Host submits that answer through `smartflow_review_turn` with the active `turnToken`. HostTurnCoordinator verifies durable artifacts and replans the stored v2 Review with `repairRounds: 0`. A resulting `REPAIR` commits `autoRepairRounds: 1`; RepairCoordinator then either prepares the next Revision or enters a genuine repair pause.
- `PUBLISH_ADAPTER_UNAVAILABLE`, `PUBLISH_PRECHECK_CONFLICT`, and a follow-up `MANUAL_PUBLISH_TARGET_MISMATCH` expose the reviewed Candidate `worktreePath` only to the owning Host. The first two may offer `confirm_manual_publish`; the Host obtains user confirmation after an external merge, and the Daemon completes only if every Candidate target kind/hash/mode already matches. `PUBLISH_RECOVERY_BLOCKED` never offers this action.
- Other pause codes expose only actions already allowed by the Run's durable `resumeActions`.

Only the Host communicates these choices to the user and submits an answer through `smartflow_review_turn`. Option names such as `resume_review_decision` and `cancel` are typed ReviewTurn answer values; submitting them does not invoke the separate public `smartflow_resume` or `smartflow_cancel` APIs. Those APIs remain independent Run-management operations rather than Review continuations. In particular, public `smartflow_resume` cannot answer an active `hostTurn` checkpoint or bypass its owner/token checks.

### `DONE`

Returned only when the Run is in `COMPLETED`, `CANCELED`, or `FAILED`. It directly contains canonical `ResultOutput`. That payload has the same shape as the independent `smartflow_result` response, but producing `DONE` does not call that public API. Nonterminal pauses and conflicts must use `USER_INPUT_REQUIRED`, not `DONE`.

## Durable Host-turn checkpoint and Review evidence

Project state uses schema version 6. Startup migration is explicit and idempotent: schema-v4 state first receives the historical v4→v5 Review conversion (safe active claim states become `AWAITING_REVIEW`, while ambiguous `REVIEWING` state pauses as `HOST_REVIEW_UNAVAILABLE`), then schema-v5 state is upgraded with current Publish precheck, attempt, and manual-confirmation evidence. Removed bundle references and `export_bundle` pause actions are disconnected during v5→v6 migration without deleting legacy files from disk. Each Run may persist:

```ts
type HostTurn =
  | { stage: "AWAITING_REVIEW"; turnToken: string; hostTurnId: string;
      revision: number; reviewAttemptId: string;
      startedAt: string; deadlineAt: string }
  | { stage: "AWAITING_USER_INPUT"; turnToken: string; hostTurnId: string;
      revision: number; pauseCode: string; startedAt: string };
```

Durable Review and Leader artifacts each use `schemaVersion: 2`. Review v2 contains `revision`, `claimId`, `reviewAttemptId`, `taskSourceHash`, `candidateHash`, Reviewer/Pi session IDs, `gate`, and in-artifact `reviewHash`; `gate.result` stores the exact ReviewResult, and `reviewHash` covers the canonical body without itself. Leader v2 contains only `revision`, `reviewHash`, `decision`, `reason`, `decidedAt`, and `decisionHash`. It reaches Candidate/task-source/session bindings through `reviewHash` and does not duplicate repair issues or direct Candidate/task-source fields. A `REPAIR` operation derives its complete scope from every nested issue in the bound Review v2 artifact.

Artifact v1 has no migration or fallback parser. Strict v2 parsing fails with `ARTIFACT_SEMANTIC_VALIDATION_FAILED`, causing recovery to pause or block the affected Run. Deployments may choose a fresh SmartFlow Data Directory operationally, but the runtime has no versioned directory format, marker, or whole-directory rejection. Artifact schema remains independent of Project state schema version 6 and its in-place v4/v5 migration.

`RunRecord.autoRepairRounds` counts daemon-started repair rounds in the current allowance. On `resume_review_decision`, HostTurnCoordinator replans the hash-verified stored Review with a zero round base; if the plan is `REPAIR`, the committed counter is 1. Existing `noProgressCount` and `run.recovery.repairRound` are retained for subsequent repair preparation. Checkpoints are durable-first and are not inferred from logs or an in-memory Host call.

## Mechanical decision policy

Only a schema-valid, exactly covered Review enters decision planning. The Daemon selects exactly one deterministic plan:

| Valid Review v2 result | Plan | Effect |
|---|---|---|
| Every Task has `completionPercentage === 100` and `issues: []` | `ACCEPT` | Persist Review/Leader evidence in one mutation, then progress to Publish |
| At least one Task is incomplete and `autoRepairRounds < 15` | `REPAIR` | Persist Review/Leader evidence, then schedule same-scope repair preparation from all current `tasks[].issues[]`; preparation may create a Revision or enter a genuine repair pause |
| At least one Task is incomplete and `autoRepairRounds >= 15` | `PAUSE_REPAIR_LIMIT` | Persist the valid Review/Leader evidence and durable `AUTOMATIC_REPAIR_LIMIT`; ask whether to grant another 15 |

Format or exact-coverage failures do not produce a decision plan or pause. The Host does not re-evaluate or resubmit mechanical decisions. It still owns Reviewer execution and every user decision.

## Repair no-progress rule

Repair preparation stores the preceding round at `run.recovery.repairRound = { failureIds, tasks, relevantPathHashes }`. Candidate operation additions/modifications contribute `newEntry.sha256`; deletions contribute `DELETED`. No Result Snapshot is reread. Comparison is:

- stable problems are current failure IDs plus unique `(task.id, issue.path)` pairs;
- the current stable-problem set being a strict subset of the preceding set is progress;
- a `relevantPathHashes` change for any Issue path present in either round is progress;
- otherwise `noProgressCount` increments.

Issue `message` and `suggestedFix`, unrelated-path changes, completion percentages, ordering, and whole-Candidate/evidence hash changes do not participate in identity. The first round compares current/current with count `-1` and initializes to zero. The default `noProgressThreshold` is 15; reaching it yields operational pause `REPAIR_NO_PROGRESS`. This does not add another Review decision plan. The overall `taskSourceHash` and `candidateHash` remain mandatory integrity bindings even though they are excluded from this detector.

## CAS, idempotency, and deadline

- Every state mutation uses Project-wide `stateVersion` CAS; a competing writer yields a fresh no-path continuation rather than replaying a partial primitive sequence.
- Daemon-internal operation request IDs are deterministic hashes of stable turn identity and operation scope.
- Review begin is one mutation: context validation, `REVIEWING`, and `AWAITING_REVIEW` commit together. A lost response is reconstructed from that durable state without a second begin.
- Review validation is a zero-write precondition. Failure writes no Review/Leader artifact, consumes no turn token or repair budget, and changes no Run field.
- Review finalization is one domain operation: Review v2 and Leader v2 artifacts are written before one state commit directly to `READY_TO_PUBLISH`, `FIXING`, or a real `PAUSED` state. New paths do not produce `LEADER_DECISION`.
- The review deadline is one durable 30-minute timestamp. No short claim lease or renew loop exists.
- On Daemon restart, `HostTurnCoordinator.recoverRun()` restores or expires `AWAITING_REVIEW` before ordinary Run recovery. `ProjectRuntime` rereads fresh state afterward and does not start competing recovery while a checkpoint remains.

## Public MCP surface

Exactly six tools are registered:

1. `smartflow_execute`
2. `smartflow_review_turn`
3. `smartflow_status`
4. `smartflow_resume`
5. `smartflow_cancel`
6. `smartflow_result`

`smartflow_execute → smartflow_review_turn*` is the sole public Review orchestration path. `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result` are separate Run-management APIs, not Review continuations or a second Review orchestration path. Public `smartflow_resume` is for independent paused-Run recovery and cannot answer or bypass an active `hostTurn`. The old wait/claim/renew/submission/Leader primitive symbols, schemas, handlers, registrations, and aliases do not exist; Review begin and finalization are atomic Daemon domain operations.

## Implementation and tests

- Protocol: `packages/protocol/src/schema/mcp-tools.ts`, `packages/protocol/src/schema/run-state.ts`, `tests/unit/packages/protocol/schema/protocol.test.ts`
- MCP registry/handler: `apps/mcp-server/src/tools/index.ts`, `apps/mcp-server/src/tools/review-turn.ts`, `tests/contract/mcp-v5.test.ts`
- Coordinator/recovery: `apps/daemon/src/host-turn-coordinator.ts`, `apps/daemon/src/review-coordinator.ts`, `apps/daemon/src/project-runtime.ts`, `tests/unit/apps/daemon/host-turn-coordinator.test.ts`
- State checkpoint: `packages/state-store/src/schema.ts`, `tests/unit/packages/state-store/schema.test.ts`
- Mechanical policy: `packages/review/src/review-decision.ts`, `packages/review/src/repair-loop.ts`, `tests/unit/packages/review/review-decision.test.ts`
- Native Host contract/direct MCP loop: `apps/mcp-server/src/server.ts`, `tests/fixtures/installed-mcp-lifecycle-child.mjs`
- Repository-only Host simulation: `tests/helpers/host-workflow/workflow.ts`, `tests/unit/helpers/host-workflow/workflow.test.ts`
- Production composition: `tests/e2e/production-repair-loop.test.ts`
