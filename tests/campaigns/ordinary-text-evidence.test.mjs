import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOrdinaryTextObserver, inspectOrdinaryTextRaw, ordinaryTextMeasurement, readOrdinaryTextProof, verifyOrdinaryTextEvidence, readOrdinaryTextPublicState, ORDINARY_TEXT_LIMITS} from '../../tooling/qualification/campaigns/browser-ordinary-text.mjs';
import {extractBrowserMeasurements} from '../../tooling/qualification/campaigns/browser-measurements.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const compositeFields = () => ({documentWidth: 64, documentHeight: 32, compositeState: {purpose: 'image', qualification: 'canonical-raster', measuredMediaType: 'image/png', safety: 'safe', availability: 'available'},
  compositeRaster: {schemaVersion: 1, pipeline: 'cp1-f64-triangle-area-v1/' + hash('pipeline'), width: 64, height: 32, role: 'composite',
    manifest: {hash: hash('manifest'), byteLength: '100', mediaType: 'application/json'}, pixels: {hash: hash('composite-pixels'), byteLength: '8192', mediaType: 'application/x-ideogram-rgba8'}, pixelIdentity: hash('composite-identity')}});
// Synthetic retained-byte fixture for the verifier. It is not a browser run,
// physical measurement, operator review, or campaign qualification receipt.
function packet() {
  const nonce = '1'.repeat(32), output = '/evidence/group', sourceRoot = '/product', browserCache = '/cache';
  const cell = {id: 'I10H/WXn-active-layout', operation: 'text.active-layout', workload: 'WXn', requiredMeasurements: []};
  const attempt = {id: cell.id + '/cold/scored/1', cache: 'cold', ordinal: 1, prime: false, startMs: 10, endMs: 500, status: 'INCONCLUSIVE', result: {observations: {}, measurements: [], phases: []}};
  const fixture = {seal: {path: '/original/fixture.json', bytes: 10, sha256: hash('fixture')}, text: {documentId: 'doc', activeLayerId: 'layer', corpus: {sha256: hash('Text')}, expectedPreviewHash: hash('pixels'), fonts: [{bytes: 1024}]}};
  const environment = {sourceDigest: hash('source').slice(7), buildDigest: hash('build'), toolsDigest: hash('tools'), controlDigest: hash('control').slice(7)};
  const workerProcessIdentity = {pid: 99, node: 'v26.10.0', startedAt: '2026-01-01T00:00:00Z'};
  const uuid = '12345678-1234-1234-1234-123456789abc', browserRegistration = 'owned-process-100-' + uuid + '.json';
  const browserProcess = {kind: 'browser', pid: 100, pgid: 100, executable: '/cache/chromium/browser', startedAtIdentity: 'real-identity'};
  const runtime = {engine: 'chromium', browserPid: 100, backendPid: 101, fixtureSeal: fixture.seal, executable: browserProcess.executable,
    revision: '1243', version: '153.0.8010.12', executableIdentity: {bytes: 123, sha256: hash('browser')}, playwrightModule: '/product/node_modules/playwright-core/index.mjs',
    ownedLaunch: {context: {createdBy: 'browser.newContext'}, process: {...browserProcess, registration: {path: output + '/' + browserRegistration}}}};
  const tools = {browserPins: {browsers: [{name: runtime.engine, revision: runtime.revision, browserVersion: runtime.version}]}};
  const prepared = {engine: runtime.engine, executable: runtime.executable, version: runtime.version, revision: runtime.revision, ...runtime.executableIdentity};
  const state = {sourceDigest: environment.sourceDigest, productRepo: sourceRoot, playwrightBrowsersPath: browserCache,
    h: {source: sourceRoot, completed: true, browserIdentity: {engines: [prepared]}}};
  const developerState = {kind: 'developer-runtime-state-1', state, sha256: hash(JSON.stringify(state, null, 2) + '\n')};
  const developerStateIdentity = {sha256: hash('prepared-envelope')};
  const binding = {kind: 'ordinary-text-binding-1', nonce, operation: cell.operation,
    attempt: {cellId: cell.id, id: attempt.id, cache: 'cold', ordinal: 1, prime: false, serial: 1}, fixtureSeal: fixture.seal,
    textFixture: {documentId: 'doc', layerId: 'layer', sourceHash: hash('Text'), rasterHash: hash('pixels'), fontFaces: 1, fontBytes: 1024}, environment, processIdentity: workerProcessIdentity, runtime};
  const identity = {actionId: 'preview', documentId: 'doc', documentRevision: '3', layerId: 'layer', layerVersion: '2', sessionId: 'session', draftId: 'draft', generation: 7,
    sourceHash: hash('Text'), dependencyHash: hash('dependency'), rasterHash: hash('pixels'), width: 20, height: 10, fontFaces: 1, fontBytes: 1024};
  const accepted = {documentId: 'doc', documentRevision: '3', layerId: 'layer', layerVersion: '2', sourceHash: identity.sourceHash, dependencyHash: identity.dependencyHash,
    rasterHash: identity.rasterHash, width: 20, height: 10, fontFaces: 1, fontBytes: 1024, ...compositeFields(), imageState: {hash: hash('image')}, compositeAssetId: 'composite', compositeVersion: '1', compositeBlob: {hash: hash('canonical-png'), byteLength: '200', mediaType: 'image/png'}};
  const native = {active: true, ...Object.fromEntries(['documentId','documentRevision','layerId','layerVersion','sessionId','draftId','generation','sourceHash'].map(key => [key, identity[key]])), savedGeneration: 7, preview: null, canvas: null};
  const trace = (lane, records = [], origin = 1000) => ({schemaVersion: 1, lane, clockOriginUnixMs: origin, clockUncertaintyMs: null, dropped: 0, invalid: 0, records});
  const product = () => ({schemaVersion: 1, trace: trace('browser-main'), workerObservations: {schemaVersion: 1, traces: [], dropped: 0, invalid: 0, clockJoin: 'external-calibration-required'}, navigation: null});
  const before = {timeOrigin: 999.75, observedMs: 50, productPhases: product(), state: clone(native), accepted: clone(accepted)};
  const after = {timeOrigin: 999.75, observedMs: 220, productPhases: product(), state: clone(native), accepted: clone(accepted)};
  after.state.preview = {id: 'preview', generation: 7, layerVersion: '2', textHash: identity.sourceHash, dependencyHash: identity.dependencyHash, rasterHash: identity.rasterHash, width: 20, height: 10};
  after.state.canvas = {width: 20, height: 10, sha256: identity.rasterHash};
  const token = {documentId: 'doc', revision: '3', layerId: 'layer', sessionId: 'session', generation: 7};
  after.productPhases.trace.records.push({sequence: 1, phase: 'text.layout', startedMs: 80, endedMs: 200, durationMs: 120, outcome: 'incomplete',
    context: {...token, snapshotId: 'draft', previewId: 'preview', assetHash: identity.rasterHash, evidenceHash: identity.dependencyHash, width: 20, height: 10, boundary: 'render-submitted'}});
  after.productPhases.workerObservations.traces.push(trace('text-worker', [{sequence: 1, phase: 'font.ready', startedMs: 10, endedMs: 30, durationMs: 20, outcome: 'ok', context: {...token, count: 1, bytes: 1024, boundary: 'observed'}}], 2000));
  const raw = {kind: 'ordinary-text-raw-1', nonce, binding: clone(binding.attempt), clock: 'runner-monotonic', startedMs: 20, endedMs: 400,
    steps: [{kind: 'preview', identity, before, after}], fonts: null, missing: []};
  const files = new Map(), put = (path, value) => {const bytes = Buffer.from(JSON.stringify(value)); files.set(path, bytes); return {path, bytes: bytes.length, sha256: hash(bytes)};};
  put('browser-runtime.json', runtime); put(browserRegistration, {kind: 'perf-owned-processes-1', ownerPid: 99, processes: [browserProcess]});
  put('owned-process-101-' + uuid + '.json', {kind: 'perf-owned-processes-1', ownerPid: 99, processes: [{kind: 'backend', pid: 101, pgid: 101}]});
  const controlFiles = ['browser.mjs','browser-text.mjs','browser-ordinary-text.mjs','browser-text-fonts.mjs','ordinary-text-phases.mjs','browser-measurements.mjs','worker.mjs','run.mjs','verification.mjs'].map(name => ({path: 'tooling/qualification/campaigns/' + name, sha256: hash(name).slice(7)}));
  const sourceFiles = ['src/ui/native-text.ts','src/ui/shell.ts','src/state/editor-client.ts','src/observability/browser.ts','src/observability/navigation-observations.ts'].map(path => ({path, sha256: hash(path).slice(7)}));
  const args = {attempt, cell, serial: 1, fixture, environment, workerProcessIdentity, groupOutput: output, controlFiles, sourceFiles, sourceRoot, browserCache, tools, developerState, developerStateIdentity,
    retainedFiles: [], readRetained: async (path, {maximum}) => {assert(files.has(path)); const bytes = files.get(path); assert(bytes.length <= maximum); return bytes;}, journalEvents: []};
  const seal = () => {
    const rawArtifact = put('ordinary-text-' + nonce + '-raw.json', raw), bindingArtifact = put('ordinary-text-' + nonce + '-binding.json', binding);
    const analysis = inspectOrdinaryTextRaw(raw, binding);
    attempt.result.observations.ordinaryText = {kind: 'ordinary-text-observation-1', nonce, binding: bindingArtifact, raw: rawArtifact, analysis, qualification: false, physicalPresentation: false};
    attempt.result.phases = clone(analysis.phases);
    args.retainedFiles = [...files].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes)}));
    args.journalEvents = [{event: 'ordinary-text-observed', cellId: cell.id, nonce, binding: bindingArtifact, raw: rawArtifact, monotonicMs: 410}];
  };
  seal(); return {args, raw, binding, files, seal};
}

