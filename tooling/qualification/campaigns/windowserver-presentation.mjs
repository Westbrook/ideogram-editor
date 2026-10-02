import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {discreteInputDescriptor, validateDiscreteInput} from './browser-discrete-input.mjs';

// This source proves an observed WindowServer pixel endpoint. It does not
// establish a complete display-slot stream, hardware scanout, or first paint.
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const demand = (condition, message) => {if (!condition) throw Error(message);};
const same = (actual, expected, message) => demand(isDeepStrictEqual(actual, expected), message);
const MAX_METADATA = 8 * 1024 ** 2, MAX_PIXELS = 256 * 1024 ** 2;
const STATUSES = ['complete', 'idle', 'blank', 'suspended', 'started', 'stopped'];
const verified = new WeakMap();
function ticks(value) {
  demand(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'Invalid lossless native ticks');
  const result = BigInt(value); demand(result <= 18446744073709551615n, 'Native ticks exceed UInt64'); return result;
}
function decode(bytes, maximum, label) {
  demand(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum, `Invalid bounded ${label}`);
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}
function roi(value) {
  demand(object(value) && Object.keys(value).sort().join(',') === 'height,width,x,y' && Object.values(value).every(integer) && value.width > 0 && value.height > 0, 'Invalid exact pixel ROI');
  demand(value.width * value.height * 4 <= MAX_PIXELS, 'ROI exceeds pixel bound'); return value;
}
function rectangle(value) {
  return object(value) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) && value.width > 0 && value.height > 0;
}
function fileIdentity(value, path, bytes) {
  demand(object(value) && value.path === path && integer(value.bytes) && sha(value.sha256) && Buffer.isBuffer(bytes) && bytes.length === value.bytes && digest(bytes) === value.sha256, 'Retained native file differs from its seal');
}

function validateCaptureGeometry(manifest) {
  demand(manifest?.kind === 'windowserver-capture-1' && manifest.schemaVersion === 1, 'Unsupported native capture');
  const config = manifest.config;
  demand(object(config) && config.schemaVersion === 1 && integer(config.displayID) && config.displayID > 0 && config.displayID <= 0xffffffff &&
    integer(config.expectedBrowserPid) && config.expectedBrowserPid > 0 && config.expectedBrowserPid <= 0x7fffffff &&
    integer(config.durationMs) && config.durationMs >= 1 && config.durationMs <= 75000 && integer(config.maxFrames) && config.maxFrames >= 1 && config.maxFrames <= 5000 &&
    integer(config.maxBytes) && config.maxBytes >= 1 && config.maxBytes <= MAX_PIXELS, 'Invalid native capture limits');
  roi(config.roi);
  const display = manifest.display;
  demand(object(display) && display.id === config.displayID && integer(display.width) && integer(display.height) && display.width > 0 && display.height > 0 &&
    config.roi.x + config.roi.width <= display.width && config.roi.y + config.roi.height <= display.height, 'Native ROI or display identity differs');
  const geometry = manifest.captureGeometry, admission = manifest.windowAdmission;
  demand(object(geometry) && rectangle(geometry.displayBoundsPoints) && geometry.backingScale?.x === display.width / geometry.displayBoundsPoints.width &&
    geometry.backingScale?.y === display.height / geometry.displayBoundsPoints.height && geometry.scalesToFit === false && geometry.showsCursor === true &&
    geometry.capturesAudio === false && geometry.queueDepth === 3 && geometry.pixelFormat === 'BGRA', 'Native capture geometry is unavailable');
  same(geometry.modePixels, {width: display.width, height: display.height}, 'Native display mode dimensions differ');
  same(geometry.displayPoints, geometry.displayBoundsPoints, 'Native display point dimensions differ');
  demand(rectangle(geometry.filterPoints) && Number.isFinite(geometry.pointPixelScale) && geometry.pointPixelScale > 0 &&
    geometry.filterPoints.width * geometry.pointPixelScale === display.width && geometry.filterPoints.height * geometry.pointPixelScale === display.height &&
    geometry.pointPixelScale === geometry.backingScale.x && geometry.pointPixelScale === geometry.backingScale.y, 'Native filter pixel mapping differs');
  demand(object(admission) && admission.ownerPID === config.expectedBrowserPid && integer(admission.windowNumber) && admission.windowNumber > 0 &&
    admission.layer === 0 && Number.isFinite(admission.alpha) && admission.alpha > 0 && admission.alpha <= 1 && admission.onScreen === true && rectangle(admission.bounds) &&
    integer(admission.aboveVisibleWindowCount) && admission.intersectingAboveWindowCount === 0, 'Owned native browser window unavailable');
  const roiPoints = {x: geometry.displayBoundsPoints.x + config.roi.x / geometry.backingScale.x,
    y: geometry.displayBoundsPoints.y + config.roi.y / geometry.backingScale.y,
    width: config.roi.width / geometry.backingScale.x, height: config.roi.height / geometry.backingScale.y};
  same(admission.roiPoints, roiPoints, 'Native ROI point mapping differs');
  demand(roiPoints.x >= admission.bounds.x && roiPoints.y >= admission.bounds.y && roiPoints.x + roiPoints.width <= admission.bounds.x + admission.bounds.width &&
    roiPoints.y + roiPoints.height <= admission.bounds.y + admission.bounds.height, 'Native ROI is outside the owned browser window');
  demand(object(manifest.timebase) && integer(manifest.timebase.numer) && manifest.timebase.numer > 0 && manifest.timebase.numer <= 0xffffffff &&
    integer(manifest.timebase.denom) && manifest.timebase.denom > 0 && manifest.timebase.denom <= 0xffffffff, 'Native clock timebase unavailable');
  ticks(manifest.startedMach);
  return {config, display, admission};
}

