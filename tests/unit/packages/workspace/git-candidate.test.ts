import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import {
  buildGitCandidate,
  verifyCandidate,
  verifyCandidateSnapshotBindings
} from "../../../../packages/workspace/src/candidate-builder.js";
import { probeGitRepository } from "../../../../packages/workspace/src/git-capability.js";
import { materializeGitSnapshot } from "../../../../packages/workspace/src/git-materializer.js";
import { initializeGitObjectStore } from "../../../../packages/workspace/src/git-object-store.js";
import { captureGitSnapshot } from "../../../../packages/workspace/src/git-snapshot.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("keeps the Job Candidate cumulative through snapshot-bound operations", async () => {
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
  const indexPath = resolve(runDirectory, "current.index");
  const workspace = resolve(runDirectory, "workspace");
  const baseline = await captureGitSnapshot({
    projectRoot: root,
    dataDirectory: runDirectory,
    runGitDirectory: store.gitDirectory,
    indexPath,
    repositoryId: capabilities.repositoryId,
    snapshotKind: "RUN_BASELINE",
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  });
  await materializeGitSnapshot({
    snapshot: baseline,
    runGitDirectory: store.gitDirectory,
    dataDirectory: runDirectory,
    destination: workspace
  });
  await writeFile(resolve(workspace, "value.txt"), "B middle\n", "utf8");
  const result1 = await captureGitSnapshot({
    projectRoot: workspace,
    dataDirectory: runDirectory,
    activeWorktreeRoot: root,
    includeAllFiles: true,
    runGitDirectory: store.gitDirectory,
    indexPath,
    repositoryId: capabilities.repositoryId,
    snapshotKind: "RUN_RESULT",
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  });

  await rm(workspace, { recursive: true, force: true });
  await materializeGitSnapshot({
    snapshot: result1,
    runGitDirectory: store.gitDirectory,
    dataDirectory: runDirectory,
    destination: workspace
  });
  await writeFile(resolve(workspace, "value.txt"), "C final\n", "utf8");
  const result2 = await captureGitSnapshot({
    projectRoot: workspace,
    dataDirectory: runDirectory,
    activeWorktreeRoot: root,
    includeAllFiles: true,
    runGitDirectory: store.gitDirectory,
    indexPath,
    repositoryId: capabilities.repositoryId,
    snapshotKind: "RUN_RESULT",
    includedPathPolicyHash: capabilities.inclusionPolicyHash
  });
  const built = await buildGitCandidate({
    runBaseline: baseline,
    runResult: result2
  });

  expect(verifyCandidate(built.candidate)).toBe(true);
  expect(verifyCandidateSnapshotBindings({
    candidate: built.candidate,
    runBaseline: baseline,
    runResult: result2
  })).toBe(true);
  expect(Object.keys(built.candidate).sort()).toEqual([
    "candidateHash",
    "operations",
    "resultSnapshotHash",
    "runBaselineSnapshotHash"
  ]);
  expect(built.candidate).toMatchObject({
    runBaselineSnapshotHash: baseline.snapshotHash,
    resultSnapshotHash: result2.snapshotHash
  });
  expect(built.candidate.operations).toHaveLength(1);
  expect(built.candidate.operations[0]).toMatchObject({
    kind: "MODIFY",
    path: "value.txt",
    oldEntry: { sha256: baseline.entries[0]?.sha256 },
    newEntry: { sha256: result2.entries[0]?.sha256 }
  });
});
