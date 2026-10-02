import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {TEXT_INPUT_PROFILE, buildTextInputInventory, textInputDescriptor, textInputIdentity, textSessionNativeId, validateTextInput, projectTextInteraction} from '../../tooling/qualification/campaigns/browser-text-input.mjs';
import {textActionOracleSubject, textOracleInventory, validateTextActionOracle, joinTextActionPixels} from '../../tooling/qualification/campaigns/text-action-oracle.mjs';
import {verifyWindowServerTextSessionLosslessCapture, windowServerTextSessionLosslessCapacity} from '../../tooling/qualification/campaigns/windowserver-text-session-lossless.mjs';

// AUTHORED ONLY: no imports, test execution, browser/native invocation or pixel
// generation was performed while staging this source. These data fixtures are
// structural examples, never an independently reviewed product pixel oracle.
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function fixture() {
  const display = {id: 7, width: 120, height: 80}, roi = {x: 10, y: 10, width: 2, height: 1};
  const environment = {fixtureSha256: 'a'.repeat(64), browserEnvironmentSha256: 'b'.repeat(64)};
  const selection = {displayID: display.id, roi};
  const actions = buildTextInputInventory().map((action, sequence) => ({sequence, actionId: action.id, family: action.kind,
    stateSha256: hash('independent-state-' + sequence), subject: textActionOracleSubject(action), kind: 'unavailable', reason: 'meaningful-pixels-not-independently-reviewed'}));
  const oracle = {kind: 'text-action-pixel-oracle-1', schemaVersion: 1, profile: TEXT_INPUT_PROFILE, binding: environment, display, roi, pixelFormat: 'BGRA8', actions};
  return {oracle, selection, environment};
}
function census(value) {return textOracleInventory(value.oracle, {selection: value.selection, environment: value.environment});}
function pixels(value, index = 0) {
  const before = {path: 'reviewed/before.bgra', sha256: 'c'.repeat(64), bytes: 8};
  const after = {path: 'reviewed/after.bgra', sha256: 'd'.repeat(64), bytes: 8};
  const row = value.oracle.actions[index]; delete row.reason; Object.assign(row, {kind: 'pixels', before, after});
  return value;
}

test('exact original 106 actions remain explicit without reviewed pixel evidence', () => {
  const value = fixture(), result = census(value);
  assert.equal(value.oracle.actions.length, 106); assert.equal(result.files.length, 0); assert.equal(result.pixelBytes, 0);
  assert.deepEqual(result.directories, ['.']); assert.equal(result.status, undefined); assert.equal(result.qualification, undefined);
  const counts = Object.fromEntries(['insert-delete', 'caret', 'semantic-selection', 'text-format', 'preedit', 'composition-end', 'presentation']
    .map(family => [family, value.oracle.actions.filter(action => action.family === family).length]));
  assert.deepEqual(counts, {'insert-delete': 40, caret: 10, 'semantic-selection': 10, 'text-format': 10, preedit: 20, 'composition-end': 10, presentation: 6});
  assert.equal(buildTextInputInventory().reduce((sum, action) => sum + action.steps.length, 0), 247);
});

test('pixel census records bounded complete fixed ROI files and directories', () => {
  const value = pixels(fixture()), result = census(value);
  assert.deepEqual(result.files, [value.oracle.actions[0].before, value.oracle.actions[0].after]);
  assert.equal(result.pixelBytes, 16); assert.deepEqual(result.directories, ['.', 'reviewed']);
});

test('same pinned pixel path may be reused without double accounting', () => {
  const value = pixels(fixture());
  for (const index of [1, 2]) {
    const row = value.oracle.actions[index]; delete row.reason;
    Object.assign(row, {kind: 'pixels', before: clone(value.oracle.actions[0].before), after: clone(value.oracle.actions[0].after)});
  }
  assert.equal(census(value).files.length, 2); assert.equal(census(value).pixelBytes, 16);
});

test('all 212 distinct logical files are retained without an implicit 100-action cap', () => {
  const value = fixture();
  for (const row of value.oracle.actions) {
    delete row.reason; row.kind = 'pixels';
    row.before = {path: `pixels/action-${row.sequence}-before.bgra`, sha256: hash('before-' + row.sequence), bytes: 8};
    row.after = {path: `pixels/action-${row.sequence}-after.bgra`, sha256: hash('after-' + row.sequence), bytes: 8};
  }
  const result = census(value); assert.equal(result.files.length, 212); assert.equal(result.pixelBytes, 1696);
});

