import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { fastSetupRequirements, selectFastSetupImage, verifyFastSetupSource, verifyFastSetupMask, prepareFastBrowserFixture } from '../../tooling/qualification/campaigns/browser-fast-setup.mjs';

const copy = value => structuredClone(value);
const hash = digit => 'sha256:' + digit.repeat(64);
const cell = (caseId, scenario) => ({ operation: 'fast.workflow', parameters: { caseId, ...(scenario === undefined ? {} : { scenario }) } });
const blob = (digit, bytes = '512') => ({ hash: hash(digit), byteLength: bytes, mediaType: 'application/octet-stream' });
const imageFile = () => ({ id: 'sealed_png', role: 'fast-candidate', path: join(tmpdir(), 'sealed-fast-512.png'), sha256: hash('a'), byteLength: '1024', width: 512, height: 512, format: 'png', index: 0 });
const documentView = () => ({ id: 'owned_document', revision: '0', historyHead: 'original_head', width: 512, height: 512, orderedLayerIds: [], image: { state: blob('b'), semanticDigest: hash('c'), compositeAssetId: 'original_composite' } });
const imageView = () => ({ width: 512, height: 512, layers: [] });
const eligible = () => ({ versionId: 'eligible_version', weights: blob('d'), name: 'Fixture adapter', version: '1', available: true, locallyEligible: true });
const fixture = () => ({ documentId: 'owned_document', corpus: { files: [imageFile()] }, adapterLibrary: { eligibleEntries: [{ versionId: 'eligible_version', weights: blob('d') }] } });
const noPage = () => new Proxy({}, { get(_target, key) { assert.fail('Prerequisite failure must precede browser access: ' + String(key)); } });

function sourceWitness() {
  return {
    file: selectFastSetupImage(fixture()),
    document: { ...documentView(), revision: '1', historyHead: 'source_head', orderedLayerIds: ['source_layer'] },
    image: { width: 512, height: 512, layers: [{ id: 'source_layer', kind: 'image', assetId: 'source_asset', visible: true, locked: false, opacity: 1, mask: null, layerToDocument: [1, 0, 0, 1, 0, 0] }] },
    asset: { id: 'source_asset', availability: 'available', safety: 'safe', qualification: 'canonical-raster', raster: { role: 'native', width: 512, height: 512, pixels: blob('e'), manifest: blob('f'), sourceAssetIds: ['original_asset'] } },
    original: { id: 'original_asset', availability: 'available', safety: 'unknown', blob: { ...blob('a', '1024'), mediaType: 'image/png' }, measuredMediaType: 'image/png' },
  };
}

function maskWitness() {
  const source = sourceWitness();
  return {
    source: verifyFastSetupSource(source),
    document: { ...source.document, revision: '2', historyHead: 'mask_head' },
    image: { ...source.image, layers: [{ ...source.image.layers[0], mask: { assetId: 'mask_asset', mapping: 'document-r16-v1', inverted: false } }] },
    asset: { id: 'mask_asset', qualification: 'canonical-raster', raster: { role: 'mask', width: 512, height: 512, pixels: blob('1'), manifest: blob('2') } },
    manifest: { plan: { kind: 'authored-mask-v2', authoring: { width: 512, height: 512, feather: 0, operations: [{ kind: 'stroke', size: 64, hardness: 1, mode: 'add', points: Array.from({ length: 120 }, (_, index) => [192 + Math.min(index, 118) * 128 / 118, 256]) }] }, statistics: { hardPixels: 8192, effectivePixels: 8192, support: { x: 160, y: 224, width: 192, height: 64 } } } },
  };
}

