import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { probeGitRepository } from "./git-capability.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "smartflow-git-capability-"));
  roots.push(root);
  await execute("git", ["init", "--quiet", root]);
  await writeFile(resolve(root, "tracked.txt"), "tracked", "utf8");
  await execute("git", ["-C", root, "add", "tracked.txt"]);
  return root;
}

describe("Git repository capability probe", () => {
  it("reports a normal repository as ready", async () => {
    const root = await repository();
    await expect(probeGitRepository(root)).resolves.toMatchObject({
      status: "READY",
      repositoryRoot: await realpath(root),
      worktreeSupported: true,
      inclusionPolicy: { tracked: true, dirty: true, untrackedNonIgnored: true, ignored: false }
    });
  });

  it("does not block repositories that configure LFS or custom filters", async () => {
    const root = await repository();
    await execute("git", ["-C", root, "config", "filter.demo.clean", "must-not-run"]);
    await execute("git", ["-C", root, "config", "filter.lfs.process", "must-not-run"]);
    await writeFile(
      resolve(root, ".gitattributes"),
      "*.bin filter=lfs diff=lfs\n*.generated filter=demo\n",
      "utf8"
    );

    await expect(probeGitRepository(root)).resolves.toMatchObject({
      status: "READY",
      repositoryRoot: await realpath(root),
      worktreeSupported: true
    });
  });

  it("pauses before submodules or nested repositories are used", async () => {

    const submoduleRoot = await repository();
    await writeFile(resolve(submoduleRoot, ".gitmodules"), "[submodule \"child\"]\n", "utf8");
    await expect(probeGitRepository(submoduleRoot)).resolves.toMatchObject({
      status: "PAUSED",
      pause: { code: "GIT_SUBMODULE_UNSUPPORTED" }
    });

    const nestedRoot = await repository();
    const child = resolve(nestedRoot, "child");
    await mkdir(child);
    await execute("git", ["init", "--quiet", child]);
    await writeFile(resolve(child, "file.txt"), "nested", "utf8");
    await expect(probeGitRepository(nestedRoot)).resolves.toMatchObject({
      status: "PAUSED",
      pause: { code: "GIT_NESTED_REPOSITORY_UNSUPPORTED" }
    });
  });

  it("returns a durable pause reason when Git is unavailable", async () => {
    await expect(probeGitRepository(process.cwd(), {
      gitBinary: "smartflow-git-does-not-exist"
    })).resolves.toMatchObject({ status: "PAUSED", pause: { code: "GIT_UNAVAILABLE" } });
  });
});
