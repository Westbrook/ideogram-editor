// Native workload preparation uses the shipped text worker and production
// writer protocols. Importing this file does not open a writer/browser/server.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { buildProductFixture } from './fixture-product.mjs';
import { workloadDefinition, fileIdentity } from './fixtures.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const check = (condition, code) => { if (!condition) throw Object.assign(Error(code), { code }); };
const abort = signal => signal?.throwIfAborted();
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);

export function planNativeFixture({ definition, corpus }) {
  const def = workloadDefinition(typeof definition === 'string' ? definition : definition?.id);
  check(['WXn', 'WXs'].includes(def.id), 'NATIVE_WORKLOAD_REQUIRED');
  for (const key of ['width', 'height', 'imageLayers', 'textLayers', 'layers', 'visibleImages', 'visibleText', 'events', 'snapshotTail', 'textBytes', 'fontFaces']) if (definition && typeof definition === 'object' && key in definition) check(definition[key] === def[key], 'NATIVE_WORKLOAD_SCALING_FORBIDDEN');
  check(Array.isArray(corpus?.files), 'NATIVE_CORPUS_REQUIRED');
  const texts = corpus.files.filter(f => f.role === 'text').sort((a, b) => a.index - b.index);
  const fonts = corpus.files.filter(f => f.role === 'font').sort((a, b) => a.index - b.index);
  const manifests = corpus.files.filter(f => f.role === 'font-manifest');
  check(texts.length === def.textLayers && fonts.length === def.fontFaces && manifests.length === 1, 'NATIVE_CORPUS_COUNTS');
  check(texts.reduce((sum, f) => sum + Number(f.byteLength), 0) === def.textBytes && texts.every(f => Number(f.byteLength) <= def.frameTextLimit), 'NATIVE_TEXT_BYTE_COUNTS');
  check(fonts.reduce((sum, f) => sum + Number(f.byteLength), 0) <= def.fontBytesLimit && fonts.every(f => Number(f.byteLength) <= 16777216), 'NATIVE_FONT_BYTE_COUNTS');
  check(new Set(fonts.map(f => f.sha256)).size === fonts.length, 'NATIVE_DISTINCT_FACES_REQUIRED');
  for (const file of [...texts, ...fonts, manifests[0]]) check(typeof file.path === 'string' && /^sha256:[a-f0-9]{64}$/.test(file.sha256 ?? '') && /^[1-9][0-9]*$/.test(String(file.byteLength)), 'NATIVE_CORPUS_IDENTITY');
  for (const font of fonts) check(font.faceIndex === 0 && typeof font.licensePath === 'string' && /^sha256:[a-f0-9]{64}$/.test(font.licenseHash ?? ''), 'NATIVE_FONT_LICENSE_REQUIRED');
  return { definition: def, texts, fonts, manifest: manifests[0], frame: { width: 360, height: 180 }, preparationOnly: true, runtimeRequired: true };
}

/** Owned negative fixture copy, never an edit to a vendored/retained face. */
export function restrictedFontBytes(input) {
  const value = Buffer.from(input); check(value.length >= 12, 'NATIVE_FONT_DIRECTORY');
  const tables = new Map();
  for (let i = 0; i < value.readUInt16BE(4); i++) { const at = 12 + i * 16; check(at + 16 <= value.length, 'NATIVE_FONT_DIRECTORY'); const offset = value.readUInt32BE(at + 8), length = value.readUInt32BE(at + 12); check(offset + length <= value.length, 'NATIVE_FONT_DIRECTORY'); tables.set(value.toString('ascii', at, at + 4), { at, offset, length }); }
  const os2 = tables.get('OS/2'), head = tables.get('head'); check(os2?.length >= 10 && head?.length >= 12, 'NATIVE_FONT_DIRECTORY');
  value.writeUInt16BE(2, os2.offset + 8);
  let sum = 0; for (let i = 0; i < os2.length; i += 4) { let word = 0; for (let j = 0; j < 4; j++) word = word * 256 + (i + j < os2.length ? value[os2.offset + i + j] : 0); sum = (sum + word) >>> 0; }
  value.writeUInt32BE(sum, os2.at + 4); value.writeUInt32BE(0, head.offset + 8); sum = 0;
  for (let i = 0; i < value.length; i += 4) { let word = 0; for (let j = 0; j < 4; j++) word = word * 256 + (i + j < value.length ? value[i + j] : 0); sum = (sum + word) >>> 0; }
  value.writeUInt32BE((0xb1b0afba - sum) >>> 0, head.offset + 8); return value;
}