// Pure orchestration model: evaluate the actual public-read callback with a
// strict fetch double. Only the real document picker and Pan control exist.
// No browser, services, image files, durable commands, or provider are used.
function readonlyPage(options = {}) {
  const state = { document: copy(options.document ?? documentView()), image: copy(options.image ?? imageView()), reads: [], clicks: [], waits: [] };
  const publicValues = options.publicValues ?? {};
  function locator(role, name, scope) {
    const value = {
      getByRole(childRole, childOptions = {}) { return locator(childRole, childOptions.name, name); },
      filter(options) {
        assert.equal(role, 'selector'); assert.equal(name, '.document-name');
        assert.equal(options.hasText, `${state.document.width} × ${state.document.height} · revision ${state.document.revision}`); return value;
      },
      async click() {
        if (name instanceof RegExp) {
          assert.equal(role, 'button'); assert.equal(scope, 'Open document'); assert(name.test('Untitled document · owned_document · 512 × 512 · revision '+state.document.revision));assert(!name.test('Contains owned_document · foreign_document · 512 × 512 · revision '+state.document.revision),'Authored title cannot impersonate the document identity');
          state.clicks.push('Select owned document');
          if (options.afterReopen) state.document = copy(options.afterReopen);
          return;
        }
        assert.equal(role, 'button'); assert(['Open', 'Pan'].includes(name), 'Unexpected mutable setup control: ' + name); state.clicks.push(name);
      },
      async waitFor(options) { state.waits.push([role, String(name), options.state]); },
    };
    return value;
  }
  const page = {
    getByRole(role, options = {}) { return locator(role, options.name); },
    locator(selector) { assert.equal(selector, '.document-name'); return locator('selector', selector); },
    async evaluate(callback, path) {
      const fetch = async (actualPath, init) => {
        assert.equal(actualPath, path); assert.deepEqual(copy(init), { headers: { 'X-App-Client': 'LP-1' }, credentials: 'same-origin' });
        state.reads.push(path); let value;
        if (Object.hasOwn(publicValues, path)) value = publicValues[path];
        else if (path === '/api/v1/documents/owned_document') value = { projection: { kind: 'inline', value: state.document } };
        else if (path === '/api/v1/documents/owned_document/image') value = state.image;
        else if (path === '/api/v1/adapters/eligible_version') value = options.adapter ?? eligible();
        else assert.fail('Unapproved setup read or durable mutation: ' + path);
        return { ok: true, json: async () => copy(value) };
      };
      return copy(await runInNewContext('(' + callback.toString() + ')', { fetch })(path));
    },
  };
  return { page, state };
}

test('setup planner requests only the exact source, mask and adapter prerequisites for WF07–WF09', () => {
  assert.deepEqual(fastSetupRequirements(cell('WF07')), { caseId: 'WF07', scenario: 'reject-source', source: true, mask: false, adapter: false });
  assert.deepEqual(fastSetupRequirements(cell('WF08', 'reject-mask')), { caseId: 'WF08', scenario: 'reject-mask', source: true, mask: true, adapter: false });
  assert.deepEqual(fastSetupRequirements(cell('WF09')), { caseId: 'WF09', scenario: 'reject-lora', source: false, mask: false, adapter: true });
  for (const value of [null, {}, cell('WF01'), cell('WF10'), cell('WF11'), cell('WF12'), cell('__proto__'), cell('constructor'), { ...cell('WF07'), operation: 'queue.fault' }]) assert.equal(fastSetupRequirements(value), null);
});

test('setup planner refuses a mismatched scenario instead of preparing another invalid input', () => {
  for (const value of [cell('WF07', 'reject-mask'), cell('WF08', 'reject-source'), cell('WF09', 'reject-acceleration'), cell('WF07', null), cell('WF09', '')]) assert.throws(() => fastSetupRequirements(value), { code: 'CAMPAIGN_PREREQUISITE' });
});

test('sealed source selection requires exactly the PNG, dimensions and result index, not a generic image', () => {
  const selected = imageFile(), other = [
    { ...selected, id: 'other_role', role: 'candidate-result' }, { ...selected, id: 'jpeg', format: 'jpeg' },
    { ...selected, id: 'wide', width: 1024 }, { ...selected, id: 'tall', height: 1024 }, { ...selected, id: 'second', index: 1 },
  ];
  assert.deepEqual(selectFastSetupImage({ corpus: { files: [...other, selected] } }), { id: selected.id, path: selected.path, sha256: selected.sha256, bytes: 1024, width: 512, height: 512 });
  for (const value of [undefined, {}, { corpus: { files: other } }, { corpus: { files: [selected, copy(selected)] } }]) assert.throws(() => selectFastSetupImage(value), { code: 'CAMPAIGN_PREREQUISITE' });
});

test('sealed source selection refuses incomplete identities, unsafe byte bounds and relative paths', () => {
  for (const patch of [
    { id: '' }, { id: 'wrong/id' }, { path: 'relative.png' }, { path: null }, { sha256: 'unsealed' },
    { byteLength: '0' }, { byteLength: '-1' }, { byteLength: '1.5' }, { byteLength: '01' }, { byteLength: ' 1024 ' },
    { byteLength: '8388609' }, { byteLength: '9007199254740992' }, { byteLength: undefined, bytes: undefined },
  ]) assert.throws(() => selectFastSetupImage({ corpus: { files: [{ ...imageFile(), ...patch }] } }), { code: 'CAMPAIGN_PREREQUISITE' });
  const maximum = { ...imageFile(), byteLength: undefined, bytes: 8 * 1024 * 1024 };
  assert.equal(selectFastSetupImage({ corpus: { files: [maximum] } }).bytes, 8 * 1024 * 1024);
  assert.equal(selectFastSetupImage({ corpus: { files: [{ ...imageFile(), bytes: 999 }] } }).bytes, 1024);
});

