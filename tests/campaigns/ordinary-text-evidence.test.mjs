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
import {createRecoveryFontObserver, inspectRecoveryFontRaw, verifyRecoveryFontEvidence, recoveryFontMeasurement, recoveryFontOutcome, TEXT_RECOVERY_FONT_SCENARIOS} from '../../tooling/qualification/campaigns/browser-text-recovery-fonts.mjs';

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


// Recovery has its own accepted-document authority: rejected native drafts do
// not borrow ordinary successful-preview lineage. These synthetic envelopes
// retain genuine immutable sidecars through the same production validators.
async function recoveryInvariantFixture(t, scenario = 'missing-font', options = {}) {
  const f = await invariantFixture(t, options), p = f.p, nonce = p.raw.nonce;
  p.args.cell.id = 'I10H/recovery-' + scenario; p.args.cell.operation = 'text.recovery'; p.args.cell.parameters = {scenario};
  p.args.attempt.id = p.args.cell.id + '/cold/scored/1';
  const specimen = {scenario, ...(scenario === 'missing-glyph' ? {textHash: hash('Unsupported')} : {}),
    ...(scenario === 'restricted-font' ? {sha256: hash('rejected restricted font')} : {})};
  p.args.fixture.text.recoveryCases = {[scenario]: specimen};
  const draftHash = scenario === 'missing-glyph' ? specimen.textHash : scenario === 'cancelled-over-limit-composition' ? hash('x'.repeat(16385)) : p.args.fixture.text.corpus.sha256;
  const attempt = {cellId: p.args.cell.id, id: p.args.attempt.id, cache: 'cold', ordinal: 1, prime: false, serial: 1};
  const binding = {kind: 'recovery-font-binding-1', nonce, operation: 'text.recovery', attempt,
    fixtureSeal: clone(p.args.fixture.seal), recovery: {documentId: 'doc', layerId: 'layer', scenario, draftHash,
      specimenSha256: hash(JSON.stringify(specimen)), rejectedFontHash: specimen.sha256 ?? null},
    environment: clone(p.args.environment), processIdentity: clone(p.args.workerProcessIdentity), runtime: clone(p.binding.runtime)};
  const before = {...clone(p.raw.fonts), kind: 'accepted-document-fonts-1', binding: clone(attempt), startMs: 50, endMs: 70,
    nativeEditorBefore: {present: true, hidden: true, session: ''}, nativeEditorAfter: {present: true, hidden: true, session: ''}};
  const cancelled = scenario === 'cancelled-over-limit-composition';
  const nativeAfter = {present: true, hidden: cancelled, session: cancelled ? '' : 'draft'};
  const after = {...clone(before), startMs: 230, endMs: 250, nativeEditorBefore: clone(nativeAfter), nativeEditorAfter: clone(nativeAfter)};
  const state = {timeOrigin: before.timeOrigin, atMs: 100, documentId: 'doc', revision: '3', layerId: 'layer', layerVersion: '2',
    sessionId: 'session', draftId: 'draft', generation: '7', previewId: '', draftHash,
    draftBytes: cancelled ? 16385 : scenario === 'missing-glyph' ? Buffer.byteLength('Unsupported') : 4,
    overLimitAdmission: cancelled, errorVisible: false, previewDisabled: cancelled, applyDisabled: true};
  const recovery = {scenario, draftHash, retained: true, rejectedFontHash: specimen.sha256 ?? null, cancelDeferredUntilNativeEnd: cancelled};
  const raw = {kind: 'recovery-font-raw-1', nonce, binding: clone(attempt), clock: 'runner-monotonic', startedMs: 20, endedMs: 400,
    actionStartedMs: 100, actionEndedMs: 300, before, after,
    refusal: {startedMs: 120, endedMs: 200, before: state, after: {...clone(state), atMs: 200, errorVisible: !cancelled}, completed: true},
    outcome: recoveryFontOutcome(recovery), failed: false, fontInvariant: null, missing: []};
  const invariant = await f.collect({fonts: after, nonce}); await f.retain(invariant.evidence); raw.fontInvariant = invariant.evidence;
  p.args.controlFiles.push({path: 'tooling/qualification/campaigns/browser-text-recovery-fonts.mjs', sha256: hash('browser-text-recovery-fonts.mjs').slice(7)});
  p.args.cell.requiredMeasurements = [
    {name: 'R35CurrentFontFaces', unit: 'count', budgetId: 'R35'}, {name: 'R35SingleFontBytes', unit: 'bytes', budgetId: 'R35'},
    {name: 'R35CurrentFontSetBytes', unit: 'bytes', budgetId: 'R35'}, invariantRule,
  ];
  p.args.attempt.result.observations = {recovery, actions: [{id: 'text-recovery', kind: 'recovery', outcome: 'completed', inputMs: 110, readyMs: 210}]};
  p.args.attempt.result.phases = [];
  for (const path of p.files.keys()) if (path.startsWith('ordinary-text-') && (path.endsWith('-raw.json') || path.endsWith('-binding.json'))) p.files.delete(path);
  const seal = ({fontInvariantProof = invariant.proof} = {}) => {
    const put = (name, value) => {const path = 'recovery-font-' + nonce + '-' + name + '.json', bytes = Buffer.from(JSON.stringify(value));
      p.files.set(path, bytes); return {path, bytes: bytes.length, sha256: hash(bytes)};};
    const bindingArtifact = put('binding', binding), artifact = put('raw', raw), analysis = inspectRecoveryFontRaw(raw, binding, {fontInvariantProof});
    p.args.attempt.result.observations.recoveryFonts = {kind: 'recovery-font-observation-1', nonce, binding: bindingArtifact, raw: artifact, analysis,
      qualification: false, acceptedDocumentOnly: true};
    p.args.attempt.result.measurements = analysis.measurements.map(row => ({...row,
      evidence: [{kind: 'recovery-font-retained-observation-1', artifact: {...artifact, path: join(f.output, artifact.path)}}]}));
    p.args.retainedFiles = [...p.files].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes)}));
    p.args.journalEvents = [{event: 'recovery-font-observed', cellId: p.args.cell.id, nonce, binding: bindingArtifact, raw: artifact, monotonicMs: 410}];
    return analysis;
  };
  seal(); return {...f, raw, binding, invariant, seal};
}
const copyReplayArguments = args => Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'function' ? value : clone(value)]));

