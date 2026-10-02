import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join, sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {attemptIdentity, digest, intervalWait} from './common.mjs';
import {readPhaseSnapshot} from './browser-phase-snapshot.mjs';
import {collectCurrentDocumentFonts, inspectCurrentDocumentFonts} from './browser-text-fonts.mjs';
import {inspectOrdinaryTextObservation} from './ordinary-text-phases.mjs';
import {collectOrdinaryFontInvariant, replayOrdinaryFontInvariant, ordinaryFontInvariantMeasurement, ORDINARY_FONT_INVARIANT_SOURCE_FILES} from './browser-text-invariant.mjs';

export const ORDINARY_TEXT_OPERATIONS = Object.freeze(['text.font-set', 'text.active-layout', 'text.apply', 'text.mixed-ready']);
export const ORDINARY_TEXT_LIMITS = Object.freeze({raw: 4 * 1024 * 1024, binding: 128 * 1024, publicJSON: 256 * 1024, state: 16 * 1024, steps: 1});
const proofs = new WeakMap(), SHA = /^sha256:[a-f0-9]{64}$/, SOURCE_SHA = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,128}$/;
const demand = (condition, message) => {if (!condition) throw Error(message);};
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const decode = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const encode = value => Buffer.from(JSON.stringify(value));
const finite = value => Number.isFinite(value) && value >= 0;
const registryNames = new Set(['R35CurrentFontFaces', 'R35SingleFontBytes', 'R35CurrentFontSetBytes', 'R35SilentFontSubstitutionCount']);
const observedPhaseNames = new Set(['text.font-ready.worker', 'text.preview.render-submitted', 'text.apply.authority-durable',
  'document.recovery.model-ready', 'document.viewport.canonical-ready', 'document.controls.edit-available']);
function textFixtureIdentity(fixture) {
  return {documentId: fixture.text.documentId, layerId: fixture.text.activeLayerId, sourceHash: fixture.text.corpus.sha256,
    rasterHash: fixture.text.expectedPreviewHash, fontFaces: fixture.text.fonts.length, fontBytes: fixture.text.fonts.reduce((sum, font) => sum + font.bytes, 0)};
}

// A deliberately narrower scalar projection than the full Asset DTO. The
// public application already validates that DTO; replay additionally binds the
// accepted composite's encoded bytes and distinct canonical pixel identity.
function canonicalComposite(root) {
  const raster = root?.compositeRaster, state = root?.compositeState;
  const blob = (value, media, maximum) => value && SHA.test(value.hash ?? '') && /^[1-9][0-9]{0,19}$/.test(value.byteLength ?? '') &&
    Number(value.byteLength) <= maximum && value.mediaType === media;
  demand(ID.test(root?.compositeAssetId ?? '') && /^(0|[1-9][0-9]{0,19})$/.test(root?.compositeVersion ?? '') &&
    state?.purpose === 'image' && state.qualification === 'canonical-raster' && state.measuredMediaType === 'image/png' && state.safety === 'safe' && state.availability === 'available' &&
    blob(root.compositeBlob, 'image/png', Number.MAX_SAFE_INTEGER), 'Canonical composite asset is unavailable');
  demand(raster?.schemaVersion === 1 && /^cp1-f64-triangle-area-v1\/sha256:[a-f0-9]{64}$/.test(raster.pipeline ?? '') &&
    Number.isSafeInteger(raster.width) && raster.width > 0 && raster.width <= 8192 && Number.isSafeInteger(raster.height) && raster.height > 0 && raster.height <= 8192 && raster.width * raster.height <= 25000000 &&
    raster.width === root.documentWidth && raster.height === root.documentHeight && ['native', 'derived', 'composite'].includes(raster.role) && SHA.test(raster.pixelIdentity ?? '') &&
    blob(raster.manifest, 'application/json', 65536) && blob(raster.pixels, 'application/x-ideogram-rgba8', 100000000) && raster.pixels.byteLength === String(raster.width * raster.height * 4),
    'Canonical composite pixel identity is unavailable');
  return {id: root.compositeAssetId, version: root.compositeVersion, blob: root.compositeBlob, ...state, raster};
}

/** Page-side reads are bounded before collecting a response body. No authored
 * text or font payload is returned from this observer. */
