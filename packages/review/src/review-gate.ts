import type { ReviewResult } from "@smartflow/protocol";

export type ReviewResultInput = ReviewResult;

export interface ReviewGateContext {
  reviewAttemptId: string;
  reviewerSessionId: string;
  piSessionId: string;
  boundReviewerSessionId?: string;
}

export interface ReviewGateDecision {
  accepted: boolean;
  allowedLeaderDecisions: Array<"accept" | "repair" | "pause">;
  result: ReviewResult;
}

export function evaluateReviewGate(
  context: ReviewGateContext,
  input: ReviewResultInput
): ReviewGateDecision {
  if (context.reviewerSessionId === context.piSessionId) {
    throw new Error("REVIEWER_SESSION_MATCHES_WORKER");
  }
  if (
    context.boundReviewerSessionId !== undefined &&
    context.reviewerSessionId !== context.boundReviewerSessionId
  ) {
    throw new Error("REVIEWER_SESSION_BINDING_MISMATCH");
  }
  if (input.tasks.some(
    (task) => (task.completionPercentage === 100) !== (task.issues.length === 0)
  )) {
    throw new Error("REVIEW_RESULT_INCONSISTENT");
  }
  const accepted = input.tasks.every((task) => task.completionPercentage === 100);
  return {
    accepted,
    allowedLeaderDecisions: accepted ? ["accept", "pause"] : ["repair", "pause"],
    result: input
  };
}

export function assertLeaderDecision(
  gate: ReviewGateDecision,
  decision: "accept" | "repair" | "pause"
): void {
  if (!gate.allowedLeaderDecisions.includes(decision)) {
    throw new Error("LEADER_DECISION_REJECTED_BY_REVIEW_GATE");
  }
}
