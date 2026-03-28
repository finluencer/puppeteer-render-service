const EventEmitter = require('events');
const BrowserPool = require('./BrowserPool');
const ImagePreprocessor = require('./ImagePreprocessor');
const { ValidationError, RenderTimeoutError } = require('./errors');
const DEFAULTS = require('./defaults');

class RenderService extends EventEmitter {
  constructor(options = {}) {
    super();

    if (!options.puppeteer) {
      throw new Error('puppeteer is required. Pass it as: { puppeteer: require("puppeteer") }');
    }

    this.puppeteer = options.puppeteer;
    this.logger = options.logger || console;

    this.config = {
      browser: { ...DEFAULTS.browser, ...options.browser },
      pdf: { ...DEFAULTS.pdf, ...options.pdf },
      image: { ...DEFAULTS.image, ...options.image },
      page: { ...DEFAULTS.page, ...options.page },
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

  async _launchBrowser() {
    try {
      return await this.puppeteer.launch({
        headless: this.config.browser.headless,
        args: this.config.browser.args,
        timeout: this.config.browser.timeout,
      });
    } catch (error) {
      if (this.logger.warn) {
        this.logger.warn('[RenderService] Primary launch failed, trying minimal config');
      }
      return await this.puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        timeout: this.config.browser.timeout,
      });
    }
  }

  async _configurePage(page, options = {}) {
    const pageConfig = { ...this.config.page, ...options };

    await page.setRequestInterception(true);

    page.on('request', (request) => {
      if (options.requestFilter) {
        const action = options.requestFilter(request);
        if (action === 'abort') return request.abort();
        if (action === 'continue') return request.continue();
      }

      const type = request.resourceType();
      if (['document', 'stylesheet', 'font', 'image'].includes(type)) {
        request.continue();
      } else {
        request.abort();
      }
    });

    await page.setJavaScriptEnabled(pageConfig.javascript);
    await page.setViewport(pageConfig.viewport);
    await page.setDefaultNavigationTimeout(pageConfig.navigationTimeout);
    await page.setDefaultTimeout(pageConfig.defaultTimeout);
  }

  async _loadContent(page, html, options = {}) {
    const maxRetries = options.retries || this.config.page.retries;
    const retryDelay = options.retryDelay || this.config.page.retryDelay;

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
            `Content loading failed after ${maxRetries} attempts: ${error.message}`
          );
        }
        if (this.logger.warn) {
          this.logger.warn(`[RenderService] Load attempt ${attempt} failed, retrying...`);
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay * attempt));
      }
    }
  }

  async render(html, options = {}) {
    if (!html || typeof html !== 'string') {
      throw new ValidationError('HTML content must be a non-empty string');
    }

    if (this.isDestroyed) {
      throw new Error('RenderService has been destroyed');
    }

    const outputType = options.type || 'pdf';
    const startTime = Date.now();
    let poolHandle = null;
    let page = null;

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
      page = await poolHandle.browser.newPage();

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
      let buffer;
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
        } catch (e) {
          // ignore
        }
      }

      if (poolHandle) {
        poolHandle.release();
      }
    }
  }

  async _generatePDF(page, userOptions = {}, metadata = {}) {
    const pdfOptions = { ...this.config.pdf, ...userOptions };

    if (this.footerTemplate && metadata) {
      pdfOptions.displayHeaderFooter = true;
      pdfOptions.headerTemplate = this.headerTemplate
        ? this.headerTemplate(metadata)
        : '<div></div>';
      pdfOptions.footerTemplate = this.footerTemplate(metadata);
    }

    return page.pdf(pdfOptions);
  }

  async _generateImage(page, type, userOptions = {}) {
    const imageConfig = { ...this.config.image, ...userOptions };

    const screenshotOptions = {
      type: type === 'jpg' ? 'jpeg' : type,
      quality: type === 'png' ? undefined : imageConfig.quality,
      fullPage: imageConfig.fullPage,
      omitBackground: imageConfig.omitBackground,
      timeout: imageConfig.timeout,
    };

    if (!imageConfig.fullPage && !userOptions.clip && imageConfig.viewport) {
      screenshotOptions.clip = {
        x: 0,
        y: 0,
        width: imageConfig.viewport.width,
        height: imageConfig.viewport.height,
      };
    }

    if (userOptions.clip) {
      screenshotOptions.clip = userOptions.clip;
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

  _validateBuffer(buffer, type) {
    if (!buffer) throw new ValidationError(`No ${type} buffer returned`);
    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
      throw new ValidationError(`Invalid ${type} buffer type`);
    }
    if (buffer.length === 0) throw new ValidationError(`Empty ${type} buffer`);

    const minSize = type === 'pdf' ? 1000 : 100;
    if (buffer.length < minSize) {
      throw new ValidationError(
        `${type} buffer too small (${buffer.length} bytes) - possibly corrupted`
      );
    }
  }

  // Convenience methods
  async pdf(html, options = {}) {
    return this.render(html, { ...options, type: 'pdf' });
  }

  async png(html, options = {}) {
    return this.render(html, { ...options, type: 'png' });
  }

  async jpeg(html, options = {}) {
    return this.render(html, { ...options, type: 'jpeg' });
  }

  async webp(html, options = {}) {
    return this.render(html, { ...options, type: 'webp' });
  }

  // Lifecycle
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

  async destroy() {
    this.isDestroyed = true;

    if (this.imagePreprocessor) {
      this.imagePreprocessor.reset();
    }

    await this.browserPool.destroy();
    this.emit('destroy');
    this.removeAllListeners();
  }
}

module.exports = RenderService;
