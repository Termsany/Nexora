/** One decode in flight and one replaceable pending frame; no FIFO of stale images. */
export class LatestFrameQueue<T> {
  private pending: { value: T } | undefined;
  private busy = false;
  private closed = false;
  received = 0;
  rendered = 0;
  dropped = 0;
  failed = 0;
  decodeMs = 0;

  private readonly consume: (value: T) => Promise<void>;
  constructor(consume: (value: T) => Promise<void>) { this.consume = consume; }

  offer(value: T): void {
    if (this.closed) return;
    this.received++;
    if (this.pending) this.dropped++;
    this.pending = { value };
    if (!this.busy) void this.drain();
  }

  dispose(): void { this.closed = true; this.pending = undefined; }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (!this.closed && this.pending) {
        const item = this.pending;
        this.pending = undefined;
        const start = performance.now();
        try { await this.consume(item.value); if (!this.closed) this.rendered++; }
        catch { if (!this.closed) this.failed++; }
        this.decodeMs = performance.now() - start;
      }
    } finally { this.busy = false; }
  }
}
