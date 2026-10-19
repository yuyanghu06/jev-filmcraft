import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRustLicenses } from './licenses.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const here = dirname(fileURLToPath(import.meta.url));
const upstream = resolve(process.env.FILMCRAFT_DIR ?? join(root, 'vendor/filmcraft'));
const version = process.env.JEV_FILMCRAFT_VERSION ?? '0.1.0-preview.1';
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('Build on a Mac with the target architecture.');
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version');
if (process.argv.slice(2).some(a => a !== '--skip-build')) throw new Error('Usage: macos.mjs [--skip-build]');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
const output = join(root, 'artifacts/releases');
const work = join(output, `build-${process.arch}`);
const app = join(work, 'Jev FilmCraft.app');
const contents = join(app, 'Contents');
const resources = join(contents, 'Resources');
const runtime = join(resources, 'runtime');
const macos = join(contents, 'MacOS');
const licenses = join(resources, 'Licenses');
const basename = `jev-filmcraft-${version}-macos-${process.arch}`;
const archive = join(output, `${basename}.zip`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

run(process.execPath, [join(root, 'plugins/filmcraft/native/apply.mjs'), upstream]);
run(process.execPath, [join(here, 'apply-distribution.mjs')]);
run('npm', ['run', 'build']);
if (!process.argv.includes('--skip-build')) {
  const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: '13.5' };
  delete env.CRAFT_FONTS_DIR; // This package ships the upstream bundled fonts and their licenses.
  run('cargo', ['build', '--locked', '--release', '--manifest-path', join(upstream, 'Cargo.toml'), '-p', 'filmcraft', '-p', 'filmcraft-cli'], { env });
}
await rm(work, { recursive: true, force: true });
for (const dir of [macos, runtime, licenses]) await mkdir(dir, { recursive: true });
const target = resolve(process.env.CARGO_TARGET_DIR ?? join(upstream, 'target'));
for (const bin of ['filmcraft', 'filmcraft-cli']) {
  await cp(join(target, 'release', bin), join(macos, bin));
  run('strip', ['-x', join(macos, bin)]);
}

// Use official standalone Node; a Homebrew Node executable depends on Homebrew dylibs.
const nodeVersion = 'v24.22.0';
const nodeHashes = {
  arm64: '6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5',
  x64: '495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91',
};
const nodeName = `node-${nodeVersion}-darwin-${process.arch}`;
const download = join(output, `${nodeName}.tar.gz`);
await mkdir(output, { recursive: true });
let nodeArchive = await readFile(download).catch(() => undefined);
if (!nodeArchive || sha256(nodeArchive) !== nodeHashes[process.arch]) {
  run('curl', ['--fail', '--location', '--retry', '3', '--output', download, `https://nodejs.org/dist/${nodeVersion}/${nodeName}.tar.gz`]);
  nodeArchive = await readFile(download);
}
if (sha256(nodeArchive) !== nodeHashes[process.arch]) throw new Error('Node archive checksum mismatch');
run('tar', ['-xzf', download, '-C', work, `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
await mkdir(join(resources, 'node/bin'), { recursive: true });
await cp(join(work, nodeName, 'bin/node'), join(resources, 'node/bin/node'));
await cp(join(work, nodeName, 'LICENSE'), join(licenses, 'Node-LICENSE.txt'));
await chmod(join(resources, 'node/bin/node'), 0o755);

// Preserve the runtime's workspace layout, but copy only compiled code and the empty template.
for (const file of ['package.json', 'package-lock.json']) await cp(join(root, file), join(runtime, file));
await mkdir(join(runtime, 'plugins/filmcraft/config'), { recursive: true });
await cp(join(root, 'plugins/filmcraft/package.json'), join(runtime, 'plugins/filmcraft/package.json'));
await cp(join(root, 'plugins/filmcraft/dist'), join(runtime, 'plugins/filmcraft/dist'), { recursive: true });
await cp(join(root, 'plugins/filmcraft/config/providers.example.json'), join(runtime, 'plugins/filmcraft/config/providers.example.json'));
await cp(join(here, 'launch.mjs'), join(runtime, 'launch.mjs'));
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime });
await cp(join(upstream, 'assets/app-icon/filmcraft.icns'), join(resources, 'FilmCraft.icns'));
for (const file of ['LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE', 'ATTRIBUTION.md']) await cp(join(upstream, file), join(licenses, file));
await cp(join(upstream, 'assets/app-icon/filmcraft.icns.attribution'), join(licenses, 'FilmCraft-icon.attribution'));
await cp(join(upstream, 'assets/app-icon/LICENSE.txt'), join(licenses, 'FilmCraft-icon-LICENSE.txt'));
for (const file of await readdir(join(upstream, 'assets/fonts'))) {
  if (file.endsWith('.txt') || file.endsWith('.attribution')) await cp(join(upstream, 'assets/fonts', file), join(licenses, file));
}
const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`, '--manifest-path', join(upstream, 'Cargo.toml')], { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 20 * 1024 * 1024 }));
const dependencies = await collectRustLicenses(metadata.packages, join(licenses, 'Rust'), join(output, 'notice-cache'));
await writeFile(join(licenses, 'Rust-dependencies.json'), JSON.stringify(dependencies, null, 2));

