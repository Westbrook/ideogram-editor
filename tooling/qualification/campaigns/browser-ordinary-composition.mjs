import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join, sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {attemptIdentity, digest} from './common.mjs';
import {readPhaseSnapshot, readTextResourceSnapshot} from './browser-phase-snapshot.mjs';
import {replayTextResourceWindow} from './browser-text-resources.mjs';
import {deriveCompositionMeasurements} from './browser-composition-counters.mjs';

export const ORDINARY_COMPOSITION_OPERATIONS = Object.freeze(['portable.reopen', 'fast.workflow']);
export const ORDINARY_COMPOSITION_NAMES = Object.freeze(['R38DerivedSnapshotBytes', 'R38IssueBytes', 'R38RawPageBytes',
  'R38MaterializedRawInspectionBytes', 'R38TextCaptionWorkspaceBytes', 'R38RawTruncationOrFalseCompletenessCount']);
export const ORDINARY_COMPOSITION_LIMITS = Object.freeze({raw: 8 * 1024 * 1024, binding: 128 * 1024, snapshots: 8, navigations: 2});
const proofs = new WeakMap(), SHA = /^sha256:[a-f0-9]{64}$/, BARE_SHA = /^[a-f0-9]{64}$/;
const demand = (condition, message) => {if (!condition) throw Error(message);};
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const finite = value => Number.isFinite(value) && value >= 0;
const encode = value => Buffer.from(JSON.stringify(value));
const decode = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const workspaceNames = new Set(['R38MaterializedRawInspectionBytes', 'R38TextCaptionWorkspaceBytes']);
const sourceRequirements = ['src/observability/composition-observations.ts', 'src/observability/allocations.ts',
  'src/observability/browser.ts', 'src/observability/diagnostic-memory.ts', 'src/composition/memory.ts', 'src/composition/core.ts',
  'src/ui/composition.ts', 'src/ui/request-edits.ts'];
const controlRequirements = ['browser.mjs', 'browser-driver.mjs', 'browser-queue.mjs', 'browser-phase-snapshot.mjs',
  'browser-ordinary-composition.mjs', 'browser-composition-counters.mjs', 'browser-text-resources.mjs', 'browser-measurements.mjs', 'worker.mjs', 'run.mjs', 'verification.mjs'];

async function snapshot(page) {
  return readPhaseSnapshot(page, owner => ({timeOrigin: performance.timeOrigin, observedMs: performance.now(), documentKind: location.href === 'about:blank' ? 'owned-blank-candidate' : 'other',
    composition: owner?.value?.compositionObservations ?? null}));
}
function snapshotIdentity(value) {
  demand(value && finite(value.timeOrigin) && finite(value.observedMs) && ['owned-blank-candidate', 'other'].includes(value.documentKind), 'Composition browser clock boundary is unavailable');
  if (value.composition) demand(typeof value.composition.instanceId === 'string' && finite(value.composition.atMs) && value.composition.atMs <= value.observedMs,
    'Composition producer snapshot identity is unavailable');
  return value.composition?.instanceId ?? null;
}

/** Reuse the central transition journal. This five-kind sum is a
 * conservative superset, not an R38-attributable peak or physical-memory claim.
 * Its excess cannot produce an R38 failure. No second ledger is introduced. */
