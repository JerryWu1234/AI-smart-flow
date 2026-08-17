import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExecutionSandboxAdapter } from "../../../../packages/workspace/src/execution-sandbox-adapter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  adapter: ExecutionSandboxAdapter;
  workspace: string;
  runtime: string;
  protectedPath: string;
}> {
  const root = await mkdtemp(resolve(tmpdir(), "smartflow-pi-sandbox-"));
  roots.push(root);
  const workspace = resolve(root, "workspace");
  const runtime = resolve(workspace, ".smartflow-runtime");
  const protectedPath = resolve(root, "protected.txt");
  await Promise.all([
    mkdir(runtime, { recursive: true }),
    writeFile(protectedPath, "secret", "utf8")
  ]);
  return {
    adapter: new ExecutionSandboxAdapter(resolve(root, "containments.json")),
    workspace,
    runtime,
    protectedPath
  };
}

describe("ExecutionSandboxAdapter Pi process containment", () => {
  it("streams stdin/stdout JSONL and keeps stable containment identity", async () => {
    const { adapter, workspace, runtime, protectedPath } = await fixture();
    const capabilities = await adapter.probe();
    if (!capabilities.available) {
      await expect(adapter.spawn({
        attemptId: "attempt-unavailable",
        configHash: "a".repeat(64),
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: workspace,
        workspaceRoot: workspace,
        homeDirectory: resolve(runtime, "home"),
        tempDirectory: resolve(runtime, "tmp"),
        runtimeReadPaths: [dirname(process.execPath)],
        deniedReadPaths: [protectedPath],
        environment: {},
        networkAccess: "ALLOW",
        deadlineAt: new Date(Date.now() + 10_000).toISOString()
      })).rejects.toThrow(/SANDBOX_UNAVAILABLE/u);
      return;
    }
    const script = [
      "process.stdin.setEncoding('utf8');",
      "let b='';",
      "process.stdin.on('data',c=>{b+=c;const p=b.split('\\n');b=p.pop();for(const l of p){if(l)process.stdout.write(JSON.stringify({echo:JSON.parse(l)})+'\\n')}});"
    ].join("");
    const handle = await adapter.spawn({
      attemptId: "attempt-stream",
      configHash: "a".repeat(64),
      argv: [process.execPath, "-e", script],
      cwd: workspace,
      workspaceRoot: workspace,
      homeDirectory: resolve(runtime, "home"),
      tempDirectory: resolve(runtime, "tmp"),
      runtimeReadPaths: [dirname(process.execPath)],
      deniedReadPaths: [protectedPath],
      environment: {},
      networkAccess: "ALLOW",
      deadlineAt: new Date(Date.now() + 10_000).toISOString()
    });
    const chunks: string[] = [];
    handle.stdout.setEncoding("utf8");
    handle.stdout.on("data", (chunk: string) => chunks.push(chunk));
    handle.stdin.write(`${JSON.stringify({ type: "prompt", text: "hello" })}\n`);
    while (chunks.length === 0) await once(handle.stdout, "data");
    expect(chunks.join("")).toContain('"text":"hello"');
    expect(adapter.inspect("attempt-stream")).toMatchObject({
      containmentId: handle.containmentId,
      pid: handle.pid,
      processStartToken: handle.processStartToken,
      status: "RUNNING"
    });
    await expect(handle.terminate()).resolves.toEqual({ treeEmpty: true });
  });

  it("terminates the full process tree at the frozen deadline", async () => {
    const { adapter, workspace, runtime, protectedPath } = await fixture();
    if (!(await adapter.probe()).available) return;
    const script = "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000)";
    const handle = await adapter.spawn({
      attemptId: "attempt-timeout",
      configHash: "b".repeat(64),
      argv: [process.execPath, "-e", script],
      cwd: workspace,
      workspaceRoot: workspace,
      homeDirectory: resolve(runtime, "home"),
      tempDirectory: resolve(runtime, "tmp"),
      runtimeReadPaths: [dirname(process.execPath)],
      deniedReadPaths: [protectedPath],
      environment: {},
      networkAccess: "ALLOW",
      deadlineAt: new Date(Date.now() + 150).toISOString()
    });
    await expect(handle.wait()).resolves.toMatchObject({ timedOut: true, treeEmpty: true });
    expect(adapter.query("attempt-timeout")).toBe("EXITED");
  });

  it("allows workspace writes but denies protected reads", async () => {
    const { adapter, workspace, runtime, protectedPath } = await fixture();
    if (!(await adapter.probe()).available) return;
    const output = resolve(workspace, "result.json");
    const script = [
      "const fs=require('node:fs');",
      "let denied=false;try{fs.readFileSync(process.env.PROTECTED,'utf8')}catch{denied=true}",
      "fs.writeFileSync(process.env.OUTPUT,JSON.stringify({denied}));"
    ].join("");
    const handle = await adapter.spawn({
      attemptId: "attempt-paths",
      configHash: "c".repeat(64),
      argv: [process.execPath, "-e", script],
      cwd: workspace,
      workspaceRoot: workspace,
      homeDirectory: resolve(runtime, "home"),
      tempDirectory: resolve(runtime, "tmp"),
      runtimeReadPaths: [dirname(process.execPath)],
      deniedReadPaths: [protectedPath],
      environment: { PROTECTED: protectedPath, OUTPUT: output },
      networkAccess: "ALLOW",
      deadlineAt: new Date(Date.now() + 10_000).toISOString()
    });
    await expect(handle.wait()).resolves.toMatchObject({ exitCode: 0, timedOut: false, treeEmpty: true });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ denied: true });
  });
});
