import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { digest, monotonic } from './common.mjs';
import { isRendererTextureNotApplicable, isAppOwnedAllocationPoint } from './renderer-ownership.mjs';
import { appOwnedCpuCandidate } from './resource-sampling-verification.mjs';
import { RESOURCE_SAMPLE_CODEC, createBrowserResourceSampleContext, encodeBrowserResourceSample } from './resource-sample-codec.mjs';
import { createResourceObservationSummary } from './resource-observations.mjs';
import { readPhaseSnapshot } from './browser-phase-snapshot.mjs';

const execute = promisify(execFile);
const INTERVAL_MS = 100, MAX_ENTRIES = 100_000, MAX_BYTES = 256 * 1024 * 1024;
const allocationKeys = ['cpuBytes', 'gpuBytes', 'previewCacheBytes', 'unusedHandles', 'textureSide', 'deviceTextureLimit'];
const coverageKeys = ['cpu', 'gpu', 'previewCache', 'handles', 'textureLimits'];
const lifecycleKeys = new Set(['uploads', 'draftReads', 'decodedBitmaps', 'canvasReads', 'reviewObjectURLs', 'inspectorDrafts', 'promptCharacters', 'nativeTextActive', 'nativeTextPending', 'nativeTextCharacters', 'nativeTextFiles', 'nativePreviewBytes', 'nativeWorkers', 'fontBackingBytes', 'maskDrafts', 'compositionModels']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const pid = value => integer(value) && value > 0;
const birthPattern = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/;

function combinedCpuProjection(value) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const time = n => Number.isFinite(n) && n >= 0 ? n : null;
  const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
  const codes = v => Array.isArray(v) && v.length <= 16 && v.every(s => typeof s === 'string' && /^[a-z0-9-]{1,96}$/.test(s)) ? [...v] : null;
  if (value?.kind !== 'combined-cpu-observation-1' || value.schemaVersion !== 1 || value.scope !== 'browser-ledger-plus-text-reservations') return null;
  const w = value.window;
  const window = w?.kind === 'combined-cpu-window-1' && w.schemaVersion === 1 ? {
    kind: w.kind, schemaVersion: 1, ledgerInstanceId: id(w.ledgerInstanceId), id: id(w.id), ordinal: count(w.ordinal),
    clock: w.clock === 'browser-performance' ? w.clock : null, clockOriginMs: time(w.clockOriginMs), startMs: time(w.startMs), endMs: time(w.endMs), peakAtMs: time(w.peakAtMs),
    startSequence: count(w.startSequence), endSequence: count(w.endSequence), peakSequence: count(w.peakSequence), currentBytes: count(w.currentBytes), peakBytes: count(w.peakBytes),
    ledgerBytesAtPeak: count(w.ledgerBytesAtPeak), textBytesAtPeak: count(w.textBytesAtPeak), textStartSequence: count(w.textStartSequence), textEndSequence: count(w.textEndSequence),
    sealed: w.sealed === true, observationComplete: w.observationComplete === true, ownerCoverageComplete: w.ownerCoverageComplete === true, failures: codes(w.failures), missing: codes(w.missing),
  } : null;
  return { kind: value.kind, schemaVersion: 1, scope: value.scope, ledgerInstanceId: id(value.ledgerInstanceId), sequence: count(value.sequence),
    currentBytes: count(value.currentBytes), observedPeakBytes: count(value.observedPeakBytes), observationComplete: value.observationComplete === true,
    ownerCoverageComplete: value.ownerCoverageComplete === true, missing: codes(value.missing), window };
}

function appOwnershipProjection(value) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const time = n => Number.isFinite(n) && n >= 0 ? n : null;
  const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
  const order = ['copy', 'staging', 'scratch', 'blob', 'font', 'text', 'canvas', 'bitmap', 'prompt', 'control'];
  const vector = v => v && typeof v === 'object' ? Object.fromEntries(['cpuBytes', 'gpuBytes', 'previewCacheBytes', 'handles'].map(k => [k, count(v[k])])) : null;
  const state = v => v && typeof v === 'object' ? { records: count(v.records), ...vector(v) } : null;
  const rows = (v, window) => Array.isArray(v) && v.length === order.length && v.every((row, i) => row?.kind === order[i]) ? v.map(row => window ? {
    kind: row.kind, initial: state(row.initial), current: state(row.current),
    transitions: row.transitions && typeof row.transitions === 'object' ? Object.fromEntries(['reserved', 'resized', 'released', 'observed'].map(k => [k, count(row.transitions[k])])) : null,
    added: vector(row.added), removed: vector(row.removed),
  } : { kind: row.kind, ...state(row) }) : null;
  if (value?.kind !== 'app-ownership-observation-1' || value.schemaVersion !== 1) return null;
  const p = value.point, w = value.window;
  const point = p?.kind === 'app-ownership-point-1' && p.schemaVersion === 1 ? {
    kind: p.kind, schemaVersion: 1, ledgerInstanceId: id(p.ledgerInstanceId), transitionSequence: count(p.transitionSequence), cpuSequence: count(p.cpuSequence),
    clock: p.clock === 'browser-performance' ? p.clock : null, clockOriginMs: time(p.clockOriginMs), atMs: time(p.atMs), totals: vector(p.totals),
    centralCpuBytes: count(p.centralCpuBytes), textBytes: count(p.textBytes), textSequence: count(p.textSequence), kinds: rows(p.kinds, false),
    observationComplete: p.observationComplete === true, globalCoverageComplete: p.globalCoverageComplete === true,
  } : null;
  const failures = v => Array.isArray(v) && v.length <= 8 && v.every(s => typeof s === 'string' && /^[a-z0-9-]{1,96}$/.test(s)) ? [...v] : null;
  const window = w?.kind === 'app-ownership-window-1' && w.schemaVersion === 1 ? {
    kind: w.kind, schemaVersion: 1, scope: w.scope === 'application-owned-conservative-reservations' ? w.scope : null,
    ledgerInstanceId: id(w.ledgerInstanceId), id: id(w.id), ordinal: count(w.ordinal), clock: w.clock === 'browser-performance' ? w.clock : null,
    clockOriginMs: time(w.clockOriginMs), startMs: time(w.startMs), endMs: time(w.endMs), cpuStartSequence: count(w.cpuStartSequence), cpuEndSequence: count(w.cpuEndSequence),
    ledgerStartSequence: count(w.ledgerStartSequence), ledgerEndSequence: count(w.ledgerEndSequence), lastTransitionSequence: count(w.lastTransitionSequence),
    sealed: w.sealed === true, budgetRefusals: count(w.budgetRefusals), kinds: rows(w.kinds, true),
    text: w.text && typeof w.text === 'object' ? { initialBytes: count(w.text.initialBytes), currentBytes: count(w.text.currentBytes), startSequence: count(w.text.startSequence), endSequence: count(w.text.endSequence), observationComplete: w.text.observationComplete === true } : null,
    peaks: w.peaks && typeof w.peaks === 'object' ? Object.fromEntries(['gpuBytes', 'previewCacheBytes', 'handles'].map(k => [k, count(w.peaks[k])])) : null,
    observationComplete: w.observationComplete === true, reconciled: w.reconciled === true, failures: failures(w.failures), globalCoverageComplete: w.globalCoverageComplete === true,
  } : null;
  return { kind: value.kind, schemaVersion: 1, ledgerInstanceId: id(value.ledgerInstanceId), transitionSequence: count(value.transitionSequence), point, window };
}

