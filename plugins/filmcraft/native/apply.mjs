import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const vendor = resolve(process.argv[2] ?? process.env.FILMCRAFT_DIR ?? fileURLToPath(new URL('../../../vendor/filmcraft', import.meta.url)));
const panel = fileURLToPath(new URL('./panel.rs', import.meta.url));
const modulePath = relative(join(vendor, 'crates/ui-egui/src'), panel).split(sep).join('/');
const patch = readFileSync(new URL('./filmcraft.patch', import.meta.url), 'utf8')
  .replace('"../../../../../plugins/filmcraft/native/panel.rs"', JSON.stringify(modulePath));
const git = args => execFileSync('git', ['-C', vendor, 'apply', ...args, '-'], { input: patch, stdio: 'pipe' });
try {
  git(['--check', '--reverse']);
  console.log('FilmCraft chat hook already applied.');
} catch {
  try { git(['--check']); git([]); console.log(`Applied FilmCraft chat hook to ${vendor}.`); }
  catch { throw new Error('Cannot apply chat hook. Check the pinned FilmCraft revision and local changes; no files were reset.'); }
}
