import { EventEmitter } from 'events';
import { BrowserPool } from './BrowserPool';
import { ImagePreprocessor } from './ImagePreprocessor';
import { ValidationError, RenderTimeoutError } from './errors';
import DEFAULTS from './defaults';
import type { BrowserPoolOptions } from './BrowserPool';
import type { ImagePreprocessorOptions } from './ImagePreprocessor';
import type { ViewportConfig } from './defaults';

type OutputType = 'pdf' | 'png' | 'jpeg' | 'webp';

interface PageLike {
  setRequestInterception(value: boolean): Promise<void>;
  setJavaScriptEnabled(value: boolean): Promise<void>;
  setViewport(viewport: ViewportConfig): Promise<void>;
  setDefaultNavigationTimeout(timeout: number): void;
  setDefaultTimeout(timeout: number): void;
  setContent(html: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  pdf(options?: Record<string, unknown>): Promise<Buffer>;
  $(selector: string): Promise<ElementLike | null>;
  close(): Promise<void>;
  isClosed(): boolean;
  on(event: string, handler: (req: RequestLike) => void): void;
}

interface ElementLike {
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
}

interface RequestLike {
  resourceType(): string;
  continue(): Promise<void> | void;
  abort(): Promise<void> | void;
}

interface BrowserLike {
  isConnected(): boolean;
  close(): Promise<void>;
  newPage(): Promise<PageLike>;
}

interface PuppeteerLike {
  launch(options?: {
    headless?: boolean;
    args?: string[];
    timeout?: number;
  }): Promise<BrowserLike>;
}

interface Logger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

interface ClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ImageOptions {
  quality?: number;
  fullPage?: boolean;
  omitBackground?: boolean;
  timeout?: number;
  viewport?: Partial<ViewportConfig>;
  clip?: ClipRect;
  selector?: string;
}

interface PdfOptions {
  format?: string;
  printBackground?: boolean;
  preferCSSPageSize?: boolean;
  displayHeaderFooter?: boolean;
  landscape?: boolean;
  scale?: number;
  timeout?: number;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  headerTemplate?: string;
  footerTemplate?: string;
  [key: string]: unknown;
}

interface PageOptions {
  javascript?: boolean;
  navigationTimeout?: number;
  defaultTimeout?: number;
  retries?: number;
  retryDelay?: number;
  viewport?: Partial<ViewportConfig>;
}

export interface RenderOptions {
  type?: OutputType;
  pdf?: PdfOptions;
  image?: ImageOptions;
  page?: PageOptions;
  preprocessor?: { pattern?: string | RegExp; namespace?: string };
  requestFilter?: (req: RequestLike) => 'abort' | 'continue' | undefined | void;
  metadata?: Record<string, unknown>;
}

export interface RenderServiceOptions {
  puppeteer: PuppeteerLike;
  logger?: Logger;
  browser?: Partial<typeof DEFAULTS.browser>;
  pdf?: Partial<PdfOptions>;
  image?: Partial<ImageOptions>;
  page?: Partial<PageOptions>;
  pool?: BrowserPoolOptions;
  imagePreprocessor?: Partial<ImagePreprocessorOptions>;
  cache?: Partial<typeof DEFAULTS.cache>;
  circuitBreaker?: Partial<typeof DEFAULTS.circuitBreaker>;
  headerTemplate?: (metadata: Record<string, unknown>) => string;
  footerTemplate?: (metadata: Record<string, unknown>) => string;
}

interface Metrics {
  totalRenders: number;
  totalTime: number;
  errors: number;
  byType: Record<OutputType, number>;
}

export class RenderService extends EventEmitter {
  puppeteer: PuppeteerLike;
  logger: Logger;
  config: {
    browser: typeof DEFAULTS.browser;
    pdf: typeof DEFAULTS.pdf;
    image: typeof DEFAULTS.image;
    page: typeof DEFAULTS.page;
  };
  headerTemplate: ((metadata: Record<string, unknown>) => string) | null;
  footerTemplate: ((metadata: Record<string, unknown>) => string) | null;
  browserPool: BrowserPool;
  imagePreprocessor: ImagePreprocessor | null;
  metrics: Metrics;
  isDestroyed: boolean;

