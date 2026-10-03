/** PERF-8 §7 evidence lifecycle. Explicit evidence allocation only; never editor storage. */
import { constants } from 'node:fs';
import { mkdir, open, opendir, lstat, realpath, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';

const DAY = 86400000, LIMIT = 100000, MAX_JSON = 16 * 1024 * 1024;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const utc = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const stamp = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
const observationDiagnostics = new WeakMap();
const opaqueError = error => ({ code: typeof error?.code === 'string' ? error.code : 'EVIDENCE_IO', message: observationDiagnostics.get(error) ?? 'Evidence observation unavailable; inspect protected controller diagnostics.' });
// Only sampler-owned context is retained; never filesystem error messages or
// absolute/error-supplied paths. Keep the historical failure schema unchanged.
function observationError(error, root, path, phase, originalCode = error?.code) {
  if (observationDiagnostics.has(error)) return error;
  const code = typeof error?.code === 'string' ? error.code : 'EVIDENCE_IO';
  const rawCode = typeof originalCode === 'string' && /^[A-Z0-9_]{1,48}$/.test(originalCode) ? originalCode : 'EVIDENCE_IO';
  const owned = path === root ? '.' : relative(root, path);
  const member = (owned === '..' || owned.startsWith('../') || isAbsolute(owned) ? '<outside>' : owned).replace(/[^\x20-\x7e]|[\\"]/g, '?').slice(0, 160);
  const failure = Object.assign(Error('Evidence observation unavailable'), { code });
  observationDiagnostics.set(failure, `Evidence observation unavailable; phase=${phase}; code=${rawCode}; member=${member}`);
  return failure;
}

export function relativeMember(root, path) {
  const value = relative(root, resolve(path));
  if (!value || value === '..' || value.startsWith('../') || isAbsolute(value) || value.includes('\\')) throw Error('Evidence member must be strictly inside allocated root');
  return value;
}
export async function readEvidenceJSON(path, { openFile = open, withIdentity = false } = {}) {
  const fd = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_JSON)) throw Error('Bounded regular JSON required');
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) {
      const result = await fd.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!result.bytesRead) throw Error('Evidence JSON shortened during read');
      offset += result.bytesRead;
    }
    const tail = Buffer.alloc(1);
    if ((await fd.read(tail, 0, 1, offset)).bytesRead || stamp(await fd.stat({ bigint: true })) !== stamp(before) || stamp(await lstat(path, { bigint: true })) !== stamp(before)) throw Error('Evidence JSON changed during bounded read');
    const value = JSON.parse(bytes.toString('utf8'));
    return withIdentity ? { value, bytes, identity: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } : value;
  } finally { await fd.close(); }
}
const boundedJSON = readEvidenceJSON;
async function exclusiveJSON(path, value) {
  if (await realpath(dirname(path)) !== dirname(path)) throw Error('Evidence write parent alias refused');
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > MAX_JSON) throw Error('Evidence metadata bound exceeded');
  const fd = await open(path, 'wx', 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  return { bytes: Buffer.byteLength(bytes), sha256: hash(bytes) };
}
export async function fileIdentity(path) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw Error('Regular evidence file required');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), digest = createHash('sha256'), buffer = Buffer.alloc(65536);
  try {
    if (stamp(await fd.stat({ bigint: true })) !== stamp(before)) throw Error('Evidence file changed before read');
    let bytes = 0;
    for (;;) { const read = await fd.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; bytes += read.bytesRead; digest.update(buffer.subarray(0, read.bytesRead)); }
    if (stamp(await fd.stat({ bigint: true })) !== stamp(before) || stamp(await lstat(path, { bigint: true })) !== stamp(before)) throw Error('Evidence file changed during read');
    return { bytes, sha256: digest.digest('hex') };
  } finally { await fd.close(); }
}
export async function evidencePath(root, member) {
  if (typeof member !== 'string' || isAbsolute(member) || member.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw Error('Unsafe evidence member');
  const path = join(root, member); relativeMember(root, path);
  let cursor = root;
  for (const part of member.split('/')) { cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw Error('Evidence symlink refused'); }
  if (await realpath(path) !== path) throw Error('Evidence path alias refused');
  return path;
}
/** Validate each existing ancestor before creating a new member; never follow aliases. */
export async function evidenceDestination(root, path, { directory = false, mustExist = false } = {}) {
  const member = relativeMember(root, path); let cursor = root, missing = false;
  if (await realpath(root) !== root || (await lstat(root)).isSymbolicLink()) throw Error('Evidence destination root alias refused');
  const parts = member.split('/');
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]); if (missing) continue;
    let value; try { value = await lstat(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; continue; }
    if (value.isSymbolicLink() || await realpath(cursor) !== cursor || (index < parts.length - 1 || directory) && !value.isDirectory()) throw Error('Evidence destination alias/type refused');
  }
  if (mustExist && missing) throw Error('Evidence destination unavailable');
  return path;
}
export async function loadAllocation(path) {
  if (!path || !isAbsolute(path)) throw Error('IE_EVIDENCE_ALLOCATION must name an absolute sealed allocation manifest');
  const { value, identity, bytes } = await readEvidenceJSON(path, { withIdentity: true });
  if (value.kind !== 'evidence-volume-allocation-1' || !id(value.allocationId) || value.purpose !== 'qualification-evidence-only' ||
      !Number.isSafeInteger(value.capacityBytes) || value.capacityBytes <= 0 || !isAbsolute(value.root ?? '') || !utc(value.issuedAt) ||
      !id(value.owner) || value.root === '/' || /[\x00-\x1f\x7f]/.test(value.root)) throw Error('Invalid evidence allocation manifest');
  const root = resolve(value.root), stat = await lstat(root, { bigint: true });
  if (value.root !== root || !stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw Error('Allocation requires an existing canonical directory');
  if (process.platform !== 'win32' && Number(stat.mode & 0o077n)) throw Error('Evidence allocation must be private to its owner');
  if (Object.keys(value).some(key => !['kind', 'allocationId', 'purpose', 'capacityBytes', 'root', 'issuedAt', 'owner'].includes(key))) throw Error('Unknown allocation field');
  const allocation = { ...value, root, identity, directoryIdentity: { dev: String(stat.dev), ino: String(stat.ino) } };
  Object.defineProperty(allocation, 'sourceBytes', { value: bytes });
  return allocation;
}
async function checkRoot(allocation) {
  const stat = await lstat(allocation.root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== allocation.directoryIdentity.dev || String(stat.ino) !== allocation.directoryIdentity.ino || await realpath(allocation.root) !== allocation.root) throw Error('Allocated evidence root changed');
}
// An enumerated child disappearing is a failed membership observation, not a
// successful partial count. Validate the allocation and every surviving known
// ancestor before admitting the existing bounded fresh-scan retry.
async function confirmDescendantMutation(allocation, path, ancestors, before) {
  const check = async () => {
    try { await checkRoot(allocation); }
    catch (error) { throw observationError(error, allocation.root, allocation.root, 'verify-root'); }
  };
  await check();
  for (const entry of [...ancestors, { path, before }]) {
    if (entry.path === allocation.root) continue;
    let current;
    try { current = await lstat(entry.path, { bigint: true }); }
    catch (error) {
      if (error.code === 'ENOENT') { await check(); return; }
      throw observationError(error, allocation.root, entry.path, 'verify-member');
    }
    if (current.isSymbolicLink() || (entry.path !== path ? !current.isDirectory() : !current.isDirectory() && !current.isFile())) {
      throw observationError(Object.assign(Error('Evidence entry changed'), { code: 'EVIDENCE_ENTRY' }), allocation.root, entry.path, 'verify-member');
    }
    if (entry.before && (entry.before.dev !== current.dev || entry.before.ino !== current.ino || entry.before.isDirectory() !== current.isDirectory() || entry.before.isFile() !== current.isFile())) {
      throw observationError(Object.assign(Error('Evidence ancestor identity changed'), { code: 'EVIDENCE_IDENTITY' }), allocation.root, entry.path, 'verify-member');
    }
  }
  await check();
}
/** Streaming traversal: no content is opened and no path outside the allocation is followed.
 * This is a periodic non-atomic filesystem counter, not a filesystem write-event oracle. */
export async function sampleVolume(allocation, { maxEntries = LIMIT, statEntry = lstat, openDirectory = opendir } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > LIMIT) throw Error('Evidence traversal limit must remain bounded');
  try { await checkRoot(allocation); } catch (error) { throw observationError(error, allocation.root, allocation.root, 'root-before'); }
  const startedAt = new Date().toISOString(), startMs = performance.now(), seen = new Set();
  let logicalBytes = 0n, allocatedBytes = 0n, entries = 0, files = 0, hardLinks = 0, concurrentChanges = 0, blocksAvailable = true;
  const failures = [];
  // Four traversal branches share one entry counter and inode set. Keep one
  // entry of lookahead: spawn only children with a known sibling and walk the
  // last child inline, so single-child ancestors do not reserve idle slots.
  // When slots are busy, recurse inline: no semaphore or whole-tree queue.
  // Every directory waits for its descendants before the original post-stat.
  let branches = 0, traversalFailed = false, traversalFailure;
  const rememberFailure = error => {
    if (!traversalFailed || traversalFailure.code === 'EVIDENCE_MUTATION' && error.code !== 'EVIDENCE_MUTATION') {
      traversalFailed = true; traversalFailure = error;
    }
  };
  async function walk(path, depth, ancestors = []) {
    const children = new Set(); let phase = 'bound', before;

    try {
      if (traversalFailed) throw traversalFailure;
    if (depth > 128 || entries >= maxEntries) {
      // Preserve the existing maxEntries+1 refusal witness, including when
      // several issued branches meet the bound in the same turn.
      if (depth <= 128 && entries === maxEntries) entries++;
      throw Object.assign(Error('Evidence traversal bound'), { code: 'EVIDENCE_BOUND' });
    }
    entries++;
    phase = 'stat-before'; before = await statEntry(path, { bigint: true });
    phase = 'entry';
    if (before.isSymbolicLink() || !before.isFile() && !before.isDirectory()) throw Object.assign(Error('Unsupported evidence entry'), { code: 'EVIDENCE_ENTRY' });
    const identity = `${before.dev}:${before.ino}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      if (typeof before.blocks !== 'bigint') blocksAvailable = false; else allocatedBytes += before.blocks * 512n;
      if (before.isFile()) { logicalBytes += before.size; files++; }
    } else { hardLinks++; if (before.isDirectory()) throw Object.assign(Error('Directory cycle'), { code: 'EVIDENCE_CYCLE' }); }
    if (before.isDirectory()) {
      phase = 'open-directory'; const directory = await openDirectory(path);
      phase = 'read-directory';
      const lineage = [...ancestors, { path, before }];
      let pendingEntry;
      for await (const entry of directory) {
        if (traversalFailed) throw traversalFailure;
        if (pendingEntry) {
          if (branches < 3) {
            branches++;
            let child;
            child = walk(join(path, pendingEntry.name), depth + 1, lineage)
              .catch(rememberFailure)
              .finally(() => { branches--; children.delete(child); });
            children.add(child);
          } else await walk(join(path, pendingEntry.name), depth + 1, lineage);
        }
        pendingEntry = entry;
      }
      if (pendingEntry) await walk(join(path, pendingEntry.name), depth + 1, lineage);
      if (children.size) await Promise.allSettled(children);
      if (traversalFailed) throw traversalFailure;
    }
    phase = 'stat-after'; const after = await statEntry(path, { bigint: true });
    phase = 'identity';
    if (after.isSymbolicLink() || !after.isFile() && !after.isDirectory()) throw Object.assign(Error('Unsupported evidence entry'), { code: 'EVIDENCE_ENTRY' });
    if (before.dev !== after.dev || before.ino !== after.ino || before.isDirectory() !== after.isDirectory() || before.isFile() !== after.isFile()) throw Object.assign(Error('Evidence identity changed during sample'), { code: depth === 0 ? 'EVIDENCE_ROOT' : 'EVIDENCE_MUTATION' });
    if (stamp(before) !== stamp(after)) { concurrentChanges++; if (before.isDirectory()) throw Object.assign(Error('Evidence membership changed during sample'), { code: 'EVIDENCE_MUTATION' }); }
    } catch (error) {
      let failure = error;
      if (!observationDiagnostics.has(error)) {
        if (depth > 0 && error?.code === 'ENOENT' && ['stat-before', 'open-directory', 'read-directory', 'stat-after'].includes(phase)) {
          try {
            await confirmDescendantMutation(allocation, path, ancestors, before);
            failure = Object.assign(Error('Enumerated evidence member disappeared'), { code: 'EVIDENCE_MUTATION' });
          } catch (refused) { failure = refused; }
        }
        failure = observationError(failure, allocation.root, path, phase, error?.code);
      }
      rememberFailure(failure); throw failure;
    } finally { if (children.size) await Promise.allSettled(children); }
  }
  try {
    await walk(allocation.root, 0);
    try { await checkRoot(allocation); } catch (error) { throw observationError(error, allocation.root, allocation.root, 'root-after'); }
  } catch (error) { failures.push(opaqueError(traversalFailed ? traversalFailure : error)); }

  const safe = logicalBytes <= BigInt(Number.MAX_SAFE_INTEGER) && allocatedBytes <= BigInt(Number.MAX_SAFE_INTEGER);
  return { kind: 'evidence-volume-sample-1', startedAt, finishedAt: new Date().toISOString(), startMs, endMs: performance.now(),
    method: 'bounded-nofollow-streaming-lstat', consistency: 'non-atomic-observation-window', completeTraversal: failures.length === 0 && safe && blocksAvailable,
    entries, concurrentChanges, uniqueFiles: files, repeatedInodes: hardLinks, observedLogicalBytes: safe ? Number(logicalBytes) : null,
    observedAllocatedBytes: safe && blocksAvailable ? Number(allocatedBytes) : null, failures,
    limitations: ['Changes between samples are not observed.', 'Concurrent directory membership or identity changes make that sample incomplete; file byte counts are measured at their individual stat observations.', 'Allocated bytes count unique filesystem inodes, including directory blocks; filesystem-wide metadata is unavailable.'] };
}
export function volumeAlarm(sample, capacityBytes) {
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) throw Error('Positive allocated evidence capacity required');
  const bytes = sample.observedAllocatedBytes;
  if (!Number.isSafeInteger(bytes) || !sample.completeTraversal) return { status: 'INCONCLUSIVE', level: 'unknown', percent: null };
  const percent = bytes / capacityBytes * 100;
  return { status: percent >= 90 ? 'FAIL' : 'PASS', level: percent >= 90 ? 'ceiling' : percent >= 80 ? 'target' : 'normal', percent };
}
const OBSERVATION_POLICY = Object.freeze({ maxAttempts: 3, maxWindowMs: 1000, retryCode: 'EVIDENCE_MUTATION' });
const mutationOnly = sample => !sample.completeTraversal && sample.failures.length === 1 && sample.failures[0].code === OBSERVATION_POLICY.retryCode;
/** Every attempt is a fresh, fully drained scan. The fixed window bounds retry
 * admission and acceptance; an already-issued filesystem call is never raced or
 * abandoned. Its late completion remains retained and cannot qualify a window. */
export async function observeVolume(allocation, sampleOptions = {}) {
  const windowStartMs = performance.now(), attempts = []; let windowEndMs = windowStartMs, previous = null;
  for (let sequence = 0; sequence < OBSERVATION_POLICY.maxAttempts; sequence++) {
    if (sequence) {
      // Separate fully drained mutation scans without extending their original
      // window. This referenced timer is owned by the pending observation;
      // monitor.finish() drains it rather than abandoning an issued retry.
      const retryAt = Math.min(attempts.at(-1).endMs + 100, windowStartMs + OBSERVATION_POLICY.maxWindowMs);
      let remaining;
      while ((remaining = retryAt - performance.now()) > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    }
    const startMs = sequence === 0 ? windowStartMs : performance.now();
    if (sequence && startMs - windowStartMs >= OBSERVATION_POLICY.maxWindowMs) { windowEndMs = startMs; break; }
    const startedAt = new Date().toISOString(); let sample;
    try { sample = await sampleVolume(allocation, sampleOptions); }
    catch (error) { sample = { kind: 'evidence-volume-sample-1', startedAt, finishedAt: new Date().toISOString(), startMs, endMs: performance.now(), method: 'bounded-nofollow-streaming-lstat', consistency: 'non-atomic-observation-window', completeTraversal: false, entries: 0, concurrentChanges: 0, uniqueFiles: 0, repeatedInodes: 0, observedLogicalBytes: null, observedAllocatedBytes: null, failures: [opaqueError(error)], limitations: ['Observation failed.'] }; }
    windowEndMs = performance.now();
    const body = { sequence, previous, startMs, endMs: windowEndMs, sample }, attempt = { ...body, hash: hash(body) };
    attempts.push(attempt); previous = attempt.hash;
    if (!mutationOnly(sample) || windowEndMs - windowStartMs >= OBSERVATION_POLICY.maxWindowMs) break;
  }
  const selectedAttempt = attempts.at(-1).sample.completeTraversal && windowEndMs - windowStartMs <= OBSERVATION_POLICY.maxWindowMs ? attempts.length - 1 : null;
  const observation = { kind: 'evidence-volume-observation-2', windowStartMs, windowEndMs, maxAttempts: OBSERVATION_POLICY.maxAttempts, maxWindowMs: OBSERVATION_POLICY.maxWindowMs, attempts, selectedAttempt };
  validateEvidenceObservation(observation); return observation;
}
export async function startEvidenceMonitor({ allocationPath = process.env.IE_EVIDENCE_ALLOCATION, output, campaignId, intervalMs = 2000, allowUnavailable = false, onAlarm = () => {}, openJournal = path => open(path, 'wx', 0o600), sampleOptions = {} }) {
  if (!id(campaignId) || !Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 30000) throw Error('Invalid evidence monitor bounds');
  let allocation;
  try { allocation = await loadAllocation(allocationPath); await evidenceDestination(allocation.root, output, { directory: true }); }
  catch (error) {
    if (!allowUnavailable) throw error;
    return { reference: { kind: 'evidence-volume-reference-1', status: 'INCONCLUSIVE', allocation: null, reason: 'Explicit allocated evidence volume unavailable' },
      async checkpoint() { return null; }, async finish() { return { status: 'INCONCLUSIVE', qualification: false, reason: 'No allocated-volume observer' }; } };
  }
  await checkRoot(allocation);
  const auditId = randomUUID(), directory = join(allocation.root, '.evidence-lifecycle');
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await evidencePath(allocation.root, '.evidence-lifecycle');
  const auditRoot = join(directory, auditId); await mkdir(auditRoot, { mode: 0o700 });
  const sourceHandle = await open(join(auditRoot, 'allocation-source.json'), 'wx', 0o600);
  try { await sourceHandle.writeFile(allocation.sourceBytes); await sourceHandle.sync(); } finally { await sourceHandle.close(); }
  await exclusiveJSON(join(auditRoot, 'allocation.json'), allocation);
  const journal = await openJournal(join(auditRoot, 'samples.jsonl')), startMs = performance.now();
  let head = null, sequence = 0, lastCommittedAlarm = null, pending = Promise.resolve(), stopped = false, finishing = false, lastLevel = null, peakBytes = null, unknownSamples = 0, maximumGapMs = 0, lastStartMs = startMs, lastCoverageStartMs = startMs, totalAttempts = 0, failedAttempts = 0;
  const reference = { kind: 'evidence-volume-reference-1', allocationId: allocation.allocationId, allocationIdentity: allocation.identity, auditId,
    auditPath: relativeMember(allocation.root, join(auditRoot, 'audit.json')), retainedPath: 'evidence-storage/audit.json', root: allocation.root, campaignId, intervalMs, qualification: false, status: 'PENDING' };
  async function observe() {
    const observation = await observeVolume(allocation, sampleOptions), observed = validateEvidenceObservation(observation), sample = observed.sample;
    lastStartMs = observation.windowStartMs;
    if (observed.chosenSample) { maximumGapMs = Math.max(maximumGapMs, observed.chosenSample.startMs - lastCoverageStartMs); lastCoverageStartMs = observed.chosenSample.startMs; }
    totalAttempts += observation.attempts.length; failedAttempts += observed.failedAttempts;
    const alarm = observed.chosenSample ? volumeAlarm(observed.chosenSample, allocation.capacityBytes) : { status: 'INCONCLUSIVE', level: 'unknown', percent: null };
    if (alarm.level === 'unknown') unknownSamples++;
    if (observed.peakCompleteBytes !== null) peakBytes = Math.max(peakBytes ?? 0, observed.peakCompleteBytes);
    const body = { sequence: sequence++, previous: head, campaignId, sample, alarm, observation }, record = { ...body, hash: hash(body) };
    await journal.writeFile(JSON.stringify(record) + '\n'); await journal.sync(); head = record.hash; lastCommittedAlarm = alarm;
    if (alarm.level !== lastLevel) { lastLevel = alarm.level; onAlarm({ allocationId: allocation.allocationId, campaignId, ...alarm }); }
    return record;
  }
  const enqueue = () => { pending = pending.then(observe); return pending; };
  const checkpoint = () => { if (stopped || finishing) throw Error('Evidence monitor closed'); return enqueue(); };
  try { await checkpoint(); } catch (error) { stopped = true; await journal.close(); throw error; }
  let timer = null;
  function schedule() {
    if (stopped || finishing) return;
    // Use the actual preceding sample start, not a nominal tick backlog. An
    // overrun gets one immediate successor after its scan/journal have drained.
    timer = setTimeout(() => {
      timer = null;
      if (stopped || finishing) return;
      checkpoint().then(schedule, () => {}); // A failed journal must not spin.
    }, Math.max(0, lastStartMs + intervalMs - performance.now()));
    timer.unref();
  }
  schedule();
  return { reference, checkpoint, async finish({ receiptPath = null, outcome = 'UNKNOWN' } = {}) {
    if (stopped || finishing) throw Error('Evidence monitor already finished');
    finishing = true;
    clearTimeout(timer);
    let observationError = null, final;
    try { final = await enqueue(); } catch (error) { observationError = opaqueError(error); }
    stopped = true;
    try { await pending; } catch (error) { observationError ??= opaqueError(error); }
    await journal.close();
    let receipt = null;
    if (receiptPath) { const member = relativeMember(allocation.root, receiptPath); receipt = { path: member, ...await fileIdentity(await evidencePath(allocation.root, member)) }; }
    const finalAlarm = final?.alarm ?? lastCommittedAlarm ?? { status: 'INCONCLUSIVE', level: 'unknown', percent: null };
    const ceiling = peakBytes !== null && peakBytes / allocation.capacityBytes >= .9;
    // An interval overrun is recorded as missing coverage, never silently certified continuous.
    const coverageComplete = receipt !== null && sequence >= 2 && !observationError && unknownSamples === 0 && maximumGapMs <= intervalMs * 2;
    const status = ceiling ? 'FAIL' : !coverageComplete ? 'INCONCLUSIVE' : 'PASS';
    const audit = { kind: 'evidence-volume-audit-2', auditId, campaignId, allocationId: allocation.allocationId, allocationIdentity: allocation.identity,
      output: relativeMember(allocation.root, output), outcome, startedMonotonicMs: startMs, recordedAt: new Date().toISOString(), elapsedMs: performance.now() - startMs,
      intervalMs, maximumGapMs, coverageComplete, counterMode: 'periodic-bounded-observation-windows', samples: sequence, journalHead: head,
      journal: await fileIdentity(join(auditRoot, 'samples.jsonl')), peakObservedAllocatedBytes: peakBytes, capacityBytes: allocation.capacityBytes,
      alarms: { targetPercent: 80, ceilingPercent: 90, final: finalAlarm }, unknownSamples, observationError, receipt,
      observationPolicy: OBSERVATION_POLICY, attempts: totalAttempts, failedAttempts,
      status, qualification: status === 'PASS', finalization: 'Audit/index bytes created after final observation are not claimed as measured. Subsequent runs include them.',
      automaticPruning: false };
    await exclusiveJSON(join(auditRoot, 'audit.json'), audit);
    if (receipt) {
      const entries = [];
      async function collect(directory, depth = 0) {
        if (depth > 128) throw Error('Retention directory bound');
        const handle = await opendir(directory);
        for await (const item of handle) {
          const path = join(directory, item.name);
          if (item.isSymbolicLink()) throw Error('Retention symlink refused');
          if (item.isDirectory()) await collect(path, depth + 1);
          else if (item.isFile()) { if (entries.length >= LIMIT) throw Error('Retention entry bound'); entries.push({ path: relativeMember(allocation.root, path), category: 'raw', createdAt: audit.recordedAt }); }
          else throw Error('Unsupported retention entry');
        }
      }
      await evidenceDestination(allocation.root, output, { directory: true, mustExist: true });
      await collect(output);
      for (const name of ['allocation-source.json', 'allocation.json', 'samples.jsonl', 'audit.json']) entries.push({ path: relativeMember(allocation.root, join(auditRoot, name)), category: 'raw', createdAt: audit.recordedAt });
      await createRetentionIndex({ allocation, output: join(auditRoot, 'retention.json'), entries, createdAt: audit.recordedAt });
    }
    if (receipt) {
      const { publishTrends } = await import('./evidence-trends.mjs');
      await publishTrends({ allocation, receiptPath, outputDirectory: auditRoot });
    }
    return audit;
  } };
}

export function retentionDeadline(entry) {
  if (!utc(entry.createdAt)) throw Error('Retention needs exact UTC creation date');
  if (entry.category === 'raw') return new Date(Date.parse(entry.createdAt) + 90 * DAY).toISOString();
  if (entry.category === 'aggregate' || entry.category === 'baseline') return new Date(Date.parse(entry.createdAt) + 365 * DAY).toISOString();
  if (entry.category === 'release-defining' || entry.category === 'source-fixture') {
    if (entry.supportEndsAt === null || entry.supportEndsAt === undefined) return null;
    if (!utc(entry.supportEndsAt) || Date.parse(entry.supportEndsAt) < Date.parse(entry.createdAt)) throw Error('Invalid release support lifetime');
    return new Date(Date.parse(entry.supportEndsAt) + 365 * DAY).toISOString();
  }
  throw Error('Unknown evidence retention category');
}
export async function createRetentionIndex({ allocation, output, entries, createdAt = new Date().toISOString() }) {
  if (!utc(createdAt) || !Array.isArray(entries) || !entries.length || entries.length > LIMIT) throw Error('Invalid bounded retention index');
  await evidenceDestination(allocation.root, output); await checkRoot(allocation);
  const seen = new Set(), records = [];
  for (const entry of entries) {
    if (seen.has(entry.path)) throw Error('Duplicate retention member'); seen.add(entry.path);
    records.push({ path: entry.path, category: entry.category, createdAt: entry.createdAt, supportEndsAt: entry.supportEndsAt ?? null,
      retainUntil: retentionDeadline(entry), identity: await fileIdentity(await evidencePath(allocation.root, entry.path)) });
  }
  const value = { kind: 'evidence-retention-index-1', indexId: randomUUID(), allocationId: allocation.allocationId, createdAt, automaticPruning: false, entries: records };
  const registry = join(allocation.root, '.evidence-lifecycle', 'retention-indexes');
  await mkdir(registry, { recursive: true, mode: 0o700 }); await evidencePath(allocation.root, '.evidence-lifecycle/retention-indexes');
  // The immutable central claim remains even if a caller loses its index copy.
  await exclusiveJSON(join(registry, value.indexId + '.json'), value);
  await exclusiveJSON(output, value); return value;
}
/** Verify an already exported copy. This API never copies or deletes evidence. */
export async function verifyEvidenceExport({ allocation, indexPath, exportRoot, output }) {
  await checkRoot(allocation);
  const index = await boundedJSON(indexPath), indexIdentity = await fileIdentity(indexPath);
  if (index.kind !== 'evidence-retention-index-1' || index.allocationId !== allocation.allocationId || !Array.isArray(index.entries) || index.entries.length > LIMIT) throw Error('Invalid retention index');
  if (!isAbsolute(exportRoot) || await realpath(exportRoot) !== exportRoot || (await lstat(exportRoot)).isSymbolicLink()) throw Error('Canonical export directory required');
  const rel = relative(allocation.root, exportRoot);
  if (!rel || !rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel)) throw Error('Export must be outside allocated evidence root');
  const records = [];
  for (const entry of index.entries) {
    const source = await evidencePath(allocation.root, entry.path), target = await evidencePath(exportRoot, entry.path);
    const [actual, exported] = await Promise.all([fileIdentity(source), fileIdentity(target)]);
    if (hash(actual) !== hash(entry.identity) || hash(exported) !== hash(entry.identity)) throw Error('Export differs from retained evidence');
    const [left, right] = await Promise.all([lstat(source), lstat(target)]);
    if (left.dev === right.dev && left.ino === right.ino) throw Error('A hardlink is not an independent evidence export');
    records.push({ path: entry.path, identity: exported });
  }
  const receipt = { kind: 'evidence-export-verification-1', exportId: randomUUID(), allocationId: allocation.allocationId, indexId: index.indexId,
    indexIdentity, verifiedAt: new Date().toISOString(), exportRoot, entries: records, automaticPruning: false };
  await evidenceDestination(allocation.root, output); await exclusiveJSON(output, receipt); return receipt;
}
export async function eligibleEvidence({ allocation, indexPath, exportReceiptPath, now = new Date().toISOString() }) {
  if (!utc(now)) throw Error('Eligibility requires exact UTC time');
  const index = await boundedJSON(indexPath), exported = await boundedJSON(exportReceiptPath);
  if (index.kind !== 'evidence-retention-index-1' || exported.kind !== 'evidence-export-verification-1' || exported.allocationId !== allocation.allocationId || index.allocationId !== allocation.allocationId || exported.indexId !== index.indexId || hash(exported.indexIdentity) !== hash(await fileIdentity(indexPath))) throw Error('Unbound evidence export receipt');
  const exportedByPath = new Map(exported.entries.map(entry => [entry.path, entry]));
  const claims = new Map();
  const registry = await opendir(await evidencePath(allocation.root, '.evidence-lifecycle/retention-indexes'));
  let claimCount = 0;
  for await (const member of registry) {
    if (++claimCount > LIMIT || !member.isFile() || member.isSymbolicLink() || !member.name.endsWith('.json')) throw Error('Invalid retention claims registry');
    const claim = await boundedJSON(await evidencePath(allocation.root, '.evidence-lifecycle/retention-indexes/' + member.name));
    if (claim.kind !== 'evidence-retention-index-1' || claim.allocationId !== allocation.allocationId) throw Error('Unbound retention claim');
    for (const entry of claim.entries) {
      if (++claimCount > LIMIT) throw Error('Retention claims bound');
      const key = entry.path + ':' + entry.identity.sha256, deadline = retentionDeadline(entry);
      if (entry.retainUntil !== deadline) throw Error('Invalid retained deadline');
      if (!claims.has(key) || deadline === null || claims.get(key) !== null && Date.parse(deadline) > Date.parse(claims.get(key))) claims.set(key, deadline);
    }
  }
  const entries = [];
  for (const entry of index.entries) {
    const declared = retentionDeadline(entry), deadline = claims.get(entry.path + ':' + entry.identity.sha256), copy = exportedByPath.get(entry.path);
    if (deadline === undefined || entry.retainUntil !== declared || !copy || hash(copy.identity) !== hash(entry.identity)) throw Error('Invalid retention/export member');
    const sourceIdentity = await fileIdentity(await evidencePath(allocation.root, entry.path));
    const exportPath = await evidencePath(exported.exportRoot, entry.path), sourcePath = await evidencePath(allocation.root, entry.path);
    const targetIdentity = await fileIdentity(exportPath);
    const [sourceStat, exportStat] = await Promise.all([lstat(sourcePath), lstat(exportPath)]);
    if (sourceStat.dev === exportStat.dev && sourceStat.ino === exportStat.ino) throw Error('Export no longer independently retained');
    if (hash(sourceIdentity) !== hash(entry.identity) || hash(targetIdentity) !== hash(entry.identity)) throw Error('Source/export changed since indexing');
    entries.push({ path: entry.path, eligible: deadline !== null && Date.parse(now) >= Date.parse(deadline), retainUntil: deadline,
      reason: deadline === null ? 'Supported release lifetime remains open' : Date.parse(now) < Date.parse(deadline) ? 'Retention minimum not reached' : 'Expired and independently exported; explicit deletion authorization still required' });
  }
  return { kind: 'evidence-pruning-eligibility-1', recordedAt: now, allocationId: allocation.allocationId, indexId: index.indexId, entries, deletesFiles: false, automaticPruning: false };
}

const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identityValid = value => value && integer(value.bytes) && sha256(value.sha256) && Object.keys(value).every(key => ['bytes', 'sha256'].includes(key));
const keysAre = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)) && allowed.every(key => Object.hasOwn(value, key));
function validateCounterSample(sample) {
  if (!keysAre(sample, ['kind','startedAt','finishedAt','startMs','endMs','method','consistency','completeTraversal','entries','concurrentChanges','uniqueFiles','repeatedInodes','observedLogicalBytes','observedAllocatedBytes','failures','limitations']) ||
      sample.kind !== 'evidence-volume-sample-1' || !utc(sample.startedAt) || !utc(sample.finishedAt) || Date.parse(sample.finishedAt) < Date.parse(sample.startedAt) ||
      !nonnegative(sample.startMs) || !nonnegative(sample.endMs) || sample.endMs < sample.startMs || sample.method !== 'bounded-nofollow-streaming-lstat' || sample.consistency !== 'non-atomic-observation-window' ||
      typeof sample.completeTraversal !== 'boolean' || !['entries','concurrentChanges','uniqueFiles','repeatedInodes'].every(key => integer(sample[key]) && sample[key] <= LIMIT + 1) ||
      !['observedLogicalBytes','observedAllocatedBytes'].every(key => sample[key] === null || integer(sample[key])) ||
      !Array.isArray(sample.failures) || sample.failures.length > 1 || sample.failures.some(value => !keysAre(value, ['code','message']) || typeof value.code !== 'string' || typeof value.message !== 'string') ||
      !Array.isArray(sample.limitations) || sample.limitations.length > 8 || sample.limitations.some(value => typeof value !== 'string' || value.length > 512) ||
      sample.completeTraversal && (sample.failures.length || sample.observedAllocatedBytes === null || sample.observedLogicalBytes === null)) throw Error('Invalid evidence sample schema');
}
/** Offline replay of every actual attempt, including mutation failures. An
 * accepted sample always names the final complete scan within the fixed window;
 * neither failed-prefix time nor a carried-forward count can supply coverage. */
export function validateEvidenceObservation(observation) {
  if (!keysAre(observation, ['kind','windowStartMs','windowEndMs','maxAttempts','maxWindowMs','attempts','selectedAttempt']) ||
      observation.kind !== 'evidence-volume-observation-2' || observation.maxAttempts !== OBSERVATION_POLICY.maxAttempts || observation.maxWindowMs !== OBSERVATION_POLICY.maxWindowMs ||
      !nonnegative(observation.windowStartMs) || !nonnegative(observation.windowEndMs) || observation.windowEndMs < observation.windowStartMs ||
      !Array.isArray(observation.attempts) || observation.attempts.length < 1 || observation.attempts.length > OBSERVATION_POLICY.maxAttempts ||
      observation.selectedAttempt !== null && !integer(observation.selectedAttempt)) throw Error('Invalid evidence observation schema');
  let previous = null, priorEnd = observation.windowStartMs, priorSample = null, peakCompleteBytes = null, failedAttempts = 0;
  for (const [sequence, attempt] of observation.attempts.entries()) {
    if (!keysAre(attempt, ['sequence','previous','startMs','endMs','sample','hash']) || attempt.sequence !== sequence || attempt.previous !== previous || !sha256(attempt.hash) ||
        !nonnegative(attempt.startMs) || !nonnegative(attempt.endMs) || attempt.endMs < attempt.startMs || attempt.startMs < priorEnd ||
        sequence === 0 && attempt.startMs !== observation.windowStartMs || attempt.startMs - observation.windowStartMs >= OBSERVATION_POLICY.maxWindowMs ||
        sequence > 0 && (!mutationOnly(priorSample) || priorEnd - observation.windowStartMs >= OBSERVATION_POLICY.maxWindowMs)) throw Error('Invalid evidence attempt chronology or retry');
    const { hash: recordedHash, ...body } = attempt;
    if (hash(body) !== recordedHash) throw Error('Invalid evidence attempt chain');
    validateCounterSample(attempt.sample);
    if (attempt.sample.startMs < attempt.startMs || attempt.sample.endMs > attempt.endMs) throw Error('Invalid evidence attempt sample span');
    if (attempt.sample.completeTraversal) peakCompleteBytes = Math.max(peakCompleteBytes ?? 0, attempt.sample.observedAllocatedBytes); else failedAttempts++;
    previous = recordedHash; priorEnd = attempt.endMs; priorSample = attempt.sample;
  }
  if (observation.windowEndMs < priorEnd || observation.windowEndMs !== priorEnd && !(mutationOnly(priorSample) && observation.attempts.length < OBSERVATION_POLICY.maxAttempts && observation.windowEndMs - observation.windowStartMs >= OBSERVATION_POLICY.maxWindowMs)) throw Error('Invalid evidence observation end');
  if (mutationOnly(priorSample) && observation.attempts.length < OBSERVATION_POLICY.maxAttempts && observation.windowEndMs - observation.windowStartMs < OBSERVATION_POLICY.maxWindowMs) throw Error('Omitted evidence mutation retry');
  const selectedAttempt = priorSample.completeTraversal && observation.windowEndMs - observation.windowStartMs <= OBSERVATION_POLICY.maxWindowMs ? observation.attempts.length - 1 : null;
  if (observation.selectedAttempt !== selectedAttempt) throw Error('Invalid evidence selected attempt');
  return { sample: priorSample, chosenSample: selectedAttempt === null ? null : priorSample, peakCompleteBytes, failedAttempts };
}
function validateAudit(audit) {
  if (!keysAre(audit, ['kind','auditId','campaignId','allocationId','allocationIdentity','output','outcome','startedMonotonicMs','recordedAt','elapsedMs','intervalMs','maximumGapMs','coverageComplete','counterMode','samples','journalHead','journal','peakObservedAllocatedBytes','capacityBytes','alarms','unknownSamples','observationError','receipt','status','qualification','finalization','automaticPruning']) ||
      audit.kind !== 'evidence-volume-audit-1' || !id(audit.auditId) || !id(audit.campaignId) || !id(audit.allocationId) || !identityValid(audit.allocationIdentity) || !utc(audit.recordedAt) ||
      !nonnegative(audit.startedMonotonicMs) || !nonnegative(audit.elapsedMs) || !nonnegative(audit.maximumGapMs) || !integer(audit.intervalMs) || audit.intervalMs < 50 || audit.intervalMs > 30000 ||
      !integer(audit.samples) || audit.samples < 1 || audit.samples > 1000000 || !integer(audit.unknownSamples) || audit.unknownSamples > audit.samples || !sha256(audit.journalHead) || !identityValid(audit.journal) ||
      !integer(audit.capacityBytes) || audit.capacityBytes === 0 || audit.peakObservedAllocatedBytes !== null && !integer(audit.peakObservedAllocatedBytes) ||
      typeof audit.coverageComplete !== 'boolean' || typeof audit.qualification !== 'boolean' || audit.counterMode !== 'periodic-while-campaign-active' || audit.automaticPruning !== false ||
      !keysAre(audit.alarms, ['targetPercent','ceilingPercent','final']) || audit.alarms.targetPercent !== 80 || audit.alarms.ceilingPercent !== 90 ||
      !['PASS','FAIL','INCONCLUSIVE'].includes(audit.status) || audit.observationError !== null && (!keysAre(audit.observationError, ['code','message']) || typeof audit.observationError.code !== 'string') ||
      typeof audit.output !== 'string' || typeof audit.outcome !== 'string' || typeof audit.finalization !== 'string' ||
      !audit.receipt || !keysAre(audit.receipt, ['path','bytes','sha256']) || typeof audit.receipt.path !== 'string' || !identityValid({ bytes: audit.receipt.bytes, sha256: audit.receipt.sha256 })) throw Error('Invalid evidence audit schema');
}
async function verifyEvidenceAuditV1(reference, receiptPath) {
  if (reference?.kind !== 'evidence-volume-reference-1' || !reference.auditPath || !isAbsolute(reference.root ?? '')) return { status: 'INCONCLUSIVE', qualification: false, reason: 'Allocated volume audit unavailable' };
  // A transferred receipt uses its colocated retained audit; no original-host access.
  const auditPath = reference.retainedPath === 'evidence-storage/audit.json' ? await evidencePath(dirname(receiptPath), reference.retainedPath) : await evidencePath(reference.root, reference.auditPath), audit = await boundedJSON(auditPath);
  validateAudit(audit);
  const allocation = await boundedJSON(join(dirname(auditPath), 'allocation.json'));
  const originalAllocation = await readEvidenceJSON(join(dirname(auditPath), 'allocation-source.json'), { withIdentity: true });
  const declared = originalAllocation.value;
  if (hash(originalAllocation.identity) !== hash(reference.allocationIdentity) || !keysAre(declared, ['kind','allocationId','purpose','capacityBytes','root','issuedAt','owner']) || declared.kind !== 'evidence-volume-allocation-1' || declared.purpose !== 'qualification-evidence-only' || !id(declared.allocationId) || !id(declared.owner) || !utc(declared.issuedAt) || !integer(declared.capacityBytes) || declared.capacityBytes === 0 || !isAbsolute(declared.root ?? '') || declared.root === '/' || /[\x00-\x1f\x7f]/.test(declared.root) || !['kind','allocationId','purpose','capacityBytes','root','issuedAt','owner'].every(key => allocation[key] === declared[key])) throw Error('Retained allocation source differs from protected identity');
  if (allocation.kind !== 'evidence-volume-allocation-1' || allocation.allocationId !== audit.allocationId || allocation.capacityBytes !== audit.capacityBytes || hash(allocation.identity) !== hash(audit.allocationIdentity)) throw Error('Evidence allocation differs from audit');
  if (audit.kind !== 'evidence-volume-audit-1' || audit.auditId !== reference.auditId || audit.campaignId !== reference.campaignId || audit.allocationId !== reference.allocationId || hash(audit.allocationIdentity) !== hash(reference.allocationIdentity)) throw Error('Unbound evidence volume audit');
  if (!audit.receipt || hash(await fileIdentity(receiptPath)) !== hash({ bytes: audit.receipt.bytes, sha256: audit.receipt.sha256 })) throw Error('Volume audit does not bind raw campaign receipt');
  const journalPath = join(dirname(auditPath), 'samples.jsonl');
  if (hash(await fileIdentity(journalPath)) !== hash(audit.journal)) throw Error('Evidence counter journal changed');
  const fd = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW), buffer = Buffer.alloc(65536);
  let pending = '', head = null, sequence = 0, peak = null, unknown = 0, lastStart = audit.startedMonotonicMs, maximumGapMs = 0, lastAlarm = null, lastEnd = audit.startedMonotonicMs;
  try {
    for (;;) {
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      pending += buffer.subarray(0, bytesRead).toString('utf8');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        if (end > 65536 || sequence >= 1000000) throw Error('Evidence journal bound exceeded');
        const record = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        const { hash: recordedHash, ...body } = record;
        if (!keysAre(record, ['sequence','previous','campaignId','sample','alarm','hash']) || !integer(record.sequence) || !sha256(recordedHash) || record.previous !== null && !sha256(record.previous)) throw Error('Invalid evidence journal record schema');
        validateCounterSample(record.sample);
        if (record.sample.startMs < lastEnd || record.sample.startMs < audit.startedMonotonicMs || record.sample.endMs > audit.startedMonotonicMs + audit.elapsedMs) throw Error('Invalid ordered evidence monotonic span');
        lastEnd = record.sample.endMs; lastAlarm = record.alarm;
        if (record.sequence !== sequence++ || record.previous !== head || hash(body) !== recordedHash || record.campaignId !== audit.campaignId || hash(volumeAlarm(record.sample, audit.capacityBytes)) !== hash(record.alarm)) throw Error('Invalid evidence counter journal chain');
        head = recordedHash;
        if (record.alarm.level === 'unknown') unknown++;
        if (record.sample.completeTraversal) peak = Math.max(peak ?? 0, record.sample.observedAllocatedBytes);
        if (lastStart !== null) maximumGapMs = Math.max(maximumGapMs, record.sample.startMs - lastStart);
        lastStart = record.sample.startMs;
      }
      if (pending.length > 65536) throw Error('Evidence journal line bound exceeded');
    }
    if (pending) throw Error('Incomplete evidence counter journal');
  } finally { await fd.close(); }
  if (!sequence || sequence !== audit.samples || head !== audit.journalHead || peak !== audit.peakObservedAllocatedBytes || unknown !== audit.unknownSamples || maximumGapMs !== audit.maximumGapMs || hash(lastAlarm) !== hash(audit.alarms.final)) throw Error('Evidence audit cannot be reproduced');
  const coverageComplete = sequence >= 2 && !audit.observationError && unknown === 0 && audit.maximumGapMs <= audit.intervalMs * 2;
  const status = peak !== null && peak / audit.capacityBytes >= .9 ? 'FAIL' : !coverageComplete ? 'INCONCLUSIVE' : 'PASS';
  if (audit.coverageComplete !== coverageComplete || audit.status !== status || audit.qualification !== (status === 'PASS')) throw Error('Invalid evidence volume verdict');
  return { status, qualification: status === 'PASS', auditPath };
}


function validateAuditV2(audit) {
  if (!audit || audit.kind !== 'evidence-volume-audit-2' || audit.counterMode !== 'periodic-bounded-observation-windows') throw Error('Invalid evidence v2 audit schema');
  const { observationPolicy, attempts, failedAttempts, ...priorFields } = audit;
  if (!keysAre(observationPolicy, ['maxAttempts','maxWindowMs','retryCode']) || Object.keys(OBSERVATION_POLICY).some(key => observationPolicy[key] !== OBSERVATION_POLICY[key]) ||
      !integer(attempts) || attempts < audit.samples || attempts > audit.samples * OBSERVATION_POLICY.maxAttempts || !integer(failedAttempts) || failedAttempts > attempts) throw Error('Invalid evidence v2 attempt summary');
  validateAudit({ ...priorFields, kind: 'evidence-volume-audit-1', counterMode: 'periodic-while-campaign-active' });
}

async function verifyEvidenceAuditV2(reference, receiptPath) {
  if (reference?.kind !== 'evidence-volume-reference-1' || !reference.auditPath || !isAbsolute(reference.root ?? '')) return { status: 'INCONCLUSIVE', qualification: false, reason: 'Allocated volume audit unavailable' };
  // A transferred receipt uses its colocated retained audit; no original-host access.
  const auditPath = reference.retainedPath === 'evidence-storage/audit.json' ? await evidencePath(dirname(receiptPath), reference.retainedPath) : await evidencePath(reference.root, reference.auditPath), audit = await boundedJSON(auditPath);
  validateAuditV2(audit);
  const allocation = await boundedJSON(join(dirname(auditPath), 'allocation.json'));
  const originalAllocation = await readEvidenceJSON(join(dirname(auditPath), 'allocation-source.json'), { withIdentity: true });
  const declared = originalAllocation.value;
  if (hash(originalAllocation.identity) !== hash(reference.allocationIdentity) || !keysAre(declared, ['kind','allocationId','purpose','capacityBytes','root','issuedAt','owner']) || declared.kind !== 'evidence-volume-allocation-1' || declared.purpose !== 'qualification-evidence-only' || !id(declared.allocationId) || !id(declared.owner) || !utc(declared.issuedAt) || !integer(declared.capacityBytes) || declared.capacityBytes === 0 || !isAbsolute(declared.root ?? '') || declared.root === '/' || /[\x00-\x1f\x7f]/.test(declared.root) || !['kind','allocationId','purpose','capacityBytes','root','issuedAt','owner'].every(key => allocation[key] === declared[key])) throw Error('Retained allocation source differs from protected identity');
  if (allocation.kind !== 'evidence-volume-allocation-1' || allocation.allocationId !== audit.allocationId || allocation.capacityBytes !== audit.capacityBytes || hash(allocation.identity) !== hash(audit.allocationIdentity)) throw Error('Evidence allocation differs from audit');
  if (audit.intervalMs !== reference.intervalMs || audit.kind !== 'evidence-volume-audit-2' || audit.auditId !== reference.auditId || audit.campaignId !== reference.campaignId || audit.allocationId !== reference.allocationId || hash(audit.allocationIdentity) !== hash(reference.allocationIdentity)) throw Error('Unbound evidence volume audit');
  if (!audit.receipt || hash(await fileIdentity(receiptPath)) !== hash({ bytes: audit.receipt.bytes, sha256: audit.receipt.sha256 })) throw Error('Volume audit does not bind raw campaign receipt');
  const journalPath = join(dirname(auditPath), 'samples.jsonl');
  if (hash(await fileIdentity(journalPath)) !== hash(audit.journal)) throw Error('Evidence counter journal changed');
  const fd = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW), buffer = Buffer.alloc(65536);
  let pending = '', head = null, sequence = 0, peak = null, unknown = 0, lastStart = audit.startedMonotonicMs, maximumGapMs = 0, lastAlarm = null, lastEnd = audit.startedMonotonicMs, attempts = 0, failedAttempts = 0;
  try {
    for (;;) {
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      pending += buffer.subarray(0, bytesRead).toString('utf8');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        if (end > 65536 || sequence >= 1000000) throw Error('Evidence journal bound exceeded');
        const record = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        const { hash: recordedHash, ...body } = record;
        if (!keysAre(record, ['sequence','previous','campaignId','sample','alarm','observation','hash']) || !integer(record.sequence) || !sha256(recordedHash) || record.previous !== null && !sha256(record.previous)) throw Error('Invalid evidence journal record schema');
        validateCounterSample(record.sample);
        const observed = validateEvidenceObservation(record.observation), window = record.observation;
        if (hash(record.sample) !== hash(observed.sample)) throw Error('Evidence selected raw sample differs');
        if (window.windowStartMs < lastEnd || window.windowStartMs < audit.startedMonotonicMs || window.windowEndMs > audit.startedMonotonicMs + audit.elapsedMs) throw Error('Invalid ordered evidence observation span');
        lastEnd = window.windowEndMs; lastAlarm = record.alarm;
        const expectedAlarm = observed.chosenSample ? volumeAlarm(observed.chosenSample, audit.capacityBytes) : { status: 'INCONCLUSIVE', level: 'unknown', percent: null };
        if (record.sequence !== sequence++ || record.previous !== head || hash(body) !== recordedHash || record.campaignId !== audit.campaignId || hash(expectedAlarm) !== hash(record.alarm)) throw Error('Invalid evidence counter journal chain');
        head = recordedHash; attempts += window.attempts.length; failedAttempts += observed.failedAttempts;
        if (record.alarm.level === 'unknown') unknown++;
        if (observed.peakCompleteBytes !== null) peak = Math.max(peak ?? 0, observed.peakCompleteBytes);
        if (observed.chosenSample) { maximumGapMs = Math.max(maximumGapMs, observed.chosenSample.startMs - lastStart); lastStart = observed.chosenSample.startMs; }
      }
      if (pending.length > 65536) throw Error('Evidence journal line bound exceeded');
    }
    if (pending) throw Error('Incomplete evidence counter journal');
  } finally { await fd.close(); }
  if (attempts !== audit.attempts || failedAttempts !== audit.failedAttempts || !sequence || sequence !== audit.samples || head !== audit.journalHead || peak !== audit.peakObservedAllocatedBytes || unknown !== audit.unknownSamples || maximumGapMs !== audit.maximumGapMs || hash(lastAlarm) !== hash(audit.alarms.final)) throw Error('Evidence audit cannot be reproduced');
  const coverageComplete = sequence >= 2 && !audit.observationError && unknown === 0 && audit.maximumGapMs <= audit.intervalMs * 2;
  const status = peak !== null && peak / audit.capacityBytes >= .9 ? 'FAIL' : !coverageComplete ? 'INCONCLUSIVE' : 'PASS';
  if (audit.coverageComplete !== coverageComplete || audit.status !== status || audit.qualification !== (status === 'PASS')) throw Error('Invalid evidence volume verdict');
  return { status, qualification: status === 'PASS', auditPath };
}


/** The v1 verifier remains byte-for-byte unchanged below its renamed entry.
 * References retain their transport envelope; the audit selects explicit v2
 * attempt replay instead of silently upgrading any historical observation. */
export async function verifyEvidenceAudit(reference, receiptPath) {
  if (reference?.kind !== 'evidence-volume-reference-1' || !reference.auditPath || !isAbsolute(reference.root ?? '')) return verifyEvidenceAuditV1(reference, receiptPath);
  const auditPath = reference.retainedPath === 'evidence-storage/audit.json' ? await evidencePath(dirname(receiptPath), reference.retainedPath) : await evidencePath(reference.root, reference.auditPath);
  const audit = await boundedJSON(auditPath);
  return audit.kind === 'evidence-volume-audit-2' ? verifyEvidenceAuditV2(reference, receiptPath) : verifyEvidenceAuditV1(reference, receiptPath);
}

export const AUDIT_FILES = ['allocation-source.json', 'allocation.json', 'samples.jsonl', 'audit.json', 'retention.json', 'trends.json', 'trends.html', 'trend-retention.json'];
/** Copy the finished audit beside a raw receipt so CI transfers do not depend on a host path. */
export async function retainEvidenceAudit(reference, destinationDirectory, sourceDirectory = null) {
  if (!reference?.auditPath) return [];
  const source = sourceDirectory ?? dirname(await evidencePath(reference.root, reference.auditPath));
  if (await realpath(destinationDirectory) !== destinationDirectory || !(await lstat(destinationDirectory)).isDirectory()) throw Error('Audit retention destination alias/type refused');
  const target = join(destinationDirectory, 'evidence-storage'); await mkdir(target, { mode: 0o700 });
  const files = [];
  for (const name of AUDIT_FILES) {
    const path = await evidencePath(source, name), expected = await fileIdentity(path);
    const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let output; const buffer = Buffer.alloc(65536);
    try { output = await open(join(target, name), 'wx', 0o600); } catch (error) { await input.close(); throw error; }
    try { for (;;) { const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break; let offset = 0; while (offset < bytesRead) { const written = await output.write(buffer, offset, bytesRead - offset, null); if (!written.bytesWritten) throw Error('Evidence copy made no progress'); offset += written.bytesWritten; } } await output.sync(); }
    finally { await input.close(); await output.close(); }
    if (hash(await fileIdentity(join(target, name))) !== hash(expected) || hash(await fileIdentity(path)) !== hash(expected)) throw Error('Audit changed during retention');
    files.push({ path: 'evidence-storage/' + name, ...expected });
  }
  await exclusiveJSON(join(target, 'bundle.json'), { kind: 'evidence-audit-bundle-1', auditId: reference.auditId, files });
  return files;
}
