import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import {
  buildGitCandidate,
  buildGitTreePatch,
  verifyCandidate
} from "./candidate-builder.js";
import { probeGitRepository } from "./git-capability.js";
import { materializeGitSnapshot } from "./git-materializer.js";
import { initializeGitObjectStore } from "./git-object-store.js";
import { captureGitSnapshot } from "./git-snapshot.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("keeps the formal Candidate cumulative and generates tree patches on demand", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "smartflow-candidate-source-"));
  const data = await mkdtemp(resolve(tmpdir(), "smartflow-candidate-data-"));
  roots.push(root, data);
  await execute("git", ["init", "--quiet", root]);
  await writeFile(resolve(root, "value.txt"), "A before\n", "utf8");
  await execute("git", ["-C", root, "add", "value.txt"]);
  const capabilities = await probeGitRepository(root);
  if (capabilities.status !== "READY" || capabilities.repositoryId === undefined) {
    throw new Error("repository capability fixture paused");
  }
  const runDirectory = resolve(data, "run-1");
  const store = await initializeGitObjectStore(runDirectory);
  const baseline = await captureGitSnapshot({
    projectRoot: root,
    dataDirectory: runDirectory,
    runGitDirectory: store.gitDirectory,
    indexPath: resolve(runDirectory, "revision-1", "baseline.index"),
    repositoryId: capabilities.repositoryId,
    snapshotKind: "RUN_BASELINE",
    revision: 1,
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  });
  const workspace1 = resolve(runDirectory, "revision-1", "workspace");
  await materializeGitSnapshot({
    snapshot: baseline,
    runGitDirectory: store.gitDirectory,
    dataDirectory: runDirectory,
    destination: workspace1
  });
  await writeFile(resolve(workspace1, "value.txt"), "B middle\n", "utf8");
  const result1 = await captureGitSnapshot({
    projectRoot: workspace1,
    dataDirectory: runDirectory,
    activeWorktreeRoot: root,
    includeAllFiles: true,
    runGitDirectory: store.gitDirectory,
    indexPath: resolve(runDirectory, "revision-1", "result.index"),
    repositoryId: capabilities.repositoryId,
    snapshotKind: "REVISION_RESULT",
    revision: 1,
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  });

  const workspace2 = resolve(runDirectory, "revision-2", "workspace");
  await materializeGitSnapshot({
    snapshot: result1,
    runGitDirectory: store.gitDirectory,
    dataDirectory: runDirectory,
    destination: workspace2
  });
  await writeFile(resolve(workspace2, "value.txt"), "C final\n", "utf8");
  const result2 = await captureGitSnapshot({
    projectRoot: workspace2,
    dataDirectory: runDirectory,
    activeWorktreeRoot: root,
    includeAllFiles: true,
    runGitDirectory: store.gitDirectory,
    indexPath: resolve(runDirectory, "revision-2", "result.index"),
    repositoryId: capabilities.repositoryId,
    snapshotKind: "REVISION_RESULT",
    revision: 2,
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  });
  const built = await buildGitCandidate({
    runBaseline: baseline,
    revisionInput: result1,
    revisionResult: result2
  });

  expect(verifyCandidate(built.candidate)).toBe(true);
  expect(built.candidate).toMatchObject({
    schemaVersion: 3,
    revision: 2,
    runBaselineSnapshotHash: baseline.snapshotHash,
    inputSnapshotHash: result1.snapshotHash,
    resultSnapshotHash: result2.snapshotHash
  });
  expect(built.candidate).not.toHaveProperty("runBaselineTreeId");
  expect(built.candidate).not.toHaveProperty("evidenceArtifactHash");
  expect(built.candidate.operations).toHaveLength(1);
  expect(built.candidate.operations[0]).toMatchObject({
    kind: "MODIFY",
    path: "value.txt",
    oldEntry: { sha256: baseline.entries[0]?.sha256 },
    newEntry: { sha256: result2.entries[0]?.sha256 }
  });
  const [incrementalPatch, cumulativePatch] = await Promise.all([
    buildGitTreePatch({
      runGitDirectory: store.gitDirectory,
      baseTreeId: result1.treeId,
      resultTreeId: result2.treeId
    }),
    buildGitTreePatch({
      runGitDirectory: store.gitDirectory,
      baseTreeId: baseline.treeId,
      resultTreeId: result2.treeId
    })
  ]);
  expect(incrementalPatch.toString("utf8")).toContain("-B middle");
  expect(incrementalPatch.toString("utf8")).toContain("+C final");
  expect(cumulativePatch.toString("utf8")).toContain("-A before");
  expect(cumulativePatch.toString("utf8")).toContain("+C final");
});
