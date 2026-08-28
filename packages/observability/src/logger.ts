import { redactSensitive } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface CorrelationIds {
  projectId?: string;
  jobId?: string;
  attemptId?: string;
  effectId?: string;
  actionId?: string;
  operationId?: string;
}

export interface LogEntry {
  level: LogLevel;
  event: string;
  correlation?: CorrelationIds;
  stage?: string;
  durationMs?: number;
  data?: unknown;
  error?: unknown;
}

export interface StructuredLogRecord extends LogEntry {
  timestamp: string;
  service: string;
}

export type LogSink = (line: string) => void;

export class StructuredLogger {
  public constructor(
    private readonly service: string,
    private readonly sink: LogSink = (line) => process.stderr.write(`${line}\n`),
    private readonly now: () => Date = () => new Date()
  ) {}

  public log(entry: LogEntry): StructuredLogRecord {
    const record = redactSensitive({
      timestamp: this.now().toISOString(),
      service: this.service,
      ...entry
    }) as StructuredLogRecord;
    this.sink(JSON.stringify(record));
    return record;
  }

  public stage(stage: string, correlation: CorrelationIds = {}): StageLogTimer {
    return new StageLogTimer(this, stage, correlation, performance.now());
  }
}

export class StageLogTimer {
  private completed = false;

  public constructor(
    private readonly logger: StructuredLogger,
    private readonly stageName: string,
    private readonly correlation: CorrelationIds,
    private readonly startedAt: number
  ) {}

  public complete(data?: unknown): StructuredLogRecord {
    if (this.completed) throw new Error(`Stage timer already completed: ${this.stageName}`);
    this.completed = true;
    return this.logger.log({
      level: "info",
      event: "stage.completed",
      stage: this.stageName,
      durationMs: Math.max(0, performance.now() - this.startedAt),
      correlation: this.correlation,
      data
    });
  }

  public fail(error: unknown): StructuredLogRecord {
    if (this.completed) throw new Error(`Stage timer already completed: ${this.stageName}`);
    this.completed = true;
    return this.logger.log({
      level: "error",
      event: "stage.failed",
      stage: this.stageName,
      durationMs: Math.max(0, performance.now() - this.startedAt),
      correlation: this.correlation,
      error
    });
  }
}
