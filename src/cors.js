'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHIM_SOURCE = String.raw`'use strict';
const http = require('node:http');
const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function portsManagerEmit(event, req, res) {
  if (event !== 'request' || !req || !res) {
    return originalEmit.apply(this, arguments);
  }
  const requestedOrigin = req.headers && req.headers.origin;
  const configuredOrigin = process.env.PORTS_MANAGER_CORS_ORIGIN;
  const origin = requestedOrigin || configuredOrigin;
  if (origin && !res.headersSent) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', mergeVary(res.getHeader('Vary'), 'Origin'));
    if (process.env.PORTS_MANAGER_CORS_CREDENTIALS !== 'false') {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods',
      req.headers['access-control-request-method'] || 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] || 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Content-Length', '0');
    res.end();
    return true;
  }
  return originalEmit.apply(this, arguments);
};
function mergeVary(current, value) {
  const values = String(current || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  return values.join(', ');
}
`;

function createCorsShim() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-manager-'));
  const filename = path.join(directory, 'cors-preload.cjs');
  fs.writeFileSync(filename, SHIM_SOURCE, { encoding: 'utf8', mode: 0o600 });
  return {
    filename,
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

module.exports = { SHIM_SOURCE, createCorsShim };
