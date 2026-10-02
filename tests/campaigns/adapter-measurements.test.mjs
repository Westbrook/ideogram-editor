import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {waMetadataIdentity} from '../../tooling/qualification/campaigns/browser-wa-observation.mjs';
import { retainAdapterCycleMeasurements } from '../../tooling/qualification/campaigns/adapter-measurements.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const counterKeys = ['submit', 'upload', 'poll', 'cancel', 'fetch', 'socket', 'dns', 'datagram'];
const networkNames = ['T06UnchangedOwnedAssetFetches', 'R32UnchangedOwnedAssetFetches', 'R32CacheIdentityMismatchCount'];
const durabilityName = 'T06ArtifactHashOrDurabilityMismatchCount';
const zero = () => Object.fromEntries(counterKeys.map(key => [key, 0]));
async function input(t, host = 'C') {
  const output = await mkdtemp(join(tmpdir(), 'wa-measurements-unit-')); t.after(() => rm(output, { recursive: true, force: true }));
  const fixtureIdentity = hash('sealed-unit-fixture');
  const weights = { hash: hash('unit-weights-identity'), byteLength: '268435456', mediaType: 'application/octet-stream' };
  const config = { hash: hash('unit-config-identity'), byteLength: '29', mediaType: 'text/plain' };
  const binding = { versionId: 'actual-import-version', adapterId: 'actual-import-adapter', version: '1', weights, config,
    profileId: 'unit-profile', locallyEligible: true, runtimeVerified: false };
  const asset = { id: binding.versionId, purpose: 'adapter', blob: weights, dependencies: [config], adapter: { id: binding.versionId, weights, config } };
  const view = { ...binding, available: true, qualification: 'structurally-valid', origin: 'import' };
  const closure = { kind: 'wa-retained-fixture-proof-1', complete: true, status: 'PASS', fixtureSha256: fixtureIdentity,
    assertions: { durableFixturePreserved: true }, importedBindingsSha256: hash('unit-import-bindings'),
    importedAssetBindings: [{ id: asset.id, metadataSha256: hash(JSON.stringify(asset)), refs: [weights, config].map(ref => ({ hash: ref.hash, byteLength: ref.byteLength })) }] };
  const closurePath = join(output, 'closure-proof.json'), bytes = Buffer.from(JSON.stringify(closure) + '\n');
  await writeFile(closurePath, bytes, { flag: 'wx', mode: 0o600 }); closure.artifact = { path: closurePath, bytes: bytes.length, sha256: hash(bytes) };
  const phases = ['import', 'select', 'unselect', 'close', 'release'].map(name => {
    const startMs = performance.now(), endMs = performance.now(); return { name, startMs, endMs, durationMs: endMs - startMs, outcome: 'expected' };
  });
  return { output, cell: { id: (host === 'C' ? 'AC2' : 'AH2') + '/WA-lifecycle', host, handler: host === 'C' ? 'adapters' : 'browser', kind: 'lifecycle', operation: 'adapter.lifecycle', workload: 'WA' },
    cycle: 1, processIdentity: 'exact-unit-process', fixtureIdentity, phases,
    specimen: { kind: 'eligible-candidate', weights: { hash: weights.hash, bytes: Number(weights.byteLength), mediaType: weights.mediaType }, config: { hash: config.hash, bytes: Number(config.byteLength), mediaType: config.mediaType }, descriptorIdentity: { sha256: hash('unit-descriptor') } },
    imported: { asset, view, binding: { eligible: true, binding } }, closure,
    ownedLookup: { before: zero(), after: zero(), expected: structuredClone(view), observed: structuredClone(view) } };
}

