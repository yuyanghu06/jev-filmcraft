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
  const files = ['crates/ui-egui/src/lib.rs', 'crates/ui-egui/src/control.rs', 'Cargo.lock', 'crates/engine/Cargo.toml', 'crates/engine/src/lib.rs', 'crates/engine/src/commands.rs'];
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
    const engineLib = join(checkout, 'crates/engine/src/lib.rs');
    const audioHook = (await readFile(engineLib, 'utf8')).match(/#\[path = ("[^\n]+")\]\s*pub mod filmcraft_audio;/)?.[1];
    assert.ok(audioHook, 'audio module hook exists');
    assert.equal(resolve(dirname(engineLib), JSON.parse(audioHook)), join(repository, 'plugins/filmcraft/native/audio.rs'));
    const engineCommands = join(checkout, 'crates/engine/src/commands.rs');
    assert.match(await readFile(engineCommands, 'utf8'), /query!\("audio\.read".*crate::filmcraft_audio::read\(s, p\)/);
    assert.match(await readFile(join(checkout, 'crates/engine/Cargo.toml'), 'utf8'), /base64 = "0\.22\.1"/);
    assert.match(await readFile(join(checkout, 'Cargo.lock'), 'utf8'), /name = "filmcraft-engine"\nversion = "[^"]+"\ndependencies = \[\n "base64 0\.22\.1"/);
    const installed = await Promise.all(files.map(file => readFile(join(checkout, file), 'utf8')));
    const reapplied = execFileSync(process.execPath, [installer, checkout], { encoding: 'utf8' });
    assert.match(reapplied, /audio hook already applied/); assert.match(reapplied, /chat hook already applied/);
    assert.deepEqual(await Promise.all(files.map(file => readFile(join(checkout, file), 'utf8'))), installed);

    const binary = join(checkout, 'target/debug', `filmcraft-cli${process.platform === 'win32' ? '.exe' : ''}`);
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, '');
    assert.equal(nativeOptions({ FILMCRAFT_DIR: checkout }).binary, binary);
    assert.equal(nativeOptions({ FILMCRAFT_DIR: checkout, FILMCRAFT_BIN: '/custom/cli' }).binary, '/custom/cli');

    const conflicting = patched.replace('jev_chat: Default::default(),', 'jev_chat: local_change(),');
    await writeFile(lib, conflicting);
    assert.throws(() => execFileSync(process.execPath, [installer], { env, stdio: 'pipe' }));
    assert.equal(await readFile(lib, 'utf8'), conflicting, 'installer leaves local UI changes intact');
    assert.equal(await readFile(engineLib, 'utf8'), installed[4], 'UI conflict preserves the engine hook');
    await writeFile(lib, patched);
    const conflictingEngine = installed[5]!.replace('crate::filmcraft_audio::read(s, p)', 'local_audio_change(s, p)');
    await writeFile(engineCommands, conflictingEngine);
    assert.throws(() => execFileSync(process.execPath, [installer], { env, stdio: 'pipe' }));
    assert.equal(await readFile(engineCommands, 'utf8'), conflictingEngine, 'installer leaves local engine changes intact');
    assert.equal(await readFile(lib, 'utf8'), patched, 'engine conflict preserves the UI hook');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
