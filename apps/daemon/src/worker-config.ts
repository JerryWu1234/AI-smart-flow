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

export const WORKER_CONFIGURATION_ENVIRONMENT_KEYS = [
  "SMARTFLOW_PI_API",
  "SMARTFLOW_PI_BASE_URL",
  "SMARTFLOW_PI_MODEL",
  "SMARTFLOW_PI_API_KEY",
  "SMARTFLOW_PI_CONTEXT_WINDOW",
  "SMARTFLOW_PI_MAX_TOKENS",
  "SMARTFLOW_PI_THINKING",
  "SMARTFLOW_PI_ATTEMPT_DEADLINE_MS"
] as const;

const unsupportedModelFlags = [
  "--model",
  "--base-url",
  "--api-format",
  "--api-key",
  "--model-api-key"
] as const;

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`WORKER_CONFIGURATION_INVALID: ${key} is required`);
  }
  return value;
}

function isWorkerConfigurationKey(key: string): boolean {
  return key.startsWith("SMARTFLOW_PI_") || /^SMARTFLOW_(?:MODEL(?:_|$)|WORKER$)/u.test(key);
}

function optionalPositiveInteger(
  environment: NodeJS.ProcessEnv,
  key: string,
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
      "WORKER_CONFIGURATION_INVALID: Pi model configuration must use SMARTFLOW_PI_* environment variables"
    );
  }
  const unsupportedKey = Object.keys(environment).find((key) =>
    isWorkerConfigurationKey(key) &&
    !WORKER_CONFIGURATION_ENVIRONMENT_KEYS.includes(
      key as typeof WORKER_CONFIGURATION_ENVIRONMENT_KEYS[number]
    ) &&
    environment[key] !== undefined
  );
  if (unsupportedKey !== undefined) {
    throw new Error(`WORKER_CONFIGURATION_INVALID: ${unsupportedKey} is unsupported`);
  }
  const api = required(environment, "SMARTFLOW_PI_API");
  if (!PI_MODEL_APIS.includes(api as PiModelApi)) {
    throw new Error("WORKER_CONFIGURATION_INVALID: SMARTFLOW_PI_API is unsupported");
  }
  const contextWindow = optionalPositiveInteger(
    environment,
    "SMARTFLOW_PI_CONTEXT_WINDOW",
    1_000_000
  );
  const maxTokens = optionalPositiveInteger(environment, "SMARTFLOW_PI_MAX_TOKENS", 384_000);
  if (maxTokens > contextWindow) {
    throw new Error(
      "WORKER_CONFIGURATION_INVALID: SMARTFLOW_PI_MAX_TOKENS must not exceed SMARTFLOW_PI_CONTEXT_WINDOW"
    );
  }
  const attemptDeadlineMs = optionalPositiveInteger(
    environment,
    "SMARTFLOW_PI_ATTEMPT_DEADLINE_MS",
    300_000
  );
  if (attemptDeadlineMs < PI_MINIMUM_ATTEMPT_DEADLINE_MS) {
    throw new Error(
      `WORKER_CONFIGURATION_INVALID: SMARTFLOW_PI_ATTEMPT_DEADLINE_MS must be at least ${String(PI_MINIMUM_ATTEMPT_DEADLINE_MS)}`
    );
  }
  const credential = required(environment, "SMARTFLOW_PI_API_KEY");
  const runtimeConfig = parsePiRuntimeConfiguration({
    api,
    baseUrl: required(environment, "SMARTFLOW_PI_BASE_URL"),
    modelId: required(environment, "SMARTFLOW_PI_MODEL"),
    contextWindow,
    maxTokens,
    thinkingLevel: (environment.SMARTFLOW_PI_THINKING?.trim() || "high") as PiThinkingLevel,
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
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    if (WORKER_CONFIGURATION_ENVIRONMENT_KEYS.includes(
      key as typeof WORKER_CONFIGURATION_ENVIRONMENT_KEYS[number]
    ) || isWorkerConfigurationKey(key)) {
      Reflect.deleteProperty(environment, key);
    }
  }
  environment.SMARTFLOW_PI_API = configuration.runtimeConfig.api;
  environment.SMARTFLOW_PI_BASE_URL = configuration.runtimeConfig.baseUrl;
  environment.SMARTFLOW_PI_MODEL = configuration.runtimeConfig.modelId;
  environment.SMARTFLOW_PI_CONTEXT_WINDOW = String(configuration.runtimeConfig.contextWindow);
  environment.SMARTFLOW_PI_MAX_TOKENS = String(configuration.runtimeConfig.maxTokens);
  environment.SMARTFLOW_PI_THINKING = configuration.runtimeConfig.thinkingLevel;
  environment.SMARTFLOW_PI_ATTEMPT_DEADLINE_MS = String(configuration.runtimeConfig.attemptDeadlineMs);
  environment.SMARTFLOW_PI_API_KEY = configuration.credential;
  return environment;
}

export function resolveWorkerRegistration(value: unknown): ResolvedWorkerLaunchConfiguration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WORKER_CONFIGURATION_INVALID: registration must be an environment object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(WORKER_CONFIGURATION_ENVIRONMENT_KEYS);
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
