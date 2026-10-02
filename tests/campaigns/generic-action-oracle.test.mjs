import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {genericNativeActionId, genericSessionNativeId} from '../../tooling/qualification/campaigns/browser-generic-input.mjs';
import {validateGenericActionOracle, joinGenericActionPixels} from '../../tooling/qualification/campaigns/generic-action-oracle.mjs';
import {verifyWindowServerSessionCapture, windowServerSessionCapacity} from '../../tooling/qualification/campaigns/windowserver-session.mjs';

// AUTHORED ONLY, NEVER EXECUTED during source staging. Structural fixtures do
// not mint a verified session token, render pixels, or qualify a campaign.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const profile = 'interaction-100-2400-60hz-60s-1', sessionId = 'input-generic-fixture-1';
function fixture() {
  const counts = new Map(), actions = [];
  let nextInputMs = 100;
  for (let sequence = 0; sequence < 100; sequence++) {
    const cycle = Math.floor(sequence / 5), position = sequence % 5;
    const family = ['stroke', 'undo', ...(cycle % 2 ? ['zoom', 'theme', 'split'] : ['pan', 'layer', 'density'])][position];
    const occurrence = (counts.get(family) ?? 0) + 1; counts.set(family, occurrence);
    const sourceActionIndex = family === 'stroke' ? cycle : cycle * 4 + position - 1;
    const identity = {sessionId, sequence, family, sourceActionIndex, ...(family === 'stroke' ? {specimenId: 'stroke-' + String(cycle).padStart(3, '0')} : {})};
    const stateSha256 = hash('state-' + sequence);
    const input = (stepId, control, operation) => ({schemaVersion: 1, sessionId, actionId: 'action-' + sourceActionIndex, stepId,
      family, target: {control, ...(family === 'layer' ? {rowIndex: 1, layerId: 'layer-1'} : {})}, input: operation});
    let descriptors;
    if (family === 'stroke') descriptors = Array.from({length: 120}, (_, sampleIndex) => ({schemaVersion: 1, sessionId, actionSequence: sequence,
      family, specimenId: identity.specimenId, sampleIndex, type: sampleIndex === 0 ? 'pointerdown' : sampleIndex === 119 ? 'pointerup' : 'pointermove', x: 10 + Math.min(sampleIndex, 118), y: 10}));
    else if (family === 'zoom') descriptors = [input('select-all', 'zoom-percentage', {kind: 'press', keyName: 'ControlOrMeta+A'}),
      input('enter-value', 'zoom-percentage', {kind: 'press-sequentially', text: '12.5'}), input('commit', 'zoom-percentage', {kind: 'press', keyName: 'Tab'})];
    else if (['theme', 'density'].includes(family)) {
      const control = family === 'theme' ? 'appearance' : 'density', light = family === 'theme' && occurrence % 2 === 0;
      descriptors = [input('select-edge', control, {kind: 'press', keyName: light ? 'Home' : 'End'}),
        ...(light ? [input('select-light', control, {kind: 'press', keyName: 'ArrowDown'})] : []), input('commit', control, {kind: 'press', keyName: 'Tab'})];
    } else descriptors = [input(family === 'pan' ? 'pan' : family === 'split' ? 'resize' : 'activate',
      {undo: 'mask-undo', layer: 'layer-row', pan: 'document-canvas', split: 'request-panel-width'}[family],
      ['undo', 'layer'].includes(family) ? {kind: 'click'} : {kind: 'press', keyName: 'ArrowRight'})];
    const dispatches = descriptors.map(descriptor => {
      const inputMs = nextInputMs; nextInputMs += 20;
      return {nativeActionId: genericNativeActionId(descriptor), descriptor, bracket: null,
        ...(family === 'stroke' ? {event: {inputMs, type: descriptor.type}} : {inputEvidence: {inputMs}})};
    });
    const endpoints = Array.from({length: family === 'stroke' ? 120 : 1}, (_, ordinal) => ({id: `endpoint-${sequence}-${ordinal}`,
      subject: family === 'stroke' ? 'mask-stroke-prefix' : family + '-complete-state', ordinal, stateSha256: hash(`endpoint-state-${sequence}-${ordinal}`),
      firstDispatch: family === 'stroke' ? ordinal : 0, lastDispatch: family === 'stroke' ? ordinal : dispatches.length - 1,
      inputMs: family === 'stroke' ? dispatches[ordinal].event.inputMs : dispatches[0].inputEvidence.inputMs,
      inputClock: 'browser-performance', supported: true}));
    actions.push({identity, stateSha256, dispatches, endpoints});
  }
  const display = {id: 7, width: 100, height: 60}, roi = {x: 4, y: 3, width: 2, height: 1};
  const binding = {fixtureSha256: 'a'.repeat(64), browserEnvironmentSha256: 'b'.repeat(64), browserPid: 23, windowNumber: 9};
  const oracle = {kind: 'generic-action-pixel-oracle-1', schemaVersion: 1, profile,
    binding: {fixtureSha256: binding.fixtureSha256, browserEnvironmentSha256: binding.browserEnvironmentSha256}, display, roi, pixelFormat: 'BGRA8',
    actions: actions.map(action => ({sequence: action.identity.sequence, family: action.identity.family, stateSha256: action.stateSha256,
      endpoints: action.endpoints.map(endpoint => ({ordinal: endpoint.ordinal, subject: endpoint.subject, kind: 'unavailable', reason: 'independent-pixels-not-supplied'})),
      ...(action.identity.family === 'stroke' ? {acknowledgement: {kind: 'unavailable', reason: 'meaningful-stroke-prefix-not-reviewed'}} : {})}))};
  return {projection: {kind: 'generic-browser-input-projection-1', profile, sessionId, status: 'PASS', actions, missing: []},
    oracle, binding, display, roi, pixelIdentities: []};
}
function validate(state, overrides = {}) {
  const oracleBytes = Buffer.from(JSON.stringify(state.oracle) + '\n');
  return validateGenericActionOracle({...state, oracleBytes, oracleSha256: hash(oracleBytes), ...overrides});
}
function withPixels(state, sequence = 1, ordinal = 0) {
  const before = {path: 'pixels/before.bgra', sha256: hash(Buffer.from([0, 1, 2, 255, 3, 4, 5, 255])), bytes: 8};
  const after = {path: 'pixels/after.bgra', sha256: hash(Buffer.from([6, 7, 8, 255, 9, 10, 11, 255])), bytes: 8};
  const endpoint = state.oracle.actions[sequence].endpoints[ordinal];
  state.oracle.actions[sequence].endpoints[ordinal] = {ordinal, subject: endpoint.subject, kind: 'pixels', before, after};
  state.pixelIdentities = [before, after].map(value => ({...value}));
  return state;
}

