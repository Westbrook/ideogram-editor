import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {createContext, runInContext} from 'node:vm';
import {collectCurrentDocumentFonts, inspectCurrentDocumentFonts} from '../../tooling/qualification/campaigns/browser-text-fonts.mjs';

// Synthetic protocol/DOM fixtures execute the real installed page evaluator.
// They do not parse real fonts, launch a browser, or establish qualification.
const hash = v => 'sha256:' + createHash('sha256').update(v).digest('hex');
const canonical = v => {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v);
  if (typeof v === 'string') return '"' + [...v].map(ch => ch.codePointAt(0) < 32 ? '\\u' + ch.codePointAt(0).toString(16).padStart(4, '0') : ch === '"' || ch === '\\' ? '\\' + ch : ch).join('') + '"';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => canonical(k) + ':' + canonical(v[k])).join(',') + '}';
};
const identified = value => ({...value, id: hash(canonical(value))});
const ref = (bytes, mediaType = 'application/json') => ({hash: hash(bytes), byteLength: String(Buffer.byteLength(bytes)), mediaType});
const binding = () => ({kind: 'ordinary-text-binding-1', nonce: 'test-attempt-1', cellId: 'I10H/text-apply-WXn', cache: 'cold', ordinal: 1});
const font = (bytes, license = 'synthetic permitted license') => identified({schemaVersion: 1, bytes: ref(bytes, 'application/octet-stream'), faceIndex: 0, format: 'static-ttf', parserProfile: 'sfnt-static-1-freetype-canvaskit040', fsType: 0, licenseRecord: ref(license, 'text/plain'), origin: 'local-file', embedding: 'permitted'});

function fixture({fontCount = 2, layerCount = 3} = {}) {
  const binaries = Array.from({length: fontCount}, (_, i) => Buffer.alloc(32 + i * 32, i + 1));
  const fonts = binaries.map(b => font(b)), bodies = new Map(), sources = new Map();
  const renderer = {schemaVersion: 1, id: hash('renderer-profile'), manifest: ref('synthetic renderer manifest')};
  const layers = Array.from({length: layerCount}, (_, i) => {
    const associated = i === 0 ? fonts.slice(0, 1) : fonts;
    const text = identified({schemaVersion: 1, textUtf8: ref('private text must not leave collector', 'text/plain'), style: {primaryFont: associated[0]?.bytes.hash, explicitFallbacks: associated.slice(1).map(f => f.bytes.hash), sizePx: 32, lineHeightMultiplier: 1.2, fill: [1, 2, 3, 255], align: 'start', direction: 'auto'}, frame: {width: 64, height: 64}, layoutPolicy: 'text-layout-1', fonts: associated});
    const render = identified({schemaVersion: 1, textVersion: text.id, rendererProfile: renderer, dependencyHash: hash('dependency-' + i), layout: ref('layout'), pixels: ref(Buffer.alloc(64 * 64 * 4), 'application/x-ideogram-rgba8'), width: 64, height: 64, overflow: false, resolvedFonts: associated.map(f => f.id)});
    const source = {schemaVersion: 1, text, render}, id = 'text_' + i;
    sources.set(id, source);
    return {id, version: '2', kind: 'text', name: 'private layer name\n' + i, assetId: 'pixels_' + i, layerToDocument: [1, 0, 0, 1, 0, 0], opacity: 1, visible: i === 0, locked: false, blend: 'normal', mask: null, source: ref(canonical(source))};
  });
  const image = {schemaVersion: 1, width: 64, height: 64, layers};
  const doc = {id: 'document_1', revision: '7', branchId: 'branch_1', width: 64, height: 64, color: 'sRGB', depth: 8, orderedLayerIds: layers.map(l => l.id), historyHead: 'history_7', checkpoint: null, compositionVersion: null, image: {state: ref(canonical(image)), semanticDigest: hash('semantic'), compositeAssetId: 'composite_7'}};
  const assets = new Map(fonts.map((f, i) => ['font_' + i, {id: 'font_' + i, version: '1', purpose: 'font', blob: f.bytes, dependencies: [f.licenseRecord], safety: 'safe', availability: 'available', qualification: 'font', measuredMediaType: 'application/octet-stream', font: f}]));
  for (const [i, bytes] of binaries.entries()) bodies.set('/api/v1/assets/font_' + i + '/content', bytes);
  return {doc, image, sources, assets, bodies, fonts, binaries};
}

