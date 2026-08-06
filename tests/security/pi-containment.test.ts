import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExecutionSandboxAdapter } from "@smartflow/workspace";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((settle, reject) => {
    server.close((error) => error === undefined ? settle() : reject(error));
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi Shell containment", () => {
  it("allows Shell and network while limiting reads and writes to the isolated workspace", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-pi-containment-"));
    roots.push(root);
    const workspace = resolve(root, "workspace");
    const runtime = resolve(workspace, ".smartflow-runtime");
    const protectedFile = resolve(root, "original-project.txt");
    const outsideWrite = resolve(root, "outside-write.txt");
    const resultPath = resolve(workspace, "result.txt");
    await Promise.all([
      mkdir(runtime, { recursive: true }),
      writeFile(protectedFile, "host-secret", "utf8")
    ]);

    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("network-ok");
    });
    servers.push(server);
    await new Promise<void>((settle, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        settle();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("network fixture unavailable");

    const adapter = new ExecutionSandboxAdapter(resolve(root, "containments.json"));
    if (!(await adapter.probe()).available) return;
    const script = [
      'outside="denied"',
      'if /usr/bin/printf "escape" > "$OUTSIDE" 2>/dev/null; then outside="allowed"; fi',
      'protected="denied"',
      'if /bin/cat "$PROTECTED" >/dev/null 2>&1; then protected="allowed"; fi',
      'network=$(/usr/bin/curl -fsS "$URL")',
      '/usr/bin/printf "%s|%s|%s" "$outside" "$protected" "$network" > "$RESULT"'
    ].join("\n");
    const handle = await adapter.spawn({
      attemptId: "attempt-shell-network",
      configHash: "d".repeat(64),
      argv: ["/bin/sh", "-c", script],
      cwd: workspace,
      workspaceRoot: workspace,
      homeDirectory: resolve(runtime, "home"),
      tempDirectory: resolve(runtime, "tmp"),
      runtimeReadPaths: [],
      deniedReadPaths: [protectedFile],
      environment: {
        OUTSIDE: outsideWrite,
        PROTECTED: protectedFile,
        RESULT: resultPath,
        URL: `http://127.0.0.1:${String(address.port)}/fixture`
      },
      networkAccess: "ALLOW",
      deadlineAt: new Date(Date.now() + 10_000).toISOString()
    });
    await expect(handle.wait()).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      treeEmpty: true
    });
    expect(await readFile(resultPath, "utf8")).toBe("denied|denied|network-ok");
    await expect(readFile(outsideWrite, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
