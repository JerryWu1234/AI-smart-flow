import { describe, expect, it } from "vitest";

import { PiEventNormalizer, redactPiValue } from "../../../../packages/provider-pi/src/event-normalizer.js";

describe("Pi event normalization", () => {
  it("maps text and official tool lifecycle events", () => {
    const normalizer = new PiEventNormalizer("attempt-1", ["/private/run/workspace"]);
    expect(normalizer.normalize({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "editing /private/run/workspace/src/a.ts"
      }
    })).toEqual({
      type: "TEXT_DELTA",
      attemptId: "attempt-1",
      text: "editing <internal-path>/src/a.ts"
    });
    expect(normalizer.normalize({
      type: "tool_execution_start",
      toolName: "edit",
      toolCallId: "call-1"
    })).toEqual({
      type: "TOOL_STARTED",
      attemptId: "attempt-1",
      toolName: "edit",
      callId: "call-1"
    });
  });

  it("redacts nested SDK errors and recognizes structured blocking", () => {
    expect(redactPiValue(
      { stack: "at /private/run/workspace/src/a.ts with key secret-value" },
      ["/private/run/workspace"],
      ["secret-value"]
    )).toEqual({ stack: "at <internal-path>/src/a.ts with key <redacted>" });
    const normalizer = new PiEventNormalizer(
      "attempt-1",
      ["/private/run/workspace"],
      ["secret-value"]
    );
    expect(normalizer.blockedTerminal("SMARTFLOW_BLOCKED: INPUT_REQUIRED: missing value"))
      .toEqual({
        type: "BLOCKED",
        attemptId: "attempt-1",
        code: "INPUT_REQUIRED",
        message: "missing value"
      });
    expect(normalizer.blockedTerminal(
      "SMARTFLOW_BLOCKED: PROVIDER_ERROR: secret-value"
    )).toMatchObject({ message: "<redacted>" });
  });
});
