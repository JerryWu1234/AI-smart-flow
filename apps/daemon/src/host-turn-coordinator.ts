import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  claimActionOutputSchema,
  durableReviewDecisionSchema,
  hostActionSchema,
  renewActionClaimOutputSchema,
  resultOutputSchema,
  resumeActionSchema,
  reviewResultSubmitOutputSchema,
  reviewTurnOutputSchema,
  statusOutputSchema,
  waitOutputSchema,
  type ClaimActionInput,
  type HostAction,
  type RenewActionClaimInput,
  type ReportHostUnavailableInput,
  type ResumeInput,
  type ReviewResultSubmitInput,
  type ReviewSubmission,
  type ReviewTurnInput,
  type ReviewTurnOutput,
  type SubmitLeaderDecisionInput
} from "@smartflow/protocol";
import { planReviewDecision, REPAIR_ROUND_LIMIT } from "@smartflow/review";
import {
  StateStore,
  StateStoreError,
  type HostTurn,
  type ProjectState,
  type RunRecord
} from "@smartflow/state-store";

import { ProjectMutationExecutor } from "./project-mutation-executor.js";

const DEFAULT_WAIT_MS = 25_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const RENEW_INTERVAL_MS = 60_000;
const CLAIM_RENEW_SAFETY_MS = 30_000;
const RENEW_FAILURE_RETRY_MS = 1_000;
const REVIEW_DEADLINE_MS = 30 * 60_000;
const CAS_RETRY_LIMIT = 4;
const RENEW_FAILURE_LIMIT = 3;
const TERMINAL_PHASES = new Set(["COMPLETED", "CANCELED", "FAILED"]);
const READ_ONLY_RESUME_ACTIONS = new Set<ResumeInput["resumeAction"]>([
  "leader_append_repair_tasks",
  "inspect_processes",
  "inspect_recovery",
  "inspect_conflict",
  "inspect_repair_diff",
  "inspect_no_progress",
  "export_bundle"
]);

interface HostTurnAuthorityOptions {
  expectedHostTurnToken: string;
}

interface LeaderDecisionOptions {
  automaticRepair?: boolean;
  clearHostTurn?: boolean;
  pauseCause?: "AUTOMATIC_REPAIR_LIMIT" | "INVALID_REVIEW";
  expectedHostTurnToken?: string;
}

interface ResumeOptions {
  clearHostTurn?: boolean;
  resetAutoRepairRounds?: boolean;
  expectedHostTurnToken?: string;
}

export interface HostTurnCoordinatorDependencies {
  store(projectId: string): StateStore;
  status(input: { projectId: string; jobId: string }): Promise<unknown>;
  wait(input: {
    projectId: string;
    jobId: string;
    afterStateVersion: number;
    timeoutMs: number;
  }): Promise<unknown>;
  claim(input: ClaimActionInput, options?: HostTurnAuthorityOptions): Promise<unknown>;
  renew(input: RenewActionClaimInput, options?: HostTurnAuthorityOptions): Promise<unknown>;
  submitReview(
    input: ReviewResultSubmitInput,
    options?: HostTurnAuthorityOptions
  ): Promise<unknown>;
  reportHostUnavailable(
    input: ReportHostUnavailableInput,
    options?: HostTurnAuthorityOptions
  ): Promise<unknown>;
  submitLeaderDecision(
    input: SubmitLeaderDecisionInput,
    options?: LeaderDecisionOptions
  ): Promise<unknown>;
  resume(input: ResumeInput, options?: ResumeOptions): Promise<unknown>;
  result(input: { projectId: string; jobId: string }): Promise<unknown>;
}

function childRequestId(seed: string, scope: string): string {
  const digest = createHash("sha256").update(`${seed}:${scope}`).digest("hex").slice(0, 40);
  const safeScope = scope.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 48);
  return `review-turn-${safeScope}-${digest}`;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function reviewAction(run: RunRecord): HostAction | undefined {
  const pending = run.pendingAction;
  if (pending?.type !== "REVIEW") return undefined;
  const parsed = hostActionSchema.safeParse({
    type: pending.type,
    actionId: pending.actionId,
    revision: pending.revision,
    taskSourceHash: pending.taskSourceHash,
    candidateHash: pending.candidateHash,
    reviewAttemptId: pending.reviewAttemptId,
    changedPaths: pending.changedPaths,
    reviewerSession: pending.reviewerSession,
    piSessionId: pending.piSessionId,
    expiresAt: pending.expiresAt
  });
  return parsed.success ? parsed.data : undefined;
}

function answerAction(answer: NonNullable<ReviewTurnInput["answer"]>): {
  action: ResumeInput["resumeAction"];
  tasksPath?: string;
  approvedSourceHash?: string;
  approval?: ResumeInput["approval"];
} {
  if (typeof answer === "string") return { action: answer };
  return {
    action: answer.action,
    tasksPath: answer.tasksPath,
    approvedSourceHash: answer.approvedSourceHash,
    approval: answer.approval
  };
}

function pauseMessage(run: RunRecord): string {
  const code = run.pause?.code ?? "RUN_PAUSED";
  if (code === "REPAIR_USER_APPROVAL_REQUIRED") {
    return "The repair revision exceeds automatic approval scope and requires user approval.";
  }
  if (code === "REPAIR_NO_PROGRESS") {
    return "Automatic repair is not making progress; inspect the repair state or cancel the run.";
  }
  if (code === "AUTOMATIC_REPAIR_LIMIT" || (
    code === "LEADER_PAUSED" && (run.autoRepairRounds ?? 0) >= REPAIR_ROUND_LIMIT
  )) {
    return `The automatic repair limit of ${String(REPAIR_ROUND_LIMIT)} rounds was reached. Continue to grant another ${String(REPAIR_ROUND_LIMIT)} rounds, or cancel.`;
  }
  if (code === "INVALID_REVIEW" || code === "LEADER_PAUSED") {
    return "The Reviewer result did not contain actionable incomplete-task guidance.";
  }
  if (code === "HOST_REVIEW_UNAVAILABLE") {
    return run.lastError?.message ?? "The bound Host Reviewer is unavailable.";
  }
  if (code.includes("PUBLISH") || code.includes("CONFLICT")) {
    return run.lastError?.message ?? "Publishing requires user attention before the run can continue.";
  }
  return run.lastError?.message ?? `The run paused with code ${code}.`;
}

function durableResumeActions(run: RunRecord): ResumeInput["resumeAction"][] {
  return (run.pause?.resumeActions ?? []).flatMap((action) => {
    const parsed = resumeActionSchema.safeParse(action);
    return parsed.success ? [parsed.data] : [];
  });
}

function mutableResumeActions(run: RunRecord): ResumeInput["resumeAction"][] {
  const actions = durableResumeActions(run).filter(
    (action) => !READ_ONLY_RESUME_ACTIONS.has(action)
  );
  return actions.length > 0 ? actions : ["cancel"];
}

function inspectionResumeActions(run: RunRecord): ResumeInput["resumeAction"][] {
  return durableResumeActions(run).filter((action) => READ_ONLY_RESUME_ACTIONS.has(action));
}

