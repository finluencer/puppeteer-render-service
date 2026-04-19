import { BrowserPoolError } from './errors';
import DEFAULTS from './defaults';
import type { PoolDefaults } from './defaults';

interface BrowserLike {
  isConnected(): boolean;
  close(): Promise<void>;
}

interface PoolItem {
  browser: BrowserLike;
  inUse: boolean;
  created: number;
  useCount: number;
}

export interface BrowserHandle {
  browser: BrowserLike;
  release(): void;
}

interface WaitQueueItem {
  resolve(handle: BrowserHandle): void;
  reject(error: Error): void;
}

interface Logger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

export interface BrowserPoolOptions extends Partial<PoolDefaults> {
  logger?: Logger;
  maxWaitQueue?: number;
}

export class BrowserPool {
  launchFn: () => Promise<BrowserLike>;
  minSize: number;
  maxSize: number;
  acquireTimeout: number;
  maxUsesPerBrowser: number;
  healthCheckInterval: number;
  maxWaitQueue: number;
  pool: PoolItem[];
  waitQueue: WaitQueueItem[];
  isInitialized: boolean;
  isShuttingDown: boolean;
  healthCheckTimer: ReturnType<typeof setInterval> | null;
  logger: Logger;

  constructor(launchFn: () => Promise<BrowserLike>, options: BrowserPoolOptions = {}) {
    const config = { ...DEFAULTS.pool, ...options };
    this.launchFn = launchFn;
    this.minSize = config.min;
    this.maxSize = config.max;
    this.acquireTimeout = config.acquireTimeout;
    this.maxUsesPerBrowser = config.maxUsesPerBrowser;
    this.healthCheckInterval = config.healthCheckInterval;
    this.maxWaitQueue = options.maxWaitQueue ?? 100;

    this.pool = [];
    this.waitQueue = [];
    this.isInitialized = false;
    this.isShuttingDown = false;
    this.healthCheckTimer = null;
    this.logger = options.logger || console;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    for (let i = 0; i < this.minSize; i++) {
      try {
        const browser = await this.launchFn();
        this.pool.push({
          browser,
          inUse: false,
          created: Date.now(),
          useCount: 0,
        });
      } catch (error) {
        if (this.logger.warn) {
          this.logger.warn(`[BrowserPool] Failed to pre-warm browser ${i + 1}:`, (error as Error).message);
        }
      }
    }

    this.healthCheckTimer = setInterval(() => this.healthCheck(), this.healthCheckInterval);
    this.isInitialized = true;
  }

