import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { startSmartFlowDaemon } from "@smartflow/daemon";
import { runSmartFlowMcpGateway } from "@smartflow/mcp-server";

async function withMissingClaude(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(resolve(tmpdir(), "smartflow-missing-reviewer-"));
  const previousPath = process.env.PATH;
  const previousAdapter = process.env.REVIEW_ADAPTER;
  process.env.PATH = directory;
  process.env.REVIEW_ADAPTER = "claude-code";
  try {
    await run(directory);
  } finally {
    if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = previousPath;
    if (previousAdapter === undefined) Reflect.deleteProperty(process.env, "REVIEW_ADAPTER");
    else process.env.REVIEW_ADAPTER = previousAdapter;
    await rm(directory, { force: true, recursive: true });
  }
}

describe("Reviewer startup preflight", () => {
  it("blocks the daemon before it becomes ready", async () => {
    await withMissingClaude(async (directory) => {
      await expect(startSmartFlowDaemon({ dataDirectory: resolve(directory, "daemon") }))
        .rejects.toThrow(
          "REVIEW_AGENT_UNAVAILABLE: adapter \"claude-code\" requires executable \"claude\" on PATH"
        );
    });
  });

  it("blocks the MCP gateway before it connects to a daemon", async () => {
    await withMissingClaude(async (directory) => {
      await expect(runSmartFlowMcpGateway({
        executablePath: process.execPath,
        entryPath: resolve(directory, "missing-entry.mjs"),
        dataDirectory: resolve(directory, "daemon")
      })).rejects.toThrow(
        "REVIEW_AGENT_UNAVAILABLE: adapter \"claude-code\" requires executable \"claude\" on PATH"
      );
    });
  });
});