function cpuAckProjection(value) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const time = n => Number.isFinite(n) && n >= 0 ? n : null;
  const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
  if (value?.kind !== 'combined-cpu-window-ack-1' || value.schemaVersion !== 1) return null;
  return { kind: value.kind, schemaVersion: 1, ledgerInstanceId: id(value.ledgerInstanceId), id: id(value.id), ordinal: count(value.ordinal),
    boundary: ['begin', 'end'].includes(value.boundary) ? value.boundary : null, sequence: count(value.sequence), atMs: time(value.atMs),
    clock: value.clock === 'browser-performance' ? value.clock : null, clockOriginMs: time(value.clockOriginMs), sealed: value.sealed === true };
}

function rendererProjection(value) {
  if (!value || typeof value !== 'object') return null;
  const label = item => typeof item === 'string' && /^[a-z0-9-]{1,80}$/.test(item) ? item : null;
  return { contract: label(value.contract), backend: label(value.backend),
    appOwnedTextureAPIs: Array.isArray(value.appOwnedTextureAPIs) && value.appOwnedTextureAPIs.length <= 16 && value.appOwnedTextureAPIs.every(item => label(item) !== null) ? [...value.appOwnedTextureAPIs] : null,
    appOwnedTextureCount: integer(value.appOwnedTextureCount) ? value.appOwnedTextureCount : null,
    textureLimitApplicability: label(value.textureLimitApplicability),
    rgbaBackingEstimateBytes: integer(value.rgbaBackingEstimateBytes) ? value.rgbaBackingEstimateBytes : null };
}

/** Only the requested numeric columns are accepted; argv and command names never enter evidence. */
export function parseResourceProcesses(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4 * 1024 * 1024) throw Error('Invalid process table');
  const rows = [], seen = new Set();
  for (const line of stdout.split('\n').filter(line => line.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw Error('Malformed process RSS row');
    const [processId, parentId, rssKiB] = match.slice(1).map(Number);
    if (!pid(processId) || !integer(parentId) || !integer(rssKiB * 1024) || seen.has(processId)) throw Error('Invalid or duplicate process identity');
    seen.add(processId); rows.push({ pid: processId, ppid: parentId, rssBytes: rssKiB * 1024 });
  }
  return rows;
}

export function parseResourceBirths(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 1024 * 1024) throw Error('Invalid process birth table');
  const rows = [], seen = new Set();
  for (const line of stdout.split('\n').filter(line => line.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    const processId = Number(match?.[1]), groupId = Number(match?.[2]), startedAtIdentity = match?.[3];
    if (!pid(processId) || !pid(groupId) || !birthPattern.test(startedAtIdentity ?? '') || seen.has(processId)) throw Error('Malformed process birth identity');
    seen.add(processId); rows.push({ pid: processId, pgid: groupId, startedAtIdentity });
  }
  return rows;
}

export function resourceProcessTree(rows, root) {
  if (!rows.some(row => row.pid === root)) return [];
  const selected = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (selected.has(row.ppid) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; }
  }
  return rows.filter(row => selected.has(row.pid));
}

