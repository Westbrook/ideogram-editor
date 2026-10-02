import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateWindowServerReady, verifyWindowServerCapture, bracketWindowServerAction, joinHmrWindowServerPixels} from '../../tooling/qualification/campaigns/windowserver-presentation.mjs';

// Synthetic protocol/arithmetic fixtures only. These eight-byte arrays are not
// semantic wordmark oracles and cannot qualify a real presentation campaign.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const beforePixels = Buffer.from([0, 1, 2, 255, 3, 4, 5, 255]);
const afterPixels = Buffer.from([6, 7, 8, 255, 9, 10, 11, 255]);
function fixture() {
  const roi = {x: 4, y: 3, width: 2, height: 1}, display = {id: 7, width: 100, height: 60};
  const sample = (ordinal, time, pixels) => ({schemaVersion: 1, event: 'sample', ordinal, statusRaw: 0, status: 'complete',
    callbackMach: String(time + 1000000), displayTimeMach: String(time), pts: {value: 0, timescale: 1, flags: 0, epoch: 0},
    pixelFormat: 1111970369, width: 100, height: 60, roi, file: `frame-${ordinal}.bgra`, sha256: hash(pixels), byteLength: pixels.length,
    retained: true, contentScale: 1, scaleFactor: 1, ownerPID: 23, windowNumber: 9, windowObservationMach: String(time + 1000001),
    aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0});
  const before = {schemaVersion: 1, event: 'clock', id: 'hmr1-before', mach: '10000000'}, after = {schemaVersion: 1, event: 'clock', id: 'hmr1-after', mach: '12000000'};
  const rows = [sample(1, 5000000, beforePixels), before, after, sample(2, 300000000, afterPixels)];
  const manifest = {kind: 'windowserver-capture-1', schemaVersion: 1,
    config: {schemaVersion: 1, displayID: 7, expectedBrowserPid: 23, roi, durationMs: 1000, maxFrames: 60, maxBytes: 4096}, display,
    captureGeometry: {displayBoundsPoints: {x: 0, y: 0, width: 100, height: 60}, displayPoints: {x: 0, y: 0, width: 100, height: 60},
      modePixels: {width: 100, height: 60}, filterPoints: {x: 0, y: 0, width: 100, height: 60}, pointPixelScale: 1,
      backingScale: {x: 1, y: 1}, scalesToFit: false, showsCursor: true, capturesAudio: false, queueDepth: 3, pixelFormat: 'BGRA'},
    windowAdmission: {ownerPID: 23, windowNumber: 9, bounds: {x: 0, y: 0, width: 100, height: 60}, layer: 0, alpha: 1, onScreen: true, roiPoints: {...roi},
      aboveVisibleWindowCount: 2, intersectingAboveWindowCount: 0},
    timebase: {numer: 1, denom: 1}, startedMach: '0', endedMach: '1000000000', terminalReason: 'requested-stop',
    counts: {sampleRecords: 2, completeFrames: 2, clockRecords: 2, pixelBytes: 16, unretainedSamples: 0},
    frames: null, pixelFiles: rows.filter(row => row.file).map(row => ({path: row.file, bytes: row.byteLength, sha256: row.sha256}))};
  const oracle = {kind: 'hmr-wordmark-oracle-1', schemaVersion: 1, subject: '.wordmark-secondary', source: {originalSha256: 'a'.repeat(64), changedSha256: 'b'.repeat(64)},
    display, roi, pixelFormat: 'BGRA8', before: {text: 'Editor', bytes: 8, sha256: hash(beforePixels)}, after: {text: 'Editor updated', bytes: 8, sha256: hash(afterPixels)}};
  const state = {rows, manifest, pixels: new Map([['frame-1.bgra', Buffer.from(beforePixels)], ['frame-2.bgra', Buffer.from(afterPixels)]]),
    oracle, oraclePixels: new Map([['before.bgra', beforePixels], ['after.bgra', afterPixels]]),
    sourceIdentity: {sourcePath: 'src/ui/shell-wordmark.ts', original: {sha256: 'sha256:' + 'a'.repeat(64)}, changed: {sha256: 'sha256:' + 'b'.repeat(64)}},
    bracket: {kind: 'native-action-bracket-1', actionId: 'hmr1', status: 'complete', actionCompleted: true, before, after}};
  return state;
}
function replay(state) {
  const framesBytes = Buffer.from(state.rows.map(row => JSON.stringify(row) + '\n').join(''));
  state.manifest.frames = {path: 'frames.ndjson', bytes: framesBytes.length, sha256: hash(framesBytes)};
  const manifestBytes = json(state.manifest);
  return verifyWindowServerCapture({manifestBytes, framesBytes, pixels: state.pixels}, {manifestSha256: hash(manifestBytes)});
}
function join(state, capture = replay(state)) {
  const oracleBytes = json(state.oracle);
  return joinHmrWindowServerPixels(capture, {...state, oracleBytes, oracleSha256: hash(oracleBytes)});
}

