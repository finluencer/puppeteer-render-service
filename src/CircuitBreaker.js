const { CircuitBreakerOpenError } = require('./errors');
const DEFAULTS = require('./defaults');

class CircuitBreaker {
  constructor(options = {}) {
    const config = { ...DEFAULTS.circuitBreaker, ...options };
    this.enabled = config.enabled;
    this.maxFailures = config.maxFailures;
    this.resetTimeout = config.resetTimeout;
    this.failures = 0;
    this.isOpen = false;
    this.lastFailureTime = null;
    this.successCount = 0;
  }

  get isBroken() {
    if (!this.enabled || !this.isOpen) return false;

    const elapsed = Date.now() - this.lastFailureTime;
    if (elapsed > this.resetTimeout) {
      this.reset();
      return false;
    }

    return true;
  }

  recordSuccess() {
    this.successCount++;
    if (this.failures > 0) {
      this.failures = Math.max(0, this.failures - 1);
    }
  }

  recordFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.maxFailures) {
      this.isOpen = true;
    }
  }

  async execute(fn, fallback) {
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

  reset() {
    this.failures = 0;
    this.isOpen = false;
    this.lastFailureTime = null;
  }

  getState() {
    return {
      isOpen: this.isOpen,
      failures: this.failures,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

module.exports = CircuitBreaker;
