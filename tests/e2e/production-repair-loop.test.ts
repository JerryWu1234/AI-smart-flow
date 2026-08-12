import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProductionRuntimeComposition,
  ProjectRuntime,
  ReviewCoordinator,
  type ProjectPipelineContext
} from "@smartflow/daemon";
import {
  type HostActionCallbacks,
  type ReviewActionResult
} from "@smartflow/host-skill";
import type {
  ReviewSubmission,
  ReviewTurnOutput
} from "@smartflow/protocol";
import type {
  CancelReceipt,
  ProviderProbeResult,
  WorkerEvent,
  WorkerProvider,
  WorkerStartInput
} from "@smartflow/provider-core";
import { normalizeFinding } from "@smartflow/review";
import { StateStore, type ProjectState } from "@smartflow/state-store";
import { hashCanonical } from "@smartflow/task-manifest";
import { createTasksSource } from "../../packages/task-manifest/src/test-fixture.js";
import { combineReviewStageResults } from "../helpers/reviewer-provenance.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const activeHarnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

class RepairLoopProvider implements WorkerProvider {
  public readonly id = "pi" as const;
  public readonly starts: Array<{
    attemptId: string;
    generation: number;
    revision: number;
    sessionId: string;
  }> = [];

  public constructor(
    private readonly revisionMarker: (revision: number) => string = (revision) => String(revision)
  ) {}

  public probe(): Promise<ProviderProbeResult> {
    return Promise.resolve({
      available: true,
      capabilities: {
        officialCodingTools: true,
        arbitraryShell: true,
        networkAccess: true,
        streaming: true,
        cancellation: true,
        sessionPersistence: true
      },
      providerRuntimeConfigHash: hashCanonical({}),
      details: { source: "production-repair-loop" }
    });
  }

  public async *start(input: WorkerStartInput): AsyncIterable<WorkerEvent> {
    const piSessionId = `worker-r${String(input.revision)}-${input.attemptId}`;
    const identity = {
      attemptId: input.attemptId,
      configHash: input.providerRuntimeConfigHash,
      containmentId: `repair-loop-${input.attemptId}`,
      pid: 2_147_483_647,
      processStartToken: `repair-loop-start-${input.attemptId}`,
      status: "EXITED"
    } as const;
    await mkdir(dirname(input.containment.registryPath), { recursive: true });
    await writeFile(input.containment.registryPath, JSON.stringify([identity]), "utf8");
    this.starts.push({
      attemptId: input.attemptId,
      generation: input.generation,
      revision: input.revision,
      sessionId: piSessionId
    });
    yield {
      type: "STARTED",
      attemptId: input.attemptId,
      piSessionId,
      containmentId: identity.containmentId,
      pid: identity.pid,
      processStartToken: identity.processStartToken
    };
    const callId = `write-r${String(input.revision)}`;
    yield { type: "TOOL_STARTED", attemptId: input.attemptId, toolName: "smartflow_write_file", callId };
    await writeFile(
      resolve(input.workspaceDir, "sum.js"),
      [
        "export function sum(left, right) {",
        "  return left + right;",
        "}",
        `export const implementedRevision = ${JSON.stringify(this.revisionMarker(input.revision))};`,
        ""
      ].join("\n"),
      "utf8"
    );
    yield {
      type: "TOOL_FINISHED",
      attemptId: input.attemptId,
      toolName: "write",
      callId,
      isError: false
    };
    yield { type: "COMPLETED", attemptId: input.attemptId, piSessionId };
  }

  public cancel(attemptId: string): Promise<CancelReceipt> {
    return Promise.resolve({ attemptId, requested: false, treeEmpty: true });
  }
}

async function waitForState(
  store: StateStore,
  jobId: string,
  predicate: (state: ProjectState) => boolean,
  timeoutMs = 8_000
): Promise<ProjectState> {
  const deadline = Date.now() + timeoutMs;
  let state = await store.readState();
  while (!predicate(state) && Date.now() < deadline) {
    await new Promise<void>((settle) => setTimeout(settle, 20));
    state = await store.readState();
  }
  if (!predicate(state)) {
    const run = state.runs[jobId];
    throw new Error(
      `Timed out waiting for run state; phase=${String(run?.phase)} pause=${String(run?.pause?.code)} error=${String(run?.lastError?.message)} recovery=${JSON.stringify(run?.recovery)}`
    );
  }
  return state;
}