function inspectCompositionReservations(raw, intervals, coverage, missing) {
  const result = [], covered = new Set(), windows = new Set();
  for (const resource of raw.resources) try {
    demand(resource && ['boundary', 'birth'].includes(resource.mode) && Number.isSafeInteger(resource.fromSnapshot) && Number.isSafeInteger(resource.toSnapshot), 'Composition resource interval is invalid');
    const interval = intervals.find(value => value.fromSnapshot === resource.fromSnapshot && value.toSnapshot === resource.toSnapshot && value.start === resource.mode);
    demand(interval && finite(resource.startedMs) && finite(resource.beginEndedMs) && finite(resource.endStartedMs) && finite(resource.endAcknowledgedMs) && finite(resource.endedMs) &&
      resource.startedMs >= raw.startedMs && resource.endedMs <= raw.endedMs && resource.startedMs <= resource.beginEndedMs && resource.beginEndedMs <= resource.endStartedMs &&
      resource.endStartedMs <= resource.endAcknowledgedMs && resource.endAcknowledgedMs <= resource.endedMs, 'Composition resource interval differs from its original browser realm');
    const intervalKey = resource.fromSnapshot + ':' + resource.toSnapshot + ':' + resource.mode;
    demand(!covered.has(intervalKey), 'Composition reservation interval is duplicated');
    const window = resource.window, replay = replayTextResourceWindow(window);
    demand(window.clockOriginMs === interval.timeOrigin, 'Composition reservation clock differs from its browser realm');
    const windowKey = window.ledgerInstanceId + ':' + window.id + ':' + window.ordinal;
    demand(!windows.has(windowKey), 'Composition reservation window is reused');
    for (const [boundary, value, point] of [['begin', resource.begin, window.initial], ['end', resource.end, window.final]]) {
      same(Object.keys(value ?? {}).sort(), ['kind', 'schemaVersion', 'ledgerInstanceId', 'id', 'ordinal', 'boundary', 'atMs', 'clockOriginMs', 'ledgerSequence', 'textSequence', 'sealed'].sort(), 'Composition reservation acknowledgment fields differ');
      demand(value.kind === 'text-resource-window-ack-1' && value.schemaVersion === 1 && value.boundary === boundary && value.sealed === (boundary === 'end') &&
        value.ledgerInstanceId === window.ledgerInstanceId && value.id === window.id && value.ordinal === window.ordinal && value.clockOriginMs === window.clockOriginMs &&
        value.atMs === point.atMs && value.ledgerSequence === point.ledgerSequence && value.textSequence === point.textSequence, 'Composition reservation acknowledgment differs');
    }
    const first = raw.snapshots[resource.fromSnapshot], last = raw.snapshots[resource.toSnapshot];
    demand(finite(raw.actionStartedMs) && finite(raw.actionEndedMs) && raw.actionStartedMs >= raw.startedMs && raw.actionEndedMs >= raw.actionStartedMs && raw.actionEndedMs <= raw.endedMs &&
      resource.startedMs >= first.endedMs && resource.beginEndedMs <= last.startedMs && resource.endStartedMs >= last.endedMs, 'Composition reservation runner brackets differ');
    const followingNavigation = raw.navigations.find(value => value.before === resource.toSnapshot);
    demand(followingNavigation ? resource.endedMs <= followingNavigation.startedMs : resource.endStartedMs >= raw.actionEndedMs, 'Composition reservation closure differs from original operation ordering');
    demand(window.final.atMs >= last.value.observedMs && (resource.mode === 'birth' ? window.id === 'startup-' + window.ledgerInstanceId && window.initial.atMs <= first.value.observedMs :
      resource.fromSnapshot === 0 && resource.beginEndedMs <= raw.actionStartedMs && window.id.startsWith('r38-' + raw.nonce + '-') &&
      window.initial.atMs >= first.value.observedMs && window.initial.atMs <= last.value.observedMs), 'Composition reservation boundaries differ');
    const indexes = ['control', 'prompt', 'staging', 'scratch', 'copy'].map(kind => window.cpuKinds.indexOf(kind));
    demand(indexes.every(index => index >= 0), 'Composition reservation kinds unavailable');
    const points = replay.points.map(point => ({sequence: point.sequence, bytes: indexes.reduce((sum, index) => sum + point.cpu[index], 0)}));
    let peak = points[0]; for (const point of points) if (point.bytes > peak.bytes) peak = point;
    demand(Number.isSafeInteger(peak.bytes) && peak.bytes >= 0, 'Composition reservation sum is invalid');
    if (replay.complete && interval.evidence.complete) {
      const compositionPoints = raw.snapshots.slice(resource.fromSnapshot, resource.toSnapshot + 1).flatMap(item => [item.value.composition, ...item.value.composition.records]);
      // Equal timestamps may straddle a boundary under reduced timer precision.
      // Only strictly interior observations establish this contradiction.
      demand(compositionPoints.filter(point => point.atMs > window.initial.atMs && point.atMs < window.final.atMs).every(point => point.promptOwnedBytes + point.compositionControlOwnedBytes <= peak.bytes),
        'Composition selected payload observations exceed the central reservation superset');
    }
    covered.add(intervalKey); windows.add(windowKey);
    const transitionCoverageComplete = replay.complete && coverage && !raw.failed;
    if (!transitionCoverageComplete) missing.push('Composition central reservations retain only an incomplete operation transition range');
    result.push({fromSnapshot: resource.fromSnapshot, toSnapshot: resource.toSnapshot, ledgerInstanceId: window.ledgerInstanceId, kinds: ['control', 'prompt', 'staging', 'scratch', 'copy'],
      observedSupersetPeakBytes: peak.bytes, peakSequence: peak.sequence, transitionCoverageComplete,
      bound: transitionCoverageComplete ? 'conservative-superset-upper-bound' : 'retained-transition-lower-bound',
      r38CoverageComplete: false, physicalMemoryComplete: false, ceilingAssessment: 'unavailable',
      scope: 'Simultaneous conservative central reservations; includes unrelated editor/control/diagnostic owners, excludes physical JS/native/DOM overhead. Excess is not an R38 breach.'});
  } catch {missing.push('Composition central reservation replay is incomplete');}
  if (covered.size !== intervals.length || !covered.size) missing.push('Complete central reservation observations for every original Composition realm are unavailable');
  return result;
}

