import { z } from "zod";

import {
  artifactRefSchema,
  artifactRefsEqual,
  canonicalValueSchema,
  idempotentReceiptSchema,
  piWorkerAttemptSchema,
  publishResultSchema,
  runPhaseSchema,
  structuredErrorSchema,
  type ArtifactRef
} from "@smartflow/protocol";

const workspaceRefSchema = z
  .object({
    relativePath: z.string().min(1)
  })
  .strict();

const gitCurrentWorkspaceSchema = z.object({
  indexPath: z.string().min(1),
  workspacePath: z.string().min(1),
  inputSnapshot: artifactRefSchema,
  resultSnapshot: artifactRefSchema.optional(),
  candidate: artifactRefSchema.optional()
}).strict();

const gitRunWorkspaceSchema = z.object({
  repositoryId: z.string().regex(/^[a-f0-9]{64}$/u),
  inclusionPolicyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  objectDirectory: z.string().min(1),
  runBaselineSnapshot: artifactRefSchema,
  current: gitCurrentWorkspaceSchema
}).strict();

const publishAttemptSchema = z
  .object({
    operationId: z.string().min(1),
    operationsHash: z.string().regex(/^[a-f0-9]{64}$/u),
    adapterId: z.string().min(1),
    status: z.enum(["PREPARED", "SUBMITTED", "COMMITTED", "CONFLICT", "UNKNOWN"]),
    result: publishResultSchema.optional()
  })
  .strict()
  .superRefine((attempt, context) => {
    const terminal = new Set(["COMMITTED", "CONFLICT", "UNKNOWN"]).has(attempt.status);
    if (terminal !== (attempt.result !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: terminal
          ? `${attempt.status} publish attempt requires a complete result`
          : `${attempt.status} publish attempt cannot contain a result`
      });
      return;
    }
    const result = attempt.result;
    if (result === undefined) return;
    if (
      result.operationId !== attempt.operationId ||
      result.operationsHash !== attempt.operationsHash ||
      (attempt.status === "COMMITTED" && result.status !== "COMMITTED") ||
      (attempt.status === "CONFLICT" && result.status !== "CONFLICT")
    ) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "publish result does not match its durable attempt"
      });
    }
  });

const canonicalRecordSchema = z.record(z.string(), canonicalValueSchema);

const workerAttemptSchema = piWorkerAttemptSchema;

const hostTurnIdentitySchema = z.object({
  turnToken: z.string().min(1).max(256),
  hostTurnId: z.string().min(1).max(256),
  startedAt: z.iso.datetime({ offset: true })
});

const hostTurnSchema = z.discriminatedUnion("stage", [
  hostTurnIdentitySchema.extend({
    stage: z.literal("AWAITING_REVIEW"),
    hostTurnId: z.literal("daemon-reviewer"),
    reviewAttemptId: z.string().min(1),
    deadlineAt: z.iso.datetime({ offset: true })
  }).strict(),
  hostTurnIdentitySchema.extend({
    stage: z.literal("AWAITING_USER_INPUT"),
    pauseCode: z.string().min(1)
  }).strict()
]);

const runRecordSchema = z
  .object({
    jobId: z.string().min(1),
    canonicalTaskPath: z.string().min(1),
    fence: z.number().int().positive(),
    phase: runPhaseSchema,
    taskManifest: artifactRefSchema,
    taskSource: artifactRefSchema,
    reviewAdapterId: z.enum([
      "codex",
      "codex-desktop",
      "claude-code",
      "claude-code-desktop"
    ]),
    approvedTasks: canonicalRecordSchema.optional(),
    baseline: artifactRefSchema.optional(),
    gitWorkspace: gitRunWorkspaceSchema.optional(),
    workspace: workspaceRefSchema.optional(),
    workerAttempts: z.array(workerAttemptSchema),
    candidate: artifactRefSchema.optional(),
    pendingAction: canonicalRecordSchema.optional(),
    hostTurn: hostTurnSchema.optional(),
    review: artifactRefSchema.optional(),
    leaderDecision: artifactRefSchema.optional(),
    reviewHistory: z.array(canonicalRecordSchema).optional(),
    noProgressCount: z.number().int().nonnegative(),
    autoRepairRounds: z.number().int().nonnegative().optional(),
    publish: publishAttemptSchema.optional(),
    cancellation: canonicalRecordSchema.optional(),
    recovery: canonicalRecordSchema.optional(),
    pause: z
      .object({
        code: z.string().min(1),
        resumeActions: z.array(z.string().min(1))
      })
      .strict()
      .optional(),
    lastError: structuredErrorSchema.optional(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true })
  })
  .strict()
  .superRefine((run, context) => {
    const attemptIds = new Set<string>();
    let activeAttempts = 0;
    for (const [index, attempt] of run.workerAttempts.entries()) {
      if (attemptIds.has(attempt.attemptId)) {
        context.addIssue({
          code: "custom",
          path: ["workerAttempts", index, "attemptId"],
          message: "Pi Attempt IDs must be unique"
        });
      }
      attemptIds.add(attempt.attemptId);
      if (attempt.status === "PREPARING" || attempt.status === "RUNNING") {
        activeAttempts += 1;
      }
    }
    if (activeAttempts > 1) {
      context.addIssue({
        code: "custom",
        path: ["workerAttempts"],
        message: "Run cannot contain multiple active Pi Attempts"
      });
    }
  });

