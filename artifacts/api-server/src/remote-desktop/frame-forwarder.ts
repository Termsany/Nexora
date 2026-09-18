type FrameSocket = {
  bufferedAmount: number;
  send(data: Buffer, options: { binary: boolean }, callback: (error?: Error) => void): void;
};

/** At most one frame handed to ws and one pending latest frame. */
export class FrameForwarder {
  private pending?: Buffer;
  private busy = false;
  private closed = false;
  sent = 0;
  dropped = 0;
  sendMs = 0;

  private readonly socket: FrameSocket;
  private readonly onSent: () => void;
  constructor(socket: FrameSocket, onSent: () => void) { this.socket = socket; this.onSent = onSent; }

  offer(frame: Buffer): void {
    if (this.closed) return;
    if (this.pending) this.dropped++;
    this.pending = frame;
    this.flush();
  }

  close(): void { this.closed = true; this.pending = undefined; }

  private flush(): void {
    if (this.closed || this.busy || !this.pending) return;
    // Do not add video behind already-buffered control traffic. A future frame retries.
    if (this.socket.bufferedAmount > 0) return;
    const frame = this.pending;
    this.pending = undefined;
    this.busy = true;
    const start = performance.now();
    try {
      this.socket.send(frame, { binary: true }, error => {
        this.busy = false;
        this.sendMs = performance.now() - start;
        if (error) { this.close(); return; }
        if (this.closed) return;
        this.sent++;
        this.onSent();
        this.flush();
      });
    } catch { this.busy = false; this.close(); }
  }
}
