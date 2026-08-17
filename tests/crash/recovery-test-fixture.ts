import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  operationsHash,
  stableOperationId,
  type ApplyOperation
} from "@smartflow/publish";
import type { RunPhase } from "@smartflow/protocol";
import {
  createReviewHostAction,
  evaluateReviewGate
} from "@smartflow/review";
import { frozenPiRuntimeConfig } from "@smartflow/provider-pi";
import { StateStore, canonicalHash, type RunRecord } from "@smartflow/state-store";
import { compileTaskManifest } from "@smartflow/task-manifest";
import {
  initializeGitObjectStore,
  type GitCandidate,
  type GitWorkspaceSnapshot
} from "@smartflow/workspace";
import {
  createProjectState,
  createRunRecord
} from "../fixtures/state-store/test-fixture.js";
import { createTasksSource } from "../fixtures/task-manifest/test-fixture.js";
import type { RuntimeHarness } from "../helpers/runtime-harness.js";

export async function createLifecycleStore(
  harness: RuntimeHarness,
  phase: RunPhase,
  overrides: Partial<RunRecord> = {},
  options: { dataDirectory?: string; projectId?: string } = {}
): Promise<StateStore> {
  const projectId = options.projectId ?? "project-1";
  const store = new StateStore(
    options.dataDirectory ?? resolve(harness.dataDir, `recovery-${phase.toLowerCase()}`)
  );
  await store.initialize(createProjectState({ canonicalProjectRoot: harness.projectDir }));

  const tasksSource = createTasksSource();
  const tasksPath = resolve(harness.projectDir, "tasks.md");
  await writeFile(tasksPath, tasksSource, "utf8");
  const compiled = compileTaskManifest(tasksSource, {
    projectId,
    jobId: "job-1",
    revision: 1,
    canonicalTaskPath: "tasks.md",
    providerRuntimeConfig: frozenPiRuntimeConfig({
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1",
      modelId: "test-model",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingLevel: "high",
      attemptDeadlineMs: 60_000,
      resourcePolicy: "workspace-project-resources"
    }),
    approval: {
      kind: "USER",
      approvedAt: "2026-07-20T00:00:00.000Z",
      parentRevision: null,
      authorizedCriterionIds: []
    }
  });
  const taskManifest = await store.writeArtifact(
    "runs/job-1/revision-1/task-manifest.json",
    compiled.artifactBytes
  );
  const taskSource = await store.writeArtifact(
    "runs/job-1/revision-1/task-source.md",
    Buffer.from(tasksSource, "utf8")
  );

  const sourceBytes = await readFile(resolve(harness.projectDir, "sum.js"));
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  const objectStore = await initializeGitObjectStore(
    resolve(store.dataDirectory, "runs/job-1")
  );
  const resultBlobId = execFileSync(
    "git",
    ["--git-dir", objectStore.gitDirectory, "hash-object", "-w", "--stdin"],
    { input: sourceBytes, encoding: "utf8" }
  ).trim();
  const objectDirectory = relative(store.dataDirectory, objectStore.objectDirectory)
    .split(sep)
    .join("/");
  const snapshotCreatedAt = "2026-07-20T00:00:00.000Z";
  const baselineBody = {
    repositoryId: "1".repeat(64),
    activeWorktreeRoot: ".",
    snapshotKind: "RUN_BASELINE" as const,
    revision: 1,
    treeId: "1".repeat(40),
    includedPathPolicyHash: "2".repeat(64),
    entries: []
  };
  const baseline: GitWorkspaceSnapshot = {
    schemaVersion: 1,
    ...baselineBody,
    snapshotHash: canonicalHash(baselineBody),
    createdAt: snapshotCreatedAt
  };
  const resultEntry = {
    path: "sum.js",
    kind: "FILE" as const,
    mode: "100644" as const,
    blobId: resultBlobId,
    sha256: sourceHash,
    size: sourceBytes.byteLength
  };
  const resultBody = {
    repositoryId: baseline.repositoryId,
    activeWorktreeRoot: ".",
    snapshotKind: "REVISION_RESULT" as const,
    revision: 1,
    treeId: "2".repeat(40),
    includedPathPolicyHash: baseline.includedPathPolicyHash,
    entries: [resultEntry]
  };
  const resultSnapshot: GitWorkspaceSnapshot = {
    schemaVersion: 1,
    ...resultBody,
    snapshotHash: canonicalHash(resultBody),
    createdAt: snapshotCreatedAt
  };
  const operations = [{
      kind: "ADD" as const,
      path: "sum.js",
      newEntry: {
        path: "sum.js",
        kind: "FILE" as const,
        sha256: sourceHash,
        size: sourceBytes.byteLength,
        mode: 0o644
      }
    }];
  const evidenceBytes = Buffer.from(JSON.stringify({ fixture: "git-evidence" }), "utf8");
  const evidenceArtifactHash = createHash("sha256").update(evidenceBytes).digest("hex");
  const candidateHashBody = {
    revision: 1,
    runBaselineSnapshotHash: baseline.snapshotHash,
    inputSnapshotHash: baseline.snapshotHash,
    resultSnapshotHash: resultSnapshot.snapshotHash,
    operations,
    evidenceArtifactHash
  };
  const candidateHash = canonicalHash(candidateHashBody);
  const candidate: GitCandidate = {
    schemaVersion: 2,
    revision: 1,
    baselineHash: baseline.snapshotHash,
    operations,
    hash: candidateHash,
    runBaselineSnapshotHash: baseline.snapshotHash,
    inputSnapshotHash: baseline.snapshotHash,
    resultSnapshotHash: resultSnapshot.snapshotHash,
    runBaselineTreeId: baseline.treeId,
    inputTreeId: baseline.treeId,
    resultTreeId: resultSnapshot.treeId,
    blobs: { "sum.js": { oldBlobId: null, newBlobId: resultEntry.blobId } },
    modes: { "sum.js": { oldMode: null, newMode: resultEntry.mode } },
    evidenceArtifactHash,
    candidateHash
  };
  const baselineRef = await store.writeArtifact(
    "runs/job-1/revision-1/snapshots/baseline.json",
    Buffer.from(JSON.stringify(baseline), "utf8")
  );
  const resultSnapshotRef = await store.writeArtifact(
    "runs/job-1/revision-1/snapshots/result.json",
    Buffer.from(JSON.stringify(resultSnapshot), "utf8")
  );
  const incrementalPatchRef = await store.writeArtifact(
    "runs/job-1/revision-1/patches/incremental.patch",
    Buffer.from("+sum.js", "utf8")
  );
  const cumulativePatchRef = await store.writeArtifact(
    "runs/job-1/revision-1/patches/cumulative.patch",
    Buffer.from("+sum.js", "utf8")
  );
  const evidenceRef = await store.writeArtifact(
    "runs/job-1/revision-1/git-evidence/evidence.json",
    evidenceBytes
  );
  const candidateRef = await store.writeArtifact(
    "runs/job-1/revision-1/candidate.json",
    Buffer.from(JSON.stringify(candidate), "utf8")
  );

  const reviewAction = createReviewHostAction({
    revision: 1,
    taskSourceHash: taskSource.sha256.replace(/^sha256:/u, ""),
    candidateHash: candidate.hash,
    changedPaths: ["sum.js"],
    piSessionId: "pi-session-old"
  }, new Date(Date.now() + 60_000).toISOString());
  const reviewGate = evaluateReviewGate(
    {
      reviewAttemptId: "review-attempt-1",
      reviewerSessionId: "reviewer-session-1",
      piSessionId: "pi-session-old",
      changedPaths: ["sum.js"]
    },
    {
      verdict: "APPROVE",
      completionPercentage: 100,
      convergeFindings: [],
      adversarialFindings: [],
      pathCoverage: { "sum.js": "FULL" },
      residualRisks: []
    }
  );
  const reviewBody = {
    schemaVersion: 1 as const,
    revision: 1,
    claimId: "claim-old",
    reviewAttemptId: "review-attempt-1",
    taskSourceHash: taskSource.sha256.replace(/^sha256:/u, ""),
    candidateHash: candidate.hash,
    reviewerSessionId: "reviewer-session-1",
    piSessionId: "pi-session-old",
    gate: reviewGate
  };
  const reviewDecision = { ...reviewBody, reviewHash: canonicalHash(reviewBody) };
  const reviewRef = await store.writeArtifact(
    "runs/job-1/revision-1/reviews/review-attempt-1.json",
    Buffer.from(JSON.stringify(reviewDecision), "utf8")
  );
  const leaderBody = {
    schemaVersion: 1,
    revision: 1,
    reviewHash: reviewDecision.reviewHash,
    decision: "accept",
    repairItems: [],
    reason: "recovery fixture accepted",
    decidedAt: "2026-07-20T00:00:00.000Z"
  };
  const leaderDecision = { ...leaderBody, decisionHash: canonicalHash(leaderBody) };
  const leaderDecisionRef = await store.writeArtifact(
    `runs/job-1/revision-1/leader-decisions/${leaderDecision.decisionHash}.json`,
    Buffer.from(JSON.stringify(leaderDecision), "utf8")
  );

  const applyOperation: ApplyOperation = {
    path: "sum.js",
    type: "ADD",
    expectedOldKind: "ABSENT",
    expectedOldHash: null,
    expectedOldMode: null,
    newHash: sourceHash,
    newMode: 0o644,
    blobRef: {
      relativePath: `git-object-store/blobs/${resultBlobId}`,
      sha256: sourceHash,
      size: sourceBytes.byteLength
    }
  };
  const publishOperationsHash = operationsHash([applyOperation]);
  const publishOperationId = stableOperationId({
    projectId,
    jobId: "job-1",
    revision: 1,
    candidateHash: candidate.hash,
    reviewHash: reviewDecision.reviewHash,
    operationsHash: publishOperationsHash
  });

  const reviewClaimed = phase === "REVIEWING";
  const pendingAction = phase === "REVIEW_PENDING" || phase === "REVIEWING"
    ? {
        ...reviewAction,
        ...(reviewClaimed
          ? {
              claimId: "claim-old",
              hostTurnId: "host-turn-old",
              claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              claimStatus: "CLAIMED"
            }
          : {})
      }
    : undefined;
  const hasBaseline = phase !== "PREPARING";
  const hasCandidate = new Set<RunPhase>([
    "FIXING", "REVIEW_PENDING", "REVIEWING", "LEADER_DECISION",
    "READY_TO_PUBLISH", "PUBLISHING"
  ]).has(phase);
  const hasDecision = new Set<RunPhase>(["LEADER_DECISION", "READY_TO_PUBLISH", "PUBLISHING"])
    .has(phase);
  const hasLeader = phase === "READY_TO_PUBLISH" || phase === "PUBLISHING";
  const basePendingAction = pendingAction;
  const run = createRunRecord({
    phase,
    canonicalTaskPath: tasksPath,
    taskManifest,
    taskSource,
    approvedTasks: {
      path: tasksPath,
      sourceHash: compiled.manifest.sourceHash
    },
    ...(hasBaseline
      ? {
          baseline: baselineRef,
          gitWorkspace: {
            repositoryId: baseline.repositoryId,
            inclusionPolicyHash: baseline.includedPathPolicyHash,
            objectDirectory,
            runBaselineSnapshot: baselineRef,
            revisions: {
              "1": {
                revision: 1,
                indexPath: "runs/job-1/revision-1/result.index",
                workspacePath: "runs/job-1/revision-1/workspace",
                inputSnapshot: baselineRef,
                ...(hasCandidate
                  ? {
                      resultSnapshot: resultSnapshotRef,
                      candidate: candidateRef,
                      incrementalPatch: incrementalPatchRef,
                      cumulativePatch: cumulativePatchRef,
                      evidence: evidenceRef
                    }
                  : {})
              }
            }
          },
          workspace: {
            relativePath: "runs/job-1/revision-1/workspace",
            baselineHash: baseline.snapshotHash,
            generation: 3,
            sandboxId: "sandbox-1",
            mutable: true as const
          },
          workerAttempts: [{
            attemptId: "attempt-old",
            generation: 3,
            revision: 1,
            providerRuntimeConfigHash: compiled.manifest.providerRuntimeConfigHash,
            piSessionId: "pi-session-old",
            status: "RUNNING" as const,
            containmentId: "sandbox-1",
            processIdentity: { pid: 2_147_483_647, startToken: "test-process-start" },
            startedAt: "2026-07-20T00:00:00.000Z"
          }]
        }
      : {}),
    ...(hasCandidate ? { candidate: candidateRef } : {}),
    ...(basePendingAction === undefined ? {} : { pendingAction: basePendingAction }),
    ...(hasDecision
      ? {
          review: reviewRef,
          reviewHistory: [{
            reviewAttemptId: "review-attempt-1",
            reviewerSessionId: "reviewer-session-1",
            taskSourceHash: taskSource.sha256.replace(/^sha256:/u, ""),
            candidateHash: candidate.hash,
            reviewHash: reviewDecision.reviewHash
          }]
        }
      : {}),
    ...(hasLeader ? { leaderDecision: leaderDecisionRef } : {}),
    ...(phase === "PUBLISHING"
      ? {
          publish: {
            operationId: publishOperationId,
            operationsHash: publishOperationsHash,
            adapterId: "recovery-test-adapter",
            revision: 1,
            status: "SUBMITTED" as const
          }
        }
      : {}),
    ...(phase === "PAUSED"
      ? { pause: { code: "USER_INPUT_REQUIRED", resumeActions: ["resume", "cancel"] } }
      : {}),
    ...(phase === "CANCELING"
      ? { cancellation: { reason: "user", status: "REQUESTED" } }
      : {}),
    ...overrides,
    ...(basePendingAction !== undefined && overrides.pendingAction !== undefined
      ? { pendingAction: { ...basePendingAction, ...overrides.pendingAction } }
      : {})
  });
  await store.writeState(
    createProjectState({
      projectId,
      canonicalProjectRoot: harness.projectDir,
      stateVersion: 1,
      projectFence: 2,
      activeRunsByTaskPath: new Set<RunPhase>(["COMPLETED", "CANCELED", "FAILED"]).has(phase)
        ? {}
        : { [run.canonicalTaskPath]: "job-1" },
      runs: { "job-1": run }
    })
  );
  return store;
}