  constructor(options: RenderServiceOptions) {
    super();

    if (!options.puppeteer) {
      throw new Error('puppeteer is required. Pass it as: { puppeteer: require("puppeteer") }');
    }

    this.puppeteer = options.puppeteer;
    this.logger = options.logger || console;

    this.config = {
      browser: { ...DEFAULTS.browser, ...options.browser },
      pdf: { ...DEFAULTS.pdf, ...options.pdf } as typeof DEFAULTS.pdf,
      image: { ...DEFAULTS.image, ...options.image } as typeof DEFAULTS.image,
      page: { ...DEFAULTS.page, ...options.page } as typeof DEFAULTS.page,
    };

    this.headerTemplate = options.headerTemplate || null;
    this.footerTemplate = options.footerTemplate || null;

    this.browserPool = new BrowserPool(
      () => this._launchBrowser(),
      { ...options.pool, logger: this.logger }
    );

    this.imagePreprocessor = options.imagePreprocessor
      ? new ImagePreprocessor({
          ...options.imagePreprocessor,
          cache: options.cache,
          circuitBreaker: options.circuitBreaker,
          logger: this.logger,
        })
      : null;

    this.metrics = {
      totalRenders: 0,
      totalTime: 0,
      errors: 0,
      byType: { pdf: 0, png: 0, jpeg: 0, webp: 0 },
    };

    this.isDestroyed = false;
  }