function harness(data = fixture(), changes = {}) {
  const calls = [], stats = {documentReads: 0, editorReads: 0, active: 0, maximumActive: 0, byteReads: 0};
  let now = 10;
  const response = (body, headers = {}) => new Response(body, {status: 200, headers: {'content-length': String(Buffer.byteLength(body)), ...headers}});
  const json = value => response(Buffer.from(JSON.stringify(value)), {'content-type': 'application/json'});
  const context = createContext({TextEncoder, TextDecoder, Uint8Array, AbortController, setTimeout, clearTimeout, crypto: webcrypto, performance: {timeOrigin: 1700000000000, now: () => ++now},
    document: {querySelector(selector) {if (selector === '#native-text-content') return {value: changes.nativeValue ?? 'private text must not leave collector'}; assert.equal(selector, '#native-text-editor'); stats.editorReads++; return changes.editor?.(stats) ?? {hidden: true, getAttribute(name) {assert.equal(name, 'data-session'); return '';}};}},
    fetch: async (path, options) => {
      calls.push(path); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error'); assert.equal(options.headers['X-App-Client'], 'LP-1'); assert.equal(options.method, undefined);
      changes.onFetch?.(path, options, stats);
      if (changes.hang) return new Promise((_, reject) => {const stop = () => reject(Error('aborted')); if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, {once: true});});
      const custom = changes.response?.(path, stats); if (custom) return custom;
      if (path === '/api/v1/documents/document_1') {stats.documentReads++; const doc = structuredClone(data.doc); changes.document?.(doc, stats); return json({protocolVersion: 1, entityVersion: doc.revision, projectionSchema: 15, highWater: '20', projection: {kind: 'inline', value: doc}});}
      if (path === '/api/v1/documents/document_1/image') return json(data.image);
      const text = /^\/api\/v1\/documents\/document_1\/text\?layerId=(text_\d+)&revision=7$/.exec(path);
      if (text) return json({documentRevision: '7', layerVersion: '2', source: data.sources.get(text[1])});
      const asset = /^\/api\/v1\/assets\/(font_\d+)$/.exec(path);
      if (asset) {const value = data.assets.get(asset[1]); return json({protocolVersion: 1, entityVersion: value.version, projectionSchema: 2, highWater: '20', projection: {kind: 'inline', value}});}
      const bytes = data.bodies.get(path);
      if (bytes) {
        stats.byteReads++; stats.active++; stats.maximumActive = Math.max(stats.maximumActive, stats.active); let sent = false, released = false;
        const done = () => {if (!released) {released = true; stats.active--;}};
        const stream = new ReadableStream({pull(controller) {if (!sent) {sent = true; controller.enqueue(new Uint8Array(bytes));} else {done(); controller.close();}}, cancel: done});
        return new Response(stream, {headers: {'content-length': String(bytes.length)}});
      }
      throw Error('Unexpected synthetic URL');
    }});
  const page = {async evaluate(fn, args) {context.__args = args; const value = await runInContext('(' + fn.toString() + ')(__args)', context); return value === undefined ? undefined : JSON.parse(JSON.stringify(value));}};
  const collect = (args = {}) => collectCurrentDocumentFonts({page, documentId: data.doc.id, fontAssetIds: [...data.assets.keys()], binding: binding(), ...args});
  return {data, page, collect, calls, stats, context};
}
const values = output => Object.fromEntries(output.measurements.map(r => [r.name, r.value]));
const unavailable = (raw, expected = binding()) => {const result = inspectCurrentDocumentFonts(raw, expected); assert.deepEqual(result.measurements, []); assert(result.missing.length > 0); return result;};

