import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { StructuredLogger } from "@smartflow/observability";
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
  verifyGitWorkspaceSnapshot,
  type GitWorkspaceSnapshot
} from "@smartflow/workspace";

import { ProjectMutationExecutor } from "../runtime/project-mutation-executor.js";
import {
  clearRepairContinuation,
  resolveRepairContinuation
} from "../repair/repair-continuation.js";

export interface WorkerRunRequest {
  jobId: string;
  prompt: string;
  providerRuntimeConfigHash: string;
  attemptDeadlineMs: number;
  resumeSession?: {
    sourceAttemptId?: string;
    expectedPiSessionId: string;
    sessionArtifact: NonNullable<RunRecord["workerAttempts"][number]["sessionArtifact"]>;
  };
}

export interface WorkerRunnerOptions {
  logger?: Pick<StructuredLogger, "log">;
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

type SessionArtifactRef = NonNullable<RunRecord["workerAttempts"][number]["sessionArtifact"]>;

interface PiSessionBundle {
  jobId: string;
  attemptId: string;
  generation: number;
  piSessionId: string;
  providerRuntimeConfigHash: string;
  terminalStatus: "COMPLETED";
  sessionFileRelativePath: string;
  sessionJsonlBase64: string;
  containmentId?: string;
  createdAt: string;
}

interface LoadedResumeSession {
  expectedPiSessionId: string;
  sessionFileRelativePath: string;
  sessionBytes: Buffer;
}

function artifactRefsEqual(left: SessionArtifactRef, right: SessionArtifactRef): boolean {
  return left.relativePath === right.relativePath &&
    left.sha256 === right.sha256 &&
    left.size === right.size;
}

function sessionRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value) || value.includes("\\")) {
    throw new Error("PI_SESSION_ARTIFACT_PATH_INVALID");
  }
  const segments = value.split("/");
  if (
    segments.length < 2 ||
    segments[0] !== "sessions" ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("PI_SESSION_ARTIFACT_PATH_INVALID");
  }
  return value;
}

