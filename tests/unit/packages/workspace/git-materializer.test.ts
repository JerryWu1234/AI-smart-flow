import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { probeGitRepository } from "../../../../packages/workspace/src/git-capability.js";
import { materializeGitSnapshot } from "../../../../packages/workspace/src/git-materializer.js";
import { initializeGitObjectStore } from "../../../../packages/workspace/src/git-object-store.js";
import { captureGitSnapshot } from "../../../../packages/workspace/src/git-snapshot.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("materializes a Git tree as a normal workspace below the Run Data Dir", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "smartflow-materialize-source-"));
  const data = await mkdtemp(resolve(tmpdir(), "smartflow-materialize-data-"));
  roots.push(root, data);
  await execute("git", ["init", "--quiet", root]);
  await writeFile(resolve(root, "file.txt"), "content", "utf8");
  await writeFile(resolve(root, "run.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(resolve(root, "run.sh"), 0o755);
  await symlink("file.txt", resolve(root, "file-link"));
  await execute("git", ["-C", root, "add", "file.txt", "run.sh", "file-link"]);
  const capabilities = await probeGitRepository(root);
  if (capabilities.status !== "READY" || capabilities.repositoryId === undefined) {
    throw new Error("repository capability fixture paused");
  }
  const runDirectory = resolve(data, "run-1");
  const store = await initializeGitObjectStore(runDirectory);
  const snapshot = await captureGitSnapshot({
    projectRoot: root,
    dataDirectory: runDirectory,
    runGitDirectory: store.gitDirectory,
    indexPath: resolve(runDirectory, "current.index"),
    repositoryId: capabilities.repositoryId,
    snapshotKind: "RUN_BASELINE",
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  });
  const destination = resolve(runDirectory, "workspace");
  await materializeGitSnapshot({
    snapshot,
    runGitDirectory: store.gitDirectory,
    dataDirectory: runDirectory,
    destination
  });

  expect(await readFile(resolve(destination, "file.txt"), "utf8")).toBe("content");
  expect(await readlink(resolve(destination, "file-link"))).toBe("file.txt");
  expect((await lstat(resolve(destination, "run.sh"))).mode & 0o111).not.toBe(0);
  expect((await lstat(destination)).isDirectory()).toBe(true);
});