test('census rejects omitted, duplicated, reordered and invented actions', () => {
  for (const mutate of [
    value => value.oracle.actions.pop(),
    value => {value.oracle.actions[105] = clone(value.oracle.actions[104]);},
    value => {[value.oracle.actions[0], value.oracle.actions[1]] = [value.oracle.actions[1], value.oracle.actions[0]];},
    value => value.oracle.actions.push(clone(value.oracle.actions[0])),
    value => {value.oracle.actions[0].family = 'stroke';},
    value => {value.oracle.actions[0].actionId = 'IText-107';},
  ]) {const value = fixture(); mutate(value); assert.throws(() => census(value));}
});

test('deferred presentation feedback cannot be relabelled as the later switch', () => {
  const value = fixture(), plan = buildTextInputInventory();
  const immediate = plan.findIndex(action => action.kind === 'presentation' && action.mode === 'immediate');
  const deferred = plan.findIndex(action => action.kind === 'presentation' && action.mode !== 'immediate');
  assert.equal(value.oracle.actions[immediate].subject, 'text-presentation-switch');
  assert.equal(value.oracle.actions[deferred].subject, 'text-presentation-pending-feedback');
  value.oracle.actions[deferred].subject = 'text-presentation-switch'; assert.throws(() => census(value), /subject/);
});

test('preedit and composition-end remain explicitly synthetic application handling subjects', () => {
  const value = fixture();
  assert.equal(value.oracle.actions.filter(action => action.subject === 'text-synthetic-preedit').length, 20);
  assert.equal(value.oracle.actions.filter(action => action.subject === 'text-synthetic-composition-end').length, 10);
  value.oracle.actions.find(action => action.family === 'preedit').subject = 'native-ime'; assert.throws(() => census(value), /subject/);
});

test('unavailable requires a reason and cannot carry unused pixel or qualification fields', () => {
  for (const mutate of [
    row => {delete row.reason;}, row => {row.reason = '';}, row => {row.reason = 'unreviewed pixels';},
    row => {row.before = {path: 'ignored.bgra', sha256: 'f'.repeat(64), bytes: 8};},
    row => {row.qualification = true;}, row => {row.kind = 'PASS';},
  ]) {const value = fixture(); mutate(value.oracle.actions[0]); assert.throws(() => census(value));}
});

test('unchanged pixels remain representable for explicit inconclusive join handling', () => {
  const value = pixels(fixture()); value.oracle.actions[0].after = clone(value.oracle.actions[0].before);
  assert.equal(census(value).files.length, 1);
});

test('rejects unsafe paths, wrong ROI extent and conflicting reuse of a file pin', () => {
  for (const path of ['/tmp/pixels.bgra', '../pixels.bgra', 'pixels/../after.bgra', 'pixels//after.bgra', 'pixels/./after.bgra', 'pixels\\after.bgra', 'pixels.png']) {
    const value = pixels(fixture()); value.oracle.actions[0].before.path = path; assert.throws(() => census(value));
  }
  const extent = pixels(fixture()); extent.oracle.actions[0].before.bytes = 4; assert.throws(() => census(extent), /complete exact ROI/);
  const conflict = pixels(fixture()); conflict.oracle.actions[0].after.path = conflict.oracle.actions[0].before.path;
  assert.throws(() => census(conflict), /conflicting pins/);
});

test('rejects wrong fixture, browser pin, display, ROI and generic profile', () => {
  for (const mutate of [
    value => {value.environment.fixtureSha256 = 'f'.repeat(64);},
    value => {value.environment.browserEnvironmentSha256 = 'e'.repeat(64);},
    value => {value.selection.displayID++;}, value => {value.selection.roi = {...value.selection.roi, x: 11};},
    value => {value.oracle.display.width = 1;}, value => {value.oracle.profile = 'interaction-100-2400-60hz-60s-1';},
    value => {value.oracle.schemaVersion = 3;}, value => {value.oracle.actions[0].stateSha256 = 'unbound';},
  ]) {const value = fixture(); value.oracle.binding = clone(value.oracle.binding); mutate(value); assert.throws(() => census(value));}
});

test('JSON replay needs no object freezing and preserves the original exact inventory', () => {
  const value = pixels(fixture()), replay = JSON.parse(JSON.stringify(value));
  assert.equal(Object.isFrozen(replay.oracle), false); assert.deepEqual(census(replay), census(value));
});

