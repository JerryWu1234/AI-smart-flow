import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { StructuredLogger } from "@smartflow/observability";
import {
  reviewResultSchema,
  type HostAction,
  type ReviewResult
} from "@smartflow/protocol";
import {
  buildReviewPrompt,
  reviewOutputJsonSchema,
  type AgentAdapter,
  type AgentRunOutcome,
  type AgentRunRequest
} from "@smartflow/review";
import {
  StateStore,
  type HostTurn,
  type ProjectState,
  type RunRecord
} from "@smartflow/state-store";
import { taskManifestSchema, type TaskManifest } from "@smartflow/task-manifest";

import { observeApprovedSource } from "./approved-source.js";
import { ProjectMutationExecutor } from "./project-mutation-executor.js";
import { verifyRunArtifacts } from "./recovery-manager.js";
import {
  ReviewCoordinator,
  DAEMON_REVIEWER_HOST_TURN_ID,
  assertReviewTaskCoverage,
  isDaemonReviewerHostTurn,
  pendingReviewAction,
  type FinalizeReviewOutput
} from "./review-coordinator.js";

export interface ReviewRunnerOptions {
  readonly model?: string;
  readonly effort?: string;
  readonly deadlineMs: number;
  /** Total createSession/resume calls permitted for one run() invocation. Minimum: 1. */
  readonly maxAttempts: number;
  readonly logger?: Pick<StructuredLogger, "log">;
}

export interface ReviewRunnerRequest {
  readonly projectId: string;
  readonly jobId: string;
}

export interface ReviewRunnerResult {
  readonly schedule: "pipeline" | "publish" | "none";
}

type AwaitingReviewTurn = Extract<HostTurn, { stage: "AWAITING_REVIEW" }>;

interface ActiveReviewContext extends ReviewRunnerRequest {
  readonly action: HostAction;
  readonly turn: AwaitingReviewTurn;
  readonly worktreePath: string;
  readonly identity: string;
}

interface PreparedReviewContext extends ActiveReviewContext {
  readonly manifest: TaskManifest;
  readonly schemaPath: string;
  readonly outputPath: string;
}

type BeginMutationResponse =
  | { kind: "BEGUN"; turnToken: string; deadlineAt: string }
  | { kind: "DRIFT" };

type FinalizeMutationResponse =
  | ({ kind: "FINALIZED" } & FinalizeReviewOutput)
  | { kind: "DRIFT"; schedule: "none" };

type OutputValidation =
  | { success: true; result: ReviewResult }
  | { success: false; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reviewIdentity(
  request: ReviewRunnerRequest,
  action: HostAction
): string {
  return createHash("sha256")
    .update([
      request.projectId,
      request.jobId,
      action.taskSourceHash,
      action.candidateHash,
      action.reviewAttemptId,
      action.actionId
    ].join("\0"), "utf8")
    .digest("hex");
}

function reviewRequestId(identity: string, operation: "begin" | "finalize" | "pause"): string {
  return `daemon-review-${operation}-${identity}`;
}

function reviewTurnToken(identity: string): string {
  return `daemon-review-turn-${identity}`;
}

function isCancellationInProgress(run: RunRecord | undefined): boolean {
  return run?.phase === "CANCELING" || run?.phase === "CANCELED" || run?.cancellation !== undefined;
}

function clearDaemonPauseHostTurn(state: ProjectState, jobId: string): ProjectState {
  const run = state.runs[jobId];
  if (run?.phase !== "PAUSED" || !isDaemonReviewerHostTurn(run.hostTurn)) return state;
  return {
    ...state,
    runs: {
      ...state.runs,
      [jobId]: { ...run, hostTurn: undefined }
    }
  };
}

function correctionFor(reason: string): string {
  return [
    `The previous reviewer attempt was rejected: ${reason}`,
    "Reread the approved Task source and return a complete corrected JSON result."
  ].join("\n");
}

function zodFailureReason(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  const details = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length === 0 ? "<root>" : issue.path.map(String).join(".");
    return `${path}: ${issue.message}`;
  });
  return `REVIEW_OUTPUT_INVALID:${details.join("; ")}`;
}

export class ReviewRunner {
  private readonly mutations: ProjectMutationExecutor;
  private readonly coordinator: ReviewCoordinator;

