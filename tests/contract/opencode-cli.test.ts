import { describe, expect, it } from "vitest";

import {
  createOpenCodeEventState,
  reduceOpenCodeEventLine
} from "../../packages/review/src/agents/opencode/cli/events.js";

const SESSION_ID = "ses_fa8ed8a8effeRgh2vB4wGikGbj";

function event(type: string, part: Record<string, unknown>): string {
  return JSON.stringify({
    type,
    timestamp: 1_788_167_223_503,
    sessionID: SESSION_ID,
    part
  });
}

const OPEN_CODE_1_17_7_TRACE = [
  event("step_start", {
    id: "prt_step_1",
    messageID: "msg_1",
    sessionID: SESSION_ID,
    snapshot: "fixture-snapshot",
    type: "step-start"
  }),
  event("tool_use", {
    id: "prt_tool_1",
    messageID: "msg_1",
    sessionID: SESSION_ID,
    type: "tool",
    tool: "read",
    callID: "call_read_1",
    state: {
      status: "completed",
      input: { filePath: "/fixture/candidate/source.ts" },
      output: "fixture source",
      time: { start: 1, end: 2 }
    }
  }),
  event("step_finish", {
    id: "prt_finish_1",
    messageID: "msg_1",
    sessionID: SESSION_ID,
    snapshot: "fixture-snapshot",
    type: "step-finish",
    reason: "tool-calls"
  }),
  event("step_start", {
    id: "prt_step_2",
    messageID: "msg_2",
    sessionID: SESSION_ID,
    snapshot: "fixture-snapshot",
    type: "step-start"
  }),
  event("text", {
    id: "prt_text_1",
    messageID: "msg_2",
    sessionID: SESSION_ID,
    type: "text",
    text: "{\"tasks\":[]}",
    time: { start: 3, end: 4 }
  }),
  event("step_finish", {
    id: "prt_finish_2",
    messageID: "msg_2",
    sessionID: SESSION_ID,
    snapshot: "fixture-snapshot",
    type: "step-finish",
    reason: "stop",
    tokens: { input: 0, output: 0, reasoning: 0 }
  })
] as const;

describe("OpenCode 1.17.7 CLI contract", () => {
  it("reduces the observed CREATE tool round and terminal response", () => {
    const state = OPEN_CODE_1_17_7_TRACE.reduce(
      reduceOpenCodeEventLine,
      createOpenCodeEventState()
    );

    expect(state).toMatchObject({
      observedSessionId: SESSION_ID,
      turnCompleted: true,
      finalText: "{\"tasks\":[]}",
      ignoredLineCount: 0
    });
    expect(JSON.parse(state.finalText ?? "null")).toEqual({ tasks: [] });
  });

  it("accepts the same trace only for the exact RESUME session", () => {
    const resumed = OPEN_CODE_1_17_7_TRACE.reduce(
      reduceOpenCodeEventLine,
      createOpenCodeEventState(SESSION_ID)
    );
    expect(resumed.failure).toBeUndefined();
    expect(resumed.observedSessionId).toBe(SESSION_ID);

    const mismatched = OPEN_CODE_1_17_7_TRACE.reduce(
      reduceOpenCodeEventLine,
      createOpenCodeEventState("ses_other")
    );
    expect(mismatched.failure?.code).toBe("OPENCODE_SESSION_MISMATCH");
  });
});
