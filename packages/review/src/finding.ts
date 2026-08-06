import { createHash } from "node:crypto";

export interface FindingInput {
  fingerprint?: string;
  code: string;
  criterionId: string | null;
  path: string | null;
  severity: "P0" | "P1" | "P2";
  blocking: boolean;
  summary: string;
  evidence: string[];
}

export interface Finding extends Omit<FindingInput, "fingerprint"> {
  fingerprint: string;
}

export function findingFingerprint(
  finding: Pick<FindingInput, "code" | "criterionId" | "path" | "severity">
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        code: finding.code,
        criterionId: finding.criterionId,
        path: finding.path,
        severity: finding.severity
      }),
      "utf8"
    )
    .digest("hex");
}

export function normalizeFinding(input: FindingInput): Finding {
  if (input.code.length === 0 || input.summary.length === 0 || input.evidence.length === 0) {
    throw new Error("REVIEW_FINDING_INVALID");
  }
  const fingerprint = findingFingerprint(input);
  if (input.fingerprint !== undefined && input.fingerprint !== fingerprint) {
    throw new Error("REVIEW_FINDING_FINGERPRINT_INVALID");
  }
  return { ...input, fingerprint };
}