test('retained replay admits exact local phase evidence without physical authority', async () => {
  const p = packet(), proof = await verifyOrdinaryTextEvidence(p.args), admitted = readOrdinaryTextProof(proof);
  assert.equal(admitted.phases.length, 2); assert.equal(admitted.phases[0].durationMs, 20);
  assert.equal(admitted.phases[1].durationMs, 120); assert(admitted.phases.every(row => row.physicalPresentation === false));
  assert.equal(admitted.observation.analysis.physicalPresentation, false); assert.equal(admitted.observation.analysis.scanout, false);
  assert.equal(readOrdinaryTextProof(JSON.parse(JSON.stringify(proof))), null);
  assert.match(ordinaryTextMeasurement({cell: p.args.cell, sample: p.args.attempt, rule: {name: 'R35CurrentFontFaces', unit: 'count', budgetId: 'R35'}, proof}).reason, /not established/);
});

// Synthetic retained raw only: actual collector evaluator/stream/hash behavior
// has its own browser-text-fonts.test.mjs coverage. These bytes exercise the
// complete issuer -> strict registry adapter -> retained replay association;
// they are never claimed as a real parsed font or browser measurement.
function fullFontObservation(p) {
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
      : JSON.stringify(value);
  const ref = (bytes, mediaType = 'application/json') => ({hash: hash(bytes), byteLength: String(Buffer.byteLength(bytes)), mediaType});
  const fonts = [1024, 2048].map((length, index) => {
    const value = {schemaVersion: 1, bytes: ref(Buffer.alloc(length, index + 1), 'application/octet-stream'), faceIndex: 0,
      format: 'static-ttf', parserProfile: 'sfnt-static-1-freetype-canvaskit040', fsType: 0,
      licenseRecord: ref('Synthetic permitted font license ' + index, 'text/plain'), origin: 'local-file', embedding: 'permitted'};
    return {...value, id: hash(canonical(value))};
  });
  const step = p.raw.steps[0], identity = step.identity, imageState = ref('synthetic exact image root');
  step.before.accepted.imageState = clone(imageState); step.after.accepted.imageState = clone(imageState);
  const layers = fonts.map((font, index) => {
    const source = ref('synthetic exact text source ' + index);
    return {id: index ? 'hidden-layer' : identity.layerId, version: identity.layerVersion, kind: 'text', source,
      observedSourceHash: source.hash, observedSourceBytes: Number(source.byteLength), textVersion: hash('text-version-' + index), renderVersion: hash('render-version-' + index),
      renderer: {schemaVersion: 1, id: hash('synthetic-renderer'), manifest: ref('synthetic renderer profile')}, fontIds: [font.id],
      textHash: index ? hash('Hidden text') : identity.sourceHash, renderDependencyHash: index ? hash('hidden-dependency') : identity.dependencyHash,
      rasterHash: index ? hash('hidden-pixels') : identity.rasterHash, width: identity.width, height: identity.height};
  });
  const root = {documentId: identity.documentId, revision: identity.documentRevision, imageState, semanticDigest: hash('synthetic semantic root'),
    orderedLayerIds: layers.map(layer => layer.id), observedImageHash: imageState.hash, observedImageBytes: Number(imageState.byteLength)};
  const native = {present: true, hidden: false, session: identity.draftId, sessionId: identity.sessionId, documentId: identity.documentId,
    documentRevision: identity.documentRevision, layerId: identity.layerId, layerVersion: identity.layerVersion,
    generation: identity.generation, savedGeneration: identity.generation, preview: clone(step.after.state.preview), nativeTextHash: identity.sourceHash};
  p.raw.fonts = {kind: 'current-document-fonts-1', binding: clone(p.binding.attempt), clock: 'browser-performance', timeOrigin: step.after.timeOrigin,
    startMs: 230, endMs: 250, before: root, after: clone(root), layers, fonts,
    files: fonts.map((font, index) => ({assetId: 'font-asset-' + index, assetVersion: '1', hash: font.bytes.hash, bytes: Number(font.bytes.byteLength),
      observedHash: font.bytes.hash, observedBytes: Number(font.bytes.byteLength), fontIds: [font.id]})),
    nativeEditorBefore: native, nativeEditorAfter: clone(native), missing: []};
  p.args.cell.requiredMeasurements = [
    {name: 'R35CurrentFontFaces', unit: 'count', budgetId: 'R35'},
    {name: 'R35SingleFontBytes', unit: 'bytes', budgetId: 'R35'},
    {name: 'R35CurrentFontSetBytes', unit: 'bytes', budgetId: 'R35'},
  ];
  p.seal();
  const observation = p.args.attempt.result.observations.ordinaryText;
  p.args.attempt.result.measurements = observation.analysis.measurements.map(row => ({...row,
    evidence: [{kind: 'ordinary-text-retained-observation-1', artifact: {...observation.raw, path: join(p.args.groupOutput, observation.raw.path)}}]}));
}