export async function readOrdinaryTextPublicState(page, text, commandId = null, signal) {
  const nonce = randomBytes(16).toString('hex');
  const cancel = () => {void page.evaluate(n => globalThis.__IDEOGRAM_ORDINARY_READS__?.get(n)?.abort(), nonce).catch(() => {});};
  signal?.throwIfAborted(); signal?.addEventListener('abort', cancel, {once: true});
  try {
  await page.evaluate(n => {const owners = globalThis.__IDEOGRAM_ORDINARY_READS__ ??= new Map(); if (owners.size) throw Error('ORDINARY_TEXT_READ_BUSY'); owners.set(n, new AbortController());}, nonce);
  signal?.throwIfAborted();
  const value = await page.evaluate(async ({text, commandId, maximum, nonce}) => {
    const owners = globalThis.__IDEOGRAM_ORDINARY_READS__, aborter = owners?.get(nonce);
    if (!aborter || owners.size !== 1) throw Error('ORDINARY_TEXT_READ_OWNER');
    const timeout = setTimeout(() => aborter.abort(), 30000);
    try {
    const validId = value => /^[A-Za-z0-9_-]{1,128}$/.test(value ?? '');
    const read = async path => {
      aborter.signal.throwIfAborted();
      const response = await fetch(path, {credentials: 'same-origin', headers: {'X-App-Client': 'LP-1'}, cache: 'no-store', redirect: 'error', signal: aborter.signal});
      let reader, buffer, offset = 0;
      try {
        if (response.status !== 200 || !response.body || response.body.locked) throw Error('ORDINARY_TEXT_PUBLIC_READ');
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximum)) throw Error('ORDINARY_TEXT_PUBLIC_BOUND');
        reader = response.body.getReader(); buffer = new Uint8Array(maximum);
        for (;;) {aborter.signal.throwIfAborted(); const item = await reader.read(); if (item.done) break; if (!(item.value instanceof Uint8Array) || offset + item.value.byteLength > maximum) throw Error('ORDINARY_TEXT_PUBLIC_BOUND'); buffer.set(item.value, offset); offset += item.value.byteLength;}
      } finally {
        if (reader) {try {await reader.cancel();} finally {reader.releaseLock();}}
        else if (response.body && !response.body.locked) await response.body.cancel();
      }
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, offset)));
    };
    if (!validId(text.documentId) || !validId(text.activeLayerId)) throw Error('ORDINARY_TEXT_SOURCE_ID');
    const before = await read('/api/v1/documents/' + text.documentId), document = before.projection?.kind === 'inline' ? before.projection.value : null;
    if (!document || document.id !== text.documentId || before.entityVersion !== document.revision || !/^(0|[1-9][0-9]{0,39})$/.test(document.revision)) throw Error('ORDINARY_TEXT_DOCUMENT');
    const value = await read('/api/v1/documents/' + document.id + '/text?layerId=' + text.activeLayerId + '&revision=' + document.revision);
    if (value.documentRevision !== document.revision || !/^(0|[1-9][0-9]{0,39})$/.test(value.layerVersion)) throw Error('ORDINARY_TEXT_LAYER_VERSION');
    const after = await read('/api/v1/documents/' + document.id);
    if (after.projection?.kind !== 'inline' || after.projection.value.revision !== document.revision || JSON.stringify(after.projection.value.image) !== JSON.stringify(document.image)) throw Error('ORDINARY_TEXT_ROOT_CHANGED');
    if (!validId(document.image?.compositeAssetId)) throw Error('ORDINARY_TEXT_COMPOSITE');
    const compositeResponse = await read('/api/v1/assets/' + document.image.compositeAssetId), composite = compositeResponse.projection?.kind === 'inline' ? compositeResponse.projection.value : null;
    if (!composite || composite.id !== document.image.compositeAssetId || compositeResponse.entityVersion !== composite.version || !/^sha256:[a-f0-9]{64}$/.test(composite.blob?.hash ?? '') || !/^[1-9][0-9]*$/.test(composite.blob?.byteLength ?? '')) throw Error('ORDINARY_TEXT_COMPOSITE_IDENTITY');
    const source = value.source;
    if (!source?.text || !source?.render || !Array.isArray(source.text.fonts) || source.text.fonts.length > 16) throw Error('ORDINARY_TEXT_SOURCE');
    let receipt = null;
    if (commandId !== null) {
      if (!validId(commandId)) throw Error('ORDINARY_TEXT_COMMAND');
      const result = await read('/api/v1/commands/' + commandId);
      if (result.receipt?.status !== 'accepted' || result.receipt.commandId !== commandId || result.receipt.documentRevision !== document.revision) throw Error('ORDINARY_TEXT_RECEIPT');
      receipt = result.receipt;
    }
    return {accepted: {documentId: document.id, documentRevision: document.revision, layerId: text.activeLayerId, layerVersion: value.layerVersion,
      sourceHash: source.text.textUtf8.hash, dependencyHash: source.render.dependencyHash, rasterHash: source.render.pixels.hash,
      width: source.render.width, height: source.render.height, fontFaces: source.text.fonts.length,
      fontBytes: source.text.fonts.reduce((total, font) => total + Number(font.bytes.byteLength), 0),
      imageState: document.image.state, documentWidth: document.width, documentHeight: document.height,
      compositeAssetId: document.image.compositeAssetId, compositeVersion: composite.version, compositeBlob: composite.blob,
      compositeState: {purpose: composite.purpose, qualification: composite.qualification, measuredMediaType: composite.measuredMediaType, safety: composite.safety, availability: composite.availability},
      compositeRaster: composite.raster ? {schemaVersion: composite.raster.schemaVersion, pipeline: composite.raster.pipeline, width: composite.raster.width, height: composite.raster.height,
        manifest: composite.raster.manifest, pixels: composite.raster.pixels, pixelIdentity: composite.raster.pixelIdentity, role: composite.raster.role} : null}, receipt};
    } finally {clearTimeout(timeout); aborter.abort(); owners.delete(nonce); if (!owners.size) delete globalThis.__IDEOGRAM_ORDINARY_READS__;}
  }, {text: {documentId: text.documentId, activeLayerId: text.activeLayerId}, commandId, maximum: ORDINARY_TEXT_LIMITS.publicJSON, nonce});
  signal?.throwIfAborted(); canonicalComposite(value.accepted); return value;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await page.evaluate(n => {const owners = globalThis.__IDEOGRAM_ORDINARY_READS__, owner = owners?.get(n); if (owner) {owner.abort(); owners.delete(n); if (!owners.size) delete globalThis.__IDEOGRAM_ORDINARY_READS__;}}, nonce);
  }
}