test('full current root includes hidden source fonts; repeated files are read and counted once', async () => {
  const h = harness(), raw = await h.collect(), output = inspectCurrentDocumentFonts(raw, binding());
  assert.deepEqual(raw.missing, []); assert.deepEqual(output.missing, []);
  assert.deepEqual(values(output), {R35CurrentFontFaces: 2, R35SingleFontBytes: 64, R35CurrentFontSetBytes: 96});
  assert.equal(raw.layers.length, 3); assert.equal(raw.layers[0].fontIds.length, 1); assert.equal(raw.layers[1].fontIds.length, 2);
  assert.equal(h.stats.byteReads, 2); assert.equal(h.stats.maximumActive, 1); assert.equal(h.stats.active, 0);
  assert.equal(h.context.__IDEOGRAM_CURRENT_FONT_READS__, undefined);
  assert.equal(h.calls.filter(p => p.includes('/text?')).length, 3);
  assert(!JSON.stringify(raw).includes('private layer name')); assert(!JSON.stringify(raw).includes('private text'));
  assert.deepEqual(output.measurements.map(r => r.unit), ['count', 'bytes', 'bytes']);
  assert(!output.measurements.some(r => /R07|Cpu|Gpu|peak/i.test(r.name)));
});

test('accepted root with no associated text has measured zero, without fetching unused font bytes', async () => {
  const h = harness(fixture({layerCount: 0})), raw = await h.collect();
  assert.deepEqual(values(inspectCurrentDocumentFonts(raw, binding())), {R35CurrentFontFaces: 0, R35SingleFontBytes: 0, R35CurrentFontSetBytes: 0});
  assert.equal(h.stats.byteReads, 0);
});

test('all 100 current layers and all 16 current faces fit the declared collection bounds', async () => {
  const h = harness(fixture({layerCount: 100, fontCount: 16})), raw = await h.collect();
  assert.deepEqual(raw.missing, []); assert.deepEqual(inspectCurrentDocumentFonts(raw, binding()).missing, []);
  assert.equal(raw.layers.length, 100); assert.equal(raw.fonts.length, 16); assert.equal(h.stats.byteReads, 16); assert.equal(h.stats.maximumActive, 1);
});

test('a 101-layer root is unavailable before source or font allocation', async () => {
  const h = harness(fixture({layerCount: 101})), raw = await h.collect(); unavailable(raw);
  assert.equal(h.stats.byteReads, 0); assert.equal(h.calls.length, 1);
});

test('visible draft can be observed but cannot supply metrics without independently admitted lineage', async () => {
  const h = harness(undefined, {editor: () => ({hidden: false, getAttribute: () => 'draft_1'})}), raw = await h.collect();
  unavailable(raw); assert.deepEqual(raw.missing, []); assert.equal(h.stats.byteReads, 2);
});

test('draft opening during the read and document revision drift both refuse measurements', async () => {
  for (const changes of [{editor: stats => ({hidden: stats.editorReads === 1, getAttribute: () => stats.editorReads === 1 ? '' : 'draft_new'})}, {document: (doc, stats) => {if (stats.documentReads === 2) doc.revision = '8';}}]) {
    const h = harness(undefined, changes), raw = await h.collect(); unavailable(raw); assert.equal(h.context.__IDEOGRAM_CURRENT_FONT_READS__, undefined);
  }
});

function draftLineage(data) {
  const source = data.sources.get('text_0'), token = {documentId: 'document_1', documentRevision: '7', layerId: 'text_0', layerVersion: '2', sessionId: 'session_1', draftId: 'draft_1'};
  const proof = {actionId: 'preview_1', token, generation: 7, sourceHash: source.text.textUtf8.hash, dependencyHash: source.render.dependencyHash, rasterHash: source.render.pixels.hash, fontFaces: source.text.fonts.length, fontBytes: source.text.fonts.reduce((n, f) => n + Number(f.bytes.byteLength), 0), previewId: 'preview_1'};
  const attrs = {'data-session': token.draftId, 'data-text-session-id': token.sessionId, 'data-text-document-id': token.documentId, 'data-text-document-revision': token.documentRevision, 'data-text-layer-id': token.layerId, 'data-text-layer-version': token.layerVersion, 'data-text-generation': '7', 'data-text-saved-generation': '7', 'data-preview-id': proof.previewId, 'data-preview-generation': '7', 'data-preview-layer-version': token.layerVersion, 'data-preview-text-hash': proof.sourceHash, 'data-preview-dependency-hash': proof.dependencyHash, 'data-preview-raster-hash': proof.rasterHash, 'data-preview-width': '64', 'data-preview-height': '64'};
  return {proof, attrs, editor: () => ({hidden: false, getAttribute: name => attrs[name] ?? null})};
}

