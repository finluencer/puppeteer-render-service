# puppeteer-render-service

A high-performance HTML rendering library built on Puppeteer with browser pooling, caching, and resilience features.

---

## Installation

```bash
npm install puppeteer-render-service
```

> `puppeteer` is a peer dependency and must be installed separately:

```bash
npm install puppeteer
```

---

## Quick Start

```js
const puppeteer = require('puppeteer');
const { createRenderService } = require('puppeteer-render-service');

const renderer = createRenderService({ puppeteer });

(async () => {
  const pdfBuffer = await renderer.pdf('<h1>Hello World</h1>');
  const pngBuffer = await renderer.png('<h1>Hello World</h1>');
  await renderer.destroy();
})();
```

---

## API

### `createRenderService(options)`

Creates and returns a new `RenderService` instance.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `puppeteer` | object | **required** | Puppeteer instance |
| `pool.min` | number | `1` | Minimum browsers in pool |
| `pool.max` | number | `3` | Maximum browsers in pool |
| `pool.acquireTimeout` | number | `15000` | Max wait to acquire browser (ms) |
| `pool.maxUsesPerBrowser` | number | `500` | Recycle browser after N uses |
| `pool.healthCheckInterval` | number | `300000` | Health check interval (ms) |
| `browser.headless` | boolean | `true` | Run browser headless |
| `browser.timeout` | number | `10000` | Browser launch timeout (ms) |
| `browser.args` | string[] | see defaults | Chrome launch flags |
| `pdf` | object | see defaults | Puppeteer PDF options |
| `image` | object | see defaults | Screenshot options |
| `page` | object | see defaults | Page settings |
| `cache` | object | see defaults | Image preprocessor cache config |
| `circuitBreaker` | object | see defaults | Circuit breaker config |
| `headerTemplate` | function | `null` | `(metadata) => htmlString` for PDF header |
| `footerTemplate` | function | `null` | `(metadata) => htmlString` for PDF footer |
| `imagePreprocessor` | object | `null` | Enable image preprocessing in HTML |
| `logger` | object | `console` | Custom logger (`{ log, warn, error }`) |

---

## Rendering

### `renderer.render(html, options)`

Renders HTML and returns a `Buffer`.

```js
const buffer = await renderer.render('<h1>Hello</h1>', { type: 'pdf' });
```

#### Options

| Option | Type | Description |
|---|---|---|
| `type` | `'pdf' \| 'png' \| 'jpeg' \| 'webp'` | Output format (default: `'pdf'`) |
| `pdf` | object | Override PDF options for this render |
| `image` | object | Override image options for this render |
| `image.selector` | string | CSS selector — screenshot that element only |
| `image.clip` | object | `{ x, y, width, height }` clip region |
| `image.fullPage` | boolean | Capture full scrollable page |
| `page` | object | Override page options for this render |
| `metadata` | object | Passed to `headerTemplate`/`footerTemplate` |
| `preprocessor` | object | Image preprocessing options |
| `requestFilter` | function | `(request) => 'abort' \| 'continue'` |

---

## Convenience Methods

All convenience methods accept the same `options` as `render()` (minus `type`).

```js
await renderer.pdf(html, options);
await renderer.png(html, options);
await renderer.jpeg(html, options);
await renderer.webp(html, options);
```

---

## Stats

```js
const stats = renderer.getStats();
// {
//   renders: { totalRenders, totalTime, errors, byType },
//   avgRenderTime,
//   pool: { total, active, idle, waiting },
//   preprocessor
// }
```

---

## Cleanup

```js
await renderer.destroy();
```

---

## Events

`RenderService` extends `EventEmitter`.

```js
renderer.on('render', ({ type, duration, bufferSize }) => {
  console.log(`Rendered ${type} in ${duration}ms`);
});

renderer.on('error', ({ error, type, duration, htmlLength }) => {
  console.error(error);
});

renderer.on('destroy', () => {
  console.log('Service shut down');
});
```