async function nativeState(page) {
  return page.evaluate(async maximum => {
    const editor = document.querySelector('#native-text-editor'), node = document.querySelector('#native-text-content');
    if (!editor || !node || editor.hidden || !node.isConnected) return {active: false};
    const value = node.value;
    for (const scalar of value) {const point = scalar.codePointAt(0); if (point >= 0xd800 && point <= 0xdfff) throw Error('ORDINARY_TEXT_NATIVE_UNICODE');}
    if (value.length > maximum || new TextEncoder().encode(value).byteLength > maximum) throw Error('ORDINARY_TEXT_NATIVE_BOUND');
    const attr = name => editor.getAttribute(name) ?? '', integer = name => {const v = attr(name); return /^(0|[1-9][0-9]*)$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;};
    const pin = async bytes => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    const identities = () => ({active: true, documentId: attr('data-text-document-id'), documentRevision: attr('data-text-document-revision'),
      layerId: attr('data-text-layer-id'), layerVersion: attr('data-text-layer-version'), sessionId: attr('data-text-session-id'), draftId: attr('data-session'),
      generation: integer('data-text-generation'), savedGeneration: integer('data-text-saved-generation')});
    const before = identities(), sourceHash = await pin(new TextEncoder().encode(value));
    const previewIdentity = () => attr('data-preview-id') ? {id: attr('data-preview-id'), generation: integer('data-preview-generation'), layerVersion: attr('data-preview-layer-version'),
      textHash: attr('data-preview-text-hash'), dependencyHash: attr('data-preview-dependency-hash'), rasterHash: attr('data-preview-raster-hash'),
      width: integer('data-preview-width'), height: integer('data-preview-height')} : null;
    const preview = previewIdentity(); let canvas = null;
    const painted = document.querySelector('#native-text-preview');
    if (preview && painted) {
      if (!Number.isSafeInteger(painted.width) || !Number.isSafeInteger(painted.height) || painted.width < 1 || painted.height < 1 || painted.width * painted.height > 1048576) throw Error('ORDINARY_TEXT_PREVIEW_BOUND');
      const pixels = painted.getContext('2d').getImageData(0, 0, painted.width, painted.height).data;
      canvas = {width: painted.width, height: painted.height, sha256: await pin(pixels)};
    }
    const after = identities(), stable = v => ({...v, savedGeneration: null});
    const saved = (before.savedGeneration === null || Number.isSafeInteger(before.savedGeneration) && before.savedGeneration <= before.generation) &&
      (after.savedGeneration === null ? before.savedGeneration === null : Number.isSafeInteger(after.savedGeneration) && after.savedGeneration <= after.generation &&
        (before.savedGeneration === null || after.savedGeneration >= before.savedGeneration));
    if (!saved || !node.isConnected || document.querySelector('#native-text-content') !== node || node.value !== value || JSON.stringify(stable(before)) !== JSON.stringify(stable(after)) || JSON.stringify(preview) !== JSON.stringify(previewIdentity()) || preview && (document.querySelector('#native-text-preview') !== painted || painted?.width !== canvas?.width || painted?.height !== canvas?.height)) throw Error('ORDINARY_TEXT_NATIVE_CHANGED');
    return {...after, sourceHash, preview, canvas};
  }, ORDINARY_TEXT_LIMITS.state);
}

async function snapshot(page) {
  const state = await nativeState(page);
  const result = await readPhaseSnapshot(page, owner => {
    const value = owner?.value;
    if (!value?.trace || !value?.workerObservations) throw Error('ORDINARY_TEXT_PHASES_MISSING');
    return {timeOrigin: performance.timeOrigin, observedMs: performance.now(), productPhases: {schemaVersion: value.schemaVersion, trace: value.trace, workerObservations: value.workerObservations,
      navigation: value.navigation ?? null}};
  });
  const after = await nativeState(page), stable = value => ({...value, savedGeneration: null});
  same(stable(state), stable(after), 'Ordinary text state changed while reading its owned diagnostics');
  demand(state.active !== true || (after.savedGeneration === null ? state.savedGeneration == null : state.savedGeneration == null || after.savedGeneration >= state.savedGeneration),
    'Ordinary text saved generation moved backwards');
  return {...result, state: after};
}

