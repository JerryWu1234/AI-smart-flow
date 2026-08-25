import { createHash } from "node:crypto";

import {
  durableLeaderDecisionSchema,
  durableReviewDecisionSchema,
  publishResultSchema,
  type PublishResult,
  type RunPhase
} from "@smartflow/protocol";
import {
  operationsHash,
  stableOperationId,
  type ApplyOperation
} from "@smartflow/publish";
import {
  StateStore,
  canonicalHash,
  runArtifactInventory,
  type ProjectState,
  type RunRecord,
  type WorkerAttempt
} from "@smartflow/state-store";
import { taskManifestSchema } from "@smartflow/task-manifest";
import {
  cleanupGitRunTemporaryState,
  getCandidateHash,
  verifyCandidate,
  verifyCandidateSnapshotBindings,
  verifyGitWorkspaceSnapshot,
  type Candidate,
  type GitWorkspaceSnapshot
} from "@smartflow/workspace";

import { gitPublishOperations } from "./git-publish-source.js";
import { ProjectMutationExecutor } from "./project-mutation-executor.js";

const terminalPhases = new Set<RunPhase>(["COMPLETED", "CANCELED", "FAILED"]);

export type RecoveryAction =
  | "NONE"
  | "REBUILD_WORKSPACE"
  | "RESUME_WORKER"
  | "START_NEW_WORKER_ATTEMPT"
  | "PREPARE_REPAIR"
  | "RUN_REVIEW"
  | "WAIT_FOR_LEADER"
  | "RECHECK_PUBLISH_READINESS"
  | "PUBLISH_RECONCILED"
  | "CONTINUE_CANCELLATION"
  | "BLOCKED";

export interface PublishRecoveryObservation {
  status: "COMMITTED" | "CONFLICT" | "PENDING" | "UNKNOWN" | "MISMATCH";
  result?: unknown;
}

export interface RecoveryRuntime {
  inspectWorker(attempt: WorkerAttempt | undefined): Promise<"RESUMABLE" | "STOPPED" | "UNKNOWN">;
  reconcilePublish(operationId: string, operationsHash: string): Promise<PublishRecoveryObservation>;
  continueCancellation(jobId: string): Promise<"CANCELED" | "BLOCKED">;
}

export interface RecoveryResult {
  jobId: string;
  phase: RunPhase;
  action: RecoveryAction;
  stateVersion: number;
  reason?: string;
  recoveryEpoch?: WorkerRecoveryEpoch;
}

export interface WorkerRecoveryEpoch {
  fence: number;
  revision: number;
  sourceGeneration: number;
  sourceAttemptId: string | null;
  resetGeneration: number;
  resetAttemptId: string | null;
}

function currentAttempt(run: RunRecord): WorkerAttempt | undefined {
  return run.workerAttempts.at(-1);
}

function nextStateWithRun(
  state: ProjectState,
  jobId: string,
  mutate: (run: RunRecord) => RunRecord,
  terminal = false
): ProjectState {
  const run = state.runs[jobId];
  if (run === undefined) throw new Error(`Unknown recovery run: ${jobId}`);
  const updatedAt = new Date().toISOString();
  return {
    ...state,
    activeRunsByTaskPath: terminal
      ? Object.fromEntries(Object.entries(state.activeRunsByTaskPath)
          .filter(([taskPath]) => taskPath !== run.canonicalTaskPath))
      : state.activeRunsByTaskPath,
    runs: { ...state.runs, [jobId]: { ...mutate(run), updatedAt } },
    updatedAt
  };
}

function digest(value: string): string {
  return value.replace(/^sha256:/u, "");
}

function semanticHashMatches(value: object, hashKey: string): boolean {
  const record = value as Record<string, unknown>;
  const expected = record[hashKey];
  const body = Object.fromEntries(Object.entries(record).filter(([key]) => key !== hashKey));
  return typeof expected === "string" && canonicalHash(body) === expected;
}

function requiresPublishApproval(run: RunRecord): boolean {
  if (new Set<RunPhase>(["READY_TO_PUBLISH", "PUBLISHING", "COMPLETED"]).has(run.phase)) {
    return true;
  }
  if (run.phase !== "PAUSED") return false;
  const code = run.pause?.code;
  return code?.startsWith("PUBLISH_") === true ||
    code === "MANUAL_PUBLISH_TARGET_MISMATCH" ||
    code === "PROJECT_PUBLISH_BUSY" ||
    (code === "RUNTIME_STAGE_FAILED" && run.lastError?.stage === "publish");
}