/** Pre-action protocol validation only; ready is not pixel or timing evidence.
 * The supervisor still authenticates the launched source/executable and binds
 * these fields to the final manifest before admitting the replayed capture. */
export function validateWindowServerReady(ready, {config, outputDirectory} = {}) {
  demand(object(ready) && ready.event === 'ready', 'Native ready record unavailable');
  validateCaptureGeometry(ready);
  same(ready.config, config, 'Native ready config differs from invocation');
  demand(typeof outputDirectory === 'string' && outputDirectory.startsWith('/') && ready.outputDirectory === outputDirectory, 'Native ready output differs from invocation');
  same(ready.roi, config.roi, 'Native ready ROI differs');
  demand(ready.pixelByteLimit === config.maxBytes && ready.metadataByteLimit === MAX_METADATA && ready.manifestByteLimit === 2 * 1024 ** 2 &&
    ready.maxClockRecords === 256 && ready.pointPixelScale === ready.captureGeometry.pointPixelScale, 'Native ready limits unavailable');
  // Return a detached snapshot; no caller mutation can rewrite the admission.
  return structuredClone(ready);
}

/** Pure replay: the owner reads bounded ordinary files once, seals their bytes,
 * and supplies those exact buffers. Map membership is exact; unlisted pixel
 * files cannot enter the result. manifestSha256 must come from that owned
 * collector invocation, never a supplied product/native-evidence flag. */
