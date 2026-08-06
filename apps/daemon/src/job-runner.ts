import { EventEmitter } from "node:events";

export type BackgroundJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";

export interface BackgroundJobSnapshot {
  jobId: string;
  status: BackgroundJobStatus;
  stateVersion: number;
  result?: unknown;
  error?: string;
}

export interface JobWaitResult {
  changed: boolean;
  snapshot: BackgroundJobSnapshot;
}

export class JobRunner {
  private readonly jobs = new Map<string, BackgroundJobSnapshot>();
  private readonly events = new EventEmitter();
  private nextStateVersion = 0;

  public enqueue(jobId: string, task: () => Promise<unknown>): BackgroundJobSnapshot {
    if (this.jobs.has(jobId)) throw new Error(`Job already exists: ${jobId}`);
    const queued = this.update({ jobId, status: "QUEUED", stateVersion: 0 });
    void this.run(jobId, task);
    return queued;
  }

  public get(jobId: string): BackgroundJobSnapshot {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new Error(`Unknown job: ${jobId}`);
    return structuredClone(job);
  }

  public async waitForChange(
    jobId: string,
    afterStateVersion: number,
    timeoutMs: number
  ): Promise<JobWaitResult> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
      throw new Error("wait timeout must be between 0 and 30000ms");
    }
    const current = this.get(jobId);
    if (current.stateVersion > afterStateVersion || timeoutMs === 0) {
      return { changed: current.stateVersion > afterStateVersion, snapshot: current };
    }
    return new Promise<JobWaitResult>((resolve) => {
      const eventName = `job:${jobId}`;
      const settle = (): void => {
        clearTimeout(timer);
        this.events.off(eventName, settle);
        const snapshot = this.get(jobId);
        resolve({ changed: snapshot.stateVersion > afterStateVersion, snapshot });
      };
      const timer = setTimeout(settle, timeoutMs);
      timer.unref();
      this.events.on(eventName, settle);
    });
  }

  private update(snapshot: Omit<BackgroundJobSnapshot, "stateVersion"> & { stateVersion?: number }): BackgroundJobSnapshot {
    this.nextStateVersion += 1;
    const next: BackgroundJobSnapshot = { ...snapshot, stateVersion: this.nextStateVersion };
    this.jobs.set(next.jobId, next);
    this.events.emit(`job:${next.jobId}`);
    return structuredClone(next);
  }

  private async run(jobId: string, task: () => Promise<unknown>): Promise<void> {
    this.update({ jobId, status: "RUNNING" });
    try {
      const result = await task();
      this.update({ jobId, status: "SUCCEEDED", result });
    } catch (error) {
      this.update({
        jobId,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
