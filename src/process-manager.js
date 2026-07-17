'use strict';

const { spawn } = require('node:child_process');
const treeKill = require('tree-kill');
const chalk = require('chalk');
const { isPortFree } = require('./runtime');

function pipeLines(stream, output, prefix, color) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) output.write(`${chalk[color](`[${prefix}]`)} ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) output.write(`${chalk[color](`[${prefix}]`)} ${pending}\n`);
  });
}

function spawnSpec(spec) {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    windowsHide: false,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false
  });
  pipeLines(child.stdout, process.stdout, spec.name, spec.color);
  pipeLines(child.stderr, process.stderr, spec.name, spec.color);
  return child;
}

async function waitForListening(port, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await isPortFree(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function killTree(pid, signal = 'SIGTERM') {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    treeKill(pid, signal, () => resolve());
  });
}

async function runProcesses(specs, options = {}) {
  const children = [];
  let stopping = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    await Promise.all(children.filter((child) => child.exitCode === null)
      .map((child) => killTree(child.pid)));
    resolveDone(code);
  };

  const register = (spec) => {
    const child = spawnSpec(spec);
    children.push(child);
    child.once('error', (error) => {
      console.error(`[${spec.name}] failed to launch: ${error.message}`);
      stop(1);
    });
    child.once('exit', (code, signal) => {
      if (!stopping) {
        console.error(`[${spec.name}] exited (${signal || `code ${code}`}); stopping the other services.`);
        stop(code || 1);
      }
    });
  };

  register(specs.backend);
  if (options.waitForBackend > 0) {
    const ready = await waitForListening(options.backendPort, options.waitForBackend);
    if (!ready) {
      console.warn(`[Ports Manager] Backend did not listen within ${options.waitForBackend}ms; starting frontend anyway.`);
    }
  }
  register(specs.frontend);

  const onSignal = () => stop(0);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const code = await done;
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  return code;
}

module.exports = { killTree, pipeLines, runProcesses, spawnSpec, waitForListening };
