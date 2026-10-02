import {spawn, execFile} from 'node:child_process';
import {promisify, isDeepStrictEqual} from 'node:util';
import {constants, writeSync} from 'node:fs';
import {open, mkdir, lstat, realpath, readdir} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {platform, arch, release} from 'node:os';
import {verifyWindowServerBuild, retainWindowServerBuildEvidence} from '../native/windowserver-build.mjs';
import {validateWindowServerReady, verifyWindowServerCapture} from './windowserver-presentation.mjs';

const exec = promisify(execFile), MAX_METADATA = 8 * 1024 ** 2, MAX_MANIFEST = 2 * 1024 ** 2;
const MAX_STDOUT = MAX_METADATA + 65536, MAX_STDERR = 1024 ** 2, MAX_BINARY = 64 * 1024 ** 2;
const NORMAL = new Set(['requested-stop', 'stdin-eof', 'duration-limit', 'frame-limit', 'pixel-byte-limit']);
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

export function validateWindowServerConfig(value) {
  keys(value, ['schemaVersion', 'displayID', 'expectedBrowserPid', 'roi', 'durationMs', 'maxFrames', 'maxBytes'], 'native config');
  integer(value.schemaVersion, 1, 1, 'native schema'); integer(value.displayID, 1, 0xffffffff, 'display ID');
  integer(value.expectedBrowserPid, 1, 0x7fffffff, 'owned browser PID');
  keys(value.roi, ['x', 'y', 'width', 'height'], 'ROI');
  for (const name of ['x', 'y']) integer(value.roi[name], 0, 32768, 'ROI ' + name);
  for (const name of ['width', 'height']) integer(value.roi[name], 1, 32768, 'ROI ' + name);
  integer(value.durationMs, 1, 75000, 'capture duration'); integer(value.maxFrames, 1, 5000, 'frame limit');
  integer(value.maxBytes, 1, 256 * 1024 ** 2, 'pixel byte limit');
  demand(value.roi.width * value.roi.height * 4 <= value.maxBytes, 'ROI exceeds pixel budget');
  return copy(value);
}

/** Bounded protocol state, exposed for pure tests. This produces provisional
 * observations only; it cannot manufacture the private byte-replay token. */
