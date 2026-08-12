const PI_API_KEY_ENVIRONMENT_VARIABLE = "SMARTFLOW_PI_API_KEY";
const PI_INTERNAL_PROVIDER_ID = "smartflow-mcp";
const PI_MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai"
] as const;
const PI_THINKING_LEVELS = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh", "max"
]);
type PiModelApi = typeof PI_MODEL_APIS[number];

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
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`PI_MODEL_EXTENSION_INVALID: ${key} must be a positive safe integer`);
  }
  return value;
}

export function createMcpModelRegistration(
  environment: Readonly<Record<string, string | undefined>> = process.env
): McpModelRegistration {
  required(environment, PI_API_KEY_ENVIRONMENT_VARIABLE);
  const apiValue = required(environment, "SMARTFLOW_PI_API");
  if (!(PI_MODEL_APIS as readonly string[]).includes(apiValue)) {
    throw new Error("PI_MODEL_EXTENSION_INVALID: SMARTFLOW_PI_API is unsupported");
  }
  const baseUrl = required(environment, "SMARTFLOW_PI_BASE_URL");
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error("PI_MODEL_EXTENSION_INVALID: SMARTFLOW_PI_BASE_URL is invalid");
  }
  if (
    !new Set(["http:", "https:"]).has(parsedBaseUrl.protocol) ||
    parsedBaseUrl.username.length > 0 ||
    parsedBaseUrl.password.length > 0
  ) {
    throw new Error("PI_MODEL_EXTENSION_INVALID: SMARTFLOW_PI_BASE_URL is invalid");
  }
  const modelId = required(environment, "SMARTFLOW_PI_MODEL");
  const contextWindow = integer(environment, "SMARTFLOW_PI_CONTEXT_WINDOW");
  const maxTokens = integer(environment, "SMARTFLOW_PI_MAX_TOKENS");
  const thinkingLevel = required(environment, "SMARTFLOW_PI_THINKING");
  if (!PI_THINKING_LEVELS.has(thinkingLevel)) {
    throw new Error("PI_MODEL_EXTENSION_INVALID: SMARTFLOW_PI_THINKING is unsupported");
  }
  integer(environment, "SMARTFLOW_PI_ATTEMPT_DEADLINE_MS");
  if (maxTokens > contextWindow) {
    throw new Error("PI_MODEL_EXTENSION_INVALID: max tokens exceed context window");
  }
  const api = apiValue as PiModelApi;
  return {
    providerId: PI_INTERNAL_PROVIDER_ID,
    config: {
      name: "SmartFlow MCP Model",
      api,
      baseUrl,
      apiKey: `$${PI_API_KEY_ENVIRONMENT_VARIABLE}`,
      models: [{
        id: modelId,
        name: modelId,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens
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

export default registerMcpModel;