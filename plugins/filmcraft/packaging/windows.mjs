import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { root, here, run, npm, copyRuntime, copyLicenses } from './common.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64.');
const version = process.env.JEV_FILMCRAFT_VERSION ?? '0.1.0-preview.2';
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version');
if (process.argv.slice(2).some(a => a !== '--skip-build')) throw new Error('Usage: npm run package:windows -- [--skip-build]');
const upstream = resolve(process.env.FILMCRAFT_DIR ?? join(root, 'vendor/filmcraft'));
const output = join(root, 'artifacts/releases');
const work = join(output, 'build-windows-x64');
const app = join(work, 'Jev FilmCraft');
const runtime = join(app, 'runtime');
const licenses = join(app, 'Licenses');
const basename = `jev-filmcraft-${version}-windows-x64`;
const archive = join(output, `${basename}.zip`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const targetTriple = 'x86_64-pc-windows-msvc';
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const ps = (script, env) => run(powershell, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], { env: { ...process.env, ...env } });

run(process.execPath, [join(root, 'plugins/filmcraft/native/apply.mjs'), upstream]);
run(process.execPath, [join(here, 'apply-distribution.mjs')]);
npm(['run', 'build']);
if (!process.argv.includes('--skip-build')) {
  const env = { ...process.env, FILMCRAFT_REQUIRE_WINRES: '1', CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: '-C target-feature=+crt-static' };
  delete env.CRAFT_FONTS_DIR;
  run('cargo', ['build', '--locked', '--release', '--target', targetTriple, '--manifest-path', join(upstream, 'Cargo.toml'), '-p', 'filmcraft', '-p', 'filmcraft-cli'], { env });
}
await rm(work, { recursive: true, force: true });
for (const dir of [join(app, 'bin'), join(app, 'node'), runtime, licenses]) await mkdir(dir, { recursive: true });
const target = resolve(process.env.CARGO_TARGET_DIR ?? join(upstream, 'target'));
for (const bin of ['filmcraft', 'filmcraft-cli']) await cp(join(target, targetTriple, 'release', `${bin}.exe`), join(app, 'bin', `${bin}.exe`));

// Official standalone Node, verified against the release's SHASUMS256.txt.
const nodeVersion = 'v24.22.0';
const nodeName = `node-${nodeVersion}-win-x64`;
const expectedHash = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3';
const download = join(output, `${nodeName}.zip`);
let nodeArchive = await readFile(download).catch(() => undefined);
if (!nodeArchive || sha256(nodeArchive) !== expectedHash) {
  const response = await fetch(`https://nodejs.org/dist/${nodeVersion}/${nodeName}.zip`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  nodeArchive = Buffer.from(await response.arrayBuffer());
  if (sha256(nodeArchive) !== expectedHash) throw new Error('Node archive checksum mismatch');
  await writeFile(download, nodeArchive);
}
ps('Expand-Archive -LiteralPath $env:JEV_ARCHIVE -DestinationPath $env:JEV_DESTINATION -Force', { JEV_ARCHIVE: download, JEV_DESTINATION: work });
await cp(join(work, nodeName, 'node.exe'), join(app, 'node/node.exe'));
await cp(join(work, nodeName, 'LICENSE'), join(licenses, 'Node-LICENSE.txt'));
await copyRuntime(runtime);
await copyLicenses(upstream, licenses, targetTriple, output, 'ico');

// .NET Framework is part of supported Windows versions; this GUI launcher needs no SDK at runtime.
const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/reference:System.Windows.Forms.dll', `/win32icon:${join(upstream, 'assets/app-icon/filmcraft.ico')}`, `/out:${join(app, 'JevFilmCraft.exe')}`, join(here, 'Launcher.cs')]);
for (const [file, subsystem] of [['JevFilmCraft.exe', 2], ['bin/filmcraft.exe', 2], ['bin/filmcraft-cli.exe', 3], ['node/node.exe', 3]]) {
  const bytes = await readFile(join(app, file));
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error(`Not a Windows executable: ${file}`);
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 94 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 92) !== subsystem) throw new Error(`Unexpected Windows executable architecture or subsystem: ${file}`);
}
await writeFile(join(app, 'START HERE.txt'), 'Jev FilmCraft\r\n\r\nExtract the ENTIRE folder, then double-click JevFilmCraft.exe. Keep bin, node, runtime and Licenses beside it. No Node or Rust installation is needed.\r\n\r\nChoose a provider in the Assistant sidebar, open Settings, enter your own API key, and Apply. Saved keys are unencrypted in %LOCALAPPDATA%\\Jev FilmCraft\\providers.json. Updates preserve them.\r\n\r\nFor Codex or Claude Code, paste the displayed install command into PowerShell after putting this folder in its permanent location. Keep the editor open while using its MCP tools.\r\n\r\nThis preview is unsigned. Windows may display a SmartScreen warning on first launch.\r\n\r\nhttps://github.com/yuyanghu06/jev-filmcraft\r\n');
const sourceCommit = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
const upstreamCommit = run('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
await writeFile(join(output, `${basename}.build.json`), JSON.stringify({ version, platform: 'win32', architecture: 'x64', minimumWindows: 'Windows 10 x64', nodeVersion, sourceCommit, upstreamCommit, signing: 'unsigned', staticRustCRT: true }, null, 2) + '\n');
await rm(archive, { force: true });
ps('Compress-Archive -LiteralPath $env:JEV_SOURCE -DestinationPath $env:JEV_ARCHIVE -CompressionLevel Optimal', { JEV_SOURCE: app, JEV_ARCHIVE: archive });
await writeFile(join(output, `${basename}.sha256`), `${sha256(await readFile(archive))}  ${basename}.zip\n`);
console.log(`Packaged ${archive}\nInstall: extract the whole folder, then open JevFilmCraft.exe.`);
