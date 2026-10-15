import { ApiError, type Operation } from './client.ts';

export type Scheduler = {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};
const scheduler: Scheduler = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// One request per poller, no overlapping interval and no stale callbacks after hide/unload.
export class SerialPoller<T> {
  private active?: Operation<T>;
  private timer?: unknown;
  private generation = 0;
  private visible = false;
  private disposed = false;
  private halted = false;
  private failures = 0;

  constructor(private options: {
    load(): Operation<T>;
    onValue(value: T): void;
    onError(error: unknown, willRetry: boolean): void;
    isDone(value: T): boolean;
    intervalMs?: number;
    scheduler?: Scheduler;
  }) {}

  resume() {
    if (this.disposed || this.visible) return;
    this.visible = true;
    if (!this.halted) void this.tick();
  }
  pause() {
    this.visible = false;
    this.generation += 1;
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
    this.active?.abort();
    this.active = undefined;
  }
  retry() {
    if (this.disposed) return;
    const visible = this.visible;
    this.pause();
    this.halted = false;
    this.failures = 0;
    if (visible) this.resume();
  }
  dispose() { this.pause(); this.disposed = true; }
  private get clock() { return this.options.scheduler ?? scheduler; }

  private async tick() {
    if (!this.visible || this.disposed || this.halted || this.active) return;
    const generation = this.generation;
    let delay = this.options.intervalMs ?? 2000;
    try {
      this.active = this.options.load();
      const value = await this.active.promise;
      if (generation !== this.generation || !this.visible) return;
      this.failures = 0;
      this.halted = this.options.isDone(value);
      this.options.onValue(value);
    } catch (error) {
      if (generation !== this.generation || !this.visible) return;
      this.failures += 1;
      const retryable = error instanceof ApiError && (error.code === 'network'
        || error.code === 'timeout' || (error.status !== undefined
          && (error.status >= 500 || error.status === 429)));
      const willRetry = retryable && this.failures <= 3;
      this.halted = !willRetry;
      delay *= 2 ** this.failures;
      this.options.onError(error, willRetry);
    } finally {
      if (generation === this.generation) {
        this.active = undefined;
        if (this.visible && !this.halted && !this.disposed) {
          this.timer = this.clock.set(() => { this.timer = undefined; void this.tick(); }, delay);
        }
      }
    }
  }
}
