// A fixed small seed ingredient, not a WX workload or a rendering benchmark.
// The native worker genuinely lays out each string. Alpha-zero pixels have an
// independent exact oracle; this earns no visible-glyph or presentation credit.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { checkCoverage } from './fonts.mjs';

const frame = Object.freeze({ width: 240, height: 90 });
const fontsRecipe = Object.freeze([
  { id: 'NotoSans', file: 'fonts/NotoSans-Regular.ttf', bytes: 569208,
    hash: 'sha256:b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5' },
  { id: 'NotoSansArabic', file: 'fonts/NotoSansArabic-Regular.ttf', bytes: 240456,
    hash: 'sha256:ceea25b464a656dc3b26849bab9356740401af62aedf1bfa8b7f0d9b75925b1b' },
]);
const licenseRecipe = Object.freeze({ file: 'notices/Noto-OFL.txt', bytes: 4377,
  hash: 'sha256:0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb' });
const layersRecipe = Object.freeze([
  { id: 'mixed_seed_text_visible', visible: true, original: 'Native Café\nretained source', replacement: 'مرحبا\nنص محفوظ' },
  { id: 'mixed_seed_text_hidden', visible: false, original: 'Hidden Café\nretained source', replacement: 'مرحبا\nنص مخفي' },
]);
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const checkAbort = signal => signal?.throwIfAborted();
const fault = code => Object.assign(Error(code), { code });
const objectPath = (root, ref) => join(root, 'objects', 'sha256', ref.hash.slice(7, 9), ref.hash.slice(7));

async function boundedFile(path, maximum, identity) {
  const before = await lstat(path);
  assert(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= maximum, 'Bounded ordinary native input required');
  if (identity) assert.equal(before.size, identity.bytes);
  const bytes = await readFile(path), after = await lstat(path);
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[field], before[field], 'Native input changed while reading');
  assert.equal(bytes.length, before.size);
  if (identity) assert.equal(hash(bytes), identity.hash, 'Pinned native input changed');
  return bytes;
}

// No execArgv override: the invoking campaign's no-egress preload propagates.
// Every result/rejection waits for exit, including abort and timeout termination.
async function renderNative(repo, request, fonts, signal, runs) {
  checkAbort(signal);
  const worker = new Worker(pathToFileURL(join(repo, 'dist/local/server/text/render-worker.mjs')),
    { workerData: { request, fonts }, env: {}, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } });
  const observed = { threadId: worker.threadId, ready: false, admitted: false, result: false, exited: false, exitCode: null, terminationRequested: false };
  runs.push(observed);
  return new Promise((resolveResult, reject) => {
    let result, failure, termination;
    const stop = error => {
      failure ??= error;
      if (!observed.exited && !termination) {
        observed.terminationRequested = true;
        termination = worker.terminate().catch(error => { failure = new AggregateError([failure, error], 'Native worker termination failed'); });
      }
    };
    const onAbort = () => stop(signal.reason instanceof Error ? signal.reason : fault('MIXED_SEED_NATIVE_ABORTED'));
    const timer = setTimeout(() => stop(fault('MIXED_SEED_NATIVE_RENDER_DEADLINE')), 20000);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', message => {
      if (failure) return;
      if (message?.type === 'ready' && !observed.ready && !observed.result) {
        observed.ready = true;
        try { checkAbort(signal); worker.postMessage({ type: 'admit' }); observed.admitted = true; }
        catch (error) { stop(error); }
      } else if (message?.type === 'result' && observed.admitted && !observed.result) {
        observed.result = true; result = message;
      } else stop(fault('MIXED_SEED_NATIVE_WORKER_' + (message?.type === 'failure' ? 'FAILURE' : 'PROTOCOL')));
    });
    worker.on('error', error => { failure ??= error; });
    worker.once('exit', async code => {
      observed.exited = true; observed.exitCode = code;
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (termination) await termination;
      if (failure) reject(failure);
      else if (code !== 0 || !observed.ready || !observed.admitted || !result) reject(fault('MIXED_SEED_NATIVE_WORKER_EXIT'));
      else resolveResult(result);
    });
    if (signal?.aborted) onAbort();
  });
}

