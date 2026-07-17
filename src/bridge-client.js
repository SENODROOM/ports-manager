'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { terminalCommand } = require('./ide');

function descriptorPath() {
  return path.join(os.homedir(), '.ports-manager', 'bridge.json');
}

function readDescriptor(filename = descriptorPath()) {
  let descriptor;
  try {
    descriptor = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    throw new Error(`bridge descriptor unavailable at ${filename}: ${error.message}`);
  }
  const endpoint = new URL(descriptor.endpoint);
  if (endpoint.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('bridge endpoint must be loopback HTTP');
  }
  if (typeof descriptor.token !== 'string' || descriptor.token.length < 32) {
    throw new Error('bridge descriptor has an invalid token');
  }
  return { endpoint, token: descriptor.token };
}

function requestBridge(route, body, descriptor = readDescriptor()) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(route, descriptor.endpoint), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${descriptor.token}`,
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      },
      timeout: 2500
    }, (response) => {
      let output = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { output += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`bridge returned ${response.statusCode}: ${output}`));
        } else {
          resolve(output ? JSON.parse(output) : {});
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('bridge request timed out')));
    request.on('error', (error) => reject(new Error(`bridge unavailable: ${error.message}`)));
    request.end(payload);
  });
}

function toTerminal(spec) {
  return {
    name: `Ports Manager ${spec.name}`,
    cwd: spec.cwd,
    env: spec.env,
    command: terminalCommand(spec)
  };
}

async function launchInBridge(specs, proxySpec, tag) {
  const terminals = [toTerminal(specs.backend), toTerminal(specs.frontend)];
  if (proxySpec) terminals.push(toTerminal(proxySpec));
  return requestBridge('/terminals', { tag, terminals });
}

async function stopBridge(tag) {
  return requestBridge('/stop', { tag });
}

module.exports = {
  descriptorPath, launchInBridge, readDescriptor, requestBridge, stopBridge, toTerminal
};
