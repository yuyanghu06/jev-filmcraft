// Exercise a relocated app with only operating-system commands on PATH. No live provider requests.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { repository } from '../dist/config.js';
import { resultData } from '../dist/core.js';
import { editDemo } from '../examples/workflow.mjs';

const windows = process.platform === 'win32';
if (!windows && process.platform !== 'darwin') throw new Error('Run this test on Windows or macOS.');
const version = process.env.JEV_FILMCRAFT_VERSION ?? '0.1.0-preview.2';
const platform = windows ? 'windows-x64' : `macos-${process.arch}`;
const archive = resolve(process.argv[2] ?? join(repository, `artifacts/releases/jev-filmcraft-${version}-${platform}.zip`));
const scratch = await mkdtemp(join(tmpdir(), "jev packaged O'Brien "));
const installed = join(scratch, 'Applications with spaces');
const state = join(scratch, 'Private settings');
const output = join(repository, 'artifacts/releases/verification');
await mkdir(installed);
await mkdir(output, { recursive: true });
const system = process.env.SystemRoot ?? 'C:\\Windows';
const powershell = join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
if (windows) {
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', "Expand-Archive -LiteralPath $env:JEV_ARCHIVE -DestinationPath $env:JEV_DESTINATION"], { env: { ...process.env, JEV_ARCHIVE: archive, JEV_DESTINATION: installed } });
} else {
  execFileSync('ditto', ['-x', '-k', archive, installed]);
}
const app = join(installed, windows ? 'Jev FilmCraft' : 'Jev FilmCraft.app');
const contents = join(app, 'Contents');
const launcher = windows ? join(app, 'JevFilmCraft.exe') : join(contents, 'MacOS/JevFilmCraft');
const node = windows ? join(app, 'node/node.exe') : join(contents, 'Resources/node/bin/node');
const runtime = windows ? join(app, 'runtime') : join(contents, 'Resources/runtime');
const entry = join(runtime, 'launch.mjs');
const env = windows ? {
  SystemRoot: system, WINDIR: system, COMSPEC: join(system, 'System32/cmd.exe'),
  USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA,
  TEMP: tmpdir(), TMP: tmpdir(), PATH: `${join(system, 'System32')};${system}`,
  FILMCRAFT_GRAPHICS: 'software', FILMCRAFT_STATE_DIR: state,
} : { HOME: process.env.HOME, TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin', FILMCRAFT_STATE_DIR: state };
const architecture = execFileSync(node, ['-p', 'process.arch'], { env, encoding: 'utf8', windowsHide: true }).trim();
let child;
let session;
let client;
const bundleHashes = async (dir = app) => {
  const hashes = {};
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, item.name);
    if (item.isSymbolicLink()) throw new Error(`Non-portable link in Windows bundle: ${file}`);
    if (item.isDirectory()) Object.assign(hashes, await bundleHashes(file));
    else hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return hashes;
};
const originalHashes = windows ? await bundleHashes() : undefined;
const verifyBundle = async () => {
  if (windows) assert.deepEqual(await bundleHashes(), originalHashes);
  else execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
};
const waitFor = async (predicate, message) => {
  for (let i = 0; i < 600; i++) {
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
  child = finder && !windows
    ? spawn('/usr/bin/open', ['-n', '-W', '--env', `FILMCRAFT_STATE_DIR=${state}`, '--env', 'PATH=/usr/bin:/bin', app], { env, detached: true, stdio: 'ignore' })
    : spawn(launcher, [], { env, detached: !windows, windowsHide: true, stdio: 'ignore' });
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
  await verifyBundle();
  const bundled = JSON.parse(await readFile(join(runtime, 'plugins/filmcraft/config/providers.example.json'), 'utf8'));
  assert(Object.values(bundled).every(provider => provider.apiKey === ''));
  await launch();
  assert.equal((await client.listTools()).tools.length, 54);
  const initial = await request('/v1/chat/providers');
  assert(initial.providers.every(p => !p.configured));
  assert(initial.installs.codex.includes(windows ? entry.replaceAll("'", "''") : entry.replaceAll("'", "'\\''")));
  assert(initial.installs['claude-code'].includes(windows ? node.replaceAll("'", "''") : node.replaceAll("'", "'\\''")));
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
  await waitFor(async () => (await control('chat.inspect')).status === 'Settings saved on this device', 'UI did not save settings');
  assert.equal(JSON.parse(await readFile(join(state, 'providers.json'), 'utf8')).jev.apiKey, 'fixture-only-not-a-real-api-key');
  if (!windows) assert.equal((await stat(join(state, 'providers.json'))).mode & 0o777, 0o600);
  await call('project_save', { path: join(scratch, 'media/edit.fcproj') });
  const shot = (await call('ui_screenshot', { max_side: 1600 })).content.find(c => c.type === 'image');
  assert(shot);
  await writeFile(join(output, 'packaged-app.png'), Buffer.from(shot.data, 'base64'));
  await quit();
  await launch(true); // Mac restarts through Launch Services, Windows restarts its GUI executable.
  assert((await request('/v1/chat/providers')).providers.find(p => p.id === 'jev').configured, 'Saved key must survive restart');
  await request('/v1/chat/config', { provider: 'jev', apiKey: '', persist: true });
  assert.equal(JSON.parse(await readFile(join(state, 'providers.json'), 'utf8')).jev.apiKey, '');
  await quit();
  await verifyBundle(); // Nothing wrote into the installed app, even when saving keys and restarting.
  await writeFile(join(output, 'report.json'), JSON.stringify({ archive, architecture, testHostArchitecture: process.arch, systemPathOnly: true, relocated: true, finderLaunch: !windows, platform: windows ? 'windows-x64' : `macos-${architecture}`, bundledMcp: true, toolCount: 54, fullEditingExportRoundTrip: true, nativeKeyEntryAndPersistence: true, cleanShutdownAndRestart: true, installedFilesUnchanged: true, liveProviderInference: false, demo }, null, 2));
  console.log('Packaged app passed: relocated launch, bundled MCP, real editing/export round trip, UI key persistence, restart, clean shutdown, unchanged installed app. No live cloud requests.');
} finally {
  if (client) {
    await control('app.quit').catch(() => {});
    await client.close().catch(() => {});
  }
  if (child?.exitCode === null) {
    try {
      if (windows) execFileSync(join(system, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F']);
      else process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
