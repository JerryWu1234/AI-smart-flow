import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { IpcResponseError, LocalIpcClient } from "./local-ipc-client.js";

const DAEMON_LOG_TAIL_BYTES = 2_000;

export interface DaemonSpawnSpec {
  command: string;
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Destination for the launched daemon's stdout and stderr. A launched daemon
   * outlives the process that launched it, so its output is redirected to a file
   * rather than a pipe: the inherited descriptor stays valid for the daemon's
   * whole life, while a pipe would break with EPIPE once the launcher exits.
   * Without a path the output is discarded, which leaves startup failures
   * invisible.
   */
  logPath?: string;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((settle) => setTimeout(settle, milliseconds));
}

async function openDaemonLog(logPath: string | undefined): Promise<FileHandle | undefined> {
  if (logPath === undefined) return undefined;
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  return open(logPath, "a", 0o600);
}

async function daemonLogTail(logPath: string | undefined): Promise<string> {
  if (logPath === undefined) return "";
  const contents = await readFile(logPath, "utf8").catch(() => "");
  if (contents.length === 0) return "";
  return `; daemon log tail: ${contents.slice(-DAEMON_LOG_TAIL_BYTES)}`;
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
  const log = await openDaemonLog(spawnSpec.logPath);
  try {
    const child = spawn(spawnSpec.command, spawnSpec.argv, {
      cwd: spawnSpec.cwd,
      env: spawnSpec.env,
      detached: true,
      shell: false,
      stdio: log === undefined ? "ignore" : ["ignore", log.fd, log.fd]
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
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    const tail = await daemonLogTail(spawnSpec.logPath);
    throw new Error(`Daemon did not become ready: ${reason}${tail}`);
  } finally {
    // Closes only the launcher's handle. The child received a duplicate at spawn
    // time and keeps writing to the file after this returns.
    await log?.close();
  }
}
