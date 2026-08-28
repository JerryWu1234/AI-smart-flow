import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PublishService,
  type ApplyOperation,
  type PublishAttemptRecord,
  type PublishAttemptStore,
  type PublishResult,
  type WorkspaceApplyAdapter
} from "@smartflow/publish";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function addOperation(): ApplyOperation {
  return {
    path: "new.txt",
    type: "ADD",
    expectedOldKind: "ABSENT",
    expectedOldHash: null,
    expectedOldMode: null,
    newHash: hash("new"),
    newMode: 0o600,
    blobRef: { relativePath: "blobs/new", sha256: hash("new"), size: 3 }
  };
}

class Store implements PublishAttemptStore {
  public value: PublishAttemptRecord | undefined;
  public get(): Promise<PublishAttemptRecord | undefined> { return Promise.resolve(this.value); }
  public prepare(value: PublishAttemptRecord): Promise<void> { this.value = value; return Promise.resolve(); }
  public beginRecovery(value: PublishAttemptRecord): Promise<void> { this.value = value; return Promise.resolve(); }
  public markSubmitted(): Promise<void> {
    if (this.value !== undefined) this.value = { ...this.value, status: "SUBMITTED" };
    return Promise.resolve();
  }
  public complete(_id: string, status: PublishAttemptRecord["status"], result: PublishResult): Promise<void> {
    if (this.value !== undefined) this.value = { ...this.value, status, result };
    return Promise.resolve();
  }
}

class LeaseStore implements PublishAttemptStore {
  private readonly attempts = new Map<string, PublishAttemptRecord>();
  private lease: string | undefined;

  public acquireLease(operationId: string): Promise<boolean> {
    if (this.lease !== undefined && this.lease !== operationId) return Promise.resolve(false);
    this.lease = operationId;
    return Promise.resolve(true);
  }
  public releaseLease(operationId: string): Promise<void> {
    if (this.lease === operationId) this.lease = undefined;
    return Promise.resolve();
  }
  public get(operationId: string): Promise<PublishAttemptRecord | undefined> {
    return Promise.resolve(this.attempts.get(operationId));
  }
  public prepare(value: PublishAttemptRecord): Promise<void> {
    this.attempts.set(value.operationId, value);
    return Promise.resolve();
  }
  public beginRecovery(value: PublishAttemptRecord): Promise<void> {
    this.attempts.set(value.operationId, value);
    return Promise.resolve();
  }
  public markSubmitted(operationId: string): Promise<void> {
    const value = this.attempts.get(operationId);
    if (value !== undefined) this.attempts.set(operationId, { ...value, status: "SUBMITTED" });
    return Promise.resolve();
  }
  public complete(
    operationId: string,
    status: PublishAttemptRecord["status"],
    result: PublishResult
  ): Promise<void> {
    const value = this.attempts.get(operationId);
    if (value !== undefined) this.attempts.set(operationId, { ...value, status, result });
    if (status === "COMMITTED" || status === "CONFLICT") this.lease = undefined;
    return Promise.resolve();
  }
}

const bindings = {
  projectId: "project-1",
  jobId: "job-1",
  candidateHash: "a".repeat(64),
  reviewHash: "b".repeat(64)
};

