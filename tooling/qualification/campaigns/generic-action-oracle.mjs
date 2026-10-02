import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {genericNativeActionId, genericSessionNativeId} from './browser-generic-input.mjs';
import {getWindowServerSessionObservations} from './windowserver-session.mjs';
import {getWindowServerSessionLosslessObservations} from './windowserver-session-lossless.mjs';

// SOURCE-ONLY. The owner supplies independently reviewed panel/canvas pixels,
// actual verified file identities and an owned input projection. This module
// creates no oracle pixels, input events, timestamps or presentation IDs.
const PROFILE = 'interaction-100-2400-60hz-60s-1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const reference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,511}$/.test(value);
const demand = (ok, reason) => {if (!ok) throw Error(reason);};
const same = (left, right, reason) => demand(isDeepStrictEqual(left, right), reason);
function freeze(value) {if (object(value) || Array.isArray(value)) {for (const item of Object.values(value)) freeze(item); Object.freeze(value);} return value;}
function ticks(value) {
  demand(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'Invalid lossless native ticks');
  const result = BigInt(value); demand(result <= 18446744073709551615n, 'Native ticks exceed UInt64'); return result;
}
function file(value) {
  demand(object(value) && typeof value.path === 'string' && value.path.length <= 240 &&
    /^[A-Za-z0-9][A-Za-z0-9_./-]*\.bgra$/.test(value.path) && !value.path.split('/').some(part => !part || part === '.' || part === '..') &&
    sha(value.sha256) && integer(value.bytes) && value.bytes > 0, 'Invalid independent oracle pixel identity');
  return {path: value.path, sha256: value.sha256, bytes: value.bytes};
}
function validateProjection(projection) {
  demand(projection?.kind === 'generic-browser-input-projection-1' && projection.profile === PROFILE && token(projection.sessionId) &&
    projection.status === 'PASS' && Array.isArray(projection.actions) && projection.actions.length === 100 &&
    Array.isArray(projection.missing) && projection.missing.length === 0, 'Complete successful owned input projection required');
  const ids = new Set(), endpointIds = new Set(); let dispatchCount = 0, endpointCount = 0;
  const counts = {stroke: 0, undo: 0, pan: 0, layer: 0, density: 0, zoom: 0, theme: 0, split: 0};
  for (const [sequence, action] of projection.actions.entries()) {
    const identity = action.identity, family = identity?.family;
    const cycle = Math.floor(sequence / 5), expected = ['stroke', 'undo', ...(cycle % 2 ? ['zoom', 'theme', 'split'] : ['pan', 'layer', 'density'])][sequence % 5];
    demand(identity?.sessionId === projection.sessionId && identity.sequence === sequence && family === expected &&
      identity.sourceActionIndex === (family === 'stroke' ? cycle : cycle * 4 + sequence % 5 - 1) &&
      sha(action.stateSha256) && Array.isArray(action.dispatches) && Array.isArray(action.endpoints), 'Generic action order or state binding differs');
    counts[family]++; endpointCount += action.endpoints.length; dispatchCount += action.dispatches.length;
    const expectedDispatches = family === 'stroke' ? 120 : family === 'zoom' ? 3 : family === 'density' ? 2 : family === 'theme' ? null : 1;
    demand(expectedDispatches === null ? [2, 3].includes(action.dispatches.length) : action.dispatches.length === expectedDispatches,
      'Generic action dispatch inventory differs');
    demand(action.endpoints.length === (family === 'stroke' ? 120 : 1), 'Generic action endpoint inventory differs');
    for (const [index, dispatch] of action.dispatches.entries()) {
      const descriptor = dispatch.descriptor;
      demand(descriptor?.sessionId === projection.sessionId && descriptor.family === family &&
        dispatch.nativeActionId === genericNativeActionId(descriptor) && !ids.has(dispatch.nativeActionId), 'Generic native dispatch identity differs');
      ids.add(dispatch.nativeActionId);
      if (family === 'stroke') demand(descriptor.actionSequence === sequence && descriptor.specimenId === identity.specimenId &&
        descriptor.sampleIndex === index && descriptor.type === (index === 0 ? 'pointerdown' : index === 119 ? 'pointerup' : 'pointermove'), 'Stroke dispatch identity differs');
      else demand(descriptor.actionId === 'action-' + identity.sourceActionIndex, 'Discrete action identity differs');
    }
    for (const [ordinal, endpoint] of action.endpoints.entries()) {
      const input = action.dispatches[endpoint.firstDispatch];
      demand(reference(endpoint.id) && reference(endpoint.subject) && endpoint.ordinal === ordinal && sha(endpoint.stateSha256) &&
        endpoint.firstDispatch === (family === 'stroke' ? ordinal : 0) &&
        endpoint.lastDispatch === (family === 'stroke' ? ordinal : action.dispatches.length - 1) &&
        Number.isFinite(endpoint.inputMs) && endpoint.inputMs >= 0 && endpoint.inputMs === (family === 'stroke' ? input?.event?.inputMs : input?.inputEvidence?.inputMs) &&
        endpoint.inputClock === 'browser-performance' &&
        typeof endpoint.supported === 'boolean' && (endpoint.supported || token(endpoint.reason)), 'Generic endpoint identity or full dispatch chain differs');
      demand(!endpointIds.has(endpoint.id), 'Duplicate generic endpoint identity'); endpointIds.add(endpoint.id);
    }
  }
  same(counts, {stroke: 20, undo: 20, pan: 10, layer: 10, density: 10, zoom: 10, theme: 10, split: 10}, 'Generic family inventory differs');
  demand(dispatchCount === 2525 && endpointCount === 2480, 'Generic full dispatch or endpoint inventory differs');
}

