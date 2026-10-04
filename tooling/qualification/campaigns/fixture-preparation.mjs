// Explicit fixture preparation accounting. Importing this module launches nothing.
import { mkdir, open, lstat, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startEvidenceMonitor, loadAllocation, evidenceDestination, retainEvidenceAudit, verifyEvidenceAudit, readEvidenceJSON } from '../evidence-volume.mjs';
import { sourceIdentityAsync, executionEnvironment } from '../core.mjs';
import { treeIdentityAsync } from '../development-cache.mjs';
import { boundedChild } from '../container/bounded-child.mjs';
import { createGateLog } from '../container/gate-log.mjs';
import { acquireTimingLock, timingLockDirectory } from './host.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GRACE_MS = 5000, MAX_MS = 12 * 60 * 60 * 1000;
const json = value => JSON.stringify(value, null, 2) + '\n';
const failure = (stage, error) => ({stage, message: String(error?.message ?? error)});
const usableIdentity = value => /^[a-f0-9]{64}$/.test(value?.digest ?? '') && Array.isArray(value.files) && value.files.length > 0;
const observedClose = child => !!child && (child.exitObserved === true || (!child.timedOut && !child.interrupted && Number.isInteger(child.code)));
const outcome = (...values) => values.includes('FAIL') ? 'FAIL' : values.every(value => value === 'PASS') ? 'PASS' : 'INCONCLUSIVE';

// Output and subject are issued by this parent, never passed through from argv.
export function preparationArguments(args) {
  if (!Array.isArray(args) || !['prepare', 'prepare-seed'].includes(args[0])) throw Error('Select prepare or prepare-seed');
  const allowed = new Set(args[0] === 'prepare-seed' ? ['--official-adapter'] : ['--workload', '--font-corpus', '--official-adapter', '--seed', '--closure-bytes']);
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw Error('Duplicate preparation argument');
    seen.add(key);
    if (key === '--allow-heavy') continue;
    if (!allowed.has(key) || typeof args[++i] !== 'string' || !args[i] || args[i].startsWith('--') || /[\x00-\x1f\x7f]/.test(args[i])) throw Error('Invalid preparation argument');
  }
  if (!seen.has('--allow-heavy')) throw Error('Explicit --allow-heavy is required');
  return [...args];
}

export function preparationGuardArguments(repo, command, inherited = process.execArgv) {
  const guards = new Set(), known = ['tests/session/no-egress.mjs', 'tests/store/no-network.mjs'].map(p => join(repo, p));
  for (let i = 0; i < inherited.length; i++) {
    const arg = inherited[i];
    if (arg === '--require' || arg.startsWith('-r') || arg.startsWith('--require=')) throw Error('Unsupported inherited preparation preload');
    if (arg !== '--import' && !arg.startsWith('--import=')) continue;
    const value = arg === '--import' ? inherited[++i] : arg.slice(9);
    if (typeof value !== 'string') throw Error('Missing inherited preload');
    const path = value.startsWith('file:') ? fileURLToPath(value) : resolve(repo, value);
    if (!known.includes(path)) throw Error('Unsupported inherited preparation preload');
    guards.add(path);
  }
  if (command === 'prepare-seed' && guards.has(known[1])) throw Error('Seed loopback cannot weaken inherited no-network guard');
  guards.add(known[command === 'prepare-seed' ? 0 : 1]);
  return [...guards].flatMap(path => ['--import', path]);
}

/** Dependencies are explicit only to test lifecycle ordering without preparing
 * product fixtures. The public CLI supplies none of them. */