test('C measurement rows retain exact lifecycle/cycle/process/fixture bindings and a reproducible artifact seal', async t => {
  const args = await input(t), rows = await retainAdapterCycleMeasurements(args);
  assert.deepEqual(rows.map(row => row.name), ['T05IncompleteOrUnverifiedIdentityAcceptanceCount', durabilityName, ...networkNames]);
  assert(rows.every(row => row.complete === true && row.value === 0));
  for (const { evidence } of rows) {
    assert.equal(evidence.cellId, args.cell.id); assert.equal(evidence.cycleOrdinal, 1); assert.equal(evidence.processIdentity, args.processIdentity); assert.equal(evidence.fixtureIdentity, args.fixtureIdentity);
    assert.equal(evidence.coverage, 'complete-cycle-actions');
    const bytes = await readFile(evidence.artifact.path); assert.equal(bytes.length, evidence.artifact.bytes); assert.equal(hash(bytes), evidence.artifact.sha256);
    const packet = JSON.parse(bytes); assert.equal(packet.cellId, args.cell.id); assert.equal(packet.cycleOrdinal, 1);
    assert.deepEqual(packet.comparisons.expected, packet.comparisons.observed); assert.equal(packet.tensorDecodeObservation, null);
    assert.deepEqual(packet.closure.artifact, args.closure.artifact);
  }
  await assert.rejects(retainAdapterCycleMeasurements(args), { code: 'EEXIST' }, 'A later observation must not overwrite retained evidence');
});

test('H never borrows backend-only network counters or invents tensor decode evidence', async t => {
  const args = await input(t, 'H'), rows = await retainAdapterCycleMeasurements(args);
  assert.deepEqual(rows.map(row => row.name), ['T05IncompleteOrUnverifiedIdentityAcceptanceCount', durabilityName]);
  assert(!rows.some(row => /Tensor|Fetch|CacheIdentity/.test(row.name)));
});

test('only planned WA lifecycle cells with all five completed ordered clocks can emit complete-cycle rows', async t => {
  const complete = await input(t);
  for (const mutate of [
    value => { value.cell.id = 'AC1/WA-lifecycle'; }, value => { value.cell.host = 'H'; },
    value => { value.cell.handler = 'backend'; }, value => { value.cell.kind = 'operation'; },
    value => { value.cell.operation = 'adapter.import'; }, value => { value.cell.workload = 'W1'; },
    value => { value.cycle = 0; }, value => { value.fixtureIdentity = null; }, value => { value.processIdentity = ''; },
    value => { value.imported.binding.eligible = false; }, value => { value.phases = []; },
    value => { value.phases.pop(); }, value => { value.phases.reverse(); },
    value => { value.phases[0].outcome = 'completed'; }, value => { delete value.phases[0].endMs; },
    value => { value.phases[0].startMs = NaN; }, value => { value.phases[0].startMs = -1; },
    value => { value.phases[1].startMs = value.phases[0].endMs - 1; },
  ]) {
    const args = structuredClone(complete); mutate(args); assert.deepEqual(await retainAdapterCycleMeasurements(args), []);
  }
  assert.deepEqual((await readdir(complete.output)).sort(), ['closure-proof.json']);
});

test('registered or observed weights/config/version contradictions refuse to emit identity-zero rows', async t => {
  const complete = await input(t);
  for (const mutate of [
    value => { value.imported.binding.binding.versionId = 'another-version'; }, value => { value.imported.view.versionId = 'another-version'; },
    value => { value.imported.view.weights.byteLength = '268435455'; }, value => { value.imported.view.config.hash = hash('another-config'); },
    value => { value.imported.binding.binding.weights.mediaType = 'text/plain'; },
  ]) {
    const args = structuredClone(complete); mutate(args); await assert.rejects(retainAdapterCycleMeasurements(args));
  }
  assert.deepEqual((await readdir(complete.output)).sort(), ['closure-proof.json']);
});

test('durability rows require this exact fixture and imported version plus its retained weights/config refs', async t => {
  await t.test('crossed fixture fails', async child => {
    const args = await input(child); args.closure.fixtureSha256 = hash('different-fixture'); await assert.rejects(retainAdapterCycleMeasurements(args));
  });
  await t.test('claimed complete imported proof with a missing weights ref fails', async child => {
    const args = await input(child); args.closure.importedAssetBindings[0].refs = args.closure.importedAssetBindings[0].refs.slice(1);
    await assert.rejects(retainAdapterCycleMeasurements(args));
  });
  for (const [label, mutate] of [
    ['unknown proof', value => { value.closure = null; }], ['incomplete proof', value => { value.closure.complete = false; }],
    ['missing fixture binding', value => { delete value.closure.fixtureSha256; }], ['missing asset binding', value => { value.closure.importedAssetBindings = []; }],
    ['missing artifact identity', value => { delete value.closure.artifact; }],
  ]) {
    await t.test(label, async child => {
      const args = await input(child); mutate(args); const rows = await retainAdapterCycleMeasurements(args);
      assert(!rows.some(row => row.name === durabilityName)); assert(rows.some(row => row.name === 'T05IncompleteOrUnverifiedIdentityAcceptanceCount'));
    });
  }
});

