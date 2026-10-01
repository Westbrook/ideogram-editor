// Qualification measurements derived from actual queue/HTTP/owned-asset reads.
// Missing specimens remain missing; no scenario name manufactures a zero.
import assert from 'node:assert/strict';

const NAMES = ['R25ActiveRequests', 'R25PendingEntries', 'R25RejectedDraftLossCount', 'R26StatusMessageBytes', 'R26ObserverBytesPerMinute', 'R26LostTerminalStateCount', 'R32UnchangedOwnedAssetFetches', 'R32CacheIdentityMismatchCount'];
const SHA = /^sha256:[a-f0-9]{64}$/;
const number = value => Number.isSafeInteger(value) && value >= 0;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digestRecord = value => value && typeof value === 'object' && SHA.test(value.hash ?? '') && /^(0|[1-9][0-9]*)$/.test(String(value.byteLength)) && typeof value.mediaType === 'string';
const statusPath = path => typeof path === 'string' && /\/requests\/[^/?]+\/status(?:\?|$)/.test(path);
const mediaPath = path => typeof path === 'string' && path.startsWith('/image/');
const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export function queueMetricApplicability(scenario) {
  const status = !['lost-ack', 'lost-acknowledgement', 'disk-full-admission', 'invalid'].includes(scenario);
  const terminalSpecimen = ['cancel-late-result', 'expired-result-url', 'expiry', 'offline-completion', 'late-result'].includes(scenario);
  return {
    R25RejectedDraftLossCount: scenario === 'disk-full-admission' ? 'explicit rejected draft before/after proof' : 'requires a separate rejection specimen',
    R26StatusMessageBytes: status ? 'actual complete status response required' : 'no status specimen in the current scenario',
    R26ObserverBytesPerMinute: scenario === 'healthy-polling' ? 'complete real ten-second observer interval' : 'requires a separately declared complete observer interval',
    R26LostTerminalStateCount: terminalSpecimen ? 'delivered terminal status plus durable attempt and candidate projection' : 'requires an explicit terminal challenge',
    R32UnchangedOwnedAssetFetches: 'explicit repeated owned-asset access with bracketed network evidence',
    R32CacheIdentityMismatchCount: 'actual owned identity/disk proof; stale or changed-key probes are separate',
  };
}

/** Queue capacity counts jobs, not upload/history preparation rows or all
 * retained queue history. This predicate mirrors the production admission rule. */
export async function readQueueMeasurementInventory(writer) {
  assert.equal(typeof writer?.queueView, 'function', 'Public queueView is required');
  const seenCursors = new Set(), seenJobs = new Set(), pendingIds = [], heldAttemptIds = [];
  let after = '', pages = 0, counts, observedTotal;
  do {
    assert(!seenCursors.has(after), 'Queue inventory cursor repeated'); seenCursors.add(after);
    const page = await writer.queueView(after); ++pages;
    assert(Array.isArray(page.jobs) && page.counts && number(page.counts.active), 'Invalid public queue inventory');
    if (counts) assert.equal(canonical(page.counts), canonical(counts), 'Queue counters changed while paging'); else counts = page.counts;
    if (page.totalJobs !== undefined) { assert(number(page.totalJobs)); if (observedTotal !== undefined) assert.equal(page.totalJobs, observedTotal, 'Queue inventory changed while paging'); observedTotal = page.totalJobs; }
    for (const job of page.jobs) {
      assert(typeof job.id === 'string' && !seenJobs.has(job.id) && Array.isArray(job.attempts), 'Duplicate or invalid queue job'); seenJobs.add(job.id);
      if (job.local !== 'locally-cancelled' && job.attempts.some(attempt => attempt.state === 'not-started')) pendingIds.push(job.id);
      for (const attempt of job.attempts) if (attempt.hold === true) { assert(typeof attempt.id === 'string'); heldAttemptIds.push(attempt.id); }
    }
    after = page.nextCursor ?? ''; assert(typeof after === 'string');
  } while (after);
  assert.equal(new Set(heldAttemptIds).size, heldAttemptIds.length, 'Attempt identity repeated');
  assert.equal(counts.active, heldAttemptIds.length, 'Public active counter and held attempts disagree');
  if (observedTotal !== undefined) assert.equal(observedTotal, seenJobs.size, 'Incomplete queue inventory');
  return { pages, jobs: seenJobs.size, pendingEntries: pendingIds.length, activeRequests: counts.active, pendingIds, heldAttemptIds, counts,
    boundary: 'All public queue pages at a stable counter/total boundary; pending counts the production admission predicate' };
}

