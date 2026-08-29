import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  durableLeaderDecisionSchema,
  durableReviewDecisionSchema
} from "@smartflow/protocol";
import {
  PublishService,
  FilesystemWorkspaceApplyAdapter,
  observeTargetState,
  operationsHash,
  stableOperationId,
  type ApplyOperation,
  type PublishAttemptRecord,
  type PublishAttemptStore,
  type PublishResult,
  type PublishServiceResult,
  type WorkspaceApplyAdapter
} from "@smartflow/publish";
import { StateStore, type ProjectState, type RunRecord } from "@smartflow/state-store";
import {
  cleanupGitRunTemporaryState,
  getCandidateBaselineHash,
  getCandidateHash,
  verifyCandidate,
  type Candidate,
  type GitWorkspaceSnapshot
} from "@smartflow/workspace";

import { gitPublishBlobReader, gitPublishOperations } from "./git-publish-source.js";
import { ProjectMutationExecutor } from "../runtime/project-mutation-executor.js";
import { verifyRunArtifacts } from "../recovery/recovery-manager.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nextState(
  state: ProjectState,
  jobId: string,
  mutate: (run: RunRecord) => RunRecord,
  terminal = false
): ProjectState {
  const run = state.runs[jobId];
  if (run === undefined) throw new Error(`Unknown publish run: ${jobId}`);
  const updatedAt = new Date().toISOString();
  const activeRunsByTaskPath = terminal
    ? Object.fromEntries(
        Object.entries(state.activeRunsByTaskPath)
          .filter(([taskPath]) => taskPath !== run.canonicalTaskPath)
      )
    : state.activeRunsByTaskPath;
  return {
    ...state,
    stateVersion: state.stateVersion + 1,
    activeRunsByTaskPath,
    runs: { ...state.runs, [jobId]: { ...mutate(run), updatedAt } },
    updatedAt
  };
}

function semanticHash(value: Record<string, unknown>, hashKey: string): boolean {
  const expected = value[hashKey];
  if (typeof expected !== "string") return false;
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== hashKey));
  return hash(canonical(body)) === expected;
}

interface PublishExecutionIdentity {
  fence: number;
  generation?: number;
  attemptId?: string;
}

function publishIdentity(run: RunRecord): PublishExecutionIdentity {
  const attempt = run.workerAttempts.at(-1);
  return {
    fence: run.fence,
    ...(attempt === undefined
      ? {}
      : { generation: attempt.generation }),
    ...(attempt === undefined ? {} : { attemptId: attempt.attemptId })
  };
}

function identityGuards(identity: PublishExecutionIdentity): {
  expectedFence: number;
  expectedGeneration?: number;
  expectedAttemptId?: string;
} {
  return {
    expectedFence: identity.fence,
    ...(identity.generation === undefined ? {} : { expectedGeneration: identity.generation }),
    ...(identity.attemptId === undefined ? {} : { expectedAttemptId: identity.attemptId })
  };
}

function identityMatches(
  state: ProjectState,
  jobId: string,
  identity: PublishExecutionIdentity
): boolean {
  const run = state.runs[jobId];
  const attempt = run?.workerAttempts.at(-1);
  return run !== undefined &&
    state.activeRunsByTaskPath[run.canonicalTaskPath] === jobId &&
    run.fence === identity.fence &&
    (identity.generation === undefined || attempt?.generation === identity.generation) &&
    (identity.attemptId === undefined || attempt?.attemptId === identity.attemptId);
}

class StateStorePublishAttemptStore implements PublishAttemptStore {
  private readonly mutations: ProjectMutationExecutor;

  public constructor(
    private readonly store: StateStore,
    private readonly jobId: string,
    private readonly identity: PublishExecutionIdentity,
    private readonly applyBoundary?: (state: ProjectState) => Promise<void>
  ) {
    this.mutations = new ProjectMutationExecutor(store);
  }

