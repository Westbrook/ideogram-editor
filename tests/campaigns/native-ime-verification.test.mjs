import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildNativeImePlan, inspectNativeImeTrace} from '../../tooling/qualification/campaigns/native-ime-contract.mjs';
import {nativeImeJSON, nativeImeHash, inspectNativeImeReview} from '../../tooling/qualification/campaigns/native-ime-authority.mjs';
import {verifyNativeImeEvidence, evaluateNativeImeProof} from '../../tooling/qualification/campaigns/native-ime-verification.mjs';

const hash = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);

// Explicitly synthetic scalar trace. Its trusted flags test the structural
// validator only; this fixture cannot prove native OS input or qualification.
function traceFixture({workload = 'WXn', commitInputAfterEnd = false} = {}) {
  const fragments = Array.from({length: 20}, (_, index) => 'fragment-' + index);
  fragments[3] = '中文'; fragments[10] = '日本語';
  const corpus = 'Initial multilingual text 😀.';
  const fixture = {text: {corpus: {text: corpus, sha256: hash(corpus), fragments, fragmentsHash: hash(JSON.stringify(fragments))}}};
  const plan = buildNativeImePlan(fixture, workload), nonce = 'synthetic-native-ime-attempt';
  const acceptedBefore = {documentId: 'document', documentRevision: 'revision', imageDigest: hash('image'), layerId: 'layer', layerVersion: 'layer-version', sourceHash: hash('source')};
  const state = {connected: true, parentUnchanged: true, nodeId: 1, parentId: 1, visible: true, focused: true,
    start: 0, end: 2, direction: 'forward', scrollTop: 12, scrollLeft: 3, units: corpus.length, textHash: hash(corpus),
    presentation: 'anchored', session: 'draft-session', revision: '1', textVersion: 1,
    switch: {pending: '', request: 0, requestEpoch: 2, requestGeneration: 1, requestTextVersion: 1, settled: 0,
      rejected: 0, rejectedEpoch: 0, rejectedGeneration: 0, rejectedCurrentEpoch: 0, rejectedCurrentGeneration: 0,
      rejectedTextVersion: 0, rejectedCurrentTextVersion: 0, rejectedGuards: 0, rejectedBoundary: '', reason: '', superseded: 0}};
  const initial = clone(state), records = [];
  let now = 100, capture = 1, composing = false, currentText = corpus;
  const value = next => {
    if (next !== currentText) {state.revision = String(Number(state.revision) + 1); state.textVersion++;}
    currentText = next; state.textHash = hash(next); state.units = next.length;
    state.start = state.end = next.length; state.direction = 'none';
  };
  const event = (type, {control = 'text', inputType = null, data = null, change = () => {}} = {}) => {
    if (type === 'compositionstart') composing = true;
    if (type === 'compositionend') composing = false;
    const row = {ordinal: records.length, type, timeStampMs: now, observedMs: now, afterObservedMs: now + 1,
      beforeCaptureOrdinal: ++capture, afterCaptureOrdinal: null, isTrusted: true, composing, control,
      eventDataHash: data === null ? null : hash(data), inputType, before: clone(state), after: null};
    change(); row.afterCaptureOrdinal = ++capture; row.after = clone(state); records.push(row); now += 10;
    return row;
  };
  const stateRow = () => {
    const ordinal = ++capture, snapshot = clone(state);
    records.push({ordinal: records.length, type: 'state', timeStampMs: null, observedMs: now, afterObservedMs: now,
      beforeCaptureOrdinal: ordinal, afterCaptureOrdinal: ordinal, isTrusted: null, composing, control: 'text',
      eventDataHash: null, inputType: null, before: snapshot, after: clone(snapshot)}); now += 10;
  };
  const request = deferred => event('click', {control: 'presentation', change: () => {
    const target = (state.switch.pending || state.presentation) === 'anchored' ? 'inspector' : 'anchored';
    const prior = state.switch.request;
    Object.assign(state.switch, {request: prior + 1, requestEpoch: 2, requestGeneration: Number(state.revision), requestTextVersion: state.textVersion});
    if (deferred) {
      if (state.switch.pending) Object.assign(state.switch, {rejected: prior, superseded: prior, reason: 'superseded'});
      state.switch.pending = target;
    } else {state.presentation = target; state.switch.settled = state.switch.request;}
  }});
  event('pointerdown', {control: 'presentation'});
  for (const item of plan.sequences) {
    if (item.index < 3) {
      state.direction = item.presentations[0].range; state.start = item.index === 2 ? currentText.length : 0; state.end = item.index === 2 ? state.start : 2;
      request(false);
    } else {state.start = state.end = currentText.length; state.direction = 'none';}
    const previous = currentText, desired = previous.slice(0, state.start) + fragments[item.fragmentIndex] + previous.slice(state.end);
    event('compositionstart', {data: ''});
    event('input', {inputType: 'insertCompositionText', data: item.outcome === 'commit' ? fragments[item.fragmentIndex] : '仮',
      change: () => value(item.outcome === 'commit' ? desired : previous + '仮')});
    if (item.index === 8) {request(true); request(true);}
    if (item.index === 9) {request(true); event('click', {control: 'cancel'});}
    const terminalInput = () => event('input', {inputType: item.outcome === 'commit' ? 'insertFromComposition' : 'deleteCompositionText',
      data: item.outcome === 'commit' ? fragments[item.fragmentIndex] : '', change: () => value(item.outcome === 'commit' ? desired : previous)});
    if (!commitInputAfterEnd || item.outcome === 'cancel') terminalInput();
    event('compositionend', {data: item.outcome === 'commit' ? fragments[item.fragmentIndex] : '', change: () => {
      if (item.index === 8) {state.presentation = state.switch.pending; state.switch.pending = ''; state.switch.settled = 5;}
      if (item.index === 9) {
        const captured = state.switch;
        Object.assign(state.switch, {pending: '', rejected: 6, rejectedEpoch: captured.requestEpoch, rejectedCurrentEpoch: 3,
          rejectedGeneration: captured.requestGeneration, rejectedCurrentGeneration: Number(state.revision),
          rejectedTextVersion: captured.requestTextVersion, rejectedCurrentTextVersion: state.textVersion,
          rejectedGuards: 7, rejectedBoundary: 'cancel-native-end', reason: 'cancelled'});
        state.session = ''; state.visible = false; state.focused = false;
        currentText = ''; state.units = 0; state.textHash = hash(''); state.start = state.end = 0;
      }
    }});
    if (commitInputAfterEnd && item.outcome === 'commit') terminalInput();
    stateRow();
  }
  const raw = {kind: 'native-ime-raw-1', nonce, clock: 'browser-performance', timeOrigin: 1700000000000,
    armedMs: 90, startMs: 100, endMs: 60100, captureStoppedMs: 60101, durationMs: 60000,
    initial, final: clone(state), records, overflow: false, interruptions: [], cleanup: {removed: true}};
  return {fixture, plan, nonce, raw, acceptedBefore, acceptedAfter: clone(acceptedBefore)};
}