test('full current-font retained proof supplies all three registry rows and rejects serialized or altered publication', async () => {
  const p = packet(); fullFontObservation(p);
  const proof = await verifyOrdinaryTextEvidence(p.args), observation = readOrdinaryTextProof(proof).observation;
  assert.deepEqual(observation.analysis.missing, []); assert.deepEqual(observation.analysis.failures, []);
  const expected = {R35CurrentFontFaces: 2, R35SingleFontBytes: 2048, R35CurrentFontSetBytes: 3072};
  const rows = p.args.cell.requiredMeasurements.map(rule => ordinaryTextMeasurement({cell: p.args.cell, sample: p.args.attempt, rule, proof}).measurement);
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.name, row.value])), expected);
  assert.deepEqual(rows, p.args.attempt.result.measurements); assert(rows.every(row => row.evidence[0].artifact.path.endsWith('-raw.json')));
  assert.equal(observation.physicalPresentation, false); assert.equal(observation.analysis.qualification, false);
  const selected = extractBrowserMeasurements({cell: p.args.cell, sample: p.args.attempt, ordinaryTextProof: proof});
  assert.deepEqual(selected.measurements, rows); assert.deepEqual(selected.unavailable, []);
  const serializedProof = JSON.parse(JSON.stringify(proof)); assert.equal(readOrdinaryTextProof(serializedProof), null);
  const refused = extractBrowserMeasurements({cell: p.args.cell, sample: p.args.attempt, ordinaryTextProof: serializedProof});
  assert.deepEqual(refused.measurements, []); assert.equal(refused.unavailable.length, 3);
  for (const rule of p.args.cell.requiredMeasurements) assert.match(ordinaryTextMeasurement({cell: p.args.cell, sample: p.args.attempt, rule, proof: serializedProof}).reason, /unavailable/);
  p.args.attempt.result.measurements[0].value++;
  await assert.rejects(verifyOrdinaryTextEvidence(p.args), /published measurements differ/);
});

