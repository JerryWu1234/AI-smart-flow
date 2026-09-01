export interface OpenCodeEventFailure {
  readonly code: string;
  readonly message: string;
}

export interface OpenCodeEventState {
  readonly expectedSessionId?: string;
  readonly observedSessionId?: string;
  readonly currentText: string;
  readonly finalText?: string;
  readonly turnCompleted: boolean;
  readonly failure?: OpenCodeEventFailure;
  readonly ignoredLineCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function withFailure(
  state: OpenCodeEventState,
  code: string,
  message: string
): OpenCodeEventState {
  if (state.failure !== undefined) return state;
  return { ...state, failure: { code, message } };
}

function withEventSession(
  state: OpenCodeEventState,
  event: Record<string, unknown>,
  eventType: string
): OpenCodeEventState {
  const sessionId = nonEmptyString(event.sessionID);
  if (sessionId === undefined) {
    return withFailure(
      state,
      "OPENCODE_EVENT_INVALID",
      `${eventType} did not include a non-empty sessionID`
    );
  }
  if (
    state.expectedSessionId !== undefined &&
    state.expectedSessionId !== sessionId
  ) {
    return withFailure(
      state,
      "OPENCODE_SESSION_MISMATCH",
      `OpenCode changed sessionID from ${state.expectedSessionId} to ${sessionId}`
    );
  }
  if (
    state.observedSessionId !== undefined &&
    state.observedSessionId !== sessionId
  ) {
    return withFailure(
      state,
      "OPENCODE_SESSION_MISMATCH",
      `OpenCode changed sessionID from ${state.observedSessionId} to ${sessionId}`
    );
  }
  return state.observedSessionId === sessionId
    ? state
    : { ...state, observedSessionId: sessionId };
}

function errorMessage(event: Record<string, unknown>): string {
  if (isRecord(event.error)) {
    const direct = nonEmptyString(event.error.message);
    if (direct !== undefined) return direct;
    if (isRecord(event.error.data)) {
      const nested = nonEmptyString(event.error.data.message);
      if (nested !== undefined) return nested;
    }
    const name = nonEmptyString(event.error.name);
    if (name !== undefined) return name;
  }
  return nonEmptyString(event.message) ?? "OpenCode reported an error event";
}

export function createOpenCodeEventState(
  expectedSessionId?: string
): OpenCodeEventState {
  const state = {
    currentText: "",
    turnCompleted: false,
    ignoredLineCount: 0
  };
  return expectedSessionId === undefined
    ? state
    : { ...state, expectedSessionId };
}

export function reduceOpenCodeEventLine(
  state: OpenCodeEventState,
  line: string
): OpenCodeEventState {
  if (state.failure !== undefined) return state;
  const trimmed = line.trim();
  if (trimmed.length === 0) return state;

  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    return { ...state, ignoredLineCount: state.ignoredLineCount + 1 };
  }

  if (!isRecord(value) || typeof value.type !== "string") {
    return { ...state, ignoredLineCount: state.ignoredLineCount + 1 };
  }

  switch (value.type) {
    case "step_start": {
      const next = withEventSession(state, value, "step_start");
      if (next.failure !== undefined) return next;
      if (!isRecord(value.part) || value.part.type !== "step-start") {
        return withFailure(
          next,
          "OPENCODE_EVENT_INVALID",
          "step_start did not include a step-start part"
        );
      }
      return { ...next, currentText: "", turnCompleted: false };
    }
    case "text": {
      const next = withEventSession(state, value, "text");
      if (next.failure !== undefined) return next;
      if (
        !isRecord(value.part) ||
        value.part.type !== "text" ||
        typeof value.part.text !== "string"
      ) {
        return withFailure(
          next,
          "OPENCODE_EVENT_INVALID",
          "text did not include a text part"
        );
      }
      return { ...next, currentText: next.currentText + value.part.text };
    }
    case "tool_use": {
      const next = withEventSession(state, value, "tool_use");
      if (next.failure !== undefined) return next;
      if (!isRecord(value.part) || value.part.type !== "tool") {
        return withFailure(
          next,
          "OPENCODE_EVENT_INVALID",
          "tool_use did not include a tool part"
        );
      }
      return next;
    }
    case "step_finish": {
      const next = withEventSession(state, value, "step_finish");
      if (next.failure !== undefined) return next;
      if (
        !isRecord(value.part) ||
        value.part.type !== "step-finish"
      ) {
        return withFailure(
          next,
          "OPENCODE_EVENT_INVALID",
          "step_finish did not include a step-finish part"
        );
      }
      const reason = nonEmptyString(value.part.reason);
      if (reason === undefined) {
        return withFailure(
          next,
          "OPENCODE_EVENT_INVALID",
          "step_finish did not include a non-empty reason"
        );
      }
      if (reason === "tool-calls") return { ...next, currentText: "" };
      if (reason === "stop") {
        return {
          ...next,
          finalText: next.currentText,
          turnCompleted: true
        };
      }
      return withFailure(
        next,
        "OPENCODE_TURN_FAILED",
        `OpenCode finished with reason ${reason}`
      );
    }
    case "error": {
      const next = withEventSession(state, value, "error");
      return next.failure === undefined
        ? withFailure(next, "OPENCODE_ERROR", errorMessage(value))
        : next;
    }
    default:
      return state;
  }
}
