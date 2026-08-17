import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: Error): void;
  }> = [];
  private terminalError: Error | undefined;
  private closed = false;

  public push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter.resolve({ done: false, value });
  }

  public fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.terminalError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  public end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.terminalError !== undefined) return Promise.reject(this.terminalError);
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      }
    };
  }
}

export interface PiRpcTransport {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

export type PiRpcEventInterceptor = (
  event: Readonly<Record<string, unknown>>
) => boolean;

export class PiRpcClient {
  private readonly eventsQueue = new AsyncEventQueue<Record<string, unknown>>();
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private readonly lines;

  public constructor(
    private readonly transport: PiRpcTransport,
    private readonly interceptEvent?: PiRpcEventInterceptor
  ) {
    this.lines = createInterface({ input: transport.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.acceptLine(line));
    this.lines.on("close", () => this.close());
    transport.stdout.on("error", (error) => this.fail(error));
    transport.stdin.on("error", (error) => this.fail(error));
  }

  public async request(command: Readonly<Record<string, unknown>>): Promise<unknown> {
    const id = `smartflow-${String(this.nextId++)}`;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await new Promise<void>((resolve, reject) => {
      this.transport.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
    return response;
  }

  public events(): AsyncIterable<Record<string, unknown>> {
    return this.eventsQueue;
  }

  public close(): void {
    const error = new Error("PI_RPC_STREAM_CLOSED");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.eventsQueue.end();
  }

  private acceptLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.fail(new Error("PI_RPC_MALFORMED_JSONL"));
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(new Error("PI_RPC_MALFORMED_MESSAGE"));
      return;
    }
    const message = value as Record<string, unknown>;
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.success === true) pending.resolve(message);
      else pending.reject(new Error(this.responseError(message)));
      return;
    }
    try {
      if (this.interceptEvent?.(message) === true) return;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("PI_RPC_EVENT_INTERCEPTOR_FAILED"));
      return;
    }
    this.eventsQueue.push(message);
  }

  private responseError(message: Record<string, unknown>): string {
    const error = message.error;
    if (typeof error === "string" && error.length > 0) return error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const detail = (error as { message?: unknown }).message;
      if (typeof detail === "string" && detail.length > 0) return detail;
    }
    return "PI_RPC_COMMAND_FAILED";
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.eventsQueue.fail(error);
    this.lines.close();
  }
}
