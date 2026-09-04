import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  durableLeaderDecisionSchema,
  durableReviewDecisionSchema,
  hostActionSchema,
  reviewResultSchema,
  type DurableReviewDecision,
  type HostAction,
  type ReviewResult
} from "@smartflow/protocol";
import {
  assertLeaderDecision,
  evaluateReviewGate,
  planReviewDecision
} from "@smartflow/review";
import { StateStore, type HostTurn, type ProjectState, type RunRecord } from "@smartflow/state-store";
import { taskManifestSchema } from "@smartflow/task-manifest";

export const DAEMON_REVIEWER_HOST_TURN_ID = "daemon-reviewer";

export function isDaemonReviewerHostTurn(
  turn: HostTurn | undefined
): turn is HostTurn & { hostTurnId: typeof DAEMON_REVIEWER_HOST_TURN_ID } {
  return turn?.hostTurnId === DAEMON_REVIEWER_HOST_TURN_ID;
}

export interface ReviewMutation<T> {
  nextState: ProjectState;
  response: T;
}

export interface BeginReviewInput {
  projectId: string;
  jobId: string;
  hostTurnId: typeof DAEMON_REVIEWER_HOST_TURN_ID;
  turnToken: string;
  deadlineAt: string;
}

export interface BeginReviewOutput {
  action: HostAction;
  worktreePath: string;
  stateVersion: number;
}

export interface FinalizeReviewInput {
  projectId: string;
  jobId: string;
  hostTurnId: typeof DAEMON_REVIEWER_HOST_TURN_ID;
  turnToken: string;
  reviewerSessionId: string;
  result: ReviewResult;
}

