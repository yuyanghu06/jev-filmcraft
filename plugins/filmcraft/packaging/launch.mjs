// Runs from the installed runtime folder, including for external MCP clients.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';

const runtime = dirname(fileURLToPath(import.meta.url));
const contents = dirname(dirname(runtime));
const env = process.env;
const windows = process.platform === 'win32';
const binaries = windows ? join(dirname(runtime), 'bin') : join(contents, 'MacOS');
env.FILMCRAFT_PACKAGED = '1';
env.FILMCRAFT_STATE_DIR ??= windows
  ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'Jev FilmCraft')
  : join(homedir(), 'Library/Application Support/Jev FilmCraft');
env.FILMCRAFT_PROVIDERS_CONFIG ??= join(env.FILMCRAFT_STATE_DIR, 'providers.json');
env.FILMCRAFT_DATA_DIR ??= join(env.FILMCRAFT_STATE_DIR, 'editor');
env.FILMCRAFT_BIN = join(binaries, windows ? 'filmcraft-cli.exe' : 'filmcraft-cli');
env.FILMCRAFT_DESKTOP_BIN = join(binaries, windows ? 'filmcraft.exe' : 'filmcraft');
env.FILMCRAFT_LAUNCHER = fileURLToPath(import.meta.url);
process.argv[2] ??= 'desktop';

try {
  if (process.argv[2] === 'desktop') {
    await mkdir(env.FILMCRAFT_STATE_DIR, { recursive: true, mode: 0o700 });
    const { initProviderConfig } = await import('./plugins/filmcraft/dist/chat/config.js');
    await initProviderConfig(env);
  }
  await import('./plugins/filmcraft/dist/cli.js');
} catch {
  // Do not echo configuration contents into a Finder startup alert or log.
  process.stderr.write('Jev FilmCraft could not initialize. Check your local provider settings and reinstall the app if needed.\n');
  process.exitCode = 1;
}