  public async get(operationId: string): Promise<PublishAttemptRecord | undefined> {
    const state = await this.store.readState();
    if (!identityMatches(state, this.jobId, this.identity)) {
      throw new Error("PUBLISH_EXECUTION_STALE");
    }
    const publish = state.runs[this.jobId]?.publish;
    if (publish === undefined || publish.operationId !== operationId) return undefined;
    return publish as PublishAttemptRecord;
  }

  public async acquireLease(operationId: string): Promise<boolean> {
    const observed = await this.store.readState();
    if (
      observed.publishLease !== null &&
      (observed.publishLease.jobId !== this.jobId || observed.publishLease.operationId !== operationId)
    ) return false;
    const acquired = await this.mutations.mutate(
      {
        requestId: `publish-lease:${operationId}:acquire:f${String(observed.projectFence)}`,
        payload: { operationId, jobId: this.jobId },
        expectedJobId: this.jobId,
        ...identityGuards(this.identity),
        expectedPhases: ["READY_TO_PUBLISH", "PUBLISHING"]
      },
      (state) => {
        const lease = state.publishLease;
        const available = lease === null ||
          (lease.jobId === this.jobId && lease.operationId === operationId);
        return {
          nextState: available && lease === null
            ? {
                ...state,
                publishLease: {
                  jobId: this.jobId,
                  operationId,
                  acquiredAt: new Date().toISOString()
                }
              }
            : state,
          response: { acquired: available }
        };
      }
    );
    return acquired.response.acquired;
  }

  public async releaseLease(operationId: string): Promise<void> {
    const observed = await this.store.readState();
    if (
      observed.publishLease?.jobId !== this.jobId ||
      observed.publishLease.operationId !== operationId
    ) return;
    await this.mutations.mutate(
      {
        requestId: `publish-lease:${operationId}:release:f${String(observed.projectFence)}`,
        payload: { operationId, jobId: this.jobId },
        expectedJobId: this.jobId,
        ...identityGuards(this.identity),
        expectedPhases: ["READY_TO_PUBLISH", "PUBLISHING"]
      },
      (state) => ({
        nextState: state.publishLease?.jobId === this.jobId &&
          state.publishLease.operationId === operationId
          ? { ...state, publishLease: null }
          : state,
        response: { released: true }
      })
    );
  }

  public async prepare(attempt: PublishAttemptRecord): Promise<void> {
    await this.mutations.mutate(
      {
        requestId: `publish:${attempt.operationId}:prepared`,
        payload: attempt,
        expectedJobId: this.jobId,
        ...identityGuards(this.identity),
        expectedPhases: ["READY_TO_PUBLISH"]
      },
      (state) => ({
        nextState: nextState(state, this.jobId, (run) => {
          if (run.phase !== "READY_TO_PUBLISH") throw new Error("PUBLISH_PHASE_INVALID");
          return { ...run, phase: "PUBLISHING", publish: attempt };
        }),
        response: { operationId: attempt.operationId, status: "PREPARED" }
      })
    );
  }

  public async markSubmittedAndApply(
    operationId: string,
    apply: () => Promise<PublishResult>
  ): Promise<PublishResult> {
    if (this.applyBoundary === undefined) throw new Error("PUBLISH_APPLY_BOUNDARY_MISSING");
    const mutation = await this.mutations.mutate(
      {
        requestId: `publish:${operationId}:submitted`,
        payload: { operationId, status: "SUBMITTED" },
        expectedJobId: this.jobId,
        ...identityGuards(this.identity),
        expectedPhases: ["PUBLISHING"]
      },
      async (current) => {
        const active = current.runs[this.jobId];
        if (
          active?.publish?.operationId !== operationId ||
          active.publish.status !== "PREPARED"
        ) throw new Error("PUBLISH_OPERATION_STALE");
        await this.applyBoundary?.(current);
        const submitted = { ...active.publish, status: "SUBMITTED" as const };
        return {
          nextState: nextState(current, this.jobId, (run) => ({
            ...run,
            publish: submitted
          })),
          response: { operationId, status: "SUBMITTED" }
        };
      },
      async (committed) => {
        await this.applyBoundary?.(committed);
        return apply;
      }
    );
    if (!mutation.effectStarted || mutation.effect === undefined) {
      throw new Error("PUBLISH_APPLY_HANDOFF_REPLAY_BLOCKED");
    }
    return mutation.effect;
  }

