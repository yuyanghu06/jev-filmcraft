import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeOptions } from '../src/config.js';
import { installCommands } from '../src/chat/desktop.js';

test('MCP installation commands quote installed paths for the destination shell', () => {
  const windows = installCommands({ FILMCRAFT_LAUNCHER: "C:\\Users\\O'Brien\\Jev FilmCraft\\runtime\\launch.mjs" }, 'win32');
  assert(windows.codex.includes("'C:\\Users\\O''Brien\\Jev FilmCraft\\runtime\\launch.mjs' desktop-mcp"));
  assert(windows['claude-code'].startsWith('claude mcp add --scope user --transport stdio filmcraft -- '));
  const mac = installCommands({ FILMCRAFT_LAUNCHER: "/Applications/O'Brien/Jev FilmCraft.app/Contents/Resources/runtime/launch.mjs" }, 'darwin');
  assert(mac.codex.includes("/O'\\''Brien/"));
});


test('automatic native binary discovery chooses the newest build, keeps release on ties and honors explicit overrides', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'filmcraft-binary-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const release = join(directory, 'target/release', `filmcraft-cli${suffix}`);
  const debug = join(directory, 'target/debug', `filmcraft-cli${suffix}`);
  for (const file of [release, debug]) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'test placeholder'); }
  const old = new Date('2020-01-01T00:00:00.000Z'), fresh = new Date('2021-01-01T00:00:00.000Z');
  const discover = () => nativeOptions({ FILMCRAFT_DIR: directory }).binary;
  await utimes(release, old, old); await utimes(debug, fresh, fresh); assert.equal(discover(), debug);
  await utimes(release, fresh, fresh); await utimes(debug, old, old); assert.equal(discover(), release);
  await utimes(debug, fresh, fresh); assert.equal(discover(), release);
  assert.equal(nativeOptions({ FILMCRAFT_DIR: directory, FILMCRAFT_BIN: '/explicit/cli' }).binary, '/explicit/cli');
  await rm(release); assert.equal(discover(), debug);
  await writeFile(release, 'test placeholder'); await rm(debug); assert.equal(discover(), release);
});
