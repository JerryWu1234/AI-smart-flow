import { z } from "zod";

import {
  artifactRefSchema,
  identifierSchema,
  nonNegativeIntegerSchema,
  sha256Schema,
  structuredErrorSchema
} from "./common.js";
import {
  reviewResultSchema,
  runPhaseSchema,
  runSummarySchema
} from "./run-state.js";

const stateMutationSchema = z
  .object({
    requestId: identifierSchema,
    projectId: identifierSchema,
    jobId: identifierSchema,
    expectedStateVersion: nonNegativeIntegerSchema
  })
  .strict();

const mutationResultSchema = z
  .object({
    projectId: identifierSchema,
    jobId: identifierSchema,
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

export const resumeActionSchema = z.enum([
  "cancel",
  "retry_provider_probe",
  "retry_git_probe",
  "retry_provider",
  "resume_review_decision",
  "retry_host_review",
  "retry_publish",
  "retry_cancel",
  "retry",
  "restore_approved_tasks",
  "confirm_manual_publish"
]);

export const resumeInputSchema = stateMutationSchema.extend({
  resumeAction: resumeActionSchema
});
export const resumeOutputSchema = mutationResultSchema;

export const cancelInputSchema = stateMutationSchema.extend({
  reason: z.string().min(1),
  hostTurnId: identifierSchema.optional()
});
export const cancelOutputSchema = mutationResultSchema;

export const resultInputSchema = statusInputSchema;
export const repairDraftSchema = z
  .object({
    sourceArtifact: artifactRefSchema,
    sourceHash: sha256Schema,
    baseTaskSourceHash: sha256Schema,
    baseTaskManifestHash: sha256Schema,
    suggestedTasksPath: z.string().min(1),
    appendText: z.string().min(1),
    addedTaskLines: z.array(z.string().min(1)).min(1),
    reasons: z.array(z.string().min(1))
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
      "MANUAL_PUBLISH_REQUIRED",
      "PRECHECK_CONFLICT",
      "PUBLISH_RECOVERY_BLOCKED",
      "FAILED",
      "CANCELED"
    ]),
    artifacts: z.array(artifactRefSchema),
    nextActions: z.array(z.string().min(1)),
    // The latest durable Review, so a caller reads per-Task completion and issues
    // without filesystem access to Artifacts. Absent until a Review is recorded.
    review: reviewResultSchema.optional(),
    repairDraft: repairDraftSchema.optional(),
    publishOutcome: publishOutcomeSchema.optional(),
    publishPrecheck: publishPrecheckSchema.optional(),
    error: structuredErrorSchema.optional()
  })
  .strict();

export const reviewTurnInputSchema = z
  .object({
    requestId: identifierSchema,
    projectId: identifierSchema,
    jobId: identifierSchema,
    hostTurnId: identifierSchema,
    turnToken: identifierSchema.optional(),
    answer: resumeActionSchema.optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.answer !== undefined && input.turnToken === undefined) {
      context.addIssue({
        code: "custom",
        path: ["turnToken"],
        message: "turnToken is required when submitting an answer"
      });
    }
  });

// The Host only polls daemon-owned stages and answers explicit user-input turns.
// Review identity, sessions, deadlines, and results remain internal to the Daemon.
const reviewTurnNotReadySchema = z.object({
  kind: z.literal("NOT_READY"),
  retryAfterMs: z.number().int().min(1).max(30_000)
}).strict();

const reviewTurnUserInputRequiredSchema = z.object({
  kind: z.literal("USER_INPUT_REQUIRED"),
  turnToken: identifierSchema,
  pause: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1)
    })
    .strict(),
  result: resultOutputSchema,
  options: z.array(z.object({
    answer: resumeActionSchema,
    description: z.string().min(1)
  }).strict()).min(1),
  worktreePath: z.string().min(1).optional()
}).strict();

const reviewTurnDoneSchema = z
  .object({
    kind: z.literal("DONE"),
    result: resultOutputSchema
  })
  .strict();

export const reviewTurnOutputSchema = z.discriminatedUnion("kind", [
  reviewTurnNotReadySchema,
  reviewTurnUserInputRequiredSchema,
  reviewTurnDoneSchema
]).superRefine((output, context) => {
  if (output.kind !== "USER_INPUT_REQUIRED" || output.worktreePath === undefined) return;
  const publishPause = output.pause.code.includes("PUBLISH") ||
    output.pause.code === "PROJECT_PUBLISH_BUSY" ||
    (output.pause.code === "RUNTIME_STAGE_FAILED" && output.result.error?.stage === "publish");
  if (!publishPause) {
    context.addIssue({
      code: "custom",
      path: ["worktreePath"],
      message: "worktreePath is allowed only for a publish-related pause"
    });
  }
});

export type ExecuteInput = z.infer<typeof executeInputSchema>;
export type ExecuteOutput = z.infer<typeof executeOutputSchema>;
export type ResumeInput = z.infer<typeof resumeInputSchema>;
export type CancelInput = z.infer<typeof cancelInputSchema>;
export type ResultOutput = z.infer<typeof resultOutputSchema>;
export type ReviewTurnInput = z.infer<typeof reviewTurnInputSchema>;
export type ReviewTurnOutput = z.infer<typeof reviewTurnOutputSchema>;
