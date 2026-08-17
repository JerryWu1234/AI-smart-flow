import type { ApplyOperation, PreflightConflict } from "./preflight.js";
import { operationsHash, preflightOperations, stableOperationId } from "./preflight.js";
import type { PublishResult, WorkspaceApplyAdapter } from "./workspace-apply-adapter.js";

export interface PublishAttemptRecord {
  operationId: string;
  operationsHash: string;
  adapterId: string;
  revision: number;
  status: "PREPARED" | "SUBMITTED" | "COMMITTED" | "CONFLICT" | "UNKNOWN";
  result?: PublishResult;
}

export interface PublishAttemptStore {
  acquireLease?(operationId: string): Promise<boolean>;
  releaseLease?(operationId: string): Promise<void>;
  get(operationId: string): Promise<PublishAttemptRecord | undefined>;
  prepare(attempt: PublishAttemptRecord): Promise<void>;
  beginRecovery(attempt: PublishAttemptRecord): Promise<void>;
  markSubmitted(operationId: string): Promise<void>;
  markSubmittedAndApply?(
    operationId: string,
    apply: () => Promise<PublishResult>
  ): Promise<PublishResult>;
  complete(operationId: string, status: PublishAttemptRecord["status"], result: PublishResult): Promise<void>;
}

export type PublishServiceResult =
  | { status: "COMMITTED"; operationId: string; result: PublishResult }
  | {
      status: "PRECHECK_CONFLICT";
      conflicts: PreflightConflict[];
      publishedCount: 0;
      totalCount: number;
      activeWorkspaceChanged: false;
    }
  | { status: "PUBLISH_BUSY" }
  | { status: "PUBLISH_RECOVERY_BLOCKED"; operationId: string; result?: PublishResult }
  | {
      status: "MANUAL_PUBLISH_REQUIRED";
      reason:
        | "PUBLISH_ADAPTER_UNAVAILABLE"
        | "PUBLISH_ATOMIC_CAS_UNAVAILABLE"
        | "PUBLISH_TARGET_MISMATCH";
      conflicts?: PreflightConflict[];
    };

export interface PublishBindings {
  projectId: string;
  jobId: string;
  revision: number;
  candidateHash: string;
  reviewHash: string;
}

function reconcile(
  operationId: string,
  expectedOperationsHash: string,
  operations: ApplyOperation[],
  result: PublishResult
): "COMMITTED" | "CONFLICT" | "BLOCKED" {
  if (result.operationId !== operationId || result.operationsHash !== expectedOperationsHash) return "BLOCKED";
  const expected = new Map(operations.map((operation) => [operation.path, operation]));
  if (result.paths.length !== operations.length) return "BLOCKED";
  const observedPaths = new Set<string>();
  for (const path of result.paths) {
    const operation = expected.get(path.path);
    if (operation === undefined || observedPaths.has(path.path) || path.status !== "COMMITTED") {
      return result.status === "CONFLICT" ? "CONFLICT" : "BLOCKED";
    }
    observedPaths.add(path.path);
    if (path.observedHash !== operation.newHash || path.observedMode !== operation.newMode) return "BLOCKED";
  }
  return observedPaths.size === expected.size && result.status === "COMMITTED"
    ? "COMMITTED"
    : "BLOCKED";
}

export class PublishService {
  public constructor(private readonly store: PublishAttemptStore) {}

