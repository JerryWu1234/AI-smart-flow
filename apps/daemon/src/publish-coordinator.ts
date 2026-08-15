import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  PublishService,
  FilesystemWorkspaceApplyAdapter,
  createDeliveryBundle,
  exportSigningPublicKey,
  loadOrCreateInstallationSigningKey,
  parseSerializedDeliveryBundle,
  requireExternalBundleSignature,
  serializeDeliveryBundle,
  operationsHash,
  stableOperationId,
  type ApplyOperation,
  type DeliveryBundle,
  type PublishAttemptRecord,
  type PublishAttemptStore,
  type PublishResult,
  type PublishServiceResult,
  type WorkspaceApplyAdapter
} from "@smartflow/publish";
import { StateStore, type ProjectState, type RunRecord } from "@smartflow/state-store";
import { taskManifestSchema } from "@smartflow/task-manifest";
import {
  buildGitTreePatch,
  cleanupGitRunTemporaryState,
  getCandidateBaselineHash,
  getCandidateHash,
  verifyCandidate,
  type Candidate,
  type GitWorkspaceSnapshot
} from "@smartflow/workspace";

import { ProjectMutationExecutor } from "./project-mutation-executor.js";
import { verifyRunArtifacts } from "./recovery-manager.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deliveryBundleBlobReader(bundle: DeliveryBundle): {
  read(ref: NonNullable<ApplyOperation["blobRef"]>): Promise<Uint8Array>;
} {
  const blobsByHash = new Map(bundle.manifest.blobs.map((blob) => {
    const bytes = bundle.blobs[blob.path];
    if (bytes === undefined || bytes.byteLength !== blob.size || hash(bytes) !== blob.sha256) {
      throw new Error(`DELIVERY_BUNDLE_BLOB_INVALID: ${blob.path}`);
    }
    return [`${blob.sha256}:${String(blob.size)}`, bytes] as const;
  }));
  return {
    read: (ref): Promise<Uint8Array> => {
      const bytes = blobsByHash.get(`${ref.sha256.replace(/^sha256:/u, "")}:${String(ref.size)}`);
      if (bytes === undefined) {
        return Promise.reject(new Error(`DELIVERY_BUNDLE_BLOB_MISSING: ${ref.relativePath}`));
      }
      return Promise.resolve(bytes);
    }
  };
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
  revision: number;
  generation?: number;
  attemptId?: string;
}

function publishIdentity(run: RunRecord): PublishExecutionIdentity {
  const attempt = run.workerAttempts.at(-1);
  return {
    fence: run.fence,
    revision: run.revision,
    ...(attempt === undefined
      ? {}
      : { generation: attempt.generation }),
    ...(attempt === undefined ? {} : { attemptId: attempt.attemptId })
  };
}