for (const scenario of TEXT_RECOVERY_FONT_SCENARIOS) test('recovery retained accepted-font replay supplies four scoped rows for ' + scenario, async t => {
  const f = await recoveryInvariantFixture(t, scenario), {p} = f;
  p.args.attempt.status = p.args.attempt.result.status = 'PASS';
  const proof = await verifyRecoveryFontEvidence(p.args), observation = p.args.attempt.result.observations.recoveryFonts;
  assert.equal(f.image.layers[1].visible, false); assert.equal(f.invariant.evidence.members.length, 7);
  assert.equal(f.invariant.evidence.members.filter(member => member.ref.hash === f.font.bytes.hash).length, 1);
  assert.deepEqual(observation.analysis.missing, []); assert.deepEqual(observation.analysis.failures, []);
  assert.equal(observation.analysis.acceptedDocumentOnly, true); assert.equal(observation.analysis.draftRendering, false);
  assert.equal(observation.analysis.physicalPresentation, false); assert.equal(observation.analysis.qualification, false);
  const rows = p.args.cell.requiredMeasurements.map(rule => recoveryFontMeasurement({cell: p.args.cell, sample: p.args.attempt, rule, proof}).measurement);
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.name, row.value])), {
    R35CurrentFontFaces: 1, R35SingleFontBytes: 32, R35CurrentFontSetBytes: 32, R35SilentFontSubstitutionCount: 0,
  });
  assert.deepEqual(rows, p.args.attempt.result.measurements);
  assert(rows.every(row => row.evidence[0].kind === 'recovery-font-retained-observation-1' && row.evidence[0].artifact.path.endsWith('-raw.json')));
  const extracted = extractBrowserMeasurements({cell: p.args.cell, sample: p.args.attempt, recoveryFontProof: proof});
  assert.deepEqual(extracted.measurements, rows); assert.deepEqual(extracted.unavailable, []);
  assert.match(rows.find(row => row.name === invariantRule.name).method, /Invalid draft.*excluded/);
  const forged = extractBrowserMeasurements({cell: p.args.cell, sample: p.args.attempt, recoveryFontProof: clone(proof)});
  assert.deepEqual(forged.measurements, []); assert.equal(forged.unavailable.length, 4);
  const wrongAttempt = clone(p.args.attempt); wrongAttempt.ordinal++;
  assert.match(recoveryFontMeasurement({cell: p.args.cell, sample: wrongAttempt, rule: invariantRule, proof}).reason, /unavailable/);
  const wrongScenario = clone(p.args.cell); wrongScenario.parameters.scenario = 'foreign';
  assert.match(recoveryFontMeasurement({cell: wrongScenario, sample: p.args.attempt, rule: invariantRule, proof}).reason, /unavailable/);
});

test('recovery reports a genuine accepted hidden-layer layout mutation as failure even with a valid final immutable closure', async t => {
  const original = await recoveryInvariantFixture(t), changed = await recoveryInvariantFixture(t, 'missing-font', {
    mutateLayout: (layout, index) => {if (index) layout.paragraphs[0].runs[0].glyphs[0] = 2;},
  });
  assert.notEqual(original.raw.before.before.imageState.hash, changed.raw.after.before.imageState.hash);
  assert.notEqual(original.raw.before.layers[1].source.hash, changed.raw.after.layers[1].source.hash);
  assert.equal(ordinaryFontInvariantMeasurement({fonts: changed.raw.after, ...changed.invariant}).value, 0);
  changed.raw.before = clone(original.raw.before);
  const analysis = changed.seal(); assert.deepEqual(analysis.measurements, []);
  assert(analysis.failures.some(message => /accepted document\/source\/font closure changed/.test(message)));
  changed.p.args.attempt.status = changed.p.args.attempt.result.status = 'PASS';
  await assert.rejects(verifyRecoveryFontEvidence(changed.p.args), /contradiction was not reported as failure/);
  changed.p.args.attempt.status = changed.p.args.attempt.result.status = 'FAIL';
  const proof = await verifyRecoveryFontEvidence(changed.p.args);
  for (const rule of changed.p.args.cell.requiredMeasurements) assert.match(recoveryFontMeasurement({cell: changed.p.args.cell, sample: changed.p.args.attempt, rule, proof}).reason, /unavailable/);
});

