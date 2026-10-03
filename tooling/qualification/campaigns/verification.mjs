import {verifyRecoveryFontEvidence} from './browser-text-recovery-fonts.mjs';
import {verifyLifecycleCompositionEvidence} from './browser-lifecycle-composition.mjs';
export {verifyLifecycleCompositionEvidence} from './browser-lifecycle-composition.mjs';
import {lifecycleAllocationObservations} from './browser-lifecycle-counters.mjs';
import {TEXT_RESOURCE_OPERATIONS, textResourceBinding, textResourceMeasurement, verifyTextResourceArtifact} from './browser-text-resources.mjs';
import {verifyWarmAttempt} from './backend-warm-proof.mjs';
import {verifyFastWarmAttempt} from './backend-fast-warm-proof.mjs';
import {verifyWQCacheAttempt} from './backend-wq-cache.mjs';
import {isBrowserWALifecycle, verifyBrowserWALifecycle} from './browser-wa-observation.mjs';
import {ORDINARY_COMPOSITION_OPERATIONS, verifyOrdinaryCompositionEvidence} from './browser-ordinary-composition.mjs';
import {verifyAdapterImportObservation} from './adapter-import-observation.mjs';
import {ORDINARY_TEXT_OPERATIONS, verifyOrdinaryTextEvidence} from './browser-ordinary-text.mjs';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digestJSON } from '../core.mjs';
import { isBuildSource } from '../dev.mjs';
import { digest, fileIdentity, readJournal } from './common.mjs';
import { selectFixtureDescriptor } from './fixture-catalog.mjs';
import { byteAuditConfiguration, jobExecutionPath } from './byte-audits.mjs';
import { isCampaignEvidencePath, verifyHmrWindowServerEvidence } from './windowserver-hmr-verification.mjs';
import { isFirstUseNativeEvidencePath, verifyFirstUseWindowServerEvidence } from './windowserver-first-use-verification.mjs';
import { isSessionNativeEvidencePath, verifySessionWindowServerEvidence } from './windowserver-session-verification.mjs';
import { isTextSessionNativeEvidencePath, verifyTextSessionWindowServerEvidence } from './windowserver-text-session-verification.mjs';
import { isNativeImeEvidencePath, verifyNativeImeEvidence } from './native-ime-verification.mjs';
import { isNavigationNativeEvidencePath, verifyNavigationWindowServerEvidence } from './windowserver-navigation-verification.mjs';

const excludedDirectories = new Set(['store', 'root', 'fixtures', 'browser-profile', 'profile']);
const safeCell = value => value.replace(/[^A-Za-z0-9_.-]/g, '_');
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const equal = (a, b, message) => { if (!isDeepStrictEqual(a, b)) throw Error(message); };
function safeRelative(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(path)) throw Error('Unsafe receipt evidence path');
  return path;
}

/** A startup byte snapshot is useful only at the selected public ready
 * boundary. Failed actions can retain their partial snapshot without claiming
 * that the document was opened or that this boundary was reached. */
export function verifyByteAuditStartupBoundary({ cell, attempt, fixture }) {
  if (attempt?.result?.d11?.scope !== 'startup') return { applicable: false };
  if (cell?.operation !== 'navigation.ready') throw Error('Startup byte audit does not belong to a navigation-ready cell');
  const observation = attempt.result.observations;
  const hasBoundary = observation && (Object.hasOwn(observation, 'startupBoundary') || Object.hasOwn(observation, 'publicOpenCompleted'));
  if (!hasBoundary) {
    if (attempt.status === 'PASS' || attempt.result.status === 'PASS') throw Error('Passing startup byte audit lacks its public ready boundary');
    return { applicable: true, verified: false };
  }
  const documentId = fixture?.documentId ?? null;
  if (documentId !== null && (typeof documentId !== 'string' || !documentId)) throw Error('Startup byte audit fixture document identity is malformed');
  const boundary = documentId === null ? 'shell-ready-no-document' : 'document-ready-via-Open';
  if (observation.documentId !== documentId || observation.startupBoundary !== boundary || observation.publicOpenCompleted !== (documentId !== null)) throw Error('Startup byte audit ready boundary differs from the selected fixture');
  // C's role context accounts for a union of startup scenarios. H records this
  // actual selected visit, including workloads outside that static union.
  return { applicable: true, verified: true, boundary, documentId };
}

/** A serialized N/A proof is shared by every observation in one continuous
 * lifecycle. Its raw reviewed bytes are verified separately below; arbitrary
 * runtime declarations and mixed executable identities cannot authorize N/A. */
export function lifecycleRendererProof(result, rawSamples = []) {
  let retained = null;
  const consider = proof => { if (proof != null) {if (retained === null) retained = proof; else equal(proof, retained, 'Lifecycle observations contain mixed renderer ownership proofs');} };
  consider(result?.sampling?.rendererOwnershipProof); consider(result?.B0?.resources?.rendererOwnershipProof);
  for (const cycle of result?.cycles ?? []) {
    consider(cycle.resources?.rendererOwnershipProof); consider(cycle.resourceObservation?.resources?.rendererOwnershipProof);
    for (const value of cycle.resourceSamples ?? []) consider(value?.rendererOwnershipProof);
    for (const value of cycle.action?.resourceSamples ?? []) consider(value?.rendererOwnershipProof);
  }
  for (const value of rawSamples) consider(value?.rendererOwnershipProof);
  return retained;
}