const shortVersion = version.split('-')[0];
await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Jev FilmCraft</string>
<key>CFBundleDisplayName</key><string>Jev FilmCraft</string>
<key>CFBundleIdentifier</key><string>com.yuyanghu.jev-filmcraft</string>
<key>CFBundleExecutable</key><string>JevFilmCraft</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${shortVersion}</string>
<key>CFBundleVersion</key><string>${shortVersion}</string>
<key>CFBundleIconFile</key><string>FilmCraft</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>LSApplicationCategoryType</key><string>public.app-category.video</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Record voice-over onto the FilmCraft timeline.</string>
<key>NSHumanReadableCopyright</key><string>Community build based on FilmCraft. See Resources/Licenses for notices.</string>
</dict></plist>
`);
run('plutil', ['-lint', join(contents, 'Info.plist')]);
run('xcrun', ['swiftc', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.5`, join(here, 'Launcher.swift'), '-o', join(macos, 'JevFilmCraft')]);

const binaries = [join(resources, 'node/bin/node'), ...['filmcraft', 'filmcraft-cli', 'JevFilmCraft'].map(bin => join(macos, bin))];
for (const binary of binaries) {
  const linked = run('otool', ['-L', binary], { encoding: 'utf8', stdio: 'pipe' });
  if (/\/opt\/homebrew|\/usr\/local|\/Users\//.test(linked.split('\n').slice(1).join('\n'))) throw new Error(`Non-portable library dependency in ${binary}`);
}
const identity = process.env.MACOS_SIGN_IDENTITY ?? '-';
const sign = file => run('codesign', ['--force', '--sign', identity, identity === '-' ? '--timestamp=none' : '--timestamp', file]);
for (const binary of binaries) sign(binary);
sign(app);
run('codesign', ['--verify', '--strict', '--deep', app]);
const sourceCommit = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
const upstreamCommit = run('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
await writeFile(join(output, `${basename}.build.json`), JSON.stringify({ version, platform: 'darwin', architecture: process.arch, minimumMacOS: '13.5', nodeVersion, sourceCommit, upstreamCommit, signing: identity === '-' ? 'ad-hoc' : 'Developer ID supplied by builder', notarized: false }, null, 2) + '\n');
await rm(archive, { force: true });
run('ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', app, archive]);
await writeFile(join(output, `${basename}.sha256`), `${sha256(await readFile(archive))}  ${basename}.zip\n`);
console.log(`Packaged ${archive}\nInstall: unzip, drag Jev FilmCraft.app to Applications, then open it.\nThis build is not notarized; see the release notes for macOS first-launch instructions.`);
