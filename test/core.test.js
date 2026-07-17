'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { mergeConfig, normalizeConfig, validateConfig } = require('../src/config');
const { classifyProject, detectFolders } = require('../src/detect');
const { allocatePorts, appendNodeRequire, buildSpecs, renderEnv } = require('../src/runtime');
const { generateIdeFiles, mergeKeybindings, mergeTasks } = require('../src/ide');
const { parseArgs } = require('../src/cli');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ports-manager-test-'));
}

function project(root, name, pkg) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(pkg));
  return directory;
}

test('configuration precedence is CLI over file over defaults', () => {
  const merged = mergeConfig(
    { frontendPort: 4100, cors: false, bannedPorts: [4102] },
    { frontendPort: 4200, bannedPorts: [4202] }
  );
  assert.equal(merged.frontendPort, 4200);
  assert.equal(merged.cors, false);
  assert.deepEqual(merged.bannedPorts.sort(), [3000, 4102, 4202, 5000]);
  assert.throws(() => validateConfig({ surprise: true }), /unknown/);
});

test('documented config shape and CLI flag names normalize correctly', () => {
  const normalized = normalizeConfig({
    pairs: [['web', 'api']],
    cors: { mode: 'shim', credentials: false },
    proxy: { enabled: true },
    ideTerminals: { mode: 'tasks', withKeybinding: true }
  });
  assert.equal(normalized.cors, true);
  assert.equal(normalized.corsCredentials, false);
  assert.equal(normalized.proxy, true);
  assert.equal(normalized.ideTerminals, 'tasks');
  assert.equal(normalized.withKeybinding, true);
  validateConfig(normalized);

  const flags = parseArgs([
    '--frontend-dir', 'web', '--backend-dir=api', '--ban', '3001,3002',
    '--range=4100-4200', '--no-cors-shim', '--ide-terminals', '--with-keybinding'
  ]);
  assert.equal(flags.frontend, 'web');
  assert.equal(flags.backend, 'api');
  assert.deepEqual(flags.bannedPorts, [3001, 3002]);
  assert.deepEqual(flags.portRange, [4100, 4200]);
  assert.equal(flags.cors, false);
  assert.equal(flags.ideTerminals, 'auto');
  assert.equal(flags.withKeybinding, true);
});