function createReviewCallback(
  plans: Map<number, {
    verdict: "APPROVE" | "REQUEST_CHANGES";
    findingCodes: string[];
    blocking?: boolean;
  }>
): {
  review: NonNullable<HostActionCallbacks["review"]>;
  observations: Array<{
    tasksSource: string;
    implementationSource: string;
    sessionMode: "CREATE" | "RESUME";
  }>;
} {
  const reviewerSessionId = "reviewer-session-s1";
  const observations: Array<{
    tasksSource: string;
    implementationSource: string;
    sessionMode: "CREATE" | "RESUME";
  }> = [];
  return {
    observations,
    review: async (context): Promise<ReviewActionResult> => {
      const revision = observations.length + 1;
      if (revision === 1 && context.reviewerSession.mode !== "CREATE") {
        throw new Error("first review must create the reviewer session");
      }
      if (
        revision > 1 &&
        (context.reviewerSession.mode !== "RESUME" ||
          context.reviewerSession.reviewerSessionId !== reviewerSessionId)
      ) {
        throw new Error("later reviews must resume the original reviewer session");
      }
      const tasksSource = await readFile(resolve(context.worktreePath, "tasks.md"), "utf8");
      const implementationSource = await readFile(resolve(context.worktreePath, "sum.js"), "utf8");
      observations.push({
        tasksSource,
        implementationSource,
        sessionMode: context.reviewerSession.mode
      });
      const plan = plans.get(revision) ?? {
        verdict: "REQUEST_CHANGES" as const,
        findingCodes: ["REPAIR_REQUIRED"]
      };
      const { verdict, findingCodes } = plan;
      const findings = findingCodes.map((code) => normalizeFinding({
        code,
        criterionId: "T001",
        path: "sum.js",
        severity: "P1",
        blocking: plan.blocking ?? true,
        summary: `Revision requires corrective implementation for ${code}`,
        evidence: [`production repair-loop test finding ${code}`]
      }));
      const approval: ReviewSubmission = {
        verdict: "APPROVE",
        completionPercentage: verdict === "APPROVE" ? 100 : 0,
        convergeFindings: [],
        adversarialFindings: [],
        pathCoverage: { "sum.js": "FULL" },
        residualRisks: []
      };
      const converge = verdict === "APPROVE" ? approval : {
        ...approval,
        verdict,
        convergeFindings: findings
      };
      const adversarial = verdict === "APPROVE" ? approval : {
        ...approval,
        verdict,
        adversarialFindings: findings
      };
      return {
        reviewerSessionId,
        result: combineReviewStageResults(
          ["sum.js"],
          converge,
          adversarial
        )
      };
    }
  };
}

type ReviewRequiredTurn = Extract<ReviewTurnOutput, { kind: "REVIEW_REQUIRED" }>;
type ReviewTurnDriver = (
  continuation?: Record<string, unknown>
) => Promise<ReviewTurnOutput>;

function createReviewTurnDriver(
  runtime: ProjectRuntime,
  scope: { projectId: string; jobId: string },
  hostTurnId: string,
  requestPrefix: string
): ReviewTurnDriver {
  let sequence = 0;
  return async (continuation = {}): Promise<ReviewTurnOutput> => {
    let next = continuation;
    for (;;) {
      sequence += 1;
      const requestId = `${requestPrefix}-${String(sequence)}`;
      const turn = await runtime.handle({
        id: requestId,
        method: "smartflow_review_turn",
        payload: {
          requestId,
          projectId: scope.projectId,
          jobId: scope.jobId,
          hostTurnId,
          ...next
        }
      }) as ReviewTurnOutput;
      if (turn.kind !== "NOT_READY") return turn;
      await new Promise<void>((settle) => setTimeout(settle, 20));
      next = {};
    }
  };
}

