const RenderService = require('./RenderService');
const BrowserPool = require('./BrowserPool');
const ImageCache = require('./ImageCache');
const ImagePreprocessor = require('./ImagePreprocessor');
const CircuitBreaker = require('./CircuitBreaker');
const errors = require('./errors');
const DEFAULTS = require('./defaults');

function createRenderService(options) {
  return new RenderService(options);
}

module.exports = {
  createRenderService,
  RenderService,
  BrowserPool,
  ImageCache,
  ImagePreprocessor,
  CircuitBreaker,
  DEFAULTS,
  ...errors,
};