  public async publish(
    activeWorkspace: string,
    bindings: PublishBindings,
    operations: ApplyOperation[],
    adapter: WorkspaceApplyAdapter | undefined,
    afterAdapterApply?: (result: PublishResult) => Promise<void>,
    beforeAdapterApply?: () => Promise<void>
  ): Promise<PublishServiceResult> {
    const hash = operationsHash(operations);
    const operationId = stableOperationId({ ...bindings, operationsHash: hash });
    if (adapter === undefined) return { status: "MANUAL_PUBLISH_REQUIRED", reason: "PUBLISH_ADAPTER_UNAVAILABLE" };
    const capabilities = await adapter.probe();
    const supportedBatch = capabilities.atomicBatchCas || capabilities.preflightBatchWrite === true;
    if (
      !capabilities.expectedOldHashCas ||
      !supportedBatch ||
      !capabilities.stableOperationId ||
      !capabilities.queryResult ||
      typeof capabilities.adapterId !== "string" ||
      capabilities.adapterId.trim().length === 0
    ) {
      return { status: "MANUAL_PUBLISH_REQUIRED", reason: "PUBLISH_ATOMIC_CAS_UNAVAILABLE" };
    }
    if (this.store.acquireLease !== undefined && !(await this.store.acquireLease(operationId))) {
      return { status: "PUBLISH_BUSY" };
    }
    const conflicts = await preflightOperations(activeWorkspace, operations);
    if (conflicts.length > 0) {
      await this.store.releaseLease?.(operationId);
      return {
        status: "PRECHECK_CONFLICT",
        conflicts,
        publishedCount: 0,
        totalCount: operations.length,
        activeWorkspaceChanged: false
      };
    }
    const existing = await this.store.get(operationId);
    if (existing !== undefined) {
      if (existing.operationsHash !== hash || existing.adapterId !== capabilities.adapterId) {
        return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
      }
      if (existing.status === "COMMITTED" && existing.result !== undefined) {
        return reconcile(operationId, hash, operations, existing.result) === "COMMITTED"
          ? { status: "COMMITTED", operationId, result: existing.result }
          : { status: "PUBLISH_RECOVERY_BLOCKED", operationId, result: existing.result };
      }
      await this.store.beginRecovery(existing);
      if (existing.status !== "PREPARED") {
        return this.recover(operationId, operations, adapter);
      }
    } else {
      await this.store.prepare({
        operationId,
        operationsHash: hash,
        adapterId: capabilities.adapterId,
        revision: bindings.revision,
        status: "PREPARED"
      });
    }
    await beforeAdapterApply?.();
    let result: PublishResult;
    if (this.store.markSubmittedAndApply === undefined) {
      await this.store.markSubmitted(operationId);
      try {
        result = await adapter.apply({ operationId, operationsHash: hash, operations });
      } catch {
        return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
      }
    } else {
      try {
        result = await this.store.markSubmittedAndApply(
          operationId,
          () => adapter.apply({ operationId, operationsHash: hash, operations })
        );
      } catch {
        return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
      }
    }
    await afterAdapterApply?.(result);
    return this.finish(operationId, hash, operations, result);
  }

  public static async observeRecovery(
    attempt: Pick<PublishAttemptRecord, "operationId" | "operationsHash" | "adapterId">,
    operations: ApplyOperation[],
    adapter: WorkspaceApplyAdapter
  ): Promise<PublishServiceResult> {
    const operationId = attempt.operationId;
    const hash = operationsHash(operations);
    if (attempt.operationsHash !== hash) {
      throw new Error("PUBLISH_ATTEMPT_NOT_FOUND_OR_MISMATCH");
    }
    const capabilities = await adapter.probe();
    const supportedBatch = capabilities.atomicBatchCas || capabilities.preflightBatchWrite === true;
    if (
      !capabilities.expectedOldHashCas ||
      !supportedBatch ||
      !capabilities.stableOperationId ||
      !capabilities.queryResult ||
      capabilities.adapterId !== attempt.adapterId
    ) {
      return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
    }
    const observed = await adapter.getResult(operationId);
    if (observed === "PENDING" || observed === "UNKNOWN") {
      return { status: "PUBLISH_RECOVERY_BLOCKED", operationId };
    }
    return reconcile(operationId, hash, operations, observed) === "COMMITTED"
      ? { status: "COMMITTED", operationId, result: observed }
      : { status: "PUBLISH_RECOVERY_BLOCKED", operationId, result: observed };
  }

  public async recover(
    operationId: string,
    operations: ApplyOperation[],
    adapter: WorkspaceApplyAdapter
  ): Promise<PublishServiceResult> {
    const attempt = await this.store.get(operationId);
    if (attempt === undefined) throw new Error("PUBLISH_ATTEMPT_NOT_FOUND_OR_MISMATCH");
    const observed = await PublishService.observeRecovery(attempt, operations, adapter);
    if (observed.status === "COMMITTED") {
      await this.store.complete(operationId, "COMMITTED", observed.result);
      return observed;
    }
    if (observed.status === "PUBLISH_RECOVERY_BLOCKED" && observed.result !== undefined) {
      const status = reconcile(operationId, attempt.operationsHash, operations, observed.result) === "CONFLICT"
        ? "CONFLICT"
        : "UNKNOWN";
      await this.store.complete(operationId, status, observed.result);
    }
    return observed;
  }

  private async finish(
    operationId: string,
    hash: string,
    operations: ApplyOperation[],
    result: PublishResult
  ): Promise<PublishServiceResult> {
    const reconciled = reconcile(operationId, hash, operations, result);
    if (reconciled === "COMMITTED") {
      await this.store.complete(operationId, "COMMITTED", result);
      return { status: "COMMITTED", operationId, result };
    }
    if (reconciled === "CONFLICT") {
      await this.store.complete(operationId, "CONFLICT", result);
    } else {
      await this.store.complete(operationId, "UNKNOWN", result);
    }
    return { status: "PUBLISH_RECOVERY_BLOCKED", operationId, result };
  }
}
