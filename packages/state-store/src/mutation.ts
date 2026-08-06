import { canonicalValueSchema, type IdempotentReceipt } from "@smartflow/protocol";

import { canonicalHash } from "./canonical-json.js";
import { StateStoreError } from "./errors.js";
import { ProjectLock } from "./project-lock.js";
import { projectStateSchema, type ProjectState } from "./schema.js";
import { StateStore } from "./state-store.js";

export interface MutationRequest {
  requestId: string;
  payload: unknown;
  expectedStateVersion?: number;
  expectedJobId?: string;
  expectedRevision?: number;
}

export interface MutationContext {
  fence: number;
  nextStateVersion: number;
}

export interface MutationDraft {
  nextState: ProjectState;
  response: unknown;
}

export interface MutationResult {
  response: unknown;
  state: ProjectState;
  replayed: boolean;
}

export class ProjectMutationSession {
  public readonly fence: number;
  private readonly store: StateStore;
  private readonly lock: ProjectLock;
  private closed = false;

  private constructor(store: StateStore, lock: ProjectLock) {
    this.store = store;
    this.lock = lock;
    this.fence = lock.fence;
  }

  public static async open(store: StateStore, ownerId: string): Promise<ProjectMutationSession> {
    const current = await store.readState();
    const lock = await ProjectLock.acquire(store.lockPath, ownerId, current.projectFence);
    try {
      const latest = await store.readState();
      if (latest.projectFence !== current.projectFence) {
        throw new StateStoreError("STALE_FENCE", "State fence changed while acquiring project lock");
      }
      await store.writeState({
        ...latest,
        projectFence: lock.fence,
        stateVersion: latest.stateVersion + 1,
        updatedAt: new Date().toISOString()
      });
      return new ProjectMutationSession(store, lock);
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  public async mutate(
    request: MutationRequest,
    build: (state: ProjectState, context: MutationContext) => MutationDraft | Promise<MutationDraft>
  ): Promise<MutationResult> {
    if (this.closed) throw new StateStoreError("STALE_FENCE", "Mutation session is closed");
    const current = await this.store.readState();
    if (current.projectFence !== this.fence) {
      throw new StateStoreError("STALE_FENCE", "Mutation session no longer owns the active fence");
    }
    const requestHash = canonicalHash(request.payload);
    const existing = current.processedRequests[request.requestId];
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new StateStoreError(
          "IDEMPOTENCY_KEY_REUSED",
          `requestId ${request.requestId} was reused with a different payload`
        );
      }
      return { response: existing.response, state: current, replayed: true };
    }
    if (
      request.expectedStateVersion !== undefined &&
      request.expectedStateVersion !== current.stateVersion
    ) {
      throw new StateStoreError(
        "STATE_VERSION_MISMATCH",
        `Expected stateVersion ${String(request.expectedStateVersion)}, observed ${String(current.stateVersion)}`
      );
    }
    if (request.expectedRevision !== undefined) {
      const run = request.expectedJobId === undefined ? undefined : current.runs[request.expectedJobId];
      if (run?.revision !== request.expectedRevision) {
        throw new StateStoreError(
          "REVISION_MISMATCH",
          `Expected revision ${String(request.expectedRevision)}, observed ${String(run?.revision)}`
        );
      }
    }
    const nextStateVersion = current.stateVersion + 1;
    const draft = await build(current, { fence: this.fence, nextStateVersion });
    const response = canonicalValueSchema.parse(draft.response);
    const receipt: IdempotentReceipt = {
      requestId: request.requestId,
      requestHash,
      response,
      responseHash: canonicalHash(response),
      committedAtStateVersion: nextStateVersion
    };
    const next = projectStateSchema.parse({
      ...draft.nextState,
      projectId: current.projectId,
      canonicalProjectRoot: current.canonicalProjectRoot,
      projectFence: this.fence,
      stateVersion: nextStateVersion,
      processedRequests: { ...current.processedRequests, [request.requestId]: receipt },
      updatedAt: new Date().toISOString()
    });
    const committed = await this.store.writeState(next);
    const committedReceipt = committed.processedRequests[request.requestId];
    if (committedReceipt === undefined) {
      throw new StateStoreError("STATE_INVALID", "Committed state is missing its mutation receipt");
    }
    return { response: committedReceipt.response, state: committed, replayed: false };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.lock.release();
  }
}