/** Lifecycle counters diagnose known document consumers; they are not a complete handle ledger. */
export function resourceProductProjection(value, rendererOwnershipProof = null) {
  const allocations = value?.allocations, values = Object.fromEntries(allocationKeys.map(key => [key, integer(allocations?.[key]) ? allocations[key] : null]));
  const globalAllocationCoverage = { complete: allocations?.complete === true, ...Object.fromEntries(coverageKeys.map(key => [key, allocations?.coverage?.[key] === true])) };
  const combinedCpu = combinedCpuProjection(allocations?.combinedCpu), appOwnership = appOwnershipProjection(allocations?.appOwnership);
  const scopeKey = { cpu: 'cpuBytes', gpu: 'gpuBytes', previewCache: 'previewCacheBytes', handles: 'handles' };
  const scoped = Object.fromEntries(Object.entries(scopeKey).map(([key, resourceKey]) => [key,
    isAppOwnedAllocationPoint(rendererOwnershipProof, { appOwnership, combinedCpu, resourceKey }) &&
    (resourceKey === 'handles' ? integer(values.unusedHandles) && values.unusedHandles <= appOwnership.point.totals.handles : appOwnership.point.totals[resourceKey] === values[resourceKey])
  ]));
  const coverage = Object.fromEntries(coverageKeys.map(key => [key, globalAllocationCoverage[key] === true || scoped[key] === true]));
  const rendererOwnership = rendererProjection(allocations?.rendererOwnership);
  const textureNotApplicable = values.textureSide === null && values.deviceTextureLimit === null && isRendererTextureNotApplicable(rendererOwnership, rendererOwnershipProof, { gpuBytes: values.gpuBytes });
  const textureComplete = rendererOwnership?.textureLimitApplicability === 'not-applicable' ? textureNotApplicable : coverage.textureLimits && values.textureSide !== null && values.deviceTextureLimit > 0;
  const complete = (globalAllocationCoverage.complete || ['cpu', 'gpu', 'previewCache', 'handles'].every(key => scoped[key])) && ['cpu', 'gpu', 'previewCache', 'handles'].every(key => coverage[key]) && ['cpuBytes', 'gpuBytes', 'previewCacheBytes', 'unusedHandles'].every(key => values[key] !== null) && textureComplete;
  if (!complete) values.unusedHandles = null;
  const lifecycle = value?.lifecycle;
  const consumers = {};
  for (const name of ['editor-client', 'editor-shell']) {
    const source = lifecycle?.consumers?.[name];
    if (source && typeof source === 'object') consumers[name] = Object.fromEntries(Object.entries(source).filter(([key, item]) => lifecycleKeys.has(key) && (integer(item) || typeof item === 'boolean')));
  }
  return { values, globalAllocationCoverage, appOwnership, combinedCpu, cpuWindowAck: cpuAckProjection(value?.cpuWindowAck), allocationCoverage: { complete, ...coverage }, rendererOwnership, rendererOwnershipProof, lifecycle: lifecycle ? { releasing: typeof lifecycle.releasing === 'boolean' ? lifecycle.releasing : null, releases: integer(lifecycle.releases) ? lifecycle.releases : null, lastReleaseMilliseconds: Number.isFinite(lifecycle.lastReleaseMilliseconds) && lifecycle.lastReleaseMilliseconds >= 0 ? lifecycle.lastReleaseMilliseconds : null, consumers } : null };
}

