import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ArtifactRef } from "@smartflow/protocol";

import { atomicWriteFile, durableWriteArtifact, type AtomicWriteHooks } from "./atomic-file.js";
import { canonicalJson } from "./canonical-json.js";
import { StateStoreError } from "./errors.js";
import { projectStateSchema, type ProjectState } from "./schema.js";

const stateWriteQueues = new Map<string, Promise<void>>();

function enqueueStateWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = stateWriteQueues.get(path) ?? Promise.resolve();
  const result = previous.then(task, task);
  const marker = result.then(
    () => undefined,
    () => undefined
  );
  stateWriteQueues.set(path, marker);
  return result.finally(() => {
    if (stateWriteQueues.get(path) === marker) stateWriteQueues.delete(path);
  });
}

export class StateStore {
  public readonly dataDirectory: string;
  public readonly statePath: string;
  public readonly eventsPath: string;
  public readonly lockPath: string;

  public constructor(dataDirectory: string) {
    this.dataDirectory = resolve(dataDirectory);
    this.statePath = resolve(this.dataDirectory, "state.json");
    this.eventsPath = resolve(this.dataDirectory, "events.jsonl");
    this.lockPath = resolve(this.dataDirectory, "lock");
  }

  public async initialize(initialState: ProjectState): Promise<ProjectState> {
    return enqueueStateWrite(this.statePath, async () => {
      await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
      try {
        return await this.readState();
      } catch (error) {
        if (!(error instanceof StateStoreError) || error.code !== "STATE_NOT_FOUND") throw error;
      }
      const validated = projectStateSchema.parse(initialState);
      await atomicWriteFile(this.statePath, Buffer.from(canonicalJson(validated), "utf8"));
      return this.readState();
    });
  }

  public async migrateState(): Promise<ProjectState> {
    return enqueueStateWrite(this.statePath, async () => {
      let bytes: Uint8Array;
      try {
        bytes = await readFile(this.statePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new StateStoreError("STATE_NOT_FOUND", `State file does not exist: ${this.statePath}`);
        }
        throw error;
      }
      try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const originalVersion = typeof value === "object" && value !== null &&
          "schemaVersion" in value
          ? (value as { schemaVersion?: unknown }).schemaVersion
          : undefined;
        const migrated = projectStateSchema.parse(value);
        if (originalVersion !== migrated.schemaVersion) {
          await atomicWriteFile(
            this.statePath,
            Buffer.from(canonicalJson(migrated), "utf8")
          );
        }
        return migrated;
      } catch (error) {
        if (error instanceof StateStoreError) throw error;
        throw new StateStoreError(
          "STATE_INVALID",
          `State file is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  public async readState(): Promise<ProjectState> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StateStoreError("STATE_NOT_FOUND", `State file does not exist: ${this.statePath}`);
      }
      throw error;
    }
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (
        typeof value === "object" &&
        value !== null &&
        "schemaVersion" in value &&
        !new Set([4, 5]).has(
          (value as { schemaVersion?: unknown }).schemaVersion as number
        )
      ) {
        throw new StateStoreError(
          "STATE_MIGRATION_UNSUPPORTED",
          "Unsupported SmartFlow project state schema version"
        );
      }
      return projectStateSchema.parse(value);
    } catch (error) {
      if (error instanceof StateStoreError) throw error;
      throw new StateStoreError(
        "STATE_INVALID",
        `State file is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async writeState(
    nextState: ProjectState,
    hooks: AtomicWriteHooks = {}
  ): Promise<ProjectState> {
    return enqueueStateWrite(this.statePath, async () => {
      const validated = projectStateSchema.parse(nextState);
      let current: ProjectState | undefined;
      try {
        current = await this.readState();
      } catch (error) {
        if (!(error instanceof StateStoreError) || error.code !== "STATE_NOT_FOUND") throw error;
      }
      if (
        current !== undefined &&
        validated.stateVersion !== current.stateVersion + 1
      ) {
        throw new StateStoreError(
          "STATE_VERSION_MISMATCH",
          `Expected next stateVersion ${String(current.stateVersion + 1)}, received ${String(validated.stateVersion)}`
        );
      }
      await atomicWriteFile(
        this.statePath,
        Buffer.from(canonicalJson(validated), "utf8"),
        hooks
      );
      return this.readState();
    });
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
    await appendFile(this.eventsPath, `${canonicalJson(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
