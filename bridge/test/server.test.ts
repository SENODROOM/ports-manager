import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { BridgeServer, ManagedTerminal, TerminalSpec, validateLaunchBody } from '../src/server';

test('validates terminal launch bodies', () => {
  const body = validateLaunchBody({
    tag: 'workspace',
    terminals: [{ name: 'Backend', cwd: '/tmp', env: { PORT: '4000' }, command: 'npm run dev' }]
  });
  assert.equal(body.terminals[0].env.PORT, '4000');
  assert.throws(() => validateLaunchBody({
    tag: 'x',
    terminals: [{ name: 'x', cwd: '/tmp', env: { 'BAD-NAME': 'x' }, command: 'x' }]
  }), /environment/);
});

test('authenticated bridge launches and stops tagged terminals', async () => {
  const terminals: Array<ManagedTerminal & { sent: string[]; disposed: boolean }> = [];
  const token = 'a'.repeat(64);
  const bridge = new BridgeServer(token, {
    create(_spec: TerminalSpec) {
      const terminal = {
        sent: [] as string[],
        disposed: false,
        show() {},
        sendText(text: string) { this.sent.push(text); },
        dispose() { this.disposed = true; }
      };
      terminals.push(terminal);
      return terminal;
    }
  });
  const port = await bridge.listen();
  try {
    const launch = await post(port, '/terminals', token, {
      tag: 'workspace',
      terminals: [{ name: 'Backend', cwd: '/tmp', env: {}, command: 'npm run dev' }]
    });
    assert.equal(launch.status, 201);
    assert.deepEqual(terminals[0].sent, ['npm run dev']);
    const unauthorized = await post(port, '/stop', 'wrong-token', { tag: 'workspace' });
    assert.equal(unauthorized.status, 401);
    const stop = await post(port, '/stop', token, { tag: 'workspace' });
    assert.equal(stop.status, 200);
    assert.equal(terminals[0].disposed, true);
  } finally {
    await bridge.close();
  }
});

function post(port: number, route: string, token: string, body: object):
Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (response) => {
      let output = '';
      response.on('data', (chunk) => { output += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, body: output }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}
