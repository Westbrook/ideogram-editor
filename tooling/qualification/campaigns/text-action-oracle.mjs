import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {TEXT_INPUT_PROFILE, buildTextInputInventory, textInputDescriptor, textInputIdentity, textSessionNativeId, projectTextInteraction} from './browser-text-input.mjs';
import {getWindowServerTextSessionLosslessObservations} from './windowserver-text-session-lossless.mjs';

// SOURCE-ONLY. The owner supplies independently reviewed meaningful text UI
// pixels and recomputes their identities from actual external bytes. This
// module generates neither expected pixels nor browser/native timestamps.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const demand = (ok, reason) => {if (!ok) throw Error(reason);};
const same = (a, b, reason) => demand(isDeepStrictEqual(a, b), reason);
const keys = (value, expected, reason) => {demand(object(value), reason); same(Object.keys(value).sort(), [...expected].sort(), reason);};
function freeze(value) {if (object(value) || Array.isArray(value)) {for (const item of Object.values(value)) freeze(item); Object.freeze(value);} return value;}
function ticks(value) {
  demand(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'Invalid lossless native ticks');
  const n = BigInt(value); demand(n <= 18446744073709551615n, 'Native ticks exceed UInt64'); return n;
}
function pixel(value) {
  keys(value, ['path', 'sha256', 'bytes'], 'Independent oracle pixel schema differs');
  demand(typeof value.path === 'string' && value.path.length <= 240 && /^[A-Za-z0-9][A-Za-z0-9_./-]*\.bgra$/.test(value.path) &&
    !value.path.split('/').some(part => !part || part === '.' || part === '..') && sha(value.sha256) && integer(value.bytes) && value.bytes > 0,
    'Invalid independent oracle pixel identity');
  return {path: value.path, sha256: value.sha256, bytes: value.bytes};
}
function geometry(display, roi) {
  keys(display, ['id', 'width', 'height'], 'Exact display identity required');
  keys(roi, ['x', 'y', 'width', 'height'], 'Exact display ROI required');
  demand(Object.values(display).every(n => integer(n) && n > 0) && Object.values(roi).every(integer) && roi.width > 0 && roi.height > 0 &&
    roi.x + roi.width <= display.width && roi.y + roi.height <= display.height && roi.width * roi.height * 4 <= 256 * 1024 ** 2,
    'Exact bounded display ROI unavailable');
}

/** The subject is a reviewed visible response to this original intent. A
 * deferred request's pending feedback is distinct from a later actual switch. */
export function textActionOracleSubject(action) {
  if (action.kind === 'insert-delete') return action.mode === 'insert' ? 'text-insert' : 'text-delete';
  if (action.kind === 'presentation') return action.mode === 'immediate' ? 'text-presentation-switch' : 'text-presentation-pending-feedback';
  const subject = {caret: 'text-caret-or-selection', 'semantic-selection': 'text-semantic-selection', 'text-format': 'text-format',
    preedit: 'text-synthetic-preedit', 'composition-end': 'text-synthetic-composition-end'}[action.kind];
  demand(subject, 'Unknown text action family'); return subject;
}

/** Pre-budget census only. This function does not authenticate a manifest,
 * read a pixel file, or confer semantic review on caller-supplied identities. */
