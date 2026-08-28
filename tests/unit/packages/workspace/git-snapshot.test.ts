import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { probeGitRepository } from "../../../../packages/workspace/src/git-capability.js";
import { initializeGitObjectStore } from "../../../../packages/workspace/src/git-object-store.js";
import { captureGitSnapshot } from "../../../../packages/workspace/src/git-snapshot.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

it("captures tracked dirty and allowed untracked files in an isolated Run object store", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "smartflow-git-snapshot-"));
  const data = await mkdtemp(resolve(tmpdir(), "smartflow-git-data-"));
  roots.push(root, data);
  await execute("git", ["init", "--quiet", root]);
  await writeFile(resolve(root, ".gitignore"), "ignored.txt\n", "utf8");
  await writeFile(resolve(root, "tracked.txt"), "before", "utf8");
  await execute("git", ["-C", root, "add", ".gitignore", "tracked.txt"]);
  await writeFile(resolve(root, "tracked.txt"), "dirty", "utf8");
  await writeFile(resolve(root, "untracked.txt"), "new", "utf8");
  await writeFile(resolve(root, "ignored.txt"), "ignored", "utf8");
  await writeFile(resolve(root, ".env"), "secret", "utf8");
  await writeFile(resolve(root, "script.sh"), "#!/bin/sh\n", "utf8");
  await chmod(resolve(root, "script.sh"), 0o755);
  await symlink("tracked.txt", resolve(root, "tracked-link"));

  const capabilities = await probeGitRepository(root);
  if (capabilities.status !== "READY" || capabilities.repositoryId === undefined) {
    throw new Error(`capability fixture paused: ${capabilities.pause?.code ?? "unknown"}`);
  }
  const indexPath = resolve(root, ".git", "index");
  const indexBefore = sha256(await readFile(indexPath));
  const objectStore = await initializeGitObjectStore(resolve(data, "run-1"));
  const snapshot = await captureGitSnapshot({
    projectRoot: root,
    dataDirectory: resolve(data, "run-1"),
    runGitDirectory: objectStore.gitDirectory,
    indexPath: resolve(data, "run-1", "current.index"),
    repositoryId: capabilities.repositoryId,
    snapshotKind: "RUN_BASELINE",
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  });

  expect(snapshot.entries.map((entry) => entry.path)).toEqual([
    ".gitignore", "script.sh", "tracked-link", "tracked.txt", "untracked.txt"
  ]);
  expect(snapshot.entries.find((entry) => entry.path === "tracked.txt")?.sha256)
    .toBe(sha256(Buffer.from("dirty")));
  expect(snapshot.entries.find((entry) => entry.path === "script.sh")?.mode).toBe("100755");
  expect(snapshot.entries.find((entry) => entry.path === "tracked-link")?.mode).toBe("120000");
  expect(snapshot.treeId).toMatch(/^[a-f0-9]{40,64}$/u);
  expect(snapshot.snapshotHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(sha256(await readFile(indexPath))).toBe(indexBefore);
  await expect(readFile(resolve(objectStore.objectDirectory, "info", "packs"))).rejects.toBeDefined();
});