test('stable actual native value and preview lineage permit exactly the accepted current font cohort', async () => {
  const data = fixture(), lineage = draftLineage(data), h = harness(data, {editor: lineage.editor}), raw = await h.collect();
  assert.deepEqual(raw.missing, []); unavailable(raw);
  const result = inspectCurrentDocumentFonts(raw, binding(), {draftProof: lineage.proof});
  assert.deepEqual(result.missing, []); assert.deepEqual(values(result), {R35CurrentFontFaces: 2, R35SingleFontBytes: 64, R35CurrentFontSetBytes: 96});
  assert.equal(raw.nativeEditorBefore.nativeTextHash, data.sources.get('text_0').text.textUtf8.hash);
  assert(!JSON.stringify(raw).includes('private text'));
  for (const [before, after] of [[null, null], [null, 7], [6, 7]]) {
    raw.nativeEditorBefore.savedGeneration = before; raw.nativeEditorAfter.savedGeneration = after;
    assert.deepEqual(inspectCurrentDocumentFonts(raw, binding(), {draftProof: lineage.proof}).missing, []);
  }
});

test('visible draft cannot add an unassociated font, use stale lineage or bypass actual text hashing', async () => {
  const mutations = [
    (r, p) => {p.token.documentRevision = '8';}, (r, p) => {p.token.layerVersion = '3';},
    (r, p) => {p.token.sessionId = 'other';}, (r, p) => {p.token.draftId = 'other';},
    (r, p) => {p.generation++;}, (r, p) => {p.previewId = 'other';}, (r, p) => {p.actionId = 'other';},
    (r, p) => {p.dependencyHash = hash('substitution');}, (r, p) => {p.fontFaces++;}, (r, p) => {p.fontBytes++;},
    r => {r.nativeEditorAfter.preview.id = 'later_preview';}, r => {r.nativeEditorAfter.generation++;},
    r => {r.nativeEditorBefore.savedGeneration = 7; r.nativeEditorAfter.savedGeneration = 6;},
    r => {r.nativeEditorAfter.savedGeneration = 8;}, r => {r.nativeEditorAfter.savedGeneration = null;},
    r => {r.nativeEditorBefore.nativeTextHash = r.nativeEditorAfter.nativeTextHash = hash('later input');},
    r => {r.layers[0].renderDependencyHash = hash('different current source');},
  ];
  for (const mutate of mutations) {
    const data = fixture(), lineage = draftLineage(data), raw = await harness(data, {editor: lineage.editor}).collect(); mutate(raw, lineage.proof);
    const result = inspectCurrentDocumentFonts(raw, binding(), {draftProof: lineage.proof}); assert.deepEqual(result.measurements, []); assert(result.missing.length > 0);
  }
  const data = fixture(), lineage = draftLineage(data), raw = await harness(data, {editor: lineage.editor, nativeValue: 'unsaved new native text'}).collect();
  assert.deepEqual(inspectCurrentDocumentFonts(raw, binding(), {draftProof: lineage.proof}).measurements, []);
  for (const nativeValue of ['\ud800', 'x'.repeat(16385)]) {const invalid = await harness(data, {editor: lineage.editor, nativeValue}).collect(); unavailable(invalid); assert(invalid.missing.length > 0);}
});

test('actual source hash, actual file hash, and declared transfer length are checked separately', async () => {
  const changedSource = fixture(); changedSource.sources.get('text_1').text.frame.width++;
  const changedFile = fixture(); changedFile.bodies.set('/api/v1/assets/font_1/content', Buffer.alloc(64, 9));
  for (const data of [changedSource, changedFile]) {const raw = await harness(data).collect(); unavailable(raw); assert(raw.missing.length > 0);}
  const h = harness(undefined, {response: path => path.endsWith('/content') ? new Response(Buffer.alloc(64), {headers: {'content-length': '16777217'}}) : null});
  unavailable(await h.collect()); assert.equal(h.context.__IDEOGRAM_CURRENT_FONT_READS__, undefined);
});

