import {createOrdinaryCompositionObserver, ORDINARY_COMPOSITION_OPERATIONS} from './browser-ordinary-composition.mjs';
import {readVerifiedNavigationBounds} from './windowserver-navigation-verification.mjs';
import {createOrdinaryTextObserver, readOrdinaryTextProof, ORDINARY_TEXT_OPERATIONS} from './browser-ordinary-text.mjs';
import {createTextResourceObserver, TEXT_RESOURCE_OPERATIONS} from './browser-text-resources.mjs';
import { readPhaseSnapshot, releasePendingPhaseSnapshots } from './browser-phase-snapshot.mjs';
import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createBrowserTrace } from './browser-trace.mjs';
import { installBrowserVitals } from './browser-vitals.mjs';
import { installCanonicalWebVitals } from './browser-canonical-vitals.mjs';
import { createBrowserResourceSampler } from './browser-resources.mjs';
import { captureRendererOwnershipProof } from './renderer-ownership.mjs';
import { createBrowserWAObservation } from './browser-wa-observation.mjs';
import { createCachePreservingEgress } from './browser-network.mjs';
import { extractBrowserMeasurements } from './browser-measurements.mjs';
import { createBrowserReadinessController, installRasterCapabilities } from './browser-readiness.mjs';
import { acceptedCommand, browserOperationCoverage, openDocument, publicRead, ready, runBrowserAction, stroke, prepareBrowserGestures, resolveBrowserCandidate, selectVisibleImageLayer } from './browser-driver.mjs';
import { captureBrowserBaseline, resetBrowserCell } from './browser-reset.mjs';
import { genericRawFeedbackCohort } from './browser-generic-input.mjs';
import { attemptIdentity, intervalWait, monotonic, PrerequisiteError, sanitize, exclusiveJSON, fileIdentity } from './common.mjs';
import { byteAuditFeatureActions } from './byte-audits.mjs';

export { browserOperationCoverage };
const executeFile = promisify(execFile);
const backendOnly = new Set(['raster.composite', 'raster.decode', 'raster.encode', 'state.snapshot-read', 'state.replay', 'state.command-accept-dispatch', 'asset.persist', 'asset.cache-lookup', 'transfer.asset']);
const navigations = new Set(['navigation.ready', 'portable.reopen', 'startup.failure']);
const queueOperations = new Set(['fast.workflow', 'queue.fault', 'queue.healthy-polling']);
const vitalOperations = new Set(['navigation.ready', 'interaction.brush', 'text.interaction']);

/** Preserve the core result envelope: the supplemental proof is independently
 * replayed from the same retained raw artifact and never changes D11 metrics. */
export function splitFeatureBoundarySnapshot(snapshot) {
  const { featureBoundary, ...d11 } = snapshot;
  return { d11, evidence: featureBoundary ?? null };
}

/** This follows a retained startup snapshot on the same page and collector.
 * Only public Export controls are activated. No preview/export is prepared and
 * no product module or private method is invoked by the harness. */
export async function runExportFeatureAudit({ page, collector, boundary, startup, id, cache, workload, signal }) {
  if (workload !== 'W1') throw new PrerequisiteError('Positive Export byte audit is declared only for W1');
  if (boundary?.complete !== true || typeof boundary.featureId !== 'string') throw new PrerequisiteError('A unique complete private-event feature witness is required');
  if (startup?.scope !== 'startup' || typeof startup.artifact?.path !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(startup.artifact.sha256)) throw new PrerequisiteError('Export byte audit requires its separately retained startup artifact');
  const baselineReference = { artifactPath: startup.artifact.path, artifactSha256: startup.artifact.sha256 };
  let active = false, completed = false, d11 = null, evidence = null, failureState = { caughtFailure: false, productFailureSeen: false };
  const retainFailure = error => { failureState = retainBrowserActionFailure(failureState, error); };
  try {
    signal?.throwIfAborted();
    const trigger = page.getByRole('button', { name: 'Export image', exact: true });
    await trigger.waitFor({ state: 'visible' });
    assert(await trigger.isEnabled(), 'Public Export action must be enabled');
    await collector.begin({ id: id + '/export-first-use', cache, scope: 'lazy-feature', featureId: boundary.featureId,
      workload, featureBoundary: { featureId: boundary.featureId, phase: 'first-use' }, byteAudit: true });
    active = true;
    // No awaited setup belongs between the retained dispatch boundary and the
    // actual public click. This records an interval, not a physical timestamp.
    await trigger.click();
    for (const name of ['Export scope', 'Export format', 'Export dimensions']) {
      const control = page.getByRole('combobox', { name, exact: true });
      await control.waitFor({ state: 'visible' });
      assert(await control.isEnabled(), name + ' must be operable at the first-use boundary');
    }
    const prepare = page.getByRole('button', { name: 'Prepare export preview', exact: true });
    await prepare.waitFor({ state: 'visible' });
    assert(await prepare.isEnabled(), 'Public export preview control must be ready');
    signal?.throwIfAborted();
    completed = true;
  } catch (error) { retainFailure(error); }
  finally {
    if (active) try {
      const snapshot = await collector.snapshot(completed ? { publicAction: { kind: 'export', completed: true } } : {});
      ({ d11, evidence } = splitFeatureBoundarySnapshot(snapshot));
    } catch (error) { retainFailure(error); }
  }
  const missing = [...(d11?.missing ?? ['Separate Export first-use byte snapshot unavailable']),
    ...(evidence?.missing ?? ['Supplemental Export first-use proof unavailable'])];
  if (d11?.status !== 'PASS' && d11?.status !== 'FAIL' || evidence?.status !== 'PASS' && evidence?.status !== 'FAIL') missing.push('Separate Export first-use proof is incomplete');
  const outcome = browserActionOutcome({ ...failureState, d11Status: d11?.status, nativeEvidenceStatuses: [evidence?.status], missing, byteAudit: true });
  return { action: { kind: 'export', completed }, d11, evidence, baselineReference,
    status: outcome.status, timingSamplesReusable: false, missing, error: outcome.error, failureClassification: outcome.failureClassification };
}

/** Configured flags select raw collection only. Actual ownership comes from
 * this campaign's launch, process registration and retained runtime, which
 * offline replay must verify independently. */
export function genericRawFeedbackSelection(value, runtime, actualPid) {
  if (value === undefined) return null;
  assert(value && Object.keys(value).length === 1 && Object.hasOwn(value, 'ownership'), 'Unsupported raw feedback selection');
  const ownership = value.ownership;
  assert(ownership && Object.keys(ownership).sort().join(',') === 'admittedBy,browserInstanceId,isolated,kind,owned,sessionOwned,syntheticOnly' &&
    ownership.kind === 'owned-isolated-synthetic-browser-1' && ownership.admittedBy === 'root' && ownership.owned === true &&
    ownership.isolated === true && ownership.syntheticOnly === true && ownership.sessionOwned === true &&
    typeof ownership.browserInstanceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(ownership.browserInstanceId), 'Explicit raw feedback selection unavailable');
  assert(runtime?.engine === 'chromium' && runtime.headless === false && Number.isSafeInteger(actualPid) && runtime.browserPid === actualPid &&
    runtime.ownedLaunch?.process?.pid === actualPid && typeof runtime.ownedLaunch.process.startedAtIdentity === 'string' &&
    runtime.ownedLaunch.context.createdBy === 'browser.newContext' && runtime.ownedLaunch.context.freshAtLaunch === true &&
    runtime.ownedLaunch.process.executable === runtime.executable && runtime.ownedLaunch.process.registration?.path &&
    /^sha256:[a-f0-9]{64}$/.test(runtime.executableIdentity?.sha256 ?? '') && /^(?:sha256:)?[a-f0-9]{64}$/.test(runtime.fixtureSeal?.sha256 ?? ''),
  'Actual owned Chromium launch and fixture facts unavailable');
  return {ownership: structuredClone(ownership), selectionProvenance: 'configured-campaign-local-scope-not-ownership-proof',
    actualRuntime: structuredClone(runtime)};
}

export function genericRawFeedbackMissing(trace) {
  if (!trace?.rawFeedback) return ['raw-feedback-consumer-unavailable'];
  return Array.isArray(trace.rawFeedback.missing) ? [...trace.rawFeedback.missing] : ['raw-feedback-missing-inventory-unavailable'];
}

/** Stop the native interval before the first cached raw stop. A partial or
 * failed receipt still drains raw collection, without a completed declaration.
 * The outer campaign finally remains responsible for end/stop failures. */
export async function endGenericFeedbackSession({native, trace, rawFeedbackSelected, sessionId, observed, missing}) {
  const anchor = await native.end();
  if (rawFeedbackSelected) {
    let cohort;
    try {cohort = genericRawFeedbackCohort(observed, {sessionId});}
    catch {missing.push('raw-feedback-original-generic-cohort-incomplete');}
    try {await trace.stop(cohort ? {rawFeedbackCohort: cohort} : {});}
    catch {missing.push('raw-feedback-stop-unavailable');}
  }
  return anchor;
}

const textFeedbackKinds = Object.freeze({'insert-delete': 'insert-delete', preedit: 'preedit',
  'composition-end': 'composition-commit-cancel', caret: 'caret-selection', 'semantic-selection': 'semantic-list',
  'text-format': 'font-wrap-transform-guide', presentation: 'presentation-request'});
const feedbackHash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
function ownFailureData(value, key) {
  if (value === null || !['object', 'function'].includes(typeof value)) return undefined;
  try {const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;}
  catch {return undefined;}
}

/** An explicitly caught primitive/falsy rejection is still a product failure.
 * Diagnostic rendering reads data properties only, never thrown accessors. */
export function browserActionOutcome({failure, caughtFailure = false, productFailureSeen = false, resultStatus, d11Status, nativeEvidenceStatuses = [], missing = [], byteAudit = false}) {
  const failurePresent = caughtFailure || !!failure;
  let prerequisiteFailure = ownFailureData(failure, 'code') === 'CAMPAIGN_PREREQUISITE';
  try {prerequisiteFailure ||= failure instanceof PrerequisiteError;} catch {}
  const caughtProductFailure = productFailureSeen || failurePresent && !prerequisiteFailure;
  const productFailed = caughtProductFailure || String(resultStatus).toUpperCase() === 'FAIL';
  const status = productFailed || String(d11Status).toUpperCase() === 'FAIL' || nativeEvidenceStatuses.includes('FAIL') ? 'FAIL' :
    missing.length || prerequisiteFailure || !byteAudit && String(resultStatus).toUpperCase() === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'PASS';
  const text = key => {const value = ownFailureData(failure, key); return typeof value === 'string' ? value.slice(0, 1024) : null;};
  return {status, failurePresent, prerequisiteFailure, actionCompleted: !productFailureSeen && !failurePresent && String(resultStatus).toUpperCase() !== 'FAIL',
    failureClassification: {productFailureSeen: !!caughtProductFailure, firstFailureWasPrerequisite: failurePresent && prerequisiteFailure},
    error: failurePresent ? {name: text('name') ?? 'ThrownValue', code: text('code'), message: prerequisiteFailure ? text('message') ?? 'Campaign prerequisite unavailable' :
      'Browser action failed; retained structured evidence identifies the phase'} : null};
}

/** Preserve the first caught value for diagnostics, but never let an earlier
 * prerequisite hide a later product, cleanup, navigation or egress failure. */
export function retainBrowserActionFailure(state, failure) {
  const incoming = browserActionOutcome({failure, caughtFailure: true});
  return {failure: state?.caughtFailure === true ? state.failure : failure, caughtFailure: true,
    productFailureSeen: state?.productFailureSeen === true || !incoming.prerequisiteFailure};
}

/** Retain a campaign-local attempt and sealed text identities without corpus
 * strings. Source/process/fixture closure still requires independent replay. */
