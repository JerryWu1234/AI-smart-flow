import { describe, expect, it } from "vitest";

import {
  REVIEW_STRATEGIES,
  defaultSmartFlowConfig,
  loadSmartFlowConfig,
  parseSmartFlowConfig,
  resolveReviewStrategy
} from "../../../../apps/daemon/src/config/config.js";

describe("SmartFlow daemon configuration", () => {
  it("uses Host selection when no review strategy is configured", async () => {
    const previousConfigPath = process.env.SMARTFLOW_CONFIG;
    Reflect.deleteProperty(process.env, "SMARTFLOW_CONFIG");
    try {
      expect(REVIEW_STRATEGIES).toEqual([
        "codex",
        "codex-desktop",
        "claude-code",
        "claude-code-desktop"
      ]);
      expect(defaultSmartFlowConfig.review).not.toHaveProperty("strategy");
      const config = await loadSmartFlowConfig();
      expect(config.review).not.toHaveProperty("strategy");
      expect(resolveReviewStrategy(config.review.strategy, "codex-desktop"))
        .toBe("codex-desktop");
      expect(resolveReviewStrategy(config.review.strategy, "claude-code"))
        .toBe("claude-code");
      expect(resolveReviewStrategy(config.review.strategy, "CODEX-DESKTOP")).toBe("codex");
      expect(resolveReviewStrategy(config.review.strategy, " codex-desktop ")).toBe("codex");
      expect(resolveReviewStrategy(config.review.strategy, "kiro")).toBe("codex");
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

  it("selects the Desktop compatibility strategy only by its registered name", () => {
    expect(resolveReviewStrategy(undefined, "claude-code-desktop"))
      .toBe("claude-code-desktop");
    for (const clientName of [
      "claude-ai",
      "Anthropic",
      "Anthropic/claude-desktop"
    ]) {
      expect(resolveReviewStrategy(undefined, clientName)).toBe("codex");
    }
    expect(resolveReviewStrategy("claude-code-desktop", "claude-ai"))
      .toBe("claude-code-desktop");
  });

  it("accepts every registered review strategy", () => {
    for (const strategy of REVIEW_STRATEGIES) {
      expect(parseSmartFlowConfig({ review: { strategy } }).review.strategy).toBe(strategy);
    }
  });

  it("leaves an omitted review strategy available for Host selection", () => {
    expect(parseSmartFlowConfig({ review: {} }).review).not.toHaveProperty("strategy");
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
