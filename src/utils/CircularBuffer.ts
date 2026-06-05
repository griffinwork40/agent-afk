/**
 * Fixed-capacity ring buffer that overwrites the oldest entries once full.
 */
export class CircularBuffer<T> {
  private buffer: T[];
  private head = 0;
  private size = 0;

  constructor(private capacity: number) {
    this.buffer = new Array<T>(capacity);
  }

  /** Write `item` at head, advance head mod capacity, clamp size to capacity. */
  add(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** Add every element of `items` in order. */
  addAll(items: T[]): void {
    for (const item of items) this.add(item);
  }

  /**
   * Return the most recent `min(count, size)` items, oldest-first.
   */
  getRecent(count: number): T[] {
    const n = Math.min(count, this.size);
    const result: T[] = new Array<T>(n);
    // Start index of the oldest item we want:
    //   head points one past the newest, so newest is at (head - 1),
    //   and the oldest of the last n items is at (head - n).
    const start = (this.head - n + this.capacity) % this.capacity;
    for (let i = 0; i < n; i++) {
      result[i] = this.buffer[(start + i) % this.capacity]!;
    }
    return result;
  }

  /** All items oldest to newest. */
  toArray(): T[] {
    return this.getRecent(this.size);
  }

  /** Reset buffer, head, and size. */
  clear(): void {
    this.buffer = new Array<T>(this.capacity);
    this.head = 0;
    this.size = 0;
  }

  /** Current number of stored items. */
  length(): number {
    return this.size;
  }
}
