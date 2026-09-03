import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectMutationExecutor } from "@smartflow/daemon";
import {
  StateStore,
  StateStoreError,
  canonicalHash,
  type AtomicWriteCheckpoint,
  type ProjectState
} from "@smartflow/state-store";
import { createProjectState } from "../fixtures/state-store/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const activeHarnesses: RuntimeHarness[] = [];

const SQLITE_CRASH_SCRIPT = `
import { DatabaseSync } from "node:sqlite";
const [databasePath, encodedState, shouldCommit] = process.argv.slice(1);
const state = JSON.parse(Buffer.from(encodedState, "base64url").toString("utf8"));
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0; BEGIN IMMEDIATE");
database.prepare(\`
  UPDATE project_state
  SET state_version = ?,
      project_fence = ?,
      state_json = ?,
      updated_at = ?
  WHERE singleton = 1
\`).run(
  state.stateVersion,
  state.projectFence,
  JSON.stringify(state),
  state.updatedAt
);
if (shouldCommit === "yes") database.exec("COMMIT");
process.kill(process.pid, "SIGKILL");
`;

const SQLITE_LOCK_SCRIPT = `
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[1]);
database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
process.stdout.write("LOCKED\\n");
setTimeout(() => database.exec("ROLLBACK"), 10_000);
`;

const SQLITE_EXPIRED_LIVE_LEASE_SCRIPT = `
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[1]);
const startedAt = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], {
  encoding: "utf8",
  shell: false
}).stdout.trim();
if (startedAt.length === 0) throw new Error("process start token unavailable");
database.prepare(\`
  INSERT INTO mutation_lease (
    singleton,
    owner_token,
    owner_id,
    owner_pid,
    owner_hostname,
    owner_process_start_token,
    expires_at_ms
  ) VALUES (1, 'expired-live-owner', 'expired-live-owner', ?, ?, ?, ?)
\`).run(
  process.pid,
  hostname(),
  \`\${String(process.pid)}:\${startedAt}\`,
  Date.now() - 60_000
);
process.stdout.write("LEASED\\n");
setInterval(() => undefined, 10_000);
`;

const SQLITE_RECEIPT_WINNER_SCRIPT = `
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
const [databasePath, requestId, requestHash, responseHash] = process.argv.slice(1);
const database = new DatabaseSync(databasePath);
const ownerToken = randomUUID();
const startedAt = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], {
  encoding: "utf8",
  shell: false
}).stdout.trim();
if (startedAt.length === 0) throw new Error("process start token unavailable");
database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
database.prepare(\`
  INSERT INTO mutation_lease (
    singleton,
    owner_token,
    owner_id,
    owner_pid,
    owner_hostname,
    owner_process_start_token,
    expires_at_ms
  ) VALUES (1, ?, 'child-winner', ?, ?, ?, ?)
\`).run(
  ownerToken,
  process.pid,
  hostname(),
  \`\${String(process.pid)}:\${startedAt}\`,
  Date.now() + 60_000
);
database.exec("COMMIT");
process.stdout.write("LEASED\\n");
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  database.exec("BEGIN IMMEDIATE");
  const row = database.prepare("SELECT state_json FROM project_state WHERE singleton = 1").get();
  const state = JSON.parse(row.state_json);
  const nextStateVersion = state.stateVersion + 1;
  state.stateVersion = nextStateVersion;
  state.projectFence += 1;
  state.updatedAt = "2026-08-15T13:01:30.000Z";
  state.processedRequests[requestId] = {
    requestId,
    requestHash,
    response: { accepted: true },
    responseHash,
    committedAtStateVersion: nextStateVersion
  };
  database.prepare(\`
    UPDATE project_state
    SET state_version = ?,
        project_fence = ?,
        state_json = ?,
        updated_at = ?
    WHERE singleton = 1
  \`).run(
    state.stateVersion,
    state.projectFence,
    JSON.stringify(state),
    state.updatedAt
  );
  database.prepare("DELETE FROM mutation_lease WHERE singleton = 1 AND owner_token = ?")
    .run(ownerToken);
  database.exec("COMMIT");
  process.stdout.write("DONE\\n");
});
setInterval(() => undefined, 10_000);
`;

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

async function runCrashWriter(
  databasePath: string,
  state: ProjectState,
  commit: boolean
): Promise<void> {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    SQLITE_CRASH_SCRIPT,
    databasePath,
    Buffer.from(JSON.stringify(state), "utf8").toString("base64url"),
    commit ? "yes" : "no"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (settle, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => settle({ code, signal }));
    }
  );
  if (result.signal !== "SIGKILL") {
    throw new Error(
      `SQLite crash writer did not reach its kill barrier (code=${String(result.code)}): ${stderr}`
    );
  }
}

async function waitForLine(
  stream: NodeJS.ReadableStream,
  expected: string
): Promise<void> {
  await new Promise<void>((settle, reject) => {
    let observed = "";
    const onData = (chunk: Buffer | string): void => {
      observed += chunk.toString();
      if (observed.includes(expected)) {
        stream.removeListener("data", onData);
        settle();
      }
    };
    stream.on("data", onData);
    stream.once("error", reject);
  });
}