export async function textFeedbackInvocation({cell, sample, serial, sessionId, fixture, runtime, processIdentity, output, rawFeedbackSelection}) {
  const {buildTextInteractionPlan, inspectTextFixture} = await import('./browser-text.mjs');
  const workload = cell.workload ?? fixture?.workload;
  assert(cell.operation === 'text.interaction' && typeof cell.id === 'string' && cell.id.length > 0 && ['WXn', 'WXs'].includes(workload), 'Exact IText cell unavailable');
  assert(['cold', 'warm', 'single'].includes(sample.cache) && Number.isSafeInteger(sample.ordinal) && sample.ordinal >= 0 &&
    (sample.prime === undefined || typeof sample.prime === 'boolean') && Number.isSafeInteger(serial) && serial > 0 &&
    typeof sessionId === 'string' && sessionId.length > 0, 'Exact IText attempt unavailable');
  assert(processIdentity && processIdentity.pid === process.pid &&
    typeof processIdentity.startedAt === 'string' && Number.isFinite(Date.parse(processIdentity.startedAt)) &&
    processIdentity.node === process.version, 'Actual worker process identity unavailable');
  assert(/^(?:sha256:)?[a-f0-9]{64}$/.test(fixture?.seal?.sha256 ?? '') &&
    fixture.seal.sha256.replace(/^sha256:/, '') === runtime?.fixtureSeal?.sha256?.replace(/^sha256:/, ''), 'IText fixture launch binding unavailable');
  assert(inspectTextFixture(fixture, cell.operation, workload).length === 0, 'Exact sealed IText fixture unavailable');
  const sourcePlan = buildTextInteractionPlan(), text = fixture.text;
  // Common receipt sanitization reserves the generic name "key" for secrets.
  // Retain the keyboard intent under an explicit name and hash both exact
  // representations so source replay can reconstruct the transformation.
  const plan = sourcePlan.map(({key, ...row}) => key === undefined ? row : {...row, inputKey: key});
  return {invocation: {cellId: cell.id, operation: cell.operation, serial,
    sample: {cache: sample.cache, ordinal: sample.ordinal, prime: sample.prime ?? false},
    producerPath: join(output, 'browser-cell-' + serial + '.json'), tracePath: join(output, 'browser-trace-' + serial + '.json'),
    rawFeedback: rawFeedbackSelection ? {...structuredClone(rawFeedbackSelection), artifactPath: join(output, 'browser-feedback-' + serial + '.raw.json')} : null},
    textAttempt: {kind: 'text-campaign-attempt-1', workload, sessionId,
    attemptId: attemptIdentity(cell, sample.cache, sample.ordinal, sample.prime),
    processIdentity: structuredClone(processIdentity), fixtureSeal: structuredClone(fixture.seal),
    textFixture: {schema: text.schema, manifestHash: text.manifestHash,
      corpus: {sha256: text.corpus.sha256, bytes: Buffer.byteLength(text.corpus.text, 'utf8'), fragmentsHash: text.corpus.fragmentsHash,
        fragmentCount: text.corpus.fragments.length, scripts: [...text.corpus.scripts]},
      fonts: text.fonts.map(font => ({id: font.id, sha256: font.sha256, bytes: font.bytes, kind: font.kind,
        licenseSha256: font.licenseSha256 ?? null})),
      semanticItemIdsHash: feedbackHash(JSON.stringify(text.semanticItemIds)),
      activeLayerId: text.activeLayerId ?? null, activeLayerIndex: text.activeLayerIndex ?? null, fontSetPreseeded: text.fontSetPreseeded === true},
    actionPlan: {sha256: feedbackHash(JSON.stringify(plan)), sourcePlanSha256: feedbackHash(JSON.stringify(sourcePlan)), actions: plan, durationMs: 60_000, refreshHz: 60,
      observedExecution: false, physicalInput: false, compositionEvents: 'synthetic-app-handling'}}};
}

/** A complete action receipt supplies the declaration to the existing raw
 * parser. The selected nativeSource label points to independently retained
 * substep delivery evidence; it is not itself proof of trusted native input.
 * It proves neither an input/EventLatency join nor display slots. */
export function textRawFeedbackCohort({segment, actions, plan}) {
  assert(Array.isArray(plan) && plan.length === 106 && Array.isArray(actions) && actions.length === plan.length, 'Incomplete IText action sequence');
  assert(segment && Number.isFinite(segment.startMs) && segment.endMs === segment.startMs + 60_000 &&
    segment.requestedMs === 60_000 && Number.isFinite(segment.captureStoppedMs) && segment.captureStoppedMs >= segment.endMs &&
    segment.actualMs === segment.captureStoppedMs - segment.startMs && segment.actions === 106 && segment.reservedFeedbackMs === 600 &&
    Number.isFinite(segment.completedActionsAtMs) && segment.completedActionsAtMs >= 0 && segment.completedActionsAtMs <= 60_000,
  'Incomplete original IText observation window');
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index], expected = plan[index];
    assert(action && action.id === expected.id && action.kind === expected.kind && action.scheduledMs === expected.scheduledMs &&
      Object.hasOwn(textFeedbackKinds, action.kind) && action.outcome === 'completed' &&
      Number.isFinite(action.inputMs) && action.inputMs >= segment.startMs && Number.isFinite(action.readyMs) &&
      action.readyMs >= action.inputMs && action.readyMs <= segment.endMs &&
      action.nativeSource === 'explicit-per-substep-delivery',
    'IText action order, completion or input provenance changed');
  }
  return {profile: 'IText', durationMs: 60_000, refreshHz: 60,
    actions: actions.map(action => ({id: action.id, kind: textFeedbackKinds[action.kind]})),
    source: 'original-completed-action-receipt', observedExecution: false, qualification: false};
}

/** One collector follows the native anchors outside the original measured
 * window. The driver expects {value, bracket}; its actual frozen run value
 * remains authoritative, and primitive product rejections remain unchanged. */
export function createTextFeedbackServices({native, trace, rawFeedbackSelected, sessionId, plan, textAttempt, missing}) {
  let startPromise, endPromise;
  const unavailable = () => ({status: 'unavailable', qualification: false});
  const matches = request => request?.sessionId === sessionId;
  return {textInputSessionId: sessionId, ...(textAttempt ? {textAttempt: structuredClone(textAttempt)} : {}),
    textSessionStart(request) {
      if (!matches(request)) {missing.push('text-native-start-session-mismatch'); return Promise.resolve(unavailable());}
      return startPromise ??= (async () => {
        let anchor;
        try {anchor = await native.start(request);} catch {missing.push('text-native-start-unavailable');}
        if (rawFeedbackSelected && anchor?.status === 'complete') {
          try {const started = await trace.start(); if (started?.status === 'unavailable') missing.push('raw-feedback-start-unavailable');}
          catch {missing.push('raw-feedback-start-unavailable');}
        } else if (rawFeedbackSelected) missing.push('raw-feedback-native-start-unavailable');
        return anchor ?? unavailable();
      })();
    },
    async textInputHook(request) {
      let called = false, productPromise, productFailed = false, nativeEnvelope;
      const run = () => {
        if (called) {missing.push('text-native-duplicate-operation-attempt'); return productPromise;}
        called = true; productPromise = Promise.resolve().then(request.run).catch(error => {productFailed = true; throw error;});
        // A native observer may start this operation and finish its own work
        // before awaiting it. Observe rejection immediately without replacing
        // the original rejecting promise that the caller must receive.
        void productPromise.catch(() => {}); return productPromise;
      };
      try {nativeEnvelope = await native.hook({...request, run});} catch {if (!productFailed) missing.push('text-native-hook-failed');}
      if (!called) {missing.push('text-native-hook-omitted-operation'); run();}
      // Await the original promise outside the instrumentation catch so even a
      // falsy/primitive product rejection cannot be swallowed or reclassified.
      const value = await productPromise;
      // Preserve the passive native bracket envelope only if it refers to the
      // exact run value. The driver independently validates the bracket and
      // maps its frozen evidence back to the original product return value.
      try {
        const result = Object.getOwnPropertyDescriptor(nativeEnvelope, 'value'), bracket = Object.getOwnPropertyDescriptor(nativeEnvelope, 'bracket');
        if (result && Object.hasOwn(result, 'value') && Object.is(result.value, value) && bracket && Object.hasOwn(bracket, 'value')) return nativeEnvelope;
      } catch {}
      missing.push('text-native-hook-envelope-unavailable');
      return {value, bracket: null};
    },
    textSessionEnd(request) {
      if (!matches(request)) {missing.push('text-native-end-session-mismatch'); return Promise.resolve(unavailable());}
      return endPromise ??= (async () => {
        let anchor;
        try {anchor = await native.end(request);} catch {missing.push('text-native-end-unavailable');}
        if (rawFeedbackSelected) {
          let rawFeedbackCohort;
          try {rawFeedbackCohort = textRawFeedbackCohort({...request, plan});} catch {missing.push('raw-feedback-itext-completed-cohort-unavailable');}
          try {await trace.stop(rawFeedbackCohort ? {rawFeedbackCohort} : {});} catch {missing.push('raw-feedback-stop-unavailable');}
        }
        return anchor ?? unavailable();
      })();
    }};
}

async function boundedClose(work, timeoutMs = 5000) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned close deadline')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export function processTreeRows(text, roots) {
  const rows = text.trim().split('\n').filter(Boolean).map(line => {
    const [pid, ppid, rssKiB] = line.trim().split(/\s+/).map(Number);
    if (![pid, ppid, rssKiB].every(Number.isSafeInteger) || pid <= 0 || ppid < 0 || rssKiB < 0) throw Error('Invalid process resource row');
    return { pid, ppid, rssBytes: rssKiB * 1024 };
  });
  const included = new Set(roots.filter(Number.isSafeInteger));
  for (let changed = true; changed;) { changed = false; for (const row of rows) if (included.has(row.ppid) && !included.has(row.pid)) { included.add(row.pid); changed = true; } }
  return rows.filter(row => included.has(row.pid));
}

export function assertCell(cell) {
  if (!cell || typeof cell.operation !== 'string' || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(cell.operation)) throw Error('Explicit campaign operation required');
  const parameters = cell.parameters ?? cell.options ?? cell;
  if (parameters.fakeClock && parameters.fakeClock !== 'scheduler-history-only' || parameters.syntheticTime) throw Error('Browser wall-time cells cannot use synthetic time');
  return parameters;
}

/** Preserve observed action work even when the display trace cannot qualify.
 * Runner dispatch observations are labelled, never joined to browser clocks by
 * subtraction and never promoted to presented-frame timestamps. */
export function interactionSession(cell, sample, result, trace, visibility) {
  if (!['interaction.brush', 'text.interaction'].includes(cell.operation) || !result) return null;
  const observed = result.observations ?? result, text = cell.operation === 'text.interaction';
  const id = String(cell.id ?? cell.operation) + ':' + String(sample.cache ?? 'unknown') + ':' + String(sample.ordinal ?? 0);
  const segment = observed.segment;
  const actions = (observed.actions ?? []).map((action, index) => ({
    id: id + ':action-' + index,
    kind: text ? action.kind : action.kind === 'stroke' ? 'stroke' : 'discrete',
    ...(!text ? { family: action.kind, sourceActionIndex: action.index, receiptIdentityScope: 'campaign-local',
      inputClock: action.inputClock ?? 'browser-performance', native: action.native ?? null,
      discreteInput: action.discreteInput ?? null, semantic: action.semantic ?? null, validation: action.validation ?? null,
      ...(action.nativeState ? {nativeState: action.nativeState} : {}),
      ...(action.specimenId ? { specimenId: action.specimenId, selectedLayerId: action.selectedLayerId, plan: action.plan,
        productCompletion: action.productCompletion, completion: action.completion, dispatchObservations: action.dispatchObservations, dispatchClock: action.dispatchClock,
        ...(action.pointerDispatches ? {pointerDispatches: action.pointerDispatches} : {}) } : {}) } : {}),
    inputMs: action.inputMs, presentedMs: null, meaningful: action.meaningful ?? true,
    outcome: action.outcome === undefined || action.outcome === 'completed' ? 'expected' : action.outcome,
    ...(action.samples ? { samples: action.samples.map((point, pointIndex) => ({ id: id + ':action-' + index + ':point-' + pointIndex, index: point.index ?? pointIndex, inputMs: point.inputMs, presentedMs: null, outcome: 'expected',
      ...(!text ? { receiptIdentityScope: 'campaign-local', browserEvent: { ...point } } : {}) })) } : {}),
    ...(action.pointerSchedule ? { pointerSchedule: action.pointerSchedule } : {}),
  }));
  return { id, cache: sample.cache, ordinal: sample.ordinal, cohortKey: cell.id ?? cell.operation,
    startMs: text ? segment?.startMs ?? null : observed.startMs, endMs: text ? segment?.endMs ?? null : observed.endMs,
    captureStoppedMs: text ? segment?.captureStoppedMs ?? null : observed.captureStoppedMs ?? null,
    visibility, refreshHz: null, requestedRefreshHz: 60, actions, activeSegments: [], fallbackSlices: [],
    ...(!text ? { automation: { driver: 'playwright', delivery: 'browser-input-api', physicalInput: false } } : {}),
    ...(text ? { textPresentation: observed.textPresentation, compositionEvents: observed.syntheticComposition ? 'synthetic-app-handling' : 'unverified' } : {}),
    trace: { kind: 'browser-diagnostic-trace', sha256: trace?.artifact?.sha256 ?? null, attributionComplete: false, actualPresentation: false },
    clock: observed.clock === 'browser-performance' ? 'browser-performance' : 'runner-monotonic-dispatch-observations',
    ...(observed.clock === 'browser-performance' ? { timeOrigin: observed.timeOrigin, unscoredPreparation: observed.unscoredPreparation } : {}),
    missing: ['Native input event timestamps joined to actual presentation and complete display-slot attribution remain unavailable'],
  };
}

/** Owns the browser and a separate real product backend process. No provider
 * credential enters either child; external HTTP is aborted before navigation.
 * Main runner owns cold/warm process counts and fixed idle/cycle scheduling. */
