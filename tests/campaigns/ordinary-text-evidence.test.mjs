import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, stat, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createOrdinaryTextObserver, inspectOrdinaryTextRaw, ordinaryTextMeasurement, readOrdinaryTextProof, verifyOrdinaryTextEvidence, readOrdinaryTextPublicState, ORDINARY_TEXT_LIMITS} from '../../tooling/qualification/campaigns/browser-ordinary-text.mjs';
import {extractBrowserMeasurements} from '../../tooling/qualification/campaigns/browser-measurements.mjs';
import {collectOrdinaryFontInvariant, replayOrdinaryFontInvariant, ordinaryFontInvariantMeasurement, ORDINARY_FONT_INVARIANT_SOURCE_FILES} from '../../tooling/qualification/campaigns/browser-text-invariant.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const compositeFields = () => ({documentWidth: 64, documentHeight: 32, compositeState: {purpose: 'image', qualification: 'canonical-raster', measuredMediaType: 'image/png', safety: 'safe', availability: 'available'},
  compositeRaster: {schemaVersion: 1, pipeline: 'cp1-f64-triangle-area-v1/' + hash('pipeline'), width: 64, height: 32, role: 'composite',
    manifest: {hash: hash('manifest'), byteLength: '100', mediaType: 'application/json'}, pixels: {hash: hash('composite-pixels'), byteLength: '8192', mediaType: 'application/x-ideogram-rgba8'}, pixelIdentity: hash('composite-identity')}});