function publishResultMatchesOperations(
  result: PublishResult,
  operations: readonly ApplyOperation[]
): boolean {
  if (result.paths.length !== operations.length) return false;
  const expected = new Map(operations.map((operation) => [operation.path, operation]));
  return result.paths.every((pathResult) => {
    const operation = expected.get(pathResult.path);
    if (operation === undefined) return false;
    if (pathResult.status !== "COMMITTED") return result.status !== "COMMITTED";
    return pathResult.observedHash === operation.newHash &&
      pathResult.observedMode === operation.newMode;
  });
}

function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function containsInternalPath(bytes: Uint8Array, paths: readonly string[]): boolean {
  const text = new TextDecoder().decode(bytes);
  return paths.some((path) => path.length > 1 && text.includes(path));
}

export async function verifyRunArtifacts(
  store: StateStore,
  run: RunRecord
): Promise<string | undefined> {
  const state = await store.readState();
  const inventory = runArtifactInventory(run);
  if (inventory.issues.length > 0) return inventory.issues[0];
  const bytesByName = new Map<string, Uint8Array>();
  for (const binding of inventory.bindings) {
    try {
      const bytes = await store.readArtifact(binding.ref);
      bytesByName.set(binding.name, bytes);
      if (
        binding.semantic !== "TASK_SOURCE" &&
        containsInternalPath(bytes, [state.canonicalProjectRoot, store.dataDirectory])
      ) return `ARTIFACT_INTERNAL_PATH_DISCLOSURE:${binding.name}`;
    } catch {
      return `ARTIFACT_INTEGRITY_FAILED:${binding.name}`;
    }
  }

  try {
    const manifestBytes = bytesByName.get("taskManifest");
    const taskSourceBytes = bytesByName.get("taskSource");
    if (manifestBytes === undefined || taskSourceBytes === undefined) {
      return "ARTIFACT_REF_MISSING:taskManifest";
    }
    const manifest = taskManifestSchema.parse(json(manifestBytes));
    if (
      manifest.jobId !== run.jobId ||
      manifest.revision !== run.revision ||
      canonicalHash(manifest.taskSourceArtifact) !== canonicalHash(run.taskSource) ||
      manifest.sourceHash !== digest(run.taskSource.sha256)
    ) return "ARTIFACT_SEMANTIC_MISMATCH:taskManifest";

    const baselineBytes = bytesByName.get("baseline");
    let baselineSnapshot: GitWorkspaceSnapshot | undefined;
    if (baselineBytes !== undefined) {
      baselineSnapshot = json(baselineBytes) as GitWorkspaceSnapshot;
      if (!verifyGitWorkspaceSnapshot(baselineSnapshot)) {
        return "ARTIFACT_SEMANTIC_MISMATCH:baseline";
      }
    }

    const candidateBytes = bytesByName.get("candidate");
    let candidate: Candidate | undefined;
    let resultSnapshot: GitWorkspaceSnapshot | undefined;
    if (candidateBytes !== undefined) {
      candidate = json(candidateBytes) as Candidate;
      if (!verifyCandidate(candidate)) return "ARTIFACT_SEMANTIC_MISMATCH:candidate";
      if (run.gitWorkspace === undefined) {
        if (
          candidate.schemaVersion === 2 ||
          candidate.schemaVersion === 3 ||
          baselineSnapshot === undefined ||
          candidate.baselineHash !== baselineSnapshot.snapshotHash
        ) return "ARTIFACT_SEMANTIC_MISMATCH:candidateSnapshots";
      } else {
        const revisionWorkspace = run.gitWorkspace.revisions[String(run.revision)];
        const runBaselineBytes = bytesByName.get("gitWorkspace.runBaselineSnapshot");
        const inputBytes = bytesByName.get(
          `gitWorkspace.revisions.${String(run.revision)}.inputSnapshot`
        );
        const resultBytes = bytesByName.get(
          `gitWorkspace.revisions.${String(run.revision)}.resultSnapshot`
        );
        if (
          revisionWorkspace === undefined ||
          baselineSnapshot === undefined ||
          runBaselineBytes === undefined ||
          inputBytes === undefined ||
          resultBytes === undefined
        ) return "ARTIFACT_SEMANTIC_MISMATCH:candidateSnapshots";
        const runBaseline = json(runBaselineBytes) as GitWorkspaceSnapshot;
        const revisionInput = json(inputBytes) as GitWorkspaceSnapshot;
        resultSnapshot = json(resultBytes) as GitWorkspaceSnapshot;
        if (
          baselineSnapshot.snapshotHash !== runBaseline.snapshotHash ||
          !verifyCandidateSnapshotBindings({
            candidate,
            runBaseline,
            revisionInput,
            revisionResult: resultSnapshot
          })
        ) return "ARTIFACT_SEMANTIC_MISMATCH:candidateSnapshots";
      }
    }

    const reviewBytes = bytesByName.get("review");
    let reviewHash: string | undefined;
    let reviewAllowsAccept = false;
    if (reviewBytes !== undefined) {
      const review = durableReviewDecisionSchema.parse(json(reviewBytes));
      reviewHash = review.reviewHash;
      reviewAllowsAccept = review.gate.allowedLeaderDecisions.includes("accept");
      const matchingAttempt = [...run.workerAttempts].reverse().find(
        (attempt) => attempt.revision === run.revision && attempt.piSessionId === review.piSessionId
      );
      const matchingHistory = [...(run.reviewHistory ?? [])].reverse().find(
        (entry) => entry.reviewAttemptId === review.reviewAttemptId
      );
      if (
        !semanticHashMatches(review, "reviewHash") ||
        review.revision !== run.revision ||
        candidate === undefined ||
        review.candidateHash !== getCandidateHash(candidate) ||
        matchingHistory === undefined ||
        matchingHistory.taskSourceHash !== review.taskSourceHash ||
        matchingHistory.candidateHash !== review.candidateHash ||
        matchingHistory.reviewHash !== review.reviewHash ||
        matchingAttempt === undefined ||
        review.reviewerSessionId === review.piSessionId
      ) return "ARTIFACT_SEMANTIC_MISMATCH:review";
    }

    const leaderBytes = bytesByName.get("leaderDecision");
    let leaderAccepted = false;
    if (leaderBytes !== undefined) {
      const decision = durableLeaderDecisionSchema.parse(json(leaderBytes));
      leaderAccepted = decision.decision === "accept";
      if (
        !semanticHashMatches(decision, "decisionHash") ||
        decision.revision !== run.revision ||
        decision.reviewHash !== reviewHash
      ) return "ARTIFACT_SEMANTIC_MISMATCH:leaderDecision";
    }
    if (requiresPublishApproval(run)) {
      if (!reviewAllowsAccept) return "ARTIFACT_SEMANTIC_MISMATCH:review";
      if (!leaderAccepted) return "ARTIFACT_SEMANTIC_MISMATCH:leaderDecision";
    }

    const publishNeedsReconciliation = run.publish?.status === "PREPARED" ||
      run.publish?.status === "SUBMITTED" ||
      run.pause?.code === "PUBLISH_RECOVERY_BLOCKED";
    if (run.publish !== undefined && !publishNeedsReconciliation) {
      if (candidate === undefined || resultSnapshot === undefined || reviewHash === undefined) {
        return "ARTIFACT_SEMANTIC_MISMATCH:publish";
      }
      const operations = gitPublishOperations(candidate, resultSnapshot);
      const expectedOperationsHash = operationsHash(operations);
      if (
        run.publish.revision !== run.revision ||
        run.publish.operationsHash !== expectedOperationsHash ||
        run.publish.operationId !== stableOperationId({
          projectId: state.projectId,
          jobId: run.jobId,
          revision: run.revision,
          candidateHash: getCandidateHash(candidate),
          reviewHash,
          operationsHash: expectedOperationsHash
        }) ||
        (run.publish.result !== undefined &&
          !publishResultMatchesOperations(run.publish.result, operations))
      ) return "ARTIFACT_SEMANTIC_MISMATCH:publish";
    }
  } catch {
    return "ARTIFACT_SEMANTIC_VALIDATION_FAILED";
  }
  return undefined;
}