export function verifyWindowServerCapture({manifestBytes, framesBytes, pixels}, {manifestSha256} = {}) {
  demand(sha(manifestSha256) && Buffer.isBuffer(manifestBytes) && digest(manifestBytes) === manifestSha256, 'Native manifest pin mismatch');
  const manifest = decode(manifestBytes, 2 * 1024 ** 2, 'native manifest');
  const {config, display, admission} = validateCaptureGeometry(manifest);
  const started = ticks(manifest.startedMach), ended = ticks(manifest.endedMach);
  demand(ended >= started, 'Native capture clock reversed');
  demand(['requested-stop', 'stdin-eof', 'duration-limit', 'frame-limit', 'pixel-byte-limit'].includes(manifest.terminalReason), 'Native terminal reason is unsuccessful or unavailable');
  demand(Buffer.isBuffer(framesBytes) && framesBytes.length > 0 && framesBytes.length <= MAX_METADATA, 'Native metadata bound exceeded');
  fileIdentity(manifest.frames, 'frames.ndjson', framesBytes);
  const text = new TextDecoder('utf-8', {fatal: true}).decode(framesBytes);
  demand(text.endsWith('\n'), 'Native metadata has an incomplete tail');
  const lines = text.slice(0, -1).split('\n');
  demand(lines.length <= config.maxFrames + 256 && lines.every(line => line.length > 0 && Buffer.byteLength(line) <= 16384), 'Native metadata record bound exceeded');
  const records = lines.map(line => JSON.parse(line));
  demand(pixels instanceof Map && Array.isArray(manifest.pixelFiles) && manifest.pixelFiles.length <= config.maxFrames && pixels.size === manifest.pixelFiles.length, 'Native pixel inventory differs');
  const files = new Map(); let pixelBytes = 0;
  for (const entry of manifest.pixelFiles) {
    demand(/^frame-[1-9][0-9]{0,4}\.bgra$/.test(entry?.path ?? '') && !files.has(entry.path), 'Invalid or duplicate native pixel path');
    const bytes = pixels.get(entry.path); fileIdentity(entry, entry.path, bytes);
    demand(bytes.length === config.roi.width * config.roi.height * 4, 'Native ROI bytes are not tightly packed BGRA');
    pixelBytes += bytes.length; demand(pixelBytes <= config.maxBytes, 'Native pixel byte limit exceeded'); files.set(entry.path, entry);
  }
  const clocks = new Map(), samples = [], referenced = new Set(); let previousCallback = started, previousDisplay = 0n, previousRecord = started;
  for (const row of records) {
    demand(object(row) && row.schemaVersion === 1, 'Malformed native record');
    if (row.event === 'clock') {
      demand(id(row.id) && !clocks.has(row.id) && clocks.size < 256, 'Duplicate or malformed native clock identity');
      const value = ticks(row.mach); demand(value >= previousRecord && value <= ended, 'Native clock record is outside capture or reversed'); previousRecord = value; clocks.set(row.id, row); continue;
    }
    demand(row.event === 'sample' && row.ordinal === samples.length + 1 && row.ordinal <= config.maxFrames && integer(row.statusRaw) && row.statusRaw < STATUSES.length && typeof row.status === 'string' && STATUSES[row.statusRaw] === row.status, 'Native sample ordinal or status differs');
    demand(row.ownerPID === admission.ownerPID && row.windowNumber === admission.windowNumber && integer(row.aboveVisibleWindowCount) &&
      row.intersectingAboveWindowCount === 0, 'Sample browser window ownership or overlap observation differs');
    const callback = ticks(row.callbackMach);
    demand(callback >= previousCallback && callback >= previousRecord && callback <= ended, 'Native sample callback clock is outside capture'); previousCallback = callback; previousRecord = callback;
    const observedWindow = ticks(row.windowObservationMach);
    demand(observedWindow >= callback && observedWindow <= ended, 'Sample window observation clock is outside capture');
    previousRecord = observedWindow;
    if (row.displayTimeMach !== null) {
      const displayed = ticks(row.displayTimeMach);
      demand(displayed <= callback && displayed >= previousDisplay, 'Native display timestamp reversed or exceeds its callback'); previousDisplay = displayed;
    }
    if (row.file !== null) {
      demand(row.retained === true && row.status === 'complete' && row.contentScale === 1 && row.displayTimeMach !== null && ticks(row.displayTimeMach) >= started && row.pixelFormat === 1111970369 &&
        row.width === display.width && row.height === display.height, 'Pixel evidence is not a complete native-resolution display sample');
      same(row.roi, config.roi, 'Sample ROI differs from capture');
      const sealed = files.get(row.file); demand(sealed && !referenced.has(row.file) && row.file === `frame-${row.ordinal}.bgra` && row.sha256 === sealed.sha256 && row.byteLength === sealed.bytes, 'Sample pixel identity differs'); referenced.add(row.file);
    } else demand(row.retained === false && row.sha256 === null && row.byteLength === null, 'Sample claims unretained pixel bytes');
    samples.push(row);
  }
  demand(referenced.size === files.size, 'Unreferenced native pixel artifact');
  demand(object(manifest.counts) && manifest.counts.sampleRecords === samples.length && manifest.counts.clockRecords === clocks.size && manifest.counts.pixelBytes === pixelBytes &&
    manifest.counts.completeFrames === samples.filter(row => row.file !== null).length && manifest.counts.unretainedSamples === samples.filter(row => row.file === null).length, 'Native sample counts differ');
  const result = Object.freeze({kind: 'verified-windowserver-capture-1', manifestSha256,
    source: 'ScreenCaptureKit-full-display', clock: 'mach-absolute', qualification: false,
    displaySlotCoverage: 'unavailable', firstPresentedFrameCoverage: 'unavailable'});
  // Keep parsed records private. Callers cannot mutate a verified timestamp or
  // forge the kind string to bypass byte replay. Pixel hashes were recomputed
  // above; retaining all input buffers would double the offline pixel budget.
  verified.set(result, {manifest, manifestSha256, records, clocks, samples}); return result;
}