  async _launchBrowser(): Promise<BrowserLike> {
    try {
      return await this.puppeteer.launch({
        headless: this.config.browser.headless,
        args: this.config.browser.args,
        timeout: this.config.browser.timeout,
      });
    } catch {
      if (this.logger.warn) {
        this.logger.warn('[RenderService] Primary launch failed, trying minimal config');
      }
      return await this.puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        timeout: this.config.browser.timeout,
      });
    }
  }

  async _configurePage(page: PageLike, options: PageOptions & { requestFilter?: RenderOptions['requestFilter'] } = {}): Promise<void> {
    const pageConfig = { ...this.config.page, ...options };

    await page.setRequestInterception(true);

    page.on('request', (request: RequestLike) => {
      try {
        if (options.requestFilter) {
          const action = options.requestFilter(request);
          if (action === 'abort') { void request.abort(); return; }
          if (action === 'continue') { void request.continue(); return; }
        }

        const type = request.resourceType();
        if (['document', 'stylesheet', 'font', 'image'].includes(type)) {
          void request.continue();
        } else {
          void request.abort();
        }
      } catch {
        // Page may be closing; ignore stale request handler errors
      }
    });

    await page.setJavaScriptEnabled(pageConfig.javascript ?? DEFAULTS.page.javascript);
    await page.setViewport(pageConfig.viewport as ViewportConfig ?? DEFAULTS.page.viewport);
    await page.setDefaultNavigationTimeout(pageConfig.navigationTimeout ?? DEFAULTS.page.navigationTimeout);
    await page.setDefaultTimeout(pageConfig.defaultTimeout ?? DEFAULTS.page.defaultTimeout);
  }

  async _loadContent(page: PageLike, html: string, options: PageOptions = {}): Promise<void> {
    const maxRetries = options.retries ?? this.config.page.retries;
    const retryDelay = options.retryDelay ?? this.config.page.retryDelay;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await page.setContent(html, {
          waitUntil: attempt === 1 ? 'domcontentloaded' : 'load',
          timeout: this.config.page.navigationTimeout,
        });

        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        return;
      } catch (error) {
        if (attempt === maxRetries) {
          throw new RenderTimeoutError(
            `Content loading failed after ${maxRetries} attempts: ${(error as Error).message}`
          );
        }
        if (this.logger.warn) {
          this.logger.warn(`[RenderService] Load attempt ${attempt} failed, retrying...`);
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay * attempt));
      }
    }
  }

  async render(html: string, options: RenderOptions = {}): Promise<Buffer> {
    if (!html || typeof html !== 'string') {
      throw new ValidationError('HTML content must be a non-empty string');
    }

    if (this.isDestroyed) {
      throw new Error('RenderService has been destroyed');
    }

    const outputType: OutputType = options.type || 'pdf';
    const startTime = Date.now();
    let poolHandle: { browser: unknown; release(): void } | null = null;
    let page: PageLike | null = null;

    try {
      this.metrics.totalRenders++;
      this.metrics.byType[outputType] = (this.metrics.byType[outputType] || 0) + 1;

      // Preprocess HTML
      let processedHtml = html;
      if (this.imagePreprocessor && options.preprocessor) {
        processedHtml = await this.imagePreprocessor.processHtml(html, options.preprocessor);
      }

      // Acquire browser
      poolHandle = await this.browserPool.acquire();
      page = await (poolHandle.browser as BrowserLike).newPage();

      // Configure page
      const pageViewport =
        outputType === 'pdf'
          ? this.config.page.viewport
          : { ...DEFAULTS.image.viewport, ...options.image?.viewport };

      await this._configurePage(page, {
        ...options.page,
        viewport: pageViewport,
        requestFilter: options.requestFilter,
      });

      // Load content
      await this._loadContent(page, processedHtml, options.page);

      // Generate output
      let buffer: Buffer;
      if (outputType === 'pdf') {
        buffer = await this._generatePDF(page, options.pdf, options.metadata);
      } else {
        buffer = await this._generateImage(page, outputType, options.image);
      }

      // Validate
      this._validateBuffer(buffer, outputType);

      const duration = Date.now() - startTime;
      this.metrics.totalTime += duration;

      this.emit('render', {
        type: outputType,
        duration,
        bufferSize: buffer.length,
      });

      return buffer;
    } catch (error) {
      this.metrics.errors++;

      this.emit('error', {
        error,
        type: outputType,
        duration: Date.now() - startTime,
        htmlLength: html?.length,
      });

      throw error;
    } finally {
      if (page) {
        try {
          if (!page.isClosed()) await page.close();
        } catch {
          // ignore
        }
      }

      if (poolHandle) {
        poolHandle.release();
      }
    }
  }

  async _generatePDF(
    page: PageLike,
    userOptions: PdfOptions = {},
    metadata: Record<string, unknown> = {}
  ): Promise<Buffer> {
    const pdfOptions: Record<string, unknown> = { ...this.config.pdf, ...userOptions };

    if (this.footerTemplate && metadata) {
      pdfOptions['displayHeaderFooter'] = true;
      pdfOptions['headerTemplate'] = this.headerTemplate
        ? this.headerTemplate(metadata)
        : '<div></div>';
      pdfOptions['footerTemplate'] = this.footerTemplate(metadata);
    }

    return page.pdf(pdfOptions);
  }

  async _generateImage(
    page: PageLike,
    type: OutputType,
    userOptions: ImageOptions = {}
  ): Promise<Buffer> {
    const imageConfig = { ...this.config.image, ...userOptions };

    const screenshotOptions: Record<string, unknown> = {
      type: type === 'jpeg' ? 'jpeg' : type,
      quality: type === 'png' ? undefined : imageConfig.quality,
      fullPage: imageConfig.fullPage,
      omitBackground: imageConfig.omitBackground,
      timeout: imageConfig.timeout,
    };

    if (!imageConfig.fullPage && !userOptions.clip && imageConfig.viewport) {
      screenshotOptions['clip'] = {
        x: 0,
        y: 0,
        width: imageConfig.viewport.width,
        height: imageConfig.viewport.height,
      };
    }

    if (userOptions.clip) {
      screenshotOptions['clip'] = userOptions.clip;
    }

    if (userOptions.selector) {
      const element = await page.$(userOptions.selector);
      if (!element) {
        throw new ValidationError(`Element "${userOptions.selector}" not found`);
      }
      return element.screenshot(screenshotOptions);
    }

    const body = await page.$('body');
    if (!body) {
      throw new ValidationError('Body element not found');
    }
    return body.screenshot(screenshotOptions);
  }

  _validateBuffer(buffer: Buffer | Uint8Array | null | undefined, type: string): void {
    if (!buffer) throw new ValidationError(`No ${type} buffer returned`);
    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
      throw new ValidationError(`Invalid ${type} buffer type`);
    }
    if (buffer.length === 0) throw new ValidationError(`Empty ${type} buffer`);

    const minSize = type === 'pdf' ? 100 : 50;
    if (buffer.length < minSize) {
      throw new ValidationError(
        `${type} buffer too small (${buffer.length} bytes) — possibly corrupted`
      );
    }
  }

  async pdf(html: string, options: Omit<RenderOptions, 'type'> = {}): Promise<Buffer> {
    return this.render(html, { ...options, type: 'pdf' });
  }

  async png(html: string, options: Omit<RenderOptions, 'type'> = {}): Promise<Buffer> {
    return this.render(html, { ...options, type: 'png' });
  }

  async jpeg(html: string, options: Omit<RenderOptions, 'type'> = {}): Promise<Buffer> {
    return this.render(html, { ...options, type: 'jpeg' });
  }

  async webp(html: string, options: Omit<RenderOptions, 'type'> = {}): Promise<Buffer> {
    return this.render(html, { ...options, type: 'webp' });
  }

  getStats() {
    return {
      renders: { ...this.metrics },
      avgRenderTime: this.metrics.totalRenders
        ? Math.round(this.metrics.totalTime / this.metrics.totalRenders)
        : 0,
      pool: this.browserPool.getStats(),
      preprocessor: this.imagePreprocessor?.getStats() || null,
    };
  }

  async destroy(): Promise<void> {
    this.isDestroyed = true;

    if (this.imagePreprocessor) {
      this.imagePreprocessor.destroy();
    }

    await this.browserPool.destroy();
    this.emit('destroy');
    this.removeAllListeners();
  }
}
