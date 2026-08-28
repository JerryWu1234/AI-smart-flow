import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkerStartInput } from "@smartflow/provider-core";
import type { SandboxedSpawnRequest } from "@smartflow/workspace";

import {
  API_KEY_ENVIRONMENT_VARIABLE,
  PI_INTERNAL_PROVIDER_ID,
  type PiRuntimeConfiguration
} from "./runtime-config.js";

export interface PiRuntimeResources {
  spawnRequest: SandboxedSpawnRequest;
}

function piWorkerEntryPath(): string {
  const extension = extname(fileURLToPath(import.meta.url)) === ".mjs" ? ".mjs" : ".js";
  return fileURLToPath(new URL(`./worker-entry${extension}`, import.meta.url));
}

function piMcpModelExtensionPath(): string {
  const extension = extname(fileURLToPath(import.meta.url)) === ".mjs" ? ".mjs" : ".js";
  return fileURLToPath(new URL(`./mcp-model-extension${extension}`, import.meta.url));
}

function piSdkBootstrapPath(): string {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const pnpmMarker = "/node_modules/.pnpm/";
  const pnpmIndex = entry.indexOf(pnpmMarker);
  if (pnpmIndex >= 0) return entry.slice(0, pnpmIndex + pnpmMarker.length - 1);
  const nodeModulesMarker = "/node_modules/";
  const nodeModulesIndex = entry.lastIndexOf(nodeModulesMarker);
  return nodeModulesIndex >= 0
    ? entry.slice(0, nodeModulesIndex + nodeModulesMarker.length - 1)
    : dirname(entry);
}

export function piModelEnvironment(
  configuration: PiRuntimeConfiguration,
  credential: string
): Record<string, string> {
  return {
    API: configuration.api,
    BASE_URL: configuration.baseUrl,
    MODEL: configuration.modelId,
    SMARTFLOW_PI_CONTEXT_WINDOW: String(configuration.contextWindow),
    SMARTFLOW_PI_MAX_TOKENS: String(configuration.maxTokens),
    SMARTFLOW_PI_THINKING: configuration.thinkingLevel,
    SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: String(configuration.attemptDeadlineMs),
    [API_KEY_ENVIRONMENT_VARIABLE]: credential
  };
}

export function createPiRuntimeResources(
  input: WorkerStartInput,
  configuration: PiRuntimeConfiguration,
  credential: string,
  workerEntry = piWorkerEntryPath(),
  modelExtension = piMcpModelExtensionPath()
): PiRuntimeResources {
  const runtimeDirectory = resolve(input.workspaceDir, ".smartflow-runtime");
  const agentDirectory = resolve(runtimeDirectory, "agent");
  const sessionDirectory = resolve(runtimeDirectory, "sessions");
  const homeDirectory = resolve(runtimeDirectory, "home");
  const tempDirectory = resolve(runtimeDirectory, "tmp");
  return {
    spawnRequest: {
      attemptId: input.attemptId,
      configHash: input.providerRuntimeConfigHash,
      argv: [
        process.execPath,
        workerEntry,
        "--no-extensions",
        "--extension",
        modelExtension,
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--approve",
        "--provider",
        PI_INTERNAL_PROVIDER_ID,
        "--model",
        configuration.modelId,
        "--thinking",
        configuration.thinkingLevel,
        "--tools",
        "read,bash,edit,write,grep,find,ls",
        "--session-dir",
        sessionDirectory,
        ...(input.resumeSession === undefined
          ? []
          : ["--session", input.resumeSession.sessionFile])
      ],
      cwd: input.workspaceDir,
      workspaceRoot: input.workspaceDir,
      homeDirectory,
      tempDirectory,
      runtimeReadPaths: [
        dirname(process.execPath),
        dirname(workerEntry),
        dirname(modelExtension),
        piSdkBootstrapPath(),
        ...input.containment.runtimeReadPaths
      ],
      deniedReadPaths: [...input.containment.deniedReadPaths],
      environment: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        PI_CODING_AGENT_DIR: agentDirectory,
        PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
        ...piModelEnvironment(configuration, credential)
      },
      networkAccess: "ALLOW",
      deadlineAt: input.deadlineAt
    }
  };
}
