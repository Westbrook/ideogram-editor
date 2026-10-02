import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {discreteInputDescriptor, validateDiscreteInput} from '../../tooling/qualification/campaigns/browser-discrete-input.mjs';
import {verifyWindowServerCapture, firstUseNativeActionId, joinFirstUseWindowServerPixels} from '../../tooling/qualification/campaigns/windowserver-presentation.mjs';

// AUTHORED, NOT EXECUTED. Tiny synthetic replay buffers check identity and
// arithmetic only. They are not reviewed panel pixels or performance evidence.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const beforePixels = Buffer.from([0, 1, 2, 255, 3, 4, 5, 255]);
const afterPixels = Buffer.from([6, 7, 8, 255, 9, 10, 11, 255]);
const otherPixels = Buffer.from([12, 13, 14, 255, 15, 16, 17, 255]);
function freeze(value) {
  if (value && typeof value === 'object') {for (const item of Object.values(value)) freeze(item); Object.freeze(value);}
  return value;
}
function inputFor(descriptor) {
  return validateDiscreteInput({descriptor, clock: 'browser-performance', timeOrigin: 1000, endedTimeOrigin: 1000,
    armedMs: 40, stoppedMs: 44, visibility: 'visible', endedVisibility: 'visible', targetConnectedAtArm: true, targetConnected: true,
    events: ['pointerdown', 'pointerup', 'click'].map((type, ordinal) => ({
      eventId: `${descriptor.sessionId}/${descriptor.actionId}/${descriptor.stepId}/event-${ordinal}`, ordinal, type,
      timeStampMs: 41 + ordinal, observedMs: 41.25 + ordinal, isTrusted: true, targetMatched: true,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: ordinal === 0 ? 1 : 0,
    })), overflow: false}, descriptor);
}
function fixture(feature = 'Mask') {
  const roi = {x: 4, y: 3, width: 2, height: 1}, display = {id: 7, width: 100, height: 60};
  const descriptor = discreteInputDescriptor({sessionId: 'input-synthetic-1', actionId: 'first-use', stepId: 'open-panel',
    family: 'first-use', target: {control: feature === 'Mask' ? 'mask-tool' : 'adapter-library'}, input: {kind: 'click'}});
  const actionId = firstUseNativeActionId(descriptor);
  const sample = (ordinal, time, pixels) => ({schemaVersion: 1, event: 'sample', ordinal, statusRaw: 0, status: 'complete',
    callbackMach: String(time + 1000000), displayTimeMach: String(time), pts: {value: 0, timescale: 1, flags: 0, epoch: 0},
    pixelFormat: 1111970369, width: 100, height: 60, roi, file: `frame-${ordinal}.bgra`, sha256: hash(pixels), byteLength: pixels.length,
    retained: true, contentScale: 1, scaleFactor: 1, ownerPID: 23, windowNumber: 9, windowObservationMach: String(time + 1000001),
    aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0});
  const before = {schemaVersion: 1, event: 'clock', id: actionId + '-before', mach: '10000000'};
  const after = {schemaVersion: 1, event: 'clock', id: actionId + '-after', mach: '12000000'};
  const rows = [sample(1, 5000000, beforePixels), before, after, sample(2, 60000000, afterPixels)];
  const binding = {fixtureSha256: 'a'.repeat(64), browserEnvironmentSha256: 'b'.repeat(64), browserPid: 23, windowNumber: 9};
  const manifest = {kind: 'windowserver-capture-1', schemaVersion: 1,
    config: {schemaVersion: 1, displayID: 7, expectedBrowserPid: 23, roi, durationMs: 1000, maxFrames: 60, maxBytes: 4096}, display,
    captureGeometry: {displayBoundsPoints: {x: 0, y: 0, width: 100, height: 60}, displayPoints: {x: 0, y: 0, width: 100, height: 60},
      modePixels: {width: 100, height: 60}, filterPoints: {x: 0, y: 0, width: 100, height: 60}, pointPixelScale: 1,
      backingScale: {x: 1, y: 1}, scalesToFit: false, showsCursor: true, capturesAudio: false, queueDepth: 3, pixelFormat: 'BGRA'},
    windowAdmission: {ownerPID: 23, windowNumber: 9, bounds: {x: 0, y: 0, width: 100, height: 60}, layer: 0, alpha: 1, onScreen: true,
      roiPoints: {...roi}, aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0},
    timebase: {numer: 1, denom: 1}, startedMach: '0', endedMach: '1000000000', terminalReason: 'requested-stop'};
  const oracle = {kind: 'first-use-panel-oracle-1', schemaVersion: 1, feature,
    subject: feature === 'Mask' ? 'mask-controls-panel' : 'local-adapter-library-panel',
    binding: {fixtureSha256: binding.fixtureSha256, browserEnvironmentSha256: binding.browserEnvironmentSha256}, display, roi, pixelFormat: 'BGRA8',
    before: {state: 'closed', bytes: 8, sha256: hash(beforePixels)}, after: {state: 'open', bytes: 8, sha256: hash(afterPixels)}};
  return {feature, expectedDescriptor: descriptor, inputEvidence: inputFor(descriptor), binding, manifest, rows, sample,
    pixels: new Map([['frame-1.bgra', Buffer.from(beforePixels)], ['frame-2.bgra', Buffer.from(afterPixels)]]), oracle,
    oraclePixels: new Map([['before.bgra', Buffer.from(beforePixels)], ['after.bgra', Buffer.from(afterPixels)]]),
    bracket: {kind: 'native-action-bracket-1', actionId, status: 'complete', actionCompleted: true, before, after}};
}
function replay(state) {
  const framesBytes = Buffer.from(state.rows.map(row => JSON.stringify(row) + '\n').join(''));
  const samples = state.rows.filter(row => row.event === 'sample'), files = samples.filter(row => row.file);
  state.manifest.frames = {path: 'frames.ndjson', bytes: framesBytes.length, sha256: hash(framesBytes)};
  state.manifest.pixelFiles = files.map(row => ({path: row.file, bytes: row.byteLength, sha256: row.sha256}));
  state.manifest.counts = {sampleRecords: samples.length, completeFrames: files.length,
    clockRecords: state.rows.length - samples.length, pixelBytes: files.reduce((sum, row) => sum + row.byteLength, 0),
    unretainedSamples: samples.length - files.length};
  const manifestBytes = json(state.manifest);
  return verifyWindowServerCapture({manifestBytes, framesBytes, pixels: state.pixels}, {manifestSha256: hash(manifestBytes)});
}
function join(state, capture = replay(state), overrides = {}) {
  const oracleBytes = json(state.oracle);
  return joinFirstUseWindowServerPixels(capture, {...state, oracleBytes, oracleSha256: hash(oracleBytes), ...overrides});
}

