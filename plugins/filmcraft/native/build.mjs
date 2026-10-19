import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (!['cli', 'desktop'].includes(target)) throw new Error('Usage: build.mjs cli|desktop');
const filmcraft = resolve(process.env.FILMCRAFT_DIR ?? fileURLToPath(new URL('../../../vendor/filmcraft', import.meta.url)));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (target === 'desktop') run(process.execPath, [fileURLToPath(new URL('./apply.mjs', import.meta.url)), filmcraft]);
run('cargo', ['build', '--locked', '--manifest-path', join(filmcraft, 'Cargo.toml'), '-p', target === 'desktop' ? 'filmcraft' : 'filmcraft-cli']);
