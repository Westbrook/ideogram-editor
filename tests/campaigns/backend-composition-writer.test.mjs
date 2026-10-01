import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCompositionFixture, runCell } from '../../tooling/qualification/campaigns/backend-composition.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
// Real owned writer tests. These run with the repository's store no-network
// preload and real filesystem prerequisites, never a substitute storage API.
for (const id of ['WJ01', 'WJ11', 'WJ17']) test(`${id} real campaign retains exact raw through composition history`, async t => {
  const output = await mkdtemp(join(tmpdir(), 'ideogram-caption-campaign-')); t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = makeCompositionFixture(id), path = join(output, id + '.raw'); await writeFile(path, fixture.bytes);
  const result = await runCell({ repo, output, fixture: { corpus: { files: [{ id, path, sha256: fixture.sha256, byteLength: fixture.byteLength }] } } }, { operation: id });
  assert.equal(result.status, 'pass', JSON.stringify(result)); assert.deepEqual(result.missing, []);
  assert(result.phases.some(phase => phase.name === 'composition.parse'));
  assert.equal(result.phases.some(phase => phase.name === 'composition.project-serialize'), id === 'WJ01');
  assert(result.assertions.every(assertion => assertion.passed)); assert.equal(result.observations.originalHash, fixture.sha256);
  assert(result.assertions.some(assertion => assertion.name.includes('identical receipt after restart')));
  assert.equal(result.evidence.length, 1);
  if (id === 'WJ01') {
    assert.equal(result.observations.requestKind, 'generate');
    assert.equal(result.observations.projectedWireBytes, result.observations.projectedPromptBytes + result.observations.projectedOtherBytes);
    assert(result.observations.projectedOtherBytes > 100, 'real request fields are included in wire accounting');
    assert(result.assertions.some(assertion => assertion.name.includes('independently recognized exact caption')));
  }
});

test('composition corpus seal byteLength mismatch rejects before writer setup', async t => {
  const output = await mkdtemp(join(tmpdir(), 'ideogram-caption-seal-')); t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = makeCompositionFixture('WJ01'), path = join(output, 'WJ01.raw'); await writeFile(path, fixture.bytes);
  await assert.rejects(() => runCell({ repo, output, fixture: { corpus: { files: [{ id: 'WJ01', path, sha256: fixture.sha256, byteLength: fixture.byteLength + 1 }] } } }, { id: 'WJ01' }), /sealed corpus byte length/);
});

test('WJ24 complete newer-native claim remains inconclusive without actual native fixture', async t => {
  const output = await mkdtemp(join(tmpdir(), 'ideogram-partial-campaign-')); t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = makeCompositionFixture('WJ24'), path = join(output, 'WJ24.raw'); await writeFile(path, fixture.bytes);
  const result = await runCell({ repo, output, fixture: { corpus: { files: [{ id: fixture.id, path, sha256: fixture.sha256, byteLength: fixture.byteLength }] } } }, { id: 'WJ24' });
  assert.equal(result.status, 'inconclusive', JSON.stringify(result)); assert.equal(result.observations.complete, false);
  assert(result.assertions.every(assertion => assertion.passed));
  assert(result.missing.includes('sealed newer durable native text version predating the late partial provenance response'));
  assert(Number(result.observations.decodedPrefixBytes) > 0); assert.equal(result.observations.nativeLayersChecked, 0);
  assert.equal(result.observations.actualStaleNativeLinksChecked, 0);
  assert.equal(result.observations.actualCandidateProvenance, true); assert.equal(result.observations.seededAcknowledgement, true);
  assert(result.evidence[0].jobId); assert(result.evidence[0].attemptId);
  assert(result.assertions.some(assertion => assertion.name.includes('actual candidate receive')));
  assert(result.assertions.some(assertion => assertion.name.includes('hash-verified after reopen')));
});

test('WJ24 preserves an existing durable semantic graph and earlier raw references', async t => {
  const output = await mkdtemp(join(tmpdir(), 'ideogram-partial-existing-graph-')); t.after(() => rm(output, { recursive: true, force: true }));
  const common = await import('../../tooling/qualification/campaigns/backend-common.mjs');
  const api = await common.product({ repo }, 'src/composition/core.js');
  const seed = await common.createProductFixture({ repo, output: join(output, 'seed') });
  let expected, seedRoot;
  try {
    await common.createDocument(seed);
    const original = await common.stageBlob(seed, Buffer.from('Earlier retained raw description'), 'text', 'application/octet-stream');
    expected = api.emptyComposition(512, 512, 'existing_composition'); expected.scene = 'Existing scene'; expected.background = 'Existing background'; expected.raw = [original.blob];
    const element = api.emptyElement('text', 'existing_element'); element.text.value = 'Keep semantic lettering'; element.desc.value = 'Keep appearance description'; expected.elements = [element];
    const stored = await common.stageBlob(seed, Buffer.from(JSON.stringify(expected)), 'text', 'application/octet-stream');
    const command = common.envelope({ type: 'CommitCompositionVersion', composition: { id: expected.id, value: { ...stored.blob, mediaType: 'application/json' }, bindings: {} }, draft: null }, { documentId: seed.documentId, expectedDocumentRevision: await seed.writer.documentRevision(seed.documentId) });
    await common.finish(seed.writer, command, 'historyCommand'); seedRoot = seed.root;
  } finally { await seed.close(); }
  const corpus = makeCompositionFixture('WJ24'), path = join(output, 'WJ24.raw'); await writeFile(path, corpus.bytes);
  const result = await runCell({ repo, output: join(output, 'run'), fixture: { root: seedRoot, corpus: { files: [{ id: corpus.id, path, sha256: corpus.sha256, byteLength: corpus.byteLength }] }, observed: { nativeTextAdvancedBeforeLateProvenance: true } } }, { id: 'WJ24' });
  assert.equal(result.status, 'inconclusive', JSON.stringify(result));
  assert(result.missing.includes('sealed newer durable native text version predating the late partial provenance response'), 'attestation cannot invent a newer native text layer');
  assert.equal(result.observations.existingCompositionPreserved, true);
  const record = result.evidence[0], after = JSON.parse(await readFile(join(record.root, 'objects', 'sha256', record.graphRef.hash.slice(7, 9), record.graphRef.hash.slice(7)), 'utf8'));
  assert.equal(after.scene, expected.scene); assert.equal(after.background, expected.background); assert.deepEqual(after.elements, expected.elements); assert.deepEqual(after.frame, expected.frame);
  assert.deepEqual(after.raw.slice(0, -1), expected.raw); assert.deepEqual(after.raw.at(-1), record.recoveryRef); assert.equal(after.review, null); assert.notEqual(after.id, expected.id);
});
