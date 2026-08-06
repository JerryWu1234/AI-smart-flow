import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const fixtureRoot = resolve(import.meta.dirname, "../fixtures/tiny-repo");
const execute = promisify(execFile);

export interface RuntimeHarness {
  readonly rootDir: string;
  readonly projectDir: string;
  readonly dataDir: string;
  readonly daemonSocketPath: string;
  nextRequestId(): string;
  spawnProcess(command: string, args: readonly string[], cwd?: string): ChildProcess;
  cleanup(): Promise<void>;
}

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent !== "" && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent);
}

export async function createRuntimeHarness(): Promise<RuntimeHarness> {
  const rootDir = await mkdtemp(join(tmpdir(), "smartflow-test-"));
  const projectDir = join(rootDir, "project");
  const dataDir = join(rootDir, "data");
  const daemonSocketPath = join(rootDir, "daemon.sock");
  const processes = new Set<ChildProcess>();
  let requestSequence = 0;

  await mkdir(dataDir, { recursive: true });
  await cp(fixtureRoot, projectDir, { recursive: true, verbatimSymlinks: true });
  await execute("git", ["init", "--quiet", projectDir]);

  const canonicalProject = await realpath(projectDir);
  const canonicalData = await realpath(dataDir);
  if (isInside(canonicalProject, canonicalData) || isInside(canonicalData, canonicalProject)) {
    throw new Error("test project and data directory must be disjoint");
  }

  return {
    rootDir,
    projectDir,
    dataDir,
    daemonSocketPath,
    nextRequestId(): string {
      requestSequence += 1;
      return `req_${String(requestSequence)}_${randomUUID()}`;
    },
    spawnProcess(command: string, args: readonly string[], cwd = projectDir): ChildProcess {
      const child = spawn(command, args, {
        cwd,
        env: { PATH: process.env.PATH ?? "" },
        stdio: "pipe"
      });
      processes.add(child);
      child.once("exit", () => processes.delete(child));
      return child;
    },
    async cleanup(): Promise<void> {
      for (const child of processes) child.kill("SIGTERM");
      await Promise.all(
        [...processes].map(
          (child) =>
            new Promise<void>((settle) => {
              child.once("exit", () => settle());
              setTimeout(() => {
                child.kill("SIGKILL");
                settle();
              }, 1_000).unref();
            })
        )
      );
      await rm(rootDir, { recursive: true, force: true });
    }
  };
}

async function addDirectoryToHash(hash: ReturnType<typeof createHash>, directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const pathFromFixture = relative(fixtureRoot, path);
    const stats = await lstat(path);
    hash.update(
      `${entry.isDirectory() ? "D" : "F"}:${pathFromFixture}:${String(stats.mode & 0o777)}\0`
    );
    if (entry.isDirectory()) await addDirectoryToHash(hash, path);
    else hash.update(await readFile(path));
  }
}

export async function hashTinyFixture(): Promise<string> {
  const hash = createHash("sha256");
  await addDirectoryToHash(hash, fixtureRoot);
  return hash.digest("hex");
}
