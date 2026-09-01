import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveReviewerExecutable } from "../../../../apps/daemon/src/review/reviewer-executable.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "smartflow-reviewer-executable-"));
  directories.push(directory);
  return directory;
}

async function writeExecutable(directory: string, name: string): Promise<string> {
  const fileName = process.platform === "win32" ? `${name}.CMD` : name;
  const path = resolve(directory, fileName);
  await writeFile(path, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", {
    mode: 0o700
  });
  return path;
}

function pathEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: directory,
    ...(process.platform === "win32" ? { PATHEXT: ".CMD" } : {})
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Reviewer executable resolution", () => {
  it("maps both Codex adapters to codex and both Claude adapters to claude", async () => {
    const directory = await temporaryDirectory();
    const codex = await writeExecutable(directory, "codex");
    const claude = await writeExecutable(directory, "claude");
    const environment = pathEnvironment(directory);

    await expect(resolveReviewerExecutable("codex", environment)).resolves.toBe(codex);
    await expect(resolveReviewerExecutable("codex-desktop", environment)).resolves.toBe(codex);
    await expect(resolveReviewerExecutable("claude-code", environment)).resolves.toBe(claude);
    await expect(resolveReviewerExecutable("claude-code-desktop", environment)).resolves.toBe(claude);
  });

  it("does not search the project directory when PATH is unset", async () => {
    const directory = await temporaryDirectory();
    await writeExecutable(directory, "codex");
    const originalDirectory = process.cwd();
    process.chdir(directory);
    try {
      await expect(resolveReviewerExecutable("codex", {})).rejects.toThrow(
        "REVIEW_AGENT_UNAVAILABLE: adapter \"codex\" requires executable \"codex\" on PATH"
      );
    } finally {
      process.chdir(originalDirectory);
    }
  });

  it("fails before Review when the selected Agent is not on PATH", async () => {
    const directory = await temporaryDirectory();
    await expect(resolveReviewerExecutable("claude-code", pathEnvironment(directory)))
      .rejects.toThrow(
        "REVIEW_AGENT_UNAVAILABLE: adapter \"claude-code\" requires executable \"claude\" on PATH"
      );
  });
});