function identityGuards(identity: PublishExecutionIdentity): {
  expectedFence: number;
  expectedRevision: number;
  expectedGeneration?: number;
  expectedAttemptId?: string;
} {
  return {
    expectedFence: identity.fence,
    expectedRevision: identity.revision,
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
    run.revision === identity.revision &&
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

  public async markSubmitted(operationId: string): Promise<void> {
    const state = await this.store.readState();
    const run = state.runs[this.jobId];
    if (run === undefined) throw new Error("PUBLISH_RUN_MISSING");
    await this.mutations.mutate(
      {
        requestId: `publish:${operationId}:submitted`,
        payload: { operationId, status: "SUBMITTED" },
        expectedJobId: this.jobId,
        ...identityGuards(this.identity),
        expectedPhases: ["PUBLISHING"]
      },
      (current) => ({
        nextState: nextState(current, this.jobId, (active) => {
          if (active.publish?.operationId !== operationId) throw new Error("PUBLISH_OPERATION_STALE");
          return { ...active, publish: { ...active.publish, status: "SUBMITTED" } };
        }),
        response: { operationId, status: "SUBMITTED" }
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
        requestId: `publish:${attempt.operationId}:begin-recovery:r${String(run.revision)}:${attempt.status}`,
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
  deliveryBundle: RunRecord["deliveryBundle"];
  phase: RunRecord["phase"];
}

export class PublishCoordinator {
  private readonly mutations: ProjectMutationExecutor;

  public constructor(
    private readonly store: StateStore,
    private readonly signingKeyPath: string,
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
      (run.workspace === undefined && run.deliveryBundle === undefined)
    ) {
      throw new Error("PUBLISH_EVIDENCE_NOT_READY");
    }
    const artifactFailure = await verifyRunArtifacts(this.store, run);
    if (artifactFailure !== undefined) {
      throw new Error(`PUBLISH_ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
    }
    const identity = publishIdentity(run);
    const manifest = taskManifestSchema.parse(JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.taskManifest))
    ));
    const baseline = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.baseline))
    ) as GitWorkspaceSnapshot;
    const baselineHash = baseline.snapshotHash;
    const candidate = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.candidate))
    ) as Candidate;
    const reviewDecision = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.review))
    ) as Record<string, unknown>;
    const leaderDecision = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.leaderDecision))
    ) as Record<string, unknown>;
    const reviewHash = reviewDecision.reviewHash;
    const reviewHistoryEntry = [...(run.reviewHistory ?? [])].reverse().find(
      (entry) => entry.reviewAttemptId === reviewDecision.reviewAttemptId
    );
    const allowedLeaderDecisions = (
      reviewDecision.gate as { allowedLeaderDecisions?: unknown } | undefined
    )?.allowedLeaderDecisions;
    const candidateHash = getCandidateHash(candidate);
    if (
      manifest.revision !== run.revision ||
      !verifyCandidate(candidate) ||
      getCandidateBaselineHash(candidate) !== baselineHash ||
      !semanticHash(reviewDecision, "reviewHash") ||
      reviewHistoryEntry?.taskSourceHash !== reviewDecision.taskSourceHash ||
      reviewHistoryEntry?.candidateHash !== candidateHash ||
      reviewDecision.candidateHash !== candidateHash ||
      !Array.isArray(allowedLeaderDecisions) ||
      !allowedLeaderDecisions.includes("accept") ||
      typeof reviewHash !== "string" ||
      !semanticHash(leaderDecision, "decisionHash") ||
      leaderDecision.reviewHash !== reviewHash ||
      leaderDecision.decision !== "accept"
    ) {
      throw new Error("PUBLISH_EVIDENCE_BINDING_INVALID");
    }
    let bundleArtifact = run.deliveryBundle;
    let durableBundle: DeliveryBundle;
    if (bundleArtifact === undefined) {
      if (run.workspace === undefined) throw new Error("PUBLISH_WORKSPACE_MISSING");
      const workspaceRoot = resolve(this.store.dataDirectory, run.workspace.relativePath);
      const { operations, blobs } = await this.operations(
        candidate,
        workspaceRoot,
        jobId,
        run.revision,
        this.adapter !== undefined
      );
      const patch = await this.deliveryPatch(run, baseline);
      const bundle = createDeliveryBundle({
        revision: run.revision,
        taskManifestHash: run.taskManifest.sha256,
        baselineHash,
        candidateHash,
        reviewHash,
        operations,
        patch,
        blobs
      });
      const signingKey = await loadOrCreateInstallationSigningKey(this.signingKeyPath);
      const envelope = requireExternalBundleSignature(bundle.canonicalManifestHash, signingKey);
      const serialized = serializeDeliveryBundle(
        bundle,
        envelope,
        exportSigningPublicKey(signingKey.publicKey)
      );
      const bundleCommit = await this.mutations.mutate(
        {
          requestId: `delivery-bundle:${jobId}:r${String(run.revision)}:${bundle.canonicalManifestHash}`,
          payload: { bundleHash: bundle.canonicalManifestHash, serializedHash: hash(serialized) },
          expectedJobId: jobId,
          ...identityGuards(identity),
          expectedPhases: ["READY_TO_PUBLISH"]
        },
        async (current) => {
          const active = current.runs[jobId];
          if (active === undefined) throw new Error("PUBLISH_RUN_MISSING");
          const currentFailure = await verifyRunArtifacts(this.store, active);
          if (currentFailure !== undefined) {
            throw new Error(`PUBLISH_ARTIFACT_INTEGRITY_BLOCKED:${currentFailure}`);
          }
          const artifact = await this.store.writeArtifact(
            `runs/${jobId}/revision-${String(run.revision)}/delivery-bundles/${bundle.canonicalManifestHash}/delivery-bundle.json`,
            serialized
          );
          return {
            nextState: nextState(current, jobId, (latest) => ({
              ...latest,
              deliveryBundle: artifact
            })),
            response: { bundleHash: bundle.canonicalManifestHash, artifact }
          };
        }
      );
      bundleArtifact = bundleCommit.response.artifact;
      durableBundle = parseSerializedDeliveryBundle(
        await this.store.readArtifact(bundleArtifact)
      ).bundle;
    } else {
      durableBundle = parseSerializedDeliveryBundle(
        await this.store.readArtifact(bundleArtifact)
      ).bundle;
    }
    const publishOperations = durableBundle.manifest.operations;
    const attemptStore = new StateStorePublishAttemptStore(
      this.store,
      jobId,
      identity,
      (current) => this.assertAdapterApplyBoundary(
        current,
        jobId,
        run,
        identity,
        bundleArtifact,
        publishOperations
      )
    );
    const service = await new PublishService(attemptStore).publish(
      state.canonicalProjectRoot,
      {
        projectId: state.projectId,
        jobId,
        revision: run.revision,
        candidateHash,
        reviewHash
      },
      publishOperations,
      this.adapter ?? new FilesystemWorkspaceApplyAdapter(
        state.canonicalProjectRoot,
        deliveryBundleBlobReader(durableBundle),
        resolve(this.store.dataDirectory, "publish-results")
      )
    );
    const phase: RunRecord["phase"] = service.status === "COMMITTED" ? "COMPLETED" : "PAUSED";
    const completed = await this.mutations.mutate(
      {
        requestId: `publish-result:${jobId}:r${String(run.revision)}:${service.status}`,
        payload: service,
        expectedJobId: jobId,
        ...identityGuards(identity),
        expectedPhases: service.status === "BUNDLE_READY" ||
          service.status === "PRECHECK_CONFLICT" ||
          service.status === "PUBLISH_BUSY"
          ? ["READY_TO_PUBLISH"]
          : ["PUBLISHING"]
      },
      (latest) => ({
        nextState: nextState(latest, jobId, (current) => {
          const recovery = { ...current.recovery };
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
          return {
            ...current,
            phase,
            ...(Object.keys(recovery).length === 0 ? { recovery: undefined } : { recovery }),
            ...(phase === "PAUSED"
              ? {
                  pause: {
                    code: service.status === "BUNDLE_READY"
                      ? "PUBLISH_ADAPTER_UNAVAILABLE"
                      : service.status === "PRECHECK_CONFLICT"
                        ? "PUBLISH_PRECHECK_CONFLICT"
                        : service.status === "PUBLISH_BUSY"
                          ? "PROJECT_PUBLISH_BUSY"
                          : "PUBLISH_RECOVERY_BLOCKED",
                    resumeActions: ["retry_publish", "export_bundle", "cancel"]
                  }
                }
              : {})
          };
        }, phase === "COMPLETED"),
        response: { phase, serviceStatus: service.status }
      })
    );
    const finalRun = completed.state.runs[jobId];
    if (finalRun?.phase === "COMPLETED") {
      await cleanupGitRunTemporaryState(this.store.dataDirectory, finalRun);
    }
    return { service, deliveryBundle: bundleArtifact, phase };
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
      run.deliveryBundle === undefined ||
      run.candidate === undefined ||
      run.review === undefined
    ) {
      return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
    }
    if (await verifyRunArtifacts(this.store, run) !== undefined) {
      return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
    }
    const durableBundle = parseSerializedDeliveryBundle(
      await this.store.readArtifact(run.deliveryBundle)
    ).bundle;
    const candidate = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.candidate))
    ) as Candidate;
    const reviewDecision = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.review))
    ) as Record<string, unknown>;
    const reviewHash = reviewDecision.reviewHash;
    const operations = durableBundle.manifest.operations;
    const operationHash = operationsHash(operations);
    if (
      typeof reviewHash !== "string" ||
      run.publish.revision !== run.revision ||
      operationHash !== expectedOperationsHash ||
      stableOperationId({
        projectId: state.projectId,
        jobId,
        revision: run.revision,
        candidateHash: getCandidateHash(candidate),
        reviewHash,
        operationsHash: operationHash
      }) !== operationId
    ) {
      return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
    }
    const adapter = this.adapter ?? new FilesystemWorkspaceApplyAdapter(
      state.canonicalProjectRoot,
      deliveryBundleBlobReader(durableBundle),
      resolve(this.store.dataDirectory, "publish-results")
    );
    return PublishService.observeRecovery(run.publish, operations, adapter);
  }

  private async assertAdapterApplyBoundary(
    state: ProjectState,
    jobId: string,
    expected: RunRecord,
    identity: PublishExecutionIdentity,
    deliveryBundle: NonNullable<RunRecord["deliveryBundle"]>,
    operations: ApplyOperation[]
  ): Promise<void> {
    const active = state.runs[jobId];
    if (
      active === undefined ||
      !identityMatches(state, jobId, identity) ||
      active.phase !== "PUBLISHING" ||
      !new Set(["PREPARED", "SUBMITTED"]).has(active.publish?.status ?? "")
    ) throw new Error("PUBLISH_APPLY_BOUNDARY_STALE");
    const artifactFailure = await verifyRunArtifacts(this.store, active);
    if (artifactFailure !== undefined) {
      throw new Error(`PUBLISH_ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
    }
    const approvedPath = active.approvedTasks?.path;
    const approvedHash = active.approvedTasks?.sourceHash;
    if (
      typeof approvedPath !== "string" ||
      typeof approvedHash !== "string" ||
      hash(await readFile(approvedPath)) !== approvedHash.replace(/^sha256:/u, "") ||
      active.taskManifest.sha256 !== expected.taskManifest.sha256 ||
      active.candidate?.sha256 !== expected.candidate?.sha256 ||
      active.review?.sha256 !== expected.review?.sha256 ||
      active.leaderDecision?.sha256 !== expected.leaderDecision?.sha256 ||
      active.deliveryBundle?.sha256 !== deliveryBundle.sha256 ||
      active.publish?.operationsHash !== operationsHash(operations)
    ) {
      throw new Error("PUBLISH_APPLY_BOUNDARY_STALE");
    }
  }

  private async operations(
    candidate: Candidate,
    workspaceRoot: string,
    jobId: string,
    revision: number,
    materializeBlobs: boolean
  ): Promise<{ operations: ApplyOperation[]; blobs: Record<string, Uint8Array> }> {
    const blobs: Record<string, Uint8Array> = {};
    const operations: ApplyOperation[] = [];
    for (const operation of candidate.operations) {
      const oldEntry = "oldEntry" in operation ? operation.oldEntry : undefined;
      const newEntry = "newEntry" in operation ? operation.newEntry : undefined;
      if (oldEntry?.kind === "SYMLINK" || newEntry?.kind === "SYMLINK") {
        throw new Error(`PUBLISH_SYMLINK_OPERATION_UNSUPPORTED: ${operation.path}`);
      }
      let blobRef: ApplyOperation["blobRef"] = null;
      if (newEntry !== undefined) {
        const bytes = await readFile(resolve(workspaceRoot, operation.path));
        if (hash(bytes) !== newEntry.sha256) throw new Error("PUBLISH_CANDIDATE_BLOB_DRIFT");
        blobs[operation.path] = bytes;
        blobRef = materializeBlobs
          ? await this.store.writeArtifact(
              `runs/${jobId}/revision-${String(revision)}/publish-blobs/${newEntry.sha256}`,
              bytes
            )
          : {
              relativePath: `delivery-bundle/blobs/${newEntry.sha256}`,
              sha256: newEntry.sha256,
              size: bytes.byteLength
            };
      }
      operations.push({
        path: operation.path,
        type: operation.kind,
        expectedOldKind: oldEntry === undefined ? "ABSENT" : "FILE",
        expectedOldHash: oldEntry?.sha256 ?? null,
        expectedOldMode: oldEntry?.mode ?? null,
        newHash: newEntry?.sha256 ?? null,
        newMode: newEntry?.mode ?? null,
        blobRef
      });
    }
    return { operations, blobs };
  }

  private async deliveryPatch(
    run: RunRecord,
    baseline: GitWorkspaceSnapshot
  ): Promise<string> {
    const revisionWorkspace = run.gitWorkspace?.revisions[String(run.revision)];
    if (revisionWorkspace?.cumulativePatch !== undefined) {
      return new TextDecoder().decode(
        await this.store.readArtifact(revisionWorkspace.cumulativePatch)
      );
    }
    if (run.gitWorkspace === undefined || revisionWorkspace?.resultSnapshot === undefined) {
      throw new Error("PUBLISH_GIT_PATCH_INPUT_MISSING");
    }
    const result = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(revisionWorkspace.resultSnapshot))
    ) as GitWorkspaceSnapshot;
    return new TextDecoder().decode(await buildGitTreePatch({
      runGitDirectory: dirname(resolve(this.store.dataDirectory, run.gitWorkspace.objectDirectory)),
      baseTreeId: baseline.treeId,
      resultTreeId: result.treeId
    }));
  }
}