export interface FinalizeReviewOutput {
  phase: RunRecord["phase"];
  stateVersion: number;
  reviewHash: string;
  result: ReviewResult;
  schedule: "none" | "pipeline" | "publish";
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function verifyDurableDecision(decision: DurableReviewDecision): boolean {
  const { reviewHash, ...body } = decision;
  return hash(body) === reviewHash;
}

export function assertReviewTaskCoverage(
  expectedTaskIds: readonly string[],
  result: ReviewResult
): void {
  const reviewedTaskIds = new Set(result.tasks.map((task) => task.id));
  if (
    reviewedTaskIds.size !== expectedTaskIds.length ||
    result.tasks.length !== expectedTaskIds.length ||
    expectedTaskIds.some((taskId) => !reviewedTaskIds.has(taskId))
  ) {
    throw new Error("REVIEW_TASK_COVERAGE_INCOMPLETE");
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function currentRun(
  state: ProjectState,
  input: { projectId: string; jobId: string }
): RunRecord {
  const run = state.runs[input.jobId];
  if (
    state.projectId !== input.projectId ||
    run === undefined ||
    state.activeRunsByTaskPath[run.canonicalTaskPath] !== input.jobId
  ) {
    throw new Error("REVIEW_BINDING_STALE");
  }
  return run;
}

function replaceRun(state: ProjectState, run: RunRecord): ProjectState {
  return { ...state, runs: { ...state.runs, [run.jobId]: run } };
}

function workerSession(run: RunRecord): string {
  const sessionId = run.workerAttempts.at(-1)?.piSessionId;
  if (sessionId === undefined) throw new Error("REVIEW_WORKER_SESSION_MISSING");
  return sessionId;
}

function boundReviewerSession(run: RunRecord): string | undefined {
  const sessions = (run.reviewHistory ?? [])
    .map((entry: Record<string, unknown> | undefined) => stringField(entry, "reviewerSessionId"))
    .filter((value: string | undefined): value is string => value !== undefined);
  const unique = [...new Set<string>(sessions)];
  if (unique.length > 1) throw new Error("REVIEWER_SESSION_HISTORY_INVALID");
  return unique[0];
}

export function pendingReviewAction(run: RunRecord): HostAction | undefined {
  const pending = run.pendingAction;
  if (pending?.type !== "REVIEW") return undefined;
  const parsed = hostActionSchema.safeParse({
    type: pending.type,
    actionId: pending.actionId,
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

function assertReviewerContext(run: RunRecord, action: HostAction): void {
  const reviewerSessionId = boundReviewerSession(run);
  const reviewerSessionMatches = reviewerSessionId === undefined
    ? action.reviewerSession.mode === "CREATE"
    : action.reviewerSession.mode === "RESUME" &&
      action.reviewerSession.reviewerSessionId === reviewerSessionId;
  if (action.piSessionId !== workerSession(run) || !reviewerSessionMatches) {
    throw new Error("REVIEW_ACTION_CONTEXT_STALE");
  }
  if ((run.reviewHistory ?? []).some(
    (entry: Record<string, unknown> | undefined) => stringField(entry, "reviewAttemptId") === action.reviewAttemptId
  )) {
    throw new Error("REVIEW_ATTEMPT_REUSED");
  }
}

export class ReviewCoordinator {
  public constructor(private readonly store: StateStore) {}

  public beginReview(
    state: ProjectState,
    input: BeginReviewInput,
    nextStateVersion: number,
    now = new Date()
  ): ReviewMutation<BeginReviewOutput> {
    const run = currentRun(state, input);
    if (run.phase !== "REVIEW_PENDING") throw new Error("REVIEW_ACTION_NOT_CLAIMABLE");
    const action = pendingReviewAction(run);
    if (action === undefined || run.candidate === undefined || run.workspace === undefined) {
      throw new Error("REVIEW_ACTION_CONTEXT_MISSING");
    }
    assertReviewerContext(run, action);
    const durableAction: HostAction = { ...action, expiresAt: input.deadlineAt };
    const hostTurn: HostTurn = {
      stage: "AWAITING_REVIEW",
      turnToken: input.turnToken,
      hostTurnId: input.hostTurnId,
      reviewAttemptId: action.reviewAttemptId,
      startedAt: now.toISOString(),
      deadlineAt: input.deadlineAt
    };
    const nextRun: RunRecord = {
      ...run,
      phase: "REVIEWING",
      pendingAction: durableAction,
      hostTurn,
      updatedAt: now.toISOString()
    };
    return {
      nextState: replaceRun(state, nextRun),
      response: {
        action: durableAction,
        worktreePath: resolve(this.store.dataDirectory, run.workspace.relativePath),
        stateVersion: nextStateVersion
      }
    };
  }

  public async finalizeReview(
    state: ProjectState,
    input: FinalizeReviewInput,
    nextStateVersion: number,
    now = new Date()
  ): Promise<ReviewMutation<FinalizeReviewOutput>> {
    const run = currentRun(state, input);
    const turn = run.hostTurn;
    const action = pendingReviewAction(run);
    if (
      run.phase !== "REVIEWING" ||
      turn?.stage !== "AWAITING_REVIEW" ||
      turn.turnToken !== input.turnToken ||
      action === undefined ||
      action.reviewAttemptId !== turn.reviewAttemptId
    ) {
      throw new Error("REVIEW_TURN_STALE_OR_MISMATCHED");
    }
    if (Date.parse(turn.deadlineAt) <= now.getTime()) {
      throw new Error("REVIEW_DEADLINE_EXPIRED");
    }
    if (
      action.taskSourceHash !== stringField(run.pendingAction, "taskSourceHash") ||
      action.candidateHash !== stringField(run.pendingAction, "candidateHash")
    ) {
      throw new Error("REVIEW_CONTEXT_BINDING_INVALID");
    }
    const boundSessionId = boundReviewerSession(run);
    if (
      (action.reviewerSession.mode === "CREATE" && boundSessionId !== undefined) ||
      (action.reviewerSession.mode === "RESUME" &&
        (boundSessionId === undefined ||
          action.reviewerSession.reviewerSessionId !== boundSessionId ||
          input.reviewerSessionId !== boundSessionId))
    ) {
      throw new Error("REVIEWER_SESSION_BINDING_MISMATCH");
    }

    const manifest = taskManifestSchema.parse(JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.taskManifest))
    ));
    const reviewResult = reviewResultSchema.parse(input.result);
    assertReviewTaskCoverage(manifest.enabledTaskIds, reviewResult);
    const gate = evaluateReviewGate(
      {
        reviewerSessionId: input.reviewerSessionId,
        piSessionId: workerSession(run),
        ...(boundSessionId === undefined ? {} : { boundReviewerSessionId: boundSessionId })
      },
      reviewResult
    );
    const reviewBody = {
      claimId: turn.turnToken,
      reviewAttemptId: action.reviewAttemptId,
      taskSourceHash: action.taskSourceHash,
      candidateHash: action.candidateHash,
      reviewerSessionId: input.reviewerSessionId,
      piSessionId: workerSession(run),
      gate
    };
    const reviewDecision = durableReviewDecisionSchema.parse({
      ...reviewBody,
      reviewHash: hash(reviewBody)
    });
    const reviewArtifact = await this.store.writeArtifact(
      `runs/${run.jobId}/reviews/${action.reviewAttemptId}.json`,
      Buffer.from(canonical(reviewDecision), "utf8")
    );

    const plan = planReviewDecision({
      result: gate.result,
      repairRounds: run.autoRepairRounds ?? 0
    });
    assertLeaderDecision(gate, plan.decision);
    const leaderBody = {
      reviewHash: reviewDecision.reviewHash,
      decision: plan.decision,
      reason: plan.reason,
      decidedAt: now.toISOString()
    };
    const decisionHash = hash(leaderBody);
    const leaderDecisionValue = durableLeaderDecisionSchema.parse({
      ...leaderBody,
      decisionHash
    });
    const leaderDecision = await this.store.writeArtifact(
      `runs/${run.jobId}/leader-decisions/${decisionHash}.json`,
      Buffer.from(canonical(leaderDecisionValue), "utf8")
    );

    const phase: RunRecord["phase"] = plan.kind === "ACCEPT"
      ? "READY_TO_PUBLISH"
      : plan.kind === "REPAIR"
        ? "FIXING"
        : "PAUSED";
    const pauseCode = plan.kind === "PAUSE_REPAIR_LIMIT"
      ? "AUTOMATIC_REPAIR_LIMIT"
      : undefined;
    const nextHostTurn: HostTurn | undefined = pauseCode === undefined
      ? undefined
      : {
          stage: "AWAITING_USER_INPUT",
          turnToken: turn.turnToken,
          hostTurnId: turn.hostTurnId,
          pauseCode,
          startedAt: now.toISOString()
        };
    const nextRun: RunRecord = {
      ...run,
      phase,
      pendingAction: undefined,
      hostTurn: nextHostTurn,
      review: reviewArtifact,
      leaderDecision,
      reviewHistory: [
        ...(run.reviewHistory ?? []),
        {
          reviewAttemptId: action.reviewAttemptId,
          reviewerSessionId: input.reviewerSessionId,
          taskSourceHash: action.taskSourceHash,
          candidateHash: action.candidateHash,
          reviewHash: reviewDecision.reviewHash
        }
      ],
      ...(plan.kind === "REPAIR"
        ? { autoRepairRounds: (run.autoRepairRounds ?? 0) + 1 }
        : {}),
      ...(pauseCode === undefined
        ? { pause: undefined }
        : {
            pause: {
              code: pauseCode,
              resumeActions: ["resume_review_decision", "cancel"]
            }
          }),
      updatedAt: now.toISOString()
    };
    return {
      nextState: replaceRun(state, nextRun),
      response: {
        phase,
        stateVersion: nextStateVersion,
        reviewHash: reviewDecision.reviewHash,
        result: gate.result,
        schedule: plan.kind === "ACCEPT"
          ? "publish"
          : plan.kind === "REPAIR"
            ? "pipeline"
            : "none"
      }
    };
  }

  public async finalizeStoredReview(
    state: ProjectState,
    jobId: string,
    nextStateVersion: number,
    options: { repairRounds?: number; resetAutoRepairRounds?: boolean } = {},
    now = new Date()
  ): Promise<ReviewMutation<FinalizeReviewOutput>> {
    const run = state.runs[jobId];
    const resumableRepairLimit = options.resetAutoRepairRounds === true &&
      run?.phase === "PAUSED" &&
      run.pause?.code === "AUTOMATIC_REPAIR_LIMIT";
    if (
      run === undefined ||
      !resumableRepairLimit ||
      run.review === undefined
    ) {
      throw new Error("LEADER_DECISION_NOT_READY");
    }
    const decision = durableReviewDecisionSchema.parse(JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.review))
    ));
    if (!verifyDurableDecision(decision)) throw new Error("LEADER_REVIEW_BINDING_INVALID");
    const plan = planReviewDecision({
      result: decision.gate.result,
      repairRounds: options.repairRounds ?? run.autoRepairRounds ?? 0
    });
    assertLeaderDecision(decision.gate, plan.decision);
    const leaderBody = {
      reviewHash: decision.reviewHash,
      decision: plan.decision,
      reason: plan.reason,
      decidedAt: now.toISOString()
    };
    const decisionHash = hash(leaderBody);
    const leaderDecisionValue = durableLeaderDecisionSchema.parse({
      ...leaderBody,
      decisionHash
    });
    const leaderDecision = await this.store.writeArtifact(
      `runs/${run.jobId}/leader-decisions/${decisionHash}.json`,
      Buffer.from(canonical(leaderDecisionValue), "utf8")
    );
    const phase: RunRecord["phase"] = plan.kind === "ACCEPT"
      ? "READY_TO_PUBLISH"
      : plan.kind === "REPAIR"
        ? "FIXING"
        : "PAUSED";
    const pauseCode = plan.kind === "PAUSE_REPAIR_LIMIT"
      ? "AUTOMATIC_REPAIR_LIMIT"
      : undefined;
    const nextHostTurn: HostTurn | undefined = pauseCode === undefined || run.hostTurn === undefined
      ? undefined
      : {
          stage: "AWAITING_USER_INPUT",
          turnToken: run.hostTurn.turnToken,
          hostTurnId: run.hostTurn.hostTurnId,
          pauseCode,
          startedAt: now.toISOString()
        };
    const baseRepairRounds = options.resetAutoRepairRounds === true
      ? 0
      : (run.autoRepairRounds ?? 0);
    const nextRun: RunRecord = {
      ...run,
      phase,
      hostTurn: nextHostTurn,
      leaderDecision,
      ...(plan.kind === "REPAIR"
        ? { autoRepairRounds: baseRepairRounds + 1 }
        : options.resetAutoRepairRounds === true
          ? { autoRepairRounds: baseRepairRounds }
          : {}),
      ...(pauseCode === undefined
        ? { pause: undefined }
        : {
            pause: {
              code: pauseCode,
              resumeActions: ["resume_review_decision", "cancel"]
            }
          }),
      updatedAt: now.toISOString()
    };
    return {
      nextState: replaceRun(state, nextRun),
      response: {
        phase,
        stateVersion: nextStateVersion,
        reviewHash: decision.reviewHash,
        result: decision.gate.result,
        schedule: plan.kind === "ACCEPT"
          ? "publish"
          : plan.kind === "REPAIR"
            ? "pipeline"
            : "none"
      }
    };
  }

