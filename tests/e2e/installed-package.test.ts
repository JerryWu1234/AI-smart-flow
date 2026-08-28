import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const runRealPiE2e = process.env.SMARTFLOW_RUN_REAL_PI_E2E === "1";

function parseJsonLine(output: string): Record<string, unknown> {
  const line = output
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("{"))
    .at(-1);
  if (line === undefined) throw new Error(`Command did not return JSON: ${output}`);
  return JSON.parse(line) as Record<string, unknown>;
}

async function executeJson(
  entry: string,
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
): Promise<{ result: Record<string, unknown>; stdout: string; stderr: string }> {
  let lastOutput = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const execution = await new Promise<{ stdout: string; stderr: string }>((settle, reject) => {
      const invocation = [
        `const { runCli } = await import(${JSON.stringify(pathToFileURL(entry).href)});`,
        `process.exitCode = await runCli(${JSON.stringify(argv)});`
      ].join("\n");
      const child = spawn(process.execPath, ["--input-type=module", "--eval", invocation], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let completed = false;
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > options.maxBuffer) child.kill("SIGKILL");
        try {
          parseJsonLine(stdout);
          completed = true;
          clearTimeout(timer);
          settle({ stdout, stderr });
          child.kill("SIGTERM");
        } catch {
          // Wait for the command's final JSON record.
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > options.maxBuffer) child.kill("SIGKILL");
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (completed) return;
        if (code === 0) settle({ stdout, stderr });
        else reject(new Error(`Installed command failed ${String(code)}/${String(signal)}: ${stderr}`));
      });
    });
    const { stdout, stderr } = execution;
    lastOutput = `${stdout}\n${stderr}`;
    try {
      return { result: parseJsonLine(stdout), stdout, stderr };
    } catch {
      if (attempt === 1) throw new Error(`Installed command returned no JSON after retry: ${lastOutput}`);
    }
  }
  throw new Error(`Installed command returned no JSON: ${lastOutput}`);
}

async function packSmartFlow(tarball: string, cacheRoot: string): Promise<void> {
  await executeFile("pnpm", ["pack", "--out", tarball], {
    cwd: process.cwd(),
    env: { ...process.env, npm_config_cache: cacheRoot },
    timeout: 120_000,
    maxBuffer: 20_000_000
  });
}

function installedTasksSource(): string {
  return `# Installed MCP lifecycle

## M13 · Installed runtime

- [ ] T057 Replace \`sum.js\` with exactly two exported functions: \`sum(a, b)\` returns \`a + b\`, and \`subtract(a, b)\` returns \`a - b\`. If the Reviewer requests a dynamic repair marker during review, add that exact comment to \`sum.js\`. — 验收：Reviewer confirms both functions, any exact marker it requested, and no unrelated file changes
`;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} did not return an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} did not return an array`);
  return value;
}

function asStringArray(value: unknown, context: string): string[] {
  return asArray(value, context).map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${context}[${String(index)}] was not a string`);
    }
    return entry;
  });
}

async function stopLaunchedDaemon(dataDirectory: string): Promise<void> {
  const lockPath = resolve(dataDirectory, "daemon.lock");
  let pid: number | undefined;
  try {
    const lock = asRecord(JSON.parse(await readFile(lockPath, "utf8")) as unknown, "daemon.lock");
    if (typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 1) pid = lock.pid;
  } catch {
    return;
  }
  if (pid === undefined || pid === process.pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise<void>((settle) => setTimeout(settle, 50));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
  }
  throw new Error(`Installed daemon ${String(pid)} did not stop`);
}