/** Pure structural replay. File identities must already have been recomputed
 * from actual independently provided BGRA bytes by the owning reader. Matching
 * caller-supplied hashes is not evaluator authentication or semantic review. */
export function validateGenericActionOracle({projection, oracle, oracleBytes, oracleSha256, pixelIdentities, binding, display, roi} = {}) {
  validateProjection(projection);
  demand(Buffer.isBuffer(oracleBytes) && oracleBytes.length > 0 && oracleBytes.length <= 16 * 1024 ** 2 &&
    sha(oracleSha256) && hash(oracleBytes) === oracleSha256, 'Independent oracle raw manifest pin mismatch');
  const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(oracleBytes));
  if (oracle !== undefined) same(parsed, oracle, 'Parsed oracle differs from retained raw manifest');
  demand(parsed.kind === 'generic-action-pixel-oracle-1' && parsed.schemaVersion === 1 && parsed.profile === PROFILE &&
    parsed.pixelFormat === 'BGRA8' && Array.isArray(parsed.actions) && parsed.actions.length === projection.actions.length, 'Unsupported generic pixel oracle');
  demand(object(binding) && sha(binding.fixtureSha256) && sha(binding.browserEnvironmentSha256) && integer(binding.browserPid) && binding.browserPid > 0 &&
    integer(binding.windowNumber) && binding.windowNumber > 0, 'Owned fixture or browser binding unavailable');
  same(parsed.binding, {fixtureSha256: binding.fixtureSha256, browserEnvironmentSha256: binding.browserEnvironmentSha256}, 'Oracle stable fixture or environment differs');
  demand(object(display) && integer(display.id) && display.id > 0 && integer(display.width) && display.width > 0 && integer(display.height) && display.height > 0 &&
    object(roi) && Object.keys(roi).sort().join(',') === 'height,width,x,y' && Object.values(roi).every(integer) && roi.width > 0 && roi.height > 0 &&
    roi.x + roi.width <= display.width && roi.y + roi.height <= display.height && roi.width * roi.height * 4 <= 256 * 1024 ** 2, 'Exact bounded display ROI unavailable');
  same(parsed.display, display, 'Oracle display differs'); same(parsed.roi, roi, 'Oracle ROI differs');
  demand(Array.isArray(pixelIdentities) && pixelIdentities.length <= 5000, 'Oracle pixel inventory unavailable');
  const pixels = new Map();
  for (const entry of pixelIdentities) {const identity = file(entry); demand(!pixels.has(identity.path), 'Duplicate oracle pixel path'); pixels.set(identity.path, identity);}
  const used = new Set();
  const pixelState = state => {
    const identity = file(state); demand(identity.bytes === roi.width * roi.height * 4, 'Oracle pixels must cover the complete exact ROI');
    same(pixels.get(identity.path), identity, 'Oracle pixel identity was not verified by owning reader'); used.add(identity.path);
  };
  for (const [index, expected] of projection.actions.entries()) {
    const action = parsed.actions[index];
    demand(action.sequence === expected.identity.sequence && action.family === expected.identity.family && action.stateSha256 === expected.stateSha256 &&
      Array.isArray(action.endpoints) && action.endpoints.length === expected.endpoints.length, 'Oracle action state or endpoint inventory differs');
    for (const [ordinal, endpoint] of expected.endpoints.entries()) {
      const row = action.endpoints[ordinal];
      demand(row.ordinal === ordinal && row.subject === endpoint.subject && ['pixels', 'unavailable'].includes(row.kind), 'Oracle endpoint identity differs');
      if (row.kind === 'unavailable') {demand(token(row.reason), 'Unavailable oracle endpoint needs an explicit reason'); continue;}
      demand(endpoint.supported, 'Unsupported endpoint cannot acquire pixel evidence');
      for (const state of [row.before, row.after]) pixelState(state);
    }
    if (action.family === 'stroke') {
      const ack = action.acknowledgement;
      demand(ack && ['pixels', 'unavailable'].includes(ack.kind), 'Every stroke needs an explicit R04 acknowledgement oracle');
      if (ack.kind === 'unavailable') demand(token(ack.reason), 'Unavailable stroke acknowledgement needs reason');
      else {
        demand(ack.subject === 'mask-stroke-acknowledgement' && Number.isInteger(ack.prefixOrdinal) && ack.prefixOrdinal >= 1 && ack.prefixOrdinal <= 118 &&
          action.endpoints[ack.prefixOrdinal].kind === 'pixels', 'Stroke acknowledgement requires a reviewed meaningful move prefix');
        same(ack.after, action.endpoints[ack.prefixOrdinal].after, 'Stroke acknowledgement pixels differ from its reviewed prefix');
        pixelState(ack.before); pixelState(ack.after);
        demand(ack.before.sha256 !== ack.after.sha256, 'Stroke acknowledgement must visibly differ from pre-stroke pixels');
      }
    }
  }
  demand(used.size === pixels.size, 'Unreferenced oracle pixel identity');
  return freeze(parsed);
}

