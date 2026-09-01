import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { connectOrLaunchDaemon } from "../../../../apps/daemon/src/transport/daemon-launcher.js";
import { LocalIpcServer } from "../../../../apps/daemon/src/transport/local-ipc-server.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

const servers: LocalIpcServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("daemon launcher", () => {
  it("does not start another daemon when the running daemon configuration differs", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "smartflow-daemon-launcher-"));
    directories.push(directory);
    const server = new LocalIpcServer(directory, () => Promise.resolve({}), "fingerprint-a");
    await server.start();
    servers.push(server);

    await expect(connectOrLaunchDaemon(
      server.endpoint,
      { command: process.execPath, argv: [], cwd: directory, env: {} },
      10_000,
      "fingerprint-b"
    )).rejects.toMatchObject({ code: "DAEMON_CONFIGURATION_MISMATCH" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reuses a running daemon after registering a different Provider configuration", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "smartflow-daemon-launcher-"));
    directories.push(directory);
    const server = new LocalIpcServer(
      directory,
      () => Promise.resolve({}),
      "fingerprint-a",
      () => ({
        daemonConfigFingerprint: "fingerprint-b",
        providerRuntimeConfigHash: "b".repeat(64)
      })
    );
    await server.start();
    servers.push(server);

    const client = await connectOrLaunchDaemon(
      server.endpoint,
      { command: process.execPath, argv: [], cwd: directory, env: {} },
      10_000,
      "fingerprint-b",
      {
        WORK_API: "openai-responses",
        WORK_BASE_URL: "https://models.example.test/v1",
        WORK_MODEL: "second-model",
        WORK_API_KEY: "secret-value"
      }
    );

    expect(spawn).not.toHaveBeenCalled();
    client.close();
  });
});
