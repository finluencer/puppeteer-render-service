import { RenderService } from './RenderService';
import { BrowserPool } from './BrowserPool';
import { ImageCache } from './ImageCache';
import { ImagePreprocessor } from './ImagePreprocessor';
import { CircuitBreaker } from './CircuitBreaker';
import {
  RenderServiceError,
  BrowserPoolError,
  RenderTimeoutError,
  ValidationError,
  CircuitBreakerOpenError,
} from './errors';
import DEFAULTS from './defaults';
import type { RenderServiceOptions, RenderOptions } from './RenderService';
import type { BrowserPoolOptions, BrowserHandle } from './BrowserPool';
import type { ImagePreprocessorOptions } from './ImagePreprocessor';
import type { CircuitBreakerOptions, CircuitBreakerState } from './CircuitBreaker';
import type { CacheStats } from './ImageCache';
import type {
  Defaults,
  ViewportConfig,
  MarginConfig,
  PoolDefaults,
  CacheDefaults,
  CircuitBreakerDefaults,
  BrowserDefaults,
  PdfDefaults,
  ImageDefaults,
  PageDefaults,
  OutputTypes,
} from './defaults';

function createRenderService(options: RenderServiceOptions): RenderService {
  return new RenderService(options);
}

export {
  createRenderService,
  RenderService,
  BrowserPool,
  ImageCache,
  ImagePreprocessor,
  CircuitBreaker,
  DEFAULTS,
  RenderServiceError,
  BrowserPoolError,
  RenderTimeoutError,
  ValidationError,
  CircuitBreakerOpenError,
};

export type {
  RenderServiceOptions,
  RenderOptions,
  BrowserPoolOptions,
  BrowserHandle,
  ImagePreprocessorOptions,
  CircuitBreakerOptions,
  CircuitBreakerState,
  CacheStats,
  Defaults,
  ViewportConfig,
  MarginConfig,
  PoolDefaults,
  CacheDefaults,
  CircuitBreakerDefaults,
  BrowserDefaults,
  PdfDefaults,
  ImageDefaults,
  PageDefaults,
  OutputTypes,
};
