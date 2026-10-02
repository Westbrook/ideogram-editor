import {readGateLog} from './gate-log-reader.mjs';
import {completionPrerequisitesFor} from './suite-prerequisites.mjs';
import { prepareFunctionalOutput } from './functional-output.mjs';
import { startEvidenceMonitor, retainEvidenceAudit, verifyEvidenceAudit } from './evidence-volume.mjs';
import { readFileSync, mkdirSync, writeFileSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname, platform, release, arch, totalmem, cpus } from 'node:os';
import { functionalGates, selectGates, versions, campaignJobs, validateCampaignSchedule, manualProtocols, sourceRevision } from './manifest.mjs';
import { sourceIdentity, executionEnvironment, gateOutcome, receiptOutcome, sha256, digestJSON, verifyReceipt } from './core.mjs';
import { boundedChild } from './container/bounded-child.mjs';
import { createGateLog } from './container/gate-log.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function option(argv, name, fallback) { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; }
function save(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }

async function sealOutputTree(output, directory) {
  const { fileManifest } = await import('./developer-campaigns/common.mjs');
  const files = await fileManifest(output), relativeOutput = resolve(output).slice(resolve(directory).length + 1);
  const manifestPath = `${relativeOutput}.manifest.json`;
  const bytes = Buffer.from(JSON.stringify({ kind: 'qualification-preparation-output-1', output: relativeOutput, files }, null, 2) + '\n');
  writeFileSync(join(directory, manifestPath), bytes, { flag: 'wx', mode: 0o444 });
  return { output: relativeOutput, files, manifest: { path: manifestPath, bytes: bytes.length, sha256: sha256(bytes) } };
}

