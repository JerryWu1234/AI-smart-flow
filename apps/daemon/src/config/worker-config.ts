import { createHash } from "node:crypto";

import {
  PI_MINIMUM_ATTEMPT_DEADLINE_MS,
  PI_MODEL_APIS,
  parsePiRuntimeConfiguration,
  type PiRuntimeConfiguration,
  type PiModelApi,
  type PiThinkingLevel
} from "@smartflow/provider-pi";

export interface ResolvedWorkerLaunchConfiguration {
  runtimeConfig: PiRuntimeConfiguration;
  credential: string;
  daemonConfigFingerprint: string;
}

// The single Worker configuration namespace. These names are both the MCP-facing
// surface and the daemon-to-Worker transport, so no key needs translating.
export const WORK_ENVIRONMENT_KEYS = [
  "WORK_API",
  "WORK_BASE_URL",
  "WORK_MODEL",
  "WORK_API_KEY",
  "WORK_CONTEXT_WINDOW",
  "WORK_MAX_TOKENS",
  "WORK_EFFORT",
  "WORK_ATTEMPT_DEADLINE_MS"
] as const;

export type WorkEnvironmentKey = typeof WORK_ENVIRONMENT_KEYS[number];
export type WorkEnvironment = Readonly<Record<WorkEnvironmentKey, string>>;

const unsupportedModelFlags = [
  "--model",
  "--base-url",
  "--api-format",
  "--api-key",
  "--model-api-key"
] as const;

function required(environment: NodeJS.ProcessEnv, key: WorkEnvironmentKey): string {
  const value = environment[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`WORKER_CONFIGURATION_INVALID: ${key} is required`);
  }
  return value;
}

function optionalPositiveInteger(
  environment: NodeJS.ProcessEnv,
  key: WorkEnvironmentKey,
  fallback: number
): number {
  const raw = environment[key]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error(`WORKER_CONFIGURATION_INVALID: ${key} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`WORKER_CONFIGURATION_INVALID: ${key} must be a positive integer`);
  }
  return value;
}

export function daemonConfigFingerprint(
  runtimeConfig: PiRuntimeConfiguration,
  credential: string
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      runtimeConfig,
      credentialDigest: createHash("sha256").update(credential).digest("hex")
    }))
    .digest("hex");
}

export function resolveWorkerLaunchConfiguration(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): ResolvedWorkerLaunchConfiguration {
  if (argv.some((value) => unsupportedModelFlags.some((flag) =>
    value === flag || value.startsWith(`${flag}=`)
  ))) {
    throw new Error(
      "WORKER_CONFIGURATION_INVALID: Pi model configuration must use WORK_BASE_URL, WORK_MODEL, and WORK_API_KEY environment variables; WORK_API is optional"
    );
  }
  const api = environment.WORK_API?.trim() ?? "openai-responses";
  if (!PI_MODEL_APIS.includes(api as PiModelApi)) {
    throw new Error("WORKER_CONFIGURATION_INVALID: WORK_API is unsupported");
  }
  const contextWindow = optionalPositiveInteger(
    environment,
    "WORK_CONTEXT_WINDOW",
    1_000_000
  );
  const maxTokens = optionalPositiveInteger(environment, "WORK_MAX_TOKENS", 384_000);
  if (maxTokens > contextWindow) {
    throw new Error(
      "WORKER_CONFIGURATION_INVALID: WORK_MAX_TOKENS must not exceed WORK_CONTEXT_WINDOW"
    );
  }
  const attemptDeadlineMs = optionalPositiveInteger(
    environment,
    "WORK_ATTEMPT_DEADLINE_MS",
    300_000
  );
  if (attemptDeadlineMs < PI_MINIMUM_ATTEMPT_DEADLINE_MS) {
    throw new Error(
      `WORKER_CONFIGURATION_INVALID: WORK_ATTEMPT_DEADLINE_MS must be at least ${String(PI_MINIMUM_ATTEMPT_DEADLINE_MS)}`
    );
  }
  const credential = required(environment, "WORK_API_KEY");
  const runtimeConfig = parsePiRuntimeConfiguration({
    api,
    baseUrl: required(environment, "WORK_BASE_URL"),
    modelId: required(environment, "WORK_MODEL"),
    contextWindow,
    maxTokens,
    thinkingLevel: (environment.WORK_EFFORT?.trim() || "high") as PiThinkingLevel,
    attemptDeadlineMs,
    resourcePolicy: "workspace-project-resources"
  });
  return {
    runtimeConfig,
    credential,
    daemonConfigFingerprint: daemonConfigFingerprint(runtimeConfig, credential)
  };
}

export function workerLaunchEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  configuration: ResolvedWorkerLaunchConfiguration
): NodeJS.ProcessEnv & WorkEnvironment {
  return {
    ...baseEnvironment,
    WORK_API: configuration.runtimeConfig.api,
    WORK_BASE_URL: configuration.runtimeConfig.baseUrl,
    WORK_MODEL: configuration.runtimeConfig.modelId,
    WORK_API_KEY: configuration.credential,
    WORK_CONTEXT_WINDOW: String(configuration.runtimeConfig.contextWindow),
    WORK_MAX_TOKENS: String(configuration.runtimeConfig.maxTokens),
    WORK_EFFORT: configuration.runtimeConfig.thinkingLevel,
    WORK_ATTEMPT_DEADLINE_MS: String(configuration.runtimeConfig.attemptDeadlineMs)
  };
}

export function resolveWorkerRegistration(value: unknown): ResolvedWorkerLaunchConfiguration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WORKER_CONFIGURATION_INVALID: registration must be an environment object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(WORK_ENVIRONMENT_KEYS);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("WORKER_CONFIGURATION_INVALID: registration contains an unknown field");
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, candidate] of Object.entries(record)) {
    if (candidate === undefined) continue;
    if (typeof candidate !== "string") {
      throw new Error(`WORKER_CONFIGURATION_INVALID: ${key} must be a string`);
    }
    environment[key] = candidate;
  }
  return resolveWorkerLaunchConfiguration([], environment);
}
