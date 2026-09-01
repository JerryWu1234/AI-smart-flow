import {
  connectOrLaunchDaemon,
  daemonEndpoint,
  resolveMcpWorkerLaunchConfiguration,
  resolveInstallationDataDirectory,
  resolveReviewerExecutable,
  resolveSmartFlowConfig,
  workerLaunchEnvironment,
  type ResolvedWorkerLaunchConfiguration
} from "@smartflow/daemon";

import { LocalDaemonGateway } from "./local-daemon-gateway.js";
import { connectSmartFlowStdioServer } from "./server.js";

export type { DaemonGateway } from "./daemon-gateway.js";
export {
  SMARTFLOW_EXECUTE_DESCRIPTION,
  SMARTFLOW_MCP_INSTRUCTIONS
} from "./server.js";
export { createToolHandlers } from "./tools/index.js";

export interface SmartFlowMcpGatewayOptions {
  executablePath: string;
  entryPath: string;
  dataDirectory?: string;
  workerLaunchConfiguration?: ResolvedWorkerLaunchConfiguration;
}

export async function runSmartFlowMcpGateway(options: SmartFlowMcpGatewayOptions): Promise<void> {
  const dataDirectory = options.dataDirectory ?? `${resolveInstallationDataDirectory()}/daemon`;
  const config = resolveSmartFlowConfig();
  if (config.review.strategy !== undefined) {
    await resolveReviewerExecutable(config.review.strategy);
  }
  const workerLaunchConfiguration = options.workerLaunchConfiguration ??
    resolveMcpWorkerLaunchConfiguration([]);
  const workerEnvironment = workerLaunchEnvironment({}, workerLaunchConfiguration);
  const client = await connectOrLaunchDaemon(
    daemonEndpoint(dataDirectory),
    {
      command: options.executablePath,
      argv: [options.entryPath, "daemon", "--data-dir", dataDirectory],
      cwd: process.cwd(),
      env: workerLaunchEnvironment(process.env, workerLaunchConfiguration)
    },
    10_000,
    workerLaunchConfiguration.daemonConfigFingerprint,
    workerEnvironment
  );
  const gateway = new LocalDaemonGateway(client);
  const server = await connectSmartFlowStdioServer(gateway);
  await new Promise<void>((settle) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.stdin.off("end", finish);
      process.stdin.off("close", finish);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      settle();
    };
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    process.stdin.resume();
  });
  await server.close();
  gateway.close();
}
