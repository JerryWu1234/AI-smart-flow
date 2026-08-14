import { resolve } from "node:path";

import type { ResumeInput } from "@smartflow/protocol";
import { deriveRepairApproval } from "@smartflow/review";
import { canonicalHash, StateStore, type ProjectState, type RunRecord } from "@smartflow/state-store";
import { compileTaskManifest, sha256Bytes, taskManifestSchema } from "@smartflow/task-manifest";

export interface CreateApprovedRevisionInput {
  store: StateStore;
  state: ProjectState;
  run: RunRecord;
  sourceBytes: Uint8Array;
  sourcePath: string;
  expectedSourceHash: string;
  approval: NonNullable<ResumeInput["approval"]>;
  providerRuntimeConfig: Readonly<Record<string, unknown>>;
  resetAutoRepairRounds?: boolean;
  fail: (code: string, message: string) => never;
}

export async function createApprovedRevision(
  input: CreateApprovedRevisionInput
): Promise<RunRecord> {
  const {
    store,
    state,
    run,
    sourceBytes,
    sourcePath,
    expectedSourceHash,
    approval,
    providerRuntimeConfig,
    fail
  } = input;
  if (sha256Bytes(sourceBytes) !== expectedSourceHash.replace(/^sha256:/u, "")) {
    fail("APPROVED_SOURCE_DRIFT", "tasks source differs from approval");
  }
  if (approval.kind === "LEADER_REPAIR" && sourcePath !== run.canonicalTaskPath) {
    fail("REPAIR_TASKS_PATH_CHANGED", "Leader repair must update the same approved tasks.md");
  }
  const previous = taskManifestSchema.parse(JSON.parse(
    new TextDecoder().decode(await store.readArtifact(run.taskManifest))
  ));
  const provisional = compileTaskManifest(sourceBytes, {
    projectId: state.projectId,
    jobId: run.jobId,
    revision: run.revision + 1,
    canonicalTaskPath: previous.canonicalTaskPath,
    providerRuntimeConfig,
    allowNoChange: previous.allowNoChange,
    approval: {
      kind: approval.kind,
      approvedAt: new Date().toISOString(),
      parentRevision: approval.parentRevision,
      authorizedCriterionIds: approval.authorizedCriterionIds
    }
  });
  if (provisional.manifest.providerRuntimeConfigHash !== previous.providerRuntimeConfigHash) {
    fail(
      "PROVIDER_CONFIG_UNAVAILABLE",
      `Registered Provider configuration does not match ${previous.providerRuntimeConfigHash}`
    );
  }
  const derived = deriveRepairApproval(previous, provisional.manifest);
  if (
    approval.kind !== derived.kind ||
    (derived.kind === "LEADER_REPAIR" &&
      (approval.parentRevision !== derived.parentRevision ||
       canonicalHash(approval.authorizedCriterionIds) !==
         canonicalHash(derived.authorizedCriterionIds)))
  ) {
    fail(
      "REPAIR_APPROVAL_MISMATCH",
      derived.reasons.join(",") || "approval binding mismatch"
    );
  }
  const taskManifest = await store.writeArtifact(
    `runs/${run.jobId}/revision-${String(run.revision + 1)}/task-manifest.json`,
    provisional.artifactBytes
  );
  const taskSource = await store.writeArtifact(
    `runs/${run.jobId}/revision-${String(run.revision + 1)}/task-source.md`,
    sourceBytes
  );
  const timestamp = new Date().toISOString();
  return {
    jobId: run.jobId,
    canonicalTaskPath: run.canonicalTaskPath,
    fence: run.fence,
    phase: "PREPARING",
    revision: run.revision + 1,
    taskManifest,
    taskSource,
    baseline: run.baseline,
    gitWorkspace: run.gitWorkspace,
    approvedTasks: {
      path: resolve(store.dataDirectory, taskSource.relativePath),
      sourceHash: provisional.manifest.sourceHash
    },
    workerAttempts: run.workerAttempts,
    noProgressCount: run.noProgressCount,
    autoRepairRounds: input.resetAutoRepairRounds === true
      ? 0
      : (run.autoRepairRounds ?? 0),
    reviewHistory: run.reviewHistory,
    ...(run.recovery?.repairRound === undefined
      ? {}
      : {
          recovery: {
            repairRound: run.recovery.repairRound,
            parentRevision: run.revision
          }
        }),
    createdAt: run.createdAt,
    updatedAt: timestamp
  };
}
