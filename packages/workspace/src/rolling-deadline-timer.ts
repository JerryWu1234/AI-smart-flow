export class RollingDeadlineTimer {
  private active = true;
  private deadline: number;
  private expired = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    initialDeadline: number,
    private readonly onDeadline: () => void
  ) {
    this.deadline = initialDeadline;
    this.arm(initialDeadline);
  }

  public renew(deadlineAt: string): boolean {
    if (!this.active) return false;
    if (!Number.isFinite(this.deadline) || this.deadline <= Date.now()) {
      this.expire();
      return false;
    }
    const deadline = Date.parse(deadlineAt);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return false;
    this.arm(deadline);
    return true;
  }

  public stop(): boolean {
    if (!this.active) return this.expired;
    if (!Number.isFinite(this.deadline) || this.deadline <= Date.now()) {
      this.expire();
      return true;
    }
    this.active = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    return false;
  }

  private arm(deadline: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.deadline = deadline;
    if (!Number.isFinite(deadline) || deadline <= Date.now()) {
      this.expire();
      return;
    }
    const delay = Math.max(1, deadline - Date.now());
    this.timer = setTimeout(() => this.expire(), delay);
    this.timer.unref();
  }

  private expire(): void {
    if (!this.active) return;
    this.active = false;
    this.expired = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.onDeadline();
  }
}
