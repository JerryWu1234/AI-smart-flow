import { describe, expect, it } from "vitest";

import { runDoctor, type DoctorProbe } from "../../../../apps/cli/src/doctor.js";

describe("SmartFlow doctor classification", () => {
  it("reports a direct MCP field failure without exposing the API Key", async () => {
    const report = await runDoctor({
      projectRoot: process.cwd(),
      environment: {
        WORK_API: "openai-completions",
        WORK_MODEL: "model-test",
        WORK_API_KEY: "doctor-secret-canary"
      }
    });
    expect(report).toMatchObject({ status: "blocking-unavailable", ready: false });
    expect(Object.keys(report).sort()).toEqual([
      "capabilities",
      "config",
      "dataDirectory",
      "ready",
      "status"
    ]);
    expect(report.capabilities[0]?.id).toBe("config");
    expect(report.capabilities[0]?.summary).toMatch(/WORK_BASE_URL is required/u);
    expect(JSON.stringify(report)).not.toContain("doctor-secret-canary");
  });

  it("distinguishes ready, optional unavailable, and blocking unavailable capabilities", async () => {
    const probes: DoctorProbe[] = [
      {
        id: "provider",
        required: true,
        run: () => Promise.resolve({ available: true, summary: "ready" })
      },
      {
        id: "apply-adapter",
        required: false,
        run: () => Promise.resolve({ available: false, summary: "manual publish required" })
      }
    ];
    const optional = await runDoctor({ projectRoot: process.cwd(), probes });
    expect(optional).toMatchObject({ status: "optional-unavailable", ready: true });
    expect(optional.capabilities).toMatchObject([
      { id: "provider", status: "ready" },
      { id: "apply-adapter", status: "optional-unavailable" }
    ]);
    probes.push({
      id: "sandbox",
      required: true,
      run: () => Promise.resolve({ available: false, summary: "unavailable" })
    });
    const blocked = await runDoctor({ projectRoot: process.cwd(), probes });
    expect(blocked).toMatchObject({ status: "blocking-unavailable", ready: false });
  });
});

describe("SmartFlow doctor Review configuration", () => {
  it("reports invalid REVIEW_* configuration as blocking", async () => {
    const report = await runDoctor({
      projectRoot: process.cwd(),
      environment: {
        WORK_API: "openai-completions",
        WORK_BASE_URL: "https://models.example.test/v1",
        WORK_MODEL: "model-test",
        WORK_API_KEY: "doctor-secret-canary",
        REVIEW_ADAPTER: "unknown-reviewer"
      }
    });
    expect(report).toMatchObject({ status: "blocking-unavailable", ready: false });
    expect(report.capabilities[0]).toMatchObject({
      id: "config",
      status: "blocking-unavailable"
    });
    expect(report.capabilities[0]?.summary).toMatch(/REVIEW_ADAPTER_INVALID/u);
    expect(JSON.stringify(report)).not.toContain("doctor-secret-canary");
  });
});