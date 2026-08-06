import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { operationsHash, preflightOperations, type ApplyOperation } from "./preflight.js";
import { FilesystemWorkspaceApplyAdapter } from "./workspace-apply-adapter.js";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function operation(oldContent: string, newContent: string): ApplyOperation {
  return {
    path: "a.txt",
    type: "MODIFY",
    expectedOldKind: "FILE",
    expectedOldHash: hash(oldContent),
    expectedOldMode: 0o600,
    newHash: hash(newContent),
    newMode: 0o600,
    blobRef: { relativePath: "blobs/a", sha256: hash(newContent), size: newContent.length }
  };
}

describe("publish preflight and filesystem adapter", () => {
  it("writes add, modify, and delete operations to the active workspace", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-publish-"));
    await writeFile(resolve(root, "a.txt"), "old", { mode: 0o600 });
    await writeFile(resolve(root, "delete.txt"), "remove", { mode: 0o600 });
    const modify = operation("old", "new");
    const add: ApplyOperation = {
      path: "nested/new.txt",
      type: "ADD",
      expectedOldKind: "ABSENT",
      expectedOldHash: null,
      expectedOldMode: null,
      newHash: hash("added"),
      newMode: 0o644,
      blobRef: { relativePath: "blobs/add", sha256: hash("added"), size: 5 }
    };
    const remove: ApplyOperation = {
      path: "delete.txt",
      type: "DELETE",
      expectedOldKind: "FILE",
      expectedOldHash: hash("remove"),
      expectedOldMode: 0o600,
      newHash: null,
      newMode: null,
      blobRef: null
    };
    const operations = [modify, add, remove];
    expect(await preflightOperations(root, operations)).toEqual([]);
    const resultDirectory = resolve(root, ".publish-results");
    const adapter = new FilesystemWorkspaceApplyAdapter(root, {
      read: (ref): Promise<Uint8Array> => Promise.resolve(
        Buffer.from(ref.relativePath === "blobs/add" ? "added" : "new", "utf8")
      )
    }, resultDirectory);
    expect(await adapter.probe()).toMatchObject({
      expectedOldHashCas: true,
      atomicBatchCas: false,
      preflightBatchWrite: true,
      queryResult: true
    });
    const operationId = `publish-${"a".repeat(64)}`;
    const input = { operationId, operationsHash: operationsHash(operations), operations };
    await expect(adapter.apply(input)).resolves.toMatchObject({ status: "COMMITTED" });
    expect(await readFile(resolve(root, "a.txt"), "utf8")).toBe("new");
    expect(await readFile(resolve(root, "nested/new.txt"), "utf8")).toBe("added");
    await expect(access(resolve(root, "delete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new FilesystemWorkspaceApplyAdapter(
      root,
      { read: (): Promise<Uint8Array> => Promise.reject(new Error("recovery must not read blobs")) },
      resultDirectory
    ).getResult(operationId)).resolves.toMatchObject({ status: "COMMITTED" });
  });

  it("writes no candidate paths when any path conflicts", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-publish-conflict-"));
    await writeFile(resolve(root, "a.txt"), "user-change", { mode: 0o600 });
    await writeFile(resolve(root, "b.txt"), "old-b", { mode: 0o600 });
    const operations = [
      operation("old", "new"),
      {
        ...operation("old-b", "new-b"),
        path: "b.txt",
        blobRef: { relativePath: "blobs/b", sha256: hash("new-b"), size: 5 }
      }
    ];
    const adapter = new FilesystemWorkspaceApplyAdapter(root, {
      read: (): Promise<Uint8Array> => Promise.reject(new Error("conflict must not read blobs"))
    }, resolve(root, ".publish-results"));
    await expect(adapter.apply({
      operationId: `publish-${"b".repeat(64)}`,
      operationsHash: operationsHash(operations),
      operations
    })).resolves.toMatchObject({
      status: "CONFLICT",
      paths: [
        { path: "a.txt", status: "CONFLICT" },
        { path: "b.txt", status: "UNRESOLVED" }
      ]
    });
    expect(await readFile(resolve(root, "a.txt"), "utf8")).toBe("user-change");
    expect(await readFile(resolve(root, "b.txt"), "utf8")).toBe("old-b");
  });

  it("detects drift before any platform apply", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-publish-drift-"));
    await writeFile(resolve(root, "a.txt"), "changed", { mode: 0o600 });
    const apply = operation("old", "new");
    expect(await preflightOperations(root, [apply])).toMatchObject([
      { path: "a.txt", reason: "HASH_MISMATCH" }
    ]);
  });
});
