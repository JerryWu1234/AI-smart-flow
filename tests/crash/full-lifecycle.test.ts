import { afterEach, describe, expect, it } from "vitest";

import {
  RecoveryManager,
  type PublishRecoveryObservation,
  type RecoveryAction,
  type RecoveryRuntime
} from "@smartflow/daemon";
import type { RunPhase } from "@smartflow/protocol";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";
import { createLifecycleStore } from "./recovery-test-fixture.js";

const runtime: RecoveryRuntime = {
  inspectWorker: () => Promise.resolve("RESUMABLE"),
  reconcilePublish: (): Promise<PublishRecoveryObservation> => Promise.resolve({ status: "PENDING" }),
  continueCancellation: () => Promise.resolve("BLOCKED")
};

const stableActions: ReadonlyArray<[RunPhase, RecoveryAction]> = [
  ["PREPARING", "REBUILD_WORKSPACE"],
  ["RUNNING", "RESUME_WORKER"],
  ["FIXING", "PREPARE_REPAIR"],
  ["REVIEW_PENDING", "WAIT_FOR_HOST"],
  ["LEADER_DECISION", "WAIT_FOR_LEADER"],
  ["READY_TO_PUBLISH", "RECHECK_PUBLISH_READINESS"],
  ["PAUSED", "NONE"]
];

const harnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("phase-complete crash recovery", () => {
  it.each(stableActions)("recovers %s deterministically as %s", async (phase, expectedAction) => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, phase);
    const before = await store.readState();

    const first = await new RecoveryManager(store, runtime).recover("job-1");
    const second = await new RecoveryManager(store, runtime).recover("job-1");
    expect(first.action).toBe(expectedAction);
    expect(second.action).toBe(expectedAction);
    expect((await store.readState()).stateVersion).toBe(before.stateVersion);
  });

  it("safely pauses REVIEWING when its durable Host turn is missing", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = await createLifecycleStore(harness, "REVIEWING");
    const before = await store.readState();

    const first = await new RecoveryManager(store, runtime).recover("job-1");
    expect(first).toMatchObject({
      phase: "PAUSED",
      action: "BLOCKED",
      reason: "HOST_REVIEW_UNAVAILABLE:REVIEW_TURN_STATE_MISSING"
    });
    const paused = await store.readState();
    expect(paused.stateVersion).toBe(before.stateVersion + 1);
    expect(paused.runs["job-1"]).toMatchObject({
      phase: "PAUSED",
      pause: { code: "HOST_REVIEW_UNAVAILABLE" }
    });

    expect(await new RecoveryManager(store, runtime).recover("job-1"))
      .toMatchObject({ phase: "PAUSED", action: "NONE" });
    expect((await store.readState()).stateVersion).toBe(paused.stateVersion);
  });

  it.each(["CANCELED", "FAILED"] as const)(
    "leaves terminal phase %s untouched",
    async (phase) => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const store = await createLifecycleStore(harness, phase);
      const before = await store.readState();

      const recovered = await new RecoveryManager(store, runtime).recover("job-1");
      expect(recovered).toMatchObject({ phase, action: "NONE" });
      expect((await store.readState()).stateVersion).toBe(before.stateVersion);
    }
  );
});
