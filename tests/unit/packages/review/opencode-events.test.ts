import { describe, expect, it } from "vitest";

import {
  createOpenCodeEventState,
  reduceOpenCodeEventLine
} from "../../../../packages/review/src/agents/opencode/cli/events.js";

function line(type: string, sessionID: string, part?: Record<string, unknown>): string {
  return JSON.stringify({ type, sessionID, ...(part === undefined ? {} : { part }) });
}

describe("OpenCode NDJSON events", () => {
  it("collects the terminal step after an intermediate tool step", () => {
    const lines = [
      "wrapper diagnostic",
      line("step_start", "ses_create", { type: "step-start" }),
      line("tool_use", "ses_create", { type: "tool", tool: "read" }),
      line("step_finish", "ses_create", { type: "step-finish", reason: "tool-calls" }),
      line("step_start", "ses_create", { type: "step-start" }),
      line("text", "ses_create", { type: "text", text: "{\"tasks\":" }),
      line("text", "ses_create", { type: "text", text: "[]}" }),
      line("step_finish", "ses_create", { type: "step-finish", reason: "stop" })
    ];

    expect(lines.reduce(reduceOpenCodeEventLine, createOpenCodeEventState())).toEqual({
      currentText: "{\"tasks\":[]}",
      finalText: "{\"tasks\":[]}",
      turnCompleted: true,
      ignoredLineCount: 1,
      observedSessionId: "ses_create"
    });
  });

  it("enforces the exact resumed session", () => {
    const expected = createOpenCodeEventState("ses_expected");
    const accepted = reduceOpenCodeEventLine(
      expected,
      line("step_start", "ses_expected", { type: "step-start" })
    );
    expect(accepted.observedSessionId).toBe("ses_expected");

    const changed = reduceOpenCodeEventLine(
      expected,
      line("step_start", "ses_other", { type: "step-start" })
    );
    expect(changed.failure).toEqual({
      code: "OPENCODE_SESSION_MISMATCH",
      message: "OpenCode changed sessionID from ses_expected to ses_other"
    });
    expect(changed.observedSessionId).toBeUndefined();
  });

  it("maps the observed nested error payload", () => {
    const event = JSON.stringify({
      type: "error",
      sessionID: "ses_error",
      error: { name: "UnknownError", data: { message: "provider unavailable" } }
    });

    expect(reduceOpenCodeEventLine(createOpenCodeEventState(), event)).toMatchObject({
      observedSessionId: "ses_error",
      failure: { code: "OPENCODE_ERROR", message: "provider unavailable" }
    });
  });

  it("fails closed for malformed known events and non-terminal finish reasons", () => {
    expect(reduceOpenCodeEventLine(
      createOpenCodeEventState(),
      line("text", "ses_bad", { type: "text" })
    ).failure?.code).toBe("OPENCODE_EVENT_INVALID");

    expect(reduceOpenCodeEventLine(
      createOpenCodeEventState(),
      line("step_finish", "ses_length", { type: "step-finish", reason: "length" })
    ).failure).toEqual({
      code: "OPENCODE_TURN_FAILED",
      message: "OpenCode finished with reason length"
    });
  });

  it("ignores unknown event types without accepting malformed envelopes", () => {
    const state = [
      "42",
      JSON.stringify({ type: "future_event", sessionID: "ses_future" })
    ].reduce(reduceOpenCodeEventLine, createOpenCodeEventState());

    expect(state.ignoredLineCount).toBe(1);
    expect(state.observedSessionId).toBeUndefined();
    expect(state.failure).toBeUndefined();
  });
});
