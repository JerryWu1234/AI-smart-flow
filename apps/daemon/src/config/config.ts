import { readFile } from "node:fs/promises";

import { parse } from "yaml";

export const REVIEW_STRATEGIES = ["codex", "codex-desktop", "claude-code"] as const;
export type ReviewStrategy = (typeof REVIEW_STRATEGIES)[number];

export interface SmartFlowConfig {
  review: {
    strategy?: ReviewStrategy;
    noProgressThreshold: 15;
    // Optional overrides passed through without a value allow list. The Review
    // Agent owns which values it accepts and supplies its own defaults.
    model?: string;
    effort?: string;
    deadlineMs: number;
    maxAttempts: number;
  };
}

export const defaultSmartFlowConfig: SmartFlowConfig = {
  review: {
    noProgressThreshold: 15,
    deadlineMs: 45 * 60_000,
    maxAttempts: 3
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReviewStrategy(value: unknown): value is ReviewStrategy {
  return REVIEW_STRATEGIES.some((strategy) => strategy === value);
}

export function resolveReviewStrategy(
  configuredStrategy: ReviewStrategy | undefined,
  clientName: string | undefined
): ReviewStrategy {
  if (configuredStrategy !== undefined) return configuredStrategy;
  return isReviewStrategy(clientName) ? clientName : "codex";
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], scope: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown ${scope} configuration: ${unknown.join(",")}`);
}

export function parseSmartFlowConfig(value: unknown): SmartFlowConfig {
  if (!isRecord(value)) throw new Error("SmartFlow configuration must be an object");
  exactKeys(value, ["review"], "root");
  const review = value.review ?? defaultSmartFlowConfig.review;
  if (!isRecord(review)) {
    throw new Error("SmartFlow review configuration must be an object");
  }
  exactKeys(
    review,
    [
      "strategy",
      "noProgressThreshold",
      "model",
      "effort",
      "deadlineMs",
      "maxAttempts"
    ],
    "review"
  );
  const reviewStrategy = review.strategy;
  const noProgressThreshold = review.noProgressThreshold ?? 15;
  const model = review.model;
  const effort = review.effort;
  const deadlineMs = review.deadlineMs ?? 45 * 60_000;
  const maxAttempts = review.maxAttempts ?? 3;
  if (
    (reviewStrategy !== undefined && !isReviewStrategy(reviewStrategy)) ||
    noProgressThreshold !== 15 ||
    (model !== undefined &&
      (typeof model !== "string" || model.trim().length === 0)) ||
    (effort !== undefined &&
      (typeof effort !== "string" || effort.trim().length === 0)) ||
    typeof deadlineMs !== "number" ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 30_000 ||
    deadlineMs > 3_600_000 ||
    typeof maxAttempts !== "number" ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10
  ) {
    throw new Error("SmartFlow configuration contains unsupported values");
  }
  return {
    review: {
      ...(isReviewStrategy(reviewStrategy) ? { strategy: reviewStrategy } : {}),
      noProgressThreshold,
      ...(typeof model === "string" ? { model: model.trim() } : {}),
      ...(typeof effort === "string" ? { effort: effort.trim() } : {}),
      deadlineMs,
      maxAttempts
    }
  };
}

export async function loadSmartFlowConfig(path = process.env.SMARTFLOW_CONFIG): Promise<SmartFlowConfig> {
  if (path === undefined) return structuredClone(defaultSmartFlowConfig);
  return parseSmartFlowConfig(parse(await readFile(path, "utf8")));
}
