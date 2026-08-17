import { hashCanonical } from "@smartflow/task-manifest";

import { PI_MINIMUM_ATTEMPT_DEADLINE_MS } from "./heartbeat.js";

export const PI_CODING_AGENT_VERSION = "0.83.0";
export const PI_NODE_MINIMUM = "22.19.0";
export const PI_INTERNAL_PROVIDER_ID = "smartflow-mcp";
export const PI_API_KEY_ENVIRONMENT_VARIABLE = "SMARTFLOW_PI_API_KEY";

export const PI_MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai"
] as const;

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type PiModelApi = typeof PI_MODEL_APIS[number];

export interface PiRuntimeConfiguration {
  api: PiModelApi;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  thinkingLevel: PiThinkingLevel;
  attemptDeadlineMs: number;
  resourcePolicy: "workspace-project-resources";
}

const thinkingLevels = new Set<PiThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh", "max"
]);
const modelApis = new Set<string>(PI_MODEL_APIS);
const configurationKeys = new Set([
  "api",
  "baseUrl",
  "modelId",
  "contextWindow",
  "maxTokens",
  "thinkingLevel",
  "attemptDeadlineMs",
  "resourcePolicy"
]);

function validBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username.length === 0 &&
      url.password.length === 0;
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parsePiRuntimeConfiguration(input: unknown): PiRuntimeConfiguration {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("PI_RUNTIME_CONFIG_INVALID");
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.api !== "string" || !modelApis.has(value.api) ||
    !validBaseUrl(value.baseUrl) ||
    typeof value.modelId !== "string" || value.modelId.trim().length === 0 ||
    !positiveInteger(value.contextWindow) ||
    !positiveInteger(value.maxTokens) ||
    value.maxTokens > value.contextWindow ||
    typeof value.thinkingLevel !== "string" || !thinkingLevels.has(value.thinkingLevel as PiThinkingLevel) ||
    !positiveInteger(value.attemptDeadlineMs) ||
    value.attemptDeadlineMs < PI_MINIMUM_ATTEMPT_DEADLINE_MS ||
    value.resourcePolicy !== "workspace-project-resources" ||
    Object.keys(value).some((key) => !configurationKeys.has(key))
  ) {
    throw new Error("PI_RUNTIME_CONFIG_INVALID");
  }
  return {
    api: value.api as PiModelApi,
    baseUrl: value.baseUrl,
    modelId: value.modelId,
    contextWindow: value.contextWindow,
    maxTokens: value.maxTokens,
    thinkingLevel: value.thinkingLevel as PiThinkingLevel,
    attemptDeadlineMs: value.attemptDeadlineMs,
    resourcePolicy: "workspace-project-resources"
  };
}

export function piRuntimeConfigHash(configuration: PiRuntimeConfiguration): string {
  return hashCanonical({
    adapter: "pi-coding-agent-sdk-rpc",
    sdkVersion: PI_CODING_AGENT_VERSION,
    configuration
  });
}

export function frozenPiRuntimeConfig(configuration: PiRuntimeConfiguration): Readonly<Record<string, unknown>> {
  return Object.freeze({
    adapter: "pi-coding-agent-sdk-rpc",
    sdkVersion: PI_CODING_AGENT_VERSION,
    configuration: Object.freeze({ ...configuration })
  });
}
