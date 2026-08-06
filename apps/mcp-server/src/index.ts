import {
  connectOrLaunchDaemon,
  daemonEndpoint,
  resolveWorkerLaunchConfiguration,
  resolveInstallationDataDirectory,
  workerLaunchEnvironment,
  type ResolvedWorkerLaunchConfiguration
} from "@smartflow/daemon";

import { LocalDaemonGateway } from "./local-daemon-gateway.js";
import { connectSmartFlowStdioServer } from "./server.js";

export * from "./daemon-gateway.js";
export * from "./local-daemon-gateway.js";
export * from "./server.js";
export * from "./tools/index.js";

export interface SmartFlowMcpGatewayOptions {
  executablePath: string;
  entryPath: string;
  dataDirectory?: string;
  workerLaunchConfiguration?: ResolvedWorkerLaunchConfiguration;
}

export async function runSmartFlowMcpGateway(options: SmartFlowMcpGatewayOptions): Promise<void> {
  const dataDirectory = options.dataDirectory ?? `${resolveInstallationDataDirectory()}/daemon`;
  const workerLaunchConfiguration = options.workerLaunchConfiguration ??
    resolveWorkerLaunchConfiguration([]);
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
