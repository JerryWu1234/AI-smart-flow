import {
  PI_API_KEY_ENVIRONMENT_VARIABLE,
  PI_INTERNAL_PROVIDER_ID,
  parsePiRuntimeConfiguration,
  type PiModelApi
} from "./runtime-config.js";

interface McpProviderModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

interface McpProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: PiModelApi;
  models: McpProviderModelConfig[];
}

export interface McpModelExtensionApi {
  registerProvider(name: string, config: McpProviderConfig): void;
}

export interface McpModelRegistration {
  providerId: typeof PI_INTERNAL_PROVIDER_ID;
  config: McpProviderConfig;
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  key: string
): string {
  const value = environment[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`PI_MODEL_EXTENSION_INVALID: ${key} is required`);
  }
  return value;
}

function integer(
  environment: Readonly<Record<string, string | undefined>>,
  key: string
): number {
  const raw = required(environment, key);
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error(`PI_MODEL_EXTENSION_INVALID: ${key} must be a positive integer`);
  }
  return Number(raw);
}

export function createMcpModelRegistration(
  environment: Readonly<Record<string, string | undefined>> = process.env
): McpModelRegistration {
  required(environment, PI_API_KEY_ENVIRONMENT_VARIABLE);
  const runtimeConfig = parsePiRuntimeConfiguration({
    api: required(environment, "SMARTFLOW_PI_API"),
    baseUrl: required(environment, "SMARTFLOW_PI_BASE_URL"),
    modelId: required(environment, "SMARTFLOW_PI_MODEL"),
    contextWindow: integer(environment, "SMARTFLOW_PI_CONTEXT_WINDOW"),
    maxTokens: integer(environment, "SMARTFLOW_PI_MAX_TOKENS"),
    thinkingLevel: required(environment, "SMARTFLOW_PI_THINKING"),
    attemptDeadlineMs: integer(environment, "SMARTFLOW_PI_ATTEMPT_DEADLINE_MS"),
    resourcePolicy: "workspace-project-resources"
  });
  return {
    providerId: PI_INTERNAL_PROVIDER_ID,
    config: {
      name: "SmartFlow MCP Model",
      api: runtimeConfig.api,
      baseUrl: runtimeConfig.baseUrl,
      apiKey: `$${PI_API_KEY_ENVIRONMENT_VARIABLE}`,
      models: [{
        id: runtimeConfig.modelId,
        name: runtimeConfig.modelId,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: runtimeConfig.contextWindow,
        maxTokens: runtimeConfig.maxTokens
      }]
    }
  };
}

export function registerMcpModel(
  pi: McpModelExtensionApi,
  environment: Readonly<Record<string, string | undefined>> = process.env
): void {
  const registration = createMcpModelRegistration(environment);
  pi.registerProvider(registration.providerId, registration.config);
}

export default function smartFlowMcpModelExtension(pi: McpModelExtensionApi): void {
  registerMcpModel(pi);
}
