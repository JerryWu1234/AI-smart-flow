import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  StateStore,
  StateStoreError,
  type ProjectState,
  type RunRecord
} from "@smartflow/state-store";
import {
  createProjectState,
  createRunRecord
} from "../../../packages/state-store/src/test-fixture.js";

import {
  HostTurnCoordinator,
  type HostTurnCoordinatorDependencies
} from "./host-turn-coordinator.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const nowText = "2026-08-11T10:00:00.000Z";
const projectId = "project-1";
const jobId = "job-1";

const temporaryDirectories: string[] = [];
const coordinators: HostTurnCoordinator[] = [];

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function reviewAction(): Record<string, unknown> {
  return {
    type: "REVIEW",
    actionId: "review-action-1",
    revision: 1,
    taskSourceHash: digestA,
    candidateHash: digestB,
    reviewAttemptId: "review-attempt-1",
    changedPaths: ["src/a.ts"],
    reviewerSession: { mode: "CREATE" },
    piSessionId: "pi-session-1",
    expiresAt: "2026-08-11T10:15:00.000Z"
  };
}

function reviewRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return createRunRecord({
    phase: "REVIEW_PENDING",
    pendingAction: reviewAction(),
    workspace: {
      relativePath: "worktrees/job-1",
      baselineHash: digestA,
      generation: 0,
      sandboxId: "sandbox-1",
      mutable: true
    },
    createdAt: nowText,
    updatedAt: nowText,
    ...overrides
  });
}

async function createStore(run: RunRecord): Promise<StateStore> {
  const directory = await mkdtemp(join(tmpdir(), "smartflow-host-turn-"));
  temporaryDirectories.push(directory);
  const store = new StateStore(join(directory, projectId));
  await store.initialize(createProjectState({
    projectId,
    canonicalProjectRoot: directory,
    runs: { [run.jobId]: run }
  }));
  return store;
}

async function writeRun(
  store: StateStore,
  update: (run: RunRecord, state: ProjectState) => RunRecord
): Promise<ProjectState> {
  const state = await store.readState();
  const run = state.runs[jobId];
  if (run === undefined) throw new Error("RUN_NOT_FOUND");
  const nextRun = update(run, state);
  const terminal = new Set(["COMPLETED", "CANCELED", "FAILED"]).has(nextRun.phase);
  return store.writeState({
    ...state,
    stateVersion: state.stateVersion + 1,
    activeRunsByTaskPath: terminal
      ? Object.fromEntries(Object.entries(state.activeRunsByTaskPath).filter(
          ([, activeJobId]) => activeJobId !== jobId
        ))
      : state.activeRunsByTaskPath,
    runs: { ...state.runs, [jobId]: nextRun },
    updatedAt: new Date().toISOString()
  });
}

function resultFor(run: RunRecord, repairDraft?: Record<string, unknown>): Record<string, unknown> {
  const terminal = run.phase === "COMPLETED";
  return {
    projectId,
    jobId,
    phase: run.phase,
    status: terminal ? "COMMITTED" : run.phase === "PAUSED" ? "PAUSED" : "RUNNING",
    artifacts: [],
    nextActions: run.pause?.resumeActions ?? [],
    ...(repairDraft === undefined ? {} : { repairDraft })
  };
}

function unexpectedDependency(name: string): Promise<never> {
  return Promise.reject(new Error(`UNEXPECTED_${name}`));
}