| Event | Payload | Description |
|---|---|---|
| `render` | `{ type, duration, bufferSize }` | Successful render |
| `error` | `{ error, type, duration, htmlLength }` | Render failure |
| `destroy` | — | Service shutdown |

---

## Examples

### PDF with Header and Footer

```js
const renderer = createRenderService({
  puppeteer,
  headerTemplate: (meta) => `
    <div style="font-size:10px;width:100%;text-align:right;padding-right:20px;">
      ${meta.title}
    </div>
  `,
  footerTemplate: (meta) => `
    <div style="font-size:10px;width:100%;text-align:center;">
      ${meta.companyName} — Page <span class="pageNumber"></span> of <span class="totalPages"></span>
    </div>
  `,
  pdf: {
    margin: { bottom: '60px', top: '50px' },
  },
});

const buffer = await renderer.pdf('<h1>Invoice</h1>', {
  metadata: { companyName: 'Acme Corp', title: 'Q1 Report' },
});
```

### Screenshot a Specific Element

```js
const buffer = await renderer.png(html, {
  image: { selector: '#chart' },
});
```

### Clip a Region

```js
const buffer = await renderer.png(html, {
  image: { clip: { x: 0, y: 0, width: 800, height: 400 } },
});
```

### Block External Requests

```js
const buffer = await renderer.render(html, {
  type: 'pdf',
  requestFilter: (req) => req.url().startsWith('https://external.com') ? 'abort' : 'continue',
});
```

### Express Integration

```js
const express = require('express');
const puppeteer = require('puppeteer');
const { createRenderService } = require('puppeteer-render-service');

const app = express();
app.use(express.json());

const renderer = createRenderService({ puppeteer });

app.post('/render', async (req, res) => {
  const { html, type = 'pdf' } = req.body;
  const buffer = await renderer.render(html, { type });
  res.set('Content-Type', type === 'pdf' ? 'application/pdf' : `image/${type}`);
  res.send(buffer);
});

app.listen(3000);
```

---

## Default Configuration

```js
{
  pool: {
    min: 1,
    max: 3,
    acquireTimeout: 15000,
    maxUsesPerBrowser: 500,
    healthCheckInterval: 300000,
  },
  cache: {
    enabled: true,
    maxSizeBytes: 104857600, // 100 MB
    maxEntries: 1000,
    ttl: 3600000,            // 1 hour
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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', /* ... */],
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
}
```

---

## Error Types

| Error | Code | Description |
|---|---|---|
| `ValidationError` | `VALIDATION_ERROR` | Invalid input (empty HTML, missing element, etc.) |
| `RenderTimeoutError` | `RENDER_TIMEOUT` | Content loading or render timed out |
| `BrowserPoolError` | `BROWSER_POOL_ERROR` | Could not acquire browser from pool |
| `CircuitBreakerOpenError` | `CIRCUIT_BREAKER_OPEN` | Too many consecutive failures |

```js
const { ValidationError, RenderTimeoutError } = require('puppeteer-render-service');

try {
  await renderer.render('');
} catch (err) {
  if (err instanceof ValidationError) {
    console.error('Bad input:', err.message);
  } else if (err instanceof RenderTimeoutError) {
    console.error('Timed out:', err.message);
  }
}
```

---

## Exports

```js
const {
  createRenderService,  // factory function (recommended)
  RenderService,        // class
  BrowserPool,
  ImageCache,
  ImagePreprocessor,
  CircuitBreaker,
  DEFAULTS,
  ValidationError,
  RenderTimeoutError,
  BrowserPoolError,
  CircuitBreakerOpenError,
} = require('puppeteer-render-service');
```

---

## Testing

```bash
npm test
npm run test:watch
npm run lint
```

Tested on Node.js 16, 18, 20, 22.

---

## License

MIT — see [LICENSE](LICENSE)

---

Made by **Finluencer**
