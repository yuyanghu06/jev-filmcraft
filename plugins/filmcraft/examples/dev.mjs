// Source-only desktop, with settings, sessions, editor data and logs isolated from the installed app.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repository, filmcraftDirectory } from '../dist/config.js';
import { initProviderConfig } from '../dist/chat/config.js';

const env = process.env;
env.FILMCRAFT_STATE_DIR ??= join(repository, 'artifacts/dev');
env.FILMCRAFT_PROVIDERS_CONFIG ??= join(env.FILMCRAFT_STATE_DIR, 'providers.json');
env.FILMCRAFT_DATA_DIR ??= join(env.FILMCRAFT_STATE_DIR, 'editor');
env.FILMCRAFT_DESKTOP_BIN ??= join(filmcraftDirectory(env), 'target/debug', process.platform === 'win32' ? 'filmcraft.exe' : 'filmcraft');
env.FILMCRAFT_LAUNCHER = fileURLToPath(import.meta.url);
delete env.FILMCRAFT_PACKAGED;
await initProviderConfig(env);
process.argv[2] ??= 'desktop';
await import('../dist/cli.js');