async function submitReviewerResult(
  nextTurn: ReviewTurnDriver,
  turn: ReviewRequiredTurn,
  review: NonNullable<HostActionCallbacks["review"]>
): Promise<ReviewTurnOutput> {
  const output = await review({
    reviewAttemptId: turn.reviewAttemptId,
    worktreePath: turn.worktreePath,
    taskSourceHash: turn.taskSourceHash,
    candidateHash: turn.candidateHash,
    changedPaths: [...turn.changedPaths],
    reviewerSession: { ...turn.reviewerSession },
    piSessionId: turn.piSessionId
  });
  return nextTurn({
    turnToken: turn.turnToken,
    review: {
      reviewerSessionId: output.reviewerSessionId,
      result: "result" in output
        ? output.result
        : {
            completionPercentage: output.completionPercentage,
            tasks: output.tasks
          }
    }
  });
}

describe("production review repair loop", () => {
  it("creates Revision N+1 through review_turn, invalidates evidence, and reruns", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksPath = resolve(harness.projectDir, "tasks.md");
    const tasksSource = createTasksSource({
      tasks: `## M01 · Core

- [ ] T001 Edit \`sum.js\` — 验收：Reviewer confirms the requested behavior`
    });
    await writeFile(tasksPath, tasksSource, "utf8");

    const provider = new RepairLoopProvider((revision) => revision === 1 ? "1" : "stable");
    const composition = new ProductionRuntimeComposition(
      harness.dataDir,
      undefined,
      undefined,
      provider
    );
    let releaseRevision2!: () => void;
    let revision2Reached!: () => void;
    const revision2Gate = new Promise<void>((settle) => {
      releaseRevision2 = settle;
    });
    const revision2Scheduled = new Promise<void>((settle) => {
      revision2Reached = settle;
    });
    const runPipeline = async (context: ProjectPipelineContext): Promise<void> => {
      if (context.expectedRevision === 2) {
        revision2Reached();
        await revision2Gate;
      }
      await composition.runPipeline(context);
    };
    const reviewPlans = new Map<number, {
      verdict: "APPROVE" | "REQUEST_CHANGES";
      findingCodes: string[];
      blocking?: boolean;
    }>([
      [1, {
        verdict: "REQUEST_CHANGES",
        findingCodes: ["LEADER_EXPECTATION_MISSED"]
      }],
      [2, { verdict: "REQUEST_CHANGES", findingCodes: ["REPAIR_REQUIRED"] }],
      [3, {
        verdict: "REQUEST_CHANGES",
        findingCodes: ["REPAIR_REQUIRED"],
        blocking: false
      }]
    ]);
    const runtime = new ProjectRuntime({
      dataDirectory: harness.dataDir,
      runPipeline,
      recover: composition.recover,
      cancel: composition.cancel,
      publish: composition.publish
    });
    const execute = await runtime.handle({
      id: "execute-r1",
      method: "smartflow_execute",
      payload: {
        requestId: "execute-r1",
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md",
        approvedSourceHash: sha256(tasksSource)
      }
    }) as { projectId: string; jobId: string };
    const nextTurn = createReviewTurnDriver(
      runtime,
      execute,
      "host-turn-repair-e2e",
      "repair-turn"
    );
    const store = new StateStore(resolve(harness.dataDir, "projects", execute.projectId));
    const reviewer = createReviewCallback(reviewPlans);

    const firstReviewPending = await waitForState(
      store,
      execute.jobId,
      (state) => state.runs[execute.jobId]?.phase === "REVIEW_PENDING"
    );
    const firstRun = firstReviewPending.runs[execute.jobId];
    if (firstRun === undefined) throw new Error("first revision missing");
    const firstEvidence = {
      taskManifest: firstRun.taskManifest,
      candidate: firstRun.candidate,
      candidateHash: firstRun.pendingAction?.candidateHash,
      attemptId: firstRun.workerAttempts.at(-1)?.attemptId,
      sessionId: firstRun.workerAttempts.at(-1)?.piSessionId
    };
    expect(firstEvidence.candidate).toBeDefined();
    expect(firstEvidence.candidateHash).toBeDefined();

    const firstTurn = await nextTurn();
    if (firstTurn.kind !== "REVIEW_REQUIRED") {
      throw new Error("first revision did not request Review");
    }
    const secondTurnPromise = submitReviewerResult(nextTurn, firstTurn, reviewer.review);
    expect(await readFile(tasksPath, "utf8")).toBe(tasksSource);
    await revision2Scheduled;

    const cleanRevision = await store.readState();
    const cleanRun = cleanRevision.runs[execute.jobId];
    if (cleanRun === undefined) throw new Error("second revision missing");
    expect(cleanRun).toMatchObject({ revision: 2, phase: "PREPARING" });
    expect(cleanRun.taskManifest.sha256).not.toBe(firstEvidence.taskManifest.sha256);
    expect(cleanRun.candidate).toBeUndefined();
    expect(cleanRun.review).toBeUndefined();
    expect(cleanRun.leaderDecision).toBeUndefined();
    expect(cleanRun.pendingAction).toBeUndefined();

    releaseRevision2();
    const secondTurn = await secondTurnPromise;
    if (secondTurn.kind !== "REVIEW_REQUIRED" || secondTurn.revision !== 2) {
      throw new Error("second revision did not request Review");
    }
    const secondReviewPending = await store.readState();
    const secondRun = secondReviewPending.runs[execute.jobId];
    if (secondRun === undefined) throw new Error("second review revision missing");
    expect(secondRun.candidate?.sha256).not.toBe(firstEvidence.candidate?.sha256);
    expect(secondRun.pendingAction?.candidateHash).not.toBe(firstEvidence.candidateHash);
    expect(secondRun.workerAttempts.at(-1)?.attemptId).not.toBe(firstEvidence.attemptId);
    expect(secondRun.workerAttempts.at(-1)?.piSessionId).not.toBe(firstEvidence.sessionId);
    expect(provider.starts.map((start) => start.revision)).toEqual([1, 2]);

    const thirdTurn = await submitReviewerResult(nextTurn, secondTurn, reviewer.review);
    if (thirdTurn.kind !== "REVIEW_REQUIRED" || thirdTurn.revision !== 3) {
      throw new Error("third revision did not request Review");
    }
    await new Promise<void>((settle) => setTimeout(settle, 100));
    const finalRun = (await store.readState()).runs[execute.jobId];
    expect(finalRun).toMatchObject({
      revision: 3,
      phase: "REVIEWING",
      noProgressCount: 1,
      hostTurn: { stage: "AWAITING_REVIEW" }
    });
    expect(finalRun?.pendingAction?.claimId).toBeDefined();
    expect(provider.starts.map((start) => start.revision)).toEqual([1, 2, 3]);
    expect(finalRun?.reviewHistory?.map((entry) => entry.reviewerSessionId))
      .toEqual(["reviewer-session-s1", "reviewer-session-s1"]);
    expect(reviewer.observations.map((observation) => observation.sessionMode))
      .toEqual(["CREATE", "RESUME"]);
    expect(reviewer.observations[0]?.tasksSource).toBe(tasksSource);
    expect(reviewer.observations[1]?.tasksSource).toBe(tasksSource);
    expect(reviewer.observations[0]?.implementationSource)
      .toContain('implementedRevision = "1"');
    expect(reviewer.observations[1]?.implementationSource)
      .toContain('implementedRevision = "stable"');
  }, 30_000);

  it("counts reduced problems without path changes and resets only after both improve", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksPath = resolve(harness.projectDir, "tasks.md");
    const tasksSource = createTasksSource({
      tasks: `## M01 · Core

- [ ] T001 Edit \`sum.js\` — 验收：Reviewer confirms the requested behavior`
    });
    await writeFile(tasksPath, tasksSource, "utf8");
    const provider = new RepairLoopProvider((revision) => revision <= 2 ? "stable" : String(revision));
    const composition = new ProductionRuntimeComposition(
      harness.dataDir,
      undefined,
      undefined,
      provider
    );
    const reviewPlans = new Map<number, {
      verdict: "APPROVE" | "REQUEST_CHANGES";
      findingCodes: string[];
    }>();
    const runtime = new ProjectRuntime({
      dataDirectory: harness.dataDir,
      runPipeline: composition.runPipeline,
      recover: composition.recover,
      cancel: composition.cancel,
      publish: composition.publish
    });
    const execute = await runtime.handle({
      id: "execute-mixed-progress",
      method: "smartflow_execute",
      payload: {
        requestId: "execute-mixed-progress",
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md",
        approvedSourceHash: sha256(tasksSource)
      }
    }) as { projectId: string; jobId: string };
    const nextTurn = createReviewTurnDriver(
      runtime,
      execute,
      "host-turn-mixed-progress",
      "mixed-progress-turn"
    );
    const store = new StateStore(resolve(harness.dataDir, "projects", execute.projectId));
    const reviewer = createReviewCallback(reviewPlans);
    const candidateHashes = new Map<number, string>();

    const completeRound = async (
      revision: number,
      findingCodes: string[],
      expectedCount: number,
      expectedPause: "REPAIR_TASKS_READY" | "REPAIR_NO_PROGRESS",
      requestedTurn?: ReviewRequiredTurn
    ): Promise<void> => {
      reviewPlans.set(revision, { verdict: "REQUEST_CHANGES", findingCodes });
      const requested = requestedTurn ?? await nextTurn();
      if (requested.kind !== "REVIEW_REQUIRED" || requested.revision !== revision) {
        throw new Error(`revision ${String(revision)} did not request Review`);
      }
      const run = (await store.readState()).runs[execute.jobId];
      if (run?.candidate === undefined) throw new Error("candidate missing from repair round");
      const candidate = JSON.parse(
        new TextDecoder().decode(await store.readArtifact(run.candidate))
      ) as { operations: Array<{ newEntry?: { sha256: string } }> };
      const relevantPathHash = candidate.operations[0]?.newEntry?.sha256;
      if (relevantPathHash === undefined) throw new Error("candidate path hash missing");
      candidateHashes.set(revision, relevantPathHash);

      const response = await submitReviewerResult(nextTurn, requested, reviewer.review);
      const afterReview = (await store.readState()).runs[execute.jobId];
      expect(afterReview?.noProgressCount).toBe(expectedCount);
      if (expectedPause === "REPAIR_NO_PROGRESS") {
        expect(response).toMatchObject({
          kind: "USER_INPUT_REQUIRED",
          pause: { code: "REPAIR_NO_PROGRESS" }
        });
        return;
      }
      expect(response).toMatchObject({
        kind: "REVIEW_REQUIRED",
        revision: revision + 1
      });
    };

    await completeRound(1, ["A", "B", "C"], 0, "REPAIR_TASKS_READY");
    await completeRound(2, ["A", "B"], 1, "REPAIR_TASKS_READY");
    expect(candidateHashes.get(2)).toBe(candidateHashes.get(1));
    await completeRound(3, ["A"], 0, "REPAIR_TASKS_READY");
    expect(candidateHashes.get(3)).not.toBe(candidateHashes.get(2));
    for (let revision = 4; revision < 16; revision += 1) {
      await completeRound(revision, ["A"], revision - 3, "REPAIR_TASKS_READY");
    }

    reviewPlans.set(16, { verdict: "REQUEST_CHANGES", findingCodes: ["A"] });
    const limitedReview = await nextTurn();
    if (limitedReview.kind !== "REVIEW_REQUIRED" || limitedReview.revision !== 16) {
      throw new Error("revision 16 did not request Review");
    }
    const limitPause = await submitReviewerResult(nextTurn, limitedReview, reviewer.review);
    expect((await store.readState()).runs[execute.jobId]?.noProgressCount).toBe(12);
    expect(limitPause).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      pause: { code: "AUTOMATIC_REPAIR_LIMIT" }
    });
    if (limitPause.kind !== "USER_INPUT_REQUIRED") {
      throw new Error("automatic repair limit did not require user input");
    }
    expect(limitPause.options.map((option) => option.answer))
      .toContain("resume_review_decision");

    const revision17 = await nextTurn({
      turnToken: limitPause.turnToken,
      answer: "resume_review_decision"
    });
    expect((await store.readState()).runs[execute.jobId]?.noProgressCount).toBe(13);
    if (revision17.kind !== "REVIEW_REQUIRED" || revision17.revision !== 17) {
      throw new Error("revision 17 did not request Review after the repair-limit pause");
    }
    await completeRound(17, ["A"], 14, "REPAIR_TASKS_READY", revision17);
    await completeRound(18, ["A"], 15, "REPAIR_NO_PROGRESS");
    await new Promise<void>((settle) => setTimeout(settle, 100));
    const finalRun = (await store.readState()).runs[execute.jobId];
    expect(finalRun?.recovery?.repairDraft).toBeUndefined();
    expect(finalRun?.pendingAction).toBeUndefined();
    expect(provider.starts.map((start) => start.revision))
      .toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
    expect(reviewer.observations.map((observation) => observation.sessionMode))
      .toEqual(["CREATE", ...Array.from({ length: 17 }, () => "RESUME")]);
  }, 60_000);

  it("keeps durable Host-turn recovery authoritative after a transient startup pause failure", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksSource = createTasksSource({
      tasks: `## M01 · Core

- [ ] T001 Edit \`sum.js\` — 验收：Reviewer confirms the requested behavior`
    });
    await writeFile(resolve(harness.projectDir, "tasks.md"), tasksSource, "utf8");
    const provider = new RepairLoopProvider();
    const composition = new ProductionRuntimeComposition(
      harness.dataDir,
      undefined,
      undefined,
      provider
    );
    let runtime = new ProjectRuntime({
      dataDirectory: harness.dataDir,
      runPipeline: composition.runPipeline,
      recover: composition.recover,
      cancel: composition.cancel,
      publish: composition.publish
    });
    const execute = await runtime.handle({
      id: "host-recovery-execute",
      method: "smartflow_execute",
      payload: {
        requestId: "host-recovery-execute",
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md",
        approvedSourceHash: sha256(tasksSource)
      }
    }) as { projectId: string; jobId: string };
    const store = new StateStore(resolve(harness.dataDir, "projects", execute.projectId));
    await waitForState(
      store,
      execute.jobId,
      (state) => state.runs[execute.jobId]?.phase === "REVIEW_PENDING"
    );
    const requested = await runtime.handle({
      id: "host-recovery-claim",
      method: "smartflow_review_turn",
      payload: {
        requestId: "host-recovery-claim",
        projectId: execute.projectId,
        jobId: execute.jobId,
        hostTurnId: "host-recovery-owner"
      }
    }) as ReviewTurnOutput;
    expect(requested.kind).toBe("REVIEW_REQUIRED");

    const claimedState = await store.readState();
    const claimedRun = claimedState.runs[execute.jobId];
    if (
      claimedRun?.hostTurn?.stage !== "AWAITING_REVIEW" ||
      claimedRun.pendingAction === undefined ||
      typeof claimedRun.pendingAction.claimId !== "string"
    ) throw new Error("durable review claim fixture missing");
    const originalClaimId = claimedRun.pendingAction.claimId;
    const expiredAt = new Date(Date.now() - 1).toISOString();
    await store.writeState({
      ...claimedState,
      stateVersion: claimedState.stateVersion + 1,
      runs: {
        ...claimedState.runs,
        [execute.jobId]: {
          ...claimedRun,
          pendingAction: {
            ...claimedRun.pendingAction,
            claimExpiresAt: expiredAt
          },
          hostTurn: {
            ...claimedRun.hostTurn,
            deadlineAt: expiredAt
          },
          updatedAt: expiredAt
        }
      },
      updatedAt: expiredAt
    });
    runtime.dispose();

    const legacyRecover = vi.fn(composition.recover);
    const originalReportHostUnavailable = ReviewCoordinator.prototype.reportHostUnavailable.bind(
      new ReviewCoordinator(store)
    );
    let reportCalls = 0;
    const reportSpy = vi.spyOn(
      ReviewCoordinator.prototype,
      "reportHostUnavailable"
    ).mockImplementation((state, input, now) => {
      reportCalls += 1;
      if (reportCalls === 1) throw new Error("transient startup pause failure");
      return originalReportHostUnavailable(state, input, now);
    });
    runtime = new ProjectRuntime({
      dataDirectory: harness.dataDir,
      runPipeline: composition.runPipeline,
      recover: legacyRecover,
      cancel: composition.cancel,
      publish: composition.publish
    });

    vi.useFakeTimers();
    try {
      await expect(runtime.recover()).resolves.toBeUndefined();
      const afterRecovery = await store.readState();
      expect(legacyRecover).not.toHaveBeenCalled();
      expect(reportSpy).toHaveBeenCalledTimes(1);
      expect(afterRecovery.runs[execute.jobId]).toMatchObject({
        phase: "REVIEWING",
        pendingAction: { claimId: originalClaimId },
        hostTurn: { stage: "AWAITING_REVIEW" }
      });

      await vi.advanceTimersToNextTimerAsync();
      await vi.waitFor(() => expect(reportSpy).toHaveBeenCalledTimes(2));
      expect((await store.readState()).runs[execute.jobId]).toMatchObject({
        phase: "PAUSED",
        pause: { code: "HOST_REVIEW_UNAVAILABLE" }
      });
      expect(legacyRecover).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      reportSpy.mockRestore();
      runtime.dispose();
    }
  }, 30_000);

  it("drives repair and publish using only execute plus review_turn", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksSource = createTasksSource({
      tasks: `## M01 · Core

- [ ] T001 Edit \`sum.js\` — 验收：Reviewer confirms the requested behavior`
    });
    await writeFile(resolve(harness.projectDir, "tasks.md"), tasksSource, "utf8");
    const provider = new RepairLoopProvider((revision) => revision === 1 ? "1" : "stable");
    const composition = new ProductionRuntimeComposition(
      harness.dataDir,
      undefined,
      undefined,
      provider
    );
    let runtime = new ProjectRuntime({
      dataDirectory: harness.dataDir,
      runPipeline: composition.runPipeline,
      recover: composition.recover,
      cancel: composition.cancel,
      publish: composition.publish
    });
    const execute = await runtime.handle({
      id: "review-turn-execute",
      method: "smartflow_execute",
      payload: {
        requestId: "review-turn-execute",
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md",
        approvedSourceHash: sha256(tasksSource)
      }
    }) as { projectId: string; jobId: string };
    const turnStore = new StateStore(resolve(harness.dataDir, "projects", execute.projectId));
    let sequence = 0;
    const nextTurn = async (
      continuation: Record<string, unknown> = {}
    ): Promise<ReviewTurnOutput> => {
      let next = continuation;
      for (;;) {
        sequence += 1;
        const turn = await runtime.handle({
          id: `review-turn-${String(sequence)}`,
          method: "smartflow_review_turn",
          payload: {
            requestId: `review-turn-${String(sequence)}`,
            projectId: execute.projectId,
            jobId: execute.jobId,
            hostTurnId: "host-turn-e2e",
            ...next
          }
        }) as ReviewTurnOutput;
        if (turn.kind !== "NOT_READY") return turn;
        await new Promise<void>((settle) => setTimeout(settle, 20));
        next = {};
      }
    };

    const first = await nextTurn();
    expect(first).toMatchObject({
      kind: "REVIEW_REQUIRED",
      reviewerSession: { mode: "CREATE" }
    });
    if (first.kind !== "REVIEW_REQUIRED") throw new Error("first review was not requested");
    runtime.dispose();
    runtime = new ProjectRuntime({
      dataDirectory: harness.dataDir,
      runPipeline: composition.runPipeline,
      recover: composition.recover,
      cancel: composition.cancel,
      publish: composition.publish
    });
    let recovered!: ReviewTurnOutput;
    let stateVersionBeforeRenewal = 0;
    vi.useFakeTimers();
    try {
      await runtime.recover();
      recovered = await nextTurn();
      stateVersionBeforeRenewal = (await turnStore.readState()).stateVersion;
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
    const renewed = await waitForState(
      turnStore,
      execute.jobId,
      (state) => state.stateVersion > stateVersionBeforeRenewal
    );
    expect(renewed.runs[execute.jobId]?.pendingAction?.claimExpiresAt).toBeDefined();
    expect(recovered).toMatchObject({
      kind: "REVIEW_REQUIRED",
      turnToken: first.turnToken,
      reviewAttemptId: first.reviewAttemptId,
      reviewerSession: { mode: "CREATE" }
    });
    if (recovered.kind !== "REVIEW_REQUIRED") {
      throw new Error("review turn was not recovered after daemon restart");
    }
    const beforeTimeout = await turnStore.readState();
    const timeoutRun = beforeTimeout.runs[execute.jobId];
    if (timeoutRun?.hostTurn?.stage !== "AWAITING_REVIEW") {
      throw new Error("recovered Host turn is not awaiting review");
    }
    const timeoutAt = new Date().toISOString();
    await turnStore.writeState({
      ...beforeTimeout,
      stateVersion: beforeTimeout.stateVersion + 1,
      runs: {
        ...beforeTimeout.runs,
        [execute.jobId]: {
          ...timeoutRun,
          hostTurn: {
            ...timeoutRun.hostTurn,
            deadlineAt: new Date(Date.now() - 1).toISOString()
          },
          updatedAt: timeoutAt
        }
      },
      updatedAt: timeoutAt
    });
    const timedOut = await nextTurn();
    expect(timedOut).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      pause: { code: "HOST_REVIEW_UNAVAILABLE" }
    });
    if (timedOut.kind !== "USER_INPUT_REQUIRED") {
      throw new Error("expired review turn did not require user input");
    }
    expect(timedOut.options.map((option) => option.answer)).toContain("retry_host_review");
    const retried = await nextTurn({
      turnToken: timedOut.turnToken,
      answer: "retry_host_review"
    });
    expect(retried).toMatchObject({
      kind: "REVIEW_REQUIRED",
      reviewerSession: { mode: "CREATE" }
    });
    if (retried.kind !== "REVIEW_REQUIRED") {
      throw new Error("expired review turn was not reissued");
    }
    expect(retried.turnToken).not.toBe(first.turnToken);
    const incomplete = normalizeFinding({
      code: "REPAIR_REQUIRED",
      criterionId: "T001",
      path: "sum.js",
      severity: "P1",
      blocking: true,
      summary: "The first revision needs a corrective implementation",
      evidence: ["review_turn e2e incomplete finding"]
    });
    const beforeLimit = await turnStore.readState();
    const limitedRun = beforeLimit.runs[execute.jobId];
    if (limitedRun === undefined) throw new Error("run missing before repair-limit test");
    const limitedAt = new Date().toISOString();
    await turnStore.writeState({
      ...beforeLimit,
      stateVersion: beforeLimit.stateVersion + 1,
      runs: {
        ...beforeLimit.runs,
        [execute.jobId]: {
          ...limitedRun,
          autoRepairRounds: 15,
          updatedAt: limitedAt
        }
      },
      updatedAt: limitedAt
    });
    const paused = await nextTurn({
      turnToken: retried.turnToken,
      review: {
        reviewerSessionId: "reviewer-session-review-turn",
        result: {
          verdict: "REQUEST_CHANGES",
          completionPercentage: 50,
          convergeFindings: [incomplete],
          adversarialFindings: [],
          pathCoverage: { "sum.js": "FULL" },
          residualRisks: []
        }
      }
    });
    expect(paused).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      pause: { code: "AUTOMATIC_REPAIR_LIMIT" },
      review: { completionPercentage: 50 }
    });
    expect(JSON.stringify(paused)).not.toContain(first.worktreePath);
    if (paused.kind !== "USER_INPUT_REQUIRED") {
      throw new Error("repair limit did not require user input");
    }
    expect(paused.options.map((option) => option.answer)).toContain("resume_review_decision");
    const second = await nextTurn({
      turnToken: paused.turnToken,
      answer: "resume_review_decision"
    });
    expect(second).toMatchObject({
      kind: "REVIEW_REQUIRED",
      reviewerSession: {
        mode: "RESUME",
        reviewerSessionId: "reviewer-session-review-turn"
      }
    });
    if (second.kind !== "REVIEW_REQUIRED") throw new Error("second review was not requested");
    const completed = await nextTurn({
      turnToken: second.turnToken,
      review: {
        reviewerSessionId: "reviewer-session-review-turn",
        result: {
          verdict: "APPROVE",
          completionPercentage: 100,
          convergeFindings: [],
          adversarialFindings: [],
          pathCoverage: { "sum.js": "FULL" },
          residualRisks: []
        }
      }
    });
    expect(completed).toMatchObject({
      kind: "DONE",
      result: { phase: "COMPLETED", status: "COMMITTED" }
    });
    expect(await readFile(resolve(harness.projectDir, "sum.js"), "utf8"))
      .toContain('implementedRevision = "stable"');
    const finalRun = (await turnStore.readState()).runs[execute.jobId];
    expect(finalRun?.autoRepairRounds).toBe(1);
    expect(finalRun?.hostTurn).toBeUndefined();
    expect(provider.starts).toHaveLength(2);
    runtime.dispose();
  }, 60_000);
});
