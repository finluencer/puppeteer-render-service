const CircuitBreaker = require('./CircuitBreaker');
const ImageCache = require('./ImageCache');

class ImagePreprocessor {
  constructor(options = {}) {
    this.fetchFn = options.fetchFn || null;
    this.shouldProcess = options.shouldProcess || (() => true);
    this.downloadTimeout = options.downloadTimeout || 4000;
    this.maxRetries = options.maxRetries || 3;
    this.batchSize = options.batchSize || 5;
    this.logger = options.logger || console;

    this.cache = new ImageCache(options.cache);
    this.circuitBreaker = new CircuitBreaker(options.circuitBreaker);
  }

  async _getFetch() {
    if (this.fetchFn) return this.fetchFn;

    if (typeof globalThis.fetch === 'function') {
      this.fetchFn = globalThis.fetch.bind(globalThis);
      return this.fetchFn;
    }

    try {
      const nodeFetch = require('node-fetch');
      this.fetchFn = nodeFetch;
      return this.fetchFn;
    } catch {
      throw new Error(
        'No fetch implementation found. Install "node-fetch" or use Node.js >= 18 with native fetch.'
      );
    }
  }

  async downloadAsBase64(url) {
    const fetch = await this._getFetch();

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.downloadTimeout);

        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'puppeteer-render-service/1.0',
            Accept: 'image/*',
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (buffer.length === 0) {
          throw new Error('Empty response body');
        }

        const contentType = response.headers.get('content-type') || 'image/png';
        return `data:${contentType};base64,${buffer.toString('base64')}`;
      } catch (error) {
        if (attempt === this.maxRetries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  async processImage(url, namespace = 'default') {
    const cacheKey = ImageCache.generateKey(url, namespace);

    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const data = await this.circuitBreaker.execute(
        () => this.downloadAsBase64(url),
        () => url
      );

      this.cache.set(cacheKey, data);
      return data;
    } catch {
      return url;
    }
  }

  async processHtml(html, options = {}) {
    const { pattern, namespace = 'default' } = options;

    if (!pattern) return html;

    const regex =
      typeof pattern === 'string'
        ? new RegExp(_escapeRegExp(pattern) + '[^"\'\\s>]+', 'g')
        : pattern;
    const urls = [...new Set(html.match(regex) || [])];

    if (urls.length === 0) return html;

    const processableUrls = urls.filter((url) => this.shouldProcess(url));
    if (processableUrls.length === 0) return html;

    const results = new Map();

    for (let i = 0; i < processableUrls.length; i += this.batchSize) {
      const batch = processableUrls.slice(i, i + this.batchSize);
      const batchResults = await Promise.all(
        batch.map(async (url) => {
          const result = await this.processImage(url, namespace).catch(() => url);
          return { url, result };
        })
      );

      for (const { url, result } of batchResults) {
        results.set(url, result);
      }
    }

    let processed = html;
    for (const [originalUrl, replacement] of results) {
      if (replacement !== originalUrl) {
        processed = processed.split(originalUrl).join(replacement);
      }
    }

    return processed;
  }

  getStats() {
    return {
      cache: this.cache.getStats(),
      circuitBreaker: this.circuitBreaker.getState(),
    };
  }

  reset() {
    this.cache.clear();
    this.circuitBreaker.reset();
  }
}

function _escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = ImagePreprocessor;
