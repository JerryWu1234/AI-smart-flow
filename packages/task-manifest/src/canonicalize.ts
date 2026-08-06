import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const child = input[key];
    if (child !== undefined) output[key] = normalize(child);
  }
  return output;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}
