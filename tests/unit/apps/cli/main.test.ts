import { describe, expect, it } from "vitest";

import { runCli } from "../../../../apps/cli/src/main.js";

describe("SmartFlow CLI configuration", () => {
  it("rejects the removed --config option", async () => {
    for (const argv of [
      ["doctor", "--config", "smartflow.yml"],
      ["daemon", "--config=smartflow.yml"]
    ]) {
      await expect(runCli(argv)).rejects.toThrow(
        "--config is unsupported; configure Review with REVIEW_ADAPTER, REVIEW_MODEL, and REVIEW_EFFORT"
      );
    }
  });
});