export function textOracleInventory(oracle, {selection, environment} = {}) {
  keys(oracle, ['kind', 'schemaVersion', 'profile', 'binding', 'display', 'roi', 'pixelFormat', 'actions'], 'Text oracle schema differs');
  demand(oracle.kind === 'text-action-pixel-oracle-1' && oracle.schemaVersion === 1 && oracle.profile === TEXT_INPUT_PROFILE &&
    oracle.pixelFormat === 'BGRA8' && Array.isArray(oracle.actions) && oracle.actions.length === 106, 'Text oracle requires the original 106 actions');
  demand(sha(environment?.fixtureSha256) && sha(environment?.browserEnvironmentSha256), 'Text fixture and browser environment pins required');
  same(oracle.binding, {fixtureSha256: environment.fixtureSha256, browserEnvironmentSha256: environment.browserEnvironmentSha256}, 'Text oracle fixture or environment differs');
  geometry(oracle.display, oracle.roi);
  same(oracle.roi, selection?.roi, 'Text oracle ROI differs'); demand(oracle.display.id === selection?.displayID, 'Text oracle display differs');
  const inventory = buildTextInputInventory(), files = new Map(), directories = new Set(['.']);
  demand(inventory.length === 106, 'Text input inventory profile differs');
  const retain = value => {
    const file = pixel(value); demand(file.bytes === oracle.roi.width * oracle.roi.height * 4, 'Oracle pixels must cover the complete exact ROI');
    if (files.has(file.path)) same(files.get(file.path), file, 'Text oracle path has conflicting pins'); else files.set(file.path, file);
    for (let directory = dirname(file.path); directory !== '.'; directory = dirname(directory)) directories.add(directory);
  };
  for (const [sequence, row] of oracle.actions.entries()) {
    const expected = inventory[sequence];
    demand(['pixels', 'unavailable'].includes(row?.kind), 'Every text action needs pixels or an explicit unavailable reason');
    keys(row, ['sequence', 'actionId', 'family', 'stateSha256', 'subject', 'kind', ...(row.kind === 'pixels' ? ['before', 'after'] : ['reason'])], 'Text oracle action schema differs');
    demand(row.sequence === sequence && row.actionId === expected.id && row.family === expected.kind && sha(row.stateSha256) &&
      row.subject === textActionOracleSubject(expected), 'Text oracle action identity or subject differs');
    if (row.kind === 'unavailable') demand(token(row.reason), 'Unavailable text oracle needs an explicit reason');
    else {retain(row.before); retain(row.after);}
  }
  demand(files.size <= 212, 'Text oracle exceeds 212 logical pixel files');
  return {files: [...files.values()], directories: [...directories], pixelBytes: [...files.values()].reduce((n, file) => n + file.bytes, 0)};
}

function validateProjection(projection, raw) {
  demand(projection?.kind === 'text-interaction-input-1' && projection.schemaVersion === 1 && projection.profile === TEXT_INPUT_PROFILE && token(projection.sessionId) &&
    projection.status === 'PASS' && projection.qualification === false && Array.isArray(projection.actions) && projection.actions.length === 106 &&
    Array.isArray(projection.missing) && projection.missing.length === 0 && Array.isArray(projection.failures) && projection.failures.length === 0,
    'Complete successful owned text input projection required');
  demand(object(raw), 'Authoritative retained raw text observations required');
  const replayed = projectTextInteraction(raw, {sessionId: projection.sessionId});
  same(projection, replayed, 'Text input projection differs from authoritative raw replay');
  const inventory = buildTextInputInventory(), ids = new Set(); let count = 0;
  for (const [sequence, action] of projection.actions.entries()) {
    const expected = inventory[sequence], identity = action.identity;
    same(identity, {sessionId: projection.sessionId, sequence, actionId: expected.id, family: expected.kind}, 'Text projection action identity differs');
    demand(sha(action.stateSha256) && object(action.state) && Array.isArray(action.dispatches) && action.dispatches.length === expected.steps.length,
      'Text action state or full input chain unavailable');
    for (const [stepSequence, dispatch] of action.dispatches.entries()) {
      const descriptor = textInputDescriptor({sessionId: projection.sessionId, actionId: expected.id, stepId: expected.steps[stepSequence].stepId});
      same(dispatch.descriptor, descriptor, 'Text dispatch descriptor differs from finite input inventory');
      const identity = textInputIdentity(descriptor);
      demand(dispatch.nativeActionId === identity.nativeActionId && !ids.has(identity.nativeActionId), 'Text dispatch identity differs or duplicates');
      ids.add(identity.nativeActionId); count++;
    }
  }
  demand(count === 247, 'Text projection must retain exactly 247 original substeps');
}

