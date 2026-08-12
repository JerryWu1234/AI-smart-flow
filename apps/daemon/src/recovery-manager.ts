import { createHash, randomUUID } from "node:crypto";

import {
  durableLeaderDecisionSchema,
  durableReviewDecisionSchema,
  publishResultSchema,
  type PublishResult,
  type RunPhase
} from "@smartflow/protocol";
import {
  parseSerializedDeliveryBundle,
  verifyDeliverySignature,
  verifyLocalDeliveryBundle,
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
import { verifyCandidate, type Candidate } from "@smartflow/workspace";

import { ProjectMutationExecutor } from "./project-mutation-executor.js";

const terminalPhases = new Set<RunPhase>(["COMPLETED", "CANCELED", "FAILED"]);

export type RecoveryAction =
  | "NONE"
  | "REBUILD_WORKSPACE"
  | "RESUME_WORKER"
  | "START_NEW_WORKER_ATTEMPT"
  | "PREPARE_REPAIR"
  | "WAIT_FOR_HOST"
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

    const candidateBytes = bytesByName.get("candidate");
    let candidate: Candidate | undefined;
    if (candidateBytes !== undefined) {
      candidate = json(candidateBytes) as Candidate;
      if (!verifyCandidate(candidate)) return "ARTIFACT_SEMANTIC_MISMATCH:candidate";
    }

    const reviewBytes = bytesByName.get("review");
    if (reviewBytes !== undefined) {
      const review = durableReviewDecisionSchema.parse(json(reviewBytes));
      const matchingAttempt = [...run.workerAttempts].reverse().find(
        (attempt) => attempt.revision === run.revision && attempt.piSessionId === review.piSessionId
      );
      const matchingHistory = [...(run.reviewHistory ?? [])].reverse().find(
        (entry) => entry.reviewAttemptId === review.reviewAttemptId
      );
      if (
        review.revision !== run.revision ||
        candidate === undefined ||
        review.candidateHash !== candidate.hash ||
        matchingHistory === undefined ||
        matchingHistory.taskSourceHash !== review.taskSourceHash ||
        matchingHistory.candidateHash !== review.candidateHash ||
        matchingAttempt === undefined ||
        review.reviewerSessionId === review.piSessionId
      ) return "ARTIFACT_SEMANTIC_MISMATCH:review";
    }

    const leaderBytes = bytesByName.get("leaderDecision");
    if (leaderBytes !== undefined) {
      const decision = durableLeaderDecisionSchema.parse(json(leaderBytes));
      if (decision.revision !== run.revision) {
        return "ARTIFACT_SEMANTIC_MISMATCH:leaderDecision";
      }
    }

    const deliveryBytes = bytesByName.get("deliveryBundle");
    if (deliveryBytes !== undefined) {
      const parsed = parseSerializedDeliveryBundle(deliveryBytes);
      if (
        !verifyLocalDeliveryBundle(parsed.bundle) ||
        !verifyDeliverySignature(
          parsed.envelope,
          new Map([[parsed.envelope.keyId, parsed.signerPublicKey]])
        ) ||
        parsed.bundle.manifest.revision !== run.revision ||
        parsed.bundle.manifest.taskManifestHash !== digest(run.taskManifest.sha256) ||
        (candidate !== undefined && parsed.bundle.manifest.candidateHash !== candidate.hash) ||
        (run.publish?.result !== undefined &&
          !publishResultMatchesOperations(run.publish.result, parsed.bundle.manifest.operations))
      ) return "ARTIFACT_SEMANTIC_MISMATCH:deliveryBundle";
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
        return this.result(state, run, "WAIT_FOR_HOST");
      case "REVIEWING":
        return this.recoverReviewClaim(state, run);
      case "LEADER_DECISION":
        return this.result(state, run, "WAIT_FOR_LEADER");
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

  private async recoverReviewClaim(state: ProjectState, run: RunRecord): Promise<RecoveryResult> {
    const expiresAt = typeof run.pendingAction?.claimExpiresAt === "string"
      ? run.pendingAction.claimExpiresAt
      : typeof run.pendingAction?.expiresAt === "string"
        ? run.pendingAction.expiresAt
        : undefined;
    if (expiresAt === undefined || Date.parse(expiresAt) > Date.now()) {
      return this.result(state, run, "WAIT_FOR_HOST");
    }
    const pendingAction = { ...run.pendingAction };
    delete pendingAction.claimId;
    delete pendingAction.hostTurnId;
    delete pendingAction.claimExpiresAt;
    delete pendingAction.claimStatus;
    delete pendingAction.status;
    const committed = await this.commit(
      state,
      run,
      "review:claim-expired",
      { expiresAt },
      (current) => ({
        ...current,
        phase: "REVIEW_PENDING",
        pendingAction: {
          ...pendingAction,
          actionId: `review-action-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
        }
      })
    );
    return this.result(committed, committed.runs[run.jobId] ?? run, "WAIT_FOR_HOST");
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
        (current) => ({
          ...current,
          phase: terminal ? "COMPLETED" : "PAUSED",
          publish: { ...publish, status: finalStatus, result: parsed.data },
          ...(terminal ? {} : {
            pause: { code: "PUBLISH_CONFLICT", resumeActions: ["inspect_conflict", "cancel"] }
          })
        }),
        terminal
      );
      return this.result(committed, committed.runs[run.jobId] ?? run, "PUBLISH_RECONCILED");
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
    terminal = false
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
      (state) => ({
        nextState: nextStateWithRun(state, run.jobId, mutate, terminal),
        response: { transition }
      })
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
