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
      expect(REVIEW_STRATEGIES).toEqual(["codex", "codex-desktop"]);
      expect(defaultSmartFlowConfig.review.strategy).toBe(DEFAULT_REVIEW_STRATEGY);
      const config = await loadSmartFlowConfig();
      expect(config.review.strategy).toBe("codex");
      expect(parseSmartFlowConfig({
        review: { strategy: "codex-desktop" }
      }).review.strategy).toBe("codex-desktop");
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

  it("rejects removed top-level configuration", () => {
    expect(() => parseSmartFlowConfig({ version: 5 }))
      .toThrow(/Unknown root configuration: version/u);
    expect(() => parseSmartFlowConfig({ workspace: { mode: "git-tree" } }))
      .toThrow(/Unknown root configuration: workspace/u);
    expect(() => parseSmartFlowConfig({ publish: { mode: "auto-after-review" } }))
      .toThrow(/Unknown root configuration: publish/u);
  });

  it("rejects the former daemon-codex strategy and unknown strategies", () => {
    for (const strategy of ["daemon-codex", "codexx"]) {
      expect(() => parseSmartFlowConfig({ review: { strategy } }))
        .toThrow(/unsupported values/u);
    }
  });

  it("rejects unknown and removed review configuration keys", () => {
    expect(() => parseSmartFlowConfig({
      review: { strategy: "codex", agent: "codex" }
    })).toThrow(/Unknown review configuration: agent/u);
    expect(() => parseSmartFlowConfig({
      review: { onUnavailable: "pause" }
    })).toThrow(/Unknown review configuration: onUnavailable/u);
    expect(defaultSmartFlowConfig.review).not.toHaveProperty("onUnavailable");
    expect(parseSmartFlowConfig({ review: {} }).review).not.toHaveProperty("onUnavailable");
  });

  it("leaves an omitted review model and effort undefined", () => {
    for (const review of [
      defaultSmartFlowConfig.review,
      parseSmartFlowConfig({ review: {} }).review
    ]) {
      expect(review.model).toBeUndefined();
      expect(review.effort).toBeUndefined();
      expect(review).not.toHaveProperty("model");
      expect(review).not.toHaveProperty("effort");
    }
  });

  // The Review Agent owns which values it accepts, so any non-empty string is
  // forwarded after surrounding configuration whitespace is removed.
  it("forwards any non-empty review model and effort verbatim", () => {
    expect(parseSmartFlowConfig({
      review: { model: "  gpt-5.6-terra  ", effort: "  max  " }
    }).review).toMatchObject({ model: "gpt-5.6-terra", effort: "max" });
    expect(parseSmartFlowConfig({ review: { effort: "not-a-real-effort" } }).review.effort)
      .toBe("not-a-real-effort");
  });

  it("rejects a blank or non-string review model and effort", () => {
    for (const review of [
      { model: "" },
      { model: "   " },
      { model: 5 },
      { effort: "" },
      { effort: "   " },
      { effort: 5 }
    ]) {
      expect(() => parseSmartFlowConfig({ review })).toThrow(/unsupported values/u);
    }
  });
});
