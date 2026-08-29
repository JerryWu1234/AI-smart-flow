import type { ArtifactRef } from "@smartflow/protocol";

import type { ProjectState, RunRecord } from "../../../packages/state-store/src/schema.js";

const fixtureArtifact: ArtifactRef = {
  relativePath: "runs/job-1/task-manifest.json",
  sha256: "a".repeat(64),
  size: 128
};

export function createRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    jobId: "job-1",
    canonicalTaskPath: "/project/tasks.md",
    fence: 1,
    phase: "PREPARING",
    taskManifest: fixtureArtifact,
    taskSource: {
      relativePath: "runs/job-1/task-source.md",
      sha256: "b".repeat(64),
      size: 64
    },
    reviewAdapterId: "codex",
    noProgressCount: 0,
    autoRepairRounds: 0,
    workerAttempts: [],
    createdAt: "2026-07-20T10:00:00+08:00",
    updatedAt: "2026-07-20T10:00:00+08:00",
    ...overrides
  };
}

export function createProjectState(overrides: Partial<ProjectState> = {}): ProjectState {
  const {
    runs = {},
    activeRunsByTaskPath: explicitActiveRunsByTaskPath,
    ...remainingOverrides
  } = overrides;
  const terminalPhases = new Set(["COMPLETED", "CANCELED", "FAILED"]);
  const activeRunsByTaskPath = explicitActiveRunsByTaskPath ?? Object.fromEntries(
    Object.values(runs)
      .filter((run) => !terminalPhases.has(run.phase))
      .map((run) => [run.canonicalTaskPath, run.jobId])
  );
  return {
    projectId: "project-1",
    canonicalProjectRoot: "/project/source",
    stateVersion: 0,
    projectFence: 0,
    publishLease: null,
    processedRequests: {},
    updatedAt: "2026-07-20T10:00:00+08:00",
    ...remainingOverrides,
    activeRunsByTaskPath,
    runs
  };
}
