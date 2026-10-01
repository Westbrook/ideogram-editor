import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { digestJSON } from '../core.mjs';
import { isBuildSource } from '../dev.mjs';
import { digest, fileIdentity, PrerequisiteError } from './common.mjs';

const prefix = value => value?.startsWith('sha256:') ? value : 'sha256:' + value;
function relativePath(path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Unsafe product source manifest path');
  return path;
}
export async function retainFile(path, output, retainedPath, expected) {
  const target = join(output, relativePath(retainedPath)); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isFile()) throw Error('Retained input evidence must be an ordinary file');
  await pipeline(createReadStream(path), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  const actual = await fileIdentity(target);
  if (actual.bytes !== expected.bytes || actual.sha256 !== prefix(expected.sha256)) throw Error('Input evidence changed during retention');
  return { ...expected, path, ...actual, retainedPath };
}

export async function verifyPreparedSource(productRepo, manifest, subjectManifest, supplemental = []) {
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length || digest(JSON.stringify(manifest.files, null, 2) + '\n') !== prefix(manifest.sha256)) throw Error('Prepared source manifest seal mismatch');
  const applicable = path => isBuildSource(path) || path.startsWith('docs/spec/') || path.startsWith('.github/workflows/') || path === 'AGENTS.md';
  const requiredPaths = subjectManifest.filter(file => !file.deleted && applicable(file.path)).map(file => file.path).sort();
  const declaredPaths = manifest.files.map(file => relativePath(file.path)).sort();
  if (digest(requiredPaths) !== digest(declaredPaths)) throw Error('Prepared source must contain the complete applicable subject path inventory');
  const expected = new Map(subjectManifest.map(file => [file.path, file]));
  const actual = [];
  for (const file of manifest.files) {
    const path = relativePath(file.path), subject = expected.get(path);
    if (!subject || subject.bytes !== file.bytes || prefix(subject.sha256) !== prefix(file.sha256)) throw Error('Prepared source is not the selected subject revision: ' + path);
    const absolute = join(productRepo, path);
    if (await realpath(absolute) !== absolute) throw Error('Prepared source contains a link');
    const identity = await fileIdentity(absolute);
    if (identity.bytes !== file.bytes || identity.sha256 !== prefix(file.sha256)) throw Error('Prepared source bytes changed: ' + path);
    actual.push({ path, ...identity });
  }
  const declared = new Set(manifest.files.map(file => file.path));
  if (declared.size !== manifest.files.length) throw Error('Duplicate prepared source input');
  for (const file of supplemental) {
    const path = relativePath(file.path), identity = await fileIdentity(join(productRepo, path));
    if (declared.has(path) || identity.bytes !== file.bytes || identity.sha256 !== prefix(file.sha256)) throw Error('Supplemental fixture input differs or overlaps source: ' + path);
    declared.add(path); actual.push({ path, ...identity, supplemental: true });
  }
  async function walk(relative) {
    let entries;
    try { entries = await readdir(join(productRepo, relative), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = relative + '/' + entry.name;
      if (entry.isSymbolicLink()) throw Error('Prepared product source contains a link');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && !declared.has(path)) throw Error('Unsealed prepared product source: ' + path);
    }
  }
  for (const path of ['src', 'server', 'tooling', 'tests', 'vendor', 'docs/spec']) await walk(path);
  return { digest: digest(actual), files: actual };
}

/** Resolve a separately prepared C/H source copy only through a retained state
 * and build receipt tied to the original subject. Never treat control-harness
 * product binaries as the base revision under test. */