test('replay rejects changed binding, executable, worker and journal identities', async () => {
  for (const change of [p => p.args.fixture.text.corpus.sha256 = hash('foreign'), p => p.args.environment.buildDigest = hash('foreign'),
    p => p.args.workerProcessIdentity.pid++, p => p.args.controlFiles.pop(), p => p.args.sourceFiles.pop(), p => p.args.browserCache = '/foreign',
    p => p.args.tools.browserPins.browsers[0].revision = 'foreign', p => p.args.developerState.state.h.browserIdentity.engines[0].sha256 = hash('foreign'),
    p => p.args.journalEvents[0].nonce = '2'.repeat(32), p => p.args.journalEvents[0].monotonicMs = 501,
    p => p.args.attempt.ordinal = 2, p => p.args.serial = 2, p => p.args.attempt.prime = true]) {
    const p = packet(); change(p); await assert.rejects(verifyOrdinaryTextEvidence(p.args));
  }
});

test('raw and analysis tampering cannot enter published rows', async () => {
  for (const change of [p => p.args.attempt.result.observations.ordinaryText.analysis.physicalPresentation = true,
    p => p.args.attempt.result.phases[0].durationMs++, p => p.args.attempt.result.phases.push(clone(p.args.attempt.result.phases[0])),
    p => p.args.attempt.result.measurements.push({name: 'R35CurrentFontFaces', value: 1}),
    p => p.files.set(p.args.attempt.result.observations.ordinaryText.raw.path, Buffer.from('{}')),
    p => p.args.attempt.result.observations.ordinaryText.raw.path = '../foreign.json',
    p => p.args.attempt.result.observations.ordinaryText.raw.bytes = ORDINARY_TEXT_LIMITS.raw + 1]) {
    const p = packet(); change(p); await assert.rejects(verifyOrdinaryTextEvidence(p.args));
  }
});

