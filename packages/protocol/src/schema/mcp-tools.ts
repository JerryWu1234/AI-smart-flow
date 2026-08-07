import { z } from "zod";

import {
  artifactRefSchema,
  identifierSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  sha256Schema,
  structuredErrorSchema
} from "./common.js";
import {
  hostActionSchema,
  repairItemSchema,
  runPhaseSchema,
  runSummarySchema
} from "./run-state.js";

const stateMutationSchema = z
  .object({
    requestId: identifierSchema,
    projectId: identifierSchema,
    jobId: identifierSchema,
    expectedRevision: positiveIntegerSchema,
    expectedStateVersion: nonNegativeIntegerSchema
  })
  .strict();

const mutationResultSchema = z
  .object({
    projectId: identifierSchema,
    jobId: identifierSchema,
    revision: positiveIntegerSchema,
    stateVersion: nonNegativeIntegerSchema,
    phase: runPhaseSchema
  })
  .strict();

function isProjectRelativePath(value: string): boolean {
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  ) return false;
  return !value.split(/[\\/]/u).includes("..");
}

export const tasksPathSchema = z
  .string()
  .min(1)
  .refine(isProjectRelativePath, { message: "TASKS_PATH_UNSAFE" });

export const executeInputSchema = z
  .object({
    projectRoot: z.string().min(1),
    tasksPath: tasksPathSchema,
    approvedSourceHash: sha256Schema,
    requestId: identifierSchema,
    expectedStateVersion: nonNegativeIntegerSchema.optional()
  })
  .strict();
export const executeOutputSchema = mutationResultSchema;

export const statusInputSchema = z
  .object({ projectId: identifierSchema, jobId: identifierSchema })
  .strict();
export const statusOutputSchema = runSummarySchema;

export const waitInputSchema = z
  .object({
    projectId: identifierSchema,
    jobId: identifierSchema,
    afterStateVersion: nonNegativeIntegerSchema,
    timeoutMs: z.number().int().min(0).max(30_000)
  })
  .strict();
export const waitOutputSchema = z
  .object({
    changed: z.boolean(),
    stateVersion: nonNegativeIntegerSchema,
    summary: runSummarySchema
  })
  .strict();

export const claimActionInputSchema = stateMutationSchema.extend({
  actionId: identifierSchema,
  hostTurnId: identifierSchema
});
export const claimedHostActionSchema = hostActionSchema.extend({
  worktreePath: z.string().min(1)
});
export const claimActionOutputSchema = z
  .object({
    claimId: identifierSchema,
    action: claimedHostActionSchema,
    stateVersion: nonNegativeIntegerSchema,
    expiresAt: z.iso.datetime({ offset: true })
  })
  .strict();

export const renewActionClaimInputSchema = stateMutationSchema.extend({
  actionId: identifierSchema,
  claimId: identifierSchema,
  hostTurnId: identifierSchema
});
export const renewActionClaimOutputSchema = mutationResultSchema.extend({
  phase: z.literal("REVIEWING"),
  expiresAt: z.iso.datetime({ offset: true })
});

const findingSchema = z
  .object({
    fingerprint: sha256Schema,
    code: z.string().min(1),
    criterionId: z.string().min(1).nullable(),
    path: z.string().min(1).nullable(),
    severity: z.enum(["P0", "P1", "P2"]),
    blocking: z.boolean(),
    summary: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1)
  })
  .strict();

export const reviewSubmissionSchema = z
  .object({
    verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCKED"]),
    completionPercentage: z.number().int().min(0).max(100),
    convergeFindings: z.array(findingSchema),
    adversarialFindings: z.array(findingSchema),
    pathCoverage: z.record(z.string(), z.enum(["FULL", "MISSING"])),
    residualRisks: z.array(z.string())
  })
  .strict();

