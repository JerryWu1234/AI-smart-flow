import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ProviderProbeResult,
  WorkerEvent,
  WorkerProvider,
  WorkerStartInput
} from "@smartflow/provider-core";
import { redactPiValue } from "@smartflow/provider-pi";
import { createReviewHostAction } from "@smartflow/review";
import {
  StateStore,
  StateStoreError,
  type ProjectState,
  type RunRecord
} from "@smartflow/state-store";
import { taskManifestSchema } from "@smartflow/task-manifest";
import {
  buildGitCandidate,
  captureGitSnapshot,
  ExecutionSandboxAdapter,
  initializeGitObjectStore,
  materializeGitSnapshot,
  probeGitRepository,
  type Candidate,
  type GitWorkspaceSnapshot
} from "@smartflow/workspace";

import { ProjectMutationExecutor } from "./project-mutation-executor.js";

export interface WorkerRunRequest {
  jobId: string;
  revision: number;
  prompt: string;
  providerRuntimeConfigHash: string;
  attemptDeadlineMs: number;
}

export interface WorkerRunResult {
  attemptId?: string;
  generation?: number;
  phase: RunRecord["phase"];
  candidate?: Candidate;
  code?: "WORKER_CANDIDATE_EMPTY";
  stale: boolean;
}

export interface WorkerRunnerHooks {
  beforeCandidateArtifact?(input: {
    jobId: string;
    revision: number;
    attemptId: string;
    generation: number;
    candidate: Candidate;
  }): void | Promise<void>;
}

const terminalEvents = new Set<WorkerEvent["type"]>([
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "TIMED_OUT",
  "CANCELED"
]);

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function isInside(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path.length === 0 || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function currentAttempt(run: RunRecord | undefined): RunRecord["workerAttempts"][number] | undefined {
  return run?.workerAttempts.at(-1);
}

function requiredValue<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}

function replaceAttempt(
  run: RunRecord,
  attemptId: string,
  update: (attempt: RunRecord["workerAttempts"][number]) => RunRecord["workerAttempts"][number]
): RunRecord["workerAttempts"] {
  const index = run.workerAttempts.findIndex((attempt) => attempt.attemptId === attemptId);
  if (index < 0) throw new Error("PI_ATTEMPT_MISSING");
  return run.workerAttempts.map((attempt, currentIndex) =>
    currentIndex === index ? update(attempt) : attempt
  );
}

function nextStateWithRun(
  state: ProjectState,
  jobId: string,
  update: (run: RunRecord) => RunRecord
): ProjectState {
  const run = state.runs[jobId];
  if (run === undefined) throw new Error(`Unknown worker run: ${jobId}`);
  const updatedAt = new Date().toISOString();
  return {
    ...state,
    stateVersion: state.stateVersion + 1,
    runs: { ...state.runs, [jobId]: { ...update(run), updatedAt } },
    updatedAt
  };
}

function requiredCapabilities(probe: Extract<ProviderProbeResult, { available: true }>): boolean {
  return probe.capabilities.officialCodingTools &&
    probe.capabilities.arbitraryShell &&
    probe.capabilities.networkAccess &&
    probe.capabilities.streaming &&
    probe.capabilities.cancellation &&
    probe.capabilities.sessionPersistence;
}

class WorkspacePreparationPaused extends Error {}

export class WorkerRunner {
  private readonly mutations: ProjectMutationExecutor;

  public constructor(
    private readonly store: StateStore,
    private readonly provider: WorkerProvider,
    private readonly hooks: WorkerRunnerHooks = {}
  ) {
    this.mutations = new ProjectMutationExecutor(store);
  }

  public async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    if (!Number.isInteger(request.attemptDeadlineMs) || request.attemptDeadlineMs <= 0) {
      throw new Error("PI_ATTEMPT_DEADLINE_INVALID");
    }
    const initial = await this.store.readState();
    const initialRun = initial.runs[request.jobId];
    if (
      initialRun === undefined ||
      initial.activeRunsByTaskPath[initialRun.canonicalTaskPath] !== request.jobId
    ) throw new Error(`Run is not active: ${request.jobId}`);
    if (initialRun.revision !== request.revision || initialRun.phase !== "PREPARING") {
      throw new Error("Worker run must start from its current PREPARING Revision");
    }
    const probe = await this.provider.probe();
    if (!probe.available || !requiredCapabilities(probe)) {
      const paused = await this.pause(
        request,
        initialRun.fence,
        initial.stateVersion,
        "PROVIDER_UNAVAILABLE",
        ["retry_provider_probe", "cancel"]
      );
      return { phase: paused ? "PAUSED" : (await this.currentRun(request.jobId)).phase, stale: !paused };
    }
    if (probe.providerRuntimeConfigHash !== request.providerRuntimeConfigHash) {
      const paused = await this.pause(
        request,
        initialRun.fence,
        initial.stateVersion,
        "PROVIDER_RUNTIME_CONFIG_DRIFT",
        ["approve_new_manifest_revision", "cancel"]
      );
      return { phase: paused ? "PAUSED" : (await this.currentRun(request.jobId)).phase, stale: !paused };
    }