// Synthetic retained-byte fixture for the verifier. It is not a browser run,
// physical measurement, operator review, or campaign qualification receipt.
function packet({sourceRoot = '/product', output = '/evidence/group'} = {}) {
  const nonce = '1'.repeat(32), browserCache = '/cache';
  const cell = {id: 'I10H/WXn-active-layout', operation: 'text.active-layout', workload: 'WXn', requiredMeasurements: []};
  const attempt = {id: cell.id + '/cold/scored/1', cache: 'cold', ordinal: 1, prime: false, startMs: 10, endMs: 500, status: 'INCONCLUSIVE', result: {observations: {}, measurements: [], phases: []}};
  const fixture = {seal: {path: '/original/fixture.json', bytes: 10, sha256: hash('fixture')}, text: {documentId: 'doc', activeLayerId: 'layer', corpus: {sha256: hash('Text')}, expectedPreviewHash: hash('pixels'), fonts: [{bytes: 1024}]}};
  const environment = {sourceDigest: hash('source').slice(7), buildDigest: hash('build'), toolsDigest: hash('tools'), controlDigest: hash('control').slice(7)};
  const workerProcessIdentity = {pid: 99, node: 'v26.10.0', startedAt: '2026-01-01T00:00:00Z'};
  const uuid = '12345678-1234-1234-1234-123456789abc', browserRegistration = 'owned-process-100-' + uuid + '.json';
  const browserProcess = {kind: 'browser', pid: 100, pgid: 100, executable: '/cache/chromium/browser', startedAtIdentity: 'real-identity'};
  const runtime = {engine: 'chromium', browserPid: 100, backendPid: 101, fixtureSeal: fixture.seal, executable: browserProcess.executable,
    revision: '1243', version: '153.0.8010.12', executableIdentity: {bytes: 123, sha256: hash('browser')}, playwrightModule: sourceRoot + '/node_modules/playwright-core/index.mjs',
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
  const controlFiles = ['browser.mjs','browser-text.mjs','browser-ordinary-text.mjs','browser-text-fonts.mjs','browser-text-invariant.mjs','ordinary-text-phases.mjs','browser-measurements.mjs','worker.mjs','run.mjs','verification.mjs'].map(name => ({path: 'tooling/qualification/campaigns/' + name, sha256: hash(name).slice(7)}));
  controlFiles.push({path: 'tooling/qualification/evidence-volume.mjs', sha256: hash('evidence-volume.mjs').slice(7)});
  const sourceFiles = ['src/ui/native-text.ts','src/ui/shell.ts','src/state/editor-client.ts','src/observability/browser.ts','src/observability/navigation-observations.ts', ...ORDINARY_FONT_INVARIANT_SOURCE_FILES].map(path => ({path, sha256: hash(path).slice(7)}));
  const args = {attempt, cell, serial: 1, fixture, environment, workerProcessIdentity, groupOutput: output, controlFiles, sourceFiles, sourceRoot, browserCache, tools, developerState, developerStateIdentity,
    retainedFiles: [], readRetained: async (path, {maximum}) => {assert(files.has(path)); const bytes = files.get(path); assert(bytes.length <= maximum); return bytes;}, journalEvents: []};
  const seal = (options = {}) => {
    const rawArtifact = put('ordinary-text-' + nonce + '-raw.json', raw), bindingArtifact = put('ordinary-text-' + nonce + '-binding.json', binding);
    const analysis = inspectOrdinaryTextRaw(raw, binding, options);
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
  assert.deepEqual(observation.analysis.missing, ['Accepted-source declared-font invariant lacks complete immutable source/layout/text/font replay']); assert.deepEqual(observation.analysis.failures, []);
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

const invariantRule = {name: 'R35SilentFontSubstitutionCount', budgetId: 'R35', unit: 'violations'};
// Explicit synthetic retained-state fixture. Real production validators and
// immutable-file proof ownership execute; no real font parsing, native shaping,
// browser process, physical measurement or qualification is represented here.
async function invariantFixture(t, {mutateLayout, mutateSource} = {}) {
  const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const [{canonical}, {dependencyIdentity}] = await Promise.all([
    import('../../dist/local/server/storage/canonical.js'), import('../../dist/local/server/text/validation.js'),
  ]);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ordinary-font-invariant-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const root = join(directory, 'private'), allocationRoot = join(directory, 'evidence'), output = join(allocationRoot, 'group');
  for (const path of [root, allocationRoot, output, join(root, 'objects'), join(root, 'objects', 'sha256'), join(root, 'staging')]) await mkdir(path, {mode: 0o700});
  const allocationPath = join(directory, 'allocation.json'), insufficientAllocationPath = join(directory, 'insufficient-allocation.json');
  for (const [path, capacityBytes] of [[allocationPath, 32 * 1048576], [insufficientAllocationPath, 1048576]]) await writeFile(path, JSON.stringify({
    kind: 'evidence-volume-allocation-1', allocationId: 'ordinary-font-invariant-test', purpose: 'qualification-evidence-only',
    capacityBytes, root: allocationRoot, issuedAt: '2026-01-01T00:00:00.000Z', owner: 'ordinary-font-invariant-test',
  }), {mode: 0o600, flag: 'wx'});
  const p = packet({sourceRoot: repo, output}), inputs = new Map();
  const ref = (value, mediaType = 'application/json') => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonical(value));
    const result = {hash: hash(bytes), byteLength: String(bytes.length), mediaType}; inputs.set(result.hash, bytes); return result;
  };
  const identified = value => {const {id: _old, ...body} = value; return {...body, id: hash(canonical(body))};};
  const font = identified({schemaVersion: 1, bytes: ref(Buffer.alloc(32, 7), 'application/octet-stream'), faceIndex: 0,
    format: 'static-ttf', parserProfile: 'sfnt-static-1-freetype-canvaskit040', fsType: 0,
    licenseRecord: ref('Synthetic permitted license', 'text/plain'), origin: 'local-file', embedding: 'permitted'});
  const renderer = {schemaVersion: 1, id: hash('synthetic renderer'), manifest: ref('synthetic renderer manifest')}, sources = [];
  const layers = ['Text', 'Hide'].map((content, index) => {
    const frame = {width: 20, height: 10}, end = content.length;
    const layout = {version: 'layout-1', policy: 'text-layout-1', frame,
      indexConvention: 'half-open; UTF-16 native; UTF-8 shaped offsets; -1 scalar interiors; downstream at start/upstream at end',
      utf16ToUtf8: [0,1,2,3,4], utf8ToUtf16: [0,1,2,3,4],
      lineHeightPolicy: 'max-supplied-font-metrics-times-multiplier; symmetric-leading; native-rounded-baselines',
      fontMetrics: [{hash: font.bytes.hash, ascent: -8, descent: 2, leading: 0}], intrinsicHeight: 10, requestedLineHeight: 10, logicalLines: 1,
      paragraphs: [{startUtf16: 0, endUtf16: end, startUtf8: 0, endUtf8: end, top: 0, height: 10, direction: 'ltr',
        lines: [{baseline: 8, ascent: 8, descent: 2, height: 10, width: 20, left: 0, lineNumber: 0, isHardBreak: false,
          startUtf8: 0, endUtf8: end, startUtf16: 0, endUtf16: end, endExcludingWhitespacesUtf16: end,
          endIncludingNewlineUtf16: end, endExcludingWhitespacesUtf8: end, endIncludingNewlineUtf8: end}],
        runs: [{fontHash: font.bytes.hash, size: 10, flags: 0, glyphs: [1], offsetsUtf8: [0,end], offsetsUtf16: [0,end],
          positions: [0,0,20,0], inkBounds: [[0,0,20,10]], top: 0, bottom: 10, baseline: 8}],
        clusters: [{startUtf16: 0, endUtf16: end, startUtf8: 0, endUtf8: end, direction: 'ltr', rect: [0,0,20,10], ranges: [{rect: [0,0,20,10], direction: 'ltr'}]}]}],
      height: 10, overflow: false};
    mutateLayout?.(layout, index);
    const text = identified({schemaVersion: 1, textUtf8: ref(content, 'text/plain'),
      style: {primaryFont: font.bytes.hash, explicitFallbacks: [], sizePx: 10, lineHeightMultiplier: 1, fill: [0,0,0,255], align: 'start', direction: 'auto'},
      frame, layoutPolicy: 'text-layout-1', fonts: [font]});
    const source = {schemaVersion: 1, text, render: {schemaVersion: 1, textVersion: text.id, rendererProfile: renderer,
      layout: ref(layout), pixels: {hash: hash('pixels'), byteLength: '800', mediaType: 'application/x-ideogram-rgba8'},
      width: 20, height: 10, overflow: false, resolvedFonts: [font.id]}};
    source.render.dependencyHash = dependencyIdentity(source); mutateSource?.(source, index);
    source.render = identified(source.render); sources.push(source);
    return {id: index ? 'hidden-layer' : 'layer', version: '2', kind: 'text', name: index ? 'Hidden synthetic text' : 'Synthetic text',
      assetId: 'pixels_' + index, layerToDocument: [1,0,0,1,0,0], opacity: 1, visible: index === 0, locked: false, blend: 'normal', mask: null, source: ref(source)};
  });
  const image = {schemaVersion: 2, width: 64, height: 32, layers}, imageState = ref(image), step = p.raw.steps[0];
  for (const value of [step.identity, step.before.accepted, step.after.accepted]) {value.fontBytes = 32; value.dependencyHash = sources[0].render.dependencyHash;}
  step.after.state.preview.dependencyHash = sources[0].render.dependencyHash;
  step.after.productPhases.trace.records[0].context.evidenceHash = sources[0].render.dependencyHash;
  step.after.productPhases.workerObservations.traces[0].records[0].context.bytes = 32;
  step.before.accepted.imageState = clone(imageState); step.after.accepted.imageState = clone(imageState);
  p.binding.textFixture.fontBytes = 32; p.args.fixture.text.fonts = [{bytes: 32}];
  const acceptedRoot = {documentId: 'doc', revision: '3', imageState, semanticDigest: hash('synthetic accepted semantic root'),
    orderedLayerIds: layers.map(layer => layer.id), observedImageHash: imageState.hash, observedImageBytes: Number(imageState.byteLength)};
  const native = {present: true, hidden: false, session: 'draft', sessionId: 'session', documentId: 'doc', documentRevision: '3', layerId: 'layer', layerVersion: '2',
    generation: 7, savedGeneration: 7, preview: clone(step.after.state.preview), nativeTextHash: hash('Text')};
  p.raw.fonts = {kind: 'current-document-fonts-1', binding: clone(p.binding.attempt), clock: 'browser-performance', timeOrigin: step.after.timeOrigin,
    startMs: 230, endMs: 250, before: acceptedRoot, after: clone(acceptedRoot),
    layers: layers.map((layer, index) => {const source = sources[index]; return {id: layer.id, version: layer.version, kind: layer.kind,
      source: layer.source, observedSourceHash: layer.source.hash, observedSourceBytes: Number(layer.source.byteLength), textVersion: source.text.id,
      renderVersion: source.render.id, renderer, fontIds: [font.id], textHash: source.text.textUtf8.hash, renderDependencyHash: source.render.dependencyHash,
      rasterHash: source.render.pixels.hash, width: source.render.width, height: source.render.height};}),
    fonts: [font], files: [{assetId: 'font-asset', assetVersion: '1', hash: font.bytes.hash, bytes: 32, observedHash: font.bytes.hash, observedBytes: 32, fontIds: [font.id]}],
    nativeEditorBefore: native, nativeEditorAfter: clone(native), missing: []};
  for (const [digest, bytes] of inputs) {
    const parent = join(root, 'objects', 'sha256', digest.slice(7,9)); await mkdir(parent, {recursive: true, mode: 0o700});
    await writeFile(join(parent, digest.slice(7)), bytes, {mode: 0o600, flag: 'wx'});
  }
  const collect = async ({allocationPath: selectedAllocation = allocationPath, ...options} = {}) => {
    // The production collector reads the actual sealed allocation from its
    // ordinary environment; restore the runner's allocation on every path.
    const previous = process.env.IE_EVIDENCE_ALLOCATION;
    if (selectedAllocation === null) delete process.env.IE_EVIDENCE_ALLOCATION; else process.env.IE_EVIDENCE_ALLOCATION = selectedAllocation;
    try {return await collectOrdinaryFontInvariant({repo, root, output, fonts: p.raw.fonts, nonce: p.raw.nonce, ...options});}
    finally {if (previous === undefined) delete process.env.IE_EVIDENCE_ALLOCATION; else process.env.IE_EVIDENCE_ALLOCATION = previous;}
  };
  const retain = async evidence => {for (const member of evidence.members) p.files.set(member.path, await readFile(join(output, member.path)));};
  const seals = () => [...p.files].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes)}));
  const replay = (evidence, options = {}) => replayOrdinaryFontInvariant({repo, output, fonts: p.raw.fonts, nonce: p.raw.nonce, evidence,
    readRetained: p.args.readRetained, retainedFiles: seals(), ...options});
  const publish = ({evidence, proof}) => {
    p.raw.fontInvariant = evidence; p.args.cell.requiredMeasurements = [
      {name: 'R35CurrentFontFaces', unit: 'count', budgetId: 'R35'}, {name: 'R35SingleFontBytes', unit: 'bytes', budgetId: 'R35'},
      {name: 'R35CurrentFontSetBytes', unit: 'bytes', budgetId: 'R35'}, invariantRule,
    ];
    p.seal({fontInvariantProof: proof}); const observation = p.args.attempt.result.observations.ordinaryText;
    p.args.attempt.result.measurements = observation.analysis.measurements.map(row => ({...row,
      evidence: [{kind: 'ordinary-text-retained-observation-1', artifact: {...observation.raw, path: join(p.args.groupOutput, observation.raw.path)}}]}));
  };
  return {p, repo, root, output, allocationRoot, allocationPath, insufficientAllocationPath, inputs, sources, image, font, collect, retain, replay, publish};
}