const textResourceNames = new Set(['R35FontShapingCpuBytes', 'R35GlyphGpuBytes']);
const textResourceRows = rows => (rows ?? []).filter(row => textResourceNames.has(row.name));
const textResourceProjection = value => {const {proof, ...observation} = value; return observation;};
function textResourceObserverId(artifact) {
  const path = artifact?.path, id = typeof path === 'string' ? basename(path, '.json') : '';
  if (!isAbsolute(path ?? '') || basename(dirname(path)) !== 'text-resources' || basename(path) !== id + '.json' || !/^text-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw Error('Text resource artifact does not identify its owned observer');
  return id;
}
function textResourceInterval(evidence, interval, journalEvents) {
  const timing = evidence?.timing;
  if (![interval?.startMs, interval?.endMs, timing?.startedMs, timing?.endedMs].every(value => Number.isFinite(value) && value >= 0) ||
      timing.startedMs < interval.startMs || timing.endedMs < timing.startedMs || timing.endedMs > interval.endMs) throw Error('Text resource observation lies outside its owned action');
  const intent = journalEvents.filter(event => event.event === 'text-resources-intent' && event.observerId === evidence.binding.observerId);
  if (intent.length !== 1 || !Number.isFinite(intent[0].monotonicMs) || intent[0].monotonicMs < timing.startedMs || intent[0].monotonicMs > timing.endedMs) throw Error('Text resource intent journal is outside its owned action');
  const begin = journalEvents.filter(event => event.event === 'text-resources-begin' && event.windowId === evidence.begin.id);
  const end = journalEvents.filter(event => event.event === 'text-resources-observed' && event.windowId === evidence.begin.id);
  if (begin.length !== 1 || end.length !== 1 || !Number.isFinite(begin[0].monotonicMs) || !Number.isFinite(end[0].monotonicMs) ||
      begin[0].monotonicMs < timing.startedMs || begin[0].monotonicMs > timing.endedMs || end[0].monotonicMs < timing.endedMs ||
      end[0].monotonicMs > interval.endMs) throw Error('Text resource journal is outside its owned action');
}

/** Ordinary resource rows have their own continuous transition witness. The
 * separate ordinary font observer retains authority for font identities/sizes.
 * Always run this branch, including when a forged receipt omits its artifact. */
export async function verifyOrdinaryTextResourceEvidence({cell, attempt, serial, fixture, processIdentity, executableIdentity,
  rendererOwnershipProof = null, readRetained, journalEvents}) {
  if (cell?.handler !== 'browser' || !TEXT_RESOURCE_OPERATIONS.includes(cell.operation)) return {applicable: false};
  const published = textResourceRows(attempt?.result?.measurements), observed = attempt?.result?.textResources;
  if (!observed) {
    if (published.length || (cell.requiredMeasurements ?? []).some(rule => textResourceNames.has(rule.name)) &&
        (attempt?.status === 'PASS' || attempt?.result?.status === 'PASS')) throw Error('Ordinary text resource measurements lack their retained observation');
    return {applicable: true, complete: false};
  }
  const binding = textResourceBinding({cell, sample: attempt, serial, fixtureIdentity: fixture?.seal?.sha256, processIdentity, executableIdentity, observerId: textResourceObserverId(observed.artifact)});
  const replay = await verifyTextResourceArtifact({artifact: observed.artifact, binding, rendererOwnershipProof, readRetained, journalEvents});
  textResourceInterval(replay.evidence, attempt, journalEvents);
  equal(observed, textResourceProjection(replay), 'Ordinary text resource summary differs from sealed replay');
  const rules = (cell.requiredMeasurements ?? []).filter(rule => textResourceNames.has(rule.name));
  const expected = rules.filter(rule => (!rule.cache || rule.cache === attempt.cache) && rules.filter(other => other.name === rule.name).length === 1)
    .map(rule => textResourceMeasurement({cell, sample: attempt, rule, proof: replay.proof}).measurement).filter(Boolean);
  equal(published, expected, 'Ordinary text resource published measurements differ from sealed replay');
  if ((!replay.complete || replay.evidence.failed) && (attempt.status === 'PASS' || attempt.result.status === 'PASS')) throw Error('Incomplete ordinary text resource observation was reported passing');
  return {applicable: true, complete: replay.complete};
}

/** R35 lifecycle rows are wrapped by the existing counter artifact. Replay
 * both retained layers and the exact cycle identity before trusting those rows;
 * endpoint-only fallbacks can remain diagnostic but can never become complete. */
export async function verifyLifecycleTextResourceEvidence({cell, result, fixture, executableIdentity, rendererOwnershipProof = null, readRetained, journalEvents}) {
  if (cell?.handler !== 'browser' || cell.kind !== 'lifecycle' || cell.operation !== 'lifecycle.editor' ||
      !(cell.requiredMeasurements ?? []).some(rule => textResourceNames.has(rule.name))) return {applicable: false};
  const required = new Set(cell.requiredMeasurements.filter(rule => textResourceNames.has(rule.name)).map(rule => rule.name));
  for (const cycle of result?.cycles ?? []) {
    const counter = cycle.action?.lifecycleCounterEvidence ?? cycle.failedActionEvidence;
    const published = textResourceRows(cycle.action?.measurements ?? counter?.measurements);
    if (!counter?.artifact) {
      if (published.length || cycle.action?.status === 'PASS') throw Error('Lifecycle text resource measurements lack their counter artifact');
      continue;
    }
    if (![cycle.startMs, cycle.endMs].every(value => Number.isFinite(value) && value >= 0) || cycle.endMs < cycle.startMs) throw Error('Lifecycle text resource action interval is unavailable');
    const artifact = counter.artifact;
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > 8 * 1048576 || !sha(artifact.sha256)) throw Error('Lifecycle text counter artifact identity is invalid');
    const bytes = await readRetained(artifact.path, {maximum: 8 * 1048576});
    if (bytes.byteLength !== artifact.bytes || digest(bytes) !== artifact.sha256) throw Error('Lifecycle text counter artifact bytes differ');
    const raw = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (raw.kind !== 'lifecycle-counters-artifact-1' || raw.schemaVersion !== 1 || raw.cellId !== cell.id || raw.cycleOrdinal !== cycle.ordinal ||
        raw.fixtureIdentity !== fixture?.seal?.sha256 || raw.fixtureIdentity !== cycle.fixtureIdentity || raw.fixtureIdentity !== result.fixtureIdentity ||
        raw.processIdentity !== cycle.processIdentity || raw.processIdentity !== result.processIdentity) throw Error('Lifecycle text counter parent binding differs');
    const observed = raw.evidence?.textResources;
    let metrics = [], complete = false, failed = raw.failed;
    if (observed) {
      const binding = textResourceBinding({cell, cycleOrdinal: cycle.ordinal, fixtureIdentity: fixture.seal.sha256,
        processIdentity: cycle.processIdentity, executableIdentity, observerId: textResourceObserverId(observed.artifact)});
      const replay = await verifyTextResourceArtifact({artifact: observed.artifact, binding, rendererOwnershipProof, readRetained, journalEvents});
      textResourceInterval(replay.evidence, {startMs: cycle.startMs, endMs: cycle.endMs}, journalEvents);
      equal(observed, textResourceProjection(replay), 'Lifecycle text resource summary differs from sealed replay');
      metrics = replay.measurements.filter(row => required.has(row.name)); complete = replay.complete; failed ||= replay.evidence.failed;
    }
    if ([...required].some(name => !metrics.some(row => row.name === name))) {
      // The broad transition upper bound can require narrower attribution and
      // therefore omit CPU even while a valid nested observation is present.
      // The collector then appends an exact endpoint lower bound. Authenticate
      // every such fallback; incomplete values can still prove a ceiling breach.
      if (!Array.isArray(raw.allocations) || raw.allocations.length > 4096 || raw.clock !== 'runner-monotonic' ||
          !Number.isFinite(raw.startedMs) || !Number.isFinite(raw.endedMs) || raw.startedMs < cycle.startMs || raw.endedMs > cycle.endMs || raw.endedMs < raw.startedMs)
        throw Error('Lifecycle text fallback lacks its bounded observation interval');
      for (const value of raw.allocations) if (!Number.isFinite(value?.startMs) || !Number.isFinite(value?.endMs) ||
          value.startMs < raw.startedMs || value.endMs < value.startMs || value.endMs > raw.endedMs) throw Error('Lifecycle text endpoint is outside its counter interval');
      const values = lifecycleAllocationObservations(raw.allocations);
      const fallback = [
        {name: 'R35FontShapingCpuBytes', value: values.fontShapingCpuBytes, unit: 'bytes', method: 'Endpoint reservation lower bound; synchronous text resource window unavailable', complete: false},
        {name: 'R35GlyphGpuBytes', value: values.glyphGpuBytes, unit: 'bytes', method: 'Endpoint glyph reservation lower bound; reviewed ownership window unavailable', complete: false},
      ].filter(row => required.has(row.name) && !metrics.some(existing => existing.name === row.name) && Number.isSafeInteger(row.value) && row.value >= 0);
      metrics.push(...fallback); complete = false;
    }
    equal(textResourceRows(raw.metrics), metrics, 'Lifecycle text resource metrics differ from sealed replay');
    const expected = metrics.map(row => ({...row, evidence: {kind: 'lifecycle-measurement-evidence-1', cellId: cell.id, cycleOrdinal: cycle.ordinal,
      processIdentity: cycle.processIdentity, fixtureIdentity: fixture.seal.sha256,
      coverage: row.complete ? 'complete-cycle-actions' : 'observed-partial-cycle-actions', artifact}}));
    equal(textResourceRows(counter.measurements), expected, 'Lifecycle text counter publication differs from sealed replay');
    equal(published, expected, 'Lifecycle text action publication differs from sealed replay');
    if ((failed || !complete) && cycle.action?.status === 'PASS') throw Error('Incomplete lifecycle text resources were reported passing');
  }
  return {applicable: true};
}

/** C's WA lifecycle owns a backend allocation stream, separate from H's
 * browser/process-tree stream. Read bytes only through the caller's immutable
 * evidence packet, including when the packet has moved since observation. */
