// Untimed, cell-local WF07–WF09 prerequisites. The sealed starting root is not
// relabeled after preparation: return the actual new identities and receipts so
// the outer driver can retain them before capturing its reset/scoring baseline.
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { digest, fileIdentity, intervalWait, monotonic, PrerequisiteError } from './common.mjs';
import { acceptedCommand, numeric, openDocument, publicRead } from './browser-driver.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const issue = message => { throw new PrerequisiteError(message); };
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const definitions = Object.freeze({
  WF07: ['reject-source', true, false, false],
  WF08: ['reject-mask', true, true, false],
  WF09: ['reject-lora', false, false, true],
});

export function fastSetupRequirements(cell) {
  if (cell?.operation !== 'fast.workflow') return null;
  const caseId = cell.parameters?.caseId;
  if (!Object.hasOwn(definitions, caseId)) return null;
  const [scenario, source, mask, adapter] = definitions[caseId];
  if (cell.parameters.scenario !== undefined && cell.parameters.scenario !== scenario) issue('Fast setup scenario does not match its exact WF case');
  return { caseId, scenario, source, mask, adapter };
}

export function selectFastSetupImage(fixture) {
  const matches = fixture?.corpus?.files?.filter(file => file.role === 'fast-candidate' && file.width === 512 && file.height === 512 && file.format === 'png' && file.index === 0) ?? [];
  if (matches.length !== 1) issue('Fast source setup requires exactly one sealed 512px PNG candidate at index 0');
  const file = matches[0], bytes = file.byteLength ?? file.bytes;
  if (!opaque(file.id) || typeof file.path !== 'string' || !isAbsolute(file.path) || !HASH.test(file.sha256 ?? '') || !/^[1-9][0-9]*$/.test(String(bytes)) || !Number.isSafeInteger(Number(bytes)) || Number(bytes) > 8 * 1024 * 1024) issue('Fast source setup corpus identity is incomplete or outside the encoded image bound');
  return { id: file.id, path: file.path, sha256: file.sha256, bytes: Number(bytes), width: 512, height: 512 };
}

function documentIdentity(document) {
  if (!opaque(document?.id) || !opaque(document.historyHead) || typeof document.revision !== 'string' || !/^[0-9]+$/.test(document.revision) || !HASH.test(document.image?.state?.hash ?? '') || !HASH.test(document.image?.semanticDigest ?? '') || !Array.isArray(document.orderedLayerIds)) issue('Fast setup requires a complete public document identity');
  return { id: document.id, revision: document.revision, historyHead: document.historyHead, width: document.width, height: document.height, orderedLayerIds: [...document.orderedLayerIds], imageStateHash: document.image.state.hash, semanticDigest: document.image.semanticDigest, compositeAssetId: document.image.compositeAssetId ?? null };
}

async function readDocument(page, fixture) {
  if (!opaque(fixture?.documentId)) issue('Fast setup requires its sealed document identity');
  const result = await publicRead(page, '/api/v1/documents/' + fixture.documentId);
  if (result.projection?.kind !== 'inline' || result.projection.value?.id !== fixture.documentId) issue('Fast setup requires the exact inline document projection');
  const document = result.projection.value;
  documentIdentity(document);
  const image = await publicRead(page, '/api/v1/documents/' + fixture.documentId + '/image');
  if (!Array.isArray(image.layers) || image.width !== document.width || image.height !== document.height) issue('Fast setup document and image dimensions disagree');
  assert.deepEqual(image.layers.map(layer => layer.id), document.orderedLayerIds, 'Fast setup document and image layer identities disagree');
  return { document, image };
}

async function readAsset(page, id, { original = false } = {}) {
  if (!opaque(id)) issue('Fast setup asset identity is invalid');
  const result = await publicRead(page, '/api/v1/assets/' + id), asset = result.projection?.value;
  if (result.projection?.kind !== 'inline' || asset?.id !== id || asset.availability !== 'available' || !(original ? ['safe', 'unknown'].includes(asset.safety) : asset.safety === 'safe')) issue('Fast setup requires an available public original or a safe canonical asset');
  return asset;
}

