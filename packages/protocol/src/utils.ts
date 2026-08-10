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

/**
 * Deterministic JSON stringification with recursively sorted object keys.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/**
 * Alias for `canonicalJson`.
 */
export const canonical = canonicalJson;

/**
 * SHA-256 hex digest of a UTF-8 string or Uint8Array.
 */
export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * SHA-256 hex digest of the canonical JSON representation of a value.
 */
export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
