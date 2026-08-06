import { homedir } from "node:os";

import type {
  CancelReceipt,
  ProviderCapabilities,
  ProviderProbeResult,
  WorkerEvent,
  WorkerProvider,
  WorkerStartInput
} from "@smartflow/provider-core";
import {
  ExecutionSandboxAdapter,
  type SandboxedProcessHandle
} from "@smartflow/workspace";

import { PiEventNormalizer, redactPiValue } from "./event-normalizer.js";
import { createMcpModelRegistration } from "./mcp-model-extension.js";
import { PiRpcClient } from "./rpc-client.js";
import {
  PI_API_KEY_ENVIRONMENT_VARIABLE,
  PI_CODING_AGENT_VERSION,
  PI_NODE_MINIMUM,
  parsePiRuntimeConfiguration,
  piRuntimeConfigHash,
  type PiRuntimeConfiguration
} from "./runtime-config.js";
import {
  createPiRuntimeResources,
  piModelEnvironment
} from "./runtime-resources.js";

const capabilities: ProviderCapabilities = Object.freeze({
  officialCodingTools: true,
  arbitraryShell: true,
  networkAccess: true,
  streaming: true,
  cancellation: true,
  sessionPersistence: true
});

interface ActiveAttempt {
  handle: SandboxedProcessHandle;
  canceled: boolean;
}

export interface PiProviderOptions {
  runtimeConfig: PiRuntimeConfiguration | Readonly<Record<string, unknown>>;
  environment?: Readonly<Record<string, string | undefined>>;
  workerEntryPath?: string;
  createSandbox?: (registryPath?: string) => ExecutionSandboxAdapter;
}

