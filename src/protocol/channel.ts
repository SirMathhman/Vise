// An async queue: values are pushed in order and taken in order. A taker that finds the queue empty
// waits, and each waiting taker gets its own value. Once ended, takers receive undefined after the
// values already queued have been taken.
export class Channel<T> {
  private queue: T[] = [];
  private ended = false;
  private waiters: ((value: T | undefined) => void)[] = [];

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.queue.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }

  // Drops the values queued so far, so a taker only sees values pushed after this call.
  discard(): void {
    this.queue = [];
  }

  // True while a value is queued, or while more values can still be pushed.
  get more(): boolean {
    return this.queue.length > 0 || !this.ended;
  }

  // Resolves with the next value, or undefined once the channel has ended and nothing is queued.
  next(): Promise<T | undefined> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (let value = await this.next(); value !== undefined; value = await this.next()) {
      yield value;
    }
  }
}