test('each admitted panel returns only an observed native upper bound with explicit limitations', () => {
  for (const feature of ['Mask', 'Adapter library']) {
    const state = fixture(feature), result = join(state);
    assert.equal(result.status, 'observed'); assert.equal(result.feature, feature);
    assert.equal(result.firstMeaningfulPaintUpperBoundMs, 50); assert.equal(result.ceilingAssessment, 'upper-bound-within-ceiling');
    assert.deepEqual(result.inputBracket, {earliestMach: '10000000', latestMach: '12000000'});
    assert.deepEqual(result.inputEvidence, state.inputEvidence); assert.notEqual(result.inputEvidence, state.inputEvidence); assert.equal(result.automation.physicalInput, false);
    assert.equal(result.qualification, false); assert.equal(result.budget, 'R04'); assert.equal(result.ceilingMs, 100); assert.equal(result.targetMs, 50);
    assert.equal(result.firstMeaningfulPaintExactMs, null); assert.equal(result.firstMeaningfulPaintLowerBoundMs, null);
    for (const field of ['physicalScanout', 'displaySlotCoverage', 'firstPresentedFrameCoverage', 'browserToNativeClockCorrelation']) assert.equal(result[field], 'unavailable');
    for (const field of ['semanticReviewRequired', 'collectorSourceAndInvocationAdmissionRequired', 'browserInputInvocationAdmissionRequired']) assert.equal(result[field], true);
    assert.equal(result.latencyId, undefined); assert.equal(result.presentedMs, undefined); assert.equal(result.readyMs, undefined);
  }
});