test('source witness retains the sealed original bytes and canonical pixels as separate identities', () => {
  const witness = sourceWitness();
  assert.deepEqual(verifyFastSetupSource(witness), { layerId: 'source_layer', assetId: 'source_asset', originalAssetId: 'original_asset', originalHash: hash('a'), originalBytes: 1024, pixelHash: hash('e'), manifestHash: hash('f'), width: 512, height: 512 });
  assert.equal(witness.original.safety, 'unknown', 'The original blob is retained; the derived canonical asset is decoded separately');
});

test('source witness refuses foreign original bytes, multiple originals and document-layer disagreement', () => {
  for (const mutate of [
    value => { value.asset.raster.sourceAssetIds = []; }, value => { value.asset.raster.sourceAssetIds.push('other_original'); },
    value => { value.original.id = 'foreign_original'; }, value => { value.original.blob.hash = hash('0'); },
    value => { value.original.blob.byteLength = '1025'; }, value => { value.original.measuredMediaType = 'image/jpeg'; },
    value => { value.document.orderedLayerIds = []; }, value => { value.document.orderedLayerIds = ['foreign_layer']; },
  ]) { const witness = sourceWitness(); mutate(witness); assert.throws(() => verifyFastSetupSource(witness), { code: 'CAMPAIGN_PREREQUISITE' }); }
});

test('source witness refuses an ambiguous, invisible, locked, masked or noncanonical source', () => {
  for (const mutate of [
    value => { value.image.layers = []; }, value => { value.image.layers.push(copy(value.image.layers[0])); },
    value => { value.image.layers[0].kind = 'text'; }, value => { value.image.layers[0].id = 'bad/id'; },
    value => { value.image.layers[0].assetId = 'foreign_asset'; }, value => { value.image.layers[0].visible = false; },
    value => { value.image.layers[0].locked = true; }, value => { value.image.layers[0].mask = { assetId: 'old_mask' }; },
    value => { value.image.layers[0].opacity = 0; }, value => { value.image.layers[0].layerToDocument = [1, 0, 0, 1]; },
    value => { value.image.layers[0].layerToDocument[4] = NaN; }, value => { value.asset.qualification = 'raw'; },
    value => { value.asset.raster.role = 'mask'; }, value => { value.asset.raster.width = 1024; }, value => { value.asset.raster.height = 256; },
    value => { value.asset.raster.pixels.hash = 'unsealed'; }, value => { value.asset.raster.manifest.hash = 'unsealed'; },
  ]) { const witness = sourceWitness(); mutate(witness); assert.throws(() => verifyFastSetupSource(witness), { code: 'CAMPAIGN_PREREQUISITE' }); }
});

test('mask witness binds real source and mask assets to the exact unfeathered 120-sample brush plan', () => {
  for (const kind of ['authored-mask-v1', 'authored-mask-v2']) {
    const witness = maskWitness(); witness.manifest.plan.kind = kind;
    const result = verifyFastSetupMask(witness);
    assert.equal(result.layerId, 'source_layer'); assert.equal(result.assetId, 'mask_asset'); assert.equal(result.pixelHash, hash('1')); assert.equal(result.manifestHash, hash('2'));
    assert.equal(result.brushDiameter, 64); assert.equal(result.samples, 120); assert.equal(result.hardPixels, 8192); assert.equal(result.effectivePixels, 8192);
    assert.deepEqual(result.support, { x: 160, y: 224, width: 192, height: 64 }); assert.match(result.authoringHash, /^sha256:[a-f0-9]{64}$/);
    witness.manifest.plan.statistics.support.x = 0; assert.equal(result.support.x, 160, 'Evidence must not alias mutable manifest support');
  }
});