function boundedEffects(effects, selection = {}) {
  const start = selection.effectStartIndex ?? 0, end = selection.effectEndIndex ?? effects.length;
  assert(number(start) && number(end) && start <= end && end <= effects.length, 'Invalid effect interval');
  return effects.slice(start, end).map((effect, index) => ({ index: start + index, effect }));
}

function completeResponse(response) {
  return response?.complete === true && number(response.statusCode) && number(response.bodyBytes) && number(response.headerBytes)
    && number(response.wireBytes) && response.wireBytes === response.bodyBytes + response.headerBytes
    && SHA.test(response.bodySha256 ?? '') && Number.isFinite(response.startedMs) && Number.isFinite(response.completedMs)
    && response.startedMs <= response.completedMs && response.clock === 'fixture-monotonic';
}

function completeRequest(request) {
  return request?.complete === true && number(request.bodyBytes) && number(request.headerBytes) && number(request.wireBytes)
    && request.wireBytes === request.bodyBytes + request.headerBytes;
}

function draftProofCount(proof) {
  assert.equal(proof?.kind, 'rejected-draft-preservation-1'); assert.equal(proof.receipt?.status, 'rejected');
  assert(typeof proof.receipt.code === 'string', 'Actual rejection code required');
  for (const record of [proof.before, proof.after]) {
    assert(record && ['draftId', 'generation', 'assetId'].every(key => typeof record[key] === 'string' && record[key].length > 0));
    assert(digestRecord(record.blob) && SHA.test(record.rawHash ?? ''), 'Authored byte identity required');
    assert(record.state && typeof record.state === 'object', 'Actual saved draft/UI projection required');
  }
  assert.equal(proof.before.rawHash, proof.before.blob.hash, 'Rejected draft baseline bytes must match the owned blob identity');
  return canonical(proof.before) === canonical(proof.after) ? 0 : 1;
}

async function probeOwnedCache({ writer, control, endpoint, probe, phases }) {
  assert(typeof probe?.assetId === 'string' && probe.assetId.length > 0, 'Named owned asset required');
  assert(control && endpoint && typeof control.snapshot === 'function', 'Bracketed fixture network observations required');
  const start = await control.snapshot(endpoint); assert(Array.isArray(start.effects));
  const first = await writer.assetProjection(probe.assetId); assert(first.asset?.id === probe.assetId && digestRecord(first.asset.blob));
  const started = performance.now(), second = await writer.assetProjection(probe.assetId), ended = performance.now();
  phases.push({ name: 'asset.cache-lookup', startMs: started, endMs: ended, durationMs: ended - started, outcome: 'completed',
    boundary: 'Repeated public owned-asset metadata lookup including writer IPC; full integrity verification remains separate' });
  let verified, proof;
  try {
    proof = await writer.assetVerify(probe.assetId); assert(typeof proof.handle === 'string' && proof.asset?.id === probe.assetId);
    // assetVerify checks the complete object. The bounded content read proves
    // that the verification capability is usable without materializing it all.
    if (BigInt(proof.asset.blob.byteLength) > 0n) { const bytes = await writer.assetContent(probe.assetId, proof.handle, '0', 1); assert.equal(bytes.byteLength, 1); }
    verified = proof.asset;
  } finally { if (proof?.handle) await writer.assetRelease(proof.handle); }
  const end = await control.snapshot(endpoint); assert(Array.isArray(end.effects) && end.effects.length >= start.effects.length);
  assert.equal(canonical(end.effects.slice(0, start.effects.length)), canonical(start.effects), 'Network effect prefix changed during cache probe');
  const added = end.effects.slice(start.effects.length), fetches = added.filter(effect => effect.method === 'GET' && mediaPath(effect.path));
  return { unchangedFetches: fetches.length, identityMismatches: [second.asset, verified].filter(asset => canonical(asset) !== canonical(first.asset)).length,
    assetId: probe.assetId, before: first.asset, after: second.asset, verified, networkEffects: added, effectStartIndex: start.effects.length, effectEndIndex: end.effects.length,
    diskIntegrity: 'Complete public assetVerify plus verified content capability',
    scope: 'Positive repeated owned-asset access; no stale-hash/size or derived-key invalidation claim' };
}

