import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalHash } from "@smartflow/state-store";
import {
  GIT_INCLUSION_POLICY,
  SMARTFLOW_CONTROL_PLANE_PATH_PREFIXES,
  buildGitCandidate,
  captureGitSnapshot,
  initializeGitObjectStore,
  isSmartFlowControlPlanePath,
  materializeGitSnapshot,
  probeGitRepository,
  verifyCandidate,
  type Candidate,
  type CandidateOperation,
  type GitSnapshotEntry,
  type GitSnapshotKind,
  type GitWorkspaceSnapshot
} from "@smartflow/workspace";

const execute = promisify(execFile);
const roots: string[] = [];

function snapshot(
  snapshotKind: GitSnapshotKind,
  entries: GitSnapshotEntry[]
): GitWorkspaceSnapshot {
  const body = {
    repositoryId: "1".repeat(64),
    activeWorktreeRoot: ".",
    snapshotKind,
    treeId: snapshotKind === "RUN_BASELINE" ? "2".repeat(40) : "3".repeat(40),
    includedPathPolicyHash: "4".repeat(64),
    entries
  };
  return {
    ...body,
    snapshotHash: canonicalHash(body),
    createdAt: "2026-08-25T00:00:00.000Z"
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SmartFlow control-plane workspace paths", () => {
  it("excludes tracked, untracked, and ignored task files from baseline and result snapshots", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-control-source-"));
    const data = await mkdtemp(resolve(tmpdir(), "smartflow-control-data-"));
    roots.push(root, data);
    await execute("git", ["init", "--quiet", root]);
    await mkdir(resolve(root, "src"), { recursive: true });
    await mkdir(resolve(root, ".smartflow/tasks/tracked"), { recursive: true });
    await mkdir(resolve(root, ".smartflow/tasks/untracked"), { recursive: true });
    await mkdir(resolve(root, ".smartflow/tasks/ignored"), { recursive: true });
    await writeFile(resolve(root, ".gitignore"), ".smartflow/tasks/ignored/\n", "utf8");
    await writeFile(resolve(root, "src/index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(resolve(root, ".smartflow/tasks/tracked/tasks.md"), "tracked", "utf8");
    await execute("git", [
      "-C", root, "add", ".gitignore", "src/index.ts", ".smartflow/tasks/tracked/tasks.md"
    ]);
    await writeFile(resolve(root, ".smartflow/tasks/untracked/tasks.md"), "untracked", "utf8");
    await writeFile(resolve(root, ".smartflow/tasks/ignored/tasks.md"), "ignored", "utf8");
    await writeFile(resolve(root, "notes.txt"), "ordinary untracked", "utf8");

    const capabilities = await probeGitRepository(root);
    if (capabilities.status !== "READY" || capabilities.repositoryId === undefined) {
      throw new Error(`capability fixture paused: ${capabilities.pause?.code ?? "unknown"}`);
    }
    expect(GIT_INCLUSION_POLICY.excludedPathPrefixes)
      .toEqual(SMARTFLOW_CONTROL_PLANE_PATH_PREFIXES);
    expect(capabilities.inclusionPolicyHash).toBe(canonicalHash(GIT_INCLUSION_POLICY));

    const runDirectory = resolve(data, "run-1");
    const objectStore = await initializeGitObjectStore(runDirectory);
    const common = {
      dataDirectory: runDirectory,
      runGitDirectory: objectStore.gitDirectory,
      indexPath: resolve(runDirectory, "current.index"),
      repositoryId: capabilities.repositoryId,
      includedPathPolicyHash: capabilities.inclusionPolicyHash
    };
    const baseline = await captureGitSnapshot({
      ...common,
      projectRoot: root,
      snapshotKind: "RUN_BASELINE"
    });
    const result = await captureGitSnapshot({
      ...common,
      projectRoot: root,
      activeWorktreeRoot: root,
      includeAllFiles: true,
      snapshotKind: "RUN_RESULT"
    });

    for (const captured of [baseline, result]) {
      expect(captured.entries.some((entry) => isSmartFlowControlPlanePath(entry.path))).toBe(false);
      expect(captured.entries.map((entry) => entry.path)).toContain("src/index.ts");
      expect(captured.entries.map((entry) => entry.path)).toContain("notes.txt");
    }

    const workspace = resolve(runDirectory, "workspace");
    await materializeGitSnapshot({
      snapshot: baseline,
      runGitDirectory: objectStore.gitDirectory,
      dataDirectory: runDirectory,
      destination: workspace
    });
    await expect(access(resolve(workspace, ".smartflow/tasks")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects control-plane Candidate operations even for hash-valid artifacts", () => {
    const path = ".smartflow/tasks/request-1/tasks.md";
    const entry: GitSnapshotEntry = {
      path,
      kind: "FILE",
      mode: "100644",
      blobId: "5".repeat(40),
      sha256: "6".repeat(64),
      size: 4
    };
    const baseline = snapshot("RUN_BASELINE", []);
    const result = snapshot("RUN_RESULT", [entry]);

    expect(() => buildGitCandidate({ runBaseline: baseline, runResult: result }))
      .toThrow(`GIT_CANDIDATE_CONTROL_PATH_FORBIDDEN: ${path}`);

    const operations: CandidateOperation[] = [{
      kind: "ADD",
      path,
      newEntry: {
        path,
        kind: "FILE",
        sha256: entry.sha256,
        size: entry.size,
        mode: 0o644
      }
    }];
    const body = {
      runBaselineSnapshotHash: baseline.snapshotHash,
      resultSnapshotHash: result.snapshotHash,
      operations
    };
    const candidate: Candidate = { ...body, candidateHash: canonicalHash(body) };
    expect(verifyCandidate(candidate)).toBe(false);
    expect(isSmartFlowControlPlanePath(".smartflow/tasks")).toBe(true);
    expect(isSmartFlowControlPlanePath(path)).toBe(true);
    expect(isSmartFlowControlPlanePath(".smartflow/tasks-other/tasks.md")).toBe(false);
  });
});
