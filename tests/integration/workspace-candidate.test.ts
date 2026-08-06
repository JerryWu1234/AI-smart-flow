import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  buildGitCandidate,
  captureGitSnapshot,
  initializeGitObjectStore,
  materializeGitSnapshot,
  probeGitRepository
} from "@smartflow/workspace";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const activeHarnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

it("builds a cumulative Git Candidate without changing the active Workspace or user index", async () => {
  const harness = await createRuntimeHarness();
  activeHarnesses.push(harness);
  const capabilities = await probeGitRepository(harness.projectDir);
  if (capabilities.status !== "READY" || capabilities.repositoryId === undefined) {
    throw new Error("Git fixture unexpectedly paused");
  }
  const activeSourcePath = resolve(harness.projectDir, "sum.js");
  const activeSource = await readFile(activeSourcePath);
  const userIndex = await readFile(resolve(harness.projectDir, ".git/index")).catch(() => Buffer.alloc(0));
  const runDirectory = resolve(harness.dataDir, "runs/job-1");
  const store = await initializeGitObjectStore(runDirectory);
  const baseline = await captureGitSnapshot({
    projectRoot: harness.projectDir,
    dataDirectory: runDirectory,
    runGitDirectory: store.gitDirectory,
    indexPath: resolve(runDirectory, "revision-1/baseline.index"),
    repositoryId: capabilities.repositoryId,
    snapshotKind: "RUN_BASELINE",
    revision: 1,
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  });
  const workspace = resolve(runDirectory, "revision-1/workspace");
  await materializeGitSnapshot({
    snapshot: baseline,
    runGitDirectory: store.gitDirectory,
    dataDirectory: runDirectory,
    destination: workspace
  });
  await writeFile(resolve(workspace, "sum.js"), "export const sum = (a, b) => a + b;\n", "utf8");
  const result = await captureGitSnapshot({
    projectRoot: workspace,
    activeWorktreeRoot: harness.projectDir,
    includeAllFiles: true,
    dataDirectory: runDirectory,
    runGitDirectory: store.gitDirectory,
    indexPath: resolve(runDirectory, "revision-1/result.index"),
    repositoryId: capabilities.repositoryId,
    snapshotKind: "REVISION_RESULT",
    revision: 1,
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  });
  const candidate = await buildGitCandidate({
    runGitDirectory: store.gitDirectory,
    runBaseline: baseline,
    revisionInput: baseline,
    revisionResult: result
  });

  expect(candidate.candidate.operations).toContainEqual(expect.objectContaining({
    kind: "MODIFY",
    path: "sum.js"
  }));
  expect(candidate.cumulativePatch.toString("utf8")).toContain("a/sum.js");
  expect(hash(await readFile(activeSourcePath))).toBe(hash(activeSource));
  expect(await readFile(resolve(harness.projectDir, ".git/index")).catch(() => Buffer.alloc(0)))
    .toEqual(userIndex);
});
