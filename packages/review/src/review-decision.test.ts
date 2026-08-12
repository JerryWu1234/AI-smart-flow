import { describe, expect, it } from "vitest";

import type { ReviewFinding, ReviewSubmission } from "@smartflow/protocol";
import { planReviewDecision, REPAIR_ROUND_LIMIT } from "./review-decision.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

function finding(fingerprint: string, blocking = true): ReviewFinding {
  return {
    fingerprint,
    code: "TASK_INCOMPLETE",
    criterionId: "T001",
    path: null,
    severity: "P1" as const,
    blocking,
    summary: "Task is incomplete",
    evidence: ["missing behavior"]
  };
}

function review(overrides: Partial<ReviewSubmission> = {}): ReviewSubmission {
  return {
    verdict: "REQUEST_CHANGES" as const,
    completionPercentage: 50,
    convergeFindings: [finding(digestA)],
    adversarialFindings: [],
    pathCoverage: { "src/a.ts": "FULL" as const },
    residualRisks: [],
    ...overrides
  };
}

describe("planReviewDecision", () => {
  it("accepts only a complete approval without blocking findings", () => {
    expect(planReviewDecision({
      result: review({ verdict: "APPROVE", completionPercentage: 100, convergeFindings: [] }),
      repairRounds: 0
    })).toEqual({
      kind: "ACCEPT",
      decision: "accept",
      repairItems: [],
      reason: "Reviewer confirmed every approved task is 100% complete"
    });
    expect(planReviewDecision({
      result: review({ verdict: "APPROVE", completionPercentage: 100 }),
      repairRounds: 0
    }).kind).toBe("REPAIR");
  });

  it("pauses when an incomplete review has no actionable blocking finding", () => {
    const invalid = review({ convergeFindings: [], adversarialFindings: [finding(digestB, false)] });
    expect(planReviewDecision({
      result: invalid,
      repairRounds: 0
    })).toMatchObject({
      kind: "PAUSE_INVALID_REVIEW",
      decision: "pause",
      repairItems: []
    });
    expect(planReviewDecision({
      result: invalid,
      repairRounds: REPAIR_ROUND_LIMIT
    }).kind).toBe("PAUSE_INVALID_REVIEW");
  });

  it("deduplicates blocking findings by fingerprint", () => {
    expect(planReviewDecision({
      result: review({ adversarialFindings: [finding(digestA), finding(digestB)] }),
      repairRounds: 14
    })).toMatchObject({
      kind: "REPAIR",
      repairItems: [
        { source: "reviewer", findingFingerprint: digestA },
        { source: "reviewer", findingFingerprint: digestB }
      ]
    });
  });

  it("pauses at fifteen completed repair rounds and retains the pending repair items", () => {
    expect(planReviewDecision({
      result: review(),
      repairRounds: REPAIR_ROUND_LIMIT
    })).toMatchObject({
      kind: "PAUSE_REPAIR_LIMIT",
      decision: "pause",
      repairItems: [{ source: "reviewer", findingFingerprint: digestA }]
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