export const projectStateSchema = z.object({
    projectId: z.string().min(1),
    canonicalProjectRoot: z.string().min(1),
    stateVersion: z.number().int().nonnegative(),
    projectFence: z.number().int().nonnegative(),
    activeRunsByTaskPath: z.record(z.string().min(1), z.string().min(1)),
    publishLease: z.object({
      jobId: z.string().min(1),
      operationId: z.string().min(1),
      acquiredAt: z.iso.datetime({ offset: true })
    }).strict().nullable(),
    runs: z.record(z.string(), runRecordSchema),
    processedRequests: z.record(z.string(), idempotentReceiptSchema),
    updatedAt: z.iso.datetime({ offset: true })
  })
  .strict()
  .superRefine((state, context) => {
    for (const [runKey, run] of Object.entries(state.runs)) {
      if (runKey !== run.jobId) {
        context.addIssue({
          code: "custom",
          path: ["runs", runKey, "jobId"],
          message: "run record key must equal jobId"
        });
      }
    }
    const terminal = new Set(["COMPLETED", "CANCELED", "FAILED"]);
    for (const [taskPath, jobId] of Object.entries(state.activeRunsByTaskPath)) {
      const run = state.runs[jobId];
      if (run === undefined || run.canonicalTaskPath !== taskPath || terminal.has(run.phase)) {
        context.addIssue({
          code: "custom",
          path: ["activeRunsByTaskPath", taskPath],
          message: "active task binding must reference the matching nonterminal Run"
        });
      }
    }
    for (const run of Object.values(state.runs)) {
      if (!terminal.has(run.phase) && state.activeRunsByTaskPath[run.canonicalTaskPath] !== run.jobId) {
        context.addIssue({
          code: "custom",
          path: ["runs", run.jobId, "canonicalTaskPath"],
          message: "every nonterminal Run must own its canonical task binding"
        });
      }
    }
    if (state.publishLease !== null) {
      const leaseRun = state.runs[state.publishLease.jobId];
      if (
        leaseRun === undefined ||
        state.activeRunsByTaskPath[leaseRun.canonicalTaskPath] !== leaseRun.jobId
      ) {
        context.addIssue({
          code: "custom",
          path: ["publishLease", "jobId"],
          message: "Publish lease must reference an active Run"
        });
      }
    }
  });

export type WorkerAttempt = z.infer<typeof workerAttemptSchema>;
export type HostTurn = z.infer<typeof hostTurnSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type ProjectState = z.infer<typeof projectStateSchema>;

interface RunArtifactBinding {
  name: string;
  ref: ArtifactRef;
  semantic:
    | "TASK_MANIFEST"
    | "TASK_SOURCE"
    | "GIT_SNAPSHOT"
    | "BASELINE"
    | "CANDIDATE"
    | "REVIEW"
    | "LEADER_DECISION"
    | "REPAIR_SOURCE"
    | "PI_SESSION"
    | "ERROR_EVIDENCE";
}

