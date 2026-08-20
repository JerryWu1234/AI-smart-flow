import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { redactPiValue } from "@smartflow/provider-pi";

import {
  cancelInputSchema,
  durableReviewDecisionSchema,
  executeInputSchema,
  hostActionSchema,
  resultOutputSchema,
  resultInputSchema,
  resumeActionSchema,
  resumeInputSchema,
  reviewTurnInputSchema,
  statusInputSchema,
  type ArtifactRef,
  type CancelInput,
  type ExecuteInput,
  type HostAction,
  type ResumeInput,
  type ResultOutput,
  type RunSummary
} from "@smartflow/protocol";
import {
  StateStore,
  canonicalHash,
  runArtifactInventory,
  type ProjectState,
  type RunRecord
} from "@smartflow/state-store";
import {
  compileTaskManifest,
  sha256Bytes,
  taskManifestSchema
} from "@smartflow/task-manifest";
import { cleanupGitRunTemporaryState } from "@smartflow/workspace";

import { createApprovedRevision } from "./approved-revision.js";
import { observeApprovedSource } from "./approved-source.js";
import {
  SMARTFLOW_IPC_PROTOCOL,
  type IpcRequest,
  type IpcRequestHandler
} from "./local-ipc-server.js";
import { ProjectMutationExecutor } from "./project-mutation-executor.js";
import { HostTurnCoordinator } from "./host-turn-coordinator.js";
import { verifyRunArtifacts } from "./recovery-manager.js";
import {
  ReviewCoordinator,
  isDaemonReviewerHostTurn
} from "./review-coordinator.js";

export interface ProjectPipelineContext {
  store: StateStore;
  projectId: string;
  jobId: string;
  expectedFence: number;
  expectedRevision: number;
  expectedGeneration?: number;
  expectedAttemptId?: string;
}

export interface ProjectRuntimeOptions {
  dataDirectory: string;
  runPipeline?: (context: ProjectPipelineContext) => Promise<void>;
  review?: (context: ProjectPipelineContext) => Promise<void>;
  publish?: (context: ProjectPipelineContext) => Promise<void>;
  cancel?: (context: ProjectPipelineContext) => Promise<void>;
  recover?: (context: ProjectPipelineContext) => Promise<void>;
  providerRuntimeConfig?: Readonly<Record<string, unknown>>;
  resolveProviderRuntimeConfig?: (
    providerRuntimeConfigHash: string
  ) => Readonly<Record<string, unknown>> | undefined;
}

interface MutationResult<T> {
  response: T;
  state: ProjectState;
  replayed: boolean;
}

class ProjectRuntimeError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProjectRuntimeError";
  }
}

function projectIdForRoot(root: string): string {
  return `project-${createHash("sha256").update(root, "utf8").digest("hex").slice(0, 40)}`;
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path.length === 0 || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isSafeTasksPathInput(path: string): boolean {
  if (isAbsolute(path) || path.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(path)) return false;
  return !path.split(/[\\/]/u).includes("..");
}

async function readProjectTasksFile(
  canonicalRoot: string,
  tasksPath: string
): Promise<{ canonicalPath: string; sourceBytes: Buffer }> {
  if (!isSafeTasksPathInput(tasksPath)) {
    throw new ProjectRuntimeError(
      "TASKS_PATH_UNSAFE",
      "tasksPath must be a Project-relative path without parent traversal"
    );
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(resolve(canonicalRoot, tasksPath));
  } catch {
    throw new ProjectRuntimeError("TASKS_PATH_NOT_REGULAR", "tasksPath does not resolve to a regular file");
  }
  if (!isInside(canonicalRoot, canonicalPath)) {
    throw new ProjectRuntimeError("TASKS_PATH_UNSAFE", "tasksPath escapes the Project Root");
  }
  return {
    canonicalPath,
    sourceBytes: await readCanonicalRegularFile(canonicalRoot, canonicalPath)
  };
}

async function readCanonicalRegularFile(canonicalRoot: string, canonicalPath: string): Promise<Buffer> {
  if (!isInside(canonicalRoot, canonicalPath)) {
    throw new ProjectRuntimeError("TASKS_PATH_UNSAFE", "tasksPath escapes the Project Root");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ProjectRuntimeError("TASKS_PATH_NOT_REGULAR", "tasksPath does not resolve to a regular file");
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof ProjectRuntimeError) throw error;
    throw new ProjectRuntimeError("TASKS_PATH_NOT_REGULAR", "tasksPath does not resolve to a regular file");
  } finally {
    await handle?.close();
  }
}

function approvedSourceDriftResumePhase(run: RunRecord): RunRecord["phase"] | undefined {
  const value = run.recovery?.approvedSourceDrift;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const phase = (value as { resumePhase?: unknown }).resumePhase;
  return phase === "REVIEW_PENDING" || phase === "LEADER_DECISION" ? phase : undefined;
}

function clearApprovedSourceDrift(recovery: RunRecord["recovery"]): RunRecord["recovery"] {
  if (recovery === undefined || recovery.approvedSourceDrift === undefined) return recovery;
  const remaining = { ...recovery };
  delete remaining.approvedSourceDrift;
  return Object.keys(remaining).length === 0 ? undefined : remaining;
}

function hasUnsafeTasksPathIssue(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): boolean {
  return error.issues.some((issue) => issue.path[0] === "tasksPath" && issue.message === "TASKS_PATH_UNSAFE");
}

function now(): string {
  return new Date().toISOString();
}

