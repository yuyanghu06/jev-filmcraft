import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeBackend } from '../adapters/native.js';
import { FilmcraftService } from '../api/service.js';
import { startApi } from '../api/server.js';
import { FilmcraftApiClient } from '../api/client.js';
import { repository, nativeOptions, filmcraftDirectory } from '../config.js';
import { loadProviderEnvironment } from './config.js';

export function sessionPath(env: NodeJS.ProcessEnv = process.env) {
  return env.FILMCRAFT_STATE_DIR ? join(resolve(env.FILMCRAFT_STATE_DIR), 'session.json') : join(repository, 'artifacts/chat/session.json');
}
export function installCommands(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  // Windows commands are pasted into PowerShell; POSIX shells escape apostrophes differently.
  const quote = (s: string) => `'${s.replaceAll("'", platform === 'win32' ? "''" : "'\\''")}'`;
  const entry = env.FILMCRAFT_LAUNCHER ?? fileURLToPath(new URL('../cli.js', import.meta.url));
  const command = `${quote(process.execPath)} ${quote(entry)} desktop-mcp`;
  return {
    codex: `codex mcp add filmcraft -- ${command}`,
    'claude-code': `claude mcp add --scope user --transport stdio filmcraft -- ${command}`,
  };
}
async function port() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('No local port available');
  return address.port;
}
export async function desktopApi(env: NodeJS.ProcessEnv = process.env) {
  let session: { url: string; token: string };
  try { session = JSON.parse(await readFile(sessionPath(env), 'utf8')); }
  catch { throw new Error('Open Jev FilmCraft (or run npm run chat) before connecting this MCP server.'); }
  const api = new FilmcraftApiClient(session.url, session.token);
  await api.health();
  return api;
}
export async function launchDesktop(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; controlInputOnly?: boolean } = {}) {
  const env = options.env ?? process.env;
  const sessionFile = sessionPath(env);
  const providerEnv = await loadProviderEnvironment(env);
  if (existsSync(sessionFile)) {
    try { await desktopApi(env); throw new Error('A FilmCraft chat session is already running. Close it before launching another.'); }
    catch (e) { if (e instanceof Error && e.message.includes('already running')) throw e; }
  }
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binary = env.FILMCRAFT_DESKTOP_BIN ?? ['debug', 'release'].map(p => join(filmcraftDirectory(env), 'target', p, `filmcraft${ext}`)).find(existsSync);
  if (!binary) throw new Error('Run npm run build:desktop first.');
  const controlPort = await port(), apiPort = await port();
  const token = randomBytes(32).toString('hex');
  const args = ['--control', String(controlPort)];
  // Distributed builds must keep FilmCraft's recovery prompt after an unexpected exit.
  if (env.FILMCRAFT_PACKAGED !== '1' || options.controlInputOnly) args.push('--no-recover');
  if (options.controlInputOnly) args.push('--control-input-only');
  if (env.FILMCRAFT_GRAPHICS) {
    if (!['default', 'dx12', 'software'].includes(env.FILMCRAFT_GRAPHICS)) throw new Error('FILMCRAFT_GRAPHICS must be default, dx12, or software');
    args.push('--graphics', env.FILMCRAFT_GRAPHICS);
  }
  if (env.FILMCRAFT_DATA_DIR) args.push('--data-dir', env.FILMCRAFT_DATA_DIR);
  if (!env.FILMCRAFT_PROJECT) args.push('--empty');
  const desktop = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, FILMCRAFT_CHAT_URL: `http://127.0.0.1:${apiPort}`, FILMCRAFT_CHAT_TOKEN: token } });
  let launchError: Error | undefined;
  desktop.on('error', error => { launchError = error; });
  // Native diagnostics can contain project data; keep them local to this process.
  desktop.stderr.on('data', () => {});
  let backend: NativeBackend | undefined;
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await api?.close();
    await backend?.close();
    if (desktop.exitCode === null && !desktop.killed) desktop.kill('SIGTERM');
    try { const saved = JSON.parse(await readFile(sessionFile, 'utf8')); if (saved.token === token) await rm(sessionFile); } catch { /* Already removed. */ }
  };
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      if (launchError || desktop.exitCode !== null) throw new Error(`FilmCraft failed to launch: ${launchError?.message ?? desktop.exitCode}`);
      const ready = await new Promise<boolean>(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port: controlPort });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
      });
      if (ready) break;
      if (Date.now() > deadline) throw new Error('FilmCraft desktop did not start within 30 seconds');
      await delay(100);
    }
    backend = await NativeBackend.connect(nativeOptions({ ...env, FILMCRAFT_MODE: 'bridge', FILMCRAFT_BRIDGE: `127.0.0.1:${controlPort}`, FILMCRAFT_PROJECT: undefined, FILMCRAFT_DEMO: undefined, FILMCRAFT_DATA_DIR: undefined }));
    api = await startApi(new FilmcraftService(backend), { token, port: apiPort, chat: { env: providerEnv, fetch: options.fetch, installs: installCommands(env) } });
    await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
    await writeFile(sessionFile, JSON.stringify({ url: api.url, token }), { mode: 0o600 });
    const client = new FilmcraftApiClient(api.url, token);
    if (env.FILMCRAFT_PROJECT) {
      const result = await client.callTool('filmcraft_project_open', { path: env.FILMCRAFT_PROJECT });
      if (result.isError) throw new Error('Could not open FILMCRAFT_PROJECT; check its absolute path.');
    }
    desktop.once('exit', () => { void close(); });
    return { ...api, close, desktop, token, client };
  } catch (error) { await close(); throw error; }
}
