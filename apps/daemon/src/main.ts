import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { MetricsRegistry, StructuredLogger } from "@smartflow/observability";
import type { WorkspaceApplyAdapter } from "@smartflow/publish";

import { loadSmartFlowConfig, type SmartFlowConfig } from "./config.js";
import { resolveInstallationDataDirectory } from "./data-dir.js";
import { LocalIpcServer, type IpcRequestHandler } from "./local-ipc-server.js";
import { ProviderRegistry } from "./provider-registry.js";
import { ProjectRuntime } from "./project-runtime.js";
import { ProductionRuntimeComposition } from "./runtime-composition.js";
import {
  resolveWorkerLaunchConfiguration,
  WORKER_CONFIGURATION_ENVIRONMENT_KEYS,
  type ResolvedWorkerLaunchConfiguration
} from "./worker-config.js";

export interface SmartFlowDaemonOptions {
  dataDirectory?: string;
  configPath?: string;
  handler?: IpcRequestHandler;
  logger?: StructuredLogger;
  metrics?: MetricsRegistry;
  workspaceApplyAdapter?: WorkspaceApplyAdapter;
  workerLaunchConfiguration?: ResolvedWorkerLaunchConfiguration;
}

export interface SmartFlowDaemonController {
  server: LocalIpcServer;
  config: SmartFlowConfig;
  dataDirectory: string;
  close(): Promise<void>;
}

export async function startSmartFlowDaemon(
  options: SmartFlowDaemonOptions = {}
): Promise<SmartFlowDaemonController> {
  const logger = options.logger ?? new StructuredLogger("smartflow-daemon");
  const metrics = options.metrics ?? new MetricsRegistry();
  const timer = performance.now();
  const config = await loadSmartFlowConfig(options.configPath);
  const workerLaunchConfiguration = options.workerLaunchConfiguration ??
    resolveWorkerLaunchConfiguration([]);
  for (const key of WORKER_CONFIGURATION_ENVIRONMENT_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  const providers = new ProviderRegistry();
  const initialProviderRuntime = providers.register(workerLaunchConfiguration);
  const providerRuntimeConfig = initialProviderRuntime.providerRuntimeConfig;
  const dataDirectory = resolve(
    options.dataDirectory ?? resolve(resolveInstallationDataDirectory(), "daemon")
  );
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const composition = new ProductionRuntimeComposition(
    dataDirectory,
    logger,
    options.workspaceApplyAdapter,
    initialProviderRuntime.provider,
    providerRuntimeConfig,
    providers.resolve.bind(providers)
  );
  const projectRuntime = new ProjectRuntime({
    dataDirectory,
    runPipeline: composition.runPipeline,
    publish: composition.publish,
    cancel: composition.cancel,
    recover: composition.recover,
    providerRuntimeConfig,
    resolveProviderRuntimeConfig: (
      providerRuntimeConfigHash
    ): Readonly<Record<string, unknown>> | undefined =>
      providers.resolve(providerRuntimeConfigHash)?.providerRuntimeConfig
  });
  await projectRuntime.recover();
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
    await server.start();
    const durationMs = performance.now() - timer;
    metrics.recordStage("daemon.start", durationMs, true);
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
    const durationMs = performance.now() - timer;
    metrics.recordStage("daemon.start", durationMs, false);
    logger.log({ level: "error", event: "daemon.start_failed", stage: "daemon.start", durationMs, error });
    throw error;
  }
  return {
    server,
    config,
    dataDirectory,
    async close(): Promise<void> {
      projectRuntime.dispose();
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
