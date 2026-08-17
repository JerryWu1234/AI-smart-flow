import { constants, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { type ChildProcessWithoutNullStreams, spawn as spawnChild, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";

import { WorkspaceError } from "./errors.js";
import { RollingDeadlineTimer } from "./rolling-deadline-timer.js";

export interface SandboxCapabilities {
  available: boolean;
  engine: "darwin-sandbox-exec" | "unavailable";
  fileIsolation: boolean;
  networkIsolation: boolean;
  processTreeControl: boolean;
  reason?: string;
}

export interface SandboxedSpawnRequest {
  attemptId: string;
  configHash: string;
  argv: string[];
  cwd: string;
  workspaceRoot: string;
  homeDirectory: string;
  tempDirectory: string;
  runtimeReadPaths: string[];
  deniedReadPaths: string[];
  environment: Readonly<Record<string, string>>;
  networkAccess: "ALLOW" | "DENY";
  deadlineAt: string;
}

export interface SandboxProcessIdentity {
  containmentId: string;
  configHash: string;
  pid: number;
  processStartToken: string;
}

export interface SandboxExecutionIdentity extends SandboxProcessIdentity {
  attemptId: string;
  status: "RUNNING" | "EXITED" | "UNKNOWN";
}

export interface SandboxExitResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  treeEmpty: boolean;
}

export interface SandboxedProcessHandle extends SandboxProcessIdentity {
  attemptId: string;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  wait(): Promise<SandboxExitResult>;
  renewDeadline(deadlineAt: string): boolean;
  terminate(): Promise<{ treeEmpty: boolean }>;
}

interface PersistedExecutionRecord {
  attemptId: string;
  configHash: string;
  containmentId: string;
  pid?: number;
  processStartToken?: string;
  status: "STARTING" | "RUNNING" | "EXITED" | "UNKNOWN";
}

interface ExecutionRecord extends PersistedExecutionRecord {
  child?: ChildProcessWithoutNullStreams;
  exit?: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  timedOut: boolean;
}

const DARWIN_RUNTIME_READ_PATHS = [
  "/System/Library",
  "/Library",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/share",
  "/usr/local/bin",
  "/usr/local/lib",
  "/opt/homebrew/bin",
  "/opt/homebrew/lib",
  "/private/etc",
  "/private/var/db",
  "/dev"
] as const;

function quoteProfile(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function isInside(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path.length === 0 || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function buildDarwinProfile(request: SandboxedSpawnRequest): string {
  const deniedReadPaths = [
    ...request.deniedReadPaths,
    resolve(homedir(), ".ssh"),
    resolve(homedir(), ".aws"),
    resolve(homedir(), ".config"),
    resolve(homedir(), "Library", "Keychains"),
    resolve(homedir(), ".netrc"),
    resolve(homedir(), ".npmrc")
  ];
  const readPaths = [
    request.workspaceRoot,
    ...request.runtimeReadPaths
  ];
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    `(deny file-read* ${deniedReadPaths.flatMap((path) => [
      `(literal ${quoteProfile(resolve(path))})`,
      `(subpath ${quoteProfile(resolve(path))})`
    ]).join(" ")})`,
    "(allow file-read-metadata)",
    `(allow file-read-data (literal "/") ${readPaths.flatMap((path) => [
      `(literal ${quoteProfile(resolve(path))})`,
      `(subpath ${quoteProfile(resolve(path))})`
    ]).join(" ")})`,
    `(allow file-write* (literal "/dev/null") (literal ${quoteProfile(request.workspaceRoot)}) (subpath ${quoteProfile(request.workspaceRoot)}))`
  ];
  if (request.networkAccess === "ALLOW") rules.push("(allow network*)");
  return rules.join("\n");
}

async function canonicalizeRequest(request: SandboxedSpawnRequest): Promise<SandboxedSpawnRequest> {
  const canonical = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path));
  const workspaceRoot = await canonical(request.workspaceRoot);
  const cwd = await canonical(request.cwd);
  const homeDirectory = await canonical(request.homeDirectory);
  const tempDirectory = await canonical(request.tempDirectory);
  if (
    !isInside(workspaceRoot, cwd) ||
    !isInside(workspaceRoot, homeDirectory) ||
    !isInside(workspaceRoot, tempDirectory)
  ) {
    throw new WorkspaceError(
      "PATH_OUTSIDE_WORKSPACE",
      "Sandbox cwd, home and temp directories must be inside the current workspace"
    );
  }
  return {
    ...request,
    cwd,
    workspaceRoot,
    homeDirectory,
    tempDirectory,
    runtimeReadPaths: [...new Set(await Promise.all([
      ...request.runtimeReadPaths,
      ...(process.platform === "darwin" ? DARWIN_RUNTIME_READ_PATHS : [])
    ].map((path) => canonical(path))))],
    deniedReadPaths: await Promise.all(request.deniedReadPaths.map((path) => canonical(path)))
  };
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function processStartToken(pid: number): string | undefined {
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    shell: false
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value.length === 0 ? undefined : `${String(pid)}:${value}`;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((settle) => setTimeout(settle, milliseconds));
}

async function waitForProcessStartToken(pid: number): Promise<string | undefined> {
  const deadline = Date.now() + 1_000;
  let token = processStartToken(pid);
  while (token === undefined && Date.now() < deadline) {
    await delay(20);
    token = processStartToken(pid);
  }
  return token;
}

function processIdentityMatches(record: PersistedExecutionRecord): boolean {
  return record.pid !== undefined &&
    record.processStartToken !== undefined &&
    processGroupExists(record.pid) &&
    processStartToken(record.pid) === record.processStartToken;
}

export class ExecutionSandboxAdapter {
  private readonly executions = new Map<string, ExecutionRecord>();
  private capabilities: SandboxCapabilities | undefined;

  public constructor(private readonly registryPath?: string) {
    if (registryPath === undefined) return;
    try {
      const records = JSON.parse(readFileSync(registryPath, "utf8")) as PersistedExecutionRecord[];
      for (const record of records) {
        if (
          typeof record.attemptId !== "string" ||
          typeof record.configHash !== "string" ||
          typeof record.containmentId !== "string" ||
          !new Set(["STARTING", "RUNNING", "EXITED", "UNKNOWN"]).has(record.status)
        ) continue;
        this.executions.set(record.attemptId, {
          ...record,
          status: record.status === "RUNNING" && !processIdentityMatches(record)
            ? "UNKNOWN"
            : record.status,
          timedOut: false
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  public async probe(): Promise<SandboxCapabilities> {
    if (this.capabilities !== undefined) return this.capabilities;
    if (process.platform !== "darwin") {
      this.capabilities = {
        available: false,
        engine: "unavailable",
        fileIsolation: false,
        networkIsolation: false,
        processTreeControl: false,
        reason: `No verified sandbox adapter for ${process.platform}`
      };
      return this.capabilities;
    }
    try {
      await access("/usr/bin/sandbox-exec", constants.X_OK);
      await this.runProbe();
      this.capabilities = {
        available: true,
        engine: "darwin-sandbox-exec",
        fileIsolation: true,
        networkIsolation: true,
        processTreeControl: true
      };
    } catch (error) {
      this.capabilities = {
        available: false,
        engine: "unavailable",
        fileIsolation: false,
        networkIsolation: false,
        processTreeControl: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
    return this.capabilities;
  }

  public async spawn(request: SandboxedSpawnRequest): Promise<SandboxedProcessHandle> {
    if (request.argv.length === 0 || !/^[a-f0-9]{64}$/u.test(request.configHash)) {
      throw new Error("SANDBOX_REQUEST_INVALID");
    }
    const deadline = Date.parse(request.deadlineAt);
    if (!Number.isFinite(deadline)) throw new Error("SANDBOX_DEADLINE_INVALID");
    if (deadline <= Date.now()) throw new Error("SANDBOX_DEADLINE_EXCEEDED");

    const capabilities = await this.probe();
    if (deadline <= Date.now()) throw new Error("SANDBOX_DEADLINE_EXCEEDED");
    if (!capabilities.available) {
      throw new Error(`SANDBOX_UNAVAILABLE: ${capabilities.reason ?? "no verified adapter"}`);
    }
    const existing = this.executions.get(request.attemptId);
    if (existing !== undefined) {
      if (existing.configHash !== request.configHash) throw new Error("SANDBOX_CONFIG_DRIFT");
      throw new Error("SANDBOX_EXECUTION_RECONCILIATION_REQUIRED");
    }

    await Promise.all([
      mkdir(request.homeDirectory, { recursive: true, mode: 0o700 }),
      mkdir(request.tempDirectory, { recursive: true, mode: 0o700 })
    ]);
    const canonical = await canonicalizeRequest(request);
    if (deadline <= Date.now()) throw new Error("SANDBOX_DEADLINE_EXCEEDED");
    const record: ExecutionRecord = {
      attemptId: request.attemptId,
      configHash: request.configHash,
      containmentId: `sandbox-${randomUUID()}`,
      status: "STARTING",
      timedOut: false
    };
    this.executions.set(request.attemptId, record);
    await this.persistRegistry();

    const profile = buildDarwinProfile(canonical);
    const child = spawnChild("/usr/bin/sandbox-exec", ["-p", profile, "--", ...canonical.argv], {
      cwd: canonical.cwd,
      env: {
        ...canonical.environment,
        HOME: canonical.homeDirectory,
        TMPDIR: canonical.tempDirectory
      },
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (child.pid === undefined) throw new Error("SANDBOX_PROCESS_IDENTITY_UNAVAILABLE");
    const startToken = await waitForProcessStartToken(child.pid);
    if (startToken === undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      record.status = "UNKNOWN";
      await this.persistRegistry();
      throw new Error("SANDBOX_PROCESS_IDENTITY_UNAVAILABLE");
    }

    record.pid = child.pid;
    record.processStartToken = startToken;
    record.status = "RUNNING";
    record.child = child;
    const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((settle, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => settle({ exitCode, signal }));
    });
    record.exit = exitPromise;
    await this.persistRegistry();

    let timeoutTermination: Promise<{ treeEmpty: boolean }> | undefined;
    const deadlineTimer = new RollingDeadlineTimer(deadline, () => {
      record.timedOut = true;
      timeoutTermination = this.terminate(request.attemptId);
    });

    const wait = async (): Promise<SandboxExitResult> => {
      const exit = await exitPromise;
      deadlineTimer.stop();
      await timeoutTermination;
      let treeEmpty = !processGroupExists(child.pid ?? -1);
      if (!treeEmpty) treeEmpty = (await this.terminate(request.attemptId)).treeEmpty;
      record.status = treeEmpty ? "EXITED" : "UNKNOWN";
      await this.persistRegistry();
      return { ...exit, timedOut: record.timedOut, treeEmpty };
    };

    return {
      attemptId: request.attemptId,
      containmentId: record.containmentId,
      configHash: record.configHash,
      pid: record.pid,
      processStartToken: record.processStartToken,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      wait,
      renewDeadline: (deadlineAt: string): boolean => deadlineTimer.renew(deadlineAt),
      terminate: async (): Promise<{ treeEmpty: boolean }> => {
        const timedOut = deadlineTimer.stop();
        if (timedOut && timeoutTermination !== undefined) return timeoutTermination;
        return this.terminate(request.attemptId);
      }
    };
  }

  public inspect(attemptId: string): SandboxExecutionIdentity | undefined {
    const record = this.executions.get(attemptId);
    if (record?.pid === undefined || record.processStartToken === undefined) return undefined;
    const status = this.query(attemptId);
    return {
      attemptId,
      containmentId: record.containmentId,
      configHash: record.configHash,
      pid: record.pid,
      processStartToken: record.processStartToken,
      status: status === "RUNNING" ? "RUNNING" : status === "EXITED" ? "EXITED" : "UNKNOWN"
    };
  }

  public query(attemptId: string): "RUNNING" | "EXITED" | "UNKNOWN" | "NOT_FOUND" {
    const record = this.executions.get(attemptId);
    if (record === undefined) return "NOT_FOUND";
    if (record.status === "STARTING" || record.status === "UNKNOWN") return "UNKNOWN";
    if (record.status === "EXITED") {
      return record.pid !== undefined && processGroupExists(record.pid) ? "UNKNOWN" : "EXITED";
    }
    return processIdentityMatches(record) ? "RUNNING" : "UNKNOWN";
  }

  public async terminate(
    attemptId: string,
    expectedIdentity?: SandboxProcessIdentity
  ): Promise<{ treeEmpty: boolean }> {
    const record = this.executions.get(attemptId);
    if (record?.pid === undefined || record.processStartToken === undefined) {
      return { treeEmpty: false };
    }
    if (
      expectedIdentity !== undefined &&
      (expectedIdentity.configHash !== record.configHash ||
        expectedIdentity.containmentId !== record.containmentId ||
        expectedIdentity.pid !== record.pid ||
        expectedIdentity.processStartToken !== record.processStartToken)
    ) {
      return { treeEmpty: false };
    }
    if (record.status === "UNKNOWN" || (record.status === "RUNNING" && !processIdentityMatches(record))) {
      return { treeEmpty: false };
    }
    if (processGroupExists(record.pid)) {
      try {
        process.kill(-record.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const termDeadline = Date.now() + 1_000;
      while (Date.now() < termDeadline && processGroupExists(record.pid)) await delay(20);
      if (processGroupExists(record.pid)) {
        try {
          process.kill(-record.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        const killDeadline = Date.now() + 1_000;
        while (Date.now() < killDeadline && processGroupExists(record.pid)) await delay(20);
      }
    }
    const treeEmpty = !processGroupExists(record.pid);
    record.status = treeEmpty ? "EXITED" : "UNKNOWN";
    await this.persistRegistry();
    return { treeEmpty };
  }

  private async runProbe(): Promise<void> {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-sandbox-probe-"));
    try {
      const workspaceRoot = resolve(root, "workspace");
      const runtime = resolve(workspaceRoot, ".smartflow-runtime");
      const hiddenPath = resolve(root, "hidden.txt");
      await Promise.all([
        mkdir(resolve(runtime, "home"), { recursive: true }),
        mkdir(resolve(runtime, "tmp"), { recursive: true }),
        writeFile(hiddenPath, "must stay hidden", "utf8")
      ]);
      const networkServer = createServer((socket) => socket.end());
      await new Promise<void>((settle, reject) => {
        networkServer.once("error", reject);
        networkServer.listen(0, "127.0.0.1", settle);
      });
      const address = networkServer.address();
      if (address === null || typeof address === "string") throw new Error("sandbox probe port failed");
      const marker = resolve(workspaceRoot, "probe.json");
      const script = [
        "const fs=require('node:fs');const net=require('node:net');",
        "let hidden=false;try{fs.readFileSync(process.env.HIDDEN,'utf8');hidden=true}catch{}",
        "let done=false;const finish=network=>{if(done)return;done=true;fs.writeFileSync(process.env.MARKER,JSON.stringify({hidden,network}));process.exit(hidden||network?41:0)};",
        "const s=net.connect(Number(process.env.PORT),'127.0.0.1');s.once('connect',()=>{s.destroy();finish(true)});s.once('error',()=>finish(false));setTimeout(()=>finish(false),1000);"
      ].join("");
      const request = await canonicalizeRequest({
        attemptId: "probe",
        configHash: "0".repeat(64),
        argv: [process.execPath, "-e", script],
        cwd: workspaceRoot,
        workspaceRoot,
        homeDirectory: resolve(runtime, "home"),
        tempDirectory: resolve(runtime, "tmp"),
        runtimeReadPaths: [dirname(process.execPath)],
        deniedReadPaths: [hiddenPath],
        environment: { HIDDEN: hiddenPath, MARKER: marker, PORT: String(address.port) },
        networkAccess: "DENY",
        deadlineAt: new Date(Date.now() + 5_000).toISOString()
      });
      const child = spawnChild("/usr/bin/sandbox-exec", ["-p", buildDarwinProfile(request), "--", ...request.argv], {
        cwd: request.cwd,
        env: { ...request.environment, HOME: request.homeDirectory, TMPDIR: request.tempDirectory },
        shell: false,
        stdio: ["ignore", "ignore", "pipe"]
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => settle({ code, signal }));
      });
      await new Promise<void>((settle) => networkServer.close(() => settle()));
      if (exit.code !== 0) {
        throw new Error(`sandbox self-test exited ${String(exit.code)}/${String(exit.signal)}: ${stderr.trim()}`);
      }
      const result = JSON.parse(await readFile(marker, "utf8")) as { hidden?: unknown; network?: unknown };
      if (result.hidden !== false || result.network !== false) {
        throw new Error("sandbox self-test did not enforce file and network boundaries");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  private async persistRegistry(): Promise<void> {
    if (this.registryPath === undefined) return;
    const records: PersistedExecutionRecord[] = [...this.executions.values()]
      .map(({ attemptId, configHash, containmentId, pid, processStartToken, status }) => ({
        attemptId,
        configHash,
        containmentId,
        ...(pid === undefined ? {} : { pid }),
        ...(processStartToken === undefined ? {} : { processStartToken }),
        status
      }))
      .sort((left, right) => left.attemptId.localeCompare(right.attemptId));
    await mkdir(dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.registryPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(records), { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, this.registryPath);
  }
}