test('exact accepted hidden-layer layouts issue an opaque font invariant and replay all four registry rows', async t => {
  const f = await invariantFixture(t), result = await f.collect(); await f.retain(result.evidence);
  assert.equal(f.image.layers[1].visible, false); assert.equal(result.evidence.members.length, 7);
  assert.equal(result.evidence.members.filter(member => member.ref.hash === f.font.bytes.hash).length, 1);
  assert.equal(result.evidence.admission.members.length, 7);
  assert.deepEqual(result.evidence.admission.members.map(member => member.path), result.evidence.members.map(member => member.path));
  for (const member of result.evidence.members) {assert.equal((await stat(join(f.output, member.path))).mode & 0o777, 0o600); assert.equal(hash(f.p.files.get(member.path)), member.ref.hash);}
  assert.equal(ordinaryFontInvariantMeasurement({fonts: f.p.raw.fonts, ...result}).value, 0);
  assert.equal(ordinaryFontInvariantMeasurement({fonts: f.p.raw.fonts, evidence: result.evidence, proof: clone(result.proof)}), null);
  assert.equal(ordinaryFontInvariantMeasurement({fonts: f.p.raw.fonts, proof: result.proof}), null);
  const replayed = await f.replay(result.evidence);
  assert.equal(ordinaryFontInvariantMeasurement({fonts: f.p.raw.fonts, evidence: result.evidence, proof: replayed}).value, 0);
  f.publish(result); const proof = await verifyOrdinaryTextEvidence(f.p.args), admitted = readOrdinaryTextProof(proof);
  assert.deepEqual(admitted.observation.analysis.missing, []); assert.deepEqual(admitted.observation.analysis.failures, []);
  const rows = extractBrowserMeasurements({cell: f.p.args.cell, sample: f.p.args.attempt, ordinaryTextProof: proof});
  assert.deepEqual(Object.fromEntries(rows.measurements.map(row => [row.name, row.value])), {
    R35CurrentFontFaces: 1, R35SingleFontBytes: 32, R35CurrentFontSetBytes: 32, R35SilentFontSubstitutionCount: 0,
  });
  assert.deepEqual(rows.unavailable, []); assert.equal(admitted.observation.analysis.physicalPresentation, false);
  assert.equal(admitted.observation.analysis.freshAllTextLayout, false);
});

