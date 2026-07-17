'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { cosmiconfig } = require('cosmiconfig');

const DEFAULTS = Object.freeze({
  pairs: [['frontend', 'backend'], ['client', 'server']],
  portRange: [4000, 4999],
  bannedPorts: [3000, 5000],
  cors: true,
  forceCors: false,
  corsCredentials: true,
  proxy: false,
  apiPrefix: '/api',
  ideTerminals: 'off',
  waitForBackend: 0,
  withKeybinding: false,
  keybinding: 'ctrl+alt+p',
  env: {}
});

const allowedKeys = new Set([
  'pairs', 'frontend', 'backend', 'frontendPort', 'backendPort', 'proxyPort', 'portRange',
  'bannedPorts', 'cors', 'forceCors', 'corsCredentials', 'proxy', 'apiPrefix',
  'ideTerminals', 'waitForBackend', 'withKeybinding', 'keybinding', 'env'
]);

function normalizeConfig(input) {
  const config = { ...input };
  if (config.cors && typeof config.cors === 'object' && !Array.isArray(config.cors)) {
    const cors = config.cors;
    config.cors = cors.mode !== 'off' && cors.enabled !== false;
    if (cors.credentials !== undefined) config.corsCredentials = cors.credentials;
  }
  if (config.proxy && typeof config.proxy === 'object' && !Array.isArray(config.proxy)) {
    config.proxy = config.proxy.enabled === true;
  }
  if (config.ideTerminals && typeof config.ideTerminals === 'object' &&
      !Array.isArray(config.ideTerminals)) {
    const ide = config.ideTerminals;
    config.ideTerminals = ide.mode || 'off';
    if (ide.withKeybinding !== undefined) config.withKeybinding = ide.withKeybinding;
    if (ide.keybinding !== undefined) config.keybinding = ide.keybinding;
  }
  return config;
}

function assertPort(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('configuration must be a JSON object');
  }
  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) throw new Error(`unknown configuration key: ${key}`);
  }
  if (config.pairs !== undefined) {
    if (!Array.isArray(config.pairs) || config.pairs.length === 0 ||
        config.pairs.some((pair) => !Array.isArray(pair) || pair.length !== 2 ||
          pair.some((name) => typeof name !== 'string' || !name.trim()))) {
      throw new Error('pairs must be a non-empty array of [frontend, backend] directory names');
    }
  }
  for (const key of ['frontendPort', 'backendPort', 'proxyPort']) {
    if (config[key] !== undefined) assertPort(config[key], key);
  }
  if (config.portRange !== undefined) {
    if (!Array.isArray(config.portRange) || config.portRange.length !== 2) {
      throw new Error('portRange must be [minimum, maximum]');
    }
    config.portRange.forEach((port, index) => assertPort(port, `portRange[${index}]`));
    if (config.portRange[0] > config.portRange[1]) throw new Error('portRange minimum exceeds maximum');
  }
  if (config.bannedPorts !== undefined) {
    if (!Array.isArray(config.bannedPorts)) throw new Error('bannedPorts must be an array');
    config.bannedPorts.forEach((port, index) => assertPort(port, `bannedPorts[${index}]`));
  }
  for (const key of ['cors', 'forceCors', 'corsCredentials', 'proxy', 'withKeybinding']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') {
      throw new Error(`${key} must be boolean`);
    }
  }
  if (config.apiPrefix !== undefined &&
      (typeof config.apiPrefix !== 'string' || !config.apiPrefix.startsWith('/'))) {
    throw new Error('apiPrefix must be a string beginning with /');
  }
  if (config.ideTerminals !== undefined &&
      !['off', 'auto', 'tasks', 'extension'].includes(config.ideTerminals)) {
    throw new Error('ideTerminals must be off, auto, tasks, or extension');
  }
  if (config.waitForBackend !== undefined &&
      (!Number.isInteger(config.waitForBackend) || config.waitForBackend < 0)) {
    throw new Error('waitForBackend must be a non-negative integer (milliseconds)');
  }
  if (config.env !== undefined &&
      (!config.env || typeof config.env !== 'object' || Array.isArray(config.env))) {
    throw new Error('env must be an object');
  }
  return config;
}

async function loadConfig(cwd, explicitPath) {
  let loaded = {};
  let filepath;
  if (explicitPath) {
    filepath = path.resolve(cwd, explicitPath);
    let raw;
    try {
      raw = fs.readFileSync(filepath, 'utf8');
    } catch (error) {
      throw new Error(`cannot read config ${filepath}: ${error.message}`);
    }
    try {
      loaded = JSON.parse(raw);
    } catch (error) {
      throw new Error(`invalid JSON in ${filepath}: ${error.message}`);
    }
  } else {
    const explorer = cosmiconfig('ports-manager', {
      searchPlaces: ['ports-manager.config.json', '.ports-managerrc', '.ports-managerrc.json']
    });
    const result = await explorer.search(cwd);
    if (result) {
      loaded = result.config;
      filepath = result.filepath;
    }
  }
  loaded = normalizeConfig(loaded);
  validateConfig(loaded);
  return { config: loaded, filepath };
}

function mergeConfig(fileConfig, cliConfig) {
  fileConfig = normalizeConfig(fileConfig);
  const result = { ...DEFAULTS, ...fileConfig };
  for (const [key, value] of Object.entries(cliConfig)) {
    if (allowedKeys.has(key) && value !== undefined) result[key] = value;
  }
  result.bannedPorts = [...new Set([
    3000, 5000, ...(fileConfig.bannedPorts || []), ...(cliConfig.bannedPorts || [])
  ])];
  validateConfig(result);
  return result;
}

module.exports = { DEFAULTS, loadConfig, mergeConfig, normalizeConfig, validateConfig };