test('mask witness rejects a foreign source, wrong mask binding, raster role, size or pixel identity', () => {
  for (const mutate of [
    value => { value.image.layers = []; }, value => { value.image.layers.push(copy(value.image.layers[0])); },
    value => { value.image.layers[0].id = 'foreign_layer'; }, value => { value.image.layers[0].assetId = 'foreign_source'; },
    value => { value.image.layers[0].visible = false; }, value => { value.image.layers[0].mask = null; },
    value => { value.image.layers[0].mask.assetId = 'foreign_mask'; }, value => { value.image.layers[0].mask.mapping = 'layer-space'; },
    value => { value.image.layers[0].mask.inverted = true; }, value => { value.asset.qualification = 'raw'; },
    value => { value.asset.raster.role = 'native'; }, value => { value.asset.raster.width = 511; }, value => { value.asset.raster.height = 511; },
    value => { value.asset.raster.pixels.hash = 'unsealed'; }, value => { value.asset.raster.manifest.hash = 'unsealed'; },
  ]) { const witness = maskWitness(); mutate(witness); assert.throws(() => verifyFastSetupMask(witness), { code: 'CAMPAIGN_PREREQUISITE' }); }
});

test('mask witness rejects a different authoring plan, brush or out-of-document sample', () => {
  for (const mutate of [
    value => { value.kind = 'retained-mask'; }, value => { value.authoring.width = 511; }, value => { value.authoring.height = 511; },
    value => { value.authoring.feather = 1; }, value => { value.authoring.operations.push(copy(value.authoring.operations[0])); },
    value => { value.authoring.operations[0].kind = 'fill'; }, value => { value.authoring.operations[0].size = 32; },
    value => { value.authoring.operations[0].hardness = 0.5; }, value => { value.authoring.operations[0].mode = 'subtract'; },
    value => { value.authoring.operations[0].points.pop(); }, value => { value.authoring.operations[0].points[0] = [NaN, 256]; },
    value => { value.authoring.operations[0].points[0] = [-1, 256]; }, value => { value.authoring.operations[0].points[0] = [256, 513]; },
    value => { value.authoring.operations[0].points[0] = [256, 256, 1]; },
  ]) { const witness = maskWitness(); mutate(witness.manifest.plan); assert.throws(() => verifyFastSetupMask(witness), { code: 'CAMPAIGN_PREREQUISITE' }); }
});

test('mask witness requires partial measured pixels inside a bounded integral support rectangle', () => {
  for (const mutate of [
    value => { value.hardPixels = 0; value.effectivePixels = 0; }, value => { value.hardPixels = 8192.5; },
    value => { value.effectivePixels = 8191; }, value => { value.hardPixels = 512 * 512; value.effectivePixels = 512 * 512; },
    value => { value.support = null; }, value => { value.support.x = -1; }, value => { value.support.y = -1; },
    value => { value.support.x = 160.5; }, value => { value.support.height = 64.5; }, value => { value.support.width = 0; },
    value => { value.support.height = 0; }, value => { value.support.x = 500; }, value => { value.support.y = 500; },
    value => { value.support.width = 513; }, value => { value.support.height = Infinity; },
    value => { value.support.width = 1; value.support.height = 1; },
  ]) { const witness = maskWitness(); mutate(witness.manifest.plan.statistics); assert.throws(() => verifyFastSetupMask(witness), { code: 'CAMPAIGN_PREREQUISITE' }); }
});

test('unrelated cells skip setup without accessing a page or relabeling their fixture', async () => {
  const result = await prepareFastBrowserFixture({ page: noPage(), cell: cell('WF11') });
  assert.deepEqual(result, { status: 'PASS', kind: 'fast-browser-preparation-1', preparationOnly: true, required: false, phases: [], observations: {} });
});

test('an aborted required setup retains the caller reason before any public read', async () => {
  const controller = new AbortController(), reason = Error('setup cancelled'); controller.abort(reason);
  await assert.rejects(prepareFastBrowserFixture({ page: noPage(), fixture: fixture(), cell: cell('WF09'), signal: controller.signal }), error => error === reason);
});

test('WF09 verifies the exact immutable eligible adapter and reopens through public controls without document mutations', async () => {
  for (const key of ['adapterLibrary', 'nested', 'adapters']) {
    const owned = fixture(), library = owned.adapterLibrary; delete owned.adapterLibrary;
    if (key === 'adapterLibrary') owned.adapterLibrary = library;
    else owned.adapters = key === 'nested' ? { library } : library;
    const { page, state } = readonlyPage(), result = await prepareFastBrowserFixture({ page, fixture: owned, cell: cell('WF09') });
    assert.equal(result.status, 'PASS'); assert.equal(result.preparationOnly, true); assert.equal(result.required, true);
    assert.deepEqual(result.observations.before, result.observations.after);
    assert.deepEqual(result.observations.adapter, { versionId: 'eligible_version', weightsHash: hash('d'), available: true, locallyEligible: true, preparation: 'production writer before server startup; public readonly eligibility witness' });
    assert.deepEqual(state.clicks, ['Open', 'Select owned document', 'Pan']);
    assert.deepEqual(state.reads, ['/api/v1/documents/owned_document', '/api/v1/documents/owned_document/image', '/api/v1/adapters/eligible_version', '/api/v1/documents/owned_document', '/api/v1/documents/owned_document', '/api/v1/documents/owned_document/image']);
    assert.deepEqual(result.phases.map(phase => [phase.name, phase.outcome]), [['fixture.fast-adapter-public-eligibility', 'completed'], ['fixture.fast-prepared-document-reopen', 'completed']]);
    assert(result.phases.every(phase => Number.isFinite(phase.durationMs) && phase.durationMs >= 0));
  }
});

