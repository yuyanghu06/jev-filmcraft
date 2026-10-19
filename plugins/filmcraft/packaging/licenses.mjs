import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Some published Rust crates omit license files; recover notices from their exact upstream VCS revision. */
export async function collectRustLicenses(packages, destination, cache) {
  const remote = new Map();
  const dependencies = [];
  for (const pkg of packages.filter(p => p.source)) {
    const directory = dirname(pkg.manifest_path);
    const target = join(destination, `${pkg.name}-${pkg.version}`);
    await mkdir(target, { recursive: true });
    const names = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice|copyright)(?:[._-]|$)/i.test(name));
    if (pkg.license_file && !names.includes(pkg.license_file)) names.push(pkg.license_file);
    for (const name of names) await cp(join(directory, name), join(target, basename(name)), { recursive: true });
    let noticeSource = 'published crate';
    if (names.length === 0) {
      const vcs = JSON.parse(await readFile(join(directory, '.cargo_vcs_info.json'), 'utf8').catch(() => '{}'));
      const revision = vcs.git?.sha1 ?? pkg.source.match(/#([a-f0-9]{40})$/)?.[1];
      const repo = pkg.repository?.match(/^https?:\/\/github.com\/([^/]+)\/([^/#]+)/);
      if (!revision || !/^[a-f0-9]{40}$/.test(revision) || !repo) throw new Error(`Cannot locate license notices for ${pkg.name}`);
      const project = `${repo[1]}/${repo[2].replace(/\.git$/, '')}`;
      const key = `${project}/${revision}`;
      if (!remote.has(key)) {
        const cached = join(cache, project, revision);
        await mkdir(cached, { recursive: true });
        const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE.MIT', 'LICENSE.APACHE', 'LICENSE-ZLIB', 'COPYING', 'NOTICE'];
        const found = [];
        for (let start = 0; start < candidates.length; start += 5) {
          const batch = await Promise.all(candidates.slice(start, start + 5).map(async name => {
            const file = join(cached, name);
            if (await readFile(file).then(() => true, () => false)) return name;
            const response = await fetch(`https://raw.githubusercontent.com/${project}/${revision}/${name}`, { signal: AbortSignal.timeout(30_000) });
            if (response.status === 404) return undefined;
            if (!response.ok) throw new Error(`License download failed for ${project}: HTTP ${response.status}`);
            await writeFile(file, await response.text());
            return name;
          }));
          found.push(...batch.filter(Boolean));
        }
        if (!found.some(name => /LICENSE|COPYING/.test(name))) {
          // This old crate declares MIT but has no separate license file in the published archive
          // or its exact source revision. Preserve its own attribution and the standard SPDX text.
          if (pkg.name !== 'dispatch' || pkg.version !== '0.2.0' || pkg.license !== 'MIT') throw new Error(`No license files found for ${project} at ${revision}`);
          const text = await readFile(new URL('./SPDX-MIT.txt', import.meta.url), 'utf8');
          await writeFile(join(cached, 'LICENSE-metadata.txt'), `dispatch 0.2.0 declares MIT in Cargo metadata.\nAuthors: ${(pkg.authors ?? []).join(', ')}\nSource: https://github.com/${project}/tree/${revision}\nNo separate license file is included upstream.\n\n${text}`);
          found.push('LICENSE-metadata.txt');
        }
        remote.set(key, { cached, found });
      }
      const { cached, found } = remote.get(key);
      for (const name of found) await cp(join(cached, name), join(target, name));
      noticeSource = `https://github.com/${project}/tree/${revision}`;
    }
    dependencies.push({ name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository, noticeSource });
  }
  return dependencies;
}