export async function verifyAdapterLifecycleResourceEvidence({ cell, result, readRetained }) {
  if (cell?.handler !== 'adapters' || cell.host !== 'C' || cell.kind !== 'lifecycle' || cell.workload !== 'WA' || cell.operation !== 'adapter.lifecycle') return { applicable: false };
  const sampling = result?.sampling, artifact = sampling?.artifact;
  if (!artifact?.path || !sha(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
    if (sampling?.complete === true) throw Error('Complete adapter lifecycle sampling lacks a sealed raw artifact');
    return { applicable: true, complete: false, missing: ['adapter-resource-sealed-artifact-unavailable'] };
  }
  const missing = [], requiredMissing = [];
  const absent = (reason, preserveFailure = false) => { missing.push(reason); if (!preserveFailure) requiredMissing.push(reason); };
  if (result?.B0?.resources == null) absent('adapter-resource-baseline-unavailable');
  if (!Array.isArray(result?.cycles)) absent('adapter-resource-cycle-inventory-unavailable');
  const selectedSamples = [result?.B0?.resources];
  for (const cycle of result?.cycles ?? []) {
    const failedCycle = ['FAIL', 'INCONCLUSIVE'].includes(result.status) && !!cycle.error;
    if (cycle.resources == null) absent(`adapter-cycle-${cycle.ordinal}-settled-resource-unavailable`, failedCycle);
    if (!Array.isArray(cycle.resourceSamples)) absent(`adapter-cycle-${cycle.ordinal}-selected-resources-unavailable`, failedCycle);
    selectedSamples.push(cycle.resources, cycle.resourceObservation?.resources, ...(cycle.resourceSamples ?? []), ...(cycle.action?.resourceSamples ?? []));
  }
  const { verifyAdapterResourceSampling } = await import('./adapter-resource-sampling-verification.mjs');
  const replay = verifyAdapterResourceSampling(await readRetained(artifact.path), sampling, {
    processIdentity: result?.processIdentity, selectedSamples: selectedSamples.filter(value => value != null),
  });
  if (replay.status === 'FAIL') throw Error('Retained adapter resource sampling contradicts its receipt: ' + replay.failures.join('; '));
  if (sampling.complete === true && (replay.complete !== true || requiredMissing.length)) throw Error('Complete adapter resource sampling lacks required raw witnesses: ' + [...(replay.missing ?? []), ...requiredMissing].join('; '));
  return { ...replay, applicable: true, complete: replay.complete === true && missing.length === 0, missing: [...new Set([...(replay.missing ?? []), ...missing])] };
}

/** Prove completeness from retained identities as well as their self-hashes.
 * Re-sealing an arbitrary subset must not authorize a prepared product copy. */
export function verifyPreparedSourceInventory(identity, supplemental = []) {
  if (identity.preparedSource == null) return;
  const provenance = identity.buildProvenance, manifest = provenance?.sourceManifest;
  const prefixed = value => value?.startsWith('sha256:') ? value : 'sha256:' + value;
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length || digest(JSON.stringify(manifest.files, null, 2) + '\n') !== prefixed(manifest.sha256)) throw Error('Prepared source lacks its sealed source manifest');
  const subject = identity.before.files;
  if (provenance.subjectSourceManifest !== undefined) equal(provenance.subjectSourceManifest, subject, 'Prepared source subject manifest differs from retained subject');
  const applicable = path => isBuildSource(path) || path.startsWith('docs/spec/') || path.startsWith('.github/workflows/') || path === 'AGENTS.md';
  const required = subject.filter(file => !file.deleted && applicable(file.path));
  equal(manifest.files.map(file => safeRelative(file.path)).sort(), required.map(file => file.path).sort(), 'Prepared source omits applicable retained subject paths');
  const files = manifest.files.map(file => {
    const expected = required.find(value => value.path === file.path);
    if (file.bytes !== expected.bytes || prefixed(file.sha256) !== prefixed(expected.sha256)) throw Error('Prepared source differs from retained subject bytes');
    return { path: file.path, bytes: file.bytes, sha256: prefixed(file.sha256) };
  });
  for (const item of supplemental) {
    const path = safeRelative(item.path);
    if (files.some(file => file.path === path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !sha(prefixed(item.sha256))) throw Error('Invalid retained supplemental source identity');
    files.push({ path, bytes: item.bytes, sha256: prefixed(item.sha256), supplemental: true });
  }
  equal(identity.preparedSource.files, files, 'Prepared source inventory differs from complete retained inputs');
  if (identity.preparedSourceAfter) equal(identity.preparedSourceAfter.files.map(file => [file.path, file.supplemental === true]), files.map(file => [file.path, file.supplemental === true]), 'Prepared source after-inventory changed');
}

async function ordinaryPath(root, path) {
  let current = root;
  const parts = safeRelative(path).split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part); const info = await lstat(current);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw Error('Evidence path must contain only ordinary directories and files');
  }
  return current;
}

async function metadataInventory(root) {
  const paths = [];
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw Error('Symlink in receipt evidence tree');
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) await walk(join(directory, entry.name), path + '/');
      else if (entry.isFile() && (isCampaignEvidencePath(path) || isFirstUseNativeEvidencePath(path) || isSessionNativeEvidencePath(path) || isTextSessionNativeEvidencePath(path) || isNativeImeEvidencePath(path) || isNavigationNativeEvidencePath(path)) && path !== 'receipt.json') paths.push(path);
    }
  }
  await walk(root); return paths.sort();
}

/** Verify the exact retained packet, without reopening mutable source inputs or
 * treating a claimed summary/eligibility boolean as an authority. The caller
 * owns plan reproduction, host eligibility and metric verdict computation. */