describe("publish safety outcomes", () => {
  it("serializes project publish, then conflicts overlapping paths before apply", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-publish-lease-"));
    const store = new LeaseStore();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((settle) => { markFirstStarted = settle; });
    const firstGate = new Promise<void>((settle) => { releaseFirst = settle; });
    let applyCalls = 0;
    const adapter: WorkspaceApplyAdapter = {
      probe: () => Promise.resolve({
        expectedOldHashCas: true,
        atomicBatchCas: true,
        stableOperationId: true,
        queryResult: true,
        adapterId: "lease-cas-test"
      }),
      apply: async (input) => {
        applyCalls += 1;
        if (applyCalls === 1) {
          markFirstStarted();
          await firstGate;
        }
        const operation = input.operations[0];
        if (operation === undefined) throw new Error("test operation missing");
        await writeFile(resolve(root, operation.path), "new", { mode: operation.newMode ?? 0o600 });
        return {
          operationId: input.operationId,
          operationsHash: input.operationsHash,
          status: "COMMITTED",
          paths: [{
            path: operation.path,
            status: "COMMITTED",
            observedHash: operation.newHash,
            observedMode: operation.newMode
          }]
        };
      },
      getResult: () => Promise.resolve("UNKNOWN")
    };
    const first = new PublishService(store).publish(root, bindings, [addOperation()], adapter);
    await firstStarted;
    const secondBindings = { ...bindings, jobId: "job-2" };
    await expect(new PublishService(store).publish(root, secondBindings, [addOperation()], adapter))
      .resolves.toEqual({ status: "PUBLISH_BUSY" });
    expect(applyCalls).toBe(1);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: "COMMITTED" });
    await expect(new PublishService(store).publish(root, secondBindings, [addOperation()], adapter))
      .resolves.toMatchObject({
        status: "PRECHECK_CONFLICT",
        publishedCount: 0,
        totalCount: 1,
        activeWorkspaceChanged: false
      });
    expect(applyCalls).toBe(1);
    const disjointOperation = { ...addOperation(), path: "other.txt" };
    await expect(new PublishService(store).publish(
      root,
      { ...bindings, jobId: "job-3" },
      [disjointOperation],
      adapter
    )).resolves.toMatchObject({ status: "COMMITTED" });
    expect(applyCalls).toBe(2);
  });

  it("distinguishes committed, preflight conflict, adapter unavailable, and partial results", async () => {
    const committedRoot = await mkdtemp(resolve(tmpdir(), "smartflow-commit-"));
    const committedAdapter: WorkspaceApplyAdapter = {
      probe: () => Promise.resolve({ expectedOldHashCas: true, atomicBatchCas: true, stableOperationId: true, queryResult: true, adapterId: "e2e-cas-test" }),
      apply: (input) => Promise.resolve({
        operationId: input.operationId,
        operationsHash: input.operationsHash,
        status: "COMMITTED",
        paths: [{ path: "new.txt", status: "COMMITTED", observedHash: hash("new"), observedMode: 0o600 }]
      }),
      getResult: () => Promise.resolve("UNKNOWN")
    };
    const committed = await new PublishService(new Store()).publish(
      committedRoot,
      bindings,
      [addOperation()],
      committedAdapter
    );
    expect(committed.status).toBe("COMMITTED");

    const conflictRoot = await mkdtemp(resolve(tmpdir(), "smartflow-conflict-"));
    await writeFile(resolve(conflictRoot, "new.txt"), "user change");
    let conflictApplyCalls = 0;
    const conflictAdapter: WorkspaceApplyAdapter = {
      probe: () => Promise.resolve({ expectedOldHashCas: true, atomicBatchCas: true, stableOperationId: true, queryResult: true, adapterId: "e2e-cas-test" }),
      apply: () => { conflictApplyCalls += 1; return Promise.reject(new Error("must not apply")); },
      getResult: () => Promise.resolve("UNKNOWN")
    };
    expect(
      (await new PublishService(new Store()).publish(conflictRoot, bindings, [addOperation()], conflictAdapter)).status
    ).toBe("PRECHECK_CONFLICT");
    expect(conflictApplyCalls).toBe(0);
    expect(await readFile(resolve(conflictRoot, "new.txt"), "utf8")).toBe("user change");

    const manualRoot = await mkdtemp(resolve(tmpdir(), "smartflow-manual-publish-"));
    expect(
      await new PublishService(new Store()).publish(manualRoot, bindings, [addOperation()], undefined)
    ).toEqual({
      status: "MANUAL_PUBLISH_REQUIRED",
      reason: "PUBLISH_ADAPTER_UNAVAILABLE"
    });
    await expect(readFile(resolve(manualRoot, "new.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const partialRoot = await mkdtemp(resolve(tmpdir(), "smartflow-partial-"));
    const partialAdapter: WorkspaceApplyAdapter = {
      probe: () => Promise.resolve({ expectedOldHashCas: true, atomicBatchCas: true, stableOperationId: true, queryResult: true, adapterId: "e2e-cas-test" }),
      apply: (input) => Promise.resolve({
        operationId: input.operationId,
        operationsHash: input.operationsHash,
        status: "PARTIAL",
        paths: [{ path: "new.txt", status: "UNRESOLVED", observedHash: null, observedMode: null }]
      }),
      getResult: () => Promise.resolve("UNKNOWN")
    };
    expect(
      (await new PublishService(new Store()).publish(partialRoot, bindings, [addOperation()], partialAdapter)).status
    ).toBe("PUBLISH_RECOVERY_BLOCKED");
  });
});
