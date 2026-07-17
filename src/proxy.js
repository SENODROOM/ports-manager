'use strict';

const http = require('node:http');

function loadProxyFactory() {
  try {
    return require('http-proxy-middleware').createProxyMiddleware;
  } catch {
    throw new Error('proxy mode requires http-proxy-middleware; reinstall optional dependencies with npm install');
  }
}

function startProxy({ port, frontendPort, backendPort, apiPrefix }, logger = console) {
  const createProxyMiddleware = loadProxyFactory();
  const onError = (error, req, res) => {
    logger.error(`[Proxy] ${error.message}`);
    if (res && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Ports Manager proxy target unavailable');
    }
  };
  const backend = createProxyMiddleware({
    target: `http://127.0.0.1:${backendPort}`,
    changeOrigin: true,
    ws: true,
    on: { error: onError }
  });
  const frontend = createProxyMiddleware({
    target: `http://127.0.0.1:${frontendPort}`,
    changeOrigin: true,
    ws: true,
    on: { error: onError }
  });
  const server = http.createServer((req, res) => {
    const selected = req.url === apiPrefix || req.url.startsWith(`${apiPrefix}/`) ? backend : frontend;
    selected(req, res, (error) => onError(error || new Error('proxy request was not handled'), req, res));
  });
  server.on('upgrade', (req, socket, head) => {
    const selected = req.url === apiPrefix || req.url.startsWith(`${apiPrefix}/`) ? backend : frontend;
    selected.upgrade(req, socket, head);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      logger.log(`[Proxy] http://127.0.0.1:${port} (${apiPrefix} -> backend)`);
      resolve({
        close: () => new Promise((done) => server.close(done)),
        server
      });
    });
  });
}

module.exports = { startProxy };
