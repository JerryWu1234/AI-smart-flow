import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ProjectRuntime, PublishCoordinator } from "@smartflow/daemon";
import {
  PublishService,
  observeTargetState,
  operationsHash,
  stableOperationId,
  type ApplyOperation,
  type PublishAttemptRecord,
  type PublishAttemptStore,
  type PublishResult,
  type WorkspaceApplyCapabilities,
  type WorkspaceApplyAdapter
} from "@smartflow/publish";
import type { Candidate, GitWorkspaceSnapshot } from "@smartflow/workspace";
import { gitPublishOperations } from "../../apps/daemon/src/git-publish-source.js";
import { createTasksSource } from "../fixtures/task-manifest/test-fixture.js";
import { createLifecycleStore } from "../crash/recovery-test-fixture.js";
import { createRuntimeHarness } from "../helpers/runtime-harness.js";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function operation(): ApplyOperation {
  return {
    path: "a.txt",
    type: "MODIFY",
    expectedOldKind: "FILE",
    expectedOldHash: hash("old"),
    expectedOldMode: 0o600,
    newHash: hash("new"),
    newMode: 0o600,
    blobRef: { relativePath: "blobs/a", sha256: hash("new"), size: 3 }
  };
}

class Store implements PublishAttemptStore {
  public readonly attempts = new Map<string, PublishAttemptRecord>();
  public completeCalls = 0;

  public get(operationId: string): Promise<PublishAttemptRecord | undefined> {
    return Promise.resolve(this.attempts.get(operationId));
  }

  public prepare(attempt: PublishAttemptRecord): Promise<void> {
    this.attempts.set(attempt.operationId, attempt);
    return Promise.resolve();
  }

  public beginRecovery(attempt: PublishAttemptRecord): Promise<void> {
    this.attempts.set(attempt.operationId, attempt);
    return Promise.resolve();
  }

  public markSubmitted(operationId: string): Promise<void> {
    const value = this.attempts.get(operationId);
    if (value === undefined) throw new Error("attempt missing");
    this.attempts.set(operationId, { ...value, status: "SUBMITTED" });
    return Promise.resolve();
  }

  public complete(
    operationId: string,
    status: PublishAttemptRecord["status"],
    result: PublishResult
  ): Promise<void> {
    this.completeCalls += 1;
    const value = this.attempts.get(operationId);
    if (value === undefined) throw new Error("attempt missing");
    this.attempts.set(operationId, { ...value, status, result });
    return Promise.resolve();
  }
}

class CountingAdapter implements WorkspaceApplyAdapter {
  public applyCalls = 0;
  public getResultCalls = 0;

  public constructor(private readonly adapter: WorkspaceApplyAdapter) {}

  public probe(): Promise<WorkspaceApplyCapabilities> {
    return this.adapter.probe();
  }

  public apply(input: {
    operationId: string;
    operationsHash: string;
    operations: ApplyOperation[];
  }): Promise<PublishResult> {
    this.applyCalls += 1;
    return this.adapter.apply(input);
  }

  public getResult(operationId: string): Promise<PublishResult | "PENDING" | "UNKNOWN"> {
    this.getResultCalls += 1;
    return this.adapter.getResult(operationId);
  }
}

const bindings = {
  projectId: "project-1",
  jobId: "job-1",
  revision: 1,
  candidateHash: "a".repeat(64),
  reviewHash: "b".repeat(64)
};

async function operationsForRun(
  store: Awaited<ReturnType<typeof createLifecycleStore>>
): Promise<ApplyOperation[]> {
  const state = await store.readState();
  const run = state.runs["job-1"];
  const resultSnapshot = run?.gitWorkspace?.revisions[String(run.revision)]?.resultSnapshot;
  if (run?.candidate === undefined || resultSnapshot === undefined) {
    throw new Error("Git publish source fixture missing");
  }
  const candidate = JSON.parse(
    new TextDecoder().decode(await store.readArtifact(run.candidate))
  ) as Candidate;
  const snapshot = JSON.parse(
    new TextDecoder().decode(await store.readArtifact(resultSnapshot))
  ) as GitWorkspaceSnapshot;
  return gitPublishOperations(candidate, snapshot);
}