function createDependencies(
  store: StateStore,
  overrides: Partial<HostTurnCoordinatorDependencies> = {},
  repairDraft?: Record<string, unknown>
): HostTurnCoordinatorDependencies {
  return {
    store: (): StateStore => store,
    status: async (): Promise<unknown> => {
      const state = await store.readState();
      const run = state.runs[jobId];
      if (run === undefined) throw new Error("RUN_NOT_FOUND");
      return {
        projectId,
        jobId,
        phase: run.phase,
        revision: run.revision,
        stateVersion: state.stateVersion,
        progress: { completed: run.phase === "REVIEW_PENDING" ? 1 : 0, total: 1 },
        ...(run.phase === "REVIEW_PENDING" || run.phase === "REVIEWING"
          ? { pendingAction: reviewAction() }
          : {}),
        ...(run.pause === undefined ? {} : { pause: run.pause })
      };
    },
    wait: async (input): Promise<unknown> => {
      const summary = await createDependencies(store).status(input);
      return { changed: false, stateVersion: input.afterStateVersion, summary };
    },
    claim: (): Promise<never> => unexpectedDependency("CLAIM"),
    renew: (): Promise<never> => unexpectedDependency("RENEW"),
    submitReview: (): Promise<never> => unexpectedDependency("REVIEW"),
    reportHostUnavailable: (): Promise<never> => unexpectedDependency("UNAVAILABLE"),
    submitLeaderDecision: (): Promise<never> => unexpectedDependency("DECISION"),
    resume: (): Promise<never> => unexpectedDependency("RESUME"),
    result: async (): Promise<unknown> => {
      const state = await store.readState();
      const run = state.runs[jobId];
      if (run === undefined) throw new Error("RUN_NOT_FOUND");
      return resultFor(run, repairDraft);
    },
    ...overrides
  };
}

function createCoordinator(dependencies: HostTurnCoordinatorDependencies): HostTurnCoordinator {
  const coordinator = new HostTurnCoordinator(dependencies);
  coordinators.push(coordinator);
  return coordinator;
}

function claimedRun(run: RunRecord, claimExpiresAt: string): RunRecord {
  return {
    ...run,
    phase: "REVIEWING",
    pendingAction: {
      ...reviewAction(),
      claimId: "claim-1",
      hostTurnId: "host-1",
      claimExpiresAt,
      claimStatus: "CLAIMED"
    },
    hostTurn: {
      stage: "AWAITING_REVIEW",
      turnToken: "turn-current",
      hostTurnId: "host-1",
      revision: 1,
      actionId: "review-action-1",
      claimId: "claim-1",
      reviewAttemptId: "review-attempt-1",
      startedAt: nowText,
      deadlineAt: "2026-08-11T10:30:00.000Z"
    }
  };
}

