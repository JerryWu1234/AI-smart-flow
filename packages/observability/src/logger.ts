import { redactSensitive } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface CorrelationIds {
  projectId?: string;
  jobId?: string;
  actionId?: string;
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
}
