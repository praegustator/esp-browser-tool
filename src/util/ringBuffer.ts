/** Fixed-capacity circular buffer of samples, used to back the scope view. */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private size_ = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive integer');
    }
    this.items = new Array<T | undefined>(capacity);
  }

  get length(): number {
    return this.size_;
  }

  push(item: T): void {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size_ < this.capacity) this.size_ += 1;
  }

  /** Oldest-first iteration. */
  *[Symbol.iterator](): IterableIterator<T> {
    const start = (this.head - this.size_ + this.capacity) % this.capacity;
    for (let index = 0; index < this.size_; index++) {
      yield this.items[(start + index) % this.capacity] as T;
    }
  }

  toArray(): T[] {
    return [...this];
  }

  /** Item at `index` counting from the oldest entry. */
  at(index: number): T | undefined {
    if (index < 0 || index >= this.size_) return undefined;
    const start = (this.head - this.size_ + this.capacity) % this.capacity;
    return this.items[(start + index) % this.capacity];
  }

  last(): T | undefined {
    return this.at(this.size_ - 1);
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.size_ = 0;
  }
}
