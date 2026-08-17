import { describe, expect, it } from "vitest";

import {
  validateHostReviewOutput,
  type HostReviewContext
} from "../../../../packages/host-skill/src/reviewer.js";

const digest = "a".repeat(64);

const context: HostReviewContext = {
  reviewAttemptId: "review-attempt-1",
  worktreePath: "/tmp/worktree",
  taskSourceHash: digest,
  candidateHash: digest,
  changedPaths: ["src/a.ts", "src/b.ts"],
  reviewerSession: { mode: "CREATE" },
  piSessionId: "pi-session-1"
};

describe("compact Reviewer completion result", () => {
  it("passes the compact task result through without path coverage", () => {
    const output = validateHostReviewOutput(context, {
      reviewerSessionId: "reviewer-1",
      completionPercentage: 75,
      tasks: [
        {
          id: "T001",
          completionPercentage: 50,
          reason: "Required behavior is incomplete",
          suggestion: "Implement the missing behavior"
        },
        { id: "T002", completionPercentage: 100 }
      ]
    });

    expect(output.result).toEqual({
      completionPercentage: 75,
      tasks: [
        {
          id: "T001",
          completionPercentage: 50,
          reason: "Required behavior is incomplete",
          suggestion: "Implement the missing behavior"
        },
        { id: "T002", completionPercentage: 100 }
      ]
    });
  });

  it("rejects an overall percentage that is not the rounded task average", () => {
    expect(() => validateHostReviewOutput(context, {
      reviewerSessionId: "reviewer-1",
      completionPercentage: 74,
      tasks: [
        {
          id: "T001",
          completionPercentage: 50,
          reason: "Required behavior is incomplete",
          suggestion: "Implement the missing behavior"
        },
        { id: "T002", completionPercentage: 100 }
      ]
    })).toThrow(/HOST_REVIEW_INVALID_OUTPUT/u);
  });

  it("preserves a rounded average of 100 when one task is not complete", () => {
    const output = validateHostReviewOutput(context, {
      reviewerSessionId: "reviewer-1",
      completionPercentage: 100,
      tasks: [
        {
          id: "T001",
          completionPercentage: 99,
          reason: "One acceptance detail remains",
          suggestion: "Implement the remaining detail"
        },
        { id: "T002", completionPercentage: 100 }
      ]
    });

    expect(output.result).toMatchObject({ completionPercentage: 100 });
    expect("tasks" in output.result && output.result.tasks[0]?.completionPercentage).toBe(99);
  });
});