export async function verifySealedEvidence(receipt, output) {
  if (!receipt || !Array.isArray(receipt.evidence) || !Array.isArray(receipt.groups) || !receipt.inputIdentities || !receipt.identity) throw Error('Missing campaign evidence structure');
  if (receipt.byteAuditGroups !== undefined && !Array.isArray(receipt.byteAuditGroups) || receipt.jobExecutions !== undefined && !Array.isArray(receipt.jobExecutions)) throw Error('Malformed byte audit or job execution evidence');
  const root = await realpath(output), records = new Map();
  for (const record of receipt.evidence) {
    const path = safeRelative(record.path);
    if (records.has(path) || path === 'receipt.json' || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !sha(record.sha256)) throw Error('Invalid or duplicate evidence identity');
    const actual = await fileIdentity(await ordinaryPath(root, path));
    equal(actual, { bytes: record.bytes, sha256: record.sha256 }, `Evidence changed: ${path}`);
    records.set(path, record);
  }
  equal([...records.keys()].sort(), await metadataInventory(root), 'Retained metadata inventory differs from its seal');
  const cache = new Map(), nativeHotEdits = new Map(), nativeFirstUses = new Map(), nativeSessions = new Map(), nativeImes = new Map(), nativeNavigations = new Map();
  async function bytes(path, {cacheResult = true, maximum = null} = {}) {
    const record = records.get(safeRelative(path));
    if (!record) throw Error(`Required sealed evidence is absent: ${path}`);
    if (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 0 || record.bytes > maximum)) throw Error(`Evidence exceeds its replay read bound: ${path}`);
    if (cache.has(path)) return cache.get(path);
    if (record.bytes > 256 * 1024 * 1024) throw Error('Structured evidence exceeds the 256 MiB verification bound');
    const handle = await open(await ordinaryPath(root, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (maximum === null ? 0 : constants.O_NONBLOCK ?? 0));
    try {
      const before = await handle.stat();
      let value;
      if (maximum === null) value = await handle.readFile();
      else {
        if (!before.isFile() || before.size !== record.bytes) throw Error(`Evidence changed before bounded reading: ${path}`);
        const storage = Buffer.alloc(record.bytes + 1); let count = 0;
        while (count < storage.length) {
          const read = await handle.read(storage, count, storage.length - count, count);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        value = storage.subarray(0, count);
      }
      const after = await handle.stat();
      if (!before.isFile() || before.size !== value.length || before.size !== after.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || value.length !== record.bytes || digest(value) !== record.sha256) throw Error(`Evidence changed while reading: ${path}`);
      if (cacheResult) cache.set(path, value); return value;
    } finally { await handle.close(); }
  }
  const json = async path => JSON.parse((await bytes(path)).toString('utf8'));
  equal(await json('plan.json'), receipt.plan, 'Sealed plan differs from receipt');
  if (digest(receipt.plan) !== receipt.planDigest) throw Error('Plan digest mismatch');
  equal(await json('host.json'), receipt.host, 'Sealed host observations differ from receipt');
  for (const side of ['before', 'after']) {
    const identity = receipt.identity[side];
    if (!Array.isArray(identity?.files) || digestJSON(identity.files) !== identity.digest) throw Error('Subject source manifest digest mismatch');
    equal(await json(`source-${side}.json`), identity, 'Sealed source identity differs from receipt');
  }
  for (const side of ['controlBefore', 'controlAfter']) {
    const identity = receipt.identity[side];
    if (!Array.isArray(identity?.files) || digestJSON(identity.files) !== identity.digest) throw Error('Control source manifest digest mismatch');
  }
  for (const side of ['buildsBefore', 'buildsAfter']) {
    const identity = receipt.identity[side];
    if (!Array.isArray(identity?.files) || digest(identity.files) !== identity.digest) throw Error('Build manifest digest mismatch');
  }
  for (const side of ['preparedSource', 'preparedSourceAfter']) {
    const identity = receipt.identity[side];
    if (identity != null && (!Array.isArray(identity.files) || digest(identity.files) !== identity.digest)) throw Error('Prepared source manifest digest mismatch');
  }
  if (Object.hasOwn(receipt.identity, 'preparedSourceStable')) {
    const before = receipt.identity.preparedSource, after = receipt.identity.preparedSourceAfter;
    if (!before && after) throw Error('Prepared source after-manifest lacks its before-manifest');
    equal(receipt.identity.preparedSourceStable, !before || Boolean(after && before.digest === after.digest), 'Prepared source stability claim differs from its manifests');
  }

  const consumedInputs = {};
  for (const [name, identity] of Object.entries(receipt.inputIdentities)) {
    if (identity === null) { consumedInputs[name] = null; continue; }
    if (!identity || !isAbsolute(identity.path ?? '') || !sha(identity.sha256) || !Number.isSafeInteger(identity.bytes)) throw Error('Invalid consumed input identity');
    const record = records.get(safeRelative(identity.retainedPath));
    if (!record || record.bytes !== identity.bytes || record.sha256 !== identity.sha256) throw Error('Consumed input differs from retained bytes');
    consumedInputs[name] = await json(identity.retainedPath);
  }
  for (const key of ['hostAttestation', 'fixtureManifest', 'configuration', 'buildProvenance']) if (!Object.hasOwn(consumedInputs, key)) throw Error(`Missing consumed input disposition: ${key}`);
  const provenance = receipt.identity.buildProvenance ?? null;
  verifyPreparedSourceInventory(receipt.identity, consumedInputs.testInputPacket?.fixtures ?? []);
  if (provenance === null) {
    // resolveProduct can consume a provenance file before rejecting its source
    // or retained logs. Preserve those sealed failure inputs without treating
    // them as applied provenance for any executed group.
    if (!receipt.runError || receipt.groups.length) equal(consumedInputs.buildProvenance, null, 'Build provenance differs from consumed input');
  }
  else {
    const { retainedLogs, ...original } = provenance;
    equal(consumedInputs.buildProvenance, original, 'Build provenance differs from consumed input');
    if (!Array.isArray(original.commands) || !Array.isArray(retainedLogs)) throw Error('Build provenance lacks retained command logs');
    const logInputs = original.commands.flatMap(command => [command.stdout, command.stderr]);
    if (logInputs.length !== retainedLogs.length) throw Error('Build log inventory differs');
    for (const [index, file] of retainedLogs.entries()) {
      const source = logInputs[index], record = records.get(safeRelative(file.retainedPath));
      const expectedHash = typeof source?.sha256 === 'string' && (source.sha256.startsWith('sha256:') ? source.sha256 : 'sha256:' + source.sha256);
      if (!record || source?.path !== file.path || source?.bytes !== file.bytes || expectedHash !== file.sha256 || record.bytes !== file.bytes || record.sha256 !== file.sha256) throw Error('Build log differs from consumed provenance');
    }
  }
  const attestation = receipt.host.attestation, rawAttestation = consumedInputs.hostAttestation;
  if (rawAttestation === null) equal(attestation, null, 'Host attestation lacks consumed input evidence');
  else {
    if (!attestation || !Array.isArray(rawAttestation.evidence) || !rawAttestation.evidence.length || !Array.isArray(attestation.evidence)) throw Error('Incomplete host attestation evidence');
    const { identity, evidence, ...fields } = attestation;
    const { evidence: rawEvidence, ...rawFields } = rawAttestation;
    equal(fields, rawFields, 'Host attestation differs from consumed input');
    equal(identity, { bytes: receipt.inputIdentities.hostAttestation.bytes, sha256: receipt.inputIdentities.hostAttestation.sha256 }, 'Host attestation identity differs');
    if (evidence.length !== rawEvidence.length) throw Error('Host evidence inventory differs');
    for (const [index, file] of evidence.entries()) {
      const original = rawEvidence[index], record = records.get(safeRelative(file.retainedPath));
      if (original.path !== file.path || original.sha256 !== file.sha256 || !record || record.bytes !== file.bytes || record.sha256 !== file.sha256) throw Error('Host evidence bytes are not retained and sealed');
      if (original.bytes !== undefined && original.bytes !== file.bytes) throw Error('Host evidence byte length differs');
    }
  }

  if (receipt.controllerTiming !== undefined) equal(await json('controller-timing.json'), receipt.controllerTiming, 'Outer controller interval differs from retained evidence');
  for (const record of receipt.jobExecutions ?? []) equal(await json(jobExecutionPath(record.jobId)), record, 'Whole-job interval differs from retained controller evidence');
  let attemptsVerified = 0;
  const folders = new Set(), wqCacheRoots = new Set();
  const auditGroups = receipt.byteAuditGroups ?? [];
  for (const group of [...receipt.groups, ...auditGroups]) {
    const byteAudit = auditGroups.includes(group);
    if (typeof group.id !== 'string' || !Array.isArray(group.attempts)) throw Error('Malformed campaign group');
    if (byteAudit && group.kind !== 'perf-byte-audit-group-1' || !byteAudit && group.kind === 'perf-byte-audit-group-1') throw Error('Scored and byte audit groups cannot exchange roles');
    const folder = safeCell(group.id);
    if (folders.has(folder)) throw Error('Duplicate or colliding group evidence directory');
    folders.add(folder);
    equal(await json(`${folder}/controller.json`), group, 'Raw group differs from sealed controller');
    if (!records.has(`${folder}/process.log`)) throw Error('Group process log is missing');
    const input = await json(`${folder}/input.json`);
    equal(input.cell, group.cell, 'Group cell differs from consumed input');
    if (byteAudit) {
      equal(input.kind, group.kind, 'Byte audit worker kind differs from sealed specification');
      equal(input.byteAudit, group.byteAudit, 'Byte audit executable identity differs from sealed specification');
    }
    if (input.id !== group.id || input.cache !== group.cache || input.output !== group.output || !isAbsolute(group.output ?? '') || !Array.isArray(input.attempts)) throw Error('Group identity differs from consumed input');
    const executionRepo = receipt.identity.runtimeOnly === true ? receipt.productRepo ?? receipt.subjectRepo : receipt.subjectRepo;
    if (input.repo !== executionRepo || input.subjectRepo !== undefined && input.subjectRepo !== receipt.subjectRepo) throw Error('Group subject/product differs from receipt');
    const nativeImeEnvironment = group.cell.operation === 'text.native-ime' ? {sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools), controlDigest: receipt.identity.controlBefore.digest, host: Object.fromEntries(['platform', 'architecture', 'kernel', 'osVersion', 'osBuild', 'hostnameHash'].map(key => [key, receipt.host?.observed?.[key] ?? null]))} : null;
    const navigationEnvironment = group.cell.operation === 'navigation.ready' ? {sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools), controlDigest: receipt.identity.controlBefore.digest, host: Object.fromEntries(['platform', 'architecture', 'kernel', 'osVersion', 'osBuild', 'hostnameHash'].map(key => [key, receipt.host?.observed?.[key] ?? null]))} : null;
    if (input.navigationEnvironment != null) equal(input.navigationEnvironment, navigationEnvironment, 'Navigation source/build/host identity differs from campaign');
    if (input.nativeImeEnvironment != null) {
      if (group.cell.operation !== 'text.native-ime') throw Error('Native IME environment belongs only to its manual cells');
      equal(input.nativeImeEnvironment, nativeImeEnvironment, 'Native IME source/build/host identity differs from campaign');
    }
    const recoveryTextEnvironment = group.cell.operation === 'text.recovery' ? {sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools), controlDigest: receipt.identity.controlBefore.digest, host: Object.fromEntries(['platform', 'architecture', 'kernel', 'osVersion', 'osBuild', 'hostnameHash'].map(key => [key, receipt.host?.observed?.[key] ?? null]))} : null;
    if (input.recoveryTextEnvironment != null) equal(input.recoveryTextEnvironment, recoveryTextEnvironment, 'Recovery text source/build/host identity differs from campaign');
    const ordinaryTextEnvironment = ORDINARY_TEXT_OPERATIONS.includes(group.cell.operation) ? {sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools), controlDigest: receipt.identity.controlBefore.digest, host: Object.fromEntries(['platform', 'architecture', 'kernel', 'osVersion', 'osBuild', 'hostnameHash'].map(key => [key, receipt.host?.observed?.[key] ?? null]))} : null;
    if (input.ordinaryTextEnvironment != null) {
      if (!ORDINARY_TEXT_OPERATIONS.includes(group.cell.operation)) throw Error('Ordinary text executable binding belongs only to its selected cells');
      equal(input.ordinaryTextEnvironment, ordinaryTextEnvironment, 'Ordinary text source/build/host identity differs from campaign');
    }
    const ordinaryCompositionEnvironment = ORDINARY_COMPOSITION_OPERATIONS.includes(group.cell.operation) ? {sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools), controlDigest: receipt.identity.controlBefore.digest, host: Object.fromEntries(['platform', 'architecture', 'kernel', 'osVersion', 'osBuild', 'hostnameHash'].map(key => [key, receipt.host?.observed?.[key] ?? null]))} : null;
    if (input.ordinaryCompositionEnvironment != null) {
      if (!ORDINARY_COMPOSITION_OPERATIONS.includes(group.cell.operation)) throw Error('Ordinary composition executable binding belongs only to its selected cells');
      equal(input.ordinaryCompositionEnvironment, ordinaryCompositionEnvironment, 'Ordinary composition source/build/host identity differs from campaign');
    }
    if (input.rendererIdentity != null) {
      if (group.cell.handler !== 'browser' || group.cell.kind !== 'lifecycle' && !TEXT_RESOURCE_OPERATIONS.includes(group.cell.operation)) throw Error('Renderer ownership inputs belong only to browser lifecycle or text resource observations');
      equal(input.rendererIdentity, { sourceFiles: receipt.identity.before.files, buildFiles: receipt.identity.buildsBefore.files, sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools) }, 'Renderer ownership source/build identity differs from the campaign');
    }
    if (group.fixturePreparationFailed === true) {
      if (!['FAIL', 'INCONCLUSIVE'].includes(group.status) || group.attempts.length || !group.error || records.has(`${folder}/events.jsonl`) || records.has(`${folder}/receipt.json`)) throw Error('Fixture preparation failure cannot contain executed work');
      equal(input.fixtureDescriptor, consumedInputs.fixtureManifest, 'Failed fixture selection differs from consumed descriptor');
      continue;
    }
    const baseConfiguration = consumedInputs.configuration ?? {};
    if (baseConfiguration.browser?.byteAudit === true) throw Error('Consumed configuration enables coverage on scored work');
    equal(input.configuration, byteAudit ? byteAuditConfiguration(baseConfiguration) : baseConfiguration, 'Group configuration differs from consumed input');
    if (group.cell.handler === 'developer') equal(input.fixture, consumedInputs.fixtureManifest, 'Developer fixture input differs from consumed input');
    else {
      const descriptor = selectFixtureDescriptor(consumedInputs.fixtureManifest, group.cell);
      if (descriptor == null) {
        equal(input.fixture, null, 'Group fixture differs from consumed input');
        if (input.fixtureIdentity != null) throw Error('Absent fixture has a claimed selected identity');
      }
      else {
        const selectedPath = `${folder}/selected-fixture-manifest.json`, retained = records.get(selectedPath);
        if (!descriptor.seal || descriptor.seal.path !== descriptor.manifestPath || !sha(descriptor.seal.sha256) || !retained || retained.sha256 !== descriptor.seal.sha256) throw Error('Selected fixture lacks its consumed descriptor seal');
        equal(input.fixtureIdentity, { path: descriptor.manifestPath, bytes: retained.bytes, sha256: retained.sha256, retainedPath: 'selected-fixture-manifest.json' }, 'Selected fixture identity differs from retained bytes');
        const selected = await json(selectedPath);
        equal(input.fixture, { ...selected, manifestPath: descriptor.manifestPath, seal: descriptor.seal }, 'Selected fixture differs from retained manifest');
      }
    }
    if (group.attempts.length > input.attempts.length || group.status === 'PASS' && group.attempts.length !== input.attempts.length) throw Error('Executed attempt count differs from input');
    for (const [index, attempt] of group.attempts.entries()) {
      const planned = input.attempts[index];
      if (attempt.ordinal !== planned.ordinal || attempt.prime !== planned.prime || attempt.cache !== input.cache || attempt.id !== `${group.cell.id}/${group.cache}/${attempt.prime ? 'prime' : 'scored'}/${attempt.ordinal}`) throw Error('Attempt differs from consumed schedule');
    }
    const journalPath = `${folder}/events.jsonl`;
    if (!records.has(journalPath)) {
      if (group.status === 'PASS' || group.attempts.length) throw Error('Attempt inventory lacks its journal');
      if (group.partial) equal(group.journalHead, null, 'Partial controller journal head differs from retained journal');
      continue;
    }
    const journal = readJournal((await bytes(journalPath)).toString('utf8'));
    if (group.partial) equal(group.journalHead, journal.head, 'Partial controller journal head differs from retained journal');
    if (group.status === 'PASS' && journal.incompleteTail) throw Error('Passing group has an incomplete journal');
    const recovered = recoverJournal(journal.events, group);
    equal(recovered.map(value => value.id), group.attempts.map(value => value.id), 'Journal attempt inventory differs from controller');
    let previousWarmProof=null, previousFastWarmProof=null;
    for (const [index, attempt] of recovered.entries()) {
      const actual = group.attempts[index];
      const terminalOverride = index === recovered.length - 1 && attempt.status !== 'PASS' && (group.timedOut === true || group.process?.interrupted === true);
      if (terminalOverride) {
        const elapsedMs = attempt.elapsedMs ?? 0, timedOut = group.timedOut === true;
        const expected = { ...attempt, status: 'FAIL', timedOut, elapsedMs,
          censor: { lowerMs: elapsedMs, upperMs: null, reason: timedOut ? 'process-timeout' : 'interrupted', timedBoundary: attempt.startMs === undefined ? 'reset-or-preparation' : 'action', durationUnavailable: elapsedMs === 0 } };
        equal(actual, expected, 'Killed attempt differs from its deterministic journal override');
      } else equal(actual, attempt, 'Attempt differs from its journal');
      verifyArtifactReferences(actual.result, root, records, { originalGroupOutput: group.output, folder });
      if (!byteAudit && group.cell.operation === 'navigation.ready' && actual.result?.nativeNavigation) {
        const proof = await verifyNavigationWindowServerEvidence({attempt: actual, cell: group.cell, serial: index + 1,
          configuration: input.configuration, groupOutput: group.output, environment: navigationEnvironment,
          retainedPaths: [...records.keys()].filter(path => path.startsWith(folder + '/')).map(path => path.slice(folder.length + 1)),
          readRetained: (path, {maximum} = {}) => bytes(`${folder}/${safeRelative(path)}`, {cacheResult: false, maximum}),
          resolveRetained: path => ordinaryPath(root, `${folder}/${safeRelative(path)}`),
          controlFiles: receipt.identity.controlBefore.files, sourceFiles: receipt.identity.before.files, fixture: input.fixture,
          workerProcessIdentity: group.processIdentity, sourceRoot: input.repo,
          developerState: consumedInputs.developerState, developerStateIdentity: receipt.inputIdentities.developerState,
          browserCache: input.browserCache, tools: receipt.identity.tools});
        if (proof) nativeNavigations.set(actual.id, proof);
      }
      previousWarmProof=await verifyWarmAttempt({cell:group.cell,attempt:actual,previous:previousWarmProof,workerProcessIdentity:group.processIdentity,fixture:input.fixture,
        readRetained:(path,{maximum}={})=>{if(!isAbsolute(path)||!path.startsWith(group.output+sep))throw Error('Warm proof must remain in its owning group');return bytes(`${folder}/${relative(group.output,resolve(path)).split(sep).join('/')}`,{cacheResult:false,maximum});}});
      previousFastWarmProof=await verifyFastWarmAttempt({cell:group.cell,attempt:actual,previous:previousFastWarmProof,fixture:input.fixture,workerProcessIdentity:group.processIdentity,controlFiles:receipt.identity.controlBefore.files,buildFiles:receipt.identity.buildsBefore.files,
        readRetained:(path,{maximum}={})=>{if(!isAbsolute(path)||!path.startsWith(group.output+sep))throw Error('Fast warm proof must remain in its owning group');return bytes(`${folder}/${relative(group.output,resolve(path)).split(sep).join('/')}`,{cacheResult:false,maximum});}});
      await verifyWQCacheAttempt({cell:group.cell,attempt:actual,fixture:input.fixture,seenRoots:wqCacheRoots,workerProcessIdentity:group.processIdentity,controlFiles:receipt.identity.controlBefore.files,buildFiles:receipt.identity.buildsBefore.files,
        readRetained:(path,{maximum}={})=>{if(!isAbsolute(path)||!path.startsWith(group.output+sep))throw Error('WQ cache proof must remain in its owning group');return bytes(`${folder}/${relative(group.output,resolve(path)).split(sep).join('/')}`,{cacheResult:false,maximum});}});
      if (group.cell.operation === 'developer.hot-update' && actual.result?.hotEdit?.windowServerPresentation) {
        const proof = await verifyHmrWindowServerEvidence({attempt: actual, configuration: input.configuration, groupOutput: group.output,
          retainedPaths: [...records.keys()].filter(path => path.startsWith(folder + '/')).map(path => path.slice(folder.length + 1)),
          readRetained: (path, {maximum} = {}) => bytes(`${folder}/${safeRelative(path)}`, {cacheResult: false, maximum}),
          resolveRetained: path => ordinaryPath(root, `${folder}/${safeRelative(path)}`),
          controlFiles: receipt.identity.controlBefore.files, sourceFiles: receipt.identity.before.files, fixture: input.fixture,
          workerPid: group.processIdentity?.pid, sourceRoot: input.repo, engine: group.cell.parameters?.browser ?? 'chromium',
          developerState: consumedInputs.developerState, developerStateIdentity: receipt.inputIdentities.developerState, subjectDigest: receipt.identity.before.digest});
        if (proof) nativeHotEdits.set(actual.id, proof);
      }
      if (group.cell.operation === 'interaction.first-use' && actual.result?.firstUse?.nativePresentation) {
        const proof = await verifyFirstUseWindowServerEvidence({attempt: actual, cell: group.cell, configuration: input.configuration, groupOutput: group.output,
          retainedPaths: [...records.keys()].filter(path => path.startsWith(folder + '/')).map(path => path.slice(folder.length + 1)),
          readRetained: (path, {maximum} = {}) => bytes(`${folder}/${safeRelative(path)}`, {cacheResult: false, maximum}),
          resolveRetained: path => ordinaryPath(root, `${folder}/${safeRelative(path)}`),
          controlFiles: receipt.identity.controlBefore.files, sourceFiles: receipt.identity.before.files, fixture: input.fixture,
          workerPid: group.processIdentity?.pid, sourceRoot: input.repo, engine: group.cell.parameters?.browser ?? 'chromium',
          developerState: consumedInputs.developerState, developerStateIdentity: receipt.inputIdentities.developerState,
          subjectDigest: receipt.identity.before.digest, browserCache: input.browserCache, tools: receipt.identity.tools});
        if (proof) nativeFirstUses.set(actual.id, proof);
      }
      if (group.cell.operation === 'interaction.brush' && actual.result?.session?.nativePresentation || group.cell.operation === 'text.interaction' && actual.result?.nativeText) {
        const members = [...records.values()].filter(file => file.path.startsWith(folder + '/')).map(file => ({...file, path: file.path.slice(folder.length + 1)}));
        const verifier = group.cell.operation === 'text.interaction' ? verifyTextSessionWindowServerEvidence : verifySessionWindowServerEvidence;
        const proof = await verifier({attempt: actual, cell: group.cell, serial: index + 1, configuration: input.configuration, groupOutput: group.output,
          retainedPaths: members.map(file => file.path), retainedFiles: members,
          readRetained: (path, {maximum} = {}) => bytes(`${folder}/${safeRelative(path)}`, {cacheResult: false, maximum}),
          resolveRetained: path => ordinaryPath(root, `${folder}/${safeRelative(path)}`),
          controlFiles: receipt.identity.controlBefore.files, sourceFiles: receipt.identity.before.files, fixture: input.fixture,
          workerPid: group.processIdentity?.pid, workerProcessIdentity: group.processIdentity, sourceRoot: input.repo, engine: group.cell.parameters?.browser ?? 'chromium',
          developerState: consumedInputs.developerState, developerStateIdentity: receipt.inputIdentities.developerState,
          subjectDigest: receipt.identity.before.digest, browserCache: input.browserCache, tools: receipt.identity.tools, evidenceStorage: receipt.evidenceStorage});
        if (proof) nativeSessions.set(actual.id, proof);
      }
      if (!byteAudit && ORDINARY_TEXT_OPERATIONS.includes(group.cell.operation)) {
        const members = [...records.values()].filter(file => file.path.startsWith(folder + '/')).map(file => ({...file, path: file.path.slice(folder.length + 1)}));
        await verifyOrdinaryTextEvidence({attempt: actual, cell: group.cell, serial: index + 1, fixture: input.fixture,
          environment: ordinaryTextEnvironment, workerProcessIdentity: group.processIdentity, groupOutput: group.output, retainedFiles: members,
          readRetained: (path, {maximum} = {}) => bytes(`${folder}/${safeRelative(path)}`, {cacheResult: false, maximum}),
          controlFiles: receipt.identity.controlBefore.files, sourceFiles: receipt.identity.before.files, sourceRoot: input.repo,
          browserCache: input.browserCache, tools: receipt.identity.tools, developerState: consumedInputs.developerState,
          developerStateIdentity: receipt.inputIdentities.developerState, journalEvents: journal.events});
      }
      if (!byteAudit && group.cell.operation === 'text.recovery') {
        const members = [...records.values()].filter(file => file.path.startsWith(folder + '/')).map(file => ({...file, path: file.path.slice(folder.length + 1)}));
        await verifyRecoveryFontEvidence({attempt: actual, cell: group.cell, serial: index + 1, fixture: input.fixture,
          environment: recoveryTextEnvironment, workerProcessIdentity: group.processIdentity, groupOutput: group.output, retainedFiles: members,
          readRetained: (path, {maximum} = {}) => bytes(`${folder}/${safeRelative(path)}`, {cacheResult: false, maximum}),
          controlFiles: receipt.identity.controlBefore.files, sourceFiles: receipt.identity.before.files, sourceRoot: input.repo,
          browserCache: input.browserCache, tools: receipt.identity.tools, developerState: consumedInputs.developerState,
          developerStateIdentity: receipt.inputIdentities.developerState, journalEvents: journal.events});
      }
      if (!byteAudit && ORDINARY_COMPOSITION_OPERATIONS.includes(group.cell.operation)) {
        const members = [...records.values()].filter(file => file.path.startsWith(folder + '/')).map(file => ({...file, path: file.path.slice(folder.length + 1)}));
        await verifyOrdinaryCompositionEvidence({attempt: actual, cell: group.cell, serial: index + 1, fixture: input.fixture,
          environment: ordinaryCompositionEnvironment, workerProcessIdentity: group.processIdentity, groupOutput: group.output, retainedFiles: members,
          readRetained: (path, {maximum} = {}) => bytes(`${folder}/${safeRelative(path)}`, {cacheResult: false, maximum}),
          controlFiles: receipt.identity.controlBefore.files, sourceFiles: receipt.identity.before.files, sourceRoot: input.repo,
          browserCache: input.browserCache, tools: receipt.identity.tools, developerState: consumedInputs.developerState,
          developerStateIdentity: receipt.inputIdentities.developerState, journalEvents: journal.events});
      }
      if (!byteAudit && group.cell.handler === 'browser' && TEXT_RESOURCE_OPERATIONS.includes(group.cell.operation)) {
        const proof = actual.result?.textResources?.evidence?.rendererOwnershipProof ?? null;
        const executableIdentity = {sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools)};
        if (proof) {
          if (!input.rendererIdentity) throw Error('Text resource renderer proof lacks independently bound executable inputs');
          const {verifyRendererOwnershipProof} = await import('./renderer-ownership.mjs');
          await verifyRendererOwnershipProof(proof, {output: group.output, sourceFiles: receipt.identity.before.files, buildFiles: receipt.identity.buildsBefore.files,
            executableIdentity, readRetained: path => bytes(`${folder}/${safeRelative(path)}`, {cacheResult: false, maximum: 32 * 1048576})});
        }
        await verifyOrdinaryTextResourceEvidence({cell: group.cell, attempt: actual, serial: index + 1, fixture: input.fixture,
          processIdentity: group.processIdentity, executableIdentity, rendererOwnershipProof: proof, journalEvents: journal.events,
          readRetained: (path, options) => {
            if (!isAbsolute(path) || !path.startsWith(group.output + sep)) throw Error('Text resource evidence must remain inside its owning group');
            return bytes(`${folder}/${safeRelative(relative(group.output, resolve(path)).split(sep).join('/'))}`, {cacheResult: false, maximum: options?.maximum});
          }});
      }
      if (group.cell.operation === 'text.native-ime' && actual.result?.observations?.nativeIme) {
        const members = [...records.values()].filter(file => file.path.startsWith(folder + '/')).map(file => ({...file, path: file.path.slice(folder.length + 1)}));
        const proof = await verifyNativeImeEvidence({attempt: actual, cell: group.cell, serial: index + 1, configuration: input.configuration,
          groupOutput: group.output, retainedPaths: members.map(file => file.path), retainedFiles: members,
          readRetained: (path, {maximum} = {}) => bytes(`${folder}/${safeRelative(path)}`, {cacheResult: false, maximum}),
          fixture: input.fixture, workerProcessIdentity: group.processIdentity, sourceRoot: input.repo,
          engine: group.cell.parameters?.browser ?? group.cell.browser ?? input.configuration?.browser?.engine ?? 'chromium', developerState: consumedInputs.developerState,
          developerStateIdentity: receipt.inputIdentities.developerState, browserCache: input.browserCache, tools: receipt.identity.tools,
          environment: nativeImeEnvironment, controlFiles: receipt.identity.controlBefore.files, journalEvents: journal.events});
        if (proof) nativeImes.set(actual.id, proof);
      }
      if (group.cell.handler === 'browser' && group.cell.kind === 'lifecycle') {
        const samplingArtifact = actual.result?.sampling?.artifact;
        let rawSamples = [];
        if (samplingArtifact?.path && sha(samplingArtifact.sha256) && Number.isSafeInteger(samplingArtifact.bytes)) {
          if (!isAbsolute(samplingArtifact.path) || !samplingArtifact.path.startsWith(group.output + sep)) throw Error('Resource samples must be retained inside their lifecycle group');
          const samplePath = `${folder}/${relative(group.output, resolve(samplingArtifact.path)).split(sep).join('/')}`;
          const { verifyResourceSamplingEvidence } = await import('./resource-sampling-verification.mjs');
          const replay = verifyResourceSamplingEvidence(await bytes(samplePath), actual.result.sampling, { lifecycle: actual.result });
          rawSamples = replay.samples;
        } else if (actual.result?.sampling?.complete === true) throw Error('Complete lifecycle resource sampling lacks a sealed raw artifact');
        const proof = lifecycleRendererProof(actual.result, rawSamples);
        if (proof) {
          if (!input.rendererIdentity) throw Error('Renderer ownership proof lacks independently bound executable inputs');
          const { verifyRendererOwnershipProof } = await import('./renderer-ownership.mjs');
          await verifyRendererOwnershipProof(proof, { output: group.output, sourceFiles: receipt.identity.before.files, buildFiles: receipt.identity.buildsBefore.files,
            executableIdentity: { sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools) },
            readRetained: path => bytes(`${folder}/${safeRelative(path)}`) });
        }
        await verifyLifecycleTextResourceEvidence({cell: group.cell, result: actual.result, fixture: input.fixture,
          executableIdentity: {sourceDigest: receipt.identity.before.digest, buildDigest: receipt.identity.buildsBefore.digest, toolsDigest: digest(receipt.identity.tools)},
          rendererOwnershipProof: proof, journalEvents: journal.events,
          readRetained: (path, options) => {
            if (!isAbsolute(path) || !path.startsWith(group.output + sep)) throw Error('Lifecycle text resource evidence must remain inside its owning group');
            return bytes(`${folder}/${safeRelative(relative(group.output, resolve(path)).split(sep).join('/'))}`, {cacheResult: false, maximum: options?.maximum});
          }});
        await verifyLifecycleCompositionEvidence({cell: group.cell, result: actual.result, attemptStatus: actual.status, fixture: input.fixture, journalEvents: journal.events,
          readRetained: (path, options) => {
            if (!isAbsolute(path) || !path.startsWith(group.output + sep)) throw Error('Lifecycle Composition evidence must remain inside its owning group');
            return bytes(`${folder}/${safeRelative(relative(group.output, resolve(path)).split(sep).join('/'))}`, {cacheResult: false, maximum: options?.maximum});
          }});
        if (rawSamples.length) {
          const { isRendererTextureNotApplicable } = await import('./renderer-ownership.mjs');
          for (const sample of rawSamples) if (sample.allocationCoverage?.complete === true && (sample.textureSide === null || sample.deviceTextureLimit === null)) {
            if (sample.textureSide !== null || sample.deviceTextureLimit !== null || !isRendererTextureNotApplicable(sample.rendererOwnership, sample.rendererOwnershipProof, { gpuBytes: sample.gpuBytes })) throw Error('Raw resource ledger claims complete texture coverage without a validated ownership proof');
          }
        }
      }
      if (isBrowserWALifecycle(group.cell)) await verifyBrowserWALifecycle({cell: group.cell, result: actual.result?.lifecycle ?? actual.result, fixture: input.fixture,
        executableIdentity: input.rendererIdentity, workerProcessIdentity: group.processIdentity,
        runtimePath: join(group.output, 'browser-runtime.json'),
        readRetained: path => {
          if (!isAbsolute(path) || !path.startsWith(group.output + sep)) throw Error('H-WA evidence must remain inside its owning lifecycle group');
          return bytes(`${folder}/${relative(group.output, resolve(path)).split(sep).join('/')}`, {cacheResult: false, maximum: 16 * 1048576});
        }});
      await verifyAdapterImportObservation({cell: group.cell, attempt: actual, workerProcessIdentity: group.processIdentity,
        readRetained: (path, {maximum} = {}) => {
          if (!isAbsolute(path) || !path.startsWith(group.output + sep)) throw Error('Adapter import evidence must remain inside its owning group');
          return bytes(`${folder}/${relative(group.output, resolve(path)).split(sep).join('/')}`, {cacheResult: false, maximum});
        }});
      await verifyAdapterLifecycleResourceEvidence({ cell: group.cell, result: actual.result,
        readRetained: path => {
          if (!isAbsolute(path) || !path.startsWith(group.output + sep)) throw Error('Adapter resource samples must be retained inside their lifecycle group');
          const samplePath = `${folder}/${relative(group.output, resolve(path)).split(sep).join('/')}`;
          return bytes(samplePath);
        } });
      if (byteAudit && actual.result?.d11) {
        const artifact = actual.result.d11.artifact, original = group.output;
        if (!artifact || typeof artifact.path !== 'string' || !isAbsolute(artifact.path) || !artifact.path.startsWith(original + sep)) throw Error('Byte audit raw observation must be retained inside its own group');
        const artifactPath = `${folder}/${relative(original, resolve(artifact.path)).split(sep).join('/')}`;
        const identities = { buildFiles: receipt.identity.buildsBefore.files, sourceFiles: receipt.identity.before.files, fixtureSeal: input.fixture?.seal?.sha256 ?? null };
        const declaredFeatureActions = group.cell.operation === 'navigation.ready' && ['W0', 'W1'].includes(group.cell.workload)
          && input.byteAudit?.actionsPerStart !== undefined;
        if (declaredFeatureActions || Object.hasOwn(actual.result, 'featureAbsence') || Object.hasOwn(actual.result, 'featureAudits')) {
          const { verifyD11FeatureAuditAttempt } = await import('./browser-d11-feature-verification.mjs');
          await verifyD11FeatureAuditAttempt({ cell: group.cell, attempt: actual, actionsPerStart: input.byteAudit?.actionsPerStart,
            output: group.output, ...identities, readBytes: path => bytes(`${folder}/${safeRelative(path)}`, { cacheResult: false, maximum: 256 * 1024 * 1024 }) });
        } else {
          const { verifyD11RetainedObservation } = await import('./browser-d11-verification.mjs');
          verifyD11RetainedObservation(await json(artifactPath), actual.result.d11, identities);
        }
        verifyByteAuditStartupBoundary({ cell: group.cell, attempt: actual, fixture: input.fixture });
      }
      if (group.cell.handler === 'developer' && ['C2/production-build', 'I1/command-groups'].includes(group.cell.id)) {
        const { verifyDeveloperBuildObservation } = await import('./developer-byte-verification.mjs');
        await verifyDeveloperBuildObservation({ cell: group.cell, attempt: actual, source: receipt.identity.before, output: group.output, readBytes: path => bytes(`${folder}/${safeRelative(path)}`) });
      }
      attemptsVerified++;
    }
    const workerPath = `${folder}/receipt.json`;
    if (records.has(workerPath) && !group.partial) {
      const worker = await json(workerPath);
      if (worker.kind !== (byteAudit ? 'perf-byte-audit-group-1' : 'perf-campaign-process-1')) throw Error('Unexpected worker receipt');
      equal(worker.attempts, recovered, 'Worker receipt differs from journal');
      for (const [name, value] of Object.entries(worker)) if (!['status', 'attempts'].includes(name)) equal(group[name], value, 'Controller differs from worker receipt');
      if (journal.events.at(-1)?.event !== 'process-end' || journal.events.at(-1).status !== worker.status) throw Error('Worker outcome differs from terminal journal evidence');
      if (group.status !== worker.status && !(group.status === 'FAIL' && (group.timedOut || group.process?.interrupted || group.process?.exitCode !== 0 || group.process?.ownedCleanupError || group.process?.sourceRecoveryError))) throw Error('Controller changed worker outcome without terminal failure evidence');
    } else if (group.status === 'PASS') throw Error('Passing group lacks a complete worker receipt');
  }
  return { evidenceFiles: records.size, groups: receipt.groups.length, byteAuditGroups: auditGroups.length, attempts: attemptsVerified, consumedInputs, nativeHotEdits, nativeFirstUses, nativeSessions, nativeImes, nativeNavigations };
}