test('native identity derives from complete canonical browser descriptor and remains bounded', () => {
  const state = fixture(), original = firstUseNativeActionId(state.expectedDescriptor);
  assert.match(original, /^fu-[a-f0-9]{48}$/);
  assert.equal(original, 'fu-' + hash(JSON.stringify(state.expectedDescriptor)).slice(0, 48));
  assert.notEqual(firstUseNativeActionId({...state.expectedDescriptor, sessionId: 'other-session'}), original);
  for (const change of [{actionId: 'other-action'}, {stepId: 'other-step'}, {family: 'undo'},
    {target: {control: 'mask-tool', rowIndex: 0}}, {input: {kind: 'press', keyName: 'Enter'}}]) {
    assert.throws(() => firstUseNativeActionId({...state.expectedDescriptor, ...change}));
  }
});

test('native bound rounds outward and fixed R04 ceiling cannot be relaxed by callers', () => {
  for (const [time, upper, assessment] of [[110000000, 100, 'upper-bound-within-ceiling'],
    [110000001, 100.001, 'unavailable-earliest-frame-not-proven'], [700000000, 690, 'unavailable-earliest-frame-not-proven']]) {
    const state = fixture(); state.rows.at(-1).displayTimeMach = String(time);
    state.rows.at(-1).callbackMach = String(time + 1000000); state.rows.at(-1).windowObservationMach = String(time + 1000001);
    const result = join(state, replay(state), {ceilingMs: 750});
    assert.equal(result.status, 'observed'); assert.equal(result.firstMeaningfulPaintUpperBoundMs, upper);
    assert.equal(result.ceilingAssessment, assessment); assert.equal(result.ceilingMs, 100);
  }
});

test('a receipt flag or copied capture cannot bypass private byte replay admission', () => {
  const state = fixture(), capture = replay(state);
  assert.throws(() => join(state, {...capture}), /capture not replayed/);
  assert.throws(() => join(state, {kind: 'verified-windowserver-capture-1', qualification: true}), /capture not replayed/);
  state.rows.at(-1).displayTimeMach = '12000001'; state.pixels.get('frame-2.bgra').fill(0);
  assert.equal(join(state, capture).firstMeaningfulPaintUpperBoundMs, 50);
});

test('runtime ownership and stable fixture or browser environment binding must all agree', () => {
  for (const mutation of [
    state => {state.binding.browserPid++;}, state => {state.binding.windowNumber++;},
    state => {state.binding.fixtureSha256 = 'c'.repeat(64);}, state => {state.binding.browserEnvironmentSha256 = 'c'.repeat(64);},
    state => {delete state.binding.browserPid;}, state => {state.binding.unowned = true;},
    state => {state.oracle.binding.browserPid = state.binding.browserPid;},
    state => {state.oracle.binding.fixtureSha256 = 'SHA256:' + state.binding.fixtureSha256;},
  ]) {const state = fixture(), capture = replay(state); mutation(state); assert.throws(() => join(state, capture));}
});

test('oracle identity admits exactly the selected complete panel and capture geometry', () => {
  for (const mutation of [
    state => {state.feature = 'Other panel';}, state => {state.feature = 'Adapter library';},
    state => {state.oracle.feature = 'Adapter library';}, state => {state.oracle.kind = 'hmr-wordmark-oracle-1';},
    state => {state.oracle.schemaVersion = 2;}, state => {state.oracle.subject = 'marker-square';},
    state => {state.oracle.before.state = 'open';}, state => {state.oracle.after.state = 'pending';},
    state => {state.oracle.display = {...state.oracle.display, id: 8};}, state => {state.oracle.roi = {...state.oracle.roi, x: 5};},
    state => {state.oracle.pixelFormat = 'RGBA8';}, state => {state.oracle.after.bytes = 4;},
  ]) {const state = fixture(), capture = replay(state); mutation(state); assert.throws(() => join(state, capture));}
});

