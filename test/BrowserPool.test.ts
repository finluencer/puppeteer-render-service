import { BrowserPool } from '../src/BrowserPool';
import { BrowserPoolError } from '../src/errors';

function createMockBrowser(connected = true) {
  return {
    isConnected: jest.fn(() => connected),
    close: jest.fn(() => Promise.resolve()),
    newPage: jest.fn(() =>
      Promise.resolve({
        close: jest.fn(),
        isClosed: jest.fn(() => false),
      })
    ),
  };
}

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

describe('BrowserPool', () => {
  let pool: BrowserPool;
  let mockLaunch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLaunch = jest.fn(() => Promise.resolve(createMockBrowser()));
    pool = new BrowserPool(mockLaunch, {
      min: 1,
      max: 3,
      acquireTimeout: 2000,
      maxUsesPerBrowser: 100,
      healthCheckInterval: 600000,
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    await pool.destroy();
  });

  describe('initialize', () => {
    it('should pre-warm minimum browsers', async () => {
      await pool.initialize();
      expect(mockLaunch).toHaveBeenCalledTimes(1);
      expect(pool.pool.length).toBe(1);
      expect(pool.isInitialized).toBe(true);
    });

    it('should not initialize twice', async () => {
      await pool.initialize();
      await pool.initialize();
      expect(mockLaunch).toHaveBeenCalledTimes(1);
    });

    it('should handle launch failures during warmup gracefully', async () => {
      const failLaunch = jest.fn(() => Promise.reject(new Error('launch failed')));
      const failPool = new BrowserPool(failLaunch, { min: 2, logger: silentLogger });

      await failPool.initialize();
      expect(failPool.pool.length).toBe(0);
      expect(failPool.isInitialized).toBe(true);
      await failPool.destroy();
    });
  });

  describe('acquire', () => {
    it('should return a browser handle with release function', async () => {
      const handle = await pool.acquire();
      expect(handle.browser).toBeDefined();
      expect(handle.browser.isConnected()).toBe(true);
      expect(typeof handle.release).toBe('function');
    });

    it('should auto-initialize if not already done', async () => {
      expect(pool.isInitialized).toBe(false);
      await pool.acquire();
      expect(pool.isInitialized).toBe(true);
    });

    it('should reuse idle browsers', async () => {
      const handle1 = await pool.acquire();
      handle1.release();

      const handle2 = await pool.acquire();
      expect(handle2.browser).toBe(handle1.browser);
      expect(mockLaunch).toHaveBeenCalledTimes(1);
    });

    it('should create new browser when all are busy', async () => {
      const handle1 = await pool.acquire();
      const handle2 = await pool.acquire();

      expect(mockLaunch).toHaveBeenCalledTimes(2);
      expect(pool.pool.length).toBe(2);

      handle1.release();
      handle2.release();
    });

    it('should throw BrowserPoolError on timeout when pool is full', async () => {
      const smallPool = new BrowserPool(mockLaunch, {
        min: 1, max: 1, acquireTimeout: 100,
        healthCheckInterval: 600000, logger: silentLogger,
      });

      const handle = await smallPool.acquire();
      await expect(smallPool.acquire()).rejects.toThrow(BrowserPoolError);
      handle.release();
      await smallPool.destroy();
    });

    it('should throw when pool is shutting down', async () => {
      await pool.initialize();
      await pool.destroy();
      await expect(pool.acquire()).rejects.toThrow('Pool is shutting down');
    });

    it('should serve waiting consumer when browser is released', async () => {
      const smallPool = new BrowserPool(mockLaunch, {
        min: 1, max: 1, acquireTimeout: 5000,
        healthCheckInterval: 600000, logger: silentLogger,
      });

      const handle1 = await smallPool.acquire();
      const acquirePromise = smallPool.acquire();

      setTimeout(() => handle1.release(), 50);

      const handle2 = await acquirePromise;
      expect(handle2.browser).toBeDefined();

      handle2.release();
      await smallPool.destroy();
    });
  });

  describe('waitQueue protection', () => {
    it('should reject immediately when waitQueue is full', async () => {
      const tinyPool = new BrowserPool(mockLaunch, {
        min: 1, max: 1, acquireTimeout: 10000,
        maxWaitQueue: 2, healthCheckInterval: 600000, logger: silentLogger,
      });

      const handle = await tinyPool.acquire();

      // Fill the wait queue to capacity
      const p1 = tinyPool.acquire();
      const p2 = tinyPool.acquire();

      // Third waiter exceeds maxWaitQueue=2 — must reject immediately
      await expect(tinyPool.acquire()).rejects.toThrow('Wait queue is full');

      handle.release();
      await Promise.allSettled([p1, p2]);
      await tinyPool.destroy();
    });

    it('should not double-resolve a waiting promise when release races with timeout', async () => {
      const smallPool = new BrowserPool(mockLaunch, {
        min: 1, max: 1,
        acquireTimeout: 80, // very short so timeout fires after resolve
        healthCheckInterval: 600000, logger: silentLogger,
      });

      const handle1 = await smallPool.acquire();
      let resolveCount = 0;

      const waitPromise = smallPool.acquire().then((h) => {
        resolveCount++;
        h.release();
      });

      // Release immediately — _drainWaitQueue fires before the 80ms timeout
      handle1.release();
      await waitPromise;

      // Wait past the timeout to ensure it doesn't fire a second resolve
      await new Promise((r) => setTimeout(r, 120));

      expect(resolveCount).toBe(1);
      await smallPool.destroy();
    });
  });

  describe('release', () => {
    it('should mark browser as not in use', async () => {
      const handle = await pool.acquire();
      const poolItem = pool.pool[0];
      expect(poolItem.inUse).toBe(true);

      handle.release();
      expect(poolItem.inUse).toBe(false);
    });

    it('should recycle browser if disconnected at release time', async () => {
      const localPool = new BrowserPool(mockLaunch, {
        min: 1, max: 2, acquireTimeout: 2000,
        healthCheckInterval: 600000, logger: silentLogger,
      });

      const handle = await localPool.acquire();
      const crashedItem = localPool.pool[0];

      // Simulate browser crash while in-use
      (crashedItem.browser.isConnected as jest.Mock).mockReturnValue(false);

      handle.release();

      // Crashed browser should be removed from pool
      expect(localPool.pool).not.toContain(crashedItem);
      await localPool.destroy();
    });

    it('should recycle browser after maxUsesPerBrowser reached', async () => {
      const pool2 = new BrowserPool(mockLaunch, {
        min: 1, max: 2, acquireTimeout: 2000,
        maxUsesPerBrowser: 2, healthCheckInterval: 600000, logger: silentLogger,
      });

      const h1 = await pool2.acquire(); h1.release();
      const h2 = await pool2.acquire(); h2.release(); // useCount hits 2, triggers recycle

      // Give recycle background launch a tick to complete
      await new Promise((r) => setTimeout(r, 10));

      expect(mockLaunch.mock.calls.length).toBeGreaterThanOrEqual(2);
      await pool2.destroy();
    });
  });

  describe('destroy', () => {
    it('should close all browsers and reset state', async () => {
      await pool.initialize();
      await pool.acquire();

      await pool.destroy();
      expect(pool.pool.length).toBe(0);
      expect(pool.isInitialized).toBe(false);
      expect(pool.isShuttingDown).toBe(true);
    });

    it('should clear health check timer', async () => {
      await pool.initialize();
      expect(pool.healthCheckTimer).not.toBeNull();

      await pool.destroy();
      expect(pool.healthCheckTimer).toBeNull();
    });

    it('should reject all pending waiters with BrowserPoolError', async () => {
      const slowPool = new BrowserPool(mockLaunch, {
        min: 1, max: 1, acquireTimeout: 30000,
        healthCheckInterval: 600000, logger: silentLogger,
      });

      const handle = await slowPool.acquire();

      const p1 = slowPool.acquire();
      const p2 = slowPool.acquire();

      // Destroy while p1 and p2 are in the wait queue
      await slowPool.destroy();

      await expect(p1).rejects.toThrow(BrowserPoolError);
      await expect(p2).rejects.toThrow(BrowserPoolError);

      handle.release(); // safe to call after destroy
    });
  });

  describe('getStats', () => {
    it('should return pool statistics', async () => {
      await pool.initialize();
      const handle = await pool.acquire();

      const stats = pool.getStats();
      expect(stats).toEqual({ total: 1, active: 1, idle: 0, waiting: 0 });

      handle.release();

      const stats2 = pool.getStats();
      expect(stats2.active).toBe(0);
      expect(stats2.idle).toBe(1);
    });

    it('should reflect waiting consumers', async () => {
      const smallPool = new BrowserPool(mockLaunch, {
        min: 1, max: 1, acquireTimeout: 5000,
        healthCheckInterval: 600000, logger: silentLogger,
      });

      const handle = await smallPool.acquire();
      const pending = smallPool.acquire(); // goes to waitQueue

      // Give microtask queue a tick
      await new Promise((r) => setTimeout(r, 0));
      expect(smallPool.getStats().waiting).toBe(1);

      handle.release();
      await pending;
      await smallPool.destroy();
    });
  });

  describe('healthCheck', () => {
    it('should remove idle disconnected browsers and replenish', async () => {
      await pool.initialize();

      // Make the idle browser appear disconnected
      pool.pool[0].browser.isConnected = jest.fn(() => false);
      await pool.healthCheck();

      // Old browser removed, new one launched to maintain minSize
      expect(mockLaunch).toHaveBeenCalledTimes(2);
    });

    it('should not remove browsers that are still connected', async () => {
      await pool.initialize();
      const initialBrowser = pool.pool[0].browser;

      await pool.healthCheck();

      expect(pool.pool[0].browser).toBe(initialBrowser);
    });
  });
});
