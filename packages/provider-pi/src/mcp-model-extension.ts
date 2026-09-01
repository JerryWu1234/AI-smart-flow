import {
  PI_HEARTBEAT_INTERVAL_MS,
  PI_HEARTBEAT_STATUS_KEY,
  PI_MINIMUM_ATTEMPT_DEADLINE_MS
} from "./heartbeat.js";

export {
  PI_HEARTBEAT_INTERVAL_MS,
  PI_HEARTBEAT_STATUS_KEY
} from "./heartbeat.js";

// Duplicated instead of imported: this module is loaded standalone by the Pi
// agent as an extension. Keep in sync with runtime-config.ts and the WORK_
// namespace in apps/daemon/src/config/worker-config.ts.
const API_KEY_ENVIRONMENT_VARIABLE = "WORK_API_KEY";
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

interface McpHeartbeatContext {
  ui: {
    setStatus(key: string, text: string | undefined): void;
  };
}

export interface McpModelExtensionApi {
  registerProvider(name: string, config: McpProviderConfig): void;
  on(
    event: "session_start" | "session_shutdown",
    handler: (event: unknown, context: McpHeartbeatContext) => void
  ): void;
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
  required(environment, API_KEY_ENVIRONMENT_VARIABLE);
  const apiValue = required(environment, "WORK_API");
  if (!(PI_MODEL_APIS as readonly string[]).includes(apiValue)) {
    throw new Error("PI_MODEL_EXTENSION_INVALID: WORK_API is unsupported");
  }
  const baseUrl = required(environment, "WORK_BASE_URL");
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error("PI_MODEL_EXTENSION_INVALID: WORK_BASE_URL is invalid");
  }
  if (
    !new Set(["http:", "https:"]).has(parsedBaseUrl.protocol) ||
    parsedBaseUrl.username.length > 0 ||
    parsedBaseUrl.password.length > 0
  ) {
    throw new Error("PI_MODEL_EXTENSION_INVALID: WORK_BASE_URL is invalid");
  }
  const modelId = required(environment, "WORK_MODEL");
  const contextWindow = integer(environment, "WORK_CONTEXT_WINDOW");
  const maxTokens = integer(environment, "WORK_MAX_TOKENS");
  const thinkingLevel = required(environment, "WORK_EFFORT");
  if (!PI_THINKING_LEVELS.has(thinkingLevel)) {
    throw new Error("PI_MODEL_EXTENSION_INVALID: WORK_EFFORT is unsupported");
  }
  const attemptDeadlineMs = integer(environment, "WORK_ATTEMPT_DEADLINE_MS");
  if (attemptDeadlineMs < PI_MINIMUM_ATTEMPT_DEADLINE_MS) {
    throw new Error(
      `PI_MODEL_EXTENSION_INVALID: WORK_ATTEMPT_DEADLINE_MS must be at least ${String(PI_MINIMUM_ATTEMPT_DEADLINE_MS)}`
    );
  }
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
      apiKey: `$${API_KEY_ENVIRONMENT_VARIABLE}`,
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

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stopHeartbeat = (): void => {
    if (heartbeat === undefined) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };
  pi.on("session_start", (_event, context) => {
    stopHeartbeat();
    const sendHeartbeat = (): void => {
      context.ui.setStatus(PI_HEARTBEAT_STATUS_KEY, String(Date.now()));
    };
    sendHeartbeat();
    heartbeat = setInterval(sendHeartbeat, PI_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
  });
  pi.on("session_shutdown", stopHeartbeat);
}

export default registerMcpModel;