/** Pure structural replay. Caller-provided pins are not evaluator identity or
 * independent semantic review. Raw manifest bytes prevent a canonicalized or
 * invented file pin from standing in for the retained external manifest. */
export function validateTextActionOracle({projection, raw, oracle, oracleBytes, oracleSha256, pixelIdentities, binding, display, roi} = {}) {
  validateProjection(projection, raw);
  demand(Buffer.isBuffer(oracleBytes) && oracleBytes.length > 0 && oracleBytes.length <= 16 * 1024 ** 2 && sha(oracleSha256) && hash(oracleBytes) === oracleSha256,
    'Independent text oracle raw manifest pin mismatch');
  const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(oracleBytes));
  if (oracle !== undefined) same(parsed, oracle, 'Parsed text oracle differs from retained raw manifest');
  demand(object(binding) && sha(binding.fixtureSha256) && sha(binding.browserEnvironmentSha256) && integer(binding.browserPid) && binding.browserPid > 0 &&
    integer(binding.windowNumber) && binding.windowNumber > 0, 'Owned text fixture or browser binding unavailable');
  geometry(display, roi); same(parsed.display, display, 'Text oracle display differs');
  const inventory = textOracleInventory(parsed, {selection: {displayID: display.id, roi}, environment: binding});
  demand(Array.isArray(pixelIdentities) && pixelIdentities.length === inventory.files.length, 'Exact independently retained text pixel inventory required');
  const actual = new Map();
  for (const value of pixelIdentities) {const file = pixel(value); demand(!actual.has(file.path), 'Duplicate text oracle pixel path'); actual.set(file.path, file);}
  for (const file of inventory.files) same(actual.get(file.path), file, 'Text oracle pixel identity was not verified by owning reader');
  for (const [index, row] of parsed.actions.entries()) demand(row.stateSha256 === projection.actions[index].stateSha256, 'Text oracle action state differs');
  return freeze(parsed);
}

/** Accept only the schema-4 text verifier's private original token. Neither a
 * copied object nor a generic session token can select this replay protocol. */
