import { describe, expect, it } from "vitest";

import { runDoctor, type DoctorProbe } from "../../../../apps/cli/src/doctor.js";

describe("SmartFlow doctor classification", () => {
  it("reports a direct MCP field failure without exposing the API Key", async () => {
    const report = await runDoctor({
      projectRoot: process.cwd(),
      environment: {
        SMARTFLOW_PI_API: "openai-completions",
        SMARTFLOW_PI_MODEL: "model-test",
        SMARTFLOW_PI_API_KEY: "doctor-secret-canary"
      }
    });
    expect(report).toMatchObject({ status: "blocking-unavailable", ready: false });
    expect(Object.keys(report).sort()).toEqual([
      "capabilities",
      "config",
      "dataDirectory",
      "ready",
      "schemaVersion",
      "status"
    ]);
    expect(report.capabilities[0]?.id).toBe("config");
    expect(report.capabilities[0]?.summary).toMatch(/SMARTFLOW_PI_BASE_URL is required/u);
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