test('partial, negative, nonintegral, reset or overflowing guard counters never establish complete zero-fetch coverage', async t => {
  for (const [label, mutate] of [
    ['subset', value => { value.ownedLookup.before = { fetch: 0 }; value.ownedLookup.after = { fetch: 0 }; }],
    ['missing after category', value => { delete value.ownedLookup.after.dns; }],
    ['negative', value => { value.ownedLookup.before.fetch = -1; }],
    ['fraction', value => { value.ownedLookup.after.fetch = 0.5; }],
    ['counter reset', value => { value.ownedLookup.before.fetch = 1; value.ownedLookup.after.fetch = 0; }],
    ['sum overflow', value => { value.ownedLookup.after.fetch = Number.MAX_SAFE_INTEGER; value.ownedLookup.after.socket = 1; }],
  ]) {
    await t.test(label, async child => {
      const args = await input(child); mutate(args); const rows = await retainAdapterCycleMeasurements(args);
      assert(!rows.some(row => networkNames.includes(row.name)));
    });
  }
});

test('actual attempted effects and actual cache identity mismatches remain nonzero while key ordering does not alter identity', async t => {
  await t.test('observed effect and mismatch', async child => {
    const args = await input(child); args.ownedLookup.after.socket = 1; args.ownedLookup.observed.versionId = 'changed-owned-version';
    const rows = await retainAdapterCycleMeasurements(args);
    assert.equal(rows.find(row => row.name === 'T06UnchangedOwnedAssetFetches').value, 1);
    assert.equal(rows.find(row => row.name === 'R32UnchangedOwnedAssetFetches').value, 1);
    assert.equal(rows.find(row => row.name === 'R32CacheIdentityMismatchCount').value, 1);
  });
  await t.test('same fields, different order', async child => {
    const args = await input(child); args.ownedLookup.observed = Object.fromEntries(Object.entries(args.ownedLookup.expected).reverse());
    const rows = await retainAdapterCycleMeasurements(args);
    assert.equal(rows.find(row => row.name === 'R32CacheIdentityMismatchCount').value, 0);
  });
});


test('partial H raw projections retain observed violations but never mint zero coverage', async t => {
  const args = await input(t, 'H');
  args.browserWA = {kind: 'retained-wa-browser-observation-1', analysis: {complete: false, measurements: [
    {name: 'T06UnchangedOwnedAssetFetches', value: 0, unit: 'count', complete: false},
    {name: 'R32UnchangedOwnedAssetFetches', value: 1, unit: 'count', complete: false},
    {name: 'R32CacheIdentityMismatchCount', value: 1, unit: 'violations', complete: false},
  ]}};
  const rows = await retainAdapterCycleMeasurements(args);
  assert(!rows.some(row => row.name === 'T06UnchangedOwnedAssetFetches'));
  const observed = rows.filter(row => networkNames.includes(row.name)); assert.equal(observed.length, 2);
  assert(observed.every(row => row.value === 1 && row.complete === false && row.evidence.coverage === 'observed-partial-cycle-actions'));
  const packet = JSON.parse(await readFile(observed[0].evidence.artifact.path));
  assert.deepEqual(packet.tensorDecodeObservation, args.browserWA);
});


test('H repeated metadata identity compares complete immutable values independent of JSON key order', () => {
  const actual = {versionId: 'owned-version', name: 'WA lifecycle import fixture', weights: {hash: hash('weights'), byteLength: '268435456'}, tags: ['first', 'second']};
  const reordered = {tags: [...actual.tags], weights: {byteLength: actual.weights.byteLength, hash: actual.weights.hash}, name: actual.name, versionId: actual.versionId};
  assert.equal(waMetadataIdentity(actual), waMetadataIdentity(reordered));
  assert.notEqual(waMetadataIdentity(actual), waMetadataIdentity({...reordered, name: 'another name'}));
  assert.notEqual(waMetadataIdentity(actual), waMetadataIdentity({...reordered, tags: [...actual.tags].reverse()}));
});