function currentAttempt(run: RunRecord | undefined): RunRecord["workerAttempts"][number] | undefined {
  return run?.workerAttempts.at(-1);
}

function artifactList(run: RunRecord): ArtifactRef[] {
  return [...new Map(
    runArtifactInventory(run).bindings.map((binding) => [
      `${binding.ref.relativePath}:${binding.ref.sha256}:${String(binding.ref.size)}`,
      binding.ref
    ])
  ).values()];
}

function publicRepairDraft(run: RunRecord): ResultOutput["repairDraft"] {
  const draft = run.recovery?.repairDraft;
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) return undefined;
  const parsed = resultOutputSchema.shape.repairDraft.safeParse(draft);
  return parsed.success ? parsed.data : undefined;
}

function publicPublishOutcome(run: RunRecord): ResultOutput["publishOutcome"] {
  if (run.publish === undefined) return undefined;
  const parsed = resultOutputSchema.shape.publishOutcome.safeParse(run.publish);
  return parsed.success ? parsed.data : undefined;
}

function publicPublishPrecheck(run: RunRecord): ResultOutput["publishPrecheck"] {
  const precheck = run.recovery?.publishPrecheck;
  const parsed = resultOutputSchema.shape.publishPrecheck.safeParse(precheck);
  return parsed.success ? parsed.data : undefined;
}

function resultStatus(run: RunRecord): ResultOutput["status"] {
  if (run.phase === "CANCELED") return "CANCELED";
  if (run.phase === "FAILED") return "FAILED";
  if (run.phase === "COMPLETED") {
    return run.publish?.status === "COMMITTED" ? "COMMITTED" : "FAILED";
  }
  if (run.phase === "PAUSED") {
    if (
      run.pause?.code === "PUBLISH_ADAPTER_UNAVAILABLE" ||
      run.pause?.code === "MANUAL_PUBLISH_TARGET_MISMATCH"
    ) return "MANUAL_PUBLISH_REQUIRED";
    if (run.pause?.code === "PUBLISH_PRECHECK_CONFLICT") return "PRECHECK_CONFLICT";
    if (run.pause?.code === "PUBLISH_RECOVERY_BLOCKED") return "PUBLISH_RECOVERY_BLOCKED";
    return "PAUSED";
  }
  return "RUNNING";
}

type ResumeSchedule = "pipeline" | "review" | "publish" | "cancel" | "recover" | "none";

function closedResumeRoute(
  run: RunRecord,
  action: ResumeInput["resumeAction"]
): { phase: RunRecord["phase"]; schedule: ResumeSchedule } | undefined {
  const code = run.pause?.code;
  switch (action) {
    case "cancel":
      return { phase: "CANCELING", schedule: "cancel" };
    case "retry_host_review":
      return code === "HOST_REVIEW_UNAVAILABLE" && publicAction(run.pendingAction)?.type === "REVIEW"
        ? { phase: "REVIEW_PENDING", schedule: "review" }
        : undefined;
    case "retry_publish":
      return (new Set([
        "PUBLISH_ADAPTER_UNAVAILABLE",
        "PUBLISH_PRECHECK_CONFLICT",
        "PUBLISH_RECOVERY_BLOCKED",
        "PROJECT_PUBLISH_BUSY"
      ]).has(code ?? "") || (
        code === "RUNTIME_STAGE_FAILED" && run.lastError?.stage === "publish"
      ))
        ? { phase: "READY_TO_PUBLISH", schedule: "publish" }
        : undefined;
    case "confirm_manual_publish":
      return run.publish === undefined && new Set([
        "PUBLISH_ADAPTER_UNAVAILABLE",
        "PUBLISH_PRECHECK_CONFLICT",
        "MANUAL_PUBLISH_TARGET_MISMATCH"
      ]).has(code ?? "")
        ? { phase: "READY_TO_PUBLISH", schedule: "publish" }
        : undefined;
    case "retry_cancel":
      return new Set(["PAUSED_PROCESS_RECONCILIATION", "CANCEL_RETRY_REQUIRED"]).has(code ?? "")
        ? { phase: "CANCELING", schedule: "cancel" }
        : undefined;
    case "retry_provider_probe":
      return code === "PROVIDER_UNAVAILABLE"
        ? { phase: "PREPARING", schedule: "pipeline" }
        : undefined;
    case "retry_git_probe":
      return code?.startsWith("GIT_") === true
        ? { phase: "PREPARING", schedule: "pipeline" }
        : undefined;
    case "retry_provider":
      return currentAttempt(run) !== undefined && new Set([
        "PAUSED_PROCESS_RECONCILIATION",
        "PROVIDER_ERROR",
        "PROVIDER_UNAVAILABLE",
        "PI_PROVIDER_FAILED",
        "PI_PROCESS_EXITED",
        "ATTEMPT_DEADLINE_EXCEEDED"
      ]).has(code ?? "")
        ? { phase: "PREPARING", schedule: "pipeline" }
        : undefined;
    case "restore_approved_tasks":
      if (code !== "APPROVED_SOURCE_DRIFT") return undefined;
      {
        const reviewPhase = approvedSourceDriftResumePhase(run);
        if (reviewPhase !== undefined) {
          return {
            phase: reviewPhase,
            schedule: reviewPhase === "REVIEW_PENDING" ? "review" : "none"
          };
        }
      }
      return currentAttempt(run) === undefined
        ? { phase: "PREPARING", schedule: "pipeline" }
        : { phase: "PREPARING", schedule: "pipeline" };
    case "retry":
    case "approve_new_manifest_revision":
      return undefined;
  }
}