function recoverJournal(events, group) {
  const attempts = [], ids = new Set(); let active = null, ended = false;
  if (!events.length || events[0].event !== 'process-start' || events[0].cellId !== group.cell.id) throw Error('Journal lacks its process/cell start');
  if (group.processIdentity) equal(events[0].processIdentity, group.processIdentity, 'Journal process identity differs');
  for (const [index, event] of events.entries()) {
    if (ended) throw Error('Journal continues after process end');
    if (event.event === 'process-start' && index !== 0) throw Error('Repeated process start');
    if (event.event === 'attempt-start') {
      if (active || !event.attempt?.id || ids.has(event.attempt.id)) throw Error('Duplicate or overlapping journal attempt');
      ids.add(event.attempt.id); active = { ...event.attempt, status: 'INCONCLUSIVE' }; attempts.push(active);
    } else if (event.event === 'attempt-action-start') {
      if (!active || active.id !== event.id || active.startMs !== undefined) throw Error('Orphan or repeated action start');
      Object.assign(active, { startMs: event.startMs, reset: event.reset, resetElapsedMs: event.resetElapsedMs });
    } else if (event.event === 'attempt-end') {
      if (!active || event.attempt?.id !== active.id) throw Error('Orphan or repeated attempt end');
      for (const key of ['id', 'cache', 'ordinal', 'prime']) equal(event.attempt[key], active[key], 'Journal attempt identity changed');
      if (active.startMs !== undefined) for (const key of ['startMs', 'reset', 'resetElapsedMs']) equal(event.attempt[key], active[key], 'Journal action boundary changed');
      else if (event.attempt.status === 'PASS') throw Error('Passing attempt lacks its action start');
      attempts[attempts.length - 1] = event.attempt; active = null;
    } else if (event.event === 'process-end') {
      if (active) throw Error('Process ended with an unfinished attempt');
      if (group.status === 'PASS' && event.status !== 'PASS') throw Error('Passing controller differs from journal outcome');
      ended = true;
    }
  }
  if (group.status === 'PASS' && (!ended || attempts.some(attempt => attempt.status !== 'PASS'))) throw Error('Passing group lacks complete successful journal attempts');
  return attempts;
}

