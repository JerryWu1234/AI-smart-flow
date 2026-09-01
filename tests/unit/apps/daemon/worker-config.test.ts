import { describe, expect, it } from "vitest";

import { piRuntimeConfigHash } from "@smartflow/provider-pi";

import {
  daemonConfigFingerprint,
  resolveMcpWorkerLaunchConfiguration,
  resolveWorkerLaunchConfiguration,
  resolveWorkerRegistration,
  workerLaunchEnvironment
} from "../../../../apps/daemon/src/config/worker-config.js";

const baseEnvironment = {
  API: "openai-responses",
  BASE_URL: "https://models.example.test/v1",
  MODEL: "gpt-test",
  SMARTFLOW_PI_CONTEXT_WINDOW: "200000",
  SMARTFLOW_PI_MAX_TOKENS: "32000",
  API_KEY: "secret-value",
  SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "60000"
};

const canonicalEnvironment = {
  ...baseEnvironment,
  SMARTFLOW_PI_THINKING: "high"
};

const mcpEnvironment = {
  ...baseEnvironment,
  EFFORT: "high"
};

const legacyRequiredEnvironmentKeys = [
  "SMARTFLOW_PI_API",
  "SMARTFLOW_PI_BASE_URL",
  "SMARTFLOW_PI_MODEL",
  "SMARTFLOW_PI_API_KEY"
] as const;

describe("Pi Worker launch configuration", () => {
  it("defaults an omitted API before hashing, registration, and launch", () => {
    const mcpWithoutApi = { ...mcpEnvironment };
    Reflect.deleteProperty(mcpWithoutApi, "API");
    const registrationWithoutApi = { ...canonicalEnvironment };
    Reflect.deleteProperty(registrationWithoutApi, "API");

    const resolved = resolveMcpWorkerLaunchConfiguration(["mcp"], mcpWithoutApi);
    const explicit = resolveMcpWorkerLaunchConfiguration(["mcp"], mcpEnvironment);

    expect(resolved.runtimeConfig.api).toBe("openai-responses");
    expect(resolveWorkerRegistration(registrationWithoutApi).runtimeConfig.api)
      .toBe("openai-responses");
    expect(piRuntimeConfigHash(resolved.runtimeConfig))
      .toBe(piRuntimeConfigHash(explicit.runtimeConfig));
    expect(resolved.daemonConfigFingerprint).toBe(explicit.daemonConfigFingerprint);
    expect(workerLaunchEnvironment({}, resolved).API).toBe("openai-responses");
  });

  it("requires explicit endpoint, model, and credential configuration", () => {
    expect(() => resolveMcpWorkerLaunchConfiguration(["mcp"], {
      API_KEY: "secret-value"
    })).toThrow(/BASE_URL is required/u);
    expect(() => resolveMcpWorkerLaunchConfiguration(["mcp"], {
      ...mcpEnvironment,
      MODEL: ""
    })).toThrow(/MODEL is required/u);
    expect(() => resolveMcpWorkerLaunchConfiguration(["mcp"], {
      ...mcpEnvironment,
      API_KEY: ""
    })).toThrow(/API_KEY is required/u);
  });

  it("rejects blank and unsupported explicit APIs", () => {
    for (const API of ["", "unknown-api"]) {
      expect(() => resolveMcpWorkerLaunchConfiguration(["mcp"], {
        ...mcpEnvironment,
        API
      })).toThrow(/API is unsupported/u);
    }
  });

  it("rejects former required names without compatibility aliases", () => {
    for (const legacyKey of legacyRequiredEnvironmentKeys) {
      expect(() => resolveMcpWorkerLaunchConfiguration(["mcp"], {
        ...mcpEnvironment,
        [legacyKey]: "legacy-value"
      })).toThrow(new RegExp(`${legacyKey} is unsupported`, "u"));
      expect(() => resolveWorkerRegistration({
        ...canonicalEnvironment,
        [legacyKey]: "legacy-value"
      })).toThrow(/registration contains an unknown field/u);
    }
  });

  it("freezes direct MCP model configuration without credential bytes", () => {
    const resolved = resolveMcpWorkerLaunchConfiguration(["mcp"], mcpEnvironment);
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
    const canonical = resolveWorkerLaunchConfiguration(["daemon"], canonicalEnvironment);
    expect(resolved.runtimeConfig).toEqual(canonical.runtimeConfig);
    expect(resolved.daemonConfigFingerprint).toBe(canonical.daemonConfigFingerprint);
    expect(resolveWorkerRegistration(workerLaunchEnvironment({}, resolved))).toEqual(resolved);
    const launchEnvironment = workerLaunchEnvironment({
      KEEP_ME: "yes",
      EFFORT: "max",
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
    expect(launchEnvironment).not.toHaveProperty("EFFORT");
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
      const resolved = resolveMcpWorkerLaunchConfiguration(["mcp"], {
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
    expect(() => resolveMcpWorkerLaunchConfiguration(
      ["mcp", "--model", "gpt-test"],
      mcpEnvironment
    )).toThrow(/must use BASE_URL, MODEL, and API_KEY environment variables; API is optional/u);
    expect(() => resolveMcpWorkerLaunchConfiguration(["mcp"], {
      ...mcpEnvironment,
      SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "0"
    })).toThrow(/SMARTFLOW_PI_ATTEMPT_DEADLINE_MS/u);
    expect(() => resolveMcpWorkerLaunchConfiguration(["mcp"], {
      ...mcpEnvironment,
      SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "59999"
    })).toThrow(/must be at least 60000/u);
    expect(() => resolveMcpWorkerLaunchConfiguration(["mcp"], {
      ...mcpEnvironment,
      SMARTFLOW_PI_MAX_TOKENS: "200001"
    })).toThrow(/must not exceed SMARTFLOW_PI_CONTEXT_WINDOW/u);
    expect(() => resolveMcpWorkerLaunchConfiguration(["mcp"], canonicalEnvironment))
      .toThrow(/SMARTFLOW_PI_THINKING is internal; MCP configuration must use EFFORT/u);
    expect(() => resolveMcpWorkerLaunchConfiguration(["mcp"], {
      ...mcpEnvironment,
      EFFORT: "turbo"
    })).toThrow(/PI_RUNTIME_CONFIG_INVALID/u);
  });

  it("keeps Reviewer settings out of the Worker daemon fingerprint", () => {
    const first = resolveMcpWorkerLaunchConfiguration(["mcp"], {
      ...mcpEnvironment,
      REVIEW_ADAPTER: "codex",
      REVIEW_MODEL: "gpt-review-a",
      REVIEW_EFFORT: "low"
    });
    const second = resolveMcpWorkerLaunchConfiguration(["mcp"], {
      ...mcpEnvironment,
      REVIEW_ADAPTER: "claude-code",
      REVIEW_MODEL: "claude-review-b",
      REVIEW_EFFORT: "high"
    });
    expect(second.daemonConfigFingerprint).toBe(first.daemonConfigFingerprint);
  });

  it("keeps credentials out of runtime hashes but rotates the daemon fingerprint", () => {
    const first = resolveMcpWorkerLaunchConfiguration(["mcp"], mcpEnvironment);
    const second = resolveMcpWorkerLaunchConfiguration(["mcp"], {
      ...mcpEnvironment,
      API_KEY: "rotated-secret"
    });
    expect(piRuntimeConfigHash(second.runtimeConfig)).toBe(piRuntimeConfigHash(first.runtimeConfig));
    expect(daemonConfigFingerprint(first.runtimeConfig, first.credential))
      .not.toBe(daemonConfigFingerprint(second.runtimeConfig, second.credential));
  });
});