  async acquire(): Promise<BrowserHandle> {
    if (this.isShuttingDown) {
      throw new BrowserPoolError('Pool is shutting down');
    }

    if (!this.isInitialized) {
      await this.initialize();
    }

    // Find available connected browser
    for (const item of this.pool) {
      if (!item.inUse && item.browser.isConnected()) {
        item.inUse = true;
        item.useCount++;
        return this._wrapPoolItem(item);
      }
    }

    // Create new browser if pool isn't full
    if (this.pool.length < this.maxSize) {
      try {
        const browser = await this.launchFn();
        const item: PoolItem = { browser, inUse: true, created: Date.now(), useCount: 1 };
        this.pool.push(item);
        return this._wrapPoolItem(item);
      } catch (error) {
        throw new BrowserPoolError(`Failed to launch browser: ${(error as Error).message}`);
      }
    }

    // Reject immediately if wait queue is full
    if (this.waitQueue.length >= this.maxWaitQueue) {
      throw new BrowserPoolError(
        `Wait queue is full (${this.maxWaitQueue} pending requests) — all browsers busy`
      );
    }

    // Wait for an available browser
    return new Promise<BrowserHandle>((resolve, reject) => {
      let settled = false;

      const wrappedResolve = (handle: BrowserHandle) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(handle);
      };

      const wrappedReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      // Declare timeout after wrapped handlers so the reference is captured correctly
      const timeout = setTimeout(() => {
        const idx = this.waitQueue.findIndex((w) => w.resolve === wrappedResolve);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        wrappedReject(new BrowserPoolError(`Acquire timeout after ${this.acquireTimeout}ms — all browsers busy`));
      }, this.acquireTimeout);

      this.waitQueue.push({ resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  release(item: PoolItem): void {
    if (!item) return;
    item.inUse = false;

    // Recycle if browser crashed while in-use
    if (!item.browser.isConnected()) {
      this._recycleBrowser(item);
      return;
    }

    // Recycle if reached max use count
    if (item.useCount >= this.maxUsesPerBrowser) {
      this._recycleBrowser(item);
      return;
    }

    // Serve waiting consumers
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      item.inUse = true;
      item.useCount++;
      waiter.resolve(this._wrapPoolItem(item));
    }
  }

  _wrapPoolItem(item: PoolItem): BrowserHandle {
    return {
      browser: item.browser,
      release: () => this.release(item),
    };
  }

  async _recycleBrowser(item: PoolItem): Promise<void> {
    const idx = this.pool.indexOf(item);
    if (idx !== -1) this.pool.splice(idx, 1);

    try {
      if (item.browser.isConnected()) await item.browser.close();
    } catch {
      // ignore close errors
    }

    if (this.isShuttingDown) return;

    // Replace with exponential backoff retry (1s → 2s → 4s)
    const launch = async (attemptsLeft: number): Promise<void> => {
      if (this.isShuttingDown) return;
      try {
        const browser = await this.launchFn();
        this.pool.push({ browser, inUse: false, created: Date.now(), useCount: 0 });
        this._drainWaitQueue();
      } catch (err) {
        if (this.logger.warn) {
          this.logger.warn('[BrowserPool] Recycle launch failed:', (err as Error).message);
        }
        if (attemptsLeft > 0) {
          const delay = 1000 * Math.pow(2, 3 - attemptsLeft);
          setTimeout(() => launch(attemptsLeft - 1), delay);
        } else if (this.logger.error) {
          this.logger.error('[BrowserPool] Recycle failed after all retries — pool may be undersized');
        }
      }
    };

    launch(3);
  }

  _drainWaitQueue(): void {
    while (this.waitQueue.length > 0) {
      const availableItem = this.pool.find((p) => !p.inUse && p.browser.isConnected());
      if (!availableItem) break;

      const waiter = this.waitQueue.shift()!;
      availableItem.inUse = true;
      availableItem.useCount++;
      waiter.resolve(this._wrapPoolItem(availableItem));
    }
  }

  async healthCheck(): Promise<void> {
    // Remove idle disconnected browsers
    const idleDisconnected = this.pool.filter((item) => !item.inUse && !item.browser.isConnected());
    for (const item of idleDisconnected) {
      const idx = this.pool.indexOf(item);
      if (idx !== -1) this.pool.splice(idx, 1);
      try { await item.browser.close(); } catch { /* ignore */ }
    }

    // Ensure minimum pool size
    const needed = this.minSize - this.pool.length;
    for (let i = 0; i < needed; i++) {
      try {
        const browser = await this.launchFn();
        this.pool.push({ browser, inUse: false, created: Date.now(), useCount: 0 });
      } catch (error) {
        if (this.logger.warn) {
          this.logger.warn('[BrowserPool] Health check launch failed:', (error as Error).message);
        }
        break;
      }
    }

    if (needed > 0) this._drainWaitQueue();
  }

  getStats() {
    return {
      total: this.pool.length,
      active: this.pool.filter((p) => p.inUse).length,
      idle: this.pool.filter((p) => !p.inUse).length,
      waiting: this.waitQueue.length,
    };
  }

  async destroy(): Promise<void> {
    this.isShuttingDown = true;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Reject all pending waiters so their promises don't hang forever
    const pending = this.waitQueue.splice(0);
    for (const waiter of pending) {
      waiter.reject(new BrowserPoolError('Pool is being destroyed'));
    }

    const closePromises = this.pool.map(async (item) => {
      try {
        if (item.browser.isConnected()) await item.browser.close();
      } catch {
        // ignore
      }
    });

    await Promise.all(closePromises);
    this.pool = [];
    this.isInitialized = false;
  }
}
