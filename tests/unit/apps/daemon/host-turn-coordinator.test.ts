import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewTurnInput, ReviewTurnOutput } from "@smartflow/protocol";
import {
  StateStore,
  type ProjectState,
  type RunRecord
} from "@smartflow/state-store";
import { compileTaskManifest } from "@smartflow/task-manifest";
import { createTasksSource } from "../../../fixtures/task-manifest/test-fixture.js";
import {
  createProjectState,
  createRunRecord
} from "../../../fixtures/state-store/test-fixture.js";

vi.mock("../../../../apps/daemon/src/recovery-manager.js", () => ({
  verifyRunArtifacts: vi.fn(() => Promise.resolve(undefined))
}));

import {
  HostTurnCoordinator,
  type HostTurnCoordinatorDependencies
} from "../../../../apps/daemon/src/host-turn-coordinator.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const nowText = "2026-08-11T10:00:00.000Z";
const projectId = "project-1";
const jobId = "job-1";
const reviewDeadlineMs = 45 * 60_000;
const reviewDeadlineAt = new Date(Date.parse(nowText) + reviewDeadlineMs).toISOString();

const temporaryDirectories: string[] = [];
const coordinators: HostTurnCoordinator[] = [];

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function reviewAction(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
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
    expiresAt: "2026-08-11T10:15:00.000Z",
    ...overrides
  };
}

function reviewRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return createRunRecord({
    phase: "REVIEW_PENDING",
    pendingAction: reviewAction(),
    candidate: {
      relativePath: "runs/job-1/revision-1/candidate.json",
      sha256: digestB,
      size: 2
    },
    workspace: {
      relativePath: "worktrees/job-1",
      baselineHash: digestA,
      generation: 0,
      sandboxId: "sandbox-1",
      mutable: true
    },
    workerAttempts: [{
      attemptId: "attempt-1",
      revision: 1,
      generation: 0,
      providerRuntimeConfigHash: digestC,
      status: "COMPLETED",
      piSessionId: "pi-session-1",
      startedAt: "2026-08-11T09:30:00.000Z",
      endedAt: "2026-08-11T09:59:00.000Z"
    }],
    createdAt: nowText,
    updatedAt: nowText,
    ...overrides
  });
}

interface TestStore {
  store: StateStore;
  approvedSourcePath: string;
}

async function createStore(run: RunRecord): Promise<TestStore> {
  const directory = await mkdtemp(join(tmpdir(), "smartflow-host-turn-"));
  temporaryDirectories.push(directory);
  const store = new StateStore(join(directory, "data", projectId));
  const tasksSource = createTasksSource({
    tasks: "## M01 · Core\n\n- [ ] T001 Edit `src/a.ts` — 验收：review passes"
  });
  // The Run keeps the absolute approved task path while the Manifest keeps the
  // Project-relative logical path, exactly as ProjectRuntime.execute records them.
  const logicalTaskPath = "tasks.md";
  const canonicalTaskPath = join(directory, logicalTaskPath);
  const compiled = compileTaskManifest(tasksSource, {
    projectId,
    jobId,
    revision: 1,
    canonicalTaskPath: logicalTaskPath,
    providerRuntimeConfig: { model: "test" },
    approval: {
      kind: "USER",
      approvedAt: nowText,
      parentRevision: null,
      authorizedCriterionIds: ["T001:acceptance:1"]
    }
  });
  const taskSource = await store.writeArtifact(
    `runs/${jobId}/revision-1/task-source.md`,
    Buffer.from(tasksSource, "utf8")
  );
  const taskManifest = await store.writeArtifact(
    `runs/${jobId}/revision-1/task-manifest.json`,
    compiled.artifactBytes
  );
  const candidate = await store.writeArtifact(
    `runs/${jobId}/revision-1/candidate.json`,
    Buffer.from("{}", "utf8")
  );
  const pendingAction = run.pendingAction?.type === "REVIEW"
    ? {
        ...run.pendingAction,
        taskSourceHash: compiled.manifest.sourceHash,
        candidateHash: candidate.sha256
      }
    : run.pendingAction;
  const approvedSourcePath = resolve(store.dataDirectory, taskSource.relativePath);
  const preparedRun: RunRecord = {
    ...run,
    canonicalTaskPath,
    taskSource,
    taskManifest,
    candidate,
    approvedTasks: {
      path: approvedSourcePath,
      sourceHash: compiled.manifest.sourceHash
    },
    pendingAction
  };
  await store.initialize(createProjectState({
    projectId,
    canonicalProjectRoot: directory,
    runs: { [preparedRun.jobId]: preparedRun }
  }));
  return { store, approvedSourcePath };
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

function resultStatus(run: RunRecord):
  | "RUNNING"
  | "PAUSED"
  | "COMMITTED"
  | "FAILED"
  | "CANCELED" {
  if (run.phase === "COMPLETED") return "COMMITTED";
  if (run.phase === "FAILED") return "FAILED";
  if (run.phase === "CANCELED") return "CANCELED";
  if (run.phase === "PAUSED") return "PAUSED";
  return "RUNNING";
}

function resultFor(run: RunRecord, repairDraft?: Record<string, unknown>): Record<string, unknown> {
  return {
    projectId,
    jobId,
    phase: run.phase,
    status: resultStatus(run),
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
        ...(run.pendingAction === undefined ? {} : { pendingAction: run.pendingAction }),
        ...(run.pause === undefined ? {} : { pause: run.pause })
      };
    },
    resume: (): Promise<never> => unexpectedDependency("RESUME"),
    result: async (): Promise<unknown> => {
      const state = await store.readState();
      const run = state.runs[jobId];
      if (run === undefined) throw new Error("RUN_NOT_FOUND");
      return resultFor(run, repairDraft);
    },
    schedule: (): void => undefined,
    ...overrides
  };
}

