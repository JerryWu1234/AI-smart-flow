import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProductionRuntimeComposition,
  ProjectRuntime,
  DAEMON_REVIEWER_HOST_TURN_ID
} from "@smartflow/daemon";
import type {
  ResultOutput,
  ReviewResult,
  ReviewTurnOutput,
  RunSummary
} from "@smartflow/protocol";
import type {
  CancelReceipt,
  ProviderProbeResult,
  WorkerEvent,
  WorkerProvider,
  WorkerStartInput
} from "@smartflow/provider-core";
import type {
  AgentAdapter,
  AgentRunOutcome,
  AgentRunRequest
} from "@smartflow/review";
import { StateStore, type ProjectState } from "@smartflow/state-store";
import { hashCanonical, taskManifestSchema } from "@smartflow/task-manifest";
import { createTasksSource } from "../fixtures/task-manifest/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const activeHarnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

class RepairLoopProvider implements WorkerProvider {
  public readonly id = "pi" as const;
  public readonly starts: Array<{
    attemptId: string;
    generation: number;
    sessionId: string;
    workspaceDir: string;
    prompt: string;
    resumeSession: WorkerStartInput["resumeSession"];
    restoredSession?: string;
  }> = [];

  public constructor(
    private readonly generationMarker: (generation: number) => string = (generation) => String(generation),
    private readonly beforeStart: (generation: number) => Promise<void> = () => Promise.resolve()
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
    await this.beforeStart(input.generation);
    const piSessionId = input.resumeSession?.expectedPiSessionId ?? "worker-session-s1";
    const sessionFile = input.resumeSession?.sessionFile ?? resolve(
      input.workspaceDir,
      ".smartflow-runtime",
      "sessions",
      `${piSessionId}.jsonl`
    );
    const restoredSession = input.resumeSession === undefined
      ? undefined
      : await readFile(sessionFile, "utf8");
    const sessionEntry = `${JSON.stringify({
      type: "smartflow-test-turn",
      attemptId: input.attemptId,
      generation: input.generation,
      prompt: input.prompt,
      workspaceDir: input.workspaceDir
    })}\n`;
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, `${restoredSession ?? ""}${sessionEntry}`, "utf8");

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
      sessionId: piSessionId,
      workspaceDir: input.workspaceDir,
      prompt: input.prompt,
      resumeSession: input.resumeSession,
      ...(restoredSession === undefined ? {} : { restoredSession })
    });
    yield {
      type: "STARTED",
      attemptId: input.attemptId,
      piSessionId,
      containmentId: identity.containmentId,
      pid: identity.pid,
      processStartToken: identity.processStartToken
    };
    const callId = `write-g${String(input.generation)}`;
    yield {
      type: "TOOL_STARTED",
      attemptId: input.attemptId,
      toolName: "smartflow_write_file",
      callId
    };
    await writeFile(
      resolve(input.workspaceDir, "sum.js"),
      [
        "export function sum(left, right) {",
        "  return left + right;",
        "}",
        `export const implementationMarker = ${JSON.stringify(this.generationMarker(input.generation))};`,
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
    yield { type: "COMPLETED", attemptId: input.attemptId, piSessionId, sessionFile };
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

async function enabledTaskIdsForRun(store: StateStore, jobId: string): Promise<string[]> {
  const run = (await store.readState()).runs[jobId];
  if (run === undefined) throw new Error("review run is missing");
  const manifest = taskManifestSchema.parse(JSON.parse(
    new TextDecoder().decode(await store.readArtifact(run.taskManifest))
  ));
  return manifest.enabledTaskIds;
}

interface ReviewPlan {
  verdict: "APPROVE" | "REQUEST_CHANGES";
  findingCodes?: readonly string[];
}

interface RecordedReviewCall {
  mode: "CREATE" | "RESUME";
  request: AgentRunRequest;
  sessionId?: string;
  tasksSource: string;
  implementationSource: string;
}

class ScriptedReviewAdapter implements AgentAdapter {
  public readonly calls: RecordedReviewCall[] = [];
  private readonly releases = new Map<number, () => void>();

  public constructor(
    private readonly plans: ReadonlyMap<number, ReviewPlan>,
    private readonly loadTaskIds: () => Promise<readonly string[]>,
    private readonly blockedCalls: ReadonlySet<number> = new Set(),
    private readonly defaultPlan: ReviewPlan = {
      verdict: "REQUEST_CHANGES",
      findingCodes: ["REPAIR_REQUIRED"]
    }
  ) {}

  public createSession(request: AgentRunRequest): Promise<AgentRunOutcome> {
    return this.run("CREATE", request);
  }

  public resume(sessionId: string, request: AgentRunRequest): Promise<AgentRunOutcome> {
    if (sessionId !== "reviewer-session-s1") {
      return Promise.reject(new Error(`unexpected Reviewer session: ${sessionId}`));
    }
    return this.run("RESUME", request, sessionId);
  }

  public cancel(): Promise<boolean> {
    for (const release of this.releases.values()) release();
    this.releases.clear();
    return Promise.resolve(true);
  }

  public async waitForCalls(count: number, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.calls.length < count && Date.now() < deadline) {
      await new Promise<void>((settle) => setTimeout(settle, 20));
    }
    if (this.calls.length < count) {
      throw new Error(`Timed out waiting for Review call ${String(count)}`);
    }
  }

  public release(callNumber: number): void {
    const release = this.releases.get(callNumber);
    if (release === undefined) throw new Error(`Review call ${String(callNumber)} is not blocked`);
    this.releases.delete(callNumber);
    release();
  }

  private async run(
    mode: "CREATE" | "RESUME",
    request: AgentRunRequest,
    sessionId?: string
  ): Promise<AgentRunOutcome> {
    const callNumber = this.calls.length + 1;
    const call: RecordedReviewCall = {
      mode,
      request,
      ...(sessionId === undefined ? {} : { sessionId }),
      tasksSource: await readFile(resolve(request.cwd, "tasks.md"), "utf8"),
      implementationSource: await readFile(resolve(request.cwd, "sum.js"), "utf8")
    };
    this.calls.push(call);
    if (this.blockedCalls.has(callNumber)) {
      await new Promise<void>((settle) => this.releases.set(callNumber, settle));
    }

    const plan = this.plans.get(callNumber) ?? this.defaultPlan;
    const taskIds = [...await this.loadTaskIds()];
    const targetTaskId = taskIds[0];
    if (targetTaskId === undefined) throw new Error("review source has no enabled tasks");
    const findingCodes = plan.findingCodes ?? ["REPAIR_REQUIRED"];
    const issues = findingCodes.map((code) => ({
      path: "sum.js",
      message: `sum requires corrective implementation for ${code}`,
      suggestedFix: `Update sum to satisfy ${code}`
    }));
    const result: ReviewResult = {
      tasks: taskIds.map((id) => plan.verdict === "APPROVE" || id !== targetTaskId
        ? { id, completionPercentage: 100, issues: [] }
        : { id, completionPercentage: 0, issues })
    };
    return {
      kind: "COMPLETED",
      sessionId: "reviewer-session-s1",
      finalResponse: result
    };
  }
}

function compositionFor(
  provider: WorkerProvider,
  adapter: AgentAdapter
): ProductionRuntimeComposition {
  return new ProductionRuntimeComposition(
    adapter,
    undefined,
    provider,
    Object.freeze({}),
    undefined,
    { deadlineMs: 60_000, maxAttempts: 3 }
  );
}

function runtimeFor(
  harness: RuntimeHarness,
  composition: ProductionRuntimeComposition
): ProjectRuntime {
  return new ProjectRuntime({
    dataDirectory: harness.dataDir,
    runPipeline: composition.runPipeline,
    review: composition.review,
    recover: composition.recover,
    cancel: composition.cancel,
    publish: composition.publish
  });
}

async function pollReviewTurn(
  runtime: ProjectRuntime,
  scope: { projectId: string; jobId: string },
  requestId: string,
  continuation: Record<string, unknown> = {}
): Promise<ReviewTurnOutput> {
  return runtime.handle({
    id: requestId,
    method: "smartflow_review_turn",
    payload: {
      requestId,
      projectId: scope.projectId,
      jobId: scope.jobId,
      hostTurnId: "host-turn-e2e",
      ...continuation
    }
  }) as Promise<ReviewTurnOutput>;
}

describe("production daemon Review repair loop", () => {
  it("reuses one immutable Job, its workspace, and one PI session across repair attempts", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksPath = resolve(harness.projectDir, "tasks.md");
    const tasksSource = createTasksSource({
      tasks: "## M01 · Core\n\n- [ ] T001 Edit `sum.js` — 验收：Reviewer confirms the requested behavior"
    });
    await writeFile(tasksPath, tasksSource, "utf8");

    let releaseGeneration1!: () => void;
    let generation1Reached!: () => void;
    const generation1Gate = new Promise<void>((settle) => {
      releaseGeneration1 = settle;
    });
    const generation1Scheduled = new Promise<void>((settle) => {
      generation1Reached = settle;
    });
    const provider = new RepairLoopProvider(
      (generation) => generation === 0 ? "1" : "stable",
      async (generation): Promise<void> => {
        if (generation === 1) {
          generation1Reached();
          await generation1Gate;
        }
      }
    );
    let resolveScope!: (scope: { store: StateStore; jobId: string }) => void;
    const scopeReady = new Promise<{ store: StateStore; jobId: string }>((settle) => {
      resolveScope = settle;
    });
    const adapter = new ScriptedReviewAdapter(
      new Map([
        [1, { verdict: "REQUEST_CHANGES", findingCodes: ["LEADER_EXPECTATION_MISSED"] }],
        [2, { verdict: "REQUEST_CHANGES", findingCodes: ["REPAIR_REQUIRED"] }],
        [3, { verdict: "APPROVE" }]
      ]),
      async () => {
        const scope = await scopeReady;
        return enabledTaskIdsForRun(scope.store, scope.jobId);
      },
      new Set([1, 2, 3])
    );
    const composition = compositionFor(provider, adapter);
    const runtime = runtimeFor(harness, composition);
    const execute = await runtime.handle({
      id: "execute-r1",
      method: "smartflow_execute",
      payload: {
        requestId: "execute-r1",
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md"
      }
    }) as { projectId: string; jobId: string };
    const store = new StateStore(resolve(harness.dataDir, "projects", execute.projectId));
    resolveScope({ store, jobId: execute.jobId });

    await adapter.waitForCalls(1);
    const firstState = await store.readState();
    const firstRun = firstState.runs[execute.jobId];
    if (
      firstRun === undefined ||
      firstRun.workspace === undefined ||
      firstRun.candidate === undefined
    ) {
      throw new Error("first Job evidence missing");
    }
    expect(firstRun).toMatchObject({
      phase: "REVIEWING",
      hostTurn: {
        stage: "AWAITING_REVIEW",
        hostTurnId: DAEMON_REVIEWER_HOST_TURN_ID
      }
    });
    const firstEvidence = {
      taskManifest: firstRun.taskManifest,
      taskSource: firstRun.taskSource,
      workspace: firstRun.workspace.relativePath,
      candidate: firstRun.candidate,
      candidateHash: firstRun.pendingAction?.candidateHash,
      attemptId: firstRun.workerAttempts.at(-1)?.attemptId,
      sessionId: firstRun.workerAttempts.at(-1)?.piSessionId
    };
    expect(await pollReviewTurn(runtime, execute, "poll-reviewing-r1"))
      .toEqual({ kind: "NOT_READY", retryAfterMs: 30_000 });

    adapter.release(1);
    await generation1Scheduled;
    const cleanState = await store.readState();
    const cleanRun = cleanState.runs[execute.jobId];
    expect(cleanRun).toMatchObject({
      phase: "RUNNING",
      taskManifest: firstEvidence.taskManifest,
      taskSource: firstEvidence.taskSource,
      workspace: { relativePath: firstEvidence.workspace }
    });
    expect(cleanRun?.candidate).toBeUndefined();
    expect(cleanRun?.review).toBeUndefined();
    expect(cleanRun?.leaderDecision).toBeUndefined();
    expect(cleanRun?.pendingAction).toBeUndefined();
    expect(cleanRun?.gitWorkspace?.current.resultSnapshot).toBeUndefined();
    expect(cleanRun?.gitWorkspace?.current.candidate).toBeUndefined();
    expect(cleanRun?.workerAttempts.map((attempt) => attempt.generation)).toEqual([0, 1]);

    releaseGeneration1();
    await adapter.waitForCalls(2);
    const secondRun = (await store.readState()).runs[execute.jobId];
    expect(secondRun).toMatchObject({
      phase: "REVIEWING",
      taskManifest: firstEvidence.taskManifest,
      taskSource: firstEvidence.taskSource,
      workspace: { relativePath: firstEvidence.workspace }
    });
    expect(secondRun?.candidate?.sha256).not.toBe(firstEvidence.candidate.sha256);
    expect(secondRun?.pendingAction?.candidateHash).not.toBe(firstEvidence.candidateHash);
    expect(secondRun?.workerAttempts.at(-1)?.attemptId).not.toBe(firstEvidence.attemptId);
    expect(secondRun?.workerAttempts.at(-1)?.piSessionId).toBe(firstEvidence.sessionId);

    adapter.release(2);
    await adapter.waitForCalls(3);
    const thirdRun = (await store.readState()).runs[execute.jobId];
    expect(thirdRun).toMatchObject({ phase: "REVIEWING" });
    expect(thirdRun?.pendingAction).not.toHaveProperty("claimId");
    expect(thirdRun?.pendingAction).not.toHaveProperty("claimExpiresAt");
    expect(thirdRun?.reviewHistory?.map((entry) => entry.reviewerSessionId))
      .toEqual(["reviewer-session-s1", "reviewer-session-s1"]);
    expect(adapter.calls.map((call) => call.mode)).toEqual(["CREATE", "RESUME", "RESUME"]);
    expect(adapter.calls.map((call) => call.tasksSource)).toEqual([
      tasksSource,
      tasksSource,
      tasksSource
    ]);
    expect(adapter.calls[0]?.implementationSource).toContain('implementationMarker = "1"');
    expect(adapter.calls[1]?.implementationSource).toContain('implementationMarker = "stable"');
    expect(adapter.calls[2]?.implementationSource).toContain('implementationMarker = "stable"');
    expect(provider.starts.map((start) => start.generation)).toEqual([0, 1, 2]);
    expect(new Set(provider.starts.map((start) => start.workspaceDir)).size).toBe(1);
    expect(new Set(provider.starts.map((start) => start.sessionId)).size).toBe(1);
    expect(provider.starts[0]?.resumeSession).toBeUndefined();
    expect(provider.starts[1]?.resumeSession?.expectedPiSessionId).toBe(firstEvidence.sessionId);
    expect(provider.starts[2]?.resumeSession?.expectedPiSessionId).toBe(firstEvidence.sessionId);
    expect(provider.starts[1]?.prompt).toContain("LEADER_EXPECTATION_MISSED");
    expect(provider.starts[2]?.prompt).toContain("REPAIR_REQUIRED");
    expect(provider.starts[1]?.restoredSession).toContain('"generation":0');
    expect(provider.starts[2]?.restoredSession).toContain('"generation":0');
    expect(provider.starts[2]?.restoredSession).toContain('"generation":1');

    adapter.release(3);
    const completed = await waitForState(
      store,
      execute.jobId,
      (state) => state.runs[execute.jobId]?.phase === "COMPLETED",
      15_000
    );
    expect(completed.runs[execute.jobId]).toMatchObject({ phase: "COMPLETED" });
  }, 30_000);

  it("pauses at the repair limit and later detects no progress", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksSource = createTasksSource({
      tasks: "## M01 · Core\n\n- [ ] T001 Edit `sum.js` — 验收：Reviewer confirms the requested behavior"
    });
    await writeFile(resolve(harness.projectDir, "tasks.md"), tasksSource, "utf8");
    const provider = new RepairLoopProvider(() => "stable");
    // The adapter is constructed before the Run exists, so it reads the Run
    // identity through a holder that the execute call fills in later.
    const reviewRef: { store?: StateStore; jobId?: string } = {};
    const adapter = new ScriptedReviewAdapter(new Map(), async () => {
      if (reviewRef.store === undefined || reviewRef.jobId === undefined) {
        await new Promise<void>((settle) => setTimeout(settle, 0));
      }
      const { store: reviewStore, jobId: reviewJobId } = reviewRef;
      if (reviewStore === undefined || reviewJobId === undefined) {
        throw new Error("review store not ready");
      }
      return enabledTaskIdsForRun(reviewStore, reviewJobId);
    });
    const composition = compositionFor(provider, adapter);
    const runtime = runtimeFor(harness, composition);
    const execute = await runtime.handle({
      id: "execute-no-progress",
      method: "smartflow_execute",
      payload: {
        requestId: "execute-no-progress",
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md"
      }
    }) as { projectId: string; jobId: string };
    const jobId = execute.jobId;
    const store = new StateStore(resolve(harness.dataDir, "projects", execute.projectId));
    reviewRef.jobId = jobId;
    reviewRef.store = store;

    await waitForState(
      store,
      jobId,
      (state) => state.runs[jobId]?.pause?.code === "AUTOMATIC_REPAIR_LIMIT",
      40_000
    );
    const limited = await pollReviewTurn(runtime, execute, "repair-limit-prompt");
    expect(limited).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      pause: { code: "AUTOMATIC_REPAIR_LIMIT" }
    });
    if (limited.kind !== "USER_INPUT_REQUIRED") throw new Error("repair limit prompt missing");
    expect(limited.options.map((option) => option.answer)).toContain("resume_review_decision");

    expect(await pollReviewTurn(runtime, execute, "repair-limit-resume", {
      turnToken: limited.turnToken,
      answer: "resume_review_decision"
    })).toEqual({ kind: "NOT_READY", retryAfterMs: 30_000 });

    const noProgress = await waitForState(
      store,
      jobId,
      (state) => state.runs[jobId]?.pause?.code === "REPAIR_NO_PROGRESS",
      40_000
    );
    expect(noProgress.runs[jobId]).toMatchObject({
      phase: "PAUSED",
      noProgressCount: 15,
      pause: { code: "REPAIR_NO_PROGRESS" }
    });
    expect(noProgress.runs[jobId]?.hostTurn).toBeUndefined();
    expect(noProgress.runs[jobId]?.pendingAction).toBeUndefined();
    expect(adapter.calls.map((call) => call.mode)).toEqual([
      "CREATE",
      ...Array.from({ length: adapter.calls.length - 1 }, () => "RESUME" as const)
    ]);
    expect(adapter.calls).toHaveLength(16);
    expect(provider.starts).toHaveLength(16);
    expect(provider.starts.map((start) => start.generation))
      .toEqual(Array.from({ length: 16 }, (_, index) => index));
    expect(new Set(provider.starts.map((start) => start.sessionId)).size).toBe(1);
  }, 90_000);

  it("uses only execute plus review_turn while daemon Review repairs and publishes", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksSource = createTasksSource({
      tasks: "## M01 · Core\n\n- [ ] T001 Edit `sum.js` — 验收：Reviewer confirms the requested behavior"
    });
    await writeFile(resolve(harness.projectDir, "tasks.md"), tasksSource, "utf8");
    const provider = new RepairLoopProvider((generation) => generation === 0 ? "1" : "stable");
    // The adapter is constructed before the Run exists, so it reads the Run
    // identity through a holder that the execute call fills in later.
    const reviewRef: { store?: StateStore; jobId?: string } = {};
    const adapter = new ScriptedReviewAdapter(
      new Map([
        [1, { verdict: "REQUEST_CHANGES", findingCodes: ["FIRST_ATTEMPT_INCOMPLETE"] }],
        [2, { verdict: "APPROVE" }]
      ]),
      async () => {
        if (reviewRef.store === undefined || reviewRef.jobId === undefined) {
          await new Promise<void>((settle) => setTimeout(settle, 0));
        }
        const { store: reviewStore, jobId: reviewJobId } = reviewRef;
        if (reviewStore === undefined || reviewJobId === undefined) {
          throw new Error("review store not ready");
        }
        return enabledTaskIdsForRun(reviewStore, reviewJobId);
      },
      new Set([1, 2])
    );
    const composition = compositionFor(provider, adapter);
    const runtime = runtimeFor(harness, composition);
    const toolNames: string[] = [];
    const call = async (method: "smartflow_execute" | "smartflow_review_turn", payload: unknown): Promise<unknown> => {
      toolNames.push(method);
      return runtime.handle({ id: `${method}-${String(toolNames.length)}`, method, payload });
    };
    const execute = await call("smartflow_execute", {
      requestId: "review-turn-execute",
      projectRoot: harness.projectDir,
      tasksPath: "tasks.md"
    }) as { projectId: string; jobId: string };
    const jobId = execute.jobId;
    const store = new StateStore(resolve(harness.dataDir, "projects", execute.projectId));
    reviewRef.jobId = jobId;
    reviewRef.store = store;

    await adapter.waitForCalls(1);
    const firstReviewing = await store.readState();
    const firstRun = firstReviewing.runs[jobId];
    if (firstRun === undefined) throw new Error("first review run missing");
    await store.writeState({
      ...firstReviewing,
      stateVersion: firstReviewing.stateVersion + 1,
      runs: {
        ...firstReviewing.runs,
        [jobId]: { ...firstRun, autoRepairRounds: 15, updatedAt: new Date().toISOString() }
      },
      updatedAt: new Date().toISOString()
    });
    const firstPoll = await call("smartflow_review_turn", {
      requestId: "review-turn-poll-1",
      projectId: execute.projectId,
      jobId,
      hostTurnId: "host-turn-e2e"
    }) as ReviewTurnOutput;
    expect(firstPoll).toEqual({ kind: "NOT_READY", retryAfterMs: 30_000 });

    adapter.release(1);
    await waitForState(
      store,
      jobId,
      (state) => state.runs[jobId]?.pause?.code === "AUTOMATIC_REPAIR_LIMIT",
      15_000
    );
    const paused = await call("smartflow_review_turn", {
      requestId: "review-turn-limit",
      projectId: execute.projectId,
      jobId,
      hostTurnId: "host-turn-e2e"
    }) as ReviewTurnOutput;
    expect(paused).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      pause: { code: "AUTOMATIC_REPAIR_LIMIT" },
      result: {
        review: {
          tasks: [{ id: "T001", completionPercentage: 0 }]
        }
      }
    });
    expect(JSON.stringify(paused)).not.toContain(adapter.calls[0]?.request.cwd);
    if (paused.kind !== "USER_INPUT_REQUIRED") throw new Error("repair limit prompt missing");

    const resumed = await call("smartflow_review_turn", {
      requestId: "review-turn-resume",
      projectId: execute.projectId,
      jobId,
      hostTurnId: "host-turn-e2e",
      turnToken: paused.turnToken,
      answer: "resume_review_decision"
    }) as ReviewTurnOutput;
    expect(resumed).toEqual({ kind: "NOT_READY", retryAfterMs: 30_000 });
    await adapter.waitForCalls(2);
    expect(adapter.calls[1]).toMatchObject({
      mode: "RESUME",
      sessionId: "reviewer-session-s1"
    });
    expect(await call("smartflow_review_turn", {
      requestId: "review-turn-poll-2",
      projectId: execute.projectId,
      jobId,
      hostTurnId: "host-turn-e2e"
    })).toEqual({ kind: "NOT_READY", retryAfterMs: 30_000 });

    adapter.release(2);
    await waitForState(
      store,
      jobId,
      (state) => state.runs[jobId]?.phase === "COMPLETED",
      15_000
    );
    const done = await call("smartflow_review_turn", {
      requestId: "review-turn-done",
      projectId: execute.projectId,
      jobId,
      hostTurnId: "host-turn-e2e"
    }) as ReviewTurnOutput;
    expect(done).toMatchObject({
      kind: "DONE",
      result: {
        phase: "COMPLETED",
        status: "COMMITTED"
      }
    });
    if (done.kind !== "DONE") throw new Error("completed run did not return DONE");
    expect(done.result.review?.tasks.every(
      (task) => task.completionPercentage === 100 && task.issues.length === 0
    )).toBe(true);

    const completedRun = (await store.readState()).runs[jobId];
    if (completedRun === undefined) throw new Error("completed run missing");
    const sessionArtifacts = completedRun.workerAttempts.flatMap((attempt) =>
      attempt.sessionArtifact === undefined ? [] : [attempt.sessionArtifact]
    );
    expect(sessionArtifacts).toHaveLength(2);
    const sessionArtifactPaths = new Set(
      sessionArtifacts.map((artifact) => artifact.relativePath)
    );
    const status = await runtime.handle({
      id: "status-with-private-session",
      method: "smartflow_status",
      payload: { projectId: execute.projectId, jobId }
    }) as RunSummary;
    expect(status.activeAttempt).not.toHaveProperty("sessionArtifact");
    const result = await runtime.handle({
      id: "result-with-private-session",
      method: "smartflow_result",
      payload: { projectId: execute.projectId, jobId }
    }) as ResultOutput;
    expect(result.artifacts.some(
      (artifact) => sessionArtifactPaths.has(artifact.relativePath)
    )).toBe(false);
    expect(done.result.artifacts.some(
      (artifact) => sessionArtifactPaths.has(artifact.relativePath)
    )).toBe(false);

    expect(await readFile(resolve(harness.projectDir, "sum.js"), "utf8"))
      .toContain('implementationMarker = "stable"');
    expect(provider.starts).toHaveLength(2);
    expect(new Set(toolNames)).toEqual(new Set([
      "smartflow_execute",
      "smartflow_review_turn"
    ]));
  }, 60_000);

  it("cancels daemon-owned Review while the Reviewer is running", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksSource = createTasksSource({
      tasks: "## M01 · Core\n\n- [ ] T001 Edit `sum.js` — 验收：Reviewer confirms the requested behavior"
    });
    await writeFile(resolve(harness.projectDir, "tasks.md"), tasksSource, "utf8");
    const provider = new RepairLoopProvider();
    const reviewRef: { store?: StateStore; jobId?: string } = {};
    const adapter = new ScriptedReviewAdapter(
      new Map([[1, { verdict: "APPROVE" }]]),
      async () => {
        if (reviewRef.store === undefined || reviewRef.jobId === undefined) {
          await new Promise<void>((settle) => setTimeout(settle, 0));
        }
        const { store: reviewStore, jobId: reviewJobId } = reviewRef;
        if (reviewStore === undefined || reviewJobId === undefined) {
          throw new Error("review store not ready");
        }
        return enabledTaskIdsForRun(reviewStore, reviewJobId);
      },
      new Set([1])
    );
    const composition = compositionFor(provider, adapter);
    const runtime = runtimeFor(harness, composition);
    const execute = await runtime.handle({
      id: "execute-cancel-review",
      method: "smartflow_execute",
      payload: {
        requestId: "execute-cancel-review",
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md"
      }
    }) as { projectId: string; jobId: string };
    const store = new StateStore(resolve(harness.dataDir, "projects", execute.projectId));
    reviewRef.store = store;
    reviewRef.jobId = execute.jobId;

    await adapter.waitForCalls(1);
    const reviewing = await store.readState();
    const reviewingRun = reviewing.runs[execute.jobId];
    expect(reviewingRun).toMatchObject({
      phase: "REVIEWING",
      hostTurn: { hostTurnId: DAEMON_REVIEWER_HOST_TURN_ID }
    });
    if (reviewingRun === undefined) throw new Error("reviewing run missing");

    await expect(runtime.handle({
      id: "cancel-running-review",
      method: "smartflow_cancel",
      payload: {
        requestId: "cancel-running-review",
        projectId: execute.projectId,
        jobId: execute.jobId,
        reason: "user canceled daemon review"
      }
    })).resolves.toMatchObject({ phase: "CANCELING" });

    const canceled = await waitForState(
      store,
      execute.jobId,
      (state) => state.runs[execute.jobId]?.phase === "CANCELED",
      15_000
    );
    const canceledRun = canceled.runs[execute.jobId];
    expect(canceledRun).toMatchObject({
      phase: "CANCELED",
      cancellation: { status: "COMPLETED" }
    });
    expect(canceledRun).not.toHaveProperty("hostTurn");
  }, 30_000);
});
