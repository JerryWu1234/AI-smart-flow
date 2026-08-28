export interface CodexEventFailure {
  readonly code: string;
  readonly message: string;
}

export interface CodexEventState {
  readonly sessionId?: string;
  readonly turnCompleted: boolean;
  readonly usage?: unknown;
  readonly agentMessage?: string;
  readonly failure?: CodexEventFailure;
  readonly ignoredLineCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function failureMessage(event: Record<string, unknown>, fallback: string): string {
  const directMessage = nonEmptyString(event.message);
  if (directMessage !== undefined) return directMessage;

  if (typeof event.error === "string") {
    const error = nonEmptyString(event.error);
    if (error !== undefined) return error;
  }
  if (isRecord(event.error)) {
    const nestedMessage = nonEmptyString(event.error.message);
    if (nestedMessage !== undefined) return nestedMessage;
  }

  const detail = nonEmptyString(event.detail);
  return detail ?? fallback;
}

function withFailure(
  state: CodexEventState,
  code: string,
  message: string
): CodexEventState {
  if (state.failure !== undefined) return state;
  return { ...state, failure: { code, message } };
}

export function createCodexEventState(): CodexEventState {
  return { turnCompleted: false, ignoredLineCount: 0 };
}

export function reduceCodexEventLine(
  state: CodexEventState,
  line: string
): CodexEventState {
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
    case "thread.started": {
      const sessionId = nonEmptyString(value.thread_id);
      if (sessionId === undefined) {
        return withFailure(
          state,
          "CODEX_EVENT_INVALID",
          "thread.started did not include a non-empty thread_id"
        );
      }
      if (state.sessionId !== undefined && state.sessionId !== sessionId) {
        return withFailure(
          state,
          "CODEX_SESSION_MISMATCH",
          `Codex changed thread_id from ${state.sessionId} to ${sessionId}`
        );
      }
      return { ...state, sessionId };
    }
    case "turn.completed":
      return Object.hasOwn(value, "usage")
        ? { ...state, turnCompleted: true, usage: value.usage }
        : { ...state, turnCompleted: true };
    case "turn.failed":
      return withFailure(
        state,
        "CODEX_TURN_FAILED",
        failureMessage(value, "Codex reported turn.failed")
      );
    case "error":
      return withFailure(
        state,
        "CODEX_ERROR",
        failureMessage(value, "Codex reported an error event")
      );
    case "item.completed": {
      if (!isRecord(value.item) || value.item.type !== "agent_message") return state;
      const text = typeof value.item.text === "string"
        ? value.item.text
        : typeof value.item.content === "string"
          ? value.item.content
          : undefined;
      if (text === undefined) {
        return withFailure(
          state,
          "CODEX_EVENT_INVALID",
          "agent_message item.completed did not include text"
        );
      }
      return { ...state, agentMessage: text };
    }
    default:
      return state;
  }
}
