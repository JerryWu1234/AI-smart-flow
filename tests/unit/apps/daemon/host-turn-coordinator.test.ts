import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewTurnInput } from "@smartflow/protocol";
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
import { DAEMON_REVIEWER_HOST_TURN_ID } from "../../../../apps/daemon/src/review-coordinator.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const nowText = "2026-08-11T10:00:00.000Z";
const projectId = "project-1";
const jobId = "job-1";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function reviewAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

async function createStore(run: RunRecord): Promise<StateStore> {
  const directory = await mkdtemp(join(tmpdir(), "smartflow-host-turn-"));
  temporaryDirectories.push(directory);
  const store = new StateStore(join(directory, "data", projectId));
  const tasksSource = createTasksSource({
    tasks: "## M01 · Core\n\n- [ ] T001 Edit `src/a.ts` — 验收：review passes"
  });
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
  const preparedRun: RunRecord = {
    ...run,
    canonicalTaskPath,
    taskSource,
    taskManifest,
    candidate,
    approvedTasks: {
      path: resolve(store.dataDirectory, taskSource.relativePath),
      sourceHash: compiled.manifest.sourceHash
    },
    pendingAction
  };
  await store.initialize(createProjectState({
    projectId,
    canonicalProjectRoot: directory,
    runs: { [preparedRun.jobId]: preparedRun }
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

function resultStatus(run: RunRecord): "RUNNING" | "PAUSED" | "COMMITTED" | "FAILED" | "CANCELED" {
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

function initialInput(overrides: Partial<ReviewTurnInput> = {}): ReviewTurnInput {
  return {
    requestId: "review-turn-request-1",
    projectId,
    jobId,
    hostTurnId: "host-1",
    ...overrides
  };
}

describe("HostTurnCoordinator daemon-owned Review boundary", () => {
  for (const phase of ["REVIEW_PENDING", "REVIEWING"] as const) {
    it(`keeps ${phase} read-only and returns the thirty-second polling interval`, async () => {
      const hostTurn = phase === "REVIEWING"
        ? {
            stage: "AWAITING_REVIEW" as const,
            turnToken: "daemon-review-turn-1",
            hostTurnId: DAEMON_REVIEWER_HOST_TURN_ID,
            revision: 1,
            reviewAttemptId: "review-attempt-1",
            startedAt: nowText,
            deadlineAt: "2026-08-11T10:45:00.000Z"
          } as const
        : undefined;
      const store = await createStore(reviewRun({ phase, hostTurn }));
      const before = await store.readState();
      const resume = vi.fn<HostTurnCoordinatorDependencies["resume"]>();
      const schedule = vi.fn<HostTurnCoordinatorDependencies["schedule"]>();
      const coordinator = new HostTurnCoordinator(createDependencies(store, { resume, schedule }));

      await expect(coordinator.turn(initialInput({ hostTurnId: "unrelated-host" })))
        .resolves.toEqual({ kind: "NOT_READY", retryAfterMs: 30_000 });

      expect(await store.readState()).toEqual(before);
      expect(resume).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    });
  }

  it("presents a daemon Reviewer failure and forwards retry_host_review", async () => {
    const store = await createStore(reviewRun({
      phase: "PAUSED",
      pause: {
        code: "HOST_REVIEW_UNAVAILABLE",
        resumeActions: ["retry_host_review", "cancel"]
      },
      lastError: {
        code: "HOST_REVIEW_UNAVAILABLE",
        message: "Codex executable was not found",
        retryable: true,
        stage: "review",
        nextActions: ["retry_host_review", "cancel"],
        artifacts: []
      }
    }));
    const resume = vi.fn<HostTurnCoordinatorDependencies["resume"]>(async () => {
      await writeRun(store, (run) => ({
        ...run,
        phase: "REVIEW_PENDING",
        pause: undefined,
        lastError: undefined,
        hostTurn: undefined
      }));
      return { phase: "REVIEW_PENDING" };
    });
    const coordinator = new HostTurnCoordinator(createDependencies(store, { resume }));

    const prompt = await coordinator.turn(initialInput({ requestId: "review-failed" }));
    expect(prompt).toMatchObject({
      kind: "USER_INPUT_REQUIRED",
      pause: { code: "HOST_REVIEW_UNAVAILABLE", message: "Codex executable was not found" }
    });
    if (prompt.kind !== "USER_INPUT_REQUIRED") throw new Error("review failure prompt missing");
    expect(prompt.options.map((option) => option.answer)).toEqual(["retry_host_review", "cancel"]);

    const retried = await coordinator.turn(initialInput({
      requestId: "retry-review",
      turnToken: prompt.turnToken,
      answer: "retry_host_review"
    }));
    expect(retried).toEqual({ kind: "NOT_READY", retryAfterMs: 30_000 });
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ resumeAction: "retry_host_review" }),
      expect.objectContaining({
        clearHostTurn: true,
        expectedHostTurnToken: prompt.turnToken
      })
    );
  });

  it("discloses a publish worktree only to the owning Host and forwards manual confirmation", async () => {
    const store = await createStore(reviewRun({
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
    const coordinator = new HostTurnCoordinator(createDependencies(store, { resume }));

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
    expect(continued).toEqual({ kind: "NOT_READY", retryAfterMs: 30_000 });
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
    const store = await createStore(reviewRun({
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
    const coordinator = new HostTurnCoordinator(createDependencies(store, { resume }, repairDraft));

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