test('retained full-display pixels produce only a conservative WindowServer upper bound', () => {
  const result = join(fixture());
  assert.equal(result.status, 'observed'); assert.equal(result.firstCorrectPaintUpperBoundMs, 290);
  assert.equal(result.ceilingAssessment, 'upper-bound-within-ceiling'); assert.equal(result.qualification, false);
  assert.equal(result.firstCorrectPaintLowerBoundMs, null); assert.equal(result.firstCorrectPaintExactMs, null);
  assert.equal(result.physicalScanout, 'unavailable'); assert.equal(result.displaySlotCoverage, 'unavailable');
  assert.equal(result.semanticReviewRequired, true);
  assert.equal(result.collectorSourceAndInvocationAdmissionRequired, true);
});

test('a late captured match cannot prove first-presentation lateness', () => {
  const state = fixture(); state.rows.at(-1).displayTimeMach = '700000000'; state.rows.at(-1).callbackMach = '701000000'; state.rows.at(-1).windowObservationMach = '701000001';
  const result = join(state); assert.equal(result.firstCorrectPaintUpperBoundMs, 690);
  assert.equal(result.ceilingAssessment, 'unavailable-earliest-frame-not-proven'); assert.equal(result.firstCorrectPaintLowerBoundMs, null);
});

test('missing or preexisting visible content stays unavailable', () => {
  const missing = fixture(); missing.oracle.after.sha256 = hash(Buffer.alloc(8)); missing.oraclePixels.set('after.bgra', Buffer.alloc(8));
  assert.equal(join(missing).reason, 'updated-wordmark-not-captured');
  const prior = fixture(); prior.rows[0].sha256 = hash(afterPixels); prior.pixels.set('frame-1.bgra', afterPixels); prior.manifest.pixelFiles[0].sha256 = hash(afterPixels);
  assert.equal(join(prior).status, 'unavailable');
  const none = fixture(); none.oracle.before.sha256 = hash(Buffer.alloc(8)); none.oraclePixels.set('before.bgra', Buffer.alloc(8));
  assert.equal(join(none).reason, 'baseline-wordmark-not-observed');
  const during = fixture(); during.rows.at(-1).displayTimeMach = '11000000';
  assert.equal(join(during).reason, 'updated-wordmark-not-captured');
});

test('raw bytes, image inventory, status, geometry and sample identity are fail-closed', () => {
  for (const mutation of [
    state => state.pixels.set('frame-2.bgra', Buffer.alloc(8)),
    state => state.pixels.set('../other.bgra', Buffer.alloc(8)),
    state => {state.rows.at(-1).ordinal = 3;},
    state => {state.rows.at(-1).status = 'idle'; state.rows.at(-1).statusRaw = 1;},
    state => {delete state.rows.at(-1).status; delete state.rows.at(-1).statusRaw; state.rows.at(-1).file = null; state.rows.at(-1).sha256 = null; state.rows.at(-1).byteLength = null;},
    state => {state.rows.at(-1).width--;},
    state => {state.rows.at(-1).roi = {...state.rows.at(-1).roi, x: 5};},
    state => {state.rows.at(-1).pixelFormat = 0;},
    state => {state.rows.at(-1).contentScale = 0.5;},
    state => {state.rows.at(-1).ownerPID++;},
    state => {state.rows.at(-1).intersectingAboveWindowCount++;},
    state => {delete state.rows.at(-1).aboveVisibleWindowCount;},
    state => {state.manifest.windowAdmission.windowNumber++;},
    state => {state.manifest.windowAdmission.bounds.width = 1;},
    state => {state.manifest.captureGeometry.backingScale.x = 2;},
    state => {state.manifest.captureGeometry.filterPoints.width--;},
    state => {delete state.manifest.captureGeometry.modePixels;},
    state => {state.manifest.counts.pixelBytes--;},
    state => {state.manifest.config.maxBytes = 15;},
    state => {state.manifest.display.id++;},
    state => {state.manifest.terminalReason = 'roi-intersects-above-window';},
  ]) {const state = fixture(); mutation(state); assert.throws(() => replay(state));}
});

test('clock identities, lossless ticks, ordering and enclosure are required', () => {
  for (const mutation of [
    state => {state.rows[2].id = state.rows[1].id;},
    state => {state.rows[1].mach = 10000000;},
    state => {state.rows[2].mach = '1';},
    state => {state.rows[1].mach = '18446744073709551616';},
    state => {state.rows.at(-1).displayTimeMach = '302000000';},
    state => {state.rows.at(-1).windowObservationMach = '300999999';},
    state => {delete state.rows.at(-1).windowObservationMach;},
    state => {state.manifest.endedMach = '100';},
    state => {state.manifest.timebase.denom = 0;},
  ]) {const state = fixture(); mutation(state); assert.throws(() => replay(state));}
});

