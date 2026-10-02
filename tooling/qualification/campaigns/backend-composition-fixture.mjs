// WJ preparation is deliberately separate from measured cells. Every native
// source below is rendered and accepted through the production text protocol.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { auth, createProductFixture, createDocument, encode, envelope, hash, product, stageBlob } from './backend-common.mjs';
import { openNativeRenderer } from './fixture-native.mjs';

const MiB = 1048576;
const caseIds = Object.freeze(Array.from({ length: 30 }, (_, index) => 'WJ' + String(index + 1).padStart(2, '0')));
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const abort = ctx => ctx.signal?.throwIfAborted();

export function planCompositionFixture({ definition, corpus }) {
  assert.equal(typeof definition === 'string' ? definition : definition?.id, 'WJ');
  assert(Array.isArray(corpus?.files), 'WJ sealed corpus is required');
  const fonts = corpus.files.filter(file => file.role === 'font');
  const manifests = corpus.files.filter(file => file.role === 'font-manifest');
  assert.equal(fonts.length, 1, 'WJ native boundary preparation requires one sealed face');
  assert.equal(manifests.length, 1, 'WJ native font manifest is required');
  for (const file of [...fonts, ...manifests]) {
    assert.equal(typeof file.path, 'string'); assert.match(file.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.match(String(file.byteLength), /^[1-9][0-9]*$/);
  }
  assert.equal(fonts[0].faceIndex, 0); assert.equal(typeof fonts[0].licensePath, 'string');
  assert.match(fonts[0].licenseHash, /^sha256:[a-f0-9]{64}$/);
  for (const id of caseIds) assert.equal(corpus.files.filter(file => file.id === id).length, 1, 'Missing or duplicate sealed ' + id);
  return { definition: { id: 'WJ' }, fonts, manifest: manifests[0], corpus,
    frame: { width: 360, height: 180 }, document: { width: 512, height: 512 },
    textBytes: MiB, textLayers: 75, preparationOnly: true,
    qualification: 'WJ native admission and stale-binding fixture; not the full WXs layer/history/font workload' };
}

async function verified(file, ctx) {
  abort(ctx); const bytes = await readFile(file.path);
  assert.equal(hash(bytes), file.sha256, 'Sealed WJ input changed');
  assert.equal(String(bytes.length), String(file.byteLength), 'Sealed WJ length changed'); return bytes;
}

async function executeAt(ctx, documentId, body, method, scoped = false) {
  abort(ctx);
  const { EMPTY_EXPECTED_VERSIONS } = await product(ctx, 'src/protocol/store.js');
  const request = envelope(body, { clientId: ctx.clientId, sessionId: ctx.sessionId,
    documentId: scoped ? documentId : null, expectedDocumentRevision: scoped && body.type !== 'NewDocument' ? await ctx.writer.documentRevision(documentId) : null,
    expectedEntityVersions: EMPTY_EXPECTED_VERSIONS });
  const writer = ctx.writer, started = performance.now();
  let receipt = method === 'submit' ? await writer.submit(encode(request), writer.epoch) : await writer[method](encode(request), ctx.auth());
  while (!receipt) {
    abort(ctx); assert(performance.now() - started < 120000, body.type + ' did not settle');
    const state = await writer.commandState(request.command.commandId);
    receipt = state.record?.receipt;
    if (!receipt) {
      assert.notEqual(state.pending?.phase, 'waiting-for-resources', body.type + ' lacks product capacity');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  if (receipt.status !== 'accepted') {
    const details = receipt.details ? Buffer.from(await writer.readMetadata(receipt.details)).toString('utf8') : '';
    throw Error(body.type + ' rejected: ' + JSON.stringify(receipt) + ' ' + details);
  }
  const events = (await writer.events(String(BigInt(receipt.fromSeq) - 1n))).events.filter(event => event.commandId === request.command.commandId);
  return { receipt, events, commandId: request.command.commandId };
}

async function withLayerValues(ctx, state, admissionId, consume) {
  assert.equal(typeof admissionId, 'string'); const priorWriter = ctx.writer;
  let failed = false, failure;
  try {
    await ctx.withClosedWriter(async ({ root }) => {
      const [{ acquireRoot }, { StoreDatabase }, storage] = await Promise.all([product(ctx, 'server/storage/ownership.js'), product(ctx, 'server/storage/database.js'), product(ctx, 'server/storage/composition.js')]);
      const owner = await acquireRoot(root); let store;
      try {
        store = new StoreDatabase(root, () => {});
        assert.deepEqual(store.histories.state(ctx.documentId), state, 'Exclusive native fixture read preserves the selected document state');
        storage.withLayerValues(state, ref => store.objects.verify(ref, true), id => store.assets.asset(id), store.rasters.compositionMemory, consume);
      } finally {
        try { if (store) { await store.candidates.close(); await store.queue.close(); await store.portables.close(); await store.histories.close(); await store.rasters.close(); await store.assets.close(); await store.recovery.settle(); store.close(); } }
        finally { owner.close(); }
      }
    });
  } catch (error) { failed = true; failure = error; }
  // The live renderer realm remains booked across this preparation-only
  // restart. Renew that same admission's epoch; never release or replace it.
  try { if (ctx.writer !== priorWriter) await ctx.writer.textAdmission(admissionId, ctx.auth()); }
  catch (error) { if (failed) throw new AggregateError([failure, error], 'Native fixture read and admission renewal failed'); throw error; }
  if (failed) throw failure;
}

async function verifyClosure(ctx, documentId, refs) {
  const hashes = new Set(), unique = new Map(); let cursor = '';
  do { const page = await ctx.writer.historyClosure(documentId, cursor); for (const ref of page.items) hashes.add(ref.hash); cursor = page.next; } while (cursor);
  for (const ref of refs) { if (unique.has(ref.hash)) assert.equal(unique.get(ref.hash).byteLength, ref.byteLength); else unique.set(ref.hash, ref); }
  for (const ref of unique.values()) {
    assert(hashes.has(ref.hash), 'Accepted native dependency is absent from history closure: ' + ref.hash);
    // Native pixel/layout/font objects exceed the metadata API's 64KiB cap.
    // Read their immutable content in bounded chunks without widening that API.
    assert.match(ref.hash, /^sha256:[a-f0-9]{64}$/); const digest = createHash('sha256'); let bytes = 0;
    const path = join(ctx.root, 'objects', 'sha256', ref.hash.slice(7, 9), ref.hash.slice(7));
    for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) { abort(ctx); bytes += chunk.length; digest.update(chunk); }
    assert.equal('sha256:' + digest.digest('hex'), ref.hash); assert.equal(String(bytes), ref.byteLength);
  }
  return { dependencyHashes: [...unique.keys()], retainedClosureObjects: hashes.size };
}

/** Context uses the fixture-product writer/execute/stage/UI capabilities. It
 * requires an initially empty document and owns no writer while its caller does.
 */
export async function buildCompositionFixture(ctx, plan) {
  assert.equal(plan.definition.id, 'WJ'); assert.equal(typeof ctx.withClosedWriter, 'function');
  assert.equal(typeof ctx.clientId, 'string'); assert.equal(typeof ctx.sessionId, 'string');
  const before = await ctx.writer.imageState(ctx.documentId);
  assert.equal(before.layers.length, 0, 'WJ native fixture starts with its own empty document');
  assert.equal(before.width, plan.document.width); assert.equal(before.height, plan.document.height);
  const { makeCompositionFixture } = await import('./backend-composition.mjs');
  const specimens = {};
  for (const id of caseIds) {
    const file = plan.corpus.files.find(file => file.id === id), bytes = await verified(file, ctx), exact = makeCompositionFixture(id);
    assert.equal(hash(bytes), exact.sha256, 'WJ corpus identity changed');
    if (['WJ26', 'WJ29', 'WJ30'].includes(id)) specimens[id] = JSON.parse(bytes.toString('utf8'));
  }
  const mainTexts = specimens.WJ30.texts;
  assert.equal(mainTexts.length, 75); assert.equal(mainTexts.reduce((n, text) => n + Buffer.byteLength(text), 0), MiB);
  await verified(plan.manifest, ctx);
  const fonts = [], fontAssetIds = [];
  for (const file of plan.fonts) {
    const bytes = await verified(file, ctx), licenseBytes = await readFile(file.licensePath);
    assert.equal(hash(licenseBytes), file.licenseHash, 'Sealed font license changed');
    const source = await ctx.stage(bytes, 'font', 'application/octet-stream'), license = await ctx.stage(licenseBytes, 'caption', 'text/plain');
    const imported = ctx.registered(await ctx.execute({ type: 'ImportFont', source: source.blob, license: license.blob, origin: 'local-file', embeddingReviewed: true }, 'historyCommand', true));
    assert.equal(imported.font?.bytes.hash, file.sha256); assert.equal(imported.font.licenseRecord.hash, file.licenseHash);
    fonts.push(imported.font); fontAssetIds.push(imported.id);
  }
  const profile = JSON.parse(await readFile(resolve(ctx.repo, 'src/text/profile.json'), 'utf8'));
  const { dependencies } = await product(ctx, 'server/text/validation.js');
  const style = { primaryFont: fonts[0].bytes.hash, explicitFallbacks: [], sizePx: 32, lineHeightMultiplier: 1.2, fill: [40, 90, 190, 255], align: 'start', direction: 'auto' };
  const rootRefs = [], auxiliaryRefs = [], facts = [], commands = [];
  const auxiliaryDocumentId = 'wj_boundary_' + randomUUID();
  await executeAt(ctx, auxiliaryDocumentId, { type: 'NewDocument', ...plan.document, color: 'sRGB', depth: 8 }, 'submit', true);
  const renderer = await openNativeRenderer(ctx, plan, ctx.signal);
  let oldLayer, editedLayer, compositionRef, witness, currentAdmissionId;
  async function prepare(documentId, layerId, text, edit = null, hidden = false) {
    abort(ctx); const revision = await ctx.writer.documentRevision(documentId), draftId = 'wj_draft_' + randomUUID(), generation = '1', placement = { x: 20, y: 20 };
    const textAsset = await ctx.stage(Buffer.from(text), 'caption', 'text/plain');
    const draft = { schemaVersion: edit ? 1 : 2, kind: edit ? 'text-draft-1' : 'text-draft-2', textUtf8: textAsset.blob, fonts, style, frame: plan.frame, ...(!edit ? { placement } : {}) };
    const draftAsset = await ctx.stage(Buffer.from(canonical(draft)), 'caption', 'text/plain');
    await ctx.ui({ type: 'SaveDraft', draft: { id: draftId, generation, kind: 'text', documentId, targetLayerId: edit ? layerId : null, expectedDocumentRevision: revision, assetId: draftAsset.id, composing: false } });
    const prepared = await renderer.prepare({ text, fonts, style, token: { documentId, documentRevision: revision, layerId, layerVersion: edit?.version ?? '0', sessionId: ctx.sessionId, generation: 1 } });
    currentAdmissionId = prepared.admissionId;
    const candidate = JSON.parse(Buffer.from(await ctx.writer.readMetadata(prepared.candidate)).toString('utf8'));
    assert.equal(candidate.source.text.textUtf8.hash, hash(Buffer.from(text))); assert.equal(candidate.source.render.rendererProfile.id, profile.id);
    const command = await executeAt(ctx, documentId, { type: edit ? 'CommitTextEdit' : 'CreateTextLayer', layerId,
      ...(edit ? { layerVersion: edit.version, reviewedDependencyHash: prepared.dependencyHash } : { name: 'WJ native ' + layerId, placement }),
      candidate: prepared.candidate, draft: { sessionId: ctx.sessionId, draftId, generation }, admissionId: prepared.admissionId }, 'historyCommand', true);
    commands.push({ type: edit ? 'CommitTextEdit' : 'CreateTextLayer', documentId, layerId, commandId: command.commandId, receipt: command.receipt });
    // Applied checkpoints still occupy UI draft slots. Release each exact
    // generation after acceptance; history alone must retain the source closure.
    await ctx.ui({ type: 'ClearDraft', draftId, generation });
    if (hidden && !edit) await executeAt(ctx, documentId, { type: 'SetLayerProperties', layerId, layerVersion: '1', properties: { visible: false }, draft: null }, 'historyCommand', true);
    const state = await ctx.writer.imageState(documentId), layer = state.layers.find(layer => layer.id === layerId);
    assert.equal(layer?.kind, 'text'); const source = JSON.parse(Buffer.from(await ctx.writer.readMetadata(layer.source)).toString('utf8'));
    assert.equal(canonical(source), canonical(candidate.source));
    const refs = [layer.source, ...dependencies(source)]; (documentId === ctx.documentId ? rootRefs : auxiliaryRefs).push(...refs);
    const fact = { documentId, layerId, version: layer.version, sourceHash: layer.source.hash, textHash: source.text.textUtf8.hash, textBytes: Number(source.text.textUtf8.byteLength), layoutHash: source.render.layout.hash, pixelHash: source.render.pixels.hash, rendererHash: source.render.rendererProfile.id };
    return { layer, fact, command };
  }
  try {
    for (const [index, text] of mainTexts.entries()) {
      const actualText = index === 0 ? 'b' + text.slice(1) : text;
      const prepared = await prepare(ctx.documentId, 'wj_text_' + String(index).padStart(3, '0'), actualText, null, index !== 0);
      facts.push(prepared.fact); if (index === 0) oldLayer = prepared.layer;
      await ctx.onProgress?.({ phase: 'wj-native-layout-and-durable-admission', workload: 'WJ', completed: index + 1, total: 79 });
    }
    await prepare(auxiliaryDocumentId, 'wj_boundary_one_byte', 'a');
    await prepare(auxiliaryDocumentId, 'wj_boundary_frame_bytes', specimens.WJ29.texts[0], null, true);
    await prepare(auxiliaryDocumentId, 'wj_boundary_lines', specimens.WJ29.texts[1], null, true);
    const core = await product(ctx, 'src/composition/core.js'), state = await ctx.writer.imageState(ctx.documentId);
    const graph = core.emptyComposition(state.width, state.height, randomUUID());
    graph.scene = 'Native text edited before a late partial provider response';
    await withLayerValues(ctx, state, currentAdmissionId, values => {
      const value = values.find(layer => layer.id === oldLayer.id); assert.equal(value.text, 'b' + mainTexts[0].slice(1));
      graph.elements = [{ ...core.emptyElement('text', 'wj_retained_text_binding'), text: core.linkField('text-content', value) }];
    });
    const bindings = { [oldLayer.id]: oldLayer.id }, graphAsset = await ctx.stage(Buffer.from(canonical(graph)), 'text', 'application/octet-stream');
    compositionRef = { id: graph.id, value: { ...graphAsset.blob, mediaType: 'application/json' }, bindings };
    await ctx.execute({ type: 'CommitCompositionVersion', composition: compositionRef, draft: null }, 'historyCommand', true); rootRefs.push(compositionRef.value);
    const edited = await prepare(ctx.documentId, oldLayer.id, mainTexts[0], oldLayer); editedLayer = edited.layer; facts[0] = edited.fact;
    const after = await ctx.writer.imageState(ctx.documentId);
    assert.deepEqual(after.composition, compositionRef);
    await withLayerValues(ctx, after, currentAdmissionId, actualValues => {
      assert.equal(core.fieldStatus(graph.elements[0].text, actualValues, bindings), 'stale');
      assert.throws(() => core.serialize(graph, actualValues, bindings), error => error.issues?.some(issue => issue.code === 'STALE_LINK'));
    });
    assert(BigInt(editedLayer.version) > BigInt(oldLayer.version)); assert.notEqual(editedLayer.source.hash, oldLayer.source.hash);
    witness = { documentId: ctx.documentId, layerId: oldLayer.id, compositionId: graph.id, binding: graph.elements[0].text,
      previousVersion: oldLayer.version, previousSource: oldLayer.source, currentVersion: editedLayer.version, currentSource: editedLayer.source,
      editCommandId: edited.command.commandId, editReceipt: edited.command.receipt, status: 'stale' };
    await ctx.onProgress?.({ phase: 'wj-native-layout-and-durable-admission', workload: 'WJ', completed: 79, total: 79 });
  } finally { await renderer.close(); }

  const rootState = await ctx.writer.imageState(ctx.documentId), auxiliaryState = await ctx.writer.imageState(auxiliaryDocumentId);
  const oneByte = auxiliaryState.layers.find(layer => layer.id === 'wj_boundary_one_byte');
  const cases = {
    WJ26: { state: { ...structuredClone(rootState), layers: [...structuredClone(rootState.layers), structuredClone(oneByte)] }, expectedCode: 'TEXT_DOCUMENT_LIMIT', textBytes: MiB + 1,
      qualification: 'Prospective 76-layer total uses accepted 75-layer 1MiB base plus accepted one-byte auxiliary source; oversized document is never committed' },
    WJ29: { state: { ...structuredClone(auxiliaryState), layers: structuredClone(auxiliaryState.layers.filter(layer => layer.id !== oneByte.id)) }, expectedCode: null, textBytes: 16384 + 255 },
    WJ30: { state: structuredClone(rootState), expectedCode: null, textBytes: MiB },
  };
  const verifiedSources = await ctx.withClosedWriter(async ({ root }) => {
    const { acquireRoot } = await product(ctx, 'server/storage/ownership.js'), { StoreDatabase } = await product(ctx, 'server/storage/database.js');
    const owner = await acquireRoot(root); let store;
    try {
      store = new StoreDatabase(root, () => {}); const evidence = {};
      for (const [id, value] of Object.entries(cases)) {
        let rejection = null; try { store.texts.limits(value.state); } catch (error) { if (error.reason !== 'TEXT_DOCUMENT_LIMIT') throw error; rejection = error.reason; }
        assert.equal(rejection, value.expectedCode, id + ' actual document admission');
        let bytes = 0; const sourceHashes = [];
        for (const layer of value.state.layers) {
          assert.equal(layer.kind, 'text'); const source = store.texts.source(layer.source), text = store.objects.verify(source.text.textUtf8, true);
          assert.equal(hash(text), source.text.textUtf8.hash); assert.equal(String(text.length), source.text.textUtf8.byteLength);
          bytes += text.length; sourceHashes.push(layer.source.hash);
        }
        assert.equal(bytes, value.textBytes); value.sourceHashes = sourceHashes;
        evidence[id] = { expectedCode: rejection, textBytes: bytes, layers: value.state.layers.length, sourceHashes };
      }
      return evidence;
    } finally {
      try { if (store) { await store.candidates.close(); await store.queue.close(); await store.portables.close(); await store.histories.close(); await store.rasters.close(); await store.assets.close(); await store.recovery.settle(); store.close(); } }
      finally { owner.close(); }
    }
  });
  assert.deepEqual(await ctx.writer.imageState(ctx.documentId), rootState, 'WJ native state survives writer restart');
  assert.deepEqual(await ctx.writer.imageState(auxiliaryDocumentId), auxiliaryState, 'WJ auxiliary states survive writer restart');
  const closure = { root: await verifyClosure(ctx, ctx.documentId, rootRefs), auxiliary: await verifyClosure(ctx, auxiliaryDocumentId, auxiliaryRefs) };
  return { layerIds: rootState.layers.map(layer => layer.id), textFacts: facts, fontAssetIds, fonts, renderer: renderer.identity,
    rendererHash: profile.id, fontManifestHash: plan.manifest.sha256, allTextLayersLaidOut: true,
    nativeAdmissionCases: cases, nativeTextAdvanceWitness: witness, auxiliaryDocumentId, closure, commands, verifiedSources,
    observed: { productionValidated: true, caseCount: 30, width: rootState.width, height: rootState.height, layers: 75, textLayers: 75, textBytes: MiB,
      allTextLayersLaidOut: true, rendererHash: profile.id, fontManifestHash: plan.manifest.sha256, nativeTextAdvancedBeforeLateProvenance: true,
      nativeSourcesSurvivedRestart: true, sourceClosureVerified: true }, qualification: plan.qualification };
}

export async function compositionFixture(options) {
  const plan = planCompositionFixture(options), repo = resolve(options.repo ?? process.cwd());
  const fixture = await createProductFixture({ repo, output: options.output, signal: options.signal });
  const ctx = { repo, root: fixture.root, documentId: fixture.documentId, clientId: 'client_1', sessionId: 'wj_preparation',
    get writer() { return fixture.writer; }, auth, signal: options.signal, onProgress: options.onProgress, corpus: options.corpus,
    stage: (bytes, purpose, mediaType) => stageBlob(fixture, bytes, purpose, mediaType),
    registered(result) { const asset = result.events.find(event => event.type === 'AssetRegistered')?.payload.asset; assert(asset); return asset; },
    execute(body, method, scoped = false) { return executeAt(ctx, ctx.documentId, body, method, scoped); },
    async ui(body) {
      const state = await fixture.writer.uiRead(ctx.sessionId, auth());
      const receipt = await fixture.writer.uiPersist(encode({ protocolVersion: 1, requestId: randomUUID(), sessionId: ctx.sessionId, expectedUISeq: state.uiSeq, body }), auth());
      assert.equal(receipt.status, 'accepted', JSON.stringify(receipt)); return receipt;
    },
    async withClosedWriter(operation) {
      await fixture.closeWriter();
      try { return await operation({ root: fixture.root, repo, documentId: fixture.documentId, signal: options.signal }); }
      finally { await fixture.reopen(); }
    },
  };
  try {
    await createDocument(fixture, plan.document); const built = await buildCompositionFixture(ctx, plan);
    return { ...built, status: 'complete', root: fixture.root, documentId: fixture.documentId, preparationOnly: true, workload: 'WJ' };
  } finally { await fixture.close(); }
}