function nodeAtLeast(required: string): boolean {
  const current = process.versions.node.split(".").map(Number);
  const minimum = required.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const left = current[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function responseData(response: unknown): Record<string, unknown> {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new Error("PI_RPC_RESPONSE_INVALID");
  }
  const data = (response as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("PI_RPC_RESPONSE_INVALID");
  }
  return data as Record<string, unknown>;
}

export class PiProvider implements WorkerProvider {
  private readonly configuration: PiRuntimeConfiguration;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly runtimeHash: string;
  private readonly active = new Map<string, ActiveAttempt>();

  public constructor(private readonly options: PiProviderOptions) {
    this.configuration = parsePiRuntimeConfiguration(options.runtimeConfig);
    this.environment = options.environment ?? process.env;
    this.runtimeHash = piRuntimeConfigHash(this.configuration);
  }

  public async probe(): Promise<ProviderProbeResult> {
    const credential = this.environment[PI_API_KEY_ENVIRONMENT_VARIABLE];
    const details = {
      sdk: `@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}`,
      nodeMinimum: PI_NODE_MINIMUM,
      api: this.configuration.api,
      baseUrl: this.configuration.baseUrl,
      model: this.configuration.modelId,
      sandbox: process.platform
    };
    if (!nodeAtLeast(PI_NODE_MINIMUM)) {
      return {
        available: false,
        code: "PROVIDER_UNAVAILABLE",
        reason: `Pi requires Node >=${PI_NODE_MINIMUM}`,
        capabilities,
        details
      };
    }
    if (credential?.trim().length === 0 || credential === undefined) {
      return {
        available: false,
        code: "PROVIDER_UNAVAILABLE",
        reason: `${PI_API_KEY_ENVIRONMENT_VARIABLE} is missing`,
        capabilities,
        details
      };
    }
    try {
      const registration = createMcpModelRegistration(
        piModelEnvironment(this.configuration, credential)
      );
      Object.assign(details, {
        extensionProviderId: registration.providerId,
        registeredModelCount: registration.config.models.length
      });
    } catch (error) {
      return {
        available: false,
        code: "PROVIDER_UNAVAILABLE",
        reason: redactPiValue(
          error instanceof Error ? error.message : String(error),
          [],
          [credential]
        ) as string,
        capabilities,
        details
      };
    }
    const sandbox = this.options.createSandbox?.() ?? new ExecutionSandboxAdapter();
    const sandboxProbe = await sandbox.probe();
    if (!sandboxProbe.available) {
      return {
        available: false,
        code: "PROVIDER_UNAVAILABLE",
        reason: `Pi sandbox unavailable: ${sandboxProbe.reason ?? "unsupported platform"}`,
        capabilities,
        details
      };
    }
    return {
      available: true,
      capabilities,
      providerRuntimeConfigHash: this.runtimeHash,
      details
    };
  }

  public async *start(input: WorkerStartInput): AsyncIterable<WorkerEvent> {
    if (input.providerRuntimeConfigHash !== this.runtimeHash) {
      yield {
        type: "FAILED",
        attemptId: input.attemptId,
        code: "PROVIDER_RUNTIME_CONFIG_DRIFT",
        message: "Frozen Pi runtime configuration changed before execution"
      };
      return;
    }
    const credential = this.environment[PI_API_KEY_ENVIRONMENT_VARIABLE];
    if (credential === undefined || credential.trim().length === 0) {
      yield {
        type: "FAILED",
        attemptId: input.attemptId,
        code: "PROVIDER_CREDENTIAL_MISSING",
        message: "Configured Pi credential is unavailable"
      };
      return;
    }

    const sandbox = this.options.createSandbox?.(input.containment.registryPath) ??
      new ExecutionSandboxAdapter(input.containment.registryPath);
    const redactionRoots = [
      input.workspaceDir,
      input.containment.registryPath,
      input.containment.homeDirectory,
      input.containment.tempDirectory,
      ...input.containment.deniedReadPaths,
      homedir()
    ];
    const normalizer = new PiEventNormalizer(input.attemptId, redactionRoots, [credential]);
    let active: ActiveAttempt | undefined;
    try {
      const resources = createPiRuntimeResources(
        input,
        this.configuration,
        credential,
        this.options.workerEntryPath
      );
      const handle = await sandbox.spawn(resources.spawnRequest);
      handle.stderr.on("data", (chunk: unknown) => {
        redactPiValue(String(chunk), redactionRoots, [credential]);
      });
      handle.stderr.resume();
      active = { handle, canceled: false };
      this.active.set(input.attemptId, active);
      const client = new PiRpcClient(handle);
      const state = responseData(await client.request({ type: "get_state" }));
      const piSessionId = state.sessionId;
      if (typeof piSessionId !== "string" || piSessionId.length === 0) {
        throw new Error("PI_SESSION_ID_MISSING");
      }
      yield {
        type: "STARTED",
        attemptId: input.attemptId,
        piSessionId,
        containmentId: handle.containmentId,
        pid: handle.pid,
        processStartToken: handle.processStartToken
      };

      await client.request({
        type: "prompt",
        message: [
          input.prompt,
          "Work only inside the current workspace. Use the official Pi coding tools directly.",
          "Do not ask the user. If work cannot continue, end with SMARTFLOW_BLOCKED: CODE: reason."
        ].join("\n\n")
      });

      const iterator = client.events()[Symbol.asyncIterator]();
      const exitPromise = handle.wait();
      let nextEvent = iterator.next();
      let terminal = false;
      while (!terminal) {
        const observed = await Promise.race([
          nextEvent.then((result) => ({ kind: "event" as const, result })),
          exitPromise.then((result) => ({ kind: "exit" as const, result }))
        ]);
        if (observed.kind === "exit") {
          if (active.canceled) {
            yield { type: "CANCELED", attemptId: input.attemptId };
          } else if (observed.result.timedOut) {
            yield {
              type: "TIMED_OUT",
              attemptId: input.attemptId,
              code: "ATTEMPT_DEADLINE_EXCEEDED"
            };
          } else {
            yield {
              type: "FAILED",
              attemptId: input.attemptId,
              code: "PI_PROCESS_EXITED",
              message: `Pi process exited ${String(observed.result.exitCode)}/${String(observed.result.signal)}`
            };
          }
          break;
        }
        if (observed.result.done) {
          const exit = await exitPromise;
          yield exit.timedOut
            ? { type: "TIMED_OUT", attemptId: input.attemptId, code: "ATTEMPT_DEADLINE_EXCEEDED" }
            : {
                type: "FAILED",
                attemptId: input.attemptId,
                code: "PI_RPC_STREAM_CLOSED",
                message: "Pi RPC stream closed before a terminal event"
              };
          break;
        }
        const event = observed.result.value;
        const normalized = normalizer.normalize(event);
        if (normalized !== undefined) yield normalized;
        if (event.type === "agent_end" && event.willRetry !== true) {
          const last = responseData(await client.request({ type: "get_last_assistant_text" })).text;
          const blocked = normalizer.blockedTerminal(typeof last === "string" ? last : "");
          if (blocked !== undefined) yield blocked;
          else yield { type: "COMPLETED", attemptId: input.attemptId, piSessionId };
          terminal = true;
          const stopped = await handle.terminate();
          if (!stopped.treeEmpty) throw new Error("PI_CONTAINMENT_RECONCILIATION_REQUIRED");
        } else {
          nextEvent = iterator.next();
        }
      }
    } catch (error) {
      if (active !== undefined) await active.handle.terminate().catch(() => ({ treeEmpty: false }));
      yield {
        type: "FAILED",
        attemptId: input.attemptId,
        code: "PI_PROVIDER_FAILED",
        message: redactPiValue(
          error instanceof Error ? error.message : String(error),
          redactionRoots,
          [credential]
        ) as string
      };
    } finally {
      this.active.delete(input.attemptId);
    }
  }

  public async cancel(attemptId: string): Promise<CancelReceipt> {
    const active = this.active.get(attemptId);
    if (active === undefined) return { attemptId, requested: false, treeEmpty: false };
    active.canceled = true;
    const result = await active.handle.terminate();
    return { attemptId, requested: true, treeEmpty: result.treeEmpty };
  }
}
