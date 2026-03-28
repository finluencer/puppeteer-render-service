/**
 * Express integration example
 *
 * Run: node examples/express-integration.js
 * Test: curl -X POST http://localhost:3000/render \
 *         -H "Content-Type: application/json" \
 *         -d '{"html":"<h1>Hello</h1>","type":"pdf"}' \
 *         --output test.pdf
 */
const express = require('express');
const puppeteer = require('puppeteer');
const { createRenderService } = require('../src');

const app = express();
const renderer = createRenderService({
  puppeteer,
  pool: { min: 1, max: 4 },
});

app.use(express.json({ limit: '10mb' }));

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

app.post('/render', async (req, res) => {
  try {
    const { html, type = 'pdf', options = {} } = req.body;

    if (!html) {
      return res.status(400).json({ error: 'html is required' });
    }

    const buffer = await renderer.render(html, { type, ...options });

    res.set('Content-Type', CONTENT_TYPES[type] || 'application/octet-stream');
    res.set('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) {
    const status = error.code === 'VALIDATION_ERROR' ? 400 : 500;
    res.status(status).json({ error: error.message, code: error.code });
  }
});

app.get('/stats', (req, res) => {
  res.json(renderer.getStats());
});

app.get('/health', (req, res) => {
  const stats = renderer.getStats();
  const healthy = stats.pool.total > 0;
  res.status(healthy ? 200 : 503).json({ healthy, ...stats });
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Render service running on http://localhost:${PORT}`);
  console.log(`POST /render  - Render HTML to PDF/Image`);
  console.log(`GET  /stats   - Service statistics`);
  console.log(`GET  /health  - Health check`);
});

// Graceful shutdown
async function shutdown() {
  console.log('\nShutting down...');
  server.close();
  await renderer.destroy();
  console.log('Done');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
