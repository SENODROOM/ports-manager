'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, mergeConfig } = require('./config');
const { detectFolders, classifyProject, scanBackend } = require('./detect');
const { allocatePorts, buildSpecs } = require('./runtime');
const { createCorsShim } = require('./cors');
const { runProcesses } = require('./process-manager');
const { startProxy } = require('./proxy');
const { generateIdeFiles, isIdeTerminal } = require('./ide');
const { launchInBridge, stopBridge } = require('./bridge-client');
const pkg = require('../package.json');

const HELP = `ports-manager [options]

Detect and run a paired frontend/backend JavaScript project.

  --frontend-dir PATH      Override frontend/client directory
  --backend-dir PATH       Override backend/server directory
  --frontend-port PORT     Request frontend port
  --backend-port PORT      Request backend port
  --proxy-port PORT        Request same-origin proxy port
  --range MIN-MAX          Port search range (default 4000-4999)
  --ban PORTS              Ban comma-separated ports
  --cors / --no-cors-shim  Enable/disable the CORS preload shim
  --force-cors             Inject shim even when CORS is heuristically detected
  --cors-credentials BOOL  Whether shim emits credential support
  --proxy                  Enable same-origin proxy mode
  --api-prefix PATH        Backend proxy prefix (default /api)
  --wait-for-backend[=MS]  Wait before frontend (bare form: 10000ms)
  --ide-terminals[=MODE]   auto, off, tasks, extension (bare form: auto)
  --with-keybinding        Generate a user-keybindings reference file
  --keybinding KEY         Reference shortcut (default ctrl+alt+p)
  --config PATH            Explicit JSON config
  --dry-run                Inspect and allocate without writes/processes
  --stop                   Ask the bridge to stop this workspace's terminals
  --help                    Show help
  --version, -v             Show version and author
`;

function valueFor(argv, index, name) {
  const argument = argv[index];
  const equals = argument.indexOf('=');
  if (equals !== -1) return { value: argument.slice(equals + 1), consumed: 0 };
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return { value: argv[index + 1], consumed: 1 };
}

function integer(value, name) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  return Number(value);
}

