import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { StructuredLogger } from "@smartflow/observability";
import {
  ClaudeCodeAdapter,
  ClaudeCodeDesktopAdapter,
  CodexAdapter,
  CodexDesktopAdapter,
  type AgentAdapter
} from "@smartflow/review";

import {
  resolveReviewEnabled,
  resolveReviewStrategy,
  resolveSmartFlowConfig,
  type ReviewStrategy
} from "./config/config.js";
import { resolveInstallationDataDirectory } from "./config/data-dir.js";
import { LocalIpcServer, type IpcRequestHandler } from "./transport/local-ipc-server.js";
import { ProviderRegistry } from "./runtime/provider-registry.js";
import { ProjectRuntime } from "./runtime/project-runtime.js";
import { ProductionRuntimeComposition } from "./runtime/runtime-composition.js";
import { resolveReviewerExecutable } from "./review/reviewer-executable.js";
import {
  resolveWorkerLaunchConfiguration,
  WORK_ENVIRONMENT_KEYS,
  type ResolvedWorkerLaunchConfiguration
} from "./config/worker-config.js";

const REVIEW_ADAPTER_FACTORIES = {
  "claude-code": (executable: string | undefined): AgentAdapter =>
    new ClaudeCodeAdapter(executable === undefined ? {} : { executable }),
  "claude-code-desktop": (executable: string | undefined): AgentAdapter =>
    new ClaudeCodeDesktopAdapter(executable === undefined ? {} : { executable }),
  codex: (executable: string | undefined): AgentAdapter =>
    new CodexAdapter(executable === undefined ? {} : { executable }),
  "codex-desktop": (executable: string | undefined): AgentAdapter =>
    new CodexDesktopAdapter(executable === undefined ? {} : { executable })
} satisfies Record<ReviewStrategy, (executable: string | undefined) => AgentAdapter>;

export interface SmartFlowDaemonOptions {
  dataDirectory?: string;
  handler?: IpcRequestHandler;
  logger?: StructuredLogger;
  workerLaunchConfiguration?: ResolvedWorkerLaunchConfiguration;
  reviewAdapter?: AgentAdapter;
}

export interface SmartFlowDaemonController {
  server: LocalIpcServer;
  close(): Promise<void>;
}

export async function startSmartFlowDaemon(
  options: SmartFlowDaemonOptions = {}
): Promise<SmartFlowDaemonController> {
  const logger = options.logger ?? new StructuredLogger("smartflow-daemon");
  const timer = performance.now();
  const config = resolveSmartFlowConfig();
  const injectedReviewAdapter = options.reviewAdapter;
  const configuredReviewExecutable =
    resolveReviewEnabled() &&
    injectedReviewAdapter === undefined &&
    config.review.strategy !== undefined
      ? await resolveReviewerExecutable(config.review.strategy)
      : undefined;
  const workerLaunchConfiguration = options.workerLaunchConfiguration ??
    resolveWorkerLaunchConfiguration([]);
  for (const key of WORK_ENVIRONMENT_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  const providers = new ProviderRegistry();
  const initialProviderRuntime = providers.register(workerLaunchConfiguration);
  const providerRuntimeConfig = initialProviderRuntime.providerRuntimeConfig;
  const dataDirectory = resolve(
    options.dataDirectory ?? resolve(resolveInstallationDataDirectory(), "daemon")
  );
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const reviewAdapters = new Map<ReviewStrategy, AgentAdapter>();
  const resolveReviewAdapter = (strategy: ReviewStrategy): AgentAdapter => {
    if (injectedReviewAdapter !== undefined) return injectedReviewAdapter;
    const existing = reviewAdapters.get(strategy);
    if (existing !== undefined) return existing;
    const executable = strategy === config.review.strategy
      ? configuredReviewExecutable
      : undefined;
    const adapter = REVIEW_ADAPTER_FACTORIES[strategy](executable);
    reviewAdapters.set(strategy, adapter);
    return adapter;
  };
  const composition = new ProductionRuntimeComposition(
    resolveReviewAdapter,
    logger,
    initialProviderRuntime.provider,
    providerRuntimeConfig,
    providers.resolve.bind(providers),
    {
      ...(config.review.model === undefined ? {} : { model: config.review.model }),
      ...(config.review.effort === undefined ? {} : { effort: config.review.effort })
    }
  );
  const projectRuntime = new ProjectRuntime({
    dataDirectory,
    runPipeline: composition.runPipeline,
    review: composition.review,
    publish: composition.publish,
    cancel: composition.cancel,
    recover: composition.recover,
    providerRuntimeConfig,
    resolveProviderRuntimeConfig: (
      providerRuntimeConfigHash
    ): Readonly<Record<string, unknown>> | undefined =>
      providers.resolve(providerRuntimeConfigHash)?.providerRuntimeConfig,
    resolveReviewAdapterId: (clientName): ReviewStrategy =>
      resolveReviewStrategy(config.review.strategy, clientName)
  });
  const server = new LocalIpcServer(
    dataDirectory,
    options.handler ?? projectRuntime.handle,
    workerLaunchConfiguration.daemonConfigFingerprint,
    (workerEnvironment) => {
      const registered = providers.registerEnvironment(workerEnvironment);
      return {
        daemonConfigFingerprint: registered.daemonConfigFingerprint,
        providerRuntimeConfigHash: registered.providerRuntimeConfigHash
      };
    }
  );
  try {
    // Own the installation before importing SQLite state or scheduling recovery effects.
    await server.acquireInstanceLock();
    await projectRuntime.recover();
    await server.start();
    const durationMs = performance.now() - timer;
    logger.log({
      level: "info",
      event: "daemon.ready",
      stage: "daemon.start",
      durationMs,
      data: {
        endpoint: server.endpoint,
        instanceId: server.instanceId
      }
    });
  } catch (error) {
    await server.close().catch(() => undefined);
    const durationMs = performance.now() - timer;
    logger.log({ level: "error", event: "daemon.start_failed", stage: "daemon.start", durationMs, error });
    throw error;
  }
  return {
    server,
    async close(): Promise<void> {
      await server.close();
      logger.log({ level: "info", event: "daemon.stopped" });
    }
  };
}

export async function serveSmartFlowDaemon(options: SmartFlowDaemonOptions = {}): Promise<void> {
  const daemon = await startSmartFlowDaemon(options);
  await new Promise<void>((settle) => {
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      void daemon.close().then(settle, settle);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}
