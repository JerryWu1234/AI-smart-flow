import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProductionRuntimeComposition,
  ProjectRuntime,
  type ProjectPipelineContext
} from "@smartflow/daemon";
import {
  HostActionLoop,
  type HostActionCallbacks,
  type HostGateway,
  type ReviewActionResult
} from "@smartflow/host-skill";
import type { RepairItem, ReviewSubmission } from "@smartflow/protocol";
import type {
  CancelReceipt,
  ProviderProbeResult,
  WorkerEvent,
  WorkerProvider,
  WorkerStartInput
} from "@smartflow/provider-core";
import { combineReviewStageResults, normalizeFinding } from "@smartflow/review";
import { StateStore, type ProjectState } from "@smartflow/state-store";
import { hashCanonical } from "@smartflow/task-manifest";
import { createTasksSource } from "../../packages/task-manifest/src/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const activeHarnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function reviewerRepairItems(
  result: ReviewSubmission,
  findingCodes?: readonly string[]
): RepairItem[] {
  const selectedCodes = findingCodes === undefined ? undefined : new Set(findingCodes);
  return [...new Set(
    [...result.convergeFindings, ...result.adversarialFindings]
      .filter((finding) => selectedCodes === undefined || selectedCodes.has(finding.code))
      .map((finding) => finding.fingerprint)
  )].map((findingFingerprint) => ({ source: "reviewer", findingFingerprint }));
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

class RuntimeGateway implements HostGateway {
  public lastResumeInput: Record<string, unknown> | undefined;
  private sequence = 0;

  public constructor(private readonly runtime: ProjectRuntime) {}

  public call(toolName: string, input: unknown): Promise<unknown> {
    if (toolName === "smartflow_resume") {
      this.lastResumeInput = structuredClone(input as Record<string, unknown>);
    }
    this.sequence += 1;
    return this.runtime.handle({
      id: `gateway-${String(this.sequence)}`,
      method: toolName,
      payload: input
    });
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

describe("production review repair loop", () => {
  it("creates Revision N+1 through HostActionLoop, invalidates evidence, reruns, and rejects stale repair payloads", async () => {
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
      [1, { verdict: "APPROVE", findingCodes: [] }],
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
    const gateway = new RuntimeGateway(runtime);
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

    const firstReview = await new HostActionLoop(gateway, {
      review: reviewer.review
    }).pollOnce({
      projectId: execute.projectId,
      jobId: execute.jobId,
      expectedRevision: 1,
      expectedStateVersion: firstReviewPending.stateVersion,
      hostTurnId: "host-turn-r1",
      requestId: "review-r1"
    }) as { reviewHash: string; result: ReviewSubmission };
    expect(firstReview.result.completionPercentage).toBe(100);
    const leaderState = await store.readState();
    await runtime.handle({
      id: "leader-repair-r1",
      method: "smartflow_submit_leader_decision",
      payload: {
        requestId: "leader-repair-r1",
        projectId: execute.projectId,
        jobId: execute.jobId,
        expectedRevision: 1,
        expectedStateVersion: leaderState.stateVersion,
        reviewHash: firstReview.reviewHash,
        decision: "repair",
        repairItems: [{
          source: "leader",
          code: "LEADER_EXPECTATION_MISSED",
          taskId: "T001",
          path: "sum.js",
          reason: "The implementation still misses the Leader's approved expectation"
        }],
        reason: "Reviewer approved, but the Leader identified a remaining task mismatch"
      }
    });

    const repairReady = await waitForState(
      store,
      execute.jobId,
      (state) => state.runs[execute.jobId]?.pause?.code === "REPAIR_TASKS_READY"
    );
    expect(repairReady.runs[execute.jobId]?.pause?.resumeActions).toContain(
      "approve_new_manifest_revision"
    );
    expect(repairReady.runs[execute.jobId]?.pause?.resumeActions).not.toContain(
      "resume_repair_revision"
    );
    const firstRepairResult = await runtime.handle({
      id: "repair-result-r1",
      method: "smartflow_result",
      payload: { projectId: execute.projectId, jobId: execute.jobId }
    }) as { repairDraft?: { addedTaskLines: string[] } };
    expect(firstRepairResult.repairDraft?.addedTaskLines).toHaveLength(1);
    expect(firstRepairResult.repairDraft?.addedTaskLines.join("\n"))
      .toContain("LEADER_EXPECTATION_MISSED");
    const revisionResponse = await new HostActionLoop(gateway, {}).pollOnce({
      projectId: execute.projectId,
      jobId: execute.jobId,
      expectedRevision: 1,
      expectedStateVersion: repairReady.stateVersion,
      hostTurnId: "host-turn-repair",
      requestId: "approve-repair-r2"
    }) as { revision: number; phase: string };
    expect(revisionResponse).toMatchObject({ revision: 2, phase: "PREPARING" });
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

    const staleResume = gateway.lastResumeInput;
    if (staleResume === undefined) throw new Error("repair resume payload was not captured");
    const beforeStaleReplay = await readFile(store.statePath);
    await expect(runtime.handle({
      id: "stale-repair-replay",
      method: "smartflow_resume",
      payload: {
        ...staleResume,
        requestId: "stale-repair-replay",
        expectedRevision: cleanRun.revision,
        expectedStateVersion: cleanRevision.stateVersion
      }
    })).rejects.toMatchObject({ code: "RESUME_NOT_ALLOWED" });
    expect(await readFile(store.statePath)).toEqual(beforeStaleReplay);

    releaseRevision2();
    const secondReviewPending = await waitForState(
      store,
      execute.jobId,
      (state) => state.runs[execute.jobId]?.phase === "REVIEW_PENDING" &&
        state.runs[execute.jobId]?.revision === 2
    );
    const secondRun = secondReviewPending.runs[execute.jobId];
    if (secondRun === undefined) throw new Error("second review revision missing");
    expect(secondRun.candidate?.sha256).not.toBe(firstEvidence.candidate?.sha256);
    expect(secondRun.pendingAction?.candidateHash).not.toBe(firstEvidence.candidateHash);
    expect(secondRun.workerAttempts.at(-1)?.attemptId).not.toBe(firstEvidence.attemptId);
    expect(secondRun.workerAttempts.at(-1)?.piSessionId).not.toBe(firstEvidence.sessionId);
    expect(provider.starts.map((start) => start.revision)).toEqual([1, 2]);

    const secondReview = await new HostActionLoop(gateway, {
      review: reviewer.review
    }).pollOnce({
      projectId: execute.projectId,
      jobId: execute.jobId,
      expectedRevision: 2,
      expectedStateVersion: secondReviewPending.stateVersion,
      hostTurnId: "host-turn-r2",
      requestId: "review-r2"
    }) as { reviewHash: string; result: ReviewSubmission };
    const secondLeaderState = await store.readState();
    await runtime.handle({
      id: "leader-repair-r2",
      method: "smartflow_submit_leader_decision",
      payload: {
        requestId: "leader-repair-r2",
        projectId: execute.projectId,
        jobId: execute.jobId,
        expectedRevision: 2,
        expectedStateVersion: secondLeaderState.stateVersion,
        reviewHash: secondReview.reviewHash,
        decision: "repair",
        repairItems: reviewerRepairItems(secondReview.result),
        reason: "The same blocker remains after a changed Candidate"
      }
    });
    const secondRepairReady = await waitForState(
      store,
      execute.jobId,
      (state) => state.runs[execute.jobId]?.pause?.code === "REPAIR_TASKS_READY" &&
        state.runs[execute.jobId]?.revision === 2
    );
    expect(secondRepairReady.runs[execute.jobId]?.noProgressCount).toBe(1);
    await new HostActionLoop(gateway, {}).pollOnce({
      projectId: execute.projectId,
      jobId: execute.jobId,
      expectedRevision: 2,
      expectedStateVersion: secondRepairReady.stateVersion,
      hostTurnId: "host-turn-repair-r3",
      requestId: "approve-repair-r3"
    });
    const thirdReviewPending = await waitForState(
      store,
      execute.jobId,
      (state) => state.runs[execute.jobId]?.phase === "REVIEW_PENDING" &&
        state.runs[execute.jobId]?.revision === 3
    );
    const thirdReview = await new HostActionLoop(gateway, {
      review: reviewer.review
    }).pollOnce({
      projectId: execute.projectId,
      jobId: execute.jobId,
      expectedRevision: 3,
      expectedStateVersion: thirdReviewPending.stateVersion,
      hostTurnId: "host-turn-r3",
      requestId: "review-r3"
    }) as { reviewHash: string; result: ReviewSubmission };
    const thirdLeaderState = await store.readState();
    await runtime.handle({
      id: "leader-repair-r3",
      method: "smartflow_submit_leader_decision",
      payload: {
        requestId: "leader-repair-r3",
        projectId: execute.projectId,
        jobId: execute.jobId,
        expectedRevision: 3,
        expectedStateVersion: thirdLeaderState.stateVersion,
        reviewHash: thirdReview.reviewHash,
        decision: "repair",
        repairItems: reviewerRepairItems(thirdReview.result),
        reason: "The blocker became non-blocking without a relevant path change"
      }
    });
    const thirdRepairReady = await waitForState(
      store,
      execute.jobId,
      (state) => state.runs[execute.jobId]?.pause?.code === "REPAIR_TASKS_READY" &&
        state.runs[execute.jobId]?.revision === 3
    );
    await new Promise<void>((settle) => setTimeout(settle, 100));
    const finalRun = (await store.readState()).runs[execute.jobId];
    expect(thirdRepairReady.runs[execute.jobId]?.noProgressCount).toBe(2);
    expect(finalRun).toMatchObject({
      revision: 3,
      phase: "PAUSED",
      pause: {
        code: "REPAIR_TASKS_READY",
        resumeActions: ["leader_append_repair_tasks", "approve_new_manifest_revision", "cancel"]
      }
    });
    expect(finalRun?.recovery?.repairDraft).toBeDefined();
    expect(finalRun?.pendingAction).toBeUndefined();
    expect(provider.starts.map((start) => start.revision)).toEqual([1, 2, 3]);
    expect(secondReview.reviewHash).not.toBe(firstReview.reviewHash);
    expect(finalRun?.reviewHistory?.map((entry) => entry.reviewerSessionId))
      .toEqual(["reviewer-session-s1", "reviewer-session-s1", "reviewer-session-s1"]);
    expect(reviewer.observations.map((observation) => observation.sessionMode))
      .toEqual(["CREATE", "RESUME", "RESUME"]);
    expect(reviewer.observations[0]?.tasksSource).toBe(tasksSource);
    expect(reviewer.observations[1]?.tasksSource).toBe(tasksSource);
    expect(reviewer.observations[2]?.tasksSource).toBe(tasksSource);
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
    const gateway = new RuntimeGateway(runtime);
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
    const store = new StateStore(resolve(harness.dataDir, "projects", execute.projectId));
    const reviewer = createReviewCallback(reviewPlans);
    const candidateHashes = new Map<number, string>();

    const completeRound = async (
      revision: number,
      findingCodes: string[],
      expectedCount: number,
      expectedPause: "REPAIR_TASKS_READY" | "REPAIR_NO_PROGRESS"
    ): Promise<void> => {
      reviewPlans.set(revision, { verdict: "REQUEST_CHANGES", findingCodes });
      const reviewPending = await waitForState(
        store,
        execute.jobId,
        (state) => state.runs[execute.jobId]?.phase === "REVIEW_PENDING" &&
          state.runs[execute.jobId]?.revision === revision
      );
      const run = reviewPending.runs[execute.jobId];
      if (run?.candidate === undefined) throw new Error("candidate missing from repair round");
      const candidate = JSON.parse(
        new TextDecoder().decode(await store.readArtifact(run.candidate))
      ) as { operations: Array<{ newEntry?: { sha256: string } }> };
      const relevantPathHash = candidate.operations[0]?.newEntry?.sha256;
      if (relevantPathHash === undefined) throw new Error("candidate path hash missing");
      candidateHashes.set(revision, relevantPathHash);
      const review = await new HostActionLoop(gateway, {
        review: reviewer.review
      }).pollOnce({
        projectId: execute.projectId,
        jobId: execute.jobId,
        expectedRevision: revision,
        expectedStateVersion: reviewPending.stateVersion,
        hostTurnId: `host-turn-mixed-r${String(revision)}`,
        requestId: `review-mixed-r${String(revision)}`
      }) as { reviewHash: string; result: ReviewSubmission };
      const leaderState = await store.readState();
      await runtime.handle({
        id: `leader-mixed-r${String(revision)}`,
        method: "smartflow_submit_leader_decision",
        payload: {
          requestId: `leader-mixed-r${String(revision)}`,
          projectId: execute.projectId,
          jobId: execute.jobId,
          expectedRevision: revision,
          expectedStateVersion: leaderState.stateVersion,
          reviewHash: review.reviewHash,
          decision: "repair",
          repairItems: reviewerRepairItems(review.result),
          reason: `Evaluate durable repair progress at revision ${String(revision)}`
        }
      });
      const paused = await waitForState(
        store,
        execute.jobId,
        (state) => state.runs[execute.jobId]?.pause?.code === expectedPause &&
          state.runs[execute.jobId]?.revision === revision
      );
      expect(paused.runs[execute.jobId]?.noProgressCount).toBe(expectedCount);
      if (expectedPause === "REPAIR_NO_PROGRESS") return;
      await new HostActionLoop(gateway, {}).pollOnce({
        projectId: execute.projectId,
        jobId: execute.jobId,
        expectedRevision: revision,
        expectedStateVersion: paused.stateVersion,
        hostTurnId: `host-turn-repair-mixed-r${String(revision + 1)}`,
        requestId: `approve-repair-mixed-r${String(revision + 1)}`
      });
    };

    await completeRound(1, ["A", "B", "C"], 0, "REPAIR_TASKS_READY");
    await completeRound(2, ["A", "B"], 1, "REPAIR_TASKS_READY");
    expect(candidateHashes.get(2)).toBe(candidateHashes.get(1));
    await completeRound(3, ["A"], 0, "REPAIR_TASKS_READY");
    expect(candidateHashes.get(3)).not.toBe(candidateHashes.get(2));
    for (let revision = 4; revision < 18; revision += 1) {
      await completeRound(revision, ["A"], revision - 3, "REPAIR_TASKS_READY");
    }
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
});