export class RecoveryManager {
  private readonly mutations: ProjectMutationExecutor;

  public constructor(
    private readonly store: StateStore,
    private readonly runtime: RecoveryRuntime
  ) {
    this.mutations = new ProjectMutationExecutor(store);
  }

  public async recover(jobId: string): Promise<RecoveryResult> {
    const state = await this.store.readState();
    const run = state.runs[jobId];
    if (run === undefined) throw new Error(`Unknown recovery run: ${jobId}`);
    const artifactFailure = await verifyRunArtifacts(this.store, run);
    if (artifactFailure !== undefined) {
      return terminalPhases.has(run.phase) || run.phase === "CANCELING"
        ? this.result(state, run, "BLOCKED", artifactFailure)
        : this.pause(state, run, artifactFailure);
    }
    if (terminalPhases.has(run.phase)) return this.result(state, run, "NONE");

    switch (run.phase) {
      case "PREPARING":
        return this.result(state, run, "REBUILD_WORKSPACE");
      case "RUNNING":
        return this.recoverWorker(state, run);
      case "FIXING":
        return this.result(state, run, "PREPARE_REPAIR");
      case "REVIEW_PENDING":
        return this.result(state, run, "RUN_REVIEW");
      case "REVIEWING":
        if (run.hostTurn?.stage !== "AWAITING_REVIEW") {
          return this.pause(state, run, "HOST_REVIEW_UNAVAILABLE:REVIEW_TURN_STATE_MISSING");
        }
        return this.result(state, run, "RUN_REVIEW");
      case "READY_TO_PUBLISH":
        return this.result(state, run, "RECHECK_PUBLISH_READINESS");
      case "PUBLISHING":
        return this.recoverPublish(state, run);
      case "PAUSED":
        return this.result(state, run, "NONE");
      case "CANCELING":
        return this.recoverCancellation(run);
      case "COMPLETED":
      case "CANCELED":
      case "FAILED":
        return this.result(state, run, "NONE");
    }
  }

