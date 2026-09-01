import {
  artifactRefSchema,
  artifactRefsEqual,
  type ArtifactRef
} from "@smartflow/protocol";
import type { RunRecord } from "@smartflow/state-store";

export interface ResolvedRepairContinuation {
  sourceAttemptId: string;
  prompt: string;
  workspaceSeedSnapshot: ArtifactRef;
  expectedPiSessionId: string;
  sessionArtifact: ArtifactRef;
}

function digest(value: string): string {
  return value.replace(/^sha256:/u, "");
}

export function resolveRepairContinuation(
  run: RunRecord
): ResolvedRepairContinuation | undefined {
  const value = run.recovery?.repairContinuation;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("REPAIR_CONTINUATION_INVALID");
  }
  const continuation = value as Record<string, unknown>;
  const workspaceSeedSnapshot = artifactRefSchema.safeParse(
    continuation.workspaceSeedSnapshot
  );
  const sessionArtifact = artifactRefSchema.safeParse(continuation.sessionArtifact);
  if (
    continuation.kind !== "PI_SESSION_REPAIR" ||
    continuation.jobId !== run.jobId ||
    typeof continuation.sourceAttemptId !== "string" ||
    continuation.sourceAttemptId.length === 0 ||
    !Number.isInteger(continuation.sourceGeneration) ||
    typeof continuation.prompt !== "string" ||
    continuation.prompt.length === 0 ||
    typeof continuation.expectedPiSessionId !== "string" ||
    continuation.expectedPiSessionId.length === 0 ||
    typeof continuation.taskSourceHash !== "string" ||
    continuation.taskSourceHash !== digest(run.taskSource.sha256) ||
    typeof continuation.taskManifestHash !== "string" ||
    continuation.taskManifestHash !== digest(run.taskManifest.sha256) ||
    typeof continuation.providerRuntimeConfigHash !== "string" ||
    continuation.providerRuntimeConfigHash.length === 0 ||
    !workspaceSeedSnapshot.success ||
    !sessionArtifact.success ||
    run.recovery?.repairRound === undefined
  ) {
    throw new Error("REPAIR_CONTINUATION_INVALID");
  }
  const sourceAttempt = run.workerAttempts.find(
    (attempt) => attempt.attemptId === continuation.sourceAttemptId
  );
  if (
    sourceAttempt === undefined ||
    sourceAttempt.status !== "COMPLETED" ||
    sourceAttempt.generation !== continuation.sourceGeneration ||
    sourceAttempt.piSessionId !== continuation.expectedPiSessionId ||
    sourceAttempt.providerRuntimeConfigHash !== continuation.providerRuntimeConfigHash ||
    sourceAttempt.sessionArtifact === undefined ||
    !artifactRefsEqual(sourceAttempt.sessionArtifact, sessionArtifact.data)
  ) {
    throw new Error("REPAIR_CONTINUATION_SOURCE_INVALID");
  }
  return {
    sourceAttemptId: sourceAttempt.attemptId,
    prompt: continuation.prompt,
    workspaceSeedSnapshot: workspaceSeedSnapshot.data,
    expectedPiSessionId: sourceAttempt.piSessionId,
    sessionArtifact: sourceAttempt.sessionArtifact
  };
}

export function clearRepairContinuation(
  recovery: RunRecord["recovery"]
): RunRecord["recovery"] {
  if (recovery === undefined || !Object.hasOwn(recovery, "repairContinuation")) {
    return recovery;
  }
  const remaining = { ...recovery };
  delete remaining.repairContinuation;
  return Object.keys(remaining).length === 0 ? undefined : remaining;
}
