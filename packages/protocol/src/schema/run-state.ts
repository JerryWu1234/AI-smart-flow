import { z } from "zod";

import {
  artifactRefSchema,
  bareSha256Schema,
  identifierSchema,
  isoDateTimeSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  structuredErrorSchema
} from "./common.js";

export const runPhaseSchema = z.enum([
  "PREPARING",
  "RUNNING",
  "FIXING",
  "REVIEW_PENDING",
  "REVIEWING",
  "LEADER_DECISION",
  "READY_TO_PUBLISH",
  "PUBLISHING",
  "PAUSED",
  "CANCELING",
  "COMPLETED",
  "CANCELED",
  "FAILED"
]);

const nonEmptyStringSchema = z.string().min(1);
const stringArraySchema = z.array(nonEmptyStringSchema);
const uniqueStringArraySchema = stringArraySchema.superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "values must be unique" });
  }
});
export const processIdentitySchema = z
  .object({
    pid: positiveIntegerSchema,
    startToken: nonEmptyStringSchema
  })
  .strict();

export const piWorkerAttemptStatusSchema = z.enum([
  "PREPARING",
  "RUNNING",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "TIMED_OUT",
  "CANCELED"
]);

export const piWorkerAttemptSchema = z
  .object({
    attemptId: identifierSchema,
    revision: positiveIntegerSchema,
    generation: nonNegativeIntegerSchema,
    providerRuntimeConfigHash: bareSha256Schema,
    status: piWorkerAttemptStatusSchema,
    piSessionId: identifierSchema.optional(),
    containmentId: identifierSchema.optional(),
    processIdentity: processIdentitySchema.optional(),
    sessionArtifact: artifactRefSchema.optional(),
    terminalReason: nonEmptyStringSchema.optional(),
    startedAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema.optional()
  })
  .strict()
  .superRefine((attempt, context) => {
    const active = attempt.status === "RUNNING";
    if (active && (attempt.containmentId === undefined || attempt.processIdentity === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["containmentId"],
        message: "RUNNING Pi Attempt requires containment and process identity"
      });
    }
    const terminal = !new Set(["PREPARING", "RUNNING"]).has(attempt.status);
    if (terminal !== (attempt.endedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: terminal
          ? "terminal Pi Attempt requires endedAt"
          : "active Pi Attempt cannot contain endedAt"
      });
    }
  });

const reviewIssuePathSchema = z.string().trim().min(1).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
  "expected a safe project-relative path"
);

export const reviewIssueSchema = z
  .object({
    path: reviewIssuePathSchema,
    message: z.string().trim().min(1),
    suggestedFix: z.string().trim().min(1).nullable()
  })
  .strict();

export const taskIdSchema = z.string().regex(/^T\d{3,}$/u);

export const taskReviewSchema = z
  .object({
    id: taskIdSchema,
    completionPercentage: z.number().int().min(0).max(100),
    issues: z.array(reviewIssueSchema)
  })
  .strict()
  .superRefine((task, context) => {
    const complete = task.completionPercentage === 100;
    if (complete !== (task.issues.length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["issues"],
        message: "complete tasks require no issues; incomplete tasks require at least one issue"
      });
    }
    const issueKeys = task.issues.map((issue) => `${issue.path}\u0000${issue.message}`);
    if (new Set(issueKeys).size !== issueKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["issues"],
        message: "task issues must be unique by path and message"
      });
    }
  });

export const reviewResultSchema = z
  .object({
    tasks: z.array(taskReviewSchema).min(1)
  })
  .strict()
  .superRefine((review, context) => {
    if (new Set(review.tasks.map((task) => task.id)).size !== review.tasks.length) {
      context.addIssue({ code: "custom", path: ["tasks"], message: "task ids must be unique" });
    }
  });

export const durableReviewGateSchema = z
  .object({
    accepted: z.boolean(),
    allowedLeaderDecisions: z.array(z.enum(["accept", "repair", "pause"])),
    result: reviewResultSchema
  })
  .strict()
  .superRefine((gate, context) => {
    const accepted = gate.result.tasks.every((task) => task.completionPercentage === 100);
    const expected = accepted ? ["accept", "pause"] : ["repair", "pause"];
    if (JSON.stringify(gate.allowedLeaderDecisions) !== JSON.stringify(expected)) {
      context.addIssue({
        code: "custom",
        path: ["allowedLeaderDecisions"],
        message: "allowed Leader decisions do not match the gate outcome"
      });
    }
    if (gate.accepted !== accepted) {
      context.addIssue({
        code: "custom",
        path: ["accepted"],
        message: "accepted must match complete reviewed tasks"
      });
    }
  });

