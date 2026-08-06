import type { WorkerEvent } from "@smartflow/provider-core";

function redactString(
  value: string,
  roots: readonly string[],
  secrets: readonly string[] = []
): string {
  const redactedSecrets = secrets
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.replaceAll(secret, "<redacted>"), value);
  const redactedRoots = roots
    .filter((root) => root.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, root) => result.replaceAll(root, "<internal-path>"), redactedSecrets);
  return redactedRoots
    .replace(/(^|[\s"'`=:(])\/(?!\/)[^\s"'`,;)}\]]+/gu, (_match, prefix: string) =>
      `${prefix}<internal-path>`
    )
    .replace(/\b[A-Za-z]:\\[^\s"'`,;)}\]]+/gu, "<internal-path>");
}

export function redactPiValue(
  value: unknown,
  roots: readonly string[],
  secrets: readonly string[] = []
): unknown {
  if (typeof value === "string") return redactString(value, roots, secrets);
  if (Array.isArray(value)) return value.map((item) => redactPiValue(item, roots, secrets));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactPiValue(item, roots, secrets)])
    );
  }
  return value;
}

function stringField(event: Record<string, unknown>, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

export class PiEventNormalizer {
  public constructor(
    private readonly attemptId: string,
    private readonly redactionRoots: readonly string[],
    private readonly redactionSecrets: readonly string[] = []
  ) {}

  public normalize(event: Record<string, unknown>): WorkerEvent | undefined {
    const redacted = redactPiValue(
      event,
      this.redactionRoots,
      this.redactionSecrets
    ) as Record<string, unknown>;
    if (redacted.type === "message_update") {
      const update = redacted.assistantMessageEvent;
      if (typeof update !== "object" || update === null || Array.isArray(update)) return undefined;
      const detail = update as Record<string, unknown>;
      if (detail.type !== "text_delta" || typeof detail.delta !== "string") return undefined;
      return { type: "TEXT_DELTA", attemptId: this.attemptId, text: detail.delta };
    }
    if (redacted.type === "tool_execution_start") {
      const toolName = stringField(redacted, "toolName");
      const callId = stringField(redacted, "toolCallId") ?? stringField(redacted, "id");
      if (toolName === undefined || callId === undefined) return undefined;
      return { type: "TOOL_STARTED", attemptId: this.attemptId, toolName, callId };
    }
    if (redacted.type === "tool_execution_end") {
      const toolName = stringField(redacted, "toolName");
      const callId = stringField(redacted, "toolCallId") ?? stringField(redacted, "id");
      if (toolName === undefined || callId === undefined) return undefined;
      return {
        type: "TOOL_FINISHED",
        attemptId: this.attemptId,
        toolName,
        callId,
        isError: redacted.isError === true
      };
    }
    return undefined;
  }

  public blockedTerminal(lastAssistantText: string): WorkerEvent | undefined {
    const text = redactString(lastAssistantText, this.redactionRoots, this.redactionSecrets);
    const match = /^SMARTFLOW_BLOCKED:\s*([A-Z][A-Z0-9_]*):\s*(.+)$/imu.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return {
        type: "BLOCKED",
        attemptId: this.attemptId,
        code: match[1],
        message: match[2].trim()
      };
    }
    return undefined;
  }
}