export async function executeGate(gate, directory, environment, cwd = root, abortSignal, {logReader = readGateLog,
  prepareIssuers = async (...args) => (await import('./completion-issuers/prepare-child.mjs')).prepareCompletionIssuersChild(...args),
  prepareInputs = async (...args) => (await import('./completion-inputs/index.mjs')).prepareCompletionInputs(...args),
} = {}) {
  const path = join(directory, `${gate.id.replaceAll(':', '-')}.log`);
  const output = createGateLog(path, abortSignal), childSignal = output.signal;
  const start = process.hrtime.bigint();
  const startedAt = new Date().toISOString();
  const [command, ...argv] = gate.command;
  let result, fixturePrerequisites, fixturePreparations, adapterFixture, verifyAdapterFixture, fixtureBuild, issuerPreparation;
  try {
    const requiredEnvironment = gate.requiredEnvironment ?? {};
    if (Object.entries(requiredEnvironment).some(([name, value]) => name !== 'IE_CAMPAIGN_PRODUCT_INTEGRATION' || value !== '1')) throw Error('Unsupported required gate environment');
    let childEnvironment = { ...environment, ...requiredEnvironment };
    const completion = completionPrerequisitesFor(gate.files ?? []);
    if (digestJSON(gate.completionPrerequisites ?? null) !== digestJSON(completion ?? null)) throw Error('Completion prerequisites differ from selected files');
    if (gate.fixtureBuild) {
      const destination = resolve(directory, `${gate.id.replaceAll(':', '-')}-${gate.fixtureBuild.id}`);
      const args = ['node_modules/vite/bin/vite.js', 'build', '--config', gate.fixtureBuild.config, '--outDir', destination];
      const build = await boundedChild(process.execPath, args, { cwd, env: childEnvironment, timeoutMs: Math.min(300_000, Math.max(1, Math.floor(gate.timeoutMs - Number(process.hrtime.bigint() - start) / 1e6))), abortSignal: childSignal, onStdout: bytes => output.append(bytes), onStderr: bytes => output.append(bytes) });
      fixtureBuild = { command: [process.execPath, ...args], output: destination.slice(resolve(directory).length + 1), ...build };
      if (build.code !== 0 || build.signal || build.timedOut || build.interrupted) throw Object.assign(Error('Required browser fixture build failed'), build);
      const { hashFile } = await import('./developer-campaigns/common.mjs');
      fixtureBuild.executable = { path: process.execPath, node: process.versions.node, ...await hashFile(process.execPath) };
      Object.assign(fixtureBuild, await sealOutputTree(destination, directory));
      childEnvironment = { ...childEnvironment, [gate.fixtureBuild.outputEnvironment]: destination };
      mkdirSync(childEnvironment.TEXT_STATE_EVIDENCE, { recursive: true });
    }
    if (gate.files?.some(file => file.startsWith('tests/adapters/'))) {
      ({ verifyAdapterFixture } = await import('./container/inputs.mjs'));
      adapterFixture = { before: await verifyAdapterFixture({ root: cwd }) };
      childEnvironment = { ...childEnvironment, IE_ADAPTER_FIXTURE: adapterFixture.before.path, IE_ADAPTER_PROFILE_FIXTURE: adapterFixture.before.path };
      output.append('Verified exact public adapter fixture for both flow and profile cases.\n');
    }
    if (completion) {
      const issuerDeadline = Math.floor(gate.timeoutMs - Number(process.hrtime.bigint() - start) / 1e6);
      if(issuerDeadline<1)throw Object.assign(Error('Completion issuer preparation exceeded the gate deadline'),{timedOut:true});
      const issuers = await prepareIssuers(join(directory, `${gate.id.replaceAll(':', '-')}-completion-issuers`), cwd, {env: childEnvironment, abortSignal: childSignal, timeoutMs: issuerDeadline});
      issuerPreparation = issuers.preparation;
      childEnvironment = { ...childEnvironment, ...issuers.env };
      fixturePreparations = [{ role: 'completion-issuers', ...await sealOutputTree(issuers.output, directory) }];
      let prepared = {};
      if (completion.kind === 'current-issuers-original-monitor-independent-capture-1') {
        const inputOutput = join(directory, `${gate.id.replaceAll(':', '-')}-completion-inputs`);
        prepared = await prepareInputs(inputOutput, cwd, { abortSignal: childSignal, timeoutMs: Math.max(1, Math.floor(gate.timeoutMs - Number(process.hrtime.bigint() - start) / 1e6)), env: childEnvironment });
        fixturePreparations.push({ role: 'completion-inputs', ...await sealOutputTree(inputOutput, directory) });
      }
      fixturePrerequisites = Object.entries({ ...issuers.env, ...prepared }).map(([name, path]) => {
        const absolute = resolve(path);
        if (!absolute.startsWith(`${resolve(directory)}/`)) throw Error('Prepared helper input escaped its receipt directory');
        const bytes = readFileSync(absolute);
        return { name, path: absolute.slice(resolve(directory).length + 1), bytes: bytes.length, sha256: sha256(bytes) };
      });
      childEnvironment = { ...childEnvironment, ...prepared };
      output.append(`Prepared and sealed ${fixturePrerequisites.length} completion helper inputs (${completion.kind}).\n`);
    }
    const remainingMs = Math.floor(gate.timeoutMs - Number(process.hrtime.bigint() - start) / 1e6);
    if (remainingMs <= 0) throw Object.assign(Error('Fixture preparation exceeded the gate deadline'), { timedOut: true });
    const child = await boundedChild(command, argv, { cwd, env: childEnvironment, timeoutMs: remainingMs, graceMs: gate.graceMs ?? 5_000, abortSignal: childSignal, onStdout: bytes => output.append(bytes), onStderr: bytes => output.append(bytes) });
    result = { ...child, exitCode: child.code }; delete result.code;
    const preparedTrees = [...(fixtureBuild?.files?.length ? [fixtureBuild] : []), ...(fixturePreparations ?? [])];
    if (preparedTrees.length) {
      const { fileManifest } = await import('./developer-campaigns/common.mjs');
      for (const tree of preparedTrees) {
        const current = await fileManifest(resolve(directory, tree.output)), manifestBytes = readFileSync(resolve(directory, tree.manifest.path));
        if (digestJSON(current) !== digestJSON(tree.files) || manifestBytes.length !== tree.manifest.bytes || sha256(manifestBytes) !== tree.manifest.sha256) throw Error(`Prepared fixture changed during gate: ${tree.output}`);
      }
    }
    if (adapterFixture) {
      adapterFixture.after = await verifyAdapterFixture({ root: cwd });
      if (JSON.stringify(adapterFixture.before) !== JSON.stringify(adapterFixture.after)) throw Error('Adapter fixture changed during the gate');
    }
  } catch (error) { issuerPreparation ??= error.issuerPreparation; output.append(`${error.message}\n`); result = { exitCode: null, signal: error.signal ?? null, timedOut: error.timedOut === true, ...(error.interrupted ? {interrupted:true} : {}), error: error.message }; }
  output.close();
  if (output.error) result = { ...result, exitCode: null, interrupted: true, error: String(output.error) };
  const endedAt = new Date().toISOString();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  let summary, logError = null;
  try { summary = await logReader(path); if (summary.error) logError = summary.error; }
  catch (error) { logError = String(error.message ?? error); summary = {bytes: null, sha256: null, counts: {}}; }
  const counts = summary.counts;
  const observation = { id: gate.id, command: gate.command, ...(gate.requiredEnvironment ? { requiredEnvironment: gate.requiredEnvironment } : {}), cwd, startedAt, endedAt, elapsedMs, ...result, counts, ...(logError ? {logError} : {}), ...(fixtureBuild ? { fixtureBuild } : {}), ...(gate.browserPrerequisites ? { browserPrerequisites: gate.browserPrerequisites } : {}), ...(issuerPreparation ? { issuerPreparation } : {}), ...(fixturePrerequisites ? { fixturePrerequisites } : {}), ...(fixturePreparations ? { fixturePreparations } : {}), ...(adapterFixture ? { adapterFixture } : {}), log: { path: path.slice(directory.length + 1), bytes: summary.bytes, sha256: summary.sha256 } };
  return { ...observation, outcome: gateOutcome(observation, gate.id.startsWith('node:')) };
}

