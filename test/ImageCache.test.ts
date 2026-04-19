import { ImageCache } from '../src/ImageCache';

describe('ImageCache', () => {
  let cache: ImageCache;

  beforeEach(() => {
    cache = new ImageCache({ ttl: 5000, maxEntries: 10, maxSizeBytes: 1024 * 1024 });
  });

  afterEach(() => {
    cache.stopCleanup();
  });

  describe('constructor', () => {
    it('should initialize with defaults', () => {
      const defaultCache = new ImageCache();
      expect(defaultCache.enabled).toBe(true);
      expect(defaultCache.hits).toBe(0);
      expect(defaultCache.misses).toBe(0);
      defaultCache.stopCleanup();
    });

    it('should accept custom options', () => {
      expect(cache.ttl).toBe(5000);
      expect(cache.maxEntries).toBe(10);
    });

    it('should start a cleanup timer when enabled', () => {
      const c = new ImageCache({ ttl: 60000 });
      // Access private field via type cast
      expect((c as unknown as Record<string, unknown>)['cleanupTimer']).not.toBeNull();
      c.stopCleanup();
    });

    it('should NOT start a cleanup timer when disabled', () => {
      const disabled = new ImageCache({ enabled: false });
      expect((disabled as unknown as Record<string, unknown>)['cleanupTimer']).toBeNull();
      disabled.stopCleanup();
    });
  });

  describe('generateKey', () => {
    it('should generate consistent keys for the same URL', () => {
      const key1 = ImageCache.generateKey('https://example.com/image.png', 'ns');
      const key2 = ImageCache.generateKey('https://example.com/image.png', 'ns');
      expect(key1).toBe(key2);
    });

    it('should strip query parameters', () => {
      const key1 = ImageCache.generateKey('https://example.com/img.png?v=1', 'ns');
      const key2 = ImageCache.generateKey('https://example.com/img.png?v=2', 'ns');
      expect(key1).toBe(key2);
    });

    it('should generate different keys for different namespaces', () => {
      const key1 = ImageCache.generateKey('https://example.com/img.png', 'ns1');
      const key2 = ImageCache.generateKey('https://example.com/img.png', 'ns2');
      expect(key1).not.toBe(key2);
    });

    it('should use default namespace', () => {
      const key = ImageCache.generateKey('https://example.com/img.png');
      expect(key).toMatch(/^default:/);
    });
  });

  describe('get/set', () => {
    it('should store and retrieve values', () => {
      cache.set('key1', 'data-value');
      expect(cache.get('key1')).toBe('data-value');
    });

    it('should return null for missing keys', () => {
      expect(cache.get('nonexistent')).toBeNull();
      expect(cache.misses).toBe(1);
    });

    it('should track hits and misses', () => {
      cache.set('key1', 'value');
      cache.get('key1');
      cache.get('key1');
      cache.get('missing');

      expect(cache.hits).toBe(2);
      expect(cache.misses).toBe(1);
    });

    it('should return null for expired entries', async () => {
      const shortCache = new ImageCache({ ttl: 80 });
      shortCache.set('key1', 'value');

      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(shortCache.get('key1')).toBeNull();
      expect(shortCache.misses).toBe(1);
      shortCache.stopCleanup();
    });

    it('should update lastAccessed on hit', () => {
      cache.set('key1', 'value');
      const before = cache.store.get('key1')!.lastAccessed;
      cache.get('key1');
      const after = cache.store.get('key1')!.lastAccessed;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('should not store when disabled', () => {
      const disabled = new ImageCache({ enabled: false });
      disabled.set('key1', 'value');
      expect(disabled.get('key1')).toBeNull();
      disabled.stopCleanup();
    });
  });

  describe('evictIfNeeded', () => {
    it('should evict LRU entries when maxEntries exceeded', () => {
      const smallCache = new ImageCache({ maxEntries: 3, evictionPercent: 0.5 });

      smallCache.set('a', 'data-a');
      smallCache.set('b', 'data-b');
      smallCache.set('c', 'data-c');
      smallCache.set('d', 'data-d'); // triggers eviction

      expect(smallCache.store.size).toBeLessThanOrEqual(3);
      smallCache.stopCleanup();
    });

    it('should evict least recently accessed entries first', () => {
      const smallCache = new ImageCache({ maxEntries: 3, evictionPercent: 0.34 });

      smallCache.set('old', 'val-old');
      // Access 'new' entries to make them more recently used
      smallCache.set('recent1', 'val-1');
      smallCache.set('recent2', 'val-2');
      // Touch recent entries so 'old' is LRU
      smallCache.get('recent1');
      smallCache.get('recent2');

      smallCache.set('newer', 'val-newer'); // triggers eviction
      // 'old' should be evicted (LRU)
      expect(smallCache.store.has('old')).toBe(false);
      smallCache.stopCleanup();
    });

    it('should not evict when within limits', () => {
      cache.set('a', 'data-a');
      cache.set('b', 'data-b');
      expect(cache.store.size).toBe(2);
    });
  });

  describe('clear', () => {
    it('should clear all entries when no namespace given', () => {
      cache.set('ns1:key1', 'value1');
      cache.set('ns2:key2', 'value2');
      cache.clear();
      expect(cache.store.size).toBe(0);
    });

    it('should clear only matching namespace', () => {
      cache.set('ns1:key1', 'value1');
      cache.set('ns1:key2', 'value2');
      cache.set('ns2:key3', 'value3');

      cache.clear('ns1');
      expect(cache.store.size).toBe(1);
      expect(cache.get('ns2:key3')).toBe('value3');
    });
  });

  describe('cleanup', () => {
    it('should remove expired entries', async () => {
      const shortCache = new ImageCache({ ttl: 80 });
      shortCache.set('old', 'value');

      await new Promise((resolve) => setTimeout(resolve, 120));
      shortCache.set('new', 'value');

      shortCache.cleanup();
      expect(shortCache.store.has('old')).toBe(false);
      expect(shortCache.store.has('new')).toBe(true);
      shortCache.stopCleanup();
    });

    it('should keep non-expired entries', () => {
      cache.set('keep', 'value');
      cache.cleanup();
      expect(cache.store.has('keep')).toBe(true);
    });
  });

  describe('stopCleanup', () => {
    it('should clear the cleanup timer', () => {
      const c = new ImageCache({ ttl: 60000 });
      expect((c as unknown as Record<string, unknown>)['cleanupTimer']).not.toBeNull();
      c.stopCleanup();
      expect((c as unknown as Record<string, unknown>)['cleanupTimer']).toBeNull();
    });

    it('should be safe to call multiple times', () => {
      const c = new ImageCache();
      expect(() => { c.stopCleanup(); c.stopCleanup(); }).not.toThrow();
    });
  });

  describe('getSizeBytes', () => {
    it('should calculate cache size', () => {
      cache.set('key1', 'hello world');
      const size = cache.getSizeBytes();
      expect(size).toBeGreaterThan(0);
    });

    it('should return 0 for empty cache', () => {
      expect(cache.getSizeBytes()).toBe(0);
    });

    it('should grow with more entries', () => {
      cache.set('key1', 'short');
      const size1 = cache.getSizeBytes();
      cache.set('key2', 'a'.repeat(1000));
      expect(cache.getSizeBytes()).toBeGreaterThan(size1);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      cache.set('key1', 'value1');
      cache.get('key1');
      cache.get('missing');

      const stats = cache.getStats();
      expect(stats).toEqual({
        entries: 1,
        sizeBytes: expect.any(Number),
        hits: 1,
        misses: 1,
        hitRate: 50,
      });
    });

    it('should return 0 hitRate when no gets performed', () => {
      expect(cache.getStats().hitRate).toBe(0);
    });

    it('should return 100 hitRate when all gets are hits', () => {
      cache.set('k', 'v');
      cache.get('k');
      cache.get('k');
      expect(cache.getStats().hitRate).toBe(100);
    });
  });
});
