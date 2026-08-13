import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  durableReviewDecisionSchema,
  resultOutputSchema,
  resumeActionSchema,
  reviewTurnOutputSchema,
  statusOutputSchema,
  type ResumeInput,
  type ReviewTurnInput,
  type ReviewTurnOutput
} from "@smartflow/protocol";
import { REPAIR_ROUND_LIMIT } from "@smartflow/review";
import {
  StateStore,
  StateStoreError,
  type HostTurn,
  type ProjectState,
  type RunRecord
} from "@smartflow/state-store";

import { observeApprovedSource } from "./approved-source.js";
import { ProjectMutationExecutor } from "./project-mutation-executor.js";
import {
  ReviewCoordinator,
  pendingReviewAction,
  type BeginReviewOutput,
  type FinalizeReviewOutput
} from "./review-coordinator.js";
import { verifyRunArtifacts } from "./recovery-manager.js";

const DEFAULT_RETRY_AFTER_MS = 1_000;
const REVIEW_DEADLINE_MS = 30 * 60_000;
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

interface ResumeOptions {
  clearHostTurn?: boolean;
  expectedHostTurnToken?: string;
}

export interface HostTurnCoordinatorDependencies {
  store(projectId: string): StateStore;
  status(input: { projectId: string; jobId: string }): Promise<unknown>;
  resume(input: ResumeInput, options?: ResumeOptions): Promise<unknown>;
  result(input: { projectId: string; jobId: string }): Promise<unknown>;
  schedule(input: {
    projectId: string;
    jobId: string;
    state: ProjectState;
    kind: "pipeline" | "publish";
  }): void;
}

