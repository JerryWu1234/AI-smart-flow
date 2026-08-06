import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RecoveryManager,
  type PublishRecoveryObservation,
  type RecoveryRuntime
} from "@smartflow/daemon";
import type { WorkerAttempt } from "@smartflow/state-store";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";
import { createLifecycleStore } from "./recovery-test-fixture.js";

class Runtime implements RecoveryRuntime {
  public worker: "RESUMABLE" | "STOPPED" | "UNKNOWN" = "STOPPED";
  public inspectedAttempt: WorkerAttempt | undefined;

  public inspectWorker(attempt: WorkerAttempt | undefined): Promise<"RESUMABLE" | "STOPPED" | "UNKNOWN"> {
    this.inspectedAttempt = attempt;
    return Promise.resolve(this.worker);
  }

  public reconcilePublish(): Promise<PublishRecoveryObservation> {
    return Promise.resolve({ status: "PENDING" });
  }

  public continueCancellation(): Promise<"CANCELED" | "BLOCKED"> {
    return Promise.resolve("BLOCKED");
  }
}

const harnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("Pi crash recovery", () => {
  it("resumes the same live Pi session when containment is still resumable", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "RUNNING");
    const runtime = new Runtime();
    runtime.worker = "RESUMABLE";

    const before = await store.readState();
    const recovered = await new RecoveryManager(store, runtime).recover("job-1");
    expect(recovered).toMatchObject({ phase: "RUNNING", action: "RESUME_WORKER" });
    expect(runtime.inspectedAttempt?.piSessionId).toBe("pi-session-old");
    expect((await store.readState()).stateVersion).toBe(before.stateVersion);
  });

  it("ends a stopped attempt and prepares one new Agent session after restart", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "RUNNING");
    const runtime = new Runtime();

    const recovered = await new RecoveryManager(store, runtime).recover("job-1");
    expect(recovered).toMatchObject({
      phase: "PREPARING",
      action: "START_NEW_WORKER_ATTEMPT",
      recoveryEpoch: {
        sourceAttemptId: "attempt-old",
        sourceGeneration: 3,
        resetGeneration: 4,
        resetAttemptId: null
      }
    });
    const state = await store.readState();
    expect(state.runs["job-1"]?.workerAttempts).toHaveLength(1);
    expect(state.runs["job-1"]?.workerAttempts[0]).toMatchObject({
      status: "FAILED",
      terminalReason: "DAEMON_RESTART_RECONCILED"
    });
    expect(state.runs["job-1"]?.workspace).toBeUndefined();

    const replay = await new RecoveryManager(store, runtime).recover("job-1");
    expect(replay.action).toBe("REBUILD_WORKSPACE");
    expect((await store.readState()).stateVersion).toBe(state.stateVersion);
  });

  it("pauses when the old process outcome cannot be proven", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "RUNNING");
    const runtime = new Runtime();
    runtime.worker = "UNKNOWN";

    const recovered = await new RecoveryManager(store, runtime).recover("job-1");
    expect(recovered).toMatchObject({
      phase: "PAUSED",
      action: "BLOCKED",
      reason: "PAUSED_PROCESS_RECONCILIATION:WORKER_OUTCOME_UNKNOWN"
    });
    expect((await store.readState()).runs["job-1"]?.workerAttempts.at(-1)?.status)
      .toBe("RUNNING");
  });

  it("does not create a replacement for a timed-out Pi Attempt", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const endedAt = new Date().toISOString();
    const store = await createLifecycleStore(harness, "RUNNING", {
      workerAttempts: [{
        attemptId: "attempt-timeout",
        revision: 1,
        generation: 3,
        providerRuntimeConfigHash: "a".repeat(64),
        status: "TIMED_OUT",
        terminalReason: "ATTEMPT_DEADLINE_EXCEEDED",
        startedAt: endedAt,
        endedAt
      }]
    });
    const runtime = new Runtime();

    const before = await store.readState();
    const recovered = await new RecoveryManager(store, runtime).recover("job-1");
    expect(recovered).toMatchObject({
      phase: "RUNNING",
      action: "WAIT_FOR_LEADER",
      reason: "ATTEMPT_DEADLINE_EXCEEDED"
    });
    expect(runtime.inspectedAttempt).toBeUndefined();
    expect((await store.readState()).stateVersion).toBe(before.stateVersion);
    expect((await store.readState()).runs["job-1"]?.workerAttempts).toHaveLength(1);
  });

  it("fails closed when a bound Artifact is corrupted", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "REVIEW_PENDING");
    const run = (await store.readState()).runs["job-1"];
    if (run?.reviewBundle === undefined) throw new Error("review bundle missing");
    await writeFile(resolve(store.dataDirectory, run.reviewBundle.relativePath), "tampered", "utf8");

    const recovered = await new RecoveryManager(store, new Runtime()).recover("job-1");
    expect(recovered).toMatchObject({
      phase: "PAUSED",
      action: "BLOCKED",
      reason: "ARTIFACT_INTEGRITY_FAILED:reviewBundle"
    });
  });
});
