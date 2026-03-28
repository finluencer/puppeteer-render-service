const ImageCache = require('../src/ImageCache');

describe('ImageCache', () => {
  let cache;

  beforeEach(() => {
    cache = new ImageCache({ ttl: 5000, maxEntries: 10, maxSizeBytes: 1024 * 1024 });
  });

  describe('constructor', () => {
    it('should initialize with defaults', () => {
      const defaultCache = new ImageCache();
      expect(defaultCache.enabled).toBe(true);
      expect(defaultCache.hits).toBe(0);
      expect(defaultCache.misses).toBe(0);
    });

    it('should accept custom options', () => {
      expect(cache.ttl).toBe(5000);
      expect(cache.maxEntries).toBe(10);
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
      const shortCache = new ImageCache({ ttl: 100 });
      shortCache.set('key1', 'value');

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(shortCache.get('key1')).toBeNull();
    });

    it('should not store when disabled', () => {
      const disabled = new ImageCache({ enabled: false });
      disabled.set('key1', 'value');
      expect(disabled.get('key1')).toBeNull();
    });
  });

  describe('evictIfNeeded', () => {
    it('should evict oldest entries when maxEntries exceeded', () => {
      const smallCache = new ImageCache({ maxEntries: 3, evictionPercent: 0.5 });

      smallCache.set('a', 'data-a');
      smallCache.set('b', 'data-b');
      smallCache.set('c', 'data-c');
      smallCache.set('d', 'data-d');

      // After eviction, oldest entries should be removed
      expect(smallCache.store.size).toBeLessThanOrEqual(3);
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
      const shortCache = new ImageCache({ ttl: 100 });
      shortCache.set('old', 'value');

      await new Promise((resolve) => setTimeout(resolve, 150));
      shortCache.set('new', 'value');

      shortCache.cleanup();
      expect(shortCache.store.has('old')).toBe(false);
      expect(shortCache.store.has('new')).toBe(true);
    });
  });

  describe('getSizeBytes', () => {
    it('should calculate cache size', () => {
      cache.set('key1', 'hello');
      const size = cache.getSizeBytes();
      expect(size).toBeGreaterThan(0);
    });

    it('should return 0 for empty cache', () => {
      expect(cache.getSizeBytes()).toBe(0);
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

    it('should return 0 hitRate when no gets', () => {
      expect(cache.getStats().hitRate).toBe(0);
    });
  });
});