test('missing raw observation refuses serialized metric success', async () => {
  const p = packet(); delete p.args.attempt.result.observations.ordinaryText; p.args.attempt.result.phases = [];
  assert.equal(await verifyOrdinaryTextEvidence(p.args), null);
  p.args.attempt.result.phases.push({name: 'text.font-ready.worker'});
  await assert.rejects(verifyOrdinaryTextEvidence(p.args), /lack replay/); p.args.attempt.result.phases = [];
  p.args.attempt.result.measurements.push({name: 'R35CurrentFontFaces', value: 0});
  await assert.rejects(verifyOrdinaryTextEvidence(p.args), /lack replay/);
  assert.match(ordinaryTextMeasurement({proof: {}, cell: p.args.cell, sample: p.args.attempt, rule: {name: 'R35CurrentFontFaces'}}).reason, /unavailable/);
});

test('wrong fixture cohort or accepted root cannot qualify an otherwise valid preview', () => {
  for (const change of [p => p.raw.steps[0].identity.sourceHash = hash('foreign'), p => p.raw.steps[0].identity.fontBytes++,
    p => p.raw.steps[0].before.accepted.dependencyHash = hash('foreign'), p => p.raw.steps[0].after.accepted.documentRevision = '4',
    p => p.raw.steps[0].kind = 'apply']) {
    const p = packet(); change(p); assert.throws(() => inspectOrdinaryTextRaw(p.raw, p.binding));
  }
});