test('folder detection supports both conventions and reports ambiguity and child use', () => {
  const root = temp();
  try {
    project(root, 'frontend', { scripts: { start: 'x' } });
    project(root, 'backend', { scripts: { start: 'x' } });
    const pair = detectFolders(root);
    assert.equal(path.basename(pair.frontend), 'frontend');
    assert.throws(() => detectFolders(path.join(root, 'frontend')), /parent directory/);
    project(root, 'client', { scripts: { start: 'x' } });
    project(root, 'server', { scripts: { start: 'x' } });
    assert.throws(() => detectFolders(root), /ambiguous/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('framework and script detection reads dependencies and prefers dev', () => {
  const root = temp();
  try {
    const vite = project(root, 'frontend', {
      scripts: { start: 'vite preview', dev: 'vite' },
      devDependencies: { vite: '^6' }
    });
    const express = project(root, 'backend', {
      scripts: { start: 'node index.js' },
      dependencies: { express: '^5' }
    });
    assert.deepEqual(
      [classifyProject(vite, 'frontend').framework, classifyProject(vite, 'frontend').script],
      ['vite', 'dev']
    );
    assert.equal(classifyProject(express, 'backend').framework, 'express');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('port allocation always bans 3000/5000 and returns distinct free explicit ports', async () => {
  const first = await freePort();
  let second = await freePort();
  while (second === first) second = await freePort();
  const base = { portRange: [4000, 4999], bannedPorts: [], backendPort: first, frontendPort: second };
  await assert.rejects(allocatePorts({ ...base, backendPort: 3000 }, 2), /banned/);
  assert.deepEqual(await allocatePorts(base, 2), [first, second]);
});

test('framework strategies set commands, strict ports, API env, templates, and NODE_OPTIONS', () => {
  const frontend = {
    directory: '/front', script: 'dev', framework: 'vite', role: 'frontend', pkg: {}
  };
  const backend = {
    directory: '/back', script: 'start', framework: 'express', role: 'backend', pkg: {}
  };
  const config = {
    proxy: false, apiPrefix: '/api', corsCredentials: true,
    env: {
      backend: { CUSTOM_URL: 'http://x:{backendPort}/{frontendPort}' },
      frontend: { FRONTEND_ONLY: '{apiPrefix}' }
    }
  };
  const specs = buildSpecs(frontend, backend, { frontend: 4001, backend: 4000 }, config, '/tmp/a b.cjs');
  assert.deepEqual(specs.frontend.args.slice(-4), ['--', '--port', '4001', '--strictPort']);
  assert.equal(specs.frontend.env.VITE_API_URL, 'http://127.0.0.1:4000');
  assert.equal(specs.backend.env.PORT, '4000');
  assert.equal(specs.backend.env.CUSTOM_URL, 'http://x:4000/4001');
  assert.equal(specs.frontend.env.FRONTEND_ONLY, '/api');
  assert.equal(specs.backend.env.FRONTEND_ONLY, undefined);
  assert.match(specs.backend.env.NODE_OPTIONS, /--require/);
  assert.equal(renderEnv({ X: '{apiPrefix}:{proxyPort}' }, { apiPrefix: '/v1', proxyPort: 4010 }).X, '/v1:4010');
  assert.match(appendNodeRequire('--trace-warnings', 'C:\\a b\\shim.cjs'), /^--trace-warnings --require "/);
});

test('task and keybinding merges preserve unrelated entries and are idempotent', () => {
  const spec = { cwd: '/x', command: 'npm', args: ['run', 'dev'], env: {}, name: 'x' };
  const existing = { version: '2.0.0', tasks: [{ label: 'Keep', type: 'shell', command: 'echo yes' }] };
  const once = mergeTasks(existing, { backend: spec, frontend: spec });
  const twice = mergeTasks(once, { backend: spec, frontend: spec });
  assert.deepEqual(twice, once);
  assert.equal(twice.tasks.filter((item) => item.label === 'Keep').length, 1);
  const keys = mergeKeybindings(mergeKeybindings([{ key: 'f1', command: 'keep' }]));
  assert.equal(keys.length, 2);
  assert.equal(keys.filter((entry) => entry.portsManagerOwned).length, 1);
});

test('task files preserve user tasks and keybinding output is opt-in', () => {
  const root = temp();
  const vscode = path.join(root, '.vscode');
  const spec = { cwd: '/x', command: 'npm', args: ['run', 'dev'], env: {}, name: 'x' };
  try {
    fs.mkdirSync(vscode);
    fs.writeFileSync(path.join(vscode, 'tasks.json'), JSON.stringify({
      version: '2.0.0',
      tasks: [{ label: 'Keep', type: 'shell', command: 'echo yes' }]
    }));
    generateIdeFiles(root, { backend: spec, frontend: spec });
    generateIdeFiles(root, { backend: spec, frontend: spec });
    const tasks = JSON.parse(fs.readFileSync(path.join(vscode, 'tasks.json'), 'utf8'));
    assert.equal(tasks.tasks.filter((task) => task.label === 'Keep').length, 1);
    assert.equal(tasks.tasks.filter((task) => task.label === 'Ports Manager: Backend').length, 1);
    assert.equal(fs.existsSync(path.join(vscode, 'ports-manager-keybindings.json')), false);

    generateIdeFiles(root, { backend: spec, frontend: spec }, null, {
      withKeybinding: true,
      keybinding: 'ctrl+alt+p'
    });
    assert.equal(fs.existsSync(path.join(vscode, 'ports-manager-keybindings.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
