# Composite Review Turn Contract

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
    result: ReviewSubmission | TaskCompletionReview;
  };
  answer?: ResumeAction | {
    action: ResumeAction;
    tasksPath?: string;
    approvedSourceHash?: string;
    approval: RevisionApproval;
  };
  reviewUnavailableReason?: string;
}
```

`review`, `answer`, and `reviewUnavailableReason` are mutually exclusive. Any continuation requires the exact `turnToken` returned by the active turn. `hostTurnId` durably owns that turn; another Host cannot take it over implicitly.

## Four public states

```ts
type ReviewTurnOutput =
  | NotReady
  | ReviewRequired
  | UserInputRequired
  | Done;
```

### `NOT_READY`

Returns `projectId`, `jobId`, `revision`, `stateVersion`, current `phase`, `progress`, and bounded `retryAfterMs`. It never contains `worktreePath`, turn authority, or Reviewer internals. The Host waits for `retryAfterMs` and calls the composite tool again with a new request ID.

A stale `review`, `reviewUnavailableReason`, or `answer` continuation returns the current no-path `NOT_READY` state rather than replaying a side effect or redisclosing a worktree.

### `REVIEW_REQUIRED`

Returned only after one CAS mutation has validated the current Review context, moved the Run to `REVIEWING`, and persisted `AWAITING_REVIEW`. It includes:

- `turnToken`, `reviewAttemptId`, `taskSourceHash`, `candidateHash`, and complete `changedPaths`;
- the bound `worktreePath`, disclosed only in this state to the owning Host;
- `reviewerSession: { mode: "CREATE" }` for the first round or `{ mode: "RESUME", reviewerSessionId }` thereafter;
- the current `piSessionId` for provenance separation;
- the fixed review `deadlineAt`.

The Host opens that worktree, rereads the synchronized Task and current files, executes exactly the requested Reviewer session mode, and submits the structured result with the same `turnToken`. The Reviewer session must differ from the Pi session.

### `USER_INPUT_REQUIRED`

Returns a durable pause with `turnToken`, `pause.code`, `pause.message`, legal mutable `options`, separate read-only `inspectionOptions`, the canonical paused `result`, and, when needed, `requiredInput`. Revision approval uses `mode: "COLLECT"` with a non-submit-ready `inputForm` when user values are missing, or `mode: "CONFIRM"` with a complete schema-valid `answer` when all values are available. It may include current Review or repair draft evidence. An optional `worktreePath` is allowed only for an owning Host's publish-related pause; non-publish pauses never disclose one.

- `AUTOMATIC_REPAIR_LIMIT` may offer `resume_review_decision`; the owning Host submits that answer through `smartflow_review_turn` with the active `turnToken`. HostTurnCoordinator atomically re-evaluates the stored Review with a reset allowance and proceeds directly to repair or another real pause.
- `INVALID_REVIEW` offers only `cancel`; incomplete Review without actionable blocking findings is never converted into guessed repair work.
- `PUBLISH_ADAPTER_UNAVAILABLE`, `PUBLISH_PRECHECK_CONFLICT`, and a follow-up `MANUAL_PUBLISH_TARGET_MISMATCH` expose the reviewed Candidate `worktreePath` only to the owning Host. The first two may offer `confirm_manual_publish`; the Host obtains user confirmation after an external merge, and the Daemon completes only if every Candidate target kind/hash/mode already matches. `PUBLISH_RECOVERY_BLOCKED` never offers this action.
- Other pause codes expose only actions already allowed by the Run's durable `resumeActions`.

Only the Host communicates these choices to the user and submits an answer through `smartflow_review_turn`. Option names such as `resume_review_decision` and `cancel` are typed ReviewTurn answer values; submitting them does not invoke the separate public `smartflow_resume` or `smartflow_cancel` APIs. Those APIs remain independent Run-management operations rather than Review continuations. In particular, public `smartflow_resume` cannot answer an active `hostTurn` checkpoint or bypass its owner/token checks.

### `DONE`

Returned only when the Run is in `COMPLETED`, `CANCELED`, or `FAILED`. It directly contains canonical `ResultOutput`. That payload has the same shape as the independent `smartflow_result` response, but producing `DONE` does not call that public API. Nonterminal pauses and conflicts must use `USER_INPUT_REQUIRED`, not `DONE`.

## Durable Host-turn checkpoint

Project state uses schema version 6. Startup migration is explicit and idempotent: schema-v4 state first receives the historical v4→v5 Review conversion (safe active claim states become `AWAITING_REVIEW`, while ambiguous `REVIEWING` state pauses as `HOST_REVIEW_UNAVAILABLE`), then schema-v5 state is upgraded with current Publish precheck, attempt, and manual-confirmation evidence. Removed bundle references and `export_bundle` pause actions are disconnected during v5→v6 migration without deleting legacy files from disk. Each Run may persist:

```ts
type HostTurn =
  | { stage: "AWAITING_REVIEW"; turnToken: string; hostTurnId: string;
      revision: number; reviewAttemptId: string;
      startedAt: string; deadlineAt: string }
  | { stage: "AWAITING_USER_INPUT"; turnToken: string; hostTurnId: string;
      revision: number; pauseCode: string; startedAt: string };
