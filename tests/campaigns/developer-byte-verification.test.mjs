import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digestJSON } from '../../tooling/qualification/core.mjs';
import { observeD11Build } from '../../tooling/qualification/developer-campaigns/commands.mjs';
import { digest, sanitize } from '../../tooling/qualification/campaigns/common.mjs';
import { verifyDeveloperBuildObservation } from '../../tooling/qualification/campaigns/developer-byte-verification.mjs';
import { d11Specimen, refreshD11Specimen, initializeD11Specimen } from './support/d11-specimen.mjs';

before(initializeD11Specimen);

const json = value => JSON.stringify(value, null, 2) + '\n';
const pathOrder = (left, right) => left.path.localeCompare(right.path);

// Every retained file lives in this Buffer map. The absolute output is only a
// path identity: these integration specimens create no directories or services
// and do not stand in for actual build commands or performance evidence.
function packet(cellId, { forgeRoles = false } = {}) {
  const state = d11Specimen(), output = resolve(tmpdir(), 'd11-developer-memory'), retained = new Map(), reads = [];
  const cell = { id: cellId, handler: 'developer' }, cache = 'cold', ordinal = 1;
  const sample = `${cellId.replaceAll('/', '-')}-${cache}-${ordinal}`, isC2 = cellId === 'C2/production-build';
  const sourceFiles = structuredClone(state.options.sourceFiles), source = { head: 'a'.repeat(40), files: sourceFiles, digest: digestJSON(sourceFiles) };
  // Capture the post-command identities before editing any inventory. A forged
  // role map cannot rewrite the independent source or compiled file receipts.
  const postFiles = structuredClone(state.options.buildFiles).map(file => ({ path: file.path.slice('dist/'.length),
    bytes: file.bytes, sha256: file.sha256.slice('sha256:'.length), mode: 0o644 })).sort(pathOrder);
  const snapshotFiles = sourceFiles.filter(file => !file.deleted).map(file => ({ ...file, mode: 0o644 }));
  const snapshot = { files: snapshotFiles, sha256: digest(json(snapshotFiles)).slice('sha256:'.length) };
  if (forgeRoles) {
    state.payload.build.roles.startupFiles.push('assets/feature.js');
    refreshD11Specimen(state);
  }
  function put(path, text) {
    const bytes = Buffer.from(text); retained.set(path, bytes);
    return { path: join(output, path), bytes: bytes.length, sha256: digest(bytes) };
  }
  const inventory = state.payload.build;
  const artifact = put(`${sample}/d11-build.json`, json(inventory));
  const d11 = observeD11Build(inventory, { artifact });
  const commands = ['app', 'server'].map(kind => ({ id: `${cache}-${ordinal}.build-${kind}`,
    command: ['npm', 'run', 'build:' + kind], exitCode: 0, outcome: 'PASS', timedOut: false, interrupted: false,
    stdout: put(`${sample}/build-${kind}.stdout.log`, `Synthetic ${kind} command output\n`),
    stderr: put(`${sample}/build-${kind}.stderr.log`, '') }));
  const artifacts = { files: postFiles, sha256: digest(json(postFiles)).slice('sha256:'.length), d11 };
  const raw = isC2 ? { kind: 'developer-P-stage-1', stage: 'production-build', artifacts, d11, commands }
    : { id: `${cache}-${ordinal}`, cache, ordinal, scored: true, source: snapshot, artifacts, d11, commands };
  if (isC2) {
    const identities = postFiles.map(file => ({ path: 'dist/' + file.path, bytes: file.bytes, sha256: 'sha256:' + file.sha256 }));
    const executable = ['dist/local/', 'dist/app/'].flatMap(prefix => identities.filter(file => file.path.startsWith(prefix)));
    raw.buildProvenance = put(`${sample}/build-provenance.json`, json({ kind: 'perf-build-provenance-1',
      sourceHead: source.head, sourceDigest: source.digest, subjectSourceManifest: source.files,
      sourceManifest: snapshot, commands, buildDigest: digest(executable) }));
  }
  put(`${sample}/${isC2 ? 'stage' : 'group'}.json`, json(raw));
  const observations = { artifacts: sanitize(raw.artifacts), d11: sanitize(raw.d11), commands: sanitize(raw.commands),
    ...(isC2 ? { buildProvenance: sanitize(raw.buildProvenance) } : { source: sanitize(raw.source) }) };
  const measurements = isC2 ? Object.fromEntries(d11.measurements.map(row => [row.name, sanitize(row)])) : sanitize(d11.measurements);
  const attempt = { status: 'PASS', cache, ordinal, prime: false,
    result: { d11: sanitize(d11), observations, measurements } };
  return { cell, attempt, source, output, inventory, retained, reads, sample,
    async readBytes(path) {
      reads.push(path);
      assert(retained.has(path), 'Unexpected retained evidence read: ' + path);
      return Buffer.from(retained.get(path));
    } };
}

for (const cellId of ['C2/production-build', 'I1/command-groups']) {
  test(`${cellId} replays retained build bytes, commands and independently captured identities`, async () => {
    const specimen = packet(cellId), result = await verifyDeveloperBuildObservation(specimen);
    assert.equal(result.verified, true);
    assert.equal(result.status, 'PASS');
    assert.equal(result.scope, 'artifact-build');
    assert.equal(result.buildSha256, specimen.inventory.sha256);
    assert.equal(result.artifacts, specimen.attempt.result.observations.artifacts.files.length);
    assert(specimen.reads.includes(`${specimen.sample}/d11-build.json`));
    for (const kind of ['app', 'server']) for (const lane of ['stdout', 'stderr'])
      assert(specimen.reads.includes(`${specimen.sample}/build-${kind}.${lane}.log`));
    assert.equal(specimen.reads.some(path => path.endsWith('/build-provenance.json')), cellId.startsWith('C2/'));
  });

  test(`${cellId} rejects forged roles even when the inventory, raw receipt and returned accounting are resealed`, async () => {
    const specimen = packet(cellId, { forgeRoles: true });
    assert.equal(specimen.attempt.result.d11.status, 'PASS');
    await assert.rejects(verifyDeveloperBuildObservation(specimen), /D11 roles differ from retained source and output bytes/);
  });
}
