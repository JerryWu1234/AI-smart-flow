import { randomUUID } from "node:crypto";

import {
  ProjectLock,
  StateStore,
  StateStoreError,
  canonicalHash,
  projectStateSchema,
  type ProjectState,
  type RunRecord
} from "@smartflow/state-store";
import type { RunPhase } from "@smartflow/protocol";

export interface ProjectMutationRequest {
  requestId: string;
  payload: unknown;
  replayPolicy?: "CANONICAL" | "CURRENT_EPOCH";
  expectedStateVersion?: number;
  expectedFence?: number;
  expectedRevision?: number;
  expectedJobId?: string;
  expectedGeneration?: number;
  expectedAttemptId?: string | null;
  expectedPhases?: readonly RunPhase[];
  advanceFence?: boolean;
}

export interface ProjectMutationContext {
  fence: number;
  nextStateVersion: number;
  run: RunRecord | undefined;
}

export interface ProjectMutationDraft<T> {
  nextState: ProjectState;
  response: T;
}

export interface ProjectMutationResult<T> {
  response: T;
  state: ProjectState;
  replayed: boolean;
}

export interface ProjectMutationEffectResult<T, TEffect> extends ProjectMutationResult<T> {
  effectStarted: boolean;
  effect: Promise<TEffect> | undefined;
}

const mutationQueues = new Map<string, Promise<void>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let settle!: () => void;
  const marker = new Promise<void>((resolveMarker) => { settle = resolveMarker; });
  const queued = previous.then(() => marker, () => marker);
  mutationQueues.set(key, queued);
  return previous.then(task, task).finally(() => {
    settle();
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  });
}

function activeRun(state: ProjectState, jobId: string | undefined): RunRecord | undefined {
  return jobId === undefined ? undefined : state.runs[jobId];
}

function currentAttempt(run: RunRecord | undefined): RunRecord["workerAttempts"][number] | undefined {
  return run?.workerAttempts.at(-1);
}

export class ProjectMutationExecutor {
  public constructor(private readonly store: StateStore) {}

  public mutate<T>(
    request: ProjectMutationRequest,
    build: (
      state: ProjectState,
      context: ProjectMutationContext
    ) => ProjectMutationDraft<T> | Promise<ProjectMutationDraft<T>>
  ): Promise<ProjectMutationResult<T>>;

  public mutate<T, TEffect>(
    request: ProjectMutationRequest,
    build: (
      state: ProjectState,
      context: ProjectMutationContext
    ) => ProjectMutationDraft<T> | Promise<ProjectMutationDraft<T>>,
    prepareEffect: (
      state: ProjectState,
      response: T
    ) => Promise<() => Promise<TEffect>>
  ): Promise<ProjectMutationEffectResult<T, TEffect>>;

