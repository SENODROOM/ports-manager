'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { SHIM_SOURCE } = require('../src/cors');
const { appendNodeRequire } = require('../src/runtime');

test('CORS preload reflects origin and handles OPTIONS before the app', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-manager-cors-test-'));
  const shim = path.join(directory, 'shim.cjs');
  const serverFile = path.join(directory, 'server.cjs');
  fs.writeFileSync(shim, SHIM_SOURCE);
  fs.writeFileSync(serverFile, `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', 'http://stale.invalid');
      res.end('app');
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `);
  const child = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      NODE_OPTIONS: appendNodeRequire(process.env.NODE_OPTIONS || '', shim),
      PORTS_MANAGER_CORS_ORIGIN: 'http://127.0.0.1:4001',
      PORTS_MANAGER_CORS_CREDENTIALS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const port = await readPort(child);
    const get = await request(port, 'GET', {
      Origin: 'http://127.0.0.1:4001'
    });
    // The application intentionally overwrites the shim on GET. This demonstrates why
    // static detection is used to avoid combining the shim with application CORS logic.
    assert.equal(get.body, 'app');
    const options = await request(port, 'OPTIONS', {
      Origin: 'http://127.0.0.1:4001',
      'Access-Control-Request-Headers': 'X-Test, Authorization',
      'Access-Control-Request-Method': 'PATCH'
    });
    assert.equal(options.status, 204);
    assert.equal(options.headers['access-control-allow-origin'], 'http://127.0.0.1:4001');
    assert.equal(options.headers['access-control-allow-credentials'], 'true');
    assert.equal(options.headers['access-control-allow-headers'], 'X-Test, Authorization');
    assert.equal(options.headers['access-control-allow-methods'], 'PATCH');
    assert.equal(options.headers['content-length'], '0');
  } finally {
    child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function readPort(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('server startup timed out')), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/\b(\d{2,5})\b/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited early with ${code}`)));
  });
}

function request(port, method, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body
      }));
    });
    request.on('error', reject);
    request.end();
  });
}
