import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import {
  captureGitSnapshot,
  initializeGitObjectStore,
  materializeGitSnapshot,
  probeGitRepository
} from "@smartflow/workspace";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("rejects external symlinks and cross-Run Git output paths", async () => {
  const project = await mkdtemp(resolve(tmpdir(), "smartflow-git-security-project-"));
  const data = await mkdtemp(resolve(tmpdir(), "smartflow-git-security-data-"));
  const otherRun = await mkdtemp(resolve(tmpdir(), "smartflow-git-security-other-"));
  roots.push(project, data, otherRun);
  await execute("git", ["init", "--quiet", project]);
  await writeFile(resolve(project, "safe.txt"), "safe", "utf8");
  await symlink(resolve(otherRun, "secret.txt"), resolve(project, "escape"));
  const capabilities = await probeGitRepository(project);
  if (capabilities.status !== "READY" || capabilities.repositoryId === undefined) {
    throw new Error("Git fixture unexpectedly paused");
  }
  const runDirectory = resolve(data, "runs/job-1");
  const objectStore = await initializeGitObjectStore(runDirectory);
  await expect(captureGitSnapshot({
    projectRoot: project,
    dataDirectory: runDirectory,
    runGitDirectory: objectStore.gitDirectory,
    indexPath: resolve(runDirectory, "revision-1/baseline.index"),
    repositoryId: capabilities.repositoryId,
    snapshotKind: "RUN_BASELINE",
    revision: 1,
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  })).rejects.toMatchObject({ code: "EXTERNAL_SYMLINK" });

  await rm(resolve(project, "escape"));
  const snapshot = await captureGitSnapshot({
    projectRoot: project,
    dataDirectory: runDirectory,
    runGitDirectory: objectStore.gitDirectory,
    indexPath: resolve(runDirectory, "revision-1/baseline.index"),
    repositoryId: capabilities.repositoryId,
    snapshotKind: "RUN_BASELINE",
    revision: 1,
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  });
  await expect(materializeGitSnapshot({
    snapshot,
    runGitDirectory: objectStore.gitDirectory,
    dataDirectory: runDirectory,
    destination: resolve(otherRun, "workspace")
  })).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  await expect(captureGitSnapshot({
    projectRoot: project,
    dataDirectory: runDirectory,
    runGitDirectory: objectStore.gitDirectory,
    indexPath: resolve(otherRun, "foreign.index"),
    repositoryId: capabilities.repositoryId,
    snapshotKind: "RUN_BASELINE",
    revision: 1,
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  })).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
});