test('recovery rejects stale alerts, changed drafts, new previews and invalid deferred cancellation without claiming font rows', async t => {
  const f = await recoveryInvariantFixture(t);
  for (const change of [
    raw => {raw.refusal.before.errorVisible = true;}, raw => {raw.refusal.after.errorVisible = false;},
    raw => {raw.refusal.after.draftHash = hash('changed rejected draft');}, raw => {raw.refusal.after.draftId = 'replacement-draft';},
    raw => {raw.refusal.after.previewId = 'new-preview';}, raw => {raw.refusal.after.generation = '8';},
    raw => {raw.refusal.after.timeOrigin++;}, raw => {raw.refusal.after.atMs = raw.after.startMs + 1;},
    raw => {raw.outcome.retained = false;}, raw => {raw.outcome.rejectedFontHash = hash('unrelated rejected font');},
    raw => {raw.after.nativeEditorBefore.session = raw.after.nativeEditorAfter.session = 'unrelated-draft';},
  ]) {
    const raw = clone(f.raw); change(raw);
    const analysis = inspectRecoveryFontRaw(raw, f.binding, {fontInvariantProof: f.invariant.proof});
    assert.deepEqual(analysis.measurements, []); assert(analysis.failures.length > 0);
  }
  const incomplete = clone(f.raw); incomplete.after.files[0].observedHash = hash('different accepted font bytes');
  const unavailable = inspectRecoveryFontRaw(incomplete, f.binding, {fontInvariantProof: f.invariant.proof});
  assert.deepEqual(unavailable.measurements, []); assert.deepEqual(unavailable.failures, []);
  assert(unavailable.missing.some(message => /complete accepted font closures/.test(message)));
  const cancelled = await recoveryInvariantFixture(t, 'cancelled-over-limit-composition');
  for (const change of [raw => {raw.refusal.before.draftBytes = raw.refusal.after.draftBytes = 16384;},
    raw => {raw.refusal.after.previewDisabled = false;}, raw => {raw.refusal.after.applyDisabled = false;},
    raw => {raw.refusal.after.overLimitAdmission = false;}, raw => {raw.outcome.cancelDeferredUntilNativeEnd = false;},
    raw => {raw.after.nativeEditorBefore = raw.after.nativeEditorAfter = {present: true, hidden: false, session: 'draft'};}]) {
    const raw = clone(cancelled.raw); change(raw);
    const analysis = inspectRecoveryFontRaw(raw, cancelled.binding, {fontInvariantProof: cancelled.invariant.proof});
    assert.deepEqual(analysis.measurements, []); assert(analysis.failures.length > 0);
  }
});

test('recovery replay binds the exact attempt, specimen, runtime, journal, source and original action', async t => {
  const f = await recoveryInvariantFixture(t);
  for (const change of [args => {args.attempt.ordinal++;}, args => {args.serial++;}, args => {args.attempt.prime = true;},
    args => {args.cell.parameters.scenario = 'corrupt-font';}, args => {args.fixture.text.recoveryCases['missing-font'].differentSpecimen = true;},
    args => {args.fixture.seal.sha256 = hash('foreign fixture');}, args => {args.environment.sourceDigest = hash('foreign source').slice(7);},
    args => {args.environment.buildDigest = hash('foreign build');}, args => {args.workerProcessIdentity.pid++;},
    args => {args.browserCache = '/foreign-cache';}, args => {args.tools.browserPins.browsers[0].revision = 'foreign';},
    args => {args.developerState.state.h.browserIdentity.engines[0].sha256 = hash('foreign executable');},
    args => {args.controlFiles = args.controlFiles.filter(file => !file.path.endsWith('/browser-text-recovery-fonts.mjs'));},
    args => {args.controlFiles = args.controlFiles.filter(file => !file.path.endsWith('/evidence-volume.mjs'));},
    args => {args.sourceFiles.pop();}, args => {args.journalEvents[0].nonce = '2'.repeat(32);},
    args => {args.journalEvents[0].monotonicMs = args.attempt.endMs + 1;}, args => {args.journalEvents.push(clone(args.journalEvents[0]));},
    args => {args.journalEvents[0].raw.sha256 = hash('foreign raw');},
    args => {args.attempt.result.observations.recovery.draftHash = hash('foreign draft');},
    args => {args.attempt.result.observations.actions = [];}, args => {args.attempt.result.observations.actions[0].outcome = 'failed';},
    args => {args.attempt.result.observations.actions[0].inputMs = 121;}, args => {args.attempt.result.observations.actions[0].readyMs = 199;},
    args => {args.attempt.result.observations.actions.push(clone(args.attempt.result.observations.actions[0]));},
  ]) {const args = copyReplayArguments(f.p.args); change(args); await assert.rejects(verifyRecoveryFontEvidence(args));}
  const original = f.p.files.get('browser-runtime.json'), runtime = JSON.parse(original);
  runtime.executable = '/cache/foreign/browser'; f.p.files.set('browser-runtime.json', Buffer.from(JSON.stringify(runtime)));
  await assert.rejects(verifyRecoveryFontEvidence(f.p.args), /actual browser differs/);
  f.p.files.set('browser-runtime.json', original); assert(await verifyRecoveryFontEvidence(f.p.args));
});

test('recovery replay independently rejects missing, mutated or falsely published retained evidence', async t => {
  const f = await recoveryInvariantFixture(t);
  for (const change of [args => {args.attempt.result.observations.recoveryFonts.analysis.physicalPresentation = true;},
    args => {args.attempt.result.observations.recoveryFonts.acceptedDocumentOnly = false;},
    args => {args.attempt.result.observations.recoveryFonts.raw.path = '../foreign.json';},
    args => {args.attempt.result.observations.recoveryFonts.raw.bytes = 4 * 1048576 + 1;},
    args => {args.attempt.result.measurements[0].value++;}, args => {args.attempt.result.measurements.push(clone(args.attempt.result.measurements[0]));},
    args => {args.retainedFiles = args.retainedFiles.filter(file => file.path !== f.invariant.evidence.members[0].path);},
  ]) {const args = copyReplayArguments(f.p.args); change(args); await assert.rejects(verifyRecoveryFontEvidence(args));}
  for (const path of [f.p.args.attempt.result.observations.recoveryFonts.raw.path, f.invariant.evidence.members[0].path]) {
    const original = f.p.files.get(path), bytes = Buffer.from(original); bytes[0] ^= 1; f.p.files.set(path, bytes);
    await assert.rejects(verifyRecoveryFontEvidence(f.p.args)); f.p.files.set(path, original);
  }
  const evidence = clone(f.raw.fontInvariant); f.raw.fontInvariant.members.pop(); f.seal();
  await assert.rejects(verifyRecoveryFontEvidence(f.p.args));
  f.raw.fontInvariant = evidence; f.seal(); assert(await verifyRecoveryFontEvidence(f.p.args));
});

