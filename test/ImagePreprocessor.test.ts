import { ImagePreprocessor } from '../src/ImagePreprocessor';

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('ImagePreprocessor', () => {
  describe('constructor', () => {
    it('should initialize with defaults', () => {
      const preprocessor = new ImagePreprocessor({ logger: silentLogger });
      expect(preprocessor.downloadTimeout).toBe(4000);
      expect(preprocessor.maxRetries).toBe(3);
      expect(preprocessor.batchSize).toBe(5);
    });

    it('should accept custom options', () => {
      const preprocessor = new ImagePreprocessor({
        downloadTimeout: 8000,
        maxRetries: 5,
        batchSize: 10,
        logger: silentLogger,
      });
      expect(preprocessor.downloadTimeout).toBe(8000);
      expect(preprocessor.maxRetries).toBe(5);
      expect(preprocessor.batchSize).toBe(10);
    });
  });

  describe('processHtml', () => {
    it('should return html unchanged when no pattern provided', async () => {
      const preprocessor = new ImagePreprocessor({ logger: silentLogger });
      const html = '<img src="https://example.com/image.png">';
      const result = await preprocessor.processHtml(html, {});
      expect(result).toBe(html);
    });

    it('should return html unchanged when no URLs match', async () => {
      const preprocessor = new ImagePreprocessor({ logger: silentLogger });
      const html = '<p>No images here</p>';
      const result = await preprocessor.processHtml(html, {
        pattern: /https:\/\/cdn\.example\.com[^"'\s>]+/g,
      });
      expect(result).toBe(html);
    });

    it('should filter URLs through shouldProcess', async () => {
      const mockFetch = jest.fn((_url: string, _init?: unknown) =>
        Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
          headers: { get: () => 'image/png' },
        })
      );

      const preprocessor = new ImagePreprocessor({
        fetchFn: mockFetch as never,
        shouldProcess: (url) => url.includes('allowed'),
        logger: silentLogger,
      });

      const html = '<img src="https://cdn.example.com/allowed.png"><img src="https://cdn.example.com/blocked.png">';
      await preprocessor.processHtml(html, {
        pattern: /https:\/\/cdn\.example\.com[^"'\s>]+/g,
      });

      // Only the allowed URL should be fetched
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('allowed');
    });

    it('should support string pattern', async () => {
      const mockFetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
          headers: { get: () => 'image/png' },
        })
      );

      const preprocessor = new ImagePreprocessor({
        fetchFn: mockFetch as never,
        logger: silentLogger,
      });

      const html = '<img src="https://cdn.example.com/image.png">';
      await preprocessor.processHtml(html, {
        pattern: 'https://cdn.example.com',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStats', () => {
    it('should return cache and circuit breaker stats', () => {
      const preprocessor = new ImagePreprocessor({ logger: silentLogger });
      const stats = preprocessor.getStats();

      expect(stats.cache).toBeDefined();
      expect(stats.cache.entries).toBe(0);
      expect(stats.circuitBreaker).toBeDefined();
      expect(stats.circuitBreaker.isOpen).toBe(false);
    });
  });

  describe('reset', () => {
    it('should clear cache and reset circuit breaker', () => {
      const preprocessor = new ImagePreprocessor({ logger: silentLogger });

      preprocessor.cache.set('key1', 'value1');
      preprocessor.circuitBreaker.recordFailure();

      preprocessor.reset();

      expect(preprocessor.cache.store.size).toBe(0);
      expect(preprocessor.circuitBreaker.failures).toBe(0);
    });
  });
});