async function verifiedBytes(file, signal) {
  abort(signal); const before = await fileIdentity(file.path); check(before.sha256 === file.sha256 && before.byteLength === String(file.byteLength), 'NATIVE_FILE_CHANGED');
  const value = await readFile(file.path); check(hash(value) === file.sha256 && String(value.length) === String(file.byteLength), 'NATIVE_FILE_CHANGED'); return value;
}

/** Start a fresh real browser renderer. The browser only reaches this loopback
 * Vite origin; font responses are from a closed, already verified path map.
 * Production DurableTextPreparation owns all worker output and R31 admission. */
export async function openNativeRenderer(ctx, plan, signal) {
  const repo = resolve(ctx.repo ?? REPO), requireSubject = createRequire(resolve(repo, 'package.json'));
  const { createServer } = await import(pathToFileURL(requireSubject.resolve('vite')).href), { chromium } = await import(pathToFileURL(requireSubject.resolve('playwright')).href);
  const pin = JSON.parse(await readFile(resolve(repo, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers.find(x => x.name === 'chromium');
  const routePrefix = '/__native_qualification_' + randomUUID() + '/', pending = new Map();
  let vite, browser, page, errors = 0, egress = 0, workers = 0, closedWorkers = 0;
  const close = async () => {
    const failures = [];
    for (const release of [async () => { if (page) await page.evaluate(async () => { globalThis.nativePreparation?.dispose(); globalThis.textFixture?.renderer?.dispose(); if (globalThis.nativeStorage) await globalThis.releaseTextRealm(globalThis.nativeStorage); }); }, () => browser?.close(), () => vite?.close()]) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Native fixture renderer cleanup failed');
  };
  try {
    vite = await createServer({ configFile: false, root: resolve(repo, 'tests/text-state/app'), cacheDir: resolve(ctx.root, '../native-vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [repo] } }, worker: { format: 'es' }, logLevel: 'error' });
    vite.middlewares.use((request, response, next) => {
      const path = (request.url ?? '').split('?')[0]; if (!path.startsWith(routePrefix)) return next();
      const raw = path.slice(routePrefix.length); if (!/^\d+$/.test(raw) || !plan.fonts[Number(raw)]) { response.statusCode = 404; response.end(); return; }
      const file = plan.fonts[Number(raw)]; response.setHeader('Content-Type', 'application/octet-stream'); response.setHeader('Content-Length', file.byteLength); response.setHeader('Cache-Control', 'no-store');
      const stream = createReadStream(file.path); stream.once('error', () => response.destroy()); response.once('close', () => stream.destroy()); stream.pipe(response);
    });
    await vite.listen(); const address = vite.httpServer.address(); check(address && typeof address !== 'string', 'NATIVE_HARNESS_ADDRESS'); const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); check(browser.version() === pin.browserVersion, 'NATIVE_BROWSER_PIN_CHANGED');
    const context = await browser.newContext();
    await context.route('**/*', route => { const u = new URL(route.request().url()); if (['http:', 'https:'].includes(u.protocol) && u.origin !== origin) { egress++; return route.abort('blockedbyclient'); } return route.continue(); });
    page = await context.newPage(); page.on('pageerror', () => errors++); page.on('worker', worker => { workers++; worker.once('close', () => closedWorkers++); });
    await page.exposeFunction('__nativeAdmit', id => { abort(signal); return ctx.writer.textAdmission(id, ctx.auth()); });
    await page.exposeFunction('__nativeRelease', id => ctx.writer.textAdmission(id, ctx.auth(), true));
    await page.exposeFunction('__nativeStageBegin', async (size, sha256, mediaType) => {
      abort(signal); check(Number.isSafeInteger(size) && size >= 0 && size <= 8388608 && /^sha256:[a-f0-9]{64}$/.test(sha256), 'NATIVE_STAGE_BOUNDS');
      check(['text/plain', 'application/json', 'application/x-ideogram-rgba8'].includes(mediaType), 'NATIVE_STAGE_MEDIA');
      const stagingId = randomUUID(); await ctx.writer.assetCreate({ protocolVersion: 1, stagingId, purpose: 'text', expectedBytes: String(size), sha256, mediaType: 'application/octet-stream' }, ctx.auth());
      pending.set(stagingId, { size, sha256, mediaType, offset: 0 }); return stagingId;
    });
    await page.exposeFunction('__nativeStageChunk', async (id, encoded) => {
      abort(signal); const stage = pending.get(id), chunk = Buffer.from(encoded, 'base64'); check(stage && chunk.length > 0 && chunk.length <= 65536 && stage.offset + chunk.length <= stage.size, 'NATIVE_STAGE_CHUNK');
      const token = await ctx.writer.assetBeginChunk(id, String(stage.offset), chunk.length, ctx.auth()); await ctx.writer.assetChunk(token, chunk, ctx.auth()); stage.offset += chunk.length;
    });
    await page.exposeFunction('__nativeStageFinish', async id => {
      abort(signal); const stage = pending.get(id); check(stage && stage.offset === stage.size, 'NATIVE_STAGE_INCOMPLETE');
      const asset = ctx.registered(await ctx.execute({ type: 'FinalizeStaging', stagingId: id, expectedSha256: stage.sha256 }, 'assetCommand')); pending.delete(id);
      return { ...asset.blob, mediaType: stage.mediaType };
    });
    await page.goto(origin); await page.waitForFunction(() => typeof globalThis.DurableTextPreparation === 'function');
    await page.evaluate(() => {
      globalThis.nativeStorage = { admit: id => globalThis.__nativeAdmit(id), releaseAdmission: id => globalThis.__nativeRelease(id), stage: async (blob, media) => {
        const sha256 = await globalThis.textFixture.hashBytes(blob), id = await globalThis.__nativeStageBegin(blob.size, sha256, media);
        for (let offset = 0; offset < blob.size; offset += 65536) { const part = new Uint8Array(await blob.slice(offset, offset + 65536).arrayBuffer()); let binary = ''; for (let at = 0; at < part.length; at += 32768) binary += String.fromCharCode(...part.subarray(at, at + 32768)); await globalThis.__nativeStageChunk(id, btoa(binary)); }
        return globalThis.__nativeStageFinish(id);
      } };
      globalThis.nativePreparation = new globalThis.DurableTextPreparation(globalThis.nativeStorage);
    });
    return { async prepare({ text, token, fonts, style }) {
      abort(signal);
      const result = await page.evaluate(async ({ text, token, fonts, style, prefix, frame }) => {
        const inputFonts = [];
        for (let index = 0; index < fonts.length; index++) { const response = await fetch(prefix + index); if (!response.ok) throw Error('NATIVE_FONT_READ'); const blob = await response.blob(); if (await globalThis.textFixture.hashBytes(blob) !== fonts[index].bytes.hash) throw Error('NATIVE_FONT_HASH'); inputFonts.push({ hash: fonts[index].bytes.hash, bytes: blob, faceIndex: 0, origin: fonts[index].origin, license: { hash: fonts[index].licenseRecord.hash, embedding: 'permitted' } }); }
        return globalThis.nativePreparation.prepare({ token, text, fonts: inputFonts, style, frame }, fonts);
      }, { text, token, fonts, style, prefix: routePrefix, frame: plan.frame });
      check(errors === 0 && egress === 0 && pending.size === 0, 'NATIVE_RENDERER_FAILURE'); return result;
    }, async close() { await close(); check(egress === 0 && errors === 0 && closedWorkers === workers, 'NATIVE_WORKER_RELEASE_INCOMPLETE'); }, identity: { engine: 'chromium', version: browser.version(), revision: pin.revision, headless: true, purpose: 'fixture preparation only; no H timing or display claim' } };
  } catch (error) { await close().catch(() => {}); throw error; }
}

export async function prepareNativeLayers(ctx, plan, { signal, onProgress = () => {} } = {}) {
  const fonts = [], fontAssetIds = [], textFacts = [], layerIds = [...ctx.imageLayerIds];
  const repo = resolve(ctx.repo ?? REPO), profile = JSON.parse(await readFile(resolve(repo, 'src/text/profile.json'), 'utf8'));
  for (const file of plan.fonts) {
    const sourceBytes = await verifiedBytes(file, signal), licenseBytes = await readFile(file.licensePath); check(hash(licenseBytes) === file.licenseHash, 'NATIVE_LICENSE_CHANGED');
    const source = await ctx.stage(sourceBytes, 'font', 'application/octet-stream'), license = await ctx.stage(licenseBytes, 'caption', 'text/plain');
    const imported = ctx.registered(await ctx.execute({ type: 'ImportFont', source: source.blob, license: license.blob, origin: 'local-file', embeddingReviewed: true }, 'historyCommand', true)); const font = imported.font; fontAssetIds.push(imported.id);
    check(font && font.bytes.hash === file.sha256 && font.licenseRecord.hash === file.licenseHash, 'NATIVE_FONT_REGISTRATION_CHANGED'); fonts.push(font);
  }
  const renderer = await openNativeRenderer(ctx, plan, signal);
  try {
    // Hidden native layers are assembled first to bound setup composites. Every
    // layer is nevertheless independently laid out by the real worker.
    const indexes = [...Array(plan.texts.length).keys()].sort((a, b) => Number(a < plan.definition.visibleText) - Number(b < plan.definition.visibleText) || a - b);
    const nativeIds = [];
    for (const index of indexes) {
      abort(signal); const file = plan.texts[index], original = await verifiedBytes(file, signal);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original); check(text.split('\n').length <= plan.definition.logicalLines && Buffer.byteLength(text) === original.length, 'NATIVE_TEXT_CORPUS_INVALID');
      const layerId = 'fixture_text_' + String(index).padStart(3, '0'), draftId = 'native_draft_' + index, generation = '1'; nativeIds[index] = layerId;
      const revision = await ctx.writer.documentRevision(ctx.documentId), sessionId = ctx.sessionId ?? 'qualification_fixture';
      const style = { primaryFont: fonts[0].bytes.hash, explicitFallbacks: fonts.slice(1).map(f => f.bytes.hash), sizePx: 32, lineHeightMultiplier: 1.2, fill: [40, 90, 190, 255], align: 'start', direction: 'auto' };
      const textAsset = await ctx.stage(original, 'caption', 'text/plain');
      const draftAsset = await ctx.stage(Buffer.from(canonical({ schemaVersion: 2, kind: 'text-draft-2', textUtf8: textAsset.blob, fonts, style, frame: plan.frame, placement: { x: 20 + index * 3, y: 20 + index * 2 } })), 'caption', 'text/plain');
      await ctx.ui({ type: 'SaveDraft', draft: { id: draftId, generation, kind: 'text', documentId: ctx.documentId, targetLayerId: null, expectedDocumentRevision: revision, assetId: draftAsset.id, composing: false } });
      const result = await renderer.prepare({ text, fonts, style, token: { documentId: ctx.documentId, documentRevision: revision, layerId, layerVersion: '0', sessionId, generation: Number(generation) } });
      const candidate = JSON.parse(Buffer.from(await ctx.writer.readMetadata(result.candidate)).toString('utf8'));
      check(candidate.source.render.rendererProfile.id === profile.id && candidate.source.text.textUtf8.hash === file.sha256, 'NATIVE_PREPARATION_IDENTITY');
      await ctx.execute({ type: 'CreateTextLayer', layerId, name: 'Native text ' + (index + 1), candidate: result.candidate, draft: { sessionId, draftId, generation }, admissionId: result.admissionId, placement: { x: 20 + index * 3, y: 20 + index * 2 } }, 'historyCommand', true);
      await ctx.ui({ type: 'ClearDraft', draftId, generation });
      if (index >= plan.definition.visibleText) await ctx.execute({ type: 'SetLayerProperties', layerId, layerVersion: '1', properties: { visible: false }, draft: null }, 'historyCommand', true);
      const state = await ctx.writer.imageState(ctx.documentId), layer = state.layers.find(layer => layer.id === layerId); check(layer?.kind === 'text', 'NATIVE_LAYER_NOT_DURABLE');
      const source = JSON.parse(Buffer.from(await ctx.writer.readMetadata(layer.source)).toString('utf8'));
      check(canonical(source) === canonical(candidate.source), 'NATIVE_SOURCE_CHANGED_ON_ADMISSION');
      textFacts[index] = { layerId, textHash: source.text.textUtf8.hash, textBytes: Number(source.text.textUtf8.byteLength), sourceHash: layer.source.hash, layoutHash: source.render.layout.hash, pixelHash: source.render.pixels.hash, rendererHash: source.render.rendererProfile.id, fonts: source.text.fonts.map(f => f.bytes.hash) };
      await onProgress({ phase: 'native-layout-and-durable-admission', workload: plan.definition.id, completed: textFacts.filter(Boolean).length, total: plan.texts.length });
    }
    layerIds.push(...nativeIds);
  } finally { await renderer.close(); }
  check(textFacts.length === plan.definition.textLayers && textFacts.every(Boolean) && textFacts.reduce((sum, f) => sum + f.textBytes, 0) === plan.definition.textBytes, 'NATIVE_ACCEPTED_TEXT_TOTAL');
  const { emptyComposition, emptyElement } = await import(pathToFileURL(resolve(repo, 'dist/local/src/composition/core.js')).href);
  const composition = emptyComposition(plan.definition.width, plan.definition.height, randomUUID());
  composition.elements = ['semantic_fixture_0', 'semantic_fixture_1'].map((id, i) => ({ ...emptyElement('obj', id), desc: { mode: 'literal', value: 'Fixture element ' + i }, bounds: { mode: 'literal', value: { rect: [20 + i * 120, 20, 100, 100], transform: [1, 0, 0, 1, 0, 0] } } }));
  const graph = await ctx.stage(Buffer.from(canonical(composition)), 'text', 'application/octet-stream');
  await ctx.execute({ type: 'CommitCompositionVersion', composition: { id: composition.id, value: { ...graph.blob, mediaType: 'application/json' }, bindings: {} }, draft: null }, 'historyCommand', true);
  return { layerIds, textFacts, fontAssetIds, semanticItemIds: composition.elements.map(e => e.id), renderer: renderer.identity, rendererHash: profile.id, fontManifestHash: plan.manifest.sha256, fonts, allTextLayersLaidOut: true };
}

/** Candidate seeding remains explicit and uses the same production emulator
 * ingress as the raster builder. Missing actual candidates makes its criteria
 * incomplete and this wrapper refuses to seal a native workload as complete. */
export async function nativeFixture({ root, definition, corpus, output, signal, onProgress, seedCandidates, repo = REPO }) {
  const subjectRepo = resolve(repo), plan = planNativeFixture({ definition, corpus }); await verifiedBytes(plan.manifest, signal);
  const built = await buildProductFixture({ root, repo: subjectRepo, workload: plan.definition.id, corpus, allowHeavy: true, signal, onProgress, seedCandidates, prepareNativeLayers: ctx => prepareNativeLayers(Object.assign(Object.create(ctx), { repo: subjectRepo }), plan, { signal, onProgress }) });
  check(built.status === 'complete' && built.native?.allTextLayersLaidOut === true, 'NATIVE_PRODUCT_FIXTURE_INCOMPLETE');
  const first = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await verifiedBytes(plan.texts[0], signal));
  const fragments = ['Cafe\u0301', 'العَرَبِيَّة', 'देवनागरी', '中文', '☀', '\n', 'unbrokenunbroken', 'A\u0300', 'اتجاه', 'हिन्दी', '日本語', '✈', 'longwordlongword', 'Latin', '★', 'e\u0301', '中文', 'देवनागरी', 'اتجاه', '\n'];
  const text = { schema: 'browser-text-fixture-1', documentId: built.documentId, manifestHash: plan.manifest.sha256, fontSetPreseeded: true,
    corpus: { text: first, sha256: hash(first), fragments, fragmentsHash: hash(JSON.stringify(fragments)), scripts: ['latin-combining', 'arabic-rtl', 'devanagari', 'cjk', 'emoji', 'newlines', 'unbroken'] },
    fonts: plan.fonts.map(f => ({ kind: 'local', id: f.id, sha256: f.sha256, bytes: Number(f.byteLength), path: f.path, licensePath: f.licensePath, licenseSha256: f.licenseHash })),
    activeLayerId: built.native.textFacts[0].layerId, activeLayerIndex: plan.definition.textLayers - 1,
    expectedLayerCount: plan.definition.layers, expectedPreviewHash: built.native.textFacts[0].pixelHash,
    semanticItemIds: built.native.semanticItemIds,
    recoveryCases: {
      'missing-font': { scenario: 'missing-font', assetId: built.native.fontAssetIds[0] },
      'corrupt-font': { scenario: 'corrupt-font', assetId: built.native.fontAssetIds[0] },
      'mismatched-font-hash': { scenario: 'mismatched-font-hash', assetId: built.native.fontAssetIds[0], replacementPath: plan.fonts[1].path, replacementHash: plan.fonts[1].sha256 },
      'missing-glyph': { scenario: 'missing-glyph', text: '\u{10ffff}', textHash: hash('\u{10ffff}') },
      'cancelled-over-limit-composition': { scenario: 'cancelled-over-limit-composition' },
    },
  };
  const restricted = restrictedFontBytes(await verifiedBytes(plan.fonts[0], signal)), restrictedPath = resolve(output, 'restricted-font-copy.ttf');
  await writeFile(restrictedPath, restricted, { flag: 'wx', mode: 0o600 });
  text.recoveryCases['restricted-font'] = { scenario: 'restricted-font', path: restrictedPath, sha256: hash(restricted), licensePath: plan.fonts[0].licensePath, licenseSha256: plan.fonts[0].licenseHash };
  const { seal: _coreSeal, ...core } = built;
  const result = { ...core, text, observed: { ...built.observed, activeRequests: built.observed.active, textBytes: built.native.textFacts.reduce((sum, f) => sum + f.textBytes, 0), fontFaces: built.native.fonts.length, allTextLayersLaidOut: built.native.allTextLayersLaidOut, rendererHash: built.native.rendererHash, fontManifestHash: built.native.fontManifestHash }, preparationOutput: output };
  return { ...result, seal: { algorithm: 'sha256-canonical-json', sha256: hash(canonical(result)), scope: 'complete native receipt before its seal field; parent seals the closed root and corpus separately' } };
}
