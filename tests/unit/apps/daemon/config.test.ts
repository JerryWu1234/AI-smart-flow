import { describe, expect, it } from "vitest";

import {
  DEFAULT_REVIEW_STRATEGY,
  REVIEW_STRATEGIES,
  defaultSmartFlowConfig,
  loadSmartFlowConfig,
  parseSmartFlowConfig
} from "../../../../apps/daemon/src/config.js";

describe("SmartFlow daemon configuration", () => {
  it("uses codex as the default review strategy without a config version", async () => {
    const previousConfigPath = process.env.SMARTFLOW_CONFIG;
    Reflect.deleteProperty(process.env, "SMARTFLOW_CONFIG");
    try {
      expect(defaultSmartFlowConfig.review.strategy).toBe(DEFAULT_REVIEW_STRATEGY);
      const config = await loadSmartFlowConfig();
      expect(config.review.strategy).toBe("codex");
      expect(config).not.toHaveProperty("version");
    } finally {
      if (previousConfigPath === undefined) {
        Reflect.deleteProperty(process.env, "SMARTFLOW_CONFIG");
      } else {
        process.env.SMARTFLOW_CONFIG = previousConfigPath;
      }
    }
  });

  it("accepts every registered review strategy", () => {
    for (const strategy of REVIEW_STRATEGIES) {
      expect(parseSmartFlowConfig({ review: { strategy } }).review.strategy).toBe(strategy);
    }
  });

  it("defaults an omitted review strategy to codex", () => {
    expect(parseSmartFlowConfig({ review: {} }).review.strategy).toBe("codex");
  });

  it("rejects the removed config version field", () => {
    expect(() => parseSmartFlowConfig({ version: 5 }))
      .toThrow(/Unknown root configuration: version/u);
  });

  it("rejects the former daemon-codex strategy and unknown strategies", () => {
    for (const strategy of ["daemon-codex", "codexx"]) {
      expect(() => parseSmartFlowConfig({ review: { strategy } }))
        .toThrow(/unsupported values/u);
    }
  });

  it("continues to reject unknown review configuration keys", () => {
    expect(() => parseSmartFlowConfig({
      review: { strategy: "codex", agent: "codex" }
    })).toThrow(/Unknown review configuration: agent/u);
  });
});
