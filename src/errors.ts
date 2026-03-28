export class RenderServiceError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RenderServiceError';
    this.code = code;
    this.details = details;
  }
}

export class BrowserPoolError extends RenderServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'BROWSER_POOL_ERROR', details);
    this.name = 'BrowserPoolError';
  }
}

export class RenderTimeoutError extends RenderServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'RENDER_TIMEOUT', details);
    this.name = 'RenderTimeoutError';
  }
}

export class ValidationError extends RenderServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export class CircuitBreakerOpenError extends RenderServiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CIRCUIT_BREAKER_OPEN', details);
    this.name = 'CircuitBreakerOpenError';
  }
}
