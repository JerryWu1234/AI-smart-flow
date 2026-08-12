import { describe, expect, it } from "vitest";

import {
  assessRepairProgress,
  deriveRepairApproval,
  normalizeFinding,
  type RepairRound
} from "@smartflow/review";
import {
  compileTaskManifest,
  type TaskManifest
} from "@smartflow/task-manifest";
import { createTasksSource } from "../../packages/task-manifest/src/test-fixture.js";

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

function round(hash: string): RepairRound {
  return {
    failureIds: ["REVIEW_BLOCKER"],
    findings: [
      normalizeFinding({
        code: "TEST_FAILURE",
        criterionId: "T001",
        path: "packages/core/src/index.ts",
        severity: "P1",
        blocking: true,
        summary: "test still fails",
        evidence: ["Reviewer observed the behavior in the Candidate"]
      })
    ],
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
    expect(first.repairTasks[0]).toMatch(/\[M01\].*parentRevision=1.*criterionId=T001.*findingFingerprint=/u);
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

  it("counts no progress when the same findings remain despite relevant path changes", () => {
    expect(
      assessRepairProgress(round("a"), round("b"), 1, { parentManifest: parentManifest() })
    ).toMatchObject({ noProgressCount: 2, pauseRequired: false });
  });

  it("counts no progress when problems reduce without a relevant path change", () => {
    const previous = { ...round("a"), failureIds: ["REVIEW_BLOCKER", "REVIEW_SCOPE"] };
    expect(
      assessRepairProgress(previous, round("a"), 1, { parentManifest: parentManifest() })
    ).toMatchObject({ noProgressCount: 2, pauseRequired: false });
  });

  it("resets no progress only when problems reduce and a relevant path changes", () => {
    const previous = { ...round("a"), failureIds: ["REVIEW_BLOCKER", "REVIEW_SCOPE"] };
    expect(
      assessRepairProgress(previous, round("b"), 1, { parentManifest: parentManifest() })
    ).toMatchObject({ noProgressCount: 0, pauseRequired: false });
  });

  it("treats a blocker becoming non-blocking as resolved and emits no forced repair task", () => {
    const previous = { ...round("a"), failureIds: [] };
    const resolved = {
      failureIds: [],
      findings: previous.findings.map((finding) => ({ ...finding, blocking: false })),
      relevantPathHashes: { "packages/core/src/index.ts": "b" }
    };
    const result = assessRepairProgress(previous, resolved, 1, { parentManifest: parentManifest() });
    expect(result).toMatchObject({ noProgressCount: 0, pauseRequired: false, repairTasks: [] });
  });

  it("counts a blocker becoming non-blocking without a relevant path change as no progress", () => {
    const previous = { ...round("a"), failureIds: [] };
    const resolved = {
      failureIds: [],
      findings: previous.findings.map((finding) => ({ ...finding, blocking: false })),
      relevantPathHashes: { "packages/core/src/index.ts": "a" }
    };
    const result = assessRepairProgress(previous, resolved, 1, { parentManifest: parentManifest() });
    expect(result).toMatchObject({ noProgressCount: 2, pauseRequired: false, repairTasks: [] });
  });

  it("ignores purely non-blocking findings for progress, paths, and repair tasks", () => {
    const nonBlocking = {
      failureIds: [],
      findings: round("a").findings.map((finding) => ({
        ...finding,
        blocking: false,
        summary: "residual risk only"
      })),
      relevantPathHashes: { "packages/core/src/index.ts": "a" }
    };
    const result = assessRepairProgress(nonBlocking, {
      ...nonBlocking,
      relevantPathHashes: { "packages/core/src/index.ts": "b" }
    }, 1, { parentManifest: parentManifest() });
    expect(result).toMatchObject({ noProgressCount: 0, pauseRequired: false, repairTasks: [] });
    expect(result.authorizedCriterionIds).toEqual([]);
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