test('external oracle pin and both complete distinct pixel buffers are required', () => {
  const pinned = fixture(), capture = replay(pinned);
  assert.throws(() => join(pinned, capture, {oracleSha256: 'c'.repeat(64)}));
  assert.throws(() => join(pinned, capture, {oracleBytes: Buffer.from('{}')}));
  for (const mutation of [
    state => {state.oraclePixels.get('after.bgra').fill(0);}, state => {state.oraclePixels.delete('before.bgra');},
    state => {state.oraclePixels.set('extra.bgra', Buffer.alloc(8));},
    state => {state.oracle.after.sha256 = state.oracle.before.sha256; state.oraclePixels.set('after.bgra', Buffer.from(beforePixels));},
    state => {state.oraclePixels.set('after.bgra', Buffer.alloc(4)); state.oracle.after.bytes = 4; state.oracle.after.sha256 = hash(Buffer.alloc(4));},
  ]) {const state = fixture(), replayed = replay(state); mutation(state); assert.throws(() => join(state, replayed));}
});

test('browser descriptor must be the canonical expected first-use action and exact feature target', () => {
  for (const change of [{actionId: 'first-use-2'}, {stepId: 'other-step'}, {sessionId: 'other-session'},
    {target: {control: 'adapter-library'}}, {target: {control: 'mask-tool', layerId: 'other-layer'}}, {extra: true}]) {
    const state = fixture(), capture = replay(state);
    state.expectedDescriptor = freeze({...state.expectedDescriptor, ...change});
    assert.throws(() => join(state, capture));
  }
});

test('retained browser events, both origins and all derived summary identities are revalidated', () => {
  for (const mutation of [
    input => {input.status = 'INCONCLUSIVE';}, input => {input.qualification = true;}, input => {input.schemaVersion = 2;},
    input => {input.automation.physicalInput = true;}, input => {input.automation.driver = 'hardware';},
    input => {input.clock = 'mach-absolute';}, input => {input.endedTimeOrigin++;}, input => {delete input.endedTimeOrigin;},
    input => {input.inputMs++;}, input => {input.initiatingEventIds = ['invented'];},
    input => {input.events[0].isTrusted = false;}, input => {input.events[0].eventId = 'invented';},
    input => {input.events[0].targetMatched = false;}, input => {input.events[1].pointerId++;},
    input => {input.events[0].timeStampMs = input.armedMs - 1;}, input => {input.events.reverse();}, input => {input.events.pop();},
    input => {input.failures.push('retained-failure');}, input => {input.missing.push('retained-gap');},
    input => {input.descriptor.sessionId = 'other-session';},
  ]) {
    const state = fixture(), capture = replay(state), input = structuredClone(state.inputEvidence);
    mutation(input); state.inputEvidence = freeze(input); assert.throws(() => join(state, capture));
  }
});

test('JSON-roundtripped browser input is revalidated without treating runtime freezing as authentication', () => {
  const state = fixture(); state.expectedDescriptor = JSON.parse(JSON.stringify(state.expectedDescriptor));
  state.inputEvidence = JSON.parse(JSON.stringify(state.inputEvidence));
  const result = join(state);
  assert.equal(result.status, 'observed'); assert.ok(Object.isFrozen(result.inputEvidence)); assert.ok(Object.isFrozen(result.descriptor));
  assert.equal(result.browserInputInvocationAdmissionRequired, true);
});

test('bracket action identity and exact retained native ACKs cannot be substituted or modified', () => {
  for (const mutation of [
    bracket => {bracket.kind = 'other';}, bracket => {bracket.status = 'unavailable';}, bracket => {bracket.actionCompleted = false;},
    bracket => {bracket.actionId = 'other-action';}, bracket => {bracket.before.id = 'other-before';},
    bracket => {bracket.after.id = 'other-after';}, bracket => {bracket.before.mach = '9999999';},
    bracket => {bracket.after.mach = '12000001';}, bracket => {delete bracket.before;}, bracket => {delete bracket.after;},
    bracket => {bracket.after = {...bracket.before};},
  ]) {
    const state = fixture(), capture = replay(state); state.bracket = structuredClone(state.bracket);
    mutation(state.bracket); assert.throws(() => join(state, capture));
  }
  const state = fixture(); state.rows.splice(1, 1); assert.throws(() => join(state), /before ACK is not retained/);
});

