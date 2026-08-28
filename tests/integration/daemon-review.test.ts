import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DAEMON_REVIEWER_HOST_TURN_ID,
  ReviewRunner,
  pendingReviewAction
} from "@smartflow/daemon";
import { StructuredLogger } from "@smartflow/observability";
import type {
  AgentAdapter,
  AgentRunOutcome,
  AgentRunRequest
} from "@smartflow/review";
import type { StateStore } from "@smartflow/state-store";
import { createLifecycleStore } from "../crash/recovery-test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

type RecordedCall =
  | { mode: "CREATE"; request: AgentRunRequest }
  | { mode: "RESUME"; sessionId: string; request: AgentRunRequest };

class FakeReviewAdapter implements AgentAdapter {
  public readonly calls: RecordedCall[] = [];

  public constructor(private readonly outcomes: AgentRunOutcome[]) {}

  public createSession(request: AgentRunRequest): Promise<AgentRunOutcome> {
    this.calls.push({ mode: "CREATE", request });
    return Promise.resolve(this.nextOutcome());
  }

  public resume(sessionId: string, request: AgentRunRequest): Promise<AgentRunOutcome> {
    this.calls.push({ mode: "RESUME", sessionId, request });
    return Promise.resolve(this.nextOutcome());
  }

  public cancel(runId: string): Promise<boolean> {
    void runId;
    return Promise.resolve(true);
  }

  private nextOutcome(): AgentRunOutcome {
    const next = this.outcomes.shift();
    if (next === undefined) throw new Error("Fake Review Adapter has no configured outcome");
    return next;
  }
}

interface LogRecord {
  event: string;
  data?: Record<string, unknown>;
}

const REVIEW_MODEL = "test-review-model";
const REVIEW_EFFORT = "xhigh";

const activeHarnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

async function reviewFixture(): Promise<{
  harness: RuntimeHarness;
  store: StateStore;
}> {
  const harness = await createRuntimeHarness();
  activeHarnesses.push(harness);
  const store = await createLifecycleStore(harness, "REVIEW_PENDING", {}, {
    dataDirectory: resolve(harness.dataDir, "daemon-review"),
    projectId: "project-1"
  });
  return { harness, store };
}

function captureLogger(): { logger: StructuredLogger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    logger: new StructuredLogger("daemon-review-test", (line) => {
      records.push(JSON.parse(line) as LogRecord);
    }),
    records
  };
}

function acceptedResult(): unknown {
  return {
    tasks: [{ id: "T001", completionPercentage: 100, issues: [] }]
  };
}

function invalidSemanticResult(): unknown {
  return {
    tasks: [{
      id: "T001",
      completionPercentage: 100,
      issues: [{
        path: "sum.js",
        message: "sum returns an incorrect result for negative operands",
        suggestedFix: null
      }]
    }]
  };
}

function runner(
  store: StateStore,
  adapter: AgentAdapter,
  maxAttempts: number,
  logger?: StructuredLogger
): ReviewRunner {
  return new ReviewRunner(store, adapter, {
    model: REVIEW_MODEL,
    effort: REVIEW_EFFORT,
    deadlineMs: 60_000,
    maxAttempts,
    ...(logger === undefined ? {} : { logger })
  });
}

async function putReviewing(
  store: StateStore,
  turnToken = "durable-review-turn"
): Promise<Awaited<ReturnType<StateStore["readState"]>>> {
  const state = await store.readState();
  const run = state.runs["job-1"];
  if (run === undefined) throw new Error("Review fixture has no run");
  const action = pendingReviewAction(run);
  if (action === undefined) throw new Error("Review fixture has no pending action");
  const now = new Date();
  return store.writeState({
    ...state,
    stateVersion: state.stateVersion + 1,
    runs: {
      ...state.runs,
      "job-1": {
        ...run,
        phase: "REVIEWING",
        pendingAction: {
          ...action,
          expiresAt: new Date(now.getTime() + 60_000).toISOString()
        },
        hostTurn: {
          stage: "AWAITING_REVIEW",
          turnToken,
          hostTurnId: DAEMON_REVIEWER_HOST_TURN_ID,
          reviewAttemptId: action.reviewAttemptId,
          startedAt: now.toISOString(),
          deadlineAt: new Date(now.getTime() + 60_000).toISOString()
        },
        updatedAt: now.toISOString()
      }
    },
    updatedAt: now.toISOString()
  });
}