function verifyArtifactReferences(value, root, records, location) {
  if (!value || typeof value !== 'object') return;
  function reference(path, identity = null) {
    if (typeof path !== 'string') throw Error('Invalid artifact reference');
    const original = location.originalGroupOutput;
    // Receipts remain verifiable after an evidence packet is copied to a new
    // directory. Only paths inside the sealed original group are remapped.
    const local = isAbsolute(path) && path.startsWith(original + sep)
      ? location.folder + '/' + relative(original, resolve(path)).split(sep).join('/')
      : isAbsolute(path) ? relative(root, resolve(path)).split(sep).join('/') : path;
    const record = records.get(safeRelative(local));
    if (!record) throw Error('Referenced artifact lacks sealed retained bytes');
    if (identity?.bytes !== undefined && identity.bytes !== record.bytes) throw Error('Artifact byte length differs');
    if (identity?.byteLength !== undefined && String(identity.byteLength) !== String(record.bytes)) throw Error('Artifact byte length differs');
    if (identity?.sha256 !== undefined && (identity.sha256.startsWith('sha256:') ? identity.sha256 : 'sha256:' + identity.sha256) !== record.sha256) throw Error('Artifact hash differs');
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'artifacts' && Array.isArray(child)) for (const item of child) { if (typeof item === 'string') reference(item); else if (item?.path) reference(item.path, item); }
    if (key === 'artifact' && child?.path) reference(child.path, child);
    if (Array.isArray(child)) for (const item of child) verifyArtifactReferences(item, root, records, location);
    else if (child && typeof child === 'object') verifyArtifactReferences(child, root, records, location);
  }
}