test('a copied receipt flag cannot bypass byte replay and later caller mutation cannot alter replayed ticks', () => {
  const state = fixture(), capture = replay(state);
  assert.throws(() => join(state, {...capture}), /capture not replayed/);
  state.rows.at(-1).displayTimeMach = '10000001'; state.pixels.get('frame-2.bgra').fill(0);
  assert.equal(join(state, capture).firstCorrectPaintUpperBoundMs, 290);
});

test('wordmark oracle pins exact source bytes, full ROI pixels and retained bracket ACKs', () => {
  for (const mutation of [
    state => {state.oracle.subject = 'marker-square';},
    state => {state.oracle.after.text = 'updated';},
    state => {state.sourceIdentity.changed.sha256 = 'sha256:' + 'c'.repeat(64);},
    state => {state.oracle.roi = {...state.oracle.roi, x: 8};},
    state => {state.oraclePixels.set('after.bgra', Buffer.alloc(8));},
    state => {state.bracket = structuredClone(state.bracket); state.bracket.after.mach = '13000000';},
  ]) {const state = fixture(), capture = replay(state); mutation(state); assert.throws(() => join(state, capture));}
});

test('fractional native milliseconds round outward rather than below the bound', () => {
  const state = fixture(); state.rows.at(-1).displayTimeMach = '510000001'; state.rows.at(-1).callbackMach = '511000000'; state.rows.at(-1).windowObservationMach = '511000001';
  assert.equal(join(state).firstCorrectPaintUpperBoundMs, 500.001);
  assert.equal(join(state).ceilingAssessment, 'unavailable-earliest-frame-not-proven');
});

test('ready validates invocation and native ownership without claiming a pixel endpoint', () => {
  const {manifest} = fixture(), outputDirectory = '/private/tmp/capture/owned-output';
  const ready = {...manifest, event: 'ready', outputDirectory, roi: manifest.config.roi, pixelByteLimit: manifest.config.maxBytes,
    metadataByteLimit: 8 * 1024 ** 2, manifestByteLimit: 2 * 1024 ** 2, maxClockRecords: 256, pointPixelScale: 1};
  const admitted = validateWindowServerReady(ready, {config: manifest.config, outputDirectory});
  assert.deepEqual(admitted, ready); assert.notEqual(admitted, ready);
  assert.equal(admitted.qualification, undefined); assert.equal(admitted.firstCorrectPaintUpperBoundMs, undefined);
  for (const mutation of [
    row => {row.config.expectedBrowserPid++;},
    row => {row.windowAdmission.bounds.width = 1;},
    row => {row.captureGeometry.backingScale.x = 2;},
    row => {row.pointPixelScale = 2;},
    row => {row.windowAdmission.intersectingAboveWindowCount = 1;},
    row => {row.outputDirectory += '-other';},
    row => {row.maxClockRecords++;},
    row => {row.startedMach = 10;},
  ]) {const row = structuredClone(ready); mutation(row); assert.throws(() => validateWindowServerReady(row, {config: manifest.config, outputDirectory}));}
});

test('native clock requests bracket the actual save in order and preserve its return value', async () => {
  const calls = [], value = {savedMs: 123};
  const result = await bracketWindowServerAction({actionId: 'hmr1', captureClock: async id => {
    calls.push(id); return {schemaVersion: 1, event: 'clock', id, mach: id.endsWith('before') ? '10' : '20'};
  }, run: async () => {calls.push('actual-save'); return value;}});
  assert.deepEqual(calls, ['hmr1-before', 'actual-save', 'hmr1-after']); assert.equal(result.value, value);
});

test('native bracket preserves action failures and successful saves with unavailable instrumentation', async () => {
  const failure = Error('save failed'); let calls = 0;
  await assert.rejects(bracketWindowServerAction({actionId: 'hmr1', captureClock: async id => {calls++; return {schemaVersion: 1, event: 'clock', id, mach: '10'};}, run: async () => {throw failure;}}), error => error === failure && error.nativeActionBracket.actionCompleted === false);
  assert.equal(calls, 1);
  const saved = {savedMs: 123};
  const missing = await bracketWindowServerAction({actionId: 'hmr1', captureClock: async () => {throw Error('unavailable');}, run: async () => saved});
  assert.equal(missing.value, saved); assert.equal(missing.bracket.actionCompleted, true); assert.equal(missing.bracket.status, 'unavailable');
  const afterMissing = await bracketWindowServerAction({actionId: 'hmr1', captureClock: async id => ({schemaVersion: 1, event: 'clock', id: id.endsWith('before') ? id : 'wrong', mach: '10'}), run: async () => saved});
  assert.equal(afterMissing.value, saved); assert.equal(afterMissing.bracket.reason, 'native-after-clock-unavailable');
});
