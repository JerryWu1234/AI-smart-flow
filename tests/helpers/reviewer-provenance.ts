import type { ReviewSubmission } from "@smartflow/protocol";

export function combineReviewStageResults(
  paths: string[],
  converge: ReviewSubmission,
  adversarial: ReviewSubmission
): ReviewSubmission {
  const pathCoverage: Record<string, "FULL" | "MISSING"> = Object.fromEntries(
    paths.map((path) => [
      path,
      converge.pathCoverage[path] === "FULL" && adversarial.pathCoverage[path] === "FULL"
        ? "FULL"
        : "MISSING"
    ])
  );
  const convergeFindings = [
    ...converge.convergeFindings,
    ...adversarial.convergeFindings
  ];
  const adversarialFindings = [
    ...converge.adversarialFindings,
    ...adversarial.adversarialFindings
  ];
  const hasBlocking = [...convergeFindings, ...adversarialFindings].some(
    (finding) => finding.blocking
  );
  const fullyCovered = Object.values(pathCoverage).every((coverage) => coverage === "FULL");
  return {
    verdict:
      converge.verdict === "APPROVE" &&
      adversarial.verdict === "APPROVE" &&
      !hasBlocking &&
      fullyCovered
        ? "APPROVE"
        : hasBlocking
          ? "BLOCKED"
          : "REQUEST_CHANGES",
    completionPercentage: Math.min(
      converge.completionPercentage,
      adversarial.completionPercentage
    ),
    convergeFindings,
    adversarialFindings,
    pathCoverage,
    residualRisks: [...converge.residualRisks, ...adversarial.residualRisks]
  };
}
