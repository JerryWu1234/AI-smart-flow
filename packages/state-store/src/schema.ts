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

export const workspaceRefSchema = z
  .object({
    relativePath: z.string().min(1),
    baselineHash: z.string().regex(/^[a-f0-9]{64}$/u),
    generation: z.number().int().nonnegative(),
    sandboxId: z.string().min(1),
    mutable: z.literal(true)
  })
  .strict();

export const gitRevisionWorkspaceSchema = z.object({
  revision: z.number().int().positive(),
  indexPath: z.string().min(1),
  workspacePath: z.string().min(1),
  inputSnapshot: artifactRefSchema,
  resultSnapshot: artifactRefSchema.optional(),
  candidate: artifactRefSchema.optional(),
  incrementalPatch: artifactRefSchema.optional(),
  cumulativePatch: artifactRefSchema.optional(),
  evidence: artifactRefSchema.optional()
}).strict();

export const gitRunWorkspaceSchema = z.object({
  capability: artifactRefSchema,
  repositoryId: z.string().regex(/^[a-f0-9]{64}$/u),
  inclusionPolicyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  objectDirectory: z.string().min(1),
  runBaselineSnapshot: artifactRefSchema,
  revisions: z.record(z.string(), gitRevisionWorkspaceSchema)
}).strict();