function optionDescription(action: string): string {
  const descriptions: Record<string, string> = {
    approve_new_manifest_revision: "Approve the supplied revision and continue the run",
    cancel: "Cancel the run and preserve its current evidence",
    export_bundle: "Inspect or export the prepared delivery bundle",
    inspect_conflict: "Inspect the durable publish conflict evidence",
    inspect_no_progress: "Inspect why automatic repair stopped making progress",
    inspect_processes: "Inspect the unresolved Pi process containment evidence",
    inspect_recovery: "Inspect the durable recovery evidence",
    inspect_repair_diff: "Inspect the proposed repair task revision",
    leader_append_repair_tasks: "Inspect the repair-task append guidance",
    resume: "Resume the paused run",
    resume_review_decision: "Grant another fifteen automatic repair rounds",
    retry_host_review: "Retry review with the same bound Reviewer session",
    retry_publish: "Retry publishing the accepted Candidate",
    retry_provider_probe: "Retry the Provider availability check",
    retry_git_probe: "Retry the Git capability check",
    retry_provider: "Retry the Provider operation",
    retry_cancel: "Retry cancellation",
    retry: "Retry the failed workflow stage",
    restore_approved_tasks: "Continue after restoring the approved task source"
  };
  return descriptions[action] ?? `Continue with ${action}`;
}

function runKey(projectId: string, jobId: string): string {
  return `${projectId}:${jobId}`;
}

interface RenewalTimer {
  timer: ReturnType<typeof setTimeout>;
  dueAt: number;
}

function isStateVersionMismatch(error: unknown): error is StateStoreError {
  return error instanceof StateStoreError && error.code === "STATE_VERSION_MISMATCH";
}

function deterministicTurnToken(input: ReviewTurnInput, scope: string): string {
  return childRequestId(`${input.requestId}:${input.hostTurnId}`, scope).replace(
    /^review-turn-/u,
    "turn-"
  );
}

export class HostTurnCoordinator {
  private readonly timers = new Map<string, RenewalTimer>();
  private readonly renewalFailures = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  private disposed = false;

  public constructor(private readonly dependencies: HostTurnCoordinatorDependencies) {}

  public turn(input: ReviewTurnInput): Promise<ReviewTurnOutput> {
    return this.serialize(runKey(input.projectId, input.jobId), async () => {
      try {
        if (input.review !== undefined) return await this.submitReviewTurn(input);
        if (input.reviewUnavailableReason !== undefined) {
          return await this.reportReviewUnavailable(input);
        }
        if (input.answer !== undefined) return await this.submitAnswer(input);
        return await this.advance(input, Date.now() + DEFAULT_WAIT_MS);
      } catch (error) {
        if (!isStateVersionMismatch(error)) throw error;
        return this.staleContinuation(input);
      }
    });
  }

  public recoverRun(projectId: string, jobId: string): Promise<void> {
    const key = runKey(projectId, jobId);
    return this.serialize(key, async () => {
      const state = await this.dependencies.store(projectId).readState();
      const run = state.runs[jobId];
      const turn = run?.hostTurn;
      if (run === undefined || turn === undefined) return;
      if (turn.stage === "CLAIMING") {
        this.scheduleClaimingWake(projectId, jobId, state);
        try {
          await this.recoverClaiming(projectId, jobId, state, run, turn);
        } catch {
          // Recovery must not prevent the daemon from accepting IPC connections. A near-term
          // wake reconciles a claim whose response was lost, or restores the deadline wake.
          this.scheduleWakeAt(projectId, jobId, Date.now() + RENEW_FAILURE_RETRY_MS);
        }
        return;
      }
      if (turn.stage !== "AWAITING_REVIEW") return;
      const now = Date.now();
      const leaseExpiresAt = Date.parse(stringField(run.pendingAction, "claimExpiresAt") ?? "");
      if (
        Date.parse(turn.deadlineAt) <= now ||
        !Number.isFinite(leaseExpiresAt) ||
        leaseExpiresAt <= now
      ) {
        try {
          await this.pauseActiveReview(
            projectId,
            jobId,
            turn,
            Date.parse(turn.deadlineAt) <= now
              ? "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded"
              : "HOST_REVIEW_UNAVAILABLE:review claim lease expired during daemon recovery"
          );
        } catch {
          // A transient pause/report failure must not prevent daemon startup. renewOnce
          // revalidates the same durable turn before retrying the pause.
          this.scheduleWakeAt(projectId, jobId, Date.now() + RENEW_FAILURE_RETRY_MS);
        }
        return;
      }
      this.scheduleRenewal(projectId, jobId, state);
    });
  }