test('navigation emits only current-episode app availability bounds for exact recovered roots', async () => {
  for (const renderMeaning of ['canonical-canvas-render-submitted', 'canonical-resident-submission-observed']) {
    const p = packet(); p.args.cell.operation = p.binding.operation = 'text.mixed-ready';
    const step = p.raw.steps[0]; step.kind = 'navigation'; step.identity = null; step.after.timeOrigin = 2000;
    step.after.productPhases.navigation = {schemaVersion: 1, navigationTimeOriginMs: 2000, milestonePolicy: 'current-availability-episode', renderMeaning,
      modelMeaning: 'stored-authoritative-model', editMeaning: 'shell-committed-document-controls', presentationEvidence: 'external-trace-required',
      identity: {sessionId: 'session-new', generation: 3, documentId: 'doc', revision: '3', assetId: 'composite', assetHash: hash('image'), snapshotId: '12345678-1234-1234-1234-123456789abc'},
      modelReadyMs: 40, renderSubmittedMs: 80, editAvailableMs: 100, viewportCurrent: true, editAvailable: true};
    step.after.editControl = {visible: true, enabled: true}; p.seal();
    const proof = await verifyOrdinaryTextEvidence(p.args), rows = readOrdinaryTextProof(proof).phases;
    assert.equal(rows.length, 3); assert(rows.every(row => row.durationMs === null && row.ceilingBreachProvesFailure === false && row.physicalPresentation === false));
    assert.deepEqual(rows.map(row => row.upperBoundMs), [40, 80, 100]);
    assert.equal(rows[1].renderMeaning, renderMeaning);
    const observed = readOrdinaryTextProof(proof).observation.analysis.children[0].canonicalComposite;
    assert.equal(observed.raster.pixelIdentity, hash('composite-identity')); assert.notEqual(observed.raster.pixels.hash, observed.blob.hash);
    for (const mutate of [root => root.compositeRaster.pixelIdentity = 'foreign', root => root.compositeRaster.pixels.byteLength = '4',
      root => root.compositeState.safety = 'unknown', root => root.compositeRaster.manifest.mediaType = 'text/plain',
      root => root.compositeRaster.width++, root => root.compositeBlob.mediaType = 'image/jpeg']) {
      const raw = clone(p.raw); mutate(raw.steps[0].before.accepted); mutate(raw.steps[0].after.accepted);
      const analysis = inspectOrdinaryTextRaw(raw, p.binding);
      assert.equal(analysis.phases.length, 0); assert(analysis.missing.some(message => /Canonical composite/.test(message)));
    }
    for (const mutate of [v => v.after.timeOrigin = v.before.timeOrigin, v => v.after.productPhases.navigation.identity.assetId = 'stale',
      v => v.after.productPhases.navigation.viewportCurrent = false, v => v.after.productPhases.navigation.editAvailable = false,
      v => v.after.productPhases.navigation.editAvailableMs = 70, v => v.after.editControl.enabled = false,
      v => v.after.productPhases.navigation.renderMeaning = 'physical-first-paint',
      v => v.after.productPhases.navigation.modelMeaning = 'fresh-all-text-layout', v => v.after.productPhases.navigation.editMeaning = 'focused-native-input',
      v => v.after.productPhases.navigation.presentationEvidence = 'physical-first-paint', v => v.after.productPhases.navigation.identity.snapshotId = '', v => v.before.timeOrigin = undefined,
      v => v.after.accepted.compositeRaster.pixelIdentity = 'foreign', v => v.after.accepted.compositeRaster.pixels.byteLength = '4',
      v => v.after.accepted.compositeState.safety = 'unknown', v => v.after.accepted.sourceHash = hash('different-source')]) {
      const raw = clone(p.raw); mutate(raw.steps[0]); const analysis = inspectOrdinaryTextRaw(raw, p.binding);
      assert.equal(analysis.phases.length, 0); assert(analysis.missing.length > 0);
    }
  }
});

test('an unavailable diagnostic read still performs the original action exactly once', async t => {
  const output = await mkdtemp(join(tmpdir(), 'ordinary-text-observation-'));
  t.after(() => rm(output, {recursive: true, force: true}));
  const p = packet(); let calls = 0;
  const observer = createOrdinaryTextObserver({page: {evaluate: async () => {throw Error('diagnostic unavailable');}}, cell: p.args.cell, sample: p.args.attempt,
    serial: 1, fixture: p.args.fixture, runtime: p.binding.runtime, environment: p.args.environment, processIdentity: p.args.workerProcessIdentity, output});
  assert.equal(await observer.step('preview', async () => {calls++; return 7;}), 7); assert.equal(calls, 1);
  const result = await observer.finish(); assert.equal(readOrdinaryTextProof(result.proof).phases.length, 0);
  assert(result.observation.analysis.missing.length > 0);
  const raw = JSON.parse(await readFile(join(output, result.observation.raw.path), 'utf8')); assert.equal(raw.steps.length, 1);
  await assert.rejects(observer.step('preview', async () => calls++)); await assert.rejects(observer.finish()); assert.equal(calls, 1);
});