export const durableReviewDecisionSchema = z
  .object({
    schemaVersion: z.literal(2),
    revision: positiveIntegerSchema,
    claimId: identifierSchema,
    reviewAttemptId: identifierSchema,
    taskSourceHash: bareSha256Schema,
    candidateHash: bareSha256Schema,
    reviewerSessionId: identifierSchema,
    piSessionId: identifierSchema,
    gate: durableReviewGateSchema,
    reviewHash: bareSha256Schema
  })
  .strict();

export const durableLeaderDecisionSchema = z
  .object({
    schemaVersion: z.literal(2),
    revision: positiveIntegerSchema,
    reviewHash: bareSha256Schema,
    decision: z.enum(["accept", "repair", "pause"]),
    reason: z.string().trim().min(1),
    decidedAt: isoDateTimeSchema,
    decisionHash: bareSha256Schema
  })
  .strict();

export const publishPathResultSchema = z
  .object({
    path: nonEmptyStringSchema,
    status: z.enum(["COMMITTED", "CONFLICT", "UNRESOLVED"]),
    observedHash: bareSha256Schema.nullable(),
    observedMode: nonNegativeIntegerSchema.nullable()
  })
  .strict();

export const publishResultSchema = z
  .object({
    operationId: identifierSchema,
    operationsHash: bareSha256Schema,
    status: z.enum(["COMMITTED", "CONFLICT", "PARTIAL", "UNKNOWN"]),
    paths: z.array(publishPathResultSchema)
  })
  .strict()
  .superRefine((result, context) => {
    if (new Set(result.paths.map((path) => path.path)).size !== result.paths.length) {
      context.addIssue({ code: "custom", path: ["paths"], message: "publish paths must be unique" });
    }
    if (result.status === "COMMITTED" && result.paths.some((path) => path.status !== "COMMITTED")) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "COMMITTED publish result requires every path to be COMMITTED"
      });
    }
    if (
      result.status === "CONFLICT" &&
      result.paths.length > 0 &&
      result.paths.every((path) => path.status !== "CONFLICT")
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "CONFLICT publish result requires a conflicting path"
      });
    }
  });

export const hostActionSchema = z
    .object({
      type: z.literal("REVIEW"),
      actionId: identifierSchema,
      revision: positiveIntegerSchema,
      taskSourceHash: bareSha256Schema,
      candidateHash: bareSha256Schema,
      reviewAttemptId: identifierSchema,
      changedPaths: uniqueStringArraySchema,
      reviewerSession: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("CREATE") }).strict(),
        z.object({
          mode: z.literal("RESUME"),
          reviewerSessionId: identifierSchema
        }).strict()
      ]),
      piSessionId: identifierSchema,
      expiresAt: z.iso.datetime({ offset: true })
    })
    .strict();

export const runSummarySchema = z
  .object({
    projectId: identifierSchema,
    jobId: identifierSchema,
    phase: runPhaseSchema,
    revision: positiveIntegerSchema,
    stateVersion: nonNegativeIntegerSchema,
    pause: z
      .object({ code: z.string().min(1), resumeActions: z.array(z.string().min(1)) })
      .strict()
      .optional(),
    pendingAction: hostActionSchema.optional(),
    activeAttempt: piWorkerAttemptSchema.optional(),
    lastError: structuredErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.phase === "REVIEW_PENDING" || value.phase === "REVIEWING") &&
      value.pendingAction?.type !== "REVIEW"
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingAction"],
        message: `${value.phase} requires a bound REVIEW action`
      });
    }
  });

export type RunPhase = z.infer<typeof runPhaseSchema>;
export type ProcessIdentity = z.infer<typeof processIdentitySchema>;
export type PiWorkerAttemptStatus = z.infer<typeof piWorkerAttemptStatusSchema>;
export type PiWorkerAttempt = z.infer<typeof piWorkerAttemptSchema>;
export type ReviewIssue = z.infer<typeof reviewIssueSchema>;
export type TaskReview = z.infer<typeof taskReviewSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type DurableReviewGate = z.infer<typeof durableReviewGateSchema>;
export type DurableReviewDecision = z.infer<typeof durableReviewDecisionSchema>;
export type DurableLeaderDecision = z.infer<typeof durableLeaderDecisionSchema>;
export type PublishPathResult = z.infer<typeof publishPathResultSchema>;
export type PublishResult = z.infer<typeof publishResultSchema>;
export type HostAction = z.infer<typeof hostActionSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