test('production validators reject self-consistent sidecar hashes hiding substituted layout fonts or false dependencies', async t => {
  for (const options of [
    {mutateLayout: (layout, index) => {if (index) layout.paragraphs[0].runs[0].fontHash = hash('undeclared hidden-layer font');}},
    {mutateLayout: (layout, index) => {if (index) layout.fontMetrics[0].hash = hash('undeclared hidden metrics');}},
    {mutateSource: (source, index) => {if (index) source.render.dependencyHash = hash('forged accepted dependency');}},
    {mutateSource: (source, index) => {if (index) source.render.resolvedFonts[0] = hash('undeclared resolved font');}},
  ]) {
    const f = await invariantFixture(t, options);
    await assert.rejects(f.collect());
    assert.equal(ordinaryFontInvariantMeasurement({fonts: f.p.raw.fonts, evidence: {}, proof: {value: 0}}), null);
  }
});

test('retained immutable sidecars, outer seals, exact member inventory and validator bytes are independently checked', async t => {
  const f = await invariantFixture(t), result = await f.collect(); await f.retain(result.evidence);
  for (const change of [
    evidence => {evidence.members[0].path = '../foreign.bin';},
    evidence => {evidence.members[0].sha256 = hash('forged outer identity');},
    evidence => {evidence.members.pop();},
    evidence => {evidence.members.push(clone(evidence.members[0]));},
    evidence => {evidence.validatorInputs[0].sha256 = hash('different validator');},
    evidence => {evidence.binding.ordinal++;},
    evidence => {evidence.root.revision = '4';},
    evidence => {evidence.admission.metadataAllowanceBytes--;},
    evidence => {evidence.admission.output = join(f.allocationRoot, 'foreign-group');},
    evidence => {evidence.admission.observation.attempts[0].hash = '0'.repeat(64);},
    evidence => {evidence.admission.members[0].chargedAllocatedBytes++;},
    evidence => {evidence.admission.members[0].projectedEntries++;},
    evidence => {evidence.admission.members.pop();},
    evidence => {evidence.admission.allocation.capacityBytes = 1048576;},
    evidence => {evidence.admission.limitations = [];},
  ]) {const evidence = clone(result.evidence); change(evidence); await assert.rejects(f.replay(evidence));}
  const member = result.evidence.members.find(row => row.ref.hash === f.font.bytes.hash), original = f.p.files.get(member.path);
  const changed = Buffer.from(original); changed[0] ^= 1; f.p.files.set(member.path, changed);
  await assert.rejects(f.replay(result.evidence), /outer seal/);
  const forgedOuter = [...f.p.files].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: path === member.path ? member.sha256 : hash(bytes)}));
  await assert.rejects(f.replay(result.evidence, {retainedFiles: forgedOuter}), /input bytes/);
  f.p.files.set(member.path, original); assert(await f.replay(result.evidence));
});

