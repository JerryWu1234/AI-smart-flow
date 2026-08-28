import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ArtifactRef } from "@smartflow/protocol";

import {
  canonicalOperations,
  operationsHash,
  preflightOperations,
  type ApplyOperation,
  type PreflightConflict
} from "./preflight.js";
import { observedFile, sha256 as hash } from "./internal-utils.js";

interface ApplyPathResult {
  path: string;
  status: "COMMITTED" | "CONFLICT" | "UNRESOLVED";
  observedHash: string | null;
  observedMode: number | null;
}

export interface PublishResult {
  operationId: string;
  operationsHash: string;
  status: "COMMITTED" | "CONFLICT" | "PARTIAL" | "UNKNOWN";
  paths: ApplyPathResult[];
}

export interface WorkspaceApplyAdapter {
  probe(): Promise<WorkspaceApplyCapabilities>;
  apply(input: {
    operationId: string;
    operationsHash: string;
    operations: ApplyOperation[];
  }): Promise<PublishResult>;
  getResult(operationId: string): Promise<PublishResult | "PENDING" | "UNKNOWN">;
}

export interface WorkspaceApplyCapabilities {
  expectedOldHashCas: boolean;
  atomicBatchCas: boolean;
  preflightBatchWrite?: boolean;
  stableOperationId: boolean;
  queryResult: boolean;
  adapterId?: string;
  reason?: string;
}

interface PublishBlobReader {
  read(ref: ArtifactRef): Promise<Uint8Array>;
}

function bareHash(value: string): string {
  return value.replace(/^sha256:/u, "");
}

async function pathResult(operation: ApplyOperation): Promise<ApplyPathResult> {
  const observed = await observedFile(operation.path);
  if (operation.type === "DELETE" && observed === "ABSENT") {
    return { path: operation.path, status: "COMMITTED", observedHash: null, observedMode: null };
  }
  if (
    observed !== "ABSENT" &&
    observed !== "OTHER" &&
    observed.hash === operation.newHash &&
    observed.mode === operation.newMode
  ) {
    return {
      path: operation.path,
      status: "COMMITTED",
      observedHash: observed.hash,
      observedMode: observed.mode
    };
  }
  const unchanged = operation.expectedOldKind === "ABSENT"
    ? observed === "ABSENT"
    : observed !== "ABSENT" &&
      observed !== "OTHER" &&
      observed.hash === operation.expectedOldHash &&
      observed.mode === operation.expectedOldMode;
  return {
    path: operation.path,
    status: unchanged ? "UNRESOLVED" : "CONFLICT",
    observedHash: observed === "ABSENT" || observed === "OTHER" ? null : observed.hash,
    observedMode: observed === "ABSENT" || observed === "OTHER" ? null : observed.mode
  };
}

export class FilesystemWorkspaceApplyAdapter implements WorkspaceApplyAdapter {
  public constructor(
    private readonly activeWorkspace: string,
    private readonly blobs: PublishBlobReader,
    private readonly resultDirectory?: string
  ) {}

  public probe(): Promise<WorkspaceApplyCapabilities> {
    const queryable = this.resultDirectory !== undefined;
    return Promise.resolve({
      expectedOldHashCas: queryable,
      atomicBatchCas: false,
      preflightBatchWrite: queryable,
      stableOperationId: queryable,
      queryResult: queryable,
      adapterId: "filesystem-preflight-batch-v1",
      ...(queryable
        ? {}
        : { reason: "A durable result directory is required for filesystem publishing" })
    });
  }

