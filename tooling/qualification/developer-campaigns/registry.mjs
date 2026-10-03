import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createReadStream, constants} from 'node:fs';
import {readFile, writeFile, mkdir, open, realpath, lstat} from 'node:fs/promises';
import {join, resolve, isAbsolute} from 'node:path';
import {sha256, json, hashFile, verifyManifest, execute, assertSuccess, cleanEnvironment, toolchain} from './common.mjs';

const limits = {tarballBytes: 512 * 1024 * 1024, fixtureBytes: 4 * 1024 * 1024 * 1024, files: 10000};
export const registryNetwork = Object.freeze({profile: 'N', downBitsPerSecond: 100000000, upBitsPerSecond: 20000000, roundTripMs: 40, packetLoss: 0});
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const browserHost = hostname => ['cdn.playwright.dev', 'playwright.azureedge.net', 'playwright.download.prss.microsoft.com'].includes(hostname) || hostname.endsWith('.download.prss.microsoft.com');
export function browserDownloadObjects(sourceLog, overrideLog) {
  const urls = text => [...text.matchAll(/^\s+Download url:\s+(https?:\/\/\S+)\s*$/gm)].map(match => new URL(match[1]));
  const original = urls(sourceLog), overridden = urls(overrideLog);
  if (!original.length || original.length !== overridden.length) throw Error('Browser download dry-run inventory mismatch');
  return original.map((url, index) => {
    if (url.protocol !== 'https:' || !browserHost(url.hostname) || url.username || url.password || url.search || url.hash) throw Error('Unapproved pinned Playwright download host');
    if (overridden[index].origin !== 'http://127.0.0.1:1' || overridden[index].search || overridden[index].hash) throw Error('Uncontrolled override download route');
    return {url: url.href, route: overridden[index].pathname};
  });
}
async function browserResponse(url, signal) {
  for (let count = 0; count < 6; count++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !browserHost(parsed.hostname) || parsed.username || parsed.password) throw Error('Browser archive redirect left the known distribution hosts');
    const response = await fetch(parsed, {redirect: 'manual', signal});
    if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); url = new URL(response.headers.get('location'), parsed).href; continue; }
    if (response.status !== 200 || !response.body) throw Error(`Browser archive fetch failed: ${response.status}`);
    return response;
  }
  throw Error('Too many browser archive redirects');
}
export async function captureBrowserDownloads({sourceRoot, output, signal}) {
  const pinned = await toolchain(sourceRoot), directory = resolve(output); await mkdir(directory, {recursive: false}); await mkdir(join(directory, 'objects'));
  const env = await cleanEnvironment({workspace: directory, npmCache: join(directory, 'npm-cache'), browserCache: join(directory, 'browser-cache')});
  const pkg = JSON.parse(await readFile(join(sourceRoot, 'node_modules/playwright-core/package.json')));
  if (pkg.version !== '1.63.0') throw Error('Pinned Playwright 1.63.0 is required for browser fixture capture');
  const receipt = {kind: 'developer-browser-download-capture-1', startedAt: new Date().toISOString(), status: 'running', commands: [], objects: [], qualification: false};
  try {
    for (const [id, extra] of [['upstream', {}], ['override', {PLAYWRIGHT_DOWNLOAD_HOST: 'http://127.0.0.1:1'}]]) {
      const command = await execute({id, command: [pinned.executable, 'node_modules/@playwright/test/cli.js', 'install', '--dry-run', 'chromium', 'firefox', 'webkit'], cwd: sourceRoot,
        env: {...env, ...extra}, directory: join(directory, 'logs'), abortSignal: signal}); receipt.commands.push(command); assertSuccess(command);
    }
    const entries = browserDownloadObjects(await readFile(receipt.commands[0].stdout.path, 'utf8'), await readFile(receipt.commands[1].stdout.path, 'utf8')); let total = 0;
    for (const entry of entries) {
      const path = `objects/${sha256(entry.url)}.zip`, handle = await open(join(directory, path), 'wx', 0o600), digest = createHash('sha256'), integrity = createHash('sha512'); let bytes = 0;
      try {
        const response = await browserResponse(entry.url, signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000));
        for await (const chunk of response.body) {
          bytes += chunk.length; total += chunk.length;
          if (bytes > limits.tarballBytes || total > limits.fixtureBytes) throw Error('Browser download fixture byte cap exceeded');
          digest.update(chunk); integrity.update(chunk); await handle.writeFile(chunk);
        }
      } finally { await handle.close(); }
      receipt.objects.push({...entry, path, bytes, sha256: digest.digest('hex'), integrity: 'sha512-' + integrity.digest('base64')});
    }
    const manifest = {kind: 'developer-browser-download-fixture-1', lockSha256: sha256(await readFile(join(sourceRoot, 'package-lock.json'))), playwright: pkg.version,
      platform: process.platform, arch: process.arch, browserManifest: await hashFile(join(sourceRoot, 'node_modules/playwright-core/browsers.json')), network: registryNetwork, objects: receipt.objects,
      provenance: 'URLs are the pinned installed Playwright public CLI dry-run output; hashes seal the captured archive bytes. No independently published archive checksum is implied.'};
    await writeFile(join(directory, 'manifest.json'), json(manifest), {flag: 'wx'}); await writeFile(join(directory, 'manifest.sha256'), sha256(json(manifest)) + '\n', {flag: 'wx'});
    receipt.status = 'captured';
  } catch (error) { receipt.status = 'failed'; receipt.failure = String(error); throw error; }
  finally { receipt.endedAt = new Date().toISOString(); await writeFile(join(directory, 'capture.json'), json(receipt)); }
  return receipt;
}
const hashPattern = /^[a-f0-9]{64}$/;
const lockLimits = {files: 32, fileBytes: 16 * 1024 * 1024, totalBytes: 32 * 1024 * 1024};
const objectRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function safeWorkspacePath(path) {
  return typeof path === 'string' && path.length > 0 && !/[:\\\x00-\x20?#%]/.test(path) && !isAbsolute(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..');
}
export function registryObjects(lock) {
  if (lock?.lockfileVersion !== 3 || !objectRecord(lock.packages)) throw Error('An npm v3 lockfile is required');
  const objects = new Map();
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!objectRecord(entry)) throw Error('Invalid lock package entry');
    if (Object.hasOwn(entry, 'link') && typeof entry.link !== 'boolean') throw Error('Malformed workspace link');
    if (entry.link === true) {
      const target = entry.resolved;
      if (!name || !safeWorkspacePath(target) || !Object.hasOwn(lock.packages, target)) throw Error('Invalid workspace link target');
      const local = lock.packages[target];
      if (!objectRecord(local) || Object.hasOwn(local, 'resolved') || Object.hasOwn(local, 'link') && local.link !== false) throw Error('Workspace link must target a local non-link package');
      continue;
    }
    if (!name || entry.resolved === undefined) continue;
    if (typeof entry.resolved !== 'string' || !entry.resolved) throw Error('Invalid resolved lock input');
    if (entry.resolved.startsWith('file:')) continue;
    const url = new URL(entry.resolved);
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || url.search || url.hash) throw Error(`Non-public-registry lock input requires an explicit separate fixture: ${name}`);
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '')) throw Error(`Pinned SHA-512 integrity is required: ${name}`);
    const previous = objects.get(url.pathname);
    if (previous && previous.integrity !== entry.integrity) throw Error('Conflicting integrity for one registry URL');
    objects.set(url.pathname, {url: url.href, route: url.pathname, integrity: entry.integrity});
  }
  if (!objects.size || objects.size > limits.files) throw Error('Empty or oversized registry fixture');
  return [...objects.values()].sort((a, b) => a.route.localeCompare(b.route));
}
function unionObjects(inputs) {
  const objects = new Map();
  for (const input of inputs) for (const entry of registryObjects(input.value)) {
    const previous = objects.get(entry.route);
    if (previous && !same(previous, entry)) throw Error('Conflicting integrity for one registry URL across locks');
    objects.set(entry.route, entry);
    if (objects.size > limits.files) throw Error('Oversized registry fixture');
  }
  return [...objects.values()].sort((a, b) => a.route.localeCompare(b.route));
}
const stamp = info => JSON.stringify([info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeMs, info.ctimeMs]);
async function readLockInput(path, maxBytes = Infinity) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw Error('An actual lockfile path is required');
  path = resolve(path);
  const before = await lstat(path);
  if (!before.isFile() || await realpath(path) !== path) throw Error('Lockfile must be a canonical regular file');
  if (before.size > maxBytes) throw Error('Multi-lock metadata byte cap exceeded');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    if (stamp(await handle.stat()) !== stamp(before)) throw Error('Lockfile changed before reading');
    if (Number.isFinite(maxBytes)) {
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, null);
        if (!bytesRead) throw Error('Lockfile shortened while reading');
        offset += bytesRead;
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead) throw Error('Lockfile grew while reading');
    } else bytes = await handle.readFile();
    if (bytes.length !== before.size || stamp(await handle.stat()) !== stamp(before)) throw Error('Lockfile changed while reading');
  } finally { await handle.close(); }
  if (stamp(await lstat(path)) !== stamp(before) || await realpath(path) !== path) throw Error('Lockfile changed after reading');
  return {identity: {path, bytes: bytes.length, sha256: sha256(bytes)}, bytes, value: JSON.parse(bytes), stamp: stamp(before)};
}
async function readLockInputs(lockfile, lockfiles) {
  if (lockfile !== undefined && lockfiles !== undefined) throw Error('Choose lockfile or lockfiles, not both');
  const paths = lockfiles === undefined ? [lockfile] : lockfiles;
  if (!Array.isArray(paths) || !paths.length || paths.length > lockLimits.files) throw Error('A nonempty bounded lockfile selection is required');
  const inputs = [], names = new Set(), hashes = new Set(); let total = 0;
  for (const path of paths) {
    const input = await readLockInput(path, paths.length > 1 ? lockLimits.fileBytes : Infinity);
    if (paths.length > 1 && (total += input.identity.bytes) > lockLimits.totalBytes) throw Error('Multi-lock metadata byte cap exceeded');
    if (names.has(input.identity.path) || hashes.has(input.identity.sha256)) throw Error('Duplicate lockfile path or content identity');
    names.add(input.identity.path); hashes.add(input.identity.sha256); inputs.push(input);
  }
  return inputs.sort((a, b) => a.identity.path < b.identity.path ? -1 : a.identity.path > b.identity.path ? 1 : 0);
}
async function requireUnchangedLocks(inputs) {
  for (const input of inputs) {
    const current = await readLockInput(input.identity.path, inputs.length > 1 ? lockLimits.fileBytes : Infinity);
    if (!same(current.identity, input.identity) || current.stamp !== input.stamp) throw Error('Lockfile changed during capture');
  }
}
function expectedLockSet(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > lockLimits.files || value.some(hash => typeof hash !== 'string' || !hashPattern.test(hash)) || new Set(value).size !== value.length) throw Error('A complete distinct expected lock hash set is required');
  return [...value].sort();
}
function validateLockIdentities(locks) {
  if (!Array.isArray(locks) || locks.length < 2 || locks.length > lockLimits.files) throw Error('Invalid multi-lock identities');
  let previous = '', total = 0;
  for (const identity of locks) {
    if (!objectRecord(identity) || Object.keys(identity).sort().join(',') !== 'bytes,path,sha256' || typeof identity.path !== 'string' || identity.path.includes('\0') || !isAbsolute(identity.path) || resolve(identity.path) !== identity.path || identity.path <= previous || !Number.isSafeInteger(identity.bytes) || identity.bytes <= 0 || identity.bytes > lockLimits.fileBytes || (total += identity.bytes) > lockLimits.totalBytes || typeof identity.sha256 !== 'string' || !hashPattern.test(identity.sha256)) throw Error('Invalid canonical multi-lock identity');
    previous = identity.path;
  }
  return expectedLockSet(locks.map(identity => identity.sha256));
}
export async function captureRegistry({lockfile, lockfiles, output, signal}) {
  const inputs = await readLockInputs(lockfile, lockfiles), entries = unionObjects(inputs), multi = inputs.length > 1;
  await requireUnchangedLocks(inputs);
  signal?.throwIfAborted();
  const directory = resolve(output); await mkdir(directory, {recursive: false}); await mkdir(join(directory, 'objects'));
  const binding = multi ? {locks: inputs.map(input => input.identity)} : {lock: {path: inputs[0].identity.path, sha256: inputs[0].identity.sha256}};
  const receipt = {kind: multi ? 'developer-registry-capture-2' : 'developer-registry-capture-1', startedAt: new Date().toISOString(), ...binding, objects: [], status: 'running', qualification: false};
  let total = 0;
  try {
    if (multi) {
      await mkdir(join(directory, 'locks'));
      for (const input of inputs) await writeFile(join(directory, 'locks', input.identity.sha256 + '.json'), input.bytes, {flag: 'wx', mode: 0o600});
    }
    for (const entry of entries) {
      const name = sha256(entry.url), path = `objects/${name}.tgz`, handle = await open(join(directory, path), 'wx', 0o600);
      const integrity = createHash('sha512'), content = createHash('sha256'); let bytes = 0;
      try {
        const response = await fetch(entry.url, {redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)});
        if (response.status !== 200 || !response.body) throw Error(`Registry fetch failed (${response.status}): ${entry.route}`);
        for await (const chunk of response.body) {
          bytes += chunk.length; total += chunk.length;
          if (bytes > limits.tarballBytes || total > limits.fixtureBytes) throw Error('Registry fixture byte limit exceeded');
          integrity.update(chunk); content.update(chunk); await handle.writeFile(chunk);
        }
        if ('sha512-' + integrity.digest('base64') !== entry.integrity) throw Error(`Registry integrity mismatch: ${entry.route}`);
      } finally { await handle.close(); }
      receipt.objects.push({...entry, path, bytes, sha256: content.digest('hex')});
      await writeFile(join(directory, 'capture.json'), json(receipt));
    }
    await requireUnchangedLocks(inputs);
    signal?.throwIfAborted();
    const manifest = {kind: multi ? 'developer-registry-fixture-2' : 'developer-registry-fixture-1',
      ...(multi ? {locks: receipt.locks} : {lockSha256: receipt.lock.sha256}), network: registryNetwork, objects: receipt.objects};
    await writeFile(join(directory, 'manifest.json'), json(manifest), {flag: 'wx'});
    await writeFile(join(directory, 'manifest.sha256'), sha256(json(manifest)) + '\n', {flag: 'wx'});
    receipt.status = 'captured';
  } catch (error) { receipt.status = 'failed'; receipt.failure = String(error); throw error; }
  finally { receipt.endedAt = new Date().toISOString(); await writeFile(join(directory, 'capture.json'), json(receipt)); }
  return receipt;
}
export async function verifyRegistry(directory, expected) {
  directory = await realpath(directory);
  const bytes = await readFile(join(directory, 'manifest.json')), seal = (await readFile(join(directory, 'manifest.sha256'), 'utf8')).trim();
  if (sha256(bytes) !== seal) throw Error('Registry manifest seal mismatch');
  const manifest = JSON.parse(bytes);
  const browser = manifest.kind === 'developer-browser-download-fixture-1', multi = manifest.kind === 'developer-registry-fixture-2';
  if ((!browser && !multi && manifest.kind !== 'developer-registry-fixture-1') || json(manifest.network) !== json(registryNetwork) || !Array.isArray(manifest.objects) || !manifest.objects.length || manifest.objects.length > limits.files) throw Error('Unsupported registry fixture');
  if (browser && (manifest.playwright !== '1.63.0' || manifest.platform !== process.platform || manifest.arch !== process.arch)) throw Error('Browser download fixture belongs to a different toolchain/platform');
  if (multi) {
    if (Object.hasOwn(manifest, 'lockSha256')) throw Error('Ambiguous multi-lock fixture identity');
    const actual = validateLockIdentities(manifest.locks);
    if (!same(actual, expectedLockSet(expected))) throw Error('Registry fixture belongs to a different lock set');
    const inputs = [];
    for (const identity of manifest.locks) {
      const input = await readLockInput(join(directory, 'locks', identity.sha256 + '.json'), lockLimits.fileBytes);
      if (input.identity.bytes !== identity.bytes || input.identity.sha256 !== identity.sha256) throw Error('Retained lockfile identity mismatch');
      inputs.push(input);
    }
    const declared = manifest.objects.map(({url, route, integrity}) => ({url, route, integrity}));
    if (!same(unionObjects(inputs), declared)) throw Error('Registry fixture does not cover the exact retained lock union');
  } else {
    if (Array.isArray(expected)) throw Error('A single-lock fixture requires a single expected lock hash');
    if (expected && manifest.lockSha256 !== expected) throw Error('Registry fixture belongs to a different lock');
  }
  if (new Set(manifest.objects.map(item => item.route)).size !== manifest.objects.length) throw Error('Duplicate registry route');
  let total = 0;
  for (const object of manifest.objects) {
    if (object.path !== `objects/${sha256(object.url)}.${browser ? 'zip' : 'tgz'}` || !object.route.startsWith('/') || object.route.includes('..') || (!browser && new URL(object.url).pathname !== object.route)) throw Error('Registry object path/route mismatch');
    if (!Number.isSafeInteger(object.bytes) || object.bytes < 1 || object.bytes > limits.tarballBytes || (total += object.bytes) > limits.fixtureBytes) throw Error('Invalid fixture object or aggregate length');
    if (browser) { const url = new URL(object.url); if (url.protocol !== 'https:' || !browserHost(url.hostname) || url.username || url.password) throw Error('Unsupported browser distribution host'); }
    else registryObjects({lockfileVersion: 3, packages: {'node_modules/check': {resolved: object.url, integrity: object.integrity}}});
  }
  for (const object of manifest.objects) {
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(join(directory, object.path))) hash.update(chunk);
    if ('sha512-' + hash.digest('base64') !== object.integrity) throw Error('Registry object integrity mismatch');
  }
  await verifyManifest(directory, manifest.objects);
  return {directory, manifest, sha256: seal};
}
export async function serveRegistry({directory, lockSha256, lockSha256s, output, port = 0}) {
  if (lockSha256 !== undefined && lockSha256s !== undefined) throw Error('Choose one expected lock binding');
  const verified = await verifyRegistry(directory, lockSha256s ?? lockSha256), routes = new Map(verified.manifest.objects.map(item => [item.route, item]));
  const multi = verified.manifest.kind === 'developer-registry-fixture-2';
  const receipt = {kind: multi ? 'developer-registry-service-2' : 'developer-registry-service-1', fixtureSha256: verified.sha256,
    ...(multi ? {locks: verified.manifest.locks, expectedLockSha256s: expectedLockSet(lockSha256s)} : {lockSha256: verified.manifest.lockSha256}), network: registryNetwork,
    startedAt: new Date().toISOString(), requests: [], qualification: false,
    limits: 'Deterministic application-level N link fixture. Scheduler drift and aggregate byte spans are retained. This does not certify physical network, browser distribution downloads, or OS TCP packet-loss emulation.'};
  let nextDown = 0, nextUp = 0, closed = false;
  const sockets = new Set(), active = new Set();
  const server = createServer((request, response) => {
    const work = (async () => {
      const started = performance.now(), observed = {method: request.method, route: request.url, startedAt: new Date().toISOString(), bytes: 0, status: null}; receipt.requests.push(observed);
      try {
        const object = routes.get(request.url);
        if (!['GET', 'HEAD'].includes(request.method) || !object || request.headers.authorization) { response.writeHead(404).end(); observed.status = 404; return; }
        const headerBytes = Buffer.byteLength(request.method + ' ' + request.url + '\r\n' + request.rawHeaders.join('\r\n'));
        nextUp = Math.max(performance.now(), nextUp) + headerBytes * 8 * 1000 / registryNetwork.upBitsPerSecond;
        await pause(Math.max(0, nextUp - performance.now()) + registryNetwork.roundTripMs);
        const path = join(verified.directory, object.path), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
        const before = await handle.stat();
        async function assertUnchanged() {
          const after = await handle.stat(), current = await lstat(path);
          if (!before.isFile() || before.size !== object.bytes || !current.isFile() || await realpath(path) !== path || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('Fixture changed during response');
        }
        await assertUnchanged();
        const initialHash = createHash('sha256');
        for await (const chunk of handle.createReadStream({autoClose: false, start: 0, highWaterMark: 64 * 1024})) initialHash.update(chunk);
        if (initialHash.digest('hex') !== object.sha256) throw Error('Fixture changed before response');
        await assertUnchanged();
        response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': object.bytes, 'X-Ideogram-Fixture': verified.sha256, 'Cache-Control': 'no-store'});
        observed.status = 200;
        const send = async chunk => {
          nextDown = Math.max(performance.now(), nextDown) + chunk.length * 8 * 1000 / registryNetwork.downBitsPerSecond;
          await pause(Math.max(0, nextDown - performance.now()));
          if (closed || response.destroyed) throw Error('Registry client disconnected');
          observed.firstByteMs ??= performance.now() - started;
          observed.bytes += chunk.length;
          if (!response.write(chunk)) await new Promise((resolve, reject) => {
            const cleanup = () => { response.off('drain', drain); response.off('close', close); response.off('error', error); };
            const drain = () => { cleanup(); resolve(); }, close = () => { cleanup(); reject(Error('Registry client disconnected')); }, error = value => { cleanup(); reject(value); };
            response.once('drain', drain); response.once('close', close); response.once('error', error);
          });
        };
        if (request.method === 'GET') {
          const deliveredHash = createHash('sha256'); let pending;
          // Keep the final chunk until the consumed bytes and the pinned FD's
          // pathname have both been verified. A changed fixture cannot finish
          // a successful Content-Length response, including browser archives.
          for await (const chunk of handle.createReadStream({autoClose: false, start: 0, highWaterMark: 64 * 1024})) {
            deliveredHash.update(chunk); if (pending) await send(pending); pending = chunk;
          }
          if (deliveredHash.digest('hex') !== object.sha256) throw Error('Fixture payload changed while serving');
          await assertUnchanged();
          if (pending) await send(pending);
        }
        response.end();
        } finally { await handle.close(); }
      } catch (error) { observed.error = String(error); response.destroy(error); }
      finally { observed.elapsedMs = performance.now() - started; observed.endedAt = new Date().toISOString(); }
    })();
    active.add(work); work.finally(() => active.delete(work));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  receipt.origin = `http://127.0.0.1:${server.address().port}`;
  return {origin: receipt.origin, receipt, async close() {
    if (closed) return; closed = true; for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); await Promise.allSettled(active);
    receipt.endedAt = new Date().toISOString();
    receipt.status = receipt.requests.some(request => request.error || request.status !== 200) ? 'failed' : receipt.requests.length ? 'served' : 'unused';
    await writeFile(output, json(receipt), {flag: 'wx'}); await writeFile(output + '.sha256', sha256(json(receipt)) + '\n', {flag: 'wx'});
  }};
}
export function parseRegistryOptions(args) {
  const [mode, ...rest] = args;
  const allowed = mode === 'capture' ? ['--lockfile', '--output'] : mode === 'capture-browsers' ? ['--source', '--output'] : mode === 'serve' ? ['--fixture', '--receipt', '--port', '--lockfile'] : [];
  if (!allowed.length) throw Error('Choose capture, capture-browsers or serve');
  const options = {mode}, lockfiles = [];
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1];
    if (!allowed.includes(flag) || !value || value.startsWith('--')) throw Error('Unknown or incomplete registry option: ' + flag);
    if (flag === '--lockfile') { lockfiles.push(value); continue; }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) throw Error('Duplicate registry option: ' + flag);
    options[key] = value;
  }
  if (lockfiles.length) options.lockfiles = lockfiles;
  if (mode === 'capture' && (!lockfiles.length || !options.output) || mode === 'capture-browsers' && (!options.source || !options.output) || mode === 'serve' && (!options.fixture || !options.receipt)) throw Error('Missing required registry option');
  if (options.port !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(options.port) || Number(options.port) > 65535) throw Error('Invalid registry port');
    options.port = Number(options.port);
  }
  return options;
}
if (import.meta.main) {
  const options = parseRegistryOptions(process.argv.slice(2));
  if (options.mode === 'capture') {
    console.log(json(await captureRegistry({lockfiles: options.lockfiles, output: options.output})));
  } else if (options.mode === 'capture-browsers') {
    console.log(json(await captureBrowserDownloads({sourceRoot: resolve(options.source), output: options.output})));
  } else {
    const inputs = options.lockfiles ? await readLockInputs(undefined, options.lockfiles) : null;
    const binding = !inputs ? {} : inputs.length === 1 ? {lockSha256: inputs[0].identity.sha256} : {lockSha256s: inputs.map(input => input.identity.sha256)};
    const service = await serveRegistry({directory: options.fixture, ...binding, output: options.receipt, port: options.port ?? 0});
    console.log(json({origin: service.origin, fixtureSha256: service.receipt.fixtureSha256}));
    const close = async () => { await service.close(); process.exitCode = 0; };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }
}