/** Replay the actual per-realm intervals. Navigation never subtracts clocks or
 * fabricates a zero baseline: a fresh realm uses its retained producer birth.
 * These are producer sizes/reservations, not renderer heap/RSS/physical memory. */
export function inspectOrdinaryCompositionRaw(raw, binding) {
  demand(binding?.kind === 'ordinary-composition-binding-1' && ORDINARY_COMPOSITION_OPERATIONS.includes(binding.operation), 'Composition binding is invalid');
  demand(raw?.kind === 'ordinary-composition-raw-1' && raw.nonce === binding.nonce && raw.clock === 'runner-monotonic' &&
    finite(raw.startedMs) && finite(raw.endedMs) && raw.endedMs >= raw.startedMs && typeof raw.actionCompleted === 'boolean' &&
    typeof raw.failed === 'boolean' && Array.isArray(raw.missing) && raw.missing.every(value => typeof value === 'string') && raw.missing.length <= 16 &&
    Array.isArray(raw.snapshots) && raw.snapshots.length <= ORDINARY_COMPOSITION_LIMITS.snapshots &&
    Array.isArray(raw.navigations) && raw.navigations.length <= ORDINARY_COMPOSITION_LIMITS.navigations && Array.isArray(raw.resources) && raw.resources.length <= 3 &&
    (raw.resourceMissing === undefined || Array.isArray(raw.resourceMissing) && raw.resourceMissing.length <= 16 && raw.resourceMissing.every(value => typeof value === 'string')), 'Composition observation envelope is invalid');
  same(raw.binding, binding.attempt, 'Composition raw attempt differs');
  const required = binding.required;
  demand(Array.isArray(required) && new Set(required).size === required.length && required.every(name => ORDINARY_COMPOSITION_NAMES.includes(name)), 'Composition registry selection is invalid');
  const missing = [...raw.missing], failures = [], intervals = [], logicalReservations = [];
  if (!raw.actionCompleted || raw.failed) missing.push('Original composition operation did not complete successfully');
  let coverage = raw.actionCompleted && !raw.failed && missing.length === 0;
  try {
    demand(raw.snapshots.length >= 2, 'Original composition operation boundary snapshots are missing');
    const samples = raw.snapshots;
    for (const item of samples) {
      demand(finite(item.startedMs) && finite(item.endedMs) && item.startedMs >= raw.startedMs && item.endedMs >= item.startedMs && item.endedMs <= raw.endedMs,
        'Composition snapshot is outside the original runner operation');
      snapshotIdentity(item.value);
    }
    for (let index = 1; index < samples.length; index++) demand(samples[index].startedMs >= samples[index - 1].endedMs, 'Composition snapshots overlap or move backwards');
    let segmentStart = 0, start = 'boundary';
    const seen = new Set();
    const append = (end, allowEmpty = false) => {
      demand(end >= segmentStart, 'Composition realm interval is reversed');
      const selected = samples.slice(segmentStart, end + 1).map(value => value.value), first = selected[0];
      const instance = snapshotIdentity(first);
      demand(selected.every(value => value.timeOrigin === first.timeOrigin && snapshotIdentity(value) === instance), 'Unobserved composition realm transition');
      for (let index = 1; index < selected.length; index++) demand(selected[index].observedMs >= selected[index - 1].observedMs, 'Composition browser clock moved backwards');
      if (!instance) {demand(allowEmpty && selected.every(value => value.composition === null && value.documentKind === 'owned-blank-candidate'), 'Composition producer is missing inside the operation'); return;}
      demand(!seen.has(instance), 'Composition producer instance was reused across realms'); seen.add(instance);
      const result = deriveCompositionMeasurements(selected.map(value => value.composition), {required, failed: raw.failed || !raw.actionCompleted, start});
      if (!result.evidence.complete) coverage = false;
      intervals.push({timeOrigin: first.timeOrigin, instanceId: instance, start, fromSnapshot: segmentStart, toSnapshot: end, ...result});
    };
    for (const [index, navigation] of raw.navigations.entries()) {
      demand(Number.isSafeInteger(navigation.before) && Number.isSafeInteger(navigation.after) && navigation.before >= segmentStart &&
        navigation.after === navigation.before + 1 && navigation.after < samples.length && navigation.completed === true &&
        finite(navigation.startedMs) && finite(navigation.endedMs) && navigation.startedMs >= samples[navigation.before].endedMs &&
        navigation.endedMs <= samples[navigation.after].startedMs && navigation.endedMs >= navigation.startedMs, 'Original navigation boundary is incomplete');
      append(navigation.before, binding.operation === 'portable.reopen' && index === 0);
      const before = samples[navigation.before].value, after = samples[navigation.after].value;
      if (snapshotIdentity(before)) {coverage = false; missing.push('Prior application realm terminal resource coverage is unavailable across navigation');}
      demand(after.timeOrigin !== before.timeOrigin && snapshotIdentity(after) && snapshotIdentity(after) !== snapshotIdentity(before), 'Navigation did not produce its own fresh realm');
      segmentStart = navigation.after; start = 'birth';
    }
    if (binding.operation === 'portable.reopen') demand(raw.navigations.length === 1, 'Portable reopen requires its exact original navigation');
    append(samples.length - 1);
  } catch (error) {coverage = false; missing.push(String(error.message));}
  missing.push(...(raw.resourceMissing ?? []));
  const reservationObservations = inspectCompositionReservations(raw, intervals, coverage, missing);
  const measurements = [];
  for (const name of required) {
    const observed = intervals.flatMap(interval => interval.measurements.filter(row => row.name === name));
    if (!observed.length) {missing.push(name + ': operation was not observed'); continue;}
    const complete = coverage && intervals.every(interval => interval.evidence.complete) && observed.every(row => row.complete) &&
      (name !== 'R38RawTruncationOrFalseCompletenessCount' || intervals.every(interval => !interval.evidence.rawInspections || interval.measurements.some(row => row.name === name && row.complete)));
    const value = name.endsWith('Count') ? observed.reduce((sum, row) => sum + row.value, 0) : Math.max(...observed.map(row => row.value));
    demand(Number.isSafeInteger(value) && value >= 0, 'Composition aggregate is invalid');
    const row = {name, value, unit: name.endsWith('Count') ? 'violations' : 'bytes',
      method: name.endsWith('Count') ? 'Independently replayed retained-source page extents and parse-state claims across each actually observed browser realm' :
        'Maximum of actual producer byte observations across each separately replayed browser realm', complete};
    if (workspaceNames.has(name)) {
      // The recorded union includes the three explicit Composition control
      // owners, but omits shared transport/control and browser/native overhead.
      // Exact selected reservations remain outside resident-workspace claims.
      logicalReservations.push({...row, complete: false, scope: name === 'R38TextCaptionWorkspaceBytes' ?
        'prompt-and-selected-composition-control-logical-reservations-only' : 'prompt-kind-raw-inspection-logical-reservations-only'});
      missing.push(name + ': complete resident Composition allocation coverage is unavailable');
    } else if (complete) measurements.push(row);
    else missing.push(name + ': original operation producer coverage is incomplete');
    if (name === 'R38RawTruncationOrFalseCompletenessCount' && value > 0) failures.push('Observed retained-source page or parse completeness contradiction');
  }
  return {kind: 'ordinary-composition-analysis-1', measurements, logicalReservations, reservationObservations, intervals, failures: [...new Set(failures)], missing: [...new Set(missing)],
    qualification: false, physicalMemoryComplete: false, originalRawHashVerification: false,
    scope: 'Actual Composition producer values and identity-bound page/parse checks; raw byte integrity, other allocation classes and JS/native/DOM overhead remain separate'};
}

