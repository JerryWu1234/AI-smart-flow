import { describe, expect, it } from "vitest";

import type { ReviewResult } from "@smartflow/protocol";
import { planReviewDecision, REPAIR_ROUND_LIMIT } from "../../../../packages/review/src/review-decision.js";

function review(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    tasks: [{
      id: "T001",
      completionPercentage: 50,
      issues: [{
        path: "src/a.ts",
        message: "renderResult omits the required empty-state branch",
        suggestedFix: null
      }]
    }],
    ...overrides
  };
}

describe("planReviewDecision", () => {
  it("accepts only when every Task is complete", () => {
    expect(planReviewDecision({
      result: review({ tasks: [{ id: "T001", completionPercentage: 100, issues: [] }] }),
      repairRounds: 0
    })).toEqual({
      kind: "ACCEPT",
      decision: "accept",
      reason: "Reviewer confirmed every approved task is 100% complete"
    });
    expect(planReviewDecision({
      result: review(),
      repairRounds: 0
    }).kind).toBe("REPAIR");
  });

  it("repairs incomplete Tasks with only required Issue fields", () => {
    expect(planReviewDecision({
      result: review(),
      repairRounds: 0
    })).toEqual({
      kind: "REPAIR",
      decision: "repair",
      reason: "Reviewer reported incomplete approved tasks"
    });
  });

  it("uses all incomplete Task issues without returning a selected repair subset", () => {
    expect(planReviewDecision({
      result: review({
        tasks: [
          ...review().tasks,
          {
            id: "T002",
            completionPercentage: 80,
            issues: [{
              path: "src/b.ts",
              message: "parseConfig drops the fallback value",
              suggestedFix: null
            }]
          }
        ]
      }),
      repairRounds: REPAIR_ROUND_LIMIT - 1
    })).toEqual({
      kind: "REPAIR",
      decision: "repair",
      reason: "Reviewer reported incomplete approved tasks"
    });
  });

  it("pauses at fifteen completed repair rounds", () => {
    expect(planReviewDecision({
      result: review(),
      repairRounds: REPAIR_ROUND_LIMIT
    })).toEqual({
      kind: "PAUSE_REPAIR_LIMIT",
      decision: "pause",
      reason: "Automatic repair limit reached"
    });
    expect(planReviewDecision({
      result: review(),
      repairRounds: REPAIR_ROUND_LIMIT + 1
    }).kind).toBe("PAUSE_REPAIR_LIMIT");
    expect(planReviewDecision({
      result: review(),
      repairRounds: REPAIR_ROUND_LIMIT - 1
    }).kind).toBe("REPAIR");
  });
});
