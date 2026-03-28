class RenderServiceError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'RenderServiceError';
    this.code = code;
    this.details = details;
  }
}

class BrowserPoolError extends RenderServiceError {
  constructor(message, details) {
    super(message, 'BROWSER_POOL_ERROR', details);
    this.name = 'BrowserPoolError';
  }
}

class RenderTimeoutError extends RenderServiceError {
  constructor(message, details) {
    super(message, 'RENDER_TIMEOUT', details);
    this.name = 'RenderTimeoutError';
  }
}

class ValidationError extends RenderServiceError {
  constructor(message, details) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

class CircuitBreakerOpenError extends RenderServiceError {
  constructor(message, details) {
    super(message, 'CIRCUIT_BREAKER_OPEN', details);
    this.name = 'CircuitBreakerOpenError';
  }
}

module.exports = {
  RenderServiceError,
  BrowserPoolError,
  RenderTimeoutError,
  ValidationError,
  CircuitBreakerOpenError,
};
