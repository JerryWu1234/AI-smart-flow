import { describe, expect, it } from "vitest";

import { piRuntimeConfigHash } from "@smartflow/provider-pi";

import {
  daemonConfigFingerprint,
  resolveWorkerLaunchConfiguration,
  workerLaunchEnvironment
} from "../../../../apps/daemon/src/worker-config.js";

const environment = {
  SMARTFLOW_PI_API: "openai-responses",
  SMARTFLOW_PI_BASE_URL: "https://models.example.test/v1",
  SMARTFLOW_PI_MODEL: "gpt-test",
  SMARTFLOW_PI_THINKING: "high",
  SMARTFLOW_PI_CONTEXT_WINDOW: "200000",
  SMARTFLOW_PI_MAX_TOKENS: "32000",
  SMARTFLOW_PI_API_KEY: "secret-value",
  SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "60000",
};

describe("Pi Worker launch configuration", () => {
  it("requires explicit model and credential configuration", () => {
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {}))
      .toThrow(/SMARTFLOW_PI_API is required/u);
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      ...environment,
      SMARTFLOW_PI_API_KEY: ""
    })).toThrow(/SMARTFLOW_PI_API_KEY is required/u);
  });

  it("freezes direct MCP model configuration without credential bytes", () => {
    const resolved = resolveWorkerLaunchConfiguration(["mcp"], environment);
    expect(resolved.runtimeConfig).toEqual({
      api: "openai-responses",
      baseUrl: "https://models.example.test/v1",
      modelId: "gpt-test",
      contextWindow: 200_000,
      maxTokens: 32_000,
      thinkingLevel: "high",
      attemptDeadlineMs: 60_000,
      resourcePolicy: "workspace-project-resources"
    });
    expect(piRuntimeConfigHash(resolved.runtimeConfig)).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(resolved.runtimeConfig)).not.toContain("secret-value");
    expect(workerLaunchEnvironment({ KEEP_ME: "yes" }, resolved)).toMatchObject({
      KEEP_ME: "yes",
      SMARTFLOW_PI_API: "openai-responses",
      SMARTFLOW_PI_BASE_URL: "https://models.example.test/v1",
      SMARTFLOW_PI_MODEL: "gpt-test",
      SMARTFLOW_PI_API_KEY: "secret-value"
    });
  });

  it("applies the single-model defaults for every supported API", () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai"
    ]) {
      const resolved = resolveWorkerLaunchConfiguration(["mcp"], {
        SMARTFLOW_PI_API: api,
        SMARTFLOW_PI_BASE_URL: "https://models.example.test/v1",
        SMARTFLOW_PI_MODEL: "model-test",
        SMARTFLOW_PI_API_KEY: "secret-value"
      });
      expect(resolved.runtimeConfig).toMatchObject({
        api,
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        thinkingLevel: "high",
        attemptDeadlineMs: 300_000
      });
    }
  });

  it("rejects model flags and invalid capabilities", () => {
    expect(() => resolveWorkerLaunchConfiguration(["mcp", "--model", "gpt-test"], environment))
      .toThrow(/must use SMARTFLOW_PI_/u);
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      ...environment,
      SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "0"
    })).toThrow(/SMARTFLOW_PI_ATTEMPT_DEADLINE_MS/u);
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      ...environment,
      SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "59999"
    })).toThrow(/must be at least 60000/u);
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      ...environment,
      SMARTFLOW_PI_MAX_TOKENS: "200001"
    })).toThrow(/must not exceed SMARTFLOW_PI_CONTEXT_WINDOW/u);
  });

  it("keeps credentials out of runtime hashes but rotates the daemon fingerprint", () => {
    const first = resolveWorkerLaunchConfiguration(["mcp"], environment);
    const second = resolveWorkerLaunchConfiguration(["mcp"], {
      ...environment,
      SMARTFLOW_PI_API_KEY: "rotated-secret"
    });
    expect(piRuntimeConfigHash(second.runtimeConfig)).toBe(piRuntimeConfigHash(first.runtimeConfig));
    expect(daemonConfigFingerprint(first.runtimeConfig, first.credential))
      .not.toBe(daemonConfigFingerprint(second.runtimeConfig, second.credential));
  });
});
