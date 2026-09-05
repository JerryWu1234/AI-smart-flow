import {
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
  expectedJobId?: string;
  expectedGeneration?: number;
  expectedAttemptId?: string | null;
  expectedPhases?: readonly RunPhase[];
  advanceFence?: boolean;
}

export interface ProjectMutationContext {
  fence: number;
  nextStateVersion: number;
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

function canonicalReplay<T>(
  state: ProjectState,
  requestId: string,
  requestHash: string
): ProjectMutationResult<T> | undefined {
  const existing = state.processedRequests[requestId];
  if (existing === undefined) return undefined;
  if (existing.requestHash !== requestHash) {
    throw new StateStoreError(
      "IDEMPOTENCY_KEY_REUSED",
      `requestId ${requestId} was reused with a different payload`
    );
  }
  return { response: existing.response as T, state, replayed: true };
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
      const lease = await this.store.acquireMutationLease();
      try {
        const state = await this.store.readState();
        const requestHash = canonicalHash(request.payload);
        const existingReplay = canonicalReplay<T>(state, request.requestId, requestHash);
        if (existingReplay !== undefined && request.replayPolicy !== "CURRENT_EPOCH") {
          return prepareEffect === undefined
            ? existingReplay
            : { ...existingReplay, effectStarted: false, effect: undefined };
        }
        const existing = state.processedRequests[request.requestId];
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
        if (existingReplay !== undefined) {
          return prepareEffect === undefined
            ? existingReplay
            : { ...existingReplay, effectStarted: false, effect: undefined };
        }

        const nextStateVersion = state.stateVersion + 1;
        const nextProjectFence = state.projectFence + 1;
        const fence = request.advanceFence === true
          ? nextProjectFence
          : (run?.fence ?? nextProjectFence);
        const draft = await build(state, { fence, nextStateVersion });
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
        let committed: ProjectState;
        try {
          committed = await lease.writeState(projectStateSchema.parse({
            ...nextState,
            projectFence: nextProjectFence,
            stateVersion: nextStateVersion,
            processedRequests: {
              ...state.processedRequests,
              [request.requestId]: {
                requestHash,
                response: draft.response
              }
            },
            updatedAt: new Date().toISOString()
          }));
        } catch (error) {
          if (
            error instanceof StateStoreError &&
            error.code === "STATE_VERSION_MISMATCH" &&
            request.replayPolicy !== "CURRENT_EPOCH"
          ) {
            const latest = await this.store.readState();
            const replay = canonicalReplay<T>(latest, request.requestId, requestHash);
            if (replay !== undefined) {
              return prepareEffect === undefined
                ? replay
                : { ...replay, effectStarted: false, effect: undefined };
            }
          }
          throw error;
        }
        const result = { response: draft.response, state: committed, replayed: false };
        if (prepareEffect === undefined) return result;
        const startEffect = await prepareEffect(committed, draft.response);
        await lease.assertOwned();
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
        await lease.release();
      }
    });
  }
}
