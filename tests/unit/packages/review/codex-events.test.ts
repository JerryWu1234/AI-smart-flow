import { describe, expect, it } from "vitest";

import {
  createCodexEventState,
  reduceCodexEventLine
} from "../../../../packages/review/src/agents/codex/cli/events.js";

function reduceLines(lines: readonly string[]): ReturnType<typeof createCodexEventState> {
  return lines.reduce(reduceCodexEventLine, createCodexEventState());
}

describe("Codex JSONL events", () => {
  it("collects session, completion, usage, and the final agent message", () => {
    const events = reduceLines([
      "not-json diagnostics from a wrapper",
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.started", item: { type: "command_execution" } }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "final fallback text" }
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 5 } })
    ]);

    expect(events).toEqual({
      sessionId: "thread-1",
      turnCompleted: true,
      usage: { input_tokens: 20, output_tokens: 5 },
      agentMessage: "final fallback text",
      ignoredLineCount: 1
    });
  });

  it.each([
    [
      JSON.stringify({ type: "turn.failed", error: { message: "schema rejected" } }),
      "CODEX_TURN_FAILED",
      "schema rejected"
    ],
    [
      JSON.stringify({ type: "error", message: "authentication unavailable" }),
      "CODEX_ERROR",
      "authentication unavailable"
    ]
  ])("maps terminal failure events from %s", (line, code, message) => {
    expect(reduceCodexEventLine(createCodexEventState(), line)).toMatchObject({
      failure: { code, message }
    });
  });

  it("does not let non-JSON or unknown event lines abort later valid events", () => {
    expect(() => reduceLines(["{broken", "42", "plain text"])).not.toThrow();
    expect(reduceLines([
      "{broken",
      JSON.stringify({ type: "future.event", value: true }),
      JSON.stringify({ type: "thread.started", thread_id: "thread-2" }),
      JSON.stringify({ type: "turn.completed" })
    ])).toMatchObject({
      sessionId: "thread-2",
      turnCompleted: true,
      ignoredLineCount: 1
    });
  });

  it("fails closed for malformed known events and session changes", () => {
    const malformed = reduceCodexEventLine(
      createCodexEventState(),
      JSON.stringify({ type: "thread.started", thread_id: "" })
    );
    expect(malformed.failure?.code).toBe("CODEX_EVENT_INVALID");

    const started = reduceCodexEventLine(
      createCodexEventState(),
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" })
    );
    const changed = reduceCodexEventLine(
      started,
      JSON.stringify({ type: "thread.started", thread_id: "thread-2" })
    );
    expect(changed.failure).toMatchObject({ code: "CODEX_SESSION_MISMATCH" });
  });
});