    let prepared: Awaited<ReturnType<WorkerRunner["prepareWorkspace"]>>;
    try {
      prepared = await this.prepareWorkspace(initial, initialRun, request);
    } catch (error) {
      if (error instanceof WorkspacePreparationPaused) {
        return { phase: (await this.currentRun(request.jobId)).phase, stale: false };
      }
      if (
        error instanceof StateStoreError &&
        new Set(["STATE_VERSION_MISMATCH", "STALE_FENCE", "REVISION_MISMATCH", "STATE_INVALID"])
          .has(error.code)
      ) {
        return { phase: (await this.currentRun(request.jobId)).phase, stale: true };
      }
      throw error;
    }

    const generation = (currentAttempt(prepared.run)?.generation ?? -1) + 1;
    const attemptId = `attempt-${randomUUID()}`;
    const registryPath = resolve(
      this.store.dataDirectory,
      "runs",
      request.jobId,
      `revision-${String(request.revision)}`,
      "pi-containments.json"
    );
    await this.beginAttempt(request, attemptId, generation, prepared.run.fence);
    const runtimeRoot = resolve(prepared.workspaceRoot, ".smartflow-runtime");
    const providerInput: WorkerStartInput = {
      attemptId,
      jobId: request.jobId,
      revision: request.revision,
      generation,
      workspaceDir: prepared.workspaceRoot,
      prompt: request.prompt,
      providerRuntimeConfigHash: request.providerRuntimeConfigHash,
      deadlineAt: new Date(Date.now() + request.attemptDeadlineMs).toISOString(),
      containment: {
        registryPath,
        homeDirectory: resolve(runtimeRoot, "home"),
        tempDirectory: resolve(runtimeRoot, "tmp"),
        runtimeReadPaths: [],
        deniedReadPaths: await this.protectedReadPaths(
          initial,
          request.jobId,
          request.revision,
          prepared.workspaceRoot
        )
      }
    };

    let terminal: WorkerEvent | undefined;
    try {
      for await (const event of this.provider.start(providerInput)) {
        if (terminal !== undefined) continue;
        const accepted = await this.persistEvent(
          request,
          attemptId,
          generation,
          prepared.run.fence,
          event
        );
        if (!accepted) {
          return {
            attemptId,
            generation,
            phase: (await this.currentRun(request.jobId)).phase,
            stale: true
          };
        }
        if (terminalEvents.has(event.type)) terminal = event;
      }
    } catch (error) {
      terminal = {
        type: "FAILED",
        attemptId,
        code: "PI_PROVIDER_FAILED",
        message: error instanceof Error ? error.message : String(error)
      };
      if (!(await this.persistEvent(request, attemptId, generation, prepared.run.fence, terminal))) {
        return {
          attemptId,
          generation,
          phase: (await this.currentRun(request.jobId)).phase,
          stale: true
        };
      }
    }
    if (terminal === undefined) {
      terminal = {
        type: "FAILED",
        attemptId,
        code: "PI_RPC_STREAM_CLOSED",
        message: "Pi RPC stream closed before a terminal event"
      };
      if (!(await this.persistEvent(request, attemptId, generation, prepared.run.fence, terminal))) {
        return {
          attemptId,
          generation,
          phase: (await this.currentRun(request.jobId)).phase,
          stale: true
        };
      }
    }