export interface RunArtifactInventory {
  bindings: RunArtifactBinding[];
  issues: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function runArtifactInventory(run: RunRecord): RunArtifactInventory {
  const bindings: RunArtifactBinding[] = [];
  const issues: string[] = [];
  const add = (
    name: string,
    value: unknown,
    semantic: RunArtifactBinding["semantic"],
    required: boolean
  ): ArtifactRef | undefined => {
    if (value === undefined) {
      if (required) issues.push(`ARTIFACT_REF_MISSING:${name}`);
      return undefined;
    }
    const parsed = artifactRefSchema.safeParse(value);
    if (!parsed.success) {
      issues.push(`ARTIFACT_REF_INVALID:${name}`);
      return undefined;
    }
    bindings.push({ name, ref: parsed.data, semantic });
    return parsed.data;
  };

  add("taskManifest", run.taskManifest, "TASK_MANIFEST", true);
  add("taskSource", run.taskSource, "TASK_SOURCE", true);
  if (run.gitWorkspace !== undefined) {
    add("gitWorkspace.runBaselineSnapshot", run.gitWorkspace.runBaselineSnapshot, "GIT_SNAPSHOT", true);
    add("gitWorkspace.current.inputSnapshot", run.gitWorkspace.current.inputSnapshot, "GIT_SNAPSHOT", true);
    add("gitWorkspace.current.resultSnapshot", run.gitWorkspace.current.resultSnapshot, "GIT_SNAPSHOT", false);
    add("gitWorkspace.current.candidate", run.gitWorkspace.current.candidate, "CANDIDATE", false);
  }

  const requiresBaseline = new Set([
    "RUNNING", "FIXING", "REVIEW_PENDING", "REVIEWING",
    "READY_TO_PUBLISH", "PUBLISHING", "COMPLETED"
  ]).has(run.phase);
  const requiresCandidate = new Set([
    "FIXING", "REVIEW_PENDING", "REVIEWING",
    "READY_TO_PUBLISH", "PUBLISHING", "COMPLETED"
  ]).has(run.phase);
  const publishPaused = run.phase === "PAUSED" && (
    (run.pause?.code.startsWith("PUBLISH_") ?? false) ||
    run.pause?.code === "MANUAL_PUBLISH_TARGET_MISMATCH" ||
    run.pause?.code === "PROJECT_PUBLISH_BUSY"
  );
  const reviewPaused = run.phase === "PAUSED" && run.pause?.code === "HOST_REVIEW_UNAVAILABLE";
  const repairPaused = run.phase === "PAUSED" && (run.pause?.code.startsWith("REPAIR_") ?? false);
  const candidate = add("candidate", run.candidate, "CANDIDATE", requiresCandidate || publishPaused || reviewPaused || repairPaused);
  add("baseline", run.baseline, "BASELINE", requiresBaseline || publishPaused || reviewPaused || repairPaused);
  add("review", run.review, "REVIEW", false);
  add("leaderDecision", run.leaderDecision, "LEADER_DECISION", false);

  const recovery = record(run.recovery);
  const repairDraft = record(recovery?.repairDraft);
  if (repairDraft !== undefined) {
    add("recovery.repairDraft.sourceArtifact", repairDraft.sourceArtifact, "REPAIR_SOURCE", true);
  }
  if (recovery !== undefined && Object.hasOwn(recovery, "repairContinuation")) {
    const repairContinuation = record(recovery.repairContinuation);
    if (repairContinuation === undefined) {
      issues.push("ARTIFACT_REF_INVALID:recovery.repairContinuation.workspaceSeedSnapshot");
    } else {
      add(
        "recovery.repairContinuation.workspaceSeedSnapshot",
        repairContinuation.workspaceSeedSnapshot,
        "GIT_SNAPSHOT",
        true
      );
    }
  }
  if (recovery !== undefined && Object.hasOwn(recovery, "untrustedSeedCandidate")) {
    const nested = add("recovery.untrustedSeedCandidate", recovery.untrustedSeedCandidate, "CANDIDATE", true);
    if (nested !== undefined && (candidate === undefined || !artifactRefsEqual(nested, candidate))) {
      issues.push("ARTIFACT_BINDING_CONFLICT:recovery.untrustedSeedCandidate");
    }
  }

  for (const [index, attempt] of run.workerAttempts.entries()) {
    add(`workerAttempts[${String(index)}].sessionArtifact`, attempt.sessionArtifact, "PI_SESSION", false);
  }
  for (const [index, artifact] of (run.lastError?.artifacts ?? []).entries()) {
    add(`lastError.artifacts[${String(index)}]`, artifact, "ERROR_EVIDENCE", true);
  }
  return { bindings, issues };
}