  public dispose(): void {
    this.disposed = true;
    for (const entry of this.timers.values()) clearTimeout(entry.timer);
    this.timers.clear();
    this.renewalFailures.clear();
  }

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const marker = new Promise<void>((resolveMarker) => { release = resolveMarker; });
    const queued = previous.then(() => marker, () => marker);
    this.queues.set(key, queued);
    return previous.then(task, task).finally(() => {
      release();
      if (this.queues.get(key) === queued) this.queues.delete(key);
    });
  }

  private async advance(input: ReviewTurnInput, deadline: number): Promise<ReviewTurnOutput> {
    for (;;) {
      const status = statusOutputSchema.parse(await this.dependencies.status(input));
      if (TERMINAL_PHASES.has(status.phase)) {
        return reviewTurnOutputSchema.parse({
          kind: "DONE",
          result: resultOutputSchema.parse(await this.dependencies.result(input))
        });
      }
      if (status.phase === "PAUSED") {
        if (status.pause?.code === "REPAIR_TASKS_READY") {
          const result = resultOutputSchema.parse(await this.dependencies.result(input));
          const draft = result.repairDraft;
          if (draft?.approval.kind === "LEADER_REPAIR") {
            await this.resumeWithCasRetry(
              input,
              childRequestId(input.requestId, `approve-r${String(status.revision)}`),
              "approve_new_manifest_revision",
              () => ({ approval: draft.approval })
            );
            continue;
          }
        }
        return this.requireUserInput(input, status.revision);
      }
      if (status.phase === "REVIEW_PENDING") {
        return this.claimReview(input, status.revision);
      }
      if (status.phase === "REVIEWING") {
        const state = await this.dependencies.store(input.projectId).readState();
        const run = state.runs[input.jobId];
        if (run === undefined) throw new Error("RUN_NOT_FOUND");
        if (run.hostTurn?.stage === "CLAIMING") {
          return this.reconcileClaim(input, run.hostTurn, state);
        }
        if (run.hostTurn?.stage === "AWAITING_REVIEW") {
          if (Date.parse(run.hostTurn.deadlineAt) <= Date.now()) {
            await this.expireReviewTurn(input.projectId, input.jobId);
            continue;
          }
          this.assertHostOwner(run.hostTurn, input.hostTurnId);
          this.scheduleRenewal(input.projectId, input.jobId, state);
          return this.reviewRequired(state, run, run.hostTurn);
        }
        return this.notReady(status);
      }
      if (status.phase === "LEADER_DECISION") {
        await this.continueLeaderDecision(input);
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return this.notReady(status);
      const waited = waitOutputSchema.parse(await this.dependencies.wait({
        projectId: input.projectId,
        jobId: input.jobId,
        afterStateVersion: status.stateVersion,
        timeoutMs: Math.min(DEFAULT_WAIT_MS, remaining)
      }));
      if (!waited.changed) return this.notReady(waited.summary);
    }
  }

  private notReady(status: ReturnType<typeof statusOutputSchema.parse>): ReviewTurnOutput {
    return reviewTurnOutputSchema.parse({
      kind: "NOT_READY",
      projectId: status.projectId,
      jobId: status.jobId,
      revision: status.revision,
      stateVersion: status.stateVersion,
      phase: status.phase,
      retryAfterMs: DEFAULT_RETRY_AFTER_MS,
      progress: status.progress
    });
  }

  private async staleContinuation(input: ReviewTurnInput): Promise<ReviewTurnOutput> {
    const status = statusOutputSchema.parse(await this.dependencies.status({
      projectId: input.projectId,
      jobId: input.jobId
    }));
    return this.notReady(status);
  }

  private async claimReview(
    input: ReviewTurnInput,
    revision: number
  ): Promise<ReviewTurnOutput> {
    const store = this.dependencies.store(input.projectId);
    let state = await store.readState();
    let run = state.runs[input.jobId];
    if (run === undefined) throw new Error("RUN_NOT_FOUND");
    if (run.hostTurn?.stage === "AWAITING_REVIEW") {
      this.assertHostOwner(run.hostTurn, input.hostTurnId);
      this.scheduleRenewal(input.projectId, input.jobId, state);
      return this.reviewRequired(state, run, run.hostTurn);
    }
    if (run.hostTurn?.stage === "CLAIMING") {
      if (Date.parse(run.hostTurn.deadlineAt) <= Date.now()) {
        if (run.phase === "REVIEWING") {
          await this.pauseActiveReview(
            input.projectId,
            input.jobId,
            run.hostTurn,
            "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded"
          );
        } else {
          await this.clearClaimIntent(input.projectId, input.jobId, run.hostTurn);
        }
        return this.staleContinuation(input);
      }
      this.assertHostOwner(run.hostTurn, input.hostTurnId);
      if (run.phase === "REVIEWING") {
        return this.reconcileClaim(input, run.hostTurn, state);
      }
    }
    if (run.phase !== "REVIEW_PENDING" || run.revision !== revision) {
      return this.staleContinuation(input);
    }
    if (run.hostTurn !== undefined) this.assertHostOwner(run.hostTurn, input.hostTurnId);
    const action = reviewAction(run);
    if (action === undefined) throw new Error("REVIEW_ACTION_MISSING");
    const now = new Date();
    const turnToken = run.hostTurn?.turnToken ?? deterministicTurnToken(input, "review");
    const intent: HostTurn = {
      stage: "CLAIMING",
      turnToken,
      hostTurnId: input.hostTurnId,
      revision,
      actionId: action.actionId,
      startedAt: run.hostTurn?.startedAt ?? now.toISOString(),
      deadlineAt: run.hostTurn?.stage === "CLAIMING"
        ? run.hostTurn.deadlineAt
        : new Date(now.getTime() + REVIEW_DEADLINE_MS).toISOString()
    };
    state = await this.persistHostTurn(
      store,
      input.jobId,
      childRequestId(turnToken, "claim-intent"),
      state.stateVersion,
      revision,
      intent,
      ["REVIEW_PENDING"]
    );
    this.scheduleClaimingWake(input.projectId, input.jobId, state);
    run = state.runs[input.jobId];
    if (run === undefined) throw new Error("RUN_NOT_FOUND");
    if (run.phase === "REVIEWING") return this.reconcileClaim(input, intent, state);

    const claimOutcome = await (async (): Promise<
      | { kind: "CLAIMED"; claim: ReturnType<typeof claimActionOutputSchema.parse> }
      | { kind: "RECOVERED"; output: ReviewTurnOutput }
    > => {
      try {
        const claim = await this.retryCas(async () => {
          const current = await store.readState();
          const currentRun = current.runs[input.jobId];
          const currentTurn = currentRun?.hostTurn;
          if (
            currentRun === undefined ||
            currentRun.phase !== "REVIEW_PENDING" ||
            currentRun.revision !== revision ||
            currentTurn?.stage !== "CLAIMING" ||
            currentTurn.turnToken !== turnToken
          ) {
            throw new Error("REVIEW_CLAIM_STATE_CHANGED");
          }
          this.assertHostOwner(currentTurn, input.hostTurnId);
          const currentAction = reviewAction(currentRun);
          if (currentAction === undefined || currentAction.actionId !== intent.actionId) {
            throw new Error("REVIEW_ACTION_MISSING");
          }
          return claimActionOutputSchema.parse(await this.dependencies.claim({
            requestId: childRequestId(turnToken, "claim"),
            projectId: input.projectId,
            jobId: input.jobId,
            expectedRevision: revision,
            expectedStateVersion: current.stateVersion,
            actionId: currentAction.actionId,
            hostTurnId: input.hostTurnId
          }, { expectedHostTurnToken: turnToken }));
        });
        return { kind: "CLAIMED", claim };
      } catch (error) {
        // The claim mutation may have committed even when its response was lost. Always
        // reconcile from durable state so the five-minute lease, not the stale Host
        // deadline, controls the next wake.
        const current = await store.readState();
        const currentRun = current.runs[input.jobId];
        const currentTurn = currentRun?.hostTurn;
        if (
          currentRun?.phase === "REVIEWING" &&
          currentTurn?.stage === "CLAIMING" &&
          currentTurn.turnToken === turnToken
        ) {
          this.assertHostOwner(currentTurn, input.hostTurnId);
          this.scheduleClaimingWake(input.projectId, input.jobId, current);
          try {
            return {
              kind: "RECOVERED",
              output: await this.reconcileClaim(input, currentTurn, current)
            };
          } catch (reconcileError) {
            this.scheduleWakeAt(
              input.projectId,
              input.jobId,
              Date.now() + RENEW_FAILURE_RETRY_MS
            );
            throw reconcileError;
          }
        }
        if (
          currentRun?.phase === "REVIEW_PENDING" &&
          currentTurn?.stage === "CLAIMING" &&
          currentTurn.turnToken === turnToken
        ) {
          this.scheduleWakeAt(
            input.projectId,
            input.jobId,
            Date.now() + RENEW_FAILURE_RETRY_MS
          );
        }
        throw error;
      }
    })();
    if (claimOutcome.kind === "RECOVERED") return claimOutcome.output;
    const { claim } = claimOutcome;
    this.scheduleClaimingWake(input.projectId, input.jobId, await store.readState());
    const awaiting: HostTurn = {
      ...intent,
      stage: "AWAITING_REVIEW",
      actionId: claim.action.actionId,
      claimId: claim.claimId,
      reviewAttemptId: claim.action.reviewAttemptId
    };
    state = await this.persistHostTurn(
      store,
      input.jobId,
      childRequestId(turnToken, "claim-complete"),
      claim.stateVersion,
      revision,
      awaiting,
      ["REVIEWING"]
    );
    run = state.runs[input.jobId];
    if (run === undefined) throw new Error("RUN_NOT_FOUND");
    this.scheduleRenewal(input.projectId, input.jobId, state);
    return this.reviewRequired(state, run, awaiting);
  }

  private async reconcileClaim(
    input: ReviewTurnInput,
    turn: Extract<HostTurn, { stage: "CLAIMING" }>,
    state: ProjectState
  ): Promise<ReviewTurnOutput> {
    const run = state.runs[input.jobId];
    if (run === undefined) throw new Error("RUN_NOT_FOUND");
    if (Date.parse(turn.deadlineAt) <= Date.now()) {
      if (run.phase === "REVIEWING") {
        await this.pauseActiveReview(
          input.projectId,
          input.jobId,
          turn,
          "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded"
        );
      } else {
        await this.clearClaimIntent(input.projectId, input.jobId, turn);
      }
      return this.staleContinuation(input);
    }
    this.assertHostOwner(turn, input.hostTurnId);
    const claimId = stringField(run.pendingAction, "claimId");
    const claimedHostTurnId = stringField(run.pendingAction, "hostTurnId");
    const claimExpiresAt = Date.parse(stringField(run.pendingAction, "claimExpiresAt") ?? "");
    const action = reviewAction(run);
    if (run.phase !== "REVIEWING" || claimId === undefined || action === undefined) {
      if (run.phase === "REVIEW_PENDING") {
        return this.claimReview(input, run.revision);
      }
      throw new Error("REVIEW_CLAIM_RECONCILIATION_FAILED");
    }
    if (
      claimedHostTurnId !== turn.hostTurnId ||
      action.actionId !== turn.actionId ||
      action.reviewAttemptId.length === 0
    ) {
      throw new Error("REVIEW_CLAIM_RECONCILIATION_FAILED");
    }
    if (!Number.isFinite(claimExpiresAt) || claimExpiresAt <= Date.now()) {
      await this.pauseActiveReview(
        input.projectId,
        input.jobId,
        turn,
        "HOST_REVIEW_UNAVAILABLE:review claim lease expired during claim recovery"
      );
      return this.staleContinuation(input);
    }
    const awaiting: HostTurn = {
      ...turn,
      stage: "AWAITING_REVIEW",
      actionId: action.actionId,
      claimId,
      reviewAttemptId: action.reviewAttemptId
    };
    const nextState = await this.persistHostTurn(
      this.dependencies.store(input.projectId),
      input.jobId,
      childRequestId(turn.turnToken, "claim-complete"),
      state.stateVersion,
      run.revision,
      awaiting,
      ["REVIEWING"]
    );
    const nextRun = nextState.runs[input.jobId];
    if (nextRun === undefined) throw new Error("RUN_NOT_FOUND");
    this.scheduleRenewal(input.projectId, input.jobId, nextState);
    return this.reviewRequired(nextState, nextRun, awaiting);
  }

  private reviewRequired(
    state: ProjectState,
    run: RunRecord,
    turn: Extract<HostTurn, { stage: "AWAITING_REVIEW" }>
  ): ReviewTurnOutput {
    const action = reviewAction(run);
    if (action === undefined || run.workspace === undefined) {
      throw new Error("REVIEW_ACTION_CONTEXT_MISSING");
    }
    return reviewTurnOutputSchema.parse({
      kind: "REVIEW_REQUIRED",
      projectId: state.projectId,
      jobId: run.jobId,
      revision: run.revision,
      stateVersion: state.stateVersion,
      turnToken: turn.turnToken,
      worktreePath: resolve(this.dependencies.store(state.projectId).dataDirectory, run.workspace.relativePath),
      reviewAttemptId: action.reviewAttemptId,
      taskSourceHash: action.taskSourceHash,
      candidateHash: action.candidateHash,
      changedPaths: action.changedPaths,
      reviewerSession: action.reviewerSession,
      piSessionId: action.piSessionId,
      deadlineAt: turn.deadlineAt
    });
  }

  private async submitReviewTurn(input: ReviewTurnInput): Promise<ReviewTurnOutput> {
    const store = this.dependencies.store(input.projectId);
    const submitted = await this.retryCas(async () => {
      const state = await store.readState();
      const run = state.runs[input.jobId];
      const turn = run?.hostTurn;
      if (
        run === undefined ||
        turn?.stage !== "AWAITING_REVIEW" ||
        turn.turnToken !== input.turnToken
      ) {
        return { kind: "STALE" as const };
      }
      this.assertHostOwner(turn, input.hostTurnId);
      if (Date.parse(turn.deadlineAt) <= Date.now()) {
        return { kind: "EXPIRED" as const, turn };
      }
      const action = reviewAction(run);
      const claimId = stringField(run.pendingAction, "claimId");
      if (action === undefined || claimId === undefined || input.review === undefined) {
        throw new Error("REVIEW_ACTION_CONTEXT_MISSING");
      }
      const response = await this.dependencies.submitReview({
        requestId: childRequestId(turn.turnToken, "submit-review"),
        projectId: input.projectId,
        jobId: input.jobId,
        expectedRevision: run.revision,
        expectedStateVersion: state.stateVersion,
        claimId,
        reviewAttemptId: action.reviewAttemptId,
        taskSourceHash: action.taskSourceHash,
        candidateHash: action.candidateHash,
        reviewerSessionId: input.review.reviewerSessionId,
        result: input.review.result
      }, { expectedHostTurnToken: turn.turnToken });
      return { kind: "SUBMITTED" as const, response, turnToken: turn.turnToken };
    });
    if (submitted.kind === "STALE") return this.staleContinuation(input);
    this.clearRenewal(input.projectId, input.jobId);
    if (submitted.kind === "EXPIRED") {
      await this.pauseActiveReview(
        input.projectId,
        input.jobId,
        submitted.turn,
        "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded"
      );
      return this.advance({ ...input, review: undefined }, Date.now() + DEFAULT_WAIT_MS);
    }
    const parsed = reviewResultSubmitOutputSchema.safeParse(submitted.response);
    if (!parsed.success) {
      const status = statusOutputSchema.parse(await this.dependencies.status(input));
      if (status.phase === "PAUSED") {
        return this.requireUserInput(input, status.revision);
      }
      throw new Error("REVIEW_SUBMISSION_RESPONSE_INVALID");
    }
    await this.applyReviewDecision(
      input,
      parsed.data.result,
      parsed.data.reviewHash,
      parsed.data.revision,
      submitted.turnToken
    );
    return this.advance({ ...input, review: undefined }, Date.now() + DEFAULT_WAIT_MS);
  }

  private async reportReviewUnavailable(input: ReviewTurnInput): Promise<ReviewTurnOutput> {
    const store = this.dependencies.store(input.projectId);
    const reported = await this.retryCas(async () => {
      const state = await store.readState();
      const run = state.runs[input.jobId];
      const turn = run?.hostTurn;
      const claimId = stringField(run?.pendingAction, "claimId");
      if (
        run === undefined ||
        turn?.stage !== "AWAITING_REVIEW" ||
        turn.turnToken !== input.turnToken ||
        input.reviewUnavailableReason === undefined ||
        claimId === undefined
      ) {
        return false;
      }
      this.assertHostOwner(turn, input.hostTurnId);
      await this.dependencies.reportHostUnavailable({
        requestId: childRequestId(turn.turnToken, "review-unavailable"),
        projectId: input.projectId,
        jobId: input.jobId,
        expectedRevision: run.revision,
        expectedStateVersion: state.stateVersion,
        claimId,
        hostUnavailableReason: input.reviewUnavailableReason.startsWith("HOST_REVIEW_UNAVAILABLE")
          ? input.reviewUnavailableReason
          : `HOST_REVIEW_UNAVAILABLE:${input.reviewUnavailableReason}`
      }, { expectedHostTurnToken: turn.turnToken });
      return true;
    });
    if (!reported) return this.staleContinuation(input);
    this.clearRenewal(input.projectId, input.jobId);
    return this.advance(
      { ...input, reviewUnavailableReason: undefined },
      Date.now() + DEFAULT_WAIT_MS
    );
  }

  private async continueLeaderDecision(input: ReviewTurnInput): Promise<void> {
    const store = this.dependencies.store(input.projectId);
    const state = await store.readState();
    const run = state.runs[input.jobId];
    if (run?.review === undefined) throw new Error("LEADER_REVIEW_BINDING_INVALID");
    const decision = durableReviewDecisionSchema.parse(JSON.parse(
      new TextDecoder().decode(await store.readArtifact(run.review))
    ));
    await this.applyReviewDecision(
      input,
      decision.gate.result,
      decision.reviewHash,
      run.revision,
      run.hostTurn?.turnToken ?? deterministicTurnToken(input, `decision-${decision.reviewHash}`)
    );
  }

  private async applyReviewDecision(
    input: ReviewTurnInput,
    result: ReviewSubmission,
    reviewHash: string,
    revision: number,
    turnToken: string
  ): Promise<void> {
    const store = this.dependencies.store(input.projectId);
    await this.retryCas(async () => {
      const state = await store.readState();
      const run = state.runs[input.jobId];
      if (run === undefined) throw new Error("RUN_NOT_FOUND");
      if (run.phase !== "LEADER_DECISION" || run.revision !== revision) {
        throw new Error("LEADER_REVIEW_BINDING_INVALID");
      }
      const plan = planReviewDecision({
        result,
        repairRounds: run.autoRepairRounds ?? 0
      });
      const decisionInput: SubmitLeaderDecisionInput = {
        requestId: childRequestId(turnToken, `decision-${plan.kind}-${reviewHash}`),
        projectId: input.projectId,
        jobId: input.jobId,
        expectedRevision: revision,
        expectedStateVersion: state.stateVersion,
        reviewHash,
        decision: plan.decision,
        repairItems: plan.decision === "repair" ? plan.repairItems : [],
        reason: plan.reason
      };
      if (plan.kind === "PAUSE_REPAIR_LIMIT") {
        await this.dependencies.submitLeaderDecision(decisionInput, {
          clearHostTurn: false,
          pauseCause: "AUTOMATIC_REPAIR_LIMIT",
          expectedHostTurnToken: turnToken
        });
        return;
      }
      if (plan.kind === "PAUSE_INVALID_REVIEW") {
        await this.dependencies.submitLeaderDecision(decisionInput, {
          clearHostTurn: false,
          pauseCause: "INVALID_REVIEW",
          expectedHostTurnToken: turnToken
        });
        return;
      }
      await this.dependencies.submitLeaderDecision(decisionInput, {
        clearHostTurn: true,
        automaticRepair: plan.kind === "REPAIR",
        expectedHostTurnToken: turnToken
      });
    });
  }

  private async requireUserInput(
    input: ReviewTurnInput,
    revision: number
  ): Promise<ReviewTurnOutput> {
    const store = this.dependencies.store(input.projectId);
    let state = await store.readState();
    let run = state.runs[input.jobId];
    if (run === undefined || run.phase !== "PAUSED" || run.pause === undefined) {
      throw new Error("USER_INPUT_NOT_READY");
    }
    if (run.hostTurn?.stage === "AWAITING_USER_INPUT") {
      this.assertHostOwner(run.hostTurn, input.hostTurnId);
      return this.userInputRequired(state, run, run.hostTurn);
    }
    const previousTurn = run.hostTurn;
    if (previousTurn !== undefined) this.assertHostOwner(previousTurn, input.hostTurnId);
    const turnToken = previousTurn === undefined
      ? deterministicTurnToken(input, `user-input-r${String(run.revision)}`)
      : childRequestId(
          previousTurn.turnToken,
          `user-input-r${String(run.revision)}-${run.pause.code}`
        ).replace(/^review-turn-/u, "turn-");
    const exposedPauseCode = run.pause.code === "LEADER_PAUSED"
      ? (run.autoRepairRounds ?? 0) >= REPAIR_ROUND_LIMIT
        ? "AUTOMATIC_REPAIR_LIMIT"
        : "INVALID_REVIEW"
      : run.pause.code;
    const turn: HostTurn = {
      stage: "AWAITING_USER_INPUT",
      turnToken,
      hostTurnId: previousTurn?.hostTurnId ?? input.hostTurnId,
      revision,
      pauseCode: exposedPauseCode,
      startedAt: new Date().toISOString()
    };
    state = await this.persistHostTurn(
      store,
      input.jobId,
      childRequestId(turnToken, "user-input"),
      state.stateVersion,
      revision,
      turn,
      ["PAUSED"],
      previousTurn?.turnToken ?? turnToken
    );
    run = state.runs[input.jobId];
    if (run === undefined) throw new Error("RUN_NOT_FOUND");
    return this.userInputRequired(state, run, turn);
  }

  private async userInputRequired(
    state: ProjectState,
    run: RunRecord,
    turn: Extract<HostTurn, { stage: "AWAITING_USER_INPUT" }>
  ): Promise<ReviewTurnOutput> {
    const durableReview = run.review === undefined
      ? undefined
      : durableReviewDecisionSchema.safeParse(JSON.parse(
          new TextDecoder().decode(
            await this.dependencies.store(state.projectId).readArtifact(run.review)
          )
        ));
    const review = durableReview?.success === true
      ? durableReview.data.gate.result
      : undefined;
    const result = resultOutputSchema.parse(await this.dependencies.result({
      projectId: state.projectId,
      jobId: run.jobId
    }));
    const repairDraft = result.repairDraft;
    const resumeActions = mutableResumeActions(run);
    const inspectionActions = inspectionResumeActions(run);
    const requiresRevisionApproval = resumeActions.includes("approve_new_manifest_revision");
    const revisionApprovalAnswer = repairDraft?.approval.kind === "USER"
      ? {
          action: "approve_new_manifest_revision" as const,
          tasksPath: repairDraft.suggestedTasksPath,
          approvedSourceHash: repairDraft.sourceHash,
          approval: repairDraft.approval
        }
      : undefined;
    return reviewTurnOutputSchema.parse({
      kind: "USER_INPUT_REQUIRED",
      projectId: state.projectId,
      jobId: run.jobId,
      revision: run.revision,
      stateVersion: state.stateVersion,
      turnToken: turn.turnToken,
      pause: {
        code: turn.pauseCode,
        message: pauseMessage(run)
      },
      result,
      ...(review === undefined ? {} : { review }),
      ...(repairDraft === undefined ? {} : { repairDraft }),
      ...(requiresRevisionApproval
        ? {
            requiredInput: revisionApprovalAnswer === undefined
              ? {
                  mode: "COLLECT",
                  action: "approve_new_manifest_revision",
                  fields: ["tasksPath", "approvedSourceHash", "approval"],
                  inputForm: {
                    tasksPath: null,
                    approvedSourceHash: null,
                    approval: null
                  }
                }
              : {
                  mode: "CONFIRM",
                  action: "approve_new_manifest_revision",
                  fields: ["tasksPath", "approvedSourceHash", "approval"],
                  answer: revisionApprovalAnswer
                }
          }
        : {}),
      inspectionOptions: inspectionActions.map((action) => ({
        action,
        description: optionDescription(action)
      })),
      options: resumeActions.map((answer) => ({
        answer,
        description: optionDescription(answer)
      }))
    });
  }

  private async submitAnswer(input: ReviewTurnInput): Promise<ReviewTurnOutput> {
    const store = this.dependencies.store(input.projectId);
    const answer = input.answer === undefined ? undefined : answerAction(input.answer);
    const resumed = await this.retryCas(async () => {
      const state = await store.readState();
      const run = state.runs[input.jobId];
      const turn = run?.hostTurn;
      if (
        run === undefined ||
        turn?.stage !== "AWAITING_USER_INPUT" ||
        turn.turnToken !== input.turnToken ||
        answer === undefined
      ) {
        return false;
      }
      this.assertHostOwner(turn, input.hostTurnId);
      if (!mutableResumeActions(run).includes(answer.action)) {
        throw new Error("REVIEW_TURN_ANSWER_NOT_ALLOWED");
      }
      await this.dependencies.resume({
        requestId: childRequestId(turn.turnToken, `answer-${answer.action}`),
        projectId: input.projectId,
        jobId: input.jobId,
        expectedRevision: run.revision,
        expectedStateVersion: state.stateVersion,
        resumeAction: answer.action,
        ...(answer.tasksPath === undefined ? {} : { tasksPath: answer.tasksPath }),
        ...(answer.approvedSourceHash === undefined
          ? {}
          : { approvedSourceHash: answer.approvedSourceHash }),
        ...(answer.approval === undefined ? {} : { approval: answer.approval })
      }, {
        clearHostTurn: true,
        resetAutoRepairRounds: answer.action === "resume_review_decision",
        expectedHostTurnToken: turn.turnToken
      });
      return true;
    });
    if (!resumed) return this.staleContinuation(input);
    return this.advance({ ...input, answer: undefined }, Date.now() + DEFAULT_WAIT_MS);
  }

  private async persistHostTurn(
    store: StateStore,
    jobId: string,
    requestId: string,
    expectedStateVersion: number,
    expectedRevision: number,
    hostTurn: HostTurn | undefined,
    expectedPhases: RunRecord["phase"][],
    expectedTurnToken = hostTurn?.turnToken
  ): Promise<ProjectState> {
    return this.retryCas(async (attempt) => {
      const stateVersion = attempt === 0
        ? expectedStateVersion
        : (await store.readState()).stateVersion;
      const mutation = await new ProjectMutationExecutor(store).mutate(
        {
          requestId,
          payload: { kind: "host-turn", jobId, hostTurn },
          expectedStateVersion: stateVersion,
          expectedJobId: jobId,
          expectedRevision,
          expectedPhases
        },
        (state) => {
          const run = state.runs[jobId];
          if (run === undefined) throw new Error("RUN_NOT_FOUND");
          if (
            expectedTurnToken !== undefined &&
            run.hostTurn !== undefined &&
            run.hostTurn.turnToken !== expectedTurnToken
          ) {
            throw new Error("HOST_TURN_STATE_CHANGED");
          }
          if (
            hostTurn !== undefined &&
            run.hostTurn !== undefined &&
            run.hostTurn.hostTurnId !== hostTurn.hostTurnId
          ) {
            throw new Error("HOST_TURN_STATE_CHANGED");
          }
          return {
            nextState: {
              ...state,
              runs: {
                ...state.runs,
                [jobId]: { ...run, hostTurn, updatedAt: new Date().toISOString() }
              }
            },
            response: {
              jobId,
              ...(hostTurn === undefined ? {} : { hostTurn })
            }
          };
        }
      );
      return mutation.state;
    });
  }

  private assertHostOwner(turn: HostTurn, hostTurnId: string): void {
    if (turn.hostTurnId !== hostTurnId) throw new Error("HOST_TURN_OWNED_BY_ANOTHER_HOST");
  }

  private async retryCas<T>(operation: (attempt: number) => Promise<T>): Promise<T> {
    let lastError: StateStoreError | undefined;
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
      try {
        return await operation(attempt);
      } catch (error) {
        if (!isStateVersionMismatch(error)) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new StateStoreError(
      "STATE_VERSION_MISMATCH",
      "Review-turn CAS reconciliation exhausted"
    );
  }

  private async resumeWithCasRetry(
    input: ReviewTurnInput,
    requestId: string,
    resumeAction: ResumeInput["resumeAction"],
    extra: () => Partial<Pick<ResumeInput, "tasksPath" | "approvedSourceHash" | "approval">>
  ): Promise<void> {
    const store = this.dependencies.store(input.projectId);
    await this.retryCas(async () => {
      const state = await store.readState();
      const run = state.runs[input.jobId];
      if (run === undefined) throw new Error("RUN_NOT_FOUND");
      await this.dependencies.resume({
        requestId,
        projectId: input.projectId,
        jobId: input.jobId,
        expectedRevision: run.revision,
        expectedStateVersion: state.stateVersion,
        resumeAction,
        ...extra()
      }, run.hostTurn === undefined
        ? undefined
        : { expectedHostTurnToken: run.hostTurn.turnToken });
    });
  }

  private async recoverClaiming(
    projectId: string,
    jobId: string,
    state: ProjectState,
    run: RunRecord,
    turn: Extract<HostTurn, { stage: "CLAIMING" }>
  ): Promise<void> {
    if (Date.parse(turn.deadlineAt) <= Date.now()) {
      if (run.phase === "REVIEWING") {
        await this.pauseActiveReview(
          projectId,
          jobId,
          turn,
          "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded during claim recovery"
        );
      } else {
        await this.clearClaimIntent(projectId, jobId, turn);
      }
      return;
    }
    const recoveryInput: ReviewTurnInput = {
      requestId: childRequestId(turn.turnToken, "recover-claim"),
      projectId,
      jobId,
      hostTurnId: turn.hostTurnId
    };
    if (run.phase === "REVIEW_PENDING") {
      await this.claimReview(recoveryInput, run.revision);
      return;
    }
    if (run.phase === "REVIEWING") {
      await this.reconcileClaim(recoveryInput, turn, state);
      return;
    }
    await this.persistHostTurn(
      this.dependencies.store(projectId),
      jobId,
      childRequestId(turn.turnToken, "clear-stale-claim-intent"),
      state.stateVersion,
      run.revision,
      undefined,
      [run.phase],
      turn.turnToken
    );
  }

  private async clearClaimIntent(
    projectId: string,
    jobId: string,
    turn: Extract<HostTurn, { stage: "CLAIMING" }>
  ): Promise<void> {
    const store = this.dependencies.store(projectId);
    const state = await store.readState();
    const run = state.runs[jobId];
    if (
      run === undefined ||
      run.phase !== "REVIEW_PENDING" ||
      run.hostTurn?.stage !== "CLAIMING" ||
      run.hostTurn.turnToken !== turn.turnToken
    ) return;
    await this.persistHostTurn(
      store,
      jobId,
      childRequestId(turn.turnToken, "claim-intent-expired"),
      state.stateVersion,
      run.revision,
      undefined,
      ["REVIEW_PENDING"],
      turn.turnToken
    );
    this.clearRenewal(projectId, jobId);
  }

  private scheduleClaimingWake(
    projectId: string,
    jobId: string,
    state: ProjectState
  ): void {
    if (this.disposed) return;
    const run = state.runs[jobId];
    const turn = run?.hostTurn;
    if (run === undefined || turn?.stage !== "CLAIMING") return;
    const deadlineAt = Date.parse(turn.deadlineAt);
    const claimExpiresAt = Date.parse(stringField(run.pendingAction, "claimExpiresAt") ?? "");
    const dueAt = Math.min(
      Number.isFinite(deadlineAt) ? deadlineAt : Date.now(),
      run.phase === "REVIEWING" && Number.isFinite(claimExpiresAt)
        ? claimExpiresAt - CLAIM_RENEW_SAFETY_MS
        : Number.POSITIVE_INFINITY
    );
    this.scheduleWakeAt(projectId, jobId, Math.max(Date.now(), dueAt));
  }

  private scheduleRenewal(
    projectId: string,
    jobId: string,
    state: ProjectState
  ): void {
    if (this.disposed) return;
    const run = state.runs[jobId];
    const turn = run?.hostTurn;
    if (run === undefined || turn?.stage !== "AWAITING_REVIEW") return;
    const now = Date.now();
    const deadlineAt = Date.parse(turn.deadlineAt);
    const claimExpiresAt = Date.parse(stringField(run.pendingAction, "claimExpiresAt") ?? "");
    const dueAt = Math.min(
      now + RENEW_INTERVAL_MS,
      Number.isFinite(deadlineAt) ? deadlineAt : now,
      Number.isFinite(claimExpiresAt) ? claimExpiresAt - CLAIM_RENEW_SAFETY_MS : now
    );
    this.scheduleWakeAt(projectId, jobId, Math.max(now, dueAt));
  }

  private scheduleWakeAt(projectId: string, jobId: string, dueAt: number): void {
    if (this.disposed) return;
    const key = runKey(projectId, jobId);
    const existing = this.timers.get(key);
    if (existing !== undefined && existing.dueAt <= dueAt) return;
    if (existing !== undefined) clearTimeout(existing.timer);
    const delay = Math.max(0, dueAt - Date.now());
    const timer = setTimeout(() => {
      if (this.timers.get(key)?.timer !== timer) return;
      this.timers.delete(key);
      void this.serialize(key, async () => {
        await this.renewOnce(projectId, jobId);
      }).catch(() => {
        this.scheduleWakeAt(projectId, jobId, Date.now() + RENEW_FAILURE_RETRY_MS);
      });
    }, delay);
    timer.unref();
    this.timers.set(key, { timer, dueAt });
  }

  private clearRenewal(projectId: string, jobId: string): void {
    const key = runKey(projectId, jobId);
    const entry = this.timers.get(key);
    if (entry !== undefined) clearTimeout(entry.timer);
    this.timers.delete(key);
    this.renewalFailures.delete(key);
  }

  private async renewOnce(projectId: string, jobId: string): Promise<void> {
    if (this.disposed) return;
    const store = this.dependencies.store(projectId);
    let expectedTurn: Extract<
      HostTurn,
      { stage: "CLAIMING" | "AWAITING_REVIEW" }
    > | undefined;
    try {
      const initial = await store.readState();
      const initialRun = initial.runs[jobId];
      const initialTurn = initialRun?.hostTurn;
      if (initialRun === undefined || initialTurn === undefined) {
        this.clearRenewal(projectId, jobId);
        return;
      }
      if (initialTurn.stage === "CLAIMING") {
        expectedTurn = initialTurn;
        if (Date.parse(initialTurn.deadlineAt) <= Date.now()) {
          if (initialRun.phase === "REVIEWING") {
            await this.pauseActiveReview(
              projectId,
              jobId,
              initialTurn,
              "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded"
            );
          } else {
            await this.clearClaimIntent(projectId, jobId, initialTurn);
          }
          return;
        }
        if (initialRun.phase === "REVIEWING") {
          const claimExpiresAt = Date.parse(
            stringField(initialRun.pendingAction, "claimExpiresAt") ?? ""
          );
          const claimCompletionFailures = this.renewalFailures.get(
            runKey(projectId, jobId)
          ) ?? 0;
          if (
            claimCompletionFailures >= RENEW_FAILURE_LIMIT ||
            !Number.isFinite(claimExpiresAt) ||
            claimExpiresAt <= Date.now()
          ) {
            await this.pauseActiveReview(
              projectId,
              jobId,
              initialTurn,
              claimCompletionFailures >= RENEW_FAILURE_LIMIT
                ? "HOST_REVIEW_UNAVAILABLE:unable to complete durable review claim recovery"
                : "HOST_REVIEW_UNAVAILABLE:review claim lease expired during claim completion"
            );
            return;
          }
          await this.reconcileClaim({
            requestId: childRequestId(initialTurn.turnToken, "wake-claim"),
            projectId,
            jobId,
            hostTurnId: initialTurn.hostTurnId
          }, initialTurn, initial);
          this.renewalFailures.delete(runKey(projectId, jobId));
          return;
        }
        this.scheduleClaimingWake(projectId, jobId, initial);
        return;
      }
      if (initialTurn.stage !== "AWAITING_REVIEW") {
        this.clearRenewal(projectId, jobId);
        return;
      }
      expectedTurn = initialTurn;
      if (Date.parse(initialTurn.deadlineAt) <= Date.now()) {
        await this.pauseActiveReview(
          projectId,
          jobId,
          initialTurn,
          "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded"
        );
        return;
      }
      const initialClaimExpiresAt = Date.parse(
        stringField(initialRun.pendingAction, "claimExpiresAt") ?? ""
      );
      if (!Number.isFinite(initialClaimExpiresAt) || initialClaimExpiresAt <= Date.now()) {
        await this.pauseActiveReview(
          projectId,
          jobId,
          initialTurn,
          "HOST_REVIEW_UNAVAILABLE:review claim lease expired"
        );
        return;
      }
      const outcome = await this.retryCas(async () => {
        const state = await store.readState();
        const run = state.runs[jobId];
        const turn = run?.hostTurn;
        if (
          run === undefined ||
          turn?.stage !== "AWAITING_REVIEW" ||
          turn.turnToken !== initialTurn.turnToken
        ) return { kind: "INACTIVE" as const };
        const deadlineAt = Date.parse(turn.deadlineAt);
        const claimExpiresAtText = stringField(run.pendingAction, "claimExpiresAt");
        const claimExpiresAt = Date.parse(claimExpiresAtText ?? "");
        const action = reviewAction(run);
        const claimId = stringField(run.pendingAction, "claimId");
        if (deadlineAt <= Date.now() || !Number.isFinite(claimExpiresAt) || claimExpiresAt <= Date.now()) {
          return { kind: "EXPIRED" as const, turn };
        }
        if (run.phase !== "REVIEWING" || action === undefined || claimId === undefined) {
          return { kind: "INACTIVE" as const };
        }
        const response = renewActionClaimOutputSchema.parse(await this.dependencies.renew({
          requestId: childRequestId(
            turn.turnToken,
            `renew-${claimId}-${claimExpiresAtText ?? "missing"}`
          ),
          projectId,
          jobId,
          expectedRevision: run.revision,
          expectedStateVersion: state.stateVersion,
          actionId: action.actionId,
          claimId,
          hostTurnId: turn.hostTurnId
        }, { expectedHostTurnToken: turn.turnToken }));
        return { kind: "RENEWED" as const, response };
      });
      if (outcome.kind === "INACTIVE") {
        this.clearRenewal(projectId, jobId);
        return;
      }
      if (outcome.kind === "EXPIRED") {
        await this.pauseActiveReview(
          projectId,
          jobId,
          outcome.turn,
          "HOST_REVIEW_UNAVAILABLE:review deadline or claim lease expired"
        );
        return;
      }
      this.renewalFailures.delete(runKey(projectId, jobId));
      const nextState = await store.readState();
      this.scheduleRenewal(projectId, jobId, nextState);
    } catch (error) {
      await this.handleRenewFailure(projectId, jobId, expectedTurn, error);
    }
  }

  private async handleRenewFailure(
    projectId: string,
    jobId: string,
    expectedTurn: Extract<
      HostTurn,
      { stage: "CLAIMING" | "AWAITING_REVIEW" }
    > | undefined,
    error: unknown
  ): Promise<void> {
    const key = runKey(projectId, jobId);
    const failures = (this.renewalFailures.get(key) ?? 0) + 1;
    this.renewalFailures.set(key, failures);
    try {
      const state = await this.dependencies.store(projectId).readState();
      const run = state.runs[jobId];
      const turn = run?.hostTurn;
      if (
        run === undefined ||
        turn === undefined ||
        (turn.stage !== "CLAIMING" && turn.stage !== "AWAITING_REVIEW") ||
        (expectedTurn !== undefined && turn.turnToken !== expectedTurn.turnToken)
      ) {
        this.clearRenewal(projectId, jobId);
        return;
      }
      if (turn.stage === "CLAIMING") {
        if (run.phase !== "REVIEW_PENDING" && run.phase !== "REVIEWING") {
          this.clearRenewal(projectId, jobId);
          return;
        }
        const now = Date.now();
        let dueAt = now + RENEW_FAILURE_RETRY_MS;
        const boundaries = [Date.parse(turn.deadlineAt)];
        if (run.phase === "REVIEWING") {
          boundaries.push(Date.parse(stringField(run.pendingAction, "claimExpiresAt") ?? ""));
        }
        for (const boundary of boundaries) {
          if (Number.isFinite(boundary) && boundary > now) {
            dueAt = Math.min(dueAt, boundary);
          }
        }
        this.scheduleWakeAt(projectId, jobId, dueAt);
        return;
      }
      const deadlineAt = Date.parse(turn.deadlineAt);
      const claimExpiresAt = Date.parse(stringField(run.pendingAction, "claimExpiresAt") ?? "");
      if (
        failures >= RENEW_FAILURE_LIMIT ||
        deadlineAt <= Date.now() ||
        !Number.isFinite(claimExpiresAt) ||
        claimExpiresAt <= Date.now()
      ) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.pauseActiveReview(
          projectId,
          jobId,
          turn,
          `HOST_REVIEW_UNAVAILABLE:unable to maintain review claim lease: ${reason}`
        );
        return;
      }
      this.scheduleWakeAt(
        projectId,
        jobId,
        Math.min(Date.now() + RENEW_FAILURE_RETRY_MS, deadlineAt, claimExpiresAt)
      );
    } catch {
      this.scheduleWakeAt(projectId, jobId, Date.now() + RENEW_FAILURE_RETRY_MS);
    }
  }

  private async pauseActiveReview(
    projectId: string,
    jobId: string,
    expectedTurn: Extract<HostTurn, { stage: "CLAIMING" | "AWAITING_REVIEW" }>,
    reason: string
  ): Promise<void> {
    const store = this.dependencies.store(projectId);
    const outcome = await this.retryCas(async () => {
      const state = await store.readState();
      const run = state.runs[jobId];
      const turn = run?.hostTurn;
      if (run === undefined || run.phase === "PAUSED") return "INACTIVE" as const;
      if (
        turn === undefined ||
        turn.turnToken !== expectedTurn.turnToken ||
        turn.hostTurnId !== expectedTurn.hostTurnId
      ) return "INACTIVE" as const;
      if (run.phase === "REVIEW_PENDING" && turn.stage === "CLAIMING") {
        return "CLEAR_INTENT" as const;
      }
      const claimId = stringField(run.pendingAction, "claimId");
      if (run.phase !== "REVIEWING" || claimId === undefined) {
        return "INACTIVE" as const;
      }
      await this.dependencies.reportHostUnavailable({
        requestId: childRequestId(turn.turnToken, `pause-${reason}`),
        projectId,
        jobId,
        expectedRevision: run.revision,
        expectedStateVersion: state.stateVersion,
        claimId,
        hostUnavailableReason: reason
      }, { expectedHostTurnToken: turn.turnToken });
      return "PAUSED" as const;
    });
    if (outcome === "CLEAR_INTENT" && expectedTurn.stage === "CLAIMING") {
      await this.clearClaimIntent(projectId, jobId, expectedTurn);
    }
    this.clearRenewal(projectId, jobId);
  }

  private async expireReviewTurn(projectId: string, jobId: string): Promise<void> {
    const state = await this.dependencies.store(projectId).readState();
    const turn = state.runs[jobId]?.hostTurn;
    if (turn?.stage !== "AWAITING_REVIEW") return;
    await this.pauseActiveReview(
      projectId,
      jobId,
      turn,
      "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded"
    );
  }
}