function boolean(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function parseArgs(argv) {
  const options = { bannedPorts: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = argument.split('=')[0];
    if (name === '--help' || name === '-h') options.help = true;
    else if (name === '--version' || name === '-v') options.version = true;
    else if (name === '--dry-run') options.dryRun = true;
    else if (name === '--stop') options.stop = true;
    else if (name === '--proxy') options.proxy = true;
    else if (name === '--no-proxy') options.proxy = false;
    else if (name === '--cors') options.cors = true;
    else if (name === '--no-cors') options.cors = false;
    else if (name === '--no-cors-shim') options.cors = false;
    else if (name === '--force-cors') options.forceCors = true;
    else if (name === '--with-keybinding') options.withKeybinding = true;
    else if (name === '--no-cors-credentials') options.corsCredentials = false;
    else if (name === '--internal-proxy') {
      options.internalProxy = true;
    } else if (name === '--ide-terminals') {
      if (argument.includes('=')) options.ideTerminals = argument.slice(argument.indexOf('=') + 1) || 'auto';
      else if (argv[index + 1] && !argv[index + 1].startsWith('--') &&
          ['off', 'auto', 'tasks', 'extension'].includes(argv[index + 1])) {
        options.ideTerminals = argv[++index];
      } else options.ideTerminals = 'auto';
    } else if (name === '--wait-for-backend') {
      if (argument.includes('=')) options.waitForBackend = integer(argument.split('=').slice(1).join('='), name);
      else if (argv[index + 1] && /^\d+$/.test(argv[index + 1])) options.waitForBackend = integer(argv[++index], name);
      else options.waitForBackend = 10000;
    } else {
      const mapping = {
        '--frontend': 'frontend', '--backend': 'backend',
        '--frontend-dir': 'frontend', '--backend-dir': 'backend', '--config': 'configPath',
        '--api-prefix': 'apiPrefix', '--keybinding': 'keybinding',
        '--frontend-port': 'frontendPort', '--backend-port': 'backendPort',
        '--proxy-port': 'proxyPort', '--cors-credentials': 'corsCredentials',
        '--port-range': 'portRange', '--range': 'portRange',
        '--ban-port': 'banPort', '--ban': 'ban',
        '--proxy-frontend-port': 'proxyFrontendPort', '--proxy-backend-port': 'proxyBackendPort'
      };
      const key = mapping[name];
      if (!key) throw new Error(`unknown option: ${argument}`);
      const found = valueFor(argv, index, name);
      index += found.consumed;
      if (['frontendPort', 'backendPort', 'proxyPort', 'proxyFrontendPort', 'proxyBackendPort'].includes(key)) {
        options[key] = integer(found.value, name);
      } else if (key === 'corsCredentials') {
        options[key] = boolean(found.value, name);
      } else if (key === 'banPort') {
        options.bannedPorts.push(integer(found.value, name));
      } else if (key === 'ban') {
        const ports = found.value.split(',').map((value) => value.trim()).filter(Boolean);
        if (!ports.length) throw new Error('--ban requires a comma-separated port list');
        options.bannedPorts.push(...ports.map((value) => integer(value, name)));
      } else if (key === 'portRange') {
        const match = found.value.match(/^(\d+)-(\d+)$/);
        if (!match) throw new Error('--port-range must be MIN-MAX');
        options.portRange = [Number(match[1]), Number(match[2])];
      } else options[key] = found.value;
    }
  }
  if (!options.bannedPorts.length) delete options.bannedPorts;
  return options;
}

function proxySpec(root, ports, apiPrefix) {
  return {
    name: 'Proxy',
    cwd: root,
    command: 'node',
    args: [
      path.resolve(__dirname, '../bin/ports-manager.js'), '--internal-proxy',
      '--proxy-port', String(ports.proxy), '--proxy-frontend-port', String(ports.frontend),
      '--proxy-backend-port', String(ports.backend), '--api-prefix', apiPrefix
    ],
    env: {},
    color: 'yellow'
  };
}

async function runProxyOnly(options) {
  for (const key of ['proxyPort', 'proxyFrontendPort', 'proxyBackendPort']) {
    if (!options[key]) throw new Error(`internal proxy missing ${key}`);
  }
  const proxy = await startProxy({
    port: options.proxyPort,
    frontendPort: options.proxyFrontendPort,
    backendPort: options.proxyBackendPort,
    apiPrefix: options.apiPrefix || '/api'
  });
  await new Promise((resolve) => {
    const finish = async () => {
      await proxy.close();
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

function printPlan(root, frontend, backend, ports, config, corsEnabled) {
  console.log(`Root:     ${root}`);
  console.log(`Backend:  ${backend.framework} / npm run ${backend.script} / ${ports.backend}`);
  console.log(`Frontend: ${frontend.framework} / npm run ${frontend.script} / ${ports.frontend}`);
  if (config.proxy) console.log(`Proxy:    http://127.0.0.1:${ports.proxy}${config.apiPrefix}`);
  console.log(`CORS shim: ${corsEnabled ? 'enabled' : 'skipped'}`);
}

async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const options = parseArgs(argv);
  if (options.help) return console.log(HELP);
  if (options.version) {
    return console.log(`ports-manager v${pkg.version}\nMuhammad Saad Amin (SENODROOM)`);
  }
  if (options.internalProxy) return runProxyOnly(options);

  const root = path.resolve(cwd);
  const tag = `ports-manager:${root}`;
  if (options.stop) {
    await stopBridge(tag);
    console.log('Requested closure of Ports Manager terminals for this workspace.');
    return;
  }
  const loaded = await loadConfig(root, options.configPath);
  const config = mergeConfig(loaded.config, options);
  const folders = detectFolders(root, config);
  const frontend = classifyProject(folders.frontend, 'frontend');
  const backend = classifyProject(folders.backend, 'backend');
  const scan = scanBackend(backend);
  const corsEnabled = config.cors && (config.forceCors || !scan.corsDetected);
  if (scan.corsDetected && config.cors && !config.forceCors) {
    console.log('Existing CORS support detected heuristically; skipping preload shim (use --force-cors to override).');
  }
  if (!scan.hasEnvPort) {
    console.warn('Warning: static scan did not find process.env.PORT in likely backend entry files; runtime behavior may differ.');
  }
  if (scan.literals.length) {
    console.warn(`Warning: possible literal listen port(s) ${scan.literals.join(', ')} found; this heuristic may include inactive code.`);
  }
  if (frontend.framework === 'generic') {
    console.warn('Warning: generic frontend receives PORT and API URL cannot be inferred; configure env values if needed.');
  }

  const allocated = await allocatePorts(config, config.proxy ? 3 : 2);
  const ports = { backend: allocated[0], frontend: allocated[1], proxy: allocated[2] };
  const ideMode = config.ideTerminals;
  const inIde = isIdeTerminal();
  let effectiveIdeMode = ideMode;
  if (ideMode !== 'off' && !inIde) {
    console.log('IDE terminal mode requested outside a corroborated VS Code/Cursor terminal; using inline mode.');
    effectiveIdeMode = 'off';
  }
  const durableShim = path.join(root, '.vscode', 'ports-manager-cors-preload.cjs');
  const shimPath = corsEnabled
    ? (effectiveIdeMode === 'off' ? (options.dryRun ? '<dry-run-cors-shim>' : null) : durableShim)
    : null;
  let temporaryShim;
  if (corsEnabled && effectiveIdeMode === 'off' && !options.dryRun) {
    temporaryShim = createCorsShim();
  }
  const specs = buildSpecs(frontend, backend, ports, config,
    temporaryShim ? temporaryShim.filename : shimPath);
  const pSpec = config.proxy ? proxySpec(root, ports, config.apiPrefix) : null;
  printPlan(root, frontend, backend, ports, config, corsEnabled);
  if (options.dryRun) {
    console.log('Dry run: no files written and no processes started.');
    return;
  }

  if (effectiveIdeMode === 'extension' || effectiveIdeMode === 'auto') {
    if (corsEnabled) {
      fs.mkdirSync(path.dirname(durableShim), { recursive: true });
      fs.writeFileSync(durableShim, require('./cors').SHIM_SOURCE, 'utf8');
    }
    try {
      await launchInBridge(specs, pSpec, tag);
      console.log('Started tagged terminals through the Ports Manager bridge.');
      return;
    } catch (error) {
      if (effectiveIdeMode === 'extension') throw error;
      console.log(`Bridge unavailable (${error.message}); generating VS Code tasks instead.`);
      effectiveIdeMode = 'tasks';
    }
  }
  if (effectiveIdeMode === 'tasks') {
    const generated = generateIdeFiles(root, specs, pSpec, {
      keybinding: config.keybinding,
      needsShim: corsEnabled,
      withKeybinding: config.withKeybinding
    });
    console.log(`Generated ${generated.tasksFile}. Run “Ports Manager: Run All” from Tasks: Run Task.`);
    if (generated.keybindingsFile) {
      console.log(`Suggested shortcut ${config.keybinding} is in ${generated.keybindingsFile}; copy it into Preferences: Open Keyboard Shortcuts (JSON).`);
      console.log('VS Code/Cursor does not apply workspace keybindings files automatically.');
    }
    return;
  }

  let proxy;
  try {
    if (config.proxy) proxy = await startProxy({
      port: ports.proxy, frontendPort: ports.frontend, backendPort: ports.backend,
      apiPrefix: config.apiPrefix
    });
    const code = await runProcesses(specs, {
      waitForBackend: config.waitForBackend,
      backendPort: ports.backend
    });
    process.exitCode = code;
  } finally {
    if (proxy) await proxy.close();
    if (temporaryShim) temporaryShim.cleanup();
  }
}

module.exports = { HELP, main, parseArgs, proxySpec, runProxyOnly };