export function verifyFastSetupSource({ document, image, asset, original, file }) {
  if (image?.layers?.length !== 1) issue('Fast source setup must produce exactly one image layer in its empty owned document');
  const layer = image.layers[0];
  if (layer.kind !== 'image' || !opaque(layer.id) || layer.assetId !== asset?.id || layer.visible !== true || layer.locked !== false || layer.mask != null || !(layer.opacity > 0) || asset.qualification !== 'canonical-raster' || asset.raster?.role !== 'native' || asset.raster.width !== file.width || asset.raster.height !== file.height || !HASH.test(asset.raster.pixels?.hash ?? '') || !HASH.test(asset.raster.manifest?.hash ?? '') || !Array.isArray(layer.layerToDocument) || layer.layerToDocument.length !== 6 || !layer.layerToDocument.every(Number.isFinite)) issue('Fast source setup did not create the prescribed visible canonical image layer');
  if (asset.raster.sourceAssetIds?.length !== 1 || asset.raster.sourceAssetIds[0] !== original?.id || original.blob?.hash !== file.sha256 || String(original.blob?.byteLength) !== String(file.bytes) || original.measuredMediaType !== 'image/png') issue('Fast source setup does not retain the exact sealed PNG original');
  if (document.orderedLayerIds?.length !== 1 || document.orderedLayerIds[0] !== layer.id) issue('Fast source setup did not bind its layer to the target document');
  return { layerId: layer.id, assetId: asset.id, originalAssetId: original.id, originalHash: original.blob.hash, originalBytes: file.bytes, pixelHash: asset.raster.pixels.hash, manifestHash: asset.raster.manifest.hash, width: asset.raster.width, height: asset.raster.height };
}

export function verifyFastSetupMask({ document, image, source, asset, manifest }) {
  const layer = image?.layers?.length === 1 ? image.layers[0] : null;
  const plan = manifest?.plan, authoring = plan?.authoring, stats = plan?.statistics;
  if (!layer || layer.id !== source.layerId || layer.assetId !== source.assetId || layer.visible !== true || layer.mask?.assetId !== asset?.id || layer.mask.mapping !== 'document-r16-v1' || layer.mask.inverted !== false || asset.qualification !== 'canonical-raster' || asset.raster?.role !== 'mask' || asset.raster.width !== document.width || asset.raster.height !== document.height || !HASH.test(asset.raster.pixels?.hash ?? '') || !HASH.test(asset.raster.manifest?.hash ?? '')) issue('Fast mask setup did not attach the actual retained document mask');
  if (!['authored-mask-v1', 'authored-mask-v2'].includes(plan?.kind) || authoring?.width !== document.width || authoring.height !== document.height || authoring.feather !== 0 || authoring.operations?.length !== 1) issue('Fast mask setup must retain its exact fresh unfeathered brush plan');
  const stroke = authoring.operations[0];
  if (stroke.kind !== 'stroke' || stroke.size !== 64 || stroke.hardness !== 1 || stroke.mode !== 'add' || stroke.points?.length !== 120 || !stroke.points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && point[0] >= 0 && point[0] <= document.width && point[1] >= 0 && point[1] <= document.height)) issue('Fast mask setup lacks its actual 64px brush geometry');
  if (!Number.isSafeInteger(stats?.hardPixels) || !Number.isSafeInteger(stats?.effectivePixels) || stats.hardPixels <= 0 || stats.effectivePixels !== stats.hardPixels || stats.effectivePixels >= document.width * document.height || !stats.support || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(stats.support[key])) || stats.support.x < 0 || stats.support.y < 0 || stats.support.width <= 0 || stats.support.height <= 0 || stats.support.x + stats.support.width > document.width || stats.support.y + stats.support.height > document.height || stats.effectivePixels > stats.support.width * stats.support.height) issue('Fast mask setup must retain nonempty partial measured mask coverage');
  return { layerId: layer.id, assetId: asset.id, pixelHash: asset.raster.pixels.hash, manifestHash: asset.raster.manifest.hash, authoringHash: digest(authoring), hardPixels: stats.hardPixels, effectivePixels: stats.effectivePixels, support: { x: stats.support.x, y: stats.support.y, width: stats.support.width, height: stats.support.height }, brushDiameter: 64, samples: 120 };
}

async function bindReceipt(page, receipt, document) {
  const value = await publicRead(page, '/api/v1/commands/' + receipt.commandId);
  if (value.receipt?.commandId !== receipt.commandId || value.receipt.status !== 'accepted' || value.receipt.documentRevision !== document.revision) issue('Fast setup document revision does not match its accepted mutation receipt');
  return { ...receipt, documentRevision: value.receipt.documentRevision };
}