  public pauseForApprovedSourceDrift(
    state: ProjectState,
    jobId: string,
    _observation: { approvedHash: string | undefined; observedHash: string },
    now = new Date()
  ): ReviewMutation<{ approvedSourceDrift: true; phase: "PAUSED"; stateVersion: number }> {
    const run = state.runs[jobId];
    if (
      run === undefined ||
      !new Set<RunRecord["phase"]>(["REVIEW_PENDING", "REVIEWING"])
        .has(run.phase)
    ) {
      throw new Error("REVIEW_SOURCE_DRIFT_BOUNDARY_INVALID");
    }
    const action = pendingReviewAction(run);
    if ((run.phase === "REVIEW_PENDING" || run.phase === "REVIEWING") && action === undefined) {
      throw new Error("REVIEW_SOURCE_DRIFT_ACTION_MISSING");
    }
    const resumePhase = run.phase === "REVIEWING" ? "REVIEW_PENDING" : run.phase;
    const refreshedAction = action === undefined ? undefined : {
      ...action,
      actionId: `review-action-${randomUUID()}`,
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString()
    };
    const nextRun: RunRecord = {
      ...run,
      phase: "PAUSED",
      hostTurn: undefined,
      pause: {
        code: "APPROVED_SOURCE_DRIFT",
        resumeActions: ["restore_approved_tasks", "cancel"]
      },
      ...(refreshedAction === undefined ? {} : { pendingAction: refreshedAction }),
      recovery: {
        ...run.recovery,
        approvedSourceDrift: {
          detectedFromPhase: run.phase,
          resumePhase,
          detectedAt: now.toISOString()
        }
      },
      updatedAt: now.toISOString()
    };
    return {
      nextState: replaceRun(state, nextRun),
      response: {
        approvedSourceDrift: true,
        phase: "PAUSED",
        stateVersion: state.stateVersion + 1
      }
    };
  }

