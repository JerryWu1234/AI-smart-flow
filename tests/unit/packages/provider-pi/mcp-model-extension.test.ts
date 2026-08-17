import { describe, expect, it, vi } from "vitest";

import {
  createMcpModelRegistration,
  registerMcpModel
} from "../../../../packages/provider-pi/src/mcp-model-extension.js";
import {
  PI_API_KEY_ENVIRONMENT_VARIABLE,
  PI_INTERNAL_PROVIDER_ID,
  PI_MODEL_APIS
} from "../../../../packages/provider-pi/src/runtime-config.js";

describe("SmartFlow Pi model Extension", () => {
  it.each(PI_MODEL_APIS)("registers exactly one %s model without credential bytes", (api) => {
    const environment = {
      SMARTFLOW_PI_API: api,
      SMARTFLOW_PI_BASE_URL: "https://models.example.test/v1",
      SMARTFLOW_PI_MODEL: "model-test",
      SMARTFLOW_PI_CONTEXT_WINDOW: "1000000",
      SMARTFLOW_PI_MAX_TOKENS: "384000",
      SMARTFLOW_PI_THINKING: "high",
      SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "1800000",
      SMARTFLOW_PI_API_KEY: "secret-value"
    };
    const registerProvider = vi.fn();

    registerMcpModel({ registerProvider }, environment);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(PI_INTERNAL_PROVIDER_ID, {
      name: "SmartFlow MCP Model",
      api,
      baseUrl: "https://models.example.test/v1",
      apiKey: `$${PI_API_KEY_ENVIRONMENT_VARIABLE}`,
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

  it("rejects numeric settings outside the safe-integer range", () => {
    const environment = {
      SMARTFLOW_PI_API: "openai-completions",
      SMARTFLOW_PI_BASE_URL: "https://models.example.test/v1",
      SMARTFLOW_PI_MODEL: "model-test",
      SMARTFLOW_PI_CONTEXT_WINDOW: "1000000",
      SMARTFLOW_PI_MAX_TOKENS: "384000",
      SMARTFLOW_PI_THINKING: "high",
      SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "1800000",
      SMARTFLOW_PI_API_KEY: "secret-value"
    };
    for (const unsafe of [String(Number.MAX_SAFE_INTEGER + 1), "9".repeat(400)]) {
      expect(() => createMcpModelRegistration({
        ...environment,
        SMARTFLOW_PI_CONTEXT_WINDOW: unsafe,
        SMARTFLOW_PI_MAX_TOKENS: unsafe
      })).toThrow(/positive safe integer/u);
      expect(() => createMcpModelRegistration({
        ...environment,
        SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: unsafe
      })).toThrow(/positive safe integer/u);
    }
  });

  it("rejects incomplete child configuration without exposing the API Key", () => {
    expect(() => createMcpModelRegistration({
      SMARTFLOW_PI_API: "openai-completions",
      SMARTFLOW_PI_API_KEY: "secret-value"
    })).toThrow(/SMARTFLOW_PI_BASE_URL is required/u);
    try {
      createMcpModelRegistration({
        SMARTFLOW_PI_API: "openai-completions",
        SMARTFLOW_PI_API_KEY: "secret-value"
      });
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
});
