import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DAEMON_REVIEWER_HOST_TURN_ID,
  PublishCoordinator,
  RecoveryManager,
  pendingReviewAction,
  type PublishRecoveryObservation,
  type RecoveryAction,
  type RecoveryRuntime
} from "@smartflow/daemon";
import type { PublishServiceResult } from "@smartflow/publish";
import type { RunPhase } from "@smartflow/protocol";
import { canonicalHash } from "@smartflow/state-store";
import type { Candidate, GitWorkspaceSnapshot } from "@smartflow/workspace";
import { gitPublishOperations } from "../../apps/daemon/src/publish/git-publish-source.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";
import { createLifecycleStore } from "./recovery-test-fixture.js";

const runtime: RecoveryRuntime = {
  inspectWorker: () => Promise.resolve("STOPPED"),
  reconcilePublish: (): Promise<PublishRecoveryObservation> => Promise.resolve({ status: "UNKNOWN" }),
  continueCancellation: () => Promise.resolve("BLOCKED")
};

function publishObservation(result: PublishServiceResult): PublishRecoveryObservation {
  if (result.status === "COMMITTED") return { status: "COMMITTED", result: result.result };
  if (result.status === "PUBLISH_RECOVERY_BLOCKED" && result.result?.status === "CONFLICT") {
    return { status: "CONFLICT", result: result.result };
  }
  return {
    status: "UNKNOWN",
    ...(result.status === "PUBLISH_RECOVERY_BLOCKED" ? { result: result.result } : {})
  };
}

