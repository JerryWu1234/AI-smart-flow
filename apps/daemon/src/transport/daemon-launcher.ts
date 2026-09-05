import { spawn } from "node:child_process";

import { IpcResponseError, LocalIpcClient } from "./local-ipc-client.js";

export interface DaemonSpawnSpec {
  command: string;
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((settle) => setTimeout(settle, milliseconds));
}

export async function connectOrLaunchDaemon(
  endpoint: string,
  spawnSpec: DaemonSpawnSpec,
  timeoutMs = 10_000,
  expectedDaemonConfigFingerprint?: string,
  workerEnvironment?: NodeJS.ProcessEnv
): Promise<LocalIpcClient> {
  try {
    return await LocalIpcClient.connect(
      endpoint,
      250,
      expectedDaemonConfigFingerprint,
      workerEnvironment
    );
  } catch (error) {
    if (error instanceof IpcResponseError) throw error;
    // The singleton daemon is not ready; launch and wait for its ready handshake.
  }
  const child = spawn(spawnSpec.command, spawnSpec.argv, {
    cwd: spawnSpec.cwd,
    env: spawnSpec.env,
    detached: true,
    shell: false,
    stdio: "ignore"
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await LocalIpcClient.connect(
        endpoint,
        250,
        expectedDaemonConfigFingerprint,
        workerEnvironment
      );
    } catch (error) {
      if (error instanceof IpcResponseError) throw error;
      lastError = error;
      await delay(50);
    }
  }
  throw new Error(
    `Daemon did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}
