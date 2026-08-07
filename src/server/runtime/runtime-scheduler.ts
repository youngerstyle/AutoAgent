type RuntimeWork = () => Promise<void>;

interface RuntimeWorkEntry {
  work: RuntimeWork;
  accepting: boolean;
  queued: boolean;
  requested: boolean;
  running: boolean;
  idleWaiters: Array<() => void>;
}

/**
 * One service-wide queue for RuntimeHost ticks. A workspace is a scheduling
 * key, so duplicate wakeups coalesce while a previous tick is running.
 */
export class RuntimeHostScheduler {
  private readonly entries = new Map<string, RuntimeWorkEntry>();
  private readonly queue: string[] = [];
  private active = 0;
  private timer?: NodeJS.Timeout;
  private pumping = false;

  constructor(
    private readonly maxConcurrent = 2,
    private readonly intervalMs = 1_000,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new Error("Runtime host scheduler concurrency must be a positive integer");
    }
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("Runtime host scheduler interval must be a positive integer");
    }
  }

  register(key: string, work: RuntimeWork): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.work = work;
      existing.accepting = true;
      this.ensureTimer();
      return;
    }
    this.entries.set(key, {
      work,
      accepting: true,
      queued: false,
      requested: false,
      running: false,
      idleWaiters: [],
    });
    this.ensureTimer();
  }

  request(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || !entry.accepting) return;
    entry.requested = true;
    this.enqueueIfIdle(key, entry);
    this.pump();
  }

  async unregister(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.accepting = false;
    entry.requested = false;
    entry.queued = false;
    this.removeQueuedKey(key);
    if (entry.running) {
      await new Promise<void>((resolve) => entry.idleWaiters.push(resolve));
    } else {
      this.entries.delete(key);
      this.stopTimerWhenIdle();
    }
  }

  async stop(): Promise<void> {
    const keys = [...this.entries.keys()];
    await Promise.all(keys.map((key) => this.unregister(key)));
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [key, entry] of this.entries) {
        if (entry.accepting) this.request(key);
      }
    }, this.intervalMs);
    this.timer.unref();
  }

  private stopTimerWhenIdle(): void {
    if (this.entries.size > 0 || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private enqueueIfIdle(key: string, entry: RuntimeWorkEntry): void {
    if (entry.running || entry.queued) return;
    entry.queued = true;
    this.queue.push(key);
  }

  private removeQueuedKey(key: string): void {
    let index = this.queue.indexOf(key);
    while (index >= 0) {
      this.queue.splice(index, 1);
      index = this.queue.indexOf(key);
    }
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active < this.maxConcurrent && this.queue.length > 0) {
        const key = this.queue.shift();
        if (!key) continue;
        const entry = this.entries.get(key);
        if (!entry || !entry.accepting) continue;
        entry.queued = false;
        entry.running = true;
        entry.requested = false;
        this.active += 1;
        void entry.work()
          .catch((error) => {
            console.error(`RuntimeHost scheduled work failed for ${key}`, error);
          })
          .finally(() => {
            entry.running = false;
            this.active -= 1;
            for (const resolve of entry.idleWaiters.splice(0)) resolve();
            if (!entry.accepting) {
              this.entries.delete(key);
            } else if (entry.requested) {
              this.enqueueIfIdle(key, entry);
            }
            this.stopTimerWhenIdle();
            this.pump();
          });
      }
    } finally {
      this.pumping = false;
    }
  }
}

/** Shared capacity for model/tool turns across all workspaces in one service. */
export class RuntimeExecutionGate {
  private readonly queue: Array<{
    work: RuntimeWork;
  }> = [];
  private active = 0;

  constructor(private readonly maxConcurrent = 2) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new Error("Runtime execution concurrency must be a positive integer");
    }
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        work: async () => {
          try {
            resolve(await work());
          } catch (error) {
            reject(error);
          }
        },
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) return;
      this.active += 1;
      void item.work()
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }
}
