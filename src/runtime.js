'use strict';

const net = require('node:net');

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function allocatePorts(config, count) {
  const [minimum, maximum] = config.portRange;
  const banned = new Set([3000, 5000, ...config.bannedPorts]);
  const requested = [config.backendPort, config.frontendPort, config.proxyPort].slice(0, count);
  const result = [];
  for (const requestedPort of requested) {
    if (requestedPort === undefined) {
      let selected;
      for (let port = minimum; port <= maximum; port += 1) {
        if (!banned.has(port) && !result.includes(port) && await isPortFree(port)) {
          selected = port;
          break;
        }
      }
      if (!selected) throw new Error(`no free ports in range ${minimum}-${maximum}`);
      result.push(selected);
    } else {
      if (banned.has(requestedPort)) throw new Error(`port ${requestedPort} is banned`);
      if (result.includes(requestedPort)) throw new Error(`port ${requestedPort} was requested more than once`);
      if (!await isPortFree(requestedPort)) throw new Error(`requested port ${requestedPort} is unavailable`);
      result.push(requestedPort);
    }
  }
  return result;
}

function renderEnv(env, values) {
  return Object.fromEntries(Object.entries(env || {}).map(([key, value]) => {
    if (typeof value !== 'string') return [key, String(value)];
    return [key, value.replace(/\{(frontendPort|backendPort|proxyPort|apiPrefix)\}/g,
      (_, name) => String(values[name] ?? ''))];
  }));
}

function buildSpecs(frontend, backend, ports, config, corsShim) {
  const values = {
    backendPort: ports.backend,
    frontendPort: ports.frontend,
    proxyPort: ports.proxy,
    apiPrefix: config.apiPrefix
  };
  const backendUrl = config.proxy
    ? `http://127.0.0.1:${ports.proxy}${config.apiPrefix}`
    : `http://127.0.0.1:${ports.backend}`;
  const configuredEnv = config.env || {};
  const commonEnv = renderEnv(Object.fromEntries(Object.entries(configuredEnv)
    .filter(([key]) => key !== 'frontend' && key !== 'backend')), values);
  const backendEnv = {
    ...commonEnv,
    ...renderEnv(configuredEnv.backend, values),
    PORT: String(ports.backend)
  };
  if (corsShim) {
    backendEnv.PORTS_MANAGER_CORS_ORIGIN = `http://127.0.0.1:${config.proxy ? ports.proxy : ports.frontend}`;
    backendEnv.PORTS_MANAGER_CORS_CREDENTIALS = String(config.corsCredentials);
    backendEnv.NODE_OPTIONS = appendNodeRequire(process.env.NODE_OPTIONS || '', corsShim);
  }

  const frontendEnv = {
    ...commonEnv,
    ...renderEnv(configuredEnv.frontend, values)
  };
  const npm = npmInvocation();
  const frontendArgs = [...npm.argsPrefix, 'run', frontend.script];
  if (frontend.framework === 'cra') {
    frontendEnv.PORT = String(ports.frontend);
    frontendEnv.REACT_APP_API_URL = backendUrl;
  } else if (frontend.framework === 'vite') {
    frontendArgs.push('--', '--port', String(ports.frontend), '--strictPort');
    frontendEnv.VITE_API_URL = backendUrl;
  } else if (frontend.framework === 'next') {
    frontendArgs.push('--', '-p', String(ports.frontend));
    frontendEnv.NEXT_PUBLIC_API_URL = backendUrl;
  } else {
    frontendEnv.PORT = String(ports.frontend);
  }

  return {
    backend: {
      name: 'Backend', cwd: backend.directory, command: npm.command,
      args: [...npm.argsPrefix, 'run', backend.script],
      env: backendEnv, color: 'cyan'
    },
    frontend: {
      name: 'Frontend', cwd: frontend.directory, command: npm.command, args: frontendArgs,
      env: frontendEnv, color: 'magenta'
    }
  };
}

function npmInvocation() {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', 'npm.cmd']
    };
  }
  return { command: 'npm', argsPrefix: [] };
}

function appendNodeRequire(existing, shimPath) {
  const escaped = shimPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${existing ? `${existing} ` : ''}--require "${escaped}"`;
}

module.exports = { allocatePorts, appendNodeRequire, buildSpecs, isPortFree, npmInvocation, renderEnv };
