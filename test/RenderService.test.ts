import { RenderService } from '../src/RenderService';
import { ValidationError } from '../src/errors';

function createMockPage() {
  return {
    setRequestInterception: jest.fn(() => Promise.resolve()),
    setJavaScriptEnabled: jest.fn(() => Promise.resolve()),
    setViewport: jest.fn(() => Promise.resolve()),
    setDefaultNavigationTimeout: jest.fn(),
    setDefaultTimeout: jest.fn(),
    setContent: jest.fn(() => Promise.resolve()),
    pdf: jest.fn(() => Promise.resolve(Buffer.alloc(5000, 'a'))),
    $: jest.fn(() =>
      Promise.resolve({
        screenshot: jest.fn(() => Promise.resolve(Buffer.alloc(500, 'b'))),
      })
    ),
    close: jest.fn(() => Promise.resolve()),
    isClosed: jest.fn(() => false),
    on: jest.fn(),
  };
}

function createMockBrowser() {
  return {
    isConnected: jest.fn(() => true),
    close: jest.fn(() => Promise.resolve()),
    newPage: jest.fn(() => Promise.resolve(createMockPage())),
  };
}

function createMockPuppeteer() {
  return {
    launch: jest.fn(() => Promise.resolve(createMockBrowser())),
  };
}

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('RenderService', () => {
  let service: RenderService;
  let mockPuppeteer: ReturnType<typeof createMockPuppeteer>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPuppeteer = createMockPuppeteer();
    service = new RenderService({
      puppeteer: mockPuppeteer,
      logger: silentLogger,
      pool: { min: 1, max: 2, healthCheckInterval: 600000 },
    });
  });

  afterEach(async () => {
    if (!service.isDestroyed) {
      await service.destroy();
    }
  });

  describe('constructor', () => {
    it('should throw if puppeteer not provided', () => {
      expect(() => new RenderService({} as never)).toThrow('puppeteer is required');
    });

    it('should initialize with defaults', () => {
      expect(service.isDestroyed).toBe(false);
      expect(service.metrics.totalRenders).toBe(0);
    });

    it('should accept custom templates', () => {
      const footer = (meta: Record<string, unknown>) => `<div>${meta['name']}</div>`;
      const svc = new RenderService({
        puppeteer: mockPuppeteer,
        footerTemplate: footer,
        logger: silentLogger,
        pool: { healthCheckInterval: 600000 },
      });
      expect(svc.footerTemplate).toBe(footer);
      svc.destroy();
    });
  });

  describe('render', () => {
    it('should generate a PDF buffer by default', async () => {
      const buffer = await service.render('<h1>Hello</h1>');
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(100);
    });

    it('should generate an image buffer for png type', async () => {
      const buffer = await service.render('<h1>Hello</h1>', { type: 'png' });
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(50);
    });

    it('should throw ValidationError for empty string HTML', async () => {
      await expect(service.render('')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for null HTML', async () => {
      await expect(service.render(null as unknown as string)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for non-string HTML', async () => {
      await expect(service.render(123 as unknown as string)).rejects.toThrow(ValidationError);
    });

    it('should throw after destroy', async () => {
      await service.destroy();
      await expect(service.render('<h1>test</h1>')).rejects.toThrow('destroyed');
    });

    it('should increment metrics on success', async () => {
      await service.render('<h1>test</h1>');
      expect(service.metrics.totalRenders).toBe(1);
      expect(service.metrics.byType.pdf).toBe(1);
    });

    it('should track byType metrics for each output type', async () => {
      await service.render('<h1>test</h1>', { type: 'pdf' });
      await service.render('<h1>test</h1>', { type: 'png' });
      await service.render('<h1>test</h1>', { type: 'jpeg' });
      await service.render('<h1>test</h1>', { type: 'webp' });
      expect(service.metrics.byType.pdf).toBe(1);
      expect(service.metrics.byType.png).toBe(1);
      expect(service.metrics.byType.jpeg).toBe(1);
      expect(service.metrics.byType.webp).toBe(1);
    });

    it('should increment error metrics on failure', async () => {
      const badPage = createMockPage();
      badPage.pdf = jest.fn(() => Promise.reject(new Error('pdf failed')));
      const badBrowser = createMockBrowser();
      badBrowser.newPage = jest.fn(() => Promise.resolve(badPage));
      mockPuppeteer.launch = jest.fn(() => Promise.resolve(badBrowser));

      const svc = new RenderService({
        puppeteer: mockPuppeteer, logger: silentLogger,
        pool: { min: 1, max: 1, healthCheckInterval: 600000 },
      });

      await expect(svc.render('<h1>test</h1>')).rejects.toThrow('pdf failed');
      expect(svc.metrics.errors).toBe(1);
      await svc.destroy();
    });

    it('should emit render event on success', async () => {
      const listener = jest.fn();
      service.on('render', listener);

      await service.render('<h1>test</h1>');
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pdf', duration: expect.any(Number), bufferSize: expect.any(Number) })
      );
    });

    it('should emit error event on failure', async () => {
      const badPage = createMockPage();
      badPage.pdf = jest.fn(() => Promise.reject(new Error('boom')));
      const badBrowser = createMockBrowser();
      badBrowser.newPage = jest.fn(() => Promise.resolve(badPage));
      mockPuppeteer.launch = jest.fn(() => Promise.resolve(badBrowser));

      const svc = new RenderService({
        puppeteer: mockPuppeteer, logger: silentLogger,
        pool: { min: 1, max: 1, healthCheckInterval: 600000 },
      });

      const errorListener = jest.fn();
      svc.on('error', errorListener);

      await expect(svc.render('<h1>test</h1>')).rejects.toThrow();
      expect(errorListener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pdf', error: expect.any(Error) })
      );
      await svc.destroy();
    });

    it('should close the page in finally even when render throws', async () => {
      const badPage = createMockPage();
      badPage.pdf = jest.fn(() => Promise.reject(new Error('crash')));
      const browser = createMockBrowser();
      browser.newPage = jest.fn(() => Promise.resolve(badPage));
      mockPuppeteer.launch = jest.fn(() => Promise.resolve(browser));

      const svc = new RenderService({
        puppeteer: mockPuppeteer, logger: silentLogger,
        pool: { min: 1, max: 1, healthCheckInterval: 600000 },
      });

      await expect(svc.render('<h1>test</h1>')).rejects.toThrow('crash');
      expect(badPage.close).toHaveBeenCalled();
      await svc.destroy();
    });
  });

  describe('request interception', () => {
    it('should not throw when request.abort() throws synchronously', async () => {
      const page = createMockPage();
      let capturedHandler: ((req: unknown) => void) | undefined;

      page.on = jest.fn((event: string, handler: (req: unknown) => void) => {
        if (event === 'request') capturedHandler = handler;
      });

      const browser = createMockBrowser();
      browser.newPage = jest.fn(() => Promise.resolve(page));
      mockPuppeteer.launch = jest.fn(() => Promise.resolve(browser));

      const svc = new RenderService({
        puppeteer: mockPuppeteer, logger: silentLogger,
        pool: { min: 1, max: 1, healthCheckInterval: 600000 },
      });

      const renderPromise = svc.render('<h1>test</h1>');

      // Simulate a request event where abort() throws (e.g. page already closed)
      if (capturedHandler) {
        expect(() =>
          capturedHandler!({
            resourceType: () => 'script',
            abort: () => { throw new Error('page closed'); },
            continue: () => Promise.resolve(),
          })
        ).not.toThrow();
      }

      await renderPromise;
      await svc.destroy();
    });

    it('should honour custom requestFilter returning abort', async () => {
      const page = createMockPage();
      let capturedHandler: ((req: unknown) => void) | undefined;
      page.on = jest.fn((event: string, handler: (req: unknown) => void) => {
        if (event === 'request') capturedHandler = handler;
      });

      const browser = createMockBrowser();
      browser.newPage = jest.fn(() => Promise.resolve(page));
      mockPuppeteer.launch = jest.fn(() => Promise.resolve(browser));

      const svc = new RenderService({
        puppeteer: mockPuppeteer, logger: silentLogger,
        pool: { min: 1, max: 1, healthCheckInterval: 600000 },
      });

      // Render first so _configurePage runs and capturedHandler is set
      await svc.render('<h1>test</h1>', { requestFilter: () => 'abort' });

      // Now invoke the handler directly to verify abort/continue routing
      expect(capturedHandler).toBeDefined();
      const abortMock = jest.fn(() => Promise.resolve());
      const continueMock = jest.fn(() => Promise.resolve());
      capturedHandler!({ resourceType: () => 'image', abort: abortMock, continue: continueMock });

      expect(abortMock).toHaveBeenCalled();
      expect(continueMock).not.toHaveBeenCalled();
      await svc.destroy();
    });
  });

  describe('buffer validation', () => {
    it('should throw ValidationError for empty buffer', async () => {
      const page = createMockPage();
      page.pdf = jest.fn(() => Promise.resolve(Buffer.alloc(0)));
      const browser = createMockBrowser();
      browser.newPage = jest.fn(() => Promise.resolve(page));
      mockPuppeteer.launch = jest.fn(() => Promise.resolve(browser));

      const svc = new RenderService({
        puppeteer: mockPuppeteer, logger: silentLogger,
        pool: { min: 1, max: 1, healthCheckInterval: 600000 },
      });
      // Attach listener so emit('error', plainObject) doesn't throw before the real error propagates
      svc.on('error', () => {});
      await expect(svc.render('<h1>test</h1>')).rejects.toThrow(ValidationError);
      await svc.destroy();
    });

    it('should accept a PDF buffer of exactly 100 bytes', async () => {
      const page = createMockPage();
      page.pdf = jest.fn(() => Promise.resolve(Buffer.alloc(100, 'x')));
      const browser = createMockBrowser();
      browser.newPage = jest.fn(() => Promise.resolve(page));
      mockPuppeteer.launch = jest.fn(() => Promise.resolve(browser));

      const svc = new RenderService({
        puppeteer: mockPuppeteer, logger: silentLogger,
        pool: { min: 1, max: 1, healthCheckInterval: 600000 },
      });
      const buf = await svc.render('<h1>test</h1>');
      expect(buf.length).toBe(100);
      await svc.destroy();
    });

    it('should throw ValidationError for a PDF buffer below 100 bytes', async () => {
      const page = createMockPage();
      page.pdf = jest.fn(() => Promise.resolve(Buffer.alloc(50, 'x')));
      const browser = createMockBrowser();
      browser.newPage = jest.fn(() => Promise.resolve(page));
      mockPuppeteer.launch = jest.fn(() => Promise.resolve(browser));

      const svc = new RenderService({
        puppeteer: mockPuppeteer, logger: silentLogger,
        pool: { min: 1, max: 1, healthCheckInterval: 600000 },
      });
      svc.on('error', () => {});
      await expect(svc.render('<h1>test</h1>')).rejects.toThrow(ValidationError);
      await svc.destroy();
    });
  });

  describe('convenience methods', () => {
    it('pdf() should call render with type pdf', async () => {
      const spy = jest.spyOn(service, 'render');
      await service.pdf('<h1>test</h1>', { pdf: { format: 'Letter' } });
      expect(spy).toHaveBeenCalledWith('<h1>test</h1>', { pdf: { format: 'Letter' }, type: 'pdf' });
    });

    it('png() should call render with type png', async () => {
      const spy = jest.spyOn(service, 'render');
      await service.png('<h1>test</h1>');
      expect(spy).toHaveBeenCalledWith('<h1>test</h1>', { type: 'png' });
    });

    it('jpeg() should call render with type jpeg', async () => {
      const spy = jest.spyOn(service, 'render');
      await service.jpeg('<h1>test</h1>');
      expect(spy).toHaveBeenCalledWith('<h1>test</h1>', { type: 'jpeg' });
    });

    it('webp() should call render with type webp', async () => {
      const spy = jest.spyOn(service, 'render');
      await service.webp('<h1>test</h1>');
      expect(spy).toHaveBeenCalledWith('<h1>test</h1>', { type: 'webp' });
    });
  });

  describe('getStats', () => {
    it('should return comprehensive stats', async () => {
      await service.render('<h1>test</h1>');

      const stats = service.getStats();
      expect(stats.renders.totalRenders).toBe(1);
      expect(stats.avgRenderTime).toBeGreaterThanOrEqual(0);
      expect(stats.pool).toEqual(
        expect.objectContaining({ total: expect.any(Number), active: expect.any(Number), idle: expect.any(Number) })
      );
      expect(stats.preprocessor).toBeNull();
    });

    it('should return 0 avgRenderTime when no renders performed', () => {
      expect(service.getStats().avgRenderTime).toBe(0);
    });
  });

  describe('destroy', () => {
    it('should mark as destroyed', async () => {
      await service.destroy();
      expect(service.isDestroyed).toBe(true);
    });

    it('should emit destroy event', async () => {
      const listener = jest.fn();
      service.on('destroy', listener);
      await service.destroy();
      expect(listener).toHaveBeenCalled();
    });

    it('should remove all listeners after destroy', async () => {
      service.on('render', jest.fn());
      await service.destroy();
      expect(service.listenerCount('render')).toBe(0);
    });
  });
});
