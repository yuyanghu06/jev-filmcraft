import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const checkout = resolve(process.env.FILMCRAFT_DIR ?? fileURLToPath(new URL('../../../vendor/filmcraft', import.meta.url)));
const patch = fileURLToPath(new URL('./distribution.patch', import.meta.url));
const git = args => execFileSync('git', ['-C', checkout, 'apply', ...args, patch], { stdio: 'pipe' });
try {
  git(['--check', '--reverse']);
  console.log('Distribution branding patch already applied.');
} catch {
  try { git(['--check']); git([]); }
  catch { throw new Error('Cannot apply distribution branding patch; check FilmCraft revision and local changes.'); }
}