function resumeSchedule(
  action: ResumeInput["resumeAction"],
  phase: RunRecord["phase"]
): ResumeSchedule {
  switch (action) {
    case "approve_new_manifest_revision":
    case "retry_provider_probe":
    case "retry_git_probe":
      return "pipeline";
    case "restore_approved_tasks":
      return phase === "PREPARING"
        ? "pipeline"
        : phase === "REVIEW_PENDING"
          ? "review"
          : phase === "LEADER_DECISION"
            ? "none"
            : "recover";
    case "retry_publish":
    case "confirm_manual_publish":
      return "publish";
    case "retry_cancel":
    case "cancel":
      return "cancel";
    case "retry_provider":
      return "pipeline";
    case "resume_review_decision":
      return phase === "FIXING"
        ? "pipeline"
        : phase === "READY_TO_PUBLISH"
          ? "publish"
          : "none";
    case "retry_host_review":
      return "review";
    case "retry":
      return "none";
  }
}

// Durable action lists still carry read-only markers such as inspect_* that no public
// tool accepts, so the public result projection advertises only submittable actions.
function publicActions(actions: readonly string[] | undefined): string[] {
  return (actions ?? []).filter((action) => resumeActionSchema.safeParse(action).success);
}

function publicAction(value: Record<string, unknown> | undefined): HostAction | undefined {
  if (value === undefined) return undefined;
  const selected = value.type === "REVIEW"
    ? {
        type: value.type,
        actionId: value.actionId,
        revision: value.revision,
        taskSourceHash: value.taskSourceHash,
        candidateHash: value.candidateHash,
        reviewAttemptId: value.reviewAttemptId,
        changedPaths: value.changedPaths,
        reviewerSession: value.reviewerSession,
        piSessionId: value.piSessionId,
        expiresAt: value.expiresAt
      }
    : value;
  const parsed = hostActionSchema.safeParse(selected);
  return parsed.success ? parsed.data : undefined;
}

export class ProjectRuntime {
  private readonly projectsDirectory: string;
  private readonly background = new Map<string, Promise<void>>();
  private readonly runtimeEpochId = randomUUID();
  private readonly providerRuntimeConfig: Readonly<Record<string, unknown>>;
  private readonly hostTurns: HostTurnCoordinator;

  public constructor(private readonly options: ProjectRuntimeOptions) {
    this.projectsDirectory = resolve(options.dataDirectory, "projects");
    this.providerRuntimeConfig = options.providerRuntimeConfig ?? Object.freeze({});
    this.hostTurns = new HostTurnCoordinator({
      store: (projectId): StateStore => this.store(projectId),
      status: (input): Promise<unknown> => this.status(input),
      resume: (input, internalOptions): Promise<unknown> => this.resume(input, internalOptions),
      result: (input): Promise<unknown> => this.result(input),
      schedule: ({ projectId, jobId, state, kind }): void => {
        const store = this.store(projectId);
        this.schedule(this.pipelineContext(store, projectId, jobId, state), kind);
      }
    });
  }

  public readonly handle: IpcRequestHandler = async (request: IpcRequest): Promise<unknown> => {
    if (request.method === "smartflow_health") {
      return { protocolVersion: SMARTFLOW_IPC_PROTOCOL, ready: true };
    }
    switch (request.method) {
      case "smartflow_execute":
        {
          const parsed = executeInputSchema.safeParse(request.payload);
          if (!parsed.success) {
            if (hasUnsafeTasksPathIssue(parsed.error)) {
              throw new ProjectRuntimeError("TASKS_PATH_UNSAFE", "tasksPath must be Project-relative without parent traversal");
            }
            throw parsed.error;
          }
          return this.execute(parsed.data, request.providerRuntimeConfigHash);
        }
      case "smartflow_status":
        return this.status(statusInputSchema.parse(request.payload));
      case "smartflow_review_turn":
        return this.hostTurns.turn(reviewTurnInputSchema.parse(request.payload));
      case "smartflow_resume":
        {
          const parsed = resumeInputSchema.safeParse(request.payload);
          if (!parsed.success) {
            if (hasUnsafeTasksPathIssue(parsed.error)) {
              throw new ProjectRuntimeError("TASKS_PATH_UNSAFE", "tasksPath must be Project-relative without parent traversal");
            }
            throw parsed.error;
          }
          return this.resume(parsed.data);
        }
      case "smartflow_cancel":
        return this.cancel(cancelInputSchema.parse(request.payload));
      case "smartflow_result":
        return this.result(resultInputSchema.parse(request.payload));
      default:
        throw new ProjectRuntimeError("DAEMON_METHOD_UNAVAILABLE", `Unknown method: ${request.method}`);
    }
  };

