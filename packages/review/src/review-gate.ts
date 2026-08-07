import type { RepairItem } from "@smartflow/protocol";

import type { Finding, FindingInput } from "./finding.js";
import { normalizeFinding } from "./finding.js";

export interface ReviewResultInput {
  verdict: "APPROVE" | "REQUEST_CHANGES" | "BLOCKED";
  completionPercentage: number;
  convergeFindings: FindingInput[];
  adversarialFindings: FindingInput[];
  pathCoverage: Record<string, "FULL" | "MISSING">;
  residualRisks: string[];
}

export interface NormalizedReviewResult extends Omit<ReviewResultInput, "convergeFindings" | "adversarialFindings"> {
  convergeFindings: Finding[];
  adversarialFindings: Finding[];
}

export interface ReviewGateContext {
  reviewAttemptId: string;
  reviewerSessionId: string;
  piSessionId: string;
  boundReviewerSessionId?: string;
  changedPaths: string[];
}

export interface ReviewGateDecision {
  accepted: boolean;
  allowedLeaderDecisions: Array<"accept" | "repair" | "pause">;
  result: NormalizedReviewResult;
  reasons: string[];
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
  const result: NormalizedReviewResult = {
    ...input,
    convergeFindings: input.convergeFindings.map(normalizeFinding),
    adversarialFindings: input.adversarialFindings.map(normalizeFinding)
  };
  const findings = [...result.convergeFindings, ...result.adversarialFindings];
  const missing = context.changedPaths.filter((path) => result.pathCoverage[path] !== "FULL");
  const unexpectedCoverage = Object.keys(result.pathCoverage).filter(
    (path) => !context.changedPaths.includes(path)
  );
  const coverageIncomplete = missing.length > 0 || unexpectedCoverage.length > 0;
  const blockers = findings.filter((finding) => finding.blocking);
  const reasons: string[] = [];
  if (result.verdict !== "APPROVE") reasons.push("VERDICT_NOT_APPROVE");
  if (coverageIncomplete) reasons.push("PATH_COVERAGE_INCOMPLETE");
  if (blockers.length > 0) reasons.push("BLOCKING_FINDINGS_PRESENT");
  const accepted = reasons.length === 0;
  return {
    accepted,
    allowedLeaderDecisions: accepted
      ? ["accept", "repair", "pause"]
      : ["repair", "pause"],
    result,
    reasons
  };
}

export function assertLeaderDecision(
  gate: ReviewGateDecision,
  decision: "accept" | "repair" | "pause",
  repairItems: readonly RepairItem[] = []
): void {
  if (!gate.allowedLeaderDecisions.includes(decision)) {
    throw new Error("LEADER_DECISION_REJECTED_BY_REVIEW_GATE");
  }
  const repairItemKeys = repairItems.map((item) => item.source === "reviewer"
    ? `reviewer:${item.findingFingerprint}`
    : `leader:${item.code}:${item.taskId}:${item.path ?? ""}`);
  const reviewFindingFingerprints = new Set(
    [...gate.result.convergeFindings, ...gate.result.adversarialFindings]
      .map((finding) => finding.fingerprint)
  );
  if (
    new Set(repairItemKeys).size !== repairItemKeys.length ||
    (decision === "repair" && repairItems.length === 0) ||
    (decision !== "repair" && repairItems.length > 0) ||
    repairItems.some(
      (item) => item.source === "reviewer" &&
        !reviewFindingFingerprints.has(item.findingFingerprint)
    )
  ) {
    throw new Error("LEADER_REPAIR_FINDING_SELECTION_INVALID");
  }
}
