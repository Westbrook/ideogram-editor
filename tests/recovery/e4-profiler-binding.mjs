// Pure fixture-side join. Never polls the page, manufactures marks, or publishes
// private IDs/URLs. Unknown is a diagnostic result, not a weakened E4 predicate.
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const ordinal = value => Number.isSafeInteger(value) && value > 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const unknown = reason => Object.freeze({diagnosticOnly:true,qualification:false,status:'unknown',reason,context:null});
const one = values => values.length === 1 ? values[0] : undefined;
const completed = row => row && row.retired === true && row.retirement === 'delivered' && row.getReaderOutcome === 'returned' && row.firstReadOutcome === 'fulfilled' && row.lastReadOutcome === 'fulfilled' && row.releaseLockOutcome === 'returned' && row.parseOutcome === 'returned' && row.responseJsonEntry === null && row.nativeEOF === null &&
 ordinal(row.readCalls) && row.readCalls === row.readCallbacks && row.firstReadOrdinal === 1 && row.firstCallbackReadOrdinal === 1 && row.doneReadOrdinal === row.readCalls && row.lastCallbackReadOrdinal === row.readCalls &&
 [row.getReaderEntry,row.getReaderReturn,row.firstReadEntry,row.firstReadCallback,row.doneReadEntry,row.doneCallback,row.releaseLockEntry,row.releaseLockReturn,row.parseEntry,row.parseReturn].every(finite) &&
 row.getReaderEntry <= row.getReaderReturn && row.getReaderReturn <= row.firstReadEntry && row.firstReadEntry <= row.firstReadCallback && row.firstReadCallback <= row.doneCallback && row.doneReadEntry <= row.doneCallback && row.doneCallback <= row.releaseLockEntry && row.releaseLockEntry <= row.releaseLockReturn && row.releaseLockReturn <= row.parseEntry && row.parseEntry <= row.parseReturn;