test('bare claimed successful projection is not an owned 106-action input chain', () => {
  const value = fixture(), oracleBytes = Buffer.from(JSON.stringify(value.oracle));
  for (const projection of [undefined, {status: 'PASS', qualification: false}, {kind: 'text-interaction-input-1', schemaVersion: 1,
    profile: TEXT_INPUT_PROFILE, sessionId: 'fixture', status: 'PASS', qualification: false, actions: [], missing: [], failures: []}]) {
    assert.throws(() => validateTextActionOracle({...value, projection, oracleBytes, oracleSha256: hash(oracleBytes), pixelIdentities: []}), /projection/);
  }
});

test('forged, copied and generic capture objects cannot mint a text replay token', () => {
  for (const capture of [{}, Object.freeze({kind: 'windowserver-text-session-capture-4', schemaVersion: 4}),
    {kind: 'windowserver-session-capture-3', schemaVersion: 3, qualification: true},
    {manifest: {kind: 'windowserver-text-session-capture-4', schemaVersion: 4}, clocks: [], samples: []}]) {
    assert.throws(() => joinTextActionPixels(capture));
  }
});

// Complete finite synthetic protocol replay. Empty passive event lists remain
// empty; native brackets enclose scripted invocations, never physical input.
function joinedFixture() {
  const value = pixels(fixture()), sessionId = 'text-oracle-synthetic-fixture';
  const semanticItemIds = ['semantic-item-1', 'semantic-item-2']; let selectedSemantic = semanticItemIds[0];
  const native = {connected: true, start: 0, end: 0, direction: 'none', units: 10, presentation: 'anchored', session: 'actual-draft-1', revision: '1', textVersion: 3, focused: true,
    switch: {pending: '', request: 0, requestEpoch: 1, requestGeneration: 1, requestTextVersion: 3, settled: 0, rejected: 0, superseded: 0,
      rejectedEpoch: null, rejectedGeneration: null, rejectedCurrentEpoch: null, rejectedCurrentGeneration: null,
      rejectedTextVersion: null, rejectedCurrentTextVersion: null, rejectedGuards: 0, rejectedBoundary: '', reason: null}};
  const witness = {kind: 'text-presentation-observation-1', requests: [], latest: null, cancellation: null};
  const textFixture = {schema: 'browser-text-fixture-1', manifestHash: 'sha256:' + hash('sealed-text-manifest'),
    corpus: {sha256: 'sha256:' + hash('synthetic-content'), bytes: 17, fragmentsHash: 'sha256:' + hash('sealed-fragment-sequence'), fragmentCount: 20,
      scripts: ['latin-combining', 'arabic-rtl', 'devanagari', 'cjk', 'emoji', 'newlines', 'unbroken']},
    fonts: ['NotoSans', 'NotoSansArabic', 'NotoSansDevanagari', 'NotoSansCJK'].map(id => ({id, sha256: 'sha256:' + hash(id), bytes: 1024, kind: 'bundled', licenseSha256: null})),
    semanticItemIdsHash: 'sha256:' + hash(JSON.stringify(semanticItemIds)), activeLayerId: null, activeLayerIndex: null, fontSetPreseeded: false};
  const raw = {textInputSessionId: sessionId, textFixture, semanticItemIds, sealedSemanticItemIds: [...semanticItemIds],
    native: {sameNode: true, sameConnectedParent: true, disconnected: false, overflow: false}, textPresentation: {sameConnectedNode: true}, actions: [], presentationWitness: witness,
    segment: {clock: 'runner-monotonic', startMs: 1000, endMs: 61000, requestedMs: 60000, captureStoppedMs: 61000, completedActionsAtMs: 60000, actions: 106}};
  const clocks = [], nativeId = textSessionNativeId(sessionId), ack = (id, mach) => ({schemaVersion: 4, event: 'clock', id, mach: String(mach)});
  const begin = ack(nativeId + '-win-before', 1000); clocks.push(begin);
  for (const action of buildTextInputInventory()) {
    const beforeNative = clone(native), beforeSelection = selectedSemantic, browser = 100 + action.sequence * 20;
    const scheduledAtMs = 1000 + action.scheduledMs, runner = scheduledAtMs + 1;
    if (action.kind === 'semantic-selection') selectedSemantic = semanticItemIds[action.index];
    if (action.kind === 'presentation') {
      const target = (native.switch.pending || native.presentation) === 'anchored' ? 'inspector' : 'anchored';
      native.switch.request++;
      if (action.mode === 'immediate') {native.presentation = target; native.switch.settled = native.switch.request;}
      else {
        if (native.switch.pending) {native.switch.superseded = native.switch.request - 1; native.switch.rejected = native.switch.request - 1; native.switch.reason = 'superseded';}
        native.switch.pending = target;
      }
      witness.requests.push({actionId: action.id, mode: action.mode, target, before: clone(beforeNative), after: clone(native)});
    }
    if (action.kind === 'composition-end' && action.sequenceInComposition === 8) {
      native.presentation = native.switch.pending; native.switch.pending = ''; native.switch.settled = native.switch.request;
      witness.latest = {beforeEnd: clone(beforeNative), afterEnd: clone(native)};
    }
    if (action.cancelSession) {
      native.session = ''; native.revision = '2'; native.textVersion = 4; native.switch.pending = ''; native.switch.rejected = native.switch.request; native.switch.reason = 'cancelled';
      Object.assign(native.switch, {rejectedEpoch: 1, rejectedGeneration: 1, rejectedCurrentEpoch: 2, rejectedCurrentGeneration: 2,
        rejectedTextVersion: 3, rejectedCurrentTextVersion: 4, rejectedGuards: 7, rejectedBoundary: 'cancel-native-end'});
      witness.cancellation = {beforeCancel: clone(beforeNative), afterCancel: clone(native)};
    }
    const state = (node, observedMs, selection = selectedSemantic) => ({clock: 'browser-performance', timeOrigin: 1000000, observedMs, visibility: 'visible', native: clone(node),
      contentSha256: hash('synthetic-content'), semanticSelection: node.session === '' ? null : selection,
      format: node.session === '' ? {fontChoice: null, lineHeight: null, frameWidth: null, frameHeight: null} :
        {fontChoice: 'NotoSans', lineHeight: '1.2', frameWidth: '360', frameHeight: '180'}});
    const dispatches = action.steps.map((step, index) => {
      const descriptor = textInputDescriptor({sessionId, actionId: action.id, stepId: step.stepId}), identity = textInputIdentity(descriptor);
      const before = ack(identity.nativeActionId + '-before', 1000000 + action.sequence * 1000000 + index * 10000);
      const after = ack(identity.nativeActionId + '-after', BigInt(before.mach) + 2000n); clocks.push(before, after);
      const inputEvidence = validateTextInput({descriptor, clock: 'browser-performance', timeOrigin: 1000000, endedTimeOrigin: 1000000,
        armedMs: browser + index * 2 + 1, stoppedMs: browser + index * 2 + 2, visibility: 'visible', endedVisibility: 'visible',
        targetConnectedAtArm: true, targetConnected: true, overflow: false, events: []}, descriptor);
      return {descriptor, nativeActionId: identity.nativeActionId,
        nativeBracket: {kind: 'native-action-bracket-1', actionId: identity.nativeActionId, status: 'complete', actionCompleted: true, before, after},
        dispatchCompleted: true, dispatchStartedMs: runner + index * 2, dispatchCompletedMs: runner + index * 2 + 1,
        clock: 'runner-monotonic', inputEvidence, missing: [], qualification: false};
    });
    raw.actions.push({id: action.id, kind: action.kind, scheduledMs: action.scheduledMs, scheduledAtMs, inputLatenessMs: runner - scheduledAtMs,
      outcome: 'completed', inputMs: runner, readyMs: runner + 15, durationMs: 15,
      nativeInput: {before: state(beforeNative, browser, beforeSelection), after: state(native, browser + 15), dispatches}});
  }
  const end = ack(nativeId + '-win-after', 60000001000n); clocks.push(end);
  const anchor = (boundary, clock) => ({kind: 'text-native-session-anchor-1', status: 'complete', boundary, sessionId, nativeSessionId: nativeId, ack: clock});
  raw.nativeSessionStart = anchor('begin', begin); raw.nativeSessionEnd = anchor('end', end);
  const projection = clone(projectTextInteraction(raw, {sessionId}));
  // This assertion is exercised only in a future authorized test run.
  assert.equal(projection.status, 'PASS', JSON.stringify({missing: projection.missing, failures: projection.failures}));
  for (const [index, row] of value.oracle.actions.entries()) row.stateSha256 = projection.actions[index].stateSha256;
  const beforePixels = Buffer.from([0, 1, 2, 255, 3, 4, 5, 255]), afterPixels = Buffer.from([6, 7, 8, 255, 9, 10, 11, 255]);
  value.oracle.actions[0].before.sha256 = hash(beforePixels); value.oracle.actions[0].after.sha256 = hash(afterPixels);
  const oracleBytes = Buffer.from(JSON.stringify(value.oracle) + '\n');
  return {...value, raw: clone(raw), projection, clocks, beforePixels, afterPixels, oracleBytes, oracleSha256: hash(oracleBytes),
    binding: {...value.environment, browserPid: 23, windowNumber: 9}, display: value.oracle.display, roi: value.oracle.roi,
    pixelIdentities: [clone(value.oracle.actions[0].before), clone(value.oracle.actions[0].after)]};
}