```

`RunRecord.autoRepairRounds` counts daemon-started repair rounds in the current allowance. The owning Host submits `resume_review_decision` through `smartflow_review_turn` with the active `turnToken`; HostTurnCoordinator atomically re-evaluates the stored Review with a reset counter. Checkpoints are durable-first and are not inferred from logs or an in-memory Host call.

## Mechanical decision policy

After validating a current Review, the Daemon uses one deterministic plan:

| Review result | Plan | Effect |
|---|---|---|
| `APPROVE`, 100%, no blocking finding | `ACCEPT` | write Review and decision evidence in one mutation, then progress to Publish |
| Incomplete with one or more blocking findings and budget `< 15` | `REPAIR` | write Review and decision evidence in one mutation, then create/approve the same-scope repair Revision |
| Incomplete with no actionable blocking finding | `PAUSE_INVALID_REVIEW` | durable `INVALID_REVIEW`; only cancel |
| Incomplete with actionable findings and budget `>= 15` | `PAUSE_REPAIR_LIMIT` | durable `AUTOMATIC_REPAIR_LIMIT`; ask whether to grant another 15 |

The Host does not re-evaluate or resubmit these mechanical decisions. It still owns Reviewer execution and every user decision.

## CAS, idempotency, and deadline

- Every state mutation uses Project-wide `stateVersion` CAS; a competing writer yields a fresh no-path continuation rather than replaying a partial primitive sequence.
- Daemon-internal operation request IDs are deterministic hashes of stable turn identity and operation scope.
- Review begin is one mutation: context validation, `REVIEWING`, and `AWAITING_REVIEW` commit together. A lost response is reconstructed from that durable state without a second begin.
- Review finalization is one domain operation: Review and automatic-decision artifacts are written before one state commit directly to `READY_TO_PUBLISH`, `FIXING`, or a real `PAUSED` state. New paths do not produce `LEADER_DECISION`.
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

- Protocol: `packages/protocol/src/schema/mcp-tools.ts`, `tests/unit/packages/protocol/schema/protocol.test.ts`
- MCP registry/handler: `apps/mcp-server/src/tools/index.ts`, `apps/mcp-server/src/tools/review-turn.ts`, `tests/contract/mcp-v5.test.ts`
- Coordinator/recovery: `apps/daemon/src/host-turn-coordinator.ts`, `apps/daemon/src/project-runtime.ts`, `tests/unit/apps/daemon/host-turn-coordinator.test.ts`
- State checkpoint: `packages/state-store/src/schema.ts`, `tests/unit/packages/state-store/schema.test.ts`
- Mechanical policy: `packages/review/src/review-decision.ts`, `tests/unit/packages/review/review-decision.test.ts`
- Native Host contract/direct MCP loop: `apps/mcp-server/src/server.ts`, `tests/fixtures/installed-mcp-lifecycle-child.mjs`
- Repository-only Host simulation: `tests/helpers/host-workflow/workflow.ts`, `tests/unit/helpers/host-workflow/workflow.test.ts`
- Production composition: `tests/e2e/production-repair-loop.test.ts`
