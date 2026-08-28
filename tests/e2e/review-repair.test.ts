import { describe, expect, it } from "vitest";

import {
  assessRepairProgress,
  assessRepairScope,
  renderRepairFeedback,
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
  it("emits parser-valid criterion-bound draft tasks and pauses after fifteen unchanged rounds", () => {
    const parent = parentManifest();
    const first = assessRepairProgress(round("a"), round("a"), 0, { parentManifest: parent });
    expect(first).toMatchObject({ noProgressCount: 1, pauseRequired: false });
    expect(first.repairTasks[0]).toMatch(/\[M01\].*criterionId=T001/u);
    expect(first.repairTasks[0]).not.toContain("parentRevision");
    expect(first.repairTasks[0]).not.toContain("fingerprint");
    const fourteenth = assessRepairProgress(round("a"), round("a"), 13, {
      parentManifest: parent
    });
    expect(fourteenth).toMatchObject({ noProgressCount: 14, pauseRequired: false });
    const fifteenth = assessRepairProgress(round("a"), round("a"), 14, {
      parentManifest: parent
    });
    expect(fifteenth).toMatchObject({ noProgressCount: 15, pauseRequired: true });

    expect(() => compileTaskManifest(createTasksSource(), {
      ...baseOptions,
      approval: {
        kind: "LEADER_REPAIR" as "USER",
        approvedAt: "2026-07-20T00:01:00.000Z",
        authorizedCriterionIds: first.authorizedCriterionIds
      }
    })).toThrow();
  });

  it("resets no progress when a relevant Candidate file changes", () => {
    expect(
      assessRepairProgress(round("a"), round("b"), 1, { parentManifest: parentManifest() })
    ).toMatchObject({ noProgressCount: 0, pauseRequired: false });
  });

  it("resets no progress when the unfinished task/path scope shrinks", () => {
    const previous = { ...round("a"), failureIds: ["REVIEW_BLOCKER", "REVIEW_SCOPE"] };
    expect(
      assessRepairProgress(previous, round("a"), 1, { parentManifest: parentManifest() })
    ).toMatchObject({ noProgressCount: 0, pauseRequired: false });
  });

  it("does not treat message-only wording changes as progress", () => {
    expect(
      assessRepairProgress(
        round("a", "runBuild fails to propagate compilation errors"),
        round("a", "Compilation failures are swallowed inside runBuild"),
        1,
        { parentManifest: parentManifest() }
      )
    ).toMatchObject({ noProgressCount: 2, pauseRequired: false });
  });

  it("treats all issues being resolved as progress and emits no repair task", () => {
    const previous = { ...round("a"), failureIds: [] };
    const resolved: RepairRound = {
      failureIds: [],
      tasks: [],
      relevantPathHashes: { "packages/core/src/index.ts": "a" }
    };
    const result = assessRepairProgress(previous, resolved, 1, { parentManifest: parentManifest() });
    expect(result).toMatchObject({ noProgressCount: 0, pauseRequired: false, repairTasks: [] });
    expect(result.authorizedCriterionIds).toEqual([]);
  });

  it("emits every nested issue while authorizing its parent Task once", () => {
    const current = round("a");
    current.tasks[0]?.issues.push({
      path: "packages/core/src/index.ts",
      message: "formatResult omits the failed-build diagnostic",
      suggestedFix: null
    });
    const result = assessRepairProgress(round("a"), current, 0, {
      parentManifest: parentManifest()
    });
    expect(result.repairTasks).toHaveLength(2);
    expect(result.authorizedCriterionIds).toEqual(["T001"]);
    expect(result.repairTasks.join("\n")).not.toContain("fingerprint");
  });

  it("keeps accumulating no progress when task/path scope and file content are unchanged", () => {
    const result = assessRepairProgress(round("a"), round("a"), 1, {
      parentManifest: parentManifest()
    });
    expect(result).toMatchObject({ noProgressCount: 2, pauseRequired: false });
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