  private async recoverWorker(state: ProjectState, run: RunRecord): Promise<RecoveryResult> {
    const attempt = currentAttempt(run);
    if (attempt?.status === "TIMED_OUT") {
      return this.result(state, run, "WAIT_FOR_LEADER", "ATTEMPT_DEADLINE_EXCEEDED");
    }
    const observed = await this.runtime.inspectWorker(attempt);
    if (observed === "UNKNOWN") {
      return this.pause(state, run, "PAUSED_PROCESS_RECONCILIATION:WORKER_OUTCOME_UNKNOWN");
    }
    if (observed === "RESUMABLE") return this.result(state, run, "RESUME_WORKER");

    const sourceGeneration = attempt?.generation ?? -1;
    const recoveryEpoch: WorkerRecoveryEpoch = {
      fence: run.fence,
      revision: run.revision,
      sourceGeneration,
      sourceAttemptId: attempt?.attemptId ?? null,
      resetGeneration: sourceGeneration + 1,
      resetAttemptId: null
    };
    const endedAt = new Date().toISOString();
    const committed = await this.commit(
      state,
      run,
      "worker:START_NEW_WORKER_ATTEMPT",
      { observed, recoveryEpoch },
      (current) => ({
        ...current,
        phase: "PREPARING",
        workerAttempts: current.workerAttempts.map((item) =>
          item.attemptId === attempt?.attemptId && new Set(["PREPARING", "RUNNING"]).has(item.status)
            ? {
                ...item,
                status: "FAILED" as const,
                terminalReason: "DAEMON_RESTART_RECONCILED",
                endedAt
              }
            : item),
        workspace: undefined,
        pause: undefined,
        recovery: {
          phase: "RUNNING",
          revision: current.revision,
          action: "START_NEW_WORKER_ATTEMPT",
          workerEpoch: recoveryEpoch
        }
      })
    );
    return this.result(
      committed,
      committed.runs[run.jobId] ?? run,
      "START_NEW_WORKER_ATTEMPT",
      undefined,
      recoveryEpoch
    );
  }

