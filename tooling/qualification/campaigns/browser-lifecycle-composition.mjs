import {createHash} from 'node:crypto';
import {basename, dirname, isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {deriveCompositionMeasurements} from './browser-composition-counters.mjs';

export const LIFECYCLE_COMPOSITION_NAMES = Object.freeze(['R38DerivedSnapshotBytes', 'R38IssueBytes', 'R38RawPageBytes',
  'R38MaterializedRawInspectionBytes', 'R38TextCaptionWorkspaceBytes', 'R38RawTruncationOrFalseCompletenessCount']);
const names = new Set(LIFECYCLE_COMPOSITION_NAMES);
const workspaceNames = new Set(['R38MaterializedRawInspectionBytes', 'R38TextCaptionWorkspaceBytes']);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const time = value => Number.isFinite(value) && value >= 0;
const demand = (value, message) => {if (!value) throw Error('Lifecycle Composition: ' + message);};
const same = (a, b, message) => demand(isDeepStrictEqual(a, b), message);
const rows = values => (values ?? []).filter(row => names.has(row.name));
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/** A continuous producer journal proves its selected payload reservations only.
 * Keep those diagnostics outside scoreable resident-workspace rows, including
 * when a conservative allowance exceeds a ceiling. Exact byte rows retain
 * their independent producer coverage. No native/RSS authority is introduced. */
export function projectLifecycleComposition({allocations, required, failed = false}) {
  const selected = required.filter(name => names.has(name));
  const boundaries = allocations.length >= 2 && allocations[0].label === 'before-open' &&
    allocations.at(-1).label === 'after-release' && allocations.every(value => value.compositionObservations);
  const derived = deriveCompositionMeasurements(allocations.map(value => value.compositionObservations).filter(Boolean),
    {required: selected, failed: failed || !boundaries});
  const measurements = derived.measurements.filter(row => !workspaceNames.has(row.name));
  const logicalReservations = derived.measurements.filter(row => workspaceNames.has(row.name)).map(row => ({...row,
    complete: false, scope: row.name === 'R38TextCaptionWorkspaceBytes' ?
      'prompt-and-selected-composition-control-logical-reservations-only' : 'prompt-kind-raw-inspection-logical-reservations-only', ceilingAssessment: 'unavailable'}));
  if (selected.includes('R38TextCaptionWorkspaceBytes') && !logicalReservations.some(row => row.name === 'R38TextCaptionWorkspaceBytes')) {
    const observed = allocations.map(value => value.captionWorkspaceBytes).filter(natural);
    if (observed.length) logicalReservations.push({name: 'R38TextCaptionWorkspaceBytes', value: Math.max(...observed), unit: 'bytes',
      method: 'Endpoint prompt-kind reservation observation; complete producer journal unavailable', complete: false,
      scope: 'prompt-kind-logical-reservations-only', ceilingAssessment: 'unavailable'});
  }
  const missing = [...derived.missing];
  if (!boundaries && selected.length) missing.push('Composition before-open/after-release producer brackets are incomplete');
  for (const name of selected) if (workspaceNames.has(name)) missing.push(name + ': complete resident Composition allocation coverage is unavailable');
  return {measurements, evidence: {kind: 'lifecycle-composition-analysis-1', producer: derived.evidence,
    logicalReservations, missing: [...new Set(missing)], physicalMemoryComplete: false, originalRawHashVerification: false}};
}

/** Replay every serialized lifecycle R38 publication from its sealed original
 * snapshots. A bound artifact or a complete flag alone is not metric authority.
 * The campaign caller confines reads to its immutable retained group packet. */
export async function verifyLifecycleCompositionEvidence({cell, result, fixture, readRetained, journalEvents, attemptStatus}) {
  if (cell?.handler !== 'browser' || cell.kind !== 'lifecycle' || cell.operation !== 'lifecycle.editor' ||
      !(cell.requiredMeasurements ?? []).some(rule => rule.budgetId === 'R38')) return {applicable: false};
  const rules = cell.requiredMeasurements.filter(rule => rule.budgetId === 'R38');
  demand(rules.every(rule => names.has(rule.name) && rule.unit === (rule.name.endsWith('Count') ? 'violations' : 'bytes')) &&
    new Set(rules.map(rule => rule.name)).size === rules.length, 'required metric registry differs');
  const passing = attemptStatus === 'PASS' || result?.status === 'PASS';
  demand(result == null || typeof result === 'object' && !Array.isArray(result), 'result inventory is malformed');
  // Interrupted preparation can publish no lifecycle result at all. Preserve
  // that absence as incomplete, without accepting any unbound metric or PASS.
  demand(result?.measurements === undefined || Array.isArray(result.measurements) && result.measurements.length === 0,
    'top-level publication lacks corresponding cycle evidence');
  if (result?.cycles == null) {
    demand(!passing && !result?.lifecycleCounterEvidence && !result?.failedActionEvidence,
      'missing cycle inventory cannot authorize publication or PASS');
    return {applicable: true, complete: false};
  }
  demand(Array.isArray(result.cycles) && result.cycles.length <= 4096, 'bounded cycle inventory is unavailable');
  const required = rules.map(rule => rule.name), seen = new Set(), artifacts = new Set();
  let complete = result.cycles.length > 0;
  for (const cycle of result.cycles) {
    demand(natural(cycle.ordinal) && cycle.ordinal > 0 && !seen.has(cycle.ordinal), 'cycle is duplicated or invalid'); seen.add(cycle.ordinal);
    const counter = cycle.action?.lifecycleCounterEvidence ?? cycle.failedActionEvidence;
    const published = rows(cycle.action?.measurements ?? counter?.measurements);
    if (!counter?.artifact) {
      demand(!published.length && cycle.action?.status !== 'PASS' && !passing, 'published metrics lack their counter artifact');
      complete = false; continue;
    }
    const artifact = counter.artifact;
    demand(isAbsolute(artifact.path ?? '') && basename(dirname(artifact.path)) === 'lifecycle-counters' &&
      basename(artifact.path) === 'cycle-' + String(cycle.ordinal).padStart(3, '0') + '.json' && !artifacts.has(artifact.path) &&
      natural(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= 8 * 1048576 && /^sha256:[a-f0-9]{64}$/.test(artifact.sha256 ?? ''), 'counter artifact identity differs');
    artifacts.add(artifact.path);
    const bytes = await readRetained(artifact.path, {maximum: 8 * 1048576});
    demand(bytes.byteLength === artifact.bytes && hash(bytes) === artifact.sha256, 'counter artifact hash/length differs');
    const raw = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    demand(raw.kind === 'lifecycle-counters-artifact-1' && raw.schemaVersion === 1 && raw.cellId === cell.id && raw.cycleOrdinal === cycle.ordinal &&
      raw.fixtureIdentity === fixture?.seal?.sha256 && raw.fixtureIdentity === cycle.fixtureIdentity && raw.fixtureIdentity === result.fixtureIdentity &&
      raw.processIdentity === cycle.processIdentity && raw.processIdentity === result.processIdentity, 'counter parent binding differs');
    demand(typeof raw.failed === 'boolean' && raw.clock === 'runner-monotonic' &&
      [cycle.startMs, cycle.endMs, raw.startedMs, raw.endedMs].every(time) && cycle.startMs <= raw.startedMs &&
      raw.startedMs <= raw.endedMs && raw.endedMs <= cycle.endMs, 'counter action interval differs');
    demand(Array.isArray(raw.allocations) && raw.allocations.length <= 4096 && Array.isArray(raw.metrics) && Array.isArray(counter.measurements), 'counter producer inventory is unavailable');
    let previous = raw.startedMs;
    for (const value of raw.allocations) {
      demand(time(value?.startMs) && time(value?.endMs) && value.startMs >= previous && value.endMs >= value.startMs && value.endMs <= raw.endedMs,
        'producer observation interval differs'); previous = value.endMs;
    }
    demand(Array.isArray(journalEvents), 'actual producer journal is unavailable');
    const events = journalEvents.filter(event => event.event === 'lifecycle-composition-observed' && event.cellId === cell.id && event.cycleOrdinal === cycle.ordinal);
    demand(events.length === 1 && time(events[0].monotonicMs) && events[0].monotonicMs >= raw.endedMs && events[0].monotonicMs <= cycle.endMs,
      'producer journal closure differs');
    same(events[0].artifact, artifact, 'producer journal artifact differs');
    same({fixtureIdentity: events[0].fixtureIdentity, processIdentity: events[0].processIdentity, startedMs: events[0].startedMs, endedMs: events[0].endedMs},
      {fixtureIdentity: raw.fixtureIdentity, processIdentity: raw.processIdentity, startedMs: raw.startedMs, endedMs: raw.endedMs}, 'producer journal binding differs');
    const projection = projectLifecycleComposition({allocations: raw.allocations, required, failed: raw.failed});
    same(raw.evidence?.composition, projection.evidence, 'producer replay summary differs');
    same(rows(raw.metrics), projection.measurements, 'raw metric publication differs');
    const expected = projection.measurements.map(row => ({...row, evidence: {kind: 'lifecycle-measurement-evidence-1', cellId: cell.id,
      cycleOrdinal: cycle.ordinal, processIdentity: raw.processIdentity, fixtureIdentity: raw.fixtureIdentity,
      coverage: row.complete ? 'complete-cycle-actions' : 'observed-partial-cycle-actions', artifact}}));
    same(rows(counter.measurements), expected, 'counter metric publication differs');
    same(published, expected, 'action metric publication differs');
    const cycleComplete = !!cycle.action && ['PASS', 'INCONCLUSIVE'].includes(cycle.action.status) && !raw.failed &&
      required.every(name => projection.measurements.some(row => row.name === name && row.complete));
    if (!cycleComplete) {complete = false; demand(cycle.action?.status !== 'PASS' && !passing, 'incomplete producer coverage was reported passing');}
  }
  demand(complete || !passing, 'incomplete cycle inventory was reported passing');
  return {applicable: true, complete};
}
