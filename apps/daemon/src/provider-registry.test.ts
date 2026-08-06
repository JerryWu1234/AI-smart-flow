import { describe, expect, it } from "vitest";

import {
  frozenPiRuntimeConfig,
  piRuntimeConfigHash,
  type PiRuntimeConfiguration
} from "@smartflow/provider-pi";

import { ProviderRegistry } from "./provider-registry.js";
import {
  daemonConfigFingerprint,
  type ResolvedWorkerLaunchConfiguration
} from "./worker-config.js";

function configuration(modelId: string, deadline = 60_000): ResolvedWorkerLaunchConfiguration {
  const runtimeConfig: PiRuntimeConfiguration = {
    api: "openai-completions",
    baseUrl: "https://models.example.test/v1",
    modelId,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinkingLevel: "high",
    attemptDeadlineMs: deadline,
    resourcePolicy: "workspace-project-resources"
  };
  const credential = "secret-value";
  return {
    runtimeConfig,
    credential,
    daemonConfigFingerprint: daemonConfigFingerprint(runtimeConfig, credential)
  };
}

describe("ProviderRegistry", () => {
  it("registers only Pi and keeps distinct frozen runtime configurations", () => {
    const registry = new ProviderRegistry();
    const firstConfig = configuration("model-a");
    const secondConfig = configuration("model-b", 90_000);
    const first = registry.register(firstConfig);
    const second = registry.register(secondConfig);
    expect(first.providerRuntimeConfigHash).toBe(piRuntimeConfigHash(firstConfig.runtimeConfig));
    expect(second.providerRuntimeConfigHash).toBe(piRuntimeConfigHash(secondConfig.runtimeConfig));
    expect(first.providerRuntimeConfigHash).not.toBe(second.providerRuntimeConfigHash);
    expect(registry.resolve(first.providerRuntimeConfigHash)).toMatchObject({
      provider: first.provider,
      providerRuntimeConfig: frozenPiRuntimeConfig(firstConfig.runtimeConfig)
    });
  });

  it("reuses an identical registered Pi configuration", () => {
    const registry = new ProviderRegistry();
    const config = configuration("model-a");
    expect(registry.register(config)).toBe(registry.register(config));
  });
});