/** Awaited native clock requests enclose the actual operation without equating
 * Node, browser Performance, trace or CMSampleBuffer PTS clocks. The owner must
 * bound and cancel captureClock; this helper starts no child process. */
export async function bracketWindowServerAction({captureClock, run, actionId}) {
  demand(typeof captureClock === 'function' && typeof run === 'function' && id(actionId) && actionId.length <= 56, 'Invalid native action bracket');
  let before = null, after = null, reason = null;
  async function clock(boundary) {
    const value = await captureClock(actionId + '-' + boundary);
    demand(value?.schemaVersion === 1 && value.event === 'clock' && value.id === actionId + '-' + boundary, 'Native clock ACK mismatch'); ticks(value.mach); return value;
  }
  try {before = await clock('before');} catch {reason = 'native-before-clock-unavailable';}
  let value;
  try {value = await run();}
  catch (error) {
    // Preserve the action exception itself; diagnostic attachment is best
    // effort because callers can throw primitives or frozen Error objects.
    try {if (object(error)) error.nativeActionBracket = {kind: 'native-action-bracket-1', actionId, status: 'unavailable', actionCompleted: false, before, after: null, reason: 'action-failed'};} catch {}
    throw error;
  }
  try {after = await clock('after');} catch {reason ??= 'native-after-clock-unavailable';}
  if (before && after && ticks(after.mach) < ticks(before.mach)) reason = 'native-action-clock-reversed';
  return {value, bracket: {kind: 'native-action-bracket-1', actionId, status: reason ? 'unavailable' : 'complete', actionCompleted: true, before, after, ...(reason ? {reason} : {})}};
}

/** Bind native ACK names to the complete browser observation identity. This is
 * a harness correlation ID, never a Chromium EventLatency or hardware ID. */
export function firstUseNativeActionId(descriptor) {
  descriptor = discreteInputDescriptor(descriptor);
  demand(descriptor.family === 'first-use' && descriptor.actionId === 'first-use' && descriptor.stepId === 'open-panel' &&
    ['mask-tool', 'adapter-library'].includes(descriptor.target.control) && Object.keys(descriptor.target).length === 1 &&
    descriptor.input.kind === 'click', 'Unsupported first-use input descriptor');
  return 'fu-' + digest(JSON.stringify(descriptor)).slice(0, 48);
}

/** Pure replay for the two existing first-use panel actions. The external pin
 * must identify independently reviewed, whole meaningful panel pixels for the
 * exact fixture and browser environment; this function does not create or
 * semantically approve an oracle. The consumer owns the actual hook invocation
 * and binds the supplied descriptor, successful run value and capture process.
 * Browser timestamps are retained but never subtracted from native clocks. */