function createCoordinator(dependencies: HostTurnCoordinatorDependencies): HostTurnCoordinator {
  const coordinator = new HostTurnCoordinator(dependencies);
  coordinators.push(coordinator);
  return coordinator;
}

function initialInput(overrides: Partial<ReviewTurnInput> = {}): ReviewTurnInput {
  return {
    requestId: "review-turn-request-1",
    projectId,
    jobId,
    hostTurnId: "host-1",
    ...overrides
  };
}

async function beginReview(
  coordinator: HostTurnCoordinator,
  input: ReviewTurnInput = initialInput()
): Promise<Extract<ReviewTurnOutput, { kind: "REVIEW_REQUIRED" }>> {
  const output = await coordinator.turn(input);
  if (output.kind !== "REVIEW_REQUIRED") {
    throw new Error(`Expected REVIEW_REQUIRED, received ${output.kind}`);
  }
  return output;
}

function completeTaskReview(): NonNullable<ReviewTurnInput["review"]> {
  return {
    reviewerSessionId: "reviewer-1",
    result: {
      tasks: [{ id: "T001", completionPercentage: 100, issues: [] }]
    }
  };
}

function incompleteTaskReview(): NonNullable<ReviewTurnInput["review"]> {
  return {
    reviewerSessionId: "reviewer-1",
    result: {
      tasks: [{
        id: "T001",
        completionPercentage: 50,
        issues: [{
          path: "src/a.ts",
          message: "executeTask leaves the requested behavior incomplete",
          suggestedFix: "Implement the remaining behavior in executeTask"
        }]
      }]
    }
  };
}

