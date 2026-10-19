import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRustLicenses } from './licenses.mjs';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const here = fileURLToPath(new URL('./', import.meta.url));
export const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
export function npm(args, options = {}) {
  // npm.cmd cannot be invoked directly by execFile on Windows. Avoid shell quoting entirely.
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...args], options);
  if (process.platform === 'win32') throw new Error('Start packaging with npm run package:windows');
  return run('npm', args, options);
}
export async function copyRuntime(runtime) {
  for (const file of ['package.json', 'package-lock.json']) await cp(join(root, file), join(runtime, file));
  await mkdir(join(runtime, 'plugins/filmcraft/config'), { recursive: true });
  await cp(join(root, 'plugins/filmcraft/package.json'), join(runtime, 'plugins/filmcraft/package.json'));
  await cp(join(root, 'plugins/filmcraft/dist'), join(runtime, 'plugins/filmcraft/dist'), { recursive: true });
  await cp(join(root, 'plugins/filmcraft/config/providers.example.json'), join(runtime, 'plugins/filmcraft/config/providers.example.json'));
  await cp(join(here, 'launch.mjs'), join(runtime, 'launch.mjs'));
  npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime });
  // The CLI imports its workspace by relative path. A Windows npm junction points at the build
  // machine; removing this unused workspace link makes the archive safe to relocate.
  await rm(join(runtime, 'node_modules/@jev/filmcraft-plugin'), { recursive: true, force: true });
}
export async function copyLicenses(upstream, licenses, target, output, icon) {
  for (const file of ['LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE', 'ATTRIBUTION.md']) await cp(join(upstream, file), join(licenses, file));
  await cp(join(upstream, `assets/app-icon/filmcraft.${icon}.attribution`), join(licenses, 'FilmCraft-icon.attribution'));
  await cp(join(upstream, 'assets/app-icon/LICENSE.txt'), join(licenses, 'FilmCraft-icon-LICENSE.txt'));
  for (const file of await readdir(join(upstream, 'assets/fonts'))) {
    if (file.endsWith('.txt') || file.endsWith('.attribution')) await cp(join(upstream, 'assets/fonts', file), join(licenses, file));
  }
  const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', target, '--manifest-path', join(upstream, 'Cargo.toml')], { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 30 * 1024 * 1024 }));
  const dependencies = await collectRustLicenses(metadata.packages, join(licenses, 'Rust'), join(output, 'notice-cache'));
  await writeFile(join(licenses, 'Rust-dependencies.json'), JSON.stringify(dependencies, null, 2));
}
