import { randomUUID } from "node:crypto";

import type { ArtifactRef } from "@smartflow/protocol";

import { verifyReviewBundle, type ReviewBundle } from "./review-bundle.js";

export interface ReviewHostAction {
  type: "REVIEW";
  actionId: string;
  revision: number;
  reviewBundle: ArtifactRef;
  reviewBundleHash: string;
  reviewAttemptId: string;
  taskSource: ArtifactRef;
  approvedSourceHash: string;
  changedPaths: string[];
  reviewerSession:
    | { mode: "CREATE" }
    | { mode: "RESUME"; reviewerSessionId: string };
  piSessionId: string;
  expiresAt: string;
}

export function createReviewHostAction(
  bundle: ReviewBundle,
  artifact: ArtifactRef,
  expiresAt: string,
  context: {
    taskSource: ArtifactRef;
    approvedSourceHash: string;
    piSessionId: string;
    boundReviewerSessionId?: string;
  }
): ReviewHostAction {
  if (
    !verifyReviewBundle(bundle) ||
    Date.parse(expiresAt) <= Date.now() ||
    context.approvedSourceHash !== bundle.taskManifest.sourceHash ||
    context.taskSource.sha256.replace(/^sha256:/u, "") !== bundle.taskManifest.taskSourceArtifact.sha256.replace(/^sha256:/u, "") ||
    context.piSessionId.length === 0 ||
    context.boundReviewerSessionId === context.piSessionId
  ) {
    throw new Error("REVIEW_ACTION_BINDING_INVALID");
  }
  return {
    type: "REVIEW",
    actionId: `review-action-${randomUUID()}`,
    revision: bundle.revision,
    reviewBundle: artifact,
    reviewBundleHash: bundle.bundleHash,
    reviewAttemptId: `review-attempt-${randomUUID()}`,
    taskSource: context.taskSource,
    approvedSourceHash: context.approvedSourceHash,
    changedPaths: bundle.changedPaths.map((path) => path.path),
    reviewerSession: context.boundReviewerSessionId === undefined
      ? { mode: "CREATE" }
      : { mode: "RESUME", reviewerSessionId: context.boundReviewerSessionId },
    piSessionId: context.piSessionId,
    expiresAt
  };
}