test('missing immutable recovery proof never supplies a substitution zero or permits a complete result', async t => {
  const f = await recoveryInvariantFixture(t), missing = inspectRecoveryFontRaw(f.raw, f.binding), serialized = inspectRecoveryFontRaw(f.raw, f.binding, {fontInvariantProof: clone(f.invariant.proof)});
  for (const analysis of [missing, serialized]) {
    assert.equal(analysis.measurements.length, 3); assert(!analysis.measurements.some(row => row.name === invariantRule.name));
    assert(analysis.missing.some(message => /immutable source\/layout\/text\/font replay/.test(message)));
  }
  f.raw.fontInvariant = null; f.seal();
  const proof = await verifyRecoveryFontEvidence(f.p.args);
  assert.match(recoveryFontMeasurement({cell: f.p.args.cell, sample: f.p.args.attempt, rule: invariantRule, proof}).reason, /unavailable/);
  f.p.args.attempt.status = f.p.args.attempt.result.status = 'PASS';
  await assert.rejects(verifyRecoveryFontEvidence(f.p.args), /missing recovery evidence was reported complete/);
  f.p.args.attempt.status = f.p.args.attempt.result.status = 'INCONCLUSIVE';
  delete f.p.args.attempt.result.observations.recoveryFonts; f.p.args.attempt.result.measurements = [];
  assert.equal(await verifyRecoveryFontEvidence(f.p.args), null);
  f.p.args.attempt.result.measurements = [{...invariantRule, value: 0}];
  await assert.rejects(verifyRecoveryFontEvidence(f.p.args), /lack retained observation/);
  f.p.args.attempt.result.measurements = []; f.p.args.attempt.status = 'PASS';
  await assert.rejects(verifyRecoveryFontEvidence(f.p.args), /lack retained observation/);
});

test('interrupted recovery and incomplete original refusal withhold all accepted font rows', async t => {
  const f = await recoveryInvariantFixture(t), original = clone(f.raw);
  for (const change of [raw => {raw.failed = true;}, raw => {raw.refusal.completed = false;},
    raw => {raw.outcome.missing = 1;}, raw => {raw.before = null;}, raw => {raw.after = null; raw.fontInvariant = null;},
    raw => {raw.missing.push('recovery-accepted-baseline-unavailable');}]) {
    Object.assign(f.raw, clone(original)); change(f.raw); const analysis = f.seal();
    assert.deepEqual(analysis.measurements, []); assert(analysis.missing.length > 0);
    const proof = await verifyRecoveryFontEvidence(f.p.args);
    for (const rule of f.p.args.cell.requiredMeasurements) assert.match(recoveryFontMeasurement({cell: f.p.args.cell, sample: f.p.args.attempt, rule, proof}).reason, /unavailable/);
  }
  Object.assign(f.raw, clone(original)); f.seal();
  // A separately failed budget does not erase independently complete rows.
  f.p.args.attempt.status = f.p.args.attempt.result.status = 'FAIL';
  const proof = await verifyRecoveryFontEvidence(f.p.args);
  assert.equal(recoveryFontMeasurement({cell: f.p.args.cell, sample: f.p.args.attempt, rule: invariantRule, proof}).measurement.value, 0);
});


test('recovery observer preserves one original action through unavailable reads and retains failed lifecycle evidence', async t => {
  const output = await mkdtemp(join(tmpdir(), 'recovery-font-observation-'));
  t.after(() => rm(output, {recursive: true, force: true}));
  const p = packet({output}), scenario = 'missing-font', events = [];
  p.args.cell.operation = 'text.recovery'; p.args.cell.parameters = {scenario};
  p.args.fixture.text.recoveryCases = {[scenario]: {scenario}};
  let actions = 0, refusals = 0, reads = 0;
  const observer = createRecoveryFontObserver({
    page: {evaluate: async () => {reads++; throw Error('diagnostic protocol unavailable');}},
    repo: p.args.sourceRoot, root: join(output, 'unavailable-private-root'), cell: p.args.cell, sample: p.args.attempt, serial: p.args.serial,
    fixture: p.args.fixture, runtime: p.binding.runtime, environment: p.args.environment,
    processIdentity: p.args.workerProcessIdentity, output, journal: async event => events.push(event),
  });
  await assert.rejects(observer.refusal(async () => {refusals++;}), /one original recovery refusal/);
  await assert.rejects(observer.observe(async () => {
    actions++;
    await assert.rejects(observer.observe(async () => {actions++;}), /one recovery observation/);
    await assert.rejects(observer.finish(), /observer must settle/);
    assert.equal(await observer.refusal(async () => {refusals++; return 7;}), 7);
    await assert.rejects(observer.refusal(async () => {refusals++;}), /one original recovery refusal/);
    throw Error('original recovery interrupted after refusal');
  }), /original recovery interrupted after refusal/);
  assert.equal(actions, 1); assert.equal(refusals, 1); assert(reads > 0);
  const {proof, observation} = await observer.finish();
  assert.deepEqual(observation.analysis.measurements, []); assert.deepEqual(observation.analysis.failures, []);
  assert(observation.analysis.missing.some(message => /Original recovery action did not complete/.test(message)));
  assert.equal(observation.analysis.acceptedDocumentOnly, true); assert.equal(observation.analysis.draftRendering, false);
  assert.equal(observation.analysis.physicalPresentation, false); assert.equal(observation.analysis.qualification, false);
  assert.match(recoveryFontMeasurement({cell: p.args.cell, sample: p.args.attempt, rule: invariantRule, proof}).reason, /unavailable/);
  const rawBytes = await readFile(join(output, observation.raw.path)), raw = JSON.parse(rawBytes);
  assert.equal(rawBytes.length, observation.raw.bytes); assert.equal(hash(rawBytes), observation.raw.sha256);
  assert.equal(raw.failed, true); assert.equal(raw.before, null); assert.equal(raw.after, null);
  assert.equal(raw.fontInvariant, null); assert.equal(raw.outcome, null);
  assert.equal(raw.refusal.completed, true); assert.equal(raw.refusal.before, null); assert.equal(raw.refusal.after, null);
  for (const code of ['recovery-accepted-baseline-unavailable', 'recovery-accepted-closure-unavailable',
    'recovery-refusal-baseline-unavailable', 'recovery-refusal-endpoint-unavailable']) assert(raw.missing.includes(code));
  assert(raw.startedMs <= raw.actionStartedMs && raw.actionStartedMs <= raw.refusal.startedMs && raw.refusal.startedMs <= raw.refusal.endedMs &&
    raw.refusal.endedMs <= raw.actionEndedMs && raw.actionEndedMs <= raw.endedMs);
  assert.deepEqual((await readdir(output)).sort(), [observation.binding.path, observation.raw.path].sort());
  assert.equal(events.length, 1); assert.equal(events[0].event, 'recovery-font-observed');
  assert.deepEqual(events[0].raw, observation.raw); assert.deepEqual(events[0].binding, observation.binding);
  await assert.rejects(observer.observe(async () => {actions++;}), /one recovery observation/);
  await assert.rejects(observer.refusal(async () => {refusals++;}), /one original recovery refusal/);
  await assert.rejects(observer.finish(), /observer must settle/);
  assert.equal(actions, 1); assert.equal(refusals, 1); assert.equal(events.length, 1);
});


