#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NativeBackend } from './adapters/native.js';
import { FilmcraftService } from './api/service.js';
import { startApi } from './api/server.js';
import { FilmcraftApiClient } from './api/client.js';
import { startStdio } from './mcp/server.js';
import { nativeOptions } from './config.js';
import { errorMessage } from './core.js';
import { launchDesktop, desktopApi } from './chat/desktop.js';
import { initProviderConfig } from './chat/config.js';

const cleanups: (() => Promise<unknown>)[] = [];
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch (error) { process.stderr.write(`${errorMessage(error)}\n`); }
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop(); });

async function main() {
  const action = process.argv[2];
  if (action === 'providers-config') {
    const config = await initProviderConfig();
    process.stdout.write(`${config.created ? 'Created' : 'Using existing'} provider config: ${config.path}\nFill in the apiKey fields, then restart npm run chat.\n`);
    return;
  }
  if (action === 'desktop') {
    const desktop = await launchDesktop();
    cleanups.push(desktop.close);
    process.stderr.write(`FilmCraft chat ready at ${desktop.url}. Choose a provider in the right sidebar.\n`);
    return;
  }
  if (action === 'desktop-mcp') {
    const server = await startStdio(await desktopApi());
    cleanups.push(() => server.close());
    server.onclose = () => { void stop(); };
    return;
  }
  if (action === 'config' && process.argv.length === 3) {
    process.stdout.write(JSON.stringify({ mcpServers: { filmcraft: { command: process.execPath, args: [fileURLToPath(import.meta.url), 'mcp'] } } }, null, 2) + '\n');
    return;
  }
  if (!action || action === '--help' || action === 'help') {
    process.stderr.write('Usage: jev-filmcraft api|mcp|config|desktop|desktop-mcp|providers-config\napi: local HTTP API (requires FILMCRAFT_API_TOKEN, >=24 characters).\nmcp: MCP stdio; auto-starts a private API/engine, or connects to FILMCRAFT_API_URL with FILMCRAFT_API_TOKEN.\nconfig: print a ready-to-use MCP configuration with absolute paths.\nproviders-config: create a local provider API key/model configuration without overwriting it.\ndesktop: launch FilmCraft with its chat sidebar.\ndesktop-mcp: connect an external MCP client to the running chat desktop.\nFILMCRAFT_MODE=headless|bridge; FILMCRAFT_BIN; FILMCRAFT_BRIDGE=127.0.0.1:9876; FILMCRAFT_PROJECT; FILMCRAFT_DEMO=true; FILMCRAFT_API_PORT=8765.\n');
    return;
  }
  if (!['api', 'mcp'].includes(action) || process.argv.length > 3) throw new Error('Expected api or mcp with configuration in environment variables; use --help');
  let url = action === 'mcp' ? process.env.FILMCRAFT_API_URL : undefined;
  const token = process.env.FILMCRAFT_API_TOKEN ?? (action === 'mcp' && !url ? randomBytes(32).toString('hex') : '');
  if (token.length < 24) throw new Error('Set FILMCRAFT_API_TOKEN to at least 24 characters');
  if (!url) {
    const port = action === 'mcp' ? 0 : Number(process.env.FILMCRAFT_API_PORT ?? 8765);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('FILMCRAFT_API_PORT must be 0..65535');
    const backend = await NativeBackend.connect(nativeOptions());
    cleanups.push(() => backend.close());
    const api = await startApi(new FilmcraftService(backend), { token, port });
    cleanups.push(api.close);
    url = api.url;
    process.stderr.write(`FilmCraft ${backend.mode} API ready at ${url}; bearer authentication required.\n`);
  }
  if (action === 'mcp') {
    const api = new FilmcraftApiClient(url, token, Number(process.env.FILMCRAFT_TIMEOUT_MS ?? 120_000) + 10_000);
    const server = await startStdio(api);
    cleanups.push(() => server.close());
    server.onclose = () => { void stop(); };
  }
}

main().catch(async error => {
  process.stderr.write(`jev-filmcraft: ${errorMessage(error)}\n`);
  await stop();
  process.exitCode = 1;
});
