import { describe, expect, it } from "vitest";

import {
  assessRepairProgress,
  assessRepairScope,
  renderRepairFeedback,
  renderRepairTaskLines,
  type RepairRound
} from "@smartflow/review";
import {
  compileTaskManifest,
  type TaskManifest
} from "@smartflow/task-manifest";
import { createTasksSource } from "../fixtures/task-manifest/test-fixture.js";

const baseOptions = {
  projectId: "project-1",
  jobId: "job-1",
  canonicalTaskPath: "tasks.md",
  providerRuntimeConfig: { runtime: "frozen" },
  approval: {
    kind: "USER" as const,
    approvedAt: "2026-07-20T00:00:00.000Z",
    authorizedCriterionIds: []
  }
};

function parentManifest(): TaskManifest {
  return compileTaskManifest(createTasksSource(), baseOptions).manifest;
}

function round(hash: string, message = "runBuild still returns success after compilation fails"): RepairRound {
  return {
    failureIds: ["REVIEW_BLOCKER"],
    tasks: [{
      id: "T001",
      completionPercentage: 50,
      issues: [{
        path: "packages/core/src/index.ts",
        message,
        suggestedFix: "Propagate the compilation failure from runBuild"
      }]
    }],
    relevantPathHashes: { "packages/core/src/index.ts": hash }
  };
}

describe("review repair loop", () => {
  it("pauses after fifteen unchanged rounds", () => {
    const first = assessRepairProgress(round("a"), round("a"), 0);
    expect(first).toMatchObject({ noProgressCount: 1, pauseRequired: false });
    const fourteenth = assessRepairProgress(round("a"), round("a"), 13);
    expect(fourteenth).toMatchObject({ noProgressCount: 14, pauseRequired: false });
    const fifteenth = assessRepairProgress(round("a"), round("a"), 14);
    expect(fifteenth).toMatchObject({ noProgressCount: 15, pauseRequired: true });
  });

  it("renders parser-valid criterion-bound drafts that still require user approval", () => {
    const repairTasks = renderRepairTaskLines(parentManifest(), round("a").tasks);
    expect(repairTasks[0]).toMatch(/\[M01\].*criterionId=T001/u);
    expect(repairTasks[0]).not.toContain("parentRevision");
    expect(repairTasks[0]).not.toContain("fingerprint");
    const source = `## M01 Repair\n\n${repairTasks.join("\n")}`;
    expect(compileTaskManifest(source, baseOptions).manifest.tasks).toMatchObject([
      { id: "T900", filePaths: ["packages/core/src/index.ts"] }
    ]);

    expect(() => compileTaskManifest(source, {
      ...baseOptions,
      approval: {
        kind: "LEADER_REPAIR" as "USER",
        approvedAt: "2026-07-20T00:01:00.000Z",
        authorizedCriterionIds: ["T001"]
      }
    })).toThrow();
  });

  it("resets no progress when a relevant Candidate file changes", () => {
    expect(
      assessRepairProgress(round("a"), round("b"), 1)
    ).toMatchObject({ noProgressCount: 0, pauseRequired: false });
  });

  it("resets no progress when the unfinished task/path scope shrinks", () => {
    const previous = { ...round("a"), failureIds: ["REVIEW_BLOCKER", "REVIEW_SCOPE"] };
    expect(
      assessRepairProgress(previous, round("a"), 1)
    ).toMatchObject({ noProgressCount: 0, pauseRequired: false });
  });

  it("does not treat message-only wording changes as progress", () => {
    expect(
      assessRepairProgress(
        round("a", "runBuild fails to propagate compilation errors"),
        round("a", "Compilation failures are swallowed inside runBuild"),
        1
      )
    ).toMatchObject({ noProgressCount: 2, pauseRequired: false });
  });

  it("treats all issues being resolved as progress", () => {
    const previous = { ...round("a"), failureIds: [] };
    const resolved: RepairRound = {
      failureIds: [],
      tasks: [],
      relevantPathHashes: { "packages/core/src/index.ts": "a" }
    };
    const result = assessRepairProgress(previous, resolved, 1);
    expect(result).toEqual({ noProgressCount: 0, pauseRequired: false });
  });

  it("renders every nested issue in a draft with its parent Task criterion", () => {
    const current = round("a");
    current.tasks[0]?.issues.push({
      path: "packages/core/src/index.ts",
      message: "formatResult omits the failed-build diagnostic",
      suggestedFix: null
    });
    const repairTasks = renderRepairTaskLines(parentManifest(), current.tasks);
    expect(repairTasks).toHaveLength(2);
    expect(repairTasks.every((task) => task.endsWith("criterionId=T001"))).toBe(true);
    expect(repairTasks.join("\n")).not.toContain("fingerprint");
  });

  it("honors a custom threshold when task/path scope and file content are unchanged", () => {
    const result = assessRepairProgress(round("a"), round("a"), 1, 2);
    expect(result).toMatchObject({ noProgressCount: 2, pauseRequired: true });
  });

  it("classifies scope expansion and keeps in-scope feedback on the same immutable Job", () => {
    const parent = parentManifest();
    expect(assessRepairScope(parent, round("a").tasks)).toEqual({
      inScope: true,
      reasons: []
    });
    const outOfScope = round("a");
    const issue = outOfScope.tasks[0]?.issues[0];
    if (issue === undefined) throw new Error("repair issue fixture missing");
    issue.path = "packages/other/src/index.ts";
    expect(assessRepairScope(parent, outOfScope.tasks)).toEqual({
      inScope: false,
      reasons: ["REVIEW_ISSUE_PATH_OUT_OF_SCOPE:T001:packages/other/src/index.ts"]
    });
    const feedback = renderRepairFeedback(round("a").tasks);
    expect(feedback).toContain("Continue working on the same approved task");
    expect(feedback).toContain("Do not modify task.md");
  });
});
