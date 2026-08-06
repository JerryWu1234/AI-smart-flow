import { readFile } from "node:fs/promises";

import { parse } from "yaml";

export interface SmartFlowConfig {
  version: 5;
  workspace: { mode: "git-tree" };
  review: { strategy: "host-subagent"; onUnavailable: "pause"; noProgressThreshold: 15 };
  publish: { mode: "auto-after-review"; onConflict: "pause" };
}

export const defaultSmartFlowConfig: SmartFlowConfig = {
  version: 5,
  workspace: { mode: "git-tree" },
  review: { strategy: "host-subagent", onUnavailable: "pause", noProgressThreshold: 15 },
  publish: { mode: "auto-after-review", onConflict: "pause" }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], scope: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown ${scope} configuration: ${unknown.join(",")}`);
}

export function parseSmartFlowConfig(value: unknown): SmartFlowConfig {
  if (!isRecord(value)) throw new Error("SmartFlow configuration must be an object");
  exactKeys(value, ["version", "workspace", "review", "publish"], "root");
  const workspace = value.workspace ?? defaultSmartFlowConfig.workspace;
  const review = value.review ?? defaultSmartFlowConfig.review;
  const publish = value.publish ?? defaultSmartFlowConfig.publish;
  if (!isRecord(workspace) || !isRecord(review) || !isRecord(publish)) {
    throw new Error("SmartFlow configuration sections must be objects");
  }
  exactKeys(workspace, ["mode"], "workspace");
  exactKeys(review, ["strategy", "onUnavailable", "noProgressThreshold"], "review");
  exactKeys(publish, ["mode", "onConflict"], "publish");
  const version = value.version ?? 5;
  const workspaceMode = workspace.mode ?? "git-tree";
  const reviewStrategy = review.strategy ?? "host-subagent";
  const reviewUnavailable = review.onUnavailable ?? "pause";
  const noProgressThreshold = review.noProgressThreshold ?? 15;
  const publishMode = publish.mode ?? "auto-after-review";
  const publishConflict = publish.onConflict ?? "pause";
  if (
    version !== 5 ||
    workspaceMode !== "git-tree" ||
    reviewStrategy !== "host-subagent" ||
    reviewUnavailable !== "pause" ||
    noProgressThreshold !== 15 ||
    publishMode !== "auto-after-review" ||
    publishConflict !== "pause"
  ) {
    throw new Error("SmartFlow configuration contains unsupported V1 values");
  }
  return {
    version,
    workspace: { mode: workspaceMode },
    review: {
      strategy: reviewStrategy,
      onUnavailable: reviewUnavailable,
      noProgressThreshold
    },
    publish: { mode: publishMode, onConflict: publishConflict }
  };
}

export async function loadSmartFlowConfig(path = process.env.SMARTFLOW_CONFIG): Promise<SmartFlowConfig> {
  if (path === undefined) return structuredClone(defaultSmartFlowConfig);
  return parseSmartFlowConfig(parse(await readFile(path, "utf8")));
}
