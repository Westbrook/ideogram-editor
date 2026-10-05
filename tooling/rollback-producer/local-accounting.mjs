// Finite accounting adapter for controller-02. No subprocess or Docker authority.
import {createHash} from 'node:crypto';
const require = (condition, message) => { if (!condition) throw Error(message); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === names.slice().sort().join('|');
export const INTERVAL_MS = 2000;
export const MAX_GAP_MS = 4000;
export const ENGINE_CONTAINER_FIELDS = '{"Id":{{json .Id}},"Name":{{json .Name}},"Run":{{json (index .Config.Labels "org.ideogram.rollback-run")}},"Image":{{json .Image}},"SizeRw":{{json .SizeRw}},"SizeRootFs":{{json .SizeRootFs}}}';
export const ENGINE_IMAGE_FIELDS = '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"Size":{{json .Size}}}';
export const UNOBSERVED_ENGINE_SCOPES = Object.freeze(['Docker daemon metadata and container log allocation', 'Docker VM backing-file allocation, sparse extents and host filesystem overhead', 'Transient commit/layer construction and exclusive physical attribution of shared base layers']);
export function validateDockerAllocation(value, {runId, volume}) {
  require(exact(value, ['kind', 'allocationId', 'runId', 'context', 'issuedAt', 'owner', 'volume', 'engine']), 'Docker allocation fields differ');
  require(value.kind === 'linux-docker-accounting-allocation-1' && value.runId === runId && value.context === 'desktop-linux' && /^[A-Za-z0-9._-]{1,100}$/.test(value.allocationId) && typeof value.owner === 'string' && value.owner.length > 0 && value.owner.length <= 200 && new Date(value.issuedAt).toISOString() === value.issuedAt, 'Docker allocation identity differs');
  require(exact(value.volume, ['name', 'capacityBytes']) && value.volume.name === volume && integer(value.volume.capacityBytes) && value.volume.capacityBytes > 0, 'Explicit owned build-volume capacity required');
  require(exact(value.engine, ['containerWritableCapacityBytes', 'imageReportedCapacityBytes', 'meaning']) && value.engine.meaning === 'per-object-engine-reported-nonexclusive-bytes' && ['containerWritableCapacityBytes', 'imageReportedCapacityBytes'].every(key => integer(value.engine[key]) && value.engine[key] > 0), 'Separate per-object engine accounting ceilings required');
  return value;
}
export function containerSize(value, {id, name, runId, image}) {
  require(exact(value, ['Id', 'Name', 'Run', 'Image', 'SizeRw', 'SizeRootFs']) && /^[a-f0-9]{64}$/.test(id) && value.Id === id && value.Name === '/' + name && value.Run === runId && value.Image === image, 'Engine observation ownership differs');
  require(integer(value.SizeRw) && integer(value.SizeRootFs) && value.SizeRootFs >= value.SizeRw, 'Engine size support unavailable or invalid');
  return {writableBytes: value.SizeRw, rootFilesystemBytes: value.SizeRootFs, physicalExclusiveBytes: null};
}
export function imageSize(value, id) {
  require(exact(value, ['Id', 'Os', 'Architecture', 'Size']) && /^sha256:[a-f0-9]{64}$/.test(id) && value.Id === id && value.Os === 'linux' && value.Architecture === 'arm64' && integer(value.Size), 'Selected image identity/size support differs');
  return {reportedBytes: value.Size, physicalExclusiveBytes: null, includesSharedBase: true};
}
export function coverage(records, capacityBytes) {
  require(integer(capacityBytes) && capacityBytes > 0 && Array.isArray(records), 'Invalid coverage inputs');
  const successful = records.filter(x => x.error === null), starts = successful.map(x => x.startedMs);
  require(records.every(x => Number.isFinite(x.startedMs) && Number.isFinite(x.endedMs) && x.endedMs >= x.startedMs) && starts.every((x, i) => !i || x >= starts[i - 1]), 'Observation times invalid');
  const maximumStartGapMs = starts.length < 2 ? null : Math.max(...starts.slice(1).map((x, i) => x - starts[i]));
  // Linux's monotonic epoch differs from this Darwin parent. The actual remote
  // observation starts within the successful call interval. Use its worst-case
  // gap, not an invented cross-host clock offset or just nominal timer ticks.
  const maximumPossibleObservationStartGapMs = successful.length < 2 ? null : Math.max(...successful.slice(1).map((x, i) => x.endedMs - successful[i].startedMs));
  const complete = records.length >= 2 && records[0].boundary === 'initial' && records.at(-1).boundary === 'final' && successful.length === records.length && maximumStartGapMs !== null && maximumStartGapMs <= MAX_GAP_MS && maximumPossibleObservationStartGapMs <= MAX_GAP_MS;
  const values = successful.map(x => x.bytes); require(values.every(integer), 'Invalid observed size');
  const peakBytes = values.length ? Math.max(...values) : null;
  return {status: peakBytes !== null && peakBytes >= capacityBytes * .9 ? 'FAIL' : complete ? 'PASS' : 'INCONCLUSIVE', coverageComplete: complete, maximumStartGapMs, maximumPossibleObservationStartGapMs, peakBytes, capacityBytes, samples: records.length, unknownSamples: records.length - successful.length, targetPercent: 80, ceilingPercent: 90};
}
export function workerCanonical(value) {
  const normalized = value => Array.isArray(value) ? value.map(normalized) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])])) : value;
  return JSON.stringify(normalized(value)).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
