'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSpecs } = require('../src/runtime');

test('generated backend process receives selected PORT and configured env', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-manager-process-test-'));
  try {
    fs.writeFileSync(path.join(root, 'write-env.js'),
      `require('node:fs').writeFileSync('observed.json', JSON.stringify({PORT:process.env.PORT,CUSTOM:process.env.CUSTOM}));`);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: { start: 'node write-env.js' }
    }));
    const project = { directory: root, script: 'start', framework: 'generic', pkg: {} };
    const specs = buildSpecs(project, project, { backend: 4123, frontend: 4124 }, {
      proxy: false,
      apiPrefix: '/api',
      corsCredentials: true,
      env: { CUSTOM: 'backend-{backendPort}' }
    });
    const result = spawnSync(specs.backend.command, specs.backend.args, {
      cwd: specs.backend.cwd,
      env: { ...process.env, ...specs.backend.env },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'observed.json'), 'utf8')), {
      PORT: '4123',
      CUSTOM: 'backend-4123'
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
