const RenderService = require('../src/RenderService');
const { ValidationError } = require('../src/errors');

// Mocks
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
  let service;
  let mockPuppeteer;

  beforeEach(() => {
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
      expect(() => new RenderService({})).toThrow('puppeteer is required');
    });

    it('should initialize with defaults', () => {
      expect(service.isDestroyed).toBe(false);
      expect(service.metrics.totalRenders).toBe(0);
    });

    it('should accept custom templates', () => {
      const footer = (meta) => `<div>${meta.name}</div>`;
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
      expect(buffer.length).toBeGreaterThan(1000);
    });

    it('should generate an image buffer for png type', async () => {
      const buffer = await service.render('<h1>Hello</h1>', { type: 'png' });
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(100);
    });

    it('should throw ValidationError for empty HTML', async () => {
      await expect(service.render('')).rejects.toThrow(ValidationError);
      await expect(service.render(null)).rejects.toThrow(ValidationError);
      await expect(service.render(123)).rejects.toThrow(ValidationError);
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

    it('should increment error metrics on failure', async () => {
      // Make page.pdf throw
      const badBrowser = createMockBrowser();
      const badPage = createMockPage();
      badPage.pdf = jest.fn(() => Promise.reject(new Error('pdf failed')));
      badBrowser.newPage = jest.fn(() => Promise.resolve(badPage));
      mockPuppeteer.launch = jest.fn(() => Promise.resolve(badBrowser));

      const svc = new RenderService({
        puppeteer: mockPuppeteer,
        logger: silentLogger,
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
        expect.objectContaining({
          type: 'pdf',
          duration: expect.any(Number),
          bufferSize: expect.any(Number),
        })
      );
    });

    it('should emit error event on failure', async () => {
      const badBrowser = createMockBrowser();
      const badPage = createMockPage();
      badPage.pdf = jest.fn(() => Promise.reject(new Error('boom')));
      badBrowser.newPage = jest.fn(() => Promise.resolve(badPage));
      mockPuppeteer.launch = jest.fn(() => Promise.resolve(badBrowser));

      const svc = new RenderService({
        puppeteer: mockPuppeteer,
        logger: silentLogger,
        pool: { min: 1, max: 1, healthCheckInterval: 600000 },
      });

      const errorListener = jest.fn();
      svc.on('error', errorListener);

      await expect(svc.render('<h1>test</h1>')).rejects.toThrow();
      expect(errorListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pdf',
          error: expect.any(Error),
        })
      );
      await svc.destroy();
    });
  });

  describe('convenience methods', () => {
    it('pdf() should call render with type pdf', async () => {
      const spy = jest.spyOn(service, 'render');
      await service.pdf('<h1>test</h1>', { pdf: { format: 'Letter' } });
      expect(spy).toHaveBeenCalledWith('<h1>test</h1>', {
        pdf: { format: 'Letter' },
        type: 'pdf',
      });
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
        expect.objectContaining({
          total: expect.any(Number),
          active: expect.any(Number),
          idle: expect.any(Number),
        })
      );
      expect(stats.preprocessor).toBeNull();
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
  });
});