test('all 100 actions, 2525 dispatches and 2480 endpoints remain explicit even without pixels', () => {
  const state = fixture(), result = validate(state);
  assert.equal(result.actions.length, 100);
  assert.equal(state.projection.actions.reduce((sum, action) => sum + action.dispatches.length, 0), 2525);
  assert.equal(result.actions.reduce((sum, action) => sum + action.endpoints.length, 0), 2480);
  assert.equal(result.actions[0].endpoints[119].kind, 'unavailable');
  assert.equal(result.status, undefined); assert.equal(result.qualification, undefined);
  assert.ok(Object.isFrozen(result.actions[0].endpoints[0]));
});

test('a complete ROI identity joins only its exact independent byte inventory', () => {
  const state = withPixels(fixture()), result = validate(state);
  assert.deepEqual(result.actions[1].endpoints[0].before, state.pixelIdentities[0]);
  state.oracle.actions[1].endpoints[0].before.sha256 = 'c'.repeat(64);
  assert.notEqual(result.actions[1].endpoints[0].before.sha256, state.oracle.actions[1].endpoints[0].before.sha256);
});

test('raw oracle bytes must match their external file pin and provided parsed object', () => {
  const state = fixture();
  assert.throws(() => validate(state, {oracleSha256: 'c'.repeat(64)}));
  assert.throws(() => validate(state, {oracleBytes: Buffer.from('{}')}));
  assert.throws(() => validate(state, {oracle: {...state.oracle, schemaVersion: 2}}));
  assert.throws(() => validate(state, {oracleBytes: undefined}));
  assert.equal(validate(state, {oracle: undefined}).profile, profile);
});