function original(row) {return row?.application === true && row.method === 'GET' && row.status === 200 && row.source === 'original-reader-json-parse' && row.scope === 'original-response-parse-delivery' && row.clock === 'browser-wall-ms' && finite(row.at) && finite(row.monotonic) && ordinal(row.operation) && ordinal(row.profilerCollection);}
function endpoint(row, origin, path, attemptId) {
 try {
  const url = new URL(row.url);
  if (row.origin !== origin || url.origin !== origin || row.path !== path || url.pathname !== path || url.username || url.password || url.hash) return false;
  const pairs = [...url.searchParams];
  return attemptId === undefined ? pairs.length === 0 : pairs.length === 2 && pairs[0][0] === 'attempt' && pairs[0][1] === attemptId && pairs[1][0] === 'after' && pairs[1][1] === '';
 } catch {return false;}
}
export function e4ProfilerRequested(environment, browserName, platform, architecture) {
 const value = environment.IE_E4_FIREFOX_PROFILER;
 if (value === undefined) return false;
 if (value !== '1' || browserName !== 'firefox' || platform !== 'linux' || architecture !== 'x64') throw Error('E4_PROFILER_SELECTION');
 return true;
}
export function bindE4ProfilerContext({authority,deliveries,phaseSnapshots,states,jobId,attemptId,deliveryErrors,phaseErrors}) {
 try {
  if (!id(jobId) || !id(attemptId) || !Array.isArray(authority) || authority.length > 4096 || !Array.isArray(deliveries) || deliveries.length > 32768 || !Array.isArray(phaseSnapshots) || phaseSnapshots.length > 8 || !Array.isArray(states) || states.length > 6 || !Array.isArray(deliveryErrors) || !Array.isArray(phaseErrors) || deliveryErrors.length || phaseErrors.length) return unknown('INPUT_UNAVAILABLE');
  const a = one(authority.filter(row => row?.phase === 'P4' && row.jobId === jobId && row.attemptId === attemptId));
  if (!a || a.clock !== 'writer-wall-ms' || !finite(a.at) || !id(a.candidate?.id) || !id(a.candidate?.preparedAssetId) || !id(a.candidate?.version) || a.candidate.state !== 'prepared' || a.candidate.jobId !== jobId || a.candidate.attemptId !== attemptId) return unknown('AUTHORITY_UNAVAILABLE');
  // This is the same first eligible original delivery used by E4's unchanged
  // P4 assertion. Later polls of the same prepared candidate are not new anchors.
  const d = deliveries.find(row => row?.application === true && row.at >= a.at && row.value?.jobId === jobId && Array.isArray(row.value.items) && row.value.items.some(c => c?.id === a.candidate.id && c.version === a.candidate.version && c.preparedAssetId === a.candidate.preparedAssetId));
  if (!original(d) || !one(deliveries.filter(row => row?.application === true && row.profilerCollection === d.profilerCollection && row.operation === d.operation))) return unknown('CANDIDATE_UNAVAILABLE');
  const snapshot = one(phaseSnapshots.filter(row => row?.collection === d.profilerCollection));
  if (snapshot?.run?.family !== 'e4' || snapshot.run.browser !== 'firefox' || !finite(snapshot.realm?.timeOrigin) || snapshot.diagnostics?.kind !== 'e4-original-consumer-phases-1' || snapshot.diagnostics.clock !== 'browser-monotonic-ms' || !Array.isArray(snapshot.diagnostics.records) || snapshot.diagnostics.records.length > 4096) return unknown('REALM_UNAVAILABLE');
  const origin = snapshot.realm.origin, timeOrigin = snapshot.realm.timeOrigin;
  if (!endpoint(d,origin,'/api/v1/jobs/'+jobId+'/candidates',attemptId) || d.value.items.filter(c => c?.id === a.candidate.id && c.version === a.candidate.version && c.preparedAssetId === a.candidate.preparedAssetId && c.state === 'prepared').length !== 1) return unknown('CANDIDATE_UNAVAILABLE');
  const candidate = one(snapshot.diagnostics.records.filter(row => row?.operation === d.operation));
  const q = one(deliveries.filter(row => row?.application === true && row.profilerCollection === d.profilerCollection && row.operation === d.operation-1));
  const queue = one(snapshot.diagnostics.records.filter(row => row?.operation === d.operation-1));
  if (!original(q) || !endpoint(q,origin,'/api/v1/queue') || !Array.isArray(q.value?.jobs) || q.value.jobs.filter(job => job?.id === jobId).length !== 1 || !completed(queue) || !completed(candidate) || queue.parseReturn > q.monotonic || q.monotonic > candidate.getReaderEntry || candidate.parseReturn > d.monotonic) return unknown('ORIGINAL_READ_UNAVAILABLE');
  const f5 = one(states.filter(row => row?.name === 'F5')), f6 = one(states.filter(row => row?.name === 'F6'));
  if (!f5 || !f6 || f5.publication !== 'P3' || f6.publication !== 'P4' || [f5,f6].some(row => row.jobId !== jobId || row.attemptId !== attemptId || row.profilerRealm?.timeOrigin !== timeOrigin || row.profilerRealm?.origin !== origin || !finite(row.at) || !finite(row.monotonic)) || f5.monotonic > queue.firstReadEntry || d.monotonic > f6.monotonic || f5.at > a.at || a.at > f6.at) return unknown('SEMANTIC_ANCHOR_UNAVAILABLE');
  const residuals = [f5.at-f5.monotonic-timeOrigin,f6.at-f6.monotonic-timeOrigin,d.at-d.monotonic-timeOrigin,q.at-q.monotonic-timeOrigin];
  if (residuals.some(value => Math.abs(value) > 5) || Math.abs(residuals[0]-residuals[1]) > 5 || d.monotonic-candidate.parseReturn > 5 || q.monotonic-queue.parseReturn > 5) return unknown('CLOCK_MISMATCH');
  const context = Object.freeze({p4WallMs:a.at,realmTimeOriginMs:timeOrigin,f5WallMs:f5.at,f5MonotonicMs:f5.monotonic,f6WallMs:f6.at,f6MonotonicMs:f6.monotonic,queueReadEntryMonotonicMs:queue.firstReadEntry,queueReadCallbackMonotonicMs:queue.firstReadCallback});
  return Object.freeze({diagnosticOnly:true,qualification:false,status:'bound',reason:'SAME_RUN_ORIGINAL_READ',context,collection:snapshot.collection,candidateOperation:d.operation,queueOperation:q.operation,deliveryIntervalMs:d.at-a.at,clockToleranceMs:5,wallClockUnitMs:1,clockUncertaintyMs:null,f5ClockResidualMs:residuals[0],f6ClockResidualMs:residuals[1]});
 } catch {return unknown('INPUT_UNAVAILABLE');}
}
