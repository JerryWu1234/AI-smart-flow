# Composite Review Turn Contract

**Status**: Current target contract (implementation gaps tracked by T204/T205)
**Date**: 2026-08-11
**Preferred Host flow**: `smartflow_execute → smartflow_review_turn`

## Purpose and ownership

`smartflow_review_turn` is the single high-level continuation entry point after an approved Run starts. The Daemon owns deterministic waiting, Review Action claim/renewal, Review submission, accept/repair/pause planning, approved-scope repair continuation, and Publish progression. The Host remains the only component allowed to create/resume a Reviewer session or communicate with the user. The Daemon never creates or replaces a Reviewer.

The ten primitive MCP tools remain public for compatibility, diagnostics, and low-level recovery. A high-level Host workflow should not reconstruct the state machine from them.

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

- `AUTOMATIC_REPAIR_LIMIT` may offer `resume_review_decision`; choosing it resets the next automatic-repair allowance to 15 rounds.
- `INVALID_REVIEW` offers only `cancel`; incomplete Review without actionable blocking findings is never converted into guessed repair work.
- Other pause codes expose only actions already allowed by the Run's durable `resumeActions`.

Only the Host communicates these choices to the user and submits an answer.

### `DONE`

Returned only when the Run is in `COMPLETED`, `CANCELED`, or `FAILED`. It contains the canonical `smartflow_result` payload. Nonterminal pauses and conflicts must use `USER_INPUT_REQUIRED`, not `DONE`.

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

`RunRecord.autoRepairRounds` counts daemon-started repair rounds in the current allowance. `resume_review_decision` resets it to zero. Checkpoints are durable-first and are not inferred from logs or an in-memory Host call.

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
- Child calls use deterministic request IDs derived from the stable `turnToken`; retries cannot duplicate claim, Review submission, repair, resume, or decision effects.
- Claim intent is persisted before the claim primitive. A lost response is reconciled from durable `pendingAction` and `hostTurn`.
- The review deadline is 30 minutes. Claims renew every 60 seconds or 30 seconds before lease expiry, whichever is earlier. Transient renew failures retry after 1 second; three failures cause a durable Host-review-unavailable pause.
- On Daemon restart, `HostTurnCoordinator.recoverRun()` is the sole recovery authority while `hostTurn` exists. `ProjectRuntime` rereads fresh state afterward and does not start legacy pipeline recovery until the checkpoint is cleared.

## Public MCP surface

Exactly eleven tools are registered:

1. `smartflow_execute`
2. `smartflow_status`
3. `smartflow_wait`
4. `smartflow_review_turn`
5. `smartflow_claim_action`
6. `smartflow_renew_action_claim`
7. `smartflow_submit_review`
8. `smartflow_submit_leader_decision`
9. `smartflow_resume`
10. `smartflow_cancel`
11. `smartflow_result`

The legacy ten remain compatible; `smartflow_review_turn` is the preferred composite API.

## Implementation and tests

- Protocol: `packages/protocol/src/schema/mcp-tools.ts`, `packages/protocol/src/schema/protocol.test.ts`
- MCP registry/handler: `apps/mcp-server/src/tools/index.ts`, `apps/mcp-server/src/tools/review-turn.ts`, `tests/contract/mcp-v5.test.ts`
- Coordinator/recovery: `apps/daemon/src/host-turn-coordinator.ts`, `apps/daemon/src/project-runtime.ts`, `apps/daemon/src/host-turn-coordinator.test.ts`
- State checkpoint: `packages/state-store/src/schema.ts`, `packages/state-store/src/schema.test.ts`
- Mechanical policy: `packages/review/src/review-decision.ts`, `packages/review/src/review-decision.test.ts`
- Host two-tool loop: `apps/host-skill/src/workflow.ts`, `apps/host-skill/src/workflow.test.ts`
- Production composition: `tests/e2e/production-repair-loop.test.ts`
