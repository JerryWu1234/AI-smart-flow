import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectOrLaunchDaemon } from "../../../../apps/daemon/src/transport/daemon-launcher.js";

const FAILING_DAEMON = "process.stderr.write('REVIEW_AGENT_UNAVAILABLE: probe\\n');process.exit(1)";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function launchFailingDaemon(logPath?: string): Promise<void> {
  const directory = await mkdtemp(resolve(tmpdir(), "smartflow-daemon-log-"));
  directories.push(directory);
  await connectOrLaunchDaemon(
    resolve(directory, "daemon", "daemon.sock"),
    {
      command: process.execPath,
      argv: ["-e", FAILING_DAEMON],
      cwd: directory,
      env: {},
      ...(logPath === undefined ? {} : { logPath })
    },
    1_000
  );
}

describe("daemon launch logging", () => {
  it("records the launched daemon's output and reports it when startup fails", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "smartflow-daemon-log-"));
    directories.push(directory);
    const logPath = resolve(directory, "daemon", "daemon.log");

    await expect(launchFailingDaemon(logPath)).rejects
      .toThrow("REVIEW_AGENT_UNAVAILABLE: probe");
    await expect(readFile(logPath, "utf8")).resolves.toContain("REVIEW_AGENT_UNAVAILABLE: probe");
  });

  it("still reports a launch timeout when no log destination is configured", async () => {
    await expect(launchFailingDaemon()).rejects.toThrow("Daemon did not become ready");
  });
});