describe("installed SmartFlow package", () => {
  it("omits the removed Host SDK export and artifact from the tarball", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-pack-audit-"));
    const tarball = resolve(root, "smartflow.tgz");
    const cacheRoot = resolve(root, "npm-cache");
    await mkdir(cacheRoot);
    try {
      await packSmartFlow(tarball, cacheRoot);
      const [{ stdout: packedFiles }, { stdout: manifestSource }] = await Promise.all([
        executeFile("tar", ["-tf", tarball], { timeout: 30_000, maxBuffer: 2_000_000 }),
        executeFile("tar", ["-xOf", tarball, "package/package.json"], {
          timeout: 30_000,
          maxBuffer: 2_000_000
        })
      ]);
      const removedHostSdkArtifact = `package/dist/${["host", "skill"].join("-")}.mjs`;
      expect(packedFiles).not.toContain(removedHostSdkArtifact);
      const packedManifest = asRecord(JSON.parse(manifestSource) as unknown, "packed manifest");
      expect(asRecord(packedManifest.exports, "packed exports")).toEqual({
        ".": "./dist/smartflow.mjs"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it.runIf(runRealPiE2e)("runs approved tasks through installed MCP, daemon, Pi, review, and filesystem publish", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-installed-"));
    const tarball = resolve(root, "smartflow.tgz");
    const installRoot = resolve(root, "install");
    const projectRoot = resolve(root, "project");
    const dataRoot = resolve(root, "data");
    const cacheRoot = resolve(root, "npm-cache");
    const daemonRoot = resolve(dataRoot, "daemon");
    const smartFlowConfigPath = resolve(root, "smartflow.yml");
    const codexTracePath = resolve(root, "codex-trace.jsonl");
    const fakeCodexBin = resolve(process.cwd(), "tests", "fixtures", "bin");
    const repairMarker = `// SMARTFLOW_DYNAMIC_REPAIR_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 20)}`;
    let lifecycleStage = "pack";
    await Promise.all([mkdir(installRoot), mkdir(projectRoot), mkdir(dataRoot), mkdir(cacheRoot)]);
    try {
      lifecycleStage = "pack";
      await packSmartFlow(tarball, cacheRoot);
      lifecycleStage = "install";
      let installError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await executeFile(
            "npm",
            ["install", "--prefix", installRoot, "--no-audit", "--no-fund", tarball],
            {
              env: { ...process.env, npm_config_cache: cacheRoot },
              timeout: 180_000,
              maxBuffer: 20_000_000
            }
          );
          installError = undefined;
          break;
        } catch (error) {
          installError = error;
        }
      }
      if (installError !== undefined) {
        throw installError instanceof Error
          ? installError
          : new Error(typeof installError === "string" ? installError : "npm install failed");
      }
      const entry = resolve(
        installRoot,
        "node_modules",
        "@jerrywu1234",
        "smartflow",
        "dist",
        "smartflow.mjs"
      );
      await writeFile(smartFlowConfigPath, [
        "review:",
        "  strategy: codex",
        "  noProgressThreshold: 15",
        "  model: e2e-review-model",
        "  effort: low",
        "  deadlineMs: 300000",
        "  maxAttempts: 3",
        ""
      ].join("\n"), "utf8");
      const environment = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !key.startsWith("VITEST") &&
              !key.startsWith("TIN_POOL") &&
              !new Set(["NODE_CHANNEL_FD", "NODE_OPTIONS", "NODE_UNIQUE_ID", "JEST_WORKER_ID"]).has(key)
          )
        ),
        PATH: `${fakeCodexBin}${delimiter}${process.env.PATH ?? ""}`,
        SMARTFLOW_CONFIG: smartFlowConfigPath,
        SMARTFLOW_DATA_HOME: dataRoot,
        XDG_DATA_HOME: resolve(dataRoot, "xdg"),
        API: process.env.API ?? "",
        BASE_URL: process.env.BASE_URL ?? "",
        MODEL: process.env.MODEL ?? "",
        API_KEY: process.env.API_KEY ?? "",
        SMARTFLOW_PI_CONTEXT_WINDOW: process.env.SMARTFLOW_PI_CONTEXT_WINDOW ?? "1000000",
        SMARTFLOW_PI_MAX_TOKENS: process.env.SMARTFLOW_PI_MAX_TOKENS ?? "384000",
        SMARTFLOW_PI_THINKING: process.env.SMARTFLOW_PI_THINKING ?? "high",
        SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: process.env.SMARTFLOW_PI_ATTEMPT_DEADLINE_MS ?? "300000",
        SMARTFLOW_TEST_REPAIR_MARKER: repairMarker,
        SMARTFLOW_TEST_CODEX_TRACE: codexTracePath,
        SMARTFLOW_TEST_TOKEN: "never-log-this-token",
        SMARTFLOW_TEST_PASSWORD: "never-log-this-password"
      };
      lifecycleStage = "doctor";
      const doctor = await executeJson(entry, ["doctor", "--json", "--project", projectRoot], {
        cwd: projectRoot,
        env: environment,
        timeout: 240_000,
        maxBuffer: 20_000_000
      });
      const doctorReport = doctor.result;
      expect(doctorReport.ready).toBe(true);
      expect(doctorReport.status).toBe("optional-unavailable");
      expect(`${doctor.stdout}\n${doctor.stderr}`).not.toContain("never-log-this-token");
      expect(`${doctor.stdout}\n${doctor.stderr}`).not.toContain("never-log-this-password");
      lifecycleStage = "write-project";
      const tasksSource = installedTasksSource();
      await Promise.all([
        writeFile(resolve(projectRoot, "package.json"), '{"type":"module"}\n', "utf8"),
        writeFile(resolve(projectRoot, "tasks.md"), tasksSource, "utf8"),
        writeFile(
          resolve(projectRoot, "tasks-b.md"),
          "# Secondary task\n\n## M14 · Concurrent run\n\n- [ ] T058 Update `other.js` — 验收：secondary run can be canceled independently\n",
          "utf8"
        ),
        writeFile(
          resolve(projectRoot, "sum.js"),
          "export function sum(a, b) {\n  return a + b;\n}\n",
          "utf8"
        ),
        writeFile(
          resolve(projectRoot, "sum.test.js"),
          [
            'import assert from "node:assert/strict";',
            'import test from "node:test";',
            'import { subtract, sum } from "./sum.js";',
            'test("math", () => { assert.equal(sum(2, 3), 5); assert.equal(subtract(5, 2), 3); });',
            ""
          ].join("\n"),
          "utf8"
        )
      ]);
      await executeFile("git", ["init", "--quiet", projectRoot]);
      const sourceBefore = await readFile(resolve(projectRoot, "sum.js"), "utf8");
      lifecycleStage = "mcp-lifecycle";
      const lifecycleProcess = await executeFile(
        process.execPath,
        [
          resolve(process.cwd(), "tests", "fixtures", "installed-mcp-lifecycle-child.mjs"),
          resolve(installRoot, "node_modules", ".bin", "smartflow"),
          projectRoot,
          daemonRoot
        ],
        {
          cwd: projectRoot,
          env: environment,
          timeout: 1_200_000,
          maxBuffer: 30_000_000
        }
      );
      const lifecycle = parseJsonLine(lifecycleProcess.stdout);
      const publicToolNames = asStringArray(
        lifecycle.publicToolNames,
        "installed public MCP tool names"
      );
      const scope = asRecord(lifecycle.scope, "installed lifecycle scope");
      const secondExecute = asRecord(lifecycle.secondExecute, "installed second execute result");
      const secondCanceled = asRecord(lifecycle.secondCanceled, "installed second canceled result");
      const result = asRecord(lifecycle.result, "installed result");
      const workflowToolNames = asStringArray(
        lifecycle.workflowToolNames,
        "installed workflow tool names"
      );
      const codexTrace = (await readFile(codexTracePath, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => asRecord(
          JSON.parse(line) as unknown,
          `installed Codex trace ${String(index)}`
        ));
      const mainReviewTrace = codexTrace.filter((entry) =>
        typeof entry.outputPath === "string" &&
        entry.outputPath.replaceAll("\\", "/").includes(
          `/runs/${String(result.jobId)}/`
        )
      );

      expect(publicToolNames).toEqual([
        "smartflow_cancel",
        "smartflow_execute",
        "smartflow_result",
        "smartflow_resume",
        "smartflow_review_turn",
        "smartflow_status"
      ]);
      expect(scope.jobId).toBe(result.jobId);
      expect(secondExecute.jobId).not.toBe(result.jobId);
      expect(secondCanceled).toMatchObject({ phase: "CANCELED" });
      expect(result).toMatchObject({
        phase: "COMPLETED",
        status: "COMMITTED",
        nextActions: [],
        publishOutcome: { status: "COMMITTED" }
      });

      expect(new Set(workflowToolNames)).toEqual(new Set([
        "smartflow_execute",
        "smartflow_review_turn"
      ]));
      expect(workflowToolNames[0]).toBe("smartflow_execute");
      expect(workflowToolNames.slice(1).every(
        (toolName) => toolName === "smartflow_review_turn"
      )).toBe(true);
      expect(lifecycle).not.toHaveProperty("reviewerModes");
      expect(lifecycle).not.toHaveProperty("reviewChangedPaths");
      expect(lifecycle).not.toHaveProperty("reviewCalls");
      expect(lifecycle).not.toHaveProperty("repairMarker");

      expect(mainReviewTrace.length).toBeGreaterThanOrEqual(2);
      const firstReview = mainReviewTrace[0];
      const finalReviewTrace = mainReviewTrace.at(-1);
      if (firstReview === undefined || finalReviewTrace === undefined) {
        throw new Error("Installed Daemon did not invoke its Reviewer");
      }
      if (typeof firstReview.sessionId !== "string") {
        throw new Error("Installed Daemon Reviewer omitted its session ID");
      }
      const reviewerSessionId = firstReview.sessionId;
      expect(firstReview).toMatchObject({ mode: "CREATE", markerPresent: false });
      expect(finalReviewTrace).toMatchObject({ mode: "RESUME", markerPresent: true });
      for (const [index, reviewTrace] of mainReviewTrace.entries()) {
        expect(reviewTrace.mode).toBe(index === 0 ? "CREATE" : "RESUME");
        expect(reviewTrace.sessionId).toBe(reviewerSessionId);
        // Configured model and effort must reach every round, resumes included.
        expect(reviewTrace).toMatchObject({ model: "e2e-review-model", effort: "low" });
        expect(asStringArray(
          reviewTrace.taskIds,
          `installed Daemon Review task IDs ${String(index)}`
        )).toContain("T057");
      }
      const reviewOutputPaths = mainReviewTrace.map((entry) =>
        String(entry.outputPath).replaceAll("\\", "/")
      );
      const jobArtifactRoot = `runs/${String(result.jobId)}/`;
      expect(reviewOutputPaths.every(
        (path) => path.includes(`/${jobArtifactRoot}reviews/`)
      )).toBe(true);
      expect(reviewOutputPaths.some(
        (path) => /(?:^|\/)revision-\d+(?:\/|$)/u.test(path)
      )).toBe(false);
      expect(repairMarker).toMatch(/^\/\/ SMARTFLOW_DYNAMIC_REPAIR_[0-9a-f]{20}$/u);

      const finalReview = asRecord(result.review, "installed final Review");
      const finalReviewTasks = asArray(finalReview.tasks, "installed final Review tasks")
        .map((task, index) => asRecord(task, `installed final Review task ${String(index)}`));
      expect(finalReviewTasks.length).toBeGreaterThan(0);
      expect(finalReviewTasks.every((task) =>
        task.completionPercentage === 100 &&
        Array.isArray(task.issues) &&
        task.issues.length === 0
      )).toBe(true);

      const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
      const artifactPaths = artifacts.map((artifact) =>
        String(asRecord(artifact, "result artifact").relativePath)
      );
      // Durable Review and result artifacts prove automatic repair stayed in one immutable Job.
      expect(artifactPaths.some(
        (relativePath) => relativePath.startsWith(`${jobArtifactRoot}reviews/`)
      )).toBe(true);
      expect(artifactPaths.every(
        (relativePath) => !/(?:^|\/)revision-\d+(?:\/|$)/u.test(relativePath)
      )).toBe(true);
      const taskSourceArtifact = artifacts
        .map((artifact) => asRecord(artifact, "result artifact"))
        .find((artifact) => artifact.relativePath === `${jobArtifactRoot}task-source.md`);
      if (taskSourceArtifact === undefined) throw new Error("Installed result omitted task source artifact");
      expect(taskSourceArtifact.relativePath).toBe(`${jobArtifactRoot}task-source.md`);
      expect(await readFile(resolve(
        daemonRoot,
        "projects",
        String(scope.projectId),
        "runs",
        String(result.jobId),
        "task-source.md"
      ), "utf8")).toBe(tasksSource);
      lifecycleStage = "published-result";
      const publishedSource = await readFile(resolve(projectRoot, "sum.js"), "utf8");
      expect(publishedSource).not.toBe(sourceBefore);
      expect(publishedSource).toContain("subtract");
      expect(publishedSource).toContain(repairMarker);
      expect(`${lifecycleProcess.stdout}\n${lifecycleProcess.stderr}`).not.toContain("never-log-this");
      expect(JSON.stringify({ lifecycle, result })).not.toContain("never-log-this");
    } catch (error) {
      throw new Error(
        `Installed MCP lifecycle failed at ${lifecycleStage}`,
        { cause: error }
      );
    } finally {
      await stopLaunchedDaemon(daemonRoot);
      await rm(root, { recursive: true, force: true });
    }
  }, 2_400_000);
});
