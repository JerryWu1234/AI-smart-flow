import { createConnection } from "node:net";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalIpcClient,
  LocalIpcServer,
  resolveWorkerLaunchConfiguration,
  startSmartFlowDaemon
} from "@smartflow/daemon";
import { JobRunner } from "../helpers/job-runner.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const activeHarnesses: RuntimeHarness[] = [];
const activeServers: LocalIpcServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

async function waitUntilCompleted(runner: JobRunner, jobId: string): Promise<void> {
  let snapshot = runner.get(jobId);
  while (snapshot.status === "QUEUED" || snapshot.status === "RUNNING") {
    const waited = await runner.waitForChange(jobId, snapshot.stateVersion, 2_000);
    snapshot = waited.snapshot;
  }
  expect(snapshot.status).toBe("SUCCEEDED");
}

describe("short MCP calls and independent daemon jobs", () => {
  it("returns execute quickly and keeps the job alive after Gateway disconnect", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const runner = new JobRunner();
    let observedClientName: string | undefined;
    const server = new LocalIpcServer(resolve(harness.dataDir, "daemon"), (request) => {
      if (request.method !== "smartflow_execute") throw new Error("unexpected method");
      observedClientName = request.clientName;
      runner.enqueue("job-1", async () => {
        await new Promise<void>((settle) => setTimeout(settle, 100));
        return { candidate: "ready" };
      });
      return Promise.resolve({ jobId: "job-1", phase: "PREPARING" });
    });
    await server.start();
    activeServers.push(server);
    const client = await LocalIpcClient.connect(server.endpoint);
    const startedAt = performance.now();
    const response = await client.call(
      "smartflow_execute",
      { requestId: "request-1" },
      "codex-desktop"
    );
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(response).toEqual({ jobId: "job-1", phase: "PREPARING" });
    expect(observedClientName).toBe("codex-desktop");
    client.close();
    await waitUntilCompleted(runner, "job-1");
  });

  it("rejects a second daemon instance and a mismatched peer user", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "singleton-daemon");
    const first = new LocalIpcServer(dataDirectory, () => Promise.resolve({}));
    await Promise.all([first.start(), first.start()]);
    await first.start();
    activeServers.push(first);
    const second = new LocalIpcServer(dataDirectory, () => Promise.resolve({}));
    await expect(second.start()).rejects.toMatchObject({ code: "PROJECT_LOCKED" });

    const socket = createConnection(first.endpoint);
    socket.setEncoding("utf8");
    await new Promise<void>((settle, reject) => {
      socket.once("connect", settle);
      socket.once("error", reject);
    });
    socket.write(
      `${JSON.stringify({
        type: "handshake",
        uid: (process.getuid?.() ?? 0) + 1
      })}\n`
    );
    const response = await new Promise<string>((settle, reject) => {
      socket.once("data", settle);
      socket.once("error", reject);
    });
    expect(JSON.parse(response.trim())).toMatchObject({
      ok: false,
      error: { code: "IPC_PEER_REJECTED" }
    });
    socket.destroy();
    await expect(runnerWaitLimit()).rejects.toThrow(/between 0 and 30000ms/u);
  });

  it("keeps the first daemon endpoint after production startup rejects a second instance", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "prod");
    const workerLaunchConfiguration = resolveWorkerLaunchConfiguration([], {
      API: "openai-responses",
      BASE_URL: "https://models.example.test/v1",
      MODEL: "test-model",
      API_KEY: "test-credential"
    });
    const first = await startSmartFlowDaemon({
      dataDirectory,
      workerLaunchConfiguration,
      handler: () => Promise.resolve({ instance: "first" })
    });
    try {
      await expect(startSmartFlowDaemon({
        dataDirectory,
        workerLaunchConfiguration,
        handler: () => Promise.resolve({ instance: "second" })
      })).rejects.toMatchObject({ code: "PROJECT_LOCKED" });

      const client = await LocalIpcClient.connect(first.server.endpoint);
      try {
        await expect(client.call("smartflow_health", {})).resolves.toEqual({ instance: "first" });
      } finally {
        client.close();
      }
    } finally {
      await first.close();
    }
  });

  it("rejects daemon connections with stale or missing configuration fingerprints", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);

    const configuredServer = new LocalIpcServer(
      resolve(harness.dataDir, "c"),
      () => Promise.resolve({ ok: true }),
      "fingerprint-a"
    );
    await configuredServer.start();
    activeServers.push(configuredServer);

    const matchingClient = await LocalIpcClient.connect(
      configuredServer.endpoint,
      2_000,
      "fingerprint-a"
    );
    expect(await matchingClient.call("health", {})).toEqual({ ok: true });
    matchingClient.close();
    await expect(LocalIpcClient.connect(
      configuredServer.endpoint,
      2_000,
      "fingerprint-b"
    )).rejects.toMatchObject({ code: "DAEMON_CONFIGURATION_MISMATCH" });

    const legacyServer = new LocalIpcServer(
      resolve(harness.dataDir, "l"),
      () => Promise.resolve({})
    );
    await legacyServer.start();
    activeServers.push(legacyServer);
    await expect(LocalIpcClient.connect(
      legacyServer.endpoint,
      2_000,
      "fingerprint-a"
    )).rejects.toMatchObject({ code: "DAEMON_CONFIGURATION_MISMATCH" });
  });

  it("binds a registered Provider configuration to one daemon connection", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const providerRuntimeConfigHash = "b".repeat(64);
    const server = new LocalIpcServer(
      resolve(harness.dataDir, "registered"),
      (request) => Promise.resolve({
        providerRuntimeConfigHash: request.providerRuntimeConfigHash
      }),
      "fingerprint-a",
      (environment) => {
        expect(environment).toMatchObject({
          API: "openai-responses",
          BASE_URL: "https://models.example.test/v1",
          MODEL: "second-model"
        });
        return {
          daemonConfigFingerprint: "fingerprint-b",
          providerRuntimeConfigHash
        };
      }
    );
    await server.start();
    activeServers.push(server);

    const client = await LocalIpcClient.connect(
      server.endpoint,
      2_000,
      "fingerprint-b",
      {
        API: "openai-responses",
        BASE_URL: "https://models.example.test/v1",
        MODEL: "second-model",
        API_KEY: "secret-value"
      }
    );

    await expect(client.call("health", {})).resolves.toEqual({ providerRuntimeConfigHash });
    client.close();
  });
});

async function runnerWaitLimit(): Promise<void> {
  const runner = new JobRunner();
  runner.enqueue("job", () => Promise.resolve(undefined));
  await runner.waitForChange("job", 0, 30_001);
}