async function prepareSource(page, fixture, signal) {
  const file = selectFastSetupImage(fixture), actual = await fileIdentity(file.path);
  if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) issue('Fast setup PNG bytes changed after sealing');
  await click(page, 'Import image');
  await page.locator('en-file-upload[label="Image file"] input').setInputFiles(file.path);
  const dialog = page.getByRole('dialog', { name: 'Review image conversion', exact: true });
  await dialog.waitFor({ state: 'visible' });
  const receipt = await acceptedCommand(page, 'ImportAsset', () => dialog.getByRole('button', { name: 'Apply reviewed result', exact: true }).click(), signal);
  await dialog.waitFor({ state: 'hidden' });
  const { document, image } = await readDocument(page, fixture);
  if (image.layers.length !== 1) issue('Fast source setup did not import one layer');
  const asset = await readAsset(page, image.layers[0].assetId);
  if (asset.raster?.sourceAssetIds?.length !== 1) issue('Fast source setup requires one retained PNG original');
  const original = await readAsset(page, asset.raster.sourceAssetIds[0], { original: true });
  return { ...verifyFastSetupSource({ document, image, asset, original, file }), input: { id: file.id, sha256: file.sha256, bytes: file.bytes }, receipt: await bindReceipt(page, receipt, document) };
}

async function prepareMask(page, fixture, source, signal) {
  const { document, image } = await readDocument(page, fixture), layer = image.layers[0];
  if (image.layers.length !== 1 || layer.id !== source.layerId) issue('Fast mask setup lost the sole imported layer');
  const rows = page.locator('#layer-tree').getByRole('treeitem');
  if (await rows.count() !== 1) issue('Fast setup layer is not uniquely visible in the public tree');
  await rows.click(); await click(page, 'Mask');
  await numeric(page, 'Brush diameter (document px)', 64);
  await numeric(page, 'Brush hardness (0–1)', 1);
  await numeric(page, 'Feather radius (document px)', 0);
  // This segmented control exposes real radio buttons, not a select element.
  await page.getByRole('group', { name: 'Brush action', exact: true }).getByRole('radio', { name: 'add', exact: true }).check();
  await click(page, 'Start fresh mask'); await click(page, 'Fit');
  const canvas = page.locator('canvas[aria-label="Document raster preview"]'), box = await canvas.boundingBox();
  if (!box || box.width <= 40 || box.height <= 40) issue('Fast mask setup has no usable visible canvas');
  const transform = layer.layerToDocument, zoom = Math.min((box.width - 40) / document.width, (box.height - 40) / document.height);
  // Place the setup stroke inside the actual imported image, using its public
  // layer transform. These are setup events, never the scored brush corpus.
  const points = Array.from({ length: 119 }, (_, index) => {
    const x = 192 + index * 128 / 118, y = 256;
    return [transform[0] * x + transform[2] * y + transform[4], transform[1] * x + transform[3] * y + transform[5]];
  });
  if (!points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= 32 && x <= document.width - 32 && y >= 32 && y <= document.height - 32)) issue('Fast mask setup stroke does not fit inside its real document');
  const css = ([x, y]) => ({ x: box.x + box.width / 2 + (x - document.width / 2) * zoom, y: box.y + box.height / 2 + (y - document.height / 2) * zoom });
  const start = monotonic(); await page.mouse.move(css(points[0]).x, css(points[0]).y); await page.mouse.down();
  try {
    for (let index = 1; index < points.length; index++) { await intervalWait(Math.max(0, start + index * 1000 / 60 - monotonic()), signal); await page.mouse.move(css(points[index]).x, css(points[index]).y); }
    await intervalWait(Math.max(0, start + 119 * 1000 / 60 - monotonic()), signal); await page.mouse.up();
  } catch (error) { await page.mouse.up().catch(() => {}); throw error; }
  const inputEndMs = monotonic();
  await page.getByText('Unapplied mask draft', { exact: true }).waitFor({ state: 'visible' });
  const preparedReceipt = await acceptedCommand(page, 'PrepareMask', () => click(page, 'Preview mask'), signal);
  await page.getByRole('img', { name: 'Prepared full document with layer mask', exact: true }).waitFor({ state: 'visible' });
  const receipt = await acceptedCommand(page, 'SetLayerProperties', () => click(page, 'Apply layer mask'), signal);
  const after = await readDocument(page, fixture), maskId = after.image.layers[0]?.mask?.assetId;
  const asset = await readAsset(page, maskId), manifest = await publicRead(page, '/api/v1/assets/' + maskId + '/raster');
  return { ...verifyFastSetupMask({ ...after, source, asset, manifest }), preparedReceipt, receipt: await bindReceipt(page, receipt, after.document), targetHz: 60, elapsedInputMs: inputEndMs - start, inputBoundary: 'untimed setup events; not a scored brush sample' };
}

