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
  worktreePath: string;
  changedPaths: string[];
  reviewerSession: ReviewerSessionRequest;
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
  // Worker/Reviewer separation is enforced by the Daemon review gate; a caller
  // can only honor the RESUME binding it was handed.
  if (
    context.reviewerSession.mode === "RESUME" &&
    reviewerSessionId !== context.reviewerSession.reviewerSessionId
  ) {
    throw new Error("REVIEWER_SESSION_RESUME_MISMATCH");
  }
  return {
    reviewerSessionId,
    result: reviewResultSchema.parse(output.result)
  };
}
