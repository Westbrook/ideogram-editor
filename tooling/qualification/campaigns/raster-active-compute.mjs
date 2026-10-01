import { digest } from './common.mjs';

const kernels = ['accumulator', 'contribution', 'fold', 'finish', 'preserve', 'resample', 'matte', 'coverage-scan'];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const close = (left, right) => Math.abs(left - right) <= 32 * Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));

/** Pure ComposeRaster has one fixed 128px tile traversal. Its worker sidecar is
 * the streaming union of real synchronous kernels, not its IO/yield wall span.
 * A bounded diagnostic prefix is sufficient only when the complete scalar and
 * exact operation counters survive unchanged in the same worker snapshot. */
export function compositeActiveEvidence(snapshot, wall, expected) {
  const missing = [], value = snapshot?.activeCompute;
  const requireValue = (condition, reason) => { if (!condition) missing.push(reason); };
  requireValue(snapshot?.schemaVersion === 1 && snapshot.lane === 'raster-worker' && snapshot.invalid === 0 && snapshot.dropped === 0, 'complete same-worker phase snapshot');
  requireValue(wall?.phase === 'raster.composite' && wall.outcome === 'ok' && wall.context?.boundary === 'observed' && finite(wall.startedMs) && finite(wall.endedMs) && wall.endedMs >= wall.startedMs, 'completed composite wall envelope');
  requireValue(integer(expected?.width) && expected.width > 0 && integer(expected?.height) && expected.height > 0 && integer(expected?.layerCount) && expected.layerCount > 0, 'exact expected composition dimensions and layer count');
  requireValue(wall?.context?.width === expected?.width && wall?.context?.height === expected?.height && wall?.context?.count === expected?.layerCount, 'composition shape and layer identity');
  requireValue(value?.schemaVersion === 1 && value.kind === 'raster-active-compute-1' && value.lane === 'raster-worker' && value.boundary === 'synchronous-kernel-elapsed-excluding-io' && value.outcome === 'completed' && value.complete === true && value.invalid === 0 && finite(value.clockOriginUnixMs) && value.clockUncertaintyMs === null, 'complete active-compute sidecar');
  requireValue(typeof wall?.context?.commandId === 'string' && value?.context?.commandId === wall.context.commandId, 'same-command active computation');
  for (const key of ['documentId', 'revision', 'transactionId', 'outputAssetId']) requireValue(value?.context?.[key] === wall?.context?.[key], 'same-worker ' + key + ' correlation');
  let expectedKernels = null;
  if (value && expected?.width > 0 && expected?.height > 0 && expected?.layerCount > 0) {
    const tiles = Math.ceil(expected.width / 128) * Math.ceil(expected.height / 128), multiple = expected.layerCount > 1;
    const counts = { accumulator: multiple ? tiles : 0, contribution: tiles * expected.layerCount, fold: multiple ? tiles * expected.layerCount : 0, finish: multiple ? tiles : 0, preserve: 0, resample: 0, matte: 0, 'coverage-scan': 0 };
    expectedKernels = Object.values(counts).reduce((sum, count) => sum + count, 0);
    requireValue(value.operations && Object.keys(value.operations).length === kernels.length && kernels.every(key => integer(value.operations[key]) && value.operations[key] === counts[key]), 'exact composite kernel counts');
  }
  const intervals = Array.isArray(value?.intervals) ? value.intervals : [];
  requireValue(integer(value?.intervalCount) && value.intervalCount > 0 && intervals.length === Math.min(128, value.intervalCount) && value.omittedIntervals === value.intervalCount - intervals.length, 'bounded interval prefix and complete count');
  requireValue(expectedKernels !== null && value?.intervalCount >= expectedKernels, 'an active interval for every synchronous kernel call');
  requireValue(finite(value?.startedMs) && finite(value?.endedMs) && value.endedMs >= value.startedMs && value.startedMs >= wall?.startedMs && value.endedMs <= wall?.endedMs, 'active envelope inside composite wall envelope');
  requireValue(finite(value?.unionMs) && finite(value?.totalMs) && value.unionMs === value.totalMs && (value.unionMs <= value.endedMs - value.startedMs || close(value.unionMs, value.endedMs - value.startedMs)), 'complete nonoverlapping active scalar');
  let retainedMs = 0, compensation = 0;
  for (const [index, interval] of intervals.entries()) {
    requireValue(finite(interval?.startMs) && finite(interval?.endMs) && interval.endMs >= interval.startMs && interval.startMs >= value?.startedMs && interval.endMs <= value?.endedMs && (!index || interval.startMs >= intervals[index - 1]?.endMs), 'ordered nonoverlapping active intervals');
    const increment = interval?.endMs - interval?.startMs - compensation, sum = retainedMs + increment;
    compensation = (sum - retainedMs) - increment; retainedMs = sum;
  }
  requireValue(intervals[0]?.startMs === value?.startedMs && finite(retainedMs) && (retainedMs <= value?.unionMs || close(retainedMs, value?.unionMs)), 'retained prefix bounded by exact active union');
  if (value?.omittedIntervals === 0) requireValue(intervals.at(-1)?.endMs === value.endedMs && close(retainedMs, value.unionMs), 'complete intervals reproduce active union');
  if (missing.length) return { phase: null, missing: [...new Set(missing)].map(reason => 'R10 requires ' + reason) };
  return { missing: [], phase: { name: 'raster.composite', durationMs: value.unionMs, outcome: 'completed', clock: 'raster-worker', clockOriginUnixMs: value.clockOriginUnixMs,
    boundary: value.boundary, aggregation: 'nonoverlapping-active-union', context: value.context,
    evidence: { kind: value.kind, sha256: digest(value), intervalCount: value.intervalCount, retainedIntervals: intervals.length, omittedIntervals: value.omittedIntervals, operations: value.operations,
      envelope: { startMs: value.startedMs, endMs: value.endedMs }, timing: 'Synchronous elapsed kernels; GC and OS descheduling included, IO/encode/decode/hash/fsync/yields excluded' } } };
}
