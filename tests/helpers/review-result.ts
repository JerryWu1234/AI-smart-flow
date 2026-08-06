import type { ReviewSubmission } from "@smartflow/protocol";
import type { ReviewBundle } from "@smartflow/review";

export function approvalForBundle(bundle: ReviewBundle): ReviewSubmission {
  return {
    verdict: "APPROVE",
    completionPercentage: 100,
    convergeFindings: [],
    adversarialFindings: [],
    pathCoverage: Object.fromEntries(
      bundle.changedPaths.map((path) => [path.path, "FULL" as const])
    ),
    residualRisks: []
  };
}