function parseSessionBundle(bytes: Uint8Array): PiSessionBundle {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("PI_SESSION_ARTIFACT_INVALID");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PI_SESSION_ARTIFACT_INVALID");
  }
  const bundle = value as Record<string, unknown>;
  const stringFields = [
    "jobId",
    "attemptId",
    "piSessionId",
    "providerRuntimeConfigHash",
    "sessionJsonlBase64",
    "createdAt"
  ];
  if (
    bundle.terminalStatus !== "COMPLETED" ||
    !Number.isInteger(bundle.generation) ||
    !stringFields.every((field) => {
      const entry = bundle[field];
      return typeof entry === "string" && entry.length > 0;
    }) ||
    (bundle.containmentId !== undefined && typeof bundle.containmentId !== "string")
  ) {
    throw new Error("PI_SESSION_ARTIFACT_INVALID");
  }
  const sessionJsonlBase64 = bundle.sessionJsonlBase64 as string;
  const decoded = Buffer.from(sessionJsonlBase64, "base64");
  if (decoded.toString("base64") !== sessionJsonlBase64) {
    throw new Error("PI_SESSION_ARTIFACT_BASE64_INVALID");
  }
  return {
    jobId: bundle.jobId as string,
    attemptId: bundle.attemptId as string,
    generation: bundle.generation as number,
    piSessionId: bundle.piSessionId as string,
    providerRuntimeConfigHash: bundle.providerRuntimeConfigHash as string,
    terminalStatus: "COMPLETED",
    sessionFileRelativePath: sessionRelativePath(bundle.sessionFileRelativePath),
    sessionJsonlBase64,
    ...(bundle.containmentId === undefined
      ? {}
      : { containmentId: bundle.containmentId }),
    createdAt: bundle.createdAt as string
  };
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
  private readonly logger: Pick<StructuredLogger, "log"> | undefined;
  private readonly mutations: ProjectMutationExecutor;

  public constructor(
    private readonly store: StateStore,
    private readonly provider: WorkerProvider,
    options: WorkerRunnerOptions = {}
  ) {
    this.logger = options.logger;
    this.mutations = new ProjectMutationExecutor(store);
  }

  private async loadResumeSession(
    run: RunRecord,
    request: WorkerRunRequest
  ): Promise<LoadedResumeSession | undefined> {
    const requested = request.resumeSession;
    if (requested === undefined) return undefined;
    const attempt = requested.sourceAttemptId === undefined
      ? currentAttempt(run)
      : run.workerAttempts.find((candidate) => candidate.attemptId === requested.sourceAttemptId);
    if (
      attempt === undefined ||
      attempt.status !== "COMPLETED" ||
      attempt.piSessionId !== requested.expectedPiSessionId ||
      attempt.providerRuntimeConfigHash !== request.providerRuntimeConfigHash ||
      attempt.sessionArtifact === undefined ||
      !artifactRefsEqual(attempt.sessionArtifact, requested.sessionArtifact)
    ) {
      throw new Error("PI_SESSION_RESUME_CONTEXT_INVALID");
    }
    const bundle = parseSessionBundle(await this.store.readArtifact(requested.sessionArtifact));
    if (
      bundle.jobId !== request.jobId ||
      bundle.attemptId !== attempt.attemptId ||
      bundle.generation !== attempt.generation ||
      bundle.piSessionId !== requested.expectedPiSessionId ||
      bundle.providerRuntimeConfigHash !== request.providerRuntimeConfigHash
    ) {
      throw new Error("PI_SESSION_ARTIFACT_BINDING_INVALID");
    }
    return {
      expectedPiSessionId: requested.expectedPiSessionId,
      sessionFileRelativePath: bundle.sessionFileRelativePath,
      sessionBytes: Buffer.from(bundle.sessionJsonlBase64, "base64")
    };
  }

  private async restoreResumeSession(
    runtimeRoot: string,
    session: LoadedResumeSession
  ): Promise<string> {
    const sessionFile = resolve(runtimeRoot, ...session.sessionFileRelativePath.split("/"));
    if (!isInside(runtimeRoot, sessionFile)) throw new Error("PI_SESSION_RESTORE_PATH_INVALID");
    await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
    await writeFile(sessionFile, session.sessionBytes, { mode: 0o600 });
    return sessionFile;
  }

  public async run(request: WorkerRunRequest): Promise<void> {
    if (!Number.isInteger(request.attemptDeadlineMs) || request.attemptDeadlineMs <= 0) {
      throw new Error("PI_ATTEMPT_DEADLINE_INVALID");
    }
    const initial = await this.store.readState();
    const initialRun = initial.runs[request.jobId];
    if (
      initialRun === undefined ||
      initial.activeRunsByTaskPath[initialRun.canonicalTaskPath] !== request.jobId
    ) throw new Error(`Run is not active: ${request.jobId}`);
    if (initialRun.phase !== "PREPARING") {
      throw new Error("Worker run must start from PREPARING");
    }
    const repairContinuation = resolveRepairContinuation(initialRun);
    const requestedResumeSession = request.resumeSession;
    if (
      repairContinuation !== undefined &&
      (
        requestedResumeSession === undefined ||
        request.prompt !== repairContinuation.prompt ||
        requestedResumeSession.sourceAttemptId !== repairContinuation.sourceAttemptId ||
        requestedResumeSession.expectedPiSessionId !== repairContinuation.expectedPiSessionId ||
        !artifactRefsEqual(
          requestedResumeSession.sessionArtifact,
          repairContinuation.sessionArtifact
        )
      )
    ) {
      throw new Error("REPAIR_CONTINUATION_REQUEST_MISMATCH");
    }
    const resumeSession = await this.loadResumeSession(initialRun, request);
    const probe = await this.provider.probe();
    if (!probe.available || !requiredCapabilities(probe)) {
      await this.pause(
        request,
        initialRun.fence,
        initial.stateVersion,
        "PROVIDER_UNAVAILABLE",
        ["retry_provider_probe", "cancel"]
      );
      return;
    }
    if (probe.providerRuntimeConfigHash !== request.providerRuntimeConfigHash) {
      await this.pause(
        request,
        initialRun.fence,
        initial.stateVersion,
        "PROVIDER_RUNTIME_CONFIG_DRIFT",
        ["retry_provider_probe", "cancel"]
      );
      return;
    }

    let prepared: Awaited<ReturnType<WorkerRunner["prepareWorkspace"]>>;
    try {
      prepared = await this.prepareWorkspace(initial, initialRun, request);
    } catch (error) {
      if (error instanceof WorkspacePreparationPaused) return;
      if (error instanceof StateStoreError) {
        if (
          new Set(["STATE_VERSION_MISMATCH", "STALE_FENCE", "STATE_INVALID"])
            .has(error.code)
        ) {
          return;
        }
      }
      throw error;
    }
    const generation = (currentAttempt(prepared.run)?.generation ?? -1) + 1;
    const attemptId = `attempt-${randomUUID()}`;
    const registryPath = resolve(
      this.store.dataDirectory,
      "runs",
      request.jobId,
      "pi-containments.json"
    );
    await this.beginAttempt(request, attemptId, generation, prepared.run.fence);
    const runtimeRoot = resolve(prepared.workspaceRoot, ".smartflow-runtime");
    let terminal: WorkerEvent | undefined;
    try {
      const restoredSessionFile = resumeSession === undefined
        ? undefined
        : await this.restoreResumeSession(runtimeRoot, resumeSession);
      const providerInput: WorkerStartInput = {
        attemptId,
        jobId: request.jobId,
        generation,
        workspaceDir: prepared.workspaceRoot,
        prompt: request.prompt,
        providerRuntimeConfigHash: request.providerRuntimeConfigHash,
        deadlineAt: new Date(Date.now() + request.attemptDeadlineMs).toISOString(),
        ...(restoredSessionFile === undefined || resumeSession === undefined
          ? {}
          : {
              resumeSession: {
                expectedPiSessionId: resumeSession.expectedPiSessionId,
                sessionFile: restoredSessionFile
              }
            }),
        containment: {
          registryPath,
          homeDirectory: resolve(runtimeRoot, "home"),
          tempDirectory: resolve(runtimeRoot, "tmp"),
          runtimeReadPaths: [],
          deniedReadPaths: await this.protectedReadPaths(
            initial,
            request.jobId,
            prepared.workspaceRoot
          )
        }
      };
      for await (const event of this.provider.start(providerInput)) {
        if (terminal !== undefined) continue;
        const accepted = await this.persistEvent(
          request,
          attemptId,
          generation,
          prepared.run.fence,
          event
        );
        if (!accepted) return;
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
        return;
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
        return;
      }
    }

    if (terminal.type === "COMPLETED") {
      await this.persistCompletedSessionArtifact(
        request,
        attemptId,
        generation,
        prepared.run.fence,
        terminal,
        runtimeRoot
      );
    }
    const reconciled = await this.reconcileContainment(
      request,
      attemptId,
      generation,
      prepared.run.fence,
      registryPath
    );
    if (!reconciled) return;
    await rm(runtimeRoot, { recursive: true, force: true });
    if (terminal.type !== "COMPLETED") return;
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
    const repairWorkspaceSeed = resolveRepairContinuation(run)?.workspaceSeedSnapshot;
    const runRoot = resolve(this.store.dataDirectory, "runs", request.jobId);
    const workspaceRoot = resolve(runRoot, "workspace");
    const workspaceRelativePath = portableRelative(this.store.dataDirectory, workspaceRoot);
    const indexPath = resolve(runRoot, "current.index");
    const indexRelativePath = portableRelative(this.store.dataDirectory, indexPath);
    const existingCurrent = run.gitWorkspace?.current;

    if (
      run.baseline !== undefined &&
      run.gitWorkspace !== undefined &&
      run.workspace !== undefined &&
      existingCurrent !== undefined &&
      existingCurrent.resultSnapshot === undefined &&
      existingCurrent.workspacePath === workspaceRelativePath &&
      existingCurrent.indexPath === indexRelativePath &&
      run.workspace.relativePath === workspaceRelativePath
    ) {
      if (!isInside(runRoot, workspaceRoot)) throw new Error("PI_WORKSPACE_PATH_INVALID");
      const [baseline, inputSnapshot] = await Promise.all([
        this.readSnapshot(run.gitWorkspace.runBaselineSnapshot),
        this.readSnapshot(existingCurrent.inputSnapshot)
      ]);
      if (
        !verifyGitWorkspaceSnapshot(baseline) ||
        baseline.snapshotKind !== "RUN_BASELINE" ||
        !verifyGitWorkspaceSnapshot(inputSnapshot) ||
        inputSnapshot.repositoryId !== baseline.repositoryId ||
        inputSnapshot.includedPathPolicyHash !== baseline.includedPathPolicyHash ||
        (repairWorkspaceSeed !== undefined &&
          (!artifactRefsEqual(existingCurrent.inputSnapshot, repairWorkspaceSeed) ||
            inputSnapshot.snapshotKind !== "RUN_RESULT"))
      ) {
        throw new Error("GIT_WORKSPACE_SEED_INVALID");
      }
      const runGitDirectory = dirname(resolve(
        this.store.dataDirectory,
        run.gitWorkspace.objectDirectory
      ));
      await rm(workspaceRoot, { recursive: true, force: true });
      await materializeGitSnapshot({
        snapshot: inputSnapshot,
        runGitDirectory,
        dataDirectory: runRoot,
        destination: workspaceRoot
      });
      await this.syncCanonicalTask(run, workspaceRoot);
      const result = await this.mutations.mutate(
        {
          requestId: `worker-workspace-reuse:${request.jobId}:s${String(initial.stateVersion)}`,
          payload: { workspace: workspaceRelativePath },
          expectedStateVersion: initial.stateVersion,
          expectedJobId: request.jobId,
          expectedFence: run.fence,
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
        runGitDirectory,
        workspaceRoot,
        run: preparedRun
      };
    }

    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    let baseline: GitWorkspaceSnapshot;
    let inputSnapshot: GitWorkspaceSnapshot;
    let baselineRef: NonNullable<RunRecord["baseline"]>;
    let inputSnapshotRef: NonNullable<RunRecord["baseline"]>;
    let runGitDirectory: string;
    let objectDirectory: string;

    if (run.gitWorkspace === undefined) {
      if (repairWorkspaceSeed !== undefined) {
        throw new Error("GIT_REPAIR_WORKSPACE_CONTEXT_MISSING");
      }
      const capability = await probeGitRepository(initial.canonicalProjectRoot);
      if (capability.status !== "READY" || capability.repositoryId === undefined) {
        const code = capability.pause?.code ?? "GIT_REPOSITORY_REQUIRED";
        await this.mutations.mutate(
          {
            requestId: `git-capability:${request.jobId}:${code}:s${String(initial.stateVersion)}`,
            payload: {
              code,
              inclusionPolicyHash: capability.inclusionPolicyHash,
              worktreeSupported: capability.worktreeSupported,
              symlinks: capability.symlinks,
              fileMode: capability.fileMode
            },
            expectedStateVersion: initial.stateVersion,
            expectedJobId: request.jobId,
            expectedFence: run.fence,
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
                artifacts: []
              }
            })),
            response: { phase: "PAUSED", code }
          })
        );
        this.logger?.log({
          level: "warn",
          event: "worker.git_capability_paused",
          stage: "git-capability",
          correlation: { jobId: request.jobId },
          data: {
            code,
            ...(capability.repositoryId === undefined
              ? {}
              : { repositoryId: capability.repositoryId }),
            inclusionPolicyHash: capability.inclusionPolicyHash,
            worktreeSupported: capability.worktreeSupported,
            symlinks: capability.symlinks,
            fileMode: capability.fileMode
          }
        });
        throw new WorkspacePreparationPaused(code);
      }
      this.logger?.log({
        level: "info",
        event: "worker.git_capability_ready",
        stage: "git-capability",
        correlation: { jobId: request.jobId },
        data: {
          repositoryId: capability.repositoryId,
          inclusionPolicyHash: capability.inclusionPolicyHash,
          worktreeSupported: capability.worktreeSupported,
          symlinks: capability.symlinks,
          fileMode: capability.fileMode
        }
      });
      const objectStore = await initializeGitObjectStore(runRoot);
      runGitDirectory = objectStore.gitDirectory;
      objectDirectory = portableRelative(this.store.dataDirectory, objectStore.objectDirectory);
      const baselineRelativePath = `runs/${request.jobId}/snapshots/run-baseline.json`;
      const durableBaseline = await this.store.readArtifactAt(baselineRelativePath);
      if (durableBaseline === undefined) {
        baseline = await captureGitSnapshot({
          projectRoot: initial.canonicalProjectRoot,
          dataDirectory: runRoot,
          runGitDirectory,
          indexPath,
          repositoryId: capability.repositoryId,
          snapshotKind: "RUN_BASELINE",
          includedPathPolicyHash: capability.inclusionPolicyHash
        });
        const baselineBytes = Buffer.from(JSON.stringify(baseline), "utf8");
        try {
          baselineRef = await this.store.writeArtifact(baselineRelativePath, baselineBytes);
        } catch (error) {
          if (!(error instanceof StateStoreError) || error.code !== "ARTIFACT_IMMUTABLE") {
            throw error;
          }
          const concurrentBaseline = await this.store.readArtifactAt(baselineRelativePath);
          if (concurrentBaseline === undefined) throw error;
          baseline = JSON.parse(
            new TextDecoder().decode(concurrentBaseline.bytes)
          ) as GitWorkspaceSnapshot;
          baselineRef = concurrentBaseline.ref;
        }
      } else {
        baseline = JSON.parse(
          new TextDecoder().decode(durableBaseline.bytes)
        ) as GitWorkspaceSnapshot;
        baselineRef = durableBaseline.ref;
      }
      if (
        !verifyGitWorkspaceSnapshot(baseline) ||
        baseline.snapshotKind !== "RUN_BASELINE" ||
        baseline.repositoryId !== capability.repositoryId ||
        baseline.includedPathPolicyHash !== capability.inclusionPolicyHash
      ) {
        throw new Error("GIT_RUN_BASELINE_INVALID");
      }
      inputSnapshot = baseline;
      inputSnapshotRef = baselineRef;
    } else {
      if (
        run.gitWorkspace.current.workspacePath !== workspaceRelativePath ||
        run.gitWorkspace.current.indexPath !== indexRelativePath
      ) {
        throw new Error("GIT_WORKSPACE_PATH_INVALID");
      }
      baselineRef = run.gitWorkspace.runBaselineSnapshot;
      inputSnapshotRef = run.gitWorkspace.current.inputSnapshot;
      [baseline, inputSnapshot] = await Promise.all([
        this.readSnapshot(baselineRef),
        this.readSnapshot(inputSnapshotRef)
      ]);
      runGitDirectory = dirname(resolve(this.store.dataDirectory, run.gitWorkspace.objectDirectory));
      objectDirectory = run.gitWorkspace.objectDirectory;
      if (
        repairWorkspaceSeed !== undefined &&
        !artifactRefsEqual(inputSnapshotRef, repairWorkspaceSeed)
      ) {
        throw new Error("GIT_REPAIR_SEED_BINDING_INVALID");
      }
    }
    if (
      !verifyGitWorkspaceSnapshot(baseline) ||
      baseline.snapshotKind !== "RUN_BASELINE" ||
      !verifyGitWorkspaceSnapshot(inputSnapshot) ||
      inputSnapshot.repositoryId !== baseline.repositoryId ||
      inputSnapshot.includedPathPolicyHash !== baseline.includedPathPolicyHash ||
      (repairWorkspaceSeed !== undefined && inputSnapshot.snapshotKind !== "RUN_RESULT")
    ) {
      throw new Error("GIT_WORKSPACE_SEED_INVALID");
    }

    await rm(workspaceRoot, { recursive: true, force: true });
    await materializeGitSnapshot({
      snapshot: inputSnapshot,
      runGitDirectory,
      dataDirectory: runRoot,
      destination: workspaceRoot
    });
    await this.syncCanonicalTask(run, workspaceRoot);
    const workspaceMutationId = randomUUID();
    const result = await this.mutations.mutate(
      {
        requestId: `worker-workspace:${request.jobId}:${workspaceMutationId}`,
        payload: { workspaceRelativePath },
        expectedStateVersion: initial.stateVersion,
        expectedJobId: request.jobId,
        expectedFence: run.fence,
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
            repositoryId: baseline.repositoryId,
            inclusionPolicyHash: baseline.includedPathPolicyHash,
            objectDirectory,
            runBaselineSnapshot: baselineRef,
            current: {
              indexPath: indexRelativePath,
              workspacePath: workspaceRelativePath,
              inputSnapshot: inputSnapshotRef
            }
          },
          workspace: {
            relativePath: workspaceRelativePath
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
    run: RunRecord,
    workspaceRoot: string
  ): Promise<void> {
    const manifest = taskManifestSchema.parse(JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.taskManifest))
    ));
    const targetPath = resolve(workspaceRoot, manifest.canonicalTaskPath);
    if (!isInside(workspaceRoot, targetPath)) throw new Error("TASK_WORKTREE_PATH_INVALID");
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeFile(targetPath, await this.store.readArtifact(run.taskSource));
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
          providerRuntimeConfigHash: request.providerRuntimeConfigHash
        },
        expectedJobId: request.jobId,
        expectedFence,
        expectedPhases: ["RUNNING"]
      },
      (state) => ({
        nextState: nextStateWithRun(state, request.jobId, (run) => ({
          ...run,
          workerAttempts: [
            ...run.workerAttempts,
            {
              attemptId,
              generation,
              providerRuntimeConfigHash: request.providerRuntimeConfigHash,
              status: "PREPARING",
              startedAt
            }
          ]
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
    const durableEvent: WorkerEvent = event.type === "COMPLETED"
      ? {
          type: "COMPLETED",
          attemptId: event.attemptId,
          piSessionId: event.piSessionId
        }
      : event.type === "FAILED" || event.type === "BLOCKED"
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
    const completedEvent = event.type === "COMPLETED" ? event : undefined;
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
            resumeActions: ["retry_provider", "cancel"]
          }
        : terminalEvent.type === "BLOCKED"
          ? { code: terminalEvent.code, resumeActions: ["cancel"] }
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
          expectedGeneration: generation,
          expectedAttemptId: attemptId,
          expectedPhases: ["RUNNING"]
        },
        async (state) => {
          let sessionArtifact: RunRecord["workerAttempts"][number]["sessionArtifact"];
          if (completedEvent !== undefined) {
            const workspace = state.runs[request.jobId]?.workspace;
            if (workspace === undefined) throw new Error("PI_WORKSPACE_MISSING");
            sessionArtifact = await this.persistCompletedSessionArtifact(
              request,
              attemptId,
              generation,
              expectedFence,
              completedEvent,
              resolve(
                this.store.dataDirectory,
                workspace.relativePath,
                ".smartflow-runtime"
              )
            );
          }
          return {
            nextState: nextStateWithRun(state, request.jobId, (run) => ({
              ...run,
              phase: pause === undefined ? run.phase : "PAUSED",
              pause,
              workerAttempts: replaceAttempt(run, attemptId, (attempt) => ({
                ...attempt,
                status,
                ...(terminalEvent.type === "COMPLETED"
                  ? {
                      piSessionId: terminalEvent.piSessionId,
                      sessionArtifact
                    }
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
          };
        }
      );
      return true;
    } catch (error) {
      if (error instanceof StateStoreError) return false;
      throw error;
    }
  }

  private async persistCompletedSessionArtifact(
    request: WorkerRunRequest,
    attemptId: string,
    generation: number,
    expectedFence: number,
    terminal: Extract<WorkerEvent, { type: "COMPLETED" }>,
    runtimeRoot: string
  ): Promise<NonNullable<RunRecord["workerAttempts"][number]["sessionArtifact"]>> {
    const state = await this.store.readState();
    const run = state.runs[request.jobId];
    const attempt = currentAttempt(run);
    if (
      run?.fence !== expectedFence ||
      attempt?.attemptId !== attemptId ||
      attempt.generation !== generation ||
      terminal.sessionFile === undefined
    ) {
      throw new Error("PI_SESSION_FILE_MISSING");
    }
    if (attempt.sessionArtifact !== undefined) {
      if (
        attempt.status !== "COMPLETED" ||
        attempt.piSessionId !== terminal.piSessionId
      ) {
        throw new Error("PI_SESSION_ARTIFACT_STATE_INVALID");
      }
      return attempt.sessionArtifact;
    }
    if (
      !new Set(["PREPARING", "RUNNING"]).has(attempt.status) ||
      (attempt.piSessionId !== undefined && attempt.piSessionId !== terminal.piSessionId)
    ) {
      throw new Error("PI_SESSION_ARTIFACT_STATE_INVALID");
    }
    const fileInfo = await lstat(terminal.sessionFile);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error("PI_SESSION_FILE_INVALID");
    }
    const [runtimeRealPath, sessionRealPath] = await Promise.all([
      realpath(runtimeRoot),
      realpath(terminal.sessionFile)
    ]);
    if (!isInside(runtimeRealPath, sessionRealPath)) {
      throw new Error("PI_SESSION_FILE_OUTSIDE_RUNTIME");
    }
    const sessionFileRelativePath = sessionRelativePath(
      portableRelative(runtimeRealPath, sessionRealPath)
    );
    const sessionBytes = await readFile(sessionRealPath);
    const body = {
      jobId: request.jobId,
      attemptId,
      generation,
      piSessionId: terminal.piSessionId,
      providerRuntimeConfigHash: attempt.providerRuntimeConfigHash,
      terminalStatus: "COMPLETED",
      sessionFileRelativePath,
      sessionJsonlBase64: sessionBytes.toString("base64"),
      ...(attempt.containmentId === undefined ? {} : { containmentId: attempt.containmentId }),
      createdAt: new Date().toISOString()
    };
    return this.store.writeArtifact(
      `runs/${request.jobId}/attempts/${attemptId}/session-artifact.json`,
      Buffer.from(JSON.stringify(body), "utf8")
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
  ): Promise<void> {
    const runRoot = resolve(this.store.dataDirectory, "runs", request.jobId);
    const currentWorkspace = prepared.run.gitWorkspace?.current;
    if (currentWorkspace === undefined) throw new Error("GIT_CURRENT_WORKSPACE_MISSING");
    const indexPath = resolve(this.store.dataDirectory, currentWorkspace.indexPath);
    if (!isInside(runRoot, indexPath)) throw new Error("GIT_CURRENT_INDEX_PATH_INVALID");
    await this.syncCanonicalTask(prepared.run, prepared.workspaceRoot);
    const resultSnapshot = await captureGitSnapshot({
      projectRoot: prepared.workspaceRoot,
      dataDirectory: runRoot,
      activeWorktreeRoot: initial.canonicalProjectRoot,
      includeAllFiles: true,
      runGitDirectory: prepared.runGitDirectory,
      indexPath,
      repositoryId: prepared.baseline.repositoryId,
      snapshotKind: "RUN_RESULT",
      includedPathPolicyHash: prepared.baseline.includedPathPolicyHash
    });
    const resultSnapshotBytes = Buffer.from(JSON.stringify(resultSnapshot), "utf8");
    const resultSnapshotHash = createHash("sha256").update(resultSnapshotBytes).digest("hex");
    const resultSnapshotRef = await this.store.writeArtifact(
      `runs/${request.jobId}/snapshots/run-result-${resultSnapshotHash}.json`,
      resultSnapshotBytes
    );
    const built = await buildGitCandidate({
      runBaseline: prepared.baseline,
      runResult: resultSnapshot
    });
    const candidate = built.candidate;
    const beforeArtifacts = await this.store.readState();
    if (!this.matchesAttempt(beforeArtifacts, request, attemptId, generation, expectedFence)) {
      return;
    }
    const candidateRef = await this.store.writeArtifact(
      `runs/${request.jobId}/candidates/candidate-${candidate.candidateHash}.json`,
      Buffer.from(JSON.stringify(candidate), "utf8")
    );

    const manifest = taskManifestSchema.parse(JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(prepared.run.taskManifest))
    ));
    const reviewTaskSourceHash = createHash("sha256")
      .update(await this.store.readArtifact(prepared.run.taskSource))
      .digest("hex");
    const candidateIncomplete = candidate.operations.length === 0 && !manifest.allowNoChange;

    await this.mutations.mutate(
      {
        requestId: `pi-candidate:${attemptId}`,
        payload: { attemptId, generation, candidateHash: candidate.candidateHash },
        expectedJobId: request.jobId,
        expectedFence,
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
        const activeWorkspace = run.gitWorkspace?.current;
        if (activeWorkspace === undefined) throw new Error("GIT_CURRENT_WORKSPACE_MISSING");
        let pendingAction: RunRecord["pendingAction"];
        if (!candidateIncomplete) {
          if (attempt.piSessionId === undefined) throw new Error("PI_SESSION_MISSING");
          const reviewerSessions = [...new Set((run.reviewHistory ?? []).flatMap((entry) =>
            typeof entry.reviewerSessionId === "string" ? [entry.reviewerSessionId] : []
          ))];
          if (reviewerSessions.length > 1) throw new Error("REVIEWER_SESSION_HISTORY_INVALID");
          const boundReviewerSessionId = reviewerSessions[0];
          pendingAction = {
            ...createReviewHostAction(
              {
                taskSourceHash: reviewTaskSourceHash,
                candidateHash: candidate.candidateHash,
                changedPaths: candidate.operations.map((operation) => operation.path),
                piSessionId: attempt.piSessionId,
                ...(typeof boundReviewerSessionId !== "string"
                  ? {}
                  : { boundReviewerSessionId })
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
            recovery: clearRepairContinuation(active.recovery),
            gitWorkspace: active.gitWorkspace === undefined
              ? undefined
              : {
                  ...active.gitWorkspace,
                  current: {
                    ...activeWorkspace,
                    resultSnapshot: resultSnapshotRef,
                    candidate: candidateRef
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
    return;
  }

  private async protectedReadPaths(
    state: ProjectState,
    jobId: string,
    workspaceRoot: string
  ): Promise<string[]> {
    const protectedPaths = new Set<string>([
      state.canonicalProjectRoot,
      ...this.store.protectedPaths
    ]);
    const runsRoot = resolve(this.store.dataDirectory, "runs");
    for (const entry of await readdir(runsRoot, { withFileTypes: true }).catch(() => [])) {
      if (entry.name !== jobId) protectedPaths.add(resolve(runsRoot, entry.name));
    }
    const runRoot = resolve(runsRoot, jobId);
    for (const entry of await readdir(runRoot, { withFileTypes: true }).catch(() => [])) {
      const path = resolve(runRoot, entry.name);
      if (!isInside(path, workspaceRoot) && !isInside(workspaceRoot, path)) {
        protectedPaths.add(path);
      }
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
      attempt?.attemptId === attemptId &&
      attempt.generation === generation;
  }

  private async pause(
    request: WorkerRunRequest,
    expectedFence: number,
    expectedStateVersion: number,
    code: string,
    resumeActions: string[]
  ): Promise<void> {
    try {
      await this.mutations.mutate(
        {
          requestId: `pi-pause:${request.jobId}:s${String(expectedStateVersion)}:${code}`,
          payload: { code, resumeActions },
          expectedStateVersion,
          expectedJobId: request.jobId,
          expectedFence,
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
    } catch (error) {
      if (
        error instanceof StateStoreError &&
        new Set(["STATE_VERSION_MISMATCH", "STALE_FENCE", "STATE_INVALID"])
          .has(error.code)
      ) return;
      throw error;
    }
  }

  private async readSnapshot(ref: NonNullable<RunRecord["baseline"]>): Promise<GitWorkspaceSnapshot> {
    return JSON.parse(new TextDecoder().decode(await this.store.readArtifact(ref))) as GitWorkspaceSnapshot;
  }
}
