import { describe, expect, it } from "vitest";

import {
  validateHostReviewOutput,
  type HostReviewContext
} from "../../../helpers/host-workflow/reviewer.js";

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
  it("passes the strict nested task result through", () => {
    const result = {
      tasks: [
        {
          id: "T001",
          completionPercentage: 50,
          issues: [{
            path: "src/a.ts",
            message: "Required behavior is incomplete",
            suggestedFix: "Implement the missing behavior"
          }]
        },
        { id: "T002", completionPercentage: 100, issues: [] }
      ]
    };
    const output = validateHostReviewOutput(context, {
      reviewerSessionId: "reviewer-1",
      result
    });

    expect(output.result).toEqual(result);
  });

  it("rejects unknown top-level keys", () => {
    expect(() => validateHostReviewOutput(context, {
      reviewerSessionId: "reviewer-1",
      result: {
        tasks: [{ id: "T001", completionPercentage: 100, issues: [] }]
      },
      unexpected: true
    })).toThrow(/HOST_REVIEW_INVALID_OUTPUT/u);
  });

  it("preserves an incomplete Task without aggregating completion", () => {
    const result = {
      tasks: [
        {
          id: "T001",
          completionPercentage: 99,
          issues: [{
            path: "src/a.ts",
            message: "One acceptance detail remains",
            suggestedFix: "Implement the remaining detail"
          }]
        },
        { id: "T002", completionPercentage: 100, issues: [] }
      ]
    };
    const output = validateHostReviewOutput(context, {
      reviewerSessionId: "reviewer-1",
      result
    });

    expect(output.result).toEqual(result);
    expect(output.result.tasks[0]?.completionPercentage).toBe(99);
  });
});
