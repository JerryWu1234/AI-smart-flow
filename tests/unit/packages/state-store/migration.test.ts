import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "@smartflow/protocol";
import { canonicalHash, StateStore, type ProjectState } from "@smartflow/state-store";
import { createProjectState, createRunRecord } from "../../../fixtures/state-store/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../../../helpers/runtime-harness.js";

const harnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

const run = createRunRecord();
const legacyStateFixture = {
  ...createProjectState({ stateVersion: 7, projectFence: 9, runs: { [run.jobId]: run } }),
  processedRequests: {
    "request-1": {
      requestId: "request-1",
      requestHash: canonicalHash({ operation: "start" }),
      response: { jobId: run.jobId, requestId: "public-request-id", committedAtStateVersion: 7 },
      committedAtStateVersion: 7
    }
  }
};

function writeV5Database(database: DatabaseSync, state: ProjectState): void {
  database.exec(`
    CREATE TABLE project_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state_version INTEGER NOT NULL CHECK (state_version >= 0),
      project_fence INTEGER NOT NULL CHECK (project_fence >= 0),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE mutation_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner_token TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
      owner_hostname TEXT NOT NULL,
      owner_process_start_token TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0)
    ) STRICT;
    PRAGMA user_version = 5;
  `);
  database.prepare("INSERT INTO project_state VALUES (1, ?, ?, ?, ?)").run(
    state.stateVersion, state.projectFence, canonicalJson(state), state.updatedAt
  );
}

describe("SQLite v5 state cleanup", () => {
  it("preserves runs, replay payloads, counters and active lease ownership during migration", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const store = new StateStore(harness.dataDir);
    const legacy = structuredClone(legacyStateFixture);
    const expiresAt = Date.now() + 60_000;
    const database = new DatabaseSync(store.databasePath);
    try {
      writeV5Database(database, legacy);
      database.prepare("INSERT INTO mutation_lease VALUES (1, ?, ?, ?, ?, ?, ?)").run(
        "lease-token", "unused-owner-id", process.pid, hostname(), "process-instance", expiresAt
      );
    } finally {
      database.close();
    }

    const migrated = await store.readState();
    const receipt = legacy.processedRequests["request-1"];
    expect(migrated).toEqual({
      ...legacy,
      processedRequests: {
        "request-1": { requestHash: receipt.requestHash, response: receipt.response }
      }
    });
    expect(await new StateStore(harness.dataDir).readState()).toEqual(migrated);
    await expect(store.writeState({ ...migrated, stateVersion: 8 })).rejects.toMatchObject({
      code: "PROJECT_LOCKED"
    });

    const observed = new DatabaseSync(store.databasePath);
    try {
      expect(observed.prepare("PRAGMA user_version").get()?.user_version).toBe(6);
      expect(observed.prepare("SELECT * FROM mutation_lease").get()).toEqual({
        singleton: 1,
        owner_token: "lease-token",
        owner_pid: process.pid,
        owner_hostname: hostname(),
        owner_process_start_token: "process-instance",
        expires_at_ms: expiresAt
      });
      expect(observed.prepare("SELECT state_json FROM project_state").get()?.state_json)
        .toBe(canonicalJson(migrated));
      observed.exec("DELETE FROM mutation_lease");
    } finally {
      observed.close();
    }
    await expect(store.writeState({ ...migrated, stateVersion: 8 })).resolves.toMatchObject({
      stateVersion: 8,
      processedRequests: migrated.processedRequests
    });
  });

  it.each(["invalid receipt", "blocked schema change"])(
    "leaves the original v5 database intact on %s",
    async (failure) => {
      const harness = await createRuntimeHarness();
      harnesses.push(harness);
      const store = new StateStore(harness.dataDir);
      const legacy = structuredClone(legacyStateFixture);
      if (failure === "invalid receipt") legacy.processedRequests["request-1"].requestHash = "invalid";
      const database = new DatabaseSync(store.databasePath);
      try {
        writeV5Database(database, legacy);
        if (failure === "blocked schema change") {
          database.exec("CREATE INDEX legacy_owner_index ON mutation_lease(owner_id)");
        }
      } finally {
        database.close();
      }

      await expect(store.readState()).rejects.toMatchObject({ code: "STATE_INVALID" });
      const observed = new DatabaseSync(store.databasePath);
      try {
        expect(observed.prepare("PRAGMA user_version").get()?.user_version).toBe(5);
        expect(observed.prepare("SELECT state_json FROM project_state").get()?.state_json)
          .toBe(canonicalJson(legacy));
        expect(observed.prepare("PRAGMA table_info(mutation_lease)").all().map((column) => column.name))
          .toContain("owner_id");
      } finally {
        observed.close();
      }
    }
  );
});