function parseArtifact(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

async function putDaemonReviewingOwner(
  store: Awaited<ReturnType<typeof createLifecycleStore>>
): Promise<void> {
  const state = await store.readState();
  const run = state.runs["job-1"];
  if (run === undefined) throw new Error("Review recovery fixture has no run");
  const action = pendingReviewAction(run);
  if (action === undefined) throw new Error("Review recovery fixture has no pending action");
  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  await store.writeState({
    ...state,
    stateVersion: state.stateVersion + 1,
    runs: {
      ...state.runs,
      [run.jobId]: {
        ...run,
        phase: "REVIEWING",
        pendingAction: { ...action, expiresAt: deadlineAt },
        hostTurn: {
          stage: "AWAITING_REVIEW",
          turnToken: "durable-review-turn",
          hostTurnId: DAEMON_REVIEWER_HOST_TURN_ID,
          reviewAttemptId: action.reviewAttemptId,
          startedAt,
          deadlineAt
        },
        updatedAt: startedAt
      }
    },
    updatedAt: startedAt
  });
}

const stableActions: ReadonlyArray<[RunPhase, RecoveryAction]> = [
  ["PREPARING", "REBUILD_WORKSPACE"],
  ["FIXING", "PREPARE_REPAIR"],
  ["REVIEW_PENDING", "RUN_REVIEW"],
  ["READY_TO_PUBLISH", "RECHECK_PUBLISH_READINESS"],
  ["PAUSED", "NONE"]
];

const harnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("phase-complete crash recovery", () => {
  it.each(stableActions)("recovers %s deterministically as %s", async (phase, expectedAction) => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, phase);
    const before = await store.readState();

    const first = await new RecoveryManager(store, runtime).recover("job-1");
    const second = await new RecoveryManager(store, runtime).recover("job-1");
    expect(first.action).toBe(expectedAction);
    expect(second.action).toBe(expectedAction);
    expect((await store.readState()).stateVersion).toBe(before.stateVersion);
  });

  it("recovers a daemon-owned REVIEWING turn as RUN_REVIEW", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "REVIEW_PENDING");
    await putDaemonReviewingOwner(store);
    const before = await store.readState();

    const first = await new RecoveryManager(store, runtime).recover("job-1");
    const second = await new RecoveryManager(store, runtime).recover("job-1");

    expect(first).toMatchObject({ phase: "REVIEWING", action: "RUN_REVIEW" });
    expect(second).toMatchObject({ phase: "REVIEWING", action: "RUN_REVIEW" });
    expect((await store.readState()).stateVersion).toBe(before.stateVersion);
  });

  it("safely pauses REVIEWING when its durable Host turn is missing", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "REVIEWING");
    const before = await store.readState();

    const first = await new RecoveryManager(store, runtime).recover("job-1");
    expect(first).toMatchObject({
      phase: "PAUSED",
      action: "BLOCKED",
      reason: "HOST_REVIEW_UNAVAILABLE:REVIEW_TURN_STATE_MISSING"
    });
    const paused = await store.readState();
    expect(paused.stateVersion).toBe(before.stateVersion + 1);
    expect(paused.runs["job-1"]).toMatchObject({
      phase: "PAUSED",
      pause: { code: "HOST_REVIEW_UNAVAILABLE" }
    });

    expect(await new RecoveryManager(store, runtime).recover("job-1"))
      .toMatchObject({ phase: "PAUSED", action: "NONE" });
    expect((await store.readState()).stateVersion).toBe(paused.stateVersion);
  });

  it("reconciles default Publish completion atomically and cleans temporary Git content", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "PUBLISHING");
    const state = await store.readState();
    const run = state.runs["job-1"];
    const current = run?.gitWorkspace?.current;
    if (
      run?.publish === undefined ||
      run.candidate === undefined ||
      run.gitWorkspace === undefined ||
      current?.resultSnapshot === undefined
    ) throw new Error("publish cleanup fixture missing");
    const publish = { ...run.publish, adapterId: "filesystem-preflight-batch-v1" };
    const setupAt = new Date().toISOString();
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      publishLease: {
        jobId: run.jobId,
        operationId: publish.operationId,
        acquiredAt: setupAt
      },
      runs: {
        ...state.runs,
        [run.jobId]: { ...run, publish, updatedAt: setupAt }
      },
      updatedAt: setupAt
    });
    const beforeRecovery = await store.readState();
    const candidate = JSON.parse(
      new TextDecoder().decode(await store.readArtifact(run.candidate))
    ) as Candidate;
    const resultSnapshot = JSON.parse(
      new TextDecoder().decode(await store.readArtifact(current.resultSnapshot))
    ) as GitWorkspaceSnapshot;
    const operations = gitPublishOperations(candidate, resultSnapshot);
    const workspacePath = resolve(store.dataDirectory, current.workspacePath);
    const indexPath = resolve(store.dataDirectory, current.indexPath);
    const gitDirectory = dirname(resolve(store.dataDirectory, run.gitWorkspace.objectDirectory));
    await mkdir(workspacePath, { recursive: true });
    await writeFile(resolve(workspacePath, "temporary.txt"), "temporary", "utf8");
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, "index", "utf8");
    await mkdir(resolve(gitDirectory, "objects"), { recursive: true });
    const publishResult = {
      operationId: publish.operationId,
      operationsHash: publish.operationsHash,
      status: "COMMITTED" as const,
      paths: operations.map((operation) => ({
        path: operation.path,
        status: "COMMITTED" as const,
        observedHash: operation.newHash,
        observedMode: operation.newMode
      }))
    };
    const resultDirectory = resolve(store.dataDirectory, "publish-results");
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(
      resolve(resultDirectory, `${publish.operationId}.json`),
      JSON.stringify(publishResult),
      "utf8"
    );
    const coordinator = new PublishCoordinator(store);
    const committedRuntime: RecoveryRuntime = {
      ...runtime,
      reconcilePublish: async (operationId, operationHash) => publishObservation(
        await coordinator.recover(run.jobId, operationId, operationHash)
      )
    };

    await expect(new RecoveryManager(store, committedRuntime).recover(run.jobId))
      .resolves.toMatchObject({
        phase: "COMPLETED",
        action: "PUBLISH_RECONCILED",
        stateVersion: beforeRecovery.stateVersion + 1
      });
    const completed = await store.readState();
    expect(completed.stateVersion).toBe(beforeRecovery.stateVersion + 1);
    expect(completed.publishLease).toBeNull();
    expect(completed.activeRunsByTaskPath[run.canonicalTaskPath]).toBeUndefined();
    expect(completed.runs[run.jobId]?.publish).toEqual({
      ...publish,
      status: "COMMITTED",
      result: publishResult
    });
    await expect(access(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(gitDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.readArtifact(current.resultSnapshot)).resolves.toBeInstanceOf(Uint8Array);

    await expect(new RecoveryManager(store, committedRuntime).recover(run.jobId))
      .resolves.toMatchObject({ phase: "COMPLETED", action: "NONE" });
    expect((await store.readState()).stateVersion).toBe(completed.stateVersion);
  });

  it("blocks a Review whose body no longer matches reviewHash", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "READY_TO_PUBLISH");
    const state = await store.readState();
    const run = state.runs["job-1"];
    if (run?.review === undefined) throw new Error("review hash fixture missing");
    const review = parseArtifact(await store.readArtifact(run.review));
    const staleReviewRef = await store.writeArtifact(
      "runs/job-1/reviews/stale-review-hash.json",
      Buffer.from(JSON.stringify({ ...review, claimId: "claim-tampered" }), "utf8")
    );
    const updatedAt = new Date().toISOString();
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      runs: {
        ...state.runs,
        [run.jobId]: { ...run, review: staleReviewRef, updatedAt }
      },
      updatedAt
    });

    await expect(new RecoveryManager(store, runtime).recover(run.jobId)).resolves.toMatchObject({
      phase: "PAUSED",
      action: "BLOCKED",
      reason: "ARTIFACT_SEMANTIC_MISMATCH:review"
    });
  });

  it("blocks a Leader Decision whose body no longer matches decisionHash", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "READY_TO_PUBLISH");
    const state = await store.readState();
    const run = state.runs["job-1"];
    if (run?.leaderDecision === undefined) throw new Error("leader hash fixture missing");
    const decision = parseArtifact(await store.readArtifact(run.leaderDecision));
    const staleDecisionRef = await store.writeArtifact(
      "runs/job-1/leader-decisions/stale-decision-hash.json",
      Buffer.from(JSON.stringify({ ...decision, reason: "tampered after approval" }), "utf8")
    );
    const updatedAt = new Date().toISOString();
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      runs: {
        ...state.runs,
        [run.jobId]: { ...run, leaderDecision: staleDecisionRef, updatedAt }
      },
      updatedAt
    });

    await expect(new RecoveryManager(store, runtime).recover(run.jobId)).resolves.toMatchObject({
      phase: "PAUSED",
      action: "BLOCKED",
      reason: "ARTIFACT_SEMANTIC_MISMATCH:leaderDecision"
    });
  });

  it("blocks a canonical non-accept Leader Decision on the publish path", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "READY_TO_PUBLISH");
    const state = await store.readState();
    const run = state.runs["job-1"];
    if (run?.leaderDecision === undefined) throw new Error("publish approval fixture missing");
    const decisionBody = parseArtifact(await store.readArtifact(run.leaderDecision));
    delete decisionBody.decisionHash;
    decisionBody.decision = "pause";
    decisionBody.reason = "leader paused before publish";
    const pausedDecision = {
      ...decisionBody,
      decisionHash: canonicalHash(decisionBody)
    };
    const pausedDecisionRef = await store.writeArtifact(
      `runs/job-1/leader-decisions/${pausedDecision.decisionHash}.json`,
      Buffer.from(JSON.stringify(pausedDecision), "utf8")
    );
    const updatedAt = new Date().toISOString();
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      runs: {
        ...state.runs,
        [run.jobId]: { ...run, leaderDecision: pausedDecisionRef, updatedAt }
      },
      updatedAt
    });

    await expect(new RecoveryManager(store, runtime).recover(run.jobId)).resolves.toMatchObject({
      phase: "PAUSED",
      action: "BLOCKED",
      reason: "ARTIFACT_SEMANTIC_MISMATCH:leaderDecision"
    });
  });

  it("allows canonical repair evidence while recovering FIXING", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "READY_TO_PUBLISH");
    const state = await store.readState();
    const run = state.runs["job-1"];
    if (run?.review === undefined || run.leaderDecision === undefined) {
      throw new Error("repair evidence fixture missing");
    }
    const reviewBody = parseArtifact(await store.readArtifact(run.review));
    const reviewAttemptId = reviewBody.reviewAttemptId;
    delete reviewBody.reviewHash;
    const gate = reviewBody.gate as Record<string, unknown>;
    reviewBody.gate = {
      ...gate,
      accepted: false,
      allowedLeaderDecisions: ["repair", "pause"],
      result: {
        tasks: [{
          id: "T001",
          completionPercentage: 50,
          issues: [{
            path: "sum.js",
            message: "sum does not implement the requested review change",
            suggestedFix: null
          }]
        }]
      }
    };
    const repairReview = { ...reviewBody, reviewHash: canonicalHash(reviewBody) };
    const repairReviewRef = await store.writeArtifact(
      "runs/job-1/reviews/repair-review.json",
      Buffer.from(JSON.stringify(repairReview), "utf8")
    );
    const leaderBody = parseArtifact(await store.readArtifact(run.leaderDecision));
    delete leaderBody.decisionHash;
    leaderBody.reviewHash = repairReview.reviewHash;
    leaderBody.decision = "repair";
    leaderBody.reason = "repair before another review";
    const repairDecision = { ...leaderBody, decisionHash: canonicalHash(leaderBody) };
    const repairDecisionRef = await store.writeArtifact(
      `runs/job-1/leader-decisions/${repairDecision.decisionHash}.json`,
      Buffer.from(JSON.stringify(repairDecision), "utf8")
    );
    const updatedAt = new Date().toISOString();
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      runs: {
        ...state.runs,
        [run.jobId]: {
          ...run,
          phase: "FIXING",
          review: repairReviewRef,
          leaderDecision: repairDecisionRef,
          reviewHistory: run.reviewHistory?.map((entry) => ({
            ...entry,
            reviewHash: entry.reviewAttemptId === reviewAttemptId
              ? repairReview.reviewHash
              : entry.reviewHash
          })),
          updatedAt
        }
      },
      updatedAt
    });
    const beforeRecovery = await store.readState();

    await expect(new RecoveryManager(store, runtime).recover(run.jobId)).resolves.toMatchObject({
      phase: "FIXING",
      action: "PREPARE_REPAIR",
      stateVersion: beforeRecovery.stateVersion
    });
    expect((await store.readState()).stateVersion).toBe(beforeRecovery.stateVersion);
  });

  it("blocks a baseline Artifact bound as the current Result Snapshot", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "READY_TO_PUBLISH");
    const state = await store.readState();
    const run = state.runs["job-1"];
    const current = run?.gitWorkspace?.current;
    if (run?.gitWorkspace === undefined || current === undefined) {
      throw new Error("snapshot binding fixture missing");
    }
    const updatedAt = new Date().toISOString();
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      runs: {
        ...state.runs,
        "job-1": {
          ...run,
          gitWorkspace: {
            ...run.gitWorkspace,
            current: { ...current, resultSnapshot: current.inputSnapshot }
          },
          updatedAt
        }
      },
      updatedAt
    });

    await expect(new RecoveryManager(store, runtime).recover("job-1")).resolves.toMatchObject({
      phase: "PAUSED",
      action: "BLOCKED",
      reason: "ARTIFACT_SEMANTIC_MISMATCH:gitWorkspace.current.resultSnapshot"
    });
  });

  it.each(["CANCELED", "FAILED"] as const)(
    "leaves terminal phase %s untouched",
    async (phase) => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const store = await createLifecycleStore(harness, phase);
      const before = await store.readState();

      const recovered = await new RecoveryManager(store, runtime).recover("job-1");
      expect(recovered).toMatchObject({ phase, action: "NONE" });
      expect((await store.readState()).stateVersion).toBe(before.stateVersion);
    }
  );
});