test('oracle identity and geometry bind exactly to the fixed profile and display ROI', () => {
  for (const change of [
    value => {value.kind = 'first-use-panel-oracle-1';}, value => {value.schemaVersion = 2;}, value => {value.profile = 'shortened';},
    value => {value.pixelFormat = 'RGBA8';}, value => {value.display = {...value.display, id: 8};},
    value => {value.roi = {...value.roi, width: 1};}, value => {value.binding.fixtureSha256 = 'c'.repeat(64);},
    value => {value.binding.browserEnvironmentSha256 = 'c'.repeat(64);}, value => {value.binding.browserPid = 23;},
  ]) {const state = fixture(); change(state.oracle); assert.throws(() => validate(state));}
});

test('action and endpoint omissions or reordering cannot shrink the fixed workload', () => {
  for (const change of [
    state => {state.projection.actions.pop(); state.oracle.actions.pop();},
    state => {state.projection.actions[0].endpoints.pop(); state.oracle.actions[0].endpoints.pop();},
    state => {state.projection.actions[0].dispatches.pop();},
    state => {state.projection.actions[1].identity.family = 'pan'; state.oracle.actions[1].family = 'pan';},
    state => {[state.oracle.actions[1], state.oracle.actions[2]] = [state.oracle.actions[2], state.oracle.actions[1]];},
    state => {state.oracle.actions[0].endpoints[0].ordinal = 1;},
    state => {state.oracle.actions[1].endpoints[0].subject = 'unrelated-spinner';},
  ]) {const state = fixture(); change(state); assert.throws(() => validate(state));}
});

test('oracle state hashes bind each family action to its owned stable projection', () => {
  const state = fixture(); state.oracle.actions[1].stateSha256 = 'c'.repeat(64); assert.throws(() => validate(state));
  const missing = fixture(); delete missing.projection.actions[1].stateSha256; assert.throws(() => validate(missing));
});

test('no substep may substitute for the full discrete action input chain', () => {
  for (const family of ['zoom', 'theme', 'density']) {
    const state = fixture(), action = state.projection.actions.find(row => row.identity.family === family);
    action.endpoints[0].firstDispatch = 1; assert.throws(() => validate(state));
    action.endpoints[0].firstDispatch = 0; action.endpoints[0].lastDispatch--; assert.throws(() => validate(state));
  }
});

test('stroke endpoint ordinal and every native dispatch descriptor remain exact', () => {
  for (const change of [
    state => {state.projection.actions[0].dispatches[1].nativeActionId = state.projection.actions[0].dispatches[0].nativeActionId;},
    state => {state.projection.actions[0].dispatches[1].descriptor.sampleIndex = 0;},
    state => {state.projection.actions[0].dispatches[119].descriptor.type = 'pointermove';},
    state => {state.projection.actions[0].endpoints[1].lastDispatch = 2;},
    state => {state.projection.actions[1].identity.sourceActionIndex = 999;},
    state => {state.projection.actions[1].dispatches[0].descriptor.sessionId = 'other-session';},
  ]) {const state = fixture(); change(state); assert.throws(() => validate(state));}
});

test('reported browser input timestamp must match the retained initiating record', () => {
  for (const sequence of [0, 1]) {
    const state = fixture(); state.projection.actions[sequence].endpoints[0].inputMs++;
    assert.throws(() => validate(state));
  }
});