async function verifiedFixture(t, value = joinedFixture(), {baselineMach = 900000, targetMach = 1200000, omitClock = false} = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'text-oracle-source-replay-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const encoded = [value.beforePixels, value.afterPixels].map(bytes => deflateRawSync(bytes)), container = Buffer.concat(encoded);
  const roi = value.roi, display = value.display, bounds = {x: 0, y: 0, width: display.width, height: display.height};
  const capacity = windowServerTextSessionLosslessCapacity(roi, 64 * 1024 ** 2);
  const budget = {allocationSha256: 'e'.repeat(64), capacityBytes: 32 * 1024 ** 3, observedAllocatedBytes: 0,
    reservationBytes: capacity.reservedArtifactBytes, nativeArtifactBytes: capacity.reservedArtifactBytes};
  const sample = (ordinal, time, bytes, blobIndex, offset) => ({schemaVersion: 4, event: 'sample', ordinal, statusRaw: 0, status: 'complete', ownerPID: 23, windowNumber: 9,
    windowObservationMach: String(time + 101), aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0, callbackMach: String(time + 100), displayTimeMach: String(time),
    pts: {value: '0', timescale: 1, flags: 0, epoch: '0'}, pixelFormat: 1111970369, width: display.width, height: display.height, roi: clone(roi), retained: true, file: 'pixels.bin',
    pixelStorage: {kind: 'deflate-raw', offset, encodedBytes: encoded[blobIndex].length, encodedSha256: hash(encoded[blobIndex])},
    sha256: hash(bytes), byteLength: bytes.length, contentScale: 1, scaleFactor: 1});
  const rows = [...value.clocks.filter((_, index) => !omitClock || index !== 1), sample(1, baselineMach, value.beforePixels, 0, 0), sample(2, targetMach, value.afterPixels, 1, encoded[0].length)]
    .sort((a, b) => Number(BigInt(a.mach ?? a.callbackMach) - BigInt(b.mach ?? b.callbackMach)));
  const frames = Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
  const manifest = {kind: 'windowserver-text-session-capture-4', schemaVersion: 4,
    config: {schemaVersion: 4, profile: TEXT_INPUT_PROFILE, storageFormat: 'rfc1951-previous-roi-1', displayID: display.id, expectedBrowserPid: 23, roi, evidenceBudget: budget}, capacity,
    storageAdmission: {availableBytesBefore: String(capacity.reservedArtifactBytes), reservedArtifactBytes: capacity.reservedArtifactBytes, evidenceBudget: clone(budget), targetAlarmAtReservation: false},
    display, captureGeometry: {displayBoundsPoints: clone(bounds), backingScale: {x: 1, y: 1}, displayPoints: clone(bounds), modePixels: {width: display.width, height: display.height},
      filterPoints: clone(bounds), pointPixelScale: 1, scalesToFit: false, showsCursor: true, capturesAudio: false, queueDepth: 3, pixelFormat: 'BGRA'},
    windowAdmission: {ownerPID: 23, windowNumber: 9, bounds: clone(bounds), layer: 0, alpha: 1, onScreen: true, roiPoints: clone(roi), aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0},
    timebase: {numer: 1, denom: 1}, startedMach: '0', endedMach: '60000002000', terminalReason: 'requested-stop',
    lossObservations: {nativeDroppedFrames: null, completeDisplaySlotSequence: false, streamError: null},
    counts: {sampleRecords: 2, completeFrames: 2, clockRecords: value.clocks.length - Number(omitClock), unretainedSamples: 0, pixelBytes: 16, encodedPixelBytes: container.length, duplicateFrames: 0},
    frames: {path: 'frames.ndjson', bytes: frames.length, sha256: hash(frames)}, pixelContainers: [{path: 'pixels.bin', bytes: container.length, sha256: hash(container)}]};
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
  await writeFile(join(directory, 'manifest.json'), manifestBytes); await writeFile(join(directory, 'frames.ndjson'), frames); await writeFile(join(directory, 'pixels.bin'), container);
  const expectedReady = {...clone(manifest), event: 'ready', outputDirectory: directory, roi: clone(roi), pixelByteLimit: capacity.maxEncodedPixelBytes,
    metadataByteLimit: capacity.metadataByteLimit, manifestByteLimit: capacity.manifestByteLimit, maxClockRecords: capacity.maxClockRecords, pointPixelScale: 1};
  for (const key of ['endedMach', 'terminalReason', 'counts', 'frames', 'pixelContainers', 'lossObservations']) delete expectedReady[key];
  const capture = await verifyWindowServerTextSessionLosslessCapture(directory, {manifestSha256: hash(manifestBytes), expectedConfig: clone(manifest.config), expectedReady,
    expectedStopped: {schemaVersion: 4, event: 'stopped', terminalReason: 'requested-stop', endedMach: manifest.endedMach, manifest: 'manifest.json'}, processExitCode: 0});
  return {value, capture};
}

