import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface TerminalSpec {
  name: string;
  cwd: string;
  env: Record<string, string>;
  command: string;
}

export interface ManagedTerminal {
  show(preserveFocus?: boolean): void;
  sendText(text: string, addNewLine?: boolean): void;
  dispose(): void;
}

export interface TerminalHost {
  create(spec: TerminalSpec): ManagedTerminal;
}

interface LaunchBody {
  tag: string;
  terminals: TerminalSpec[];
}

interface StopBody {
  tag: string;
}

const MAX_BODY = 64 * 1024;

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function shortString(value: unknown, maximum = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

export function validateLaunchBody(value: unknown): LaunchBody {
  if (!plainObject(value) || !shortString(value.tag, 1024) ||
      !Array.isArray(value.terminals) || value.terminals.length < 1 || value.terminals.length > 8) {
    throw new Error('invalid terminal launch body');
  }
  const terminals = value.terminals.map((candidate): TerminalSpec => {
    if (!plainObject(candidate) || !shortString(candidate.name, 200) ||
        !shortString(candidate.cwd, 4096) || !shortString(candidate.command, 16384) ||
        !plainObject(candidate.env)) {
      throw new Error('invalid terminal specification');
    }
    const env: Record<string, string> = {};
    for (const [key, item] of Object.entries(candidate.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string' || item.length > 16384) {
        throw new Error('invalid terminal environment');
      }
      env[key] = item;
    }
    return { name: candidate.name, cwd: candidate.cwd, command: candidate.command, env };
  });
  return { tag: value.tag, terminals };
}

function validateStopBody(value: unknown): StopBody {
  if (!plainObject(value) || !shortString(value.tag, 1024)) throw new Error('invalid stop body');
  return { tag: value.tag };
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new Error('content-type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response: http.ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  response.end(payload);
}

export class BridgeServer {
  private server?: http.Server;
  private readonly tracked = new Map<string, Set<ManagedTerminal>>();

  constructor(private readonly token: string, private readonly host: TerminalHost) {}

  async listen(): Promise<number> {
    if (this.server) throw new Error('bridge already listening');
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('bridge failed to bind');
    return address.port;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (!isLoopback(request.socket.remoteAddress)) return send(response, 403, { error: 'loopback only' });
      if (!authorized(request.headers.authorization, this.token)) return send(response, 401, { error: 'unauthorized' });
      if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
      const body = await readJson(request);
      if (request.url === '/terminals') {
        const launch = validateLaunchBody(body);
        this.stopTag(launch.tag);
        const terminals = new Set<ManagedTerminal>();
        try {
          for (const spec of launch.terminals) {
            const terminal = this.host.create(spec);
            terminals.add(terminal);
            terminal.show(true);
            terminal.sendText(spec.command, true);
          }
        } catch (error) {
          for (const terminal of terminals) terminal.dispose();
          throw error;
        }
        this.tracked.set(launch.tag, terminals);
        return send(response, 201, { created: terminals.size });
      }
      if (request.url === '/stop') {
        const stop = validateStopBody(body);
        const stopped = this.stopTag(stop.tag);
        return send(response, 200, { stopped });
      }
      return send(response, 404, { error: 'not found' });
    } catch (error) {
      return send(response, 400, { error: error instanceof Error ? error.message : 'bad request' });
    }
  }

  forget(terminal: ManagedTerminal): void {
    for (const [tag, terminals] of this.tracked) {
      terminals.delete(terminal);
      if (!terminals.size) this.tracked.delete(tag);
    }
  }

  stopTag(tag: string): number {
    const terminals = this.tracked.get(tag);
    if (!terminals) return 0;
    this.tracked.delete(tag);
    for (const terminal of terminals) terminal.dispose();
    return terminals.size;
  }

  stopAll(): number {
    let count = 0;
    for (const tag of [...this.tracked.keys()]) count += this.stopTag(tag);
    return count;
  }

  async close(): Promise<void> {
    this.stopAll();
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
