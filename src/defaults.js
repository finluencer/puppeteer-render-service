const DEFAULTS = {
  pool: {
    min: 1,
    max: 3,
    acquireTimeout: 15000,
    maxUsesPerBrowser: 500,
    healthCheckInterval: 300000,
  },

  cache: {
    enabled: true,
    maxSizeBytes: 100 * 1024 * 1024,
    maxEntries: 1000,
    ttl: 3600000,
    evictionPercent: 0.3,
  },

  circuitBreaker: {
    enabled: true,
    maxFailures: 5,
    resetTimeout: 30000,
  },

  browser: {
    headless: true,
    timeout: 10000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-background-networking',
      '--hide-scrollbars',
      '--font-render-hinting=none',
      '--disable-accelerated-2d-canvas',
      '--disable-translate',
      '--disable-extensions',
      '--disable-sync',
      '--disable-default-apps',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  },

  pdf: {
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    landscape: false,
    scale: 1,
    timeout: 10000,
    margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
  },

  image: {
    type: 'png',
    quality: 85,
    fullPage: false,
    omitBackground: false,
    timeout: 15000,
    viewport: { width: 1200, height: 630, deviceScaleFactor: 1 },
  },

  page: {
    javascript: false,
    navigationTimeout: 8000,
    defaultTimeout: 8000,
    retries: 2,
    retryDelay: 200,
    viewport: { width: 1024, height: 1400, deviceScaleFactor: 1 },
  },

  outputTypes: {
    pdf: 'pdf',
    png: 'png',
    jpeg: 'jpeg',
    webp: 'webp',
  },
};

module.exports = DEFAULTS;