test('an unavailable endpoint stays counted and cannot acquire pixel proof', () => {
  const state = fixture(); state.projection.actions[0].endpoints[0].supported = false;
  state.projection.actions[0].endpoints[0].reason = 'down-has-no-distinct-reviewed-endpoint';
  assert.equal(validate(state).actions[0].endpoints.length, 120);
  withPixels(state, 0, 0); assert.throws(() => validate(state));
  const missing = fixture(); delete missing.oracle.actions[0].endpoints[0].reason; assert.throws(() => validate(missing));
});

test('identical before and after pixels are structurally retained for an inconclusive join', () => {
  const state = withPixels(fixture()), endpoint = state.oracle.actions[1].endpoints[0];
  endpoint.after = {...endpoint.before}; state.pixelIdentities.pop();
  const result = validate(state); assert.equal(result.actions[1].endpoints[0].before.sha256, result.actions[1].endpoints[0].after.sha256);
});

test('pixel paths, sizes, hashes and exact references are bounded and cannot be substituted', () => {
  for (const change of [
    state => {state.pixelIdentities[0].sha256 = 'c'.repeat(64);},
    state => {state.pixelIdentities[0].bytes = 4;}, state => {state.pixelIdentities.pop();},
    state => {state.pixelIdentities.push({...state.pixelIdentities[0]});},
    state => {state.pixelIdentities.push({...state.pixelIdentities[0], path: 'unreferenced.bgra'});},
    state => {state.oracle.actions[1].endpoints[0].before.path = '../outside.bgra';},
    state => {state.oracle.actions[1].endpoints[0].before.path = '/absolute.bgra';},
    state => {state.oracle.actions[1].endpoints[0].before.bytes = 4; state.pixelIdentities[0].bytes = 4;},
  ]) {const state = withPixels(fixture()); change(state); assert.throws(() => validate(state));}
});

test('input projection failures are not rescued by oracle pixels or summary flags', () => {
  for (const change of [
    state => {state.projection.status = 'INCONCLUSIVE';}, state => {state.projection.status = 'FAIL';},
    state => {state.projection.missing.push('input-clock-unavailable');}, state => {state.projection.profile = 'smaller-profile';},
    state => {state.projection.actions[1].identity.sessionId = 'other-session';},
  ]) {const state = withPixels(fixture()); change(state); assert.throws(() => validate(state));}
});

test('stroke R04 acknowledgement requires a distinct reviewed move prefix without replacing diagnostic points', () => {
  const state = withPixels(fixture(), 5, 1), action = state.oracle.actions[5], endpoint = action.endpoints[1];
  action.acknowledgement = {kind: 'pixels', subject: 'mask-stroke-acknowledgement', prefixOrdinal: 1,
    before: {...endpoint.before}, after: {...endpoint.after}};
  assert.equal(validate(state).actions[5].endpoints.length, 120);
  for (const prefixOrdinal of [0, 119]) {action.acknowledgement.prefixOrdinal = prefixOrdinal; assert.throws(() => validate(state));}
  action.acknowledgement.prefixOrdinal = 1; action.acknowledgement.after = {...endpoint.before}; assert.throws(() => validate(state));
  action.acknowledgement.after = {...endpoint.after}; action.acknowledgement.before = {...endpoint.after}; assert.throws(() => validate(state));
  delete action.acknowledgement; assert.throws(() => validate(state));
});

test('caller-created native receipt flags cannot mint a replayed session token', () => {
  const state = fixture(), oracleBytes = Buffer.from(JSON.stringify(state.oracle));
  for (const fake of [{}, {kind: 'verified-windowserver-session-2', qualification: true}, {status: 'PASS', observations: state}]) {
    assert.throws(() => joinGenericActionPixels(fake, {...state, oracleBytes, oracleSha256: hash(oracleBytes)}));
  }
});

