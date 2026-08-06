import { createHash, randomUUID } from "node:crypto";
import {
  hostActionSchema,
  type ClaimActionInput,
  type ClaimActionOutput,
  type ReportHostUnavailableInput,
  type ReportHostUnavailableOutput,
  type RenewActionClaimInput,
  type RenewActionClaimOutput,
  type SubmitLeaderDecisionInput,
  type SubmitLeaderDecisionOutput,
  type ReviewResultSubmitInput,
  type ReviewResultSubmitOutput
} from "@smartflow/protocol";
import {
  assertLeaderDecision,
  evaluateReviewGate,
  verifyReviewBundle,
  type ReviewBundle,
  type ReviewGateDecision
} from "@smartflow/review";
import { StateStore, type ProjectState, type RunRecord } from "@smartflow/state-store";
import { taskManifestSchema } from "@smartflow/task-manifest";

interface DurableReviewDecision {
  schemaVersion: 1;
  revision: number;
  claimId: string;
  reviewAttemptId: string;
  reviewBundleHash: string;
  reviewerSessionId: string;
  piSessionId: string;
  gate: ReviewGateDecision;
  reviewHash: string;
}

export interface ReviewMutation<T> {
  nextState: ProjectState;
  response: T;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function currentRun(state: ProjectState, input: { projectId: string; jobId: string; expectedRevision: number }): RunRecord {
  const run = state.runs[input.jobId];
  if (
    state.projectId !== input.projectId ||
    run === undefined ||
    state.activeRunsByTaskPath[run.canonicalTaskPath] !== input.jobId ||
    run.revision !== input.expectedRevision
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
    .map((entry) => stringField(entry, "reviewerSessionId"))
    .filter((value): value is string => value !== undefined);
  const unique = [...new Set(sessions)];
  if (unique.length > 1) throw new Error("REVIEWER_SESSION_HISTORY_INVALID");
  return unique[0];
}

function pendingReviewAction(run: RunRecord): ReturnType<typeof hostActionSchema.parse> | undefined {
  const pending = run.pendingAction;
  if (pending?.type !== "REVIEW") return undefined;
  const parsed = hostActionSchema.safeParse({
    type: pending.type,
    actionId: pending.actionId,
    revision: pending.revision,
    reviewBundle: pending.reviewBundle,
    reviewBundleHash: pending.reviewBundleHash,
    reviewAttemptId: pending.reviewAttemptId,
    taskSource: pending.taskSource,
    approvedSourceHash: pending.approvedSourceHash,
    changedPaths: pending.changedPaths,
    reviewerSession: pending.reviewerSession,
    piSessionId: pending.piSessionId,
    expiresAt: pending.expiresAt
  });
  return parsed.success ? parsed.data : undefined;
}

function verifyDurableDecision(decision: DurableReviewDecision): boolean {
  const { reviewHash, ...body } = decision;
  return hash(body) === reviewHash;
}

export class ReviewCoordinator {
  public constructor(private readonly store: StateStore) {}

  public claim(
    state: ProjectState,
    input: ClaimActionInput,
    now = new Date()
  ): ReviewMutation<ClaimActionOutput> {
    const run = currentRun(state, input);
    const action = pendingReviewAction(run);
    const existingClaimExpiresAt = stringField(run.pendingAction, "claimExpiresAt");
    const claimAvailable = run.phase === "REVIEW_PENDING" ||
      (run.phase === "REVIEWING" &&
        existingClaimExpiresAt !== undefined &&
        Date.parse(existingClaimExpiresAt) <= now.getTime());
    if (!claimAvailable || action?.type !== "REVIEW") {
      throw new Error("REVIEW_ACTION_NOT_CLAIMABLE");
    }
    if (
      run.reviewBundle === undefined ||
      canonical(action.reviewBundle) !== canonical(run.reviewBundle)
    ) throw new Error("REVIEW_ACTION_BUNDLE_INVALID");
    const reviewerSessionId = boundReviewerSession(run);
    const reviewerSessionMatches = reviewerSessionId === undefined
      ? action.reviewerSession.mode === "CREATE"
      : action.reviewerSession.mode === "RESUME" &&
        action.reviewerSession.reviewerSessionId === reviewerSessionId;
    const approvedSourceHash = stringField(run.approvedTasks, "sourceHash");
    if (
      action.piSessionId !== workerSession(run) ||
      !reviewerSessionMatches ||
      canonical(action.taskSource) !== canonical(run.taskSource) ||
      action.approvedSourceHash !== approvedSourceHash ||
      action.approvedSourceHash !== action.taskSource.sha256.replace(/^sha256:/u, "")
    ) throw new Error("REVIEW_ACTION_CONTEXT_STALE");
    if ((run.reviewHistory ?? []).some(
      (entry) => stringField(entry, "reviewAttemptId") === action.reviewAttemptId
    )) throw new Error("REVIEW_ATTEMPT_REUSED");
    if (action.actionId !== input.actionId) {
      throw new Error("REVIEW_ACTION_NOT_CLAIMABLE");
    }
    const claimableAction = {
      ...action,
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString()
    };
    const claimId = `claim-${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const updatedAt = now.toISOString();
    const nextRun: RunRecord = {
      ...run,
      phase: "REVIEWING",
      pendingAction: {
        ...claimableAction,
        claimId,
        hostTurnId: input.hostTurnId,
        claimExpiresAt: expiresAt,
        claimStatus: "CLAIMED"
      },
      updatedAt
    };
    return {
      nextState: replaceRun(state, nextRun),
      response: {
        claimId,
        action: claimableAction,
        stateVersion: state.stateVersion + 1,
        expiresAt
      }
    };
  }

  public renewClaim(
    state: ProjectState,
    input: RenewActionClaimInput,
    now = new Date()
  ): ReviewMutation<RenewActionClaimOutput> {
    const run = currentRun(state, input);
    const action = pendingReviewAction(run);
    const pending = run.pendingAction;
    const claimExpiresAt = stringField(pending, "claimExpiresAt");
    if (
      run.phase !== "REVIEWING" ||
      action?.actionId !== input.actionId ||
      stringField(pending, "claimId") !== input.claimId ||
      stringField(pending, "hostTurnId") !== input.hostTurnId ||
      stringField(pending, "claimStatus") !== "CLAIMED" ||
      claimExpiresAt === undefined
    ) {
      throw new Error("REVIEW_CLAIM_STALE_OR_MISMATCHED");
    }
    if (Date.parse(claimExpiresAt) <= now.getTime()) {
      throw new Error("REVIEW_CLAIM_EXPIRED");
    }
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const nextRun: RunRecord = {
      ...run,
      pendingAction: {
        ...pending,
        expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
        claimExpiresAt: expiresAt
      },
      updatedAt: now.toISOString()
    };
    return {
      nextState: replaceRun(state, nextRun),
      response: {
        projectId: state.projectId,
        jobId: run.jobId,
        revision: run.revision,
        stateVersion: state.stateVersion + 1,
        phase: "REVIEWING",
        expiresAt
      }
    };
  }

  public pauseForApprovedSourceDrift(
    state: ProjectState,
    jobId: string,
    observation: { approvedHash: string | undefined; observedHash: string },
    now = new Date()
  ): ReviewMutation<{ approvedSourceDrift: true; phase: "PAUSED"; stateVersion: number }> {
    const run = state.runs[jobId];
    if (
      run === undefined ||
      !new Set<RunRecord["phase"]>(["REVIEW_PENDING", "REVIEWING", "LEADER_DECISION"]).has(run.phase)
    ) throw new Error("REVIEW_SOURCE_DRIFT_BOUNDARY_INVALID");
    const action = pendingReviewAction(run);
    if ((run.phase === "REVIEW_PENDING" || run.phase === "REVIEWING") && action === undefined) {
      throw new Error("REVIEW_SOURCE_DRIFT_ACTION_MISSING");
    }
    const resumePhase = run.phase === "REVIEWING" ? "REVIEW_PENDING" : run.phase;
    const refreshedAction = action?.type === "REVIEW"
      ? {
          ...action,
          actionId: `review-action-${randomUUID()}`,
          expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString()
        }
      : undefined;
    const nextRun: RunRecord = {
      ...run,
      phase: "PAUSED",
      pause: {
        code: "APPROVED_SOURCE_DRIFT",
        resumeActions: ["approve_new_manifest_revision", "restore_approved_tasks", "cancel"]
      },
      ...(refreshedAction === undefined ? {} : { pendingAction: refreshedAction }),
      recovery: {
        ...run.recovery,
        approvedSourceDrift: {
          detectedFromPhase: run.phase,
          resumePhase,
          observedHash: observation.observedHash,
          ...(observation.approvedHash === undefined ? {} : { approvedHash: observation.approvedHash }),
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

  public async submitReview(
    state: ProjectState,
    input: ReviewResultSubmitInput,
    now = new Date()
  ): Promise<ReviewMutation<ReviewResultSubmitOutput | ReportHostUnavailableOutput>> {
    const run = currentRun(state, input);
    const pending = run.pendingAction;
    const action = pendingReviewAction(run);
    const claimExpiresAt = stringField(pending, "claimExpiresAt");
    const reviewBundleHash = stringField(pending, "reviewBundleHash");
    const claimId = stringField(pending, "claimId");
    const reviewBundleRef = pending?.reviewBundle;
    if (
      run.phase !== "REVIEWING" ||
      action?.type !== "REVIEW" ||
      claimId !== input.claimId ||
      reviewBundleHash !== input.reviewBundleHash ||
      action.reviewAttemptId !== input.reviewAttemptId ||
      claimExpiresAt === undefined ||
      typeof reviewBundleRef !== "object" ||
      reviewBundleRef === null
    ) {
      throw new Error("REVIEW_CLAIM_STALE_OR_MISMATCHED");
    }
    if (Date.parse(claimExpiresAt) <= now.getTime()) {
      return this.reportHostUnavailable(state, {
        requestId: input.requestId,
        projectId: input.projectId,
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        expectedStateVersion: input.expectedStateVersion,
        claimId: input.claimId,
        hostUnavailableReason: "HOST_REVIEW_CLAIM_EXPIRED_DURING_EXECUTION"
      }, now);
    }
    const bundle = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(reviewBundleRef as {
        relativePath: string;
        sha256: string;
        size: number;
      }))
    ) as ReviewBundle;
    if (
      !verifyReviewBundle(bundle) ||
      bundle.bundleHash !== input.reviewBundleHash ||
      bundle.revision !== run.revision
    ) {
      throw new Error("REVIEW_BUNDLE_BINDING_INVALID");
    }
    const changedPaths = bundle.changedPaths.map((path) => path.path);
    if (canonical(action.changedPaths) !== canonical(changedPaths)) {
      throw new Error("REVIEW_CHANGED_PATHS_MISMATCH");
    }
    const boundSessionId = boundReviewerSession(run);
    if (
      (action.reviewerSession.mode === "CREATE" && boundSessionId !== undefined) ||
      (action.reviewerSession.mode === "RESUME" &&
        (boundSessionId === undefined ||
          action.reviewerSession.reviewerSessionId !== boundSessionId ||
          input.reviewerSessionId !== boundSessionId))
    ) throw new Error("REVIEWER_SESSION_BINDING_MISMATCH");
    const gate = evaluateReviewGate(
      {
        reviewAttemptId: input.reviewAttemptId,
        reviewBundleHash: input.reviewBundleHash,
        reviewerSessionId: input.reviewerSessionId,
        piSessionId: workerSession(run),
        ...(boundSessionId === undefined ? {} : { boundReviewerSessionId: boundSessionId }),
        changedPaths
      },
      input.result
    );
    const body = {
      schemaVersion: 1 as const,
      revision: run.revision,
      claimId: input.claimId,
      reviewAttemptId: input.reviewAttemptId,
      reviewBundleHash: input.reviewBundleHash,
      reviewerSessionId: input.reviewerSessionId,
      piSessionId: workerSession(run),
      gate
    };
    const decision: DurableReviewDecision = { ...body, reviewHash: hash(body) };
    const artifact = await this.store.writeArtifact(
      `runs/${run.jobId}/revision-${String(run.revision)}/reviews/${input.reviewAttemptId}.json`,
      Buffer.from(canonical(decision), "utf8")
    );
    const nextRun: RunRecord = {
      ...run,
      pendingAction: undefined,
      phase: "LEADER_DECISION",
      review: artifact,
      reviewHistory: [
        ...(run.reviewHistory ?? []),
        {
          reviewAttemptId: input.reviewAttemptId,
          reviewerSessionId: input.reviewerSessionId,
          reviewBundleHash: input.reviewBundleHash,
          reviewHash: decision.reviewHash
        }
      ],
      updatedAt: now.toISOString()
    };
    return {
      nextState: replaceRun(state, nextRun),
      response: {
        projectId: state.projectId,
        jobId: run.jobId,
        revision: run.revision,
        stateVersion: state.stateVersion + 1,
        phase: "LEADER_DECISION",
        reviewHash: decision.reviewHash,
        reviewAttemptId: input.reviewAttemptId,
        reviewerSessionId: input.reviewerSessionId,
        result: input.result
      }
    };
  }

  public async submitLeaderDecision(
    state: ProjectState,
    input: SubmitLeaderDecisionInput,
    now = new Date()
  ): Promise<ReviewMutation<SubmitLeaderDecisionOutput>> {
    const run = currentRun(state, input);
    if (run.phase !== "LEADER_DECISION" || run.review === undefined) {
      throw new Error("LEADER_DECISION_NOT_READY");
    }
    const decision = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.review))
    ) as DurableReviewDecision;
    if (!verifyDurableDecision(decision) || decision.reviewHash !== input.reviewHash) {
      throw new Error("LEADER_REVIEW_BINDING_INVALID");
    }
    assertLeaderDecision(
      decision.gate,
      input.decision,
      input.repairItems
    );
    const leaderTaskIds = new Set(
      input.repairItems.flatMap((item) => item.source === "leader" ? [item.taskId] : [])
    );
    if (leaderTaskIds.size > 0) {
      const manifest = taskManifestSchema.parse(JSON.parse(
        new TextDecoder().decode(await this.store.readArtifact(run.taskManifest))
      ));
      const currentTaskIds = new Set(manifest.tasks.map((task) => task.id));
      if ([...leaderTaskIds].some((taskId) => !currentTaskIds.has(taskId))) {
        throw new Error("LEADER_REPAIR_TASK_UNKNOWN");
      }
    }
    const phase: RunRecord["phase"] = input.decision === "accept"
      ? "READY_TO_PUBLISH"
      : input.decision === "repair"
        ? "FIXING"
        : "PAUSED";
    const leaderBody = {
      schemaVersion: 1,
      revision: run.revision,
      reviewHash: input.reviewHash,
      decision: input.decision,
      repairItems: input.repairItems,
      reason: input.reason,
      decidedAt: now.toISOString()
    };
    const decisionHash = hash(leaderBody);
    const leaderDecision = await this.store.writeArtifact(
      `runs/${run.jobId}/revision-${String(run.revision)}/leader-decisions/${decisionHash}.json`,
      Buffer.from(canonical({ ...leaderBody, decisionHash }), "utf8")
    );
    const nextRun: RunRecord = {
      ...run,
      phase,
      leaderDecision,
      ...(phase === "PAUSED"
        ? { pause: { code: "LEADER_PAUSED", resumeActions: ["resume_review_decision", "cancel"] } }
        : { pause: undefined }),
      updatedAt: now.toISOString()
    };
    return {
      nextState: replaceRun(state, nextRun),
      response: {
        projectId: state.projectId,
        jobId: run.jobId,
        revision: run.revision,
        stateVersion: state.stateVersion + 1,
        phase
      }
    };
  }

  public pauseForHostUnavailable(
    state: ProjectState,
    jobId: string,
    now = new Date(),
    reason = "Current Host Reviewer is unavailable"
  ): ProjectState {
    const run = state.runs[jobId];
    if (
      run === undefined ||
      (run.phase !== "REVIEW_PENDING" && run.phase !== "REVIEWING") ||
      run.pendingAction === undefined
    ) {
      throw new Error("HOST_REVIEW_ACTION_NOT_ACTIVE");
    }
    const pendingAction = { ...run.pendingAction };
    delete pendingAction.claimId;
    delete pendingAction.hostTurnId;
    delete pendingAction.claimExpiresAt;
    delete pendingAction.claimStatus;
    return replaceRun(state, {
      ...run,
      phase: "PAUSED",
      pendingAction: {
        ...pendingAction,
        actionId: `review-action-${randomUUID()}`,
        expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString()
      },
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

  public reportHostUnavailable(
    state: ProjectState,
    input: ReportHostUnavailableInput,
    now = new Date()
  ): ReviewMutation<ReportHostUnavailableOutput> {
    const run = currentRun(state, input);
    if (
      run.phase !== "REVIEWING" ||
      stringField(run.pendingAction, "claimId") !== input.claimId ||
      run.pendingAction === undefined
    ) {
      throw new Error("HOST_REVIEW_CLAIM_STALE");
    }
    const nextState = this.pauseForHostUnavailable(
      state,
      run.jobId,
      now,
      input.hostUnavailableReason
    );
    return {
      nextState,
      response: {
        projectId: state.projectId,
        jobId: run.jobId,
        revision: run.revision,
        stateVersion: state.stateVersion + 1,
        phase: "PAUSED"
      }
    };
  }
}