// Entire packet is synthetic unit data. This tests retained-byte admission and
// cannot be used as a native session, human approval or campaign qualification.
function packet() {
  const f = traceFixture(), nonce = 'a'.repeat(32), prefix = 'native-ime-' + nonce + '/', groupOutput = '/test/campaign/group', sourceRoot = '/test/repo';
  f.raw.nonce = nonce; f.nonce = nonce; f.fixture.text.documentId = f.acceptedBefore.documentId; f.fixture.text.activeLayerId = f.acceptedBefore.layerId;
  f.acceptedBefore.sourceHash = f.fixture.text.corpus.sha256; f.acceptedAfter.sourceHash = f.fixture.text.corpus.sha256;
  const cell = {id: 'Q3/I10H/text-native-WXn', operation: 'text.native-ime', workload: 'WXn'}, attempt = {id: cell.id + '/cold/scored/1', cache: 'cold', ordinal: 1, prime: false, status: 'INCONCLUSIVE', startMs: 100, endMs: 63000, reset: {status: 'PASS', cache: 'cold'}, result: {observations: {}}};
  const epoch = f.raw.timeOrigin, sealedAt = epoch + 60150, receivedAt = epoch + 61100;
  const files = new Map(), put = (path, value, raw = false) => {const bytes = raw ? Buffer.from(value) : nativeImeJSON(value); files.set(path, bytes); return {path, bytes: bytes.length, sha256: nativeImeHash(bytes)};};
  const workerProcessIdentity = {pid: 999, startedAt: new Date(0).toISOString(), node: 'v26.10.0'};
  f.fixture.seal = {path: '/original/fixture.json', bytes: 10, sha256: hash('fixture')};
  const browserPath = '/test/cache/chromium/browser', uuid = '12345678-1234-1234-1234-123456789abc', browserRegistration = 'owned-process-1001-' + uuid + '.json';
  const process = {kind: 'browser', pid: 1001, pgid: 1001, executable: browserPath, startedAtIdentity: 'actual-start'};
  put(browserRegistration, {kind: 'perf-owned-processes-1', ownerPid: 999, processes: [process]});
  put('owned-process-1002-' + uuid + '.json', {kind: 'perf-owned-processes-1', ownerPid: 999, processes: [{kind: 'backend', pid: 1002, pgid: 1002, startedAtIdentity: 'backend-start'}]});
  const runtime = {headless: false, engine: 'chromium', version: '153.0.8010.12', revision: '1243', browserPid: 1001, backendPid: 1002, fixtureSeal: f.fixture.seal,
    executable: browserPath, executableIdentity: {bytes: 50, sha256: hash('browser')}, playwrightModule: sourceRoot + '/node_modules/playwright-core/index.mjs',
    ownedLaunch: {context: {createdBy: 'browser.newContext', freshAtLaunch: true}, process: {...process, registration: {path: groupOutput + '/' + browserRegistration}}}};
  put('browser-runtime.json', runtime);
  const tools = {browserPins: {browsers: [{name: 'chromium', revision: runtime.revision, browserVersion: runtime.version}]}}, environment = {sourceDigest: hash('source'), buildDigest: hash('build'), toolsDigest: hash('tools'), controlDigest: hash('control'), host: {platform: 'darwin', architecture: 'arm64', kernel: 'kernel', osVersion: '15.7', osBuild: 'build', hostnameHash: hash('host')}};
  const configuration = {browser: {nativeIme: {kind: 'native-ime-selection-1', operatorPaths: {WXn: '/original/operator.json'}}}}, selection = {kind: 'native-ime-selection-1', operatorPath: '/original/operator.json', armTimeoutMs: 30000, reviewTimeoutMs: 120000};
  const original = {path: '/original/settings', bytes: 8, sha256: hash('settings'), role: 'os-input-settings'};
  const operator = {kind: 'native-ime-operator-1', actualNative: true, operatorId: 'operator', method: {kind: 'human', description: 'Synthetic fixture only'}, inputSource: {language: 'japanese', id: 'test.japanese', build: '1'}, dictionary: 'default', settings: 'default', os: {name: 'macOS', version: '15.7', build: 'build'}, evidence: [original]};
  const operatorEvidence = [{...put(prefix + 'operator-evidence-0.record', 'settings', true), originalPath: original.path}];
  const planArtifact = put(prefix + 'plan.json', f.plan), operatorArtifact = put(prefix + 'operator.json', operator);
  const binding = {kind: 'native-ime-binding-1', nonce, attempt: {cellId: cell.id, id: attempt.id, cache: 'cold', ordinal: 1, prime: false, serial: 1}, processIdentity: workerProcessIdentity, runtime, environment, fixtureSeal: f.fixture.seal, plan: planArtifact, operator: operatorArtifact, operatorEvidence, selection, acceptedBefore: f.acceptedBefore};
  const bindingArtifact = put(prefix + 'binding.json', binding), rawArtifact = put(prefix + 'raw.json', f.raw);
  const analysis = inspectNativeImeTrace(f.raw, f);
  const seal = {kind: 'native-ime-raw-seal-1', nonce, raw: rawArtifact, binding: bindingArtifact, plan: planArtifact, acceptedAfter: f.acceptedAfter, sealedAt, reviewTimeoutMs: 120000, analysis};
  const sealArtifact = put(prefix + 'raw-seal.json', seal);
  const reviewEvidenceOriginal = {path: '/original/session', role: 'native-session-observation', bytes: 7, sha256: hash('session')};
  const review = {kind: 'native-ime-review-1', complete: true, actualNative: true, synthetic: false, collectorGenerated: false, reviewerId: 'reviewer', method: 'Synthetic reviewer only', observations: 'Unit fixture; no actual native witness', evidence: [reviewEvidenceOriginal], nonce, binding: bindingArtifact, raw: rawArtifact, plan: planArtifact, inputSource: 'japanese', reviewedAt: new Date(epoch + 61000).toISOString()};
  const reviewArtifact = put(prefix + 'review.json', review), authority = inspectNativeImeReview(review, {operator, plan: f.plan, nonce, binding: bindingArtifact, raw: rawArtifact, planArtifact, sealedAt, receivedAt, reviewTimeoutMs: 120000});
  const reviewReceipt = put(prefix + 'review-receipt.json', {kind: 'native-ime-review-receipt-1', nonce, review: reviewArtifact, receivedAt, receivedElapsedMs: 1000, evidence: [{...put(prefix + 'review-evidence-0.record', 'session', true), originalPath: reviewEvidenceOriginal.path}], authority});
  const observation = {kind: 'native-ime-observation-1', qualification: false, physicalPresentation: false, nonce, binding: bindingArtifact, raw: rawArtifact, plan: planArtifact, seal: sealArtifact, review: reviewArtifact, reviewReceipt, trace: analysis.observation};
  attempt.result.observations.nativeIme = observation;
  const state = {productRepo: sourceRoot, sourceDigest: environment.sourceDigest, playwrightBrowsersPath: '/test/cache', h: {source: sourceRoot, completed: true, browserIdentity: {engines: [{engine: 'chromium', executable: browserPath, version: runtime.version, revision: runtime.revision, ...runtime.executableIdentity}]}}};
  const developerState = {kind: 'developer-runtime-state-1', sha256: hash(nativeImeJSON(state)).slice(7), state};
  const journalEvents = [
    {event: 'native-ime-capture-start', cellId: cell.id, nonce, monotonicMs: 110, utc: new Date(epoch + 80).toISOString()},
    {event: 'native-ime-ready', cellId: cell.id, nonce, monotonicMs: 120, utc: new Date(epoch + 95).toISOString(), binding: bindingArtifact},
    {event: 'native-ime-raw-sealed', cellId: cell.id, nonce, monotonicMs: 60200, utc: new Date(epoch + 60200).toISOString(), raw: rawArtifact},
    {event: 'native-ime-reviewed', cellId: cell.id, nonce, monotonicMs: 61200, utc: new Date(epoch + 61200).toISOString(), review: reviewArtifact},
  ];
  const args = {attempt, cell, serial: 1, configuration, groupOutput, fixture: f.fixture, workerProcessIdentity, sourceRoot, engine: 'chromium', developerState, developerStateIdentity: {sha256: hash('state')}, browserCache: '/test/cache', tools, environment, journalEvents,
    controlFiles: ['browser.mjs', 'browser-text.mjs', 'browser-native-ime.mjs', 'browser-native-ime-observer.mjs', 'native-ime-contract.mjs', 'native-ime-authority.mjs', 'native-ime-verification.mjs', 'worker.mjs', 'run.mjs', 'verification.mjs'].map(name => ({path: 'tooling/qualification/campaigns/' + name, sha256: hash(name)})),
    readRetained: async (path, {maximum}) => {const bytes = files.get(path); assert.ok(bytes, 'Required fixture bytes ' + path); assert.ok(bytes.length <= maximum, 'Read must remain bounded'); return bytes;}};
  const refresh = () => {args.retainedPaths = [...files.keys()]; args.retainedFiles = [...files].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: nativeImeHash(bytes)}));};
  refresh(); return {args, observation, files, put, refresh, prefix, analysis};
}

