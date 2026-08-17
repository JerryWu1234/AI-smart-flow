import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { StructuredLogger } from "@smartflow/observability";
import type { PublishServiceResult, WorkspaceApplyAdapter } from "@smartflow/publish";
import type { WorkerProvider } from "@smartflow/provider-core";
import type { ProjectState, RunRecord, WorkerAttempt } from "@smartflow/state-store";
import { taskManifestSchema } from "@smartflow/task-manifest";
import { ExecutionSandboxAdapter } from "@smartflow/workspace";

import { CancelManager, type CancellationRuntime } from "./cancel-manager.js";
import { ProjectMutationExecutor } from "./project-mutation-executor.js";
import type {
  ProviderRuntimeResolver,
  RegisteredProviderRuntime
} from "./provider-registry.js";
import type { ProjectPipelineContext } from "./project-runtime.js";
import { PublishCoordinator } from "./publish-coordinator.js";
import { RepairCoordinator } from "./repair-coordinator.js";
import {
  RecoveryManager,
  verifyRunArtifacts,
  type RecoveryRuntime
} from "./recovery-manager.js";
import { WorkerRunner } from "./worker-runner.js";

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function sourceHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function currentAttempt(run: RunRecord | undefined): WorkerAttempt | undefined {
  return run?.workerAttempts.at(-1);
}

function attemptDeadlineMs(config: Readonly<Record<string, unknown>>): number {
  const configuration = config.configuration;
  if (typeof configuration !== "object" || configuration === null || Array.isArray(configuration)) {
    return 1_800_000;
  }
  const value = (configuration as Record<string, unknown>).attemptDeadlineMs;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 1_800_000;
}

export class ProductionRuntimeComposition {
  public constructor(
    private readonly daemonDataDirectory: string,
    private readonly logger = new StructuredLogger("smartflow-runtime"),
    private readonly workspaceApplyAdapter?: WorkspaceApplyAdapter,
    private readonly provider?: WorkerProvider,
    private readonly providerRuntimeConfig: Readonly<Record<string, unknown>> = Object.freeze({}),
    private readonly providerRuntimeResolver?: ProviderRuntimeResolver
  ) {}

  private repairCoordinator(
    store: ProjectPipelineContext["store"],
    providerRuntimeConfig: Readonly<Record<string, unknown>>
  ): RepairCoordinator {
    return new RepairCoordinator(store, providerRuntimeConfig);
  }

  private async prepareRepairAndContinue(
    context: ProjectPipelineContext,
    providerRuntimeConfig: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const outcome = await this.repairCoordinator(
      context.store,
      providerRuntimeConfig
    ).prepare(context.jobId);
    if (outcome.phase !== "PREPARING") return;
    const state = await context.store.readState();
    const run = state.runs[context.jobId];
    if (run?.phase !== "PREPARING" || run.revision !== outcome.revision) return;
    await this.runPipeline(this.contextForRun(context, run));
  }

  public runPipeline = async (context: ProjectPipelineContext): Promise<void> => {
    if (!(await this.contextCurrent(context))) return;
    if (!(await this.approvedSourceCurrent(context))) return;
    const state = await context.store.readState();
    const run = state.runs[context.jobId];
    if (run === undefined) return;
    const manifest = taskManifestSchema.parse(JSON.parse(
      new TextDecoder().decode(await context.store.readArtifact(run.taskManifest))
    ));
    const providerRuntime = this.resolveProviderRuntime(manifest.providerRuntimeConfigHash);
    if (run.phase === "FIXING") {
      await this.prepareRepairAndContinue(
        context,
        providerRuntime.providerRuntimeConfig
      );
      return;
    }
    if (run.phase !== "PREPARING") return;
    const prompt = [
      "Implement the approved SmartFlow tasks in the current isolated workspace.",
      "You may modify any file inside this workspace and may use Pi's official coding and shell tools directly.",
      ...manifest.tasks.flatMap((task) => [
        `${task.id}: ${task.description}`,
        ...task.acceptanceCriteria.map((criterion) => `Acceptance: ${criterion}`)
      ]),
      "When the requested work is complete, answer briefly and stop."
    ].join("\n");
    const worker = await new WorkerRunner(context.store, providerRuntime.provider).run({
      jobId: context.jobId,
      revision: manifest.revision,
      prompt,
      providerRuntimeConfigHash: manifest.providerRuntimeConfigHash,
      attemptDeadlineMs: attemptDeadlineMs(providerRuntime.providerRuntimeConfig)
    });
    if (worker.phase === "FIXING") {
      await this.prepareRepairAndContinue(
        context,
        providerRuntime.providerRuntimeConfig
      );
    }
  };