async function productSnapshot(page, boundary = null) {
  // Only the diagnostic observation window is controlled. No cache, editor,
  // renderer, GC or resource owner is reset by these measurement boundaries.
  const cpuWindowAck = boundary ? await page.evaluate(({ boundary, id }) => {
    function cpuAckProjection(value) {
      const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
      const time = n => Number.isFinite(n) && n >= 0 ? n : null;
      const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
      if (value?.kind !== 'combined-cpu-window-ack-1' || value.schemaVersion !== 1) return null;
      return { kind: value.kind, schemaVersion: 1, ledgerInstanceId: id(value.ledgerInstanceId), id: id(value.id), ordinal: count(value.ordinal),
        boundary: ['begin', 'end'].includes(value.boundary) ? value.boundary : null, sequence: count(value.sequence), atMs: time(value.atMs),
        clock: value.clock === 'browser-performance' ? value.clock : null, clockOriginMs: time(value.clockOriginMs), sealed: value.sealed === true };
    }
    const api = globalThis.__IDEOGRAM_PHASES__;
    const action = boundary === 'begin' ? api?.beginCpuObservationWindow : api?.endCpuObservationWindow;
    if (typeof action !== 'function') throw Error('COMBINED_CPU_OBSERVER_UNAVAILABLE');
    return cpuAckProjection(action(id));
  }, boundary) : null;
  const snapshot = await readPhaseSnapshot(page, handle => {
    function appOwnershipProjection(value) {
      const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
      const time = n => Number.isFinite(n) && n >= 0 ? n : null;
      const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
      const order = ['copy', 'staging', 'scratch', 'blob', 'font', 'text', 'canvas', 'bitmap', 'prompt', 'control'];
      const vector = v => v && typeof v === 'object' ? Object.fromEntries(['cpuBytes', 'gpuBytes', 'previewCacheBytes', 'handles'].map(k => [k, count(v[k])])) : null;
      const state = v => v && typeof v === 'object' ? { records: count(v.records), ...vector(v) } : null;
      const rows = (v, window) => Array.isArray(v) && v.length === order.length && v.every((row, i) => row?.kind === order[i]) ? v.map(row => window ? {
        kind: row.kind, initial: state(row.initial), current: state(row.current),
        transitions: row.transitions && typeof row.transitions === 'object' ? Object.fromEntries(['reserved', 'resized', 'released', 'observed'].map(k => [k, count(row.transitions[k])])) : null,
        added: vector(row.added), removed: vector(row.removed),
      } : { kind: row.kind, ...state(row) }) : null;
      if (value?.kind !== 'app-ownership-observation-1' || value.schemaVersion !== 1) return null;
      const p = value.point, w = value.window;
      const point = p?.kind === 'app-ownership-point-1' && p.schemaVersion === 1 ? {
        kind: p.kind, schemaVersion: 1, ledgerInstanceId: id(p.ledgerInstanceId), transitionSequence: count(p.transitionSequence), cpuSequence: count(p.cpuSequence),
        clock: p.clock === 'browser-performance' ? p.clock : null, clockOriginMs: time(p.clockOriginMs), atMs: time(p.atMs), totals: vector(p.totals),
        centralCpuBytes: count(p.centralCpuBytes), textBytes: count(p.textBytes), textSequence: count(p.textSequence), kinds: rows(p.kinds, false),
        observationComplete: p.observationComplete === true, globalCoverageComplete: p.globalCoverageComplete === true,
      } : null;
      const failures = v => Array.isArray(v) && v.length <= 8 && v.every(s => typeof s === 'string' && /^[a-z0-9-]{1,96}$/.test(s)) ? [...v] : null;
      const window = w?.kind === 'app-ownership-window-1' && w.schemaVersion === 1 ? {
        kind: w.kind, schemaVersion: 1, scope: w.scope === 'application-owned-conservative-reservations' ? w.scope : null,
        ledgerInstanceId: id(w.ledgerInstanceId), id: id(w.id), ordinal: count(w.ordinal), clock: w.clock === 'browser-performance' ? w.clock : null,
        clockOriginMs: time(w.clockOriginMs), startMs: time(w.startMs), endMs: time(w.endMs), cpuStartSequence: count(w.cpuStartSequence), cpuEndSequence: count(w.cpuEndSequence),
        ledgerStartSequence: count(w.ledgerStartSequence), ledgerEndSequence: count(w.ledgerEndSequence), lastTransitionSequence: count(w.lastTransitionSequence),
        sealed: w.sealed === true, budgetRefusals: count(w.budgetRefusals), kinds: rows(w.kinds, true),
        text: w.text && typeof w.text === 'object' ? { initialBytes: count(w.text.initialBytes), currentBytes: count(w.text.currentBytes), startSequence: count(w.text.startSequence), endSequence: count(w.text.endSequence), observationComplete: w.text.observationComplete === true } : null,
        peaks: w.peaks && typeof w.peaks === 'object' ? Object.fromEntries(['gpuBytes', 'previewCacheBytes', 'handles'].map(k => [k, count(w.peaks[k])])) : null,
        observationComplete: w.observationComplete === true, reconciled: w.reconciled === true, failures: failures(w.failures), globalCoverageComplete: w.globalCoverageComplete === true,
      } : null;
      return { kind: value.kind, schemaVersion: 1, ledgerInstanceId: id(value.ledgerInstanceId), transitionSequence: count(value.transitionSequence), point, window };
    }
    function combinedCpuProjection(value) {
      const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
      const time = n => Number.isFinite(n) && n >= 0 ? n : null;
      const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
      const codes = v => Array.isArray(v) && v.length <= 16 && v.every(s => typeof s === 'string' && /^[a-z0-9-]{1,96}$/.test(s)) ? [...v] : null;
      if (value?.kind !== 'combined-cpu-observation-1' || value.schemaVersion !== 1 || value.scope !== 'browser-ledger-plus-text-reservations') return null;
      const w = value.window;
      const window = w?.kind === 'combined-cpu-window-1' && w.schemaVersion === 1 ? {
        kind: w.kind, schemaVersion: 1, ledgerInstanceId: id(w.ledgerInstanceId), id: id(w.id), ordinal: count(w.ordinal),
        clock: w.clock === 'browser-performance' ? w.clock : null, clockOriginMs: time(w.clockOriginMs), startMs: time(w.startMs), endMs: time(w.endMs), peakAtMs: time(w.peakAtMs),
        startSequence: count(w.startSequence), endSequence: count(w.endSequence), peakSequence: count(w.peakSequence), currentBytes: count(w.currentBytes), peakBytes: count(w.peakBytes),
        ledgerBytesAtPeak: count(w.ledgerBytesAtPeak), textBytesAtPeak: count(w.textBytesAtPeak), textStartSequence: count(w.textStartSequence), textEndSequence: count(w.textEndSequence),
        sealed: w.sealed === true, observationComplete: w.observationComplete === true, ownerCoverageComplete: w.ownerCoverageComplete === true, failures: codes(w.failures), missing: codes(w.missing),
      } : null;
      return { kind: value.kind, schemaVersion: 1, scope: value.scope, ledgerInstanceId: id(value.ledgerInstanceId), sequence: count(value.sequence),
        currentBytes: count(value.currentBytes), observedPeakBytes: count(value.observedPeakBytes), observationComplete: value.observationComplete === true,
        ownerCoverageComplete: value.ownerCoverageComplete === true, missing: codes(value.missing), window };
    }

    // This only calls the existing read-only observer and getter. No GC, editor
    // mutation, fabricated allocations, DOM text, request payload or URL is read.
    const allocations = handle?.value?.allocations;
    const lifecycle = document.querySelector('ie-shell')?.documentLifecycle;
    const allocationKeys = ['cpuBytes', 'gpuBytes', 'previewCacheBytes', 'unusedHandles', 'textureSide', 'deviceTextureLimit'];
    const coverageKeys = ['cpu', 'gpu', 'previewCache', 'handles', 'textureLimits'];
    const renderer = allocations?.rendererOwnership, label = value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value) ? value : null;
    const rendererOwnership = renderer && typeof renderer === 'object' ? { contract: label(renderer.contract), backend: label(renderer.backend), appOwnedTextureAPIs: Array.isArray(renderer.appOwnedTextureAPIs) && renderer.appOwnedTextureAPIs.length <= 16 && renderer.appOwnedTextureAPIs.every(value => label(value) !== null) ? [...renderer.appOwnedTextureAPIs] : null, appOwnedTextureCount: Number.isSafeInteger(renderer.appOwnedTextureCount) && renderer.appOwnedTextureCount >= 0 ? renderer.appOwnedTextureCount : null, textureLimitApplicability: label(renderer.textureLimitApplicability), rgbaBackingEstimateBytes: Number.isSafeInteger(renderer.rgbaBackingEstimateBytes) && renderer.rgbaBackingEstimateBytes >= 0 ? renderer.rgbaBackingEstimateBytes : null } : null;
    const values = allocations ? { complete: allocations.complete === true, coverage: Object.fromEntries(coverageKeys.map(key => [key, allocations.coverage?.[key] === true])), ...Object.fromEntries(allocationKeys.map(key => [key, Number.isSafeInteger(allocations[key]) && allocations[key] >= 0 ? allocations[key] : null])), rendererOwnership, combinedCpu: combinedCpuProjection(allocations?.combinedCpu), appOwnership: appOwnershipProjection(allocations?.appOwnership) } : null;
    const names = ['uploads', 'draftReads', 'decodedBitmaps', 'canvasReads', 'reviewObjectURLs', 'inspectorDrafts', 'promptCharacters', 'nativeTextActive', 'nativeTextPending', 'nativeTextCharacters', 'nativeTextFiles', 'nativePreviewBytes', 'nativeWorkers', 'fontBackingBytes', 'maskDrafts', 'compositionModels'];
    const consumers = Object.fromEntries(['editor-client', 'editor-shell'].filter(name => lifecycle?.consumers?.[name]).map(name => [name, Object.fromEntries(names.filter(key => typeof lifecycle.consumers[name][key] === 'boolean' || Number.isSafeInteger(lifecycle.consumers[name][key]) && lifecycle.consumers[name][key] >= 0).map(key => [key, lifecycle.consumers[name][key]]))]));
    return { allocations: values, lifecycle: lifecycle ? { releasing: lifecycle.releasing === true, releases: lifecycle.releases, lastReleaseMilliseconds: lifecycle.lastReleaseMilliseconds, consumers } : null };
  });
  return { ...snapshot, cpuWindowAck };
}

