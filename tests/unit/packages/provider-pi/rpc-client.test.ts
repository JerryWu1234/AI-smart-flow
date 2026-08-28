import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { PiRpcClient } from "../../../../packages/provider-pi/src/rpc-client.js";

describe("Pi JSONL RPC client", () => {
  it("correlates commands and streams SDK events", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new PiRpcClient({ stdin, stdout });
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

  it("intercepts control events at receipt before queued events are consumed", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let heartbeatCount = 0;
    const client = new PiRpcClient(
      { stdin, stdout },
      (event) => {
        if (event.type !== "extension_ui_request" || event.statusKey !== "smartflow-heartbeat") {
          return false;
        }
        heartbeatCount += 1;
        return true;
      }
    );

    stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    stdout.write(`${JSON.stringify({
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: "smartflow-heartbeat"
    })}\n`);
    stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(heartbeatCount).toBe(1);
    const events = client.events()[Symbol.asyncIterator]();
    await expect(events.next()).resolves.toEqual({ done: false, value: { type: "agent_start" } });
    await expect(events.next()).resolves.toEqual({ done: false, value: { type: "agent_end" } });
  });

  it("fails closed on malformed JSONL", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new PiRpcClient({ stdin, stdout });
    const next = client.events()[Symbol.asyncIterator]().next();
    stdout.write("not-json\n");
    await expect(next).rejects.toThrow(/PI_RPC_MALFORMED_JSONL/u);
  });
});