export function joinTextActionPixels(capture, options = {}) {
  const retained = getWindowServerTextSessionLosslessObservations(capture);
  demand(object(retained), 'Native text session capture was not replayed');
  const {manifest, manifestSha256, clocks, samples} = retained;
  demand(manifest?.schemaVersion === 4 && manifest.kind === 'windowserver-text-session-capture-4' && manifest.config?.schemaVersion === 4 &&
    manifest.config.profile === TEXT_INPUT_PROFILE && manifest.config.storageFormat === 'rfc1951-previous-roi-1', 'Private native text session protocol differs');
  demand(sha(manifestSha256) && Array.isArray(clocks) && Array.isArray(samples), 'Retained native text observations unavailable');
  const {projection, binding} = options;
  const oracle = validateTextActionOracle({...options, display: manifest.display, roi: manifest.config.roi});
  demand(binding.browserPid === manifest.windowAdmission?.ownerPID && binding.browserPid === manifest.config.expectedBrowserPid &&
    binding.windowNumber === manifest.windowAdmission?.windowNumber, 'Native text browser invocation ownership differs');
  const started = ticks(manifest.startedMach), ended = ticks(manifest.endedMach), timebase = manifest.timebase;
  demand(ended >= started && integer(timebase?.numer) && timebase.numer > 0 && integer(timebase?.denom) && timebase.denom > 0, 'Native text clock unavailable');
  const clockMap = new Map();
  for (const clock of clocks) {
    keys(clock, ['schemaVersion', 'event', 'id', 'mach'], 'Native text clock schema differs');
    demand(clock.schemaVersion === 4 && clock.event === 'clock' && token(clock.id) && !clockMap.has(clock.id), 'Duplicate or invalid native text clock');
    ticks(clock.mach); clockMap.set(clock.id, clock);
  }
  demand(clockMap.size === 496, 'Native text session requires 494 substep ACKs and two window anchors');
  const nativeSessionId = textSessionNativeId(projection.sessionId);
  const anchor = (value, boundary) => {
    keys(value, ['ack', 'boundary', 'kind', 'nativeSessionId', 'sessionId', 'status'], 'Native text window anchor schema differs');
    demand(value.kind === 'text-native-session-anchor-1' && value.status === 'complete' && value.boundary === boundary && value.sessionId === projection.sessionId &&
      value.nativeSessionId === nativeSessionId && value.ack?.id === nativeSessionId + (boundary === 'begin' ? '-win-before' : '-win-after'), 'Native text window anchors differ');
    same(clockMap.get(value.ack.id), value.ack, 'Native text window ACK is not retained'); return ticks(value.ack.mach);
  };
  const windowBegan = anchor(projection.nativeSessionStart, 'begin'), windowEnded = anchor(projection.nativeSessionEnd, 'end');
  demand(windowBegan >= started && windowEnded >= windowBegan && windowEnded <= ended, 'Native text observation window anchors reversed');
  const dispatches = []; let previous = windowBegan;
  for (const action of projection.actions) for (const dispatch of action.dispatches) {
    const bracket = dispatch.nativeBracket, nativeActionId = dispatch.nativeActionId;
    demand(bracket?.kind === 'native-action-bracket-1' && bracket.actionId === nativeActionId && bracket.status === 'complete' && bracket.actionCompleted === true &&
      bracket.before?.id === nativeActionId + '-before' && bracket.after?.id === nativeActionId + '-after', 'Complete exact native text substep bracket required');
    same(clockMap.get(bracket.before.id), bracket.before, 'Native text before ACK is not retained');
    same(clockMap.get(bracket.after.id), bracket.after, 'Native text after ACK is not retained');
    const before = ticks(bracket.before.mach), after = ticks(bracket.after.mach);
    demand(before >= previous && after >= before && after <= windowEnded, 'Native text substep brackets overlap or reverse');
    previous = after; dispatches.push({before, after});
  }
  let priorDisplay = started;
  const usable = samples.filter(sample => {
    if (sample.sha256 === null || sample.sha256 === undefined) return false;
    demand(sha(sample.sha256) && sample.ownerPID === binding.browserPid && sample.windowNumber === binding.windowNumber, 'Native text sample ownership differs');
    same(sample.roi, oracle.roi, 'Native text sample ROI differs');
    const displayed = ticks(sample.displayTimeMach);
    demand(displayed >= priorDisplay && displayed <= ended, 'Native text sample display clock reversed'); priorDisplay = displayed; return true;
  });
  let offset = 0;
  const actions = projection.actions.map((action, index) => {
    const expected = oracle.actions[index], first = offset, last = offset + action.dispatches.length - 1;
    offset = last + 1;
    const a = dispatches[first].before, b = dispatches[last].after, next = dispatches[last + 1]?.before ?? windowEnded;
    const prior = dispatches[first - 1]?.after ?? windowBegan;
    const synthetic = ['preedit', 'composition-end'].includes(action.identity.family);
    const base = {identity: structuredClone(action.identity), subject: expected.subject, stateSha256: action.stateSha256,
      requirements: ['R04'], referenceCeilingMs: 100, firstDispatch: 0, lastDispatch: action.dispatches.length - 1,
      nativeBracket: {earliestMach: a.toString(), latestMach: b.toString(), nextInputMach: next.toString()},
      delivery: synthetic ? 'synthetic-app-handling' : 'playwright-automation', physicalInput: false,
      status: 'INCONCLUSIVE', firstMeaningfulPaintUpperBoundMs: null, firstMeaningfulPaintExactMs: null, firstMeaningfulPaintLowerBoundMs: null,
      qualification: false};
    if (expected.kind === 'unavailable') return {...base, reason: expected.reason};
    if (expected.before.sha256 === expected.after.sha256) return {...base, reason: 'oracle-has-no-distinguishable-pixel-change'};
    const baseline = usable.filter(sample => ticks(sample.displayTimeMach) <= a).at(-1);
    if (!baseline || baseline.sha256 !== expected.before.sha256) return {...base, reason: 'exact-before-baseline-not-observed'};
    if (ticks(baseline.displayTimeMach) < prior) return {...base, reason: 'baseline-predates-previous-action-completion'};
    // Earlier identical text/selection/presentation states are legitimate.
    // Only this action's latest baseline interval belongs to its causality.
    if (usable.some(sample => ticks(sample.displayTimeMach) >= ticks(baseline.displayTimeMach) && ticks(sample.displayTimeMach) <= a && sample.sha256 === expected.after.sha256))
      return {...base, reason: 'target-pixels-preexisted-this-input'};
    const matched = usable.find(sample => ticks(sample.displayTimeMach) >= b &&
      (last + 1 < dispatches.length ? ticks(sample.displayTimeMach) < next : ticks(sample.displayTimeMach) <= next) && sample.sha256 === expected.after.sha256);
    if (!matched) return {...base, reason: 'target-pixels-not-observed-before-next-action'};
    // The begin ACK precedes the original browser window. This conservative
    // native bound needs no browser-to-native clock conversion.
    if ((ticks(matched.displayTimeMach) - windowBegan) * BigInt(timebase.numer) > 60000n * BigInt(timebase.denom) * 1_000_000n)
      return {...base, reason: 'target-pixels-outside-conservative-original-window'};
    const numerator = (ticks(matched.displayTimeMach) - a) * BigInt(timebase.numer), denominator = BigInt(timebase.denom) * 1_000_000n;
    const microseconds = (numerator * 1000n + denominator - 1n) / denominator;
    demand(microseconds <= BigInt(Number.MAX_SAFE_INTEGER), 'Native text upper bound exceeds exact arithmetic');
    const upperMs = Number(microseconds) / 1000;
    return {...base, status: 'OBSERVED', observedDisplayTimeMach: matched.displayTimeMach, firstMeaningfulPaintUpperBoundMs: upperMs,
      ceilingAssessment: upperMs <= 100 ? 'upper-bound-within-reference-ceiling' : 'unavailable-earliest-frame-not-proven'};
  });
  const observed = actions.filter(action => action.status === 'OBSERVED').length;
  return freeze({kind: 'text-action-windowserver-pixel-join-1', schemaVersion: 1, profile: TEXT_INPUT_PROFILE, sessionId: projection.sessionId,
    captureSchemaVersion: 4, captureSha256: manifestSha256, oracleSha256: options.oracleSha256, actions,
    requiredActions: 106, requiredSubsteps: 247, requiredNativeClocks: 496, observedAcknowledgements: observed,
    status: observed === 106 ? 'OBSERVED' : 'INCONCLUSIVE', qualification: false,
    automation: {driver: 'playwright', physicalInput: false, compositionDelivery: 'synthetic-app-handling'},
    nativeIME: {status: 'INCONCLUSIVE', reason: 'physical-os-ime-witness-not-supplied'},
    semanticReviewRequired: true, independentPixelFileAdmissionRequired: true, browserInputInvocationAdmissionRequired: true,
    collectorSourceAndInvocationAdmissionRequired: true, physicalScanout: 'unavailable', displaySlotCoverage: 'unavailable',
    firstPresentedFrameCoverage: 'unavailable', browserToNativeClockCorrelation: 'unavailable',
    layoutCompletion: 'not-established-by-R04-acknowledgement', applicationFrameWork: 'unavailable'});
}
