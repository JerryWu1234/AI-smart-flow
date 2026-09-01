import { describe, expect, it } from "vitest";

import { StructuredLogger } from "../../../../packages/observability/src/logger.js";
import { MetricsRegistry } from "../../../../packages/observability/src/metrics.js";

describe("structured observability", () => {
  it("keeps correlation and duration fields while removing secrets and complete env maps", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger("test", (line) => lines.push(line), () => new Date("2026-07-20T00:00:00Z"));
    const record = logger.log({
      level: "info",
      event: "worker.completed",
      stage: "worker",
      durationMs: 12,
      correlation: { projectId: "project-1", jobId: "job-1", actionId: "action-1" },
      data: {
        token: "token-value",
        env: { SAFE: "visible", API_TOKEN: "secret-value" },
        message: "AUTH_TOKEN=secret-value Bearer abc.def.ghi"
      }
    });
    const serialized = lines.join("\n");
    expect(record.correlation).toMatchObject({ jobId: "job-1", actionId: "action-1" });
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("token-value");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("visible");
  });

  it("aggregates stage durations and failures", () => {
    const metrics = new MetricsRegistry();
    metrics.recordStage("worker", 10, true);
    metrics.recordStage("worker", 20, false);
    expect(metrics.snapshot()).toEqual({
      worker: { count: 2, failures: 1, totalDurationMs: 30, maxDurationMs: 20 }
    });
  });
});