async function verifyAdapter(page, fixture) {
  const library = fixture.adapterLibrary ?? fixture.adapters?.library ?? fixture.adapters;
  const item = library?.eligibleEntries?.find(entry => opaque(entry.versionId) && HASH.test(entry.weights?.hash ?? ''));
  if (!item) issue('WF09 requires prepareAdapterLibrary in the owned root before server startup');
  const actual = await publicRead(page, '/api/v1/adapters/' + item.versionId);
  if (actual.versionId !== item.versionId || actual.available !== true || actual.locallyEligible !== true || actual.weights?.hash !== item.weights.hash) issue('WF09 exact immutable adapter is not actually available and locally eligible');
  return { versionId: actual.versionId, weightsHash: actual.weights.hash, available: true, locallyEligible: true, preparation: 'production writer before server startup; public readonly eligibility witness' };
}

export async function prepareFastBrowserFixture({ page, cell, fixture, signal }) {
  const requirements = fastSetupRequirements(cell);
  if (!requirements) return { status: 'PASS', kind: 'fast-browser-preparation-1', preparationOnly: true, required: false, phases: [], observations: {} };
  signal?.throwIfAborted();
  const phases = [], observations = { ...requirements, sealScope: 'original starting fixture; this public preparation is separate and must precede the scoring/reset baseline' };
  const timed = async (name, work) => { signal?.throwIfAborted(); const phase = { name, startMs: monotonic(), outcome: 'running' }; phases.push(phase); try { const result = await work(); phase.outcome = 'completed'; return result; } catch (error) { phase.outcome = 'failed'; throw error; } finally { phase.endMs = monotonic(); phase.durationMs = phase.endMs - phase.startMs; } };
  try {
    const before = await readDocument(page, fixture); observations.before = documentIdentity(before.document);
    if (requirements.source && before.image.layers.length !== 0) issue('Fast source setup requires the unchanged empty owned WF starting document');
    if (requirements.source) observations.source = await timed('fixture.fast-source-public-import', () => prepareSource(page, fixture, signal));
    if (requirements.mask) observations.mask = await timed('fixture.fast-mask-public-brush-and-apply', () => prepareMask(page, fixture, observations.source, signal));
    if (requirements.adapter) observations.adapter = await timed('fixture.fast-adapter-public-eligibility', () => verifyAdapter(page, fixture));
    // The standard baseline requires no selected layer or unapplied draft.
    // Reopening through the picker keeps the same page and warm module caches.
    await timed('fixture.fast-prepared-document-reopen', () => openDocument(page, fixture));
    await click(page, 'Pan');
    const after = await readDocument(page, fixture); observations.after = documentIdentity(after.document);
    if (!requirements.source) assert.deepEqual(observations.after, observations.before, 'Readonly adapter preparation changed the document');
    if (requirements.source) {
      assert.equal(after.image.layers.length, 1); assert.equal(after.image.layers[0].id, observations.source.layerId); assert.equal(after.image.layers[0].assetId, observations.source.assetId);
      assert.equal(after.document.revision, (observations.mask ?? observations.source).receipt.documentRevision, 'Reopen changed the prepared document');
      assert.equal(after.image.layers[0].mask?.assetId ?? null, observations.mask?.assetId ?? null, 'Reopen changed the prepared mask');
    }
    return { status: 'PASS', kind: 'fast-browser-preparation-1', preparationOnly: true, required: true, phases, observations };
  } catch (error) {
    if (error instanceof PrerequisiteError) error.evidence = { kind: 'fast-browser-preparation-1', preparationOnly: true, phases, observations };
    throw error;
  }
}
