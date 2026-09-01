export const REVIEW_STRATEGIES = [
  "codex",
  "codex-desktop",
  "claude-code",
  "claude-code-desktop",
  "opencode"
] as const;
export type ReviewStrategy = (typeof REVIEW_STRATEGIES)[number];

export interface SmartFlowConfig {
  review: {
    strategy?: ReviewStrategy;
    // Optional overrides passed through without a value allow list. The Review
    // Agent owns which values it accepts and supplies its own defaults.
    model?: string;
    effort?: string;
  };
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

function environmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = environment[key];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(`REVIEW_CONFIG_INVALID: ${key} must not be empty`);
  }
  return value;
}

export function resolveSmartFlowConfig(
  environment: NodeJS.ProcessEnv = process.env
): SmartFlowConfig {
  if (environment.SMARTFLOW_CONFIG !== undefined) {
    throw new Error(
      "REVIEW_CONFIG_INVALID: SMARTFLOW_CONFIG is unsupported; use REVIEW_ADAPTER, REVIEW_MODEL, and REVIEW_EFFORT"
    );
  }
  const adapter = environmentValue(environment, "REVIEW_ADAPTER");
  if (adapter !== undefined && !isReviewStrategy(adapter)) {
    throw new Error(
      `REVIEW_ADAPTER_INVALID: unsupported adapter "${adapter}"; expected codex, codex-desktop, claude-code, claude-code-desktop, or opencode`
    );
  }
  const model = environmentValue(environment, "REVIEW_MODEL");
  const effort = environmentValue(environment, "REVIEW_EFFORT");
  return {
    review: {
      ...(adapter === undefined ? {} : { strategy: adapter }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort })
    }
  };
}
