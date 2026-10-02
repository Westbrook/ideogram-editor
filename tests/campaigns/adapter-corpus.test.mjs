// Pure binding and small-manifest boundary tests. No synthetic file is called a
// qualified 256 MiB adapter, and none of these tests constitutes product evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAdapterCorpus, assertImportedAdapterBinding } from '../../tooling/qualification/campaigns/adapter-corpus.mjs';

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const digest = letter => 'sha256:' + letter.repeat(64);
const file = (path, letter, bytes, mediaType) => ({ path, sha256: digest(letter), byteLength: String(bytes), mediaType });
const normal = () => ({ weights: file('weights.safetensors', 'a', 268435456, 'application/octet-stream'),
  config: file('config.json', 'b', 128, 'text/plain'), declaredFamily: 'ideogram-v4', declaredFormat: 'fal', expectedProfileId: 'qualified-producer-1' });

async function fixture(t, extra = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'wa-adapter-corpus-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = { kind: 'sealed-performance-fixture', version: 'unit-boundary-only', workload: 'WA', outcome: 'prepared', corpus: { files: [] }, ...extra };
  const manifestPath = join(directory, 'fixture.json'), contents = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, contents);
  return { ...manifest, manifestPath, seal: { path: manifestPath, sha256: hash(contents) } };
}

test('missing seals and missing descriptors remain inconclusive without creating specimens', async t => {
  const unsealed = await resolveAdapterCorpus({ adapterCorpus: { kind: 'wa-adapter-corpus-1', normal: normal() } });
  assert.equal(unsealed.status, 'inconclusive'); assert.equal(unsealed.specimen, null);
  const sealed = await resolveAdapterCorpus(await fixture(t));
  assert.equal(sealed.status, 'inconclusive'); assert.equal(sealed.specimen, null);
  assert(sealed.missing.some(value => value.includes('association is unavailable')));
  await assert.rejects(resolveAdapterCorpus({}, { requiredBytes: 16 }), /exactly 256 MiB or 1 GiB/);
});

test('the sealed manifest, not a changed caller projection, binds adapter associations', async t => {
  const input = await fixture(t);
  await assert.rejects(resolveAdapterCorpus({ ...input, adapterCorpus: { kind: 'wa-adapter-corpus-1', normal: normal() } }), /Caller changed/);
  await assert.rejects(resolveAdapterCorpus({ ...input, corpus: { files: [{ role: 'adapter-weights' }] } }), /Caller changed/);
  await writeFile(input.manifestPath, JSON.stringify({ ...input, adapterCorpus: { kind: 'wa-adapter-corpus-1', normal: normal() } }));
  await assert.rejects(resolveAdapterCorpus(input), /seal changed/);
});

test('descriptor paths, roles and exact benchmark sizes are checked before artifact reads', async t => {
  const escaped = normal(); escaped.weights.path = '../outside.safetensors';
  await assert.rejects(resolveAdapterCorpus(await fixture(t, { adapterCorpus: { kind: 'wa-adapter-corpus-1', normal: escaped } })), /escapes/);
  const undersized = normal(); undersized.weights.byteLength = '85299896';
  await assert.rejects(resolveAdapterCorpus(await fixture(t, { adapterCorpus: { kind: 'wa-adapter-corpus-1', normal: undersized } })), /prescribed exact size/);
  const wrongRole = normal(); wrongRole.config.role = 'adapter-weights';
  await assert.rejects(resolveAdapterCorpus(await fixture(t, { adapterCorpus: { kind: 'wa-adapter-corpus-1', normal: wrongRole } })), /role contradicts/);
  await assert.rejects(resolveAdapterCorpus(await fixture(t, { adapterCorpus: { kind: 'wa-adapter-corpus-1', normal: normal() } })), /matching sealed corpus file/);
});

test('absent stress association never substitutes the normal specimen', async t => {
  const result = await resolveAdapterCorpus(await fixture(t, { adapterCorpus: { kind: 'wa-adapter-corpus-1', normal: normal() } }), { requiredBytes: 1073741824 });
  assert.equal(result.status, 'inconclusive'); assert.equal(result.specimen, null); assert.match(result.missing[0], /stress/);
});