test('returned input evidence is a detached deeply frozen replay snapshot', () => {
  const state = fixture(), input = structuredClone(state.inputEvidence);
  input.descriptor = state.expectedDescriptor;
  state.inputEvidence = Object.freeze(input);
  const result = join(state);
  input.events[0].timeStampMs = 0; input.automation.physicalInput = true;
  assert.equal(result.inputEvidence.events[0].timeStampMs, 41); assert.equal(result.automation.physicalInput, false);
  assert.ok(Object.isFrozen(result.inputEvidence.events[0])); assert.ok(Object.isFrozen(result.automation));
});

test('native input clocks must remain ordered within verified capture', () => {
  const state = fixture(); state.rows[2].mach = '9000000'; assert.throws(() => replay(state));
  const missing = fixture(); delete missing.rows[2].mach; assert.throws(() => replay(missing));
});

test('missing baseline or target and a target inside the action bracket remain unavailable', () => {
  const noBaseline = fixture(); noBaseline.oracle.before.sha256 = hash(otherPixels); noBaseline.oraclePixels.set('before.bgra', Buffer.from(otherPixels));
  assert.equal(join(noBaseline).reason, 'closed-panel-baseline-not-observed');
  const noTarget = fixture(); noTarget.oracle.after.sha256 = hash(otherPixels); noTarget.oraclePixels.set('after.bgra', Buffer.from(otherPixels));
  assert.equal(join(noTarget).reason, 'open-panel-not-captured-after-input');
  const inside = fixture(); inside.rows.at(-1).displayTimeMach = '11000000';
  assert.equal(join(inside).reason, 'open-panel-not-captured-after-input');
  const afterBaseline = fixture(); afterBaseline.rows[0].displayTimeMach = '11000000'; afterBaseline.rows[0].callbackMach = '12000000';
  afterBaseline.rows[0].windowObservationMach = '12000001';
  // Move that sample after the two ACKs to retain a valid native callback order.
  afterBaseline.rows = [afterBaseline.rows[1], afterBaseline.rows[2], afterBaseline.rows[0], afterBaseline.rows[3]];
  assert.equal(join(afterBaseline).reason, 'closed-panel-baseline-not-observed');
});

test('an open panel before input is rejected even if a closed baseline follows it', () => {
  const state = fixture(), before = state.rows[1], after = state.rows[2];
  state.rows = [state.sample(1, 4000000, afterPixels), state.sample(2, 6000000, beforePixels), before, after, state.sample(3, 60000000, afterPixels)];
  state.pixels = new Map([['frame-1.bgra', Buffer.from(afterPixels)], ['frame-2.bgra', Buffer.from(beforePixels)], ['frame-3.bgra', Buffer.from(afterPixels)]]);
  const result = join(state); assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'open-panel-preexisted-input');
  assert.equal(result.firstMeaningfulPaintUpperBoundMs, null);
});

test('an older closed match cannot hide a newer observed incompatible baseline', () => {
  const state = fixture(), before = state.rows[1], after = state.rows[2];
  state.rows = [state.sample(1, 4000000, beforePixels), state.sample(2, 6000000, otherPixels), before, after, state.sample(3, 60000000, afterPixels)];
  state.pixels = new Map([['frame-1.bgra', Buffer.from(beforePixels)], ['frame-2.bgra', Buffer.from(otherPixels)], ['frame-3.bgra', Buffer.from(afterPixels)]]);
  assert.equal(join(state).reason, 'closed-panel-baseline-not-observed');
});

test('fractional timebase uses native rational arithmetic without browser-clock subtraction', () => {
  const state = fixture(); state.manifest.timebase = {numer: 125, denom: 3};
  const result = join(state); assert.equal(result.firstMeaningfulPaintUpperBoundMs, 2083.334);
  assert.equal(result.inputEvidence.inputMs, 41); assert.equal(result.ceilingAssessment, 'unavailable-earliest-frame-not-proven');
});