function measurementRows(analysis, artifact) {
  return analysis.measurements.map(row => ({...row, evidence: [{kind: 'ordinary-composition-retained-observation-1', artifact}]}));
}
export function ordinaryCompositionMeasurement({cell, sample, rule, proof}) {
  const value = proof && proofs.get(proof);
  if (!value || value.binding.operation !== cell?.operation || value.binding.attempt.cellId !== cell?.id || value.binding.attempt.cache !== sample?.cache ||
    value.binding.attempt.ordinal !== sample?.ordinal || value.binding.attempt.prime !== Boolean(sample?.prime)) return {reason: 'Current owned ordinary Composition proof is unavailable'};
  const row = value.measurements.find(row => row.name === rule?.name);
  if (!row || rule.budgetId !== 'R38' || rule.unit !== row.unit || row.complete !== true) return {reason: 'Exact complete Composition registry row was not established by the original operation'};
  return {measurement: structuredClone(row)};
}
export function readOrdinaryCompositionProof(proof) {
  const value = proof && proofs.get(proof); return value ? {observation: structuredClone(value.observation)} : null;
}

/** Passive observer for exactly the original operation and its real navigations.
 * No additional product gesture, parse, page read, state mutation, or retry. */
export function createOrdinaryCompositionObserver({page, cell, sample, serial, fixture, runtime, environment, processIdentity, output, signal, journal}) {
  demand(ORDINARY_COMPOSITION_OPERATIONS.includes(cell?.operation), 'Ordinary Composition cell required');
  const nonce = randomBytes(16).toString('hex'), prefix = 'ordinary-composition-' + nonce;
  const binding = {kind: 'ordinary-composition-binding-1', nonce, operation: cell.operation,
    attempt: {cellId: cell.id, id: attemptIdentity(cell, sample.cache, sample.ordinal, sample.prime), cache: sample.cache, ordinal: sample.ordinal, prime: Boolean(sample.prime), serial},
    required: (cell.requiredMeasurements ?? []).filter(rule => rule.budgetId === 'R38').map(rule => rule.name),
    fixtureSeal: fixture.seal, documentId: fixture.documentId ?? null, environment, processIdentity, runtime};
  const raw = {kind: 'ordinary-composition-raw-1', nonce, binding: binding.attempt, clock: 'runner-monotonic', startedMs: performance.now(), endedMs: null,
    actionStartedMs: null, actionEndedMs: null, actionCompleted: false, failed: false, snapshots: [], navigations: [], resources: [], resourceMissing: [], missing: []};
  let observing = false, observed = false, navigating = false, finished = false, resource = null;
  const capture = async () => {
    demand(raw.snapshots.length < ORDINARY_COMPOSITION_LIMITS.snapshots, 'Composition snapshot bound');
    const startedMs = performance.now(), value = await snapshot(page), endedMs = performance.now();
    raw.snapshots.push({startedMs, endedMs, value}); return raw.snapshots.length - 1;
  };
  const captureSafely = async () => {try {return await capture();} catch {raw.missing.push('Composition diagnostic snapshot unavailable'); return null;}};
  const beginResource = async (fromSnapshot, mode = 'boundary') => {
    if (fromSnapshot === null || !raw.snapshots[fromSnapshot].value.composition) return;
    try {
      const startedMs = performance.now(), id = 'r38-' + nonce + '-' + raw.resources.length;
      const begin = mode === 'birth' ? await page.evaluate(() => globalThis.__IDEOGRAM_PHASES__?.textResourceStartupIdentity?.()?.begin ?? null) :
        await page.evaluate(id => globalThis.__IDEOGRAM_PHASES__?.beginTextResourceObservationWindow?.(id) ?? null, id);
      demand(begin, 'Composition central resource window unavailable');
      resource = {mode, fromSnapshot, startedMs, beginEndedMs: performance.now(), begin};
    } catch {raw.resourceMissing.push('Composition central reservation start unavailable');}
  };
  const endResource = async toSnapshot => {
    if (!resource) return;
    const owner = resource; resource = null;
    try {
      const endStartedMs = performance.now();
      const end = owner.mode === 'birth' ? (await page.evaluate(() => globalThis.__IDEOGRAM_PHASES__?.sealTextResourceStartupWindow?.() ?? null))?.end :
        await page.evaluate(id => globalThis.__IDEOGRAM_PHASES__?.endTextResourceObservationWindow?.(id) ?? null, owner.begin.id);
      const endAcknowledgedMs = performance.now(), window = await readTextResourceSnapshot(page);
      demand(end && window && toSnapshot !== null, 'Composition central reservation end unavailable');
      raw.resources.push({...owner, toSnapshot, endStartedMs, endAcknowledgedMs, end, window, endedMs: performance.now()});
    } catch {raw.resourceMissing.push('Composition central reservation closure unavailable');}
  };
  const retain = async (name, value, maximum) => {
    const bytes = encode(value); demand(bytes.length <= maximum, 'Composition retained artifact bound');
    const path = prefix + '-' + name + '.json'; await writeFile(join(output, path), bytes, {mode: 0o600, flag: 'wx'});
    return {path, bytes: bytes.length, sha256: digest(bytes)};
  };
  return Object.freeze({
    async observe(action) {
      demand(!observing && !observed && !finished && typeof action === 'function', 'Composition original operation may be observed once');
      observing = true; observed = true;
      const first = await captureSafely(); await beginResource(first);
      try {signal?.throwIfAborted(); raw.actionStartedMs = performance.now(); const value = await action(); raw.actionCompleted = true; return value;}
      catch (error) {raw.failed = true; throw error;}
      finally {raw.actionEndedMs = performance.now(); const last = await captureSafely(); await endResource(last); observing = false;}
    },
    async navigation(action) {
      demand(observing && !navigating && !finished && raw.navigations.length < ORDINARY_COMPOSITION_LIMITS.navigations && typeof action === 'function', 'Composition navigation must belong to the original operation');
      navigating = true;
      // This closes before the actual navigation. Later handlers, microtasks
      // and native realm teardown have no acknowledged terminal snapshot;
      // even a pagehide callback would not prove that those owners settled.
      const before = await captureSafely(); await endResource(before);
      const entry = {before, after: null, startedMs: performance.now(), endedMs: null, completed: false}; raw.navigations.push(entry);
      try {signal?.throwIfAborted(); const value = await action(); entry.completed = true; return value;}
      finally {entry.endedMs = performance.now(); entry.after = await captureSafely(); await beginResource(entry.after, 'birth'); navigating = false;}
    },
    async finish({failed = false} = {}) {
      demand(!observing && !navigating && !finished, 'Composition observer did not settle'); finished = true;
      raw.failed ||= failed; raw.endedMs = performance.now();
      const bindingArtifact = await retain('binding', binding, ORDINARY_COMPOSITION_LIMITS.binding), artifact = await retain('raw', raw, ORDINARY_COMPOSITION_LIMITS.raw);
      const analysis = inspectOrdinaryCompositionRaw(raw, binding);
      const observation = {kind: 'ordinary-composition-observation-1', nonce, binding: bindingArtifact, raw: artifact, analysis,
        qualification: false, physicalMemoryComplete: false};
      const measurements = measurementRows(analysis, {...artifact, path: join(output, artifact.path)}), proof = Object.freeze({});
      proofs.set(proof, {binding, observation, analysis, measurements});
      await journal?.({event: 'ordinary-composition-observed', cellId: cell.id, nonce, binding: bindingArtifact, raw: artifact});
      return {proof, observation};
    },
  });
}

