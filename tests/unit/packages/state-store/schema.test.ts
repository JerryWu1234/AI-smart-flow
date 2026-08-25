import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeHarness, type RuntimeHarness } from "../../../helpers/runtime-harness.js";
import { projectStateSchema } from "../../../../packages/state-store/src/schema.js";
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

  it("persists strict Host review turns and automatic repair counts in schema v6", () => {
    const run = createRunRecord({
      phase: "REVIEWING",
      autoRepairRounds: 7,
      hostTurn: {
        stage: "AWAITING_REVIEW",
        turnToken: "turn-1",
        hostTurnId: "daemon-reviewer",
        revision: 1,
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

  it.each([4, 5])("rejects project state schema v%s", (schemaVersion) => {
    expect(projectStateSchema.safeParse({
      ...createProjectState(),
      schemaVersion
    }).success).toBe(false);
  });

  it("persists Pi Attempt session/containment identity and TIMED_OUT", () => {
    const run = createRunRecord({
      phase: "PAUSED",
      workerAttempts: [{
        attemptId: "attempt-1",
        revision: 1,
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
        revision: 1,
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

  it("uses SQLite as the only state and audit storage", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(harness.dataDir);
    const initial = await store.initialize(createProjectState());
    const event = { kind: "STATE_INITIALIZED", stateVersion: 0 };
    await store.appendAuditEvent(event);

    expect(await store.readState()).toEqual(initial);
    expect(store.protectedPaths).toEqual([
      store.databasePath,
      `${store.databasePath}-wal`,
      `${store.databasePath}-shm`
    ]);

    const database = new DatabaseSync(store.databasePath);
    try {
      const row = database.prepare(`
        SELECT event_json
        FROM audit_events
        ORDER BY sequence DESC
        LIMIT 1
      `).get() as { event_json?: unknown } | undefined;
      expect(row?.event_json).toBe(JSON.stringify(event));
    } finally {
      database.close();
    }
  });
});
