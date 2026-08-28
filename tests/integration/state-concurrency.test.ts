import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectMutationExecutor } from "@smartflow/daemon";
import {
  StateStore,
  StateStoreError,
  type ProjectState,
  type RunRecord
} from "@smartflow/state-store";
import {
  createProjectState,
  createRunRecord
} from "../fixtures/state-store/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const activeHarnesses: RuntimeHarness[] = [];

function activeState(run: RunRecord = createRunRecord()): ProjectState {
  return createProjectState({
    projectFence: run.fence,
    activeRunsByTaskPath: { [run.canonicalTaskPath]: run.jobId },
    runs: { [run.jobId]: run }
  });
}

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

async function expectStateError(
  promise: Promise<unknown>,
  code: StateStoreError["code"]
): Promise<void> {
  try {
    await promise;
    throw new Error("expected state operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(StateStoreError);
    expect((error as StateStoreError).code).toBe(code);
  }
}

describe("single writer, fence, CAS, and idempotent receipts", () => {
  it("serializes a committed external-effect handoff", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(resolve(harness.dataDir, "effect-handoff-lock"));
    await store.initialize(activeState(createRunRecord({ phase: "PUBLISHING" })));
    const prepareEntered = Promise.withResolvers<undefined>();
    const releasePrepare = Promise.withResolvers<undefined>();
    const effectEntered = Promise.withResolvers<undefined>();
    const releaseEffect = Promise.withResolvers<undefined>();
    let applyCalls = 0;
    const handoff = new ProjectMutationExecutor(store).mutate(
      {
        requestId: "publish-submit-handoff",
        payload: { status: "SUBMITTED" },
        expectedJobId: "job-1",
        expectedPhases: ["PUBLISHING"]
      },
      (state) => ({ nextState: state, response: { status: "SUBMITTED" } }),
      async () => {
        prepareEntered.resolve(undefined);
        await releasePrepare.promise;
        return async (): Promise<{ status: "APPLIED" }> => {
          applyCalls += 1;
          effectEntered.resolve(undefined);
          await releaseEffect.promise;
          return { status: "APPLIED" as const };
        };
      }
    );
    await prepareEntered.promise;

    let cancelBuilds = 0;
    const cancel = new ProjectMutationExecutor(store).mutate(
      {
        requestId: "cancel-during-publish-handoff",
        payload: { phase: "CANCELING" },
        expectedJobId: "job-1",
        expectedPhases: ["PUBLISHING"]
      },
      (state) => {
        cancelBuilds += 1;
        const run = state.runs["job-1"];
        if (run === undefined) throw new Error("run missing");
        return {
          nextState: {
            ...state,
            runs: { ...state.runs, "job-1": { ...run, phase: "CANCELING" } }
          },
          response: { phase: "CANCELING" }
        };
      }
    );
    await new Promise<void>((settle) => setTimeout(settle, 50));
    expect(cancelBuilds).toBe(0);

    releasePrepare.resolve(undefined);
    await effectEntered.promise;
    const submitted = await handoff;
    expect(submitted).toMatchObject({ effectStarted: true });
    await expect(cancel).resolves.toMatchObject({ response: { phase: "CANCELING" } });
    expect(cancelBuilds).toBe(1);
    expect((await store.readState()).runs["job-1"]?.phase).toBe("CANCELING");
    expect(applyCalls).toBe(1);

    releaseEffect.resolve(undefined);
    await expect(submitted.effect).resolves.toEqual({ status: "APPLIED" });
  });

  it("commits only one of two writes built from the same stateVersion", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(resolve(harness.dataDir, "state-write-cas"));
    await store.initialize(createProjectState());
    const state = await store.readState();
    const results = await Promise.allSettled([
      store.writeState({
        ...state,
        stateVersion: state.stateVersion + 1,
        updatedAt: new Date(Date.now() + 1).toISOString()
      }),
      store.writeState({
        ...state,
        stateVersion: state.stateVersion + 1,
        updatedAt: new Date(Date.now() + 2).toISOString()
      })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
      code: "STATE_VERSION_MISMATCH"
    });
    expect((await store.readState()).stateVersion).toBe(state.stateVersion + 1);
  });

  it("advances the active run fence and replays the original canonical response", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(resolve(harness.dataDir, "state-concurrency"));
    await store.initialize(activeState());
    const initial = await store.readState();
    const initialRun = initial.runs["job-1"];
    if (initialRun === undefined) throw new Error("run missing");
    const staleFence = initialRun.fence;
    const executor = new ProjectMutationExecutor(store);
    const advanced = await executor.mutate(
      {
        requestId: "advance-writer-fence",
        payload: { writer: "writer-2" },
        expectedJobId: "job-1",
        expectedFence: staleFence,
        advanceFence: true
      },
      (state, context) => ({
        nextState: state,
        response: { fence: context.fence }
      })
    );
    const activeFence = advanced.state.runs["job-1"]?.fence;
    if (activeFence === undefined) throw new Error("advanced run missing");
    expect(activeFence).toBe(staleFence + 1);
    await expectStateError(
      executor.mutate(
        {
          requestId: "superseded-writer",
          payload: {},
          expectedJobId: "job-1",
          expectedFence: staleFence
        },
        (state) => ({ nextState: state, response: { accepted: false } })
      ),
      "STALE_FENCE"
    );
    let mutations = 0;
    const request = {
      requestId: "request-1",
      payload: { operation: "start", jobId: "job-1" },
      expectedJobId: "job-1",
      expectedFence: activeFence
    };
    const first = await executor.mutate(request, (state, context) => {
      mutations += 1;
      return {
        nextState: state,
        response: {
          projectId: state.projectId,
          jobId: "job-1",
          stateVersion: context.nextStateVersion
        }
      };
    });
    const replay = await executor.mutate(request, () => {
      mutations += 1;
      throw new Error("replayed mutation must not run");
    });
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(first.response);
    expect(mutations).toBe(1);
    await expectStateError(
      executor.mutate({ ...request, payload: { operation: "different" } }, () => {
        throw new Error("must not run");
      }),
      "IDEMPOTENCY_KEY_REUSED"
    );
  });

  it("rejects stale stateVersion and fence", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(resolve(harness.dataDir, "state-cas"));
    await store.initialize(activeState());
    const initial = await store.readState();
    const run = initial.runs["job-1"];
    if (run === undefined) throw new Error("run missing");
    const executor = new ProjectMutationExecutor(store);
    await expectStateError(
      executor.mutate(
        {
          requestId: "stale-state",
          payload: {},
          expectedStateVersion: initial.stateVersion + 1
        },
        () => {
          throw new Error("must not run");
        }
      ),
      "STATE_VERSION_MISMATCH"
    );
    await store.writeState({
      ...initial,
      projectFence: initial.projectFence + 1,
      stateVersion: initial.stateVersion + 1,
      runs: {
        ...initial.runs,
        "job-1": { ...run, fence: run.fence + 1 }
      },
      updatedAt: new Date().toISOString()
    });
    await expectStateError(
      executor.mutate(
        {
          requestId: "stale-fence",
          payload: {},
          expectedJobId: "job-1",
          expectedFence: run.fence
        },
        () => {
          throw new Error("must not run");
        }
      ),
      "STALE_FENCE"
    );
  });

  it("serializes background and cancel mutations without overwriting CANCELING", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(resolve(harness.dataDir, "state-runtime-mutations"));
    await store.initialize(activeState(createRunRecord({ phase: "RUNNING" })));
    const cancelEntered = Promise.withResolvers<undefined>();
    const releaseCancel = Promise.withResolvers<undefined>();
    const cancelExecutor = new ProjectMutationExecutor(store);
    const backgroundExecutor = new ProjectMutationExecutor(store);
    let cancelBuilds = 0;
    const cancel = cancelExecutor.mutate(
      {
        requestId: "cancel-job-1",
        payload: { jobId: "job-1", reason: "test" },
        expectedJobId: "job-1",
      },
      async (state) => {
        cancelBuilds += 1;
        cancelEntered.resolve(undefined);
        await releaseCancel.promise;
        const run = state.runs["job-1"];
        if (run === undefined) throw new Error("run missing");
        return {
          nextState: {
            ...state,
            runs: { ...state.runs, "job-1": { ...run, phase: "CANCELING" } }
          },
          response: { phase: "CANCELING" }
        };
      }
    );
    await cancelEntered.promise;
    const background = backgroundExecutor.mutate(
      {
        requestId: "worker-terminal-job-1",
        payload: { jobId: "job-1", event: "completed" },
        expectedJobId: "job-1",
      },
      (state) => {
        const run = state.runs["job-1"];
        if (run?.phase !== "RUNNING") throw new Error("BACKGROUND_PHASE_STALE");
        return {
          nextState: {
            ...state,
            runs: { ...state.runs, "job-1": { ...run, phase: "REVIEW_PENDING" } }
          },
          response: { phase: "REVIEW_PENDING" }
        };
      }
    );
    releaseCancel.resolve(undefined);
    await expect(cancel).resolves.toMatchObject({ response: { phase: "CANCELING" } });
    await expect(background).rejects.toThrow("BACKGROUND_PHASE_STALE");
    await expect(cancelExecutor.mutate(
      {
        requestId: "cancel-job-1",
        payload: { jobId: "job-1", reason: "test" },
        expectedJobId: "job-1",
      },
      () => {
        cancelBuilds += 1;
        throw new Error("idempotent replay must not rebuild");
      }
    )).resolves.toMatchObject({ replayed: true });
    expect(cancelBuilds).toBe(1);
    expect((await store.readState()).runs["job-1"]?.phase).toBe("CANCELING");
  });

  it("fences late Worker, Review, Publish, and Recovery callbacks by captured identity", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(resolve(harness.dataDir, "captured-callback-identity"));
    await store.initialize(activeState(
      createRunRecord({
          fence: 3,
          phase: "RUNNING",
          workerAttempts: [{
            attemptId: "attempt-old",
            generation: 4,
            providerRuntimeConfigHash: "a".repeat(64),
            status: "RUNNING",
            piSessionId: "pi-session-old",
            containmentId: "containment-old",
            processIdentity: { pid: 2_147_483_647, startToken: "process-old" },
            startedAt: "2026-07-20T10:00:00+08:00"
          }]
        })
    ));
    const executor = new ProjectMutationExecutor(store);
    const replayRequest = {
      requestId: "captured-callback-original",
      payload: { callback: "worker", result: "accepted" },
      expectedJobId: "job-1",
      expectedFence: 3,
      expectedGeneration: 4,
      expectedAttemptId: "attempt-old",
      expectedPhases: ["RUNNING"] as const
    };
    const accepted = await executor.mutate(replayRequest, (state) => ({
      nextState: state,
      response: { accepted: true }
    }));
    const current = await store.readState();
    const run = current.runs["job-1"];
    if (run === undefined) throw new Error("run missing");
    const oldAttempt = run.workerAttempts[0];
    if (oldAttempt === undefined) throw new Error("worker attempt missing");
    await store.writeState({
      ...current,
      projectFence: 4,
      stateVersion: current.stateVersion + 1,
      runs: {
        ...current.runs,
        "job-1": {
          ...run,
          fence: 4,
          phase: "CANCELING",
          workerAttempts: [{
            ...oldAttempt,
            generation: 5,
            attemptId: "attempt-new"
          }]
        }
      },
      updatedAt: new Date().toISOString()
    });
    const protectedState = await store.readState();

    for (const callback of ["worker", "review", "publish", "recovery"] as const) {
      let builds = 0;
      await expectStateError(executor.mutate(
        {
          ...replayRequest,
          requestId: `captured-callback-late-${callback}`,
          payload: { callback, result: "late" }
        },
        (state) => {
          builds += 1;
          return { nextState: state, response: { accepted: false } };
        }
      ), "STALE_FENCE");
      expect(builds).toBe(0);
      expect(await store.readState()).toEqual(protectedState);
    }

    await expect(executor.mutate(replayRequest, () => {
      throw new Error("replayed callback must not rebuild");
    })).resolves.toMatchObject({
      replayed: true,
      response: accepted.response
    });
    expect(await store.readState()).toEqual(protectedState);
  });
});
