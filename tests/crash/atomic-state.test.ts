import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  StateStore,
  StateStoreError,
  type AtomicWriteCheckpoint,
  type ProjectState
} from "@smartflow/state-store";
import { createProjectState } from "../../packages/state-store/src/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const activeHarnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("atomic state replacement crash points", () => {
  for (const checkpoint of [
    "AFTER_TEMP_WRITE",
    "AFTER_FILE_FSYNC",
    "AFTER_RENAME",
    "AFTER_DIRECTORY_FSYNC"
  ] as const) {
    it(`recovers only the complete old or new state after ${checkpoint}`, async () => {
      const harness = await createRuntimeHarness();
      activeHarnesses.push(harness);
      const store = new StateStore(resolve(harness.dataDir, checkpoint));
      const oldState = await store.initialize(createProjectState());
      const newState: ProjectState = {
        ...oldState,
        stateVersion: 1,
        updatedAt: "2026-07-20T11:00:00+08:00"
      };
      await expect(
        store.writeState(newState, {
          checkpoint(observed: AtomicWriteCheckpoint): void {
            if (observed === checkpoint) throw new Error(`simulated crash at ${checkpoint}`);
          }
        })
      ).rejects.toThrow(/simulated crash/u);
      const recovered = await store.readState();
      const expected = checkpoint === "AFTER_TEMP_WRITE" || checkpoint === "AFTER_FILE_FSYNC"
        ? oldState
        : newState;
      expect(recovered).toEqual(expected);
    });
  }

  it("fails explicitly instead of migrating active Broker state", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "legacy-state");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(resolve(dataDirectory, "state.json"), JSON.stringify({
      schemaVersion: 2,
      runs: { "job-1": { phase: "RUNNING", brokerSession: { status: "ACTIVE" } } }
    }), "utf8");
    const store = new StateStore(dataDirectory);
    await expect(store.readState()).rejects.toMatchObject({
      code: "STATE_MIGRATION_UNSUPPORTED"
    } satisfies Partial<StateStoreError>);
  });
});