/** Exact byte replay is mandatory before any serialized ordinary-composition metric
 * can enter a campaign summary. This issuer grants no physical authority. */
export async function verifyOrdinaryCompositionEvidence({attempt, cell, serial, fixture, environment, workerProcessIdentity, groupOutput, retainedFiles, readRetained, controlFiles, sourceFiles, sourceRoot, browserCache, tools, developerState, developerStateIdentity, journalEvents}) {
  if (!ORDINARY_COMPOSITION_OPERATIONS.includes(cell?.operation)) return null;
  const observation = attempt.result?.observations?.ordinaryComposition;
  if (!observation) {demand(!(attempt.result?.measurements ?? []).some(row => ORDINARY_COMPOSITION_NAMES.includes(row.name)), 'Ordinary Composition measurements lack replay evidence'); return null;}
  demand(observation.kind === 'ordinary-composition-observation-1' && observation.qualification === false && observation.physicalMemoryComplete === false && /^[a-f0-9]{32}$/.test(observation.nonce ?? ''), 'Ordinary Composition scope or nonce differs');
  const seals = new Map(retainedFiles.map(file => [file.path, file])), prefix = 'ordinary-composition-' + observation.nonce;
  const read = async (identity, name, maximum) => {
    demand(identity?.path === prefix + '-' + name + '.json' && Number.isSafeInteger(identity.bytes) && identity.bytes > 0 && identity.bytes <= maximum && SHA.test(identity.sha256), 'Ordinary Composition retained member differs');
    const seal = seals.get(identity.path); demand(seal?.bytes === identity.bytes && seal.sha256 === identity.sha256, 'Ordinary Composition outer seal differs');
    const bytes = await readRetained(identity.path, {maximum}); demand(bytes.length === identity.bytes && digest(bytes) === identity.sha256, 'Ordinary Composition retained bytes differ'); return decode(bytes);
  };
  const binding = await read(observation.binding, 'binding', ORDINARY_COMPOSITION_LIMITS.binding), raw = await read(observation.raw, 'raw', ORDINARY_COMPOSITION_LIMITS.raw);
  demand(binding.kind === 'ordinary-composition-binding-1' && binding.nonce === observation.nonce && binding.operation === cell.operation, 'Ordinary Composition binding differs');
  same(binding.attempt, {cellId: cell.id, id: attempt.id, cache: attempt.cache, ordinal: attempt.ordinal, prime: attempt.prime, serial}, 'Ordinary Composition scheduled attempt differs');
  same(binding.fixtureSeal, fixture.seal, 'Ordinary Composition fixture differs'); same(binding.environment, environment, 'Ordinary Composition source/build identity differs'); same(binding.processIdentity, workerProcessIdentity, 'Ordinary Composition worker differs');
  same(binding.documentId, fixture.documentId ?? null, 'Ordinary Composition sealed document differs');
  same(binding.required, (cell.requiredMeasurements ?? []).filter(rule => rule.budgetId === 'R38').map(rule => rule.name), 'Ordinary Composition registry differs');
  demand(workerProcessIdentity?.node === 'v26.10.0' && workerProcessIdentity.pid > 1 && finite(attempt.startMs) && finite(attempt.endMs) && raw.startedMs >= attempt.startMs && raw.endedMs <= attempt.endMs, 'Ordinary Composition worker clock window differs');
  demand(['sourceDigest', 'controlDigest'].every(key => BARE_SHA.test(environment?.[key] ?? '')) && ['buildDigest', 'toolsDigest'].every(key => SHA.test(environment?.[key] ?? '')), 'Ordinary Composition executable bindings missing');
  for (const name of controlRequirements) demand(controlFiles?.some(file => file.path === 'tooling/qualification/campaigns/' + name && BARE_SHA.test(file.sha256)), 'Ordinary Composition control source closure missing: ' + name);
  for (const name of sourceRequirements) demand(sourceFiles?.some(file => file.path === name && BARE_SHA.test(file.sha256)), 'Ordinary Composition application source closure missing: ' + name);
  const runtime = decode(await readRetained('browser-runtime.json', {maximum: 1024 * 1024})); same(binding.runtime, runtime, 'Ordinary Composition actual browser differs'); same(runtime.fixtureSeal, fixture.seal, 'Ordinary Composition browser fixture differs');
  demand(runtime.ownedLaunch?.context?.createdBy === 'browser.newContext' && runtime.browserPid > 1 && runtime.backendPid > 1 && runtime.playwrightModule?.startsWith(join(sourceRoot, 'node_modules') + sep) && runtime.executable?.startsWith(browserCache + sep), 'Ordinary Composition owned browser path differs');
  const pins = tools?.browserPins?.browsers?.filter(pin => pin.name === runtime.engine);
  demand(pins?.length === 1 && pins[0].revision === runtime.revision && pins[0].browserVersion === runtime.version && SHA.test(runtime.executableIdentity?.sha256 ?? ''), 'Ordinary Composition browser version pin differs');
  demand(developerState?.kind === 'developer-runtime-state-1' && digest(JSON.stringify(developerState.state, null, 2) + '\n').slice(7) === developerState.sha256?.replace(/^sha256:/, '') && SHA.test(developerStateIdentity?.sha256 ?? ''), 'Ordinary Composition prepared executable evidence is missing');
  const state = developerState.state, workspace = state.h?.source === sourceRoot ? state.h : state.p;
  const completed = workspace === state.h ? workspace?.completed === true : workspace?.completed?.includes('production-build') && workspace.completed.includes('browser-cache');
  demand(completed && !workspace.failure && !workspace.active && state.productRepo === sourceRoot && workspace.source === sourceRoot && state.sourceDigest === environment.sourceDigest, 'Ordinary Composition prepared source differs');
  const selectedCache = state.playwrightBrowsersPath ?? workspace.browserCache, prepared = workspace.browserIdentity?.engines?.filter(value => value.engine === runtime.engine);
  demand(selectedCache === browserCache && prepared?.length === 1 && prepared[0].executable === runtime.executable && prepared[0].version === runtime.version && prepared[0].revision === runtime.revision &&
    prepared[0].bytes === runtime.executableIdentity.bytes && prepared[0].sha256?.replace(/^sha256:/, '') === runtime.executableIdentity.sha256.slice(7), 'Ordinary Composition browser immutable preparation differs');
  for (const kind of ['browser', 'backend']) {
    const pid = runtime[kind + 'Pid'], entries = retainedFiles.filter(file => new RegExp('^owned-process-' + pid + '-[a-f0-9-]{36}\\.json$').test(file.path));
    demand(entries.length === 1, 'Ordinary Composition process ownership missing'); const record = decode(await readRetained(entries[0].path, {maximum: 65536})), process = record.processes?.[0];
    demand(record.ownerPid === workerProcessIdentity.pid && record.kind === 'perf-owned-processes-1' && record.processes?.length === 1 && process.kind === kind && process.pid === pid && process.pgid > 1, 'Ordinary Composition process ownership differs');
    if (kind === 'browser') demand(runtime.ownedLaunch.process?.registration?.path === join(groupOutput, entries[0].path) && runtime.ownedLaunch.process?.startedAtIdentity === process.startedAtIdentity && process.executable === runtime.executable, 'Ordinary Composition browser launch differs');
  }
  const events = journalEvents.filter(event => event.event === 'ordinary-composition-observed' && event.nonce === observation.nonce && event.cellId === cell.id);
  demand(events.length === 1 && events[0].monotonicMs >= raw.endedMs && events[0].monotonicMs <= attempt.endMs, 'Ordinary Composition journal closure differs'); same(events[0].binding, observation.binding, 'Ordinary Composition journal binding differs'); same(events[0].raw, observation.raw, 'Ordinary Composition journal raw differs');
  const analysis = inspectOrdinaryCompositionRaw(raw, binding); same(analysis, observation.analysis, 'Ordinary Composition analysis differs');
  demand(!analysis.failures.length || attempt.status === 'FAIL' && attempt.result.status === 'FAIL', 'Ordinary Composition observed contradiction was not reported as failure');
  demand(!analysis.missing.length || attempt.status !== 'PASS' && attempt.result.status !== 'PASS', 'Ordinary Composition missing observations were reported complete');
  const measurements = measurementRows(analysis, {...observation.raw, path: join(groupOutput, observation.raw.path)});
  same((attempt.result.measurements ?? []).filter(row => ORDINARY_COMPOSITION_NAMES.includes(row.name)), measurements.filter(row => (cell.requiredMeasurements ?? []).some(rule => rule.name === row.name)), 'Ordinary Composition published measurements differ');
  const proof = Object.freeze({}); proofs.set(proof, {binding, observation, analysis, measurements}); return proof;
}