  public constructor(
    private readonly store: StateStore,
    private readonly adapter: AgentAdapter,
    private readonly options: ReviewRunnerOptions
  ) {
    if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
      throw new Error("REVIEW_DEADLINE_INVALID");
    }
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new Error("REVIEW_MAX_ATTEMPTS_INVALID");
    }
    this.mutations = new ProjectMutationExecutor(store);
    this.coordinator = new ReviewCoordinator(store);
  }

  public async run(request: ReviewRunnerRequest): Promise<ReviewRunnerResult> {
    const active = await this.beginOrReuse(request);
    if (active === undefined) return { schedule: "none" };

    const prepared = await this.prepare(active);

    let correction: string | undefined;
    let reviewerSessionId = prepared.action.reviewerSession.mode === "RESUME"
      ? prepared.action.reviewerSession.reviewerSessionId
      : undefined;
    let lastFailure = "DAEMON_REVIEWER_DID_NOT_RETURN_A_VALID_RESULT";

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      if (!await this.isStillActive(prepared)) return { schedule: "none" };
      const remainingDeadlineMs = Date.parse(prepared.turn.deadlineAt) - Date.now();
      if (remainingDeadlineMs <= 0) {
        lastFailure = "REVIEW_DEADLINE_EXPIRED";
        this.logAttemptFailure(prepared, attempt, reviewerSessionId, lastFailure, false);
        break;
      }

      const prompt = buildReviewPrompt({
        manifest: prepared.manifest,
        changedPaths: prepared.action.changedPaths,
        tasksPath: prepared.manifest.canonicalTaskPath,
        ...(correction === undefined ? {} : { correction })
      });
      const agentRequest: AgentRunRequest = {
        runId: prepared.action.reviewAttemptId,
        cwd: prepared.worktreePath,
        prompt,
        outputSchemaPath: prepared.schemaPath,
        outputPath: prepared.outputPath,
        deadlineMs: remainingDeadlineMs,
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        ...(this.options.effort === undefined ? {} : { effort: this.options.effort })
      };
      const mode = reviewerSessionId === undefined ? "CREATE" : "RESUME";
      let outcome: AgentRunOutcome;
      try {
        outcome = reviewerSessionId === undefined
          ? await this.adapter.createSession(agentRequest)
          : await this.adapter.resume(reviewerSessionId, agentRequest);
      } catch (error) {
        lastFailure = `REVIEW_ADAPTER_ERROR:${errorMessage(error)}`;
        correction = correctionFor(lastFailure);
        this.logAttemptFailure(
          prepared,
          attempt,
          reviewerSessionId,
          lastFailure,
          attempt < this.options.maxAttempts
        );
        continue;
      }

      this.options.logger?.log({
        level: outcome.kind === "COMPLETED" ? "info" : "warn",
        event: "daemon_review.adapter_outcome",
        stage: "review",
        correlation: this.correlation(prepared),
        data: {
          attempt,
          maxAttempts: this.options.maxAttempts,
          mode,
          ...(this.options.model === undefined ? {} : { model: this.options.model }),
          ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
          outcome: outcome.kind,
          ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId })
        }
      });

      if (outcome.kind === "CANCELED" && !await this.isStillActive(prepared)) {
        return { schedule: "none" };
      }

      if (outcome.sessionId !== undefined) {
        if (outcome.sessionId.length === 0) {
          lastFailure = "REVIEWER_SESSION_ID_INVALID";
          correction = correctionFor(lastFailure);
          this.logAttemptFailure(
            prepared,
            attempt,
            reviewerSessionId,
            lastFailure,
            attempt < this.options.maxAttempts
          );
          continue;
        }
        if (reviewerSessionId === undefined) reviewerSessionId = outcome.sessionId;
        else if (reviewerSessionId !== outcome.sessionId) {
          lastFailure = "REVIEWER_SESSION_CHANGED_DURING_RETRY";
          correction = correctionFor(lastFailure);
          this.logAttemptFailure(
            prepared,
            attempt,
            reviewerSessionId,
            lastFailure,
            attempt < this.options.maxAttempts
          );
          continue;
        }
      }

      if (outcome.kind === "FAILED") {
        lastFailure = `REVIEW_ADAPTER_FAILED:${outcome.code}:${outcome.message}`;
      } else if (outcome.kind === "TIMED_OUT") {
        lastFailure = "REVIEW_ADAPTER_TIMED_OUT";
      } else if (outcome.kind === "CANCELED") {
        lastFailure = "REVIEW_ADAPTER_CANCELED";
      } else {
        const validated = this.validateOutput(outcome.finalResponse, prepared.manifest);
        if (validated.success && reviewerSessionId !== undefined) {
          try {
            return await this.finalize(prepared, reviewerSessionId, validated.result);
          } catch (error) {
            if (!await this.isStillActive(prepared)) return { schedule: "none" };
            if (errorMessage(error) === "REVIEW_DEADLINE_EXPIRED") {
              return this.pause(prepared, "REVIEW_DEADLINE_EXPIRED_BEFORE_FINALIZE");
            }
            throw error;
          }
        }
        lastFailure = validated.success
          ? "REVIEWER_SESSION_ID_MISSING"
          : validated.reason;
      }

      correction = correctionFor(lastFailure);
      this.logAttemptFailure(
        prepared,
        attempt,
        reviewerSessionId,
        lastFailure,
        attempt < this.options.maxAttempts
      );
    }

    return this.pause(
      prepared,
      `DAEMON_REVIEW_ATTEMPTS_EXHAUSTED:maxAttempts=${String(this.options.maxAttempts)};lastFailure=${lastFailure}`
    );
  }

  private async beginOrReuse(
    request: ReviewRunnerRequest
  ): Promise<ActiveReviewContext | undefined> {
    const state = await this.store.readState();
    if (state.projectId !== request.projectId) throw new Error("REVIEW_PROJECT_MISMATCH");
    const run = state.runs[request.jobId];
    if (run === undefined) throw new Error("RUN_NOT_FOUND");
    if (isCancellationInProgress(run)) return undefined;

    if (run.phase === "REVIEWING") {
      if (!isDaemonReviewerHostTurn(run.hostTurn)) {
        this.options.logger?.log({
          level: "warn",
          event: "daemon_review.foreign_turn_rejected",
          stage: "review",
          correlation: { projectId: request.projectId, jobId: request.jobId }
        });
        throw new Error("REVIEW_TURN_NOT_DAEMON_OWNED");
      }
      return this.activeContext(state, request);
    }
    if (run.phase !== "REVIEW_PENDING") return undefined;

    const action = pendingReviewAction(run);
    if (action === undefined) throw new Error("REVIEW_ACTION_CONTEXT_MISSING");
    const identity = reviewIdentity(request, action);
    const turnToken = reviewTurnToken(identity);
    const startedAt = new Date();
    const deadlineAt = new Date(startedAt.getTime() + this.options.deadlineMs).toISOString();
    const mutation = await this.mutations.mutate<BeginMutationResponse>(
      {
        requestId: reviewRequestId(identity, "begin"),
        payload: {
          kind: "daemon-review-begin",
          projectId: request.projectId,
          jobId: request.jobId,
          reviewAttemptId: action.reviewAttemptId,
          actionId: action.actionId
        },
        expectedStateVersion: state.stateVersion,
        expectedFence: run.fence,
        expectedJobId: request.jobId,
        expectedPhases: ["REVIEW_PENDING"]
      },
      async (current, context) => {
        const currentRun = current.runs[request.jobId];
        if (currentRun === undefined) throw new Error("RUN_NOT_FOUND");
        const artifactFailure = await verifyRunArtifacts(this.store, currentRun);
        if (artifactFailure !== undefined) {
          throw new Error(`ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
        }
        const observation = await observeApprovedSource(current, request.jobId);
        if (!observation.matches) {
          const paused = this.coordinator.pauseForApprovedSourceDrift(
            current,
            request.jobId,
            observation,
            startedAt
          );
          return { nextState: paused.nextState, response: { kind: "DRIFT" as const } };
        }
        const begun = this.coordinator.beginReview(
          current,
          {
            projectId: request.projectId,
            jobId: request.jobId,
            hostTurnId: DAEMON_REVIEWER_HOST_TURN_ID,
            turnToken,
            deadlineAt
          },
          context.nextStateVersion,
          startedAt
        );
        return {
          nextState: begun.nextState,
          response: { kind: "BEGUN" as const, turnToken, deadlineAt }
        };
      }
    );
    if (mutation.response.kind === "DRIFT") return undefined;
    return this.activeContext(mutation.state, request, identity);
  }

  private activeContext(
    state: ProjectState,
    request: ReviewRunnerRequest,
    expectedIdentity?: string
  ): ActiveReviewContext | undefined {
    if (state.projectId !== request.projectId) throw new Error("REVIEW_PROJECT_MISMATCH");
    const run = state.runs[request.jobId];
    if (isCancellationInProgress(run)) return undefined;
    if (run?.phase !== "REVIEWING") return undefined;
    if (!isDaemonReviewerHostTurn(run.hostTurn)) {
      throw new Error("REVIEW_TURN_NOT_DAEMON_OWNED");
    }
    const turn = run.hostTurn;
    const action = pendingReviewAction(run);
    if (
      turn.stage !== "AWAITING_REVIEW" ||
      action === undefined ||
      run.workspace === undefined ||
      turn.reviewAttemptId !== action.reviewAttemptId
    ) {
      throw new Error("REVIEW_ACTION_CONTEXT_MISSING");
    }
    const identity = reviewIdentity(request, action);
    if (expectedIdentity !== undefined && identity !== expectedIdentity) {
      throw new Error("REVIEW_ACTION_CONTEXT_CHANGED");
    }
    return {
      ...request,
      action,
      turn,
      worktreePath: resolve(this.store.dataDirectory, run.workspace.relativePath),
      identity
    };
  }

  private async prepare(context: ActiveReviewContext): Promise<PreparedReviewContext> {
    const state = await this.store.readState();
    const run = state.runs[context.jobId];
    if (run === undefined) throw new Error("RUN_NOT_FOUND");
    const manifest = taskManifestSchema.parse(JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.taskManifest))
    ));
    const directory = `runs/${context.jobId}/reviews`;
    const schemaRelativePath = `${directory}/${context.action.reviewAttemptId}.schema.json`;
    const outputRelativePath = `${directory}/${context.action.reviewAttemptId}.output.json`;
    await this.store.writeArtifact(
      schemaRelativePath,
      Buffer.from(JSON.stringify(reviewOutputJsonSchema()), "utf8")
    );
    return {
      ...context,
      manifest,
      schemaPath: resolve(this.store.dataDirectory, schemaRelativePath),
      outputPath: resolve(this.store.dataDirectory, outputRelativePath)
    };
  }

  private validateOutput(value: unknown, manifest: TaskManifest): OutputValidation {
    const parsed = reviewResultSchema.safeParse(value);
    if (!parsed.success) return { success: false, reason: zodFailureReason(parsed.error) };
    try {
      assertReviewTaskCoverage(manifest.enabledTaskIds, parsed.data);
    } catch {
      const observed = parsed.data.tasks.map((task) => task.id).join(",");
      return {
        success: false,
        reason: `REVIEW_TASK_COVERAGE_INCOMPLETE:expected=${manifest.enabledTaskIds.join(",")};observed=${observed}`
      };
    }
    return { success: true, result: parsed.data };
  }

  private async finalize(
    context: PreparedReviewContext,
    reviewerSessionId: string,
    result: ReviewResult
  ): Promise<ReviewRunnerResult> {
    const state = await this.store.readState();
    const run = state.runs[context.jobId];
    if (!this.matchesActiveContext(state, context)) return { schedule: "none" };
    if (run === undefined) return { schedule: "none" };
    const mutation = await this.mutations.mutate<FinalizeMutationResponse>(
      {
        requestId: reviewRequestId(context.identity, "finalize"),
        payload: {
          kind: "daemon-review-finalize",
          projectId: context.projectId,
          jobId: context.jobId,
          reviewAttemptId: context.action.reviewAttemptId,
          actionId: context.action.actionId,
          reviewerSessionId,
          result
        },
        expectedStateVersion: state.stateVersion,
        expectedFence: run.fence,
        expectedJobId: context.jobId,
        expectedPhases: ["REVIEWING"]
      },
      async (current, mutationContext) => {
        const currentRun = current.runs[context.jobId];
        if (currentRun === undefined) throw new Error("RUN_NOT_FOUND");
        const artifactFailure = await verifyRunArtifacts(this.store, currentRun);
        if (artifactFailure !== undefined) {
          throw new Error(`ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
        }
        const observation = await observeApprovedSource(current, context.jobId);
        if (!observation.matches) {
          const paused = this.coordinator.pauseForApprovedSourceDrift(
            current,
            context.jobId,
            observation
          );
          return {
            nextState: paused.nextState,
            response: { kind: "DRIFT" as const, schedule: "none" as const }
          };
        }
        const finalized = await this.coordinator.finalizeReview(
          current,
          {
            projectId: context.projectId,
            jobId: context.jobId,
            hostTurnId: DAEMON_REVIEWER_HOST_TURN_ID,
            turnToken: context.turn.turnToken,
            reviewerSessionId,
            result
          },
          mutationContext.nextStateVersion
        );
        return {
          nextState: clearDaemonPauseHostTurn(finalized.nextState, context.jobId),
          response: { kind: "FINALIZED" as const, ...finalized.response }
        };
      }
    );
    this.options.logger?.log({
      level: "info",
      event: "daemon_review.finalized",
      stage: "review",
      correlation: this.correlation(context),
      data: { schedule: mutation.response.schedule, reviewerSessionId }
    });
    return { schedule: mutation.response.schedule };
  }

  private async pause(
    context: ActiveReviewContext,
    reason: string
  ): Promise<ReviewRunnerResult> {
    const state = await this.store.readState();
    const run = state.runs[context.jobId];
    if (!this.matchesActiveContext(state, context) || run === undefined) {
      return { schedule: "none" };
    }
    try {
      await this.mutations.mutate(
        {
          requestId: reviewRequestId(context.identity, "pause"),
          payload: {
            kind: "daemon-review-pause",
            projectId: context.projectId,
            jobId: context.jobId,
            reviewAttemptId: context.action.reviewAttemptId,
            actionId: context.action.actionId
          },
          expectedStateVersion: state.stateVersion,
          expectedFence: run.fence,
          expectedJobId: context.jobId,
          expectedPhases: ["REVIEWING"]
        },
        (current) => ({
          nextState: clearDaemonPauseHostTurn(
            this.coordinator.pauseForHostUnavailable(
              current,
              context.jobId,
              context.turn.turnToken,
              new Date(),
              reason
            ),
            context.jobId
          ),
          response: { phase: "PAUSED" as const, schedule: "none" as const }
        })
      );
    } catch (error) {
      const latest = await this.store.readState();
      if (!this.matchesActiveContext(latest, context)) return { schedule: "none" };
      throw error;
    }
    this.options.logger?.log({
      level: "warn",
      event: "daemon_review.paused",
      stage: "review",
      correlation: this.correlation(context),
      data: { reason }
    });
    return { schedule: "none" };
  }

  private async isStillActive(context: ActiveReviewContext): Promise<boolean> {
    return this.matchesActiveContext(await this.store.readState(), context);
  }

  private matchesActiveContext(state: ProjectState, context: ActiveReviewContext): boolean {
    if (state.projectId !== context.projectId) throw new Error("REVIEW_PROJECT_MISMATCH");
    const run = state.runs[context.jobId];
    if (isCancellationInProgress(run)) return false;
    if (run?.phase !== "REVIEWING") return false;
    if (!isDaemonReviewerHostTurn(run.hostTurn)) {
      throw new Error("REVIEW_TURN_NOT_DAEMON_OWNED");
    }
    const action = pendingReviewAction(run);
    return run.hostTurn.stage === "AWAITING_REVIEW" &&
      run.hostTurn.turnToken === context.turn.turnToken &&
      run.hostTurn.reviewAttemptId === context.action.reviewAttemptId &&
      action?.actionId === context.action.actionId &&
      action.reviewAttemptId === context.action.reviewAttemptId;
  }

  private correlation(context: ActiveReviewContext): {
    projectId: string;
    jobId: string;
    actionId: string;
  } {
    return {
      projectId: context.projectId,
      jobId: context.jobId,
      actionId: context.action.actionId
    };
  }

  private logAttemptFailure(
    context: ActiveReviewContext,
    attempt: number,
    reviewerSessionId: string | undefined,
    reason: string,
    willRetry: boolean
  ): void {
    this.options.logger?.log({
      level: "warn",
      event: "daemon_review.attempt_rejected",
      stage: "review",
      correlation: this.correlation(context),
      data: {
        attempt,
        maxAttempts: this.options.maxAttempts,
        reason,
        willRetry,
        ...(reviewerSessionId === undefined ? {} : { reviewerSessionId })
      }
    });
  }
}
