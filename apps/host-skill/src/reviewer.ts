import {
  identifierSchema,
  reviewSubmissionSchema,
  type ReviewSubmission,
  type TaskCompletionReview
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
  reviewerSession: ReviewerSessionRequest;
  piSessionId: string;
}

export interface HostReviewOutput {
  reviewerSessionId: string;
  result: ReviewSubmission | TaskCompletionReview;
}

export interface TaskCompletionReviewTask {
  id: string;
  completionPercentage: number;
  reason?: string;
  suggestion?: string;
}

export interface TaskCompletionReviewOutput {
  reviewerSessionId: string;
  completionPercentage: number;
  tasks: TaskCompletionReviewTask[];
}

export type HostReviewCallbackOutput = HostReviewOutput | TaskCompletionReviewOutput;

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

function percentage(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100) {
    throw new Error("HOST_REVIEW_INVALID_OUTPUT");
  }
  return value as number;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("HOST_REVIEW_INVALID_OUTPUT");
  }
  return value.trim();
}

function validateTaskCompletionOutput(value: Record<string, unknown>): TaskCompletionReviewOutput {
  exactKeys(value, ["reviewerSessionId", "completionPercentage", "tasks"]);
  const reviewerSessionId = identifierSchema.parse(value.reviewerSessionId);
  const completionPercentage = percentage(value.completionPercentage);
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new Error("HOST_REVIEW_INVALID_OUTPUT");
  }
  const tasks = value.tasks.map((candidate): TaskCompletionReviewTask => {
    const task = record(candidate);
    exactKeys(task, ["id", "completionPercentage", "reason", "suggestion"]);
    const id = nonEmptyString(task.id);
    if (!/^T\d{3,}$/u.test(id)) throw new Error("HOST_REVIEW_INVALID_OUTPUT");
    const taskPercentage = percentage(task.completionPercentage);
    if (taskPercentage === 100) {
      if (task.reason !== undefined || task.suggestion !== undefined) {
        throw new Error("HOST_REVIEW_INVALID_OUTPUT");
      }
      return { id, completionPercentage: taskPercentage };
    }
    return {
      id,
      completionPercentage: taskPercentage,
      reason: nonEmptyString(task.reason),
      suggestion: nonEmptyString(task.suggestion)
    };
  });
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error("HOST_REVIEW_INVALID_OUTPUT");
  }
  const average = Math.round(
    tasks.reduce((total, task) => total + task.completionPercentage, 0) / tasks.length
  );
  if (completionPercentage !== average) throw new Error("HOST_REVIEW_INVALID_OUTPUT");
  return { reviewerSessionId, completionPercentage, tasks };
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
  const compact = "result" in output ? undefined : validateTaskCompletionOutput(output);
  const reviewerSessionId = compact?.reviewerSessionId ??
    identifierSchema.parse(output.reviewerSessionId);
  if (context.reviewerSession.mode === "CREATE") {
    if (reviewerSessionId === context.piSessionId) {
      throw new Error("REVIEWER_SESSION_MATCHES_WORKER");
    }
  } else if (reviewerSessionId !== context.reviewerSession.reviewerSessionId) {
    throw new Error("REVIEWER_SESSION_RESUME_MISMATCH");
  }
  if (compact === undefined) {
    return {
      reviewerSessionId,
      result: reviewSubmissionSchema.parse(output.result)
    };
  }
  return {
    reviewerSessionId,
    result: {
      completionPercentage: compact.completionPercentage,
      tasks: compact.tasks
    }
  };
}