  public pauseForHostUnavailable(
    state: ProjectState,
    jobId: string,
    expectedTurnToken: string,
    now = new Date(),
    reason = "Current Host Reviewer is unavailable"
  ): ProjectState {
    const run = state.runs[jobId];
    const turn = run?.hostTurn;
    if (
      run === undefined ||
      run.phase !== "REVIEWING" ||
      turn?.stage !== "AWAITING_REVIEW" ||
      turn.turnToken !== expectedTurnToken ||
      run.pendingAction === undefined
    ) {
      throw new Error("HOST_REVIEW_ACTION_NOT_ACTIVE");
    }
    const action = pendingReviewAction(run);
    const pendingAction = action === undefined
      ? run.pendingAction
      : {
          ...action,
          actionId: `review-action-${randomUUID()}`,
          expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString()
        };
    return replaceRun(state, {
      ...run,
      phase: "PAUSED",
      hostTurn: {
        stage: "AWAITING_USER_INPUT",
        turnToken: turn.turnToken,
        hostTurnId: turn.hostTurnId,
        pauseCode: "HOST_REVIEW_UNAVAILABLE",
        startedAt: now.toISOString()
      },
      pendingAction,
      pause: {
        code: "HOST_REVIEW_UNAVAILABLE",
        resumeActions: ["retry_host_review", "cancel"]
      },
      lastError: {
        code: "HOST_REVIEW_UNAVAILABLE",
        stage: "review",
        message: reason,
        retryable: true,
        nextActions: ["retry_host_review", "cancel"],
        artifacts: []
      },
      updatedAt: now.toISOString()
    });
  }
}