export async function resolveProduct({ repo, subject, configuration, input, output, runtimeOnly }) {
  let productRepo = repo, provenance = null, preparedSource = null, state = null, supplemental = [];
  if (configuration.ciHandoff?.manifestPath) await input(configuration.ciHandoff.manifestPath, 'ciHandoff', 'ci-handoff.json');
  if (runtimeOnly && configuration.developerStateDirectory) {
    const envelope = await input(join(configuration.developerStateDirectory, 'bridge-state.json'), 'developerState', 'developer-state.json');
    if (envelope.kind !== 'developer-runtime-state-1' || prefix(envelope.sha256) !== digest(JSON.stringify(envelope.state, null, 2) + '\n')) throw Error('Developer bridge state seal mismatch');
    state = envelope.state;
    if (state.sourceDigest !== subject.digest || !state.productRepo || !state.buildProvenancePath) throw new PrerequisiteError('Prepared product state must match this subject source and completed C2/H0');
    productRepo = state.productRepo;
    const preparedH = state.h?.source === productRepo && state.h.completed === true && !state.h.failure && !state.h.active;
    const preparedC = state.p?.source === productRepo && state.p.completed?.includes('production-build') && !state.p.failure && !state.p.active;
    if (!preparedH && !preparedC) throw new PrerequisiteError('Product source cannot be used before successful C2/H0 publication or after failed/interrupted preparation');
    provenance = await input(state.buildProvenancePath, 'buildProvenance', 'build-provenance.json');
    if (state.inputPacket) {
      const packet = await input(join(state.inputPacket.path, 'manifest.json'), 'testInputPacket', 'test-input-packet.json');
      if (digest(JSON.stringify(packet, null, 2) + '\n') !== prefix(state.inputPacket.manifestSha256)) throw Error('Supplemental test input packet identity mismatch');
      const { verifyInstalledInputs } = await import('../container/inputs.mjs');
      const checked = await verifyInstalledInputs({ root: productRepo, packet: state.inputPacket.path });
      if (prefix(checked.manifestSha256) !== prefix(state.inputPacket.manifestSha256)) throw Error('Installed supplemental input packet changed');
      supplemental = checked.installed.fixtures;
    }
  } else {
    if (configuration.productRepo) productRepo = configuration.productRepo;
    if (configuration.buildProvenance) provenance = await input(configuration.buildProvenance, 'buildProvenance', 'build-provenance.json');
  }
  if (!isAbsolute(productRepo) || await realpath(productRepo) !== productRepo) throw Error('Product execution root must be canonical and absolute');
  if (provenance) {
    if (provenance.kind !== 'perf-build-provenance-1' || provenance.sourceDigest !== subject.digest || provenance.sourceHead !== subject.head || provenance.productRepo && provenance.productRepo !== productRepo) throw Error('Build provenance belongs to another source or product');
    if (Array.isArray(provenance.subjectSourceManifest) && digestJSON(provenance.subjectSourceManifest) !== subject.digest) throw Error('Build source manifest does not bind the selected subject');
    if (productRepo !== repo) preparedSource = await verifyPreparedSource(productRepo, provenance.sourceManifest, subject.files, supplemental);
    const logs = [];
    for (const [index, command] of (provenance.commands ?? []).entries()) for (const lane of ['stdout', 'stderr']) {
      const file = command[lane];
      if (!file?.path || !Number.isSafeInteger(file.bytes) || !/^(sha256:)?[a-f0-9]{64}$/.test(file.sha256)) throw Error('Build provenance requires both retained command logs');
      logs.push(await retainFile(file.path, output, `build-logs/${index}-${lane}.log`, file));
    }
    provenance = { ...provenance, retainedLogs: logs };
  } else if (productRepo !== repo) throw new PrerequisiteError('A prepared product copy requires sealed source-to-build provenance');
  const preparedBrowser = state?.h?.source === productRepo && state.h.completed === true ? state.h
    : state?.p?.source === productRepo && state.p.completed?.includes('browser-cache') ? state.p : null;
  const browserCache = state?.playwrightBrowsersPath ?? preparedBrowser?.browserCache ?? null;
  if (browserCache && (!isAbsolute(browserCache) || await realpath(browserCache) !== browserCache)) throw Error('Prepared browser cache must be canonical and absolute');
  return { productRepo, provenance, preparedSource, supplemental, browserCache };
}

export function validBuildProvenance(provenance, subject, builds) {
  return !!(provenance?.kind === 'perf-build-provenance-1' && provenance.sourceDigest === subject.digest && provenance.sourceHead === subject.head && provenance.buildDigest === builds.digest && Array.isArray(provenance.commands) && provenance.commands.length === 2 && ['app', 'server'].every(kind => provenance.commands.some(command => command.id.endsWith('.build-' + kind))) && provenance.commands.every(command => command.exitCode === 0 && command.outcome === 'PASS' && !command.timedOut && !command.interrupted) && provenance.retainedLogs?.length === 4);
}