export async function runFixturePreparation({repo = REPO, output, timeoutMs, args, environment = process.env,
  execArgv = process.execArgv, signal} = {}, {
  monitorFactory = startEvidenceMonitor, auditRetainer = retainEvidenceAudit, auditVerifier = verifyEvidenceAudit,
  childRunner = boundedChild, sourceProvider = sourceIdentityAsync, finalizationWriter = writeFile,
  dependencyProvider = root => treeIdentityAsync(join(root, 'node_modules')),
  hostLeaseProvider = async id => acquireTimingLock(await timingLockDirectory(), {receiptId: id}),
} = {}) {
  args = preparationArguments(args);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= GRACE_MS || timeoutMs > MAX_MS) throw Error('Preparation timeout must exceed 5000ms and be at most12hours');
  repo = await realpath(repo);
  if (!isAbsolute(output ?? '') || output !== resolve(output) || !output.startsWith(join(repo, 'artifacts') + sep)) throw Error('Preparation requires a canonical absolute new artifact output');
  const guardArgs = preparationGuardArguments(repo, args[0], execArgv);
  const allocation = await loadAllocation(environment.IE_EVIDENCE_ALLOCATION);
  await evidenceDestination(allocation.root, output, {directory: true});
  const existing = await lstat(output).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
  if (existing) throw Error('Preparation output already exists');
  signal?.throwIfAborted();
  await mkdir(dirname(output), {recursive: true, mode: 0o700});
  await evidenceDestination(allocation.root, output, {directory: true});
  await mkdir(output, {mode: 0o700});
  await evidenceDestination(allocation.root, output, {directory: true, mustExist: true});
  const prepared = join(output, 'prepared'), temp = join(output, 'tmp'), receiptPath = join(output, 'receipt.json');
  const id = 'fixture-preparation-' + randomUUID(), start = performance.now();
  const controller = new AbortController(), relay = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', relay, {once: true}); if (signal?.aborted) relay();
  const onInterrupt = () => controller.abort('SIGINT'), onTerminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  const receipt = {kind: 'fixture-preparation-run-1', id, qualification: false, output, prepared,
    startedAt: new Date().toISOString(), timeoutMs, graceMs: GRACE_MS, producerCommand: args[0], rawOutcome: 'INCONCLUSIVE',
    allocation: {path: environment.IE_EVIDENCE_ALLOCATION, root: allocation.root, identity: allocation.identity, directoryIdentity: allocation.directoryIdentity},
    before: null, after: null, dependenciesBefore: null, dependenciesAfter: null, sourceStable: false, dependenciesUnchanged: false,
    producer: null, descriptor: null, evidenceStorage: null, errors: []};
  const lockPath = join(repo, 'artifacts/qualification/active.lock');
  let lock, lockInfo, lease, monitor, log, initialAlarm, storageAlarm, saved = false, audit, verified, retained = false;
  let leaseReleased = false, checkoutReleased = false, producerStarted = false, exclusionRetained = false;
  const lifecycleErrors = [];
  const report = (stage, error) => lifecycleErrors.push(failure(stage, error));
  try {
    await mkdir(dirname(lockPath), {recursive: true, mode: 0o700});
    lock = await open(lockPath, 'wx', 0o600); lockInfo = await lock.stat();
    await lock.writeFile(json({kind: 'fixture-preparation', pid: process.pid, id, output}));
    lease = await hostLeaseProvider(id);
    receipt.hostExclusion = {path: lease.path, identity: lease.identity};
    monitor = await monitorFactory({allocationPath: environment.IE_EVIDENCE_ALLOCATION, output, campaignId: id,
      allowUnavailable: false, onAlarm(alarm) {
        initialAlarm ??= {...alarm};
        if (alarm.status !== 'PASS' || !['normal', 'target'].includes(alarm.level)) {
          storageAlarm ??= {status: alarm.status, level: alarm.level, percent: alarm.percent};
          controller.abort('Preparation evidence storage unavailable or at ceiling');
        }
      }});
    receipt.evidenceStorage = monitor.reference;
    if (monitor.reference.root !== allocation.root || monitor.reference.allocationIdentity?.bytes !== allocation.identity.bytes ||
        monitor.reference.allocationIdentity?.sha256 !== allocation.identity.sha256) throw Error('Preparation allocation changed before monitor admission');
    if (initialAlarm?.status !== 'PASS' || !['normal', 'target'].includes(initialAlarm.level)) throw Error('Initial preparation storage observation refused');
    controller.signal.throwIfAborted();
    receipt.before = await sourceProvider(repo);
    receipt.dependenciesBefore = await dependencyProvider(repo);
    if (!usableIdentity(receipt.before) || !usableIdentity(receipt.dependenciesBefore)) throw Error('Preparation requires existing usable source and installed dependency identities');
    controller.signal.throwIfAborted();
    await mkdir(temp, {mode: 0o700});
    log = createGateLog(join(output, 'preparation.log'), controller.signal);
    const childEnvironment = {...executionEnvironment(environment, dirname(process.execPath), output), TMPDIR: temp, TMP: temp, TEMP: temp};
    const remaining = Math.floor(timeoutMs - (performance.now() - start) - GRACE_MS);
    if (remaining < 1) throw Error('Preparation deadline elapsed before child launch');
    producerStarted = true;
    receipt.producer = await childRunner(process.execPath, [...guardArgs, join(repo, 'tooling/qualification/campaigns/fixtures-run.mjs'),
      ...args, '--repo', repo, '--output', prepared], {cwd: repo, env: childEnvironment, timeoutMs: remaining, graceMs: GRACE_MS,
      abortSignal: log.signal, onStdout: bytes => log.append(bytes), onStderr: bytes => log.append(bytes)});
    log.close(); if (log.error) throw log.error;
    const child = receipt.producer;
    receipt.rawOutcome = child.code === 0 && !child.signal && !child.timedOut && !child.interrupted && !controller.signal.aborted ? 'PASS' : 'FAIL';
    if (receipt.rawOutcome === 'PASS') {
      const path = join(prepared, args[0] === 'prepare-seed' ? 'seed.json' : 'fixture-input.json');
      const descriptor = await readEvidenceJSON(path, {withIdentity: true});
      receipt.descriptor = {path, ...descriptor.identity};
    }
  } catch (error) {
    receipt.errors.push(failure('preparation', error)); receipt.rawOutcome = 'FAIL';
  } finally {
    try {log?.close(); if (log?.error) report('log-close', log.error);} catch (error) {report('log-close', error);}
    try {if (receipt.before) receipt.after = await sourceProvider(repo);} catch (error) {report('source-after', error);}
    try {if (receipt.dependenciesBefore) receipt.dependenciesAfter = await dependencyProvider(repo);} catch (error) {report('dependencies-after', error);}
    receipt.sourceStable = !!receipt.before && receipt.before.digest === receipt.after?.digest;
    receipt.dependenciesUnchanged = !!receipt.dependenciesBefore && receipt.dependenciesBefore.digest === receipt.dependenciesAfter?.digest;
    receipt.storageAlarm = storageAlarm ?? null; receipt.interrupted = controller.signal.aborted; receipt.finalizationErrors = [...lifecycleErrors];
    receipt.endedAt = new Date().toISOString(); receipt.elapsedMs = performance.now() - start;
    try {await writeFile(receiptPath, json(receipt), {flag: 'wx', mode: 0o600}); saved = true;} catch (error) {report('receipt-save', error);}
    try {
      if (monitor) {
        try {audit = await monitor.finish({receiptPath: saved ? receiptPath : null, outcome: receipt.rawOutcome});} catch (error) {report('audit-finish', error);}
        try {await auditRetainer(monitor.reference, output); retained = true;} catch (error) {report('audit-retain', error);}
        if (saved && retained) try {verified = await auditVerifier(monitor.reference, receiptPath);} catch (error) {report('audit-verify', error);}
      }
    } finally {
      const closureKnown = !producerStarted || observedClose(receipt.producer);
      if (!closureKnown) {
        exclusionRetained = true;
        report('producer-closure', Error('Producer close unobserved; owned host and checkout exclusions retained for inspection'));
      }
      if (closureKnown) try {if (lease) {await lease.release(); leaseReleased = true;}} catch (error) {report('host-release', error);}
      if (lock) {
        try {await lock.close();} catch (error) {report('checkout-close', error);}
        if (closureKnown) try {
          const current = await lstat(lockPath);
          if (current.dev !== lockInfo.dev || current.ino !== lockInfo.ino) throw Error('Checkout lock identity changed');
          await unlink(lockPath); checkoutReleased = true;
        } catch (error) {report('checkout-release', error);}
      }
    }
  }
  // This final state follows awaited audit/retention/lock work; the earlier raw
  // receipt stays immutable if cancellation arrives during those operations.
  const interrupted = controller.signal.aborted || signal?.aborted === true;
  const effectiveOutcome = outcome(interrupted ? 'FAIL' : receipt.rawOutcome, audit?.status, verified?.status, retained ? 'PASS' : 'INCONCLUSIVE',
    receipt.sourceStable && receipt.dependenciesUnchanged ? 'PASS' : 'INCONCLUSIVE', lifecycleErrors.length ? 'FAIL' : 'PASS');
  const final = {kind: 'fixture-preparation-finalization-1', qualification: false, receiptPath, rawOutcome: receipt.rawOutcome,
    effectiveOutcome, interrupted, producerStarted, producerCloseObserved: observedClose(receipt.producer),
    storageStatus: audit?.status ?? 'UNAVAILABLE', verifiedStorageStatus: verified?.status ?? 'UNAVAILABLE', auditRetained: retained,
    leaseReleased, checkoutReleased, exclusionRetained, retainedExclusions: exclusionRetained ? {checkout: lockPath, host: lease?.path ?? null} : null, lifecycleErrors,
    limits: ['Preparation only; not a scored campaign or hardware qualification.', 'Normal child close is not a descendant-process census.',
      'Audit, index and finalization bytes follow the last observation; no automatic pruning.']};
  try {
    await finalizationWriter(join(output, 'finalization.json'), json(final), {flag: 'wx', mode: 0o600});
    if (!final.interrupted && (controller.signal.aborted || signal?.aborted === true)) {
      // Never rewrite a sealed record: retain a late-interruption supplement,
      // and make the actual return/CLI unsuccessful as well.
      const late = {...final, effectiveOutcome: 'FAIL', interrupted: true, finalizationRecordPrecedesInterruption: true};
      await finalizationWriter(join(output, 'interruption-after-finalization.json'), json(late), {flag: 'wx', mode: 0o600});
      return late;
    }
    return final;
  } finally {
    signal?.removeEventListener('abort', relay); process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
  }
}

export function parsePreparationArguments(argv) {
  const split = argv.indexOf('--');
  if (split !== 4 || argv[0] !== '--output' || argv[2] !== '--timeout-ms' || !/^[1-9][0-9]*$/.test(argv[3] ?? '')) throw Error('Use --output ABSENT_ABSOLUTE_LEAF --timeout-ms N -- prepare[-seed] ... --allow-heavy');
  return {output: argv[1], timeoutMs: Number(argv[3]), args: preparationArguments(argv.slice(split + 1))};
}
export async function main(argv = process.argv.slice(2)) {
  if (process.versions.node !== '26.10.0') throw Error('Use pinned Node26.10.0');
  const result = await runFixturePreparation(parsePreparationArguments(argv));
  console.log(JSON.stringify(result)); return result.effectiveOutcome === 'PASS' ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => {process.exitCode = code;}, error => {console.error(JSON.stringify({status: 'FAIL', message: String(error.message)})); process.exitCode = 1;});
}
