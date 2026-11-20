/** A scheduler owned by one native storage fixture, independent of Bun's global clock. */
export class StorageClock {
  private timestamp = Date.parse("2026-09-10T00:00:00.000Z");
  private readonly heartbeats = new Map<
    number,
    { callback: () => void; interval: number; next: number }
  >();
  private nextId = 0;

  readonly date = () => new Date(this.timestamp);

  readonly scheduleHeartbeat = (callback: () => void, interval: number) => {
    const id = ++this.nextId;
    this.heartbeats.set(id, {
      callback,
      interval,
      next: this.timestamp + interval,
    });
    return () => {
      this.heartbeats.delete(id);
    };
  };

  now() {
    return this.timestamp;
  }

  pending() {
    return this.heartbeats.size;
  }

  advanceBy(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new Error(
        "Storage clock advancement must be finite and nonnegative",
      );
    const end = this.timestamp + milliseconds;
    while (true) {
      const next = [...this.heartbeats.values()]
        .filter((timer) => timer.next <= end)
        .sort((a, b) => a.next - b.next)[0];
      if (!next) break;
      this.timestamp = next.next;
      next.next += next.interval;
      next.callback();
    }
    this.timestamp = end;
  }

  assertDrained() {
    if (this.pending() !== 0)
      throw new Error(
        `Storage clock leaked ${this.pending()} heartbeat timers`,
      );
  }
}