function navigationObservation(step, fixture) {
  const value = step.after?.productPhases?.navigation, root = step.after?.accepted, before = step.before;
  demand(value?.schemaVersion === 1 && finite(step.after.timeOrigin) && finite(before?.timeOrigin) && before.timeOrigin !== step.after.timeOrigin &&
    value.navigationTimeOriginMs === step.after.timeOrigin, 'Current navigation realm is unavailable');
  same(root, before.accepted, 'Navigation changed the accepted document/layer root');
  for (const key of ['documentId', 'layerId', 'sourceHash', 'rasterHash', 'fontFaces', 'fontBytes']) same(root?.[key], fixture[key], 'Navigation fixture source differs: ' + key);
  const identity = value.identity;
  demand(identity?.documentId === fixture.documentId && identity.revision === root?.documentRevision && identity.assetId === root?.compositeAssetId &&
    identity.assetHash === root?.imageState?.hash && ID.test(identity.sessionId ?? '') && Number.isSafeInteger(identity.generation) && identity.generation >= 0 &&
    ID.test(identity.snapshotId ?? ''), 'Navigation root/session/generation differs');
  const composite = canonicalComposite(root);
  demand(value.viewportCurrent === true && value.editAvailable === true && step.after.editControl?.visible === true && step.after.editControl?.enabled === true,
    'Current canonical viewport and public edit control are unavailable');
  demand(value.modelMeaning === 'stored-authoritative-model' && value.editMeaning === 'shell-committed-document-controls' && value.presentationEvidence === 'external-trace-required' &&
    value.milestonePolicy === 'current-availability-episode' && ['canonical-canvas-render-submitted', 'canonical-resident-submission-observed'].includes(value.renderMeaning), 'Navigation endpoint meaning is unavailable');
  const clocks = [value.modelReadyMs, value.renderSubmittedMs, value.editAvailableMs];
  demand(clocks.every(finite) && clocks[2] >= Math.max(clocks[0], clocks[1]) && step.after.observedMs >= Math.max(...clocks), 'Navigation application endpoints are incomplete');
  return {kind: 'retained-layout-navigation-observation-1', identity, canonicalComposite: composite, navigationTimeOriginMs: value.navigationTimeOriginMs,
    qualification: false, physicalPresentation: false, freshAllTextLayout: false, phases: [
      ['document.recovery.model-ready', value.modelReadyMs, 'Authoritative complete model recovery in this navigation; retained layouts are not fresh shaping.'],
      ['document.viewport.canonical-ready', value.renderSubmittedMs, value.renderMeaning === 'canonical-canvas-render-submitted' ?
        'Exact accepted canonical composite submitted by this app; no first-presented-frame claim.' :
        'Already submitted exact canonical composite observed resident; no fresh decode/submission or first-ready claim.'],
      ['document.controls.edit-available', value.editAvailableMs, 'Current document entry controls committed by the app and observed publicly enabled; no physical focus/paint claim.'],
    ].map(([name, endMs, scope]) => ({name, startMs: 0, endMs, durationMs: null, upperBoundMs: endMs, clock: 'browser-performance', timeOrigin: value.navigationTimeOriginMs,
      boundary: 'observed-current-availability', outcome: 'incomplete', scope, context: identity, milestonePolicy: value.milestonePolicy,
      renderMeaning: value.renderMeaning, ceilingBreachProvesFailure: false, physicalPresentation: false}))};
}

/** Pure replay of retained application observations, not an authority issuer.
 * Missing children never turn into zero violations or a physical claim. */