test('a symlinked manifest is refused even when its target bytes match the supplied seal', async t => {
  const input = await fixture(t), alias = join(input.manifestPath, '..', 'alias.json');
  await symlink(input.manifestPath, alias);
  await assert.rejects(resolveAdapterCorpus({ ...input, manifestPath: alias, seal: { ...input.seal, path: alias } }), /nonsymlink/);
});

function observedBinding() {
  const weights = { hash: digest('a'), byteLength: '268435456', mediaType: 'application/octet-stream' };
  const config = { hash: digest('b'), byteLength: '128', mediaType: 'text/plain' };
  const specimen = { kind: 'eligible-candidate', weights: { path: '/sealed/weights', hash: weights.hash, bytes: 268435456, mediaType: weights.mediaType },
    config: { path: '/sealed/config', hash: config.hash, bytes: 128, mediaType: config.mediaType }, provenance: null,
    declaredFamily: 'ideogram-v4', declaredFormat: 'fal', expectedProfileId: 'qualified-producer-1', descriptorIdentity: { sha256: digest('c') } };
  const adapter = { id: 'version-1', adapterId: 'adapter-1', version: '1', weights, config, origin: { kind: 'import', original: null },
    declaredFamily: 'ideogram-v4', declaredFormat: 'fal', qualification: 'structurally-valid',
    validation: { locallyEligible: true, runtimeVerified: false, profileId: 'qualified-producer-1' } };
  const asset = { id: adapter.id, purpose: 'adapter', qualification: 'adapter-version', availability: 'available', blob: weights, adapter };
  const view = { versionId: adapter.id, adapterId: adapter.adapterId, version: adapter.version, weights, config,
    origin: 'import', declaredFamily: adapter.declaredFamily, declaredFormat: adapter.declaredFormat, qualification: adapter.qualification,
    available: true, locallyEligible: true, runtimeVerified: false, profileId: adapter.validation.profileId };
  return { asset, view, specimen, isSupportedAdapterProfile: id => id === 'qualified-producer-1' };
}

test('metadata binding requires product-observed eligibility and the subject profile authority', () => {
  const input = observedBinding();
  const result = assertImportedAdapterBinding(input);
  assert.equal(result.eligible, true); assert.equal(result.binding.versionId, input.asset.id);
  assert.deepEqual(result.binding.config, input.asset.adapter.config); assert.equal(result.binding.runtimeVerified, false);
  assert.equal(assertImportedAdapterBinding({ ...input, isSupportedAdapterProfile: undefined }).eligible, false);
  assert.equal(assertImportedAdapterBinding({ ...input, isSupportedAdapterProfile: () => false }).eligible, false);
  const unsupported = observedBinding(); unsupported.asset.adapter.validation.locallyEligible = unsupported.view.locallyEligible = false;
  unsupported.asset.adapter.validation.profileId = unsupported.view.profileId = null;
  assert.equal(assertImportedAdapterBinding(unsupported).eligible, false);
  const structural = observedBinding(); structural.specimen.kind = 'structural-only'; structural.specimen.expectedProfileId = null;
  assert.equal(assertImportedAdapterBinding(structural).eligible, false);
});

test('metadata binding refuses changed configuration, version, eligibility, or runtime claims', () => {
  for (const mutate of [
    input => { input.view = { ...input.view, config: { ...input.view.config, hash: digest('d') } }; },
    input => { input.asset.adapter.config = { ...input.asset.adapter.config, byteLength: '127' }; },
    input => { input.view.versionId = 'other-version'; },
    input => { input.view.locallyEligible = false; },
    input => { input.asset.adapter.validation.runtimeVerified = true; },
    input => { input.view.runtimeVerified = true; },
    input => { input.asset.adapter.origin.original = input.asset.adapter.config; },
  ]) { const input = observedBinding(); mutate(input); assert.throws(() => assertImportedAdapterBinding(input)); }
});