test('WF09 missing or changed eligibility fails before controls and retains failed prerequisite evidence', async () => {
  for (const patch of [{ versionId: 'different_version' }, { available: false }, { locallyEligible: false }, { weights: blob('0') }]) {
    const { page, state } = readonlyPage({ adapter: { ...eligible(), ...patch } });
    await assert.rejects(prepareFastBrowserFixture({ page, fixture: fixture(), cell: cell('WF09') }), error => {
      assert.equal(error.code, 'CAMPAIGN_PREREQUISITE'); assert.match(error.message, /exact immutable adapter/);
      assert.equal(error.evidence.preparationOnly, true); assert.equal(error.evidence.phases[0].outcome, 'failed'); return true;
    });
    assert.deepEqual(state.clicks, []);
  }
  const { page, state } = readonlyPage(), owned = fixture(); owned.adapterLibrary.eligibleEntries = [];
  await assert.rejects(prepareFastBrowserFixture({ page, fixture: owned, cell: cell('WF09') }), /prepareAdapterLibrary/);
  assert.deepEqual(state.clicks, []); assert.equal(state.reads.some(path => path.startsWith('/api/v1/adapters/')), false);
});

test('WF09 refuses a changed document after picker reopen rather than claiming readonly preparation', async () => {
  const { page } = readonlyPage({ afterReopen: { ...documentView(), revision: '1', historyHead: 'unrelated_edit' } });
  await assert.rejects(prepareFastBrowserFixture({ page, fixture: fixture(), cell: cell('WF09') }), /Readonly adapter preparation changed the document/);
});

test('setup rejects foreign projections, inconsistent dimensions or layer roots before touching controls', async () => {
  for (const publicValues of [
    { '/api/v1/documents/owned_document': { projection: { kind: 'blob', value: documentView() } } },
    { '/api/v1/documents/owned_document': { projection: { kind: 'inline', value: { ...documentView(), id: 'foreign_document' } } } },
    { '/api/v1/documents/owned_document/image': { ...imageView(), width: 1024 } },
  ]) {
    const { page, state } = readonlyPage({ publicValues });
    await assert.rejects(prepareFastBrowserFixture({ page, fixture: fixture(), cell: cell('WF09') }), { code: 'CAMPAIGN_PREREQUISITE' }); assert.deepEqual(state.clicks, []);
  }
  const { page, state } = readonlyPage({ image: { ...imageView(), layers: [{ id: 'foreign_layer' }] } });
  await assert.rejects(prepareFastBrowserFixture({ page, fixture: fixture(), cell: cell('WF09') }), /document and image layer identities disagree/); assert.deepEqual(state.clicks, []);
});

test('source and mask setup refuse a nonempty owned starting document before importing any image', async () => {
  for (const caseId of ['WF07', 'WF08']) {
    const witness = sourceWitness(), { page, state } = readonlyPage({ document: witness.document, image: witness.image });
    await assert.rejects(prepareFastBrowserFixture({ page, fixture: fixture(), cell: cell(caseId) }), /unchanged empty owned WF starting document/);
    assert.deepEqual(state.clicks, []); assert.equal(state.reads.length, 2);
  }
});

test('source setup fails on a missing sealed image before filesystem access or public import controls', async () => {
  const owned = fixture(); owned.corpus.files = [];
  const { page, state } = readonlyPage();
  await assert.rejects(prepareFastBrowserFixture({ page, fixture: owned, cell: cell('WF07') }), error => {
    assert.equal(error.code, 'CAMPAIGN_PREREQUISITE'); assert.match(error.message, /exactly one sealed 512px PNG/);
    assert.equal(error.evidence.phases[0].name, 'fixture.fast-source-public-import'); assert.equal(error.evidence.phases[0].outcome, 'failed'); return true;
  });
  assert.deepEqual(state.clicks, []);
});
