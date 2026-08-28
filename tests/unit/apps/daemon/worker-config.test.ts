import { describe, expect, it } from "vitest";

import { piRuntimeConfigHash } from "@smartflow/provider-pi";

import {
  daemonConfigFingerprint,
  resolveWorkerLaunchConfiguration,
  resolveWorkerRegistration,
  workerLaunchEnvironment
} from "../../../../apps/daemon/src/worker-config.js";

const environment = {
  API: "openai-responses",
  BASE_URL: "https://models.example.test/v1",
  MODEL: "gpt-test",
  SMARTFLOW_PI_THINKING: "high",
  SMARTFLOW_PI_CONTEXT_WINDOW: "200000",
  SMARTFLOW_PI_MAX_TOKENS: "32000",
  API_KEY: "secret-value",
  SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "60000"
};

const legacyRequiredEnvironmentKeys = [
  "SMARTFLOW_PI_API",
  "SMARTFLOW_PI_BASE_URL",
  "SMARTFLOW_PI_MODEL",
  "SMARTFLOW_PI_API_KEY"
] as const;

describe("Pi Worker launch configuration", () => {
  it("requires explicit model and credential configuration", () => {
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {}))
      .toThrow(/API is required/u);
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      ...environment,
      API_KEY: ""
    })).toThrow(/API_KEY is required/u);
  });

  it("rejects former required names without compatibility aliases", () => {
    for (const legacyKey of legacyRequiredEnvironmentKeys) {
      expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
        ...environment,
        [legacyKey]: "legacy-value"
      })).toThrow(new RegExp(`${legacyKey} is unsupported`, "u"));
      expect(() => resolveWorkerRegistration({
        ...environment,
        [legacyKey]: "legacy-value"
      })).toThrow(/registration contains an unknown field/u);
    }
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
    const launchEnvironment = workerLaunchEnvironment({
      KEEP_ME: "yes",
      SMARTFLOW_PI_API: "legacy-api",
      SMARTFLOW_PI_BASE_URL: "https://legacy.example.test/v1",
      SMARTFLOW_PI_MODEL: "legacy-model",
      SMARTFLOW_PI_API_KEY: "legacy-secret"
    }, resolved);
    expect(launchEnvironment).toMatchObject({
      KEEP_ME: "yes",
      API: "openai-responses",
      BASE_URL: "https://models.example.test/v1",
      MODEL: "gpt-test",
      API_KEY: "secret-value",
      SMARTFLOW_PI_THINKING: "high",
      SMARTFLOW_PI_CONTEXT_WINDOW: "200000",
      SMARTFLOW_PI_MAX_TOKENS: "32000",
      SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "60000"
    });
    for (const legacyKey of legacyRequiredEnvironmentKeys) {
      expect(launchEnvironment).not.toHaveProperty(legacyKey);
    }
  });

  it("applies the single-model defaults for every supported API", () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai"
    ]) {
      const resolved = resolveWorkerLaunchConfiguration(["mcp"], {
        API: api,
        BASE_URL: "https://models.example.test/v1",
        MODEL: "model-test",
        API_KEY: "secret-value"
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
      .toThrow(/must use API, BASE_URL, MODEL, and API_KEY environment variables/u);
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
      API_KEY: "rotated-secret"
    });
    expect(piRuntimeConfigHash(second.runtimeConfig)).toBe(piRuntimeConfigHash(first.runtimeConfig));
    expect(daemonConfigFingerprint(first.runtimeConfig, first.credential))
      .not.toBe(daemonConfigFingerprint(second.runtimeConfig, second.credential));
  });
});