async function releaseAdmission(ctx, id) {
  const deadline = performance.now() + 25000;
  for (;;) {
    try { await ctx.writer.textAdmission(id, ctx.auth(), true); return; }
    catch (error) {
      // An aborted command poll may leave its actual verifier draining. The
      // release stays with the same admission; it does not resubmit the edit.
      if (error.code !== 'QUEUE_FULL' || performance.now() >= deadline) throw error;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
  }
}

/** ctx is the composer's ordinary writer context. No font, profile, worker,
 * command implementation, or native result can be supplied by its caller. */
export async function prepareMixedSeedNative(ctx, { signal, onProgress = () => {} } = {}) {
  checkAbort(signal);
  const repo = resolve(ctx.repo), runs = [], admissions = { acquired: 0, released: 0, active: 0 };
  const { canonical } = await import(pathToFileURL(join(repo, 'dist/local/src/protocol/json.js')).href);
  const { verificationBudget } = await import(pathToFileURL(join(repo, 'dist/local/src/protocol/text-budget.js')).href);
  const identify = value => ({ ...value, id: hash(canonical(value)) });
  const profileBytes = await boundedFile(join(repo, 'src/text/profile.json'), 65536), profile = JSON.parse(profileBytes.toString('utf8'));
  const { id: profileId, ...profileBody } = profile;
  assert.equal(hash(JSON.stringify(profileBody)), profileId, 'Current renderer manifest identity');
  assert(Number.isSafeInteger(profile.engine?.wasm?.bytes) && profile.engine.wasm.bytes > 0);
  const licenseBytes = await boundedFile(join(repo, 'vendor/text', licenseRecipe.file), 65536, licenseRecipe);
  const loaded = [];
  for (const recipe of fontsRecipe) {
    checkAbort(signal);
    const pinned = profile.fonts.find(font => font.id === recipe.id);
    assert(pinned && pinned.file === recipe.file && pinned.bytes === recipe.bytes && 'sha256:' + pinned.sha256 === recipe.hash);
    assert.equal(pinned.licenseFile, licenseRecipe.file); assert.equal(pinned.licenseHash, licenseRecipe.hash);
    const bytes = await boundedFile(join(repo, 'vendor/text', recipe.file), 16777216, recipe);
    for (const layer of layersRecipe) checkCoverage([bytes], recipe.id === 'NotoSans' ? layer.original : layer.replacement);
    loaded.push(bytes);
  }
  const initialImage = await ctx.writer.imageState(ctx.documentId);
  assert(!initialImage.layers.some(layer => layersRecipe.some(recipe => recipe.id === layer.id)), 'Small seed native identities must be fresh');

  const put = async (bytes, mediaType) => {
    checkAbort(signal);
    const value = Buffer.from(bytes), asset = await ctx.stage(value, 'text', 'application/octet-stream');
    assert.equal(asset.blob.hash, hash(value)); assert.equal(asset.blob.byteLength, String(value.length));
    return { ...asset.blob, mediaType };
  };
  const readSource = ref => ctx.writer.consumeMetadata(ref, bytes => {
    assert(bytes.byteLength <= 65536 && String(bytes.byteLength) === ref.byteLength && hash(bytes) === ref.hash);
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  });
  const fontAssets = [];
  for (const [index, recipe] of fontsRecipe.entries()) {
    checkAbort(signal);
    const source = await ctx.stage(loaded[index], 'font', 'application/octet-stream');
    const license = await ctx.stage(licenseBytes, 'caption', 'text/plain');
    const imported = ctx.registered(await ctx.execute({ type: 'ImportFont', source: source.blob, license: license.blob,
      origin: 'bundled', embeddingReviewed: true }, 'historyCommand', true));
    assert.equal(imported.font?.bytes.hash, recipe.hash); assert.equal(imported.font?.licenseRecord.hash, licenseRecipe.hash);
    fontAssets.push(imported);
  }
  loaded.length = 0;
  const manifest = await put(profileBytes, 'application/json'), historical = [], current = [];
  const facts = (layer, source, document) => ({ layerId: layer.id, layerVersion: layer.version, visible: layer.visible,
    historyNode: document.historyHead, source: layer.source, text: source.text.textUtf8, layout: source.render.layout,
    pixels: source.render.pixels, profile: source.render.rendererProfile.manifest,
    fonts: source.text.fonts.map(font => font.bytes), licenses: source.text.fonts.map(font => font.licenseRecord) });

  async function apply(recipe, font, replace) {
    checkAbort(signal);
    const document = await ctx.writer.document(ctx.documentId), image = await ctx.writer.imageState(ctx.documentId);
    const prior = image.layers.find(layer => layer.id === recipe.id), layerVersion = replace ? prior?.version : '0';
    assert(!replace || prior?.kind === 'text');
    const literal = replace ? recipe.replacement : recipe.original;
    assert(Buffer.byteLength(literal) <= 128 && literal.split('\n').length <= 2);
    const style = { primaryFont: font.bytes.hash, explicitFallbacks: [], sizePx: 24, lineHeightMultiplier: 1.2,
      fill: [40, 90, 190, 0], align: 'start', direction: 'auto' };
    const token = { documentId: document.id, documentRevision: document.revision, layerId: recipe.id,
      layerVersion, sessionId: ctx.sessionId, generation: 1 };
    const budget = verificationBudget(literal, frame.width, frame.height, Number(font.bytes.byteLength), profile.engine.wasm.bytes);
    const rendered = await renderNative(repo, { text: literal, style, frame, token }, [{ path: objectPath(ctx.root, font.bytes),
      length: Number(font.bytes.byteLength), hash: font.bytes.hash, origin: font.origin, licenseHash: font.licenseRecord.hash }], signal, runs);
    checkAbort(signal);
    assert.equal(rendered.width, frame.width); assert.equal(rendered.height, frame.height);
    assert.equal(typeof rendered.overflow, 'boolean');
    assert(typeof rendered.layout === 'string' && Buffer.byteLength(rendered.layout) <= 8388608);
    assert(JSON.parse(rendered.layout).paragraphs.some(paragraph => paragraph.runs.length > 0), 'Real nonempty native layout required');
    const textAsset = await ctx.stage(Buffer.from(literal), 'caption', 'text/plain'), textUtf8 = textAsset.blob;
    const layout = await put(Buffer.from(rendered.layout), 'application/json');
    const pixels = await put(Buffer.alloc(frame.width * frame.height * 4), 'application/x-ideogram-rgba8');
    assert.equal(textUtf8.hash, hash(literal)); assert.equal(rendered.textHash, textUtf8.hash);
    assert.equal(rendered.layoutHash, layout.hash); assert.equal(rendered.rasterHash, pixels.hash);
    const text = identify({ schemaVersion: 1, textUtf8, style, frame, layoutPolicy: 'text-layout-1', fonts: [font] });
    const dependencyHash = hash(JSON.stringify({ rendererProfile: profileId, textHash: textUtf8.hash, style, frame,
      fonts: [{ hash: font.bytes.hash, licenseHash: font.licenseRecord.hash, faceIndex: 0,
        format: font.format, parserProfile: font.parserProfile, fsType: font.fsType }] }));
    const render = identify({ schemaVersion: 1, textVersion: text.id, rendererProfile: { schemaVersion: 1, id: profileId, manifest },
      dependencyHash, layout, pixels, width: rendered.width, height: rendered.height, overflow: rendered.overflow, resolvedFonts: [font.id] });
    const source = { schemaVersion: 1, text, render };
    const candidate = await put(Buffer.from(canonical({ schemaVersion: 1, token, source })), 'application/json');
    const draft = await ctx.stage(Buffer.from(canonical({ schemaVersion: 1, kind: 'text-draft-1', textUtf8, style, frame, fonts: [font] })), 'caption', 'text/plain');
    const draftId = 'mixed_native_' + randomUUID(), generation = '1';
    await ctx.ui({ type: 'SaveDraft', draft: { id: draftId, generation, kind: 'text', documentId: document.id,
      targetLayerId: replace ? recipe.id : null, expectedDocumentRevision: document.revision, assetId: draft.id, composing: false } });
    const admissionId = randomUUID() + '_1_' + budget.bytes;
    let failure, acquired = false;
    try {
      checkAbort(signal);
      await ctx.writer.textAdmission(admissionId, ctx.auth());
      acquired = true; admissions.acquired++; admissions.active++;
      await ctx.execute({ type: replace ? 'ReplaceTextFont' : 'CreateTextLayer', layerId: recipe.id,
        ...(replace ? { layerVersion, reviewedDependencyHash: dependencyHash } : { name: recipe.visible ? 'Mixed seed native text' : 'Mixed seed hidden native text' }),
        candidate, draft: { sessionId: ctx.sessionId, draftId, generation }, admissionId }, 'historyCommand', true);
    } catch (error) { failure = error; throw error; }
    finally {
      // Also attempt release when the admission response was lost; success is
      // reported only for operations whose acquisition was actually observed.
      try { await releaseAdmission(ctx, admissionId); if (acquired) { admissions.released++; admissions.active--; } }
      catch (error) { throw failure ? new AggregateError([failure, error], 'Native edit and admission release failed') : error; }
    }
    await ctx.ui({ type: 'ClearDraft', draftId, generation });
    let state = await ctx.writer.imageState(ctx.documentId), layer = state.layers.find(layer => layer.id === recipe.id);
    assert(layer?.kind === 'text'); assert.equal(canonical(await readSource(layer.source)), canonical(source));
    if (!replace && !recipe.visible) {
      await ctx.execute({ type: 'SetLayerProperties', layerId: recipe.id, layerVersion: layer.version,
        properties: { visible: false }, draft: null }, 'historyCommand', true);
      state = await ctx.writer.imageState(ctx.documentId); layer = state.layers.find(value => value.id === recipe.id);
    }
    assert.equal(layer.visible, recipe.visible);
    const after = await ctx.writer.document(ctx.documentId);
    await onProgress({ phase: replace ? 'mixed-native-font-replaced' : 'mixed-native-created', layerId: recipe.id, alphaZero: true });
    return facts(layer, source, after);
  }

  for (const recipe of layersRecipe) historical.push(await apply(recipe, fontAssets[0].font, false));
  for (const recipe of layersRecipe) current.push(await apply(recipe, fontAssets[1].font, true));
  const finalImage = await ctx.writer.imageState(ctx.documentId);
  for (const layer of finalImage.layers.filter(layer => layer.kind === 'text')) {
    const source = await readSource(layer.source);
    assert(!source.text.fonts.some(font => font.bytes.hash === fontAssets[0].font.bytes.hash), 'Superseded font must not remain in current native text');
  }
  for (const retained of historical) {
    const source = await readSource(retained.source);
    assert.equal(source.text.fonts[0].bytes.hash, fontAssets[0].font.bytes.hash);
    assert(!current.some(value => value.source.hash === retained.source.hash), 'History source must be superseded');
  }
  assert.equal(runs.length, 4); assert(runs.every(run => run.exited && run.exitCode === 0 && run.ready && run.admitted && run.result && !run.terminationRequested));
  assert.deepEqual(admissions, { acquired: 4, released: 4, active: 0 });
  return { kind: 'mixed-wc-seed-native-1', alphaZero: true, visibleGlyphCredit: false,
    purpose: 'Real native dependency and history closure only; no visible-glyph, presentation, or performance qualification',
    layerIds: layersRecipe.map(recipe => recipe.id), hiddenLayerId: layersRecipe.find(recipe => !recipe.visible).id,
    current, historical, currentFont: { assetId: fontAssets[1].id, font: fontAssets[1].font },
    historyOnlyFont: { assetId: fontAssets[0].id, font: fontAssets[0].font },
    workers: { started: runs.length, exited: runs.filter(run => run.exited).length, active: 0, runs }, admissions };
}