import {createReopenFontObserver, inspectReopenFontRaw, reopenFontFixtureIdentity, reopenFontOutcome, reopenFontMeasurement, verifyReopenFontEvidence} from '../../tooling/qualification/campaigns/browser-reopen-fonts.mjs';

// This reuses the genuine immutable source/layout/font sidecars above. Browser
// metadata and clocks remain synthetic verifier inputs, never a browser result.
function reopenFixtureProjection(f) {
  const fonts=f.p.raw.fonts, root=fonts.before;
  return {documentId:root.documentId,seal:clone(f.p.args.fixture.seal),
    text:{schema:'browser-reopen-text-fixture-1',documentId:root.documentId,revision:root.revision,imageState:clone(root.imageState),semanticDigest:root.semanticDigest,orderedLayerIds:[...root.orderedLayerIds]},
    native:{schema:'browser-reopen-native-fixture-1',fonts:clone(fonts.fonts),fontAssetIds:fonts.files.map(file=>file.assetId),textFacts:fonts.layers.map((layer,i)=>({layerId:layer.id,sourceHash:layer.source.hash,textHash:layer.textHash,textBytes:Number(f.sources[i].text.textUtf8.byteLength),layoutHash:f.sources[i].render.layout.hash,pixelHash:layer.rasterHash,rendererHash:layer.renderer.id,fonts:layer.fontIds.map(id=>fonts.fonts.find(font=>font.id===id).bytes.hash)}))}};
}
async function reopenInvariantFixture(t) {
  const f=await invariantFixture(t),p=f.p,nonce=p.raw.nonce;
  p.args.cell.id='I10H/portable-reopen';p.args.cell.operation='portable.reopen';p.args.attempt.id=p.args.cell.id+'/cold/scored/1';
  p.args.fixture=reopenFixtureProjection(f);
  const attempt={cellId:p.args.cell.id,id:p.args.attempt.id,cache:'cold',ordinal:1,prime:false,serial:1};
  const binding={kind:'reopen-font-binding-1',nonce,operation:'portable.reopen',attempt,fixtureSeal:clone(p.args.fixture.seal),fixture:reopenFontFixtureIdentity(p.args.fixture),environment:clone(p.args.environment),processIdentity:clone(p.args.workerProcessIdentity),runtime:clone(p.binding.runtime)};
  const fonts={...clone(p.raw.fonts),kind:'accepted-document-fonts-1',binding:clone(attempt),timeOrigin:2000,startMs:230,endMs:250,nativeEditorBefore:{present:true,hidden:true,session:''},nativeEditorAfter:{present:true,hidden:true,session:''}};
  const outcome={documentId:'doc',acceptedTestEdit:true,startupBoundary:'document-ready-via-Open',publicOpenCompleted:true,viewportAsset:'current-composite',authoritativeDOMReadyMs:280};
  const raw={kind:'reopen-font-raw-1',nonce,binding:clone(attempt),clock:'runner-monotonic',startedMs:20,endedMs:400,actionStartedMs:100,actionEndedMs:300,
    priorRealm:{timeOrigin:1000,atMs:50},afterRealm:{timeOrigin:2000,atMs:260},navigations:[150],navigationCount:1,
    checkpoint:{commandId:'checkpoint',documentId:'doc',status:'accepted',observedDurableReceiptMs:320,replyObservedMs:290,expectedDocumentRevision:'3',documentRevision:'3',transactionId:'transaction'},fonts,outcome:reopenFontOutcome(outcome),failed:false,fontInvariant:null,missing:[]};
  const invariant=await f.collect({fonts,nonce});await f.retain(invariant.evidence);raw.fontInvariant=invariant.evidence;
  for(const name of ['browser-driver.mjs','browser-reopen-fonts.mjs','browser-text-resources.mjs','fixture-portable.mjs','fixtures.mjs'])p.args.controlFiles.push({path:'tooling/qualification/campaigns/'+name,sha256:hash(name).slice(7)});
  p.args.cell.requiredMeasurements=[{name:'R35CurrentFontFaces',unit:'count',budgetId:'R35'},{name:'R35SingleFontBytes',unit:'bytes',budgetId:'R35'},{name:'R35CurrentFontSetBytes',unit:'bytes',budgetId:'R35'},invariantRule];
  p.args.attempt.result.observations=clone(outcome);p.args.attempt.result.phases=[];
  p.args.attempt.result.evidence={observedCommandReceipts:[{commandId:'checkpoint',observedMs:305}]};
  for(const path of p.files.keys())if(path.startsWith('ordinary-text-')&&(path.endsWith('-raw.json')||path.endsWith('-binding.json')))p.files.delete(path);
  const seal=({fontInvariantProof=invariant.proof}={})=>{
    const put=(name,value)=>{const path='reopen-font-'+nonce+'-'+name+'.json',bytes=Buffer.from(JSON.stringify(value));p.files.set(path,bytes);return{path,bytes:bytes.length,sha256:hash(bytes)};};
    const bindingArtifact=put('binding',binding),artifact=put('raw',raw),analysis=inspectReopenFontRaw(raw,binding,{fontInvariantProof});
    p.args.attempt.result.observations.reopenFonts={kind:'reopen-font-observation-1',nonce,binding:bindingArtifact,raw:artifact,analysis,qualification:false,acceptedDocumentOnly:true};
    p.args.attempt.result.measurements=analysis.measurements.map(row=>({...row,evidence:[{kind:'reopen-font-retained-observation-1',artifact:{...artifact,path:join(f.output,artifact.path)}}]}));
    p.args.retainedFiles=[...p.files].map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}));
    p.args.journalEvents=[{event:'reopen-font-observed',cellId:p.args.cell.id,nonce,binding:bindingArtifact,raw:artifact,monotonicMs:410}];return analysis;
  };
  seal();return{...f,raw,binding,invariant,seal};
}