export function createWindowServerControl({config: supplied, outputDirectory, send, onFailure = () => {}, clockTimeoutMs = 2000}) {
  const config = validateWindowServerConfig(supplied); deadline(clockTimeoutMs, 'clock deadline');
  demand(typeof send === 'function' && typeof onFailure === 'function' && isAbsolute(outputDirectory), 'Invalid native control owner');
  const admitted = deferred(), ids = new Set(), awaitingAck = new Set(), clocks = new Map(), pixelWaiters = new Set(), records = [];
  let ready = null, stopped = null, failure = null, stopRequested = false, lastOrdinal = 0;
  function rejectPending(error) {
    for (const waiter of clocks.values()) { clearTimeout(waiter.timer); waiter.reject(error); } clocks.clear();
    for (const waiter of pixelWaiters) { clearTimeout(waiter.timer); waiter.reject(error); } pixelWaiters.clear();
  }
  function fail(error) {
    if (failure) return; failure = error instanceof Error ? error : Error(String(error));
    admitted.reject(failure); rejectPending(failure); onFailure(failure);
  }
  function active() { if (failure) throw failure; demand(ready && !stopped && !stopRequested, 'Native control is not active'); }
  function sample(row) {
    demand(row?.schemaVersion === 1 && row.event === 'sample' && row.retained === true && row.status === 'complete' && row.statusRaw === 0,
      'Stdout sample is not retained and complete');
    integer(row.ordinal, 1, config.maxFrames, 'sample ordinal');
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
  function match(hash, minimum) { return ready && records.find(row => row.event === 'sample' && row.sha256 === hash && ticks(row.displayTimeMach) >= minimum); }
  function settlePixels() {
    for (const waiter of pixelWaiters) { const row = match(waiter.hash, waiter.minimum); if (!row) continue;
      clearTimeout(waiter.timer); pixelWaiters.delete(waiter); waiter.resolve(copy({sample: row, authenticated: false})); }
  }
  function accept(row) {
    if (failure) throw failure;
    try {
      demand(object(row) && !stopped, 'Native output after stopped or invalid record');
      if (row.event === 'ready') {
        demand(!ready, 'Duplicate native ready');
        ready = copy(validateWindowServerReady(row, {config, outputDirectory}));
        for (const previous of records) if (previous.event === 'sample') sample(previous);
        admitted.resolve(ready); settlePixels(); return;
      }
      if (row.event === 'stopped') {
        keys(row, ['schemaVersion', 'event', 'terminalReason', 'endedMach', 'manifest'], 'native stopped');
        demand(ready && row.schemaVersion === 1 && row.manifest === 'manifest.json' && NORMAL.has(row.terminalReason) && ticks(row.endedMach) >= ticks(ready.startedMach), 'Invalid native stopped');
        stopped = copy(row); rejectPending(Error('Native capture ended before the pending observation')); return;
      }
      demand(records.length < config.maxFrames + 256, 'Native control record limit');
      if (row.event === 'sample') {
        sample(row); demand(row.ordinal > lastOrdinal, 'Duplicate or reversed sample ordinal'); lastOrdinal = row.ordinal;
        records.push(copy(row)); settlePixels(); return;
      }
      keys(row, ['schemaVersion', 'event', 'id', 'mach'], 'native clock ACK');
      demand(ready && row.schemaVersion === 1 && row.event === 'clock' && awaitingAck.has(row.id), 'Unsolicited native clock ACK');
      demand(ticks(row.mach) >= ticks(ready.startedMach), 'Native ACK predates capture');
      awaitingAck.delete(row.id); const waiter = clocks.get(row.id); clocks.delete(row.id); records.push(copy(row));
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(copy(row)); }
    } catch (error) { fail(error); throw error; }
  }
  function captureClock(id) {
    try {
      active(); demand(typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && !ids.has(id) && ids.size < 256, 'Invalid or repeated native clock ID'); ids.add(id);
      const pending = deferred(); pending.timer = setTimeout(() => fail(Error('Native clock deadline exceeded')), clockTimeoutMs); clocks.set(id, pending);
      Promise.resolve().then(() => {
        if (failure || stopped || stopRequested || clocks.get(id) !== pending) return;
        awaitingAck.add(id); return send({command: 'clock', id});
      }).catch(fail); return pending.promise;
    } catch (error) { fail(error); return Promise.reject(error); }
  }
  function waitForPixelHash(hash, options = {}) {
    try {
      demand(object(options) && Object.keys(options).every(key => ['timeoutMs', 'minimumDisplayTimeMach'].includes(key)), 'Unexpected pixel wait options');
      active(); demand(sha(hash), 'Invalid expected pixel hash');
      const timeoutMs = deadline(options.timeoutMs ?? 5000, 'pixel wait deadline', 75000), minimum = options.minimumDisplayTimeMach === undefined ? 0n : ticks(options.minimumDisplayTimeMach);
      const row = match(hash, minimum); if (row) return Promise.resolve(copy({sample: row, authenticated: false}));
      const pending = deferred(); Object.assign(pending, {hash, minimum, timer: setTimeout(() => fail(Error('Native pixel observation deadline exceeded')), timeoutMs)});
      pixelWaiters.add(pending); return pending.promise;
    } catch (error) { fail(error); return Promise.reject(error); }
  }
  async function requestStop() {
    if (failure) throw failure; if (stopped || stopRequested) return;
    demand(ready, 'Cannot request native stop before ready'); stopRequested = true;
    rejectPending(Error('Native stop requested')); try { await send({command: 'stop'}); } catch (error) { fail(error); throw error; }
  }
  function assertReplay(manifest, retained) {
    if (failure) throw failure; demand(ready && stopped, 'Native ready/stopped pair missing');
    for (const name of ['config', 'display', 'captureGeometry', 'windowAdmission', 'timebase', 'startedMach']) same(manifest[name], ready[name], 'Native manifest differs from ready: ' + name);
    same(manifest.endedMach, stopped.endedMach, 'Native ended clock differs'); same(manifest.terminalReason, stopped.terminalReason, 'Native terminal reason differs');
    if (stopRequested) demand(stopped.terminalReason === 'requested-stop', 'Explicit stop did not finish as requested');
    same(retained.filter(row => row.event === 'clock' || row.event === 'sample' && row.retained === true), records, 'Stdout observations differ from retained native records');
  }
  return Object.freeze({ready: admitted.promise, accept, captureClock, waitForPixelHash, requestStop, fail, assertReplay,
    snapshot: () => copy({ready, stopped, records, stopRequested, failure: failure ? String(failure) : null})});
}

