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
}

interface Logger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

export interface BrowserPoolOptions extends Partial<PoolDefaults> {
  logger?: Logger;
}

export class BrowserPool {
  launchFn: () => Promise<BrowserLike>;
  minSize: number;
  maxSize: number;
  acquireTimeout: number;
  maxUsesPerBrowser: number;
  healthCheckInterval: number;
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

    // Find available browser
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

    // Wait for an available browser
    return new Promise<BrowserHandle>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.waitQueue.findIndex((w) => w.resolve === wrappedResolve);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        reject(new BrowserPoolError(`Acquire timeout after ${this.acquireTimeout}ms - all browsers busy`));
      }, this.acquireTimeout);

      const wrappedResolve = (item: BrowserHandle) => {
        clearTimeout(timeout);
        resolve(item);
      };

      this.waitQueue.push({ resolve: wrappedResolve });
    });
  }

  release(item: PoolItem): void {
    if (!item) return;
    item.inUse = false;

    // Recycle if too many uses
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

    // Replace in background
    this.launchFn()
      .then((browser) => {
        this.pool.push({ browser, inUse: false, created: Date.now(), useCount: 0 });
        this._drainWaitQueue();
      })
      .catch((err: Error) => {
        if (this.logger.warn) {
          this.logger.warn('[BrowserPool] Recycle launch failed:', err.message);
        }
      });
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
    // Remove disconnected browsers
    this.pool = this.pool.filter((item) => item.browser.isConnected());

    // Ensure minimum pool size
    const available = this.pool.filter((p) => !p.inUse).length;
    if (available < this.minSize) {
      try {
        const browser = await this.launchFn();
        this.pool.push({ browser, inUse: false, created: Date.now(), useCount: 0 });
        this._drainWaitQueue();
      } catch (error) {
        if (this.logger.warn) {
          this.logger.warn('[BrowserPool] Health check launch failed:', (error as Error).message);
        }
      }
    }
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

    this.waitQueue = [];

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