  public async apply(input: {
    operationId: string;
    operationsHash: string;
    operations: ApplyOperation[];
  }): Promise<PublishResult> {
    if (this.resultDirectory === undefined) {
      throw new Error("PUBLISH_ATOMIC_CAS_UNAVAILABLE: durable result directory missing");
    }
    const operations = canonicalOperations(input.operations);
    if (operationsHash(operations) !== input.operationsHash) {
      throw new Error("PUBLISH_OPERATIONS_HASH_MISMATCH");
    }
    const existing = await this.readResult(input.operationId);
    if (existing !== undefined) {
      if (existing.operationsHash !== input.operationsHash) {
        throw new Error("PUBLISH_OPERATION_ID_REUSED");
      }
      return existing;
    }
    const root = resolve(this.activeWorkspace);
    const conflicts = await preflightOperations(root, operations);
    if (conflicts.length > 0) {
      const result = await this.conflictResult(input.operationId, input.operationsHash, operations, root, conflicts);
      await this.writeResult(result);
      return result;
    }

    const prepared = new Map<string, string>();
    try {
      for (const operation of operations) {
        if (operation.blobRef === null || operation.newHash === null || operation.newMode === null) continue;
        const bytes = await this.blobs.read(operation.blobRef);
        if (
          bytes.byteLength !== operation.blobRef.size ||
          hash(bytes) !== bareHash(operation.blobRef.sha256) ||
          hash(bytes) !== operation.newHash
        ) throw new Error(`PUBLISH_BLOB_INVALID: ${operation.path}`);
        const target = resolve(root, operation.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const temporary = resolve(
          dirname(target),
          `.smartflow-${input.operationId.slice(-12)}-${randomUUID()}.tmp`
        );
        await writeFile(temporary, bytes, { flag: "wx", mode: operation.newMode });
        await chmod(temporary, operation.newMode);
        prepared.set(operation.path, temporary);
      }

      const finalConflicts = await preflightOperations(root, operations);
      if (finalConflicts.length > 0) {
        await this.removePrepared(prepared);
        const result = await this.conflictResult(
          input.operationId,
          input.operationsHash,
          operations,
          root,
          finalConflicts
        );
        await this.writeResult(result);
        return result;
      }

      for (const operation of operations) {
        const staged = prepared.get(operation.path);
        if (operation.type === "DELETE") {
          await unlink(resolve(root, operation.path));
        } else if (staged !== undefined) {
          await rename(staged, resolve(root, operation.path));
          prepared.delete(operation.path);
        }
      }
    } catch {
      await this.removePrepared(prepared);
      const result = await this.observe(input.operationId, input.operationsHash, operations);
      await this.writeResult(result);
      return result;
    }

    const result = await this.observe(input.operationId, input.operationsHash, operations);
    await this.writeResult(result);
    return result;
  }

  public async getResult(operationId: string): Promise<PublishResult | "PENDING" | "UNKNOWN"> {
    return await this.readResult(operationId) ?? "UNKNOWN";
  }

  private async conflictResult(
    operationId: string,
    operationHash: string,
    operations: ApplyOperation[],
    root: string,
    conflicts: PreflightConflict[]
  ): Promise<PublishResult> {
    const conflictPaths = new Set(conflicts.map((conflict) => conflict.path));
    const paths = await Promise.all(operations.map(async (operation) => {
      const result = await pathResult({ ...operation, path: resolve(root, operation.path) });
      return {
        ...result,
        path: operation.path,
        status: conflictPaths.has(operation.path) ? "CONFLICT" as const : "UNRESOLVED" as const
      };
    }));
    return {
      operationId,
      operationsHash: operationHash,
      status: "CONFLICT",
      paths
    };
  }

  private async observe(
    operationId: string,
    operationHash: string,
    operations: ApplyOperation[]
  ): Promise<PublishResult> {
    const root = resolve(this.activeWorkspace);
    const paths = await Promise.all(operations.map(async (operation) => {
      const result = await pathResult({ ...operation, path: resolve(root, operation.path) });
      return { ...result, path: operation.path };
    }));
    const committed = paths.filter((path) => path.status === "COMMITTED").length;
    const conflicts = paths.some((path) => path.status === "CONFLICT");
    return {
      operationId,
      operationsHash: operationHash,
      status: committed === paths.length
        ? "COMMITTED"
        : committed > 0
          ? "PARTIAL"
          : conflicts
            ? "CONFLICT"
            : "UNKNOWN",
      paths
    };
  }

  private async readResult(operationId: string): Promise<PublishResult | undefined> {
    if (this.resultDirectory === undefined) return undefined;
    try {
      return JSON.parse(await readFile(this.recordPath(operationId), "utf8")) as PublishResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeResult(result: PublishResult): Promise<void> {
    if (this.resultDirectory === undefined) {
      throw new Error("PUBLISH_RESULT_DIRECTORY_MISSING");
    }
    await mkdir(this.resultDirectory, { recursive: true, mode: 0o700 });
    const target = this.recordPath(result.operationId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(result), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  }

  private recordPath(operationId: string): string {
    if (this.resultDirectory === undefined || !/^publish-[a-f0-9]{64}$/u.test(operationId)) {
      throw new Error("PUBLISH_OPERATION_ID_INVALID");
    }
    return resolve(this.resultDirectory, `${operationId}.json`);
  }

  private async removePrepared(
    prepared: Map<string, string>
  ): Promise<void> {
    await Promise.all([...prepared.values()].map((temporary) => rm(temporary, { force: true })));
    prepared.clear();
  }
}
