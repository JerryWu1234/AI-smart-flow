import { describe, expect, it } from "vitest";

import {
  assessRepairProgress,
  deriveRepairApproval,
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
  canonicalTaskPath: "/project/tasks.md",
  providerRuntimeConfig: { runtime: "frozen" },
  approval: {
    kind: "USER" as const,
    approvedAt: "2026-07-20T00:00:00.000Z",
    parentRevision: null,
    authorizedCriterionIds: []
  }
};

function parentManifest(): TaskManifest {
  return compileTaskManifest(createTasksSource(), { ...baseOptions, revision: 1 }).manifest;
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

function appendRepairTasks(source: string, tasks: string[]): string {
  return `${source.trimEnd()}\n\n## Review Repair Tasks\n\n${tasks.join("\n")}\n`;
}

describe("review repair loop", () => {
  it("emits parser-valid, parent-bound tasks and pauses after fifteen unchanged rounds", () => {
    const parent = parentManifest();
    const first = assessRepairProgress(round("a"), round("a"), 0, { parentManifest: parent });
    expect(first).toMatchObject({ noProgressCount: 1, pauseRequired: false });
    expect(first.repairTasks[0]).toMatch(/\[M01\].*parentRevision=1.*criterionId=T001/u);
    expect(first.repairTasks[0]).not.toContain("fingerprint");
    const fourteenth = assessRepairProgress(round("a"), round("a"), 13, {
      parentManifest: parent
    });
    expect(fourteenth).toMatchObject({ noProgressCount: 14, pauseRequired: false });
    const fifteenth = assessRepairProgress(round("a"), round("a"), 14, {
      parentManifest: parent
    });
    expect(fifteenth).toMatchObject({ noProgressCount: 15, pauseRequired: true });

    const proposed = compileTaskManifest(
      appendRepairTasks(createTasksSource(), first.repairTasks),
      {
        ...baseOptions,
        revision: 2,
        approval: {
          kind: "LEADER_REPAIR",
          approvedAt: "2026-07-20T00:01:00.000Z",
          parentRevision: 1,
          authorizedCriterionIds: first.authorizedCriterionIds
        }
      }
    ).manifest;
    expect(deriveRepairApproval(parent, proposed)).toMatchObject({
      kind: "LEADER_REPAIR",
      parentRevision: 1,
      authorizedCriterionIds: ["T001"],
      reasons: []
    });
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

  it("derives authorization from immutable Manifest diffs, ignoring a forged approval label", () => {
    const parent = parentManifest();
    const assessment = assessRepairProgress(round("a"), round("b"), 0, { parentManifest: parent });
    const changedPolicySource = appendRepairTasks(createTasksSource(), assessment.repairTasks);
    const forged = compileTaskManifest(changedPolicySource, {
      ...baseOptions,
      revision: 2,
      providerRuntimeConfig: { runtime: "changed" },
      approval: {
        kind: "LEADER_REPAIR",
        approvedAt: "2026-07-20T00:01:00.000Z",
        parentRevision: 1,
        authorizedCriterionIds: ["T001"]
      }
    }).manifest;
    expect(deriveRepairApproval(parent, forged).kind).toBe("USER");
    expect(deriveRepairApproval(parent, forged).reasons).toContain("PROVIDER_RUNTIME_CHANGED");
  });
});