export const publishAttemptSchema = z
  .object({
    operationId: z.string().min(1),
    operationsHash: z.string().regex(/^[a-f0-9]{64}$/u),
    adapterId: z.string().min(1),
    revision: z.number().int().positive(),
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

export const workerAttemptSchema = piWorkerAttemptSchema;

const hostTurnIdentitySchema = z.object({
  turnToken: z.string().min(1).max(256),
  hostTurnId: z.string().min(1).max(256),
  revision: z.number().int().positive(),
  startedAt: z.iso.datetime({ offset: true })
});

export const hostTurnSchema = z.discriminatedUnion("stage", [
  hostTurnIdentitySchema.extend({
    stage: z.literal("AWAITING_REVIEW"),
    reviewAttemptId: z.string().min(1),
    deadlineAt: z.iso.datetime({ offset: true })
  }).strict(),
  hostTurnIdentitySchema.extend({
    stage: z.literal("AWAITING_USER_INPUT"),
    pauseCode: z.string().min(1)
  }).strict()
]);

export const runRecordSchema = z
  .object({
    jobId: z.string().min(1),
    canonicalTaskPath: z.string().min(1),
    fence: z.number().int().positive(),
    phase: runPhaseSchema,
    revision: z.number().int().positive(),
    taskManifest: artifactRefSchema,
    taskSource: artifactRefSchema,
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
    if (run.gitWorkspace !== undefined) {
      const revisions = Object.values(run.gitWorkspace.revisions)
        .sort((left, right) => left.revision - right.revision);
      for (const [key, revision] of Object.entries(run.gitWorkspace.revisions)) {
        if (key !== String(revision.revision)) {
          context.addIssue({
            code: "custom",
            path: ["gitWorkspace", "revisions", key, "revision"],
            message: "Git Revision record key must equal its revision"
          });
        }
      }
      for (const [index, revision] of revisions.entries()) {
        const expectedInput = index === 0
          ? run.gitWorkspace.runBaselineSnapshot
          : revisions[index - 1]?.resultSnapshot;
        if (
          revision.revision !== index + 1 ||
          expectedInput === undefined ||
          !artifactRefsEqual(revision.inputSnapshot, expectedInput)
        ) {
          context.addIssue({
            code: "custom",
            path: ["gitWorkspace", "revisions", String(revision.revision), "inputSnapshot"],
            message: "Git Revision input must form an unbroken Baseline to Result chain"
          });
        }
      }
    }

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
      if (attempt.revision > run.revision) {
        context.addIssue({
          code: "custom",
          path: ["workerAttempts", index, "revision"],
          message: "Pi Attempt cannot target a future Revision"
        });
      }
      if (attempt.status === "PREPARING" || attempt.status === "RUNNING") {
        activeAttempts += 1;
        if (attempt.revision !== run.revision) {
          context.addIssue({
            code: "custom",
            path: ["workerAttempts", index, "revision"],
            message: "active Pi Attempt must target the current Revision"
          });
        }
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

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function migrateV4Run(value: unknown): unknown {
  const run = plainRecord(value);
  if (run === undefined) return value;
  const pendingSource = plainRecord(run.pendingAction);
  const pendingAction = pendingSource === undefined ? undefined : { ...pendingSource };
  if (pendingAction !== undefined) {
    delete pendingAction.claimId;
    delete pendingAction.hostTurnId;
    delete pendingAction.claimExpiresAt;
    delete pendingAction.claimStatus;
    delete pendingAction.status;
  }

  const legacyTurn = plainRecord(run.hostTurn);
  let hostTurn: Record<string, unknown> | undefined;
  if (legacyTurn?.stage === "AWAITING_USER_INPUT") {
    hostTurn = {
      stage: "AWAITING_USER_INPUT",
      turnToken: legacyTurn.turnToken,
      hostTurnId: legacyTurn.hostTurnId,
      revision: legacyTurn.revision,
      pauseCode: legacyTurn.pauseCode,
      startedAt: legacyTurn.startedAt
    };
  } else if (
    legacyTurn?.stage === "AWAITING_REVIEW" ||
    (legacyTurn?.stage === "CLAIMING" && run.phase === "REVIEWING")
  ) {
    const reviewAttemptId = nonEmptyString(legacyTurn.reviewAttemptId) ??
      nonEmptyString(pendingSource?.reviewAttemptId);
    if (reviewAttemptId !== undefined) {
      hostTurn = {
        stage: "AWAITING_REVIEW",
        turnToken: legacyTurn.turnToken,
        hostTurnId: legacyTurn.hostTurnId,
        revision: legacyTurn.revision,
        reviewAttemptId,
        startedAt: legacyTurn.startedAt,
        deadlineAt: legacyTurn.deadlineAt
      };
    }
  }

  const rest = { ...run };
  delete rest.hostTurn;
  delete rest.pendingAction;
  if (run.phase === "REVIEWING" && hostTurn === undefined) {
    return {
      ...rest,
      phase: "PAUSED",
      ...(pendingAction === undefined ? {} : { pendingAction }),
      pause: {
        code: "HOST_REVIEW_UNAVAILABLE",
        resumeActions: pendingAction?.type === "REVIEW"
          ? ["retry_host_review", "cancel"]
          : ["cancel"]
      },
      lastError: {
        code: "HOST_REVIEW_UNAVAILABLE",
        stage: "review",
        message: "Legacy Review ownership could not be migrated safely",
        retryable: pendingAction?.type === "REVIEW",
        nextActions: pendingAction?.type === "REVIEW"
          ? ["retry_host_review", "cancel"]
          : ["cancel"],
        artifacts: []
      }
    };
  }
  return {
    ...rest,
    ...(pendingAction === undefined ? {} : { pendingAction }),
    ...(hostTurn === undefined ? {} : { hostTurn })
  };
}

function migratePublishActions(value: unknown, pauseCode: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const canConfirm = pauseCode === "PUBLISH_ADAPTER_UNAVAILABLE" ||
    pauseCode === "PUBLISH_PRECHECK_CONFLICT";
  const migrated: unknown[] = [];
  for (const action of value as unknown[]) {
    if (action === "export_bundle") {
      if (canConfirm) migrated.push("confirm_manual_publish");
    } else {
      migrated.push(action);
    }
  }
  return [...new Set(migrated)];
}

function migrateV5Run(value: unknown): unknown {
  const run = plainRecord(value);
  if (run === undefined) return value;
  const migrated = { ...run };
  const hadLegacyPublishSource = Object.hasOwn(migrated, "deliveryBundle");
  delete migrated.deliveryBundle;

  const pause = plainRecord(migrated.pause);
  if (pause !== undefined) {
    migrated.pause = {
      ...pause,
      resumeActions: migratePublishActions(pause.resumeActions, pause.code)
    };
  }
  const lastError = plainRecord(migrated.lastError);
  if (lastError !== undefined) {
    migrated.lastError = {
      ...lastError,
      nextActions: migratePublishActions(lastError.nextActions, pause?.code)
    };
  }
  if (hadLegacyPublishSource && plainRecord(migrated.publish) !== undefined) {
    migrated.recovery = {
      ...(plainRecord(migrated.recovery) ?? {}),
      publishSourceMigration: {
        sourceSchemaVersion: 5,
        legacyOperationIdentity: true
      }
    };
  }
  return migrated;
}

function migrateProjectStateInput(value: unknown): unknown {
  let state = plainRecord(value);
  if (state?.schemaVersion === 4) {
    const runs = plainRecord(state.runs);
    state = {
      ...state,
      schemaVersion: 5,
      runs: runs === undefined
        ? state.runs
        : Object.fromEntries(
            Object.entries(runs).map(([jobId, run]) => [jobId, migrateV4Run(run)])
          )
    };
  }
  if (state?.schemaVersion !== 5) return state ?? value;
  const runs = plainRecord(state.runs);
  return {
    ...state,
    schemaVersion: 6,
    runs: runs === undefined
      ? state.runs
      : Object.fromEntries(
          Object.entries(runs).map(([jobId, run]) => [jobId, migrateV5Run(run)])
        )
  };
}

export const projectStateSchema = z.preprocess(
  migrateProjectStateInput,
  z.object({
    schemaVersion: z.literal(6),
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
  }));

export type WorkspaceRef = z.infer<typeof workspaceRefSchema>;
export type GitRevisionWorkspace = z.infer<typeof gitRevisionWorkspaceSchema>;
export type GitRunWorkspace = z.infer<typeof gitRunWorkspaceSchema>;
export type PublishAttempt = z.infer<typeof publishAttemptSchema>;
export type WorkerAttempt = z.infer<typeof workerAttemptSchema>;
export type HostTurn = z.infer<typeof hostTurnSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type ProjectState = z.infer<typeof projectStateSchema>;

export interface RunArtifactBinding {
  name: string;
  ref: ArtifactRef;
  revision: number;
  semantic:
    | "TASK_MANIFEST"
    | "TASK_SOURCE"
    | "GIT_CAPABILITY"
    | "GIT_SNAPSHOT"
    | "GIT_PATCH"
    | "GIT_EVIDENCE"
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
    revision: number,
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
    bindings.push({ name, ref: parsed.data, revision, semantic });
    return parsed.data;
  };

  add("taskManifest", run.taskManifest, run.revision, "TASK_MANIFEST", true);
  add("taskSource", run.taskSource, run.revision, "TASK_SOURCE", true);
  if (run.gitWorkspace !== undefined) {
    add("gitWorkspace.capability", run.gitWorkspace.capability, 1, "GIT_CAPABILITY", true);
    add("gitWorkspace.runBaselineSnapshot", run.gitWorkspace.runBaselineSnapshot, 1, "GIT_SNAPSHOT", true);
    for (const revision of Object.values(run.gitWorkspace.revisions)) {
      add(
        `gitWorkspace.revisions.${String(revision.revision)}.inputSnapshot`,
        revision.inputSnapshot,
        revision.revision === 1 ? 1 : revision.revision - 1,
        "GIT_SNAPSHOT",
        true
      );
      add(`gitWorkspace.revisions.${String(revision.revision)}.resultSnapshot`, revision.resultSnapshot, revision.revision, "GIT_SNAPSHOT", false);
      add(`gitWorkspace.revisions.${String(revision.revision)}.candidate`, revision.candidate, revision.revision, "CANDIDATE", false);
      add(`gitWorkspace.revisions.${String(revision.revision)}.incrementalPatch`, revision.incrementalPatch, revision.revision, "GIT_PATCH", false);
      add(`gitWorkspace.revisions.${String(revision.revision)}.cumulativePatch`, revision.cumulativePatch, revision.revision, "GIT_PATCH", false);
      add(`gitWorkspace.revisions.${String(revision.revision)}.evidence`, revision.evidence, revision.revision, "GIT_EVIDENCE", false);
    }
  }

  const requiresBaseline = new Set([
    "RUNNING", "FIXING", "REVIEW_PENDING", "REVIEWING", "LEADER_DECISION",
    "READY_TO_PUBLISH", "PUBLISHING", "COMPLETED"
  ]).has(run.phase);
  const requiresCandidate = new Set([
    "FIXING", "REVIEW_PENDING", "REVIEWING", "LEADER_DECISION",
    "READY_TO_PUBLISH", "PUBLISHING", "COMPLETED"
  ]).has(run.phase);
  const publishPaused = run.phase === "PAUSED" && (
    (run.pause?.code.startsWith("PUBLISH_") ?? false) ||
    run.pause?.code === "MANUAL_PUBLISH_TARGET_MISMATCH" ||
    run.pause?.code === "PROJECT_PUBLISH_BUSY"
  );
  const reviewPaused = run.phase === "PAUSED" && run.pause?.code === "HOST_REVIEW_UNAVAILABLE";
  const repairPaused = run.phase === "PAUSED" && (run.pause?.code.startsWith("REPAIR_") ?? false);
  const candidate = add("candidate", run.candidate, run.revision, "CANDIDATE", requiresCandidate || publishPaused || reviewPaused || repairPaused);
  add("baseline", run.baseline, 1, "BASELINE", requiresBaseline || publishPaused || reviewPaused || repairPaused);
  add("review", run.review, run.revision, "REVIEW", new Set(["LEADER_DECISION", "READY_TO_PUBLISH", "PUBLISHING", "COMPLETED"]).has(run.phase) || publishPaused);
  add("leaderDecision", run.leaderDecision, run.revision, "LEADER_DECISION", new Set(["READY_TO_PUBLISH", "PUBLISHING", "COMPLETED"]).has(run.phase) || publishPaused);

  const recovery = record(run.recovery);
  const repairDraft = record(recovery?.repairDraft);
  if (repairDraft !== undefined) {
    add("recovery.repairDraft.sourceArtifact", repairDraft.sourceArtifact, run.revision + 1, "REPAIR_SOURCE", true);
  }
  if (recovery !== undefined && Object.hasOwn(recovery, "untrustedSeedCandidate")) {
    const nested = add("recovery.untrustedSeedCandidate", recovery.untrustedSeedCandidate, run.revision, "CANDIDATE", true);
    if (nested !== undefined && (candidate === undefined || !artifactRefsEqual(nested, candidate))) {
      issues.push("ARTIFACT_BINDING_CONFLICT:recovery.untrustedSeedCandidate");
    }
  }

  for (const [index, attempt] of run.workerAttempts.entries()) {
    add(`workerAttempts[${String(index)}].sessionArtifact`, attempt.sessionArtifact, attempt.revision, "PI_SESSION", false);
  }
  for (const [index, artifact] of (run.lastError?.artifacts ?? []).entries()) {
    add(`lastError.artifacts[${String(index)}]`, artifact, run.revision, "ERROR_EVIDENCE", true);
  }
  return { bindings, issues };
}