const taskCompletionSchema = z
  .object({
    id: z.string().regex(/^T\d{3,}$/u),
    completionPercentage: z.number().int().min(0).max(100),
    reason: z.string().trim().min(1).optional(),
    suggestion: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((task, context) => {
    const hasGuidance = task.reason !== undefined && task.suggestion !== undefined;
    if ((task.completionPercentage === 100) === hasGuidance) {
      context.addIssue({
        code: "custom",
        message: "incomplete tasks require reason and suggestion; complete tasks require neither"
      });
    }
  });

export const taskCompletionReviewSchema = z
  .object({
    completionPercentage: z.number().int().min(0).max(100),
    tasks: z.array(taskCompletionSchema).min(1)
  })
  .strict()
  .superRefine((review, context) => {
    if (new Set(review.tasks.map((task) => task.id)).size !== review.tasks.length) {
      context.addIssue({ code: "custom", path: ["tasks"], message: "task ids must be unique" });
    }
    const average = Math.round(
      review.tasks.reduce((total, task) => total + task.completionPercentage, 0) /
        review.tasks.length
    );
    if (review.completionPercentage !== average) {
      context.addIssue({
        code: "custom",
        path: ["completionPercentage"],
        message: "completionPercentage must be the rounded task average"
      });
    }
  });

export const reviewSubmissionInputSchema = z.union([
  reviewSubmissionSchema,
  taskCompletionReviewSchema
]);

export const reviewResultSubmitInputSchema = stateMutationSchema.extend({
  claimId: identifierSchema,
  reviewAttemptId: identifierSchema,
  taskSourceHash: sha256Schema,
  candidateHash: sha256Schema,
  reviewerSessionId: identifierSchema,
  result: reviewSubmissionInputSchema
});
export const reviewResultSubmitOutputSchema = mutationResultSchema.extend({
  reviewHash: sha256Schema,
  reviewAttemptId: identifierSchema,
  reviewerSessionId: identifierSchema,
  result: reviewSubmissionSchema
});

export const reportHostUnavailableInputSchema = stateMutationSchema.extend({
  claimId: identifierSchema,
  hostUnavailableReason: z.string().min(1)
});
export const reportHostUnavailableOutputSchema = mutationResultSchema;
export const submitReviewInputSchema = z.union([
  reviewResultSubmitInputSchema,
  reportHostUnavailableInputSchema
]);
export const submitReviewOutputSchema = z.union([
  reviewResultSubmitOutputSchema,
  reportHostUnavailableOutputSchema
]);

export const submitLeaderDecisionInputSchema = stateMutationSchema.extend({
  reviewHash: sha256Schema,
  decision: z.enum(["accept", "repair", "pause"]),
  repairItems: z.array(repairItemSchema).default([]),
  reason: z.string().trim().min(1)
}).superRefine((input, context) => {
  const repairItemKeys = input.repairItems.map((item) => item.source === "reviewer"
    ? `reviewer:${item.findingFingerprint}`
    : `leader:${item.code}:${item.taskId}:${item.path ?? ""}`);
  if (new Set(repairItemKeys).size !== repairItemKeys.length) {
    context.addIssue({
      code: "custom",
      path: ["repairItems"],
      message: "repair items must be unique"
    });
  }
  if (input.decision === "repair" && input.repairItems.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["repairItems"],
      message: "repair requires at least one repair item"
    });
  }
  if (input.decision !== "repair" && input.repairItems.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["repairItems"],
      message: "only repair decisions may contain repair items"
    });
  }
});
export const submitLeaderDecisionOutputSchema = mutationResultSchema;

export const resumeActionSchema = z.enum([
  "approve_new_manifest_revision",
  "cancel",
  "resume",
  "retry_provider_probe",
  "retry_git_probe",
  "retry_provider",
  "resume_review_decision",
  "retry_host_review",
  "retry_publish",
  "retry_cancel",
  "retry",
  "restore_approved_tasks",
  "leader_append_repair_tasks",
  "inspect_processes",
  "inspect_recovery",
  "inspect_conflict",
  "inspect_repair_diff",
  "inspect_no_progress",
  "export_bundle"
]);

export const resumeInputSchema = stateMutationSchema.extend({
  resumeAction: resumeActionSchema,
  tasksPath: tasksPathSchema.optional(),
  approvedSourceHash: sha256Schema.optional(),
  approval: z
    .object({
      kind: z.enum(["USER", "LEADER_REPAIR"]),
      parentRevision: positiveIntegerSchema.nullable(),
      authorizedCriterionIds: z.array(z.string().min(1))
    })
    .strict()
    .optional()
});
export const resumeOutputSchema = mutationResultSchema;

export const cancelInputSchema = stateMutationSchema.extend({ reason: z.string().min(1) });
export const cancelOutputSchema = mutationResultSchema;

export const resultInputSchema = statusInputSchema;
export const repairDraftSchema = z
  .object({
    sourceArtifact: artifactRefSchema,
    sourceHash: sha256Schema,
    suggestedTasksPath: z.string().min(1),
    appendText: z.string().min(1),
    addedTaskLines: z.array(z.string().min(1)).min(1),
    reasons: z.array(z.string().min(1)),
    approval: z
      .object({
        kind: z.enum(["USER", "LEADER_REPAIR"]),
        parentRevision: positiveIntegerSchema.nullable(),
        authorizedCriterionIds: z.array(z.string().min(1))
      })
      .strict()
  })
  .strict();
export const publishOutcomeSchema = z
  .object({
    operationId: z.string().min(1),
    operationsHash: sha256Schema,
    adapterId: z.string().min(1),
    status: z.enum(["PREPARED", "SUBMITTED", "COMMITTED", "CONFLICT", "UNKNOWN"]),
    result: z
      .object({
        operationId: z.string().min(1),
        operationsHash: sha256Schema,
        status: z.enum(["COMMITTED", "CONFLICT", "PARTIAL", "UNKNOWN"]),
        paths: z.array(z.object({
          path: z.string().min(1),
          status: z.enum(["COMMITTED", "CONFLICT", "UNRESOLVED"]),
          observedHash: sha256Schema.nullable(),
          observedMode: z.number().int().nullable()
        }).strict())
      })
      .strict()
      .optional()
  })
  .strict();