test('a genuine immutable proof cannot bypass public font presence, open draft lineage or changed accepted roots', async t => {
  const f = await invariantFixture(t), result = await f.collect(); await f.retain(result.evidence); f.publish(result);
  for (const change of [fonts => {fonts.files[0].observedHash = hash('different public bytes');}, fonts => {fonts.files = [];},
    fonts => {fonts.nativeEditorBefore.preview.id = fonts.nativeEditorAfter.preview.id = 'unrelated-preview';},
    fonts => {fonts.nativeEditorBefore.nativeTextHash = fonts.nativeEditorAfter.nativeTextHash = hash('unrelated draft');},
    fonts => {fonts.after.revision = '4';}]) {
    const raw = clone(f.p.raw); change(raw.fonts);
    assert.equal(ordinaryFontInvariantMeasurement({fonts: raw.fonts, evidence: result.evidence, proof: result.proof}), null);
    try {const analysis = inspectOrdinaryTextRaw(raw, f.p.binding, {fontInvariantProof: result.proof});
      assert(!analysis.measurements.some(row => row.name === invariantRule.name)); assert(analysis.missing.length > 0);
    } catch (error) {assert.match(error.message, /Font inventory/);}
  }
  const raw = clone(f.p.raw); raw.steps[0].after.accepted.imageState.hash = hash('changed accepted root');
  assert.throws(() => inspectOrdinaryTextRaw(raw, f.p.binding, {fontInvariantProof: result.proof}), /accepted|image root/);
  // Even a fresh semantic replay cannot approve an unrelated current editor.
  const unrelated = clone(f.p.raw.fonts); unrelated.nativeEditorBefore.preview.id = unrelated.nativeEditorAfter.preview.id = 'foreign';
  const proof = await f.replay(result.evidence, {fonts: unrelated});
  const analysis = inspectOrdinaryTextRaw({...f.p.raw, fonts: unrelated}, f.p.binding, {fontInvariantProof: proof});
  assert(!analysis.measurements.some(row => row.name === invariantRule.name)); assert(analysis.missing.some(message => /preview lineage/.test(message)));
});

