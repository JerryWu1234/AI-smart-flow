import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import { SMARTFLOW_IPC_PROTOCOL } from "./local-ipc-server.js";

interface PendingCall {
  settle(value: unknown): void;
  reject(error: Error): void;
}

export class IpcResponseError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "IpcResponseError";
    this.code = code;
  }
}

export class LocalIpcClient {
  public readonly instanceId: string;
  public readonly providerRuntimeConfigHash: string | undefined;
  private readonly socket: Socket;
  private readonly pending = new Map<string, PendingCall>();

  private constructor(
    socket: Socket,
    instanceId: string,
    providerRuntimeConfigHash?: string
  ) {
    this.socket = socket;
    this.instanceId = instanceId;
    this.providerRuntimeConfigHash = providerRuntimeConfigHash;
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", (line) => this.receive(line));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => this.rejectAll(new Error("IPC connection closed")));
  }

  public static async connect(
    endpoint: string,
    timeoutMs = 2_000,
    expectedDaemonConfigFingerprint?: string,
    workerEnvironment?: NodeJS.ProcessEnv
  ): Promise<LocalIpcClient> {
    const socket = createConnection(endpoint);
    socket.setEncoding("utf8");
    await new Promise<void>((settle, reject) => {
      const timer = setTimeout(() => reject(new Error("IPC connect timed out")), timeoutMs);
      timer.unref();
      socket.once("connect", () => {
        clearTimeout(timer);
        settle();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    socket.write(`${JSON.stringify({
        type: "handshake",
        protocol: SMARTFLOW_IPC_PROTOCOL,
        uid: process.getuid?.() ?? null,
        ...(expectedDaemonConfigFingerprint === undefined
          ? {}
          : { daemonConfigFingerprint: expectedDaemonConfigFingerprint }),
        ...(workerEnvironment === undefined ? {} : { workerEnvironment })
      })}\n`);
    const ready = await new Promise<{
      instanceId: string;
      providerRuntimeConfigHash?: string;
    }>((settle, reject) => {
      const timer = setTimeout(() => reject(new Error("IPC ready handshake timed out")), timeoutMs);
      timer.unref();
      const lines = createInterface({ input: socket, crlfDelay: Infinity });
      lines.once("line", (line) => {
        clearTimeout(timer);
        lines.close();
        const response = JSON.parse(line) as {
          type?: unknown;
          protocol?: unknown;
          instanceId?: unknown;
          daemonConfigFingerprint?: unknown;
          providerRuntimeConfigHash?: unknown;
          error?: { code?: unknown; message?: unknown };
        };
        if (response.type === "response" && response.error !== undefined) {
          socket.end();
          reject(new IpcResponseError(
            typeof response.error.code === "string" ? response.error.code : "IPC_PEER_REJECTED",
            typeof response.error.message === "string"
              ? response.error.message
              : "IPC peer rejected handshake"
          ));
          return;
        }
        if (
          response.type !== "ready" ||
          response.protocol !== SMARTFLOW_IPC_PROTOCOL ||
          typeof response.instanceId !== "string"
        ) {
          socket.end();
          const message = response.error?.message;
          reject(new Error(typeof message === "string" ? message : "IPC peer rejected handshake"));
          return;
        }
        if (
          expectedDaemonConfigFingerprint !== undefined &&
          response.daemonConfigFingerprint !== expectedDaemonConfigFingerprint
        ) {
          socket.end();
          reject(new IpcResponseError(
            "DAEMON_CONFIGURATION_MISMATCH",
            "Daemon configuration does not match this MCP installation"
          ));
          return;
        }
        if (
          workerEnvironment !== undefined &&
          typeof response.providerRuntimeConfigHash !== "string"
        ) {
          socket.end();
          reject(new IpcResponseError(
            "PROVIDER_CONFIG_UNAVAILABLE",
            "Daemon did not register the MCP Provider configuration"
          ));
          return;
        }
        settle({
          instanceId: response.instanceId,
          ...(typeof response.providerRuntimeConfigHash === "string"
            ? { providerRuntimeConfigHash: response.providerRuntimeConfigHash }
            : {})
        });
      });
    });
    return new LocalIpcClient(socket, ready.instanceId, ready.providerRuntimeConfigHash);
  }

  public call(method: string, payload: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise<unknown>((settle, reject) => {
      this.pending.set(id, { settle, reject });
      this.socket.write(`${JSON.stringify({ type: "request", id, method, payload })}\n`);
    });
  }

  public close(): void {
    this.socket.end();
  }

  private receive(line: string): void {
    const response = JSON.parse(line) as {
      type?: unknown;
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (response.type !== "response" || typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    if (response.ok === true) pending.settle(response.result);
    else {
      pending.reject(
        new IpcResponseError(
          typeof response.error?.code === "string" ? response.error.code : "DAEMON_REQUEST_FAILED",
          typeof response.error?.message === "string" ? response.error.message : "Daemon request failed"
        )
      );
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