  public async recover(): Promise<void> {
    const entries = await readdir(this.projectsDirectory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^project-[a-f0-9]{40}$/u.test(entry.name)) continue;
      const store = this.store(entry.name);
      const initial = await store.migrateState();
      for (const run of Object.values(initial.runs)) {
        if (new Set(["COMPLETED", "CANCELED", "FAILED"]).has(run.phase)) {
          await cleanupGitRunTemporaryState(store.dataDirectory, run);
        }
      }
      for (const jobId of Object.values(initial.activeRunsByTaskPath)) {
        const state = await store.readState();
        const run = state.runs[jobId];
        if (run === undefined) continue;
        const epoch = await new ProjectMutationExecutor(store).mutate(
        {
          requestId: `runtime-epoch:${this.runtimeEpochId}:${state.projectId}:${jobId}`,
          payload: { kind: "runtime-epoch", runtimeEpochId: this.runtimeEpochId, jobId },
          expectedStateVersion: state.stateVersion,
          expectedJobId: run.jobId,
          expectedRevision: run.revision,
          expectedPhases: [run.phase],
          advanceFence: true
        },
        (current) => ({
          nextState: current,
          response: { projectId: current.projectId, runtimeEpochId: this.runtimeEpochId }
        })
        );
        const recoveredState = epoch.state;
        const recoveredRun = recoveredState.runs[run.jobId];
        if (
          recoveredRun === undefined ||
          (recoveredRun.hostTurn !== undefined &&
            !isDaemonReviewerHostTurn(recoveredRun.hostTurn))
        ) continue;
        const context = this.pipelineContext(
          store,
          recoveredState.projectId,
          run.jobId,
          recoveredState
        );
        if (this.options.recover !== undefined) {
          this.schedule(context, "recover");
        } else if (recoveredRun.phase === "PREPARING") {
          this.schedule(context, "pipeline");
        } else if (
          recoveredRun.phase === "REVIEW_PENDING" ||
          (recoveredRun.phase === "REVIEWING" &&
            isDaemonReviewerHostTurn(recoveredRun.hostTurn))
        ) {
          this.schedule(context, "review");
        } else if (recoveredRun.phase === "READY_TO_PUBLISH") {
          this.schedule(context, "publish");
        } else if (recoveredRun.phase === "CANCELING") {
          this.schedule(context, "cancel");
        }
      }
    }
  }

  public async execute(
    input: ExecuteInput,
    providerRuntimeConfigHash?: string
  ): Promise<unknown> {
    const providerRuntimeConfig = this.resolveProviderRuntimeConfig(providerRuntimeConfigHash);
    const canonicalRoot = await realpath(input.projectRoot);
    const { canonicalPath: canonicalTasksPath, sourceBytes } = await readProjectTasksFile(
      canonicalRoot,
      input.tasksPath
    );
    if (sha256Bytes(sourceBytes) !== input.approvedSourceHash.replace(/^sha256:/u, "")) {
      throw new ProjectRuntimeError("APPROVED_SOURCE_DRIFT", "tasks source differs from the approved hash");
    }
    const projectId = projectIdForRoot(canonicalRoot);
    const store = this.store(projectId);
    await store.initialize({
      schemaVersion: 6,
      projectId,
      canonicalProjectRoot: canonicalRoot,
      stateVersion: 0,
      projectFence: 0,
      activeRunsByTaskPath: {},
      publishLease: null,
      runs: {},
      processedRequests: {},
      updatedAt: now()
    });
    const mutation = await this.mutate(
      store,
      input.requestId,
      providerRuntimeConfigHash === undefined
        ? input
        : { ...input, providerRuntimeConfigHash },
      input.expectedStateVersion,
      undefined,
      async (state, nextStateVersion, fence) => {
        const activeJobId = state.activeRunsByTaskPath[canonicalTasksPath];
        if (activeJobId !== undefined) {
          throw new ProjectRuntimeError("TASK_ALREADY_ACTIVE", `Task file already has active run ${activeJobId}`);
        }
        const jobId = `job-${randomUUID()}`;
        const logicalTaskPath = relative(canonicalRoot, canonicalTasksPath).split(sep).join("/");
        const compiled = compileTaskManifest(sourceBytes, {
          projectId,
          jobId,
          revision: 1,
          canonicalTaskPath: logicalTaskPath,
          providerRuntimeConfig,
          approval: {
            kind: "USER",
            approvedAt: now(),
            parentRevision: null,
            authorizedCriterionIds: []
          }
        });
        if (
          providerRuntimeConfigHash !== undefined &&
          compiled.manifest.providerRuntimeConfigHash !== providerRuntimeConfigHash
        ) {
          throw new ProjectRuntimeError(
            "PROVIDER_CONFIG_UNAVAILABLE",
            `Registered Provider configuration does not match ${providerRuntimeConfigHash}`
          );
        }
        const taskManifest = await store.writeArtifact(
          `runs/${jobId}/revision-1/task-manifest.json`,
          compiled.artifactBytes
        );
        const taskSource = await store.writeArtifact(
          `runs/${jobId}/revision-1/task-source.md`,
          sourceBytes
        );
        if (taskSource.sha256 !== compiled.manifest.taskSourceArtifact.sha256) {
          throw new ProjectRuntimeError("TASK_SOURCE_BINDING_FAILED", "Task source Artifact hash mismatch");
        }
        const timestamp = now();
        const run: RunRecord = {
          jobId,
          canonicalTaskPath: canonicalTasksPath,
          fence,
          phase: "PREPARING",
          revision: 1,
          taskManifest,
          taskSource,
          approvedTasks: {
            path: resolve(store.dataDirectory, taskSource.relativePath),
            sourceHash: compiled.manifest.sourceHash
          },
          workerAttempts: [],
          noProgressCount: 0,
          autoRepairRounds: 0,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        return {
          nextState: {
            ...state,
            activeRunsByTaskPath: {
              ...state.activeRunsByTaskPath,
              [canonicalTasksPath]: jobId
            },
            runs: { ...state.runs, [jobId]: run }
          },
          response: {
            projectId,
            jobId,
            revision: 1,
            stateVersion: nextStateVersion,
            phase: "PREPARING" as const
          }
        };
      }
    );
    const response = mutation.response as { jobId: string };
    if (!mutation.replayed) {
      this.schedule(this.pipelineContext(store, projectId, response.jobId, mutation.state), "pipeline");
    }
    return mutation.response;
  }

  public async status(input: { projectId: string; jobId: string }): Promise<RunSummary> {
    const store = this.store(input.projectId);
    const state = await store.readState();
    const run = state.runs[input.jobId];
    if (run === undefined) throw new ProjectRuntimeError("RUN_NOT_FOUND", `Unknown run: ${input.jobId}`);
    const artifactFailure = await verifyRunArtifacts(store, run);
    if (artifactFailure !== undefined) {
      throw new ProjectRuntimeError("ARTIFACT_INTEGRITY_BLOCKED", artifactFailure);
    }
    return {
      projectId: state.projectId,
      jobId: run.jobId,
      phase: run.phase,
      revision: run.revision,
      stateVersion: state.stateVersion,
      ...(run.pause === undefined ? {} : { pause: run.pause }),
      ...(publicAction(run.pendingAction) === undefined ? {} : { pendingAction: publicAction(run.pendingAction) }),
      ...(currentAttempt(run) === undefined ? {} : { activeAttempt: currentAttempt(run) }),
      ...(run.lastError === undefined ? {} : { lastError: run.lastError })
    };
  }

  private async resume(
    input: ReturnType<typeof resumeInputSchema.parse>,
    internalOptions: {
      clearHostTurn?: boolean;
      expectedHostTurnToken?: string;
    } = {}
  ): Promise<unknown> {
    const store = this.store(input.projectId);
    const mutationPayload = Object.keys(internalOptions).length === 0
      ? input
      : { ...input, internalOptions };
    const mutation = await this.mutate(
      store,
      input.requestId,
      mutationPayload,
      input.expectedStateVersion,
      input.expectedRevision,
      async (state, nextStateVersion) => {
        const run = state.runs[input.jobId];
        if (run === undefined) {
          throw new ProjectRuntimeError("RUN_NOT_FOUND", `Unknown run: ${input.jobId}`);
        }
        this.assertHostTurnAuthority(run, internalOptions.expectedHostTurnToken);
        if (run.phase !== "PAUSED") {
          throw new ProjectRuntimeError("RESUME_NOT_ALLOWED", "Run is not paused");
        }
        if (!run.pause?.resumeActions.includes(input.resumeAction)) {
          throw new ProjectRuntimeError("RESUME_ACTION_NOT_ALLOWED", "Resume action is not available for this pause");
        }
        const hasRevisionPayload = input.tasksPath !== undefined ||
          input.approval !== undefined ||
          input.approvedSourceHash !== undefined;
        if (hasRevisionPayload && input.resumeAction !== "approve_new_manifest_revision") {
          throw new ProjectRuntimeError(
            "RESUME_ACTION_PAYLOAD_MISMATCH",
            "Revision approval fields require approve_new_manifest_revision"
          );
        }
        let revisionSource: Awaited<ReturnType<typeof readProjectTasksFile>> | undefined;
        if (input.resumeAction === "approve_new_manifest_revision") {
          if (input.approval === undefined) {
            throw new ProjectRuntimeError("REVISION_APPROVAL_INCOMPLETE", "New Revision requires approval");
          }
          if (input.approval.kind === "LEADER_REPAIR") {
            const draft = publicRepairDraft(run);
            if (
              draft === undefined ||
              draft.approval.kind !== "LEADER_REPAIR" ||
              draft.approval.parentRevision !== input.approval.parentRevision ||
              canonicalHash(draft.approval.authorizedCriterionIds) !==
                canonicalHash(input.approval.authorizedCriterionIds)
            ) {
              throw new ProjectRuntimeError(
                "REPAIR_APPROVAL_MISMATCH",
                "Leader repair approval does not bind the durable internal repair task"
              );
            }
            revisionSource = {
              canonicalPath: run.canonicalTaskPath,
              sourceBytes: Buffer.from(await store.readArtifact(draft.sourceArtifact))
            };
          } else {
            if (input.tasksPath === undefined || input.approvedSourceHash === undefined) {
              throw new ProjectRuntimeError(
                "REVISION_APPROVAL_INCOMPLETE",
                "User Revision requires tasksPath, hash, and approval"
              );
            }
            revisionSource = await readProjectTasksFile(state.canonicalProjectRoot, input.tasksPath);
          }
        }
        if (input.resumeAction !== "retry_cancel" && input.resumeAction !== "cancel") {
          await this.assertRunArtifacts(store, state, input.jobId);
        }
        if (input.resumeAction === "restore_approved_tasks") {
          const observation = await observeApprovedSource(state, input.jobId);
          if (!observation.matches) {
            throw new ProjectRuntimeError(
              "APPROVED_SOURCE_DRIFT",
              "Approved tasks source has not been restored"
            );
          }
        }
        if (input.resumeAction === "approve_new_manifest_revision") {
          if (revisionSource === undefined || input.approval === undefined) {
            throw new ProjectRuntimeError(
              "REVISION_APPROVAL_INCOMPLETE",
              "New Revision requires source and approval"
            );
          }
          const previous = taskManifestSchema.parse(JSON.parse(
            new TextDecoder().decode(await store.readArtifact(run.taskManifest))
          ));
          const expectedSourceHash = input.approval.kind === "LEADER_REPAIR"
            ? publicRepairDraft(run)?.sourceHash
            : input.approvedSourceHash;
          if (expectedSourceHash === undefined) {
            throw new ProjectRuntimeError(
              "REVISION_APPROVAL_INCOMPLETE",
              "New Revision requires an approved source hash"
            );
          }
          const clean = await createApprovedRevision({
            store,
            state,
            run,
            sourceBytes: revisionSource.sourceBytes,
            sourcePath: revisionSource.canonicalPath,
            expectedSourceHash,
            approval: input.approval,
            providerRuntimeConfig: this.resolveProviderRuntimeConfig(
              previous.providerRuntimeConfigHash
            ),
            fail: (code, message): never => {
              throw new ProjectRuntimeError(code, message);
            }
          });
          return {
            nextState: { ...state, runs: { ...state.runs, [run.jobId]: clean } },
            response: {
              projectId: state.projectId,
              jobId: run.jobId,
              revision: clean.revision,
              stateVersion: nextStateVersion,
              phase: clean.phase
            }
          };
        }
        if (input.resumeAction === "resume_review_decision") {
          if (
            run.pause.code !== "AUTOMATIC_REPAIR_LIMIT" ||
            run.review === undefined
          ) {
            throw new ProjectRuntimeError(
              "RESUME_CODE_ACTION_MISMATCH",
              `${run.pause.code} cannot execute ${input.resumeAction}`
            );
          }
          const finalized = await new ReviewCoordinator(store).finalizeStoredReview(
            state,
            run.jobId,
            nextStateVersion,
            { repairRounds: 0, resetAutoRepairRounds: true }
          );
          return {
            nextState: finalized.nextState,
            response: {
              projectId: state.projectId,
              jobId: run.jobId,
              revision: run.revision,
              stateVersion: nextStateVersion,
              phase: finalized.response.phase
            }
          };
        }
        const route = closedResumeRoute(run, input.resumeAction);
        if (route === undefined) {
          throw new ProjectRuntimeError(
            "RESUME_CODE_ACTION_MISMATCH",
            `${run.pause.code} cannot execute ${input.resumeAction}`
          );
        }
        const phase = route.phase;
        const retriedReviewAction = input.resumeAction === "retry_host_review"
          ? publicAction(run.pendingAction)
          : undefined;
        if (input.resumeAction === "retry_host_review" && retriedReviewAction?.type !== "REVIEW") {
          throw new ProjectRuntimeError("REVIEW_RETRY_ACTION_MISSING", "No durable review action is available to retry");
        }
        const resumedRecovery = input.resumeAction === "restore_approved_tasks"
          ? clearApprovedSourceDrift(run.recovery)
          : run.recovery;
        const previousManualConfirmation = run.recovery?.manualPublishConfirmation;
        const previousManualRecord = typeof previousManualConfirmation === "object" &&
          previousManualConfirmation !== null &&
          !Array.isArray(previousManualConfirmation)
          ? previousManualConfirmation as Record<string, unknown>
          : undefined;
        const manualSourcePauseCode = run.pause.code === "MANUAL_PUBLISH_TARGET_MISMATCH" &&
          typeof previousManualRecord?.pauseCode === "string"
          ? previousManualRecord.pauseCode
          : run.pause.code;
        const nextRecovery = input.resumeAction === "confirm_manual_publish"
          ? {
              ...resumedRecovery,
              manualPublishConfirmation: {
                status: "REQUESTED",
                revision: run.revision,
                pauseCode: manualSourcePauseCode,
                requestId: input.requestId,
                requestedAt: now()
              }
            }
          : resumedRecovery;
        return {
          nextState: {
            ...state,
            runs: {
              ...state.runs,
              [run.jobId]: {
                ...run,
                phase,
                pause: undefined,
                lastError: undefined,
                ...(input.resumeAction === "cancel"
                  ? {
                      cancellation: {
                        reason: "pause resume action",
                        requestedAt: now(),
                        status: "REQUESTED"
                      }
                    }
                  : {}),
                ...(input.resumeAction === "restore_approved_tasks" ||
                  input.resumeAction === "confirm_manual_publish"
                    ? { recovery: nextRecovery }
                    : {}),
                ...(retriedReviewAction?.type === "REVIEW"
                  ? {
                      pendingAction: {
                        ...retriedReviewAction,
                        actionId: `review-action-${randomUUID()}`,
                        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
                      }
                    }
                  : {}),
                ...(internalOptions.clearHostTurn === true ? { hostTurn: undefined } : {}),
                updatedAt: now()
              }
            }
          },
          response: {
            projectId: state.projectId,
            jobId: run.jobId,
            revision: run.revision,
            stateVersion: nextStateVersion,
            phase
          }
        };
      });
    if (!mutation.replayed) {
      const response = mutation.response as { phase: RunRecord["phase"] };
      const schedule = resumeSchedule(input.resumeAction, response.phase);
      if (schedule !== "none") {
        this.schedule(
          this.pipelineContext(store, input.projectId, input.jobId, mutation.state),
          schedule
        );
      }
    }
    return mutation.response;
  }

  private async cancel(input: CancelInput): Promise<unknown> {
    const store = this.store(input.projectId);
    const mutation = await this.mutate(store, input.requestId, input, input.expectedStateVersion, input.expectedRevision,
      (state, nextStateVersion) => {
        const run = state.runs[input.jobId];
        if (run === undefined) throw new ProjectRuntimeError("RUN_NOT_FOUND", input.jobId);
        this.assertCancelAuthority(run, input.hostTurnId);
        const nextRun: RunRecord = {
          ...run,
          phase: "CANCELING",
          pause: undefined,
          hostTurn: undefined,
          cancellation: { reason: input.reason, requestedAt: now(), status: "REQUESTED" },
          updatedAt: now()
        };
        return {
          nextState: { ...state, runs: { ...state.runs, [run.jobId]: nextRun } },
          response: {
            projectId: state.projectId,
            jobId: run.jobId,
            revision: run.revision,
            stateVersion: nextStateVersion,
            phase: "CANCELING" as const
          }
        };
      });
    if (!mutation.replayed) {
      this.schedule(this.pipelineContext(store, input.projectId, input.jobId, mutation.state), "cancel");
    }
    return mutation.response;
  }

  private async result(input: { projectId: string; jobId: string }): Promise<ResultOutput> {
    const store = this.store(input.projectId);
    const state = await store.readState();
    const run = state.runs[input.jobId];
    if (run === undefined) throw new ProjectRuntimeError("RUN_NOT_FOUND", input.jobId);
    const artifactFailure = await verifyRunArtifacts(store, run);
    if (artifactFailure !== undefined) {
      throw new ProjectRuntimeError("ARTIFACT_INTEGRITY_BLOCKED", artifactFailure);
    }
    const status = resultStatus(run);
    // Inline the latest durable Review so a caller reads per-Task completion and
    // issues without filesystem access. A damaged artifact degrades to no Review
    // rather than failing the whole projection.
    const durableReview = run.review === undefined
      ? undefined
      : durableReviewDecisionSchema.safeParse(JSON.parse(
          new TextDecoder().decode(await store.readArtifact(run.review))
        ));
    return {
      projectId: state.projectId,
      jobId: run.jobId,
      phase: run.phase,
      status,
      artifacts: artifactList(run),
      nextActions: publicActions(run.pause?.resumeActions),
      ...(durableReview?.success === true
        ? { review: durableReview.data.gate.result }
        : {}),
      ...(publicRepairDraft(run) === undefined ? {} : { repairDraft: publicRepairDraft(run) }),
      ...(publicPublishOutcome(run) === undefined ? {} : { publishOutcome: publicPublishOutcome(run) }),
      ...(publicPublishPrecheck(run) === undefined
        ? {}
        : { publishPrecheck: publicPublishPrecheck(run) }),
      ...(run.lastError === undefined
        ? {}
        : { error: { ...run.lastError, nextActions: publicActions(run.lastError.nextActions) } })
    };
  }

  private store(projectId: string): StateStore {
    if (!/^project-[a-f0-9]{40}$/u.test(projectId)) {
      throw new ProjectRuntimeError("PROJECT_ID_INVALID", "Invalid projectId");
    }
    return new StateStore(resolve(this.projectsDirectory, projectId));
  }

  // Cancellation stays owner-bound: a caller that cannot name the active turn must
  // not abort someone else's Run. Supplying the owning hostTurnId lets that Host
  // cancel out of turn instead of having to drive a full composite turn first.
  private assertCancelAuthority(run: RunRecord, hostTurnId: string | undefined): void {
    const hostTurn = run.hostTurn;
    if (hostTurn === undefined || isDaemonReviewerHostTurn(hostTurn)) return;
    if (hostTurnId !== undefined && hostTurn.hostTurnId === hostTurnId) return;
    throw new ProjectRuntimeError(
      "HOST_TURN_ACTIVE",
      "Run is owned by an active composite Host turn"
    );
  }

  private assertHostTurnAuthority(
    run: RunRecord,
    expectedHostTurnToken: string | undefined,
    expectedHostTurnId?: string
  ): void {
    const hostTurn = run.hostTurn;
    if (hostTurn === undefined) return;
    if (expectedHostTurnToken === undefined) {
      throw new ProjectRuntimeError(
        "HOST_TURN_ACTIVE",
        "Run is owned by an active composite Host turn"
      );
    }
    if (
      hostTurn.turnToken !== expectedHostTurnToken ||
      (expectedHostTurnId !== undefined && hostTurn.hostTurnId !== expectedHostTurnId)
    ) {
      throw new ProjectRuntimeError(
        "HOST_TURN_AUTHORITY_MISMATCH",
        "Composite Host turn authority no longer matches durable state"
      );
    }
  }

  private async assertRunArtifacts(
    store: StateStore,
    state: ProjectState,
    jobId: string
  ): Promise<RunRecord> {
    const run = state.runs[jobId];
    if (run === undefined) throw new ProjectRuntimeError("RUN_NOT_FOUND", `Unknown run: ${jobId}`);
    const failure = await verifyRunArtifacts(store, run);
    if (failure !== undefined) {
      throw new ProjectRuntimeError("ARTIFACT_INTEGRITY_BLOCKED", failure);
    }
    return run;
  }

  private pipelineContext(
    store: StateStore,
    projectId: string,
    jobId: string,
    state: ProjectState
  ): ProjectPipelineContext {
    const run = state.runs[jobId];
    if (run === undefined) throw new ProjectRuntimeError("RUN_NOT_FOUND", jobId);
    const attempt = currentAttempt(run);
    return {
      store,
      projectId,
      jobId,
      expectedFence: run.fence,
      expectedRevision: run.revision,
      ...(attempt === undefined ? {} : {
        expectedGeneration: attempt.generation,
        expectedAttemptId: attempt.attemptId
      })
    };
  }

  private schedule(
    context: ProjectPipelineContext,
    kind: "pipeline" | "review" | "publish" | "cancel" | "recover"
  ): void {
    const key = `${context.projectId}:${context.jobId}:${kind}`;
    if (this.background.has(key)) return;
    const callback = kind === "pipeline"
      ? this.options.runPipeline
      : kind === "review"
        ? this.options.review
        : kind === "publish"
          ? this.options.publish
          : kind === "cancel"
            ? this.options.cancel
            : this.options.recover;
    const task = (callback === undefined
      ? this.pauseUnavailable(context, kind)
      : callback(context)
    ).catch((error: unknown) => this.pauseFailure(context, kind, error)).finally(() => {
      this.background.delete(key);
    });
    this.background.set(key, task);
  }

  private resolveProviderRuntimeConfig(
    providerRuntimeConfigHash: string | undefined
  ): Readonly<Record<string, unknown>> {
    if (providerRuntimeConfigHash === undefined) return this.providerRuntimeConfig;
    const resolved = this.options.resolveProviderRuntimeConfig?.(providerRuntimeConfigHash);
    if (resolved !== undefined) return resolved;
    if (this.options.resolveProviderRuntimeConfig === undefined) {
      return this.providerRuntimeConfig;
    }
    throw new ProjectRuntimeError(
      "PROVIDER_CONFIG_UNAVAILABLE",
      `Provider configuration is not registered: ${providerRuntimeConfigHash}`
    );
  }

  private pauseUnavailable(context: ProjectPipelineContext, kind: string): Promise<void> {
    return Promise.reject(
      new ProjectRuntimeError(
        "RUNTIME_STAGE_UNAVAILABLE",
        `${kind} runtime is unavailable for ${context.jobId}`
      )
    );
  }

  private async pauseFailure(context: ProjectPipelineContext, stage: string, error: unknown): Promise<void> {
    const state = await context.store.readState();
    const run = state.runs[context.jobId];
    const attempt = currentAttempt(run);
    if (
      run === undefined ||
      run.fence !== context.expectedFence ||
      run.revision !== context.expectedRevision ||
      (context.expectedGeneration !== undefined &&
        attempt?.generation !== context.expectedGeneration) ||
      (context.expectedAttemptId !== undefined &&
        attempt?.attemptId !== context.expectedAttemptId) ||
      new Set(["PAUSED", "CANCELING", "COMPLETED", "CANCELED", "FAILED"]).has(run.phase)
    ) return;
    const message = redactPiValue(
      error instanceof Error ? error.message : String(error),
      [state.canonicalProjectRoot, context.store.dataDirectory, homedir()]
    ) as string;
    const resumeActions = stage === "publish"
      ? ["retry_publish", "cancel"] as const
      : stage === "review"
        ? ["retry_host_review", "cancel"] as const
        : ["retry", "cancel"] as const;
    const failureCode = stage === "review"
      ? "HOST_REVIEW_UNAVAILABLE"
      : "RUNTIME_STAGE_FAILED";
    await new ProjectMutationExecutor(context.store).mutate<{
      ignored: boolean;
      phase: "PAUSED" | null;
    }>(
      {
        requestId: `runtime-failure:${run.jobId}:r${String(run.revision)}:${stage}:${canonicalHash(message)}`,
        payload: { stage, message },
        expectedJobId: run.jobId,
        expectedFence: context.expectedFence,
        expectedRevision: run.revision,
        ...(context.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: context.expectedGeneration }),
        ...(context.expectedAttemptId === undefined
          ? {}
          : { expectedAttemptId: context.expectedAttemptId }),
        expectedPhases: [run.phase]
      },
      (current) => {
        const active = current.runs[run.jobId];
        if (active === undefined || active.phase !== run.phase) {
          return { nextState: current, response: { ignored: true, phase: null } };
        }
        const updatedAt = now();
        return {
          nextState: {
            ...current,
            runs: {
              ...current.runs,
              [run.jobId]: {
                ...active,
                phase: "PAUSED",
                hostTurn: stage === "review" ? undefined : active.hostTurn,
                pause: { code: failureCode, resumeActions: [...resumeActions] },
                lastError: {
                  code: failureCode,
                  stage,
                  message,
                  retryable: true,
                  nextActions: [...resumeActions],
                  artifacts: []
                },
                updatedAt
              }
            }
          },
          response: { ignored: false, phase: "PAUSED" as const }
        };
      }
    );
  }

  private async mutate<T>(
    store: StateStore,
    requestId: string,
    payload: unknown,
    expectedStateVersion: number | undefined,
    expectedRevision: number | undefined,
    build: (
      state: ProjectState,
      nextStateVersion: number,
      fence: number
    ) => Promise<{ nextState: ProjectState; response: T }> | { nextState: ProjectState; response: T }
  ): Promise<MutationResult<T>> {
    const jobId = typeof payload === "object" && payload !== null &&
      typeof (payload as { jobId?: unknown }).jobId === "string"
      ? (payload as { jobId: string }).jobId
      : undefined;
    return new ProjectMutationExecutor(store).mutate(
      {
        requestId,
        payload,
        ...(expectedStateVersion === undefined ? {} : { expectedStateVersion }),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        ...(jobId === undefined ? {} : { expectedJobId: jobId })
      },
      async (state, context) => build(state, context.nextStateVersion, context.fence)
    );
  }
}