test('forged invariant zero and serialized issuer state cannot enter the ordinary retained replay path', async t => {
  const f = await invariantFixture(t), result = await f.collect(); await f.retain(result.evidence); f.publish(result);
  const claimed = clone(f.p.raw); claimed.fontInvariant = {value: 0};
  const analysis = inspectOrdinaryTextRaw(claimed, f.p.binding, {fontInvariantProof: clone(result.proof)});
  assert(!analysis.measurements.some(row => row.name === invariantRule.name));
  f.p.args.attempt.result.measurements.find(row => row.name === invariantRule.name).value = 1;
  await assert.rejects(verifyOrdinaryTextEvidence(f.p.args), /published measurements differ/);
  f.publish(result); f.p.raw.fontInvariant = {value: 0}; f.p.seal();
  await assert.rejects(verifyOrdinaryTextEvidence(f.p.args), /retained proof shape/);
});

test('actual allocated evidence headroom admits deduplicated writes and refuses cumulative growth before another input proof', async t => {
  const f = await invariantFixture(t), {Objects} = await import('../../dist/local/server/storage/objects.js');
  const previousAllocation = process.env.IE_EVIDENCE_ALLOCATION, originalProve = Objects.prototype.prove;
  let attempts = 0;
  // This counter delegates the real proof boundary. Absence of admission must
  // refuse before acquiring an immutable input or allocating/writing a sidecar.
  Objects.prototype.prove = function(...args) {attempts++; return Reflect.apply(originalProve, this, args);};
  try {
    await assert.rejects(f.collect({allocationPath: null}), /IE_EVIDENCE_ALLOCATION/);
    await assert.rejects(f.collect({allocationPath: f.insufficientAllocationPath}), /evidence allocation/);
    assert.equal(attempts, 0); assert.deepEqual(await readdir(f.output), []);
    assert.equal(process.env.IE_EVIDENCE_ALLOCATION, previousAllocation);
  } finally {Objects.prototype.prove = originalProve;}
  const first = await f.collect(), admission = first.evidence.admission;
  const initial = admission.observation.attempts[admission.observation.selectedAttempt].sample;
  assert.equal(admission.allocation.root, f.allocationRoot); assert.equal(admission.output, f.output);
  assert.equal(admission.members.length, first.evidence.members.length);
  const sidecarAllocated = (await Promise.all(first.evidence.members.map(member => stat(join(f.output, member.path))))).reduce((sum, value) => sum + value.blocks * 512, 0);
  const priorPath = join(f.allocationRoot, 'prior-attempt.bin');
  await writeFile(priorPath, Buffer.alloc(65536, 0x5a), {mode: 0o600, flag: 'wx'});
  const priorAllocated = (await stat(priorPath)).blocks * 512;
  assert(priorAllocated > 0); assert(sidecarAllocated > 0);
  const second = await f.collect({nonce: '2'.repeat(32)}), current = second.evidence.admission;
  const observed = current.observation.attempts[current.observation.selectedAttempt].sample;
  assert(observed.observedAllocatedBytes >= initial.observedAllocatedBytes + sidecarAllocated + priorAllocated);
  assert.equal(current.members.length, 7);
  // A real reduced manifest fits the first observed baseline, but cumulative
  // retained evidence makes even the next first member cross the existing 90%.
  const firstCharge = current.members[0].chargedAllocatedBytes;
  const capacityBytes = Math.ceil((observed.observedAllocatedBytes + current.metadataAllowanceBytes + firstCharge / 2) / 0.9);
  assert(initial.observedAllocatedBytes + current.metadataAllowanceBytes + firstCharge < capacityBytes * 0.9);
  const cumulativePath = join(f.root, '..', 'cumulative-allocation.json');
  const manifest = JSON.parse(await readFile(f.allocationPath, 'utf8'));
  await writeFile(cumulativePath, JSON.stringify({...manifest, allocationId: 'ordinary-font-cumulative-test', capacityBytes}), {mode: 0o600, flag: 'wx'});
  const before = (await readdir(f.output)).sort(); attempts = 0;
  Objects.prototype.prove = function(...args) {attempts++; return Reflect.apply(originalProve, this, args);};
  try {
    await assert.rejects(f.collect({allocationPath: cumulativePath, nonce: '3'.repeat(32)}), /existing evidence allocation/);
    assert.equal(attempts, 0); assert.deepEqual((await readdir(f.output)).sort(), before);
    assert.equal(process.env.IE_EVIDENCE_ALLOCATION, previousAllocation);
  } finally {Objects.prototype.prove = originalProve;}
});

