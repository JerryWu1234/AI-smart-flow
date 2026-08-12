import type { RepairItem, ReviewSubmission } from "@smartflow/protocol";

export const REPAIR_ROUND_LIMIT = 15;

interface ReviewDecisionBase {
  reason: string;
  repairItems: RepairItem[];
}

export type ReviewDecisionPlan =
  | (ReviewDecisionBase & { kind: "ACCEPT"; decision: "accept" })
  | (ReviewDecisionBase & { kind: "REPAIR"; decision: "repair" })
  | (ReviewDecisionBase & { kind: "PAUSE_INVALID_REVIEW"; decision: "pause" })
  | (ReviewDecisionBase & { kind: "PAUSE_REPAIR_LIMIT"; decision: "pause" });

export interface PlanReviewDecisionInput {
  result: ReviewSubmission;
  repairRounds: number;
}

export function planReviewDecision(input: PlanReviewDecisionInput): ReviewDecisionPlan {
  const blockingFindings = [...new Map([
    ...input.result.convergeFindings,
    ...input.result.adversarialFindings
  ].filter((finding) => finding.blocking).map((finding) => [
    finding.fingerprint,
    finding
  ])).values()];
  const repairItems: RepairItem[] = blockingFindings.map((finding) => ({
    source: "reviewer",
    findingFingerprint: finding.fingerprint
  }));
  const complete =
    input.result.verdict === "APPROVE" &&
    input.result.completionPercentage === 100 &&
    blockingFindings.length === 0;

  if (complete) {
    return {
      kind: "ACCEPT",
      decision: "accept",
      repairItems: [],
      reason: "Reviewer confirmed every approved task is 100% complete"
    };
  }
  if (blockingFindings.length === 0) {
    return {
      kind: "PAUSE_INVALID_REVIEW",
      decision: "pause",
      repairItems: [],
      reason: "Reviewer did not provide actionable incomplete-task guidance"
    };
  }
  if (input.repairRounds >= REPAIR_ROUND_LIMIT) {
    return {
      kind: "PAUSE_REPAIR_LIMIT",
      decision: "pause",
      repairItems,
      reason: "Automatic repair limit reached"
    };
  }
  return {
    kind: "REPAIR",
    decision: "repair",
    repairItems,
    reason: "Reviewer reported incomplete approved tasks"
  };
}
