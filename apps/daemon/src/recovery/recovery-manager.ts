import { createHash } from "node:crypto";

import {
  artifactRefSchema,
  artifactRefsEqual,
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

import { resolveReviewEnabled } from "../config/config.js";
import { gitPublishOperations } from "../publish/git-publish-source.js";
import { ProjectMutationExecutor } from "../runtime/project-mutation-executor.js";

const terminalPhases = new Set<RunPhase>(["COMPLETED", "CANCELED", "FAILED"]);

export type RecoveryAction =
  | "NONE"
  | "REBUILD_WORKSPACE"
  | "START_NEW_WORKER_ATTEMPT"
  | "PREPARE_REPAIR"
  | "RUN_REVIEW"
  | "WAIT_FOR_LEADER"
  | "RECHECK_PUBLISH_READINESS"
  | "PUBLISH_RECONCILED"
  | "CONTINUE_CANCELLATION"
  | "BLOCKED";

export interface PublishRecoveryObservation {
  status: "COMMITTED" | "CONFLICT" | "UNKNOWN";
  result?: unknown;
}

export interface RecoveryRuntime {
  inspectWorker(attempt: WorkerAttempt | undefined): Promise<"STOPPED" | "UNKNOWN">;
  reconcilePublish(operationId: string, operationsHash: string): Promise<PublishRecoveryObservation>;
  continueCancellation(): Promise<"CANCELED" | "BLOCKED">;
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
  if (!resolveReviewEnabled()) return false;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function runRelativePath(jobId: string, value: string): boolean {
  const segments = value.split("/");
  return value.startsWith(`runs/${jobId}/`) &&
    !value.includes("\\") &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
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
        binding.semantic !== "PI_SESSION" &&
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
    if (
      run.taskManifest.relativePath !== `runs/${run.jobId}/task-manifest.json` ||
      run.taskSource.relativePath !== `runs/${run.jobId}/task-source.md`
    ) return "ARTIFACT_SEMANTIC_MISMATCH:taskPaths";
    const manifest = taskManifestSchema.parse(json(manifestBytes));
    if (
      manifest.projectId !== state.projectId ||
      manifest.jobId !== run.jobId ||
      canonicalHash(manifest.taskSourceArtifact) !== canonicalHash(run.taskSource) ||
      manifest.sourceHash !== digest(run.taskSource.sha256)
    ) return "ARTIFACT_SEMANTIC_MISMATCH:taskManifest";

    let baselineSnapshot: GitWorkspaceSnapshot | undefined;
    let inputSnapshot: GitWorkspaceSnapshot | undefined;
    let resultSnapshot: GitWorkspaceSnapshot | undefined;
    if (run.gitWorkspace !== undefined) {
      const baselineBytes = bytesByName.get("baseline");
      const runBaselineBytes = bytesByName.get("gitWorkspace.runBaselineSnapshot");
      const inputBytes = bytesByName.get("gitWorkspace.current.inputSnapshot");
      if (
        run.baseline === undefined ||
        baselineBytes === undefined ||
        runBaselineBytes === undefined ||
        inputBytes === undefined ||
        !artifactRefsEqual(run.baseline, run.gitWorkspace.runBaselineSnapshot) ||
        !runRelativePath(run.jobId, run.gitWorkspace.objectDirectory) ||
        !runRelativePath(run.jobId, run.gitWorkspace.current.indexPath) ||
        !runRelativePath(run.jobId, run.gitWorkspace.current.workspacePath)
      ) return "ARTIFACT_SEMANTIC_MISMATCH:gitWorkspace";
      baselineSnapshot = json(runBaselineBytes) as GitWorkspaceSnapshot;
      const baselineAlias = json(baselineBytes) as GitWorkspaceSnapshot;
      inputSnapshot = json(inputBytes) as GitWorkspaceSnapshot;
      if (
        !verifyGitWorkspaceSnapshot(baselineSnapshot) ||
        baselineSnapshot.snapshotKind !== "RUN_BASELINE" ||
        !verifyGitWorkspaceSnapshot(baselineAlias) ||
        baselineAlias.snapshotHash !== baselineSnapshot.snapshotHash ||
        !verifyGitWorkspaceSnapshot(inputSnapshot) ||
        inputSnapshot.repositoryId !== run.gitWorkspace.repositoryId ||
        inputSnapshot.repositoryId !== baselineSnapshot.repositoryId ||
        inputSnapshot.includedPathPolicyHash !== run.gitWorkspace.inclusionPolicyHash ||
        inputSnapshot.includedPathPolicyHash !== baselineSnapshot.includedPathPolicyHash
      ) return "ARTIFACT_SEMANTIC_MISMATCH:gitWorkspaceSnapshots";
      const resultBytes = bytesByName.get("gitWorkspace.current.resultSnapshot");
      if (resultBytes !== undefined) {
        resultSnapshot = json(resultBytes) as GitWorkspaceSnapshot;
        if (
          !verifyGitWorkspaceSnapshot(resultSnapshot) ||
          resultSnapshot.snapshotKind !== "RUN_RESULT" ||
          resultSnapshot.repositoryId !== baselineSnapshot.repositoryId ||
          resultSnapshot.includedPathPolicyHash !== baselineSnapshot.includedPathPolicyHash
        ) return "ARTIFACT_SEMANTIC_MISMATCH:gitWorkspace.current.resultSnapshot";
      }
    } else if (run.baseline !== undefined) {
      return "ARTIFACT_SEMANTIC_MISMATCH:gitWorkspace";
    }

    let previousGeneration = -1;
    for (const [index, attempt] of run.workerAttempts.entries()) {
      if (
        attempt.generation !== previousGeneration + 1 ||
        attempt.providerRuntimeConfigHash !== manifest.providerRuntimeConfigHash
      ) return "ARTIFACT_SEMANTIC_MISMATCH:workerAttempt";
      previousGeneration = attempt.generation;
      const sessionBytes = bytesByName.get(`workerAttempts[${String(index)}].sessionArtifact`);
      if (attempt.status === "COMPLETED" && sessionBytes === undefined) {
        return "ARTIFACT_SEMANTIC_MISMATCH:workerSession";
      }
      if (sessionBytes === undefined) continue;
      const bundle = record(json(sessionBytes));
      if (
        bundle === undefined ||
        bundle.jobId !== run.jobId ||
        bundle.attemptId !== attempt.attemptId ||
        bundle.generation !== attempt.generation ||
        bundle.piSessionId !== attempt.piSessionId ||
        bundle.providerRuntimeConfigHash !== attempt.providerRuntimeConfigHash ||
        bundle.terminalStatus !== "COMPLETED" ||
        bundle.containmentId !== attempt.containmentId ||
        typeof bundle.sessionFileRelativePath !== "string" ||
        typeof bundle.sessionJsonlBase64 !== "string"
      ) return "ARTIFACT_SEMANTIC_MISMATCH:workerSession";
    }

    const continuation = record(run.recovery?.repairContinuation);
    if (continuation !== undefined) {
      const seedRef = artifactRefSchema.safeParse(continuation.workspaceSeedSnapshot);
      const sessionRef = artifactRefSchema.safeParse(continuation.sessionArtifact);
      const sourceAttempt = run.workerAttempts.find(
        (attempt) => attempt.attemptId === continuation.sourceAttemptId
      );
      const repairSeedBytes = bytesByName.get(
        "recovery.repairContinuation.workspaceSeedSnapshot"
      );
      if (
        run.gitWorkspace === undefined ||
        inputSnapshot === undefined ||
        run.gitWorkspace.current.resultSnapshot !== undefined ||
        !seedRef.success ||
        !sessionRef.success ||
        repairSeedBytes === undefined ||
        !artifactRefsEqual(seedRef.data, run.gitWorkspace.current.inputSnapshot) ||
        continuation.kind !== "PI_SESSION_REPAIR" ||
        continuation.jobId !== run.jobId ||
        sourceAttempt === undefined ||
        sourceAttempt.status !== "COMPLETED" ||
        sourceAttempt.generation !== continuation.sourceGeneration ||
        sourceAttempt.piSessionId !== continuation.expectedPiSessionId ||
        sourceAttempt.providerRuntimeConfigHash !== continuation.providerRuntimeConfigHash ||
        sourceAttempt.sessionArtifact === undefined ||
        !artifactRefsEqual(sourceAttempt.sessionArtifact, sessionRef.data) ||
        run.recovery?.repairRound === undefined
      ) return "ARTIFACT_SEMANTIC_MISMATCH:repairContinuation";
      const repairSeed = json(repairSeedBytes) as GitWorkspaceSnapshot;
      if (
        !verifyGitWorkspaceSnapshot(repairSeed) ||
        repairSeed.snapshotKind !== "RUN_RESULT" ||
        repairSeed.snapshotHash !== inputSnapshot.snapshotHash ||
        repairSeed.repositoryId !== run.gitWorkspace.repositoryId ||
        repairSeed.includedPathPolicyHash !== run.gitWorkspace.inclusionPolicyHash
      ) return "ARTIFACT_SEMANTIC_MISMATCH:repairContinuation.workspaceSeedSnapshot";
    } else if (run.recovery?.repairContinuation !== undefined) {
      return "ARTIFACT_SEMANTIC_MISMATCH:repairContinuation";
    }

    const candidateBytes = bytesByName.get("candidate");
    let candidate: Candidate | undefined;
    if (candidateBytes !== undefined) {
      candidate = json(candidateBytes) as Candidate;
      if (
        run.gitWorkspace === undefined ||
        run.candidate === undefined ||
        baselineSnapshot === undefined ||
        resultSnapshot === undefined ||
        run.gitWorkspace.current.candidate === undefined ||
        !artifactRefsEqual(run.candidate, run.gitWorkspace.current.candidate) ||
        !verifyCandidate(candidate) ||
        !verifyCandidateSnapshotBindings({
          candidate,
          runBaseline: baselineSnapshot,
          runResult: resultSnapshot
        })
      ) return "ARTIFACT_SEMANTIC_MISMATCH:candidateSnapshots";
    } else if (run.gitWorkspace?.current.candidate !== undefined) {
      return "ARTIFACT_SEMANTIC_MISMATCH:candidate";
    }

    const reviewBytes = bytesByName.get("review");
    let reviewHash: string | undefined;
    let reviewAllowsAccept = false;
    if (reviewBytes !== undefined) {
      const review = durableReviewDecisionSchema.parse(json(reviewBytes));
      reviewHash = review.reviewHash;
      reviewAllowsAccept = review.gate.allowedLeaderDecisions.includes("accept");
      const matchingAttempt = [...run.workerAttempts].reverse().find(
        (attempt) => attempt.status === "COMPLETED" && attempt.piSessionId === review.piSessionId
      );
      const matchingHistory = [...(run.reviewHistory ?? [])].reverse().find(
        (entry) => entry.reviewAttemptId === review.reviewAttemptId
      );
      if (
        !semanticHashMatches(review, "reviewHash") ||
        candidate === undefined ||
        review.taskSourceHash !== manifest.sourceHash ||
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
        decision.reviewHash !== reviewHash
      ) return "ARTIFACT_SEMANTIC_MISMATCH:leaderDecision";
    }
    if (requiresPublishApproval(run)) {
      if (!reviewAllowsAccept) return "ARTIFACT_SEMANTIC_MISMATCH:review";
      if (!leaderAccepted) return "ARTIFACT_SEMANTIC_MISMATCH:leaderDecision";
    }

    if (run.publish !== undefined) {
      if (
        candidate === undefined ||
        resultSnapshot === undefined ||
        (resolveReviewEnabled() && reviewHash === undefined)
      ) {
        return "ARTIFACT_SEMANTIC_MISMATCH:publish";
      }
      const operations = gitPublishOperations(candidate, resultSnapshot);
      const expectedOperationsHash = operationsHash(operations);
      if (
        run.publish.operationsHash !== expectedOperationsHash ||
        run.publish.operationId !== stableOperationId({
          projectId: state.projectId,
          jobId: run.jobId,
          candidateHash: getCandidateHash(candidate),
          ...(reviewHash === undefined ? {} : { reviewHash }),
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

    const sourceGeneration = attempt?.generation ?? -1;
    const recoveryEpoch: WorkerRecoveryEpoch = {
      fence: run.fence,
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
          ...current.recovery,
          phase: "RUNNING",
          action: "START_NEW_WORKER_ATTEMPT"
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
    const observed = await this.runtime.continueCancellation();
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
        requestId: `recovery:${run.jobId}:s${String(capturedState.stateVersion)}:${transition}`,
        payload,
        replayPolicy: "CURRENT_EPOCH",
        expectedStateVersion: capturedState.stateVersion,
        expectedJobId: run.jobId,
        expectedFence: run.fence,
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
