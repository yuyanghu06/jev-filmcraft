import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { PluginError } from './core.js';
import type { NativeOptions } from './adapters/native.js';

export const repository = fileURLToPath(new URL('../../../', import.meta.url));

export function filmcraftDirectory(env: NodeJS.ProcessEnv = process.env) {
  return resolve(env.FILMCRAFT_DIR ?? join(repository, 'vendor/filmcraft'));
}

export function nativeOptions(env = process.env): NativeOptions {
  const mode = env.FILMCRAFT_MODE ?? 'headless';
  if (mode !== 'headless' && mode !== 'bridge') throw new PluginError('CONFIG', 'FILMCRAFT_MODE must be headless or bridge');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = ['release', 'debug'].map(profile => join(filmcraftDirectory(env), 'target', profile, `filmcraft-cli${ext}`));
  const binary = env.FILMCRAFT_BIN ?? candidates.find(existsSync);
  if (!binary) throw new PluginError('CONFIG', 'FilmCraft CLI is not built. Run npm run build:filmcraft, or set FILMCRAFT_BIN to an existing filmcraft-cli executable.');
  const timeoutMs = Number(env.FILMCRAFT_TIMEOUT_MS ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) throw new PluginError('CONFIG', 'FILMCRAFT_TIMEOUT_MS must be an integer from 1000 to 3600000');
  if (env.FILMCRAFT_DEMO && !['true', 'false'].includes(env.FILMCRAFT_DEMO)) throw new PluginError('CONFIG', 'FILMCRAFT_DEMO must be true or false');
  return {
    binary, mode, timeoutMs,
    bridge: env.FILMCRAFT_BRIDGE ?? '127.0.0.1:9876',
    project: env.FILMCRAFT_PROJECT ? resolve(env.FILMCRAFT_PROJECT) : undefined,
    demo: env.FILMCRAFT_DEMO === 'true',
    dataDir: env.FILMCRAFT_DATA_DIR ? resolve(env.FILMCRAFT_DATA_DIR) : mode === 'headless' ? join(homedir(), '.local/share/jev-filmcraft') : undefined,
  };
}
