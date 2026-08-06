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

export const reviewFindingSchema = z
  .object({
    fingerprint: bareSha256Schema,
    code: nonEmptyStringSchema,
    criterionId: nonEmptyStringSchema.nullable(),
    path: nonEmptyStringSchema.nullable(),
    severity: z.enum(["P0", "P1", "P2"]),
    blocking: z.boolean(),
    summary: nonEmptyStringSchema,
    evidence: stringArraySchema.min(1)
  })
  .strict();

const reviewSubmissionPayloadSchema = z.object({
  verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCKED"]),
  completionPercentage: z.number().int().min(0).max(100),
  convergeFindings: z.array(reviewFindingSchema),
  adversarialFindings: z.array(reviewFindingSchema),
  pathCoverage: z.record(z.string(), z.enum(["FULL", "MISSING"])),
  residualRisks: z.array(z.string())
}).strict();

export const durableReviewGateSchema = z
  .object({
    accepted: z.boolean(),
    allowedLeaderDecisions: z.array(z.enum(["accept", "repair", "pause"])),
    result: reviewSubmissionPayloadSchema,
    reasons: z.array(z.enum([
      "VERDICT_NOT_APPROVE",
      "PATH_COVERAGE_INCOMPLETE",
      "BLOCKING_FINDINGS_PRESENT"
    ]))
  })
  .strict()
  .superRefine((gate, context) => {
    const expected = gate.reasons.length === 0
      ? ["accept", "repair", "pause"]
      : ["repair", "pause"];
    if (JSON.stringify(gate.allowedLeaderDecisions) !== JSON.stringify(expected)) {
      context.addIssue({
        code: "custom",
        path: ["allowedLeaderDecisions"],
        message: "allowed Leader decisions do not match the gate outcome"
      });
    }
    if (gate.accepted !== (gate.reasons.length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "accepted must match the absence of gate reasons"
      });
    }
  });

export const durableReviewDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: positiveIntegerSchema,
    claimId: identifierSchema,
    reviewAttemptId: identifierSchema,
    reviewBundleHash: bareSha256Schema,
    reviewerSessionId: identifierSchema,
    piSessionId: identifierSchema,
    gate: durableReviewGateSchema,
    reviewHash: bareSha256Schema
  })
  .strict();

const projectRelativeRepairPathSchema = z.string().trim().min(1).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
  "expected a safe project-relative path"
);

export const repairItemSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("reviewer"),
      findingFingerprint: bareSha256Schema
    })
    .strict(),
  z
    .object({
      source: z.literal("leader"),
      code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).max(256),
      taskId: z.string().regex(/^T\d{3,}$/u),
      path: projectRelativeRepairPathSchema.nullable(),
      reason: z.string().trim().min(1).max(4_096)
    })
    .strict()
]);

function repairItemKey(item: z.infer<typeof repairItemSchema>): string {
  return item.source === "reviewer"
    ? `reviewer:${item.findingFingerprint}`
    : `leader:${item.code}:${item.taskId}:${item.path ?? ""}`;
}

export const durableLeaderDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: positiveIntegerSchema,
    reviewHash: bareSha256Schema,
    decision: z.enum(["accept", "repair", "pause"]),
    repairItems: z.array(repairItemSchema),
    reason: z.string().trim().min(1),
    decidedAt: isoDateTimeSchema,
    decisionHash: bareSha256Schema
  })
  .strict()
  .superRefine((decision, context) => {
    if (new Set(decision.repairItems.map(repairItemKey)).size !== decision.repairItems.length) {
      context.addIssue({
        code: "custom",
        path: ["repairItems"],
        message: "repair items must be unique"
      });
    }
    if (decision.decision === "repair" && decision.repairItems.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["repairItems"],
        message: "repair requires at least one repair item"
      });
    }
    if (decision.decision !== "repair" && decision.repairItems.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["repairItems"],
        message: "only repair decisions may contain repair items"
      });
    }
  });

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
      reviewBundle: artifactRefSchema,
      reviewBundleHash: bareSha256Schema,
      reviewAttemptId: identifierSchema,
      taskSource: artifactRefSchema,
      approvedSourceHash: bareSha256Schema,
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
    progress: z
      .object({ completed: nonNegativeIntegerSchema, total: nonNegativeIntegerSchema })
      .strict(),
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
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type DurableReviewGate = z.infer<typeof durableReviewGateSchema>;
export type DurableReviewDecision = z.infer<typeof durableReviewDecisionSchema>;
export type DurableLeaderDecision = z.infer<typeof durableLeaderDecisionSchema>;
export type RepairItem = z.infer<typeof repairItemSchema>;
export type PublishPathResult = z.infer<typeof publishPathResultSchema>;
export type PublishResult = z.infer<typeof publishResultSchema>;
export type HostAction = z.infer<typeof hostActionSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
