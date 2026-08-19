import type { ReviewResult } from "@smartflow/protocol";

export const REPAIR_ROUND_LIMIT = 15;

interface ReviewDecisionBase {
  reason: string;
}

export type ReviewDecisionPlan =
  | (ReviewDecisionBase & { kind: "ACCEPT"; decision: "accept" })
  | (ReviewDecisionBase & { kind: "REPAIR"; decision: "repair" })
  | (ReviewDecisionBase & { kind: "PAUSE_REPAIR_LIMIT"; decision: "pause" });

export interface PlanReviewDecisionInput {
  result: ReviewResult;
  repairRounds: number;
}

export function planReviewDecision(input: PlanReviewDecisionInput): ReviewDecisionPlan {
  const complete = input.result.tasks.every((task) => task.completionPercentage === 100);

  if (complete) {
    return {
      kind: "ACCEPT",
      decision: "accept",
      reason: "Reviewer confirmed every approved task is 100% complete"
    };
  }
  if (input.repairRounds >= REPAIR_ROUND_LIMIT) {
    return {
      kind: "PAUSE_REPAIR_LIMIT",
      decision: "pause",
      reason: "Automatic repair limit reached"
    };
  }
  return {
    kind: "REPAIR",
    decision: "repair",
    reason: "Reviewer reported incomplete approved tasks"
  };
}