function childRequestId(seed: string, scope: string): string {
  const digest = createHash("sha256").update(`${seed}:${scope}`).digest("hex").slice(0, 40);
  const safeScope = scope.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 48);
  return `review-turn-${safeScope}-${digest}`;
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
  if (
    code === "AUTOMATIC_REPAIR_LIMIT" ||
    (code === "LEADER_PAUSED" && (run.autoRepairRounds ?? 0) >= REPAIR_ROUND_LIMIT)
  ) {
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

function isStateVersionMismatch(error: unknown): error is StateStoreError {
  return error instanceof StateStoreError && error.code === "STATE_VERSION_MISMATCH";
}

function deterministicTurnToken(input: ReviewTurnInput, scope: string): string {
  return childRequestId(`${input.requestId}:${input.hostTurnId}`, scope).replace(
    /^review-turn-/u,
    "turn-"
  );
}

interface DeadlineTimer {
  timer: ReturnType<typeof setTimeout>;
  dueAt: number;
}

type BeginMutationResponse =
  | { kind: "DRIFT" }
  | ({ kind: "BEGUN" } & BeginReviewOutput);

type FinalizeMutationResponse =
  | { kind: "DRIFT" }
  | ({ kind: "FINALIZED" } & FinalizeReviewOutput);

export class HostTurnCoordinator {
  private readonly timers = new Map<string, DeadlineTimer>();
  private disposed = false;

  public constructor(private readonly dependencies: HostTurnCoordinatorDependencies) {}

  public async turn(input: ReviewTurnInput): Promise<ReviewTurnOutput> {
    try {
      if (input.review !== undefined) return await this.submitReviewTurn(input);
      if (input.reviewUnavailableReason !== undefined) {
        return await this.reportReviewUnavailable(input);
      }
      if (input.answer !== undefined) return await this.submitAnswer(input);
      return await this.advance(input);
    } catch (error) {
      if (!isStateVersionMismatch(error)) throw error;
      return this.staleContinuation(input);
    }
  }

  public async recoverRun(projectId: string, jobId: string): Promise<void> {
    const state = await this.dependencies.store(projectId).readState();
    const run = state.runs[jobId];
    const turn = run?.hostTurn;
    if (run === undefined || turn === undefined) return;
    if (turn.stage !== "AWAITING_REVIEW" || run.phase !== "REVIEWING") return;
    if (Date.parse(turn.deadlineAt) <= Date.now()) {
      await this.pauseActiveReview(
        projectId,
        jobId,
        turn,
        "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded during recovery"
      );
      return;
    }
    this.scheduleDeadline(projectId, jobId, state);
  }

  public dispose(): void {
    this.disposed = true;
    for (const entry of this.timers.values()) clearTimeout(entry.timer);
    this.timers.clear();
  }

  private async advance(input: ReviewTurnInput): Promise<ReviewTurnOutput> {
    for (;;) {
      const status = statusOutputSchema.parse(await this.dependencies.status(input));
      if (TERMINAL_PHASES.has(status.phase)) {
        return reviewTurnOutputSchema.parse({
          kind: "DONE",
          result: resultOutputSchema.parse(await this.dependencies.result(input))
        });
      }
      if (status.phase === "PAUSED") {
        // Compatibility for a v4 repair draft. New safe repair revisions no longer pause.
        if (status.pause?.code === "REPAIR_TASKS_READY") {
          const result = resultOutputSchema.parse(await this.dependencies.result(input));
          const draft = result.repairDraft;
          if (draft?.approval.kind === "LEADER_REPAIR") {
            await this.resumeCurrentState(
              input,
              childRequestId(input.requestId, `approve-r${String(status.revision)}`),
              "approve_new_manifest_revision",
              { approval: draft.approval }
            );
            continue;
          }
        }
        return this.requireUserInput(input, status.revision);
      }
      if (status.phase === "REVIEW_PENDING") return this.beginReview(input, status.revision);
      if (status.phase === "REVIEWING") {
        const state = await this.dependencies.store(input.projectId).readState();
        const run = state.runs[input.jobId];
        const turn = run?.hostTurn;
        if (run === undefined) throw new Error("RUN_NOT_FOUND");
        if (turn?.stage !== "AWAITING_REVIEW") return this.notReady(status);
        this.assertHostOwner(turn, input.hostTurnId);
        if (Date.parse(turn.deadlineAt) <= Date.now()) {
          await this.pauseActiveReview(
            input.projectId,
            input.jobId,
            turn,
            "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded"
          );
          continue;
        }
        this.scheduleDeadline(input.projectId, input.jobId, state);
        return this.reviewRequired(state, run, turn);
      }
      if (status.phase === "LEADER_DECISION") {
        await this.finalizeLegacyDecision(input);
        continue;
      }
      return this.notReady(status);
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

  private async beginReview(
    input: ReviewTurnInput,
    revision: number
  ): Promise<ReviewTurnOutput> {
    const store = this.dependencies.store(input.projectId);
    const state = await store.readState();
    const run = state.runs[input.jobId];
    if (run === undefined) throw new Error("RUN_NOT_FOUND");
    if (run.hostTurn?.stage === "AWAITING_REVIEW") {
      this.assertHostOwner(run.hostTurn, input.hostTurnId);
      this.scheduleDeadline(input.projectId, input.jobId, state);
      return this.reviewRequired(state, run, run.hostTurn);
    }
    const turnToken = deterministicTurnToken(input, `review-r${String(revision)}`);
    const deadlineAt = new Date(Date.now() + REVIEW_DEADLINE_MS).toISOString();
    const mutation = await new ProjectMutationExecutor(store).mutate<BeginMutationResponse>(
      {
        requestId: childRequestId(turnToken, "begin"),
        payload: {
          kind: "begin-review-turn",
          projectId: input.projectId,
          jobId: input.jobId,
          hostTurnId: input.hostTurnId,
          revision,
          turnToken,
          deadlineAt
        },
        expectedStateVersion: state.stateVersion,
        expectedJobId: input.jobId,
        expectedRevision: revision,
        expectedPhases: ["REVIEW_PENDING"]
      },
      async (current, context) => {
        const currentRun = current.runs[input.jobId];
        if (currentRun === undefined) throw new Error("RUN_NOT_FOUND");
        const artifactFailure = await verifyRunArtifacts(store, currentRun);
        if (artifactFailure !== undefined) {
          throw new Error(`ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
        }
        const observation = await observeApprovedSource(current, input.jobId);
        const coordinator = new ReviewCoordinator(store);
        if (!observation.matches) {
          const paused = coordinator.pauseForApprovedSourceDrift(
            current,
            input.jobId,
            observation
          );
          return {
            nextState: paused.nextState,
            response: { kind: "DRIFT" as const }
          };
        }
        const begun = coordinator.beginReview(
          current,
          {
            projectId: input.projectId,
            jobId: input.jobId,
            expectedRevision: revision,
            hostTurnId: input.hostTurnId,
            turnToken,
            deadlineAt
          },
          context.nextStateVersion
        );
        return {
          nextState: begun.nextState,
          response: { kind: "BEGUN" as const, ...begun.response }
        };
      }
    );
    if (mutation.response.kind === "DRIFT") return this.advance(input);
    const nextRun = mutation.state.runs[input.jobId];
    const nextTurn = nextRun?.hostTurn;
    if (nextRun === undefined || nextTurn?.stage !== "AWAITING_REVIEW") {
      return this.staleContinuation(input);
    }
    this.scheduleDeadline(input.projectId, input.jobId, mutation.state);
    return this.reviewRequired(mutation.state, nextRun, nextTurn);
  }

  private reviewRequired(
    state: ProjectState,
    run: RunRecord,
    turn: Extract<HostTurn, { stage: "AWAITING_REVIEW" }>
  ): ReviewTurnOutput {
    const action = pendingReviewAction(run);
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
      worktreePath: resolve(
        this.dependencies.store(state.projectId).dataDirectory,
        run.workspace.relativePath
      ),
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
    const state = await store.readState();
    const run = state.runs[input.jobId];
    const turn = run?.hostTurn;
    if (
      run === undefined ||
      turn?.stage !== "AWAITING_REVIEW" ||
      turn.turnToken !== input.turnToken ||
      input.review === undefined
    ) {
      return this.staleContinuation(input);
    }
    this.assertHostOwner(turn, input.hostTurnId);
    const review = input.review;
    if (Date.parse(turn.deadlineAt) <= Date.now()) {
      await this.pauseActiveReview(
        input.projectId,
        input.jobId,
        turn,
        "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded"
      );
      return this.advance({ ...input, review: undefined });
    }
    const mutation = await new ProjectMutationExecutor(store).mutate<FinalizeMutationResponse>(
      {
        requestId: childRequestId(turn.turnToken, "finalize"),
        payload: {
          kind: "finalize-review-turn",
          projectId: input.projectId,
          jobId: input.jobId,
          hostTurnId: input.hostTurnId,
          turnToken: turn.turnToken,
          reviewerSessionId: review.reviewerSessionId,
          result: review.result
        },
        expectedStateVersion: state.stateVersion,
        expectedJobId: input.jobId,
        expectedRevision: run.revision,
        expectedPhases: ["REVIEWING"]
      },
      async (current, context) => {
        const currentRun = current.runs[input.jobId];
        if (currentRun === undefined) throw new Error("RUN_NOT_FOUND");
        const artifactFailure = await verifyRunArtifacts(store, currentRun);
        if (artifactFailure !== undefined) {
          throw new Error(`ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
        }
        const observation = await observeApprovedSource(current, input.jobId);
        const coordinator = new ReviewCoordinator(store);
        if (!observation.matches) {
          const paused = coordinator.pauseForApprovedSourceDrift(
            current,
            input.jobId,
            observation
          );
          return {
            nextState: paused.nextState,
            response: { kind: "DRIFT" as const }
          };
        }
        const finalized = await coordinator.finalizeReview(
          current,
          {
            projectId: input.projectId,
            jobId: input.jobId,
            expectedRevision: run.revision,
            hostTurnId: input.hostTurnId,
            turnToken: turn.turnToken,
            reviewerSessionId: review.reviewerSessionId,
            result: review.result
          },
          context.nextStateVersion
        );
        return {
          nextState: finalized.nextState,
          response: { kind: "FINALIZED" as const, ...finalized.response }
        };
      }
    );
    this.clearDeadline(input.projectId, input.jobId);
    if (mutation.response.kind === "DRIFT") {
      return this.advance({ ...input, review: undefined });
    }
    this.scheduleOutcome(input.projectId, input.jobId, mutation.state, mutation.response);
    return this.advance({ ...input, review: undefined });
  }

  private async finalizeLegacyDecision(input: ReviewTurnInput): Promise<void> {
    const store = this.dependencies.store(input.projectId);
    const state = await store.readState();
    const run = state.runs[input.jobId];
    if (run?.phase !== "LEADER_DECISION" || run.review === undefined) return;
    const requestSeed = run.review.sha256;
    const mutation = await new ProjectMutationExecutor(store).mutate(
      {
        requestId: childRequestId(requestSeed, "finalize-legacy-decision"),
        payload: {
          kind: "finalize-legacy-review-decision",
          projectId: input.projectId,
          jobId: input.jobId,
          revision: run.revision,
          reviewHash: requestSeed
        },
        expectedStateVersion: state.stateVersion,
        expectedJobId: input.jobId,
        expectedRevision: run.revision,
        expectedPhases: ["LEADER_DECISION"]
      },
      async (current, context) => {
        const currentRun = current.runs[input.jobId];
        if (currentRun === undefined) throw new Error("RUN_NOT_FOUND");
        const artifactFailure = await verifyRunArtifacts(store, currentRun);
        if (artifactFailure !== undefined) {
          throw new Error(`ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
        }
        return new ReviewCoordinator(store).finalizeStoredReview(
          current,
          input.jobId,
          context.nextStateVersion
        );
      }
    );
    this.scheduleOutcome(input.projectId, input.jobId, mutation.state, mutation.response);
  }

  private scheduleOutcome(
    projectId: string,
    jobId: string,
    state: ProjectState,
    outcome: FinalizeReviewOutput
  ): void {
    if (outcome.schedule === "none") return;
    this.dependencies.schedule({
      projectId,
      jobId,
      state,
      kind: outcome.schedule
    });
  }

  private async reportReviewUnavailable(input: ReviewTurnInput): Promise<ReviewTurnOutput> {
    const store = this.dependencies.store(input.projectId);
    const state = await store.readState();
    const run = state.runs[input.jobId];
    const turn = run?.hostTurn;
    if (
      run === undefined ||
      turn?.stage !== "AWAITING_REVIEW" ||
      turn.turnToken !== input.turnToken ||
      input.reviewUnavailableReason === undefined
    ) {
      return this.staleContinuation(input);
    }
    this.assertHostOwner(turn, input.hostTurnId);
    const reason = input.reviewUnavailableReason.startsWith("HOST_REVIEW_UNAVAILABLE")
      ? input.reviewUnavailableReason
      : `HOST_REVIEW_UNAVAILABLE:${input.reviewUnavailableReason}`;
    await new ProjectMutationExecutor(store).mutate(
      {
        requestId: childRequestId(turn.turnToken, "review-unavailable"),
        payload: { kind: "review-unavailable", reason },
        expectedStateVersion: state.stateVersion,
        expectedJobId: input.jobId,
        expectedRevision: run.revision,
        expectedPhases: ["REVIEWING"]
      },
      (current) => ({
        nextState: new ReviewCoordinator(store).pauseForHostUnavailable(
          current,
          input.jobId,
          turn.turnToken,
          new Date(),
          reason
        ),
        response: { phase: "PAUSED" as const }
      })
    );
    this.clearDeadline(input.projectId, input.jobId);
    return this.advance({ ...input, reviewUnavailableReason: undefined });
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
      previousTurn?.turnToken
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
    const state = await store.readState();
    const run = state.runs[input.jobId];
    const turn = run?.hostTurn;
    const answer = input.answer === undefined ? undefined : answerAction(input.answer);
    if (
      run === undefined ||
      turn?.stage !== "AWAITING_USER_INPUT" ||
      turn.turnToken !== input.turnToken ||
      answer === undefined
    ) {
      return this.staleContinuation(input);
    }
    this.assertHostOwner(turn, input.hostTurnId);
    if (!mutableResumeActions(run).includes(answer.action)) {
      throw new Error("REVIEW_TURN_ANSWER_NOT_ALLOWED");
    }
    if (answer.action === "resume_review_decision") {
      return this.resumeReviewDecision(input, state, run, turn);
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
      expectedHostTurnToken: turn.turnToken
    });
    return this.advance({ ...input, answer: undefined });
  }

  private async resumeReviewDecision(
    input: ReviewTurnInput,
    state: ProjectState,
    run: RunRecord,
    turn: Extract<HostTurn, { stage: "AWAITING_USER_INPUT" }>
  ): Promise<ReviewTurnOutput> {
    const store = this.dependencies.store(input.projectId);
    const mutation = await new ProjectMutationExecutor(store).mutate<FinalizeReviewOutput>(
      {
        requestId: childRequestId(turn.turnToken, "resume-review-decision"),
        payload: {
          kind: "resume-review-decision",
          projectId: input.projectId,
          jobId: input.jobId,
          revision: run.revision,
          turnToken: turn.turnToken
        },
        expectedStateVersion: state.stateVersion,
        expectedJobId: input.jobId,
        expectedRevision: run.revision,
        expectedPhases: ["PAUSED"]
      },
      async (current, context) => {
        const active = current.runs[input.jobId];
        if (
          active?.hostTurn?.stage !== "AWAITING_USER_INPUT" ||
          active.hostTurn.turnToken !== turn.turnToken ||
          active.hostTurn.hostTurnId !== input.hostTurnId
        ) {
          throw new Error("HOST_TURN_STATE_CHANGED");
        }
        const artifactFailure = await verifyRunArtifacts(store, active);
        if (artifactFailure !== undefined) {
          throw new Error(`ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
        }
        return new ReviewCoordinator(store).finalizeStoredReview(
          current,
          input.jobId,
          context.nextStateVersion,
          { repairRounds: 0, resetAutoRepairRounds: true }
        );
      }
    );
    this.scheduleOutcome(input.projectId, input.jobId, mutation.state, mutation.response);
    return this.advance({ ...input, answer: undefined });
  }

  private async persistHostTurn(
    store: StateStore,
    jobId: string,
    requestId: string,
    expectedStateVersion: number,
    expectedRevision: number,
    hostTurn: HostTurn,
    expectedTurnToken?: string
  ): Promise<ProjectState> {
    const mutation = await new ProjectMutationExecutor(store).mutate(
      {
        requestId,
        payload: { kind: "host-turn", jobId, hostTurn },
        expectedStateVersion,
        expectedJobId: jobId,
        expectedRevision,
        expectedPhases: ["PAUSED"]
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
          response: { jobId, hostTurn }
        };
      }
    );
    return mutation.state;
  }

  private async resumeCurrentState(
    input: ReviewTurnInput,
    requestId: string,
    resumeAction: ResumeInput["resumeAction"],
    extra: Partial<Pick<ResumeInput, "tasksPath" | "approvedSourceHash" | "approval">>
  ): Promise<void> {
    const state = await this.dependencies.store(input.projectId).readState();
    const run = state.runs[input.jobId];
    if (run === undefined) throw new Error("RUN_NOT_FOUND");
    await this.dependencies.resume({
      requestId,
      projectId: input.projectId,
      jobId: input.jobId,
      expectedRevision: run.revision,
      expectedStateVersion: state.stateVersion,
      resumeAction,
      ...extra
    }, run.hostTurn === undefined
      ? undefined
      : { expectedHostTurnToken: run.hostTurn.turnToken });
  }

  private assertHostOwner(turn: HostTurn, hostTurnId: string): void {
    if (turn.hostTurnId !== hostTurnId) throw new Error("HOST_TURN_OWNED_BY_ANOTHER_HOST");
  }

  private scheduleDeadline(projectId: string, jobId: string, state: ProjectState): void {
    if (this.disposed) return;
    const run = state.runs[jobId];
    const turn = run?.hostTurn;
    if (run?.phase !== "REVIEWING" || turn?.stage !== "AWAITING_REVIEW") return;
    this.scheduleWakeAt(projectId, jobId, Date.parse(turn.deadlineAt));
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
      void this.expireReviewTurn(projectId, jobId).catch(() => {
        this.scheduleWakeAt(projectId, jobId, Date.now() + DEFAULT_RETRY_AFTER_MS);
      });
    }, delay);
    timer.unref();
    this.timers.set(key, { timer, dueAt });
  }

  private clearDeadline(projectId: string, jobId: string): void {
    const key = runKey(projectId, jobId);
    const entry = this.timers.get(key);
    if (entry !== undefined) clearTimeout(entry.timer);
    this.timers.delete(key);
  }

  private async expireReviewTurn(projectId: string, jobId: string): Promise<void> {
    const state = await this.dependencies.store(projectId).readState();
    const turn = state.runs[jobId]?.hostTurn;
    if (turn?.stage !== "AWAITING_REVIEW") return;
    if (Date.parse(turn.deadlineAt) > Date.now()) {
      this.scheduleDeadline(projectId, jobId, state);
      return;
    }
    await this.pauseActiveReview(
      projectId,
      jobId,
      turn,
      "HOST_REVIEW_UNAVAILABLE:thirty-minute review deadline exceeded"
    );
  }

  private async pauseActiveReview(
    projectId: string,
    jobId: string,
    expectedTurn: Extract<HostTurn, { stage: "AWAITING_REVIEW" }>,
    reason: string
  ): Promise<void> {
    const store = this.dependencies.store(projectId);
    const state = await store.readState();
    const run = state.runs[jobId];
    if (
      run?.phase !== "REVIEWING" ||
      run.hostTurn?.stage !== "AWAITING_REVIEW" ||
      run.hostTurn.turnToken !== expectedTurn.turnToken
    ) {
      this.clearDeadline(projectId, jobId);
      return;
    }
    await new ProjectMutationExecutor(store).mutate(
      {
        requestId: childRequestId(expectedTurn.turnToken, `pause-${reason}`),
        payload: { kind: "pause-review-turn", reason },
        expectedStateVersion: state.stateVersion,
        expectedJobId: jobId,
        expectedRevision: run.revision,
        expectedPhases: ["REVIEWING"]
      },
      (current) => ({
        nextState: new ReviewCoordinator(store).pauseForHostUnavailable(
          current,
          jobId,
          expectedTurn.turnToken,
          new Date(),
          reason
        ),
        response: { phase: "PAUSED" as const }
      })
    );
    this.clearDeadline(projectId, jobId);
  }
}
