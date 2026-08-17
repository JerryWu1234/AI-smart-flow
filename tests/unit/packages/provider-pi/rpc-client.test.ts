import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { PiRpcClient } from "../../../../packages/provider-pi/src/rpc-client.js";

describe("Pi JSONL RPC client", () => {
  it("correlates commands and streams SDK events", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const client = new PiRpcClient({ stdin, stdout, stderr });
    const written: string[] = [];
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => written.push(chunk));
    const request = client.request({ type: "get_state" });
    while (written.length === 0) await new Promise((settle) => setTimeout(settle, 0));
    const command = JSON.parse(written.join("").trim()) as { id: string };
    stdout.write(`${JSON.stringify({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "pi-session-1" }
    })}\n`);
    await expect(request).resolves.toMatchObject({ data: { sessionId: "pi-session-1" } });
    const events = client.events()[Symbol.asyncIterator]();
    stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    await expect(events.next()).resolves.toEqual({ done: false, value: { type: "agent_start" } });
  });

  it("fails closed on malformed JSONL", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new PiRpcClient({ stdin, stdout, stderr: new PassThrough() });
    const next = client.events()[Symbol.asyncIterator]().next();
    stdout.write("not-json\n");
    await expect(next).rejects.toThrow(/PI_RPC_MALFORMED_JSONL/u);
  });
});
