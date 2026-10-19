import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { repository, nativeOptions } from '../../src/config.js';

test('install into a separate FilmCraft checkout, resolve binaries, and preserve conflicts', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'filmcraft install '));
  const checkout = join(scratch, 'fresh filmcraft');
  const upstream = join(repository, 'vendor/filmcraft');
  const installer = join(repository, 'plugins/filmcraft/native/apply.mjs');
  const files = ['crates/ui-egui/src/lib.rs', 'crates/ui-egui/src/control.rs'];
  try {
    await mkdir(checkout);
    execFileSync('git', ['init', '--quiet', checkout]);
    for (const file of files) {
      const source = execFileSync('git', ['-C', upstream, 'show', `105c09bd80e2c86ec7464a2c59a2501eb89ffc5c:${file}`]);
      await mkdir(dirname(join(checkout, file)), { recursive: true });
      await writeFile(join(checkout, file), source);
    }
    const env = { ...process.env, FILMCRAFT_DIR: checkout };
    execFileSync(process.execPath, [installer], { env });
    const lib = join(checkout, files[0]!);
    const patched = await readFile(lib, 'utf8');
    const modulePath = patched.match(/#\[path = ("[^\n]+")\]\s*mod jev_chat;/)?.[1];
    assert.ok(modulePath, 'sidebar module hook exists');
    assert.equal(resolve(dirname(lib), JSON.parse(modulePath)), join(repository, 'plugins/filmcraft/native/panel.rs'));
    assert.match(await readFile(join(checkout, files[1]!), 'utf8'), /"chat.inspect" => ok\(app.jev_chat.inspect\(\)\)/);
    assert.match(execFileSync(process.execPath, [installer, checkout], { encoding: 'utf8' }), /already applied/);
    assert.equal(await readFile(lib, 'utf8'), patched);

    const binary = join(checkout, 'target/debug', `filmcraft-cli${process.platform === 'win32' ? '.exe' : ''}`);
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, '');
    assert.equal(nativeOptions({ FILMCRAFT_DIR: checkout }).binary, binary);
    assert.equal(nativeOptions({ FILMCRAFT_DIR: checkout, FILMCRAFT_BIN: '/custom/cli' }).binary, '/custom/cli');

    const conflicting = patched.replace('jev_chat: Default::default(),', 'jev_chat: local_change(),');
    await writeFile(lib, conflicting);
    assert.throws(() => execFileSync(process.execPath, [installer], { env, stdio: 'pipe' }));
    assert.equal(await readFile(lib, 'utf8'), conflicting, 'installer leaves local changes intact');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