test('full raw replay validates exact state pins and survives JSON roundtrip', () => {
  const value = joinedFixture(); assert.equal(validateTextActionOracle(value).actions.length, 106);
  const replay = {...value, raw: JSON.parse(JSON.stringify(value.raw)), projection: JSON.parse(JSON.stringify(value.projection))};
  assert.equal(validateTextActionOracle(replay).actions.length, 106);
});

test('raw replay rejects modified projection, input events, state and independent file pins', () => {
  for (const mutate of [
    value => {value.projection.actions[0].stateSha256 = 'f'.repeat(64);},
    value => {value.raw.actions[0].nativeInput.before.contentSha256 = 'f'.repeat(64);},
    value => {value.raw.actions[0].nativeInput.dispatches[0].inputEvidence.endedTimeOrigin++;},
    value => {value.projection.actions[0].dispatches[0].descriptor.stepId = 'invented';},
    value => {value.oracleSha256 = 'f'.repeat(64);}, value => {value.pixelIdentities[0].sha256 = 'f'.repeat(64);},
    value => {delete value.raw;}, value => {value.oracle.actions[0].subject = 'invented';},
  ]) {const value = joinedFixture(); mutate(value); assert.throws(() => validateTextActionOracle(value));}
});

test('private 496-clock replay observes only a conservative complete-action upper bound', async t => {
  const {value, capture} = await verifiedFixture(t), result = joinTextActionPixels(capture, value);
  assert.equal(result.requiredActions, 106); assert.equal(result.requiredSubsteps, 247); assert.equal(result.requiredNativeClocks, 496);
  assert.equal(result.observedAcknowledgements, 1); assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(result.qualification, false);
  assert.equal(result.actions[0].status, 'OBSERVED'); assert.equal(result.actions[0].firstMeaningfulPaintUpperBoundMs, 0.2);
  assert.equal(result.actions[0].lastDispatch, 1); assert.equal(result.actions[0].firstMeaningfulPaintExactMs, null);
  assert.equal(result.nativeIME.status, 'INCONCLUSIVE'); assert.equal(result.physicalScanout, 'unavailable');
  assert.equal(result.actions.filter(action => action.delivery === 'synthetic-app-handling').length, 30);
});

test('native replay rejects missing ACK inventory and altered retained wrapper clocks', async t => {
  const missing = await verifiedFixture(t, joinedFixture(), {omitClock: true}); assert.throws(() => joinTextActionPixels(missing.capture, missing.value), /494 substep ACKs/);
  const complete = await verifiedFixture(t);
  complete.value.projection.nativeSessionStart.ack.mach = '1001'; complete.value.raw.nativeSessionStart.ack.mach = '1001';
  assert.throws(() => joinTextActionPixels(complete.capture, complete.value), /window ACK is not retained/);
});

test('target frames before the last substep or after the next action stay inconclusive', async t => {
  for (const targetMach of [1005000, 2100000]) {
    const {value, capture} = await verifiedFixture(t, joinedFixture(), {targetMach});
    assert.equal(joinTextActionPixels(capture, value).actions[0].reason, 'target-pixels-not-observed-before-next-action');
  }
});
