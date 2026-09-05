import { describe, expect, it, vi } from "vitest";

import {
  createMcpModelRegistration,
  PI_HEARTBEAT_INTERVAL_MS,
  PI_HEARTBEAT_STATUS_KEY,
  registerMcpModel,
  type McpModelExtensionApi
} from "../../../../packages/provider-pi/src/mcp-model-extension.js";
import {
  PI_INTERNAL_PROVIDER_ID,
  PI_MODEL_APIS,
  parsePiRuntimeConfiguration
} from "../../../../packages/provider-pi/src/runtime-config.js";
import { piModelEnvironment } from "../../../../packages/provider-pi/src/runtime-resources.js";

const workEnvironment = {
  WORK_API: "openai-completions",
  WORK_BASE_URL: "https://models.example.test/v1",
  WORK_MODEL: "model-test",
  WORK_API_KEY: "secret-value",
  WORK_CONTEXT_WINDOW: "1000000",
  WORK_MAX_TOKENS: "384000",
  WORK_EFFORT: "high",
  WORK_ATTEMPT_DEADLINE_MS: "300000"
};

describe("SmartFlow Pi model Extension", () => {
  it.each(PI_MODEL_APIS)("registers exactly one %s model without credential bytes", (api) => {
    const environment = { ...workEnvironment, WORK_API: api };
    const registerProvider = vi.fn();
    const on = vi.fn();

    registerMcpModel({ registerProvider, on }, environment);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledTimes(2);
    expect(registerProvider).toHaveBeenCalledWith(PI_INTERNAL_PROVIDER_ID, {
      name: "SmartFlow MCP Model",
      api,
      baseUrl: "https://models.example.test/v1",
      apiKey: "$WORK_API_KEY",
      models: [{
        id: "model-test",
        name: "model-test",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 384_000
      }]
    });
    expect(JSON.stringify(registerProvider.mock.calls)).not.toContain("secret-value");
  });

  // The Extension reads the WORK_ namespace from its own copy of the key names
  // because Pi loads it standalone. This pins the writer and the reader together.
  it("accepts the environment produced by piModelEnvironment", () => {
    const configuration = parsePiRuntimeConfiguration({
      api: "openai-responses",
      baseUrl: "https://models.example.test/v1",
      modelId: "model-test",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingLevel: "high",
      attemptDeadlineMs: 300_000,
      resourcePolicy: "workspace-project-resources"
    });

    const registration = createMcpModelRegistration(
      piModelEnvironment(configuration, "secret-value")
    );

    expect(registration.config.api).toBe(configuration.api);
    expect(registration.config.baseUrl).toBe(configuration.baseUrl);
    expect(registration.config.models[0]).toMatchObject({
      id: configuration.modelId,
      contextWindow: configuration.contextWindow,
      maxTokens: configuration.maxTokens
    });
  });

  it("emits heartbeats immediately, on cadence, and only while the session is active", () => {
    vi.useFakeTimers();
    try {
      type SessionEvent = Parameters<McpModelExtensionApi["on"]>[0];
      type SessionHandler = Parameters<McpModelExtensionApi["on"]>[1];
      const handlers = new Map<SessionEvent, SessionHandler>();
      const on: McpModelExtensionApi["on"] = (event, handler) => {
        handlers.set(event, handler);
      };
      registerMcpModel({ registerProvider: vi.fn(), on }, workEnvironment);
      const setStatus = vi.fn();
      const context = { ui: { setStatus } };
      const start = handlers.get("session_start");
      const shutdown = handlers.get("session_shutdown");
      if (start === undefined || shutdown === undefined) throw new Error("SESSION_HANDLER_MISSING");

      start({}, context);
      expect(setStatus).toHaveBeenLastCalledWith(PI_HEARTBEAT_STATUS_KEY, expect.any(String));
      expect(setStatus).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(PI_HEARTBEAT_INTERVAL_MS);
      expect(setStatus).toHaveBeenCalledTimes(2);

      shutdown({}, context);
      vi.advanceTimersByTime(PI_HEARTBEAT_INTERVAL_MS * 2);
      expect(setStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rejects numeric settings outside the safe-integer range", () => {
    for (const unsafe of [String(Number.MAX_SAFE_INTEGER + 1), "9".repeat(400)]) {
      expect(() => createMcpModelRegistration({
        ...workEnvironment,
        WORK_CONTEXT_WINDOW: unsafe,
        WORK_MAX_TOKENS: unsafe
      })).toThrow(/positive safe integer/u);
      expect(() => createMcpModelRegistration({
        ...workEnvironment,
        WORK_ATTEMPT_DEADLINE_MS: unsafe
      })).toThrow(/positive safe integer/u);
    }
    expect(() => createMcpModelRegistration({
      ...workEnvironment,
      WORK_ATTEMPT_DEADLINE_MS: "59999"
    })).toThrow(/must be at least 60000/u);
  });

  it("rejects incomplete child configuration without exposing the API Key", () => {
    expect(() => createMcpModelRegistration({
      WORK_API: "openai-completions",
      WORK_API_KEY: "secret-value"
    })).toThrow(/WORK_BASE_URL is required/u);
    try {
      createMcpModelRegistration({
        WORK_API: "openai-completions",
        WORK_API_KEY: "secret-value"
      });
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
});