  private async recoverPublish(state: ProjectState, run: RunRecord): Promise<RecoveryResult> {
    const publish = run.publish;
    if (publish === undefined) return this.pause(state, run, "PUBLISH_ATTEMPT_MISSING");
    const observed = await this.runtime.reconcilePublish(
      publish.operationId,
      publish.operationsHash
    );
    const parsed = observed.result === undefined
      ? undefined
      : publishResultSchema.safeParse(observed.result);
    if (observed.status === "COMMITTED" || observed.status === "CONFLICT") {
      const finalStatus = observed.status;
      if (
        parsed?.success !== true ||
        parsed.data.operationId !== publish.operationId ||
        parsed.data.operationsHash !== publish.operationsHash ||
        parsed.data.status !== finalStatus
      ) return this.pause(state, run, "PUBLISH_RECOVERY_BLOCKED:RESULT_BINDING_INVALID");
      const terminal = finalStatus === "COMMITTED";
      const committed = await this.commit(
        state,
        run,
        `publish:${finalStatus.toLowerCase()}`,
        { observed },
        (current) => {
          if (
            current.publish?.operationId !== publish.operationId ||
            current.publish.operationsHash !== publish.operationsHash
          ) throw new Error("PUBLISH_RECOVERY_IDENTITY_MISMATCH");
          return {
            ...current,
            phase: terminal ? "COMPLETED" : "PAUSED",
            publish: { ...current.publish, status: finalStatus, result: parsed.data },
            ...(terminal ? {} : {
              pause: { code: "PUBLISH_CONFLICT", resumeActions: ["inspect_conflict", "cancel"] }
            })
          };
        },
        terminal,
        publish.operationId
      );
      const recoveredRun = committed.runs[run.jobId] ?? run;
      if (terminal) {
        await cleanupGitRunTemporaryState(this.store.dataDirectory, recoveredRun);
      }
      return this.result(committed, recoveredRun, "PUBLISH_RECONCILED");
    }
    return this.pause(state, run, `PUBLISH_RECOVERY_BLOCKED:${observed.status}`);
  }

  private async recoverCancellation(run: RunRecord): Promise<RecoveryResult> {
    const observed = await this.runtime.continueCancellation(run.jobId);
    const current = await this.store.readState();
    const recovered = current.runs[run.jobId] ?? run;
    return observed === "CANCELED" && recovered.phase === "CANCELED"
      ? this.result(current, recovered, "CONTINUE_CANCELLATION")
      : this.result(current, recovered, "BLOCKED", "CANCELLATION_RECONCILIATION_BLOCKED");
  }

  private async pause(state: ProjectState, run: RunRecord, reason: string): Promise<RecoveryResult> {
    const code = reason.split(":", 1)[0] ?? "RECOVERY_BLOCKED";
    const committed = await this.commit(
      state,
      run,
      `pause:${code}:${createHash("sha256").update(reason).digest("hex")}`,
      { reason },
      (current) => ({
        ...current,
        phase: "PAUSED",
        pause: { code, resumeActions: ["inspect_recovery", "cancel"] },
        lastError: {
          code,
          stage: "recovery",
          message: reason,
          retryable: true,
          nextActions: ["inspect_recovery", "cancel"],
          artifacts: []
        }
      })
    );
    return this.result(committed, committed.runs[run.jobId] ?? run, "BLOCKED", reason);
  }

  private async commit(
    capturedState: ProjectState,
    run: RunRecord,
    transition: string,
    payload: unknown,
    mutate: (run: RunRecord) => RunRecord,
    terminal = false,
    releasePublishLeaseOperationId?: string
  ): Promise<ProjectState> {
    const attempt = currentAttempt(run);
    return (await this.mutations.mutate(
      {
        requestId: `recovery:${run.jobId}:r${String(run.revision)}:s${String(capturedState.stateVersion)}:${transition}`,
        payload,
        replayPolicy: "CURRENT_EPOCH",
        expectedStateVersion: capturedState.stateVersion,
        expectedJobId: run.jobId,
        expectedFence: run.fence,
        expectedRevision: run.revision,
        ...(attempt === undefined ? {} : {
          expectedGeneration: attempt.generation,
          expectedAttemptId: attempt.attemptId
        }),
        expectedPhases: [run.phase]
      },
      (state) => {
        const nextState = nextStateWithRun(state, run.jobId, mutate, terminal);
        return {
          nextState: releasePublishLeaseOperationId !== undefined &&
            nextState.publishLease?.jobId === run.jobId &&
            nextState.publishLease.operationId === releasePublishLeaseOperationId
            ? { ...nextState, publishLease: null }
            : nextState,
          response: { transition }
        };
      }
    )).state;
  }

  private result(
    state: ProjectState,
    run: RunRecord,
    action: RecoveryAction,
    reason?: string,
    recoveryEpoch?: WorkerRecoveryEpoch
  ): RecoveryResult {
    return {
      jobId: run.jobId,
      phase: run.phase,
      action,
      stateVersion: state.stateVersion,
      ...(reason === undefined ? {} : { reason }),
      ...(recoveryEpoch === undefined ? {} : { recoveryEpoch })
    };
  }
}
