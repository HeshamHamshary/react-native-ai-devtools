/** Fixed-capacity FIFO buffer. Oldest entries are dropped; memory use is bounded. */
export class RingBuffer<T> {
  private items: T[] = [];
  private dropped = 0;

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped++;
    }
  }

  /** Most recent item, if any. */
  last(): T | undefined {
    return this.items[this.items.length - 1];
  }

  /** Items oldest -> newest, optionally filtered, keeping only the last `limit`. */
  toArray(filter?: (item: T) => boolean, limit?: number): T[] {
    const out = filter ? this.items.filter(filter) : this.items.slice();
    return limit !== undefined && out.length > limit ? out.slice(out.length - limit) : out;
  }

  get size(): number {
    return this.items.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  clear(): void {
    this.items = [];
  }
}