function publicFixture(t, override) {
  const previous = globalThis.fetch, page = {evaluate: async (fn, argument) => fn(argument)};
  const document = {id: 'doc', revision: '3', width: 64, height: 32, image: {state: {hash: hash('image')}, compositeAssetId: 'composite'}};
  const values = {
    '/api/v1/documents/doc': {entityVersion: '3', projection: {kind: 'inline', value: document}},
    '/api/v1/documents/doc/text?layerId=layer&revision=3': {documentRevision: '3', layerVersion: '2', source: {
      text: {textUtf8: {hash: hash('Text')}, fonts: [{bytes: {byteLength: '1024'}}]},
      render: {dependencyHash: hash('dependency'), pixels: {hash: hash('pixels')}, width: 20, height: 10}}},
    '/api/v1/assets/composite': {entityVersion: '1', projection: {kind: 'inline', value: {id: 'composite', version: '1', ...compositeFields().compositeState, raster: compositeFields().compositeRaster, blob: {hash: hash('canonical'), byteLength: '200', mediaType: 'image/png'}}}},
  };
  globalThis.fetch = override ?? (async (path, options) => {
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); assert(options.signal instanceof AbortSignal);
    assert(Object.hasOwn(values, path)); return new Response(JSON.stringify(values[path]), {status: 200});
  });
  t.after(() => {globalThis.fetch = previous; delete globalThis.__IDEOGRAM_ORDINARY_READS__;});
  return {page, text: {documentId: 'doc', activeLayerId: 'layer'}, values};
}

test('public read binds actual accepted source and canonical asset then drains its owner', async t => {
  const f = publicFixture(t), value = await readOrdinaryTextPublicState(f.page, f.text);
  assert.equal(value.accepted.sourceHash, hash('Text')); assert.equal(value.accepted.compositeBlob.hash, hash('canonical'));
  assert.equal(value.accepted.compositeRaster.pixelIdentity, hash('composite-identity'));
  assert.equal(globalThis.__IDEOGRAM_ORDINARY_READS__, undefined);
  f.values['/api/v1/documents/doc/text?layerId=layer&revision=3'].documentRevision = '2';
  await assert.rejects(readOrdinaryTextPublicState(f.page, f.text), /LAYER_VERSION/);
  assert.equal(globalThis.__IDEOGRAM_ORDINARY_READS__, undefined);
});

test('non-success bodies and oversized streams are cancelled and unlocked', async t => {
  let cancelled = 0, released = 0;
  const f = publicFixture(t, async () => ({status: 503, body: {locked: false, cancel: async () => {cancelled++;}}, headers: new Headers()}));
  await assert.rejects(readOrdinaryTextPublicState(f.page, f.text), /PUBLIC_READ/); assert.equal(cancelled, 1);
  globalThis.fetch = async () => ({status: 200, headers: new Headers(), body: {locked: false, getReader: () => ({read: async () => ({done: false, value: new Uint8Array(ORDINARY_TEXT_LIMITS.publicJSON + 1)}), cancel: async () => {cancelled++;}, releaseLock: () => {released++;}})}});
  await assert.rejects(readOrdinaryTextPublicState(f.page, f.text), /PUBLIC_BOUND/); assert.equal(cancelled, 2); assert.equal(released, 1);
  assert.equal(globalThis.__IDEOGRAM_ORDINARY_READS__, undefined);
});

