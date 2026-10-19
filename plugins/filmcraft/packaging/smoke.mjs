// Exercise a relocated app with only macOS system commands on PATH. No live provider requests.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { repository } from '../dist/config.js';
import { resultData } from '../dist/core.js';
import { editDemo } from '../examples/workflow.mjs';

const archive = resolve(process.argv[2] ?? join(repository, `artifacts/releases/jev-filmcraft-0.1.0-preview.1-macos-${process.arch}.zip`));
const scratch = await mkdtemp(join(tmpdir(), 'jev packaged app '));
const installed = join(scratch, 'Applications with spaces');
const state = join(scratch, 'Private settings');
const output = join(repository, 'artifacts/releases/verification');
await mkdir(installed);
await mkdir(output, { recursive: true });
execFileSync('ditto', ['-x', '-k', archive, installed]);
const app = join(installed, 'Jev FilmCraft.app');
const contents = join(app, 'Contents');
const launcher = join(contents, 'MacOS/JevFilmCraft');
const node = join(contents, 'Resources/node/bin/node');
const entry = join(contents, 'Resources/runtime/launch.mjs');
const env = { HOME: process.env.HOME, TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin', FILMCRAFT_STATE_DIR: state };
let child;
let session;
let client;
const verifySignature = () => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const waitFor = async (predicate, message) => {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(message);
};
const request = async (route, body) => {
  const response = await fetch(`${session.url}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
  assert(response.ok, `Packaged API returned ${response.status} for ${route}`);
  return response.json();
};
const launch = async (finder = false) => {
  child = finder
    ? spawn('/usr/bin/open', ['-n', '-W', '--env', `FILMCRAFT_STATE_DIR=${state}`, '--env', 'PATH=/usr/bin:/bin', app], { env, detached: true, stdio: 'ignore' })
    : spawn(launcher, [], { env, detached: true, stdio: 'ignore' });
  let error;
  child.once('error', e => { error = e; });
  await waitFor(async () => {
    if (error) throw error;
    if (child.exitCode !== null) throw new Error(`App launcher exited: ${child.exitCode}`);
    try { session = JSON.parse(await readFile(join(state, 'session.json'), 'utf8')); return (await request('/v1/health')).connected; }
    catch { return false; }
  }, 'Packaged app did not start');
  client = new Client({ name: 'packaged-app-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: node, args: [entry, 'desktop-mcp'], env, stderr: 'inherit' }));
};
const call = async (name, args = {}) => {
  const result = await client.callTool({ name: `filmcraft_${name}`, arguments: args });
  assert(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result;
};
const control = async (method, params = {}) => resultData(await call('ui_control', { method, params }));
const click = id => control('ui.click', { id });
const quit = async () => {
  await control('app.quit').catch(() => {});
  await client.close();
  client = undefined;
  await waitFor(() => child.exitCode !== null, 'App and service did not exit after closing FilmCraft');
  assert.equal(child.exitCode, 0);
  child = undefined;
  await assert.rejects(readFile(join(state, 'session.json')), { code: 'ENOENT' });
};

try {
  verifySignature();
  const bundled = JSON.parse(await readFile(join(contents, 'Resources/runtime/plugins/filmcraft/config/providers.example.json'), 'utf8'));
  assert(Object.values(bundled).every(provider => provider.apiKey === ''));
  await launch();
  assert.equal((await client.listTools()).tools.length, 54);
  const initial = await request('/v1/chat/providers');
  assert(initial.providers.every(p => !p.configured));
  assert(initial.installs.codex.includes(entry));
  assert(initial.installs['claude-code'].includes(node));
  const demo = await editDemo(client, join(scratch, 'media'));
  await call('marker_add', { seconds: 1, name: 'Packaged MCP test' });
  assert.match(JSON.stringify(resultData(await call('sequence_inspect'))), /Packaged MCP test/);
  await waitFor(async () => (await control('chat.inspect')).status === 'Ready', 'Sidebar did not connect');
  await click('chat.provider');
  await click('chat.provider.jev');
  await click('chat.settings');
  await click('chat.key');
  await control('ui.type', { text: 'fixture-only-not-a-real-api-key' });
  await click('chat.settings.apply');
  await waitFor(async () => (await control('chat.inspect')).status === 'Settings saved on this Mac', 'UI did not save settings');
  assert.equal(JSON.parse(await readFile(join(state, 'providers.json'), 'utf8')).jev.apiKey, 'fixture-only-not-a-real-api-key');
  assert.equal((await stat(join(state, 'providers.json'))).mode & 0o777, 0o600);
  await call('project_save', { path: join(scratch, 'media/edit.fcproj') });
  const shot = (await call('ui_screenshot', { max_side: 1600 })).content.find(c => c.type === 'image');
  assert(shot);
  await writeFile(join(output, 'packaged-app.png'), Buffer.from(shot.data, 'base64'));
  await quit();
  await launch(true); // Use the same Launch Services path as opening the app in Finder.
  assert((await request('/v1/chat/providers')).providers.find(p => p.id === 'jev').configured, 'Saved key must survive restart');
  await request('/v1/chat/config', { provider: 'jev', apiKey: '', persist: true });
  assert.equal(JSON.parse(await readFile(join(state, 'providers.json'), 'utf8')).jev.apiKey, '');
  await quit();
  verifySignature(); // Nothing wrote into the installed app, even when saving keys and restarting.
  await writeFile(join(output, 'report.json'), JSON.stringify({ archive, architecture: process.arch, systemPathOnly: true, relocated: true, finderLaunch: true, bundledMcp: true, toolCount: 54, fullEditingExportRoundTrip: true, nativeKeyEntryAndPersistence: true, cleanShutdownAndRestart: true, bundleSignatureUnchanged: true, liveProviderInference: false, demo }, null, 2));
  console.log('Packaged app passed: relocated launch, bundled MCP, real editing/export round trip, UI key persistence, restart, clean shutdown, unchanged signature. No live cloud requests.');
} finally {
  if (client) {
    await control('app.quit').catch(() => {});
    await client.close().catch(() => {});
  }
  if (child?.exitCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  await rm(scratch, { recursive: true, force: true });
}