    await this.persistSessionArtifact(request, attemptId, generation, prepared.run.fence);
    const reconciled = await this.reconcileContainment(
      request,
      attemptId,
      generation,
      prepared.run.fence,
      registryPath
    );
    if (!reconciled) {
      return { attemptId, generation, phase: "PAUSED", stale: false };
    }
    await rm(runtimeRoot, { recursive: true, force: true });
    if (terminal.type !== "COMPLETED") {
      return {
        attemptId,
        generation,
        phase: (await this.currentRun(request.jobId)).phase,
        stale: false
      };
    }
    return this.captureCandidate(
      initial,
      prepared,
      request,
      attemptId,
      generation,
      prepared.run.fence
    );
  }

  private async prepareWorkspace(
    initial: ProjectState,
    run: RunRecord,
    request: WorkerRunRequest
  ): Promise<{
    baseline: GitWorkspaceSnapshot;
    inputSnapshot: GitWorkspaceSnapshot;
    runGitDirectory: string;
    workspaceRoot: string;
    run: RunRecord;
  }> {
    const revisionKey = String(request.revision);
    const existingRevision = run.gitWorkspace?.revisions[revisionKey];
    if (
      run.baseline !== undefined &&
      run.gitWorkspace !== undefined &&
      run.workspace !== undefined &&
      existingRevision !== undefined &&
      existingRevision.resultSnapshot === undefined &&
      existingRevision.workspacePath === run.workspace.relativePath
    ) {
      const workspaceRoot = resolve(this.store.dataDirectory, run.workspace.relativePath);
      if (!isInside(this.store.dataDirectory, workspaceRoot)) throw new Error("PI_WORKSPACE_PATH_INVALID");
      await rm(resolve(workspaceRoot, ".smartflow-runtime"), { recursive: true, force: true });
      const [baseline, inputSnapshot] = await Promise.all([
        this.readSnapshot(run.baseline),
        this.readSnapshot(existingRevision.inputSnapshot)
      ]);
      await this.syncCanonicalTask(initial.canonicalProjectRoot, run, workspaceRoot);
      const result = await this.mutations.mutate(
        {
          requestId: `worker-workspace-reuse:${request.jobId}:r${revisionKey}:s${String(initial.stateVersion)}`,
          payload: { workspace: run.workspace.relativePath, revision: request.revision },
          expectedStateVersion: initial.stateVersion,
          expectedJobId: request.jobId,
          expectedFence: run.fence,
          expectedRevision: request.revision,
          expectedPhases: ["PREPARING"]
        },
        (state) => ({
          nextState: nextStateWithRun(state, request.jobId, (active) => ({
            ...active,
            phase: "RUNNING",
            pause: undefined,
            lastError: undefined
          })),
          response: { phase: "RUNNING", reused: true }
        })
      );
      const preparedRun = result.state.runs[request.jobId];
      if (preparedRun === undefined) throw new Error("PI_RUN_DISAPPEARED");
      return {
        baseline,
        inputSnapshot,
        runGitDirectory: dirname(resolve(this.store.dataDirectory, run.gitWorkspace.objectDirectory)),
        workspaceRoot,
        run: preparedRun
      };
    }

    const revisionRoot = resolve(
      this.store.dataDirectory,
      "runs",
      request.jobId,
      `revision-${revisionKey}`
    );
    await mkdir(revisionRoot, { recursive: true, mode: 0o700 });
    const runRoot = resolve(this.store.dataDirectory, "runs", request.jobId);
    let baseline: GitWorkspaceSnapshot;
    let inputSnapshot: GitWorkspaceSnapshot;
    let baselineRef: RunRecord["baseline"];
    let capabilityRef = run.gitWorkspace?.capability;
    let runGitDirectory: string;
    let objectDirectory: string;
    let inputSnapshotRef: NonNullable<RunRecord["baseline"]>;

    if (run.gitWorkspace === undefined) {
      const capability = await probeGitRepository(initial.canonicalProjectRoot);
      const portableCapability = Object.fromEntries(
        Object.entries(capability).filter(([key]) =>
          key !== "repositoryRoot" && key !== "gitDirectory"
        )
      );
      const capabilityBytes = Buffer.from(JSON.stringify(portableCapability), "utf8");
      const writtenCapabilityRef = await this.store.writeArtifact(
        `runs/${request.jobId}/revision-1/git/capability-${createHash("sha256").update(capabilityBytes).digest("hex")}.json`,
        capabilityBytes
      );
      capabilityRef = writtenCapabilityRef;
      if (capability.status !== "READY" || capability.repositoryId === undefined) {
        const code = capability.pause?.code ?? "GIT_REPOSITORY_REQUIRED";
        await this.mutations.mutate(
          {
            requestId: `git-capability:${request.jobId}:${code}:s${String(initial.stateVersion)}`,
            payload: capability,
            expectedStateVersion: initial.stateVersion,
            expectedJobId: request.jobId,
            expectedFence: run.fence,
            expectedRevision: request.revision,
            expectedPhases: ["PREPARING"]
          },
          (state) => ({
            nextState: nextStateWithRun(state, request.jobId, (active) => ({
              ...active,
              phase: "PAUSED",
              pause: { code, resumeActions: ["retry_git_probe", "cancel"] },
              lastError: {
                code,
                stage: "git-capability",
                message: capability.pause?.message ?? "Git repository is unsupported",
                retryable: true,
                nextActions: ["retry_git_probe", "cancel"],
                artifacts: [writtenCapabilityRef]
              }
            })),
            response: { phase: "PAUSED", code }
          })
        );
        throw new WorkspacePreparationPaused(code);
      }
      const objectStore = await initializeGitObjectStore(runRoot);
      runGitDirectory = objectStore.gitDirectory;
      objectDirectory = portableRelative(this.store.dataDirectory, objectStore.objectDirectory);
      baseline = await captureGitSnapshot({
        projectRoot: initial.canonicalProjectRoot,
        dataDirectory: runRoot,
        runGitDirectory,
        indexPath: resolve(revisionRoot, "baseline.index"),
        repositoryId: capability.repositoryId,
        snapshotKind: "RUN_BASELINE",
        revision: 1,
        includedPathPolicyHash: capability.inclusionPolicyHash
      });
      const baselineBytes = Buffer.from(JSON.stringify(baseline), "utf8");
      baselineRef = await this.store.writeArtifact(
        `runs/${request.jobId}/revision-1/snapshots/run-baseline-${createHash("sha256").update(baselineBytes).digest("hex")}.json`,
        baselineBytes
      );
      inputSnapshot = baseline;
      inputSnapshotRef = baselineRef;
    } else {
      baselineRef = run.gitWorkspace.runBaselineSnapshot;
      baseline = await this.readSnapshot(baselineRef);
      const previous = run.gitWorkspace.revisions[String(request.revision - 1)];
      if (previous?.resultSnapshot === undefined) throw new Error("GIT_REVISION_INPUT_MISSING");
      inputSnapshotRef = previous.resultSnapshot;
      inputSnapshot = await this.readSnapshot(inputSnapshotRef);
      runGitDirectory = dirname(resolve(this.store.dataDirectory, run.gitWorkspace.objectDirectory));
      objectDirectory = run.gitWorkspace.objectDirectory;
    }

    const workspaceRoot = resolve(revisionRoot, `workspace-${randomUUID()}`);
    await materializeGitSnapshot({
      snapshot: inputSnapshot,
      runGitDirectory,
      dataDirectory: runRoot,
      destination: workspaceRoot
    });
    await this.syncCanonicalTask(initial.canonicalProjectRoot, run, workspaceRoot);
    const workspaceRelativePath = portableRelative(this.store.dataDirectory, workspaceRoot);
    const sandboxId = `workspace-${randomUUID()}`;
    const preparedCapabilityRef = requiredValue(
      capabilityRef,
      "GIT_WORKSPACE_BINDING_MISSING"
    );
    const result = await this.mutations.mutate(
      {
        requestId: `worker-workspace:${request.jobId}:r${revisionKey}:${sandboxId}`,
        payload: { baselineHash: baseline.snapshotHash, workspaceRelativePath, sandboxId },
        expectedStateVersion: initial.stateVersion,
        expectedJobId: request.jobId,
        expectedFence: run.fence,
        expectedRevision: request.revision,
        expectedPhases: ["PREPARING"]
      },
      (state) => ({
        nextState: nextStateWithRun(state, request.jobId, (active) => ({
          ...active,
          phase: "RUNNING",
          pause: undefined,
          lastError: undefined,
          baseline: baselineRef,
          gitWorkspace: {
            capability: preparedCapabilityRef,
            repositoryId: baseline.repositoryId,
            inclusionPolicyHash: baseline.includedPathPolicyHash,
            objectDirectory,
            runBaselineSnapshot: baselineRef,
            revisions: {
              ...(active.gitWorkspace?.revisions ?? {}),
              [revisionKey]: {
                revision: request.revision,
                indexPath: portableRelative(this.store.dataDirectory, resolve(revisionRoot, "result.index")),
                workspacePath: workspaceRelativePath,
                inputSnapshot: inputSnapshotRef
              }
            }
          },
          workspace: {
            relativePath: workspaceRelativePath,
            baselineHash: baseline.snapshotHash,
            generation: 0,
            sandboxId,
            mutable: true
          }
        })),
        response: { phase: "RUNNING", workspaceRelativePath }
      })
    );
    const preparedRun = result.state.runs[request.jobId];
    if (preparedRun === undefined) throw new Error("PI_RUN_DISAPPEARED");
    return { baseline, inputSnapshot, runGitDirectory, workspaceRoot, run: preparedRun };
  }

  private async syncCanonicalTask(
    projectRoot: string,
    run: RunRecord,
    workspaceRoot: string
  ): Promise<void> {
    const manifest = taskManifestSchema.parse(JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.taskManifest))
    ));
    const sourcePath = isAbsolute(run.canonicalTaskPath)
      ? run.canonicalTaskPath
      : resolve(projectRoot, run.canonicalTaskPath);
    const targetPath = resolve(workspaceRoot, manifest.canonicalTaskPath);
    if (!isInside(workspaceRoot, targetPath)) throw new Error("TASK_WORKTREE_PATH_INVALID");
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeFile(targetPath, await readFile(sourcePath));
  }

  private async beginAttempt(
    request: WorkerRunRequest,
    attemptId: string,
    generation: number,
    expectedFence: number
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    await this.mutations.mutate(
      {
        requestId: `pi-attempt:${attemptId}:preparing`,
        payload: {
          attemptId,
          generation,
          revision: request.revision,
          providerRuntimeConfigHash: request.providerRuntimeConfigHash
        },
        expectedJobId: request.jobId,
        expectedFence,
        expectedRevision: request.revision,
        expectedPhases: ["RUNNING"]
      },
      (state) => ({
        nextState: nextStateWithRun(state, request.jobId, (run) => ({
          ...run,
          workerAttempts: [
            ...run.workerAttempts,
            {
              attemptId,
              revision: request.revision,
              generation,
              providerRuntimeConfigHash: request.providerRuntimeConfigHash,
              status: "PREPARING",
              startedAt
            }
          ],
          workspace: run.workspace === undefined
            ? undefined
            : { ...run.workspace, generation }
        })),
        response: { attemptId, generation, status: "PREPARING" }
      })
    );
  }

  private async persistEvent(
    request: WorkerRunRequest,
    attemptId: string,
    generation: number,
    expectedFence: number,
    event: WorkerEvent
  ): Promise<boolean> {
    if (event.attemptId !== attemptId) return false;
    const durableEvent: WorkerEvent = event.type === "FAILED" || event.type === "BLOCKED"
      ? {
          ...event,
          message: redactPiValue(event.message, [
            (await this.store.readState()).canonicalProjectRoot,
            this.store.dataDirectory,
            homedir()
          ]) as string
        }
      : event;
    if (
      event.type === "TEXT_DELTA" ||
      event.type === "TOOL_STARTED" ||
      event.type === "TOOL_FINISHED"
    ) return this.matchesAttempt(await this.store.readState(), request, attemptId, generation, expectedFence);
    if (event.type === "STARTED") {
      try {
        await this.mutations.mutate(
          {
            requestId: `pi-event:${attemptId}:started`,
            payload: durableEvent,
            expectedJobId: request.jobId,
            expectedFence,
            expectedRevision: request.revision,
            expectedGeneration: generation,
            expectedAttemptId: attemptId,
            expectedPhases: ["RUNNING"]
          },
          (state) => ({
            nextState: nextStateWithRun(state, request.jobId, (run) => ({
              ...run,
              workerAttempts: replaceAttempt(run, attemptId, (attempt) => ({
                ...attempt,
                status: "RUNNING",
                piSessionId: event.piSessionId,
                containmentId: event.containmentId,
                processIdentity: { pid: event.pid, startToken: event.processStartToken }
              }))
            })),
            response: { attemptId, status: "RUNNING" }
          })
        );
        return true;
      } catch (error) {
        if (error instanceof StateStoreError) return false;
        throw error;
      }
    }

    const terminalEvent = durableEvent as Extract<WorkerEvent, {
      type: "COMPLETED" | "BLOCKED" | "FAILED" | "TIMED_OUT" | "CANCELED";
    }>;
    const endedAt = new Date().toISOString();
    const status = terminalEvent.type;
    const terminalReason = terminalEvent.type === "COMPLETED"
      ? undefined
      : terminalEvent.type === "TIMED_OUT"
        ? terminalEvent.code
        : terminalEvent.type === "CANCELED"
          ? "ATTEMPT_CANCELED"
          : `${terminalEvent.code}: ${terminalEvent.message}`;
    const pause = terminalEvent.type === "COMPLETED"
      ? undefined
      : terminalEvent.type === "TIMED_OUT"
        ? {
            code: terminalEvent.code,
            resumeActions: ["retry_provider", "approve_new_manifest_revision", "cancel"]
          }
        : terminalEvent.type === "BLOCKED"
          ? { code: terminalEvent.code, resumeActions: ["approve_new_manifest_revision", "cancel"] }
          : terminalEvent.type === "FAILED"
            ? { code: terminalEvent.code, resumeActions: ["retry_provider", "cancel"] }
            : { code: "ATTEMPT_CANCELED", resumeActions: ["retry_provider", "cancel"] };
    try {
      await this.mutations.mutate(
        {
          requestId: `pi-event:${attemptId}:${terminalEvent.type.toLowerCase()}`,
          payload: terminalEvent,
          expectedJobId: request.jobId,
          expectedFence,
          expectedRevision: request.revision,
          expectedGeneration: generation,
          expectedAttemptId: attemptId,
          expectedPhases: ["RUNNING"]
        },
        (state) => ({
          nextState: nextStateWithRun(state, request.jobId, (run) => ({
            ...run,
            phase: pause === undefined ? run.phase : "PAUSED",
            pause,
            workerAttempts: replaceAttempt(run, attemptId, (attempt) => ({
              ...attempt,
              status,
              ...(terminalEvent.type === "COMPLETED"
                ? { piSessionId: terminalEvent.piSessionId }
                : {}),
              ...(terminalReason === undefined ? {} : { terminalReason }),
              endedAt
            })),
            ...(terminalEvent.type === "FAILED"
              ? {
                  lastError: {
                    code: terminalEvent.code,
                    stage: "pi-provider",
                    message: terminalEvent.message,
                    retryable: true,
                    nextActions: ["retry_provider", "cancel"],
                    artifacts: []
                  }
                }
              : {})
          })),
          response: { attemptId, status }
        })
      );
      return true;
    } catch (error) {
      if (error instanceof StateStoreError) return false;
      throw error;
    }
  }

  private async persistSessionArtifact(
    request: WorkerRunRequest,
    attemptId: string,
    generation: number,
    expectedFence: number
  ): Promise<void> {
    const state = await this.store.readState();
    const attempt = currentAttempt(state.runs[request.jobId]);
    if (attempt?.attemptId !== attemptId || attempt.piSessionId === undefined) return;
    const body = {
      schemaVersion: 1,
      jobId: request.jobId,
      revision: request.revision,
      attemptId,
      generation,
      piSessionId: attempt.piSessionId,
      providerRuntimeConfigHash: attempt.providerRuntimeConfigHash,
      terminalStatus: attempt.status,
      ...(attempt.containmentId === undefined ? {} : { containmentId: attempt.containmentId }),
      createdAt: new Date().toISOString()
    };
    const artifact = await this.store.writeArtifact(
      `runs/${request.jobId}/attempts/${attemptId}/session-artifact.json`,
      Buffer.from(JSON.stringify(body), "utf8")
    );
    await this.mutations.mutate(
      {
        requestId: `pi-attempt:${attemptId}:session-artifact`,
        payload: { attemptId, artifact },
        expectedJobId: request.jobId,
        expectedFence,
        expectedRevision: request.revision,
        expectedGeneration: generation,
        expectedAttemptId: attemptId,
        expectedPhases: ["RUNNING", "PAUSED"]
      },
      (current) => ({
        nextState: nextStateWithRun(current, request.jobId, (run) => ({
          ...run,
          workerAttempts: replaceAttempt(run, attemptId, (value) => ({
            ...value,
            sessionArtifact: artifact
          }))
        })),
        response: { attemptId, artifact }
      })
    );
  }

  private async reconcileContainment(
    request: WorkerRunRequest,
    attemptId: string,
    generation: number,
    expectedFence: number,
    registryPath: string
  ): Promise<boolean> {
    const state = await this.store.readState();
    if (!this.matchesAttempt(state, request, attemptId, generation, expectedFence)) return false;
    const attempt = currentAttempt(state.runs[request.jobId]);
    if (attempt === undefined) return false;
    const adapter = new ExecutionSandboxAdapter(registryPath);
    const observed = adapter.query(attemptId);
    let treeEmpty = false;
    if (attempt.containmentId === undefined || attempt.processIdentity === undefined) {
      treeEmpty = observed === "NOT_FOUND";
    } else {
      const identity = adapter.inspect(attemptId);
      const matches = identity !== undefined &&
        identity.containmentId === attempt.containmentId &&
        identity.configHash === attempt.providerRuntimeConfigHash &&
        identity.pid === attempt.processIdentity.pid &&
        identity.processStartToken === attempt.processIdentity.startToken;
      if (matches && observed === "EXITED") treeEmpty = true;
      else if (matches && observed === "RUNNING") {
        treeEmpty = (await adapter.terminate(attemptId)).treeEmpty;
      }
    }
    if (treeEmpty) return true;
    await this.mutations.mutate(
      {
        requestId: `pi-attempt:${attemptId}:reconciliation-blocked`,
        payload: { attemptId, observed },
        expectedJobId: request.jobId,
        expectedFence,
        expectedRevision: request.revision,
        expectedGeneration: generation,
        expectedAttemptId: attemptId,
        expectedPhases: ["RUNNING", "PAUSED"]
      },
      (current) => ({
        nextState: nextStateWithRun(current, request.jobId, (run) => ({
          ...run,
          phase: "PAUSED",
          pause: {
            code: "PI_CONTAINMENT_RECONCILIATION_REQUIRED",
            resumeActions: ["inspect_processes", "cancel"]
          },
          lastError: {
            code: "PI_CONTAINMENT_RECONCILIATION_REQUIRED",
            stage: "pi-containment",
            message: "Pi process-tree termination could not be proven",
            retryable: false,
            nextActions: ["inspect_processes", "cancel"],
            artifacts: []
          }
        })),
        response: { attemptId, observed, treeEmpty: false }
      })
    );
    return false;
  }

  private async captureCandidate(
    initial: ProjectState,
    prepared: {
      baseline: GitWorkspaceSnapshot;
      inputSnapshot: GitWorkspaceSnapshot;
      runGitDirectory: string;
      workspaceRoot: string;
      run: RunRecord;
    },
    request: WorkerRunRequest,
    attemptId: string,
    generation: number,
    expectedFence: number
  ): Promise<WorkerRunResult> {
    const revisionRoot = resolve(
      this.store.dataDirectory,
      "runs",
      request.jobId,
      `revision-${String(request.revision)}`
    );
    const resultSnapshot = await captureGitSnapshot({
      projectRoot: prepared.workspaceRoot,
      dataDirectory: resolve(this.store.dataDirectory, "runs", request.jobId),
      activeWorktreeRoot: initial.canonicalProjectRoot,
      includeAllFiles: true,
      runGitDirectory: prepared.runGitDirectory,
      indexPath: resolve(revisionRoot, "result.index"),
      repositoryId: prepared.baseline.repositoryId,
      snapshotKind: "REVISION_RESULT",
      revision: request.revision,
      includedPathPolicyHash: prepared.baseline.includedPathPolicyHash
    });
    const resultSnapshotBytes = Buffer.from(JSON.stringify(resultSnapshot), "utf8");
    const resultSnapshotRef = await this.store.writeArtifact(
      `runs/${request.jobId}/revision-${String(request.revision)}/snapshots/result-${createHash("sha256").update(resultSnapshotBytes).digest("hex")}.json`,
      resultSnapshotBytes
    );
    const built = await buildGitCandidate({
      runGitDirectory: prepared.runGitDirectory,
      runBaseline: prepared.baseline,
      revisionInput: prepared.inputSnapshot,
      revisionResult: resultSnapshot
    });
    const candidate = built.candidate;
    await this.hooks.beforeCandidateArtifact?.({
      jobId: request.jobId,
      revision: request.revision,
      attemptId,
      generation,
      candidate
    });
    const beforeArtifacts = await this.store.readState();
    if (!this.matchesAttempt(beforeArtifacts, request, attemptId, generation, expectedFence)) {
      return { attemptId, generation, phase: (await this.currentRun(request.jobId)).phase, stale: true };
    }
    const [incrementalPatchRef, cumulativePatchRef, evidenceRef, candidateRef] = await Promise.all([
      this.store.writeArtifact(
        `runs/${request.jobId}/revision-${String(request.revision)}/patches/incremental-${createHash("sha256").update(built.incrementalPatch).digest("hex")}.patch`,
        built.incrementalPatch
      ),
      this.store.writeArtifact(
        `runs/${request.jobId}/revision-${String(request.revision)}/patches/cumulative-${createHash("sha256").update(built.cumulativePatch).digest("hex")}.patch`,
        built.cumulativePatch
      ),
      this.store.writeArtifact(
        `runs/${request.jobId}/revision-${String(request.revision)}/git-evidence/${candidate.evidenceArtifactHash}.json`,
        built.evidenceBytes
      ),
      this.store.writeArtifact(
        `runs/${request.jobId}/revision-${String(request.revision)}/candidates/${attemptId}-${candidate.hash}.json`,
        Buffer.from(JSON.stringify(candidate), "utf8")
      )
    ]);
    const manifest = taskManifestSchema.parse(JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(prepared.run.taskManifest))
    ));
    const reviewTaskPath = resolve(prepared.workspaceRoot, manifest.canonicalTaskPath);
    if (!isInside(prepared.workspaceRoot, reviewTaskPath)) {
      throw new Error("TASK_WORKTREE_PATH_INVALID");
    }
    const reviewTaskSourceHash = createHash("sha256")
      .update(await readFile(reviewTaskPath))
      .digest("hex");
    const candidateIncomplete = candidate.operations.length === 0 && !manifest.allowNoChange;

    await this.mutations.mutate(
      {
        requestId: `pi-candidate:${attemptId}`,
        payload: { attemptId, generation, candidateHash: candidate.hash },
        expectedJobId: request.jobId,
        expectedFence,
        expectedRevision: request.revision,
        expectedGeneration: generation,
        expectedAttemptId: attemptId,
        expectedPhases: ["RUNNING"]
      },
      (state) => {
        const run = state.runs[request.jobId];
        if (run === undefined) throw new Error("PI_RUN_MISSING");
        const attempt = currentAttempt(run);
        if (attempt?.attemptId !== attemptId || attempt.status !== "COMPLETED") {
          throw new Error("PI_ATTEMPT_NOT_COMPLETED");
        }
        const revisionWorkspace = run.gitWorkspace?.revisions[String(request.revision)];
        if (revisionWorkspace === undefined) throw new Error("GIT_REVISION_WORKSPACE_MISSING");
        let pendingAction: RunRecord["pendingAction"];
        if (!candidateIncomplete) {
          if (attempt.piSessionId === undefined) throw new Error("PI_SESSION_MISSING");
          const reviewerSessions = [...new Set((run.reviewHistory ?? []).flatMap((entry) =>
            typeof entry.reviewerSessionId === "string" ? [entry.reviewerSessionId] : []
          ))];
          if (reviewerSessions.length > 1) throw new Error("REVIEWER_SESSION_HISTORY_INVALID");
          pendingAction = {
            ...createReviewHostAction(
              {
                revision: run.revision,
                taskSourceHash: reviewTaskSourceHash,
                candidateHash: candidate.hash,
                changedPaths: candidate.operations.map((operation) => operation.path),
                piSessionId: attempt.piSessionId,
                ...(reviewerSessions[0] === undefined
                  ? {}
                  : { boundReviewerSessionId: reviewerSessions[0] })
              },
              new Date(Date.now() + 15 * 60_000).toISOString()
            )
          };
        }
        return {
          nextState: nextStateWithRun(state, request.jobId, (active) => ({
            ...active,
            phase: candidateIncomplete ? "FIXING" : "REVIEW_PENDING",
            candidate: candidateRef,
            gitWorkspace: active.gitWorkspace === undefined
              ? undefined
              : {
                  ...active.gitWorkspace,
                  revisions: {
                    ...active.gitWorkspace.revisions,
                    [String(request.revision)]: {
                      ...revisionWorkspace,
                      resultSnapshot: resultSnapshotRef,
                      candidate: candidateRef,
                      incrementalPatch: incrementalPatchRef,
                      cumulativePatch: cumulativePatchRef,
                      evidence: evidenceRef
                    }
                  }
                },
            ...(pendingAction === undefined ? {} : { pendingAction }),
            ...(candidateIncomplete
              ? {
                  lastError: {
                    code: "WORKER_CANDIDATE_EMPTY",
                    stage: "candidate-completeness",
                    message: "Pi completed without producing a changed Candidate",
                    retryable: true,
                    nextActions: ["prepare_repair", "cancel"],
                    artifacts: [candidateRef]
                  }
                }
              : { lastError: undefined, pause: undefined })
          })),
          response: { phase: candidateIncomplete ? "FIXING" : "REVIEW_PENDING" }
        };
      }
    );
    return {
      attemptId,
      generation,
      phase: candidateIncomplete ? "FIXING" : "REVIEW_PENDING",
      candidate,
      ...(candidateIncomplete ? { code: "WORKER_CANDIDATE_EMPTY" as const } : {}),
      stale: false
    };
  }

  private async protectedReadPaths(
    state: ProjectState,
    jobId: string,
    revision: number,
    workspaceRoot: string
  ): Promise<string[]> {
    const protectedPaths = new Set<string>([
      state.canonicalProjectRoot,
      this.store.statePath,
      this.store.eventsPath,
      this.store.lockPath
    ]);
    const runsRoot = resolve(this.store.dataDirectory, "runs");
    for (const entry of await readdir(runsRoot, { withFileTypes: true }).catch(() => [])) {
      if (entry.name !== jobId) protectedPaths.add(resolve(runsRoot, entry.name));
    }
    const runRoot = resolve(runsRoot, jobId);
    const revisionName = `revision-${String(revision)}`;
    for (const entry of await readdir(runRoot, { withFileTypes: true }).catch(() => [])) {
      const path = resolve(runRoot, entry.name);
      if (entry.name !== revisionName) protectedPaths.add(path);
    }
    const revisionRoot = resolve(runRoot, revisionName);
    for (const entry of await readdir(revisionRoot, { withFileTypes: true }).catch(() => [])) {
      const path = resolve(revisionRoot, entry.name);
      if (!isInside(path, workspaceRoot) && !isInside(workspaceRoot, path)) protectedPaths.add(path);
    }
    return [...protectedPaths];
  }

  private matchesAttempt(
    state: ProjectState,
    request: WorkerRunRequest,
    attemptId: string,
    generation: number,
    expectedFence: number
  ): boolean {
    const run = state.runs[request.jobId];
    const attempt = currentAttempt(run);
    return run !== undefined &&
      state.activeRunsByTaskPath[run.canonicalTaskPath] === request.jobId &&
      run.fence === expectedFence &&
      run.revision === request.revision &&
      attempt?.attemptId === attemptId &&
      attempt.generation === generation;
  }

  private async pause(
    request: WorkerRunRequest,
    expectedFence: number,
    expectedStateVersion: number,
    code: string,
    resumeActions: string[]
  ): Promise<boolean> {
    try {
      await this.mutations.mutate(
        {
          requestId: `pi-pause:${request.jobId}:r${String(request.revision)}:s${String(expectedStateVersion)}:${code}`,
          payload: { code, resumeActions },
          expectedStateVersion,
          expectedJobId: request.jobId,
          expectedFence,
          expectedRevision: request.revision,
          expectedPhases: ["PREPARING"]
        },
        (state) => ({
          nextState: nextStateWithRun(state, request.jobId, (run) => ({
            ...run,
            phase: "PAUSED",
            pause: { code, resumeActions }
          })),
          response: { phase: "PAUSED", code }
        })
      );
      return true;
    } catch (error) {
      if (
        error instanceof StateStoreError &&
        new Set(["STATE_VERSION_MISMATCH", "STALE_FENCE", "REVISION_MISMATCH", "STATE_INVALID"])
          .has(error.code)
      ) return false;
      throw error;
    }
  }

  private async readSnapshot(ref: NonNullable<RunRecord["baseline"]>): Promise<GitWorkspaceSnapshot> {
    return JSON.parse(new TextDecoder().decode(await this.store.readArtifact(ref))) as GitWorkspaceSnapshot;
  }

  private async currentRun(jobId: string): Promise<RunRecord> {
    const run = (await this.store.readState()).runs[jobId];
    if (run === undefined) throw new Error(`Unknown worker run: ${jobId}`);
    return run;
  }
}