export function inspectOrdinaryTextRaw(raw, binding, {fontInvariantProof} = {}) {
  const missing = [], failures = [], phases = [], measurements = [], children = [];
  demand(raw?.kind === 'ordinary-text-raw-1' && raw.nonce === binding.nonce && Array.isArray(raw.steps) && raw.steps.length <= ORDINARY_TEXT_LIMITS.steps && Array.isArray(raw.missing), 'Malformed ordinary text observation');
  same(raw.binding, binding.attempt, 'Ordinary text raw attempt differs');
  missing.push(...raw.missing);
  if (!finite(raw.startedMs) || !finite(raw.endedMs) || raw.endedMs < raw.startedMs || raw.clock !== 'runner-monotonic') missing.push('Ordinary text observation interval unavailable');
  if (raw.steps.length !== 1) missing.push('One original ordinary text operation was not completely observed');
  let draftProof;
  for (const step of raw.steps) {
    if (step.kind === 'navigation') {
      demand(binding.operation === 'text.mixed-ready', 'Navigation observation belongs to another operation');
      try {const value = navigationObservation(step, binding.textFixture); phases.push(...value.phases); children.push(value);}
      catch (error) {missing.push(error.message);}
      missing.push('Fresh navigation-wide all-text shaping and actual presented canonical viewport are separately unavailable');
    } else {
      demand(step.kind === (binding.operation === 'text.apply' ? 'apply' : 'preview'), 'Ordinary action kind differs');
      if (!step.identity || !step.before?.accepted) {missing.push('Actual ordinary text source binding unavailable'); continue;}
      for (const key of ['documentId', 'layerId', 'sourceHash', 'rasterHash', 'fontFaces', 'fontBytes']) same(step.identity[key], binding.textFixture[key], 'Ordinary text fixture field differs: ' + key);
      const accepted = step.before.accepted;
      for (const key of ['documentId', 'documentRevision', 'layerId', 'layerVersion', 'sourceHash', 'dependencyHash', 'rasterHash', 'width', 'height', 'fontFaces', 'fontBytes']) same(step.identity[key], accepted[key], 'Ordinary text actual accepted source differs: ' + key);
      if (step.kind === 'preview') same(step.after?.accepted, accepted, 'Preview changed the accepted document/layer root');
      const value = inspectOrdinaryTextObservation({operation: binding.operation, binding: step.identity, before: step.before, after: step.after});
      phases.push(...(value.phases ?? [])); missing.push(...(value.missing ?? [])); failures.push(...(value.failures ?? [])); children.push(value);
      if (step.kind === 'preview' && value.status === 'PASS') draftProof = value.evidence;
    }
  }
  // Current-root evidence owns these three state metrics. An open draft needs
  // independently admitted unchanged preview lineage; this is not a peak ledger.
  if (raw.fonts) {
    if (raw.fonts.before && raw.fonts.after) {
      const step = raw.steps[0], accepted = step?.after?.accepted;
      demand(raw.fonts.before.documentId === binding.textFixture.documentId && raw.fonts.before.revision === accepted?.documentRevision && raw.fonts.after.revision === accepted?.documentRevision, 'Font inventory belongs to another document revision');
      same(raw.fonts.before.imageState, accepted.imageState, 'Font inventory image root differs'); same(raw.fonts.after.imageState, accepted.imageState, 'Font inventory final image root differs');
      demand(raw.fonts.timeOrigin === step.after.timeOrigin && raw.fonts.startMs >= step.after.observedMs, 'Font accounting precedes this action or belongs to another realm');
    }
    const value = inspectCurrentDocumentFonts(raw.fonts, binding.attempt, {draftProof});
    measurements.push(...value.measurements); missing.push(...value.missing); children.push({kind: 'current-document-font-accounting-1', ...value});
    // The current-root/font-file proof and independently admitted open preview
    // lineage remain prerequisites. Sidecar validation cannot bypass either.
    const invariant = !value.missing.length && value.measurements.length === 3
      ? ordinaryFontInvariantMeasurement({fonts: raw.fonts, evidence: raw.fontInvariant, proof: fontInvariantProof}) : null;
    if (invariant) measurements.push(invariant);
    else missing.push('Accepted-source declared-font invariant lacks complete immutable source/layout/text/font replay');
  } else missing.push('Complete closed-editor current-document font accounting is unavailable');
  return {kind: 'ordinary-text-analysis-1', qualification: false, physicalPresentation: false, scanout: false, freshAllTextLayout: false,
    measurements, phases, children, missing: [...new Set(missing)], failures: [...new Set(failures)]};
}

function measurementRows(analysis, artifact) {
  return analysis.measurements.map(row => ({...row, evidence: [{kind: 'ordinary-text-retained-observation-1', artifact}]}));
}
export function ordinaryTextMeasurement({cell, sample, rule, proof}) {
  const value = proof && proofs.get(proof);
  if (!value || value.binding.operation !== cell?.operation || value.binding.attempt.cellId !== cell?.id || value.binding.attempt.cache !== sample?.cache || value.binding.attempt.ordinal !== sample?.ordinal || value.binding.attempt.prime !== Boolean(sample?.prime)) return {reason: 'Current owned ordinary-text observation proof unavailable'};
  const row = value.measurements.find(item => item.name === rule.name);
  if (!row || rule.budgetId !== 'R35' || rule.unit !== row.unit) return {reason: 'Exact ordinary-text registry row is not established by this observation'};
  return {measurement: structuredClone(row)};
}
export function readOrdinaryTextProof(proof) {const value = proof && proofs.get(proof); return value ? {phases: structuredClone(value.analysis.phases), observation: structuredClone(value.observation)} : null;}

/** Called only by the owned browser driver. It observes existing actions and
 * cannot add Preview, Apply, Cancel, navigation, input or layout work. */