  public mutate<T, TEffect>(
    request: ProjectMutationRequest,
    build: (
      state: ProjectState,
      context: ProjectMutationContext
    ) => ProjectMutationDraft<T> | Promise<ProjectMutationDraft<T>>,
    prepareEffect?: (
      state: ProjectState,
      response: T
    ) => Promise<() => Promise<TEffect>>
  ): Promise<ProjectMutationResult<T> | ProjectMutationEffectResult<T, TEffect>> {
    return enqueue(this.store.dataDirectory, async () => {
      const before = await this.store.readState();
      const lock = await ProjectLock.acquire(
        this.store.lockPath,
        `mutation-${randomUUID()}`,
        before.projectFence
      );
      try {
        const state = await this.store.readState();
        if (state.projectFence !== before.projectFence) {
          throw new StateStoreError("STALE_FENCE", "Project fence changed while acquiring mutation lock");
        }
        const requestHash = canonicalHash(request.payload);
        const existing = state.processedRequests[request.requestId];
        if (existing !== undefined) {
          if (existing.requestHash !== requestHash) {
            throw new StateStoreError(
              "IDEMPOTENCY_KEY_REUSED",
              `requestId ${request.requestId} was reused with a different payload`
            );
          }
          if (request.replayPolicy !== "CURRENT_EPOCH") {
            const replay = { response: existing.response as T, state, replayed: true };
            return prepareEffect === undefined
              ? replay
              : { ...replay, effectStarted: false, effect: undefined };
          }
        }
        if (
          existing === undefined &&
          request.expectedStateVersion !== undefined &&
          request.expectedStateVersion !== state.stateVersion
        ) {
          throw new StateStoreError(
            "STATE_VERSION_MISMATCH",
            `Expected ${String(request.expectedStateVersion)}, observed ${String(state.stateVersion)}`
          );
        }
        const run = activeRun(state, request.expectedJobId);
        if (request.expectedFence !== undefined && request.expectedFence !== run?.fence) {
          throw new StateStoreError(
            "STALE_FENCE",
            `Expected fence ${String(request.expectedFence)}, observed ${String(run?.fence)}`
          );
        }
        if (request.expectedJobId !== undefined && run === undefined) {
          throw new StateStoreError("STATE_INVALID", `Unknown run ${request.expectedJobId}`);
        }
        if (
          request.expectedJobId !== undefined &&
          run !== undefined &&
          state.activeRunsByTaskPath[run.canonicalTaskPath] !== request.expectedJobId
        ) {
          throw new StateStoreError(
            "STATE_INVALID",
            `Run ${request.expectedJobId} is no longer the active Project run`
          );
        }
        if (request.expectedRevision !== undefined && run?.revision !== request.expectedRevision) {
          throw new StateStoreError(
            "REVISION_MISMATCH",
            `Expected Revision ${String(request.expectedRevision)}, observed ${String(run?.revision)}`
          );
        }
        if (
          request.expectedGeneration !== undefined &&
          currentAttempt(run)?.generation !== request.expectedGeneration
        ) {
          throw new StateStoreError(
            "STALE_FENCE",
            `Expected generation ${String(request.expectedGeneration)}, observed ${String(currentAttempt(run)?.generation)}`
          );
        }
        if (
          request.expectedAttemptId !== undefined &&
          (currentAttempt(run)?.attemptId ?? null) !== request.expectedAttemptId
        ) {
          throw new StateStoreError(
            "STALE_FENCE",
            `Expected attempt ${String(request.expectedAttemptId)}, observed ${String(currentAttempt(run)?.attemptId)}`
          );
        }
        if (
          request.expectedPhases !== undefined &&
          (run === undefined || !request.expectedPhases.includes(run.phase))
        ) {
          throw new StateStoreError(
            "STATE_INVALID",
            `Expected phase ${request.expectedPhases.join("|")}, observed ${String(run?.phase)}`
          );
        }
        if (existing !== undefined) {
          const replay = { response: existing.response as T, state, replayed: true };
          return prepareEffect === undefined
            ? replay
            : { ...replay, effectStarted: false, effect: undefined };
        }
        const nextStateVersion = state.stateVersion + 1;
        const fence = request.advanceFence === true ? lock.fence : (run?.fence ?? lock.fence);
        const draft = await build(state, { fence, nextStateVersion, run });
        const responseHash = canonicalHash(draft.response);
        let nextState = draft.nextState;
        if (request.advanceFence === true && request.expectedJobId !== undefined) {
          const nextRun = nextState.runs[request.expectedJobId];
          if (nextRun !== undefined) {
            nextState = {
              ...nextState,
              runs: {
                ...nextState.runs,
                [request.expectedJobId]: { ...nextRun, fence }
              }
            };
          }
        }
        const committed = await this.store.writeState(projectStateSchema.parse({
          ...nextState,
          projectFence: lock.fence,
          stateVersion: nextStateVersion,
          processedRequests: {
            ...state.processedRequests,
            [request.requestId]: {
              requestId: request.requestId,
              requestHash,
              response: draft.response,
              responseHash,
              committedAtStateVersion: nextStateVersion
            }
          },
          updatedAt: new Date().toISOString()
        }));
        const result = { response: draft.response, state: committed, replayed: false };
        if (prepareEffect === undefined) return result;
        const startEffect = await prepareEffect(committed, draft.response);
        let effect: Promise<TEffect>;
        try {
          effect = startEffect();
        } catch (error) {
          effect = Promise.reject(
            error instanceof Error ? error : new Error(String(error))
          );
        }
        return { ...result, effectStarted: true, effect };
      } finally {
        await lock.release();
      }
    });
  }
}