// Native timing tests below use the real private verifier's ordinary-file replay
// API. Only synthetic literal eight-byte images are retained; nothing executes a
// browser or collector, and these fixtures have not been run during staging.
async function replayFixture(t, {sequence = 99, endpointOrdinal = 0, strokeAck = false, matchedOffset = 9000000, oldTarget = false, baselineOffset = -2000000,
  matchedTime, timebase = {numer: 1, denom: 1}, omitClock = false} = {}) {
  const state = withPixels(fixture(), sequence, endpointOrdinal), rows = [], all = state.projection.actions.flatMap(action => action.dispatches);
  const clock = (id, mach) => ({schemaVersion: 2, event: 'clock', id, mach: String(mach)});
  const anchor = (boundary, mach) => ({kind: 'generic-native-session-anchor-1', status: 'complete', boundary, sessionId,
    nativeSessionId: genericSessionNativeId(sessionId), ack: clock(genericSessionNativeId(sessionId) + '-' + boundary, mach)});
  state.projection.nativeSessionStart = anchor('begin', 1000);
  state.projection.nativeSessionEnd = anchor('end', 60010000000);
  rows.push(state.projection.nativeSessionStart.ack);
  for (const [index, dispatch] of all.entries()) {
    const before = clock(dispatch.nativeActionId + '-before', 1000000 + index * 20000000);
    const after = clock(dispatch.nativeActionId + '-after', Number(before.mach) + 1000000);
    dispatch.bracket = {kind: 'native-action-bracket-1', actionId: dispatch.nativeActionId, status: 'complete', actionCompleted: true, before, after};
    rows.push(before, after);
  }
  rows.push(state.projection.nativeSessionEnd.ack);
  const selected = state.projection.actions[sequence], a = Number(selected.dispatches[endpointOrdinal].bracket.before.mach);
  const beforePixels = Buffer.from([0, 1, 2, 255, 3, 4, 5, 255]), afterPixels = Buffer.from([6, 7, 8, 255, 9, 10, 11, 255]);
  const images = [], bounds = {x: 0, y: 0, width: state.display.width, height: state.display.height};
  const sample = (time, bytes) => {
    const ordinal = images.length + 1; images.push(bytes);
    return {schemaVersion: 2, event: 'sample', ordinal, statusRaw: 0, status: 'complete',
      ownerPID: 23, windowNumber: 9, windowObservationMach: String(time + 101), aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0,
      callbackMach: String(time + 100), displayTimeMach: String(time), pts: {value: '0', timescale: 1, flags: 0, epoch: '0'},
      pixelFormat: 1111970369, width: state.display.width, height: state.display.height, roi: {...state.roi}, retained: true,
      file: `frame-${ordinal}.bgra`, sha256: hash(bytes), byteLength: bytes.length, contentScale: 1, scaleFactor: 1};
  };
  if (strokeAck) {
    const action = state.oracle.actions[sequence], endpoint = action.endpoints[endpointOrdinal];
    action.acknowledgement = {kind: 'pixels', subject: 'mask-stroke-acknowledgement', prefixOrdinal: endpointOrdinal,
      before: {...endpoint.before}, after: {...endpoint.after}};
    rows.push(sample(Number(selected.dispatches[0].bracket.before.mach) - 2000000, beforePixels));
  }
  if (oldTarget) rows.push(sample(a - 25000000, afterPixels));
  rows.push(sample(a + baselineOffset, beforePixels), sample(matchedTime ?? a + matchedOffset, afterPixels));
  rows.sort((left, right) => Number(left.event === 'clock' ? left.mach : left.callbackMach) - Number(right.event === 'clock' ? right.mach : right.callbackMach));
  if (omitClock) rows.splice(rows.findIndex(row => row.id === all[0].bracket.before.id), 1);
  const capacity = windowServerSessionCapacity(state.roi);
  const evidenceBudget = {allocationSha256: 'a'.repeat(64), capacityBytes: 32 * 1024 ** 3, observedAllocatedBytes: 0, reservationBytes: capacity.requiredArtifactBytes};
  const manifest = {kind: 'windowserver-session-capture-2', schemaVersion: 2,
    config: {schemaVersion: 2, profile, displayID: state.display.id, expectedBrowserPid: state.binding.browserPid, roi: state.roi, evidenceBudget}, capacity,
    storageAdmission: {availableBytesBefore: String(capacity.requiredArtifactBytes), requiredArtifactBytes: capacity.requiredArtifactBytes,
      evidenceBudget: {...evidenceBudget}, targetAlarmAtReservation: false}, display: state.display,
    captureGeometry: {displayBoundsPoints: {...bounds}, backingScale: {x: 1, y: 1}, displayPoints: {...bounds},
      modePixels: {width: state.display.width, height: state.display.height}, filterPoints: {...bounds}, pointPixelScale: 1,
      scalesToFit: false, showsCursor: true, capturesAudio: false, queueDepth: 3, pixelFormat: 'BGRA'},
    windowAdmission: {ownerPID: 23, windowNumber: 9, bounds: {...bounds}, layer: 0, alpha: 1, onScreen: true,
      roiPoints: {...state.roi}, aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0},
    timebase, startedMach: '0', endedMach: '60100000000', terminalReason: 'requested-stop',
    lossObservations: {nativeDroppedFrames: null, completeDisplaySlotSequence: false, streamError: null},
    counts: {sampleRecords: images.length, completeFrames: images.length, clockRecords: rows.length - images.length,
      pixelBytes: images.length * 8, unretainedSamples: 0},
    pixelFiles: rows.filter(row => row.file).map(row => ({path: row.file, bytes: row.byteLength, sha256: row.sha256}))};
  const framesBytes = Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
  manifest.frames = {path: 'frames.ndjson', bytes: framesBytes.length, sha256: hash(framesBytes)};
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'generic-oracle-replay-source-'))), directory = join(root, 'capture');
  await mkdir(directory); t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(directory, 'manifest.json'), manifestBytes); await writeFile(join(directory, 'frames.ndjson'), framesBytes);
  for (const [index, bytes] of images.entries()) await writeFile(join(directory, `frame-${index + 1}.bgra`), bytes);
  const expectedReady = {...structuredClone(manifest), event: 'ready', outputDirectory: directory, roi: state.roi,
    pixelByteLimit: capacity.maxPixelBytes, metadataByteLimit: capacity.metadataByteLimit, manifestByteLimit: capacity.manifestByteLimit,
    maxClockRecords: capacity.maxClockRecords, pointPixelScale: 1};
  for (const key of ['endedMach', 'terminalReason', 'counts', 'frames', 'pixelFiles', 'lossObservations']) delete expectedReady[key];
  const capture = await verifyWindowServerSessionCapture(directory, {manifestSha256: hash(manifestBytes), expectedConfig: manifest.config, expectedReady,
    expectedStopped: {schemaVersion: 2, event: 'stopped', terminalReason: 'requested-stop', endedMach: manifest.endedMach, manifest: 'manifest.json'}, processExitCode: 0});
  const oracleBytes = Buffer.from(JSON.stringify(state.oracle) + '\n');
  return {capture, options: {...state, oracleBytes, oracleSha256: hash(oracleBytes)}, sequence};
}

