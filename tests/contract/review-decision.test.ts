import { describe, expect, it } from "vitest";

import {
  assertLeaderDecision,
  evaluateReviewGate,
  findingFingerprint,
  type FindingInput,
  type ReviewResultInput
} from "@smartflow/review";

function finding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    code: "MISSING_GUARD",
    criterionId: "T031",
    path: "packages/a.ts",
    severity: "P2",
    blocking: true,
    summary: "guard missing",
    evidence: ["line 10"],
    ...overrides
  };
}

function result(overrides: Partial<ReviewResultInput> = {}): ReviewResultInput {
  return {
    verdict: "APPROVE",
    completionPercentage: 100,
    convergeFindings: [],
    adversarialFindings: [],
    pathCoverage: { "packages/a.ts": "FULL" },
    residualRisks: [],
    ...overrides
  };
}

const context = {
  reviewAttemptId: "review-1",
  reviewerSessionId: "reviewer-1",
  piSessionId: "pi-session-1",
  changedPaths: ["packages/a.ts"]
};

describe("review and Leader decision contract", () => {
  it("lets the Leader accept complete review coverage after inspecting Reviewer comments", () => {
    const approved = evaluateReviewGate(context, result());
    expect(approved.accepted).toBe(true);
    expect(() => assertLeaderDecision(approved, "accept")).not.toThrow();

    const blocked = evaluateReviewGate(context, result({ convergeFindings: [finding()] }));
    expect(blocked.accepted).toBe(false);
    expect(() => assertLeaderDecision(blocked, "accept")).toThrow(
      /LEADER_DECISION_REJECTED_BY_REVIEW_GATE/u
    );

    const incomplete = evaluateReviewGate(
      context,
      result({ pathCoverage: { "packages/a.ts": "MISSING" } })
    );
    expect(() => assertLeaderDecision(incomplete, "accept")).toThrow(
      /LEADER_DECISION_REJECTED_BY_REVIEW_GATE/u
    );
  });

  it("requires repair to select current Reviewer findings by fingerprint", () => {
    const lowSeverityBlocker = finding({ severity: "P2", blocking: true });
    const gate = evaluateReviewGate(context, result({ convergeFindings: [lowSeverityBlocker] }));
    const fingerprint = findingFingerprint(lowSeverityBlocker);
    expect(gate.reasons).toContain(
      "BLOCKING_FINDINGS_PRESENT"
    );
    expect(() => assertLeaderDecision(gate, "repair", [{
      source: "reviewer",
      findingFingerprint: fingerprint
    }])).not.toThrow();
    expect(() => assertLeaderDecision(gate, "repair")).toThrow(
      /LEADER_REPAIR_FINDING_SELECTION_INVALID/u
    );
    expect(() => assertLeaderDecision(gate, "repair", [{
      source: "reviewer",
      findingFingerprint: "f".repeat(64)
    }])).toThrow(
      /LEADER_REPAIR_FINDING_SELECTION_INVALID/u
    );
    const reworded = { ...lowSeverityBlocker, summary: "different natural language" };
    expect(fingerprint).toBe(
      findingFingerprint(reworded)
    );
  });

  it("allows a Leader-authored repair after the Reviewer approves", () => {
    const approved = evaluateReviewGate(context, result());
    expect(() => assertLeaderDecision(approved, "repair", [{
      source: "leader",
      code: "LEADER_CONCERN",
      taskId: "T031",
      path: "packages/a.ts",
      reason: "The implementation misses a required edge case"
    }])).not.toThrow();
  });

  it("creates an independent Reviewer once and requires that session on later rounds", () => {
    expect(() => evaluateReviewGate({ ...context, reviewerSessionId: "pi-session-1" }, result())).toThrow(
      /REVIEWER_SESSION_MATCHES_WORKER/u
    );
    expect(evaluateReviewGate(context, result()).accepted).toBe(true);
    expect(evaluateReviewGate({
      ...context,
      boundReviewerSessionId: "reviewer-1"
    }, result()).accepted).toBe(true);
    expect(() => evaluateReviewGate({
      ...context,
      reviewerSessionId: "reviewer-2",
      boundReviewerSessionId: "reviewer-1"
    }, result())).toThrow(
      /REVIEWER_SESSION_BINDING_MISMATCH/u
    );
  });
});