const workerHash = value => 'sha256:' + createHash('sha256').update(workerCanonical(value)).digest('hex');
export function volumeSize(value, request) {
  require(value?.kind === 'capsule-volume-observation-1' && value.policyId === request.policyId && workerCanonical(value.request) === workerCanonical(request) && value.requestHash === workerHash(request), 'Volume request binding differs');
  require(workerCanonical(value.bounds) === workerCanonical({maxEntries: 1000000, maxDepth: 128, maxAttempts: 3, maxWindowUs: 1000000}) && value.status === 'complete' && value.drained === true && integer(value.windowStartMonotonicUs) && integer(value.windowEndMonotonicUs) && value.windowEndMonotonicUs >= value.windowStartMonotonicUs && value.windowEndMonotonicUs - value.windowStartMonotonicUs <= 1000000, 'Volume bounded complete observation unavailable');
  require(Array.isArray(value.attempts) && value.attempts.length >= 1 && value.attempts.length <= 3 && value.selectedAttempt === value.attempts.length - 1, 'Volume selection differs');
  let previous = null;
  for (const [index, attempt] of value.attempts.entries()) {
    const {hash, ...body} = attempt;
    require(hash === workerHash(body) && attempt.sequence === index && attempt.previous === previous && attempt.drained === true && integer(attempt.startMonotonicUs) && integer(attempt.endMonotonicUs) && attempt.endMonotonicUs >= attempt.startMonotonicUs && attempt.startMonotonicUs >= value.windowStartMonotonicUs && attempt.endMonotonicUs <= value.windowEndMonotonicUs, 'Volume attempt chain/time differs');
    if (index < value.selectedAttempt) require(attempt.status === 'unknown' && attempt.counts === null && attempt.errors?.length === 1 && attempt.errors[0].code === 'EVIDENCE_MUTATION', 'Nonmutation volume retry refused');
    previous = hash;
  }
  const selected = value.attempts[value.selectedAttempt];
  require(selected.status === 'complete' && selected.errors?.length === 0 && exact(selected.rootBefore, ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'blocks', 'mtimeNs', 'ctimeNs']) && workerCanonical(selected.rootBefore) === workerCanonical(selected.rootAfter) && integer(selected.rootAfter.dev) && integer(selected.rootAfter.ino) && selected.rootAfter.ino > 0 && exact(selected.counts, ['entries', 'uniqueInodes', 'directories', 'regularFiles', 'symlinks', 'allocatedBytes', 'regularLogicalBytes', 'symlinkAllocatedBytes']) && Object.values(selected.counts).every(integer), 'Volume completed sample invalid');
  require(selected.counts.entries >= 1 && selected.counts.entries <= 1000000 && selected.counts.uniqueInodes <= selected.counts.entries && selected.counts.directories >= 1 && selected.counts.allocatedBytes % 512 === 0 && selected.counts.symlinkAllocatedBytes <= selected.counts.allocatedBytes, 'Volume counters exceed policy');
  const rootIdentity = {dev: selected.rootAfter.dev, ino: selected.rootAfter.ino};
  require(request.rootIdentity === null || workerCanonical(rootIdentity) === workerCanonical(request.rootIdentity), 'Volume root identity changed');
  require(integer(selected.counts.allocatedBytes), 'Volume allocated bytes missing');
  return {bytes: selected.counts.allocatedBytes, rootIdentity, result: value, pointInTime: true};
}
// Observation and retention are supplied by the existing bounded child/receipt
// runner. A failed observation is retained and latched; it cannot be retried away.
export function createAccounting({observe, retain, onFailure, clock = () => performance.now(), schedule = setTimeout, cancel = clearTimeout}) {
  const targets = new Map(); let pending = Promise.resolve(), timer = null, ending = false, failed = false, sequence = 0, previous = null, lastStart = clock();
  const latch = error => { failed = true; onFailure(error); };
  async function sample(target, boundary) {
    const startedMs = clock(); lastStart = startedMs; let observation = null, error = null;
    try { observation = await observe(target); require(integer(observation.bytes), 'Observer omitted size'); }
    catch (cause) { error = {name: String(cause?.name ?? 'Error'), message: String(cause?.message ?? cause).slice(0, 2048)}; }
    const record = {sequence: sequence++, previous, key: target.key, boundary, startedMs, endedMs: clock(), bytes: observation?.bytes ?? null, observation, error};
    record.hash = createHash('sha256').update(JSON.stringify(record)).digest('hex'); previous = record.hash; target.records.push(record);
    await retain(record); // A journal failure also prevents a successful finish.
    if (error || observation.bytes >= target.capacityBytes * .9) latch(error ?? {message: 'Accounting ceiling reached: ' + target.key});
    const preceding = target.records.at(-2);
    if (preceding && record.endedMs - preceding.startedMs > MAX_GAP_MS) latch({message: 'Successful observation start coverage unavailable: ' + target.key});
    return record;
  }
  function queue(action) { const result = pending.then(action); pending = result.catch(error => { latch(error); }); return result; }
  function tick() {
    if (ending || failed || timer !== null || !targets.size) return;
    timer = schedule(() => { timer = null; queue(async () => { for (const target of targets.values()) if (target.active) await sample(target, 'periodic'); }).then(tick, () => {}); }, Math.max(0, lastStart + INTERVAL_MS - clock()));
    timer?.unref?.();
  }
  return {
    // Serialize lifecycle transitions with actual observations. This does not
    // pause or reset cadence/coverage clocks; slow transitions still fail.
    coordinate(action) { require(!ending && typeof action === 'function', 'Accounting transition unavailable'); return queue(action); },
    async add(target) { require(!ending && !failed && !targets.has(target.key) && integer(target.capacityBytes) && target.capacityBytes > 0, 'Invalid accounting target'); target.records = []; target.active = false; targets.set(target.key, target); const record = await queue(() => sample(target, 'initial')); require(record.error === null && !failed, 'Initial accounting observation failed'); target.active = true; tick(); return record; },
    async checkpoint(key) { require(!ending && targets.get(key)?.active, 'Accounting target unavailable'); return queue(() => sample(targets.get(key), 'periodic')); },
    async retire(key) { require(!ending && targets.get(key)?.active, 'Accounting target unavailable'); return queue(async () => { const target = targets.get(key); const record = await sample(target, 'final'); target.active = false; return record; }); },
    async finish() {
      require(!ending, 'Accounting already finished'); ending = true; if (timer !== null) cancel(timer); await pending;
      for (const target of targets.values()) if (target.active) try { await queue(() => sample(target, 'final')); } catch { /* Retained failure stays latched. */ }
      const scopes = [...targets.values()].map(target => ({key: target.key, meaning: target.meaning, ...coverage(target.records, target.capacityBytes)}));
      return {kind: 'linux-docker-observation-summary-1', status: failed || scopes.some(x => x.status === 'FAIL') ? 'FAIL' : scopes.every(x => x.status === 'PASS') ? 'PASS' : 'INCONCLUSIVE', scopes, records: sequence, journalHead: previous, intervalMs: INTERVAL_MS, maxSuccessfulStartGapMs: MAX_GAP_MS, physicalDockerUsageStatus: 'UNOBSERVABLE', unobserved: UNOBSERVED_ENGINE_SCOPES, exclusivePhysicalTotalBytes: null, qualification: false};
    },
  };
}