export function joinFirstUseWindowServerPixels(capture, {oracleBytes, oraclePixels, oracleSha256, feature,
  expectedDescriptor, inputEvidence, bracket, binding} = {}) {
  demand(verified.has(capture) && sha(oracleSha256) && Buffer.isBuffer(oracleBytes) && digest(oracleBytes) === oracleSha256,
    'First-use oracle pin mismatch or capture not replayed');
  capture = verified.get(capture);
  const subjects = {Mask: {subject: 'mask-controls-panel', control: 'mask-tool'},
    'Adapter library': {subject: 'local-adapter-library-panel', control: 'adapter-library'}};
  demand(Object.hasOwn(subjects, feature), 'Unsupported first-use feature');
  const descriptor = discreteInputDescriptor(expectedDescriptor), actionId = firstUseNativeActionId(descriptor);
  same(expectedDescriptor, descriptor, 'First-use expected descriptor is not canonical');
  demand(descriptor.target.control === subjects[feature].control, 'First-use feature and input target differ');
  demand(inputEvidence?.kind === 'browser-discrete-input-1' && inputEvidence.schemaVersion === 1 && inputEvidence.status === 'PASS' &&
    inputEvidence.qualification === false, 'First-use input observation is not an admitted successful run');
  same(inputEvidence.descriptor, descriptor, 'First-use input action or substep differs');
  same(inputEvidence.automation, {driver: 'playwright', delivery: 'browser-input-api', physicalInput: false}, 'First-use input automation provenance differs');
  // Recheck both retained browser clock origins and every input record. This
  // authenticates neither an invocation nor a correlation with native clocks;
  // the owned live consumer must supply invocation admission. Elapsed native
  // arithmetic below uses only Mach ticks.
  const checkedInput = validateDiscreteInput(inputEvidence, descriptor);
  demand(checkedInput.status === 'PASS', 'First-use retained input records are invalid');
  same(checkedInput, inputEvidence, 'First-use retained input differs from validated records');
  demand(object(binding) && Object.keys(binding).sort().join(',') === 'browserEnvironmentSha256,browserPid,fixtureSha256,windowNumber' &&
    sha(binding.fixtureSha256) && sha(binding.browserEnvironmentSha256) &&
    binding.browserPid === capture.manifest.config.expectedBrowserPid && binding.browserPid === capture.manifest.windowAdmission.ownerPID &&
    binding.windowNumber === capture.manifest.windowAdmission.windowNumber, 'First-use owned fixture or browser binding differs');
  const oracle = decode(oracleBytes, 65536, 'first-use pixel oracle');
  demand(oracle.kind === 'first-use-panel-oracle-1' && oracle.schemaVersion === 1 && oracle.feature === feature &&
    oracle.subject === subjects[feature].subject && oracle.before?.state === 'closed' && oracle.after?.state === 'open',
    'First-use semantic oracle differs from fixed panel action');
  same(oracle.binding, {fixtureSha256: binding.fixtureSha256, browserEnvironmentSha256: binding.browserEnvironmentSha256},
    'First-use oracle fixture or browser environment differs');
  same(oracle.display, capture.manifest.display, 'First-use oracle display differs');
  same(oracle.roi, capture.manifest.config.roi, 'First-use oracle ROI differs');
  demand(oracle.pixelFormat === 'BGRA8' && oraclePixels instanceof Map && oraclePixels.size === 2, 'First-use oracle pixel format or inventory differs');
  for (const [name, state] of [['before.bgra', oracle.before], ['after.bgra', oracle.after]]) {
    fileIdentity({path: name, bytes: state.bytes, sha256: state.sha256}, name, oraclePixels.get(name));
    demand(state.bytes === oracle.roi.width * oracle.roi.height * 4, 'First-use oracle ROI bytes differ');
  }
  demand(oracle.before.sha256 !== oracle.after.sha256, 'First-use oracle contains no visible change');
  demand(bracket?.kind === 'native-action-bracket-1' && bracket.status === 'complete' && bracket.actionCompleted === true &&
    bracket.actionId === actionId && bracket.before?.id === actionId + '-before' && bracket.after?.id === actionId + '-after',
    'First-use native action bracket missing or input identity differs');
  same(capture.clocks.get(bracket.before.id), bracket.before, 'First-use before ACK is not retained');
  same(capture.clocks.get(bracket.after.id), bracket.after, 'First-use after ACK is not retained');
  const before = ticks(bracket.before.mach), after = ticks(bracket.after.mach);
  demand(after >= before, 'First-use native input bracket reversed');
  const usable = capture.samples.filter(row => row.file !== null);
  const latestBaseline = usable.filter(row => ticks(row.displayTimeMach) <= before).at(-1);
  const baseline = latestBaseline?.sha256 === oracle.before.sha256 ? latestBaseline : null;
  const preexisting = usable.some(row => ticks(row.displayTimeMach) <= before && row.sha256 === oracle.after.sha256);
  // A target frame inside the bracket cannot establish its ordering relative
  // to the dispatched action. Later observed pixels provide only an upper bound.
  const matched = usable.find(row => ticks(row.displayTimeMach) >= after && row.sha256 === oracle.after.sha256);
  const base = {kind: 'first-use-windowserver-pixel-join-1', source: 'ScreenCaptureKit-full-display', endpoint: 'WindowServer-presented-pixels',
    feature, subject: oracle.subject, descriptor, automation: checkedInput.automation, inputEvidence: checkedInput, nativeActionId: actionId,
    binding: {...binding}, oracleSha256, captureSha256: capture.manifestSha256, qualification: false,
    semanticReviewRequired: true, collectorSourceAndInvocationAdmissionRequired: true, browserInputInvocationAdmissionRequired: true,
    physicalScanout: 'unavailable', displaySlotCoverage: 'unavailable', firstPresentedFrameCoverage: 'unavailable',
    browserToNativeClockCorrelation: 'unavailable', firstMeaningfulPaintLowerBoundMs: null, firstMeaningfulPaintExactMs: null,
    firstMeaningfulPaintUpperBoundMs: null, budget: 'R04', targetMs: 50, ceilingMs: 100};
  if (!baseline || preexisting || !matched) return {...base, status: 'unavailable',
    reason: !baseline ? 'closed-panel-baseline-not-observed' : preexisting ? 'open-panel-preexisted-input' : 'open-panel-not-captured-after-input'};
  const numerator = (ticks(matched.displayTimeMach) - before) * BigInt(capture.manifest.timebase.numer);
  const denominator = BigInt(capture.manifest.timebase.denom) * 1_000_000n;
  const microseconds = (numerator * 1000n + denominator - 1n) / denominator;
  demand(microseconds <= BigInt(Number.MAX_SAFE_INTEGER), 'First-use native elapsed bound exceeds exact arithmetic');
  const upperMs = Number(microseconds) / 1000;
  return {...base, status: 'observed', baselineOrdinal: baseline.ordinal, matchedOrdinal: matched.ordinal,
    observedDisplayTimeMach: matched.displayTimeMach, inputBracket: {earliestMach: before.toString(), latestMach: after.toString()},
    firstMeaningfulPaintUpperBoundMs: upperMs,
    ceilingAssessment: upperMs <= 100 ? 'upper-bound-within-ceiling' : 'unavailable-earliest-frame-not-proven'};
}