describe("ReviewRunner", () => {
  it("accepts a valid review and schedules publish", async () => {
    const { store } = await reviewFixture();
    const initial = await store.readState();
    const initialRun = initial.runs["job-1"];
    if (initialRun === undefined) throw new Error("Review fixture has no run");
    const action = pendingReviewAction(initialRun);
    if (action === undefined) throw new Error("Review fixture has no action");
    const adapter = new FakeReviewAdapter([{
      kind: "COMPLETED",
      sessionId: "review-session-accept",
      finalResponse: acceptedResult()
    }]);

    await expect(runner(store, adapter, 2).run({
      projectId: "project-1",
      jobId: "job-1"
    })).resolves.toEqual({ schedule: "publish" });

    expect(adapter.calls).toHaveLength(1);
    const call = adapter.calls[0];
    expect(call?.mode).toBe("CREATE");
    if (call === undefined) throw new Error("Expected a Review Adapter call");
    expect(call.request.outputSchemaPath).toBe(resolve(
      store.dataDirectory,
      `runs/job-1/reviews/${action.reviewAttemptId}.schema.json`
    ));
    expect(call.request.outputPath).toBe(resolve(
      store.dataDirectory,
      `runs/job-1/reviews/${action.reviewAttemptId}.output.json`
    ));
    expect(call.request.outputSchemaPath).not.toBe(call.request.outputPath);
    expect(call.request).toMatchObject({ model: REVIEW_MODEL, effort: REVIEW_EFFORT });
    const schema = JSON.parse(await readFile(call.request.outputSchemaPath, "utf8")) as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema).toMatchObject({ required: ["tasks"], additionalProperties: false });

    const reviewed = (await store.readState()).runs["job-1"];
    expect(reviewed).toMatchObject({
      phase: "READY_TO_PUBLISH",
      reviewHistory: [{
        reviewAttemptId: action.reviewAttemptId,
        reviewerSessionId: "review-session-accept"
      }]
    });
    expect(reviewed?.pendingAction).toBeUndefined();
    expect(reviewed?.hostTurn).toBeUndefined();
    expect(reviewed?.review).toBeDefined();
    expect(reviewed?.leaderDecision).toBeDefined();
  });

  it("routes a repair review back to the pipeline", async () => {
    const { store } = await reviewFixture();
    const adapter = new FakeReviewAdapter([{
      kind: "COMPLETED",
      sessionId: "review-session-repair",
      finalResponse: {
        tasks: [{
          id: "T001",
          completionPercentage: 50,
          issues: [{
            path: "sum.js",
            message: "sum returns the wrong total when either operand is negative",
            suggestedFix: "Handle signed operands before returning the total"
          }]
        }]
      }
    }]);

    await expect(runner(store, adapter, 1).run({
      projectId: "project-1",
      jobId: "job-1"
    })).resolves.toEqual({ schedule: "pipeline" });

    const reviewed = (await store.readState()).runs["job-1"];
    expect(reviewed).toMatchObject({
      phase: "FIXING",
      autoRepairRounds: 1,
      reviewHistory: [{ reviewerSessionId: "review-session-repair" }]
    });
    expect(reviewed?.hostTurn).toBeUndefined();
  });

  it("corrects invalid semantic output by resuming the created session", async () => {
    const { store } = await reviewFixture();
    const { logger, records } = captureLogger();
    const adapter = new FakeReviewAdapter([
      {
        kind: "COMPLETED",
        sessionId: "review-session-correction",
        finalResponse: invalidSemanticResult()
      },
      {
        kind: "COMPLETED",
        sessionId: "review-session-correction",
        finalResponse: acceptedResult()
      }
    ]);

    await expect(runner(store, adapter, 2, logger).run({
      projectId: "project-1",
      jobId: "job-1"
    })).resolves.toEqual({ schedule: "publish" });

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]?.mode).toBe("CREATE");
    expect(adapter.calls[1]).toMatchObject({
      mode: "RESUME",
      sessionId: "review-session-correction"
    });
    expect(adapter.calls[1]?.request.prompt).toContain("## Correction required for this round");
    expect(adapter.calls[1]?.request.prompt).toContain("REVIEW_OUTPUT_INVALID");
    // The resumed round must carry the same model and effort as the first round.
    expect(adapter.calls[1]?.request).toMatchObject({
      model: REVIEW_MODEL,
      effort: REVIEW_EFFORT
    });
    const outcomes = records.filter((record) => record.event === "daemon_review.adapter_outcome");
    expect(outcomes[0]?.data).toMatchObject({ model: REVIEW_MODEL, effort: REVIEW_EFFORT });
    const rejected = records.find((record) => record.event === "daemon_review.attempt_rejected");
    expect(rejected?.data?.attempt).toBe(1);
    expect(rejected?.data?.willRetry).toBe(true);
    const rejectionReason = rejected?.data?.reason;
    if (typeof rejectionReason !== "string") throw new Error("Expected a rejection reason");
    expect(rejectionReason).toContain("REVIEW_OUTPUT_INVALID");
    expect((await store.readState()).runs["job-1"]?.reviewHistory).toHaveLength(1);
  });

  it("corrects exact Task coverage on the same session before finalize", async () => {
    const { store } = await reviewFixture();
    const adapter = new FakeReviewAdapter([
      {
        kind: "COMPLETED",
        sessionId: "review-session-coverage",
        finalResponse: {
          tasks: [{ id: "T999", completionPercentage: 100, issues: [] }]
        }
      },
      {
        kind: "COMPLETED",
        sessionId: "review-session-coverage",
        finalResponse: acceptedResult()
      }
    ]);

    await expect(runner(store, adapter, 2).run({
      projectId: "project-1",
      jobId: "job-1"
    })).resolves.toEqual({ schedule: "publish" });

    expect(adapter.calls[1]).toMatchObject({
      mode: "RESUME",
      sessionId: "review-session-coverage"
    });
    expect(adapter.calls[1]?.request.prompt).toContain("REVIEW_TASK_COVERAGE_INCOMPLETE");
    expect(adapter.calls[1]?.request.prompt).toContain("expected=T001;observed=T999");
  });

  it("pauses after the total call budget and removes the daemon host owner", async () => {
    const { store } = await reviewFixture();
    const { logger, records } = captureLogger();
    const adapter = new FakeReviewAdapter([
      {
        kind: "COMPLETED",
        sessionId: "review-session-exhausted",
        finalResponse: invalidSemanticResult()
      },
      {
        kind: "COMPLETED",
        sessionId: "review-session-exhausted",
        finalResponse: invalidSemanticResult()
      }
    ]);

    await expect(runner(store, adapter, 2, logger).run({
      projectId: "project-1",
      jobId: "job-1"
    })).resolves.toEqual({ schedule: "none" });

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]).toMatchObject({
      mode: "RESUME",
      sessionId: "review-session-exhausted"
    });
    const paused = (await store.readState()).runs["job-1"];
    expect(paused).toMatchObject({
      phase: "PAUSED",
      pause: {
        code: "HOST_REVIEW_UNAVAILABLE",
        resumeActions: ["retry_host_review", "cancel"]
      },
      pendingAction: {
        type: "REVIEW"
      },
      lastError: {
        code: "HOST_REVIEW_UNAVAILABLE"
      }
    });
    expect(paused?.lastError?.message).toContain("maxAttempts=2");
    expect(paused?.hostTurn).toBeUndefined();
    expect(paused?.review).toBeUndefined();
    expect(records.filter((record) => record.event === "daemon_review.attempt_rejected"))
      .toHaveLength(2);
    const pauseRecord = records.find((record) => record.event === "daemon_review.paused");
    const pauseReason = pauseRecord?.data?.reason;
    if (typeof pauseReason !== "string") throw new Error("Expected a pause reason");
    expect(pauseReason).toContain("DAEMON_REVIEW_ATTEMPTS_EXHAUSTED");
  });

  it("recovers a daemon-owned REVIEWING turn without beginning it again", async () => {
    const { store } = await reviewFixture();
    const claimed = await putReviewing(store);
    const adapter = new FakeReviewAdapter([{
      kind: "COMPLETED",
      sessionId: "review-session-recovered",
      finalResponse: acceptedResult()
    }]);

    await expect(runner(store, adapter, 1).run({
      projectId: "project-1",
      jobId: "job-1"
    })).resolves.toEqual({ schedule: "publish" });

    const recovered = await store.readState();
    expect(recovered.stateVersion).toBe(claimed.stateVersion + 1);
    expect(recovered.runs["job-1"]).toMatchObject({
      phase: "READY_TO_PUBLISH",
      reviewHistory: [{ reviewerSessionId: "review-session-recovered" }]
    });
    expect(Object.keys(recovered.processedRequests).some(
      (requestId) => requestId.startsWith("daemon-review-begin-")
    )).toBe(false);
  });

  it("retries real reviewer startup failures and pauses with the final reason", async () => {
    const { store } = await reviewFixture();
    const adapter = new FakeReviewAdapter([
      {
        kind: "FAILED",
        code: "CODEX_SPAWN_FAILED",
        message: "codex executable was not found"
      },
      {
        kind: "FAILED",
        code: "CODEX_SPAWN_FAILED",
        message: "codex executable was not found"
      }
    ]);

    await expect(runner(store, adapter, 2).run({
      projectId: "project-1",
      jobId: "job-1"
    })).resolves.toEqual({ schedule: "none" });

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls.every((call) => call.mode === "CREATE")).toBe(true);
    expect(adapter.calls[1]?.request.prompt).toContain("CODEX_SPAWN_FAILED");
    const paused = (await store.readState()).runs["job-1"];
    expect(paused).toMatchObject({
      phase: "PAUSED",
      pause: { code: "HOST_REVIEW_UNAVAILABLE" },
      lastError: {
        code: "HOST_REVIEW_UNAVAILABLE"
      }
    });
    expect(paused?.lastError?.message).toContain("CODEX_SPAWN_FAILED");
    expect(paused?.lastError?.message).toContain("codex executable was not found");
    expect(paused?.hostTurn).toBeUndefined();
  });
});
