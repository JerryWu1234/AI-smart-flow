import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectMutationSession,
  StateStore,
  type AtomicWriteHooks,
  type ProjectState
} from "@smartflow/state-store";
import { createProjectState } from "../../packages/state-store/src/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

class FaultingStateStore extends StateStore {
  public nextHooks: AtomicWriteHooks | undefined;

  public override async writeState(
    nextState: ProjectState,
    hooks: AtomicWriteHooks = {}
  ): Promise<ProjectState> {
    const selected = this.nextHooks ?? hooks;
    this.nextHooks = undefined;
    return super.writeState(nextState, selected);
  }
}

const activeHarnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("durable idempotency response", () => {
  it("recovers the first response when the caller loses it after rename", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new FaultingStateStore(resolve(harness.dataDir, "idempotency"));
    await store.initialize(createProjectState());
    const session = await ProjectMutationSession.open(store, "writer-1");
    store.nextHooks = {
      checkpoint(checkpoint): void {
        if (checkpoint === "AFTER_RENAME") throw new Error("response lost after durable commit");
      }
    };
    let mutationRuns = 0;
    let firstGeneratedJobId = "";
    const request = { requestId: "request-1", payload: { operation: "create-job" } };
    await expect(
      session.mutate(request, (state, context) => {
        mutationRuns += 1;
        firstGeneratedJobId = randomUUID();
        return {
          nextState: state,
          response: { jobId: firstGeneratedJobId, stateVersion: context.nextStateVersion }
        };
      })
    ).rejects.toThrow(/response lost/u);
    const replay = await session.mutate(request, () => {
      mutationRuns += 1;
      throw new Error("durable request must not execute twice");
    });
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual({ jobId: firstGeneratedJobId, stateVersion: 2 });
    expect(mutationRuns).toBe(1);
    await session.close();
  });
});
