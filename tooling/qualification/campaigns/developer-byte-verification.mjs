import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digestJSON } from '../core.mjs';
import { isBuildSource } from '../dev.mjs';
import { observeD11Build } from '../developer-campaigns/commands.mjs';
import { digest, sanitize } from './common.mjs';
import { verifyD11RetainedBuild } from './browser-d11-verification.mjs';

const bare = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const prefixed = value => value?.startsWith('sha256:') ? value : 'sha256:' + value;
const json = value => JSON.stringify(value, null, 2) + '\n';
const equal = (left, right, message) => { if (!isDeepStrictEqual(left, right)) throw Error(message); };
function safePath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /^[A-Za-z]:/.test(value) || /[\\\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Unsafe developer byte evidence path');
  return value;
}
function sourceRows(source) {
  if (!source || !Array.isArray(source.files) || !source.files.length || digestJSON(source.files) !== source.digest) throw Error('Developer bytes require the retained subject source identity');
  const names = new Set();
  for (const file of source.files) {
    safePath(file.path); if (names.has(file.path)) throw Error('Duplicate developer subject source'); names.add(file.path);
    if (file.deleted === true) continue;
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !bare(file.sha256)) throw Error('Malformed developer subject source');
  }
  return source.files;
}

/** This manifest is the independent post-command fileManifest(dist) capture.
 * It must never be derived from the D11 accounting inventory being verified. */