async function requestManualConfirmation(
  store: Awaited<ReturnType<typeof createLifecycleStore>>,
  sourcePauseCode: "PUBLISH_ADAPTER_UNAVAILABLE" | "PUBLISH_PRECHECK_CONFLICT"
): Promise<void> {
  const state = await store.readState();
  const run = state.runs["job-1"];
  if (run === undefined) throw new Error("manual publish fixture missing");
  const updatedAt = new Date().toISOString();
  await store.writeState({
    ...state,
    stateVersion: state.stateVersion + 1,
    runs: {
      ...state.runs,
      "job-1": {
        ...run,
        phase: "READY_TO_PUBLISH",
        pause: undefined,
        recovery: {
          ...run.recovery,
          manualPublishConfirmation: {
            status: "REQUESTED",
            revision: run.revision,
            pauseCode: sourcePauseCode,
            requestId: `manual-confirm-${String(state.stateVersion + 1)}`,
            requestedAt: updatedAt
          }
        },
        updatedAt
      }
    },
    updatedAt
  });
}

describe("durable CAS publish", () => {
  it("persists preflight conflicts for smartflow_result without applying any path", async () => {
    const harness = await createRuntimeHarness();
    try {
      const projectId = `project-${"3".repeat(40)}`;
      const dataDirectory = resolve(harness.dataDir, "publish-precheck-result");
      const store = await createLifecycleStore(harness, "READY_TO_PUBLISH", {}, {
        dataDirectory: resolve(dataDirectory, "projects", projectId),
        projectId
      });
      const ready = await store.readState();
      const workspace = ready.runs["job-1"]?.workspace;
      if (workspace === undefined) throw new Error("precheck workspace missing");
      const sourcePath = resolve(harness.projectDir, "sum.js");
      const source = await readFile(sourcePath);
      const workspacePath = resolve(store.dataDirectory, workspace.relativePath, "sum.js");
      await mkdir(resolve(workspacePath, ".."), { recursive: true });
      await writeFile(workspacePath, "mutable worktree does not drive preflight", "utf8");
      let applyCalls = 0;
      const adapter: WorkspaceApplyAdapter = {
        probe: () => Promise.resolve({
          expectedOldHashCas: true,
          atomicBatchCas: true,
          stableOperationId: true,
          queryResult: true,
          adapterId: "publish-precheck-result-test"
        }),
        apply: () => {
          applyCalls += 1;
          return Promise.reject(new Error("preflight conflict must not apply"));
        },
        getResult: () => Promise.resolve("UNKNOWN")
      };

      await expect(new PublishCoordinator(store, adapter).publish("job-1")).resolves.toMatchObject({
        service: {
          status: "PRECHECK_CONFLICT",
          publishedCount: 0,
          totalCount: 1,
          activeWorkspaceChanged: false,
          conflicts: [{ path: "sum.js", reason: "EXPECTED_ABSENT" }]
        },
        phase: "PAUSED"
      });

      const result = await new ProjectRuntime({ dataDirectory }).handle({
        id: "publish-precheck-result",
        method: "smartflow_result",
        payload: { projectId, jobId: "job-1" }
      });
      expect(result).toMatchObject({
        status: "PRECHECK_CONFLICT",
        publishPrecheck: {
          publishedCount: 0,
          totalCount: 1,
          activeWorkspaceChanged: false,
          conflicts: [{ path: "sum.js", reason: "EXPECTED_ABSENT" }]
        }
      });
      expect(applyCalls).toBe(0);
      expect(await readFile(sourcePath)).toEqual(source);
    } finally {
      await harness.cleanup();
    }
  });

  it("uses immutable Result Snapshot blobs instead of mutable worktree bytes", async () => {
    const harness = await createRuntimeHarness();
    try {
      const projectId = `project-${"2".repeat(40)}`;
      const dataDirectory = resolve(harness.dataDir, "git-source-publish");
      const store = await createLifecycleStore(harness, "READY_TO_PUBLISH", {}, {
        dataDirectory: resolve(dataDirectory, "projects", projectId),
        projectId
      });
      const ready = await store.readState();
      const workspace = ready.runs["job-1"]?.workspace;
      if (workspace === undefined) throw new Error("default publish workspace missing");
      const operations = await operationsForRun(store);
      expect(operations).toHaveLength(1);
      expect(operations[0]?.blobRef?.relativePath)
        .toMatch(/^git-object-store\/blobs\/[a-f0-9]{40,64}$/u);
      const sourcePath = resolve(harness.projectDir, "sum.js");
      const source = await readFile(sourcePath);
      const workspacePath = resolve(store.dataDirectory, workspace.relativePath, "sum.js");
      await mkdir(resolve(workspacePath, ".."), { recursive: true });
      await writeFile(workspacePath, "tampered mutable worktree bytes", "utf8");
      await rm(sourcePath);

      const published = await new PublishCoordinator(store).publish("job-1");
      if (published.service.status !== "COMMITTED") {
        throw new Error(`default publish failed: ${JSON.stringify(published.service)}`);
      }
      expect(published).toMatchObject({ service: { status: "COMMITTED" }, phase: "COMPLETED" });
      expect((await store.readState()).runs["job-1"]).toMatchObject({
        phase: "COMPLETED",
        publish: { status: "COMMITTED", adapterId: "filesystem-preflight-batch-v1" }
      });
      expect(await readFile(sourcePath)).toEqual(source);
    } finally {
      await harness.cleanup();
    }
  });

  it("publishes from the Git object store after the revision worktree is removed", async () => {
    const harness = await createRuntimeHarness();
    try {
      const store = await createLifecycleStore(harness, "READY_TO_PUBLISH");
      const ready = await store.readState();
      const run = ready.runs["job-1"];
      if (run?.workspace === undefined) throw new Error("Git source fixture missing");
      const operations = await operationsForRun(store);
      const sourcePath = resolve(harness.projectDir, "sum.js");
      const source = await readFile(sourcePath);
      await rm(resolve(store.dataDirectory, run.workspace.relativePath), {
        recursive: true,
        force: true
      });
      await rm(sourcePath);

      const result = await new PublishCoordinator(store).publish("job-1");

      expect(result).toMatchObject({ service: { status: "COMMITTED" }, phase: "COMPLETED" });
      expect(operations[0]?.newHash).toBe(createHash("sha256").update(source).digest("hex"));
      expect(await readFile(sourcePath)).toEqual(source);
    } finally {
      await harness.cleanup();
    }
  });

  it("recovers the default filesystem adapter from Git-derived operations without a worktree", async () => {
    const harness = await createRuntimeHarness();
    try {
      const store = await createLifecycleStore(harness, "PUBLISHING");
      const state = await store.readState();
      const run = state.runs["job-1"];
      if (
        run?.publish === undefined ||
        run.candidate === undefined ||
        run.workspace === undefined
      ) throw new Error("default recovery fixture missing");
      const operations = await operationsForRun(store);
      const publish = {
        ...run.publish,
        adapterId: "filesystem-preflight-batch-v1"
      };
      const updatedAt = new Date().toISOString();
      await store.writeState({
        ...state,
        stateVersion: state.stateVersion + 1,
        runs: { ...state.runs, "job-1": { ...run, publish, updatedAt } },
        updatedAt
      });
      await rm(resolve(store.dataDirectory, run.workspace.relativePath), {
        recursive: true,
        force: true
      });
      const resultRecord: PublishResult = {
        operationId: publish.operationId,
        operationsHash: publish.operationsHash,
        status: "COMMITTED",
        paths: operations.map((operation) => ({
          path: operation.path,
          status: "COMMITTED" as const,
          observedHash: operation.newHash,
          observedMode: operation.newMode
        }))
      };
      const resultDirectory = resolve(store.dataDirectory, "publish-results");
      await mkdir(resultDirectory, { recursive: true });
      await writeFile(
        resolve(resultDirectory, `${publish.operationId}.json`),
        JSON.stringify(resultRecord),
        "utf8"
      );

      const beforeRecovery = await store.readState();
      await expect(new PublishCoordinator(store).recover(
        "job-1",
        publish.operationId,
        publish.operationsHash
      )).resolves.toMatchObject({
        status: "COMMITTED",
        operationId: publish.operationId,
        result: resultRecord
      });
      const afterRecovery = await store.readState();
      expect(afterRecovery.stateVersion).toBe(beforeRecovery.stateVersion);
      expect(afterRecovery.runs["job-1"]?.publish).toEqual(publish);
    } finally {
      await harness.cleanup();
    }
  });

  it("blocks recovery when the persisted operationId is not the accepted stable identity", async () => {
    const harness = await createRuntimeHarness();
    try {
      const store = await createLifecycleStore(harness, "PUBLISHING");
      const state = await store.readState();
      const run = state.runs["job-1"];
      if (run?.publish === undefined) throw new Error("operation identity fixture missing");
      const operationId = `publish-${"f".repeat(64)}`;
      const updatedAt = new Date().toISOString();
      await store.writeState({
        ...state,
        stateVersion: state.stateVersion + 1,
        runs: {
          ...state.runs,
          "job-1": {
            ...run,
            publish: { ...run.publish, operationId },
            updatedAt
          }
        },
        updatedAt
      });

      await expect(new PublishCoordinator(store).recover(
        "job-1",
        operationId,
        run.publish.operationsHash
      )).resolves.toEqual({
        status: "PUBLISH_RECOVERY_BLOCKED",
        operationId
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns IPC cancel while apply is pending and rejects its late completion", async () => {
    const harness = await createRuntimeHarness();
    try {
      const projectId = `project-${"1".repeat(40)}`;
      const tasksSource = createTasksSource();
      const tasksPath = resolve(harness.projectDir, "tasks.md");
      await writeFile(tasksPath, tasksSource, "utf8");
      const store = await createLifecycleStore(harness, "READY_TO_PUBLISH", {
        approvedTasks: { path: tasksPath, sourceHash: hash(tasksSource) }
      }, {
        dataDirectory: resolve(harness.dataDir, "projects", projectId),
        projectId
      });
      const ready = await store.readState();
      const run = ready.runs["job-1"];
      const workspace = run?.workspace;
      if (workspace === undefined) throw new Error("publish race workspace missing");
      const sourcePath = resolve(harness.projectDir, "sum.js");
      const source = await readFile(sourcePath);
      const workspacePath = resolve(store.dataDirectory, workspace.relativePath, "sum.js");
      await mkdir(resolve(workspacePath, ".."), { recursive: true });
      await writeFile(workspacePath, source);
      await rm(sourcePath);

      const applyEntered = Promise.withResolvers<undefined>();
      const releaseApply = Promise.withResolvers<undefined>();
      let applyCalls = 0;
      const adapter: WorkspaceApplyAdapter = {
        probe: () => Promise.resolve({
          expectedOldHashCas: true, atomicBatchCas: true,
          stableOperationId: true,
          queryResult: true,
          adapterId: "publish-cancel-race-test"
        }),
        apply: async (input) => {
          applyCalls += 1;
          applyEntered.resolve(undefined);
          await releaseApply.promise;
          return {
            operationId: input.operationId,
            operationsHash: input.operationsHash,
            status: "COMMITTED",
            paths: input.operations.map((entry) => ({
              path: entry.path,
              status: "COMMITTED" as const,
              observedHash: entry.newHash,
              observedMode: entry.newMode
            }))
          };
        },
        getResult: () => Promise.resolve("UNKNOWN")
      };
      const publishing = new PublishCoordinator(store, adapter).publish("job-1");
      await applyEntered.promise;

      const beforeCancel = await store.readState();
      const cancelStartedAt = Date.now();
      const cancel = new ProjectRuntime({
        dataDirectory: harness.dataDir,
        cancel: (): Promise<void> => Promise.resolve()
      }).handle({
        id: "cancel-pending-publish",
        method: "smartflow_cancel",
        payload: {
          requestId: "cancel-pending-publish",
          projectId,
          jobId: "job-1",
          expectedRevision: 1,
          expectedStateVersion: beforeCancel.stateVersion,
          reason: "cancel while adapter apply is pending"
        }
      });
      const timeout = new Promise<never>((_settle, reject) => {
        setTimeout(() => reject(new Error("smartflow_cancel exceeded two seconds")), 2_000).unref();
      });
      await expect(Promise.race([cancel, timeout])).resolves.toMatchObject({ phase: "CANCELING" });
      expect(Date.now() - cancelStartedAt).toBeLessThan(2_000);
      expect((await store.readState()).runs["job-1"]).toMatchObject({
        phase: "CANCELING",
        publish: { status: "SUBMITTED" }
      });

      releaseApply.resolve(undefined);
      await expect(publishing).rejects.toThrow();
      expect(applyCalls).toBe(1);
      expect((await store.readState()).runs["job-1"]).toMatchObject({
        phase: "CANCELING",
        publish: { status: "SUBMITTED" }
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("revalidates the Review decision in the committed adapter handoff", async () => {
    const harness = await createRuntimeHarness();
    try {
      const tasksSource = createTasksSource();
      const tasksPath = resolve(harness.projectDir, "tasks.md");
      await writeFile(tasksPath, tasksSource, "utf8");
      const store = await createLifecycleStore(harness, "READY_TO_PUBLISH", {
        approvedTasks: { path: tasksPath, sourceHash: hash(tasksSource) }
      });
      const ready = await store.readState();
      const run = ready.runs["job-1"];
      const review = run?.review;
      const workspace = run?.workspace;
      if (review === undefined || workspace === undefined) {
        throw new Error("publish handoff fixture is incomplete");
      }
      const sourcePath = resolve(harness.projectDir, "sum.js");
      const source = await readFile(sourcePath);
      const workspacePath = resolve(store.dataDirectory, workspace.relativePath, "sum.js");
      await mkdir(resolve(workspacePath, ".."), { recursive: true });
      await writeFile(workspacePath, source);
      await rm(sourcePath);

      let probeCalls = 0;
      let applyCalls = 0;
      const adapter: WorkspaceApplyAdapter = {
        probe: async () => {
          probeCalls += 1;
          await writeFile(resolve(store.dataDirectory, review.relativePath), "{\"tampered\":true}");
          return {
            expectedOldHashCas: true, atomicBatchCas: true,
            stableOperationId: true,
            queryResult: true,
            adapterId: "publish-handoff-integrity-test"
          };
        },
        apply: () => {
          applyCalls += 1;
          return Promise.reject(new Error("apply must not run"));
        },
        getResult: () => Promise.resolve("UNKNOWN")
      };

      await expect(new PublishCoordinator(store, adapter).publish("job-1")).resolves.toMatchObject({
        service: { status: "PUBLISH_RECOVERY_BLOCKED" },
        phase: "PAUSED"
      });
      expect(probeCalls).toBe(1);
      expect(applyCalls).toBe(0);
      await expect(access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await store.readState()).runs["job-1"]).toMatchObject({
        phase: "PAUSED",
        publish: { status: "PREPARED" },
        pause: { code: "PUBLISH_RECOVERY_BLOCKED" }
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("blocks a tampered Review decision before any Publish side effect", async () => {
    const harness = await createRuntimeHarness();
    try {
      const store = await createLifecycleStore(harness, "READY_TO_PUBLISH");
      const beforeState = await store.readState();
      const review = beforeState.runs["job-1"]?.review;
      if (review === undefined) throw new Error("review decision missing");
      const activeWorkspacePath = resolve(harness.projectDir, "sum.js");
      const beforeWorkspace = await readFile(activeWorkspacePath);
      await writeFile(resolve(store.dataDirectory, review.relativePath), "{\"tampered\":true}");

      let probeCalls = 0;
      let applyCalls = 0;
      const adapter: WorkspaceApplyAdapter = {
        probe: () => {
          probeCalls += 1;
          return Promise.resolve({
            expectedOldHashCas: true, atomicBatchCas: true,
            stableOperationId: true,
            queryResult: true,
            adapterId: "publish-integrity-test"
          });
        },
        apply: () => {
          applyCalls += 1;
          return Promise.reject(new Error("apply must not run"));
        },
        getResult: () => Promise.resolve("UNKNOWN")
      };

      await expect(new PublishCoordinator(store, adapter).publish("job-1"))
        .rejects.toThrow(/PUBLISH_ARTIFACT_INTEGRITY_BLOCKED/u);

      expect(probeCalls).toBe(0);
      expect(applyCalls).toBe(0);
      expect(await readFile(activeWorkspacePath)).toEqual(beforeWorkspace);
      expect((await store.readState()).runs["job-1"]?.publish).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("commits manual confirmation only after every target exactly matches", async () => {
    const harness = await createRuntimeHarness();
    try {
      const store = await createLifecycleStore(harness, "READY_TO_PUBLISH");
      const sourcePath = resolve(harness.projectDir, "sum.js");
      const reviewedSource = await readFile(sourcePath);

      await expect(new PublishCoordinator(store).publish("job-1")).resolves.toMatchObject({
        service: { status: "PRECHECK_CONFLICT" },
        phase: "PAUSED"
      });
      await writeFile(sourcePath, "different external merge", "utf8");
      await requestManualConfirmation(store, "PUBLISH_PRECHECK_CONFLICT");

      await expect(new PublishCoordinator(store).publish("job-1")).resolves.toMatchObject({
        service: {
          status: "MANUAL_PUBLISH_REQUIRED",
          reason: "PUBLISH_TARGET_MISMATCH"
        },
        phase: "PAUSED"
      });
      expect((await store.readState()).runs["job-1"]).toMatchObject({
        phase: "PAUSED",
        pause: { code: "MANUAL_PUBLISH_TARGET_MISMATCH" },
        recovery: { manualPublishConfirmation: { status: "MISMATCH" } }
      });

      await writeFile(sourcePath, reviewedSource);
      const exactOperations = await operationsForRun(store);
      expect(await observeTargetState(harness.projectDir, exactOperations)).toEqual({
        matches: true,
        conflicts: []
      });
      await requestManualConfirmation(store, "PUBLISH_PRECHECK_CONFLICT");
      expect(await readFile(sourcePath)).toEqual(reviewedSource);
      expect(await observeTargetState(harness.projectDir, exactOperations)).toEqual({
        matches: true,
        conflicts: []
      });
      const committed = await new PublishCoordinator(store).publish("job-1");
      if (committed.service.status !== "COMMITTED") {
        throw new Error(`manual confirmation failed: ${JSON.stringify(committed.service)}`);
      }
      expect(committed).toMatchObject({
        service: { status: "COMMITTED" },
        phase: "COMPLETED"
      });
      expect((await store.readState()).runs["job-1"]).toMatchObject({
        phase: "COMPLETED",
        publish: {
          adapterId: "manual-confirmation-v1",
          status: "COMMITTED"
        }
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("does not allow manual confirmation to bypass recovery-blocked attempts", async () => {
    const harness = await createRuntimeHarness();
    try {
      const projectId = `project-${"4".repeat(40)}`;
      const dataDirectory = resolve(harness.dataDir, "manual-recovery-block");
      const store = await createLifecycleStore(harness, "PUBLISHING", {}, {
        dataDirectory: resolve(dataDirectory, "projects", projectId),
        projectId
      });
      const state = await store.readState();
      const run = state.runs["job-1"];
      if (run?.publish === undefined) throw new Error("recovery block fixture missing");
      const updatedAt = new Date().toISOString();
      await store.writeState({
        ...state,
        stateVersion: state.stateVersion + 1,
        runs: {
          ...state.runs,
          "job-1": {
            ...run,
            phase: "PAUSED",
            pause: {
              code: "PUBLISH_RECOVERY_BLOCKED",
              resumeActions: ["confirm_manual_publish", "inspect_recovery", "cancel"]
            },
            updatedAt
          }
        },
        updatedAt
      });
      const before = await store.readState();

      await expect(new ProjectRuntime({ dataDirectory }).handle({
        id: "manual-recovery-bypass",
        method: "smartflow_resume",
        payload: {
          requestId: "manual-recovery-bypass",
          projectId,
          jobId: "job-1",
          resumeAction: "confirm_manual_publish",
          expectedRevision: 1,
          expectedStateVersion: before.stateVersion
        }
      })).rejects.toMatchObject({ code: "RESUME_CODE_ACTION_MISMATCH" });
      expect(await store.readState()).toEqual(before);
    } finally {
      await harness.cleanup();
    }
  });

  it("recovers adapter success after a Daemon crash by querying the same operationId", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-publish-recovery-"));
    await writeFile(resolve(root, "a.txt"), "old", { mode: 0o600 });
    const apply = operation();
    const results = new Map<string, PublishResult>();
    const platformAdapter: WorkspaceApplyAdapter = {
      probe: () => Promise.resolve({ expectedOldHashCas: true, atomicBatchCas: true, stableOperationId: true, queryResult: true, adapterId: "publish-cas-test" }),
      apply: (input) => {
        const result: PublishResult = {
          operationId: input.operationId,
          operationsHash: input.operationsHash,
          status: "COMMITTED",
          paths: [{ path: "a.txt", status: "COMMITTED", observedHash: hash("new"), observedMode: 0o600 }]
        };
        results.set(input.operationId, result);
        return Promise.resolve(result);
      },
      getResult: (operationId) => Promise.resolve(results.get(operationId) ?? "UNKNOWN")
    };
    const adapter = new CountingAdapter(platformAdapter);
    const store = new Store();
    const service = new PublishService(store);
    await expect(
      service.publish(root, bindings, [apply], adapter, () => Promise.reject(new Error("DAEMON_CRASH")))
    ).rejects.toThrow(/DAEMON_CRASH/u);
    const operationId = stableOperationId({
      ...bindings,
      operationsHash: operationsHash([apply])
    });
    expect(store.attempts.get(operationId)?.status).toBe("SUBMITTED");
    const recovered = await service.recover(operationId, [apply], adapter);
    expect(recovered.status).toBe("COMMITTED");
    expect(adapter.applyCalls).toBe(1);
    expect(adapter.getResultCalls).toBe(1);
    await expect(service.publish(root, bindings, [apply], adapter)).resolves.toEqual(recovered);
    expect(store.completeCalls).toBe(1);
    expect(adapter.applyCalls).toBe(1);
    expect(adapter.getResultCalls).toBe(1);
  });

  it("blocks UNKNOWN recovery without calling apply or generating a new ID", async () => {
    const apply = operation();
    const hashValue = operationsHash([apply]);
    const operationId = stableOperationId({ ...bindings, operationsHash: hashValue });
    const store = new Store();
    await store.prepare({ operationId, operationsHash: hashValue, adapterId: "publish-cas-test", revision: 1, status: "SUBMITTED" });
    let applyCalls = 0;
    const adapter: WorkspaceApplyAdapter = {
      probe: () => Promise.resolve({ expectedOldHashCas: true, atomicBatchCas: true, stableOperationId: true, queryResult: true, adapterId: "publish-cas-test" }),
      apply: () => {
        applyCalls += 1;
        return Promise.reject(new Error("must not apply"));
      },
      getResult: () => Promise.resolve("UNKNOWN")
    };
    expect(await new PublishService(store).recover(operationId, [apply], adapter)).toEqual({
      status: "PUBLISH_RECOVERY_BLOCKED",
      operationId
    });
    expect(applyCalls).toBe(0);
  });

  it("normalizes an adapter apply exception into SUBMITTED recovery", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-publish-apply-error-"));
    await writeFile(resolve(root, "a.txt"), "old", { mode: 0o600 });
    const apply = operation();
    const store = new Store();
    let applyCalls = 0;
    let queryCalls = 0;
    const adapter: WorkspaceApplyAdapter = {
      probe: () => Promise.resolve({
        expectedOldHashCas: true, atomicBatchCas: true,
        stableOperationId: true,
        queryResult: true,
        adapterId: "publish-apply-error"
      }),
      apply: () => {
        applyCalls += 1;
        return Promise.reject(new Error("transport closed after submission"));
      },
      getResult: () => {
        queryCalls += 1;
        return Promise.resolve("UNKNOWN");
      }
    };
    const service = new PublishService(store);
    const first = await service.publish(root, bindings, [apply], adapter);
    expect(first).toMatchObject({ status: "PUBLISH_RECOVERY_BLOCKED" });
    expect([...store.attempts.values()]).toEqual([
      expect.objectContaining({ status: "SUBMITTED", adapterId: "publish-apply-error" })
    ]);

    const retry = await service.publish(root, bindings, [apply], adapter);
    expect(retry).toEqual(first);
    expect(applyCalls).toBe(1);
    expect(queryCalls).toBe(1);
    expect(store.completeCalls).toBe(0);
  });

  it("performs the final boundary guard before any adapter apply", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-publish-boundary-"));
    await writeFile(resolve(root, "a.txt"), "old", { mode: 0o600 });
    let applyCalls = 0;
    const adapter: WorkspaceApplyAdapter = {
      probe: () => Promise.resolve({
        expectedOldHashCas: true, atomicBatchCas: true,
        stableOperationId: true,
        queryResult: true,
        adapterId: "publish-boundary-test"
      }),
      apply: () => {
        applyCalls += 1;
        return Promise.reject(new Error("apply must not run"));
      },
      getResult: () => Promise.resolve("UNKNOWN")
    };
    const store = new Store();
    await expect(new PublishService(store).publish(
      root,
      bindings,
      [operation()],
      adapter,
      undefined,
      () => Promise.reject(new Error("APPROVED_SOURCE_DRIFT"))
    )).rejects.toThrow(/APPROVED_SOURCE_DRIFT/u);
    expect(applyCalls).toBe(0);
    expect([...store.attempts.values()][0]).toMatchObject({
      adapterId: "publish-boundary-test",
      status: "PREPARED"
    });
  });

  it("blocks recovery when the adapter identity changes", async () => {
    const apply = operation();
    const operationsDigest = operationsHash([apply]);
    const operationId = stableOperationId({ ...bindings, operationsHash: operationsDigest });
    const store = new Store();
    await store.prepare({
      operationId,
      operationsHash: operationsDigest,
      adapterId: "original-adapter",
      revision: 1,
      status: "SUBMITTED"
    });
    let queryCalls = 0;
    const changedAdapter: WorkspaceApplyAdapter = {
      probe: () => Promise.resolve({
        expectedOldHashCas: true, atomicBatchCas: true,
        stableOperationId: true,
        queryResult: true,
        adapterId: "replacement-adapter"
      }),
      apply: () => Promise.reject(new Error("must not apply")),
      getResult: () => {
        queryCalls += 1;
        return Promise.resolve("UNKNOWN");
      }
    };
    await expect(new PublishService(store).recover(operationId, [apply], changedAdapter)).resolves.toEqual({
      status: "PUBLISH_RECOVERY_BLOCKED",
      operationId
    });
    expect(queryCalls).toBe(0);
  });
});