test('verified native replay observes only the exact endpoint and preserves all missing rows', async t => {
  const replayed = await replayFixture(t), result = joinGenericActionPixels(replayed.capture, replayed.options), endpoint = result.actions[99].endpoints[0];
  assert.equal(endpoint.status, 'OBSERVED'); assert.equal(endpoint.firstMeaningfulPaintUpperBoundMs, 9);
  assert.deepEqual(endpoint.requirements, ['R04']); assert.equal(endpoint.referenceCeilingMs, 100);
  assert.equal(result.observedEndpoints, 1); assert.equal(result.requiredEndpoints, 2480); assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.qualification, false); assert.equal(result.automation.physicalInput, false);
  assert.equal(endpoint.firstMeaningfulPaintExactMs, null); assert.equal(result.browserToNativeClockCorrelation, 'unavailable');
  const copied = {...replayed.capture}; assert.throws(() => joinGenericActionPixels(copied, replayed.options));
});

test('repeated historical target pixels are valid after a fresh exact baseline', async t => {
  const replayed = await replayFixture(t, {oldTarget: true});
  const endpoint = joinGenericActionPixels(replayed.capture, replayed.options).actions[99].endpoints[0];
  assert.equal(endpoint.status, 'OBSERVED'); assert.equal(endpoint.firstMeaningfulPaintUpperBoundMs, 9);
});