test('rejected response headers await body cancellation, including a failing cleanup', {timeout: 5000}, async () => {
  for (const status of [200, 503]) {
    let cancelled = 0, release, started, settled = false;
    const gate = new Promise(resolve => {release = resolve;});
    const cancellation = new Promise(resolve => {started = resolve;});
    const h = harness(undefined, {response: path => path.endsWith('/content') ? new Response(new ReadableStream({cancel() {cancelled++; started(); return gate;}}), {status, headers: {'content-length': '16777217'}}) : null});
    const pending = h.collect().then(raw => {settled = true; return raw;});
    await cancellation;
    assert.equal(cancelled, 1); assert.equal(settled, false); release();
    unavailable(await pending); assert.equal(h.context.__IDEOGRAM_CURRENT_FONT_READS__, undefined);
  }
  let cancellationAttempted = false;
  const h = harness(undefined, {response: path => path.endsWith('/content') ? new Response(new ReadableStream({cancel() {cancellationAttempted = true; throw Error('cleanup failed');}}), {headers: {'content-length': '16777217'}}) : null});
  const raw = await h.collect(); unavailable(raw); assert(cancellationAttempted); assert.deepEqual(raw.missing, ['FONT_OBSERVATION_UNAVAILABLE']);
});

test('fixture asset IDs are locators only and cannot hide a missing current font', async () => {
  const h = harness(), raw = await h.collect({fontAssetIds: ['font_0']});
  assert.deepEqual(raw.missing, ['FONT_CURRENT_ASSET_LOCATOR_MISSING']); unavailable(raw); assert.equal(h.stats.byteReads, 0);
});

test('same bytes under distinct licensed versions count one face and one file', async () => {
  const data = fixture(), second = font(data.binaries[0], 'a second exact license');
  data.fonts[1] = second;
  const secondAsset = data.assets.get('font_1'); secondAsset.font = second; secondAsset.blob = second.bytes; secondAsset.dependencies = [second.licenseRecord];
  data.bodies.set('/api/v1/assets/font_1/content', data.binaries[0]);
  for (const [layerId, source] of data.sources) {
    const {id: oldTextId, ...text} = source.text;
    text.fonts = [layerId === 'text_0' ? data.fonts[0] : second];
    text.style.explicitFallbacks = [];
    source.text = identified(text);
    const {id: oldRenderId, ...render} = source.render;
    source.render = identified({...render, textVersion: source.text.id, resolvedFonts: source.text.fonts.map(f => f.id)});
    data.image.layers.find(l => l.id === layerId).source = ref(canonical(source));
  }
  data.doc.image.state = ref(canonical(data.image));
  const h = harness(data), raw = await h.collect(), result = inspectCurrentDocumentFonts(raw, binding());
  assert.deepEqual(result.missing, []); assert.deepEqual(values(result), {R35CurrentFontFaces: 1, R35SingleFontBytes: 32, R35CurrentFontSetBytes: 32}); assert.equal(h.stats.byteReads, 1);
});

