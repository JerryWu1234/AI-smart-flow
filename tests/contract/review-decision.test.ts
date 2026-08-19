import { describe, expect, it } from "vitest";

import {
  assertLeaderDecision,
  evaluateReviewGate,
  type ReviewResultInput
} from "@smartflow/review";

function result(overrides: Partial<ReviewResultInput> = {}): ReviewResultInput {
  return {
    tasks: [{ id: "T031", completionPercentage: 100, issues: [] }],
    ...overrides
  };
}

function incompleteResult(message = "validateInput fails to reject an empty token"): ReviewResultInput {
  return result({
    tasks: [{
      id: "T031",
      completionPercentage: 75,
      issues: [{
        path: "packages/a.ts",
        message,
        suggestedFix: "Add the missing empty-token guard in validateInput"
      }]
    }]
  });
}

const context = {
  reviewAttemptId: "review-1",
  reviewerSessionId: "reviewer-1",
  piSessionId: "pi-session-1"
};

describe("review and Leader decision contract", () => {
  it("lets the Leader accept only when every reviewed Task is complete", () => {
    const approved = evaluateReviewGate(context, result());
    expect(approved.accepted).toBe(true);
    expect(() => assertLeaderDecision(approved, "accept")).not.toThrow();

    const blocked = evaluateReviewGate(context, incompleteResult());
    expect(blocked.accepted).toBe(false);
    expect(() => assertLeaderDecision(blocked, "accept")).toThrow(
      /LEADER_DECISION_REJECTED_BY_REVIEW_GATE/u
    );
    expect(() => assertLeaderDecision(blocked, "repair")).not.toThrow();
  });

  it("repairs all nested issues without selecting issue identities", () => {
    const gate = evaluateReviewGate(context, incompleteResult());
    expect(gate.result.tasks[0]?.issues).toEqual([{
      path: "packages/a.ts",
      message: "validateInput fails to reject an empty token",
      suggestedFix: "Add the missing empty-token guard in validateInput"
    }]);
    expect(gate.allowedLeaderDecisions).toEqual(["repair", "pause"]);
    expect(() => assertLeaderDecision(gate, "repair")).not.toThrow();
  });

  it("does not permit a repair decision after every Task is complete", () => {
    const approved = evaluateReviewGate(context, result());
    expect(() => assertLeaderDecision(approved, "repair")).toThrow(
      /LEADER_DECISION_REJECTED_BY_REVIEW_GATE/u
    );
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
