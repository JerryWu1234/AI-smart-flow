import { canonicalValueSchema, type IdempotentReceipt } from "@smartflow/protocol";

import { canonicalHash } from "./canonical-json.js";
import { StateStoreError } from "./errors.js";
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

function replayReceipt(
  state: ProjectState,
  requestId: string,
  requestHash: string
): MutationResult | undefined {
  const existing = state.processedRequests[requestId];
  if (existing === undefined) return undefined;
  if (existing.requestHash !== requestHash) {
    throw new StateStoreError(
      "IDEMPOTENCY_KEY_REUSED",
      `requestId ${requestId} was reused with a different payload`
    );
  }
  return { response: existing.response, state, replayed: true };
}

/**
 * Compatibility API for callers that group mutations under one fence.
 * Opening a newer session atomically allocates a higher fence and preempts older sessions.
 */
export class ProjectMutationSession {
  public readonly fence: number;
  private readonly store: StateStore;
  private readonly ownerId: string;
  private closed = false;

  private constructor(store: StateStore, ownerId: string, fence: number) {
    this.store = store;
    this.ownerId = ownerId;
    this.fence = fence;
  }

  public static async open(store: StateStore, ownerId: string): Promise<ProjectMutationSession> {
    const lease = await store.acquireMutationLease(`session-open:${ownerId}`);
    try {
      const current = await store.readState();
      const fence = current.projectFence + 1;
      const committed = await lease.writeState({
        ...current,
        projectFence: fence,
        stateVersion: current.stateVersion + 1,
        updatedAt: new Date().toISOString()
      });
      return new ProjectMutationSession(store, ownerId, committed.projectFence);
    } finally {
      await lease.release();
    }
  }

  public async mutate(
    request: MutationRequest,
    build: (state: ProjectState, context: MutationContext) => MutationDraft | Promise<MutationDraft>
  ): Promise<MutationResult> {
    if (this.closed) throw new StateStoreError("STALE_FENCE", "Mutation session is closed");
    const requestHash = canonicalHash(request.payload);
    const lease = await this.store.acquireMutationLease(
      `session:${this.ownerId}:${request.requestId}`
    );
    try {
      const current = await this.store.readState();
      if (current.projectFence !== this.fence) {
        throw new StateStoreError("STALE_FENCE", "Mutation session no longer owns the active fence");
      }
      const replay = replayReceipt(current, request.requestId, requestHash);
      if (replay !== undefined) return replay;
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
        const run = request.expectedJobId === undefined
          ? undefined
          : current.runs[request.expectedJobId];
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
      try {
        const committed = await lease.writeState(next);
        const committedReceipt = committed.processedRequests[request.requestId];
        if (committedReceipt === undefined) {
          throw new StateStoreError("STATE_INVALID", "Committed state is missing its mutation receipt");
        }
        return { response: committedReceipt.response, state: committed, replayed: false };
      } catch (error) {
        if (error instanceof StateStoreError && error.code === "STATE_VERSION_MISMATCH") {
          const latest = await this.store.readState();
          const committedReplay = replayReceipt(latest, request.requestId, requestHash);
          if (committedReplay !== undefined) return committedReplay;
          if (latest.projectFence !== this.fence) {
            throw new StateStoreError("STALE_FENCE", "Mutation session was preempted by a newer fence");
          }
        }
        throw error;
      }
    } finally {
      await lease.release();
    }
  }

  public close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
