import { BrowserPool } from '../src/BrowserPool';
import { BrowserPoolError } from '../src/errors';

// Mock browser object
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
    mockLaunch = jest.fn(() => Promise.resolve(createMockBrowser()));
    pool = new BrowserPool(mockLaunch, {
      min: 1,
      max: 3,
      acquireTimeout: 2000,
      maxUsesPerBrowser: 100,
      healthCheckInterval: 600000, // Long interval so it won't fire during tests
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

    it('should handle launch failures during warmup', async () => {
      const failLaunch = jest.fn(() => Promise.reject(new Error('launch failed')));
      const failPool = new BrowserPool(failLaunch, { min: 2, logger: silentLogger });

      await failPool.initialize();
      expect(failPool.pool.length).toBe(0);
      expect(failPool.isInitialized).toBe(true);
      await failPool.destroy();
    });
  });

  describe('acquire', () => {
    it('should return a browser with release function', async () => {
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
      expect(mockLaunch).toHaveBeenCalledTimes(1); // Only 1 launch, reused
    });

    it('should create new browser when all are busy', async () => {
      const handle1 = await pool.acquire();
      const handle2 = await pool.acquire();

      expect(mockLaunch).toHaveBeenCalledTimes(2);
      expect(pool.pool.length).toBe(2);

      handle1.release();
      handle2.release();
    });

    it('should throw on timeout when all browsers busy and pool full', async () => {
      const smallPool = new BrowserPool(mockLaunch, {
        min: 1,
        max: 1,
        acquireTimeout: 500,
        healthCheckInterval: 600000,
        logger: silentLogger,
      });

      const handle1 = await smallPool.acquire();

      await expect(smallPool.acquire()).rejects.toThrow(BrowserPoolError);
      handle1.release();
      await smallPool.destroy();
    });

    it('should throw when pool is shutting down', async () => {
      await pool.initialize();
      await pool.destroy();

      await expect(pool.acquire()).rejects.toThrow('Pool is shutting down');
    });

    it('should serve waiting consumer when browser is released', async () => {
      const smallPool = new BrowserPool(mockLaunch, {
        min: 1,
        max: 1,
        acquireTimeout: 5000,
        healthCheckInterval: 600000,
        logger: silentLogger,
      });

      const handle1 = await smallPool.acquire();

      const acquirePromise = smallPool.acquire();

      // Release after small delay
      setTimeout(() => handle1.release(), 100);

      const handle2 = await acquirePromise;
      expect(handle2.browser).toBeDefined();

      handle2.release();
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
  });

  describe('getStats', () => {
    it('should return pool statistics', async () => {
      await pool.initialize();
      const handle = await pool.acquire();

      const stats = pool.getStats();
      expect(stats).toEqual({
        total: 1,
        active: 1,
        idle: 0,
        waiting: 0,
      });

      handle.release();

      const stats2 = pool.getStats();
      expect(stats2.active).toBe(0);
      expect(stats2.idle).toBe(1);
    });
  });

  describe('healthCheck', () => {
    it('should remove disconnected browsers', async () => {
      await pool.initialize();

      // Make browser appear disconnected
      pool.pool[0].browser.isConnected = jest.fn(() => false);
      await pool.healthCheck();

      // Old one removed, new one added
      expect(mockLaunch).toHaveBeenCalledTimes(2);
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
  });
});
