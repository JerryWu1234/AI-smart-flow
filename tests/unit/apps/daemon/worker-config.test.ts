import { describe, expect, it } from "vitest";

import { piRuntimeConfigHash } from "@smartflow/provider-pi";

import {
  daemonConfigFingerprint,
  resolveWorkerLaunchConfiguration,
  resolveWorkerRegistration,
  workerLaunchEnvironment
} from "../../../../apps/daemon/src/config/worker-config.js";

const workEnvironment = {
  WORK_API: "openai-responses",
  WORK_BASE_URL: "https://models.example.test/v1",
  WORK_MODEL: "gpt-test",
  WORK_API_KEY: "secret-value",
  WORK_CONTEXT_WINDOW: "200000",
  WORK_MAX_TOKENS: "32000",
  WORK_EFFORT: "high",
  WORK_ATTEMPT_DEADLINE_MS: "60000"
};

describe("Pi Worker launch configuration", () => {
  it("defaults an omitted WORK_API before hashing, registration, and launch", () => {
    const withoutApi = { ...workEnvironment };
    Reflect.deleteProperty(withoutApi, "WORK_API");

    const resolved = resolveWorkerLaunchConfiguration(["mcp"], withoutApi);
    const explicit = resolveWorkerLaunchConfiguration(["mcp"], workEnvironment);

    expect(resolved.runtimeConfig.api).toBe("openai-responses");
    expect(resolveWorkerRegistration(withoutApi).runtimeConfig.api).toBe("openai-responses");
    expect(piRuntimeConfigHash(resolved.runtimeConfig))
      .toBe(piRuntimeConfigHash(explicit.runtimeConfig));
    expect(resolved.daemonConfigFingerprint).toBe(explicit.daemonConfigFingerprint);
    expect(workerLaunchEnvironment({}, resolved).WORK_API).toBe("openai-responses");
  });

  it("requires explicit endpoint, model, and credential configuration", () => {
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      WORK_API_KEY: "secret-value"
    })).toThrow(/WORK_BASE_URL is required/u);
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      ...workEnvironment,
      WORK_MODEL: ""
    })).toThrow(/WORK_MODEL is required/u);
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      ...workEnvironment,
      WORK_API_KEY: ""
    })).toThrow(/WORK_API_KEY is required/u);
  });

  it("rejects blank and unsupported explicit APIs", () => {
    for (const WORK_API of ["", "unknown-api"]) {
      expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
        ...workEnvironment,
        WORK_API
      })).toThrow(/WORK_API is unsupported/u);
    }
  });

  it("freezes direct MCP model configuration without credential bytes", () => {
    const resolved = resolveWorkerLaunchConfiguration(["mcp"], workEnvironment);
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
    expect(resolveWorkerRegistration(workerLaunchEnvironment({}, resolved))).toEqual(resolved);
    const launchEnvironment = workerLaunchEnvironment({ KEEP_ME: "yes" }, resolved);
    expect(launchEnvironment).toMatchObject({
      KEEP_ME: "yes",
      WORK_API: "openai-responses",
      WORK_BASE_URL: "https://models.example.test/v1",
      WORK_MODEL: "gpt-test",
      WORK_API_KEY: "secret-value",
      WORK_CONTEXT_WINDOW: "200000",
      WORK_MAX_TOKENS: "32000",
      WORK_EFFORT: "high",
      WORK_ATTEMPT_DEADLINE_MS: "60000"
    });
  });

  it("overwrites stale WORK_ values from the base environment", () => {
    const resolved = resolveWorkerLaunchConfiguration(["mcp"], workEnvironment);
    const launchEnvironment = workerLaunchEnvironment({
      WORK_MODEL: "stale-model",
      WORK_EFFORT: "off",
      WORK_API_KEY: "stale-secret"
    }, resolved);
    expect(launchEnvironment.WORK_MODEL).toBe("gpt-test");
    expect(launchEnvironment.WORK_EFFORT).toBe("high");
    expect(launchEnvironment.WORK_API_KEY).toBe("secret-value");
  });

  it("rejects registrations carrying fields outside the WORK_ namespace", () => {
    expect(() => resolveWorkerRegistration({
      ...workEnvironment,
      WORK_UNKNOWN: "value"
    })).toThrow(/registration contains an unknown field/u);
  });

  it("applies the single-model defaults for every supported API", () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai"
    ]) {
      const resolved = resolveWorkerLaunchConfiguration(["mcp"], {
        WORK_API: api,
        WORK_BASE_URL: "https://models.example.test/v1",
        WORK_MODEL: "model-test",
        WORK_API_KEY: "secret-value"
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
    expect(() => resolveWorkerLaunchConfiguration(
      ["mcp", "--model", "gpt-test"],
      workEnvironment
    )).toThrow(
      /must use WORK_BASE_URL, WORK_MODEL, and WORK_API_KEY environment variables; WORK_API is optional/u
    );
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      ...workEnvironment,
      WORK_ATTEMPT_DEADLINE_MS: "0"
    })).toThrow(/WORK_ATTEMPT_DEADLINE_MS/u);
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      ...workEnvironment,
      WORK_ATTEMPT_DEADLINE_MS: "59999"
    })).toThrow(/must be at least 60000/u);
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      ...workEnvironment,
      WORK_MAX_TOKENS: "200001"
    })).toThrow(/must not exceed WORK_CONTEXT_WINDOW/u);
    expect(() => resolveWorkerLaunchConfiguration(["mcp"], {
      ...workEnvironment,
      WORK_EFFORT: "turbo"
    })).toThrow(/PI_RUNTIME_CONFIG_INVALID/u);
  });

  it("keeps Reviewer settings out of the Worker daemon fingerprint", () => {
    const first = resolveWorkerLaunchConfiguration(["mcp"], {
      ...workEnvironment,
      REVIEW_ADAPTER: "codex",
      REVIEW_MODEL: "gpt-review-a",
      REVIEW_EFFORT: "low"
    });
    const second = resolveWorkerLaunchConfiguration(["mcp"], {
      ...workEnvironment,
      REVIEW_ADAPTER: "claude-code",
      REVIEW_MODEL: "claude-review-b",
      REVIEW_EFFORT: "high"
    });
    expect(second.daemonConfigFingerprint).toBe(first.daemonConfigFingerprint);
  });

  it("keeps credentials out of runtime hashes but rotates the daemon fingerprint", () => {
    const first = resolveWorkerLaunchConfiguration(["mcp"], workEnvironment);
    const second = resolveWorkerLaunchConfiguration(["mcp"], {
      ...workEnvironment,
      WORK_API_KEY: "rotated-secret"
    });
    expect(piRuntimeConfigHash(second.runtimeConfig)).toBe(piRuntimeConfigHash(first.runtimeConfig));
    expect(daemonConfigFingerprint(first.runtimeConfig, first.credential))
      .not.toBe(daemonConfigFingerprint(second.runtimeConfig, second.credential));
  });
});