export function createOrdinaryTextObserver({page, repo, root, cell, sample, serial, fixture, runtime, environment, processIdentity, output, signal, journal}) {
  demand(ORDINARY_TEXT_OPERATIONS.includes(cell.operation), 'Ordinary text cell required');
  const nonce = randomBytes(16).toString('hex'), prefix = 'ordinary-text-' + nonce;
  const binding = {kind: 'ordinary-text-binding-1', nonce, operation: cell.operation,
    attempt: {cellId: cell.id, id: attemptIdentity(cell, sample.cache, sample.ordinal, sample.prime), cache: sample.cache, ordinal: sample.ordinal, prime: Boolean(sample.prime), serial},
    fixtureSeal: fixture.seal, textFixture: textFixtureIdentity(fixture), environment, processIdentity, runtime};
  const raw = {kind: 'ordinary-text-raw-1', nonce, binding: binding.attempt, clock: 'runner-monotonic', startedMs: performance.now(), endedMs: null, steps: [], fonts: null, fontInvariant: null, missing: []};
  let live = true, stepping = false, finished = false, fontInvariantProof;
  const retain = async (name, value, maximum) => {const bytes = encode(value); demand(bytes.length <= maximum, 'Ordinary text artifact bound'); const path = prefix + '-' + name + '.json'; await writeFile(join(output, path), bytes, {mode: 0o600, flag: 'wx'}); return {path, bytes: bytes.length, sha256: digest(bytes)};};
  return {
    async step(kind, action) {
      demand(live && !stepping && raw.steps.length < ORDINARY_TEXT_LIMITS.steps && ['preview', 'apply', 'navigation'].includes(kind), 'Ordinary text observer lifecycle');
      stepping = true; const step = {kind, identity: null, before: null, after: null}; raw.steps.push(step);
      let captured = null, captures = 0, listener;
      try {
        signal?.throwIfAborted();
        const current = await readOrdinaryTextPublicState(page, fixture.text, null, signal);
        step.before = await snapshot(page);
        step.before.accepted = current.accepted;
        const state = step.before.state;
        if (kind !== 'navigation') step.identity = {actionId: kind === 'apply' ? state.preview?.id : null, documentId: state.documentId, documentRevision: state.documentRevision,
          layerId: state.layerId, layerVersion: state.layerVersion, sessionId: state.sessionId, draftId: state.draftId, generation: state.generation,
          sourceHash: fixture.text.corpus.sha256, dependencyHash: current.accepted.dependencyHash, rasterHash: fixture.text.expectedPreviewHash,
          width: current.accepted.width, height: current.accepted.height, fontFaces: current.accepted.fontFaces, fontBytes: current.accepted.fontBytes};
        if (kind === 'apply') {
          listener = request => {
            if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/v1/commands') return;
            try {const data = request.postData(); if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) return; const command = JSON.parse(data)?.command;
              if (!['CreateTextLayer', 'CommitTextEdit', 'ReplaceTextFont'].includes(command?.body?.type)) return;
              captures++; captured = {commandId: command.commandId, correlationId: command.correlationId, draft: command.body.draft};
            } catch {captures++;}
          };
          page.on('request', listener);
        }
      } catch (error) {raw.missing.push('Ordinary text pre-action observation unavailable: ' + String(error.message).slice(0, 256));}
      let result;
      try {signal?.throwIfAborted(); result = await action();}
      finally {
        if (listener) page.off('request', listener);
        try {
          signal?.throwIfAborted();
          step.after = await snapshot(page);
          if (kind === 'navigation') {
            // Only observe the existing reload's real application endpoints.
            // No extra navigation, layout, focus or input may satisfy them.
            const started = performance.now();
            while ((!step.after.productPhases.navigation?.viewportCurrent || !step.after.productPhases.navigation?.editAvailable) && performance.now() - started < 20000) {
              await intervalWait(10, signal); step.after = await snapshot(page);
            }
          }
          if (kind === 'preview' && step.identity) step.identity.actionId = step.after.state.preview?.id ?? null;
          if (kind === 'apply') {
            demand(captures === 1 && captured && ID.test(captured.commandId), 'Exact original Apply command is unavailable');
            const current = await readOrdinaryTextPublicState(page, fixture.text, captured.commandId, signal);
            step.after.accepted = current.accepted;
            step.after.receipt = {...captured, transactionId: current.receipt.transactionId, resultingRevision: current.receipt.documentRevision};
          } else step.after.accepted = (await readOrdinaryTextPublicState(page, fixture.text, null, signal)).accepted;
          if (kind === 'navigation') {
            const accepted = step.after.accepted, entry = page.getByRole('button', {name: 'Text', exact: true});
            const editControl = {visible: await entry.isVisible(), enabled: await entry.isEnabled()};
            // Refresh the application gate after public source/control reads so
            // a lost viewport or successor root cannot reuse the earlier row.
            step.after = {...await snapshot(page), accepted, editControl};
          }
          raw.fonts = await collectCurrentDocumentFonts({page, documentId: fixture.text.documentId,
            fontAssetIds: fixture.native?.fontAssetIds ?? [], binding: binding.attempt, signal});
          try {
            const invariant = await collectOrdinaryFontInvariant({repo, root, fonts: raw.fonts, nonce, output, signal});
            raw.fontInvariant = invariant.evidence; fontInvariantProof = invariant.proof;
          } catch {raw.missing.push('Accepted-source declared-font invariant immutable inputs or validation unavailable');}
        } catch (error) {raw.missing.push('Ordinary text post-action observation unavailable: ' + String(error.message).slice(0, 256));}
        stepping = false;
      }
      return result;
    },
    async finish() {
      demand(live && !stepping && !finished, 'Ordinary text observer did not settle'); live = false; finished = true; raw.endedMs = performance.now();
      const bindingArtifact = await retain('binding', binding, ORDINARY_TEXT_LIMITS.binding), artifact = await retain('raw', raw, ORDINARY_TEXT_LIMITS.raw);
      const analysis = inspectOrdinaryTextRaw(raw, binding, {fontInvariantProof});
      const observation = {kind: 'ordinary-text-observation-1', nonce, binding: bindingArtifact, raw: artifact, analysis, qualification: false, physicalPresentation: false};
      const measurements = measurementRows(analysis, {...artifact, path: join(output, artifact.path)}), proof = Object.freeze({}); proofs.set(proof, {binding, observation, analysis, measurements});
      await journal?.({event: 'ordinary-text-observed', cellId: cell.id, nonce, binding: bindingArtifact, raw: artifact});
      return {proof, observation};
    },
  };
}