const mutations = [
  ['wrong attempt', r => {r.binding.nonce = 'another-attempt';}],
  ['partial collection', r => {r.missing.push('READ_FAILED');}],
  ['foreign root', r => {r.after.documentId = 'another_document';}],
  ['changed image', r => {r.after.semanticDigest = hash('changed');}],
  ['omitted hidden layer', r => {r.layers.splice(1, 1);}],
  ['reordered layers', r => {r.layers.reverse();}],
  ['unknown source font', r => {r.layers[1].fontIds[0] = hash('absent');}],
  ['unobserved source', r => {r.layers[1].observedSourceHash = hash('wrong');}],
  ['unobserved image', r => {r.before.observedImageBytes++;}],
  ['missing profile', r => {delete r.layers[1].renderer.manifest;}],
  ['unknown profile field', r => {r.layers[1].renderer.raw = 'private';}],
  ['unknown font field', r => {r.fonts[0].raw = 'private';}],
  ['missing license', r => {delete r.fonts[0].licenseRecord;}],
  ['unreviewed permission', r => {r.fonts[0].embedding = 'restricted';}],
  ['changed font identity', r => {r.fonts[0].parserProfile = 'unregistered';}],
  ['unregistered face', r => {r.fonts[0].faceIndex = 1;}],
  ['missing owned bytes', r => {r.files.pop();}],
  ['file mismatch', r => {r.files[0].observedHash = hash('wrong');}],
  ['duplicate file', r => {r.files.push(structuredClone(r.files[0]));}],
  ['duplicate font', r => {r.fonts.push(structuredClone(r.fonts[0]));}],
  ['wrong file association', r => {r.files[0].fontIds.push(r.fonts[1].id);}],
  ['numeric revision', r => {r.before.revision = r.after.revision = 7;}],
  ['negative clock', r => {r.startMs = -1;}],
  ['reversed clock', r => {r.endMs = r.startMs - 1;}],
  ['capture timeout', r => {r.endMs = r.startMs + 60001;}],
  ['unknown retained field', r => {r.authoredText = 'not allowed';}],
  ['open draft', r => {r.nativeEditorAfter.hidden = false;}],
];
for (const [label, mutate] of mutations) test('strict inspection rejects ' + label, async () => {const raw = await harness().collect(); mutate(raw); unavailable(raw);});

test('malformed and oversized envelopes fail closed without throwing or granting zero', async () => {
  for (const raw of [null, [], {}, {kind: 'current-document-fonts-1', binding: {bad: 'x'.repeat(1048577)}}]) unavailable(raw);
  const raw = await harness().collect(); raw.files[0].fontIds = Array(1601).fill(hash('x')); unavailable(raw);
  const cycle = {}; cycle.self = cycle; unavailable(cycle);
});

test('timeout and caller abort release the actual in-page owner', async () => {
  const timed = harness(undefined, {hang: true}), raw = await timed.collect({timeoutMs: 5});
  assert.deepEqual(raw.missing, ['FONT_OBSERVATION_ABORTED']); unavailable(raw); assert.equal(timed.context.__IDEOGRAM_CURRENT_FONT_READS__, undefined);
  const aborter = new AbortController();
  const cancelled = harness(undefined, {hang: true, onFetch: () => aborter.abort(Error('caller cancelled'))});
  await assert.rejects(cancelled.collect({signal: aborter.signal}), /caller cancelled/); assert.equal(cancelled.context.__IDEOGRAM_CURRENT_FONT_READS__, undefined);
});

test('caller abort before owner installation is drained after registration without starting reads', async () => {
  const h = harness(), evaluate = h.page.evaluate; let release, held = false;
  const gate = new Promise(resolve => {release = resolve;});
  h.page.evaluate = async (fn, args) => {if (!held && fn.toString().includes('owners.set')) {held = true; await gate;} return evaluate(fn, args);};
  const aborter = new AbortController(), pending = h.collect({signal: aborter.signal});
  assert(held); aborter.abort(Error('cancelled during registration')); release();
  await assert.rejects(pending, /cancelled during registration/); assert.deepEqual(h.calls, []); assert.equal(h.context.__IDEOGRAM_CURRENT_FONT_READS__, undefined);
});

test('existing page owner and navigation failure never become successful raw observations', async () => {
  const h = harness(); h.context.__IDEOGRAM_CURRENT_FONT_READS__ = new Map([['prior', new AbortController()]]);
  await assert.rejects(h.collect(), /already owned/); assert.equal(h.context.__IDEOGRAM_CURRENT_FONT_READS__.size, 1);
  await assert.rejects(collectCurrentDocumentFonts({page: {evaluate: async () => {throw Error('navigation destroyed context');}}, documentId: 'document_1', fontAssetIds: [], binding: binding()}), /navigation destroyed context/);
});

test('argument bounds reject undefined IDs, duplicate locators and invalid deadlines before page calls', async () => {
  const h = harness();
  for (const patch of [{documentId: undefined}, {documentId: 17}, {fontAssetIds: ['font_0', 'font_0']}, {fontAssetIds: Array.from({length: 17}, (_, i) => 'f_' + i)}, {timeoutMs: 0}, {timeoutMs: 60001}, {binding: null}]) await assert.rejects(h.collect(patch), /arguments are invalid/);
  assert.deepEqual(h.calls, []);
});
