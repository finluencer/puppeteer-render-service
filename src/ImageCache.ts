import { createHash } from 'crypto';
import DEFAULTS from './defaults';
import type { CacheDefaults } from './defaults';

interface CacheEntry {
  data: string;
  timestamp: number;
  lastAccessed: number;
  size: number;
  [key: string]: unknown;
}

export interface CacheStats {
  entries: number;
  sizeBytes: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export class ImageCache {
  enabled: boolean;
  maxSizeBytes: number;
  maxEntries: number;
  ttl: number;
  evictionPercent: number;
  store: Map<string, CacheEntry>;
  hits: number;
  misses: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor(options: Partial<CacheDefaults> = {}) {
    const config = { ...DEFAULTS.cache, ...options };
    this.enabled = config.enabled;
    this.maxSizeBytes = config.maxSizeBytes;
    this.maxEntries = config.maxEntries;
    this.ttl = config.ttl;
    this.evictionPercent = config.evictionPercent;
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
    this.cleanupTimer = null;

    if (this.enabled) {
      // Run cleanup at 1/4 of TTL, but no more often than every 60s
      const cleanupInterval = Math.max(this.ttl / 4, 60_000);
      this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
      // Don't block process exit
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  static generateKey(url: string, namespace = 'default'): string {
    const normalized = url.split('?')[0];
    const hash = createHash('sha256')
      .update(`${namespace}:${normalized}`)
      .digest('hex')
      .substring(0, 16);
    return `${namespace}:${hash}`;
  }

  get(key: string): string | null {
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

  set(key: string, data: string, meta: Record<string, unknown> = {}): void {
    if (!this.enabled) return;

    this.store.set(key, {
      data,
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      size: Buffer.byteLength(data, 'utf8'),
      ...meta,
    });

    this.evictIfNeeded();
  }

  evictIfNeeded(): void {
    if (this.store.size <= this.maxEntries && this.getSizeBytes() <= this.maxSizeBytes) {
      return;
    }

    const entries = Array.from(this.store.entries());
    // Sort by LRU: least recently accessed first
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    const toEvict = Math.ceil(this.store.size * this.evictionPercent);

    for (let i = 0; i < toEvict && i < entries.length; i++) {
      this.store.delete(entries[i][0]);
    }
  }

  getSizeBytes(): number {
    let total = 0;
    for (const [key, value] of this.store.entries()) {
      total += Buffer.byteLength(key, 'utf8');
      total += (value.size as number) || 0;
    }
    return total;
  }

  clear(namespace?: string): void {
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

  cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.store.entries()) {
      if (now - value.timestamp > this.ttl) {
        this.store.delete(key);
      }
    }
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  getStats(): CacheStats {
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
