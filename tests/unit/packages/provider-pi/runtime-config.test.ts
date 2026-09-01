import { describe, expect, it } from "vitest";

import { PI_MINIMUM_ATTEMPT_DEADLINE_MS } from "../../../../packages/provider-pi/src/heartbeat.js";
import { PiProvider } from "../../../../packages/provider-pi/src/pi-provider.js";
import {
  parsePiRuntimeConfiguration,
  piRuntimeConfigHash,
  type PiRuntimeConfiguration
} from "../../../../packages/provider-pi/src/runtime-config.js";

const configuration: PiRuntimeConfiguration = {
  api: "openai-completions",
  baseUrl: "https://models.example.test/v1",
  modelId: "gpt-test",
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  thinkingLevel: "high",
  attemptDeadlineMs: 60_000,
  resourcePolicy: "workspace-project-resources"
};

describe("Pi runtime configuration", () => {
  it("hashes behavior and deadline without credential bytes", () => {
    const first = piRuntimeConfigHash(configuration);
    const second = piRuntimeConfigHash({ ...configuration, attemptDeadlineMs: 90_000 });
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
    expect(JSON.stringify(configuration)).not.toContain("secret-value");
  });

  it("strictly rejects unknown and credential-value fields", () => {
    expect(parsePiRuntimeConfiguration(configuration)).toEqual(configuration);
    expect(() => parsePiRuntimeConfiguration({ ...configuration, apiKey: "secret-value" }))
      .toThrow(/PI_RUNTIME_CONFIG_INVALID/u);
    expect(() => parsePiRuntimeConfiguration({ ...configuration, api: "openai" }))
      .toThrow(/PI_RUNTIME_CONFIG_INVALID/u);
    expect(() => parsePiRuntimeConfiguration({ ...configuration, maxTokens: 1_000_001 }))
      .toThrow(/PI_RUNTIME_CONFIG_INVALID/u);
    expect(() => parsePiRuntimeConfiguration({
      ...configuration,
      attemptDeadlineMs: PI_MINIMUM_ATTEMPT_DEADLINE_MS - 1
    })).toThrow(/PI_RUNTIME_CONFIG_INVALID/u);
  });

  it("fails a Worker Attempt before launch when the frozen hash drifts", async () => {
    const provider = new PiProvider({
      runtimeConfig: configuration,
      environment: { WORK_API_KEY: "secret-value" }
    });
    const events = provider.start({
      attemptId: "attempt-1",
      generation: 0,
      workspaceDir: "/workspace",
      prompt: "work",
      providerRuntimeConfigHash: "f".repeat(64),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      containment: {
        registryPath: "/workspace/.smartflow-runtime/containments.json",
        homeDirectory: "/workspace/.smartflow-runtime/home",
        tempDirectory: "/workspace/.smartflow-runtime/tmp",
        runtimeReadPaths: [],
        deniedReadPaths: []
      }
    });
    await expect(events[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { type: "FAILED", code: "PROVIDER_RUNTIME_CONFIG_DRIFT" }
    });
  });
});
