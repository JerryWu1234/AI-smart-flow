import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeHarness, type RuntimeHarness } from "../../../helpers/runtime-harness.js";
import {
  projectStateSchema,
  runArtifactInventory
} from "../../../../packages/state-store/src/schema.js";
import { StateStore } from "../../../../packages/state-store/src/state-store.js";
import {
  createProjectState,
  createRunRecord
} from "../../../fixtures/state-store/test-fixture.js";

const activeHarnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("ProjectState schema and recovery source", () => {
  it("strictly validates state and rejects unknown fields", () => {
    expect(projectStateSchema.safeParse(createProjectState()).success).toBe(true);
    expect(
      projectStateSchema.safeParse({ ...createProjectState(), unexpected: true }).success
    ).toBe(false);
  });

  it("validates replay keys while storing only the payload hash and original response", () => {
    const receipt = { requestHash: "c".repeat(64), response: { accepted: true } };
    expect(projectStateSchema.safeParse(createProjectState({
      processedRequests: { "request-1": receipt }
    })).success).toBe(true);
    for (const requestId of ["", "   ", "x".repeat(257)]) {
      expect(projectStateSchema.safeParse(createProjectState({
        processedRequests: { [requestId]: receipt }
      })).success).toBe(false);
    }
  });

  it("keeps only the active workspace path in state v7", () => {
    const run = createRunRecord({ workspace: { relativePath: "runs/job-1/workspace" } });
    const state = createProjectState({ runs: { [run.jobId]: run } });
    expect(projectStateSchema.safeParse(state).success).toBe(true);
    expect(projectStateSchema.safeParse({
      ...state,
      runs: {
        [run.jobId]: {
          ...run,
          workspace: { ...run.workspace, baselineHash: "a".repeat(64) }
        }
      }
    }).success).toBe(false);
  });

  it("persists strict Host review turns and automatic repair counts in schema v7", () => {
    const run = createRunRecord({
      phase: "REVIEWING",
      autoRepairRounds: 7,
      hostTurn: {
        stage: "AWAITING_REVIEW",
        turnToken: "turn-1",
        hostTurnId: "daemon-reviewer",
        reviewAttemptId: "review-attempt-1",
        startedAt: "2026-08-11T10:00:00+00:00",
        deadlineAt: "2026-08-11T10:30:00+00:00"
      }
    });
    const state = createProjectState({ runs: { [run.jobId]: run } });
    expect(projectStateSchema.parse(state).runs[run.jobId]).toMatchObject({
      autoRepairRounds: 7,
      hostTurn: { stage: "AWAITING_REVIEW", turnToken: "turn-1" }
    });
    expect(projectStateSchema.safeParse({
      ...state,
      runs: {
        [run.jobId]: {
          ...run,
          hostTurn: { ...run.hostTurn, worktreePath: "/private/worktree" }
        }
      }
    }).success).toBe(false);
    expect(projectStateSchema.safeParse({
      ...state,
      runs: {
        [run.jobId]: {
          ...run,
          hostTurn: { ...run.hostTurn, hostTurnId: "host-turn-1" }
        }
      }
    }).success).toBe(false);
  });

  it("persists Pi Attempt session/containment identity and TIMED_OUT", () => {
    const run = createRunRecord({
      phase: "PAUSED",
      workerAttempts: [{
        attemptId: "attempt-1",
        generation: 0,
        providerRuntimeConfigHash: "b".repeat(64),
        status: "TIMED_OUT",
        piSessionId: "pi-session-1",
        containmentId: "containment-1",
        processIdentity: { pid: 1234, startToken: "1234:start" },
        terminalReason: "ATTEMPT_DEADLINE_EXCEEDED",
        startedAt: "2026-07-20T10:00:00+08:00",
        endedAt: "2026-07-20T10:01:00+08:00"
      }],
      pause: { code: "WORKER_TIMED_OUT", resumeActions: ["retry_provider"] }
    });
    const state = createProjectState({
      stateVersion: 1,
      projectFence: 2,
      activeRunsByTaskPath: { [run.canonicalTaskPath]: run.jobId },
      runs: { [run.jobId]: run }
    });
    expect(projectStateSchema.safeParse(state).success).toBe(true);
    expect(projectStateSchema.safeParse({
      ...state,
      runs: {
        [run.jobId]: {
          ...run,
          workerAttempts: [{ ...run.workerAttempts[0], attemptId: "attempt-1" }, run.workerAttempts[0]]
        }
      }
    }).success).toBe(false);
  });

  it("requires completed Pi Attempts to bind their internal session artifact", () => {
    const completedAttempt = {
      attemptId: "attempt-completed",
      generation: 0,
      providerRuntimeConfigHash: "c".repeat(64),
      status: "COMPLETED" as const,
      piSessionId: "pi-session-completed",
      startedAt: "2026-07-20T10:00:00+08:00",
      endedAt: "2026-07-20T10:01:00+08:00"
    };
    const incompleteRun = createRunRecord({
      phase: "RUNNING",
      workerAttempts: [completedAttempt]
    });
    expect(projectStateSchema.safeParse(createProjectState({
      runs: { [incompleteRun.jobId]: incompleteRun }
    })).success).toBe(false);

    const sessionArtifact = {
      relativePath: "runs/job-1/attempts/attempt-completed/session-artifact.json",
      sha256: "d".repeat(64),
      size: 256
    };
    const completeRun = createRunRecord({
      phase: "RUNNING",
      workerAttempts: [{ ...completedAttempt, sessionArtifact }]
    });
    expect(projectStateSchema.safeParse(createProjectState({
      runs: { [completeRun.jobId]: completeRun }
    })).success).toBe(true);
    expect(runArtifactInventory(completeRun).bindings).toContainEqual({
      name: "workerAttempts[0].sessionArtifact",
      ref: sessionArtifact,
      semantic: "PI_SESSION"
    });
  });

  it("rejects Broker, effect, managed-process, singular Worker Attempt, and workerBlock state", () => {
    const run = createRunRecord();
    for (const legacy of [
      { brokerSession: { status: "ACTIVE" } },
      { effectExecutions: {} },
      { managedProcesses: [] },
      { workerAttempt: {} },
      { workerBlock: {} }
    ]) {
      expect(projectStateSchema.safeParse(createProjectState({
        runs: { [run.jobId]: { ...run, ...legacy } }
      })).success).toBe(false);
    }
  });

  it("requires terminal Publish results to bind their operation and operations hash", () => {
    const operationId = "publish-1";
    const operationsHash = "e".repeat(64);
    const result = {
      operationId,
      operationsHash,
      status: "COMMITTED" as const,
      paths: [{
        path: "src/a.ts",
        status: "COMMITTED" as const,
        observedHash: "f".repeat(64),
        observedMode: 0o644
      }]
    };
    const run = createRunRecord({
      publish: {
        operationId,
        operationsHash,
        adapterId: "cas-adapter",
        status: "COMMITTED",
        result
      }
    });
    const state = createProjectState({ runs: { [run.jobId]: run } });
    expect(projectStateSchema.safeParse(state).success).toBe(true);
    expect(projectStateSchema.safeParse({
      ...state,
      runs: {
        [run.jobId]: {
          ...run,
          publish: {
            ...run.publish,
            result: { ...result, operationId: "publish-other" }
          }
        }
      }
    }).success).toBe(false);
  });

  it("uses SQLite as the only state storage", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(harness.dataDir);
    const initial = await store.initialize(createProjectState());

    expect(await store.readState()).toEqual(initial);
    expect(store.protectedPaths).toEqual([
      store.databasePath,
      `${store.databasePath}-wal`,
      `${store.databasePath}-shm`
    ]);

    const database = new DatabaseSync(store.databasePath);
    try {
      const projectStateColumns = database.prepare("PRAGMA table_info(project_state)").all() as {
        name?: unknown;
      }[];
      expect(projectStateColumns.map((column) => column.name)).toEqual([
        "singleton",
        "state_version",
        "project_fence",
        "state_json",
        "updated_at"
      ]);
      const leaseColumns = database.prepare("PRAGMA table_info(mutation_lease)").all();
      expect(leaseColumns.map((column) => column.name)).toEqual([
        "singleton",
        "owner_token",
        "owner_pid",
        "owner_hostname",
        "owner_process_start_token",
        "expires_at_ms"
      ]);
    } finally {
      database.close();
    }
  });
});