export async function createBrowserCampaign(context = {}) {
  const repo = resolve(context.repo ?? process.cwd()), output = resolve(context.output ?? join(repo, 'artifacts/browser-campaign-' + randomUUID()));
  const browserOptions = context.configuration?.browser ?? {};
  await mkdir(output, { recursive: true, mode: 0o700 });
  let fixture = context.fixture, browserServer, browser, browserContext, page, server, serverChild, root, backendAdapter, hmrAdapter, d11Collector, egress, lifecycleOracle, lifecycleCounters, nativeBrowserRuntime;
  let adapterLifecycle, waObservation, queueProvider, browserGeneration = 0, backendGeneration = 0, runtimeEngine, activeQueueTrace;
  const replacedRealms = [];
  let prepared = false, closed = false, serial = 0, preparationCell, controls, adapterLibrary, rawVitals, canonicalVitals, canonicalMissing, resourceSampler, rendererOwnershipCapture, gestures, baseline, previousResult, resetMissing = [], readinessController, readinessEvidence, requiredWorkerRestart;
  const resources = [], errors = [], external = [], commandReceipts = [], pendingReplies = new Set();
  const signal = context.signal;

  async function registerProcess(kind, pid, executable) {
    const identity = await executeFile('/bin/ps', ['-p', String(pid), '-o', 'pgid=,lstart='], { timeout: 5000 });
    const row = identity.stdout.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!row) throw Error('Owned process birth identity unavailable');
    const started = await executeFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5000 });
    const value = { kind, pid, pgid: Number(row[1]), startedAtIdentity: started.stdout.trim(), executable };
    const registrationPath = join(output, 'owned-process-' + pid + '-' + randomUUID() + '.json');
    await exclusiveJSON(registrationPath, { kind: 'perf-owned-processes-1', ownerPid: process.pid, processes: [value] });
    return {...value, registration: {path: registrationPath, ...await fileIdentity(registrationPath)}};
  }

  async function launchServer(isQueue) {
    const { ownServerProcess } = await import(pathToFileURL(join(repo, 'tests/editor/completion/owned-process.mjs')).href);
    const child = fork(new URL('./browser-server-process.mjs', import.meta.url), [root, join(repo, 'dist/app'), repo, isQueue ? new URL('./browser-queue-worker.mjs', import.meta.url).href : '', output], {
      cwd: repo, execPath: process.execPath,
      execArgv: ['--import', join(repo, isQueue ? 'tests/provider/no-egress.mjs' : 'tests/protocol/no-effects.mjs')],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    serverChild = child; child.stderr?.resume();
    const ownedServer = ownServerProcess(child); ownedServer.catch(() => {});
    const identity = await registerProcess('backend', child.pid, process.execPath);
    server = await ownedServer;
    backendGeneration++; return identity;
  }

  async function launchBrowser(cell) {
    const parameters = assertCell(cell);
    const subjectRequire = createRequire(join(repo, 'package.json'));
    const playwright = await import(pathToFileURL(subjectRequire.resolve('playwright')).href);
    const name = parameters.browser ?? cell.browser ?? context.browserName ?? browserOptions.engine ?? 'chromium';
    if (!['chromium', 'firefox', 'webkit'].includes(name)) throw Error('Unsupported browser engine');
    runtimeEngine = name;
    egress ??= await createCachePreservingEgress({ engine: name, allowedOrigins: [server.origin], onBlocked: event => external.push(event) });
    browserServer = await playwright[name].launchServer({ ...egress.launchOptions, headless: context.headless ?? browserOptions.headless ?? false, timeout: 30000 });
    const browserProcessIdentity = await registerProcess('browser', browserServer.process().pid, playwright[name].executablePath());
    browser = await playwright[name].connect(browserServer.wsEndpoint());
    const pin = JSON.parse(await readFile(join(repo, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers.find(entry => entry.name === name);
    if (browser.version() !== pin.browserVersion) throw new PrerequisiteError('Installed browser differs from the sealed Playwright pin');
    browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'no-preference' });
    browserContext.setDefaultTimeout(10000); browserContext.setDefaultNavigationTimeout(15000);
    const capabilitySetup = await installRasterCapabilities(browserContext, cell.operation === 'interaction.brush' ? parameters.mode ?? 'native' : 'native');
    rawVitals = await installBrowserVitals(browserContext);
    try { if (!queueOperations.has(cell.operation)) canonicalVitals = await installCanonicalWebVitals(browserContext, { repo, allowedOrigins: [server.origin] }); }
    catch (error) { if (error?.code !== 'CAMPAIGN_PREREQUISITE') throw error; canonicalMissing = error.message; }
    if (!egress.supported) await browserContext.route('**/*', route => {
      const target = new URL(route.request().url());
      if (['http:', 'https:'].includes(target.protocol) && target.origin !== server.origin) { external.push({ protocol: target.protocol, ordinal: external.length + 1 }); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    page = await browserContext.newPage();
    // This is an unscored transport challenge, served only by our proxy. A
    // platform loopback bypass reaches the product server and cannot satisfy it.
    const proxyRoute = egress.supported ? await egress.verifyBrowserRoute(page, { signal }) : null;
    if (browserOptions.byteAudit === true) {
      const { createBrowserD11Collector } = await import('./browser-d11.mjs');
      d11Collector = await createBrowserD11Collector({ context: browserContext, page, repo, output, origin: server.origin, fixture, engine: name, cachePolicy: { httpCacheDisabledByRouting: !egress.supported, policy: egress.cachePolicy } });
      if (!navigations.has(cell.operation)) await d11Collector.begin({ id: 'unscored-bootstrap', cache: 'cold', scope: 'startup', byteAudit: true });
    }
    page.on('pageerror', () => errors.push({ type: 'page-error', atMs: monotonic() }));
    page.on('response', response => {
      if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/v1/commands') return;
      // Response bodies are inspected transiently, but only immutable IDs/status
      // enter a receipt. Requests/prompt/body text are never retained here.
      const promise = response.json().then(value => {
        const receipt = value.receipt ?? value;
        if (receipt.commandId) commandReceipts.push({ commandId: receipt.commandId, status: receipt.status, observedMs: monotonic() });
      }).catch(() => {}).finally(() => pendingReplies.delete(promise));
      pendingReplies.add(promise);
    });
    const executable = playwright[name].executablePath();
    const identity = { engine: name, version: browser.version(), revision: pin.revision, executable, executableIdentity: await fileIdentity(executable), playwrightModule: subjectRequire.resolve('playwright'), backendPid: server.pid, browserPid: browserServer.process().pid, headless: context.headless ?? browserOptions.headless ?? false, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, proxyRoute, capabilitySetup, fixtureSeal: fixture.seal, root };
    identity.ownedLaunch = {process: browserProcessIdentity, context: {createdBy: 'browser.newContext', freshAtLaunch: true},
      observation: 'source-bound-launch-and-process-registration-not-serialized-authority'};
    nativeBrowserRuntime = structuredClone(identity);
    if (cell.operation === 'adapter.lifecycle') waObservation = createBrowserWAObservation({page, context: browserContext, proxy: egress, server, runtime: identity, executableIdentity: context.rendererIdentity, output});
    await writeFile(join(output, browserGeneration++ === 0 ? 'browser-runtime.json' : 'browser-runtime-replacement-' + browserGeneration + '.json'), JSON.stringify(identity, null, 2), { mode: 0o600, flag: 'wx' });
    return identity;
  }

  async function processBirth(child) {
    if (!child || !Number.isSafeInteger(child.pid) || child.exitCode !== null || child.signalCode !== null) throw Error('Owned process is not live');
    const value = await executeFile('/bin/ps', ['-p', String(child.pid), '-o', 'pgid=,lstart='], { timeout: 5000 });
    const row = value.stdout.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!row) throw Error('Owned process birth identity unavailable');
    return { pid: child.pid, pgid: Number(row[1]), startedAtIdentity: row[2] };
  }

  async function restartQueueProcess(target, request) {
    if (!queueProvider || !prepared || !['browser', 'backend'].includes(target) || !queueOperations.has(preparationCell.operation)) throw new PrerequisiteError('Queue process replacement requires its exact live campaign owner');
    if (d11Collector || resourceSampler) throw new PrerequisiteError('Queue process replacement cannot silently reuse an active byte-audit or lifecycle resource observer');
    assert.deepEqual(request.providerIdentity, queueProvider.identity);
    const before = await processBirth(target === 'browser' ? browserServer.process() : serverChild);
    const providerBefore = structuredClone(queueProvider.identity), rootBefore = root, originBefore = server.origin;
    const workerBefore = target === 'backend' ? (await controls.read()).workerIdentity : null;
    if (target === 'backend' && workerBefore?.pid !== before.pid) throw Error('Current queue worker identity is not bound to owned backend');
    const priorRealm = await readPhaseSnapshot(page, handle => ({ timeOrigin: performance.timeOrigin, observedMs: performance.now(), productPhases: handle?.value ?? null }));
    await releasePendingPhaseSnapshots(page);
    replacedRealms.push({ target, generation: browserGeneration, ...priorRealm, rawVitals: rawVitals?.snapshot() ?? null, canonicalVitals: canonicalVitals?.snapshot() ?? null, clocksJoinedBySubtraction: false });
    let oldExited = false, oldExit;
    if (target === 'browser') {
      await activeQueueTrace?.beforeReplacement();
      rawVitals?.close(); canonicalVitals?.close(); canonicalVitals = undefined;
      const oldProcess = browserServer.process();
      await boundedClose(() => browserServer.kill(), 15000);
      oldExited = oldProcess.exitCode !== null || oldProcess.signalCode !== null;
      oldExit = { pid: oldProcess.pid, code: oldProcess.exitCode, signal: oldProcess.signalCode, observedMs: monotonic() };
      if (!oldExited) throw Error('Browser replacement did not observe original process exit');
      browser = browserContext = page = undefined;
      await launchBrowser(preparationCell);
      readinessController = createBrowserReadinessController({ page, browser, engine: runtimeEngine, fixture, signal, diagnosticOutput: output, readEncodedEvidence: () => rasterMaintenance('encoded-rebuild-evidence') });
      await activeQueueTrace?.afterReplacement();
    } else {
      const oldProcess = serverChild, oldOrigin = server.origin;
      await server.kill();
      oldExited = oldProcess.exitCode !== null || oldProcess.signalCode !== null;
      oldExit = { pid: oldProcess.pid, code: oldProcess.exitCode, signal: oldProcess.signalCode, observedMs: monotonic() };
      if (!oldExited) throw Error('Backend replacement did not observe original process exit');
      await launchServer(true);
      // Replace exactly the prior owned origin. This does not broaden the proxy
      // allowlist and cannot create a direct transport fallback.
      await page.goto('about:blank');
      if (oldOrigin !== server.origin) egress.replaceOwnedOrigin(oldOrigin, server.origin);
      await egress.verifyBrowserRoute(page, { origin: server.origin, signal });
    }
    await page.goto(await server.pair()); await ready(page);
    const after = await processBirth(target === 'browser' ? browserServer.process() : serverChild);
    if (before.pid === after.pid && before.startedAtIdentity === after.startedAtIdentity) throw Error('Queue restart reused its old process identity');
    let workerAfter = null;
    if (target === 'backend') {
      const started = monotonic();
      for (;;) {
        workerAfter = (await controls.read()).workerIdentity;
        if (workerAfter?.pid === after.pid && workerAfter.epoch !== workerBefore.epoch) break;
        if (monotonic() - started > 10000) throw Error('Replacement queue worker generation was not observed');
        await intervalWait(25, signal);
      }
    }
    const witness = { kind: 'queue-process-restart-1', target, before, after, oldExited, oldExit, rootBefore, rootAfter: root, rootRetained: rootBefore === root, workerBefore, workerAfter,
      providerBefore, providerAfter: structuredClone(queueProvider.identity), backendGeneration, browserGeneration,
      fixtureSeal: fixture.seal, sameOrigin: originBefore === server.origin };
    await exclusiveJSON(join(output, 'queue-process-restart-' + target + '-' + randomUUID() + '.json'), witness);
    return { page, witness };
  }

  async function launch(cell) {
    signal?.throwIfAborted(); const parameters = assertCell(cell); preparationCell = cell;
    if (!fixture?.root || !fixture.seal) throw new PrerequisiteError('Browser campaigns require a sealed durable workload fixture');
    const { verifyFixtureManifest } = await import('./fixtures.mjs'); await verifyFixtureManifest(fixture);
    if (['interaction.brush', 'raster.stroke-finalize', 'lifecycle.editor'].includes(cell.operation)) gestures = await prepareBrowserGestures(fixture);
    // Copy only durable fixture inputs. No node_modules, build output or browser
    // profile is copied, and the original sealed source is never opened writable.
    root = join(output, 'browser-private-' + randomUUID());
    await cp(fixture.root, root, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    if (cell.operation.startsWith('adapter.') || cell.operation === 'fast.workflow' && parameters.caseId === 'WF09') {
      adapterLibrary = fixture.adapterLibrary ?? fixture.adapters?.library;
      if (!adapterLibrary) {
        const { prepareAdapterFixtures, prepareAdapterLibrary } = await import('./adapters.mjs');
        const inputs = await prepareAdapterFixtures(join(output, 'adapter-inputs'), { sizes: [256 * 1024 * 1024], signal });
        const { openWriter } = await import(pathToFileURL(join(repo, 'dist/local/server/storage/writer.js')).href);
        const writer = await openWriter({ root });
        try { await writer.protocolDefaults(); adapterLibrary = await prepareAdapterLibrary(writer, inputs, { repo, root, output, signal, officialPath: fixture.officialAdapterPath }); }
        finally { await writer.close(); }
      }
      fixture = { ...fixture, adapterLibrary };
    }
    const isQueue = queueOperations.has(cell.operation);
    if (isQueue) {
      const { selectQueueResultFiles } = await import('./browser-queue.mjs');
      const resultFiles = await selectQueueResultFiles(cell, fixture);
      const { createBrowserQueueProvider, createBrowserQueueControls } = await import('./browser-queue-provider.mjs');
      queueProvider = await createBrowserQueueProvider({ repo, root, fixture, resultFiles, endpoint: cell.operation === 'fast.workflow' ? 'ideogram/v4/fast' : 'ideogram/v4', signal });
      await writeFile(join(root, 'campaign-provider-config.json'), JSON.stringify({ repo, diagnosticOutput: output, endpoint: cell.operation === 'fast.workflow' ? 'ideogram/v4/fast' : 'ideogram/v4', fixture: { corpus: fixture.corpus }, resultFiles, externalProvider: queueProvider.identity }), { mode: 0o600 });
      controls = await createBrowserQueueControls({ root, provider: queueProvider, signal });
    }
    await launchServer(isQueue);
    const identity = await launchBrowser(cell);
    if (!navigations.has(cell.operation)) {
      await page.goto(await server.pair()); await ready(page);
      // A text byte audit first observes an empty shell. Opening the mixed
      // document belongs inside the later text-engine coverage boundary.
      if (fixture.documentId && !(d11Collector && cell.operation.startsWith('text.'))) await openDocument(page, fixture);
      if (d11Collector) await exclusiveJSON(join(output, 'd11-unscored-bootstrap.json'), await d11Collector.snapshot());
      if (cell.operation === 'lifecycle.editor') {
        fixture = { ...fixture, candidate: await resolveBrowserCandidate(page, fixture) };
        lifecycleOracle = await (await import('./browser-lifecycle-oracle.mjs')).createLifecycleOracle({ page, fixture, root, origin: server.origin, repo, signal });
        await exclusiveJSON(join(output, 'lifecycle-initial-oracle.json'), await lifecycleOracle.baseline());
        const { createLifecycleCounters } = await import('./browser-lifecycle-counters.mjs');
        lifecycleCounters = await createLifecycleCounters({ page, root, repo, output, cell, fixtureIdentity: fixture.seal.sha256, processIdentity: JSON.stringify(await lifecycleIdentity()), rendererOwnershipProof: rendererOwnershipCapture?.proof ?? null,
          executableIdentity: textResourceExecutableIdentity(), journal: context.trace, signal });
      }
      if (cell.operation === 'adapter.lifecycle') {
        const { createAdapterBrowserLifecycle } = await import('./browser-adapters.mjs');
        adapterLifecycle = await createAdapterBrowserLifecycle({ page, fixture, signal, backend: { repo, root, output, server, adapterLibrary, closeDocumentConsumers, measureResources, lifecycleIdentity, waObservation } });
        await adapterLifecycle.prepare();
      }
      if (cell.operation === 'lifecycle.editor') await closeDocumentConsumers();
    }
    if (cell.operation === 'adapter.select') { const { prepareAdapterBrowserCell } = await import('./browser-adapters.mjs'); await prepareAdapterBrowserCell({ page, fixture, backend: { adapterLibrary } }); }
    if (cell.operation === 'fast.workflow' && ['WF07', 'WF08', 'WF09'].includes(parameters.caseId)) {
      const { prepareFastBrowserFixture } = await import('./browser-fast-setup.mjs');
      const setup = await prepareFastBrowserFixture({ page, cell, fixture, signal });
      await exclusiveJSON(join(output, 'browser-fast-setup.json'), sanitize(setup));
    }
    if (['raster.masked-prepare', 'raster.adopt', 'lifecycle.editor'].includes(cell.operation)) fixture = { ...fixture, candidate: await resolveBrowserCandidate(page, fixture) };
    readinessController = createBrowserReadinessController({ page, browser, engine: runtimeEngine, fixture, signal, diagnosticOutput: output, readEncodedEvidence: () => rasterMaintenance('encoded-rebuild-evidence') });
    prepared = true; return identity;
  }

  async function prepareCell(cell) {
    if (closed) throw Error('Browser campaign is closed'); assertCell(cell);
    if (cell.operation === 'developer.hot-update') {
      hmrAdapter ??= await (await import('./browser-hmr.mjs')).createBrowserHmrCampaign(context);
      return hmrAdapter.prepareCell(cell);
    }
    if (backendOnly.has(cell.operation)) {
      if (!backendAdapter) {
        const module = await import('./backend.mjs');
        backendAdapter = await (module.createBackendAdapter ?? module.createBackendCampaign)(context);
      }
      return backendAdapter.prepareCell(cell);
    }
    if (!prepared) return launch(cell);
    if (preparationCell.workload && cell.workload && preparationCell.workload !== cell.workload) throw Error('A browser process cannot silently switch workload cohorts');
    return { reused: true, browserPid: browserServer.process().pid, backendPid: server.pid };
  }

  async function resetCell(cell, sample = {}) {
    const p = assertCell(cell); signal?.throwIfAborted();
    if (cell.operation === 'developer.hot-update') { await prepareCell(cell); return hmrAdapter.resetCell(cell, sample); }
    if (backendOnly.has(cell.operation)) return backendAdapter.resetCell(cell, sample);
    if (!prepared) await prepareCell(cell);
    if (!resourceSampler) await releasePendingPhaseSnapshots(page);
    if (sample.cache === 'cold' && serial > 0) throw new PrerequisiteError('Cold browser samples require a fresh runner child/browser/backend, never a cache-label change');
    resetMissing = []; readinessEvidence = null;
    if (cell.operation === 'adapter.select') { const { resetAdapterBrowserCell } = await import('./browser-adapters.mjs'); await resetAdapterBrowserCell({ page, fixture, backend: { adapterLibrary } }); return { status: 'PASS', cache: sample.cache, reset: 'actual public unselect and immutable library search' }; }
    const controlled = !!(p.readiness || p.decodedCache || p.mode && p.mode !== 'native');
    // Logical history/view restoration is separate from the real renderer
    // preconditions established below; it cannot certify a decoded cache.
    const logicalCell = controlled ? { ...cell, parameters: { ...p, readiness: undefined, decodedCache: undefined, mode: 'native' } } : cell;
    const finishReset = async reset => {
      if (!controlled || String(reset.status).toUpperCase() !== 'PASS') return reset;
      try { readinessEvidence = await readinessController.resetProductState(cell); }
      catch (error) { if (error?.code !== 'CAMPAIGN_PREREQUISITE') throw error; resetMissing = [error.message]; return { ...reset, status: 'INCONCLUSIVE', missing: resetMissing }; }
      if (readinessEvidence.actionAllowed !== true) resetMissing = readinessEvidence.missing ?? ['Renderer precondition is unavailable'];
      return { ...reset, status: readinessEvidence.status, readiness: readinessEvidence, missing: [...(reset.missing ?? []), ...(readinessEvidence.missing ?? [])] };
    };
    if (navigations.has(cell.operation)) return { status: 'PASS', cache: sample.cache, pagePreparation: 'navigation remains inside action timer' };
    if (cell.kind === 'lifecycle' || cell.operation.endsWith('.lifecycle') || cell.operation === 'lifecycle.editor') return { status: 'PASS', cache: sample.cache, independentClosedBaseline: true };
    if (d11Collector && cell.operation.startsWith('text.') && !baseline) return { status: 'PASS', cache: sample.cache, pagePreparation: 'First mixed document opens inside the explicit text-engine byte audit' };
    if (controlled && previousResult && cell.operation === 'raster.adopt') await readinessController.returnToAccepted();
    if (!baseline) baseline = await captureBrowserBaseline({ page, cell: logicalCell, fixture, signal });
    const reset = await resetBrowserCell({ page, cell: logicalCell, fixture, sample, previousResult, baseline, controls, server, signal, networkGuard: egress });
    baseline = reset.baseline ?? baseline;
    resetMissing = reset.missing ?? (String(reset.status).toUpperCase() !== 'PASS' ? ['Actual public reset did not establish the cell preconditions'] : []);
    if (String(reset.status).toUpperCase() === 'PASS' && sample.cache === 'warm' && ['interaction.brush', 'text.interaction'].includes(cell.operation)) {
      const startMs = monotonic(), actions = [];
      const document = (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
      await page.waitForFunction(asset => document.querySelector('canvas[aria-label="Document raster preview"]')?.getAttribute('data-asset') === asset, document.image?.compositeAssetId ?? '');
      let nativePreparation = null;
      if (cell.operation === 'text.interaction') {
        const { runTextBrowserCell } = await import('./browser-text.mjs');
        nativePreparation = await runTextBrowserCell({ page, cell: { ...cell, operation: 'text.active-layout' }, fixture, repo, signal });
        actions.push('public exact-fixture native text preview');
      } else {
        await page.getByRole('button', { name: 'Mask', exact: true }).click();
        await page.getByRole('spinbutton', { name: 'Brush diameter (document px)', exact: true }).waitFor({ state: 'visible' });
        actions.push('public mask feature activation');
      }
      const restored = await resetBrowserCell({ page, cell: logicalCell, fixture, sample, previousResult: nativePreparation ?? { observations: { unscoredFeatureActivation: true } }, baseline, controls, server, signal, networkGuard: egress });
      if (String(restored.status).toUpperCase() !== 'PASS') { resetMissing = restored.missing ?? ['Per-visit public preparation did not restore the sealed state']; return { ...restored, warmPreparation: { startMs, endMs: monotonic(), actions } }; }
      return finishReset({ ...reset, warmPreparation: { kind: 'actual-unscored-per-visit-preparation', startMs, endMs: monotonic(), actions, viewportAssetId: document.image?.compositeAssetId ?? null, nativePreparation, canonicalVisitIncludesPreparation: true, retainedWorkerCacheClaim: false, readiness: 'Public viewport identity and actual feature workflow; independent complete decoded/font cache ledger remains unavailable' } });
    }
    return finishReset(reset);
  }

  async function measureResources() {
    if (!server || !browserServer) throw new PrerequisiteError('Browser resource owner not running');
    if (resourceSampler) { const value = await resourceSampler.measure(); resources.push(value); return value; }
    const sampleAtMs = monotonic();
    let processRows;
    try { processRows = (await executeFile('/bin/ps', ['-e', '-o', 'pid=,ppid=,rss='], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
    catch { throw new PrerequisiteError('OS attributable process-tree RSS is unavailable'); }
    const browserProcesses = processTreeRows(processRows, [browserServer.process().pid]);
    const backendProcesses = processTreeRows(processRows, [server.pid]);
    if (!browserProcesses.length || !backendProcesses.length) throw new PrerequisiteError('Owned process disappeared during RSS sample');
    const phases = await readPhaseSnapshot(page);
    const lifecycle = await page.locator('ie-shell').evaluate(shell => shell.documentLifecycle ?? null);
    const sample = { sampleAtMs, browserProcesses, backendProcesses, browserRssBytes: browserProcesses.reduce((sum, p) => sum + p.rssBytes, 0), backendRssBytes: backendProcesses.reduce((sum, p) => sum + p.rssBytes, 0), allocations: phases?.allocations ?? null, allocationCoverage: phases?.allocations ? 'product diagnostic ledger; completeness separately verified' : 'missing CPU/GPU/font/caption ledger', forcedGC: false };
    sample.documentLifecycle = lifecycle; resources.push(sample); return sample;
  }

  function textResourceExecutableIdentity() {
    const identity = context.rendererIdentity;
    return identity ? {sourceDigest: identity.sourceDigest, buildDigest: identity.buildDigest, toolsDigest: identity.toolsDigest} : null;
  }
  async function ensureRendererOwnershipCapture() {
    if (rendererOwnershipCapture) return rendererOwnershipCapture;
    const identity = context.rendererIdentity;
    rendererOwnershipCapture = identity ? await captureRendererOwnershipProof({repo, output, sourceFiles: identity.sourceFiles, buildFiles: identity.buildFiles,
      executableIdentity: textResourceExecutableIdentity()}) : {proof: null, artifact: null, missing: ['renderer-source-and-build-identity-unavailable']};
    return rendererOwnershipCapture;
  }
  async function lifecycleIdentity() {
    if (!resourceSampler) {
      await ensureRendererOwnershipCapture();
      resourceSampler = createBrowserResourceSampler({ browserPid: browserServer?.process().pid, backendPid: server?.pid, page, output, signal, rendererOwnershipProof: rendererOwnershipCapture.proof });
      await resourceSampler.start();
    }
    return resourceSampler.identity();
  }

  async function beginResourceWindow({ cycleOrdinal }) {
    await lifecycleIdentity();
    return resourceSampler.beginWindow({ cycleOrdinal });
  }
  async function endResourceWindow(handle) {
    if (!resourceSampler) throw new PrerequisiteError('Resource window has no live process sampler');
    return resourceSampler.endWindow(handle);
  }

  async function resourceSamplingEvidence() { return resourceSampler ? { ...await resourceSampler.stop(), rendererOwnershipProof: rendererOwnershipCapture?.proof ?? null, rendererOwnershipMissing: rendererOwnershipCapture?.missing ?? [] } : { complete: false, kind: 'attributed-process-tree-and-allocation-ledger', sha256: null, missing: ['Continuous sampling was not started'] }; }

  async function finalizeLifecycle(cell) {
    if (cell.operation === 'adapter.lifecycle') { if (!adapterLifecycle) throw new PrerequisiteError('Adapter lifecycle owner was not prepared before B0'); return adapterLifecycle.finalize(); }
    if (cell.operation !== 'lifecycle.editor') return { status: 'PASS', applicable: false };
    if (!lifecycleOracle) return { status: 'INCONCLUSIVE', missing: ['Lifecycle initial full byte oracle was not prepared before B0'] };
    const value = await lifecycleOracle.completeSeries();
    const file = join(output, 'lifecycle-final-oracle.json'); await exclusiveJSON(file, value);
    return { ...value, status: value.complete ? 'PASS' : 'INCONCLUSIVE', artifacts: [file] };
  }

  async function lifecycleCycle(argument = {}, { cycle = 1, signal: cycleSignal = signal } = {}) {
    const cell = argument.cell ?? argument;
    cycleSignal?.throwIfAborted();
    if (!page) throw new PrerequisiteError('No live editor lifecycle');
    if (cell.operation === 'adapter.lifecycle') {
      if (!adapterLifecycle) throw new PrerequisiteError('Adapter lifecycle owner was not prepared before B0');
      await openDocument(page, fixture);
      return adapterLifecycle.run(cell, { cycle, signal: cycleSignal });
    }
    let counterEvidence;
    try {
    await lifecycleCounters?.startCycle({ cycleOrdinal: cycle, documentId: fixture.documentId });
    const close = page.getByRole('button', { name: 'Close document', exact: true });
    if (await close.count() !== 1) throw new PrerequisiteError('Product document-close capability unavailable; navigation is not a lifecycle substitute');
    const candidate = fixture.candidate;
    if (!candidate) throw new PrerequisiteError('Lifecycle requires a fixed sealed prepared candidate');
    const phases = [], receipts = [], readDocument = async () => (await publicRead(page, '/api/v1/documents/' + fixture.documentId)).projection.value;
    const phase = async (name, work) => {
      const entry = { name, startMs: monotonic(), endMs: null, outcome: 'running' }; phases.push(entry);
      let actionFailure;
      try { const value = await work(); entry.outcome = 'expected'; return value; }
      catch (error) { actionFailure = error; entry.outcome = 'failed'; throw error; }
      finally {
        entry.endMs = monotonic();
        try { await lifecycleCounters?.observe({ label: name }); }
        catch (observerFailure) { if (actionFailure) throw new AggregateError([actionFailure, observerFailure], 'Lifecycle action and phase observation failed'); throw observerFailure; }
      }
    };
    let before, afterStroke, retainedBefore, lifecycle, mixed, strokeResult, adoption, oracleResult;
    const retainedWitness = async () => {
      const frozen = fixture.extensions?.candidates;
      const ids = [...new Set([candidate.encodedAssetId, candidate.preparedAssetId, frozen?.source?.assetId, frozen?.mask?.assetId].filter(Boolean))];
      const assets = [];
      for (const id of ids) {
        const asset = (await publicRead(page, '/api/v1/assets/' + id)).projection.value;
        const disk = await page.evaluate(async id => {
          const response = await fetch('/api/v1/assets/' + id + '/content', { method: 'HEAD', headers: { 'X-App-Client': 'LP-1' }, credentials: 'same-origin', cache: 'no-store' });
          return { status: response.status, etag: response.headers.get('etag'), byteLength: response.headers.get('content-length') };
        }, id);
        assert.equal(disk.status, 200); assert.equal(disk.etag, '"' + asset.blob.hash + '"'); assert.equal(disk.byteLength, asset.blob.byteLength);
        assets.push({ id, blob: asset.blob, pixels: asset.raster?.pixels ?? null });
      }
      return assets;
    };
    await phase('open', async () => { await openDocument(page, fixture); before = await readDocument(); retainedBefore = await retainedWitness(); await lifecycleOracle?.checkpoint('open'); });
    strokeResult = await phase('stroke', async () => {
      const value = await stroke(page, { signal: cycleSignal, commit: true, fixture, gestures, strokeIndex: cycle - 1 });
      afterStroke = await readDocument(); assert.notDeepEqual(afterStroke.image, before.image, 'Lifecycle stroke must change the accepted image'); await lifecycleOracle?.checkpoint('after-stroke', { stroke: value }); return value;
    });
    if (['WXn', 'WXs'].includes(fixture.workload)) mixed = await (await import('./browser-text.mjs')).runNativeLifecycle({ page, fixture, signal: cycleSignal, phase });
    // An explicit full-candidate placement remains reversible after the mask
    // stroke changes the original source. Its treatment is retained in evidence.
    adoption = await phase('adopt', async () => {
      const replacement = await selectVisibleImageLayer(page, fixture, strokeResult.target.id);
      const result = await runBrowserAction({ page, cell: { ...cell, operation: 'raster.adopt', parameters: { candidate, readiness: 'B', placement: 'current-document', treatment: 'full-candidate', replaceSelectedImage: true } }, fixture, signal: cycleSignal, pair: () => server.pair() });
      const changed = await readDocument(), image = await publicRead(page, '/api/v1/documents/' + fixture.documentId + '/image');
      assert.deepEqual(changed.orderedLayerIds, afterStroke.orderedLayerIds, 'Replacement must preserve exact layer identities, slots and count');
      const target = image.layers.find(layer => layer.id === replacement.id); assert(target); assert.equal(target.version, String(BigInt(replacement.version) + 1n));
      await lifecycleOracle?.checkpoint('after-adoption', { replacement, candidate });
      return { ...result, replacement };
    });
    await phase('undo-adoption', async () => {
      assert.equal(adoption.receipt?.documentId, fixture.documentId, 'Lifecycle adoption must create an undoable revision of the fixture document');
      receipts.push(await acceptedCommand(page, 'Undo', () => page.getByRole('button', { name: 'Undo', exact: true }).click(), cycleSignal));
      assert.deepEqual((await readDocument()).image, afterStroke.image, 'Undo of adoption must restore the stroked document');
      await lifecycleOracle?.checkpoint('after-undo-adoption');
    });
    await phase('undo-stroke', async () => {
      await openDocument(page, fixture);
      receipts.push(await acceptedCommand(page, 'Undo', () => page.getByRole('button', { name: 'Undo', exact: true }).click(), cycleSignal));
      const restored = await readDocument(); assert.deepEqual(restored.image, before.image); assert.deepEqual(restored.orderedLayerIds, before.orderedLayerIds);
      await lifecycleOracle?.afterUndo();
    });
    const beforeCloseLifecycle = await page.locator('ie-shell').evaluate(shell => shell.documentLifecycle ?? null);
    if (!beforeCloseLifecycle || beforeCloseLifecycle.releasing || beforeCloseLifecycle.failed) throw Error('Lifecycle close requires its current healthy document owner');
    const closeStartMs = monotonic();
    await phase('close', async () => { await close.click(); await page.getByText('No document open', { exact: true }).waitFor({ state: 'visible' }); });
    await phase('release', async () => {
      await page.waitForFunction(previous => { const value = document.querySelector('ie-shell')?.documentLifecycle; return value && (value.failed || !value.releasing && value.releases > previous); }, beforeCloseLifecycle.releases);
      lifecycle = await page.locator('ie-shell').evaluate(shell => shell.documentLifecycle ?? null);
      if (!lifecycle || lifecycle.releasing || lifecycle.failed || lifecycle.releases <= beforeCloseLifecycle.releases) throw Error('Current lifecycle document resource release failed or was not observed');
      for (const counters of Object.values(lifecycle.consumers)) for (const value of Object.values(counters)) assert(value === 0 || value === false, 'A document consumer retained resources after close');
      assert.deepEqual(await retainedWitness(), retainedBefore, 'Frozen source, mask and candidate asset bytes must stay retained after close');
      oracleResult = await lifecycleOracle?.afterClose();
    });
    counterEvidence = await lifecycleCounters?.finishCycle();
    const rasterWorker = await rasterMaintenance('raster-worker-state');
    if (requiredWorkerRestart) {
      assert.equal(rasterWorker.identity?.generation, requiredWorkerRestart.generation, 'The scheduled replacement worker must execute the next real cycle');
      assert.equal(rasterWorker.lastCompleted?.generation, requiredWorkerRestart.generation, 'A newly started idle service alone is not evidence of resumed raster work');
      assert(rasterWorker.completedJobs > requiredWorkerRestart.completedJobs, 'The next cycle must complete real work on the replacement generation');
      requiredWorkerRestart = null;
    }
    const oracleMissing = [...(oracleResult?.missing ?? ['Complete initial/interim/final retained-input byte proof unavailable']), ...(counterEvidence?.missing ?? ['Lifecycle counter observations unavailable'])];
    const oracleComplete = !!oracleResult?.assertions?.lifecycleRaster && oracleResult.assertions.undoRestored === true && oracleResult.assertions.retainedInputs === true;
    if (!oracleComplete && !oracleMissing.length) oracleMissing.push('Required scoped lifecycle oracle assertions are absent');
    return { status: oracleMissing.length ? 'INCONCLUSIVE' : 'PASS', measurements: counterEvidence?.measurements ?? [], lifecycleCounterEvidence: counterEvidence, artifacts: counterEvidence?.artifact ? [counterEvidence.artifact.path].filter(Boolean) : [], phases, strokeSamples: strokeResult.samples.length, stroke: strokeResult, adoption, receipts, mixed, assertions: oracleResult?.assertions ?? { exactPixels: null, undoRestored: true, retainedInputs: null }, oracle: oracleResult?.evidence ?? null, retainedAssetWitness: retainedBefore, closeStartMs, closeObservedMs: phases.at(-1).endMs, releaseMs: lifecycle.lastReleaseMilliseconds, lifecycle, rasterWorker, browserPid: browserServer.process().pid, backendPid: server.pid, completeCycleActions: true, missing: oracleMissing };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Lifecycle phase failed', { cause: error });
      if (!counterEvidence && lifecycleCounters) {
        try { failure.lifecycleCounterEvidence = await lifecycleCounters.finishCycle({ failed: true }); }
        catch (counterError) { throw new AggregateError([failure, counterError], 'Lifecycle phase and attempted counter capture failed'); }
      } else if (counterEvidence) failure.lifecycleCounterEvidence = counterEvidence;
      throw failure;
    }
  }

  async function rasterMaintenance(type, expectedGeneration) {
    signal?.throwIfAborted();if (!serverChild?.connected) throw new PrerequisiteError('Owned backend maintenance channel is unavailable');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); serverChild.off('message', reply); serverChild.off('exit', exited); signal?.removeEventListener('abort', aborted); };
      const reply = message => { if (message?.type !== 'raster-maintenance-reply' || message.id !== id) return; cleanup(); if (message.error) reject(Object.assign(Error('Owned raster maintenance failed'), { code: message.error.code })); else resolve(message.value); };
      const exited = () => { cleanup(); reject(Error('Owned backend exited during raster maintenance')); };
      const aborted = () => { cleanup(); reject(signal.reason ?? Error('Aborted')); };
      const timer = setTimeout(() => { cleanup(); reject(Error('Owned raster maintenance deadline')); }, 30000);
      serverChild.on('message', reply); serverChild.once('exit', exited); signal?.addEventListener('abort', aborted, { once: true });
      serverChild.send({ type, id, ...(expectedGeneration === undefined ? {} : { expectedGeneration }) });
    });
  }
  async function restartWorker({ cycle } = {}) {
    await page.getByText('No document open', { exact: true }).waitFor({ state: 'visible' });
    const lifecycle = await page.locator('ie-shell').evaluate(shell => shell.documentLifecycle);
    if (!lifecycle || lifecycle.releasing) throw new PrerequisiteError('Document consumers have not finished releasing');
    const state = await rasterMaintenance('raster-worker-state');
    if (state.activeJobs !== 0 || state.retainedJobReferences !== 0 || state.idleWorkers !== 1 || !state.identity) throw new PrerequisiteError('A real idle raster worker is required for scheduled restart');
    const backendPid = serverChild.pid, browserPid = browserServer.process().pid;
    const receipt = await rasterMaintenance('restart-raster-worker', state.generation);
    assert.equal(receipt.kind, 'raster-worker-restart-1'); assert.deepEqual(receipt.before, state.identity);
    assert.equal(receipt.after.generation, state.generation + 1); assert.equal(receipt.activeJobs, 0); assert.equal(receipt.retainedJobReferences, 0);
    assert.equal(receipt.forcedGC, false); assert.equal(receipt.nativeAllocatorReleaseClaim, false);
    assert.equal(serverChild.pid, backendPid); assert.equal(browserServer.process().pid, browserPid);
    requiredWorkerRestart = { generation: receipt.after.generation, completedJobs: state.completedJobs };
    const identity = value => `${backendPid}:${value.threadId}:${value.generation}`;
    return { status: 'PASS', cycle, before: identity(receipt.before), after: identity(receipt.after), receipt, backendPid, browserPid, mainProcessRestarted: false, requiresNextRealJobEvidence: true };
  }

  async function closeDocumentConsumers() {
    const beforeLifecycle = await page.locator('ie-shell').evaluate(shell => shell.documentLifecycle ?? null);
    if (!beforeLifecycle || beforeLifecycle.releasing || beforeLifecycle.failed) throw new PrerequisiteError('Document must have a healthy live owner before the close witness');
    const closeStartMs = monotonic(); await page.getByRole('button', { name: 'Close document', exact: true }).click();
    await page.getByText('No document open', { exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(previous => { const value = document.querySelector('ie-shell')?.documentLifecycle; return value && (value.failed || !value.releasing && value.releases > previous); }, beforeLifecycle.releases);
    const lifecycle = await page.locator('ie-shell').evaluate(shell => shell.documentLifecycle ?? null);
    if (!lifecycle || lifecycle.releasing || lifecycle.failed || lifecycle.releases <= beforeLifecycle.releases) throw Error('Current document resource release failed or was not observed');
    return { closeStartMs, closeObservedMs: monotonic(), beforeLifecycle, lifecycle };
  }

  async function execute(cell, sample = {}) {
    assertCell(cell); if (closed) throw Error('Browser campaign is closed'); signal?.throwIfAborted();
    if (Object.hasOwn(context.services ?? {}, 'nativeNavigation')) throw new PrerequisiteError('Native navigation requires an internally owned capture selection');
    if (cell.operation === 'developer.hot-update') { await prepareCell(cell); return hmrAdapter.execute(cell, sample); }
    if (backendOnly.has(cell.operation)) { await prepareCell(cell); return backendAdapter.execute(cell, sample); }
    await prepareCell(cell);
    if (resetMissing.length) return { cellId: cell.id, status: 'INCONCLUSIVE', elapsedMs: 0, phases: [], missing: [...resetMissing], observations: { actionExecuted: false } };
    const visitCohort = { cache: sample.cache === 'warm' ? 'warm' : 'cold', cohortKey: cell.id ?? cell.operation + '-' + (cell.workload ?? fixture.workload) };
    let initialVisitIds = [], currentVisitId, visits;
    if (browserOptions.byteAudit !== true && vitalOperations.has(cell.operation) && canonicalVitals) {
      initialVisitIds = canonicalVitals.visits().map(visit => visit.visitId);
      canonicalVitals.setCohort(visitCohort, { page, includeCurrentVisit: !navigations.has(cell.operation) });
      if (!navigations.has(cell.operation)) currentVisitId = canonicalVitals.visits().at(-1)?.visitId;
    }
    const visibility = await page.evaluate(() => document.visibilityState);
    const index = ++serial, phases = [], startMs = monotonic(), errorStart = errors.length, externalStart = external.length, receiptStart = commandReceipts.length;
    const genericSelected = cell.operation === 'interaction.brush' && browserOptions.byteAudit !== true && browserOptions.windowServerGenericActions !== undefined;
    const textSelected = cell.operation === 'text.interaction' && browserOptions.byteAudit !== true && browserOptions.windowServerTextActions !== undefined;
    const rawTraceMissing = []; let rawFeedbackSelection = null;
    if (browserOptions.rawDisplayFeedback !== undefined) try {
      assert(genericSelected || textSelected, 'Raw display feedback requires a selected full interaction route');
      rawFeedbackSelection = genericRawFeedbackSelection(browserOptions.rawDisplayFeedback, nativeBrowserRuntime, browserServer.process().pid);
    } catch {rawTraceMissing.push('raw-feedback-selection-or-owned-invocation-unavailable');}
    let trace = createBrowserTrace(page, { artifactDirectory: output, artifactName: 'browser-trace-' + index + '.json',
      ...(rawFeedbackSelection ? {rawFeedback: {ownership: rawFeedbackSelection.ownership, artifactName: 'browser-feedback-' + index + '.raw.json'}} : {}) });
    const traceSegments = [];
    if (!rawFeedbackSelection) await trace.start();
    activeQueueTrace = queueOperations.has(cell.operation) ? {
      async beforeReplacement() { if (trace) { traceSegments.push(await trace.stop()); trace = null; } },
      async afterReplacement() { trace = createBrowserTrace(page, { artifactDirectory: output, artifactName: 'browser-trace-' + index + '-replacement-' + browserGeneration + '.json' }); await trace.start(); },
    } : undefined;
    const discreteInputSessionId = 'input-' + randomUUID();
    let result, evidence, d11, auditAction, discreteInputFailure, nativeFirstUse, nativeFirstUseObservation, nativeGeneric, nativeGenericObservation,
      nativeText, nativeTextObservation, textBinding, textServices, ordinaryText, ordinaryTextObservation, ordinaryTextProof, ordinaryComposition, ordinaryCompositionObservation, ordinaryCompositionProof, nativeNavigation, nativeNavigationObservation, navigationProof, textResourceObserver, textResources, textResourceProof, textResourceFailure, auditActive = false, featureBoundary, featureAbsence;
    const featureAudits = [], featureActions = d11Collector ? byteAuditFeatureActions(cell) : [];
    const auditId = featureActions.length ? attemptIdentity(cell, visitCohort.cache, sample.ordinal, sample.prime)
      : String(cell.id) + ':' + String(sample.cache) + ':' + String(sample.ordinal);
    let failureState = {caughtFailure: false, productFailureSeen: false};
    const retainFailure = error => {failureState = retainBrowserActionFailure(failureState, error);};
    try {
      if (featureActions.length) {
        featureBoundary = await d11Collector.resolveFeatureBoundary();
        if (featureBoundary?.complete !== true || typeof featureBoundary.featureId !== 'string') throw new PrerequisiteError('Export boundary lacks one complete private-event witness: ' + (featureBoundary?.missing ?? []).join('; '));
        if (browserOptions.byteAuditScope && browserOptions.byteAuditScope !== 'startup') throw new PrerequisiteError('Declared navigation feature proofs require the startup scope');
      }
      if (d11Collector) await d11Collector.begin({ id: auditId, cache: visitCohort.cache, scope: browserOptions.byteAuditScope ?? (navigations.has(cell.operation) ? 'startup' : cell.operation.startsWith('text.') ? 'text-engine' : 'lazy-feature'), featureId: browserOptions.byteAuditFeatureId,
        ...(featureActions.length ? { workload: cell.workload, featureBoundary: { featureId: featureBoundary.featureId, phase: 'startup-absence' } } : {}), byteAudit: true });
      auditActive = !!d11Collector;
      if (d11Collector && cell.operation.startsWith('text.')) {
        await openDocument(page, fixture);
        baseline ??= await captureBrowserBaseline({ page, cell, fixture, signal });
      }
      if (cell.operation === 'navigation.ready' && browserOptions.byteAudit !== true && browserOptions.windowServerNavigation !== undefined) {
        try {
          const {prepareNavigationWindowServer} = await import('./windowserver-navigation.mjs');
          nativeNavigation = await prepareNavigationWindowServer({configuration: browserOptions.windowServerNavigation,
            runtime: nativeBrowserRuntime, cell, sample, serial: index, fixture,
            invocation: {kind: 'windowserver-navigation-invocation-1', cellId: String(cell.id), workload: cell.workload,
              cache: sample.cache, ordinal: sample.ordinal, prime: Boolean(sample.prime), serial: index,
              attemptId: attemptIdentity(cell, sample.cache, sample.ordinal, Boolean(sample.prime)), sourceRoot: repo,
              workerProcessIdentity: context.processIdentity, environment: context.navigationEnvironment}, output, signal});
        } catch (error) {
          signal?.throwIfAborted();
          nativeNavigationObservation = {kind: 'navigation-windowserver-observation-1', qualification: false,
            missing: ['native-navigation-setup-unavailable'], failures: [{name: String(error?.name ?? 'Error'), message: String(error?.message ?? error).slice(0, 1024)}]};
        }
      }
      if (cell.operation === 'interaction.first-use' && browserOptions.byteAudit !== true && browserOptions.windowServerFirstUse !== undefined) {
        const feature = (cell.parameters ?? cell.options ?? cell).feature === 'adapter' ? 'Adapter library' : 'Mask';
        try {
          if (sample.cache !== 'cold' || index !== 1) throw Error('Native first-use observation requires the existing fresh cold first-use boundary');
          if (context.services?.discreteInputHook !== undefined || context.services?.discreteFirstUseReady !== undefined) throw Error('A native first-use selection cannot replace an existing input/readiness hook');
          const {prepareFirstUseWindowServer} = await import('./windowserver-first-use.mjs');
          nativeFirstUse = await prepareFirstUseWindowServer({configuration: browserOptions.windowServerFirstUse, runtime: nativeBrowserRuntime,
            feature, sessionId: discreteInputSessionId, output, signal});
        } catch (error) {
          signal?.throwIfAborted();
          nativeFirstUseObservation = {kind: 'first-use-windowserver-observation-1', feature, qualification: false,
            missing: ['native-first-use-setup-unavailable'], failures: [{name: String(error?.name ?? 'Error'), message: String(error?.message ?? error).slice(0, 1024)}]};
        }
      }
      if (genericSelected) {
        try {
          if (context.services?.discreteInputHook !== undefined || context.services?.genericPointerHook !== undefined ||
            context.services?.genericSessionStart !== undefined || context.services?.genericSessionEnd !== undefined) throw Error('A generic native selection cannot replace an existing input hook');
          const {prepareGenericWindowServer} = await import('./windowserver-generic-actions.mjs');
          nativeGeneric = await prepareGenericWindowServer({configuration: browserOptions.windowServerGenericActions, runtime: nativeBrowserRuntime,
            sessionId: discreteInputSessionId, invocation: {cellId: String(cell.id), operation: cell.operation, serial: index,
              sample: {cache: sample.cache, ordinal: sample.ordinal, prime: sample.prime}, producerPath: join(output, 'browser-cell-' + index + '.json'),
              tracePath: join(output, 'browser-trace-' + index + '.json'),
              rawFeedback: rawFeedbackSelection ? {...rawFeedbackSelection, artifactPath: join(output, 'browser-feedback-' + index + '.raw.json')} : null}, output, signal});
        } catch (error) {
          signal?.throwIfAborted();
          nativeGenericObservation = {kind: 'generic-windowserver-observation-1', sessionId: discreteInputSessionId, qualification: false,
            missing: ['generic-native-setup-unavailable'], failures: [{name: String(error?.name ?? 'Error'), message: String(error?.message ?? error).slice(0, 1024)}],
            evidenceAdmission: error?.sessionEvidenceAdmission ?? null, evidenceVolumeStatus: error?.evidenceVolumeStatus ?? null};
        }
      }
      if (textSelected) {
        try {
          if (['textInputSessionId', 'textAttempt', 'textSessionStart', 'textInputHook', 'textSessionEnd'].some(key => context.services?.[key] !== undefined)) throw Error('A text native selection cannot replace an existing text input hook');
          textBinding = await textFeedbackInvocation({cell, sample, serial: index, sessionId: discreteInputSessionId, fixture,
            runtime: nativeBrowserRuntime, processIdentity: context.processIdentity, output, rawFeedbackSelection});
          const {prepareTextWindowServer} = await import('./windowserver-text-actions.mjs');
          nativeText = await prepareTextWindowServer({configuration: browserOptions.windowServerTextActions, runtime: nativeBrowserRuntime,
            sessionId: discreteInputSessionId, invocation: textBinding.invocation, textAttempt: textBinding.textAttempt, fixture, output, signal});
          textServices = createTextFeedbackServices({native: nativeText, trace, rawFeedbackSelected: !!rawFeedbackSelection,
            sessionId: discreteInputSessionId, plan: textBinding.textAttempt.actionPlan.actions, textAttempt: textBinding.textAttempt, missing: rawTraceMissing});
        } catch (error) {
          signal?.throwIfAborted();
          nativeTextObservation = {kind: 'text-windowserver-observation-1', sessionId: discreteInputSessionId, qualification: false,
            missing: ['text-native-setup-unavailable'], failures: [{name: String(error?.name ?? 'Error'), message: String(error?.message ?? error).slice(0, 1024)}],
            evidenceAdmission: error?.sessionEvidenceAdmission ?? null, evidenceVolumeStatus: error?.evidenceVolumeStatus ?? null};
        }
      }
      // This window precedes the original font, worker and WASM work performed
      // by the text operation. Unscored launch/reset work remains outside it.
      // Mixed-document reloads bind a distinct, automatically observed startup
      // realm; they never stitch old and new allocation clocks together.
      if (TEXT_RESOURCE_OPERATIONS.includes(cell.operation) && browserOptions.byteAudit !== true) {
        try {
          const ownership = await ensureRendererOwnershipCapture();
          textResourceObserver = createTextResourceObserver({page, cell, sample, serial: index, fixtureIdentity: fixture.seal.sha256,
            processIdentity: context.processIdentity, rendererOwnershipProof: ownership.proof, executableIdentity: textResourceExecutableIdentity(),
            output, journal: context.trace});
          await textResourceObserver.begin();
        } catch {rawTraceMissing.push('ordinary-text-resource-observation-start-unavailable');}
      }
      const module = cell.operation.startsWith('text.') ? await import('./browser-text.mjs') : null;
      if (ORDINARY_TEXT_OPERATIONS.includes(cell.operation) && browserOptions.byteAudit !== true) {
        if (context.services?.ordinaryText !== undefined) throw Error('An external service cannot replace ordinary text observation');
        ordinaryText = createOrdinaryTextObserver({page, repo, root, cell, sample, serial: index, fixture, runtime: nativeBrowserRuntime,
          environment: context.ordinaryTextEnvironment, processIdentity: context.processIdentity, output, signal, journal: context.trace});
      }
      if (context.services?.compositionObservation !== undefined) throw Error('An external service cannot replace ordinary composition observation');
      if (ORDINARY_COMPOSITION_OPERATIONS.includes(cell.operation) && browserOptions.byteAudit !== true) {
        ordinaryComposition = createOrdinaryCompositionObserver({page, cell, sample, serial: index, fixture, runtime: nativeBrowserRuntime,
          environment: context.ordinaryCompositionEnvironment, processIdentity: context.processIdentity, output, signal, journal: context.trace});
      }
      let nativeIme;
      if (cell.operation === 'text.native-ime' && browserOptions.byteAudit !== true && browserOptions.nativeIme !== undefined) {
        if (context.services?.nativeIme !== undefined) throw Error('An external service cannot replace the native IME issuer');
        const {createNativeImeService} = await import('./browser-native-ime.mjs');
        nativeIme = createNativeImeService({page, cell, sample, serial: index, fixture, runtime: nativeBrowserRuntime,
          environment: context.nativeImeEnvironment, processIdentity: context.processIdentity,
          configuration: browserOptions.nativeIme, output, signal, journal: context.trace});
      } else if (context.services?.nativeIme !== undefined) throw Error('Native IME requires explicit owned selection');
      if (module) result = await module.runTextBrowserCell({ page, cell, fixture, repo, signal, services: {...context.services, ...textServices, ...(nativeIme ? {nativeIme} : {}), ...(ordinaryText ? {ordinaryText} : {})} });
      else if (queueOperations.has(cell.operation)) {
        const { runQueueBrowserCell } = await import('./browser-queue.mjs');
        const action = () => runQueueBrowserCell({ page, cell, fixture, server, controls, signal, services: { restartBrowser: request => restartQueueProcess('browser', request), restartBackend: request => restartQueueProcess('backend', request),
          ...(ordinaryComposition ? {compositionObservation: ordinaryComposition} : {}) } });
        result = ordinaryComposition ? await ordinaryComposition.observe(action) : await action();
      }
      else if (cell.operation.startsWith('adapter.')) {
        const { runAdapterBrowserCell } = await import('./browser-adapters.mjs');
        result = await runAdapterBrowserCell({ page, cell, fixture, signal, backend: { root, server, adapterLibrary, closeDocumentConsumers } });
      } else {
        const action = () => runBrowserAction({ page, cell, fixture, signal, pair: () => server.pair(), services: { ...context.services,
        ...(ordinaryComposition ? {compositionObservation: ordinaryComposition} : {}),
        ...(nativeNavigation ? {nativeNavigation} : {}),
        discreteInputSessionId, ...(nativeFirstUse ? {discreteInputHook: nativeFirstUse.hook, discreteFirstUseReady: nativeFirstUse.ready} : {}), retainDiscreteInputFailure: value => { discreteInputFailure = value; },
        ...(genericSelected ? {genericInputEnabled: true} : {}),
        ...(nativeGeneric ? {discreteInputHook: nativeGeneric.hook, genericPointerHook: nativeGeneric.hook,
          genericSessionStart: async () => {const anchor = await nativeGeneric.start();
            if (rawFeedbackSelection && anchor?.status === 'complete') try {const started = await trace.start(); if (started?.status === 'unavailable') rawTraceMissing.push('raw-feedback-start-unavailable');} catch {rawTraceMissing.push('raw-feedback-start-unavailable');}
            else if (rawFeedbackSelection) rawTraceMissing.push('raw-feedback-native-start-unavailable');
            return anchor;},
          genericSessionEnd: observed => endGenericFeedbackSession({native: nativeGeneric, trace, rawFeedbackSelected: !!rawFeedbackSelection,
            sessionId: discreteInputSessionId, observed, missing: rawTraceMissing})} : {}),
        gestures, lifecycleCycle, verifyDecodedReadiness: readinessController.verifyDecodedReadiness, observeAdoption: readinessController.observeAdoption,
        verifyEncodedReadiness: readinessController.verifyEncodedReadiness, observeEncodedAdoption: readinessController.observeEncodedAdoption } });
        result = ordinaryComposition ? await ordinaryComposition.observe(action) : await action();
      }
      if (d11Collector && cell.operation === 'text.mixed-ready') {
        const initialization = await module.runTextBrowserCell({ page, cell: { ...cell, operation: 'text.active-layout' }, fixture, repo, signal });
        auditAction = { operation: 'text.active-layout', scope: 'explicit-unscored-text-engine-byte-initialization', originalOperation: cell.operation, observations: initialization.observations, outcome: initialization.status };
        if (String(initialization.status).toUpperCase() === 'FAIL') result.status = 'FAIL';
      }
      await Promise.all([...pendingReplies]);
      const phaseSnapshot = await readPhaseSnapshot(page);
      evidence = { productPhases: phaseSnapshot, observedCommandReceipts: commandReceipts.slice(receiptStart), rawVisits: rawVitals.snapshot(), replacedRealms, readiness: readinessEvidence };
      if (nativeNavigation) result = {...result, productPhases: phaseSnapshot,
        navigationSemantic: {kind: 'navigation-semantic-witness-1', navigationNonce: nativeNavigation.navigationNonce,
          status: phaseSnapshot?.navigationStatus ?? null}};
      if (d11Collector) {
        ({ d11, evidence: featureAbsence } = splitFeatureBoundarySnapshot(await d11Collector.snapshot())); auditActive = false;
        if (featureActions.includes('export.first-use-ready')) featureAudits.push(await runExportFeatureAudit({ page, collector: d11Collector,
          boundary: featureBoundary, startup: d11, id: auditId, cache: visitCohort.cache, workload: cell.workload, signal }));
      }
    } catch (error) {
      retainFailure(error);
      const observations = discreteInputFailure ?? ownFailureData(error, 'observations');
      if (observations) result = { observations };
    }
    finally {
      // Seal even when the action throws before producing result.observations.
      // Resource diagnostics never erase the original action failure.
      if (textResourceObserver) try {
        const observed = await textResourceObserver.finish({failed: !browserActionOutcome({...failureState, resultStatus: result?.status}).actionCompleted});
        const {proof, ...observation} = observed; textResources = observation; textResourceProof = proof;
      } catch (error) {
        rawTraceMissing.push('ordinary-text-resource-observation-closure-unavailable');
        if (error?.textResourceArtifact) textResourceFailure = {artifact: error.textResourceArtifact, missing: ['text-resource-evidence-invalid']};
      }
      // The text driver normally closes at its retained endpoint. Its hook is
      // idempotent, so a thrown/older driver also drains without inventing a
      // successful segment or delaying native end until raw-file replay.
      if (textServices) try {await textServices.textSessionEnd({sessionId: discreteInputSessionId,
        segment: result?.observations?.segment, actions: result?.observations?.actions});}
      catch {rawTraceMissing.push('text-native-final-end-unavailable');}
      // Close a selected raw trace before potentially long native byte replay,
      // including failure paths that did not reach the normal session-end hook.
      if (rawFeedbackSelection) try {await trace.stop();} catch {rawTraceMissing.push('raw-feedback-final-stop-unavailable');}
      if (nativeText) {
        let actionCompleted = false;
        if (browserActionOutcome({...failureState, resultStatus: result?.status}).actionCompleted) try {
          textRawFeedbackCohort({...result?.observations, plan: textBinding.textAttempt.actionPlan.actions}); actionCompleted = true;
        } catch {rawTraceMissing.push('text-native-original-segment-incomplete');}
        try {nativeTextObservation = await nativeText.finish({result, actionCompleted});}
        catch (error) {nativeTextObservation = {kind: 'text-windowserver-observation-1', sessionId: discreteInputSessionId, qualification: false,
          missing: ['text-native-closure-unavailable'], failures: [{name: String(error?.name ?? 'Error'), message: String(error?.message ?? error).slice(0, 1024)}]};}
      }
      if (nativeGeneric) {
        try {nativeGenericObservation = await nativeGeneric.finish({result, actionCompleted: browserActionOutcome({...failureState, resultStatus: result?.status}).actionCompleted});}
        catch (error) {nativeGenericObservation = {kind: 'generic-windowserver-observation-1', sessionId: discreteInputSessionId, qualification: false,
          missing: ['generic-native-closure-unavailable'], failures: [{name: String(error?.name ?? 'Error'), message: String(error?.message ?? error).slice(0, 1024)}]};}
      }
      if (nativeNavigation) {
        try {
          const observed = await nativeNavigation.finish({result, actionCompleted: browserActionOutcome({...failureState, resultStatus: result?.status}).actionCompleted});
          nativeNavigationObservation = observed.observation; navigationProof = observed.proof;
        } catch (error) {
          nativeNavigationObservation = {kind: 'navigation-windowserver-observation-1', qualification: false,
            missing: ['native-navigation-closure-unavailable'], failures: [{name: String(error?.name ?? 'Error'), message: String(error?.message ?? error).slice(0, 1024)}]};
        }
      }
      if (nativeFirstUse) {
        try { nativeFirstUseObservation = await nativeFirstUse.finish({result, actionCompleted: browserActionOutcome({...failureState, resultStatus: result?.status}).actionCompleted}); }
        catch (error) { nativeFirstUseObservation = {kind: 'first-use-windowserver-observation-1', qualification: false,
          missing: ['native-first-use-closure-unavailable'], failures: [{name: String(error?.name ?? 'Error'), message: String(error?.message ?? error).slice(0, 1024)}]}; }
      }
      if (ordinaryText) try {
        const observed = await ordinaryText.finish(); ordinaryTextObservation = observed.observation; ordinaryTextProof = observed.proof;
        if (result?.observations) result.observations.ordinaryText = ordinaryTextObservation;
        if (ordinaryTextObservation.analysis.failures.length) retainFailure(Error('Ordinary text observation contradiction: ' + ordinaryTextObservation.analysis.failures.join(', ')));
      } catch (error) {rawTraceMissing.push('ordinary-text-observation-closure-unavailable');}
      if (ordinaryComposition) try {
        const observed = await ordinaryComposition.finish({failed: !browserActionOutcome({...failureState, resultStatus: result?.status}).actionCompleted});
        ordinaryCompositionObservation = observed.observation; ordinaryCompositionProof = observed.proof;
        result = {...result, observations: {...(result?.observations ?? result), ordinaryComposition: ordinaryCompositionObservation}};
        if (ordinaryCompositionObservation.analysis.failures.length) retainFailure(Error('Ordinary composition observation contradiction: ' + ordinaryCompositionObservation.analysis.failures.join(', ')));
      } catch {rawTraceMissing.push('ordinary-composition-observation-closure-unavailable');}
      if (auditActive) try { ({ d11, evidence: featureAbsence } = splitFeatureBoundarySnapshot(await d11Collector.snapshot())); } catch (error) { retainFailure(error); }
      const endMs = monotonic(); phases.push({ name: 'browser.action', startMs, endMs, durationMs: endMs - startMs, clock: 'runner-monotonic', scope: 'includes Playwright action/witness/trace overhead; never narrower child budget' });
    }
    let finalTrace = null;
    if (trace) try {finalTrace = await trace.stop();}
    catch (error) {if (!rawFeedbackSelection) throw error; rawTraceMissing.push('raw-feedback-artifact-closure-unavailable');
      finalTrace = {kind: 'browser-trace-unavailable', artifact: null, rawFeedback: {manifest: null, analysis: null,
        missing: ['raw-feedback-artifact-closure-unavailable'], qualification: false}};}
    if (rawFeedbackSelection) rawTraceMissing.push(...genericRawFeedbackMissing(finalTrace));
    activeQueueTrace = undefined;
    const traced = traceSegments.length ? { ...(finalTrace ?? traceSegments.at(-1)), segments: [...traceSegments, ...(finalTrace ? [finalTrace] : [])], kind: 'separate-real-process-trace-segments', clocksJoinedBySubtraction: false } : finalTrace;
    if (browserOptions.byteAudit === true && navigations.has(cell.operation)) {
      try { await releasePendingPhaseSnapshots(page); await page.goto('about:blank'); } catch (error) { retainFailure(error); }
    }
    if (browserOptions.byteAudit !== true && vitalOperations.has(cell.operation) && canonicalVitals) {
      const expectedVisits = currentVisitId ? [currentVisitId] : canonicalVitals.visits().filter(visit => !initialVisitIds.includes(visit.visitId)).map(visit => visit.visitId);
      try { await releasePendingPhaseSnapshots(page); await page.goto('about:blank'); }
      catch (error) { retainFailure(error); }
      visits = canonicalVitals.snapshot({ ...visitCohort, expectedVisits });
      // New INP visits need a new document lifecycle. Reopen after the scored
      // visit has finalized; the next reset still proves its exact warm state.
      if (!navigations.has(cell.operation)) {
        try { await releasePendingPhaseSnapshots(page); await page.goto(await server.pair()); await ready(page); await openDocument(page, fixture); }
        catch (error) { retainFailure(error); }
      }
    }
    const prerequisiteFailure = browserActionOutcome(failureState).prerequisiteFailure;
    const byteAudit = browserOptions.byteAudit === true;
    const missing = [...(byteAudit ? d11?.missing ?? ['The explicit byte audit did not reach its actual ready boundary'] : result?.missing ?? []), ...(readinessEvidence?.missing ?? []), ...(prerequisiteFailure ? [browserActionOutcome(failureState).error?.message ?? 'Campaign prerequisite unavailable'] : [])];
    if (featureActions.length) {
      missing.push(...(featureAbsence?.missing ?? ['Required startup Export absence proof unavailable']));
      if (featureAbsence?.status !== 'PASS' && featureAbsence?.status !== 'FAIL') missing.push('Startup Export absence proof is incomplete');
      if (featureActions.includes('export.first-use-ready') && featureAudits.length !== 1) missing.push('Required separate W1 Export first-use action is absent');
      for (const audit of featureAudits) {
        missing.push(...audit.missing);
        if (audit.status !== 'PASS' && audit.status !== 'FAIL') missing.push('Separate Export first-use proof is incomplete');
      }
    }
    missing.push(...(nativeNavigationObservation?.missing ?? []));
    missing.push(...(nativeFirstUseObservation?.missing ?? []));
    missing.push(...(nativeGenericObservation?.missing ?? []));
    missing.push(...(nativeTextObservation?.missing ?? []));
    missing.push(...rawTraceMissing);
    missing.push(...(ordinaryTextObservation?.analysis.missing ?? []));
    missing.push(...(ordinaryCompositionObservation?.analysis.missing ?? []));
    missing.push(...(textResources?.missing ?? []));
    const measured = byteAudit ? { measurements: [], unavailable: [] } : extractBrowserMeasurements({ cell, sample, visits, result, evidence, trace: traced, resources, ordinaryTextProof, ordinaryCompositionProof, navigationProof, navigationObservation: nativeNavigationObservation, textResourceProof });
    missing.push(...measured.unavailable.filter(row => row.source !== 'separate-byte-audit').map(row => row.name + ': ' + row.reason));
    if (!byteAudit && !evidence?.productPhases) missing.push('Product phase snapshot unavailable');
    if (!byteAudit && vitalOperations.has(cell.operation) && !canonicalVitals) missing.push(canonicalMissing ?? 'Pinned canonical Web Vitals observer unavailable');
    const navigationBounds = !byteAudit && cell.operation === 'navigation.ready' && ['W0', 'W1'].includes(cell.workload)
      ? readVerifiedNavigationBounds(navigationProof, nativeNavigationObservation, {cell, sample}) : null;
    const navigationPresentation = navigationBounds && ['shell', 'canvas'].every(key => Number.isFinite(navigationBounds[key]?.upperBoundMs) &&
      navigationBounds[key].upperBoundMs >= 0 && navigationBounds[key].upperBoundMs <= navigationBounds[key].ceilingMs) &&
      navigationBounds.semantic?.complete === true && navigationBounds.semantic.falsePendingOrCompletionCount === 0 &&
      !(cell.requiredMeasurements ?? []).some(row => row.budgetId === 'R07');
    if (!byteAudit && cell.requirements?.presentationTrace !== false && !navigationPresentation) missing.push(cell.operation === 'navigation.ready'
      ? 'Navigation requires independently replayed native shell and usable-canvas presentation bounds'
      : 'Actual display presentation and complete R07 application attribution are not established by renderer Paint/DrawFrame');
    if (!byteAudit && (context.headless ?? browserOptions.headless)) missing.push('Headless browser cannot establish the required H display environment');
    const network = egress.evidence();
    if (sample.cache === 'warm' && !egress.supported) missing.push('This browser engine retains a route-based egress guard that disables HTTP cache');
    if (egress.supported && !network.counts.accepted) missing.push('No actual product request traversed the configured cache-preserving proxy');
    if (errors.length > errorStart || external.length > externalStart) retainFailure(Error('Unexpected browser failure or attempted external request'));
    const outcome = browserActionOutcome({...failureState, resultStatus: result?.status, d11Status: d11?.status,
      nativeEvidenceStatuses: [navigationBounds?.semantic?.complete === true && navigationBounds.semantic.falsePendingOrCompletionCount > 0 ? 'FAIL' : null,
        nativeNavigationObservation?.evidenceVolumeStatus, nativeGenericObservation?.evidenceVolumeStatus, nativeTextObservation?.evidenceVolumeStatus, featureAbsence?.status, ...featureAudits.map(audit => audit.status)], missing, byteAudit});
    const status = outcome.status;
    const session = byteAudit ? null : interactionSession(cell, sample, result, traced, visibility);
    if (session && nativeGenericObservation) session.nativePresentation = nativeGenericObservation;
    const firstUseSource = result?.observations ?? result;
    const firstUse = cell.operation === 'interaction.first-use' && firstUseSource ? { id: String(cell.id) + ':' + String(sample.ordinal), reset: sample.cache === 'cold' && index === 1,
      startMs: firstUseSource.startMs, endMs: firstUseSource.endMs, captureStoppedMs: firstUseSource.captureStoppedMs,
      inputMs: firstUseSource.inputMs ?? firstUseSource.discreteInput?.inputMs ?? null,
      inputClock: firstUseSource.inputClock ?? firstUseSource.discreteInput?.clock,
      inputTimeOrigin: firstUseSource.inputTimeOrigin ?? firstUseSource.discreteInput?.timeOrigin,
      discreteInput: firstUseSource.discreteInput, ...(nativeFirstUseObservation ? {nativePresentation: nativeFirstUseObservation} : {}),
      ...(firstUseSource.nativeReadiness ? {nativeReadiness: firstUseSource.nativeReadiness} : {}),
      readyMs: firstUseSource.readyMs, readyClock: firstUseSource.readyClock,
      windowClock: firstUseSource.windowClock, presentedMs: null, meaningful: firstUseSource.meaningful, feature: firstUseSource.feature,
      trace: { kind: 'browser-diagnostic-trace', sha256: traced.artifact?.sha256 ?? null, attributionComplete: false },
      outcome: outcome.actionCompleted ? 'expected' : 'failed', resetEvidence: { freshBrowserContext: index === 1, fixtureCopiedBeforeLaunch: true, browserPid: browserServer.process().pid, backendPid: server.pid } } : null;
    const receipt = { cellId: cell.id, operation: cell.operation, status, elapsedMs: monotonic() - startMs, phases: [...phases, ...(result?.phases ?? []), ...(readOrdinaryTextProof(ordinaryTextProof)?.phases ?? [])], measurements: measured.measurements, measurementUnavailable: measured.unavailable, observations: result?.observations ?? result ?? null, evidence, network, ...(visits ? { visits } : {}), ...(session ? { session } : {}), ...(firstUse && !byteAudit ? { firstUse } : {}), ...(d11 ? { d11 } : {}), ...(featureActions.length ? { featureAbsence: featureAbsence ?? null, featureAudits } : {}), ...(auditAction ? { auditAction } : {}), timingSamplesReusable: !byteAudit, trace: traced, missing, error: outcome.error, rawConsoleRetained: false, screenshotsRetained: false, clocksJoinedBySubtraction: false };
    receipt.failureClassification = outcome.failureClassification;
    if (nativeNavigationObservation) receipt.nativeNavigation = nativeNavigationObservation;
    if (nativeFirstUseObservation && !firstUse) receipt.nativeFirstUse = nativeFirstUseObservation;
    if (nativeGenericObservation && !session) receipt.nativeGeneric = nativeGenericObservation;
    if (nativeTextObservation) receipt.nativeText = nativeTextObservation;
    if (textBinding) receipt.textFeedback = textBinding;
    if (textResources) receipt.textResources = textResources;
    if (textResourceFailure) receipt.textResourceFailure = textResourceFailure;
    const file = join(output, 'browser-cell-' + index + '.json'); await writeFile(file, JSON.stringify(sanitize(receipt), null, 2), { mode: 0o600, flag: 'wx' });
    previousResult = result ?? receipt;
    return { ...receipt, artifacts: [file, textResources?.artifact?.path, textResourceFailure?.artifact?.path, ...(traced.segments ?? [traced]).map(item => item.artifact?.path)].filter(Boolean) };
  }

  async function close() {
    if (closed) return; closed = true; const failures = [];
    if (resourceSampler) try { await boundedClose(() => resourceSampler.stop()); } catch { failures.push('Owned resource sampler did not seal'); }
    if (page && !page.isClosed()) try { await boundedClose(() => releasePendingPhaseSnapshots(page)); } catch { failures.push('Scoped product observation handle release failed'); }
    if (page && !page.isClosed()) try { await boundedClose(() => page.goto('about:blank')); } catch { failures.push('Final real visit navigation failed'); }
    if (rawVitals) { try { await exclusiveJSON(join(output, 'browser-raw-visits.json'), rawVitals.snapshot()); } catch { failures.push('Raw visit receipt could not be retained'); } rawVitals.close(); }
    if (canonicalVitals) { try { await exclusiveJSON(join(output, 'browser-canonical-visits.json'), canonicalVitals.snapshot()); } catch { failures.push('Canonical visit receipt could not be retained'); } canonicalVitals.close(); }
    for (const work of [() => backendAdapter?.close(), () => hmrAdapter?.close(), () => d11Collector?.close(), () => lifecycleOracle?.close(), () => lifecycleCounters?.close(), () => adapterLifecycle?.close(), () => waObservation?.close(), () => browserContext?.close(), () => browser?.close(), () => browserServer?.close(), () => server?.close(), () => queueProvider?.close(), () => egress?.close()]) {
      try { await boundedClose(work); } catch { failures.push('Owned resource close failed'); }
    }
    if (failures.length && browserServer) try { await boundedClose(() => browserServer.kill()); } catch { failures.push('Owned browser forced termination failed'); }
    if (serverChild && serverChild.exitCode === null) { serverChild.kill('SIGTERM'); failures.push('Backend remained live after owner close; owned child terminated'); }
    await writeFile(join(output, 'browser-close.json'), JSON.stringify({ closed: !failures.length, failures, resourceSamples: resources.length, unexpectedExternalRequests: external.length, pageErrors: errors.length, fixtureRetained: root ?? null }, null, 2), { mode: 0o600, flag: 'wx' });
    if (failures.length) throw new AggregateError(failures.map(message => Error(message)), 'Browser campaign close incomplete');
  }
  return { prepareCell, resetCell, execute, close, measureResources, beginResourceWindow, endResourceWindow, lifecycleCycle, finalizeLifecycle, lifecycleIdentity, resourceSamplingEvidence, restartWorker,
    get fixtureIdentity() { return fixture?.seal?.sha256 ?? null; },
    get weightsIdentity() { return adapterLifecycle?.weightsIdentity ?? adapterLibrary?.fixtureManifest?.weights.find(item => item.bytes === 256 * 1048576)?.hash ?? null; },
    get configIdentity() { return adapterLifecycle?.configIdentity ?? adapterLibrary?.fixtureManifest?.config?.hash ?? null; } };
}