/** Fixed 100ms serial sampler. Hooks exist only for portable, service-free unit
 * tests; ordinary campaign callers supply only the first options object. */
export function createBrowserResourceSampler({ browserPid, backendPid, page, output, signal, rendererOwnershipProof = null }, hooks = {}) {
  const workerPid = hooks.workerPid ?? process.pid;
  if (![browserPid, backendPid, workerPid].every(pid) || new Set([browserPid, backendPid, workerPid]).size !== 3 || !isAbsolute(output ?? '')) throw Error('Distinct owned roots and an absolute output directory are required');
  const exec = hooks.execute ?? execute, now = hooks.now ?? monotonic, schedule = hooks.setTimeout ?? setTimeout, cancel = hooks.clearTimeout ?? clearTimeout, openFile = hooks.open ?? open;
  const readProduct = hooks.productSnapshot ?? (boundary => productSnapshot(page, boundary));
  const maxEntries = hooks.maxEntries ?? MAX_ENTRIES, maxBytes = hooks.maxBytes ?? MAX_BYTES;
  if (!integer(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES || !integer(maxBytes) || maxBytes < 16_384 || maxBytes > MAX_BYTES) throw Error('Invalid resource evidence bound');
  const productTimeoutMs = hooks.productTimeoutMs ?? 1000;
  if (!integer(productTimeoutMs) || productTimeoutMs < 1 || productTimeoutMs > 1000) throw Error('Invalid product observation deadline');
  const artifact = join(output, 'browser-resources-' + randomUUID() + '.json');
  const reasons = new Set(), births = new Map(), counts = { samples: 0, scheduled: 0, manual: 0, missedIntervals: 0, failedSamples: 0 };
  const aggregate = createResourceObservationSummary(), windows = [];
  const cpuWindowId = randomUUID(), cpuWindowScope = 'independent-B0-browser-cpu-window';
  let cpuBeginAttempted = false, cpuEndAcknowledged = false, observationWindow = null, continuousCpuPeak = null;
  let appOwnedBegin = null, appOwnedCpu = null;
  let sampleContext = null;
  const cpuWindowCleanup = { attempted: false, complete: false, ack: null, error: null };
  const footerReserve = Math.min(512 * 1024, Math.floor(maxBytes / 2));
  let activeWindow = null, interruptedWindow = null, windowSequence = 0;
  let state = 'new', roots, processIdentity = null, timer, file, hash, bytes = 0, bytesReliable = true, identityBytes = 0, sha256 = null, startMs = null, endMs = null, nextDue = null, lastScheduled = null, maximumGapMs = 0, maximumSampleDurationMs = 0, ledgerComplete = true, processComplete = true, latest = null, tail = Promise.resolve(), stopPromise, pendingProduct, productTimedOut = false;
  const command = args => exec('/bin/ps', args, { timeout: 750, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
  async function observedProduct(boundary = null) {
    // Keep at most one outstanding browser evaluation if its renderer stops
    // responding. A timeout is missing evidence, never an empty/zero ledger.
    if (pendingProduct && productTimedOut) throw Error('Previous product observation is unresolved');
    const pending = Promise.resolve().then(() => readProduct(boundary)); pendingProduct = pending;
    pending.finally(() => { if (pendingProduct === pending) { pendingProduct = undefined; productTimedOut = false; } }).catch(() => {});
    let timeout;
    try { return await Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => { productTimedOut = true; reject(Error('Product resource observation deadline')); }, productTimeoutMs); })]); }
    finally { clearTimeout(timeout); }
  }
  async function observeBirths(ids) {
    const { stdout } = await command(['-p', [...new Set(ids)].join(','), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=']);
    return parseResourceBirths(stdout);
  }
  async function write(text) {
    try { await file.writeFile(text); }
    catch (error) { bytesReliable = false; throw error; }
    hash.update(text); bytes += Buffer.byteLength(text);
  }
  function verifyRoots(current) {
    for (const root of roots ?? []) {
      const actual = current.find(row => row.pid === root.pid);
      if (!actual || actual.pgid !== root.pgid || actual.startedAtIdentity !== root.startedAtIdentity) { processComplete = false; throw Error('Owned process identity changed or exited'); }
    }
  }
  function retainBirth(entry) {
    const key = digest(entry);
    if (!births.has(key)) {
      const value = { identity: key, ...entry }, length = Buffer.byteLength(JSON.stringify(value)) + 1;
      if (births.size >= 20_000 || bytes + identityBytes + length + footerReserve >= maxBytes) { reasons.add('process-identity-limit'); processComplete = false; return null; }
      births.set(key, value); identityBytes += length;
    }
    return key;
  }
  async function sample(kind) {
    if (counts.samples >= maxEntries || bytes + identityBytes >= maxBytes - footerReserve) { reasons.add('resource-sample-limit'); return latest; }
    const observedStartMs = now(), missing = [];
    const cpuWindowBoundary = kind === 'manual' && !cpuBeginAttempted ? 'begin' : kind === 'final' && cpuBeginAttempted ? 'end' : null;
    if (cpuWindowBoundary === 'begin') cpuBeginAttempted = true;
    if (kind === 'scheduled') {
      if (lastScheduled !== null) { const gap = observedStartMs - lastScheduled; maximumGapMs = Math.max(maximumGapMs, gap); if (gap > INTERVAL_MS * 2) reasons.add('sampling-gap-over-two-intervals'); }
      lastScheduled = observedStartMs; counts.scheduled++;
    } else counts.manual++;
    let browserProcesses = [], backendProcesses = [], browserRssBytes = null, backendRssBytes = null, projected = resourceProductProjection(null, rendererOwnershipProof);
    try {
      // Discover PIDs first, then bracket the measured RSS table with birth
      // observations for every attributed process. A newly born/exited/recycled
      // descendant invalidates this sample instead of inheriting another PID's RSS.
      const discovery = parseResourceProcesses((await command(['-e', '-o', 'pid=,ppid=,rss='])).stdout);
      const discovered = [...resourceProcessTree(discovery, browserPid), ...resourceProcessTree(discovery, backendPid)];
      const before = await observeBirths([...roots.map(root => root.pid), ...discovered.map(row => row.pid)]);
      verifyRoots(before);
      const { stdout } = await command(['-e', '-o', 'pid=,ppid=,rss=']);
      const rows = parseResourceProcesses(stdout);
      browserProcesses = resourceProcessTree(rows, browserPid); backendProcesses = resourceProcessTree(rows, backendPid);
      if (!browserProcesses.length || !backendProcesses.length) throw Error('Owned RSS root missing');
      const browserIds = new Set(browserProcesses.map(row => row.pid));
      if (backendProcesses.some(row => browserIds.has(row.pid))) throw Error('Owned process trees overlap');
      const observed = await observeBirths([...roots.map(root => root.pid), ...browserProcesses.map(row => row.pid), ...backendProcesses.map(row => row.pid)]);
      verifyRoots(observed);
      const identify = row => { const birth = observed.find(value => value.pid === row.pid), previous = before.find(value => value.pid === row.pid); if (!birth || !previous || previous.pgid !== birth.pgid || previous.startedAtIdentity !== birth.startedAtIdentity) throw Error('Descendant birth changed during RSS observation'); const identity = retainBirth(birth); if (!identity) throw Error('Process identity bound exceeded'); return { ...row, identity }; };
      browserProcesses = browserProcesses.map(identify); backendProcesses = backendProcesses.map(identify);
      browserRssBytes = browserProcesses.reduce((sum, row) => sum + row.rssBytes, 0); backendRssBytes = backendProcesses.reduce((sum, row) => sum + row.rssBytes, 0);
      if (!integer(browserRssBytes + backendRssBytes)) throw Error('RSS sum exceeds exact numeric range');
    } catch { missing.push('process-tree-or-birth-observation-unavailable'); processComplete = false; browserRssBytes = null; backendRssBytes = null; browserProcesses = []; backendProcesses = []; }
    try { projected = resourceProductProjection(await observedProduct(cpuWindowBoundary ? { boundary: cpuWindowBoundary, id: cpuWindowId } : null), rendererOwnershipProof); }
    catch { missing.push('read-only-product-resource-snapshot-unavailable'); }
    if (!projected.allocationCoverage.complete) { ledgerComplete = false; missing.push('complete-product-allocation-ledger-unavailable'); }
    const observedEndMs = now();
    maximumSampleDurationMs = Math.max(maximumSampleDurationMs, observedEndMs - observedStartMs);
    if (missing.length) counts.failedSamples++;
    for (const reason of missing) reasons.add(reason);
    const value = { ordinal: counts.samples + 1, kind, sampleAtMs: observedStartMs, observation: { startMs: observedStartMs, endMs: observedEndMs }, processIdentity, browserRssBytes, backendRssBytes, ...projected.values, settledBytes: browserRssBytes === null || backendRssBytes === null ? null : browserRssBytes + backendRssBytes, browserProcesses, backendProcesses, allocationCoverage: projected.allocationCoverage, globalAllocationCoverage: projected.globalAllocationCoverage, appOwnership: projected.appOwnership, rendererOwnership: projected.rendererOwnership, rendererOwnershipProof: projected.rendererOwnershipProof, documentLifecycle: projected.lifecycle, combinedCpu: projected.combinedCpu, cpuWindowBoundary, cpuWindowAck: projected.cpuWindowAck, missing, forcedGC: false };
    // Encode the actual row before writing. No full observation history is
    // buffered: only existing bounded B0/end and peak witnesses stay live.
    const text = (counts.samples ? ',\n' : '') + JSON.stringify(encodeBrowserResourceSample(value, sampleContext));
    if (bytes + identityBytes + Buffer.byteLength(text) > maxBytes - footerReserve) { reasons.add('resource-byte-limit'); return latest; }
    await write(text); counts.samples++; latest = value;
    const window = value.combinedCpu?.window, ack = value.cpuWindowAck;
    const joined = window?.id === cpuWindowId && ack?.id === cpuWindowId && ack.ledgerInstanceId === window.ledgerInstanceId && ack.ordinal === window.ordinal && ack.boundary === cpuWindowBoundary;
    if (cpuWindowBoundary === 'begin') {
      appOwnedBegin = value;
      if (joined && window.sealed === false && ack.sealed === false) observationWindow = { scope: cpuWindowScope, id: cpuWindowId, processIdentity, ledgerInstanceId: window.ledgerInstanceId,
        startSourceOrdinal: value.ordinal, endSourceOrdinal: null, startObservation: value.observation, endObservation: null, beginAck: ack, endAck: null };
      else reasons.add('continuous-browser-cpu-window-start-unavailable');
    }
    if (cpuWindowBoundary === 'end') {
      if (ack?.id === cpuWindowId && ack.boundary === 'end' && ack.sealed === true) cpuEndAcknowledged = true;
      if (joined && observationWindow?.ledgerInstanceId === window.ledgerInstanceId && window.sealed === true && ack.sealed === true) {
        observationWindow.endSourceOrdinal = value.ordinal; observationWindow.endObservation = value.observation; observationWindow.endAck = ack;
        continuousCpuPeak = { kind: 'owned-allocation-continuous-peak-1', scope: cpuWindowScope, value: window.peakBytes, processIdentity, sharedIdentity: window.ledgerInstanceId,
          sequence: window.endSequence, sourceOrdinal: value.ordinal, observation: value.observation, windowId: window.id, window,
          ownerCoverageComplete: window.ownerCoverageComplete, complete: window.observationComplete && window.ownerCoverageComplete && projected.allocationCoverage.cpu, artifact: null };
      } else reasons.add('continuous-browser-cpu-window-end-unavailable');
      appOwnedCpu = appOwnedCpuCandidate(appOwnedBegin, value, processIdentity, observationWindow);
    }
    aggregate.add(value); activeWindow?.aggregate.add(value);
    return structuredClone(value);
  }
  function enqueue(kind, before = null, after = null) {
    const task = tail.then(async () => { if (state === 'failed') throw Error('Resource artifact is incomplete'); before?.(); const value = await sample(kind); return after ? after(value) : value; });
    tail = task.catch(() => {
      // writeFile may have persisted a prefix before rejecting. Do not append a
      // footer or advertise a digest that omits those unknown persisted bytes.
      reasons.add('resource-artifact-write-failed'); state = 'failed'; cancel(timer); timer = undefined;
    });
    return task;
  }
  function arm() {
    if (state !== 'running' || reasons.has('resource-sample-limit') || reasons.has('resource-byte-limit')) return;
    timer = schedule(() => {
      timer = undefined;
      if (state !== 'running') return;
      void enqueue('scheduled').catch(() => {}).finally(() => {
        if (state !== 'running') return;
        nextDue += INTERVAL_MS;
        while (nextDue < now()) { nextDue += INTERVAL_MS; counts.missedIntervals++; }
        if (counts.missedIntervals) reasons.add('scheduled-sample-interval-missed');
        arm();
      });
    }, Math.max(0, nextDue - now()));
    timer?.unref?.();
  }
  function evidence() {
    const missing = [...reasons];
    if (state !== 'stopped') missing.push('sampler-not-sealed');
    if (!ledgerComplete || !counts.samples) missing.push('complete-product-allocation-ledger-unavailable');
    if (!processComplete || !counts.samples) missing.push('complete-process-tree-identity-observation-unavailable');
    if (counts.scheduled < 2) missing.push('continuous-resource-sampling-requires-two-scheduled-observations');
    if (!(continuousCpuPeak?.complete || appOwnedCpu?.complete) || !observationWindow?.endObservation) missing.push('complete-continuous-browser-cpu-window-unavailable');
    const unique = [...new Set(missing)], summary = aggregate.snapshot();
    const scopedCpu = appOwnedCpu ? { ...structuredClone(appOwnedCpu), artifact: sha256 === null ? null : { path: artifact, bytes: bytesReliable ? bytes : null, sha256 } } : null;
    const allocationPeaks = continuousCpuPeak ? { cpuBytes: { ...structuredClone(continuousCpuPeak), artifact: sha256 === null ? null : { path: artifact, bytes: bytesReliable ? bytes : null, sha256 } } } : {};
    return { kind: 'attributed-process-tree-and-allocation-ledger', complete: state === 'stopped' && unique.length === 0 && sha256 !== null, sha256, artifact: { path: artifact, bytes: bytesReliable ? bytes : null, confirmedBytesWritten: bytes, sha256 }, processIdentity, roots: roots ? structuredClone(roots) : null, intervalMs: INTERVAL_MS, startMs, endMs, counts: { ...counts }, maximumGapMs, maximumSampleDurationMs, peaks: summary.peaks, peakSamples: summary.peakSamples, textureLimits: summary.textureLimits, windows: structuredClone(windows), cpuWindowCleanup: structuredClone(cpuWindowCleanup), observationWindow: observationWindow ? structuredClone(observationWindow) : null, allocationPeaks, appOwnedCpu: scopedCpu, missing: unique, settledBytesDefinition: 'Sum of RSS bytes for distinct owned browser and backend process trees; shared OS pages may be counted by RSS in more than one process. Worker RSS is excluded.', clock: 'runner-monotonic', identitySource: 'OS PID, process group and lstart; lstart has one-second resolution', allocationSource: 'Existing read-only product phase allocation snapshot; lifecycle counters are diagnostic only', observedPeaksAreSampled: true, continuousCpuScope: cpuWindowScope, forcedGC: false };
  }
  async function start() {
    if (state !== 'new') throw Error('Resource sampler starts only once');
    signal?.throwIfAborted(); state = 'starting';
    try {
      const observed = await observeBirths([workerPid, browserPid, backendPid]);
      roots = [['worker', workerPid], ['browser', browserPid], ['backend', backendPid]].map(([kind, id]) => { const value = observed.find(row => row.pid === id); if (!value) throw Error('Owned process birth identity unavailable'); return { kind, ...value }; });
      processIdentity = digest({ schema: 'browser-resource-process-identity-1', roots });
      roots.forEach(({ kind: _kind, ...value }) => retainBirth(value));
      // Validate descriptors and bounds before cloning or writing the proof.
      // All later observations use this one immutable execution context.
      sampleContext = createBrowserResourceSampleContext({ processIdentity, rendererOwnershipProof });
      rendererOwnershipProof = sampleContext.rendererOwnershipProof;
      file = await openFile(artifact, 'wx', 0o600); hash = createHash('sha256'); startMs = now();
      await write(JSON.stringify({ schema: 'browser-resource-samples-2', sampleCodec: RESOURCE_SAMPLE_CODEC, sampleContext, intervalMs: INTERVAL_MS, processIdentity, roots, startMs }).slice(0, -1) + ',"samples":[\n');
      state = 'running'; await enqueue('scheduled'); nextDue = startMs + INTERVAL_MS;
      while (nextDue < now()) { nextDue += INTERVAL_MS; counts.missedIntervals++; }
      if (counts.missedIntervals) reasons.add('scheduled-sample-interval-missed');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else arm();
      return evidence();
    } catch (error) { state = 'failed'; reasons.add('sampler-start-failed'); try { await file?.close(); } finally { file = undefined; } throw error; }
  }
  function measure() {
    if (state !== 'running') return Promise.reject(Error('Resource sampler is not running'));
    signal?.throwIfAborted(); return enqueue('manual');
  }
  async function beginWindow({ cycleOrdinal }) {
    if (state !== 'running' || activeWindow || !integer(cycleOrdinal) || cycleOrdinal < 1 || cycleOrdinal > 100 || windows.length >= 100) throw Error('Resource window must belong to one running lifecycle cycle');
    signal?.throwIfAborted();
    const handle = Object.freeze({ id: randomUUID(), sequence: ++windowSequence, cycleOrdinal });
    // Mutation and the boundary sample share the serial sample queue, so an
    // already queued observation can never straddle this window's start.
    try {
      await enqueue('window-start', () => {
        if (state !== 'running' || activeWindow) throw Error('Resource sampler changed before window start');
        activeWindow = { handle, startMs: now(), aggregate: createResourceObservationSummary() };
      });
    } catch (error) { if (activeWindow?.handle === handle) activeWindow = null; reasons.add('resource-window-start-unavailable'); throw error; }
    return handle;
  }
  function finishWindow(window, endpointError = null) {
    if (activeWindow !== window) throw Error('Resource window ownership changed');
    activeWindow = null;
    const handle = window.handle, summary = window.aggregate.snapshot(), value = { kind: 'resource-observation-window-1', id: handle.id, cycleOrdinal: handle.cycleOrdinal, processIdentity,
      startMs: window.startMs, endMs: now(), ...summary, complete: summary.complete && endpointError === null, missing: endpointError ? [endpointError] : [] };
    // The raw artifact already retains every observation. Its footer binds
    // only the bounded window interval; the attempt retains actual witnesses.
    windows.push({ kind: value.kind, id: value.id, cycleOrdinal: value.cycleOrdinal, processIdentity, startMs: value.startMs, endMs: value.endMs,
      firstOrdinal: value.firstOrdinal, lastOrdinal: value.lastOrdinal, sampleCount: value.sampleCount, complete: value.complete, missing: value.missing });
    return value;
  }
  async function endWindow(handle) {
    if (interruptedWindow?.handle === handle && !interruptedWindow.delivered) { interruptedWindow.delivered = true; return structuredClone(interruptedWindow.value); }
    if (!activeWindow || activeWindow.handle !== handle) throw Error('Unknown or already closed resource window');
    const window = activeWindow;
    // The close mutation is serialized with its final real observation. A
    // subsequent scheduled observation belongs outside this cycle window.
    if (state === 'running') {
      try { return await enqueue('window-end', null, () => finishWindow(window)); }
      catch { await tail; return finishWindow(window, 'resource-window-endpoint-unavailable'); }
    }
    await tail;
    if (interruptedWindow?.handle === handle && !interruptedWindow.delivered) { interruptedWindow.delivered = true; return structuredClone(interruptedWindow.value); }
    return finishWindow(window, 'sampler-not-running-at-window-end');
  }
  async function cleanupCpuWindow() {
    if (!cpuBeginAttempted || cpuEndAcknowledged || cpuWindowCleanup.attempted) return;
    cpuWindowCleanup.attempted = true;
    try {
      // A missing/failed artifact append is not permission to leave a live
      // diagnostic owner behind. Retry the same idempotent end, under the same
      // one-outstanding-evaluation bound. This is cleanup only: it creates no
      // synthetic sample ordinal, scored boundary or retained maximum.
      const projected = resourceProductProjection(await observedProduct({ boundary: 'end', id: cpuWindowId }), rendererOwnershipProof), ack = projected.cpuWindowAck;
      if (ack?.id !== cpuWindowId || ack.boundary !== 'end' || ack.sealed !== true) throw Error('CPU_WINDOW_CLEANUP_ACK');
      cpuEndAcknowledged = true; cpuWindowCleanup.complete = true; cpuWindowCleanup.ack = ack;
    } catch {
      cpuWindowCleanup.error = 'cpu-window-cleanup-unavailable'; reasons.add('cpu-window-cleanup-unavailable');
    }
  }
  function abort() { reasons.add('sampling-aborted'); void stop().catch(() => {}); }
  function stop() {
    if (stopPromise) return stopPromise;
    if (state === 'new' || state === 'starting') return Promise.reject(Error('Resource sampler has not started'));
    stopPromise = (async () => {
      cancel(timer); timer = undefined; signal?.removeEventListener('abort', abort);
      try {
        if (state === 'failed') { await cleanupCpuWindow(); return evidence(); }
        const wasRunning = state === 'running'; state = 'stopping'; await tail;
        if (state === 'failed' || reasons.has('resource-artifact-write-failed')) throw Error('Resource artifact has an incomplete write');
        if (wasRunning) await enqueue('final');
        await cleanupCpuWindow();
        if (activeWindow) {
          reasons.add('resource-window-left-open');
          const window = activeWindow; interruptedWindow = { handle: window.handle, value: finishWindow(window, 'sampler-stopped-with-open-window'), delivered: false };
        }
        endMs = now();
        if (lastScheduled !== null && endMs - lastScheduled > INTERVAL_MS * 2) reasons.add('final-sampling-gap-over-two-intervals');
        const summary = evidence(), { complete: _complete, sha256: _sha256, artifact: _artifact, ...summaryValues } = summary;
        const missing = summary.missing.filter(reason => reason !== 'sampler-not-sealed');
        const footer = '\n],"identities":' + JSON.stringify([...births.values()]) + ',"summary":' + JSON.stringify({ ...summaryValues, dataComplete: missing.length === 0, missing }) + '}\n';
        if (bytes + Buffer.byteLength(footer) > maxBytes) { reasons.add('resource-footer-byte-limit'); throw Error('Resource footer exceeds the retained artifact bound'); }
        await write(footer);
        await file.sync(); await file.close(); file = undefined; sha256 = 'sha256:' + hash.digest('hex'); state = 'stopped'; return evidence();
      } catch (error) { state = 'failed'; reasons.add('resource-artifact-seal-failed'); throw error; }
      finally { await cleanupCpuWindow(); if (file) { try { await file.close(); } catch { reasons.add('resource-artifact-close-failed'); } finally { file = undefined; } } }
    })();
    return stopPromise;
  }
  return { start, measure, beginWindow, endWindow, stop, evidence, identity: () => processIdentity };
}
