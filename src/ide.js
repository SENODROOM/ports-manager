'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('jsonc-parser');
const { SHIM_SOURCE } = require('./cors');

const OWNED_PREFIX = 'Ports Manager:';

function isIdeTerminal(env = process.env) {
  return env.TERM_PROGRAM === 'vscode';
}

function readJsonc(filename, fallback) {
  if (!fs.existsSync(filename)) return fallback;
  const errors = [];
  const value = parse(fs.readFileSync(filename, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length || value === undefined) throw new Error(`cannot parse ${filename} as JSON with comments`);
  return value;
}

function taskFromSpec(label, spec) {
  return {
    label: `${OWNED_PREFIX} ${label}`,
    type: 'process',
    command: spec.command,
    args: spec.args,
    options: { cwd: spec.cwd, env: spec.env },
    presentation: {
      reveal: 'always',
      panel: 'dedicated',
      group: 'ports-manager',
      clear: true
    },
    isBackground: true,
    problemMatcher: []
  };
}

function mergeTasks(existing, specs, proxySpec) {
  const document = existing && typeof existing === 'object' ? existing : {};
  const unrelated = Array.isArray(document.tasks)
    ? document.tasks.filter((task) => !task || typeof task.label !== 'string' || !task.label.startsWith(OWNED_PREFIX))
    : [];
  const owned = [
    taskFromSpec('Backend', specs.backend),
    taskFromSpec('Frontend', specs.frontend)
  ];
  if (proxySpec) owned.push(taskFromSpec('Proxy', proxySpec));
  owned.push({
    label: `${OWNED_PREFIX} Run All`,
    dependsOn: owned.map((task) => task.label),
    dependsOrder: 'parallel',
    problemMatcher: [],
    runOptions: { reevaluateOnRerun: true }
  });
  return { ...document, version: document.version || '2.0.0', tasks: [...unrelated, ...owned] };
}

function mergeKeybindings(existing, key = 'ctrl+alt+p') {
  const entries = Array.isArray(existing) ? existing : [];
  const unrelated = entries.filter((entry) => entry && entry.portsManagerOwned !== true);
  return [...unrelated, {
    key,
    command: 'workbench.action.tasks.runTask',
    args: `${OWNED_PREFIX} Run All`,
    portsManagerOwned: true
  }];
}

function generateIdeFiles(root, specs, proxySpec, options = {}) {
  const { keybinding = 'ctrl+alt+p', needsShim = false, withKeybinding = false } = options;
  const vscode = path.join(root, '.vscode');
  fs.mkdirSync(vscode, { recursive: true });
  const tasksFile = path.join(vscode, 'tasks.json');
  const keybindingsFile = path.join(vscode, 'ports-manager-keybindings.json');
  if (needsShim) {
    const shimFile = path.join(vscode, 'ports-manager-cors-preload.cjs');
    fs.writeFileSync(shimFile, SHIM_SOURCE, 'utf8');
  }
  const tasks = mergeTasks(readJsonc(tasksFile, { version: '2.0.0', tasks: [] }), specs, proxySpec);
  fs.writeFileSync(tasksFile, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  if (withKeybinding) {
    const keybindings = mergeKeybindings(readJsonc(keybindingsFile, []), keybinding);
    fs.writeFileSync(keybindingsFile, `${JSON.stringify(keybindings, null, 2)}\n`, 'utf8');
  }
  return { tasksFile, keybindingsFile: withKeybinding ? keybindingsFile : null };
}

function shellQuote(value, platform = process.platform) {
  const text = String(value);
  if (/^[A-Za-z0-9_./\\:@%+=,-]+$/.test(text)) return text;
  if (platform === 'win32') {
    if (text.includes('"')) throw new Error('cannot safely quote a double quote for an unknown Windows terminal shell');
    return `"${text}"`;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function terminalCommand(spec, platform = process.platform) {
  return [spec.command, ...spec.args].map((part) => shellQuote(part, platform)).join(' ');
}

module.exports = {
  OWNED_PREFIX, generateIdeFiles, isIdeTerminal, mergeKeybindings, mergeTasks,
  readJsonc, shellQuote, taskFromSpec, terminalCommand
};