/** Match only within a dispatch-owned native interval. A session token must be
 * admitted by its private streaming verifier; this function cannot mint one.
 * No PASS, first-frame equality, physical scanout or full-slot claim is made. */
export function joinGenericActionPixels(capture, options = {}) {
  return joinVerifiedGenericActionPixels(getWindowServerSessionObservations(capture), options, 2);
}

/** The lossless route admits only the schema-3 private verifier's original
 * token. A copied object or schema-2 token cannot select another protocol. */
export function joinGenericActionLosslessPixels(capture, options = {}) {
  return joinVerifiedGenericActionPixels(getWindowServerSessionLosslessObservations(capture), options, 3);
}

function joinVerifiedGenericActionPixels(retained, options, schemaVersion) {
  demand(object(retained), 'Native session capture was not replayed');
  const {manifest, manifestSha256, clocks, samples} = retained;
  demand(manifest.schemaVersion === schemaVersion && manifest.kind === 'windowserver-session-capture-' + schemaVersion &&
    manifest.config.schemaVersion === schemaVersion && (schemaVersion !== 3 || manifest.config.storageFormat === 'rfc1951-previous-roi-1'),
    'Private native session protocol differs from selected join');
  demand(sha(manifestSha256) && Array.isArray(clocks) && Array.isArray(samples), 'Retained native session observations unavailable');
  const {projection, binding} = options;
  const oracle = validateGenericActionOracle({...options, display: manifest.display, roi: manifest.config.roi});
  demand(binding.browserPid === manifest.windowAdmission.ownerPID && binding.browserPid === manifest.config.expectedBrowserPid &&
    binding.windowNumber === manifest.windowAdmission.windowNumber, 'Native browser invocation ownership differs');
  const started = ticks(manifest.startedMach), ended = ticks(manifest.endedMach), timebase = manifest.timebase;
  demand(ended >= started && integer(timebase?.numer) && timebase.numer > 0 && integer(timebase?.denom) && timebase.denom > 0, 'Native session clock unavailable');
  const clockMap = new Map();
  for (const clock of clocks) {demand(clock.schemaVersion === schemaVersion && clock.event === 'clock' && token(clock.id) && !clockMap.has(clock.id), 'Duplicate or invalid native clock record'); clockMap.set(clock.id, clock);}
  demand(clockMap.size === 5052, 'Native session requires 5050 input ACKs and two window anchors');
  const sessionNativeId = genericSessionNativeId(projection.sessionId);
  const anchor = (value, boundary) => {
    demand(value?.kind === 'generic-native-session-anchor-1' && value.status === 'complete' && value.boundary === boundary &&
      value.sessionId === projection.sessionId && value.nativeSessionId === sessionNativeId && value.ack?.id === sessionNativeId + '-' + boundary,
      'Native observation window anchors differ');
    same(Object.keys(value).sort(), ['ack', 'boundary', 'kind', 'nativeSessionId', 'sessionId', 'status'], 'Native observation window anchor schema differs');
    return value.ack;
  };
  const windowStart = anchor(projection.nativeSessionStart, 'begin'), windowEnd = anchor(projection.nativeSessionEnd, 'end');
  same(clockMap.get(windowStart.id), windowStart, 'Native window begin ACK is not retained');
  same(clockMap.get(windowEnd.id), windowEnd, 'Native window end ACK is not retained');
  const windowBegan = ticks(windowStart.mach), windowEnded = ticks(windowEnd.mach);
  demand(windowBegan >= started && windowEnded >= windowBegan && windowEnded <= ended, 'Native observation window anchors reversed');
  const dispatches = []; let previous = windowBegan;
  for (const action of projection.actions) for (const dispatch of action.dispatches) {
    const bracket = dispatch.bracket, nativeActionId = dispatch.nativeActionId;
    demand(bracket?.kind === 'native-action-bracket-1' && bracket.actionId === nativeActionId && bracket.status === 'complete' && bracket.actionCompleted === true &&
      bracket.before?.id === nativeActionId + '-before' && bracket.after?.id === nativeActionId + '-after', 'Complete exact native input bracket required');
    same(clockMap.get(bracket.before.id), bracket.before, 'Native before ACK is not retained');
    same(clockMap.get(bracket.after.id), bracket.after, 'Native after ACK is not retained');
    const before = ticks(bracket.before.mach), after = ticks(bracket.after.mach);
    demand(before >= previous && after >= before && after <= windowEnded, 'Native input brackets overlap or reverse'); previous = after;
    dispatches.push({dispatch, before, after});
  }
  let priorDisplay = started;
  const usable = samples.filter(sample => {
    if (sample.sha256 === null || sample.sha256 === undefined) return false;
    demand(sha(sample.sha256) && sample.ownerPID === binding.browserPid && sample.windowNumber === binding.windowNumber, 'Native sample ownership or pixels unavailable');
    same(sample.roi, oracle.roi, 'Native sample ROI differs');
    const displayed = ticks(sample.displayTimeMach);
    demand(displayed >= priorDisplay && displayed <= ended, 'Native sample display clock reversed'); priorDisplay = displayed;
    return true;
  });
  let offset = 0;
  const actions = projection.actions.map((action, index) => {
    const observe = (endpoint, expected, requirements, referenceCeilingMs) => {
      const first = offset + endpoint.firstDispatch, last = offset + endpoint.lastDispatch;
      const a = dispatches[first].before, b = dispatches[last].after, next = dispatches[last + 1]?.before ?? windowEnded;
      const prior = dispatches[first - 1]?.after ?? windowBegan;
      const base = {id: endpoint.id, ordinal: endpoint.ordinal, subject: endpoint.subject, stateSha256: endpoint.stateSha256, requirements,
        inputMs: endpoint.inputMs, inputClock: endpoint.inputClock, firstDispatch: endpoint.firstDispatch, lastDispatch: endpoint.lastDispatch,
        nativeBracket: {earliestMach: a.toString(), latestMach: b.toString(), nextInputMach: next.toString()},
        status: 'INCONCLUSIVE', firstMeaningfulPaintUpperBoundMs: null, firstMeaningfulPaintExactMs: null, firstMeaningfulPaintLowerBoundMs: null,
        qualification: false};
      if (!endpoint.supported || expected.kind === 'unavailable') return {...base, reason: !endpoint.supported ? endpoint.reason : expected.reason};
      if (expected.before.sha256 === expected.after.sha256) return {...base, reason: 'oracle-has-no-distinguishable-pixel-change'};
      const baseline = usable.filter(sample => ticks(sample.displayTimeMach) <= a).at(-1);
      if (!baseline || baseline.sha256 !== expected.before.sha256) return {...base, reason: 'exact-before-baseline-not-observed'};
      if (ticks(baseline.displayTimeMach) < prior) return {...base, reason: 'baseline-predates-previous-input-completion'};
      // Repeated theme/density/viewport states from earlier actions are valid.
      // Only the latest baseline interval belongs to this action's causality.
      if (usable.some(sample => ticks(sample.displayTimeMach) >= ticks(baseline.displayTimeMach) && ticks(sample.displayTimeMach) <= a && sample.sha256 === expected.after.sha256))
        return {...base, reason: 'target-pixels-preexisted-this-input'};
      const matched = usable.find(sample => ticks(sample.displayTimeMach) >= b &&
        (last + 1 < dispatches.length ? ticks(sample.displayTimeMach) < next : ticks(sample.displayTimeMach) <= next) && sample.sha256 === expected.after.sha256);
      if (!matched) return {...base, reason: 'target-pixels-not-observed-before-next-input'};
      // The begin ACK precedes the original browser window start. Keeping a
      // match within 60 native seconds of that earlier anchor conservatively
      // bounds it inside the original window without converting browser clocks.
      if ((ticks(matched.displayTimeMach) - windowBegan) * BigInt(timebase.numer) > 60000n * BigInt(timebase.denom) * 1_000_000n)
        return {...base, reason: 'target-pixels-outside-conservative-original-window'};
      const numerator = (ticks(matched.displayTimeMach) - a) * BigInt(timebase.numer), denominator = BigInt(timebase.denom) * 1_000_000n;
      const microseconds = (numerator * 1000n + denominator - 1n) / denominator;
      demand(microseconds <= BigInt(Number.MAX_SAFE_INTEGER), 'Native elapsed upper bound exceeds exact arithmetic');
      const upperMs = Number(microseconds) / 1000;
      return {...base, status: 'OBSERVED', observedDisplayTimeMach: matched.displayTimeMach,
        firstMeaningfulPaintUpperBoundMs: upperMs, referenceCeilingMs,
        ceilingAssessment: upperMs <= referenceCeilingMs ? 'upper-bound-within-reference-ceiling' : 'unavailable-earliest-frame-not-proven'};
    };
    const requirements = action.identity.family === 'stroke' ? ['R07'] : ['pan', 'zoom'].includes(action.identity.family) ? ['R04', 'R07'] : ['R04'];
    const endpoints = action.endpoints.map((endpoint, ordinal) => observe(endpoint, oracle.actions[index].endpoints[ordinal], requirements,
      action.identity.family === 'stroke' ? 33.4 : 100));
    let acknowledgement;
    if (action.identity.family === 'stroke') {
      const expected = oracle.actions[index].acknowledgement;
      acknowledgement = observe({id: `${projection.sessionId}/action-${index}/acknowledgement`, ordinal: 0,
        subject: 'mask-stroke-acknowledgement', stateSha256: action.stateSha256, firstDispatch: 0,
        lastDispatch: expected.kind === 'pixels' ? expected.prefixOrdinal : 0,
        inputMs: action.dispatches[0].event.inputMs, inputClock: 'browser-performance',
        supported: expected.kind === 'pixels', ...(expected.kind === 'unavailable' ? {reason: expected.reason} : {})}, expected, ['R04'], 100);
      if (expected.kind === 'pixels') acknowledgement.prefixOrdinal = expected.prefixOrdinal;
    } else acknowledgement = {...endpoints[0], endpointId: endpoints[0].id};
    offset += action.dispatches.length;
    return {identity: structuredClone(action.identity), stateSha256: action.stateSha256, endpoints, acknowledgement};
  });
  const observed = actions.flatMap(action => action.endpoints).filter(endpoint => endpoint.status === 'OBSERVED').length;
  return freeze({kind: 'generic-action-windowserver-pixel-join-1', schemaVersion: 1, profile: PROFILE,
    sessionId: projection.sessionId, captureSchemaVersion: schemaVersion, captureSha256: manifestSha256, oracleSha256: options.oracleSha256, actions,
    observedEndpoints: observed, requiredEndpoints: 2480, requiredAcknowledgements: 100,
    observedAcknowledgements: actions.filter(action => action.acknowledgement.status === 'OBSERVED').length,
    status: observed === 2480 && actions.every(action => action.acknowledgement.status === 'OBSERVED') ? 'OBSERVED' : 'INCONCLUSIVE',
    qualification: false, automation: {driver: 'playwright', delivery: 'browser-input-api', physicalInput: false},
    semanticReviewRequired: true, independentPixelFileAdmissionRequired: true, browserInputInvocationAdmissionRequired: true,
    collectorSourceAndInvocationAdmissionRequired: true, physicalScanout: 'unavailable', displaySlotCoverage: 'unavailable',
    firstPresentedFrameCoverage: 'unavailable', browserToNativeClockCorrelation: 'unavailable'});
}
