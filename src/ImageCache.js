const crypto = require('crypto');
const DEFAULTS = require('./defaults');

class ImageCache {
  constructor(options = {}) {
    const config = { ...DEFAULTS.cache, ...options };
    this.enabled = config.enabled;
    this.maxSizeBytes = config.maxSizeBytes;
    this.maxEntries = config.maxEntries;
    this.ttl = config.ttl;
    this.evictionPercent = config.evictionPercent;
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  static generateKey(url, namespace = 'default') {
    const normalized = url.split('?')[0];
    const hash = crypto
      .createHash('sha256')
      .update(`${namespace}:${normalized}`)
      .digest('hex')
      .substring(0, 16);
    return `${namespace}:${hash}`;
  }

  get(key) {
    if (!this.enabled) return null;

    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() - entry.timestamp > this.ttl) {
      this.store.delete(key);
      this.misses++;
      return null;
    }

    entry.lastAccessed = Date.now();
    this.hits++;
    return entry.data;
  }

  set(key, data, meta = {}) {
    if (!this.enabled) return;

    this.store.set(key, {
      data,
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      size: typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : 0,
      ...meta,
    });

    this.evictIfNeeded();
  }

  evictIfNeeded() {
    if (this.store.size <= this.maxEntries && this.getSizeBytes() <= this.maxSizeBytes) {
      return;
    }

    const entries = Array.from(this.store.entries());
    const sorted = entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    const toEvict = sorted.slice(0, Math.ceil(this.store.size * this.evictionPercent));

    for (const [key] of toEvict) {
      this.store.delete(key);
    }
  }

  getSizeBytes() {
    let total = 0;
    for (const [key, value] of this.store.entries()) {
      total += Buffer.byteLength(key, 'utf8');
      total += value.size || 0;
    }
    return total;
  }

  clear(namespace) {
    if (!namespace) {
      this.store.clear();
      return;
    }

    for (const key of this.store.keys()) {
      if (key.startsWith(`${namespace}:`)) {
        this.store.delete(key);
      }
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [key, value] of this.store.entries()) {
      if (now - value.timestamp > this.ttl) {
        this.store.delete(key);
      }
    }
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      entries: this.store.size,
      sizeBytes: this.getSizeBytes(),
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) : 0,
    };
  }
}

module.exports = ImageCache;