export function developerPostBuildIdentity(artifacts, source) {
  sourceRows(source);
  if (!Array.isArray(artifacts?.files) || !artifacts.files.length || !bare(artifacts.sha256) || digest(json(artifacts.files)) !== 'sha256:' + artifacts.sha256) throw Error('Developer post-build artifact manifest is absent or unsealed');
  const paths = new Set();
  const buildFiles = artifacts.files.map(file => {
    const path = safePath(file.path);
    if (paths.has(path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !bare(file.sha256)) throw Error('Malformed or duplicate developer post-build artifact');
    paths.add(path); return { path: 'dist/' + path, bytes: file.bytes, sha256: 'sha256:' + file.sha256 };
  });
  if (!buildFiles.some(file => file.path.startsWith('dist/app/')) || !buildFiles.some(file => file.path.startsWith('dist/local/'))) throw Error('Developer bytes require both actual post-build app and server artifacts');
  return { buildFiles, sourceFiles: source.files };
}

function bindSnapshot(manifest, source) {
  if (!Array.isArray(manifest?.files) || !manifest.files.length || prefixed(manifest.sha256) !== digest(json(manifest.files))) throw Error('Developer source snapshot is absent or unsealed');
  const applicable = path => isBuildSource(path) || path.startsWith('docs/spec/') || path.startsWith('.github/workflows/') || path === 'AGENTS.md';
  const required = source.files.filter(file => !file.deleted && applicable(file.path));
  equal(manifest.files.map(file => safePath(file.path)).sort(), required.map(file => file.path).sort(), 'Developer source snapshot omits the selected subject');
  for (const file of manifest.files) {
    const original = required.find(value => value.path === file.path);
    if (file.bytes !== original.bytes || prefixed(file.sha256) !== prefixed(original.sha256) || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw Error('Developer source snapshot differs from selected subject bytes');
  }
}

/** Verify one C2/I1 build using only sealed files in its original worker group.
 * The returned inventory is a sanitized metadata view; its complete retained
 * file is authoritative, including strings longer than the transport limit. */
export async function verifyDeveloperBuildObservation({ cell, attempt, source, output, readBytes }) {
  if (!['C2/production-build', 'I1/command-groups'].includes(cell?.id) || cell.handler !== 'developer') throw Error('Unexpected developer byte cell');
  const result = attempt?.result, d11 = result?.d11;
  if (!d11) {
    if (attempt?.status === 'PASS') throw Error('Passing developer build lacks its retained D11 audit');
    return { verified: false, reason: 'Build did not produce a D11 observation' };
  }
  if (!['cold', 'warm'].includes(attempt.cache) || !Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 1 || attempt.prime || typeof output !== 'string' || !isAbsolute(output) || resolve(output) !== output || typeof readBytes !== 'function') throw Error('Malformed developer byte audit context');
  const sample = `${cell.id.replaceAll('/', '-')}-${attempt.cache}-${attempt.ordinal}`;
  const isC2 = cell.id === 'C2/production-build', artifactPath = `${sample}/d11-build.json`;
  async function retained(path, identity) {
    safePath(path);
    const bytes = await readBytes(path);
    if (!Buffer.isBuffer(bytes)) throw Error('Developer evidence reader must return verified bytes');
    if (identity && (identity.path !== join(output, path) || identity.bytes !== bytes.length || prefixed(identity.sha256) !== digest(bytes))) throw Error('Developer retained file identity differs');
    return bytes;
  }
  async function parsed(path, identity) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await retained(path, identity))); }
  function localPath(path) {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || !path.startsWith(join(output, sample) + sep)) throw Error('Developer build evidence escapes its exact sample');
    return safePath(relative(output, path).split(sep).join('/'));
  }
  if (d11.artifact?.path !== join(output, artifactPath)) throw Error('Developer D11 artifact belongs to another sample');
  const inventory = await parsed(artifactPath, d11.artifact);
  const raw = await parsed(`${sample}/${isC2 ? 'stage' : 'group'}.json`);
  if (isC2 ? raw.kind !== 'developer-P-stage-1' || raw.stage !== 'production-build' : raw.id !== `${attempt.cache}-${attempt.ordinal}` || raw.cache !== attempt.cache || raw.ordinal !== attempt.ordinal || raw.scored !== true) throw Error('Developer raw receipt belongs to another command/sample');
  const observation = result.observations;
  if (!observation) throw Error('Developer D11 lacks its original observation');
  equal(observation.artifacts, sanitize(raw.artifacts), 'Developer post-build manifest differs from raw command receipt');
  equal(observation.d11, sanitize(raw.d11), 'Developer D11 differs from raw command receipt');
  equal(observation.commands, sanitize(raw.commands), 'Developer commands differ from raw command receipt');
  equal(raw.d11, raw.artifacts?.d11, 'Developer build audit copies disagree');
  equal(raw.d11?.inventory, inventory, 'Developer retained D11 inventory differs from raw command receipt');
  const identities = developerPostBuildIdentity(raw.artifacts, source);
  if (!isC2) {
    bindSnapshot(raw.source, source);
    equal(observation.source, sanitize(raw.source), 'Developer snapshot differs from raw command receipt');
  }
  const commands = ['app', 'server'].map(kind => (raw.commands ?? []).find(command => command.id?.endsWith('.build-' + kind)));
  for (const [index, command] of commands.entries()) {
    const kind = index ? 'server' : 'app';
    if (!command || command.exitCode !== 0 || command.outcome !== 'PASS' || command.timedOut || command.interrupted || !Array.isArray(command.command) || !isDeepStrictEqual(command.command.slice(-2), ['run', 'build:' + kind])) throw Error('D11 requires the actual successful production build commands');
    for (const lane of ['stdout', 'stderr']) await retained(localPath(command[lane]?.path), command[lane]);
  }
  if (isC2 && (raw.buildProvenance || attempt.status === 'PASS')) {
    const provenance = await parsed(`${sample}/build-provenance.json`, raw.buildProvenance);
    if (!raw.buildProvenance || provenance.kind !== 'perf-build-provenance-1' || provenance.sourceHead !== source.head || provenance.sourceDigest !== source.digest) throw Error('C2 provenance belongs to another selected source');
    equal(provenance.subjectSourceManifest, source.files, 'C2 provenance subject manifest differs');
    bindSnapshot(provenance.sourceManifest, source);
    equal(provenance.commands, commands, 'C2 provenance build commands differ');
    const executable = ['dist/local/', 'dist/app/'].flatMap(prefix => identities.buildFiles.filter(file => file.path.startsWith(prefix)));
    if (digest(executable) !== provenance.buildDigest) throw Error('C2 provenance differs from actual post-build artifact identity');
    equal(observation.buildProvenance, sanitize(raw.buildProvenance), 'C2 provenance reference differs from raw command receipt');
  }
  verifyD11RetainedBuild(inventory, identities);
  const derived = observeD11Build(inventory, { artifact: d11.artifact });
  equal(raw.d11, derived, 'Developer D11 accounting differs from independently replayed build');
  equal(d11, sanitize(derived), 'Returned developer D11 accounting differs from independently replayed build');
  const measured = result.measurements ?? {};
  for (const metric of derived.measurements) {
    const value = Array.isArray(measured) ? measured.filter(item => item?.name === metric.name) : [measured[metric.name]];
    if (value.length !== 1) throw Error('Developer D11 measurement is missing or duplicated');
    equal(value[0], sanitize(metric), 'Developer D11 measured bytes differ from independently replayed build');
  }
  const names = Array.isArray(measured) ? measured.map(item => item?.name) : Object.keys(measured);
  if (names.some(name => typeof name === 'string' && name.startsWith('D11') && !derived.measurements.some(metric => metric.name === name))) throw Error('Developer D11 contains unverified measured bytes');
  return { verified: true, scope: derived.scope, status: derived.status, buildSha256: derived.buildSha256, artifacts: identities.buildFiles.length };
}
