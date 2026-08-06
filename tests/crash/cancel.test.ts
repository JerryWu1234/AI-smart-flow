import { afterEach, describe, expect, it } from "vitest";

import {
  CancelManager,
  type CancellationRuntime
} from "@smartflow/daemon";
import type { WorkerAttempt } from "@smartflow/state-store";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";
import { createLifecycleStore } from "./recovery-test-fixture.js";

class Runtime implements CancellationRuntime {
  public workerStopped = true;
  public actionRevoked = true;
  public stopCalls: Array<WorkerAttempt | undefined> = [];

  public stopWorker(attempt: WorkerAttempt | undefined): Promise<boolean> {
    this.stopCalls.push(attempt);
    return Promise.resolve(this.workerStopped);
  }

  public revokeAction(): Promise<boolean> {
    return Promise.resolve(this.actionRevoked);
  }
}

const activeHarnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("durable Pi cancellation reconciliation", () => {
  it("stops the active Pi Attempt, marks it canceled, and completes idempotently", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = await createLifecycleStore(harness, "RUNNING");
    const runtime = new Runtime();
    const manager = new CancelManager(store, runtime);

    const requested = await manager.request("job-1", "user requested cancellation");
    expect(requested.phase).toBe("CANCELING");
    expect((await manager.request("job-1", "duplicate")).stateVersion)
      .toBe(requested.stateVersion);

    const completed = await manager.reconcile("job-1");
    expect(completed).toMatchObject({ phase: "CANCELED", reconciled: true });
    const run = (await store.readState()).runs["job-1"];
    expect(run?.workerAttempts.at(-1)).toMatchObject({
      attemptId: "attempt-old",
      status: "CANCELED",
      terminalReason: "RUN_CANCELED"
    });
    expect(run?.cancellation).toMatchObject({ status: "COMPLETED" });
    expect(runtime.stopCalls[0]?.attemptId).toBe("attempt-old");

    const calls = runtime.stopCalls.length;
    expect((await manager.reconcile("job-1")).stateVersion).toBe(completed.stateVersion);
    expect(runtime.stopCalls).toHaveLength(calls);
  });

  it("fails closed when the Pi process tree cannot be proven stopped", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = await createLifecycleStore(harness, "RUNNING");
    const runtime = new Runtime();
    runtime.workerStopped = false;
    const manager = new CancelManager(store, runtime);

    await manager.request("job-1", "cancel uncertain process");
    const blocked = await manager.reconcile("job-1");
    expect(blocked).toMatchObject({
      phase: "PAUSED",
      reconciled: false,
      blockedReasons: ["WORKER_STOP_UNCONFIRMED"]
    });
    const run = (await store.readState()).runs["job-1"];
    expect(run?.pause?.code).toBe("PAUSED_PROCESS_RECONCILIATION");
    expect(run?.workerAttempts.at(-1)?.status).toBe("RUNNING");
  });

  it("revokes a claimed Review Action before completing cancellation", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = await createLifecycleStore(harness, "REVIEWING");
    const runtime = new Runtime();
    runtime.actionRevoked = false;
    const manager = new CancelManager(store, runtime);

    await manager.request("job-1", "cancel review");
    const blocked = await manager.reconcile("job-1");
    expect(blocked.blockedReasons).toContain("ACTION_REVOCATION_UNCONFIRMED");
  });
});
