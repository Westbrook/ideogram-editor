import {readFile, writeFile, realpath, readdir, lstat, readlink} from 'node:fs/promises';
import {resolve, join, relative, sep} from 'node:path';
import {createRequire} from 'node:module';
import {hashFile, json, sha256} from './common.mjs';

export async function browserCacheIdentity(directory) {
  directory = await realpath(directory); const files = [];
  async function walk(path) {
    for (const entry of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(path, entry.name), name = relative(directory, absolute).split(sep).join('/');
      // Installation ownership links/locks are not executable browser inputs.
      // Every executable, shared library, resource and distribution link is.
      if (name === '.links' || name === '__dirlock') continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await realpath(absolute);
        if (target !== directory && !target.startsWith(directory + sep)) throw Error('Browser distribution link leaves its sealed cache');
        files.push({path: name, link: await readlink(absolute)});
      } else if (info.isDirectory()) await walk(absolute);
      else if (info.isFile()) files.push({path: name, ...await hashFile(absolute)});
      else throw Error('Browser cache contains a special file');
    }
  }
  await walk(directory);
  if (!files.length) throw Error('Empty browser distribution cache');
  return {sha256: sha256(json(files)), files};
}

export async function verifyBrowsers(cwd = process.cwd(), selected = ['chromium', 'firefox', 'webkit'], expected = null) {
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(engine => !['chromium', 'firefox', 'webkit'].includes(engine))) throw Error('Select distinct pinned browser engines');
  const require = createRequire(resolve(cwd, 'package.json'));
  const browserAPI = require('@playwright/test');
  const packagePath = require.resolve('playwright-core/package.json');
  const packageJSON = JSON.parse(await readFile(packagePath));
  if (packageJSON.version !== '1.63.0') throw Error('Pinned Playwright 1.63.0 required');
  const revisionManifest = JSON.parse(await readFile(resolve(packagePath, '../browsers.json')));
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH || process.env.PLAYWRIGHT_BROWSERS_PATH === '0') throw Error('An isolated explicit browser cache is required');
  const cache = await browserCacheIdentity(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (expected && expected.cache?.sha256 !== cache.sha256) throw Error('Browser distribution cache changed before launch');
  const engines = [];
  for (const [engine, version, revision] of [['chromium', '153.0.8010.12', '1243'], ['firefox', '155.0', '1543'], ['webkit', '26.6', '2359']]) {
    if (!selected.includes(engine)) continue;
    const entry = revisionManifest.browsers.find(item => item.name === engine);
    if (entry?.revision !== revision || entry.browserVersion !== version) throw Error(`Pinned ${engine} browser manifest mismatch`);
    const executable = browserAPI[engine].executablePath(), identity = await hashFile(executable);
    if (expected && !expected.engines?.some(item => item.engine === engine && item.version === version && item.sha256 === identity.sha256)) throw Error(`Browser cache identity changed before launch: ${engine}`);
    const browser = await browserAPI[engine].launch({executablePath: executable});
    try {
      if (browser.version() !== version) throw Error(`Wrong executable browser version: ${engine}`);
      engines.push({engine, version: browser.version(), revision, executable, ...identity, platformRevisionOverride: entry.revisionOverrides ?? null});
    } finally { await browser.close(); }
  }
  return {kind: 'developer-browser-cache-verification-1', playwright: packageJSON.version, revisionManifest, engines, cache,
    scope: 'All installed distribution bytes/links, including Chromium default headless shell, are sealed. Reported engine versions are launched with the explicitly hashed public executable path.'};
}
if (import.meta.main) {
  if (!process.argv[2]) throw Error('Exclusive browser identity output path is required');
  await writeFile(process.argv[2], json(await verifyBrowsers(process.cwd(), process.argv[3] ? process.argv[3].split(',') : undefined, process.argv[4] ? JSON.parse(await readFile(process.argv[4])) : null)), {flag: 'wx'});
}