test('native join cannot borrow a target at the next input or a stale preceding baseline', async t => {
  const next = await replayFixture(t, {sequence: 1, matchedOffset: 20000000});
  assert.equal(joinGenericActionPixels(next.capture, next.options).actions[1].endpoints[0].reason, 'target-pixels-not-observed-before-next-input');
  const stale = await replayFixture(t, {baselineOffset: -25000000});
  assert.equal(joinGenericActionPixels(stale.capture, stale.options).actions[99].endpoints[0].reason, 'baseline-predates-previous-input-completion');
});

test('exact native ACK and session window anchors cannot be altered or omitted', async t => {
  const replayed = await replayFixture(t), altered = structuredClone(replayed.options);
  // Preserve raw bytes as Buffer after cloning the plain receipt inputs.
  altered.oracleBytes = Buffer.from(replayed.options.oracleBytes);
  altered.projection.actions[99].dispatches[0].bracket.after.mach = '50482000001';
  assert.throws(() => joinGenericActionPixels(replayed.capture, altered), /after ACK/);
  altered.projection = structuredClone(replayed.options.projection); altered.projection.nativeSessionStart.ack.mach = '1001';
  assert.throws(() => joinGenericActionPixels(replayed.capture, altered), /begin ACK/);
  const omitted = await replayFixture(t, {omitClock: true});
  assert.throws(() => joinGenericActionPixels(omitted.capture, omitted.options), /5050 input ACKs/);
});

test('one reviewed stroke prefix provides an R04 action bound while all 120 R07 diagnostics remain', async t => {
  const replayed = await replayFixture(t, {sequence: 5, endpointOrdinal: 1, strokeAck: true});
  const result = joinGenericActionPixels(replayed.capture, replayed.options), action = result.actions[5];
  assert.equal(action.endpoints.length, 120); assert.equal(action.endpoints[1].firstMeaningfulPaintUpperBoundMs, 9);
  assert.deepEqual(action.endpoints[1].requirements, ['R07']);
  assert.equal(action.acknowledgement.firstMeaningfulPaintUpperBoundMs, 29); assert.deepEqual(action.acknowledgement.requirements, ['R04']);
  assert.equal(action.acknowledgement.firstDispatch, 0); assert.equal(action.acknowledgement.lastDispatch, 1);
  assert.equal(action.acknowledgement.referenceCeilingMs, 100); assert.equal(result.requiredAcknowledgements, 100);
  assert.equal(result.observedAcknowledgements, 1); assert.equal(result.requiredEndpoints, 2480); assert.equal(result.qualification, false);
});

test('native upper bounds round outward and cannot extend the original sixty-second window', async t => {
  const fractional = await replayFixture(t, {matchedOffset: 100000001});
  const endpoint = joinGenericActionPixels(fractional.capture, fractional.options).actions[99].endpoints[0];
  assert.equal(endpoint.firstMeaningfulPaintUpperBoundMs, 100.001);
  assert.equal(endpoint.ceilingAssessment, 'unavailable-earliest-frame-not-proven'); assert.equal(endpoint.status, 'OBSERVED');
  const outside = await replayFixture(t, {matchedTime: 60002000000});
  assert.equal(joinGenericActionPixels(outside.capture, outside.options).actions[99].endpoints[0].reason, 'target-pixels-outside-conservative-original-window');
});