async function ownedDirectory(path, mode) {
  demand(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && await realpath(path) === path, 'Directory must be absolute and canonical');
  const info = await lstat(path); demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (mode === undefined || (info.mode & 0o777) === mode), 'Unsafe owned directory');
  return info;
}
async function readBounded(path, maximum, check, mode = 0o400) {
  check();
  demand(await realpath(dirname(path)) === dirname(path), 'Artifact parent is linked');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    demand(before.isFile() && before.nlink === 1 && before.uid === process.getuid() && (before.mode & 0o777) === mode && before.size >= 0 && before.size <= maximum, 'Unsafe or oversized native artifact');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { check(); const read = await file.read(bytes, offset, Math.min(bytes.length - offset, 1024 ** 2), offset); demand(read.bytesRead > 0, 'Native artifact truncated'); offset += read.bytesRead; }
    const tail = await file.read(Buffer.alloc(1), 0, 1, offset), after = await file.stat(), current = await lstat(path);
    demand(tail.bytesRead === 0 && current.isFile() && current.dev === before.dev && current.ino === before.ino &&
      [after, current].every(value => value.size === before.size && value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs && value.nlink === 1), 'Native artifact changed while reading');
    check(); return bytes;
  } finally { await file.close(); }
}
async function exclusiveJSON(path, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'), file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.chmod(0o400); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  return {path, bytes: bytes.length, sha256: digest(bytes)};
}
async function birth(pid) {
  const {stdout} = await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart='], {timeout: 1000, maxBuffer: 4096, env: {PATH: '/usr/bin:/bin', LANG: 'C'}});
  const match = /^\s*(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(stdout);
  demand(match && Number(match[1]) === pid && Number(match[2]) === pid, 'Native owned process birth/group unavailable');
  return {pid, pgid: Number(match[2]), startedAtIdentity: match[3]};
}

/** Explicit pinned executable only. This function never compiles, installs,
 * discovers a compiler, requests permission, or accepts a qualification flag. */
export async function startWindowServerCapture(options) {
  demand(object(options) && Object.keys(options).every(key => ['build', 'config', 'directory', 'abortSignal', 'readyTimeoutMs', 'clockTimeoutMs', 'stopTimeoutMs', 'processRecordDirectory'].includes(key)), 'Unexpected native supervisor options');
  demand(process.platform !== 'win32', 'Native supervisor requires POSIX ownership');
  const {build: suppliedBuild, abortSignal, directory, processRecordDirectory} = options, config = validateWindowServerConfig(options.config);
  keys(suppliedBuild, ['receiptPath', 'receiptSha256', 'sourceSha256'], 'native build pin'); const build = copy(suppliedBuild);
  const readyTimeoutMs = deadline(options.readyTimeoutMs ?? 10000, 'ready deadline'), stopTimeoutMs = deadline(options.stopTimeoutMs ?? 7000, 'stop deadline');
  const clockTimeoutMs = deadline(options.clockTimeoutMs ?? 2000, 'clock deadline'); abortSignal?.throwIfAborted();
  const verifiedBuild = await verifyWindowServerBuild(build, {abortSignal, timeoutMs: readyTimeoutMs}), executable = verifiedBuild.binaryPath;
  const executableBy = performance.now() + readyTimeoutMs;
  const executableBytes = await readBounded(executable, MAX_BINARY, () => { abortSignal?.throwIfAborted(); demand(performance.now() < executableBy, 'Native executable read deadline exceeded'); }, 0o700);
  const executableIdentity = {bytes: executableBytes.length, sha256: digest(executableBytes)}; demand(executableIdentity.sha256 === verifiedBuild.binarySha256, 'Native executable pin changed'); abortSignal?.throwIfAborted();
  demand(typeof directory === 'string' && isAbsolute(directory) && resolve(directory) === directory, 'Native output must be absolute and normalized');
  await ownedDirectory(dirname(directory)); if (processRecordDirectory !== undefined) await ownedDirectory(processRecordDirectory);
  await mkdir(directory, {mode: 0o700}); await ownedDirectory(directory, 0o700);
  // Each transaction carries the exact bounded build closure needed after
  // relocation. Historical absolute build paths never become replay read paths.
  const retainedBuild = await retainWindowServerBuildEvidence(build, {directory: join(directory, 'build-evidence'), abortSignal, timeoutMs: readyTimeoutMs});
  demand(retainedBuild.binarySha256 === executableIdentity.sha256, 'Retained build differs from native executable');
  const buildEvidence = copy({path: 'build-evidence/manifest.json', bytes: retainedBuild.manifestBytes, sha256: retainedBuild.manifestSha256,
    sourceSha256: retainedBuild.sourceSha256, receiptSha256: retainedBuild.receiptSha256, binarySha256: retainedBuild.binarySha256});
  const captureDirectory = join(directory, 'capture'), configPath = join(directory, 'config.json');
  const configIdentity = await exclusiveJSON(configPath, config), stdoutPath = join(directory, 'stdout.ndjson'), stderrPath = join(directory, 'stderr.log');
  const stdoutFile = await open(stdoutPath, 'wx', 0o600); let stderrFile;
  try { stderrFile = await open(stderrPath, 'wx', 0o600); } catch (error) { await stdoutFile.close(); throw error; }
  const startedAt = new Date().toISOString(), signals = [], errors = [], totals = {stdout: 0, stderr: 0};
  let child, failure, observedExit, observedClose, processIdentity = null, registration = null, captureDirectoryIdentity = null, termination, stopPromise, receiptPromise;
  let pending = Buffer.alloc(0), startupTimer, lifetimeTimer, closeResolve;
  const closed = new Promise(resolve => { closeResolve = resolve; }), failed = deferred();
  function fail(error) { failure ??= error instanceof Error ? error : Error(String(error)); failed.resolve(); control.fail(failure); void terminate(); }
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
      if (failure || observedExit || !child?.stdin.writable) { reject(failure ?? Error('Native stdin unavailable')); return; }
      child.stdin.write(JSON.stringify(record) + '\n', error => error ? reject(error) : resolve());
    });
  }
  const control = createWindowServerControl({config, outputDirectory: captureDirectory, send, onFailure: error => { failure ??= error; failed.resolve(); void terminate(); }, clockTimeoutMs});
  function append(file, stream, limit, bytes) {
    const previous = totals[stream]; totals[stream] += bytes.length;
    const part = bytes.subarray(0, Math.max(0, Math.min(bytes.length, limit - previous)));
    for (let offset = 0; offset < part.length;) { const count = writeSync(file.fd, part, offset, part.length - offset); demand(count > 0, 'Native log write made no progress'); offset += count; }
    demand(totals[stream] <= limit, `Native ${stream} byte limit exceeded`);
  }
  function stdout(bytes) {
    try {
      append(stdoutFile, 'stdout', MAX_STDOUT, bytes); if (failure) return;
      pending = Buffer.concat([pending, bytes]);
      for (let newline; (newline = pending.indexOf(10)) !== -1;) {
        const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
        demand(line.length > 0 && line.length <= 16384, 'Native NDJSON line bound exceeded');
        control.accept(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(line)));
      }
      demand(pending.length <= 16384, 'Native NDJSON pending line bound exceeded');
    } catch (error) { fail(error); }
  }
  const abort = () => fail(Error('Native capture aborted: ' + String(abortSignal.reason ?? 'aborted')));
  async function retainProcess(outcome, manifest = null) {
    if (receiptPromise) return receiptPromise;
    receiptPromise = (async () => {
      clearTimeout(startupTimer); clearTimeout(lifetimeTimer); abortSignal?.removeEventListener('abort', abort);
      const retainBy = performance.now() + stopTimeoutMs, checkRetain = () => demand(performance.now() < retainBy, 'Native process receipt deadline exceeded');
      const sealed = await Promise.allSettled([stdoutFile, stderrFile].map(async file => { try { await file.chmod(0o400); await file.sync(); } finally { await file.close(); } }));
      const sealErrors = sealed.filter(result => result.status === 'rejected').map(result => result.reason);
      if (sealErrors.length) throw new AggregateError(sealErrors, 'Native log sealing failed');
      const stdoutBytes = await readBounded(stdoutPath, MAX_STDOUT, checkRetain), stderrBytes = await readBounded(stderrPath, MAX_STDERR, checkRetain);
      const receipt = {kind: 'windowserver-owned-process-1', schemaVersion: 1, qualification: false, outcome, startedAt, endedAt: new Date().toISOString(),
        runtime: {platform: platform(), arch: arch(), release: release()},
        processIdentity, registration, build: structuredClone(build), buildEvidence, executable: {path: executable, ...executableIdentity}, command: [executable, configPath, captureDirectory],
        config: {...configIdentity, path: 'config.json'}, outputDirectory: captureDirectory, captureDirectoryIdentity, exit: observedExit ?? null, close: observedClose ?? null, requestedSignals: [...signals],
        streamBytesObserved: totals, stdout: {path: 'stdout.ndjson', bytes: stdoutBytes.length, sha256: digest(stdoutBytes)}, stderr: {path: 'stderr.log', bytes: stderrBytes.length, sha256: digest(stderrBytes)},
        failure: failure ? String(failure) : null, cleanupErrors: [...errors], manifest: manifest ? {...manifest, path: 'capture/manifest.json'} : null};
      checkRetain(); const pin = await exclusiveJSON(join(directory, 'process.json'), receipt); checkRetain(); return copy({...receipt, receipt: pin});
    })(); return receiptPromise;
  }
  async function finish() {
    let timer; const finishBy = performance.now() + stopTimeoutMs;
    const check = () => { if (failure) throw failure; abortSignal?.throwIfAborted(); demand(performance.now() < finishBy, 'Native stop/evidence deadline exceeded'); };
    try {
      if (failure) throw failure;
      timer = setTimeout(() => fail(Error('Native stop/stdio drain deadline exceeded')), stopTimeoutMs);
      await Promise.race([control.requestStop(), failed.promise]);
      await Promise.race([closed, failed.promise]);
      if (termination) await termination; check();
      demand(observedExit?.code === 0 && observedClose?.code === 0 && observedExit.signal === null && observedClose.signal === null && pending.length === 0, 'Native process did not exit successfully with complete stdio');
      const finalBuild = await verifyWindowServerBuild(build, {abortSignal, timeoutMs: Math.max(1, Math.floor(finishBy - performance.now()))}); check(); demand(finalBuild.binarySha256 === executableIdentity.sha256, 'Native build changed during capture');
      const childInfo = await ownedDirectory(captureDirectory, 0o500), names = (await readdir(captureDirectory)).sort();
      demand(captureDirectoryIdentity && childInfo.dev === captureDirectoryIdentity.dev && childInfo.ino === captureDirectoryIdentity.ino, 'Native output directory differs from ready admission');
      const manifestBytes = await readBounded(join(captureDirectory, 'manifest.json'), MAX_MANIFEST, check);
      const manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(manifestBytes));
      demand(Array.isArray(manifest.pixelFiles) && manifest.pixelFiles.length <= config.maxFrames, 'Invalid retained pixel list');
      same(names, ['frames.ndjson', 'manifest.json', ...manifest.pixelFiles.map(row => row.path)].sort(), 'Native artifact directory membership differs');
      const framesBytes = await readBounded(join(captureDirectory, 'frames.ndjson'), MAX_METADATA, check);
      const framesText = new TextDecoder('utf-8', {fatal: true}).decode(framesBytes);
      demand(framesText.endsWith('\n'), 'Native metadata tail incomplete');
      const lines = framesText.slice(0, -1).split('\n'); demand(lines.length <= config.maxFrames + 256, 'Native frame record bound exceeded');
      const records = lines.map(line => { demand(Buffer.byteLength(line) <= 16384, 'Native retained record too large'); return JSON.parse(line); });
      const pixels = new Map(); let total = 0;
      for (const row of manifest.pixelFiles) {
        demand(/^frame-[1-9][0-9]{0,4}\.bgra$/.test(row?.path ?? '') && !pixels.has(row.path) && row.bytes === config.roi.width * config.roi.height * 4, 'Unsafe native pixel member');
        total += row.bytes; demand(total <= config.maxBytes, 'Retained pixels exceed configured budget'); pixels.set(row.path, await readBounded(join(captureDirectory, row.path), row.bytes, check));
      }
      control.assertReplay(manifest, records);
      const pin = {path: join(captureDirectory, 'manifest.json'), bytes: manifestBytes.length, sha256: digest(manifestBytes)};
      const capture = verifyWindowServerCapture({manifestBytes, framesBytes, pixels}, {manifestSha256: pin.sha256});
      const finalDirectory = await ownedDirectory(captureDirectory, 0o500); demand(finalDirectory.dev === childInfo.dev && finalDirectory.ino === childInfo.ino, 'Native artifact directory replaced');
      same((await readdir(captureDirectory)).sort(), names, 'Native artifact membership changed during replay');
      check(); clearTimeout(timer);
      const retained = await retainProcess('CAPTURE_REPLAYED', pin);
      abortSignal?.throwIfAborted(); if (failure) throw failure;
      return Object.freeze({capture, manifest: copy(pin), process: retained});
    } catch (error) {
      fail(error); await terminate(); let retained;
      try { retained = await retainProcess('FAILED'); } catch (retentionError) { errors.push(String(retentionError)); }
      const reported = Error(String(failure ?? error)); reported.windowServerProcess = retained ?? {outputDirectory: directory, failure: String(failure ?? error), cleanupErrors: errors}; throw reported;
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
    lifetimeTimer = setTimeout(() => fail(Error('Native lifetime deadline exceeded')), readyTimeoutMs + config.durationMs + stopTimeoutMs);
    abortSignal?.addEventListener('abort', abort, {once: true}); if (abortSignal?.aborted) abort();
    processIdentity = copy({kind: 'windowserver', ...await birth(child.pid), executable, ownerPid: process.pid});
    if (processRecordDirectory !== undefined) registration = await exclusiveJSON(join(processRecordDirectory, `owned-process-${child.pid}-${randomUUID()}.json`),
      {kind: 'perf-owned-processes-1', ownerPid: process.pid, processes: [{kind: 'windowserver', pid: processIdentity.pid, pgid: processIdentity.pgid, startedAtIdentity: processIdentity.startedAtIdentity, executable}]});
    const ready = await control.ready;
    const admittedDirectory = await ownedDirectory(captureDirectory);
    demand([0o700, 0o500].includes(admittedDirectory.mode & 0o777), 'Native capture directory mode differs');
    captureDirectoryIdentity = copy({dev: admittedDirectory.dev, ino: admittedDirectory.ino});
    clearTimeout(startupTimer); if (failure) throw failure;
    return Object.freeze({ready, processIdentity, captureClock: control.captureClock, waitForPixelHash: control.waitForPixelHash, stop});
  } catch (error) { fail(error); return stop(); }
}
