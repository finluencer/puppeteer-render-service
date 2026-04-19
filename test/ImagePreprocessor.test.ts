import { ImagePreprocessor } from '../src/ImagePreprocessor';

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function makeFetch(overrides: Partial<{ ok: boolean; status: number; body: ArrayBuffer; contentType: string }> = {}) {
  const { ok = true, status = 200, body = new ArrayBuffer(100), contentType = 'image/png' } = overrides;
  return jest.fn(() =>
    Promise.resolve({
      ok,
      status,
      arrayBuffer: () => Promise.resolve(body),
      headers: { get: () => contentType },
    })
  );
}

describe('ImagePreprocessor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with defaults', () => {
      const p = new ImagePreprocessor({ logger: silentLogger });
      expect(p.downloadTimeout).toBe(4000);
      expect(p.maxRetries).toBe(3);
      expect(p.batchSize).toBe(5);
      p.destroy();
    });

    it('should accept custom options', () => {
      const p = new ImagePreprocessor({ downloadTimeout: 8000, maxRetries: 5, batchSize: 10, logger: silentLogger });
      expect(p.downloadTimeout).toBe(8000);
      expect(p.maxRetries).toBe(5);
      expect(p.batchSize).toBe(10);
      p.destroy();
    });
  });

  describe('downloadAsBase64', () => {
    it('should download and return a base64 data URI', async () => {
      const p = new ImagePreprocessor({ fetchFn: makeFetch({ contentType: 'image/jpeg' }) as never, logger: silentLogger });
      const result = await p.downloadAsBase64('https://example.com/img.jpg');
      expect(result).toMatch(/^data:image\/jpeg;base64,/);
      p.destroy();
    });

    it('should throw on non-OK HTTP response', async () => {
      const p = new ImagePreprocessor({
        fetchFn: makeFetch({ ok: false, status: 404 }) as never,
        maxRetries: 1, logger: silentLogger,
      });
      await expect(p.downloadAsBase64('https://example.com/img.png')).rejects.toThrow('HTTP 404');
      p.destroy();
    });

    it('should throw on empty response body', async () => {
      const p = new ImagePreprocessor({
        fetchFn: makeFetch({ body: new ArrayBuffer(0) }) as never,
        maxRetries: 1, logger: silentLogger,
      });
      await expect(p.downloadAsBase64('https://example.com/img.png')).rejects.toThrow('Empty response body');
      p.destroy();
    });

    it('should retry on network failure and succeed on later attempt', async () => {
      let calls = 0;
      const fetchFn = jest.fn(() => {
        calls++;
        if (calls < 3) return Promise.reject(new Error('network error'));
        return Promise.resolve({
          ok: true, status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(50)),
          headers: { get: () => 'image/png' },
        });
      });

      const p = new ImagePreprocessor({
        fetchFn: fetchFn as never, maxRetries: 3,
        downloadTimeout: 100, logger: silentLogger,
      });

      const result = await p.downloadAsBase64('https://example.com/img.png');
      expect(result).toMatch(/^data:image\/png;base64,/);
      expect(calls).toBe(3);
      p.destroy();
    }, 10000);

    it('should throw after exhausting all retries', async () => {
      const fetchFn = jest.fn(() => Promise.reject(new Error('always fails')));
      const p = new ImagePreprocessor({
        fetchFn: fetchFn as never, maxRetries: 2, logger: silentLogger,
      });
      await expect(p.downloadAsBase64('https://example.com/img.png')).rejects.toThrow('always fails');
      expect(fetchFn).toHaveBeenCalledTimes(2);
      p.destroy();
    }, 5000);
  });

  describe('processImage', () => {
    it('should return base64 data URI on success', async () => {
      const p = new ImagePreprocessor({ fetchFn: makeFetch() as never, logger: silentLogger });
      const result = await p.processImage('https://example.com/img.png');
      expect(result).toMatch(/^data:image\/png;base64,/);
      p.destroy();
    });

    it('should cache result and not re-fetch on second call', async () => {
      const fetchFn = makeFetch();
      const p = new ImagePreprocessor({ fetchFn: fetchFn as never, logger: silentLogger });

      await p.processImage('https://example.com/img.png');
      await p.processImage('https://example.com/img.png');

      expect(fetchFn).toHaveBeenCalledTimes(1);
      p.destroy();
    });

    it('should log warn and return original URL on download failure', async () => {
      const fetchFn = jest.fn(() => Promise.reject(new Error('net fail')));
      const p = new ImagePreprocessor({
        fetchFn: fetchFn as never, maxRetries: 1, logger: silentLogger,
      });

      const result = await p.processImage('https://example.com/img.png');
      expect(result).toBe('https://example.com/img.png');
      expect(silentLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to download'),
        expect.any(String)
      );
      p.destroy();
    }, 5000);

    it('should log warn and return original URL when circuit breaker is open', async () => {
      const p = new ImagePreprocessor({ logger: silentLogger });

      // Force circuit open (default maxFailures = 5)
      for (let i = 0; i < 5; i++) p.circuitBreaker.recordFailure();

      const result = await p.processImage('https://example.com/img.png');
      expect(result).toBe('https://example.com/img.png');
      expect(silentLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Circuit open')
      );
      p.destroy();
    });

    it('should not cache the fallback URL when download fails', async () => {
      const fetchFn = jest.fn(() => Promise.reject(new Error('fail')));
      const p = new ImagePreprocessor({
        fetchFn: fetchFn as never, maxRetries: 1, logger: silentLogger,
      });

      await p.processImage('https://example.com/img.png');
      expect(p.cache.store.size).toBe(0);
      p.destroy();
    }, 5000);

    it('should use separate cache entries per namespace', async () => {
      const fetchFn = makeFetch();
      const p = new ImagePreprocessor({ fetchFn: fetchFn as never, logger: silentLogger });

      await p.processImage('https://example.com/img.png', 'ns1');
      await p.processImage('https://example.com/img.png', 'ns2');

      // Different namespaces = different cache keys = two fetch calls
      expect(fetchFn).toHaveBeenCalledTimes(2);
      p.destroy();
    });
  });

  describe('processHtml', () => {
    it('should return html unchanged when no pattern provided', async () => {
      const p = new ImagePreprocessor({ logger: silentLogger });
      const html = '<img src="https://example.com/image.png">';
      expect(await p.processHtml(html, {})).toBe(html);
      p.destroy();
    });

    it('should return html unchanged when no URLs match', async () => {
      const p = new ImagePreprocessor({ logger: silentLogger });
      const html = '<p>No images here</p>';
      const result = await p.processHtml(html, { pattern: /https:\/\/cdn\.example\.com[^"'\s>]+/g });
      expect(result).toBe(html);
      p.destroy();
    });

    it('should replace matching URLs with base64 data URIs', async () => {
      const p = new ImagePreprocessor({ fetchFn: makeFetch() as never, logger: silentLogger });
      const html = '<img src="https://cdn.example.com/logo.png">';
      const result = await p.processHtml(html, { pattern: /https:\/\/cdn\.example\.com[^"'\s>]+/g });
      expect(result).toContain('data:image/png;base64,');
      expect(result).not.toContain('cdn.example.com/logo.png');
      p.destroy();
    });

    it('should filter URLs through shouldProcess', async () => {
      const fetchFn = makeFetch();
      const p = new ImagePreprocessor({
        fetchFn: fetchFn as never,
        shouldProcess: (url) => url.includes('allowed'),
        logger: silentLogger,
      });

      const html = '<img src="https://cdn.example.com/allowed.png"><img src="https://cdn.example.com/blocked.png">';
      await p.processHtml(html, { pattern: /https:\/\/cdn\.example\.com[^"'\s>]+/g });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const calls = fetchFn.mock.calls as unknown as Array<[string, ...unknown[]]>;
      expect(calls[0][0]).toContain('allowed');
      p.destroy();
    });

    it('should support string pattern', async () => {
      const fetchFn = makeFetch();
      const p = new ImagePreprocessor({ fetchFn: fetchFn as never, logger: silentLogger });
      await p.processHtml('<img src="https://cdn.example.com/image.png">', { pattern: 'https://cdn.example.com' });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      p.destroy();
    });

    it('should deduplicate repeated URLs in the same HTML', async () => {
      const fetchFn = makeFetch();
      const p = new ImagePreprocessor({ fetchFn: fetchFn as never, logger: silentLogger });
      const html = '<img src="https://cdn.example.com/img.png"><img src="https://cdn.example.com/img.png">';
      await p.processHtml(html, { pattern: /https:\/\/cdn\.example\.com[^"'\s>]+/g });
      expect(fetchFn).toHaveBeenCalledTimes(1); // deduped
      p.destroy();
    });

    it('should process images in batches', async () => {
      const fetchFn = makeFetch();
      const p = new ImagePreprocessor({ fetchFn: fetchFn as never, batchSize: 2, logger: silentLogger });

      const urls = Array.from({ length: 5 }, (_, i) => `https://cdn.example.com/img${i}.png`);
      const html = urls.map((u) => `<img src="${u}">`).join('');
      await p.processHtml(html, { pattern: /https:\/\/cdn\.example\.com[^"'\s>]+/g });

      expect(fetchFn).toHaveBeenCalledTimes(5);
      p.destroy();
    });
  });

  describe('getStats', () => {
    it('should return cache and circuit breaker stats', () => {
      const p = new ImagePreprocessor({ logger: silentLogger });
      const stats = p.getStats();
      expect(stats.cache).toBeDefined();
      expect(stats.cache.entries).toBe(0);
      expect(stats.circuitBreaker.isOpen).toBe(false);
      p.destroy();
    });
  });

  describe('reset', () => {
    it('should clear cache and reset circuit breaker', () => {
      const p = new ImagePreprocessor({ logger: silentLogger });
      p.cache.set('key1', 'value1');
      p.circuitBreaker.recordFailure();

      p.reset();

      expect(p.cache.store.size).toBe(0);
      expect(p.circuitBreaker.failures).toBe(0);
      p.destroy();
    });
  });

  describe('destroy', () => {
    it('should stop the cache cleanup timer', () => {
      const p = new ImagePreprocessor({ logger: silentLogger });
      p.destroy();
      expect((p.cache as unknown as Record<string, unknown>)['cleanupTimer']).toBeNull();
    });

    it('should reset circuit breaker on destroy', () => {
      const p = new ImagePreprocessor({ logger: silentLogger });
      p.circuitBreaker.recordFailure();
      p.circuitBreaker.recordFailure();
      p.destroy();
      expect(p.circuitBreaker.failures).toBe(0);
    });
  });
});