test('sealed synthetic packet exercises real replay capability without granting physical qualification', async () => {
  const p = packet(); assert.equal(p.analysis.status, 'PASS');
  const proof = await verifyNativeImeEvidence(p.args), result = evaluateNativeImeProof(proof, p.observation);
  assert.equal(result.outcome, 'PASS'); assert.equal(result.nativeCompatibility, true); assert.equal(result.qualification, false); assert.equal(result.physicalPresentation, false); assert.equal(result.scanout, false);
  assert.equal(evaluateNativeImeProof({...proof}, p.observation).outcome, 'INCONCLUSIVE');
  assert.equal(evaluateNativeImeProof(proof, {...p.observation, nonce: 'b'.repeat(32)}).outcome, 'INCONCLUSIVE');
});
test('native replay rejects old worker/attempt, unowned browser and impossible sixty-second journal', async () => {
  for (const alter of [p => p.args.attempt.ordinal = 2, p => p.args.workerProcessIdentity.pid++, p => p.args.environment.host.osBuild = 'other', p => p.args.journalEvents[2].monotonicMs = 130, p => p.args.journalEvents[3].monotonicMs = p.args.attempt.endMs + 1]) {
    const p = packet(); alter(p); await assert.rejects(verifyNativeImeEvidence(p.args));
  }
  const p = packet(); p.args.developerState = null; assert.equal(await verifyNativeImeEvidence(p.args), null);
});
test('native replay requires real independently pinned browser bytes', async () => {
  const p = packet(), runtime = JSON.parse(p.files.get('browser-runtime.json')), binding = JSON.parse(p.files.get(p.prefix + 'binding.json'));
  delete runtime.executableIdentity.sha256; delete binding.runtime.executableIdentity.sha256;
  delete p.args.developerState.state.h.browserIdentity.engines[0].sha256;
  p.args.developerState.sha256 = hash(nativeImeJSON(p.args.developerState.state)).slice(7);
  p.put('browser-runtime.json', runtime); p.observation.binding = p.put(p.prefix + 'binding.json', binding); p.refresh();
  await assert.rejects(verifyNativeImeEvidence(p.args), /immutable identity/);
});

