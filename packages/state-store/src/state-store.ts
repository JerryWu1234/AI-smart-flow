import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ArtifactRef } from "@smartflow/protocol";

import {
  atomicWriteFile,
  durableWriteArtifact,
  type AtomicWriteHooks
} from "./atomic-file.js";
import { bytesHash, canonicalJson } from "./canonical-json.js";
import { StateStoreError } from "./errors.js";
import { projectStateSchema, type ProjectState } from "./schema.js";

const DATABASE_SCHEMA_VERSION = 3;
const SQLITE_BUSY_TIMEOUT_MS = 500;
const MUTATION_LEASE_WAIT_MS = 5_000;
const MUTATION_LEASE_TTL_MS = 30_000;
const MUTATION_LEASE_RENEW_MS = 10_000;
const MUTATION_LEASE_POLL_MS = 25;
const LEGACY_STATE_TOMBSTONE_KIND = "smartflow.sqlite-state-retired";
const LEGACY_IMPORT_DIRECTORY = "legacy-imports";

const DATABASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS project_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  document_schema_version INTEGER NOT NULL,
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  project_fence INTEGER NOT NULL CHECK (project_fence >= 0),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('runtime', 'legacy')),
  source_path TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_imports (
  source_path TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('state', 'events')),
  source_sha256 TEXT NOT NULL,
  source_schema_version INTEGER,
  imported_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS mutation_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_token TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
  owner_hostname TEXT NOT NULL,
  owner_process_start_token TEXT,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0)
) STRICT;
`;

interface StateRow {
  document_schema_version: number;
  state_version: number;
  project_fence: number;
  state_json: string;
  updated_at: string;
}

interface ParsedStateDocument {
  state: ProjectState;
  sourceSchemaVersion: number;
}

interface LegacyStateSource extends ParsedStateDocument {
  sourceHash: string;
  kind: "state";
}

interface LegacyStateTombstone {
  kind: "tombstone";
  sourceHash: string;
  archive: string;
}

interface LegacyEventsSource {
  sourceHash: string;
  lines: string[];
}

interface DatabaseState {
  state: ProjectState;
  sourceSchemaVersion: number;
  legacyStateHash: string | undefined;
  legacyEventsHash: string | undefined;
}

interface MutationLeaseRow {
  owner_token: string;
  owner_id: string;
  owner_pid: number;
  owner_hostname: string;
  owner_process_start_token: string | null;
  expires_at_ms: number;
}

export interface StateMutationLease {
  readonly ownerId: string;
  assertOwned(): Promise<void>;
  writeState(nextState: ProjectState, hooks?: AtomicWriteHooks): Promise<ProjectState>;
  release(): Promise<void>;
}

function ensureDatabaseSchema(database: DatabaseSync): void {
  database.exec(DATABASE_SCHEMA);
  const leaseColumns = database.prepare("PRAGMA table_info(mutation_lease)").all() as Array<{
    name?: unknown;
  }>;
  if (!leaseColumns.some((column) => column.name === "owner_process_start_token")) {
    database.exec("ALTER TABLE mutation_lease ADD COLUMN owner_process_start_token TEXT");
  }
}

function sqliteError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("ERR_SQLITE");
}

function mapSqliteError(error: unknown, databasePath: string): never {
  if (error instanceof StateStoreError) throw error;
  if (!sqliteError(error)) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:busy|locked)\b/iu.test(message)) {
    throw new StateStoreError(
      "PROJECT_LOCKED",
      `SQLite state database is busy: ${databasePath}`
    );
  }
  throw new StateStoreError(
    "STATE_INVALID",
    `SQLite state database is invalid: ${message}`
  );
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new StateStoreError(
      "STATE_INVALID",
      `State document is invalid (${source}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseStateDocument(text: string, source: string): ParsedStateDocument {
  const value = parseJson(text, source);
  const sourceSchemaVersion = typeof value === "object" && value !== null &&
    "schemaVersion" in value
    ? (value as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (
    typeof sourceSchemaVersion === "number" &&
    !new Set([4, 5]).has(sourceSchemaVersion)
  ) {
    throw new StateStoreError(
      "STATE_MIGRATION_UNSUPPORTED",
      `Unsupported SmartFlow project state schema version: ${String(sourceSchemaVersion)}`
    );
  }
  try {
    const state = projectStateSchema.parse(value);
    return {
      state,
      sourceSchemaVersion: typeof sourceSchemaVersion === "number"
        ? sourceSchemaVersion
        : state.schemaVersion
    };
  } catch (error) {
    if (error instanceof StateStoreError) throw error;
    throw new StateStoreError(
      "STATE_INVALID",
      `State document is invalid (${source}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function stateRow(database: DatabaseSync): StateRow | undefined {
  return database.prepare(`
    SELECT document_schema_version, state_version, project_fence, state_json, updated_at
    FROM project_state
    WHERE singleton = 1
  `).get() as StateRow | undefined;
}

function parseStateRow(row: StateRow, databasePath: string): ParsedStateDocument {
  if (
    typeof row.document_schema_version !== "number" ||
    typeof row.state_version !== "number" ||
    typeof row.project_fence !== "number" ||
    typeof row.state_json !== "string" ||
    typeof row.updated_at !== "string"
  ) {
    throw new StateStoreError("STATE_INVALID", `SQLite state row is malformed: ${databasePath}`);
  }
  const parsed = parseStateDocument(row.state_json, databasePath);
  if (
    parsed.sourceSchemaVersion !== row.document_schema_version ||
    parsed.state.stateVersion !== row.state_version ||
    parsed.state.projectFence !== row.project_fence ||
    parsed.state.updatedAt !== row.updated_at
  ) {
    throw new StateStoreError(
      "STATE_INVALID",
      `SQLite state metadata does not match its canonical document: ${databasePath}`
    );
  }
  return parsed;
}

function insertState(database: DatabaseSync, state: ProjectState): void {
  database.prepare(`
    INSERT INTO project_state (
      singleton,
      document_schema_version,
      state_version,
      project_fence,
      state_json,
      updated_at
    ) VALUES (1, ?, ?, ?, ?, ?)
  `).run(
    state.schemaVersion,
    state.stateVersion,
    state.projectFence,
    canonicalJson(state),
    state.updatedAt
  );
}

function updateState(
  database: DatabaseSync,
  state: ProjectState,
  expectedStateVersion: number
): void {
  const result = database.prepare(`
    UPDATE project_state
    SET document_schema_version = ?,
        state_version = ?,
        project_fence = ?,
        state_json = ?,
        updated_at = ?
    WHERE singleton = 1 AND state_version = ?
  `).run(
    state.schemaVersion,
    state.stateVersion,
    state.projectFence,
    canonicalJson(state),
    state.updatedAt,
    expectedStateVersion
  );
  if (Number(result.changes) !== 1) {
    throw new StateStoreError(
      "STATE_VERSION_MISMATCH",
      `Expected current stateVersion ${String(expectedStateVersion)}`
    );
  }
}

function beginImmediate(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch (error) {
    if (!/no transaction is active/iu.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
  }
}

function commit(database: DatabaseSync): void {
  database.exec("COMMIT");
}

async function chmodIfPresent(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function optionalFile(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new StateStoreError(
      "STATE_INVALID",
      `Unable to read legacy state source ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function legacyArchiveName(sourceName: string, sourceHash: string): string {
  return `${sourceName}.imported-${sourceHash}`;
}

function legacyArchiveRelativePath(sourceName: string, sourceHash: string): string {
  return `${LEGACY_IMPORT_DIRECTORY}/${legacyArchiveName(sourceName, sourceHash)}`;
}

function parseLegacyStateFile(
  bytes: Uint8Array,
  path: string
): LegacyStateSource | LegacyStateTombstone {
  const text = new TextDecoder().decode(bytes);
  const value = parseJson(text, path);
  if (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === LEGACY_STATE_TOMBSTONE_KIND
  ) {
    const candidate = value as {
      version?: unknown;
      database?: unknown;
      sourceSha256?: unknown;
      archive?: unknown;
    };
    const legacyArchive = typeof candidate.sourceSha256 === "string"
      ? legacyArchiveName("state.json", candidate.sourceSha256)
      : undefined;
    const protectedArchive = typeof candidate.sourceSha256 === "string"
      ? legacyArchiveRelativePath("state.json", candidate.sourceSha256)
      : undefined;
    if (
      candidate.version !== 1 ||
      candidate.database !== "state.sqlite" ||
      typeof candidate.sourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(candidate.sourceSha256) ||
      typeof candidate.archive !== "string" ||
      (candidate.archive !== legacyArchive && candidate.archive !== protectedArchive)
    ) {
      throw new StateStoreError("STATE_INVALID", `Legacy state tombstone is invalid: ${path}`);
    }
    return {
      kind: "tombstone",
      sourceHash: candidate.sourceSha256,
      archive: candidate.archive
    };
  }
  const parsed = parseStateDocument(text, path);
  return { ...parsed, kind: "state", sourceHash: bytesHash(bytes) };
}

async function readLegacyState(
  path: string
): Promise<LegacyStateSource | LegacyStateTombstone | undefined> {
  const bytes = await optionalFile(path);
  return bytes === undefined ? undefined : parseLegacyStateFile(bytes, path);
}

async function readLegacyEvents(path: string): Promise<LegacyEventsSource | undefined> {
  const bytes = await optionalFile(path);
  if (bytes === undefined) return undefined;
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return {
    sourceHash: bytesHash(bytes),
    lines: lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
  };
}

function recordLegacyImport(
  database: DatabaseSync,
  input: {
    sourcePath: string;
    sourceKind: "state" | "events";
    sourceHash: string;
    sourceSchemaVersion?: number;
    importedAt: string;
  }
): void {
  database.prepare(`
    INSERT OR IGNORE INTO legacy_imports (
      source_path,
      source_kind,
      source_sha256,
      source_schema_version,
      imported_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    input.sourcePath,
    input.sourceKind,
    input.sourceHash,
    input.sourceSchemaVersion ?? null,
    input.importedAt
  );
}

function importLegacyEvents(
  database: DatabaseSync,
  sourcePath: string,
  source: LegacyEventsSource | undefined,
  importedAt: string
): void {
  if (source === undefined) return;
  const existing = database.prepare(`
    SELECT source_sha256
    FROM legacy_imports
    WHERE source_path = ? AND source_kind = 'events'
  `).get(sourcePath) as { source_sha256?: unknown } | undefined;
  if (existing !== undefined) return;
  const insert = database.prepare(`
    INSERT INTO audit_events (event_json, created_at, source, source_path)
    VALUES (?, ?, 'legacy', ?)
  `);
  for (const line of source.lines) insert.run(line, importedAt, sourcePath);
  recordLegacyImport(database, {
    sourcePath,
    sourceKind: "events",
    sourceHash: source.sourceHash,
    importedAt
  });
}

function legacyImportHash(
  database: DatabaseSync,
  sourcePath: string,
  sourceKind: "state" | "events"
): string | undefined {
  const row = database.prepare(`
    SELECT source_sha256
    FROM legacy_imports
    WHERE source_path = ? AND source_kind = ?
  `).get(sourcePath, sourceKind) as { source_sha256?: unknown } | undefined;
  if (row === undefined) return undefined;
  if (typeof row.source_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.source_sha256)) {
    throw new StateStoreError(
      "STATE_INVALID",
      `Legacy import marker is malformed for ${sourcePath}`
    );
  }
  return row.source_sha256;
}

function mutationLeaseRow(database: DatabaseSync): MutationLeaseRow | undefined {
  const row = database.prepare(`
    SELECT owner_token,
           owner_id,
           owner_pid,
           owner_hostname,
           owner_process_start_token,
           expires_at_ms
    FROM mutation_lease
    WHERE singleton = 1
  `).get() as MutationLeaseRow | undefined;
  if (row === undefined) return undefined;
  if (
    typeof row.owner_token !== "string" ||
    typeof row.owner_id !== "string" ||
    typeof row.owner_pid !== "number" ||
    typeof row.owner_hostname !== "string" ||
    (row.owner_process_start_token !== null &&
      typeof row.owner_process_start_token !== "string") ||
    typeof row.expires_at_ms !== "number"
  ) {
    throw new StateStoreError("STATE_INVALID", "SQLite mutation lease is malformed");
  }
  return row;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function processStartToken(pid: number): string | undefined {
  if (process.platform === "win32") return undefined;
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    shell: false,
    timeout: 1_000
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  const startedAt = result.stdout.trim();
  return startedAt.length === 0 ? undefined : `${String(pid)}:${startedAt}`;
}

function currentProcessStartToken(): string {
  const token = processStartToken(process.pid);
  if (token === undefined) {
    throw new StateStoreError(
      "STATE_INVALID",
      `Unable to establish SQLite mutation owner process identity for pid ${String(process.pid)}`
    );
  }
  return token;
}

function removeStaleMutationLease(database: DatabaseSync, now: number): void {
  const lease = mutationLeaseRow(database);
  if (lease === undefined) return;
  if (lease.owner_hostname === hostname()) {
    if (processExists(lease.owner_pid)) {
      if (lease.expires_at_ms > now) return;
      const observedStartToken = processStartToken(lease.owner_pid);
      if (
        lease.owner_process_start_token !== null &&
        observedStartToken === lease.owner_process_start_token
      ) {
        // A suspended owner can miss renewals while still retaining the right to
        // cross the commit-to-effect handoff. Its process instance remains owner.
        return;
      }
      if (observedStartToken === undefined) {
        throw new StateStoreError(
          "PROJECT_LOCKED",
          `Unable to verify expired SQLite mutation owner pid ${String(lease.owner_pid)}`
        );
      }
      // A different start token proves that the recorded PID was reused. A null
      // token can only come from the pre-v3 lease schema and is reclaimable once
      // its old TTL has elapsed.
    }
  } else if (lease.expires_at_ms > now) {
    return;
  }
  database.prepare(`
    DELETE FROM mutation_lease
    WHERE singleton = 1 AND owner_token = ?
  `).run(lease.owner_token);
}

function databaseState(
  database: DatabaseSync,
  databasePath: string,
  legacyStatePath: string,
  eventsPath: string
): DatabaseState | undefined {
  const row = stateRow(database);
  if (row === undefined) return undefined;
  const parsed = parseStateRow(row, databasePath);
  return {
    state: parsed.state,
    sourceSchemaVersion: parsed.sourceSchemaVersion,
    legacyStateHash: legacyImportHash(database, legacyStatePath, "state"),
    legacyEventsHash: legacyImportHash(database, eventsPath, "events")
  };
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyLegacyArchive(
  archivePath: string,
  expectedHash: string
): Promise<void> {
  const archiveBytes = await optionalFile(archivePath);
  if (archiveBytes === undefined || bytesHash(archiveBytes) !== expectedHash) {
    throw new StateStoreError(
      "STATE_INVALID",
      `Legacy archive is missing or does not match its SQLite import marker: ${archivePath}`
    );
  }
}

async function ensureLegacyArchive(
  sourcePath: string,
  archivePath: string,
  expectedHash: string
): Promise<void> {
  const archiveDirectory = resolve(archivePath, "..");
  await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
  await chmod(archiveDirectory, 0o700);

  const archiveBytes = await optionalFile(archivePath);
  if (archiveBytes === undefined) {
    const sourceBytes = await optionalFile(sourcePath);
    if (sourceBytes !== undefined && bytesHash(sourceBytes) !== expectedHash) {
      throw new StateStoreError(
        "STATE_INVALID",
        `Legacy source changed after SQLite import: ${sourcePath}`
      );
    }
    if (sourceBytes !== undefined) {
      try {
        await rename(sourcePath, archivePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "EEXIST") throw error;
      }
    }
  }

  // A concurrent reconciler may have completed the rename after either read.
  // Verification turns ENOENT/EEXIST races into an idempotent success only when
  // the durable archive contains exactly the bytes recorded in SQLite.
  await verifyLegacyArchive(archivePath, expectedHash);
  await chmod(archivePath, 0o600);
  await Promise.all([...new Set([
    resolve(sourcePath, ".."),
    archiveDirectory
  ])].map((directory) => fsyncDirectory(directory)));
}

async function removeMatchingLegacySource(
  sourcePath: string,
  expectedHash: string
): Promise<void> {
  const sourceBytes = await optionalFile(sourcePath);
  if (sourceBytes === undefined || bytesHash(sourceBytes) !== expectedHash) return;
  try {
    await unlink(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fsyncDirectory(resolve(sourcePath, ".."));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}

class SqliteMutationLease implements StateMutationLease {
  public readonly ownerId: string;
  private readonly renewLease: () => Promise<void>;
  private readonly writeWithLease: (
    nextState: ProjectState,
    hooks: AtomicWriteHooks
  ) => Promise<ProjectState>;
  private readonly releaseLease: () => Promise<void>;
  private readonly renewalTimer: ReturnType<typeof setInterval>;
  private renewalFailure: unknown;
  private renewalInFlight: Promise<void> | undefined;
  private released = false;

  public constructor(
    ownerId: string,
    renewLease: () => Promise<void>,
    writeWithLease: (nextState: ProjectState, hooks: AtomicWriteHooks) => Promise<ProjectState>,
    releaseLease: () => Promise<void>
  ) {
    this.ownerId = ownerId;
    this.renewLease = renewLease;
    this.writeWithLease = writeWithLease;
    this.releaseLease = releaseLease;
    this.renewalTimer = setInterval(() => {
      void this.renew().catch(() => undefined);
    }, MUTATION_LEASE_RENEW_MS);
    if (typeof this.renewalTimer === "object") this.renewalTimer.unref();
  }

  public async assertOwned(): Promise<void> {
    this.assertUsable();
    await this.renew();
    this.assertUsable();
  }

  public async writeState(
    nextState: ProjectState,
    hooks: AtomicWriteHooks = {}
  ): Promise<ProjectState> {
    this.assertUsable();
    const committed = await this.writeWithLease(nextState, hooks);
    this.assertUsable();
    return committed;
  }

  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    clearInterval(this.renewalTimer);
    await this.renewalInFlight?.catch(() => undefined);
    await this.releaseLease();
  }

  private assertUsable(): void {
    if (this.released) {
      throw new StateStoreError("STALE_FENCE", "SQLite mutation lease is already released");
    }
    if (this.renewalFailure !== undefined) {
      throw this.renewalFailure instanceof Error
        ? this.renewalFailure
        : new Error("SQLite mutation lease renewal failed", { cause: this.renewalFailure });
    }
  }

  private renew(): Promise<void> {
    if (this.renewalInFlight !== undefined) return this.renewalInFlight;
    const renewal = this.renewLease().catch((error: unknown) => {
      this.renewalFailure = error;
      throw error;
    }).finally(() => {
      if (this.renewalInFlight === renewal) this.renewalInFlight = undefined;
    });
    this.renewalInFlight = renewal;
    return renewal;
  }
}

export class StateStore {
  public readonly dataDirectory: string;
  public readonly databasePath: string;
  /** Compatibility alias for the current authoritative state storage. */
  public readonly statePath: string;
  /** Legacy JSONL import source; audit events are now stored in SQLite. */
  public readonly eventsPath: string;
  public readonly protectedPaths: readonly string[];
  private readonly legacyStatePath: string;
  private readonly legacyImportDirectory: string;
  private readonly mutationLeaseContext = new AsyncLocalStorage<string>();
  private reconciledLegacyImports: string | undefined;

  public constructor(dataDirectory: string) {
    this.dataDirectory = resolve(dataDirectory);
    this.databasePath = resolve(this.dataDirectory, "state.sqlite");
    this.statePath = this.databasePath;
    this.legacyStatePath = resolve(this.dataDirectory, "state.json");
    this.eventsPath = resolve(this.dataDirectory, "events.jsonl");
    this.legacyImportDirectory = resolve(this.dataDirectory, LEGACY_IMPORT_DIRECTORY);
    this.protectedPaths = Object.freeze([
      this.databasePath,
      `${this.databasePath}-wal`,
      `${this.databasePath}-shm`,
      this.legacyStatePath,
      this.eventsPath,
      this.legacyImportDirectory
    ]);
  }

  public async initialize(initialState: ProjectState): Promise<ProjectState> {
    try {
      return await this.readState();
    } catch (error) {
      if (!(error instanceof StateStoreError) || error.code !== "STATE_NOT_FOUND") throw error;
    }
    const validated = projectStateSchema.parse(initialState);
    const legacyEvents = await readLegacyEvents(this.eventsPath);
    const snapshot = await this.withDatabase((database) => {
      beginImmediate(database);
      try {
        const existing = databaseState(
          database,
          this.databasePath,
          this.legacyStatePath,
          this.eventsPath
        );
        if (existing !== undefined) {
          commit(database);
          return existing;
        }
        insertState(database, validated);
        const importedAt = new Date().toISOString();
        importLegacyEvents(database, this.eventsPath, legacyEvents, importedAt);
        const inserted = databaseState(
          database,
          this.databasePath,
          this.legacyStatePath,
          this.eventsPath
        );
        if (inserted === undefined) {
          throw new StateStoreError("STATE_INVALID", "Initialized SQLite state row is missing");
        }
        commit(database);
        return inserted;
      } catch (error) {
        rollback(database);
        throw error;
      }
    });
    await this.reconcileLegacySources(snapshot);
    return snapshot.state;
  }

  public async migrateState(): Promise<ProjectState> {
    const state = await this.readState();
    return this.withDatabase((database) => {
      beginImmediate(database);
      try {
        const row = stateRow(database);
        if (row === undefined) {
          throw new StateStoreError("STATE_NOT_FOUND", `State does not exist: ${this.databasePath}`);
        }
        const parsed = parseStateRow(row, this.databasePath);
        if (parsed.sourceSchemaVersion !== state.schemaVersion) {
          updateState(database, state, state.stateVersion);
        }
        commit(database);
        return state;
      } catch (error) {
        rollback(database);
        throw error;
      }
    });
  }

  public async readState(): Promise<ProjectState> {
    const existing = await this.readDatabaseState();
    if (existing !== undefined) {
      await this.reconcileLegacySources(existing);
      return existing.state;
    }

    const [legacyState, legacyEvents] = await Promise.all([
      readLegacyState(this.legacyStatePath),
      readLegacyEvents(this.eventsPath)
    ]);
    if (legacyState?.kind === "tombstone") {
      throw new StateStoreError(
        "STATE_INVALID",
        `Legacy state is retired but SQLite state is missing: ${this.databasePath}`
      );
    }
    if (legacyState === undefined) {
      const raced = await this.readDatabaseState();
      if (raced !== undefined) {
        await this.reconcileLegacySources(raced);
        return raced.state;
      }
      throw new StateStoreError("STATE_NOT_FOUND", `State does not exist: ${this.databasePath}`);
    }
    const snapshot = await this.withDatabase((database) => {
      beginImmediate(database);
      try {
        const row = databaseState(
          database,
          this.databasePath,
          this.legacyStatePath,
          this.eventsPath
        );
        if (row !== undefined) {
          commit(database);
          return row;
        }
        insertState(database, legacyState.state);
        const importedAt = new Date().toISOString();
        recordLegacyImport(database, {
          sourcePath: this.legacyStatePath,
          sourceKind: "state",
          sourceHash: legacyState.sourceHash,
          sourceSchemaVersion: legacyState.sourceSchemaVersion,
          importedAt
        });
        importLegacyEvents(database, this.eventsPath, legacyEvents, importedAt);
        const inserted = databaseState(
          database,
          this.databasePath,
          this.legacyStatePath,
          this.eventsPath
        );
        if (inserted === undefined) {
          throw new StateStoreError("STATE_INVALID", "Imported SQLite state row is missing");
        }
        commit(database);
        return inserted;
      } catch (error) {
        rollback(database);
        throw error;
      }
    });
    await this.reconcileLegacySources(snapshot);
    return snapshot.state;
  }

  public async acquireMutationLease(
    ownerId: string,
    waitMs = MUTATION_LEASE_WAIT_MS
  ): Promise<StateMutationLease> {
    if (ownerId.length === 0 || !Number.isFinite(waitMs) || waitMs < 0) {
      throw new StateStoreError("STATE_INVALID", "SQLite mutation lease options are invalid");
    }
    const ownerToken = randomUUID();
    const ownerProcessStartToken = currentProcessStartToken();
    const deadline = Date.now() + waitMs;
    for (;;) {
      let acquired = false;
      try {
        acquired = await this.withDatabase((database) => {
          beginImmediate(database);
          try {
            const now = Date.now();
            removeStaleMutationLease(database, now);
            if (mutationLeaseRow(database) !== undefined) {
              commit(database);
              return false;
            }
            database.prepare(`
              INSERT INTO mutation_lease (
                singleton,
                owner_token,
                owner_id,
                owner_pid,
                owner_hostname,
                owner_process_start_token,
                expires_at_ms
              ) VALUES (1, ?, ?, ?, ?, ?, ?)
            `).run(
              ownerToken,
              ownerId,
              process.pid,
              hostname(),
              ownerProcessStartToken,
              now + MUTATION_LEASE_TTL_MS
            );
            commit(database);
            return true;
          } catch (error) {
            rollback(database);
            throw error;
          }
        });
      } catch (error) {
        if (!(error instanceof StateStoreError) || error.code !== "PROJECT_LOCKED") throw error;
      }
      if (acquired) {
        return new SqliteMutationLease(
          ownerId,
          () => this.renewMutationLease(ownerToken),
          (nextState, hooks) => this.mutationLeaseContext.run(
            ownerToken,
            () => this.writeState(nextState, hooks)
          ),
          () => this.releaseMutationLease(ownerToken)
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new StateStoreError(
          "PROJECT_LOCKED",
          `Project already has an active SQLite mutation lease: ${this.databasePath}`
        );
      }
      await delay(Math.min(MUTATION_LEASE_POLL_MS, remaining));
    }
  }

  public async writeState(
    nextState: ProjectState,
    hooks: AtomicWriteHooks = {}
  ): Promise<ProjectState> {
    return this.writeStateWithLease(
      nextState,
      hooks,
      this.mutationLeaseContext.getStore()
    );
  }

  public async writeArtifact(
    relativePath: string,
    data: Uint8Array,
    hooks: AtomicWriteHooks = {}
  ): Promise<ArtifactRef> {
    return durableWriteArtifact(
      this.dataDirectory,
      resolve(this.dataDirectory, relativePath),
      data,
      hooks
    );
  }

  public async readArtifact(ref: ArtifactRef): Promise<Uint8Array> {
    const path = resolve(this.dataDirectory, ref.relativePath);
    const rel = relative(this.dataDirectory, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new StateStoreError("STATE_INVALID", "Artifact path escapes the Data Directory");
    }
    const bytes = await readFile(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== ref.size || sha256 !== ref.sha256) {
      throw new StateStoreError("STATE_INVALID", `Artifact hash mismatch: ${ref.relativePath}`);
    }
    return bytes;
  }

  public async appendAuditEvent(event: unknown): Promise<void> {
    const eventJson = canonicalJson(event);
    await this.withDatabase((database) => {
      beginImmediate(database);
      try {
        database.prepare(`
          INSERT INTO audit_events (event_json, created_at, source, source_path)
          VALUES (?, ?, 'runtime', NULL)
        `).run(eventJson, new Date().toISOString());
        commit(database);
      } catch (error) {
        rollback(database);
        throw error;
      }
    });
  }

  private async readDatabaseState(): Promise<DatabaseState | undefined> {
    return this.withDatabase((database) => databaseState(
      database,
      this.databasePath,
      this.legacyStatePath,
      this.eventsPath
    ));
  }

  private async reconcileLegacySources(snapshot: DatabaseState): Promise<void> {
    const reconciliationKey = `${snapshot.legacyStateHash ?? "-"}:${snapshot.legacyEventsHash ?? "-"}`;
    if (this.reconciledLegacyImports === reconciliationKey) {
      const source = await readLegacyState(this.legacyStatePath);
      const stateRetirementIsCurrent = snapshot.legacyStateHash === undefined
        ? source === undefined
        : source?.kind === "tombstone" &&
          source.sourceHash === snapshot.legacyStateHash &&
          source.archive === legacyArchiveRelativePath("state.json", snapshot.legacyStateHash);
      if (stateRetirementIsCurrent) return;
      this.reconciledLegacyImports = undefined;
    }
    await this.reconcileLegacyState(snapshot.legacyStateHash);
    await this.reconcileLegacyEvents(snapshot.legacyEventsHash);
    this.reconciledLegacyImports = reconciliationKey;
  }

  private async ensureProtectedLegacyArchive(
    sourcePath: string,
    sourceName: string,
    importedHash: string
  ): Promise<void> {
    const archiveRelativePath = legacyArchiveRelativePath(sourceName, importedHash);
    const archivePath = resolve(this.dataDirectory, archiveRelativePath);
    const previousArchivePath = resolve(
      this.dataDirectory,
      legacyArchiveName(sourceName, importedHash)
    );
    const archive = await optionalFile(archivePath);
    if (archive === undefined) {
      const previousArchive = await optionalFile(previousArchivePath);
      if (previousArchive !== undefined && bytesHash(previousArchive) !== importedHash) {
        throw new StateStoreError(
          "STATE_INVALID",
          `Legacy archive does not match its SQLite import marker: ${previousArchivePath}`
        );
      }
      await ensureLegacyArchive(
        previousArchive === undefined ? sourcePath : previousArchivePath,
        archivePath,
        importedHash
      );
    } else if (bytesHash(archive) !== importedHash) {
      throw new StateStoreError(
        "STATE_INVALID",
        `Legacy archive does not match its SQLite import marker: ${archivePath}`
      );
    }

    // Builds created before protected archives were introduced used a sibling
    // *.imported-<hash> file. Move or remove that exact immutable duplicate.
    await removeMatchingLegacySource(previousArchivePath, importedHash);
  }

  private async reconcileLegacyState(importedHash: string | undefined): Promise<void> {
    const source = await readLegacyState(this.legacyStatePath);
    if (importedHash === undefined) {
      if (source !== undefined) {
        throw new StateStoreError(
          "STATE_INVALID",
          `Unregistered legacy state coexists with SQLite authority: ${this.legacyStatePath}`
        );
      }
      return;
    }
    const legacyArchive = legacyArchiveName("state.json", importedHash);
    const protectedArchive = legacyArchiveRelativePath("state.json", importedHash);
    if (source?.kind === "tombstone") {
      if (
        source.sourceHash !== importedHash ||
        (source.archive !== legacyArchive && source.archive !== protectedArchive)
      ) {
        throw new StateStoreError(
          "STATE_INVALID",
          `Legacy state tombstone does not match its SQLite import: ${this.legacyStatePath}`
        );
      }
      await this.ensureProtectedLegacyArchive(
        this.legacyStatePath,
        "state.json",
        importedHash
      );
      if (source.archive === protectedArchive) return;
    } else {
      if (source !== undefined && source.sourceHash !== importedHash) {
        throw new StateStoreError(
          "STATE_INVALID",
          `Legacy state changed after SQLite import: ${this.legacyStatePath}`
        );
      }
      await this.ensureProtectedLegacyArchive(
        this.legacyStatePath,
        "state.json",
        importedHash
      );
    }
    await atomicWriteFile(
      this.legacyStatePath,
      Buffer.from(canonicalJson({
        kind: LEGACY_STATE_TOMBSTONE_KIND,
        version: 1,
        database: "state.sqlite",
        sourceSha256: importedHash,
        archive: protectedArchive
      }), "utf8")
    );
  }

  private async reconcileLegacyEvents(importedHash: string | undefined): Promise<void> {
    // events.jsonl is only a one-time bootstrap source. Once SQLite exists, a
    // later or rewritten file is deliberately ignored and never becomes an
    // audit or recovery authority.
    if (importedHash === undefined) return;
    const source = await optionalFile(this.eventsPath);
    const sourceMatchesImport = source !== undefined && bytesHash(source) === importedHash;
    await this.ensureProtectedLegacyArchive(
      this.eventsPath,
      "events.jsonl",
      importedHash
    );
    if (sourceMatchesImport) {
      await removeMatchingLegacySource(this.eventsPath, importedHash);
    }
  }

  private async renewMutationLease(ownerToken: string): Promise<void> {
    await this.withDatabase((database) => {
      beginImmediate(database);
      try {
        const now = Date.now();
        removeStaleMutationLease(database, now);
        const lease = mutationLeaseRow(database);
        if (lease?.owner_token !== ownerToken) {
          throw new StateStoreError("STALE_FENCE", "SQLite mutation lease was preempted");
        }
        database.prepare(`
          UPDATE mutation_lease
          SET expires_at_ms = ?
          WHERE singleton = 1 AND owner_token = ?
        `).run(now + MUTATION_LEASE_TTL_MS, ownerToken);
        commit(database);
      } catch (error) {
        rollback(database);
        throw error;
      }
    });
  }

  private async releaseMutationLease(ownerToken: string): Promise<void> {
    await this.withDatabase((database) => {
      beginImmediate(database);
      try {
        database.prepare(`
          DELETE FROM mutation_lease
          WHERE singleton = 1 AND owner_token = ?
        `).run(ownerToken);
        commit(database);
      } catch (error) {
        rollback(database);
        throw error;
      }
    });
  }

  private async writeStateWithLease(
    nextState: ProjectState,
    hooks: AtomicWriteHooks,
    ownerToken: string | undefined
  ): Promise<ProjectState> {
    const validated = projectStateSchema.parse(nextState);

    await hooks.checkpoint?.("AFTER_TEMP_WRITE");
    await hooks.checkpoint?.("AFTER_FILE_FSYNC");

    const committed = await this.withDatabase((database) => {
      beginImmediate(database);
      try {
        const now = Date.now();
        removeStaleMutationLease(database, now);
        const activeLease = mutationLeaseRow(database);
        if (ownerToken === undefined && activeLease !== undefined) {
          throw new StateStoreError(
            "PROJECT_LOCKED",
            `Project has an active SQLite mutation lease: ${this.databasePath}`
          );
        }
        if (ownerToken !== undefined) {
          if (activeLease?.owner_token !== ownerToken) {
            throw new StateStoreError("STALE_FENCE", "SQLite mutation lease was preempted");
          }
          database.prepare(`
            UPDATE mutation_lease
            SET expires_at_ms = ?
            WHERE singleton = 1 AND owner_token = ?
          `).run(now + MUTATION_LEASE_TTL_MS, ownerToken);
        }
        const row = stateRow(database);
        if (row === undefined) {
          insertState(database, validated);
        } else {
          const current = parseStateRow(row, this.databasePath).state;
          if (validated.stateVersion !== current.stateVersion + 1) {
            throw new StateStoreError(
              "STATE_VERSION_MISMATCH",
              `Expected next stateVersion ${String(current.stateVersion + 1)}, received ${String(validated.stateVersion)}`
            );
          }
          updateState(database, validated, current.stateVersion);
        }
        commit(database);
        const observed = stateRow(database);
        if (observed === undefined) {
          throw new StateStoreError("STATE_INVALID", "Committed SQLite state row is missing");
        }
        return parseStateRow(observed, this.databasePath).state;
      } catch (error) {
        rollback(database);
        throw error;
      }
    });

    await hooks.checkpoint?.("AFTER_RENAME");
    await hooks.checkpoint?.("AFTER_DIRECTORY_FSYNC");
    return committed;
  }

  private async withDatabase<T>(operation: (database: DatabaseSync) => T): Promise<T> {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const handle = await open(this.databasePath, "a", 0o600);
    await handle.close();
    await chmod(this.databasePath, 0o600);

    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.databasePath);
      database.exec(`
        PRAGMA busy_timeout = ${String(SQLITE_BUSY_TIMEOUT_MS)};
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
      `);
      const versionRow = database.prepare("PRAGMA user_version").get() as {
        user_version?: unknown;
      } | undefined;
      const version = versionRow?.user_version;
      if (typeof version !== "number" || version > DATABASE_SCHEMA_VERSION) {
        throw new StateStoreError(
          "STATE_MIGRATION_UNSUPPORTED",
          `Unsupported SQLite state schema version: ${String(version)}`
        );
      }
      ensureDatabaseSchema(database);
      if (version < DATABASE_SCHEMA_VERSION) {
        database.exec(`PRAGMA user_version = ${String(DATABASE_SCHEMA_VERSION)}`);
      }
      return operation(database);
    } catch (error) {
      return mapSqliteError(error, this.databasePath);
    } finally {
      if (database?.isOpen === true) database.close();
      await Promise.all([
        chmodIfPresent(this.databasePath),
        chmodIfPresent(`${this.databasePath}-wal`),
        chmodIfPresent(`${this.databasePath}-shm`)
      ]);
    }
  }
}