/** `before` retains actual campaign observations, never assumed outcomes:
 * - requiredMeasurements: registry names applicable to this cell;
 * - queueCheckpoints: [{label, counts}] read at admission/dispatch/recovery;
 * - rejectedDraftProof: rejected receipt plus before/after authored identities,
 *   rawHash and complete saved UI/draft `state`;
 * - observerWindow: one complete >=10s fixture-monotonic interval, effect index
 *   bounds, observerId and productObserverOnly, excluding direct probe traffic;
 * - terminalChallenge: jobId/attemptId/requestId and effect bounds, optionally
 *   retainedResponses (otherwise the fixture's actual controlReads are used);
 * - cacheProbe: {assetId} authorizes the public read/integrity/reuse probe.
 * A prepared draft is not itself rejection evidence. Output metrics only cover
 * those observed specimens; evidence records their narrower boundaries. */
export async function collectQueueMeasurements({ writer, control, endpoint, queued, prepared, before = {}, snapshot, scenario, phases = [] }) {
  const measurements = {}, missing = [], evidence = [], required = new Set(before.requiredMeasurements ?? NAMES);
  const supply = (name, value) => { if (required.has(name)) { assert(Number.isFinite(value) && value >= 0); measurements[name] = value; } };
  const absent = (name, reason) => { if (required.has(name)) missing.push(name + ': ' + reason); };
  evidence.push({ kind: 'metric-applicability', scenario, rules: queueMetricApplicability(scenario) });
  if (required.has('R25ActiveRequests') || required.has('R25PendingEntries')) {
    try {
      const inventory = await readQueueMeasurementInventory(writer); evidence.push({ kind: 'queue-inventory', ...inventory });
      supply('R25PendingEntries', inventory.pendingEntries);
      const checkpoints = (before.queueCheckpoints ?? []).map(item => { assert(number(item.counts?.active), 'Queue checkpoint must carry an actual counter'); return { label: item.label, active: item.counts.active }; });
      checkpoints.push({ label: 'collection', active: inventory.activeRequests });
      supply('R25ActiveRequests', Math.max(...checkpoints.map(item => item.active)));
      evidence.push({ kind: 'observed-active-counter-checkpoints', checkpoints, scope: 'Maximum of observed durable counters; unsampled intervals are not inferred' });
    } catch (error) { absent('R25PendingEntries', error.message); absent('R25ActiveRequests', error.message); }
  }
  if (required.has('R25RejectedDraftLossCount')) {
    try { const count = draftProofCount(before.rejectedDraftProof); supply('R25RejectedDraftLossCount', count); evidence.push({ kind: 'rejected-draft-preservation', proof: before.rejectedDraftProof, lossCount: count }); }
    catch (error) { absent('R25RejectedDraftLossCount', 'Explicit complete rejected draft/byte/projection proof required (' + error.message + ')'); }
  }
  if (!snapshot && control && endpoint) snapshot = await control.snapshot(endpoint);
  const effects = snapshot?.effects ?? [];
  let statusEffects = [];
  try { statusEffects = boundedEffects(effects, before).filter(({ effect }) => statusPath(effect.path) && completeResponse(effect.response)); }
  catch (error) { absent('R26StatusMessageBytes', error.message); }
  if (statusEffects.length) {
    supply('R26StatusMessageBytes', Math.max(...statusEffects.map(({ effect }) => effect.response.wireBytes)));
    evidence.push({ kind: 'status-response-bytes', records: statusEffects.map(({ index, effect }) => ({ effectIndex: index, method: effect.method, path: effect.path, response: effect.response })),
      boundary: 'Exact complete HTTP response status line, headers and body; request bytes accounted separately' });
  } else absent('R26StatusMessageBytes', 'No complete exactly-accounted status response observed');
  if (required.has('R26ObserverBytesPerMinute')) {
    try {
      const window = before.observerWindow;
      assert(window?.complete === true && window.clock === 'fixture-monotonic' && typeof window.observerId === 'string' && window.observerId.length > 0, 'Explicit complete same-clock observer window required');
      assert(Number.isFinite(window.startedMs) && Number.isFinite(window.completedMs) && window.completedMs - window.startedMs >= 10000, 'Observer interval must cover at least ten real seconds');
      const rows = boundedEffects(effects, window).filter(({ effect }) => statusPath(effect.path)); assert(rows.length > 0, 'Observer interval contains no status exchange');
      assert.equal(new Set(rows.map(({ effect }) => effect.path.split('?')[0])).size, 1, 'Multiple request identities in observer window');
      for (const { effect } of rows) {
        assert(completeRequest(effect.request) && completeResponse(effect.response), 'Status exchange is incomplete or lacks exact request/response wire bytes');
        assert(effect.atMs >= window.startedMs && effect.response.completedMs <= window.completedMs, 'Status exchange is outside the complete declared window');
        assert(effect.observerId === undefined || effect.observerId === window.observerId, 'Mixed observers in declared interval');
        assert(effect.role !== 'direct-control', 'Direct comparison traffic cannot count as observer traffic');
      }
      assert(window.productObserverOnly === true, 'Caller must attest the bounded interval contains only this product observer');
      const requestBytes = rows.reduce((sum, { effect }) => sum + effect.request.wireBytes, 0), responseBytes = rows.reduce((sum, { effect }) => sum + effect.response.wireBytes, 0);
      const elapsedMs = window.completedMs - window.startedMs;
      supply('R26ObserverBytesPerMinute', (requestBytes + responseBytes) * 60000 / elapsedMs);
      evidence.push({ kind: 'normalized-observed-status-rate', window, elapsedMs, requestBytes, responseBytes, exchanges: rows.length,
        boundary: 'Exact status request/response HTTP bytes normalized from the complete real interval; submit/result/image/control-probe traffic excluded' });
    } catch (error) { absent('R26ObserverBytesPerMinute', error.message); }
  }
  if (required.has('R26LostTerminalStateCount')) {
    try {
      const challenge = before.terminalChallenge;
      assert(challenge && ['jobId', 'attemptId', 'requestId'].every(key => typeof challenge[key] === 'string' && challenge[key].length > 0), 'Explicit completed terminal challenge required');
      if (queued) assert.equal(challenge.jobId, queued.job?.id ?? queued.id);
      const path = '/' + endpoint + '/requests/' + encodeURIComponent(challenge.requestId) + '/status';
      const delivered = boundedEffects(effects, challenge).filter(({ effect }) => effect.path === path && completeResponse(effect.response) && effect.response.statusCode === 200 && terminal.has(effect.response.terminalStatus));
      assert(delivered.length > 0, 'No complete terminal status response in challenge');
      const reads = challenge.retainedResponses ?? snapshot?.controlReads;
      assert(Array.isArray(reads), 'Complete protected terminal response receipt required');
      for (const { effect } of delivered) assert(reads.some(read => {
        const receipt = read.receipt, retained = receipt?.evidence;
        return read.jobId === challenge.jobId && read.attemptId === challenge.attemptId && read.kind === 'status' && receipt?.outcome === 'complete' && receipt.status === 200
          && 'sha256:' + receipt.sha256 === effect.response.bodySha256 && String(receipt.receivedBytes) === String(effect.response.bodyBytes)
          && retained?.attemptId === challenge.attemptId && retained.direction === 'response' && retained.completeness === 'complete'
          && typeof retained.recordId === 'string' && retained.recordId.length > 0 && retained.sha256 === receipt.sha256;
      }), 'Server terminal bytes were not proven received into matching protected attempt evidence');
      const expected = delivered[0].effect.response.terminalStatus.toLowerCase();
      const recovery = await writer.queueRecovery(challenge.jobId, challenge.attemptId), view = await writer.candidateView(challenge.jobId, challenge.attemptId);
      assert.equal(recovery.attempt.id, challenge.attemptId); assert.equal(recovery.attempt.requestId, challenge.requestId); assert.equal(view.jobId, challenge.jobId);
      const lost = recovery.attempt.state !== 'provider-terminal' || recovery.attempt.terminal !== expected || recovery.attempt.hold !== false || view.observation?.phase !== expected ? 1 : 0;
      supply('R26LostTerminalStateCount', lost);
      evidence.push({ kind: 'terminal-projection-check', challenge, delivered: delivered.map(row => ({ effectIndex: row.index, response: row.effect.response })), expected,
        attempt: recovery.attempt, observation: view.observation, lostCount: lost, scope: 'First delivered terminal remains authoritative at the later durable read' });
    } catch (error) { absent('R26LostTerminalStateCount', error.message); }
  }
  if (required.has('R32UnchangedOwnedAssetFetches') || required.has('R32CacheIdentityMismatchCount')) {
    try {
      const proof = await probeOwnedCache({ writer, control, endpoint, probe: before.cacheProbe, phases });
      supply('R32UnchangedOwnedAssetFetches', proof.unchangedFetches); supply('R32CacheIdentityMismatchCount', proof.identityMismatches);
      evidence.push({ kind: 'owned-asset-reuse-probe', ...proof });
    } catch (error) { absent('R32UnchangedOwnedAssetFetches', error.message); absent('R32CacheIdentityMismatchCount', error.message); }
  }
  // prepared is deliberately not treated as proof of rejection or ownership.
  void prepared;
  const origins = {
    R25ActiveRequests: ['count', 'Maximum of observed durable queue counters, cross-checked against the complete public held-attempt inventory', ['observed-active-counter-checkpoints', 'queue-inventory']],
    R25PendingEntries: ['count', 'Count of all public queue jobs matching the exact production pending-admission predicate across stable pages', ['queue-inventory']],
    R25RejectedDraftLossCount: ['violations', 'Exact before/after authored blob hash and complete saved UI projection comparison across a real rejected command', ['rejected-draft-preservation']],
    R26StatusMessageBytes: ['bytes', 'Maximum complete actual HTTP status-response wire bytes, measured by socket counters with explicit body length', ['status-response-bytes']],
    R26ObserverBytesPerMinute: ['bytes/minute', 'Exact request and response HTTP bytes normalized over the declared complete real observer interval', ['normalized-observed-status-rate']],
    R26LostTerminalStateCount: ['violations', 'Protected received terminal-response proof compared with later durable attempt and candidate-observation projections', ['terminal-projection-check']],
    R32UnchangedOwnedAssetFetches: ['count', 'Media GET count in the exact fixture interval bracketing repeated public owned-asset lookup and complete disk verification', ['owned-asset-reuse-probe']],
    R32CacheIdentityMismatchCount: ['violations', 'Exact repeated asset projection and complete verified asset identity comparison', ['owned-asset-reuse-probe']],
  };
  const measurementDetails = {};
  for (const name of Object.keys(measurements)) {
    const [unit, method, kinds] = origins[name];
    measurementDetails[name] = { unit, method, evidence: evidence.filter(item => kinds.includes(item.kind)) };
  }
  return { measurements, measurementDetails, missing, evidence };
}