test('portable reopen replays immutable hidden-layer fonts and translates only its owned four-row proof',async t=>{
  const f=await reopenInvariantFixture(t),{p}=f;p.args.attempt.status=p.args.attempt.result.status='PASS';
  const proof=await verifyReopenFontEvidence(p.args),analysis=p.args.attempt.result.observations.reopenFonts.analysis;
  assert.equal(f.image.layers[1].visible,false);assert.equal(f.invariant.evidence.members.length,7);
  assert.deepEqual(analysis.missing,[]);assert.deepEqual(analysis.failures,[]);assert.equal(analysis.qualification,false);assert.equal(analysis.draftRendering,false);assert.equal(analysis.physicalPresentation,false);
  const rows=p.args.cell.requiredMeasurements.map(rule=>reopenFontMeasurement({cell:p.args.cell,sample:p.args.attempt,rule,proof}).measurement);
  assert.deepEqual(Object.fromEntries(rows.map(row=>[row.name,row.value])),{R35CurrentFontFaces:1,R35SingleFontBytes:32,R35CurrentFontSetBytes:32,R35SilentFontSubstitutionCount:0});
  assert.deepEqual(rows,p.args.attempt.result.measurements);assert(rows.every(row=>row.evidence[0].kind==='reopen-font-retained-observation-1'));
  const translated=extractBrowserMeasurements({cell:p.args.cell,sample:p.args.attempt,reopenFontProof:proof});assert.deepEqual(translated.measurements,rows);assert.deepEqual(translated.unavailable,[]);
  for(const supplied of [clone(proof),{complete:true,measurements:rows}]){const forged=extractBrowserMeasurements({cell:p.args.cell,sample:p.args.attempt,reopenFontProof:supplied});assert.deepEqual(forged.measurements,[]);assert.equal(forged.unavailable.length,4);}
  const other=clone(p.args.attempt);other.ordinal++;assert.match(reopenFontMeasurement({cell:p.args.cell,sample:other,rule:invariantRule,proof}).reason,/unavailable/);
  assert.match(reopenFontMeasurement({cell:{...p.args.cell,operation:'navigation.ready'},sample:p.args.attempt,rule:invariantRule,proof}).reason,/unavailable/);
  assert.match(reopenFontMeasurement({cell:p.args.cell,sample:p.args.attempt,rule:{...invariantRule,unit:'bytes'},proof}).reason,/unavailable/);
});

test('portable reopen rejects old realms, unrelated receipt revisions and changed sealed current graph without borrowing proof',async t=>{
  const f=await reopenInvariantFixture(t);
  const cases=[
    r=>{r.afterRealm.timeOrigin=r.priorRealm.timeOrigin;},r=>{r.fonts.timeOrigin++;},r=>{r.navigationCount=2;r.navigations.push(160);},
    r=>{r.checkpoint.documentRevision='4';},r=>{r.checkpoint.expectedDocumentRevision='2';},r=>{r.checkpoint.replyObservedMs=301;},r=>{r.checkpoint.observedDurableReceiptMs=299;},
    r=>{r.outcome.publicOpenCompleted=false;},r=>{r.fonts.before.imageState.hash=hash('foreign image');r.fonts.after.imageState.hash=hash('foreign image');},
    r=>{r.fonts.files[0].assetId='seed-font-not-current';},r=>{r.fontInvariant.members=r.fontInvariant.members.filter(member=>member.ref.hash!==f.sources[1].render.layout.hash);},
  ];
  for(const mutate of cases){const raw=clone(f.raw);mutate(raw);const analysis=inspectReopenFontRaw(raw,f.binding,{fontInvariantProof:f.invariant.proof});assert.equal(analysis.measurements.length,0);assert(analysis.failures.length||analysis.missing.length);}
  const missing=clone(f.raw);missing.fontInvariant=null;const absent=inspectReopenFontRaw(missing,f.binding);assert.equal(absent.measurements.length,3);assert(!absent.measurements.some(row=>row.name===invariantRule.name));assert(absent.missing.length);
  const failed=clone(f.raw);failed.failed=true;assert.equal(inspectReopenFontRaw(failed,f.binding,{fontInvariantProof:f.invariant.proof}).measurements.length,0);
});