/** Exact full-wordmark pixels, not a marker square or DOM text. The independent
 * oracle is admitted by its exact external pin and retained pixels; semantic
 * review and real source/preservation checks belong to the existing HMR owner.
 * This produces no metric PASS/FAIL and never labels a late capture a late
 * first presentation: an earlier correct frame may have been uncaptured. */
export function joinHmrWindowServerPixels(capture, {oracleBytes, oraclePixels, oracleSha256, sourceIdentity, bracket} = {}) {
  demand(verified.has(capture) && sha(oracleSha256) && Buffer.isBuffer(oracleBytes) && digest(oracleBytes) === oracleSha256, 'HMR oracle pin mismatch or capture not replayed');
  capture = verified.get(capture);
  const oracle = decode(oracleBytes, 65536, 'HMR pixel oracle');
  demand(oracle.kind === 'hmr-wordmark-oracle-1' && oracle.schemaVersion === 1 && oracle.subject === '.wordmark-secondary' && oracle.before?.text === 'Editor' && oracle.after?.text === 'Editor updated', 'HMR semantic oracle differs from fixed edit');
  demand(sourceIdentity?.sourcePath === 'src/ui/shell-wordmark.ts' && sha(oracle.source?.originalSha256) && sha(oracle.source?.changedSha256) &&
    oracle.source.originalSha256 !== oracle.source.changedSha256 &&
    sourceIdentity.original?.sha256 === 'sha256:' + oracle.source.originalSha256 && sourceIdentity.changed?.sha256 === 'sha256:' + oracle.source.changedSha256, 'HMR source edit differs from oracle');
  same(oracle.display, capture.manifest.display, 'HMR oracle display differs'); same(oracle.roi, capture.manifest.config.roi, 'HMR oracle ROI differs');
  demand(oracle.pixelFormat === 'BGRA8' && oraclePixels instanceof Map && oraclePixels.size === 2, 'HMR oracle pixel format or inventory differs');
  for (const [name, state] of [['before.bgra', oracle.before], ['after.bgra', oracle.after]]) {
    fileIdentity({path: name, bytes: state.bytes, sha256: state.sha256}, name, oraclePixels.get(name));
    demand(state.bytes === oracle.roi.width * oracle.roi.height * 4, 'HMR oracle ROI bytes differ');
  }
  demand(oracle.before.sha256 !== oracle.after.sha256, 'HMR oracle contains no visible change');
  demand(bracket?.kind === 'native-action-bracket-1' && bracket.status === 'complete' && bracket.actionCompleted === true && id(bracket.actionId) && bracket.before?.id === bracket.actionId + '-before' && bracket.after?.id === bracket.actionId + '-after', 'HMR native action bracket missing');
  same(capture.clocks.get(bracket.before.id), bracket.before, 'HMR before ACK is not retained'); same(capture.clocks.get(bracket.after.id), bracket.after, 'HMR after ACK is not retained');
  const before = ticks(bracket.before.mach), after = ticks(bracket.after.mach); demand(after >= before, 'HMR save bracket reversed');
  const ceilingMs = 500; // PERF D05; callers cannot weaken the named ceiling.
  const usable = capture.samples.filter(row => row.file !== null);
  const matches = (row, name) => row.sha256 === digest(oraclePixels.get(name));
  const baseline = usable.filter(row => ticks(row.displayTimeMach) <= before && matches(row, 'before.bgra')).at(-1);
  const preexisting = usable.some(row => ticks(row.displayTimeMach) <= before && matches(row, 'after.bgra'));
  // Select only a frame certainly after completion of the bracketed save.
  // A match inside [A,B] cannot prove its ordering relative to that save.
  const matched = usable.find(row => ticks(row.displayTimeMach) >= after && matches(row, 'after.bgra'));
  const base = {kind: 'hmr-windowserver-pixel-join-1', source: 'ScreenCaptureKit-full-display', endpoint: 'WindowServer-presented-pixels', qualification: false,
    oracleSha256, captureSha256: capture.manifestSha256, semanticReviewRequired: true, collectorSourceAndInvocationAdmissionRequired: true,
    physicalScanout: 'unavailable', displaySlotCoverage: 'unavailable',
    firstCorrectPaintLowerBoundMs: null, firstCorrectPaintExactMs: null};
  if (!baseline || preexisting || !matched) return {...base, status: 'unavailable', reason: !baseline ? 'baseline-wordmark-not-observed' : preexisting ? 'updated-wordmark-preexisted-save' : 'updated-wordmark-not-captured'};
  const numerator = (ticks(matched.displayTimeMach) - before) * BigInt(capture.manifest.timebase.numer), denominator = BigInt(capture.manifest.timebase.denom) * 1_000_000n;
  // Round upward to whole microseconds; floating-point conversion cannot shrink
  // a true upper bound or turn an exact threshold into an accidental pass.
  const microseconds = (numerator * 1000n + denominator - 1n) / denominator;
  demand(microseconds <= BigInt(Number.MAX_SAFE_INTEGER), 'Native elapsed bound exceeds exact arithmetic');
  const upperMs = Number(microseconds) / 1000;
  return {...base, status: 'observed', baselineOrdinal: baseline.ordinal, matchedOrdinal: matched.ordinal, observedDisplayTimeMach: matched.displayTimeMach,
    saveBracket: {earliestMach: before.toString(), latestMach: after.toString()}, firstCorrectPaintUpperBoundMs: upperMs,
    ceilingAssessment: upperMs <= ceilingMs ? 'upper-bound-within-ceiling' : 'unavailable-earliest-frame-not-proven', ceilingMs};
}
