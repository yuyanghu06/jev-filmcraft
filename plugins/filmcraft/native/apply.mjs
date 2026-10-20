import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const vendor = resolve(process.argv[2] ?? process.env.FILMCRAFT_DIR ?? fileURLToPath(new URL('../../../vendor/filmcraft', import.meta.url)));
function applyHook(name, patchFile, module, crate) {
  const source = fileURLToPath(new URL(`./${module}`, import.meta.url));
  const modulePath = relative(join(vendor, `crates/${crate}/src`), source).split(sep).join('/');
  const patch = readFileSync(new URL(patchFile, import.meta.url), 'utf8')
    .replace(JSON.stringify(`../../../../../plugins/filmcraft/native/${module}`), JSON.stringify(modulePath));
  const git = args => execFileSync('git', ['-C', vendor, 'apply', ...args, '-'], { input: patch, stdio: 'pipe' });
  try {
    git(['--check', '--reverse']);
    console.log(`FilmCraft ${name} hook already applied.`);
  } catch {
    try { git(['--check']); git([]); console.log(`Applied FilmCraft ${name} hook to ${vendor}.`); }
    catch { throw new Error(`Cannot apply ${name} hook. Check the pinned FilmCraft revision and local changes; no files were reset.`); }
  }
}
applyHook('audio', './audio.patch', 'audio.rs', 'engine');
if (!process.argv.includes('--audio-only')) applyHook('chat', './filmcraft.patch', 'panel.rs', 'ui-egui');
