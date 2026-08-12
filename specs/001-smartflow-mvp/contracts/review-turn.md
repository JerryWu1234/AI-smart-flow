# Composite Review Turn Contract

**Status**: Current contract
**Date**: 2026-08-11
**Sole public Review orchestration**: `smartflow_execute → smartflow_review_turn*`

## Purpose and ownership

`smartflow_review_turn` is the only public Review continuation entry point after an approved Run starts. The Daemon internally owns deterministic waiting, Review Action claim/renewal, Review submission, accept/repair/pause planning, approved-scope repair continuation, and Publish progression. The Host remains the only component allowed to create/resume a Reviewer session or communicate with the user. The Daemon never creates or replaces a Reviewer.

The public MCP surface contains exactly six tools: `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`. The latter four are separate Run-management APIs, not Review continuations or a second Review orchestration path. Public `smartflow_resume` is an independent paused-Run recovery API; while an active `hostTurn` exists, it cannot submit a ReviewTurn answer or bypass ownership. The `HostActionLoop` symbol and public symbols, schemas, handlers, registrations, and aliases for `smartflow_wait`, `smartflow_claim_action`, `smartflow_renew_action_claim`, `smartflow_submit_review`, and `smartflow_submit_leader_decision` do not exist. Their Review orchestration operations are Daemon-internal mechanics only.

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

Returns `projectId`, `jobId`, `revision`, `stateVersion`, current `phase`, `progress`, and bounded `retryAfterMs`. It never contains `worktreePath`, claim credentials, or Reviewer internals. The Host waits for `retryAfterMs` and calls the composite tool again with a new request ID.

A stale `review`, `reviewUnavailableReason`, or `answer` continuation returns the current no-path `NOT_READY` state rather than replaying a side effect or redisclosing a worktree.

### `REVIEW_REQUIRED`

Returned only after the Daemon has durably recorded claim intent, successfully claimed/reconciled the current Review Action, and persisted `AWAITING_REVIEW`. It includes:

- `turnToken`, `reviewAttemptId`, `taskSourceHash`, `candidateHash`, and complete `changedPaths`;
- the claimed `worktreePath`, disclosed only in this state to the owning Host;
- `reviewerSession: { mode: "CREATE" }` for the first round or `{ mode: "RESUME", reviewerSessionId }` thereafter;
- the current `piSessionId` for provenance separation;
- the fixed review `deadlineAt`.

The Host opens that worktree, rereads the synchronized Task and current files, executes exactly the requested Reviewer session mode, and submits the structured result with the same `turnToken`. The Reviewer session must differ from the Pi session.

### `USER_INPUT_REQUIRED`

Returns a durable pause with `turnToken`, `pause.code`, `pause.message`, legal mutable `options`, separate read-only `inspectionOptions`, the canonical paused `result`, and, when needed, `requiredInput`. Revision approval uses `mode: "COLLECT"` with a non-submit-ready `inputForm` when user values are missing, or `mode: "CONFIRM"` with a complete schema-valid `answer` when all values are available. It may include current Review or repair draft evidence, but never the claimed worktree path.

- `AUTOMATIC_REPAIR_LIMIT` may offer `resume_review_decision`; the owning Host submits that answer through `smartflow_review_turn` with the active `turnToken`, after which HostTurnCoordinator invokes Daemon resume mechanics internally, resets `autoRepairRounds` to zero, and allows the next group of up to 15 rounds.
- `INVALID_REVIEW` offers only `cancel`; incomplete Review without actionable blocking findings is never converted into guessed repair work.
- Other pause codes expose only actions already allowed by the Run's durable `resumeActions`.

Only the Host communicates these choices to the user and submits an answer through `smartflow_review_turn`. Option names such as `resume_review_decision` and `cancel` are typed ReviewTurn answer values; submitting them does not invoke the separate public `smartflow_resume` or `smartflow_cancel` APIs. Those APIs remain independent Run-management operations rather than Review continuations. In particular, public `smartflow_resume` cannot answer an active `hostTurn` checkpoint or bypass its owner/token checks.

### `DONE`

Returned only when the Run is in `COMPLETED`, `CANCELED`, or `FAILED`. It directly contains canonical `ResultOutput`. That payload has the same shape as the independent `smartflow_result` response, but producing `DONE` does not call that public API. Nonterminal pauses and conflicts must use `USER_INPUT_REQUIRED`, not `DONE`.

## Durable Host-turn checkpoint

Project state remains schema version 4. Each Run may persist:

