import { randomUUID } from "node:crypto";

import type { HostAction } from "@smartflow/protocol";

export function createReviewHostAction(
  context: {
    revision: number;
    taskSourceHash: string;
    candidateHash: string;
    changedPaths: string[];
    piSessionId: string;
    boundReviewerSessionId?: string;
  },
  expiresAt: string
): HostAction {
  if (
    context.revision < 1 ||
    !/^[a-f0-9]{64}$/u.test(context.taskSourceHash) ||
    !/^[a-f0-9]{64}$/u.test(context.candidateHash) ||
    Date.parse(expiresAt) <= Date.now() ||
    context.piSessionId.length === 0 ||
    context.boundReviewerSessionId === context.piSessionId
  ) {
    throw new Error("REVIEW_ACTION_BINDING_INVALID");
  }
  return {
    type: "REVIEW",
    actionId: `review-action-${randomUUID()}`,
    revision: context.revision,
    taskSourceHash: context.taskSourceHash,
    candidateHash: context.candidateHash,
    reviewAttemptId: `review-attempt-${randomUUID()}`,
    changedPaths: [...context.changedPaths],
    reviewerSession: context.boundReviewerSessionId === undefined
      ? { mode: "CREATE" }
      : { mode: "RESUME", reviewerSessionId: context.boundReviewerSessionId },
    piSessionId: context.piSessionId,
    expiresAt
  };
}