test('actual immutable proof leases drain on held-read failure, cancellation and exclusive sidecar refusal', async t => {
  const f = await invariantFixture(t), {Objects} = await import('../../dist/local/server/storage/objects.js');
  const originalRead = Objects.prototype.readRange, originalRelease = Objects.prototype.releaseProof, originalClose = Objects.prototype.close;
  let held = 0, released = 0, closed = 0, owner;
  // Explicit failure at the real public Objects read boundary, after prove has
  // acquired its actual token. All release/close calls delegate to production.
  Objects.prototype.readRange = function(...args) {owner = this; held = this.proofInventory().retained; throw Error('controlled immutable read failure');};
  Objects.prototype.releaseProof = function(...args) {released++; return Reflect.apply(originalRelease, this, args);};
  Objects.prototype.close = function(...args) {closed++; return Reflect.apply(originalClose, this, args);};
  try {await assert.rejects(f.collect(), /controlled immutable read failure/);}
  finally {Objects.prototype.readRange = originalRead; Objects.prototype.releaseProof = originalRelease; Objects.prototype.close = originalClose;}
  assert.equal(held, 1); assert.equal(released, 1); assert.equal(closed, 1);
  assert.deepEqual(owner.proofInventory(), {pending: 0, retained: 0, activeReaders: 0, metadataBytes: 0});
  assert.deepEqual(await readdir(f.output), []);
  const abort = new AbortController(); abort.abort(); await assert.rejects(f.collect({signal: abort.signal}));
  assert.deepEqual(await readdir(f.output), []);
  const complete = await f.collect(); await f.retain(complete.evidence);
  const before = await readFile(join(f.output, complete.evidence.members[0].path));
  await assert.rejects(f.collect(), /EEXIST/); assert.deepEqual(await readFile(join(f.output, complete.evidence.members[0].path)), before);
  await assert.rejects(f.replay(complete.evidence, {signal: abort.signal}));
  assert(await f.replay(complete.evidence));
});
