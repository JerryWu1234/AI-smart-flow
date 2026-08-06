export interface StageMetric {
  count: number;
  failures: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export class MetricsRegistry {
  private readonly stages = new Map<string, StageMetric>();

  public recordStage(stage: string, durationMs: number, succeeded: boolean): void {
    if (stage.length === 0 || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error("Invalid stage metric");
    }
    const current = this.stages.get(stage) ?? {
      count: 0,
      failures: 0,
      totalDurationMs: 0,
      maxDurationMs: 0
    };
    this.stages.set(stage, {
      count: current.count + 1,
      failures: current.failures + (succeeded ? 0 : 1),
      totalDurationMs: current.totalDurationMs + durationMs,
      maxDurationMs: Math.max(current.maxDurationMs, durationMs)
    });
  }

  public snapshot(): Readonly<Record<string, StageMetric>> {
    return Object.fromEntries(
      [...this.stages.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([stage, metric]) => [stage, { ...metric }])
    );
  }
}
