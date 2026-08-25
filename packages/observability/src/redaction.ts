const sensitiveKey = /(?:authorization|cookie|credential|password|passwd|private.?key|secret|session|token|api.?key|env(?:ironment)?)/iu;
const sensitiveAssignment = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*([^\s,;]+)/giu;
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const privateKeyBlock = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu;
const posixAbsolutePath = /(^|[\s"'`=:(])\/(?!\/)[^\s"'`,;)}\]]+/gu;
const windowsAbsolutePath = /\b[A-Za-z]:\\[^\s"'`,;)}\]]+/gu;

const REDACTED = "[REDACTED]";
const REDACTED_PATH = "[REDACTED_PATH]";

function redactString(value: string): string {
  return value
    .replace(privateKeyBlock, REDACTED)
    .replace(bearerToken, `Bearer ${REDACTED}`)
    .replace(sensitiveAssignment, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(posixAbsolutePath, (_match, prefix: string) => `${prefix}${REDACTED_PATH}`)
    .replace(windowsAbsolutePath, REDACTED_PATH);
}

export function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = sensitiveKey.test(key) ? REDACTED : redactSensitive(item, seen);
  }
  return output;
}
