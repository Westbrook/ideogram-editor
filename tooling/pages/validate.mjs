import { openSync, fstatSync, closeSync, writeSync } from 'node:fs';
import { readFile, readdir, lstat, realpath, writeFile, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digestJSON, tapCounts, gateOutcome } from '../qualification/core.mjs';
import { treeIdentityAsync } from '../qualification/development-cache.mjs';
import { prepareFunctionalOutput } from '../qualification/functional-output.mjs';
import { acquireTimingLock, timingLockDirectory } from '../qualification/campaigns/host.mjs';
import { startEvidenceMonitor, retainEvidenceAudit, verifyEvidenceAudit, fileIdentity } from '../qualification/evidence-volume.mjs';
import { boundedChild } from '../qualification/container/bounded-child.mjs';
import { createGateLog } from '../qualification/container/gate-log.mjs';
import { browserReportOutcome } from '../qualification/container/browser-plan.mjs';
import { buildIdentity, verifyArtifact } from './artifact.mjs';
import { committedInputs } from './source.mjs';
import { cleanEnvironment } from './build.mjs';

const combine = (...values) => values.includes('FAIL') ? 'FAIL' : values.every(value => value === 'PASS') ? 'PASS' : 'INCONCLUSIVE';
function argumentsFor(args) {
  const options = {};
  while (args.length) {
    const field = { '--commit': 'commit', '--built-at': 'builtAt', '--output': 'output' }[args.shift()], value = args.shift();
    if (!field || !value || options[field]) throw Error('Usage: validate.mjs --commit SHA --built-at UTC --output /fresh/allocated/leaf');
    options[field] = value;
  }
  buildIdentity(options.commit, options.builtAt);
  if (!options.output || !isAbsolute(options.output) || !process.env.IE_EVIDENCE_ALLOCATION) throw Error('Explicit fresh output and IE_EVIDENCE_ALLOCATION are required');
  return options;
}
async function smallJSON(path, maxBytes = 16 * 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || await realpath(path) !== path) throw Error('Invalid bounded Pages evidence file');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function browserClosure(directory) {
  const root = join(directory, 'closure');
  const names = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  if (names.length > 6 || names.some(name => !/^(chromium|firefox|webkit)-\d+(?:\.started)?\.json$/.test(name))) throw Error('Unexpected Pages owner closure inventory');
  const starts = names.filter(name => name.endsWith('.started.json')), rows = [];
  for (const name of starts) {
    const started = await smallJSON(join(root, name), 65536), completedName = name.replace('.started.json', '.json');
    if (!names.includes(completedName)) throw Error(`Pages owner did not close: ${name}`);
    const value = await smallJSON(join(root, completedName), 65536);
    if (value.schema !== 1 || value.project !== started.project || value.worker !== started.worker || value.browserClosed !== true || value.serverClosed !== true || !Array.isArray(value.errors) || value.errors.length) throw Error('Unclosed browser or static server');
    rows.push({ ...value, identity: await fileIdentity(join(root, completedName)), startedIdentity: await fileIdentity(join(root, name)) });
  }
  if (names.length !== starts.length * 2 || new Set(rows.map(row => row.project)).size !== rows.length) throw Error('Ambiguous Pages owner closure');
  return rows;
}
async function retainedDistribution(directory) {
  const source = join(directory, 'public-artifact');
  const stat = await lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return { exists: false, files: [] };
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(source) !== source) throw Error('Unexpected Pages output root');
  let total = 0, entries = 0; const files = [];
  async function copy(prefix = '', depth = 0) {
    if (depth > 4) throw Error('Closed Pages artifact depth bound exceeded');
    for (const name of (await readdir(join(source, prefix))).sort()) {
      if (++entries > 256) throw Error('Closed Pages artifact entry bound exceeded; original retained in its run directory');
      const member = prefix + name, path = join(source, member), current = await lstat(path);
      if (current.isSymbolicLink() || await realpath(path) !== path) throw Error('Linked Pages artifact cannot be retained');
      if (current.isDirectory()) { await copy(member + '/', depth + 1); continue; }
      if (!current.isFile() || current.size > 24 * 1024 * 1024 || files.length >= 160 || (total += current.size) > 64 * 1024 * 1024) throw Error('Closed Pages artifact retention bound exceeded; original retained in its run directory');
      const before = await fileIdentity(path);
      if (digestJSON(before) !== digestJSON(await fileIdentity(path))) throw Error('Pages artifact changed during retention');
      files.push({ path: member, ...before });
    }
  }
  await copy();
  const value = { exists: true, scope: 'Exact closed distribution, including any failed partial build; not a publication approval', files, totalBytes: total };
  await writeFile(join(directory, 'retained-artifact.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return value;
}

export async function validatePages(options) {
  if (process.versions.node !== '26.10.0') throw Error('Use Node 26.10.0');
  const root = process.cwd(), id = 'pages-' + randomUUID(), start = performance.now();
  const { directory, lock: lockPath } = prepareFunctionalOutput(root, id, options.output);
  const descriptor = openSync(lockPath, 'wx', 0o600), lockIdentity = fstatSync(descriptor);
  const receiptPath = join(directory, 'receipt.json'), controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT'), terminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const env = { ...cleanEnvironment(process.env), IE_EVIDENCE_ALLOCATION: process.env.IE_EVIDENCE_ALLOCATION,
    IE_PAGES_OUTPUT: join(directory, 'browser'), IE_PAGES_ARTIFACT: join(directory, 'public-artifact') };
  const gates = [
    { id: 'npm-version', command: ['npm', '--version'], timeoutMs: 10_000 },
    { id: 'typecheck', command: ['npm', 'run', 'typecheck'], timeoutMs: 180_000 },
    { id: 'pages-publisher-tests', command: [process.execPath, '--import', './tests/store/no-network.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1', 'pages/tests/publish-branch.test.mjs'], timeoutMs: 60_000 },
    { id: 'pages-unpack-tests', command: ['python3', '-B', 'pages/tests/test_unpack_artifact.py'], timeoutMs: 60_000 },
    { id: 'pages-build', command: [process.execPath, 'tooling/pages/build.mjs', '--commit', options.commit, '--built-at', options.builtAt, '--metadata', join(directory, 'build'), '--output', env.IE_PAGES_ARTIFACT], timeoutMs: 300_000 },
    { id: 'pages-browser', command: ['npm', 'exec', '--offline', '--', 'playwright', 'test', '--config', 'pages/tests/playwright.config.ts'], timeoutMs: 660_000 },
    { id: 'pages-artifact', command: [process.execPath, 'tooling/pages/artifact.mjs', env.IE_PAGES_ARTIFACT, options.commit], timeoutMs: 60_000 },
  ];
  const receipt = { kind: 'pages-preview-validation-1', id, identity: buildIdentity(options.commit, options.builtAt),
    startedAt: new Date().toISOString(), plan: gates, gates: [], qualification: false,
    limits: { workers: 1, retries: 0, gateLogBytes: 8 * 1024 * 1024, browserJSONBytes: 16 * 1024 * 1024, artifactBytes: 64 * 1024 * 1024, artifactFiles: 160 },
    scope: 'Isolated public Pages text preview. No full-editor, native/manual, physical-resource or live-provider qualification.', finalizationErrors: [] };
  let hostLease, monitor, audit, verified, before, dependenciesBefore, physicalClosed = true, browserStarted = false, rawSaved = false;
  let auditRetained = false, finished = false, leaseReleased = false, checkoutReleased = false;
  const lifecycleErrors = [], failure = (stage, error) => lifecycleErrors.push({ stage, error: String(error) });
  const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  try {
    writeSync(descriptor, JSON.stringify({ pid: process.pid, id, directory, kind: 'pages-preview-validation' }));
    hostLease = await acquireTimingLock(await timingLockDirectory(), { receiptId: id });
    receipt.hostExclusion = { path: hostLease.path, identity: hostLease.identity };
    let initialAlarm;
    monitor = await startEvidenceMonitor({ allocationPath: env.IE_EVIDENCE_ALLOCATION, output: directory, campaignId: id, allowUnavailable: false,
      onAlarm: alarm => { initialAlarm ??= { ...alarm }; console.error(JSON.stringify({ evidenceStorageAlarm: alarm })); } });
    receipt.evidenceStorage = monitor.reference;
    if (initialAlarm?.status !== 'PASS' || !['normal', 'target'].includes(initialAlarm.level)) throw Object.assign(Error('Initial evidence observation refused Pages work'), { outcome: initialAlarm?.status === 'FAIL' ? 'FAIL' : 'INCONCLUSIVE' });
    before = await committedInputs(root, options.commit); dependenciesBefore = await treeIdentityAsync(join(root, 'node_modules'));
    if (!dependenciesBefore) throw Error('Pinned npm installation is missing');
    receipt.before = before; receipt.dependenciesBefore = dependenciesBefore;
    for (const gate of gates) {
      if (controller.signal.aborted) throw Error('Pages validation interrupted');
      console.log(`Starting ${gate.id}`);
      const path = join(directory, gate.id + '.log'), log = createGateLog(path, controller.signal); let bytes = 0, observation;
      const append = part => { bytes += part.length; if (bytes > receipt.limits.gateLogBytes) controller.abort('Pages gate log bound exceeded'); else log.append(part); };
      if (gate.id === 'pages-browser') browserStarted = true;
      physicalClosed = false;
      try { observation = await boundedChild(gate.command[0], gate.command.slice(1), { cwd: root, env, timeoutMs: gate.timeoutMs, graceMs: 10_000,
        abortSignal: log.signal, onStdout: append, onStderr: append }); }
      finally { log.close(); }
      physicalClosed = Number.isInteger(observation.code) && !observation.signal && !observation.timedOut && !observation.interrupted;
      const outcome = observation.code === 0 && physicalClosed && !log.error ? 'PASS' : 'FAIL';
      const entry = { id: gate.id, observation, outcome, log: { path: gate.id + '.log', ...await fileIdentity(path) }, logError: log.error ? String(log.error) : null };
      receipt.gates.push(entry);
      if (gate.id === 'npm-version' && (await readFile(path, 'utf8')).trim() !== '12.1.0') { entry.outcome = 'FAIL'; throw Error('Use npm 12.1.0'); }
      if (gate.id === 'pages-publisher-tests') {
        const counts = tapCounts(await readFile(path, 'utf8'));
        entry.counts = counts;
        entry.outcome = gateOutcome({ exitCode: observation.code, signal: observation.signal, timedOut: observation.timedOut,
          interrupted: observation.interrupted, counts, logError: log.error }, true);
        if (entry.outcome !== 'PASS' || counts.tests !== 25 || counts.pass !== 25) { entry.outcome = 'FAIL'; throw Error('All 25 Pages publisher Node cases must pass without skips'); }
      }
      if (gate.id === 'pages-unpack-tests') {
        const text = await readFile(path, 'utf8'), match = /Ran ([1-9][0-9]*) tests? in [^\n]+\n\nOK\s*$/.exec(text);
        if (!match || Number(match[1]) !== 7) { entry.outcome = 'FAIL'; throw Error('All seven Pages unpack cases must pass without skips'); }
        entry.counts = { tests: Number(match[1]), pass: Number(match[1]) };
      }
      if (gate.id === 'pages-browser') {
        const report = await smallJSON(join(env.IE_PAGES_OUTPUT, 'results.json'));
        receipt.browser = browserReportOutcome(report, { files: ['pages/tests/preview.spec.ts'] });
        receipt.browserReport = await fileIdentity(join(env.IE_PAGES_OUTPUT, 'results.json'));
        receipt.owners = await browserClosure(env.IE_PAGES_OUTPUT);
        if (receipt.browser.outcome !== 'PASS' || receipt.browser.discovered !== 30 || receipt.browser.counts.expected !== 30 ||
            JSON.stringify(receipt.owners.map(row => row.project).sort()) !== JSON.stringify(['chromium', 'firefox', 'webkit'])) { entry.outcome = 'FAIL'; throw Error('Pages requires all ten cases in all three pinned engines'); }
      }
      await save();
      console.log(`${gate.id}: ${outcome}`);
      if (outcome !== 'PASS') throw Error(`${gate.id} failed; later gates were not started`);
      if (gate.id === 'typecheck') {
        const playwright = await import('@playwright/test');
        receipt.requiredBrowsers = [];
        for (const engine of ['chromium', 'firefox', 'webkit']) {
          const executable = playwright[engine].executablePath();
          const binary = await lstat(executable);
          if (!binary.isFile()) throw Error(`Missing pinned ${engine} executable; install explicitly before Pages validation`);
          receipt.requiredBrowsers.push({ engine, executable });
        }
        receipt.browserPins = await smallJSON(join(root, 'node_modules/playwright-core/browsers.json'), 65536);
      }
    }
    receipt.artifact = await verifyArtifact(root, env.IE_PAGES_ARTIFACT, options.commit);
    receipt.outcome = 'PASS';
  } catch (error) { receipt.outcome = ['FAIL', 'INCONCLUSIVE'].includes(error.outcome) ? error.outcome : 'FAIL'; receipt.error = String(error); }
  finally {
    if (browserStarted) {
      try { receipt.owners = await browserClosure(env.IE_PAGES_OUTPUT); }
      catch (error) { physicalClosed = false; receipt.finalizationErrors.push({ stage: 'browser-closure', error: String(error) }); }
    }
    // Never inspect/copy a distribution that could still have an owned writer.
    if (physicalClosed) {
      try { receipt.retainedArtifact = await retainedDistribution(directory); }
      catch (error) { receipt.finalizationErrors.push({ stage: 'artifact-retention', error: String(error) }); }
      if (before) try { receipt.after = await committedInputs(root, options.commit); } catch (error) { receipt.finalizationErrors.push({ stage: 'committed-source-after', error: String(error) }); }
      if (dependenciesBefore) try { receipt.dependenciesAfter = await treeIdentityAsync(join(root, 'node_modules')); } catch (error) { receipt.finalizationErrors.push({ stage: 'dependencies-after', error: String(error) }); }
    }
    receipt.physicalClosed = physicalClosed;
    receipt.sourceStable = !!before && before.digest === receipt.after?.digest;
    receipt.dependenciesStable = !!dependenciesBefore && dependenciesBefore.digest === receipt.dependenciesAfter?.digest;
    if (!receipt.sourceStable || !receipt.dependenciesStable || !physicalClosed || receipt.finalizationErrors.length) receipt.outcome = combine(receipt.outcome, 'INCONCLUSIVE');
    if (controller.signal.aborted) { receipt.outcome = 'FAIL'; receipt.interrupted = String(controller.signal.reason); }
    receipt.pending = gates.slice(receipt.gates.length).map(gate => gate.id);
    receipt.endedAt = new Date().toISOString(); receipt.elapsedMs = performance.now() - start;
    try { await save(); rawSaved = true; } catch (error) { failure('raw-save', error); }
    // Raw receipt becomes immutable here. Finalization below is a separate record.
    if (monitor) {
      try { audit = await monitor.finish({ receiptPath: rawSaved ? receiptPath : null, outcome: receipt.outcome }); finished = true; }
      catch (error) { failure('audit-finish', error); }
      try { await retainEvidenceAudit(monitor.reference, directory); auditRetained = true; }
      catch (error) { failure('audit-retain', error); }
      if (rawSaved && auditRetained) try { verified = await verifyEvidenceAudit(monitor.reference, receiptPath); }
      catch (error) { failure('audit-verify', error); }
    }
    if (physicalClosed && (!monitor || finished)) {
      try { if (hostLease) await hostLease.release(); leaseReleased = true; }
      catch (error) { failure('host-release', error); }
      try {
        closeSync(descriptor);
        const current = await lstat(lockPath);
        if (current.ino !== lockIdentity.ino || current.dev !== lockIdentity.dev) throw Error('Checkout lock identity changed');
        await unlink(lockPath); checkoutReleased = true;
      } catch (error) { failure('checkout-release', error); }
    } else {
      closeSync(descriptor);
      failure('ownership-retained', 'Owned process cleanup or evidence monitor shutdown is unproven; host and checkout leases retained for root investigation. Do not steal them.');
    }
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  }
  const effectiveOutcome = combine(receipt.outcome, audit?.status, verified?.status,
    finished && auditRetained && rawSaved && physicalClosed && leaseReleased && checkoutReleased ? 'PASS' : 'INCONCLUSIVE', lifecycleErrors.length || controller.signal.aborted ? 'FAIL' : 'PASS');
  const finalization = { kind: 'pages-preview-finalization-1', rawOutcome: receipt.outcome, effectiveOutcome, receipt: await fileIdentity(receiptPath),
    auditFinished: finished, auditRetained, auditStatus: audit?.status ?? null, verifiedAuditStatus: verified?.status ?? null,
    physicalClosed, leaseReleased, checkoutReleased, interrupted: controller.signal.aborted ? String(controller.signal.reason) : null,
    lifecycleErrors, scope: 'Post-audit closure metadata; not included in the final storage sample' };
  await writeFile(join(directory, 'finalization.json'), JSON.stringify(finalization, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ rawOutcome: receipt.outcome, effectiveOutcome, output: directory, physicalClosed, leaseReleased, checkoutReleased }));
  return finalization;
}
if (import.meta.main) validatePages(argumentsFor(process.argv.slice(2))).then(result => { process.exitCode = result.effectiveOutcome === 'PASS' ? 0 : result.effectiveOutcome === 'FAIL' ? 1 : 2; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
