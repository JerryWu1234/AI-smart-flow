import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  WorkerRunner,
  resolveWorkerLaunchConfiguration,
  type ResolvedWorkerLaunchConfiguration
} from "@smartflow/daemon";
import { StructuredLogger } from "@smartflow/observability";
import { PiProvider, frozenPiRuntimeConfig } from "@smartflow/provider-pi";
import { StateStore } from "@smartflow/state-store";
import { compileTaskManifest } from "@smartflow/task-manifest";

export interface InstalledProviderGateResult {
  providerAvailable: boolean;
  phase: string;
  sourceUnchanged: boolean;
  candidateHash?: string;
  attemptCount: number;
  providerRuntimeConfigHash?: string;
  reason?: string;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function installedGateTasksSource(): string {
  return `# Installed Pi gate

## M13 · Installed runtime

- [ ] T044 [M13] Update \`sum.js\` — 验收：the Candidate exports the requested sum and subtract functions for Review
`;
}

export async function runInstalledPiGate(
  projectRoot: string,
  dataDirectory: string,
  configuration: ResolvedWorkerLaunchConfiguration = resolveWorkerLaunchConfiguration([]),
  logger = new StructuredLogger("smartflow-installed-gate")
): Promise<InstalledProviderGateResult> {
  const timer = logger.stage("installed-pi-gate", {
    projectId: "installed-gate",
    jobId: "job-1",
    revision: 1
  });
  const canonicalProject = resolve(projectRoot);
  const sourcePath = resolve(canonicalProject, "sum.js");
  const sourceHashBefore = hash(await readFile(sourcePath));
  const store = new StateStore(resolve(dataDirectory));
  const timestamp = new Date().toISOString();
  const tasksSource = installedGateTasksSource();
  const runtimeConfig = frozenPiRuntimeConfig(configuration.runtimeConfig);
  const compiled = compileTaskManifest(tasksSource, {
    projectId: "installed-gate",
    jobId: "job-1",
    revision: 1,
    canonicalTaskPath: "installed-provider-gate.tasks.md",
    providerRuntimeConfig: runtimeConfig,
    approval: {
      kind: "USER",
      approvedAt: timestamp,
      parentRevision: null,
      authorizedCriterionIds: []
    }
  });
  const taskManifest = await store.writeArtifact(
    "runs/job-1/revision-1/task-manifest.json",
    compiled.artifactBytes
  );
  const taskSource = await store.writeArtifact(
    "runs/job-1/revision-1/task-source.md",
    Buffer.from(tasksSource, "utf8")
  );
  await store.initialize({
    schemaVersion: 4,
    projectId: "installed-gate",
    canonicalProjectRoot: canonicalProject,
    stateVersion: 1,
    projectFence: 1,
    activeRunsByTaskPath: {
      [resolve(canonicalProject, "installed-provider-gate.tasks.md")]: "job-1"
    },
    publishLease: null,
    runs: {
      "job-1": {
        jobId: "job-1",
        canonicalTaskPath: resolve(canonicalProject, "installed-provider-gate.tasks.md"),
        fence: 1,
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
        createdAt: timestamp,
        updatedAt: timestamp
      }
    },
    processedRequests: {},
    updatedAt: timestamp
  });
  const provider = new PiProvider({
    runtimeConfig: configuration.runtimeConfig,
    environment: {
      SMARTFLOW_PI_API_KEY: configuration.credential
    }
  });
  const probe = await provider.probe();
  if (!probe.available) {
    timer.fail(probe.reason);
    return {
      providerAvailable: false,
      phase: "PAUSED",
      sourceUnchanged: hash(await readFile(sourcePath)) === sourceHashBefore,
      attemptCount: 0,
      reason: probe.reason
    };
  }
  const worker = await new WorkerRunner(store, provider).run({
    jobId: "job-1",
    revision: 1,
    providerRuntimeConfigHash: probe.providerRuntimeConfigHash,
    attemptDeadlineMs: configuration.runtimeConfig.attemptDeadlineMs,
    prompt: [
      "Modify sum.js in the isolated workspace.",
      "Keep sum(a, b) and add subtract(a, b) returning a - b.",
      "Use Pi's official coding tools directly, then stop."
    ].join("\n")
  });
  const finalRun = (await store.readState()).runs["job-1"];
  if (
    worker.candidate === undefined ||
    worker.phase !== "REVIEW_PENDING" ||
    finalRun?.pendingAction?.type !== "REVIEW"
  ) {
    const phase = finalRun?.phase ?? worker.phase;
    timer.fail(`Worker stopped in ${phase}`);
    return {
      providerAvailable: true,
      phase,
      sourceUnchanged: hash(await readFile(sourcePath)) === sourceHashBefore,
      attemptCount: finalRun?.workerAttempts.length ?? 0,
      providerRuntimeConfigHash: probe.providerRuntimeConfigHash,
      reason: `Worker stopped in ${phase}`
    };
  }
  const result: InstalledProviderGateResult = {
    providerAvailable: true,
    phase: worker.phase,
    sourceUnchanged: hash(await readFile(sourcePath)) === sourceHashBefore,
    candidateHash: worker.candidate.hash,
    attemptCount: finalRun.workerAttempts.length,
    providerRuntimeConfigHash: probe.providerRuntimeConfigHash
  };
  timer.complete({
    ...result,
    project: relative(canonicalProject, sourcePath).split(sep).join("/")
  });
  return result;
}