describe("HostTurnCoordinator simplified review state machine", () => {
  it("begins Review in one state commit and replays the durable turn without another mutation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const { store } = await createStore(reviewRun());
    const writeState = vi.spyOn(store, "writeState");
    const coordinator = createCoordinator(createDependencies(store));
    const input = initialInput({ requestId: "atomic-begin" });

    const first = await beginReview(coordinator, input);
    const afterFirst = await store.readState();
    const second = await beginReview(coordinator, input);

    expect(second).toEqual(first);
    expect(writeState).toHaveBeenCalledTimes(1);
    expect(afterFirst.stateVersion).toBe(1);
    expect(afterFirst.runs[jobId]).toMatchObject({
      phase: "REVIEWING",
      hostTurn: {
        stage: "AWAITING_REVIEW",
        hostTurnId: "host-1",
        turnToken: first.turnToken,
        reviewAttemptId: "review-attempt-1",
        deadlineAt: reviewDeadlineAt
      }
    });
    expect(afterFirst.runs[jobId]?.pendingAction).not.toHaveProperty("claimId");
    expect(afterFirst.runs[jobId]?.pendingAction).not.toHaveProperty("claimExpiresAt");
  });

  it("keeps Review ownership bound to the Host that began the turn", async () => {
    const { store } = await createStore(reviewRun());
    const coordinator = createCoordinator(createDependencies(store));
    await beginReview(coordinator);
    const before = await store.readState();

    await expect(coordinator.turn(initialInput({
      requestId: "other-host",
      hostTurnId: "host-2"
    }))).rejects.toThrow("HOST_TURN_OWNED_BY_ANOTHER_HOST");

    expect(await store.readState()).toEqual(before);
  });

  it("restores the single durable deadline after restart and pauses when it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowText));
    const { store } = await createStore(reviewRun());
    const firstCoordinator = createCoordinator(createDependencies(store));
    await beginReview(firstCoordinator);
    firstCoordinator.dispose();

    const recoveredCoordinator = createCoordinator(createDependencies(store));
    await recoveredCoordinator.recoverRun(projectId, jobId);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(reviewDeadlineMs);
    await vi.waitFor(async () => {
      expect((await store.readState()).runs[jobId]).toMatchObject({
        phase: "PAUSED",
        pause: { code: "HOST_REVIEW_UNAVAILABLE" },
        hostTurn: {
          stage: "AWAITING_USER_INPUT",
          hostTurnId: "host-1"
        }
      });
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finalizes an accepted Review and decision atomically before scheduling Publish", async () => {
    const { store } = await createStore(reviewRun());
    const schedule = vi.fn<HostTurnCoordinatorDependencies["schedule"]>();
    const coordinator = createCoordinator(createDependencies(store, { schedule }));
    const requested = await beginReview(coordinator);
    const writeState = vi.spyOn(store, "writeState");

    const output = await coordinator.turn(initialInput({
      requestId: "accept-review",
      turnToken: requested.turnToken,
      review: completeTaskReview()
    }));

    expect(output).toMatchObject({ kind: "NOT_READY" });
    expect((await store.readState()).runs[jobId]?.phase).toBe("READY_TO_PUBLISH");
    expect(writeState).toHaveBeenCalledTimes(1);
    const state = await store.readState();
    const run = state.runs[jobId];
    if (run === undefined) throw new Error("accepted run missing");
    expect(run).toMatchObject({ phase: "READY_TO_PUBLISH" });
    expect(run.pendingAction).toBeUndefined();
    expect(run.hostTurn).toBeUndefined();
    expect(run.review).toBeDefined();
    expect(run.leaderDecision).toBeDefined();
    expect(run.reviewHistory).toHaveLength(1);
    const reviewRef = run.review;
    if (reviewRef === undefined) throw new Error("review missing");
    const decisionRef = run.leaderDecision;
    if (decisionRef === undefined) throw new Error("decision missing");
    const review = JSON.parse(new TextDecoder().decode(
      await store.readArtifact(reviewRef)
    )) as Record<string, unknown>;
    const decision = JSON.parse(new TextDecoder().decode(
      await store.readArtifact(decisionRef)
    )) as Record<string, unknown>;
    expect(review.claimId).toBe(requested.turnToken);
    expect(decision).toMatchObject({ decision: "accept", reviewHash: review.reviewHash });
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ kind: "publish" }));
  });

  it("finalizes actionable incomplete work directly to FIXING and schedules the repair pipeline", async () => {
    const { store } = await createStore(reviewRun());
    const schedule = vi.fn<HostTurnCoordinatorDependencies["schedule"]>();
    const coordinator = createCoordinator(createDependencies(store, { schedule }));
    const requested = await beginReview(coordinator);

    const output = await coordinator.turn(initialInput({
      requestId: "repair-review",
      turnToken: requested.turnToken,
      review: incompleteTaskReview()
    }));

    expect(output).toMatchObject({ kind: "NOT_READY" });
    const repairedRun = (await store.readState()).runs[jobId];
    expect(repairedRun).toMatchObject({
      phase: "FIXING",
      autoRepairRounds: 1
    });
    expect(repairedRun?.pendingAction).toBeUndefined();
    expect(repairedRun?.hostTurn).toBeUndefined();
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ kind: "pipeline" }));
  });

  it("rejects an inconsistent Review without mutating the Run", async () => {
    const { store } = await createStore(reviewRun());
    const coordinator = createCoordinator(createDependencies(store));
    const requested = await beginReview(coordinator);
    const before = await store.readState();

    await expect(coordinator.turn(initialInput({
      requestId: "invalid-review",
      turnToken: requested.turnToken,
      review: {
        reviewerSessionId: "reviewer-1",
        result: {
          tasks: [{ id: "T001", completionPercentage: 50, issues: [] }]
        }
      }
    }))).rejects.toThrow();

    expect(await store.readState()).toEqual(before);
  });

  it("requires user input at the repair limit and can directly restart automatic decision", async () => {
    const { store } = await createStore(reviewRun({ autoRepairRounds: 15 }));
    const schedule = vi.fn<HostTurnCoordinatorDependencies["schedule"]>();
    const coordinator = createCoordinator(createDependencies(store, { schedule }));
    const requested = await beginReview(coordinator);

    const paused = await coordinator.turn(initialInput({
      requestId: "repair-limit",
      turnToken: requested.turnToken,
      review: incompleteTaskReview()
    }));
    expect(paused).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      pause: { code: "AUTOMATIC_REPAIR_LIMIT" }
    });
    if (paused.kind !== "USER_INPUT_REQUIRED") throw new Error("repair limit prompt missing");
    expect(paused.options.map((option) => option.answer)).toEqual([
      "resume_review_decision",
      "cancel"
    ]);

    const resumed = await coordinator.turn(initialInput({
      requestId: "repair-limit-resume",
      turnToken: paused.turnToken,
      answer: "resume_review_decision"
    }));
    expect(resumed).toMatchObject({ kind: "NOT_READY" });
    const resumedRun = (await store.readState()).runs[jobId];
    expect(resumedRun).toMatchObject({
      phase: "FIXING",
      autoRepairRounds: 1
    });
    expect(resumedRun?.hostTurn).toBeUndefined();
    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ kind: "pipeline" }));
  });

  it("treats a stale turn token as read-only and rejects a mismatched bound Reviewer session", async () => {
    const firstStore = await createStore(reviewRun());
    const firstCoordinator = createCoordinator(createDependencies(firstStore.store));
    await beginReview(firstCoordinator);
    const before = await firstStore.store.readState();

    const stale = await firstCoordinator.turn(initialInput({
      requestId: "stale-token",
      turnToken: "turn-stale",
      review: completeTaskReview()
    }));
    expect(stale).toMatchObject({ kind: "NOT_READY" });
    expect((await firstStore.store.readState()).runs[jobId]?.phase).toBe("REVIEWING");
    expect(await firstStore.store.readState()).toEqual(before);

    const boundRun = reviewRun({
      pendingAction: reviewAction({
        reviewAttemptId: "review-attempt-2",
        reviewerSession: {
          mode: "RESUME",
          reviewerSessionId: "reviewer-bound"
        }
      }),
      reviewHistory: [{
        reviewAttemptId: "review-attempt-1",
        reviewerSessionId: "reviewer-bound",
        taskSourceHash: digestA,
        candidateHash: digestB,
        reviewHash: digestC
      }]
    });
    const secondStore = await createStore(boundRun);
    const secondCoordinator = createCoordinator(createDependencies(secondStore.store));
    const requested = await beginReview(secondCoordinator, initialInput({
      requestId: "bound-session-begin"
    }));

    await expect(secondCoordinator.turn(initialInput({
      requestId: "bound-session-mismatch",
      turnToken: requested.turnToken,
      review: {
        ...completeTaskReview(),
        reviewerSessionId: "reviewer-other"
      }
    }))).rejects.toThrow("REVIEWER_SESSION_BINDING_MISMATCH");
    expect((await secondStore.store.readState()).runs[jobId]?.phase).toBe("REVIEWING");
  });

  it("pauses safely when the approved task source hash changes before finalization", async () => {
    const { store, approvedSourcePath } = await createStore(reviewRun());
    const coordinator = createCoordinator(createDependencies(store));
    const requested = await beginReview(coordinator);
    await writeFile(approvedSourcePath, "changed approved source", "utf8");

    const output = await coordinator.turn(initialInput({
      requestId: "source-drift",
      turnToken: requested.turnToken,
      review: completeTaskReview()
    }));

    expect(output).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      pause: { code: "APPROVED_SOURCE_DRIFT" }
    });
    expect((await store.readState()).runs[jobId]).toMatchObject({
      phase: "PAUSED",
      pause: { code: "APPROVED_SOURCE_DRIFT" },
      hostTurn: { stage: "AWAITING_USER_INPUT" }
    });
  });

  it("persists Host unavailability without an external report primitive", async () => {
    const { store } = await createStore(reviewRun());
    const coordinator = createCoordinator(createDependencies(store));
    const requested = await beginReview(coordinator);

    const output = await coordinator.turn(initialInput({
      requestId: "reviewer-unavailable",
      turnToken: requested.turnToken,
      reviewUnavailableReason: "reviewer process exited"
    }));

    expect(output).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      pause: { code: "HOST_REVIEW_UNAVAILABLE" }
    });
    expect((await store.readState()).runs[jobId]).toMatchObject({
      phase: "PAUSED",
      lastError: {
        code: "HOST_REVIEW_UNAVAILABLE",
        message: "HOST_REVIEW_UNAVAILABLE:reviewer process exited"
      }
    });
  });

  it("discloses a publish worktree only to the owning Host and forwards manual confirmation", async () => {
    const { store } = await createStore(reviewRun({
      phase: "PAUSED",
      pendingAction: undefined,
      pause: {
        code: "PUBLISH_PRECHECK_CONFLICT",
        resumeActions: ["retry_publish", "confirm_manual_publish", "cancel"]
      }
    }));
    const resume = vi.fn<HostTurnCoordinatorDependencies["resume"]>(async () => {
      await writeRun(store, (run) => ({
        ...run,
        phase: "READY_TO_PUBLISH",
        pause: undefined,
        hostTurn: undefined
      }));
      return { phase: "READY_TO_PUBLISH" };
    });
    const coordinator = createCoordinator(createDependencies(store, { resume }));

    const prompt = await coordinator.turn(initialInput({ requestId: "publish-prompt" }));
    expect(prompt).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      pause: { code: "PUBLISH_PRECHECK_CONFLICT" },
      worktreePath: resolve(store.dataDirectory, "worktrees/job-1")
    });
    if (prompt.kind !== "USER_INPUT_REQUIRED") throw new Error("publish prompt missing");
    expect(prompt.options.map((option) => option.answer)).toEqual([
      "retry_publish",
      "confirm_manual_publish",
      "cancel"
    ]);
    await expect(coordinator.turn(initialInput({
      requestId: "publish-other-host",
      hostTurnId: "host-2"
    }))).rejects.toThrow(/HOST_TURN_OWNED_BY_ANOTHER_HOST/u);

    const continued = await coordinator.turn(initialInput({
      requestId: "publish-confirm",
      turnToken: prompt.turnToken,
      answer: "confirm_manual_publish"
    }));
    expect(continued).toMatchObject({ kind: "NOT_READY" });
    expect((await store.readState()).runs[jobId]?.phase).toBe("READY_TO_PUBLISH");
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ resumeAction: "confirm_manual_publish" }),
      expect.objectContaining({
        clearHostTurn: true,
        expectedHostTurnToken: prompt.turnToken
      })
    );
  });

  it("exposes a complete USER revision approval and forwards it through resume", async () => {
    const repairDraft = {
      sourceArtifact: {
        relativePath: "runs/job-1/repair.md",
        sha256: digestA,
        size: 10
      },
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
    const { store } = await createStore(reviewRun({
      phase: "PAUSED",
      pendingAction: undefined,
      pause: {
        code: "REPAIR_USER_APPROVAL_REQUIRED",
        resumeActions: ["inspect_repair_diff", "approve_new_manifest_revision", "cancel"]
      },
      recovery: { repairDraft }
    }));
    const resume = vi.fn<HostTurnCoordinatorDependencies["resume"]>(async () => {
      await writeRun(store, (run) => ({
        ...run,
        phase: "COMPLETED",
        pause: undefined,
        hostTurn: undefined
      }));
      return { phase: "COMPLETED" };
    });
    const coordinator = createCoordinator(createDependencies(store, { resume }, repairDraft));

    const prompt = await coordinator.turn(initialInput({ requestId: "user-prompt" }));
    expect(prompt).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      requiredInput: {
        mode: "CONFIRM",
        action: "approve_new_manifest_revision",
        answer: {
          tasksPath: "tasks.md",
          approvedSourceHash: digestA,
          approval: repairDraft.approval
        }
      }
    });
    expect(prompt).not.toHaveProperty("worktreePath");
    if (prompt.kind !== "USER_INPUT_REQUIRED" || prompt.requiredInput?.mode !== "CONFIRM") {
      throw new Error("complete USER approval answer missing");
    }

    const done = await coordinator.turn(initialInput({
      requestId: "user-answer",
      turnToken: prompt.turnToken,
      answer: prompt.requiredInput.answer
    }));
    expect(done.kind).toBe("DONE");
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeAction: "approve_new_manifest_revision",
        tasksPath: "tasks.md",
        approvedSourceHash: digestA,
        approval: repairDraft.approval
      }),
      expect.objectContaining({
        clearHostTurn: true,
        expectedHostTurnToken: prompt.turnToken
      })
    );
  });
});