describe("HostTurnCoordinator safety and recovery", () => {
  it.each([
    { field: "review", value: {
      reviewerSessionId: "reviewer-1",
      result: { completionPercentage: 100, tasks: [{ id: "T001", completionPercentage: 100 }] }
    } },
    { field: "reviewUnavailableReason", value: "reviewer disappeared" },
    { field: "answer", value: "cancel" }
  ])("treats stale $field continuations as read-only NOT_READY", async ({ field, value }) => {
    const store = await createStore(reviewRun());
    const claim = vi.fn((): Promise<never> => Promise.reject(new Error("MUST_NOT_CLAIM")));
    const coordinator = createCoordinator(createDependencies(store, { claim }));

    const output = await coordinator.turn({
      requestId: `stale-${field}`,
      projectId,
      jobId,
      hostTurnId: "old-host",
      turnToken: "turn-stale",
      [field]: value
    });

    expect(output).toMatchObject({ kind: "NOT_READY", phase: "REVIEW_PENDING" });
    expect(JSON.stringify(output)).not.toContain("worktreePath");
    expect(claim).not.toHaveBeenCalled();
    expect((await store.readState()).runs[jobId]?.hostTurn).toBeUndefined();
  });

  it("does not let another Host take over or retry a paused review turn", async () => {
    const active = claimedRun(reviewRun(), "2026-08-11T10:05:00.000Z");
    const store = await createStore({
      ...active,
      phase: "PAUSED",
      pause: {
        code: "HOST_REVIEW_UNAVAILABLE",
        resumeActions: ["retry_host_review", "cancel"]
      }
    });
    const claim = vi.fn((): Promise<never> => Promise.reject(new Error("MUST_NOT_CLAIM")));
    const resume = vi.fn((): Promise<never> => Promise.reject(new Error("MUST_NOT_RESUME")));
    const coordinator = createCoordinator(createDependencies(store, { claim, resume }));

    await expect(coordinator.turn({
      requestId: "paused-review-wrong-host",
      projectId,
      jobId,
      hostTurnId: "host-2"
    })).rejects.toThrow("HOST_TURN_OWNED_BY_ANOTHER_HOST");
    expect((await store.readState()).runs[jobId]?.hostTurn).toMatchObject({
      stage: "AWAITING_REVIEW",
      hostTurnId: "host-1"
    });

    const prompt = await coordinator.turn({
      requestId: "paused-review-owner",
      projectId,
      jobId,
      hostTurnId: "host-1"
    });
    expect(prompt).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      options: [
        { answer: "retry_host_review" },
        { answer: "cancel" }
      ]
    });
    if (prompt.kind !== "USER_INPUT_REQUIRED") {
      throw new Error("USER input prompt missing");
    }
    expect((await store.readState()).runs[jobId]?.hostTurn).toMatchObject({
      stage: "AWAITING_USER_INPUT",
      hostTurnId: "host-1",
      turnToken: prompt.turnToken
    });

    await expect(coordinator.turn({
      requestId: "paused-review-wrong-host-retry",
      projectId,
      jobId,
      hostTurnId: "host-2",
      turnToken: prompt.turnToken,
      answer: "retry_host_review"
    })).rejects.toThrow("HOST_TURN_OWNED_BY_ANOTHER_HOST");
    expect(claim).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("retries a project-wide CAS conflict with the same child request id", async () => {
    const store = await createStore(reviewRun());
    const requestIds: string[] = [];
    let calls = 0;
    const claim = vi.fn(async (input: Parameters<HostTurnCoordinatorDependencies["claim"]>[0]) => {
      calls += 1;
      requestIds.push(input.requestId);
      if (calls === 1) {
        await writeRun(store, (run) => ({ ...run, updatedAt: new Date().toISOString() }));
        throw new StateStoreError("STATE_VERSION_MISMATCH", "competing run advanced project state");
      }
      const leaseExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const next = await writeRun(store, (run) => ({
        ...run,
        phase: "REVIEWING",
        pendingAction: {
          ...run.pendingAction,
          claimId: "claim-1",
          hostTurnId: input.hostTurnId,
          claimExpiresAt: leaseExpiresAt,
          claimStatus: "CLAIMED"
        }
      }));
      return {
        claimId: "claim-1",
        action: { ...reviewAction(), worktreePath: join(store.dataDirectory, "worktrees/job-1") },
        stateVersion: next.stateVersion,
        expiresAt: leaseExpiresAt
      };
    });
    const coordinator = createCoordinator(createDependencies(store, { claim }));

    const output = await coordinator.turn({
      requestId: "claim-with-cas",
      projectId,
      jobId,
      hostTurnId: "host-1"
    });

    expect(output).toMatchObject({ kind: "REVIEW_REQUIRED", reviewAttemptId: "review-attempt-1" });
    expect(claim).toHaveBeenCalledTimes(2);
    expect(new Set(requestIds).size).toBe(1);
    expect((await store.readState()).runs[jobId]?.hostTurn?.stage).toBe("AWAITING_REVIEW");
  });

  it("renews before a near-expiry lease after restart and polling cannot postpone it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const store = await createStore(claimedRun(reviewRun(), "2026-08-11T10:00:10.000Z"));
    const renew = vi.fn(async () => {
      const next = await writeRun(store, (run) => ({
        ...run,
        pendingAction: {
          ...run.pendingAction,
          claimExpiresAt: "2026-08-11T10:05:00.000Z"
        }
      }));
      return {
        projectId,
        jobId,
        revision: 1,
        stateVersion: next.stateVersion,
        phase: "REVIEWING",
        expiresAt: "2026-08-11T10:05:00.000Z"
      };
    });
    const coordinator = createCoordinator(createDependencies(store, { renew }));

    await coordinator.recoverRun(projectId, jobId);
    const polled = await coordinator.turn({
      requestId: "poll-near-expiry",
      projectId,
      jobId,
      hostTurnId: "host-1"
    });
    expect(polled.kind).toBe("REVIEW_REQUIRED");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));

    expect(renew).toHaveBeenCalledTimes(1);
  });

  it("keeps daemon recovery available when an expired review pause report fails once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const active = claimedRun(reviewRun(), "2026-08-11T10:05:00.000Z");
    if (active.hostTurn?.stage !== "AWAITING_REVIEW") {
      throw new Error("AWAITING_REVIEW fixture missing");
    }
    const store = await createStore({
      ...active,
      hostTurn: { ...active.hostTurn, deadlineAt: "2026-08-11T09:59:00.000Z" }
    });
    let reportCalls = 0;
    const reportHostUnavailable = vi.fn(async (
      input: Parameters<HostTurnCoordinatorDependencies["reportHostUnavailable"]>[0]
    ) => {
      reportCalls += 1;
      if (reportCalls === 1) throw new Error("transient recovery pause failure");
      const next = await writeRun(store, (run) => ({
        ...run,
        phase: "PAUSED",
        pause: { code: "HOST_REVIEW_UNAVAILABLE", resumeActions: ["retry_host_review", "cancel"] },
        lastError: {
          code: "HOST_REVIEW_UNAVAILABLE",
          stage: "review",
          message: input.hostUnavailableReason,
          retryable: true,
          nextActions: ["retry_host_review", "cancel"],
          artifacts: []
        }
      }));
      return { projectId, jobId, revision: 1, stateVersion: next.stateVersion, phase: "PAUSED" };
    });
    const coordinator = createCoordinator(createDependencies(store, { reportHostUnavailable }));

    await expect(coordinator.recoverRun(projectId, jobId)).resolves.toBeUndefined();
    expect(reportHostUnavailable).toHaveBeenCalledTimes(1);
    expect((await store.readState()).runs[jobId]?.phase).toBe("REVIEWING");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() => expect(reportHostUnavailable).toHaveBeenCalledTimes(2));
    expect((await store.readState()).runs[jobId]).toMatchObject({
      phase: "PAUSED",
      pause: { code: "HOST_REVIEW_UNAVAILABLE" }
    });
  });

  it("durably pauses when repeated renewal rejection prevents maintaining the lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const store = await createStore(claimedRun(reviewRun(), "2026-08-11T10:05:00.000Z"));
    const renew = vi.fn((): Promise<never> => Promise.reject(new Error("renewal rejected")));
    const reportHostUnavailable = vi.fn(async (
      input: Parameters<HostTurnCoordinatorDependencies["reportHostUnavailable"]>[0]
    ) => {
      const next = await writeRun(store, (run) => ({
        ...run,
        phase: "PAUSED",
        pause: { code: "HOST_REVIEW_UNAVAILABLE", resumeActions: ["retry_host_review", "cancel"] },
        lastError: {
          code: "HOST_REVIEW_UNAVAILABLE",
          stage: "review",
          message: input.hostUnavailableReason,
          retryable: true,
          nextActions: ["retry_host_review", "cancel"],
          artifacts: []
        }
      }));
      return { projectId, jobId, revision: 1, stateVersion: next.stateVersion, phase: "PAUSED" };
    });
    const coordinator = createCoordinator(createDependencies(store, {
      renew,
      reportHostUnavailable
    }));

    await coordinator.recoverRun(projectId, jobId);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(2));
    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(reportHostUnavailable).toHaveBeenCalledTimes(1));

    expect(renew).toHaveBeenCalledTimes(3);
    expect(reportHostUnavailable).toHaveBeenCalledTimes(1);
    expect((await store.readState()).runs[jobId]).toMatchObject({
      phase: "PAUSED",
      pause: { code: "HOST_REVIEW_UNAVAILABLE" }
    });
  });

  it("replays a pre-claim CLAIMING checkpoint after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const turn = {
      stage: "CLAIMING" as const,
      turnToken: "turn-claiming",
      hostTurnId: "host-1",
      revision: 1,
      actionId: "review-action-1",
      startedAt: nowText,
      deadlineAt: "2026-08-11T10:30:00.000Z"
    };
    const store = await createStore(reviewRun({ hostTurn: turn }));
    const claim = vi.fn(async (input: Parameters<HostTurnCoordinatorDependencies["claim"]>[0]) => {
      const next = await writeRun(store, (run) => ({
        ...run,
        phase: "REVIEWING",
        pendingAction: {
          ...run.pendingAction,
          claimId: "claim-1",
          hostTurnId: input.hostTurnId,
          claimExpiresAt: "2026-08-11T10:05:00.000Z",
          claimStatus: "CLAIMED"
        }
      }));
      return {
        claimId: "claim-1",
        action: { ...reviewAction(), worktreePath: join(store.dataDirectory, "worktrees/job-1") },
        stateVersion: next.stateVersion,
        expiresAt: "2026-08-11T10:05:00.000Z"
      };
    });
    const coordinator = createCoordinator(createDependencies(store, { claim }));

    await coordinator.recoverRun(projectId, jobId);

    expect(claim).toHaveBeenCalledTimes(1);
    expect((await store.readState()).runs[jobId]?.hostTurn).toMatchObject({
      stage: "AWAITING_REVIEW",
      turnToken: "turn-claiming",
      claimId: "claim-1"
    });
  });

  it("clears an expired pre-claim checkpoint so it cannot retain Host ownership", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const store = await createStore(reviewRun({
      hostTurn: {
        stage: "CLAIMING",
        turnToken: "turn-expired",
        hostTurnId: "old-host",
        revision: 1,
        actionId: "review-action-1",
        startedAt: "2026-08-11T09:00:00.000Z",
        deadlineAt: "2026-08-11T09:30:00.000Z"
      }
    }));
    const claim = vi.fn((): Promise<never> =>
      Promise.reject(new Error("MUST_NOT_CLAIM_EXPIRED_INTENT"))
    );
    const coordinator = createCoordinator(createDependencies(store, { claim }));

    const output = await coordinator.turn({
      requestId: "replace-expired-claiming-owner",
      projectId,
      jobId,
      hostTurnId: "replacement-host"
    });

    expect(output).toMatchObject({ kind: "NOT_READY", phase: "REVIEW_PENDING" });
    expect(claim).not.toHaveBeenCalled();
    expect((await store.readState()).runs[jobId]?.hostTurn).toBeUndefined();
  });

  it("keeps daemon recovery available when pre-claim replay fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const store = await createStore(reviewRun({
      hostTurn: {
        stage: "CLAIMING",
        turnToken: "turn-recovery-failure",
        hostTurnId: "host-1",
        revision: 1,
        actionId: "review-action-1",
        startedAt: nowText,
        deadlineAt: "2026-08-11T10:30:00.000Z"
      }
    }));
    const claim = vi.fn((): Promise<never> =>
      Promise.reject(new Error("recovery claim transport failed"))
    );
    const coordinator = createCoordinator(createDependencies(store, { claim }));

    await expect(coordinator.recoverRun(projectId, jobId)).resolves.toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(1);
    expect((await store.readState()).runs[jobId]?.hostTurn?.stage).toBe("CLAIMING");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(async () => {
      expect((await store.readState()).runs[jobId]?.hostTurn?.stage).toBe("CLAIMING");
      expect(vi.getTimerCount()).toBe(1);
    });
    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(async () => {
      expect((await store.readState()).runs[jobId]?.hostTurn).toBeUndefined();
    });
  });

  it("retries cleanup when the first expired pre-claim mutation fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const store = await createStore(reviewRun());
    const claim = vi.fn((): Promise<never> => Promise.reject(new Error("claim transport failed")));
    const coordinator = createCoordinator(createDependencies(store, { claim }));

    await expect(coordinator.turn({
      requestId: "failed-live-claim",
      projectId,
      jobId,
      hostTurnId: "old-host"
    })).rejects.toThrow("claim transport failed");
    expect((await store.readState()).runs[jobId]?.hostTurn?.stage).toBe("CLAIMING");
    expect(vi.getTimerCount()).toBe(1);

    const writeState = vi.spyOn(store, "writeState");
    writeState.mockRejectedValueOnce(new Error("transient cleanup write failure"));

    // The near-term reconciliation wake observes that the pre-claim deadline is still live.
    await vi.advanceTimersToNextTimerAsync();
    expect(writeState).not.toHaveBeenCalled();
    expect((await store.readState()).runs[jobId]?.hostTurn?.stage).toBe("CLAIMING");
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));

    // The deadline wake attempts cleanup; the injected first write failure must be retried.
    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(() => expect(writeState).toHaveBeenCalledTimes(1));
    expect((await store.readState()).runs[jobId]?.hostTurn?.stage).toBe("CLAIMING");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersToNextTimerAsync();
    await vi.waitFor(async () => {
      expect((await store.readState()).runs[jobId]?.hostTurn).toBeUndefined();
    });
  });

  it("reconciles a committed five-minute claim when the claim response is lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const store = await createStore(reviewRun());
    const claim = vi.fn(async (input: Parameters<HostTurnCoordinatorDependencies["claim"]>[0]) => {
      await writeRun(store, (run) => ({
        ...run,
        phase: "REVIEWING",
        pendingAction: {
          ...run.pendingAction,
          claimId: "claim-1",
          hostTurnId: input.hostTurnId,
          claimExpiresAt: "2026-08-11T10:05:00.000Z",
          claimStatus: "CLAIMED"
        }
      }));
      throw new Error("claim response was lost");
    });
    const reportHostUnavailable = vi.fn((): Promise<never> =>
      Promise.reject(new Error("MUST_NOT_PAUSE"))
    );
    const coordinator = createCoordinator(createDependencies(store, {
      claim,
      reportHostUnavailable
    }));

    const output = await coordinator.turn({
      requestId: "lost-claim-response",
      projectId,
      jobId,
      hostTurnId: "host-1"
    });

    expect(output).toMatchObject({
      kind: "REVIEW_REQUIRED",
      reviewAttemptId: "review-attempt-1",
      changedPaths: ["src/a.ts"]
    });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(reportHostUnavailable).not.toHaveBeenCalled();
    expect((await store.readState()).runs[jobId]).toMatchObject({
      phase: "REVIEWING",
      pendingAction: {
        claimId: "claim-1",
        claimExpiresAt: "2026-08-11T10:05:00.000Z"
      },
      hostTurn: {
        stage: "AWAITING_REVIEW",
        hostTurnId: "host-1",
        claimId: "claim-1",
        deadlineAt: "2026-08-11T10:30:00.000Z"
      }
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("reconciles a post-claim CLAIMING checkpoint without claiming twice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const run = claimedRun(reviewRun(), "2026-08-11T10:05:00.000Z");
    const store = await createStore({
      ...run,
      hostTurn: {
        stage: "CLAIMING",
        turnToken: "turn-current",
        hostTurnId: "host-1",
        revision: 1,
        actionId: "review-action-1",
        startedAt: nowText,
        deadlineAt: "2026-08-11T10:30:00.000Z"
      }
    });
    const claim = vi.fn((): Promise<never> => Promise.reject(new Error("MUST_NOT_RECLAIM")));
    const coordinator = createCoordinator(createDependencies(store, { claim }));

    await coordinator.recoverRun(projectId, jobId);

    expect(claim).not.toHaveBeenCalled();
    expect((await store.readState()).runs[jobId]?.hostTurn).toMatchObject({
      stage: "AWAITING_REVIEW",
      claimId: "claim-1"
    });
  });

  it("persists invalid-review cause and exposes only cancel", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const store = await createStore(claimedRun(reviewRun(), "2026-08-11T10:05:00.000Z"));
    const pauseCauses: unknown[] = [];
    const normalizedReview = {
      verdict: "REQUEST_CHANGES" as const,
      completionPercentage: 50,
      convergeFindings: [],
      adversarialFindings: [],
      pathCoverage: { "src/a.ts": "FULL" as const },
      residualRisks: []
    };
    const submitReview = vi.fn(async () => {
      const next = await writeRun(store, (run) => ({
        ...run,
        phase: "LEADER_DECISION",
        pendingAction: undefined
      }));
      return {
        projectId,
        jobId,
        revision: 1,
        stateVersion: next.stateVersion,
        phase: "LEADER_DECISION",
        reviewHash: digestA,
        reviewAttemptId: "review-attempt-1",
        reviewerSessionId: "reviewer-1",
        result: normalizedReview
      };
    });
    const submitLeaderDecision = vi.fn(async (
      _input: Parameters<HostTurnCoordinatorDependencies["submitLeaderDecision"]>[0],
      options?: Parameters<HostTurnCoordinatorDependencies["submitLeaderDecision"]>[1]
    ) => {
      pauseCauses.push(options?.pauseCause);
      const next = await writeRun(store, (run) => ({
        ...run,
        phase: "PAUSED",
        pause: { code: "INVALID_REVIEW", resumeActions: ["cancel"] }
      }));
      return { projectId, jobId, revision: 1, stateVersion: next.stateVersion, phase: "PAUSED" };
    });
    const coordinator = createCoordinator(createDependencies(store, {
      submitReview,
      submitLeaderDecision
    }));

    const output = await coordinator.turn({
      requestId: "invalid-review",
      projectId,
      jobId,
      hostTurnId: "host-1",
      turnToken: "turn-current",
      review: {
        reviewerSessionId: "reviewer-1",
        result: { completionPercentage: 50, tasks: [{
          id: "T001",
          completionPercentage: 50,
          reason: "missing evidence",
          suggestion: "review again"
        }] }
      }
    });

    expect(pauseCauses).toEqual(["INVALID_REVIEW"]);
    expect(output).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      pause: { code: "INVALID_REVIEW" },
      options: [{ answer: "cancel" }]
    });
    expect(JSON.stringify(output)).not.toContain("resume_review_decision");
  });

  it("exposes a separate collection form for a generic approval pause", async () => {
    const store = await createStore(reviewRun({
      phase: "PAUSED",
      pendingAction: undefined,
      pause: {
        code: "APPROVED_SOURCE_DRIFT",
        resumeActions: ["approve_new_manifest_revision", "cancel"]
      }
    }));
    const coordinator = createCoordinator(createDependencies(store));

    const prompt = await coordinator.turn({
      requestId: "generic-approval-prompt",
      projectId,
      jobId,
      hostTurnId: "host-user"
    });

    expect(prompt).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      requiredInput: {
        mode: "COLLECT",
        action: "approve_new_manifest_revision",
        fields: ["tasksPath", "approvedSourceHash", "approval"],
        inputForm: {
          tasksPath: null,
          approvedSourceHash: null,
          approval: null
        }
      }
    });
    if (prompt.kind !== "USER_INPUT_REQUIRED" || prompt.requiredInput === undefined) {
      throw new Error("USER input form missing");
    }
    expect("answer" in prompt.requiredInput).toBe(false);
  });

  it("separates inspection actions from mutable options and embeds result evidence", async () => {
    const evidenceResult = {
      projectId,
      jobId,
      phase: "PAUSED" as const,
      status: "PRECHECK_CONFLICT" as const,
      artifacts: [],
      nextActions: ["inspect_conflict", "cancel"],
      publishPrecheck: {
        conflicts: [{ path: "src/a.ts", reason: "HASH_MISMATCH" as const }],
        publishedCount: 0 as const,
        totalCount: 1,
        activeWorkspaceChanged: false as const
      }
    };
    const store = await createStore(reviewRun({
      phase: "PAUSED",
      pendingAction: undefined,
      pause: {
        code: "PUBLISH_CONFLICT",
        resumeActions: ["inspect_conflict", "cancel"]
      }
    }));
    const result = vi.fn((): Promise<unknown> => Promise.resolve(evidenceResult));
    const coordinator = createCoordinator(createDependencies(store, { result }));

    const prompt = await coordinator.turn({
      requestId: "inspect-conflict-prompt",
      projectId,
      jobId,
      hostTurnId: "host-user"
    });

    expect(prompt).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      result: evidenceResult
    });
    if (prompt.kind !== "USER_INPUT_REQUIRED") {
      throw new Error("USER input prompt missing");
    }
    expect(prompt.inspectionOptions.map((option) => option.action)).toEqual([
      "inspect_conflict"
    ]);
    expect(prompt.options.map((option) => option.answer)).toEqual(["cancel"]);
    expect(prompt.result.publishPrecheck).toEqual(evidenceResult.publishPrecheck);
    expect(result).toHaveBeenCalledTimes(1);
  });

  it("exposes and submits a complete USER revision approval template", async () => {
    const repairDraft = {
      sourceArtifact: { relativePath: "runs/job-1/repair.md", sha256: digestA, size: 10 },
      sourceHash: digestA,
      suggestedTasksPath: "tasks.md",
      appendText: "\n- [ ] T002 repair",
      addedTaskLines: ["- [ ] T002 repair"],
      reasons: ["User scope changed"],
      approval: {
        kind: "USER",
        parentRevision: 1,
        authorizedCriterionIds: ["T002"]
      }
    };
    const store = await createStore(reviewRun({
      phase: "PAUSED",
      pendingAction: undefined,
      pause: {
        code: "REPAIR_USER_APPROVAL_REQUIRED",
        resumeActions: ["inspect_repair_diff", "approve_new_manifest_revision", "cancel"]
      },
      recovery: { repairDraft }
    }));
    const resumeInputs: unknown[] = [];
    const resume = vi.fn(async (input: Parameters<HostTurnCoordinatorDependencies["resume"]>[0]) => {
      resumeInputs.push(input);
      const next = await writeRun(store, (run) => ({
        ...run,
        phase: "COMPLETED",
        pause: undefined,
        hostTurn: undefined
      }));
      return { projectId, jobId, revision: 2, stateVersion: next.stateVersion, phase: "COMPLETED" };
    });
    const coordinator = createCoordinator(createDependencies(store, { resume }, repairDraft));

    const prompt = await coordinator.turn({
      requestId: "user-prompt",
      projectId,
      jobId,
      hostTurnId: "host-user"
    });
    expect(prompt).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      repairDraft,
      requiredInput: {
        mode: "CONFIRM",
        action: "approve_new_manifest_revision",
        fields: ["tasksPath", "approvedSourceHash", "approval"],
        answer: {
          action: "approve_new_manifest_revision",
          tasksPath: "tasks.md",
          approvedSourceHash: digestA,
          approval: repairDraft.approval
        }
      }
    });
    if (
      prompt.kind !== "USER_INPUT_REQUIRED" ||
      prompt.requiredInput?.mode !== "CONFIRM"
    ) {
      throw new Error("complete USER approval answer missing");
    }
    const answer = prompt.requiredInput.answer;
    const done = await coordinator.turn({
      requestId: "user-answer",
      projectId,
      jobId,
      hostTurnId: "host-user",
      turnToken: prompt.turnToken,
      answer
    });

    expect(done.kind).toBe("DONE");
    expect(resumeInputs).toContainEqual(expect.objectContaining({
      resumeAction: "approve_new_manifest_revision",
      tasksPath: "tasks.md",
      approvedSourceHash: digestA,
      approval: repairDraft.approval
    }));
  });
});
