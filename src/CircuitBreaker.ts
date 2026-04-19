import { CircuitBreakerOpenError } from './errors';
import DEFAULTS from './defaults';

export interface CircuitBreakerOptions {
  enabled?: boolean;
  maxFailures?: number;
  resetTimeout?: number;
}

export interface CircuitBreakerState {
  isOpen: boolean;
  failures: number;
  successCount: number;
  lastFailureTime: number | null;
}

export class CircuitBreaker {
  enabled: boolean;
  maxFailures: number;
  resetTimeout: number;
  failures: number;
  isOpen: boolean;
  lastFailureTime: number | null;
  successCount: number;

  constructor(options: CircuitBreakerOptions = {}) {
    const config = { ...DEFAULTS.circuitBreaker, ...options };
    this.enabled = config.enabled;
    this.maxFailures = config.maxFailures;
    this.resetTimeout = config.resetTimeout;
    this.failures = 0;
    this.isOpen = false;
    this.lastFailureTime = null;
    this.successCount = 0;
  }

  get isBroken(): boolean {
    if (!this.enabled || !this.isOpen) return false;

    const elapsed = Date.now() - this.lastFailureTime!;
    if (elapsed > this.resetTimeout) {
      this.reset();
      return false;
    }

    return true;
  }

  recordSuccess(): void {
    // Cap to avoid overflow on long-lived instances
    if (this.successCount < Number.MAX_SAFE_INTEGER) {
      this.successCount++;
    }
    if (this.failures > 0) {
      this.failures = Math.max(0, this.failures - 1);
    }
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.maxFailures) {
      this.isOpen = true;
    }
  }

  async execute<T>(fn: () => Promise<T>, fallback?: () => T | Promise<T>): Promise<T> {
    if (this.isBroken) {
      if (fallback) return fallback();
      throw new CircuitBreakerOpenError(
        `Circuit breaker is open (${this.failures} failures). Retry after ${this.resetTimeout}ms.`
      );
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  reset(): void {
    this.failures = 0;
    this.isOpen = false;
    this.lastFailureTime = null;
    this.successCount = 0;
  }

  getState(): CircuitBreakerState {
    return {
      isOpen: this.isOpen,
      failures: this.failures,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}
