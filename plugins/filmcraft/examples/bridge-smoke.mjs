import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'jev-filmcraft-desktop-'));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const desktop = spawn(join(root, 'vendor/filmcraft/target/debug/filmcraft'), ['--control', String(port), '--control-input-only', '--empty', '--no-recover', '--data-dir', scratch], { stdio: ['ignore', 'ignore', 'pipe'] });
let launchError;
let diagnostics = '';
desktop.on('error', error => { launchError = error; });
desktop.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
const client = new Client({ name: 'jev-desktop-evaluation', version: '0.1.0' });
try {
  // Wait for the actual desktop listener instead of timing-dependent sleeps.
  const { createConnection } = await import('node:net');
  const deadline = Date.now() + 30_000;
  while (true) {
    if (launchError || desktop.exitCode !== null) throw new Error(`Desktop launch failed: ${launchError ?? diagnostics}`);
    const ready = await new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (ready) break;
    if (Date.now() > deadline) throw new Error(`Desktop did not start: ${diagnostics}`);
    await setTimeout(100);
  }
  const env = { ...process.env, FILMCRAFT_MODE: 'bridge', FILMCRAFT_BRIDGE: `127.0.0.1:${port}` };
  for (const key of ['FILMCRAFT_PROJECT', 'FILMCRAFT_DEMO', 'FILMCRAFT_DATA_DIR', 'FILMCRAFT_API_URL']) delete env[key];
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'plugins/filmcraft/dist/cli.js'), 'mcp'], env, stderr: 'inherit' }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name: `filmcraft_${name}`, arguments: args });
    assert(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    return result;
  };
  assert((await client.listTools()).tools.some(t => t.name === 'filmcraft_ui_screenshot'));
  await call('project_open', { path: join(root, 'artifacts/demo/edit.fcproj') });
  await call('ui_inspect');
  await call('ui_elements', { prefix: 'timeline.' });
  await call('playhead_set', { seconds: 0.5 });
  await call('marker_add', { seconds: 0.5, name: 'Desktop bridge verified' });
  const inspected = await call('sequence_inspect');
  assert.match(inspected.content.find(c => c.type === 'text').text, /Desktop bridge verified/);
  await call('ui_control', { method: 'ui.set', params: { timeline: { fit: true } } });
  const screenshot = await call('ui_screenshot', { max_side: 1200 });
  const image = screenshot.content.find(c => c.type === 'image');
  assert(image, 'Desktop screenshot must return pixels');
  await mkdir(join(root, 'artifacts/bridge'), { recursive: true });
  await writeFile(join(root, 'artifacts/bridge/desktop.png'), Buffer.from(image.data, 'base64'));
  console.log('Desktop bridge verified: live project, commands, UI inspection, control, and PNG screenshot.');
} finally {
  await client.close();
  if (desktop.exitCode === null && !launchError) {
    const exited = new Promise(resolve => desktop.once('exit', resolve));
    desktop.kill('SIGTERM');
    const fallback = globalThis.setTimeout(() => desktop.kill('SIGKILL'), 5000);
    await exited;
    globalThis.clearTimeout(fallback);
  }
  await rm(scratch, { recursive: true, force: true });
}