test('changed retained raw or external evidence cannot be admitted by re-sealing the outer inventory', async () => {
  for (const name of ['raw.json', 'review.json', 'operator-evidence-0.record', 'review-evidence-0.record']) {
    const p = packet(); p.files.set(p.prefix + name, Buffer.from('changed')); p.refresh(); await assert.rejects(verifyNativeImeEvidence(p.args), /seal|bytes|differs/);
  }
});
test('missing or copied review never confers authority on an otherwise structurally valid trace', async () => {
  const p = packet(); p.observation.reviewReceipt = null; assert.equal(await verifyNativeImeEvidence(p.args), null);
  const q = packet(); q.args.journalEvents = q.args.journalEvents.filter(row => row.event !== 'native-ime-reviewed'); await assert.rejects(verifyNativeImeEvidence(q.args), /journal boundaries/);
});

test('native replay rejects another browser epoch and the first millisecond beyond freshness tolerance', async () => {
  for (const shift of [86400000, 106]) {
    const p = packet(), raw = JSON.parse(p.files.get(p.prefix + 'raw.json')), seal = JSON.parse(p.files.get(p.prefix + 'raw-seal.json'));
    raw.timeOrigin += shift; p.observation.raw = p.put(p.prefix + 'raw.json', raw);
    seal.raw = p.observation.raw; p.observation.seal = p.put(p.prefix + 'raw-seal.json', seal); p.refresh();
    await assert.rejects(verifyNativeImeEvidence(p.args), /browser epoch/);
  }
});