test('portable retained replay requires exact attempt, runtime, journal, original endpoint and response joins',async t=>{
  const f=await reopenInvariantFixture(t),{p}=f;await verifyReopenFontEvidence(p.args);
  const cases=[
    a=>{a.attempt.ordinal++;},a=>{a.fixture.documentId='seed-document';},a=>{a.environment.sourceDigest=hash('other source').slice(7);},
    a=>{a.controlFiles=a.controlFiles.filter(row=>!row.path.endsWith('/browser-reopen-fonts.mjs'));},a=>{a.sourceFiles=a.sourceFiles.filter(row=>row.path!=='src/ui/native-text.ts');},
    a=>{a.workerProcessIdentity.pid++;},a=>{a.tools.browserPins.browsers[0].revision='other';},a=>{a.journalEvents=[];},
    a=>{a.attempt.result.observations.authoritativeDOMReadyMs=281;},a=>{a.attempt.result.evidence.observedCommandReceipts=[];},
    a=>{a.attempt.result.evidence.observedCommandReceipts[0].observedMs=289;},a=>{a.attempt.result.evidence.observedCommandReceipts.push(clone(a.attempt.result.evidence.observedCommandReceipts[0]));},
  ];
  for(const mutate of cases){const args=copyReplayArguments(p.args);mutate(args);await assert.rejects(verifyReopenFontEvidence(args),/Reopen fonts:/);}
  const missing=copyReplayArguments(p.args);delete missing.attempt.result.observations.reopenFonts;missing.attempt.status=missing.attempt.result.status='PASS';await assert.rejects(verifyReopenFontEvidence(missing),/lack retained observation/);
});

test('portable immutable replay refuses modified retained bytes even after an outer artifact seal is replaced',async t=>{
  const f=await reopenInvariantFixture(t),{p}=f;
  const member=f.invariant.evidence.members.find(value=>value.ref.hash===f.sources[1].render.layout.hash),original=p.files.get(member.path),changed=Buffer.from(original);changed[0]^=1;p.files.set(member.path,changed);
  const outer=p.args.retainedFiles.find(value=>value.path===member.path);outer.sha256=hash(changed);
  await assert.rejects(verifyReopenFontEvidence(p.args));
  p.files.set(member.path,original);outer.sha256=hash(original);
  await verifyReopenFontEvidence(p.args);
  const rawIdentity=p.args.attempt.result.observations.reopenFonts.raw,rawBytes=p.files.get(rawIdentity.path);p.files.set(rawIdentity.path,Buffer.concat([rawBytes,Buffer.from(' ')]));
  await assert.rejects(verifyReopenFontEvidence(p.args),/retained bytes differ/);
});

function reopenObserverHarness(f,{failReads=false}={}){
  const listeners=new Map(),frame={},events=[],reads=[],journal=[];let origin=1000;
  const page={mainFrame:()=>frame,on(name,fn){assert(!listeners.has(name));listeners.set(name,fn);},off(name,fn){assert.equal(listeners.get(name),fn);listeners.delete(name);},
    async evaluate(_fn,arg){reads.push(arg);if(failReads)throw Error('diagnostic unavailable');if(arg===undefined)return{timeOrigin:origin,atMs:500};
      if(arg&&typeof arg==='object'&&Object.hasOwn(arg,'commandId')){events.push('durable-read');return{commandId:arg.commandId,status:'accepted',transactionId:arg.transactionId,documentRevision:'3'};}
      if(typeof arg==='string')return;throw Error('font closure deliberately unavailable');}};
  const observer=createReopenFontObserver({page,repo:f.repo,root:f.root,cell:f.p.args.cell,sample:f.p.args.attempt,serial:1,fixture:f.p.args.fixture,runtime:f.binding.runtime,environment:f.p.args.environment,processIdentity:f.p.args.workerProcessIdentity,output:f.output,journal:async event=>journal.push(event)});
  const emit=(name,value)=>{assert(listeners.has(name));listeners.get(name)(value);};
  const request=(overrides={})=>{const command={commandId:'checkpoint',documentId:'doc',expectedDocumentRevision:'3',transactionId:'transaction',body:{type:'SaveCheckpoint'},...overrides};return{method:()=> 'POST',url:()=> 'http://127.0.0.1:4000/api/v1/commands',postData:()=>JSON.stringify({command})};};
  const navigate=()=>{origin=2000;emit('framenavigated',frame);};
  return{observer,listeners,events,reads,journal,emit,request,navigate};
}

test('portable observer keeps the original result and reads one exact same-request checkpoint only after action return',async t=>{
  const f=await reopenInvariantFixture(t),h=reopenObserverHarness(f),result={documentId:'doc',acceptedTestEdit:true,startupBoundary:'document-ready-via-Open',publicOpenCompleted:true,viewportAsset:'current',authoritativeDOMReadyMs:null};let actions=0;
  const actual=await h.observer.navigation(async()=>{actions++;h.events.push('action');h.navigate();const req=h.request();h.emit('request',req);h.emit('response',{request:()=>h.request(),status:()=>202});h.emit('response',{request:()=>req,status:()=>202});assert(!h.events.includes('durable-read'));result.authoritativeDOMReadyMs=performance.now();h.events.push('action-return');return result;});
  assert.strictEqual(actual,result);assert.equal(actions,1);assert.deepEqual(h.events,['action','action-return','durable-read']);assert.equal(h.listeners.size,0);
  const {observation}=await h.observer.finish(),raw=JSON.parse(await readFile(join(f.output,observation.raw.path)));
  assert.equal(raw.checkpoint.commandId,'checkpoint');assert.equal(raw.checkpoint.transactionId,'transaction');assert.equal(raw.checkpoint.documentRevision,'3');assert.equal(raw.navigationCount,1);
  assert(raw.checkpoint.replyObservedMs<=raw.actionEndedMs);assert(raw.checkpoint.observedDurableReceiptMs>=raw.actionEndedMs);assert.deepEqual(raw.outcome,reopenFontOutcome(result));
  assert.equal(raw.fonts,null);assert.equal(observation.analysis.measurements.length,0);assert(raw.missing.includes('reopen-accepted-font-closure-unavailable'));
  assert.equal(h.reads.filter(arg=>arg&&typeof arg==='object'&&Object.hasOwn(arg,'commandId')).length,1);assert.equal(h.journal.length,1);
});

