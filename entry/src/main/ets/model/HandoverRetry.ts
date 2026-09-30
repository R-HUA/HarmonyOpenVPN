// Retry only new DNS failures during a bounded handover window. Counts are cumulative.
export class HandoverRetry {
  private failures: number = 0;
  private until: number = 0;
  private remaining: number = 0;
  constructor(private retry: () => void, private log: (message: string) => void) {}

  arm(): void { this.until = Date.now() + 15000; this.remaining = 2; }
  finish(): void { this.until = 0; this.remaining = 0; }
  observe(failures: number): void {
    const changed = failures > this.failures;
    this.failures = failures;
    if (!changed || Date.now() >= this.until || this.remaining <= 0) return;
    --this.remaining;
    this.log('HANDOVER_DNS_RETRY: early retry; remaining=' + this.remaining);
    this.retry();
  }
}
