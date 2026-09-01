import { describe, expect, it } from "vitest";

import {
  REVIEW_STRATEGIES,
  resolveReviewStrategy,
  resolveSmartFlowConfig
} from "../../../../apps/daemon/src/config/config.js";

describe("SmartFlow daemon configuration", () => {
  it("uses Host selection when REVIEW_ADAPTER is omitted", () => {
    expect(REVIEW_STRATEGIES).toEqual([
      "codex",
      "codex-desktop",
      "claude-code",
      "claude-code-desktop",
      "opencode"
    ]);
    const config = resolveSmartFlowConfig({});
    expect(config.review).toEqual({});
    expect(resolveReviewStrategy(config.review.strategy, "codex-desktop"))
      .toBe("codex-desktop");
    expect(resolveReviewStrategy(config.review.strategy, "claude-code"))
      .toBe("claude-code");
    expect(resolveReviewStrategy(config.review.strategy, "claude-code-desktop"))
      .toBe("claude-code-desktop");
    expect(resolveReviewStrategy(config.review.strategy, "opencode"))
      .toBe("opencode");
    expect(resolveReviewStrategy(config.review.strategy, "OpenCode")).toBe("codex");
    expect(resolveReviewStrategy(config.review.strategy, " open-code ")).toBe("codex");
    expect(resolveReviewStrategy(config.review.strategy, "CODEX-DESKTOP")).toBe("codex");
    expect(resolveReviewStrategy(config.review.strategy, " codex-desktop ")).toBe("codex");
    expect(resolveReviewStrategy(config.review.strategy, "kiro")).toBe("codex");
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

  it("accepts every registered REVIEW_ADAPTER", () => {
    for (const strategy of REVIEW_STRATEGIES) {
      expect(resolveSmartFlowConfig({ REVIEW_ADAPTER: strategy }).review.strategy).toBe(strategy);
    }
  });

  it("trims and forwards REVIEW_MODEL and REVIEW_EFFORT", () => {
    expect(resolveSmartFlowConfig({
      REVIEW_ADAPTER: " opencode ",
      REVIEW_MODEL: " anthropic/claude-sonnet-4 ",
      REVIEW_EFFORT: " high "
    }).review).toEqual({
      strategy: "opencode",
      model: "anthropic/claude-sonnet-4",
      effort: "high"
    });
  });

  it("rejects an unsupported REVIEW_ADAPTER without falling back", () => {
    expect(() => resolveSmartFlowConfig({ REVIEW_ADAPTER: "missing-agent" }))
      .toThrow(
        "REVIEW_ADAPTER_INVALID: unsupported adapter \"missing-agent\"; expected codex, codex-desktop, claude-code, claude-code-desktop, or opencode"
      );
  });

  it("rejects blank REVIEW_* values", () => {
    for (const key of ["REVIEW_ADAPTER", "REVIEW_MODEL", "REVIEW_EFFORT"] as const) {
      expect(() => resolveSmartFlowConfig({ [key]: "  " }))
        .toThrow(`REVIEW_CONFIG_INVALID: ${key} must not be empty`);
    }
  });

  it("rejects the removed SMARTFLOW_CONFIG file setting", () => {
    expect(() => resolveSmartFlowConfig({ SMARTFLOW_CONFIG: "/tmp/smartflow.yml" }))
      .toThrow(
        "REVIEW_CONFIG_INVALID: SMARTFLOW_CONFIG is unsupported; use REVIEW_ADAPTER, REVIEW_MODEL, and REVIEW_EFFORT"
      );
  });
});