describe("atomic state replacement crash points", () => {
  // writeState fires AFTER_TEMP_WRITE and AFTER_FILE_FSYNC back to back before
  // the SQLite transaction, then AFTER_RENAME and AFTER_DIRECTORY_FSYNC back to
  // back after it. Each pair injects at the same instant, so the only boundary
  // worth crashing at is the transaction itself. These two checkpoints bracket
  // it; the other two are the same two scenarios under different names.
  for (const [checkpoint, committed] of [
    ["AFTER_FILE_FSYNC", false],
    ["AFTER_RENAME", true]
  ] as const) {
    it(`recovers the ${committed ? "new" : "old"} state after a crash at ${checkpoint}`, async () => {
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
      expect(recovered).toEqual(committed ? newState : oldState);
    });
  }

  for (const commit of [false, true]) {
    it(`reopens a real WAL after a child is killed ${commit ? "after" : "before"} COMMIT`, async () => {
      const harness = await createRuntimeHarness();
      activeHarnesses.push(harness);
      const store = new StateStore(resolve(harness.dataDir, `wal-kill-${String(commit)}`));
      const oldState = await store.initialize(createProjectState());
      const newState: ProjectState = {
        ...oldState,
        stateVersion: oldState.stateVersion + 1,
        projectFence: oldState.projectFence + 1,
        updatedAt: "2026-08-15T13:00:00.000Z"
      };

      await runCrashWriter(store.databasePath, newState, commit);
      const wal = await stat(`${store.databasePath}-wal`);
      expect(wal.isFile()).toBe(true);
      if (commit) expect(wal.size).toBeGreaterThan(0);
      const reopened = await new StateStore(store.dataDirectory).readState();
      expect(reopened).toEqual(commit ? newState : oldState);
    });
  }

  it("maps a real cross-process SQLite writer collision to PROJECT_LOCKED", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(resolve(harness.dataDir, "wal-busy"));
    const current = await store.initialize(createProjectState());
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      SQLITE_LOCK_SCRIPT,
      store.databasePath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await waitForLine(child.stdout, "LOCKED");
      await expect(store.writeState({
        ...current,
        stateVersion: current.stateVersion + 1,
        updatedAt: "2026-08-15T13:01:00.000Z"
      })).rejects.toMatchObject({ code: "PROJECT_LOCKED" } satisfies Partial<StateStoreError>);
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((settle) => child.once("exit", () => settle()));
    }
  });

  it("does not steal an expired lease from a live local owner", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(resolve(harness.dataDir, "expired-live-lease"));
    await store.initialize(createProjectState());
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      SQLITE_EXPIRED_LIVE_LEASE_SCRIPT,
      store.databasePath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let exited = false;
    try {
      await waitForLine(child.stdout, "LEASED");
      await expect(store.acquireMutationLease("contender", 75)).rejects.toMatchObject({
        code: "PROJECT_LOCKED"
      } satisfies Partial<StateStoreError>);

      child.kill("SIGKILL");
      await new Promise<void>((settle) => child.once("exit", () => settle()));
      exited = true;

      const recovered = await store.acquireMutationLease("after-owner-death", 1_000);
      await recovered.assertOwned();
      await recovered.release();
    } finally {
      if (!exited) {
        child.kill("SIGKILL");
        await new Promise<void>((settle) => child.once("exit", () => settle()));
      }
    }
  });

  it("reclaims an expired lease after its PID is reused", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(resolve(harness.dataDir, "reused-lease-pid"));
    await store.initialize(createProjectState());
    const database = new DatabaseSync(store.databasePath);
    try {
      database.prepare(`
        INSERT INTO mutation_lease (
          singleton,
          owner_token,
          owner_id,
          owner_pid,
          owner_hostname,
          owner_process_start_token,
          expires_at_ms
        ) VALUES (1, 'dead-reused-owner', 'dead-reused-owner', ?, ?, ?, ?)
      `).run(
        process.pid,
        hostname(),
        `${String(process.pid)}:different-process-instance`,
        Date.now() - 60_000
      );
    } finally {
      database.close();
    }

    const recovered = await store.acquireMutationLease("pid-reuse-recovery", 1_000);
    await recovered.assertOwned();
    await recovered.release();
  });

  it("replays a canonical receipt after waiting for a cross-process SQLite lease", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const store = new StateStore(resolve(harness.dataDir, "cross-process-receipt"));
    await store.initialize(createProjectState());
    const request = {
      requestId: "cross-process-winner",
      payload: { operation: "claim" }
    };
    const response = { accepted: true };
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      SQLITE_RECEIPT_WINNER_SCRIPT,
      store.databasePath,
      request.requestId,
      canonicalHash(request.payload),
      canonicalHash(response)
    ], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await waitForLine(child.stdout, "LEASED");
      let builds = 0;
      const mutation = new ProjectMutationExecutor(store).mutate(request, (state) => {
        builds += 1;
        return { nextState: state, response: { accepted: false } };
      });
      await new Promise<void>((settle) => setTimeout(settle, 50));
      expect(builds).toBe(0);
      const completed = waitForLine(child.stdout, "DONE");
      child.stdin.write("COMMIT\n");
      await completed;
      await expect(mutation).resolves.toMatchObject({
        replayed: true,
        response
      });
      expect(builds).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((settle) => child.once("exit", () => settle()));
    }
  });

});