```ts
type HostTurn =
  | { stage: "CLAIMING"; turnToken: string; hostTurnId: string; revision: number;
      actionId: string; startedAt: string; deadlineAt: string }
  | { stage: "AWAITING_REVIEW"; turnToken: string; hostTurnId: string; revision: number;
      actionId: string; claimId: string; reviewAttemptId: string;
      startedAt: string; deadlineAt: string }
  | { stage: "AWAITING_USER_INPUT"; turnToken: string; hostTurnId: string;
      revision: number; pauseCode: string; startedAt: string };
```

`RunRecord.autoRepairRounds` counts daemon-started repair rounds in the current allowance. The owning Host submits `resume_review_decision` through `smartflow_review_turn` with the active `turnToken`; HostTurnCoordinator invokes Daemon resume mechanics internally, clears the checkpoint, and resets the counter to zero. Checkpoints are durable-first and are not inferred from logs or an in-memory Host call.

## Mechanical decision policy

After validating a current Review, the Daemon uses one deterministic plan:

| Review result | Plan | Effect |
|---|---|---|
| `APPROVE`, 100%, no blocking finding | `ACCEPT` | submit accept and progress to Publish |
| Incomplete with one or more blocking findings and budget `< 15` | `REPAIR` | submit only reviewer-fingerprint RepairItems; create/approve same-scope repair Revision |
| Incomplete with no actionable blocking finding | `PAUSE_INVALID_REVIEW` | durable `INVALID_REVIEW`; only cancel |
| Incomplete with actionable findings and budget `>= 15` | `PAUSE_REPAIR_LIMIT` | durable `AUTOMATIC_REPAIR_LIMIT`; ask whether to grant another 15 |

The Host does not re-evaluate or resubmit these mechanical decisions. It still owns Reviewer execution and every user decision.

## Serialization, CAS, and idempotency

- All composite turns for one `projectId + jobId` execute through a per-Run queue.
- Every state mutation uses Project-wide `stateVersion` CAS. An operation makes at most four total attempts, including the initial attempt and up to three retries after fresh rereads.
- Daemon-internal operations use deterministic request IDs derived from the stable `turnToken`; retries cannot duplicate Action claim, Review persistence, repair, resume application, decision, or Publish effects.
- Claim intent is persisted before the Daemon-internal Action claim. A lost response is reconciled from durable `pendingAction` and `hostTurn`.
- The review deadline is 30 minutes. Claims renew every 60 seconds or 30 seconds before lease expiry, whichever is earlier. Transient renew failures retry after 1 second; three failures cause a durable Host-review-unavailable pause.
- On Daemon restart, `HostTurnCoordinator.recoverRun()` is the sole Review-turn recovery authority while `hostTurn` exists. `ProjectRuntime` rereads fresh state afterward and does not start ordinary Run recovery until the checkpoint is cleared.

## Public MCP surface

Exactly six tools are registered:

1. `smartflow_execute`
2. `smartflow_review_turn`
3. `smartflow_status`
4. `smartflow_resume`
5. `smartflow_cancel`
6. `smartflow_result`

`smartflow_execute → smartflow_review_turn*` is the sole public Review orchestration path. `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result` are separate Run-management APIs, not Review continuations or a second Review orchestration path. Public `smartflow_resume` is for independent paused-Run recovery and cannot answer or bypass an active `hostTurn`. The `HostActionLoop` symbol and public symbols, schemas, handlers, registrations, and aliases for `smartflow_wait`, `smartflow_claim_action`, `smartflow_renew_action_claim`, `smartflow_submit_review`, and `smartflow_submit_leader_decision` do not exist; those Review mechanics are Daemon-internal only.

## Implementation and tests

- Protocol: `packages/protocol/src/schema/mcp-tools.ts`, `packages/protocol/src/schema/protocol.test.ts`
- MCP registry/handler: `apps/mcp-server/src/tools/index.ts`, `apps/mcp-server/src/tools/review-turn.ts`, `tests/contract/mcp-v5.test.ts`
- Coordinator/recovery: `apps/daemon/src/host-turn-coordinator.ts`, `apps/daemon/src/project-runtime.ts`, `apps/daemon/src/host-turn-coordinator.test.ts`
- State checkpoint: `packages/state-store/src/schema.ts`, `packages/state-store/src/schema.test.ts`
- Mechanical policy: `packages/review/src/review-decision.ts`, `packages/review/src/review-decision.test.ts`
- Host two-tool loop: `apps/host-skill/src/workflow.ts`, `apps/host-skill/src/workflow.test.ts`
- Production composition: `tests/e2e/production-repair-loop.test.ts`
