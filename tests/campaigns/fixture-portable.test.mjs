import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveFeatureEvidence, buildPortableFixture, portableFixturePlan } from '../../tooling/qualification/campaigns/fixture-portable.mjs';

const seed = () => ({ root: '/closed/mixed-root', documentId: 'mixed_document', archive: {
  path: '/sealed/mixed.zip', sha256: 'a'.repeat(64), byteLength: '20000',
} });

test('WC plan pins full workloads and discloses production mutations as preparation only', () => {
  const normal = portableFixturePlan({ workload: 'WC512', seed: seed() });
  const stress = portableFixturePlan({ workload: 'WC4G', seed: seed() });
  assert.deepEqual([normal.closureBytes, normal.assets, normal.events], ['536870912', 1000, 10000]);
  assert.deepEqual([stress.closureBytes, stress.assets, stress.events, stress.captionVersions], ['4294967296', 10000, 100000, 4096]);
  assert.equal(normal.qualification, false); assert.equal(normal.preparationOnly, true);
  assert(normal.mutations.some(value => value.includes('production') || value.includes('ImportBundle')));
  assert(normal.mutations.some(value => value.includes('SaveCopy')));
  for (const workload of ['WC', 'WC1', 'smoke', { id: 'WC512', assets: 1 }]) {
    assert.throws(() => portableFixturePlan({ workload, seed: seed() }), { code: 'FIXTURE_REQUIRED' });
  }
});

test('valid plan freezes caller-owned seed identities', () => {
  const input = seed(), plan = portableFixturePlan({ workload: 'WC512', seed: input });
  input.archive.sha256 = 'b'.repeat(64); input.root = '/different';
  assert.equal(plan.seed.archive.sha256, 'a'.repeat(64)); assert.equal(plan.seed.root, '/closed/mixed-root');
});

test('missing mixed seed returns explicit inconclusive without creating output', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'wc-missing-')); t.after(() => rm(parent, { recursive: true, force: true }));
  const result = await buildPortableFixture({ workload: 'WC4G', output: join(parent, 'must-not-exist') });
  assert.equal(result.status, 'inconclusive'); assert.equal(result.qualification, false);
  assert(result.missing[0].includes('mixed')); assert.deepEqual(await readdir(parent), []);
});

test('valid seed requires explicit heavy preparation and complete archive identity', async () => {
  for (const archive of [{}, { path: '/archive', sha256: 'short', byteLength: '12' }, { path: '/archive', sha256: 'a'.repeat(64), byteLength: '0' }]) {
    assert.throws(() => portableFixturePlan({ workload: 'WC512', seed: { ...seed(), archive } }), { code: 'FIXTURE_REQUIRED' });
  }
  await assert.rejects(buildPortableFixture({ workload: 'WC512', seed: seed() }), /allowHeavy:true/);
});

// These tiny indexes model the already-validated typed tables left by the
// production closure validator. They test evidence classification only, never
// pretend to be real WC archives, font validation, or performance samples.
function typedIndex(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE refs(hash TEXT PRIMARY KEY,bytes TEXT); CREATE TABLE entities(kind TEXT,id TEXT,json TEXT); CREATE TABLE adopted_lineages(json TEXT); CREATE TABLE text_sources(hash TEXT,json TEXT); CREATE TABLE semantic_versions(id TEXT,ref TEXT)');
  const content = new Map();
  const ref = value => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const hash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    db.prepare('INSERT OR IGNORE INTO refs VALUES (?,?)').run(hash, String(bytes.length)); content.set(hash, bytes);
    return { hash, byteLength: String(bytes.length), mediaType: 'application/json' };
  };
  const entity = (kind, id, value) => db.prepare('INSERT INTO entities VALUES (?,?,?)').run(kind, id, JSON.stringify(value));
  const encoded = ref('encoded original'), pixels = ref('actual pixel identity'), fontBytes = ref('licensed font'), license = ref('license'), layout = ref('frozen layout');
  entity('asset', 'original', { blob: encoded });
  const contribution = ref({ plan: { kind: 'cp1-layer-contribution-v1' } });
  const stack = ref({ kind: 'cp1-contribution-stack-v1', contributions: [{ manifest: contribution, pixels }] });
  const raster = ref({ plan: { kind: 'decoded-native', sourceAssetId: 'original', contributions: stack } });
  entity('asset', 'prepared', { blob: pixels, raster: { manifest: raster } });
  entity('candidate-result', 'candidate', { safety: 'safe', encodedAssetId: 'original', preparedAssetId: 'prepared' });
  const source = { text: { textUtf8: ref('Editable native text'), fonts: [{ embedding: 'permitted', bytes: fontBytes, licenseRecord: license }] }, render: { layout } };
  const sourceRef = ref(source); db.prepare('INSERT INTO text_sources VALUES (?,?)').run(sourceRef.hash, JSON.stringify(source));
  const raw = ref('Original caption\n'), prompt = ref('Derived caption');
  const composition = ref({ id: 'composition_1', raw: [raw], review: { prompt } });
  db.prepare('INSERT INTO semantic_versions VALUES (?,?)').run('composition_1', JSON.stringify({ id: 'composition_1', value: composition, bindings: {} }));
  const adapter = ref('Weights'); entity('asset', 'adapter', { qualification: 'adapter-version', adapter: { weights: adapter, config: null, validation: {} } });
  return { db, read: async ref => { assert(content.has(ref.hash)); return content.get(ref.hash); }, ref, encoded, raw, prompt, composition };
}

test('feature evidence follows typed raster/candidate/native/composition/adapter edges', async t => {
  const fixture = typedIndex(t), evidence = await archiveFeatureEvidence(fixture.db, fixture.read);
  assert.equal(evidence.captionVersions, 1); assert.equal(evidence.typedFeaturesVerified, true);
  assert(evidence.features.originals.includes(fixture.encoded.hash));
  assert(evidence.features.retainedCandidates.includes(fixture.encoded.hash));
  assert(evidence.features.rawCaptions.includes(fixture.raw.hash));
  assert(evidence.features.derivedCaptions.includes(fixture.prompt.hash));
  for (const name of ['editableText', 'licensedFonts', 'frozenLayouts', 'contributions', 'adapters']) assert(evidence.features[name].length > 0, name);
});

test('arbitrary rooted hashes cannot masquerade as typed feature evidence', async t => {
  const fixture = typedIndex(t), padding = fixture.ref('unrelated rooted bytes');
  await assert.rejects(archiveFeatureEvidence(fixture.db, fixture.read, { seal: {
    counts: { captionVersions: 1 }, features: { originals: [padding.hash] },
  } }), /not typed retained evidence/);
  await assert.rejects(archiveFeatureEvidence(fixture.db, fixture.read, { seal: {
    counts: { captionVersions: 1 }, features: { unknown: [padding.hash] },
  } }), /Unknown WC feature/);
});

test('declared 4096 caption versions cannot replace actual retained version count', async t => {
  const fixture = typedIndex(t);
  await assert.rejects(archiveFeatureEvidence(fixture.db, fixture.read, { seal: {
    counts: { captionVersions: 4096 }, features: { rawCaptions: [fixture.raw.hash], derivedCaptions: [fixture.composition.hash] },
  } }), /Exact retained reviewed caption version count/);
});