  public async beginRecovery(attempt: PublishAttemptRecord): Promise<void> {
    const state = await this.store.readState();
    const run = state.runs[this.jobId];
    if (run === undefined) throw new Error("PUBLISH_RUN_MISSING");
    await this.mutations.mutate(
      {
        requestId: `publish:${attempt.operationId}:begin-recovery:${attempt.status}`,
        payload: attempt,
        expectedJobId: this.jobId,
        ...identityGuards(this.identity),
        expectedPhases: ["READY_TO_PUBLISH", "PUBLISHING"]
      },
      (current) => ({
        nextState: nextState(current, this.jobId, (active) => {
          if (
            active.publish?.operationId !== attempt.operationId ||
            active.publish.operationsHash !== attempt.operationsHash ||
            active.publish.adapterId !== attempt.adapterId
          ) throw new Error("PUBLISH_RECOVERY_IDENTITY_MISMATCH");
          return { ...active, phase: "PUBLISHING", publish: attempt };
        }),
        response: { operationId: attempt.operationId, status: attempt.status, phase: "PUBLISHING" }
      })
    );
  }

  public async complete(
    operationId: string,
    status: PublishAttemptRecord["status"],
    result: PublishResult
  ): Promise<void> {
    const state = await this.store.readState();
    const run = state.runs[this.jobId];
    if (run === undefined) throw new Error("PUBLISH_RUN_MISSING");
    await this.mutations.mutate(
      {
        requestId: `publish:${operationId}:${status.toLowerCase()}`,
        payload: { operationId, status, result },
        expectedJobId: this.jobId,
        ...identityGuards(this.identity),
        expectedPhases: ["PUBLISHING"]
      },
      (current) => ({
        nextState: {
          ...nextState(current, this.jobId, (active) => {
          if (active.publish?.operationId !== operationId) throw new Error("PUBLISH_OPERATION_STALE");
          return { ...active, publish: { ...active.publish, status, result } };
          }),
          publishLease: status === "COMMITTED" || status === "CONFLICT"
            ? null
            : current.publishLease
        },
        response: { operationId, status }
      })
    );
  }
}

export interface PublishCoordinatorResult {
  service: PublishServiceResult;
  phase: RunRecord["phase"];
}

interface GitPublishSource {
  candidate: Candidate;
  resultSnapshot: GitWorkspaceSnapshot;
  operations: ApplyOperation[];
  gitDirectory: string;
}

function manualPublishRequested(run: RunRecord): boolean {
  const marker = run.recovery?.manualPublishConfirmation;
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) return false;
  const value = marker as Record<string, unknown>;
  return value.status === "REQUESTED" &&
    new Set(["PUBLISH_ADAPTER_UNAVAILABLE", "PUBLISH_PRECHECK_CONFLICT"])
      .has(typeof value.pauseCode === "string" ? value.pauseCode : "");
}

export class PublishCoordinator {
  private readonly mutations: ProjectMutationExecutor;

  public constructor(
    private readonly store: StateStore,
    private readonly adapter?: WorkspaceApplyAdapter
  ) {
    this.mutations = new ProjectMutationExecutor(store);
  }