async function main(argv) {
  const [command] = argv;
  const selector = option(argv, '--select', 'base');
  if (command === 'campaign') {
    const campaign = option(argv, '--campaign', 'Q3'), features = option(argv, '--features', 'core');
    console.log(JSON.stringify({ sourceRevision, campaign, features, jobs: campaignJobs(campaign, features), qualification: false, manuals: manualProtocols, note: 'Inventory only. Native H/C hardware, complete exact cells, sample/cache/reset/prime/B0 counts and receipts remain required.' }, null, 2)); return;
  }
  if (command === 'validate-schedule') { console.log(JSON.stringify(validateCampaignSchedule(JSON.parse(readFileSync(argv[1], 'utf8'))), null, 2)); return; }
  if (command === 'verify') {
    const path = resolve(argv[1]); const receipt = JSON.parse(readFileSync(path, 'utf8'));
    const absolute = relative => { const selected = resolve(dirname(path), relative); if (!selected.startsWith(`${dirname(path)}/`)) throw Error('Receipt log path escaped its directory'); return selected; };
    const summaries = new Map(); for (const gate of receipt.gates ?? []) summaries.set(gate.log.path, await readGateLog(absolute(gate.log.path)));
    const functional = verifyReceipt(receipt, relative => readFileSync(absolute(relative)), relative => summaries.get(relative)); const evidenceStorage = await verifyEvidenceAudit(receipt.evidenceStorage, path); console.log(JSON.stringify({ functional, evidenceStorage }, null, 2)); if (evidenceStorage.status !== 'PASS') process.exitCode = evidenceStorage.status === 'FAIL' ? 1 : 2; return;
  }
  if (!['plan', 'run'].includes(command)) throw Error('Usage: run.mjs plan|run --select base|features|helpers|all|gate[,gate] [--without-dependencies] [--output /allocated/new-run] | campaign --campaign P|Q3 --features core|adapters|training | validate-schedule file | verify receipt');
  const gates = selectGates(functionalGates(root), selector, { includeDependencies: !argv.includes('--without-dependencies') });
  const plan = { sourceRevision, selector, qualification: false, dependenciesIncluded: !argv.includes('--without-dependencies'), gates, scope: 'Selected functional suite invocations only; no full TEST coverage, WD fixed selections, P/Q3 performance, native/manual, live Fal, CI or container qualification is inferred.' };
  if (command === 'plan') { console.log(JSON.stringify(plan, null, 2)); return; }
  if (process.versions.node !== versions.node) throw Error(`Pinned Node ${versions.node} required; found ${process.versions.node}`);
  const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const { directory, lock } = prepareFunctionalOutput(root, id, option(argv, '--output'));
  let lockFd;
  try { lockFd = openSync(lock, 'wx'); } catch { throw Error(`A qualification run owns ${lock}; inspect ownership before recovering a stale lock`); }
  writeFileSync(lockFd, JSON.stringify({ pid: process.pid, id, directory }));
  const controller = new AbortController();
  const onInterrupt = () => controller.abort('SIGINT');
  const onTerminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  let evidenceMonitor = null, retainedReceiptPath = null;
  try {
    evidenceMonitor = await startEvidenceMonitor({ output: directory, campaignId: id, onAlarm: alarm => console.error(JSON.stringify({ evidenceStorageAlarm: alarm })) });
    const environment = executionEnvironment(process.env, resolve(root, '.toolchain/bin'), directory);
    const npm = spawnSync('npm', ['--version'], { env: environment, encoding: 'utf8', cwd: root });
    if (npm.status !== 0 || npm.stdout.trim() !== versions.npm) throw Error(`Pinned npm ${versions.npm} required`);
    const before = sourceIdentity(root);
    const receipt = { kind: 'qualification-functional-run-1', evidenceStorage: evidenceMonitor.reference, id, sourceRevision, scope: plan.scope, selected: gates.map(gate => gate.id), plan, environment: { hostname: hostname(), platform: platform(), release: release(), arch: arch(), totalmem: totalmem(), cpu: cpus()[0]?.model ?? 'unavailable', node: process.versions.node, npm: npm.stdout.trim(), qualification: false }, startedAt: new Date().toISOString(), gates: [] };
    save(join(directory, 'plan.json'), { ...plan, identity: before });
    console.log(`Qualification evidence: ${directory}`);
    for (const gate of gates) {
      if (controller.signal.aborted) break;
      console.log(`Starting ${gate.id}`);
      const observed = await executeGate(gate, directory, environment, root, controller.signal); receipt.gates.push(observed);
      save(join(directory, `${gate.id.replaceAll(':', '-')}.json`), observed);
      console.log(`${gate.id}: ${observed.outcome} (${Math.round(observed.elapsedMs)}ms)`);
      if (observed.outcome !== 'PASS') break;
    }
    const after = sourceIdentity(root);
    receipt.interrupted = controller.signal.aborted ? String(controller.signal.reason) : null;
    receipt.identity = { before, after }; receipt.endedAt = new Date().toISOString();
    receipt.outcome = receiptOutcome(receipt.gates, receipt.selected, before.digest, after.digest, receipt.interrupted);
    save(join(directory, 'receipt.json'), receipt); retainedReceiptPath = join(directory, 'receipt.json');
    console.log(`${receipt.outcome}: ${join(directory, 'receipt.json')}`);
    process.exitCode = receipt.outcome === 'PASS' ? 0 : 1;
  } finally {
    try {
      if (evidenceMonitor) { const audit = await evidenceMonitor.finish({ receiptPath: retainedReceiptPath, outcome: process.exitCode ? 'FAIL' : 'UNKNOWN' }); if (retainedReceiptPath) await retainEvidenceAudit(evidenceMonitor.reference, directory); console.log(JSON.stringify({ evidenceStorage: { status: audit.status } })); if (audit.status !== 'PASS' && process.exitCode !== 1) process.exitCode = audit.status === 'FAIL' ? 1 : 2; }
    } finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); closeSync(lockFd); unlinkSync(lock); }
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