test('reader cleanup failure remains unavailable and still releases the lock', async t => {
  let released = false;
  const f = publicFixture(t, async () => ({status: 200, headers: new Headers(), body: {locked: false, getReader: () => ({read: async () => ({done: true}), cancel: async () => {throw Error('cancel failed');}, releaseLock: () => {released = true;}})}}));
  await assert.rejects(readOrdinaryTextPublicState(f.page, f.text), /cancel failed/);
  assert.equal(released, true); assert.equal(globalThis.__IDEOGRAM_ORDINARY_READS__, undefined);
});

test('caller abort reaches an installed fetch owner and drains it', async t => {
  let entered; const active = new Promise(resolve => {entered = resolve;});
  const f = publicFixture(t, async (_path, {signal}) => new Promise((_resolve, reject) => {signal.addEventListener('abort', () => reject(Error('read aborted')), {once: true}); entered();}));
  const control = new AbortController(), operation = readOrdinaryTextPublicState(f.page, f.text, null, control.signal);
  operation.catch(() => {}); await active; control.abort(); await assert.rejects(operation);
  assert.equal(globalThis.__IDEOGRAM_ORDINARY_READS__, undefined);
});


test('campaign abort during the pre-read retires observation without starting an action', async t => {
  const output = await mkdtemp(join(tmpdir(), 'ordinary-text-abort-'));
  t.after(() => rm(output, {recursive: true, force: true}));
  const p = packet(), control = new AbortController(); let actions = 0;
  const observer = createOrdinaryTextObserver({page: {evaluate: async () => {control.abort(); throw Error('owned read aborted');}}, cell: p.args.cell, sample: p.args.attempt,
    serial: 1, fixture: p.args.fixture, runtime: p.binding.runtime, environment: p.args.environment, processIdentity: p.args.workerProcessIdentity, output, signal: control.signal});
  await assert.rejects(observer.step('preview', async () => {actions++;})); assert.equal(actions, 0);
  const result = await observer.finish(); assert.equal(readOrdinaryTextProof(result.proof).phases.length, 0);
  assert(result.observation.analysis.missing.length > 0);
});


test('ordinary text consumes exact parent source/control bare hashes and prefixed build/tool hashes', async () => {
  const p = packet();
  for (const key of ['sourceDigest', 'controlDigest']) assert.match(p.args.environment[key], /^[a-f0-9]{64}$/);
  for (const key of ['buildDigest', 'toolsDigest']) assert.match(p.args.environment[key], /^sha256:[a-f0-9]{64}$/);
  assert([...p.args.sourceFiles, ...p.args.controlFiles].every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  const proof = await verifyOrdinaryTextEvidence(p.args);
  assert.equal(readOrdinaryTextProof(proof).phases.length, 2);
});

for (const key of ['sourceDigest', 'controlDigest', 'buildDigest', 'toolsDigest']) test('ordinary text rejects wrong identity encoding for ' + key, async () => {
  const p = packet();
  p.args.environment[key] = key === 'sourceDigest' || key === 'controlDigest' ? 'sha256:' + p.args.environment[key] : p.args.environment[key].slice(7);
  p.seal();
  await assert.rejects(verifyOrdinaryTextEvidence(p.args), /executable bindings/);
});

for (const key of ['sourceFiles', 'controlFiles']) test('ordinary text rejects prefixed or malformed parent ' + key + ' identities', async () => {
  for (const encode of [value => 'sha256:' + value, value => value.slice(1), value => value.toUpperCase()]) {
    const p = packet(); p.args[key][0].sha256 = encode(p.args[key][0].sha256);
    await assert.rejects(verifyOrdinaryTextEvidence(p.args), /source closure/);
  }
});

test('source identity correction does not permit unprefixed retained artifact or browser identities', async () => {
  const p = packet(); p.args.attempt.result.observations.ordinaryText.raw.sha256 = p.args.attempt.result.observations.ordinaryText.raw.sha256.slice(7);
  await assert.rejects(verifyOrdinaryTextEvidence(p.args), /retained member/);
  const q = packet(); q.binding.runtime.executableIdentity.sha256 = q.binding.runtime.executableIdentity.sha256.slice(7);
  q.files.set('browser-runtime.json', Buffer.from(JSON.stringify(q.binding.runtime))); q.seal();
  await assert.rejects(verifyOrdinaryTextEvidence(q.args), /browser version pin/);
});