  public publish = async (context: ProjectPipelineContext): Promise<void> => {
    if (!(await this.contextCurrent(context))) return;
    if (!(await this.approvedSourceCurrent(context))) return;
    const state = await context.store.readState();
    const run = state.runs[context.jobId];
    if (run === undefined) return;
    const artifactFailure = await verifyRunArtifacts(context.store, run);
    if (artifactFailure !== undefined) {
      throw new Error(`PUBLISH_ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
    }
    await new PublishCoordinator(
      context.store,
      this.workspaceApplyAdapter
    ).publish(context.jobId);
  };

  public cancel = async (context: ProjectPipelineContext): Promise<void> => {
    if (!(await this.contextCurrent(context))) return;
    await new CancelManager(context.store, this.cancellationRuntime(context)).reconcile(context.jobId);
  };

  public recover = async (context: ProjectPipelineContext): Promise<void> => {
    if (!(await this.contextCurrent(context))) return;
    const recoveryRuntime: RecoveryRuntime = {
      inspectWorker: (attempt) => this.inspectWorker(context, attempt),
      reconcilePublish: async (operationId, operationsHash) => {
        const result: PublishServiceResult = await new PublishCoordinator(
          context.store,
          this.workspaceApplyAdapter
        ).recover(context.jobId, operationId, operationsHash);
        if (result.status === "COMMITTED") return { status: "COMMITTED", result: result.result };
        if (result.status === "PUBLISH_RECOVERY_BLOCKED" && result.result?.status === "CONFLICT") {
          return { status: "CONFLICT", result: result.result };
        }
        return {
          status: "UNKNOWN",
          ...(result.status === "PUBLISH_RECOVERY_BLOCKED" ? { result: result.result } : {})
        };
      },
      continueCancellation: async () => {
        const result = await new CancelManager(
          context.store,
          this.cancellationRuntime(context)
        ).reconcile(context.jobId);
        return result.reconciled ? "CANCELED" : "BLOCKED";
      }
    };
    const result = await new RecoveryManager(context.store, recoveryRuntime).recover(context.jobId);
    if (result.action === "REBUILD_WORKSPACE" || result.action === "START_NEW_WORKER_ATTEMPT") {
      const state = await context.store.readState();
      const run = state.runs[context.jobId];
      if (run !== undefined) await this.runPipeline(this.contextForRun(context, run));
      return;
    }
    if (result.action === "PREPARE_REPAIR") {
      const providerRuntime = await this.providerRuntimeForRun(context);
      await this.repairCoordinator(
        context.store,
        providerRuntime.providerRuntimeConfig
      ).prepare(context.jobId);
      return;
    }
    if (result.action === "RECHECK_PUBLISH_READINESS") await this.publish(context);
  };

  private cancellationRuntime(context: ProjectPipelineContext): CancellationRuntime {
    return {
      stopWorker: async (attempt): Promise<boolean> => {
        if (attempt === undefined || !new Set(["PREPARING", "RUNNING"]).has(attempt.status)) {
          return true;
        }
        const providerRuntime = await this.providerRuntimeForRun(context).catch(() => undefined);
        const canceled = await providerRuntime?.provider.cancel(attempt.attemptId)
          .catch(() => undefined);
        if (canceled?.treeEmpty === true) return true;
        return this.stopPersistedAttempt(context, attempt);
      },
      revokeAction: () => Promise.resolve(true)
    };
  }

  private async inspectWorker(
    context: ProjectPipelineContext,
    attempt: WorkerAttempt | undefined
  ): Promise<"RESUMABLE" | "STOPPED" | "UNKNOWN"> {
    if (attempt === undefined || !new Set(["PREPARING", "RUNNING"]).has(attempt.status)) {
      return "STOPPED";
    }
    return (await this.stopPersistedAttempt(context, attempt)) ? "STOPPED" : "UNKNOWN";
  }

  private async stopPersistedAttempt(
    context: ProjectPipelineContext,
    attempt: WorkerAttempt
  ): Promise<boolean> {
    const registryPath = resolve(
      context.store.dataDirectory,
      "runs",
      context.jobId,
      `revision-${String(attempt.revision)}`,
      "pi-containments.json"
    );
    const adapter = new ExecutionSandboxAdapter(registryPath);
    const observed = adapter.query(attempt.attemptId);
    if (observed === "NOT_FOUND") return attempt.status === "PREPARING";
    if (observed === "EXITED") return true;
    if (observed !== "RUNNING") return false;
    const identity = adapter.inspect(attempt.attemptId);
    if (
      identity === undefined ||
      identity.containmentId !== attempt.containmentId ||
      identity.configHash !== attempt.providerRuntimeConfigHash ||
      identity.pid !== attempt.processIdentity?.pid ||
      identity.processStartToken !== attempt.processIdentity.startToken
    ) return false;
    return (await adapter.terminate(attempt.attemptId, identity)).treeEmpty;
  }

  private contextForRun(
    context: ProjectPipelineContext,
    run: RunRecord
  ): ProjectPipelineContext {
    const attempt = currentAttempt(run);
    return {
      store: context.store,
      projectId: context.projectId,
      jobId: context.jobId,
      expectedFence: run.fence,
      expectedRevision: run.revision,
      ...(attempt === undefined ? {} : {
        expectedGeneration: attempt.generation,
        expectedAttemptId: attempt.attemptId
      })
    };
  }

  private resolveProviderRuntime(providerRuntimeConfigHash: string): RegisteredProviderRuntime {
    const registered = this.providerRuntimeResolver?.(providerRuntimeConfigHash);
    if (registered !== undefined) return registered;
    if (this.providerRuntimeResolver === undefined && this.provider !== undefined) {
      return {
        daemonConfigFingerprint: "direct-pi-runtime",
        providerRuntimeConfigHash,
        providerRuntimeConfig: this.providerRuntimeConfig,
        provider: this.provider
      };
    }
    const error = new Error(`Provider configuration is not registered: ${providerRuntimeConfigHash}`);
    Object.assign(error, { code: "PROVIDER_CONFIG_UNAVAILABLE" });
    throw error;
  }

  private async providerRuntimeForRun(
    context: ProjectPipelineContext
  ): Promise<RegisteredProviderRuntime> {
    const state = await context.store.readState();
    const run = state.runs[context.jobId];
    if (run === undefined) throw new Error(`Run is unavailable: ${context.jobId}`);
    const manifest = taskManifestSchema.parse(JSON.parse(
      new TextDecoder().decode(await context.store.readArtifact(run.taskManifest))
    ));
    return this.resolveProviderRuntime(manifest.providerRuntimeConfigHash);
  }

  private async approvedSourceCurrent(context: ProjectPipelineContext): Promise<boolean> {
    const state = await context.store.readState();
    const run = state.runs[context.jobId];
    const path = stringField(run?.approvedTasks, "path");
    const approvedHash = stringField(run?.approvedTasks, "sourceHash");
    if (
      run === undefined ||
      !this.contextMatches(state, run, context) ||
      new Set(["PAUSED", "CANCELING", "COMPLETED", "CANCELED", "FAILED"]).has(run.phase) ||
      path === undefined ||
      approvedHash === undefined
    ) return false;
    const observed = await readFile(path).then(sourceHash).catch(() => "UNAVAILABLE");
    if (observed === approvedHash) return true;
    const attempt = currentAttempt(run);
    await new ProjectMutationExecutor(context.store).mutate(
      {
        requestId: `approved-source-drift:${run.jobId}:r${String(run.revision)}:${observed}`,
        payload: { approvedHash, observed },
        expectedJobId: run.jobId,
        expectedFence: context.expectedFence,
        expectedRevision: run.revision,
        ...(attempt === undefined ? {} : {
          expectedGeneration: attempt.generation,
          expectedAttemptId: attempt.attemptId
        }),
        expectedPhases: [run.phase]
      },
      (current) => {
        const active = current.runs[run.jobId];
        if (active === undefined) throw new Error("APPROVED_SOURCE_RUN_MISSING");
        const updatedAt = new Date().toISOString();
        return {
          nextState: {
            ...current,
            runs: {
              ...current.runs,
              [run.jobId]: {
                ...active,
                phase: "PAUSED",
                pause: {
                  code: "APPROVED_SOURCE_DRIFT",
                  resumeActions: ["approve_new_manifest_revision", "restore_approved_tasks", "cancel"]
                },
                updatedAt
              }
            }
          },
          response: { phase: "PAUSED", code: "APPROVED_SOURCE_DRIFT" }
        };
      }
    );
    this.logger.log({
      level: "warn",
      event: "runtime.approved_source_drift",
      data: { projectId: context.projectId, jobId: context.jobId, revision: run.revision }
    });
    return false;
  }

  private async contextCurrent(context: ProjectPipelineContext): Promise<boolean> {
    const state = await context.store.readState();
    const run = state.runs[context.jobId];
    return run !== undefined && this.contextMatches(state, run, context);
  }

  private contextMatches(
    state: ProjectState,
    run: RunRecord,
    context: ProjectPipelineContext
  ): boolean {
    const attempt = currentAttempt(run);
    return state.activeRunsByTaskPath[run.canonicalTaskPath] === context.jobId &&
      run.fence === context.expectedFence &&
      run.revision === context.expectedRevision &&
      (context.expectedGeneration === undefined || attempt?.generation === context.expectedGeneration) &&
      (context.expectedAttemptId === undefined || attempt?.attemptId === context.expectedAttemptId);
  }
}
