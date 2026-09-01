import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PublishService, type ApplyOperation, type WorkspaceApplyAdapter } from "@smartflow/publish";

describe("publish path and Git safety", () => {
  it("rejects parent symlink escape with zero adapter and Git writes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-publish-security-"));
    const outside = resolve(root, "outside");
    const project = resolve(root, "project");
    await Promise.all([mkdir(outside), mkdir(project)]);
    await mkdir(resolve(project, ".git"));
    await writeFile(resolve(project, ".git", "index"), "index-before");
    await symlink(outside, resolve(project, "escape"));
    const content = Buffer.from("malicious");
    const digest = createHash("sha256").update(content).digest("hex");
    const operation: ApplyOperation = {
      path: "escape/out.txt",
      type: "ADD",
      expectedOldKind: "ABSENT",
      expectedOldHash: null,
      expectedOldMode: null,
      newHash: digest,
      newMode: 0o600,
      blobRef: { relativePath: "blob", sha256: digest, size: content.length }
    };
    let calls = 0;
    const adapter: WorkspaceApplyAdapter = {
      probe: () => Promise.resolve({ expectedOldHashCas: true, atomicBatchCas: true, stableOperationId: true, queryResult: true, adapterId: "security-cas-test" }),
      apply: () => { calls += 1; return Promise.reject(new Error("must not apply")); },
      getResult: () => Promise.resolve("UNKNOWN")
    };
    const store = {
      get: (): Promise<undefined> => Promise.resolve(undefined),
      prepare: (): Promise<void> => Promise.resolve(),
      beginRecovery: (): Promise<void> => Promise.resolve(),
      markSubmittedAndApply: (): Promise<never> => Promise.reject(new Error("must not submit")),
      complete: (): Promise<void> => Promise.resolve()
    };
    const result = await new PublishService(store).publish(
      project,
      {
        projectId: "project-1",
        jobId: "job-1",
        candidateHash: "a".repeat(64),
        reviewHash: "b".repeat(64)
      },
      [operation],
      adapter
    );
    expect(result.status).toBe("PRECHECK_CONFLICT");
    expect(calls).toBe(0);
    expect(await readFile(resolve(project, ".git", "index"), "utf8")).toBe("index-before");
  });

  it("preserves concurrent user edits across an atomic CAS conflict", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-publish-cas-race-"));
    const project = resolve(root, "project");
    await mkdir(project);
    await writeFile(resolve(project, "modify.txt"), "old-modify", { mode: 0o600 });
    await writeFile(resolve(project, "delete.txt"), "old-delete", { mode: 0o600 });
    const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
    const operations: ApplyOperation[] = [
      {
        path: "modify.txt",
        type: "MODIFY",
        expectedOldKind: "FILE",
        expectedOldHash: digest("old-modify"),
        expectedOldMode: 0o600,
        newHash: digest("new-modify"),
        newMode: 0o600,
        blobRef: { relativePath: "blob-modify", sha256: digest("new-modify"), size: 10 }
      },
      {
        path: "delete.txt",
        type: "DELETE",
        expectedOldKind: "FILE",
        expectedOldHash: digest("old-delete"),
        expectedOldMode: 0o600,
        newHash: null,
        newMode: null,
        blobRef: null
      }
    ];
    let applyCalls = 0;
    const adapter: WorkspaceApplyAdapter = {
      probe: async () => {
        await writeFile(resolve(project, "modify.txt"), "user-modify", { mode: 0o640 });
        await chmod(resolve(project, "modify.txt"), 0o640);
        await writeFile(resolve(project, "delete.txt"), "user-delete", { mode: 0o600 });
        return { expectedOldHashCas: true, atomicBatchCas: true, stableOperationId: true, queryResult: true, adapterId: "security-cas-test" };
      },
      apply: (input) => {
        applyCalls += 1;
        return Promise.resolve({
          operationId: input.operationId,
          operationsHash: input.operationsHash,
          status: "CONFLICT",
          paths: input.operations.map((operation) => ({
            path: operation.path,
            status: "CONFLICT" as const,
            observedHash: null,
            observedMode: null
          }))
        });
      },
      getResult: () => Promise.resolve("UNKNOWN")
    };
    const store = {
      get: (): Promise<undefined> => Promise.resolve(undefined),
      prepare: (): Promise<void> => Promise.resolve(),
      beginRecovery: (): Promise<void> => Promise.resolve(),
      markSubmittedAndApply: (): Promise<never> => Promise.reject(new Error("must not submit")),
      complete: (): Promise<void> => Promise.resolve()
    };
    const result = await new PublishService(store).publish(
      project,
      {
        projectId: "project-1",
        jobId: "job-1",
        candidateHash: "a".repeat(64),
        reviewHash: "b".repeat(64)
      },
      operations,
      adapter
    );
    expect(result).toMatchObject({
      status: "PRECHECK_CONFLICT",
      publishedCount: 0,
      totalCount: 2,
      activeWorkspaceChanged: false
    });
    expect(applyCalls).toBe(0);
    expect(await readFile(resolve(project, "modify.txt"), "utf8")).toBe("user-modify");
    expect((await stat(resolve(project, "modify.txt"))).mode & 0o777).toBe(0o640);
    expect(await readFile(resolve(project, "delete.txt"), "utf8")).toBe("user-delete");
  });

  it("never invokes an adapter that does not advertise true atomic CAS", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-publish-no-cas-"));
    await writeFile(resolve(root, "a.txt"), "old", { mode: 0o600 });
    const content = "new";
    const digest = createHash("sha256").update(content).digest("hex");
    let applyCalls = 0;
    const adapter: WorkspaceApplyAdapter = {
      probe: () => Promise.resolve({
        expectedOldHashCas: false, atomicBatchCas: false,
        stableOperationId: true,
        queryResult: true
      }),
      apply: () => {
        applyCalls += 1;
        return Promise.reject(new Error("must not apply"));
      },
      getResult: () => Promise.resolve("UNKNOWN")
    };
    const result = await new PublishService({
      get: (): Promise<undefined> => Promise.resolve(undefined),
      prepare: (): Promise<void> => Promise.resolve(),
      beginRecovery: (): Promise<void> => Promise.resolve(),
      markSubmittedAndApply: (): Promise<never> => Promise.reject(new Error("must not submit")),
      complete: (): Promise<void> => Promise.resolve()
    }).publish(
      root,
      {
        projectId: "project-1",
        jobId: "job-1",
        candidateHash: "a".repeat(64),
        reviewHash: "b".repeat(64)
      },
      [{
        path: "a.txt",
        type: "MODIFY",
        expectedOldKind: "FILE",
        expectedOldHash: createHash("sha256").update("old").digest("hex"),
        expectedOldMode: 0o600,
        newHash: digest,
        newMode: 0o600,
        blobRef: { relativePath: "blob", sha256: digest, size: content.length }
      }],
      adapter
    );
    expect(result).toEqual({
      status: "MANUAL_PUBLISH_REQUIRED",
      reason: "PUBLISH_ATOMIC_CAS_UNAVAILABLE"
    });
    expect(applyCalls).toBe(0);
    expect(await readFile(resolve(root, "a.txt"), "utf8")).toBe("old");
  });
});