  public async publish(jobId: string): Promise<PublishCoordinatorResult> {
    const state = await this.store.readState();
    const run = state.runs[jobId];
    if (
      run === undefined ||
      run.phase !== "READY_TO_PUBLISH" ||
      state.activeRunsByTaskPath[run.canonicalTaskPath] !== jobId ||
      run.baseline === undefined ||
      run.candidate === undefined ||
      run.review === undefined ||
      run.leaderDecision === undefined ||
      run.gitWorkspace === undefined
    ) {
      throw new Error("PUBLISH_EVIDENCE_NOT_READY");
    }
    const artifactFailure = await verifyRunArtifacts(this.store, run);
    if (artifactFailure !== undefined) {
      throw new Error(`PUBLISH_ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
    }
    const identity = publishIdentity(run);
    const baseline = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.baseline))
    ) as GitWorkspaceSnapshot;
    const baselineHash = baseline.snapshotHash;
    const source = await this.gitSource(run);
    const reviewValue: unknown = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.review))
    );
    const leaderValue: unknown = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.leaderDecision))
    );
    const reviewDecision = durableReviewDecisionSchema.parse(reviewValue);
    const leaderDecision = durableLeaderDecisionSchema.parse(leaderValue);
    const reviewHash = reviewDecision.reviewHash;
    const reviewHistoryEntry = [...(run.reviewHistory ?? [])].reverse().find(
      (entry) => entry.reviewAttemptId === reviewDecision.reviewAttemptId
    );
    const candidateHash = getCandidateHash(source.candidate);
    if (
      !verifyCandidate(source.candidate) ||
      getCandidateBaselineHash(source.candidate) !== baselineHash ||
      !semanticHash(reviewValue as Record<string, unknown>, "reviewHash") ||
      reviewHistoryEntry?.taskSourceHash !== reviewDecision.taskSourceHash ||
      reviewHistoryEntry.candidateHash !== candidateHash ||
      reviewDecision.candidateHash !== candidateHash ||
      !reviewDecision.gate.allowedLeaderDecisions.includes("accept") ||
      !semanticHash(leaderValue as Record<string, unknown>, "decisionHash") ||
      leaderDecision.reviewHash !== reviewHash ||
      leaderDecision.decision !== "accept"
    ) {
      throw new Error("PUBLISH_EVIDENCE_BINDING_INVALID");
    }
    if (manualPublishRequested(run)) {
      return this.confirmManualPublish(
        state,
        run,
        identity,
        source.operations,
        candidateHash,
        reviewHash
      );
    }

    const attemptStore = new StateStorePublishAttemptStore(
      this.store,
      jobId,
      identity,
      (current) => this.assertAdapterApplyBoundary(
        current,
        jobId,
        run,
        identity,
        source.operations
      )
    );
    const service = await new PublishService(attemptStore).publish(
      state.canonicalProjectRoot,
      {
        projectId: state.projectId,
        jobId,
        candidateHash,
        reviewHash
      },
      source.operations,
      this.adapter ?? new FilesystemWorkspaceApplyAdapter(
        state.canonicalProjectRoot,
        gitPublishBlobReader({
          dataDirectory: this.store.dataDirectory,
          gitDirectory: source.gitDirectory
        }),
        resolve(this.store.dataDirectory, "publish-results")
      )
    );
    const phase: RunRecord["phase"] = service.status === "COMMITTED" ? "COMPLETED" : "PAUSED";
    const completed = await this.mutations.mutate(
      {
        requestId: `publish-result:${jobId}:${service.status}`,
        payload: service,
        expectedJobId: jobId,
        ...identityGuards(identity),
        expectedPhases: service.status === "MANUAL_PUBLISH_REQUIRED" ||
          service.status === "PRECHECK_CONFLICT" ||
          service.status === "PUBLISH_BUSY"
          ? ["READY_TO_PUBLISH"]
          : ["PUBLISHING"]
      },
      (latest) => ({
        nextState: nextState(latest, jobId, (current) => {
          const recovery = { ...current.recovery };
          delete recovery.manualPublishConfirmation;
          if (service.status === "PRECHECK_CONFLICT") {
            recovery.publishPrecheck = {
              conflicts: service.conflicts,
              publishedCount: service.publishedCount,
              totalCount: service.totalCount,
              activeWorkspaceChanged: service.activeWorkspaceChanged
            };
          } else {
            delete recovery.publishPrecheck;
          }
          const pause = service.status === "COMMITTED"
            ? undefined
            : this.pauseForService(service);
          return {
            ...current,
            phase,
            ...(Object.keys(recovery).length === 0 ? { recovery: undefined } : { recovery }),
            ...(pause === undefined ? {} : { pause })
          };
        }, phase === "COMPLETED"),
        response: { phase, serviceStatus: service.status }
      })
    );
    const finalRun = completed.state.runs[jobId];
    if (finalRun?.phase === "COMPLETED") {
      await cleanupGitRunTemporaryState(this.store.dataDirectory, finalRun);
    }
    return { service, phase };
  }

  public async recover(
    jobId: string,
    operationId: string,
    expectedOperationsHash: string
  ): Promise<PublishServiceResult> {
    const state = await this.store.readState();
    const run = state.runs[jobId];
    if (
      run === undefined ||
      state.activeRunsByTaskPath[run.canonicalTaskPath] !== jobId ||
      run.phase !== "PUBLISHING" ||
      run.publish?.operationId !== operationId ||
      run.publish.operationsHash !== expectedOperationsHash ||
      run.candidate === undefined ||
      run.review === undefined ||
      run.gitWorkspace === undefined
    ) {
      return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
    }
    if (await verifyRunArtifacts(this.store, run) !== undefined) {
      return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
    }
    try {
      const source = await this.gitSource(run);
      const reviewDecision = JSON.parse(
        new TextDecoder().decode(await this.store.readArtifact(run.review))
      ) as Record<string, unknown>;
      const reviewHash = reviewDecision.reviewHash;
      const operationHash = operationsHash(source.operations);
      if (
        typeof reviewHash !== "string" ||
        operationHash !== expectedOperationsHash ||
        stableOperationId({
          projectId: state.projectId,
          jobId,
          candidateHash: getCandidateHash(source.candidate),
          reviewHash,
          operationsHash: operationHash
        }) !== operationId
      ) {
        return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
      }
      const adapter = this.adapter ?? new FilesystemWorkspaceApplyAdapter(
        state.canonicalProjectRoot,
        gitPublishBlobReader({
          dataDirectory: this.store.dataDirectory,
          gitDirectory: source.gitDirectory
        }),
        resolve(this.store.dataDirectory, "publish-results")
      );
      return await PublishService.observeRecovery(run.publish, source.operations, adapter);
    } catch {
      return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
    }
  }

  private async confirmManualPublish(
    state: ProjectState,
    run: RunRecord,
    identity: PublishExecutionIdentity,
    operations: ApplyOperation[],
    candidateHash: string,
    reviewHash: string
  ): Promise<PublishCoordinatorResult> {
    if (run.publish !== undefined) throw new Error("MANUAL_PUBLISH_ATTEMPT_ALREADY_EXISTS");
    const confirmationRequestId = (
      run.recovery?.manualPublishConfirmation as { requestId?: unknown } | undefined
    )?.requestId;
    if (typeof confirmationRequestId !== "string" || confirmationRequestId.length === 0) {
      throw new Error("MANUAL_PUBLISH_CONFIRMATION_STALE");
    }
    const operationHash = operationsHash(operations);
    const operationId = stableOperationId({
      projectId: state.projectId,
      jobId: run.jobId,
      candidateHash,
      reviewHash,
      operationsHash: operationHash
    });
    const confirmationRequestHash = hash(confirmationRequestId);
    const committed = await this.mutations.mutate<{
      phase: RunRecord["phase"];
      service: PublishServiceResult;
    }>(
      {
        requestId: `manual-publish-confirm:${run.jobId}:${operationId}:${confirmationRequestHash}`,
        payload: {
          operationId,
          operationsHash: operationHash,
          confirmationRequestHash
        },
        expectedJobId: run.jobId,
        ...identityGuards(identity),
        expectedPhases: ["READY_TO_PUBLISH"]
      },
      async (current) => {
        await this.assertEvidenceBoundary(current, run.jobId, run, identity);
        const active = current.runs[run.jobId];
        if (active === undefined || !manualPublishRequested(active) || active.publish !== undefined) {
          throw new Error("MANUAL_PUBLISH_CONFIRMATION_STALE");
        }
        const observation = await observeTargetState(current.canonicalProjectRoot, operations);
        const recovery = { ...active.recovery };
        const marker = typeof recovery.manualPublishConfirmation === "object" &&
          recovery.manualPublishConfirmation !== null &&
          !Array.isArray(recovery.manualPublishConfirmation)
          ? recovery.manualPublishConfirmation as Record<string, unknown>
          : {};
        if (marker.requestId !== confirmationRequestId) {
          throw new Error("MANUAL_PUBLISH_CONFIRMATION_STALE");
        }
        if (!observation.matches) {
          const service: PublishServiceResult = {
            status: "MANUAL_PUBLISH_REQUIRED",
            reason: "PUBLISH_TARGET_MISMATCH",
            conflicts: observation.conflicts
          };
          recovery.manualPublishConfirmation = {
            ...marker,
            status: "MISMATCH",
            operationId,
            confirmationRequestHash,
            checkedAt: new Date().toISOString(),
            conflicts: observation.conflicts
          };
          recovery.publishPrecheck = {
            conflicts: observation.conflicts,
            publishedCount: 0,
            totalCount: operations.length,
            activeWorkspaceChanged: false
          };
          return {
            nextState: nextState(current, run.jobId, (latest) => ({
              ...latest,
              phase: "PAUSED",
              recovery,
              pause: {
                code: "MANUAL_PUBLISH_TARGET_MISMATCH",
                resumeActions: ["confirm_manual_publish", "retry_publish", "cancel"]
              }
            })),
            response: { phase: "PAUSED", service }
          };
        }
        const result: PublishResult = {
          operationId,
          operationsHash: operationHash,
          status: "COMMITTED",
          paths: operations.map((operation) => ({
            path: operation.path,
            status: "COMMITTED",
            observedHash: operation.newHash,
            observedMode: operation.newMode
          }))
        };
        const publish: PublishAttemptRecord = {
          operationId,
          operationsHash: operationHash,
          adapterId: "manual-confirmation-v1",
          status: "COMMITTED",
          result
        };
        delete recovery.manualPublishConfirmation;
        delete recovery.publishPrecheck;
        const terminal = nextState(current, run.jobId, (latest) => ({
          ...latest,
          phase: "COMPLETED",
          publish,
          pause: undefined,
          ...(Object.keys(recovery).length === 0 ? { recovery: undefined } : { recovery })
        }), true);
        const service: PublishServiceResult = { status: "COMMITTED", operationId, result };
        return {
          nextState: terminal.publishLease?.jobId === run.jobId
            ? { ...terminal, publishLease: null }
            : terminal,
          response: { phase: "COMPLETED", service }
        };
      }
    );
    const finalRun = committed.state.runs[run.jobId];
    if (finalRun?.phase === "COMPLETED") {
      await cleanupGitRunTemporaryState(this.store.dataDirectory, finalRun);
    }
    return committed.response;
  }

  private pauseForService(service: Exclude<PublishServiceResult, { status: "COMMITTED" }>): {
    code: string;
    resumeActions: string[];
  } {
    if (service.status === "MANUAL_PUBLISH_REQUIRED") {
      return {
        code: "PUBLISH_ADAPTER_UNAVAILABLE",
        resumeActions: ["retry_publish", "confirm_manual_publish", "cancel"]
      };
    }
    if (service.status === "PRECHECK_CONFLICT") {
      return {
        code: "PUBLISH_PRECHECK_CONFLICT",
        resumeActions: ["retry_publish", "confirm_manual_publish", "cancel"]
      };
    }
    if (service.status === "PUBLISH_BUSY") {
      return { code: "PROJECT_PUBLISH_BUSY", resumeActions: ["retry_publish", "cancel"] };
    }
    return { code: "PUBLISH_RECOVERY_BLOCKED", resumeActions: ["inspect_recovery", "cancel"] };
  }

  private async assertAdapterApplyBoundary(
    state: ProjectState,
    jobId: string,
    expected: RunRecord,
    identity: PublishExecutionIdentity,
    operations: ApplyOperation[]
  ): Promise<void> {
    const active = state.runs[jobId];
    if (
      active === undefined ||
      active.phase !== "PUBLISHING" ||
      !new Set(["PREPARED", "SUBMITTED"]).has(active.publish?.status ?? "")
    ) throw new Error("PUBLISH_APPLY_BOUNDARY_STALE");
    await this.assertEvidenceBoundary(state, jobId, expected, identity);
    if (active.publish?.operationsHash !== operationsHash(operations)) {
      throw new Error("PUBLISH_APPLY_BOUNDARY_STALE");
    }
  }

  private async assertEvidenceBoundary(
    state: ProjectState,
    jobId: string,
    expected: RunRecord,
    identity: PublishExecutionIdentity
  ): Promise<void> {
    const active = state.runs[jobId];
    if (active === undefined || !identityMatches(state, jobId, identity)) {
      throw new Error("PUBLISH_APPLY_BOUNDARY_STALE");
    }
    const artifactFailure = await verifyRunArtifacts(this.store, active);
    if (artifactFailure !== undefined) {
      throw new Error(`PUBLISH_ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
    }
    const approvedPath = active.approvedTasks?.path;
    const approvedHash = active.approvedTasks?.sourceHash;
    const activeResult = active.gitWorkspace?.current.resultSnapshot;
    const expectedResult = expected.gitWorkspace?.current.resultSnapshot;
    if (
      typeof approvedPath !== "string" ||
      typeof approvedHash !== "string" ||
      hash(await readFile(approvedPath)) !== approvedHash.replace(/^sha256:/u, "") ||
      active.taskManifest.sha256 !== expected.taskManifest.sha256 ||
      active.baseline?.sha256 !== expected.baseline?.sha256 ||
      active.candidate?.sha256 !== expected.candidate?.sha256 ||
      active.review?.sha256 !== expected.review?.sha256 ||
      active.leaderDecision?.sha256 !== expected.leaderDecision?.sha256 ||
      active.gitWorkspace?.objectDirectory !== expected.gitWorkspace?.objectDirectory ||
      activeResult?.sha256 !== expectedResult?.sha256
    ) {
      throw new Error("PUBLISH_APPLY_BOUNDARY_STALE");
    }
  }

  private async gitSource(run: RunRecord): Promise<GitPublishSource> {
    const currentWorkspace = run.gitWorkspace?.current;
    if (
      run.candidate === undefined ||
      run.gitWorkspace === undefined ||
      currentWorkspace?.resultSnapshot === undefined
    ) {
      throw new Error("PUBLISH_GIT_SOURCE_MISSING");
    }
    const candidate = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.candidate))
    ) as Candidate;
    const resultSnapshot = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(currentWorkspace.resultSnapshot))
    ) as GitWorkspaceSnapshot;
    return {
      candidate,
      resultSnapshot,
      operations: gitPublishOperations(candidate, resultSnapshot),
      gitDirectory: dirname(resolve(this.store.dataDirectory, run.gitWorkspace.objectDirectory))
    };
  }
}
