import {
  identifierSchema,
  reviewResultSchema,
  type ReviewResult
} from "@smartflow/protocol";

export type ReviewerSessionRequest =
  // CREATE is idempotent for one reviewAttemptId: a Host retry must reuse its durable mapping.
  | { mode: "CREATE" }
  | { mode: "RESUME"; reviewerSessionId: string };

export interface HostReviewContext {
  reviewAttemptId: string;
  worktreePath: string;
  taskSourceHash: string;
  candidateHash: string;
  changedPaths: string[];
  reviewerSession: ReviewerSessionRequest;
  piSessionId: string;
}

export interface HostReviewOutput {
  reviewerSessionId: string;
  result: ReviewResult;
}

export type HostReviewCallbackOutput = HostReviewOutput;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("HOST_REVIEW_INVALID_OUTPUT");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("HOST_REVIEW_INVALID_OUTPUT");
  }
}

export function reviewerSessionIdFromOutput(value: unknown): string | undefined {
  try {
    return identifierSchema.parse(record(value).reviewerSessionId);
  } catch {
    return undefined;
  }
}

export function validateHostReviewOutput(
  context: HostReviewContext,
  value: unknown
): HostReviewOutput {
  const output = record(value);
  exactKeys(output, ["reviewerSessionId", "result"]);
  const reviewerSessionId = identifierSchema.parse(output.reviewerSessionId);
  if (context.reviewerSession.mode === "CREATE") {
    if (reviewerSessionId === context.piSessionId) {
      throw new Error("REVIEWER_SESSION_MATCHES_WORKER");
    }
  } else if (reviewerSessionId !== context.reviewerSession.reviewerSessionId) {
    throw new Error("REVIEWER_SESSION_RESUME_MISMATCH");
  }
  return {
    reviewerSessionId,
    result: reviewResultSchema.parse(output.result)
  };
}