test('portable observer refuses ambiguous original requests and responses without inventing a durable receipt',async t=>{
  for(const variant of ['two-requests','two-responses','foreign-response','wrong-document']){
    const f=await reopenInvariantFixture(t),h=reopenObserverHarness(f);let actions=0;
    await h.observer.navigation(async()=>{actions++;h.navigate();const req=h.request(variant==='wrong-document'?{documentId:'other'}:{});h.emit('request',req);if(variant==='two-requests')h.emit('request',h.request());
      h.emit('response',{request:()=>variant==='foreign-response'?h.request():req,status:()=>202});if(variant==='two-responses')h.emit('response',{request:()=>req,status:()=>202});return{};});
    const {observation}=await h.observer.finish(),raw=JSON.parse(await readFile(join(f.output,observation.raw.path)));
    assert.equal(actions,1);assert.equal(h.listeners.size,0);assert.equal(raw.checkpoint,null);assert(!h.events.includes('durable-read'));assert.equal(observation.analysis.measurements.length,0);assert(raw.missing.length);
  }
});

test('portable observer preserves original thrown identity, removes listeners and prevents duplicate action or finish',async t=>{
  const f=await reopenInvariantFixture(t),h=reopenObserverHarness(f,{failReads:true}),failure=Object.freeze(new Error('original action refused'));let actions=0;
  await assert.rejects(h.observer.navigation(async()=>{actions++;await assert.rejects(h.observer.navigation(async()=>{actions++;}),/one original reopen/);await assert.rejects(h.observer.finish(),/must settle/);throw failure;}),error=>error===failure);
  assert.equal(actions,1);assert.equal(h.reads.length,2);assert.equal(h.listeners.size,0);assert.deepEqual(h.events,[]);
  const {observation,proof}=await h.observer.finish(),bytes=await readFile(join(f.output,observation.raw.path)),raw=JSON.parse(bytes);
  assert.equal(bytes.length,observation.raw.bytes);assert.equal(hash(bytes),observation.raw.sha256);assert.equal(raw.failed,true);assert.equal(raw.fonts,null);assert.equal(raw.checkpoint,null);assert.equal(raw.fontInvariant,null);
  assert(raw.missing.includes('original-reopen-action-failed'));assert.equal(observation.analysis.measurements.length,0);assert.match(reopenFontMeasurement({cell:f.p.args.cell,sample:f.p.args.attempt,rule:invariantRule,proof}).reason,/unavailable/);
  assert.equal(h.journal.length,1);await assert.rejects(h.observer.navigation(async()=>{actions++;}),/one original reopen/);await assert.rejects(h.observer.finish(),/must settle/);assert.equal(actions,1);
});


test('portable compact binding admits all 100 layers and 16 ordered fonts while preserving sequence identity',async t=>{
  const f=await reopenInvariantFixture(t),fixture=clone(f.p.args.fixture);
  const {canonical}=await import('../../dist/local/server/storage/canonical.js');
  fixture.native.fonts=Array.from({length:16},(_,i)=>{const {id:_id,...body}=clone(f.font);body.bytes={...body.bytes,hash:hash('maximal font '+i)};return{...body,id:hash(canonical(body))};});
  fixture.native.fontAssetIds=fixture.native.fonts.map((_,i)=>'current_font_'+i);
  const ordered=fixture.native.fonts.map(font=>font.bytes.hash),fact=fixture.native.textFacts[0];
  fixture.text.orderedLayerIds=Array.from({length:100},(_,i)=>'current_text_'+String(i).padStart(3,'0'));
  fixture.native.textFacts=fixture.text.orderedLayerIds.map((layerId,i)=>({...clone(fact),layerId,sourceHash:hash('current source '+i),fonts:[...ordered]}));
  const before=clone(fixture),identity=reopenFontFixtureIdentity(fixture),bytes=Buffer.byteLength(JSON.stringify(identity));
  assert.deepEqual(fixture,before);assert.equal(identity.native.textFacts.length,100);assert.equal(identity.native.fonts.length,16);assert.equal(identity.native.fontAssetIds.length,16);assert(bytes<=112*1024);
  for(const row of identity.native.textFacts){assert.equal(row.fontCount,16);assert.equal(row.fontSequenceHash,hash(JSON.stringify(ordered)));assert.equal(Object.hasOwn(row,'fonts'),false);}
  for(const mutate of [fonts=>fonts.reverse(),fonts=>fonts.pop(),fonts=>{fonts[7]=hash('changed single font');}]){
    const changed=clone(fixture);mutate(changed.native.textFacts[0].fonts);const other=reopenFontFixtureIdentity(changed);
    assert.notEqual(other.native.textFacts[0].fontSequenceHash,identity.native.textFacts[0].fontSequenceHash);assert.deepEqual(other.native.textFacts.slice(1),identity.native.textFacts.slice(1));
  }
  for(const mutate of [fact=>{fact.fontCount++;},fact=>{fact.fontSequenceHash=hash('different ordered fonts');}]){
    const binding=clone(f.binding);mutate(binding.fixture.native.textFacts[0]);const analysis=inspectReopenFontRaw(f.raw,binding,{fontInvariantProof:f.invariant.proof});assert.equal(analysis.measurements.length,0);assert(analysis.failures.length);
  }
  // The complete maximum fixture can be retained under the original binding
  // cap, even when a browser observation is unavailable. It grants no rows.
  const observer=createReopenFontObserver({page:{},repo:f.repo,root:f.root,cell:f.p.args.cell,sample:f.p.args.attempt,serial:1,fixture,runtime:f.binding.runtime,environment:f.p.args.environment,processIdentity:f.p.args.workerProcessIdentity,output:f.output});
  const {observation}=await observer.finish({failed:true}),retained=await readFile(join(f.output,observation.binding.path));
  assert(retained.length<=128*1024);assert.equal(retained.length,observation.binding.bytes);assert.equal(hash(retained),observation.binding.sha256);assert.deepEqual(JSON.parse(retained).fixture,identity);assert.equal(observation.analysis.measurements.length,0);
});
