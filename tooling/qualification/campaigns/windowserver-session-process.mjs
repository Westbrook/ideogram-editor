import {spawn, execFile} from 'node:child_process';
import {promisify, isDeepStrictEqual} from 'node:util';
import {constants, writeSync} from 'node:fs';
import {open, mkdir, lstat, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {platform, arch, release} from 'node:os';
import {fileURLToPath} from 'node:url';
import {verifyWindowServerBuild, retainWindowServerBuildEvidence} from '../native/windowserver-build.mjs';
import {windowServerSessionCapacity, validateWindowServerSessionConfig, validateWindowServerSessionReady, verifyWindowServerSessionCapture, getWindowServerSessionObservations} from './windowserver-session.mjs';
import {inspectSessionEvidenceBudget} from './windowserver-session-budget.mjs';
import {loadAllocation, sampleVolume, volumeAlarm, evidenceDestination} from '../evidence-volume.mjs';

const exec = promisify(execFile), MAX_STDERR = 1024 ** 2, MAX_BINARY = 64 * 1024 ** 2;
const MAX_PROCESS_JSON = 128 * 1024, MAX_FINAL_SAMPLE = 64 * 1024, MAX_SOURCE = 4 * 1024 ** 2;
const sessionSourcePath = fileURLToPath(new URL('../native/windowserver-session-capture.swift', import.meta.url));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const demand = (condition, reason) => { if (!condition) throw Error(reason); };
const same = (a, b, reason) => demand(isDeepStrictEqual(a, b), reason);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const copy = value => freeze(structuredClone(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function keys(value, expected, label) { demand(object(value), `Invalid ${label}`); same(Object.keys(value).sort(), [...expected].sort(), `Unexpected ${label} fields`); }
function integer(value, minimum, maximum, label) { demand(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `Invalid ${label}`); return value; }
function ticks(value) {
  demand(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'Invalid native clock ticks');
  const parsed = BigInt(value); demand(parsed <= 18446744073709551615n, 'Native clock exceeds UInt64'); return parsed;
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {}); return {promise, resolve, reject}; }
function deadline(value, label, maximum = 30000) { return integer(value, 1, maximum, label); }

export function validateSessionWindowServerConfig(value) {
  return copy(validateWindowServerSessionConfig(value));
}

/** Bounded protocol state, exposed for pure tests. This produces provisional
 * observations only; it cannot manufacture the private byte-replay token. */
export function createSessionWindowServerControl({config: supplied, outputDirectory, send, onFailure = () => {}, clockTimeoutMs = 2000}) {
  const config = validateSessionWindowServerConfig(supplied), capacity = windowServerSessionCapacity(config.roi); deadline(clockTimeoutMs, 'clock deadline');
  demand(typeof send === 'function' && typeof onFailure === 'function' && isAbsolute(outputDirectory), 'Invalid native control owner');
  const admitted = deferred(), ids = new Set(), awaitingAck = new Set(), clocks = new Map(), records = [];
  let ready = null, stopped = null, failure, hasFailure = false, stopRequested = false, lastOrdinal = 0;
  function rejectPending(error) {
    for (const waiter of clocks.values()) { clearTimeout(waiter.timer); waiter.reject(error); } clocks.clear();
  }
  function fail(error) {
    if (hasFailure) return; hasFailure = true; failure = error;
    admitted.reject(failure); rejectPending(failure); onFailure(failure);
  }
  function active() { if (hasFailure) throw failure; demand(ready && !stopped && !stopRequested, 'Native control is not active'); }
  function sample(row) {
    demand(row?.schemaVersion === 2 && row.event === 'sample' && row.retained === true && row.status === 'complete' && row.statusRaw === 0,
      'Stdout sample is not retained and complete');
    integer(row.ordinal, 1, capacity.maxFrames, 'sample ordinal');
    demand(row.file === `frame-${row.ordinal}.bgra` && sha(row.sha256) && row.byteLength === config.roi.width * config.roi.height * 4 &&
      row.ownerPID === config.expectedBrowserPid && row.contentScale === 1 && row.pixelFormat === 1111970369, 'Invalid provisional sample identity');
    integer(row.windowNumber, 1, 0xffffffff, 'sample window');
    demand(ticks(row.displayTimeMach) <= ticks(row.callbackMach) && ticks(row.callbackMach) <= ticks(row.windowObservationMach), 'Provisional sample clocks reversed');
    same(row.roi, config.roi, 'Provisional sample ROI differs');
    if (ready) {
      demand(row.windowNumber === ready.windowAdmission.windowNumber && row.width === ready.display.width && row.height === ready.display.height &&
        ticks(row.displayTimeMach) >= ticks(ready.startedMach), 'Provisional sample differs from ready admission');
      integer(row.aboveVisibleWindowCount, 0, Number.MAX_SAFE_INTEGER, 'sample higher-window count');
      demand(row.intersectingAboveWindowCount === 0, 'Provisional ROI has an intersecting higher window');
    }
  }
  function accept(row) {
    if (hasFailure) throw failure;
    try {
      demand(object(row) && !stopped, 'Native output after stopped or invalid record');
      if (row.event === 'ready') {
        demand(!ready, 'Duplicate native ready');
        ready = copy(validateWindowServerSessionReady(row, {config, outputDirectory}));
        for (const previous of records) if (previous.event === 'sample') sample(previous);
        admitted.resolve(ready); return;
      }
      if (row.event === 'stopped') {
        keys(row, ['schemaVersion', 'event', 'terminalReason', 'endedMach', 'manifest'], 'native stopped');
        demand(ready && row.schemaVersion === 2 && row.manifest === 'manifest.json' && row.terminalReason === 'requested-stop' && stopRequested && ticks(row.endedMach) >= ticks(ready.startedMach), 'Invalid native stopped');
        stopped = copy(row); rejectPending(Error('Native capture ended before the pending observation')); return;
      }
      demand(records.length < capacity.maxFrames + capacity.maxClockRecords, 'Native control record limit');
      if (row.event === 'sample') {
        sample(row); demand(row.ordinal > lastOrdinal, 'Duplicate or reversed sample ordinal'); lastOrdinal = row.ordinal;
        records.push(copy(row)); return;
      }
      keys(row, ['schemaVersion', 'event', 'id', 'mach'], 'native clock ACK');
      demand(ready && row.schemaVersion === 2 && row.event === 'clock' && awaitingAck.has(row.id), 'Unsolicited native clock ACK');
      demand(ticks(row.mach) >= ticks(ready.startedMach), 'Native ACK predates capture');
      awaitingAck.delete(row.id); const waiter = clocks.get(row.id); clocks.delete(row.id); records.push(copy(row));
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(copy(row)); }
    } catch (error) { fail(error); throw error; }
  }
  function captureClock(id) {
    try {
      active(); demand(typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && !ids.has(id) && ids.size < capacity.maxClockRecords, 'Invalid or repeated native clock ID'); ids.add(id);
      const pending = deferred(); pending.timer = setTimeout(() => fail(Error('Native clock deadline exceeded')), clockTimeoutMs); clocks.set(id, pending);
      Promise.resolve().then(() => {
        if (hasFailure || stopped || stopRequested || clocks.get(id) !== pending) return;
        awaitingAck.add(id); return send({command: 'clock', id});
      }).catch(fail); return pending.promise;
    } catch (error) { fail(error); return Promise.reject(error); }
  }
  async function requestStop() {
    if (hasFailure) throw failure; if (stopped || stopRequested) return;
    demand(ready, 'Cannot request native stop before ready'); stopRequested = true;
    rejectPending(Error('Native stop requested')); try { await send({command: 'stop'}); } catch (error) { fail(error); throw error; }
  }
  function assertReplay(manifest, retained) {
    if (hasFailure) throw failure; demand(ready && stopped, 'Native ready/stopped pair missing');
    for (const name of ['config', 'capacity', 'storageAdmission', 'display', 'captureGeometry', 'windowAdmission', 'timebase', 'startedMach']) same(manifest[name], ready[name], 'Native manifest differs from ready: ' + name);
    same(manifest.endedMach, stopped.endedMach, 'Native ended clock differs'); same(manifest.terminalReason, stopped.terminalReason, 'Native terminal reason differs');
    if (stopRequested) demand(stopped.terminalReason === 'requested-stop', 'Explicit stop did not finish as requested');
    same(retained.filter(row => row.event === 'clock' || row.event === 'sample' && row.retained === true), records, 'Stdout observations differ from retained native records');
  }
  return Object.freeze({ready: admitted.promise, accept, captureClock, requestStop, fail, assertReplay,
    snapshot: () => copy({ready, stopped, records, stopRequested, failure: hasFailure ? String(failure) : null})});
}

async function ownedDirectory(path, mode, {bigint = false} = {}) {
  demand(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && await realpath(path) === path, 'Directory must be absolute and canonical');
  const info = await lstat(path, {bigint}); demand(info.isDirectory() && !info.isSymbolicLink() && Number(info.uid) === process.getuid() && (Number(info.mode) & 0o077) === 0 && (mode === undefined || (Number(info.mode) & 0o777) === mode), 'Unsafe owned directory');
  return info;
}
async function readBounded(path, maximum, check, mode = 0o400) {
  check();
  demand(await realpath(dirname(path)) === dirname(path), 'Artifact parent is linked');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    demand(before.isFile() && before.nlink === 1 && before.uid === process.getuid() && (mode === null ? (before.mode & 0o022) === 0 : (before.mode & 0o777) === mode) && before.size >= 0 && before.size <= maximum, 'Unsafe or oversized native artifact');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { check(); const read = await file.read(bytes, offset, Math.min(bytes.length - offset, 1024 ** 2), offset); demand(read.bytesRead > 0, 'Native artifact truncated'); offset += read.bytesRead; }
    const tail = await file.read(Buffer.alloc(1), 0, 1, offset), after = await file.stat(), current = await lstat(path);
    demand(tail.bytesRead === 0 && current.isFile() && current.dev === before.dev && current.ino === before.ino &&
      [after, current].every(value => value.size === before.size && value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs && value.nlink === 1), 'Native artifact changed while reading');
    check(); return bytes;
  } finally { await file.close(); }
}
async function exclusiveJSON(path, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); demand(bytes.length <= MAX_PROCESS_JSON, 'Native supervisor JSON limit exceeded');
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.chmod(0o400); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  return {path, bytes: bytes.length, sha256: digest(bytes)};
}
async function exclusiveBytes(path, bytes, maximum) {
  demand(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum, 'Invalid bounded retained authority');
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.chmod(0o400); await file.sync(); } finally { await file.close(); }
  const parent = await open(dirname(path), constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
  return {path, bytes: bytes.length, sha256: digest(bytes)};
}
async function birth(pid) {
  const {stdout} = await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart='], {timeout: 1000, maxBuffer: 4096, env: {PATH: '/usr/bin:/bin', LANG: 'C'}});
  const match = /^\s*(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(stdout);
  demand(match && Number(match[1]) === pid && Number(match[2]) === pid, 'Native owned process birth/group unavailable');
  return {pid, pgid: Number(match[2]), startedAtIdentity: match[3]};
}

/** Finite session successor; no HMR source is changed. Only a separately built
 * session collector is admitted by its current source pin. This never compiles,
 * installs, discovers a compiler, or replaces the outer evidence monitor. */
export async function startSessionWindowServerCapture(options) {
  demand(object(options) && Object.keys(options).every(key => ['build', 'config', 'evidenceAllocation', 'evidenceReservation', 'directory', 'abortSignal', 'readyTimeoutMs', 'clockTimeoutMs', 'stopTimeoutMs', 'processRecordDirectory'].includes(key)), 'Unexpected native session supervisor options');
  demand(process.platform !== 'win32', 'Native session supervisor requires POSIX ownership');
  const {build: suppliedBuild, abortSignal, directory, processRecordDirectory} = options;
  keys(suppliedBuild, ['receiptPath', 'receiptSha256', 'sourceSha256'], 'native build pin');
  const build = copy(suppliedBuild), requestedConfig = copy(options.config), evidenceAllocation = copy(options.evidenceAllocation), evidenceReservation = copy(options.evidenceReservation);
  keys(evidenceAllocation, ['path', 'bytes', 'sha256'], 'evidence allocation selection');
  demand(evidenceAllocation.path === process.env.IE_EVIDENCE_ALLOCATION && isAbsolute(evidenceAllocation.path) && await realpath(evidenceAllocation.path) === evidenceAllocation.path, 'Session allocation differs from controller authority');
  const allocation = await loadAllocation(evidenceAllocation.path);
  same(allocation.identity, {bytes: evidenceAllocation.bytes, sha256: evidenceAllocation.sha256}, 'Session allocation authority pin differs');
  await ownedDirectory(allocation.root);
  demand(typeof directory === 'string' && isAbsolute(directory) && resolve(directory) === directory, 'Native output must be absolute and normalized');
  await evidenceDestination(allocation.root, directory, {directory: true}); await ownedDirectory(dirname(directory));
  if (processRecordDirectory !== undefined) { await evidenceDestination(allocation.root, processRecordDirectory, {directory: true, mustExist: true}); await ownedDirectory(processRecordDirectory); }
  const readyTimeoutMs = deadline(options.readyTimeoutMs ?? 10000, 'ready deadline'), stopTimeoutMs = deadline(options.stopTimeoutMs ?? 120000, 'stop deadline', 300000);
  const clockTimeoutMs = deadline(options.clockTimeoutMs ?? 2000, 'clock deadline'); abortSignal?.throwIfAborted();
  // A fresh private directory may be created before the read-only budget gate;
  // bulk oracle/build/native evidence remains behind complete admission.
  await mkdir(directory, {mode: 0o700}); await ownedDirectory(directory, 0o700);
  const budgetInputs = {config: requestedConfig, evidenceAllocation, evidenceReservation, outputDirectory: directory};
  const preparation = await inspectSessionEvidenceBudget(budgetInputs); abortSignal?.throwIfAborted();
  const budgetDirectory = join(directory, 'evidence-budget'); await mkdir(budgetDirectory, {mode: 0o700});
  const authority = await exclusiveBytes(join(budgetDirectory, 'allocation-source.json'), preparation.allocationSourceBytes, 16 * 1024 ** 2);
  same({bytes: authority.bytes, sha256: authority.sha256}, allocation.identity, 'Retained allocation source differs');
  const preparationPin = await exclusiveJSON(join(budgetDirectory, 'preparation.json'), preparation.admission);
  const sourceBy = performance.now() + readyTimeoutMs;
  const sourceBytes = await readBounded(sessionSourcePath, MAX_SOURCE, () => { abortSignal?.throwIfAborted(); demand(performance.now() < sourceBy, 'Session source read deadline exceeded'); }, null);
  const authorizedSource = copy({path: sessionSourcePath, bytes: sourceBytes.length, sha256: digest(sourceBytes)});
  demand(build.sourceSha256 === authorizedSource.sha256, 'Build does not match the adjacent session collector source');
  const verifiedBuild = await verifyWindowServerBuild(build, {abortSignal, timeoutMs: readyTimeoutMs}), executable = verifiedBuild.binaryPath;
  const executableBy = performance.now() + readyTimeoutMs;
  const executableBytes = await readBounded(executable, MAX_BINARY, () => { abortSignal?.throwIfAborted(); demand(performance.now() < executableBy, 'Native executable read deadline exceeded'); }, 0o700);
  const executableIdentity = {bytes: executableBytes.length, sha256: digest(executableBytes)}; demand(executableIdentity.sha256 === verifiedBuild.binarySha256, 'Native executable pin changed'); abortSignal?.throwIfAborted();
  const retainedBuild = await retainWindowServerBuildEvidence(build, {directory: join(directory, 'build-evidence'), abortSignal, timeoutMs: readyTimeoutMs});
  demand(retainedBuild.binarySha256 === executableIdentity.sha256, 'Retained build differs from native executable');
  const buildEvidence = copy({path: 'build-evidence/manifest.json', bytes: retainedBuild.manifestBytes, sha256: retainedBuild.manifestSha256,
    sourceSha256: retainedBuild.sourceSha256, receiptSha256: retainedBuild.receiptSha256, binarySha256: retainedBuild.binarySha256});
  // Observe again after preparation. Earlier reads are not a quota or a promise
  // that another writer has left the allocation unchanged.
  const admission = await inspectSessionEvidenceBudget(budgetInputs); abortSignal?.throwIfAborted();
  demand(Buffer.compare(admission.allocationSourceBytes, preparation.allocationSourceBytes) === 0, 'Session allocation source changed during preparation');
  same(admission.admission.allocation.directoryIdentity, preparation.admission.allocation.directoryIdentity, 'Session allocation directory changed');
  same(admission.admission.directoryIdentity, preparation.admission.directoryIdentity, 'Session output directory changed during preparation');
  const admissionPin = await exclusiveJSON(join(budgetDirectory, 'admission.json'), admission.admission);
  const config = validateSessionWindowServerConfig(admission.admission.config), capacity = windowServerSessionCapacity(config.roi), maxStdout = capacity.metadataByteLimit + 65536;
  const captureDirectory = join(directory, 'capture'), configPath = join(directory, 'config.json');
  const configIdentity = await exclusiveJSON(configPath, config), stdoutPath = join(directory, 'stdout.ndjson'), stderrPath = join(directory, 'stderr.log');
  const stdoutFile = await open(stdoutPath, 'wx', 0o600); let stderrFile;
  try { stderrFile = await open(stderrPath, 'wx', 0o600); } catch (error) { await stdoutFile.close(); throw error; }
  const evidenceVolume = {kind: 'windowserver-session-evidence-reference-1', allocation: {...authority, path: 'evidence-budget/allocation-source.json'},
    preparation: {...preparationPin, path: 'evidence-budget/preparation.json'}, admission: {...admissionPin, path: 'evidence-budget/admission.json'}, finalSample: null,
    allocationIdentity: {...allocation.identity}, capacityBytes: allocation.capacityBytes,
    selectedAllocation: evidenceAllocation, selectedReservation: evidenceReservation, requestedConfig,
    requiredOuterAudit: {kind: 'evidence-volume-reference-1', allocationIdentity: {...allocation.identity}, qualification: false}, qualification: false};
  const startedAt = new Date().toISOString(), signals = [], errors = [], totals = {stdout: 0, stderr: 0};
  let child, failure, hasFailure = false, observedExit, observedClose, processIdentity = null, registration = null, captureDirectoryIdentity = null, termination, stopPromise, receiptPromise;
  let pending = Buffer.alloc(0), startupTimer, lifetimeTimer, closeResolve;
  const closed = new Promise(resolve => { closeResolve = resolve; }), failed = deferred();
  function fail(error) {
    if (hasFailure) return; hasFailure = true; failure = error; failed.resolve(); control.fail(error); void terminate();
  }
  async function signalOwned(signal) {
    if (!child?.pid || observedExit) return;
    try {
      if (processIdentity) { const current = await birth(child.pid); same(current, {pid: processIdentity.pid, pgid: processIdentity.pgid, startedAtIdentity: processIdentity.startedAtIdentity}, 'Native process identity changed before signal'); process.kill(-current.pgid, signal); }
      else child.kill(signal);
      signals.push(signal);
    } catch (error) { if (error.code !== 'ESRCH' && !observedExit) errors.push(String(error)); }
  }
  function terminate() {
    if (termination) return termination;
    termination = (async () => {
      clearTimeout(startupTimer); clearTimeout(lifetimeTimer);
      await signalOwned('SIGTERM'); await Promise.race([closed, sleep(500)]);
      if (!observedClose) { await signalOwned('SIGKILL'); await Promise.race([closed, sleep(1000)]); }
      if (!observedClose) errors.push('Native exit or stdio closure unconfirmed after bounded drain');
      child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
    })();
    return termination;
  }
  function send(record) {
    return new Promise((resolve, reject) => {
      if (hasFailure || observedExit || !child?.stdin.writable) { reject(hasFailure ? failure : Error('Native stdin unavailable')); return; }
      child.stdin.write(JSON.stringify(record) + '\n', error => error ? reject(error) : resolve());
    });
  }
  const control = createSessionWindowServerControl({config, outputDirectory: captureDirectory, send, onFailure: fail, clockTimeoutMs});
  function append(file, stream, limit, bytes) {
    const previous = totals[stream]; totals[stream] += bytes.length;
    const part = bytes.subarray(0, Math.max(0, Math.min(bytes.length, limit - previous)));
    for (let offset = 0; offset < part.length;) { const count = writeSync(file.fd, part, offset, part.length - offset); demand(count > 0, 'Native log write made no progress'); offset += count; }
    demand(totals[stream] <= limit, `Native ${stream} byte limit exceeded`);
  }
  function stdout(bytes) {
    try {
      append(stdoutFile, 'stdout', maxStdout, bytes); if (hasFailure) return;
      pending = Buffer.concat([pending, bytes]);
      for (let newline; (newline = pending.indexOf(10)) !== -1;) {
        const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
        demand(line.length > 0 && line.length <= 16384, 'Native NDJSON line bound exceeded');
        const row = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(line));
        demand(line.length + 1 <= (row?.event === 'sample' ? 4096 : row?.event === 'clock' ? 256 : 16384), 'Native record exceeds its reserved byte bound');
        control.accept(row);
      }
      demand(pending.length <= 16384, 'Native NDJSON pending line bound exceeded');
    } catch (error) { fail(error); }
  }
  const abort = () => fail(abortSignal.reason);
  async function retainProcess(outcome, manifest = null) {
    if (receiptPromise) return receiptPromise;
    receiptPromise = (async () => {
      clearTimeout(startupTimer); clearTimeout(lifetimeTimer); abortSignal?.removeEventListener('abort', abort);
      const retainBy = performance.now() + stopTimeoutMs, checkRetain = () => demand(performance.now() < retainBy, 'Native process receipt deadline exceeded');
      const sealed = await Promise.allSettled([stdoutFile, stderrFile].map(async file => { try { await file.chmod(0o400); await file.sync(); } finally { await file.close(); } }));
      const sealErrors = sealed.filter(result => result.status === 'rejected').map(result => result.reason);
      if (sealErrors.length) throw new AggregateError(sealErrors, 'Native log sealing failed');
      const stdoutBytes = await readBounded(stdoutPath, maxStdout, checkRetain), stderrBytes = await readBounded(stderrPath, MAX_STDERR, checkRetain);
      const receipt = {kind: 'windowserver-session-owned-process-2', schemaVersion: 2, qualification: false, outcome, startedAt, endedAt: new Date().toISOString(),
        runtime: {platform: platform(), arch: arch(), release: release()},
        processIdentity, registration, build: structuredClone(build), authorizedSource, buildEvidence, evidenceVolume: structuredClone(evidenceVolume), executable: {path: executable, ...executableIdentity}, command: [executable, configPath, captureDirectory],
        config: {...configIdentity, path: 'config.json'}, outputDirectory: captureDirectory, captureDirectoryIdentity, exit: observedExit ?? null, close: observedClose ?? null, requestedSignals: [...signals],
        streamBytesObserved: totals, stdout: {path: 'stdout.ndjson', bytes: stdoutBytes.length, sha256: digest(stdoutBytes)}, stderr: {path: 'stderr.log', bytes: stderrBytes.length, sha256: digest(stderrBytes)},
        failure: hasFailure ? String(failure) : null, cleanupErrors: [...errors], manifest: manifest ? {...manifest, path: 'capture/manifest.json'} : null};
      checkRetain(); const pin = await exclusiveJSON(join(directory, 'process.json'), receipt); checkRetain(); return copy({...receipt, receipt: pin});
    })(); return receiptPromise;
  }
  async function finish() {
    let timer; const finishBy = performance.now() + stopTimeoutMs;
    const check = () => { if (hasFailure) throw failure; abortSignal?.throwIfAborted(); demand(performance.now() < finishBy, 'Native stop/evidence deadline exceeded'); };
    try {
      if (hasFailure) throw failure;
      timer = setTimeout(() => fail(Error('Native stop/stdio drain deadline exceeded')), stopTimeoutMs);
      await Promise.race([control.requestStop(), failed.promise]);
      await Promise.race([closed, failed.promise]);
      if (termination) await termination; check();
      demand(observedExit?.code === 0 && observedClose?.code === 0 && observedExit.signal === null && observedClose.signal === null && pending.length === 0, 'Native process did not exit successfully with complete stdio');
      const finalSource = await readBounded(sessionSourcePath, MAX_SOURCE, check, null);
      same({bytes: finalSource.length, sha256: digest(finalSource)}, {bytes: authorizedSource.bytes, sha256: authorizedSource.sha256}, 'Adjacent session collector source changed');
      const finalBuild = await verifyWindowServerBuild(build, {abortSignal, timeoutMs: Math.min(60000, Math.max(1, Math.floor(finishBy - performance.now())))}); check(); demand(finalBuild.binarySha256 === executableIdentity.sha256, 'Native build changed during capture');
      const childInfo = await ownedDirectory(captureDirectory, 0o500);
      demand(captureDirectoryIdentity && childInfo.dev === captureDirectoryIdentity.dev && childInfo.ino === captureDirectoryIdentity.ino, 'Native output directory differs from ready admission');
      const manifestBytes = await readBounded(join(captureDirectory, 'manifest.json'), capacity.manifestByteLimit, check);
      const pin = {path: join(captureDirectory, 'manifest.json'), bytes: manifestBytes.length, sha256: digest(manifestBytes)};
      const protocol = control.snapshot();
      const capture = await verifyWindowServerSessionCapture(captureDirectory, {manifestSha256: pin.sha256, expectedConfig: config,
        expectedReady: protocol.ready, expectedStopped: protocol.stopped, processExitCode: observedExit.code,
        signal: abortSignal, timeoutMs: Math.max(1, Math.floor(finishBy - performance.now()))});
      check(); const observations = getWindowServerSessionObservations(capture);
      control.assertReplay(observations.manifest, observations.records);
      const finalDirectory = await ownedDirectory(captureDirectory, 0o500);
      demand(finalDirectory.dev === childInfo.dev && finalDirectory.ino === childInfo.ino, 'Native artifact directory replaced');
      demand(await realpath(evidenceAllocation.path) === evidenceAllocation.path, 'Session allocation path changed');
      const finalAllocation = await loadAllocation(evidenceAllocation.path); check();
      same(finalAllocation.identity, allocation.identity, 'Session allocation authority changed');
      same(finalAllocation.directoryIdentity, allocation.directoryIdentity, 'Session allocation root changed');
      const finalRoot = await ownedDirectory(finalAllocation.root, undefined, {bigint: true});
      same(Object.fromEntries(['dev', 'ino', 'uid', 'mode'].map(key => [key, String(finalRoot[key])])), admission.admission.allocation.directoryIdentity, 'Session allocation root ownership changed');
      const finalSample = await sampleVolume(finalAllocation); check();
      const finalAlarm = volumeAlarm(finalSample, finalAllocation.capacityBytes);
      const envelope = {kind: 'windowserver-session-evidence-final-sample-1', allocationIdentity: {...finalAllocation.identity},
        capacityBytes: finalAllocation.capacityBytes, sample: finalSample, alarm: finalAlarm};
      demand(Buffer.byteLength(JSON.stringify(envelope, null, 2) + '\n') <= MAX_FINAL_SAMPLE, 'Session final sample byte limit exceeded');
      const finalSamplePin = await exclusiveJSON(join(budgetDirectory, 'final-sample.json'), envelope);
      evidenceVolume.finalSample = {...finalSamplePin, path: 'evidence-budget/final-sample.json'};
      if (finalAlarm.status !== 'PASS') throw Object.assign(Error('Native session evidence volume did not remain available'), {evidenceVolumeStatus: finalAlarm.status});
      check(); clearTimeout(timer);
      const retained = await retainProcess('CAPTURE_REPLAYED', pin);
      abortSignal?.throwIfAborted(); if (hasFailure) throw failure;
      return Object.freeze({capture, manifest: copy(pin), process: retained});
    } catch (error) {
      fail(error);
      try { await terminate(); } catch (cleanupError) { errors.push(String(cleanupError)); }
      let retained;
      try { retained = await retainProcess('FAILED'); } catch (retentionError) { errors.push(String(retentionError)); }
      // Preserve the first thrown value, including null, primitives, and frozen
      // abort reasons. The immutable process receipt remains the diagnostic channel
      // when the original value cannot accept a best-effort attachment.
      try {
        if (failure instanceof Error && Object.isExtensible(failure)) Object.defineProperty(failure, 'windowServerProcess', {value: retained ?? {outputDirectory: directory, failure: String(failure), cleanupErrors: [...errors]}, configurable: true});
      } catch {}
      throw failure;
    } finally { clearTimeout(timer); }
  }
  function stop() { return stopPromise ??= finish(); }
  try {
    abortSignal?.throwIfAborted();
    child = spawn(executable, [configPath, captureDirectory], {cwd: directory, env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C'}, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
    child.stdout.on('data', stdout); child.stderr.on('data', bytes => { try { append(stderrFile, 'stderr', MAX_STDERR, bytes); } catch (error) { fail(error); } });
    child.stdin.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail); child.once('error', fail);
    child.once('exit', (code, signal) => { observedExit = {code, signal}; });
    child.once('close', (code, signal) => {
      observedClose = {code, signal}; closeResolve();
      if (pending.length || !control.snapshot().stopped || code !== 0 || signal) fail(Error('Native child closed without a complete successful protocol'));
    });
    startupTimer = setTimeout(() => fail(Error('Native ready deadline exceeded')), readyTimeoutMs);
    lifetimeTimer = setTimeout(() => fail(Error('Native lifetime deadline exceeded')), readyTimeoutMs + capacity.durationMs + stopTimeoutMs);
    abortSignal?.addEventListener('abort', abort, {once: true}); if (abortSignal?.aborted) abort();
    processIdentity = copy({kind: 'windowserver', ...await birth(child.pid), executable, ownerPid: process.pid});
    if (processRecordDirectory !== undefined) registration = await exclusiveJSON(join(processRecordDirectory, `owned-process-${child.pid}-${randomUUID()}.json`),
      {kind: 'perf-owned-processes-1', ownerPid: process.pid, processes: [{kind: 'windowserver', pid: processIdentity.pid, pgid: processIdentity.pgid, startedAtIdentity: processIdentity.startedAtIdentity, executable}]});
    const ready = await control.ready;
    const admittedDirectory = await ownedDirectory(captureDirectory);
    demand([0o700, 0o500].includes(admittedDirectory.mode & 0o777), 'Native capture directory mode differs');
    captureDirectoryIdentity = copy({dev: admittedDirectory.dev, ino: admittedDirectory.ino});
    clearTimeout(startupTimer); if (hasFailure) throw failure;
    return Object.freeze({ready, config, processIdentity, captureClock: control.captureClock, stop});
  } catch (error) { fail(error); return stop(); }
}