/** Exact byte replay is mandatory before any serialized ordinary-text metric
 * can enter a campaign summary. This issuer grants no physical authority. */
export async function verifyOrdinaryTextEvidence({attempt, cell, serial, fixture, environment, workerProcessIdentity, groupOutput, retainedFiles, readRetained, controlFiles, sourceFiles, sourceRoot, browserCache, tools, developerState, developerStateIdentity, journalEvents}) {
  if (!ORDINARY_TEXT_OPERATIONS.includes(cell?.operation)) return null;
  const observation = attempt.result?.observations?.ordinaryText;
  if (!observation) {demand(!(attempt.result?.measurements ?? []).some(row => registryNames.has(row.name)) && !(attempt.result?.phases ?? []).some(row => observedPhaseNames.has(row.name)), 'Ordinary text measurements lack replay evidence'); return null;}
  demand(observation.kind === 'ordinary-text-observation-1' && observation.qualification === false && observation.physicalPresentation === false && /^[a-f0-9]{32}$/.test(observation.nonce ?? ''), 'Ordinary text scope or nonce differs');
  const seals = new Map(retainedFiles.map(file => [file.path, file])), prefix = 'ordinary-text-' + observation.nonce;
  const read = async (identity, name, maximum) => {
    demand(identity?.path === prefix + '-' + name + '.json' && Number.isSafeInteger(identity.bytes) && identity.bytes > 0 && identity.bytes <= maximum && SHA.test(identity.sha256), 'Ordinary text retained member differs');
    const seal = seals.get(identity.path); demand(seal?.bytes === identity.bytes && seal.sha256 === identity.sha256, 'Ordinary text outer seal differs');
    const bytes = await readRetained(identity.path, {maximum}); demand(bytes.length === identity.bytes && digest(bytes) === identity.sha256, 'Ordinary text retained bytes differ'); return decode(bytes);
  };
  const binding = await read(observation.binding, 'binding', ORDINARY_TEXT_LIMITS.binding), raw = await read(observation.raw, 'raw', ORDINARY_TEXT_LIMITS.raw);
  demand(binding.kind === 'ordinary-text-binding-1' && binding.nonce === observation.nonce && binding.operation === cell.operation, 'Ordinary text binding differs');
  same(binding.attempt, {cellId: cell.id, id: attempt.id, cache: attempt.cache, ordinal: attempt.ordinal, prime: attempt.prime, serial}, 'Ordinary text scheduled attempt differs');
  same(binding.fixtureSeal, fixture.seal, 'Ordinary text fixture differs'); same(binding.environment, environment, 'Ordinary text source/build identity differs'); same(binding.processIdentity, workerProcessIdentity, 'Ordinary text worker differs');
  same(binding.textFixture, textFixtureIdentity(fixture), 'Ordinary text sealed fixture identities differ');
  demand(workerProcessIdentity?.node === 'v26.10.0' && workerProcessIdentity.pid > 1 && finite(attempt.startMs) && finite(attempt.endMs) && raw.startedMs >= attempt.startMs && raw.endedMs <= attempt.endMs, 'Ordinary text worker clock window differs');
  // core.sourceIdentity supplies bare source/control hashes. Build, tool and
  // retained-artifact identities use common.digest's explicit sha256 prefix.
  demand(['sourceDigest', 'controlDigest'].every(key => SOURCE_SHA.test(environment?.[key] ?? '')) &&
    ['buildDigest', 'toolsDigest'].every(key => SHA.test(environment?.[key] ?? '')), 'Ordinary text executable bindings missing');
  for (const name of ['browser.mjs', 'browser-text.mjs', 'browser-ordinary-text.mjs', 'browser-text-fonts.mjs', 'browser-text-invariant.mjs', 'ordinary-text-phases.mjs', 'browser-measurements.mjs', 'worker.mjs', 'run.mjs', 'verification.mjs']) demand(controlFiles?.some(file => file.path === 'tooling/qualification/campaigns/' + name && SOURCE_SHA.test(file.sha256)), 'Ordinary text control source closure missing: ' + name);
  for (const name of ['src/ui/native-text.ts', 'src/ui/shell.ts', 'src/state/editor-client.ts', 'src/observability/browser.ts', 'src/observability/navigation-observations.ts']) demand(sourceFiles?.some(file => file.path === name && SOURCE_SHA.test(file.sha256)), 'Ordinary text application source closure missing: ' + name);
  demand(controlFiles?.some(file => file.path === 'tooling/qualification/evidence-volume.mjs' && SOURCE_SHA.test(file.sha256)), 'Ordinary font invariant evidence allocation control closure missing');
  for (const name of ORDINARY_FONT_INVARIANT_SOURCE_FILES) demand(sourceFiles?.some(file => file.path === name && SOURCE_SHA.test(file.sha256)), 'Ordinary font invariant validator source closure missing: ' + name);
  const runtime = decode(await readRetained('browser-runtime.json', {maximum: 1024 * 1024})); same(binding.runtime, runtime, 'Ordinary text actual browser differs'); same(runtime.fixtureSeal, fixture.seal, 'Ordinary text browser fixture differs');
  demand(runtime.ownedLaunch?.context?.createdBy === 'browser.newContext' && runtime.browserPid > 1 && runtime.backendPid > 1 && runtime.playwrightModule?.startsWith(join(sourceRoot, 'node_modules') + sep) && runtime.executable?.startsWith(browserCache + sep), 'Ordinary text owned browser path differs');
  const pins = tools?.browserPins?.browsers?.filter(pin => pin.name === runtime.engine);
  demand(pins?.length === 1 && pins[0].revision === runtime.revision && pins[0].browserVersion === runtime.version && SHA.test(runtime.executableIdentity?.sha256 ?? ''), 'Ordinary text browser version pin differs');
  demand(developerState?.kind === 'developer-runtime-state-1' && digest(JSON.stringify(developerState.state, null, 2) + '\n').slice(7) === developerState.sha256?.replace(/^sha256:/, '') && SHA.test(developerStateIdentity?.sha256 ?? ''), 'Ordinary text prepared executable evidence is missing');
  const state = developerState.state, workspace = state.h?.source === sourceRoot ? state.h : state.p;
  const completed = workspace === state.h ? workspace?.completed === true : workspace?.completed?.includes('production-build') && workspace.completed.includes('browser-cache');
  demand(completed && !workspace.failure && !workspace.active && state.productRepo === sourceRoot && workspace.source === sourceRoot && state.sourceDigest === environment.sourceDigest, 'Ordinary text prepared source differs');
  const selectedCache = state.playwrightBrowsersPath ?? workspace.browserCache, prepared = workspace.browserIdentity?.engines?.filter(value => value.engine === runtime.engine);
  demand(selectedCache === browserCache && prepared?.length === 1 && prepared[0].executable === runtime.executable && prepared[0].version === runtime.version && prepared[0].revision === runtime.revision &&
    prepared[0].bytes === runtime.executableIdentity.bytes && prepared[0].sha256?.replace(/^sha256:/, '') === runtime.executableIdentity.sha256.slice(7), 'Ordinary text browser immutable preparation differs');
  for (const kind of ['browser', 'backend']) {
    const pid = runtime[kind + 'Pid'], entries = retainedFiles.filter(file => new RegExp('^owned-process-' + pid + '-[a-f0-9-]{36}\\.json$').test(file.path));
    demand(entries.length === 1, 'Ordinary text process ownership missing'); const record = decode(await readRetained(entries[0].path, {maximum: 65536})), process = record.processes?.[0];
    demand(record.ownerPid === workerProcessIdentity.pid && record.kind === 'perf-owned-processes-1' && record.processes?.length === 1 && process.kind === kind && process.pid === pid && process.pgid > 1, 'Ordinary text process ownership differs');
    if (kind === 'browser') demand(runtime.ownedLaunch.process?.registration?.path === join(groupOutput, entries[0].path) && runtime.ownedLaunch.process?.startedAtIdentity === process.startedAtIdentity && process.executable === runtime.executable, 'Ordinary text browser launch differs');
  }
  const events = journalEvents.filter(event => event.event === 'ordinary-text-observed' && event.nonce === observation.nonce && event.cellId === cell.id);
  demand(events.length === 1 && events[0].monotonicMs >= raw.endedMs && events[0].monotonicMs <= attempt.endMs, 'Ordinary text journal closure differs'); same(events[0].binding, observation.binding, 'Ordinary text journal binding differs'); same(events[0].raw, observation.raw, 'Ordinary text journal raw differs');
  const fontInvariantProof = raw.fontInvariant ? await replayOrdinaryFontInvariant({repo: sourceRoot, fonts: raw.fonts, nonce: binding.nonce, output: groupOutput,
    evidence: raw.fontInvariant, readRetained, retainedFiles}) : undefined;
  const analysis = inspectOrdinaryTextRaw(raw, binding, {fontInvariantProof}); same(analysis, observation.analysis, 'Ordinary text analysis differs');
  demand(!analysis.failures.length || attempt.status === 'FAIL' && attempt.result.status === 'FAIL', 'Ordinary text observed contradiction was not reported as failure');
  demand(!analysis.missing.length || attempt.status !== 'PASS' && attempt.result.status !== 'PASS', 'Ordinary text missing observations were reported complete');
  const measurements = measurementRows(analysis, {...observation.raw, path: join(groupOutput, observation.raw.path)});
  same((attempt.result.measurements ?? []).filter(row => registryNames.has(row.name)), measurements.filter(row => (cell.requiredMeasurements ?? []).some(rule => rule.name === row.name)), 'Ordinary text published measurements differ');
  same((attempt.result.phases ?? []).filter(row => observedPhaseNames.has(row.name)), analysis.phases, 'Ordinary text published phases differ');
  const proof = Object.freeze({}); proofs.set(proof, {binding, observation, analysis, measurements}); return proof;
}
