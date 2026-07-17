import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BridgeServer, TerminalHost, TerminalSpec } from './server';

let bridge: BridgeServer | undefined;
let descriptorFile: string | undefined;
let activeToken: string | undefined;

function writeDescriptor(port: number, token: string): string {
  const directory = path.join(os.homedir(), '.ports-manager');
  const filename = path.join(directory, 'bridge.json');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows ACLs do not map directly to POSIX modes.
  }
  const temporary = path.join(directory, `.bridge-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const payload = JSON.stringify({
    endpoint: `http://127.0.0.1:${port}/`,
    token,
    pid: process.pid
  });
  fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporary, filename);
  } catch (error) {
    if (process.platform !== 'win32') {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    fs.rmSync(filename, { force: true });
    fs.renameSync(temporary, filename);
  }
  try {
    fs.chmodSync(filename, 0o600);
  } catch {
    // Best effort on Windows.
  }
  return filename;
}

function removeOwnDescriptor(): void {
  if (!descriptorFile || !activeToken) return;
  try {
    const current = JSON.parse(fs.readFileSync(descriptorFile, 'utf8')) as { token?: string };
    if (current.token === activeToken) fs.rmSync(descriptorFile, { force: true });
  } catch {
    // Already removed or replaced.
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const token = crypto.randomBytes(32).toString('hex');
  activeToken = token;
  const host: TerminalHost = {
    create(spec: TerminalSpec) {
      return vscode.window.createTerminal({
        name: spec.name,
        cwd: spec.cwd,
        env: spec.env,
        isTransient: true
      });
    }
  };
  bridge = new BridgeServer(token, host);
  try {
    const port = await bridge.listen();
    descriptorFile = writeDescriptor(port, token);
  } catch (error) {
    await bridge.close();
    bridge = undefined;
    activeToken = undefined;
    vscode.window.showErrorMessage(`Ports Manager bridge failed to start: ${error instanceof Error ? error.message : error}`);
    return;
  }

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => bridge?.forget(terminal)),
    vscode.commands.registerCommand('ports-manager.stopAll', () => {
      const count = bridge?.stopAll() || 0;
      vscode.window.showInformationMessage(`Stopped ${count} Ports Manager terminal${count === 1 ? '' : 's'}.`);
    })
  );
}

export async function deactivate(): Promise<void> {
  removeOwnDescriptor();
  if (bridge) await bridge.close();
  bridge = undefined;
  activeToken = undefined;
  descriptorFile = undefined;
}
