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
  buildGitCandidate,
  initializeGitObjectStore,
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
      authorizedCriterionIds: []
    }
  });
  const taskManifest = await store.writeArtifact(
    "runs/job-1/task-manifest.json",
    compiled.artifactBytes
  );
  const taskSource = await store.writeArtifact(
    "runs/job-1/task-source.md",
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
    treeId: "1".repeat(40),
    includedPathPolicyHash: "2".repeat(64),
    entries: []
  };
  const baseline: GitWorkspaceSnapshot = {
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
    snapshotKind: "RUN_RESULT" as const,
    treeId: "2".repeat(40),
    includedPathPolicyHash: baseline.includedPathPolicyHash,
    entries: [resultEntry]
  };
  const resultSnapshot: GitWorkspaceSnapshot = {
    ...resultBody,
    snapshotHash: canonicalHash(resultBody),
    createdAt: snapshotCreatedAt
  };
  const { candidate } = await buildGitCandidate({
    runBaseline: baseline,
    runResult: resultSnapshot
  });
  const baselineBytes = Buffer.from(JSON.stringify(baseline), "utf8");
  const resultSnapshotBytes = Buffer.from(JSON.stringify(resultSnapshot), "utf8");
  const resultArtifactHash = createHash("sha256").update(resultSnapshotBytes).digest("hex");
  const baselineRef = await store.writeArtifact(
    "runs/job-1/snapshots/run-baseline.json",
    baselineBytes
  );
  const resultSnapshotRef = await store.writeArtifact(
    `runs/job-1/snapshots/run-result-${resultArtifactHash}.json`,
    resultSnapshotBytes
  );
  const candidateRef = await store.writeArtifact(
    `runs/job-1/candidates/candidate-${candidate.candidateHash}.json`,
    Buffer.from(JSON.stringify(candidate), "utf8")
  );

  const reviewAction = createReviewHostAction({
    taskSourceHash: taskSource.sha256.replace(/^sha256:/u, ""),
    candidateHash: candidate.candidateHash,
    changedPaths: ["sum.js"],
    piSessionId: "pi-session-old"
  }, new Date(Date.now() + 60_000).toISOString());
  const reviewGate = evaluateReviewGate(
    {
      reviewerSessionId: "reviewer-session-1",
      piSessionId: "pi-session-old"
    },
    {
      tasks: [{ id: "T001", completionPercentage: 100, issues: [] }]
    }
  );
  const reviewBody = {
    claimId: "claim-old",
    reviewAttemptId: "review-attempt-1",
    taskSourceHash: taskSource.sha256.replace(/^sha256:/u, ""),
    candidateHash: candidate.candidateHash,
    reviewerSessionId: "reviewer-session-1",
    piSessionId: "pi-session-old",
    gate: reviewGate
  };
  const reviewDecision = { ...reviewBody, reviewHash: canonicalHash(reviewBody) };
  const reviewRef = await store.writeArtifact(
    "runs/job-1/reviews/review-attempt-1.json",
    Buffer.from(JSON.stringify(reviewDecision), "utf8")
  );
  const leaderBody = {
    reviewHash: reviewDecision.reviewHash,
    decision: "accept",
    reason: "recovery fixture accepted",
    decidedAt: "2026-07-20T00:00:00.000Z"
  };
  const leaderDecision = { ...leaderBody, decisionHash: canonicalHash(leaderBody) };
  const leaderDecisionRef = await store.writeArtifact(
    `runs/job-1/leader-decisions/${leaderDecision.decisionHash}.json`,
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
    candidateHash: candidate.candidateHash,
    reviewHash: reviewDecision.reviewHash,
    operationsHash: publishOperationsHash
  });

  const pendingAction = phase === "REVIEW_PENDING" || phase === "REVIEWING"
    ? reviewAction
    : undefined;
  const hasBaseline = phase !== "PREPARING";
  const hasCandidate = new Set<RunPhase>([
    "FIXING", "REVIEW_PENDING", "REVIEWING", "READY_TO_PUBLISH", "PUBLISHING"
  ]).has(phase);
  const hasDecision = new Set<RunPhase>(["READY_TO_PUBLISH", "PUBLISHING"]).has(phase);
  const hasLeader = phase === "READY_TO_PUBLISH" || phase === "PUBLISHING";
  const completedSessionArtifact = hasCandidate
    ? await store.writeArtifact(
        "runs/job-1/attempts/attempt-old/session-artifact.json",
        Buffer.from(JSON.stringify({
          jobId: "job-1",
          attemptId: "attempt-old",
          generation: 0,
          piSessionId: "pi-session-old",
          providerRuntimeConfigHash: compiled.manifest.providerRuntimeConfigHash,
          terminalStatus: "COMPLETED",
          sessionFileRelativePath: "sessions/pi-session-old.jsonl",
          sessionJsonlBase64: Buffer.from(
            '{"type":"session","id":"pi-session-old"}\n',
            "utf8"
          ).toString("base64"),
          createdAt: "2026-07-20T00:00:00.000Z"
        }), "utf8")
      )
    : undefined;
  const basePendingAction = pendingAction;
  const run = createRunRecord({
    phase,
    canonicalTaskPath: tasksPath,
    taskManifest,
    taskSource,
    approvedTasks: {
      path: resolve(store.dataDirectory, taskSource.relativePath),
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
            current: {
              indexPath: "runs/job-1/current.index",
              workspacePath: "runs/job-1/workspace",
              inputSnapshot: baselineRef,
              ...(hasCandidate
                ? {
                    resultSnapshot: resultSnapshotRef,
                    candidate: candidateRef
                  }
                : {})
            }
          },
          workspace: {
            relativePath: "runs/job-1/workspace"
          },
          workerAttempts: [{
            attemptId: "attempt-old",
            generation: 0,
            providerRuntimeConfigHash: compiled.manifest.providerRuntimeConfigHash,
            piSessionId: "pi-session-old",
            startedAt: "2026-07-20T00:00:00.000Z",
            ...(completedSessionArtifact === undefined
              ? {
                  status: "RUNNING" as const,
                  containmentId: "sandbox-1",
                  processIdentity: {
                    pid: 2_147_483_647,
                    startToken: "test-process-start"
                  }
                }
              : {
                  status: "COMPLETED" as const,
                  sessionArtifact: completedSessionArtifact,
                  endedAt: "2026-07-20T00:01:00.000Z"
                })
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
            candidateHash: candidate.candidateHash,
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
            status: "SUBMITTED" as const
          }
        }
      : {}),
    ...(phase === "PAUSED"
      ? { pause: { code: "USER_INPUT_REQUIRED", resumeActions: ["cancel"] } }
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
