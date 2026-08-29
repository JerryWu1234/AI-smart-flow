import { chmod, mkdir, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { ProjectLock } from "@smartflow/state-store";
import { redactSensitive } from "@smartflow/observability";

export interface IpcRequest {
  id: string;
  method: string;
  payload: unknown;
  providerRuntimeConfigHash?: string;
  clientName?: string;
}

export type IpcRequestHandler = (request: IpcRequest) => Promise<unknown>;

export interface WorkerConfigurationRegistrationResult {
  daemonConfigFingerprint: string;
  providerRuntimeConfigHash: string;
}

export type WorkerConfigurationRegistrar = (
  workerEnvironment: unknown
) => WorkerConfigurationRegistrationResult;

type IpcResponse =
  | {
      type: "ready";
      instanceId: string;
      daemonConfigFingerprint?: string;
      providerRuntimeConfigHash?: string;
    }
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: { code: string; message: string } };

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "DAEMON_REQUEST_FAILED";
}

function publicErrorMessage(error: unknown): string {
  return redactSensitive(error instanceof Error ? error.message : String(error)) as string;
}

async function ignoreMissing(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function daemonEndpoint(dataDirectory: string, platform = process.platform): string {
  if (platform === "win32") {
    const id = createHash("sha256").update(resolve(dataDirectory)).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\smartflow-${id}`;
  }
  return resolve(dataDirectory, "daemon.sock");
}

function send(socket: Socket, response: IpcResponse): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

export class LocalIpcServer {
  public readonly instanceId = randomUUID();
  public readonly endpoint: string;
  private readonly dataDirectory: string;
  private readonly handler: IpcRequestHandler;
  private readonly daemonConfigFingerprint: string | undefined;
  private readonly registerWorkerConfiguration: WorkerConfigurationRegistrar | undefined;
  private server: Server | undefined;
  private instanceLock: ProjectLock | undefined;
  private endpointOwned = false;
  private startInFlight: Promise<void> | undefined;

  public constructor(
    dataDirectory: string,
    handler: IpcRequestHandler,
    daemonConfigFingerprint?: string,
    registerWorkerConfiguration?: WorkerConfigurationRegistrar
  ) {
    this.dataDirectory = resolve(dataDirectory);
    this.endpoint = daemonEndpoint(this.dataDirectory);
    this.handler = handler;
    this.daemonConfigFingerprint = daemonConfigFingerprint;
    this.registerWorkerConfiguration = registerWorkerConfiguration;
  }

  public async acquireInstanceLock(): Promise<void> {
    if (this.instanceLock !== undefined) return;
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    this.instanceLock = await ProjectLock.acquire(
      resolve(this.dataDirectory, "daemon.lock"),
      this.instanceId,
      0
    );
  }

  public start(): Promise<void> {
    if (this.server !== undefined && this.endpointOwned) return Promise.resolve();
    if (this.startInFlight !== undefined) return this.startInFlight;
    const start = this.startOnce().finally(() => {
      if (this.startInFlight === start) this.startInFlight = undefined;
    });
    this.startInFlight = start;
    return start;
  }

  private async startOnce(): Promise<void> {
    await this.acquireInstanceLock();
    if (process.platform !== "win32") await ignoreMissing(this.endpoint);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((settle, reject) => {
        server.once("error", reject);
        server.listen(this.endpoint, () => {
          server.off("error", reject);
          settle();
        });
      });
      this.endpointOwned = true;
      if (process.platform !== "win32") await chmod(this.endpoint, 0o600);
    } catch (error) {
      this.server = undefined;
      if (server.listening) {
        await new Promise<void>((settle) => server.close(() => settle()));
      }
      if (this.endpointOwned && process.platform !== "win32") {
        await ignoreMissing(this.endpoint).catch(() => undefined);
      }
      this.endpointOwned = false;
      await this.instanceLock?.release().catch(() => undefined);
      this.instanceLock = undefined;
      throw error;
    }
  }

  public async close(): Promise<void> {
    const server = this.server;
    const endpointOwned = this.endpointOwned;
    this.server = undefined;
    this.endpointOwned = false;
    let failure: unknown;
    if (server !== undefined) {
      try {
        await new Promise<void>((settle, reject) => {
          server.close((error) => (error === undefined ? settle() : reject(error)));
        });
      } catch (error) {
        failure = error;
      }
    }
    if (endpointOwned && process.platform !== "win32") {
      try {
        await ignoreMissing(this.endpoint);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await this.instanceLock?.release();
    } catch (error) {
      failure ??= error;
    }
    this.instanceLock = undefined;
    if (failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error("IPC server cleanup failed", { cause: failure });
    }
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    let authenticated = false;
    let providerRuntimeConfigHash: string | undefined;
    lines.on("line", (line) => {
      if (line.length > 1_048_576) {
        socket.destroy(new Error("IPC message exceeds 1 MiB"));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy(new Error("Invalid IPC JSON"));
        return;
      }
      if (!authenticated) {
        const expectedUid = process.getuid?.();
        const candidate = message as {
          type?: unknown;
          uid?: unknown;
          daemonConfigFingerprint?: unknown;
          workerEnvironment?: unknown;
        };
        if (
          candidate.type !== "handshake" ||
          (expectedUid !== undefined && candidate.uid !== expectedUid)
        ) {
          send(socket, {
            type: "response",
            id: "handshake",
            ok: false,
            error: { code: "IPC_PEER_REJECTED", message: "IPC handshake or user identity mismatch" }
          });
          socket.end();
          return;
        }
        let connectionFingerprint = this.daemonConfigFingerprint;
        if (
          this.registerWorkerConfiguration !== undefined &&
          candidate.workerEnvironment !== undefined
        ) {
          let registration: WorkerConfigurationRegistrationResult;
          try {
            registration = this.registerWorkerConfiguration(candidate.workerEnvironment);
          } catch (error) {
            send(socket, {
              type: "response",
              id: "handshake",
              ok: false,
              error: {
                code: "WORKER_CONFIGURATION_INVALID",
                message: publicErrorMessage(error)
              }
            });
            socket.end();
            return;
          }
          if (
            typeof candidate.daemonConfigFingerprint === "string" &&
            candidate.daemonConfigFingerprint !== registration.daemonConfigFingerprint
          ) {
            send(socket, {
              type: "response",
              id: "handshake",
              ok: false,
              error: {
                code: "DAEMON_CONFIGURATION_MISMATCH",
                message: "Worker registration does not match its configuration fingerprint"
              }
            });
            socket.end();
            return;
          }
          connectionFingerprint = registration.daemonConfigFingerprint;
          providerRuntimeConfigHash = registration.providerRuntimeConfigHash;
        } else if (
          this.daemonConfigFingerprint !== undefined &&
          typeof candidate.daemonConfigFingerprint === "string" &&
          candidate.daemonConfigFingerprint !== this.daemonConfigFingerprint
        ) {
          send(socket, {
            type: "response",
            id: "handshake",
            ok: false,
            error: {
              code: "DAEMON_CONFIGURATION_MISMATCH",
              message: "Daemon configuration does not match this MCP installation"
            }
          });
          socket.end();
          return;
        }
        authenticated = true;
        send(socket, {
          type: "ready",
          instanceId: this.instanceId,
          ...(connectionFingerprint === undefined
            ? {}
            : { daemonConfigFingerprint: connectionFingerprint }),
          ...(providerRuntimeConfigHash === undefined ? {} : { providerRuntimeConfigHash })
        });
        return;
      }
      const candidate = message as Partial<IpcRequest> & { type?: unknown };
      if (
        candidate.type !== "request" ||
        typeof candidate.id !== "string" ||
        typeof candidate.method !== "string"
      ) {
        socket.destroy(new Error("Invalid IPC request"));
        return;
      }
      const requestId = candidate.id;
      const method = candidate.method;
      void this.handler({
        id: requestId,
        method,
        payload: candidate.payload,
        ...(providerRuntimeConfigHash === undefined ? {} : { providerRuntimeConfigHash }),
        ...(typeof candidate.clientName === "string" ? { clientName: candidate.clientName } : {})
      })
        .then((result) => send(socket, { type: "response", id: requestId, ok: true, result }))
        .catch((error: unknown) =>
          send(socket, {
            type: "response",
            id: requestId,
            ok: false,
            error: {
              code: errorCode(error),
              message: publicErrorMessage(error)
            }
          })
        );
    });
  }
}