export const publishPrecheckSchema = z
  .object({
    conflicts: z.array(z.object({
      path: z.string().min(1),
      reason: z.enum([
        "EXPECTED_ABSENT",
        "EXPECTED_FILE",
        "HASH_MISMATCH",
        "MODE_MISMATCH",
        "UNSAFE_PATH"
      ])
    }).strict()).min(1),
    publishedCount: z.literal(0),
    totalCount: z.number().int().positive(),
    activeWorkspaceChanged: z.literal(false)
  })
  .strict();
export const resultOutputSchema = z
  .object({
    projectId: identifierSchema,
    jobId: identifierSchema,
    phase: runPhaseSchema,
    status: z.enum([
      "RUNNING",
      "PAUSED",
      "COMMITTED",
      "BUNDLE_READY",
      "PRECHECK_CONFLICT",
      "PUBLISH_RECOVERY_BLOCKED",
      "FAILED",
      "CANCELED"
    ]),
    artifacts: z.array(artifactRefSchema),
    nextActions: z.array(z.string().min(1)),
    repairDraft: repairDraftSchema.optional(),
    publishOutcome: publishOutcomeSchema.optional(),
    publishPrecheck: publishPrecheckSchema.optional(),
    error: structuredErrorSchema.optional()
  })
  .strict();

export const mcpToolSchemas = {
  smartflow_execute: { input: executeInputSchema, output: executeOutputSchema },
  smartflow_status: { input: statusInputSchema, output: statusOutputSchema },
  smartflow_wait: { input: waitInputSchema, output: waitOutputSchema },
  smartflow_claim_action: { input: claimActionInputSchema, output: claimActionOutputSchema },
  smartflow_renew_action_claim: {
    input: renewActionClaimInputSchema,
    output: renewActionClaimOutputSchema
  },
  smartflow_submit_review: { input: submitReviewInputSchema, output: submitReviewOutputSchema },
  smartflow_submit_leader_decision: {
    input: submitLeaderDecisionInputSchema,
    output: submitLeaderDecisionOutputSchema
  },
  smartflow_resume: { input: resumeInputSchema, output: resumeOutputSchema },
  smartflow_cancel: { input: cancelInputSchema, output: cancelOutputSchema },
  smartflow_result: { input: resultInputSchema, output: resultOutputSchema }
} as const;

export type ExecuteInput = z.infer<typeof executeInputSchema>;
export type ExecuteOutput = z.infer<typeof executeOutputSchema>;
export type StatusInput = z.infer<typeof statusInputSchema>;
export type StatusOutput = z.infer<typeof statusOutputSchema>;
export type WaitInput = z.infer<typeof waitInputSchema>;
export type WaitOutput = z.infer<typeof waitOutputSchema>;
export type ClaimActionInput = z.infer<typeof claimActionInputSchema>;
export type ClaimActionOutput = z.infer<typeof claimActionOutputSchema>;
export type RenewActionClaimInput = z.infer<typeof renewActionClaimInputSchema>;
export type RenewActionClaimOutput = z.infer<typeof renewActionClaimOutputSchema>;
export type SubmitReviewInput = z.infer<typeof submitReviewInputSchema>;
export type ReviewResultSubmitInput = z.infer<typeof reviewResultSubmitInputSchema>;
export type SubmitReviewOutput = z.infer<typeof submitReviewOutputSchema>;
export type ReviewResultSubmitOutput = z.infer<typeof reviewResultSubmitOutputSchema>;
export type ReportHostUnavailableInput = z.infer<typeof reportHostUnavailableInputSchema>;
export type ReportHostUnavailableOutput = z.infer<typeof reportHostUnavailableOutputSchema>;
export type ReviewSubmission = z.infer<typeof reviewSubmissionSchema>;
export type TaskCompletionReview = z.infer<typeof taskCompletionReviewSchema>;
export type SubmitLeaderDecisionInput = z.infer<typeof submitLeaderDecisionInputSchema>;
export type SubmitLeaderDecisionOutput = z.infer<typeof submitLeaderDecisionOutputSchema>;
export type ResumeInput = z.infer<typeof resumeInputSchema>;
export type ResumeOutput = z.infer<typeof resumeOutputSchema>;
export type CancelInput = z.infer<typeof cancelInputSchema>;
export type CancelOutput = z.infer<typeof cancelOutputSchema>;
export type ResultInput = z.infer<typeof resultInputSchema>;
export type ResultOutput = z.infer<typeof resultOutputSchema>;
