import { startEvidenceMonitor, retainEvidenceAudit } from '../evidence-volume.mjs';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { resolve, join } from 'node:path';
import { boundedChild } from './bounded-child.mjs';
import { createGateLog } from './gate-log.mjs';
import { createBrowserPlan } from './browser-plan.mjs';
import { retainBrowserEvidence } from './browser-evidence.mjs';
import { verifyInstalledInputs } from './inputs.mjs';
import { parseContainerSelection, selectContainerNodePlan, containerPacketEnvironment, containerPrerequisiteIds } from './selection.mjs';
import { executionEnvironment } from '../core.mjs';
import { executeGate } from '../run.mjs';

const { selection, scope, browserOnly } = parseContainerSelection(process.argv.slice(2));
const root = resolve('.');
const toolchain = JSON.parse(await readFile('tooling/toolchain.json', 'utf8'));
if (process.versions.node !== toolchain.node) throw Error(`Use Node ${toolchain.node}`);
await mkdir('artifacts/qualification-container', { recursive: true });
const output = await mkdtemp(resolve('artifacts/qualification-container/run-'));
const browserPlan = createBrowserPlan({ selection, scope, output });
const browsers = browserPlan.requiredBrowsers;
const nodePlan = selectContainerNodePlan(root, { scope, browserOnly });
let evidenceMonitor = null;
const receipt = {
  schema: 1, status: 'running', startedAt: new Date().toISOString(), output,
  environment: { node: process.versions.node, platform: platform(), arch: arch(), kernel: release(),
    baseImage: process.env.QUALIFICATION_BASE_IMAGE ?? null,
    sourceRevision: process.env.QUALIFICATION_SOURCE_REVISION ?? 'working-tree',
    browsers, selectedBrowserScope: selection, functionalScope: scope, nodeScope: browserOnly ? 'prerequisites-only' : scope },
  scope: 'Container functional gates only. Not C/H bare-metal performance, physical display, assistive technology, resource, release, or paid-provider qualification.',
  commands: [], browserPlan, functionalPlan: nodePlan, functionalGates: [],
};
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const interruption = new AbortController();
const onInterrupt = () => interruption.abort('SIGINT');
const onTerminate = () => interruption.abort('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
function recordInterruption() {
  if (!interruption.signal.aborted) return false;
  const newlyRecorded = receipt.interrupted !== true;
  receipt.status = 'interrupted'; receipt.interrupted = true;
  receipt.reason = String(interruption.signal.reason);
  process.exitCode = interruption.signal.reason === 'SIGINT' ? 130 : 143;
  return newlyRecorded;
}
// Child processes receive no ambient provider credentials, tokens, proxy or
// NODE_OPTIONS settings. Test scripts retain their checked-in no-egress preloads.
const env = {
  PATH: `${join(root, '.toolchain/bin')}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: '/tmp', CI: '1', LANG: 'C.UTF-8',
  ...(process.env.IE_EVIDENCE_ALLOCATION ? { IE_EVIDENCE_ALLOCATION: process.env.IE_EVIDENCE_ALLOCATION } : {}),
  ...containerPacketEnvironment(process.env),
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/playwright',
  npm_config_cache: '/tmp/ideogram-qualification-npm-cache',
  npm_config_userconfig: '/tmp/ideogram-qualification-empty-npmrc',
};
async function run(label, executable, args, extra = {}, timeoutMs = 300_000) {
  const log = `${String(receipt.commands.length + 1).padStart(2, '0')}-${label}.log`;
  const entry = { label, executable, args, timeoutMs, terminationGraceMs: 5_000, startedAt: new Date().toISOString(), log, status: 'running' };
  receipt.commands.push(entry); await save();
  console.log(`Running ${label}; receipt: ${join(output, 'receipt.json')}`);
  const stream = createGateLog(join(output, log), interruption.signal);
  const started = performance.now();
  try {
    const result = await boundedChild(executable, args, {
      cwd: root, env: { ...env, ...extra }, timeoutMs, abortSignal: stream.signal,
      onStdout: chunk => { process.stdout.write(chunk); stream.append(chunk); },
      onStderr: chunk => { process.stderr.write(chunk); stream.append(chunk); },
    });
    Object.assign(entry, result, { status: result.interrupted ? 'interrupted' : result.code === 0 && !result.timedOut ? 'passed' : 'failed' });
    if (result.interrupted) throw Error(`${label} interrupted by ${result.reason}; its process tree was terminated`);
    if (result.timedOut) throw Error(`${label} exceeded its ${timeoutMs}ms deadline; its process tree was terminated`);
    if (result.code !== 0) throw Error(`${label} failed (exit ${result.code}, signal ${result.signal})`);
  } catch (error) {
    entry.status = entry.interrupted ? 'interrupted' : 'failed'; entry.error = String(error); throw error;
  } finally {
    entry.elapsedMs = performance.now() - started; entry.finishedAt = new Date().toISOString();
    stream.close();
    if (stream.error) { entry.status = 'failed'; entry.error = String(stream.error); }
    const bytes = await readFile(join(output, log));
    entry.logBytes = bytes.length;
    entry.logSha256 = createHash('sha256').update(bytes).digest('hex');
    await chmod(join(output, log), 0o444);
    await save();
    if (stream.error) throw Error('Qualification log failed after child cleanup: ' + String(stream.error));
  }
}
const npm = (label, args, extra, timeoutMs) => run(label, join(root, '.toolchain/bin/npm'), args, extra, timeoutMs);
async function sourceManifest() {
  const files = [];
  const excluded = new Set(['.toolchain', 'node_modules', 'dist', 'artifacts', 'test-results', 'playwright-report', '.git']);
  async function inventory(directory = '') {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name)) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await inventory(path);
      else if (entry.isFile()) { const bytes = await readFile(join(root, path)); files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
      else throw Error(`Unexpected source entry: ${path}`);
    }
  }
  await inventory();
  return JSON.stringify(files, null, 2) + '\n';
}
try {
  evidenceMonitor = await startEvidenceMonitor({ output, campaignId: 'container-' + Date.now(), onAlarm: alarm => console.error(JSON.stringify({ evidenceStorageAlarm: alarm })) });
  receipt.evidenceStorage = evidenceMonitor.reference;
  const inputs = await verifyInstalledInputs();
  receipt.inputPacket = { manifestSha256: inputs.manifestSha256, commits: inputs.manifest.history.requirements.length, fixtures: inputs.manifest.fixtures.length, installed: inputs.installed, qualification: false };
  // This describes actual admitted source bytes, including uncommitted changes.
  const manifest = await sourceManifest();
  await writeFile(join(output, 'source-manifest.json'), manifest);
  receipt.sourceManifestSha256 = createHash('sha256').update(manifest).digest('hex');
  const installedNpm = JSON.parse(await readFile(join(root, '.toolchain', 'npm-' + toolchain.npm, 'package/package.json'), 'utf8'));
  if (installedNpm.version !== toolchain.npm) throw Error(`Use npm ${toolchain.npm}`);
  await npm('toolchain', ['--version'], {}, 30_000);
  // Execute the app-owned plan directly, sharing its parsed test outcomes and
  // bounded child lifecycle. All prerequisites execute once in this invocation;
  // no previous run/source/dependency receipt is relabelled as current evidence.
  const gateOutput = join(output, 'functional-gates'); await mkdir(gateOutput);
  const gateEnv = executionEnvironment(env, join(root, '.toolchain/bin'), gateOutput);
  for (const gate of nodePlan) {
    console.log(`Running ${gate.id}; receipt: ${join(output, 'receipt.json')}`);
    const observed = await executeGate(gate, gateOutput, gateEnv, root, interruption.signal);
    await chmod(join(gateOutput, observed.log.path), 0o444);
    await writeFile(join(gateOutput, `${gate.id.replaceAll(':', '-')}.json`), JSON.stringify(observed, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    receipt.functionalGates.push(observed); await save();
    console.log(`${gate.id}: ${observed.outcome}`);
    if (observed.outcome !== 'PASS') throw Error(`${gate.id} is ${observed.outcome}; see retained functional-gates log`);
  }
  receipt.dependencyProof = {
    kind: 'same-invocation-prerequisites-1', sourceManifestSha256: receipt.sourceManifestSha256,
    gates: containerPrerequisiteIds(receipt.functionalGates),
    gateReceipt: 'receipt.json#functionalGates', reusedAcross: nodePlan.filter(gate => gate.id.startsWith('node:')).map(gate => gate.id),
    reusedAcrossBrowserSteps: browserPlan.steps.filter(step => step.browser).map(step => step.id),
    limit: 'Fresh app/server commands in this invocation only; no external or historical dependency evidence reused.',
  };
  const playwright = await import('@playwright/test');
  receipt.playwrightManifest = JSON.parse(await readFile('node_modules/playwright-core/browsers.json', 'utf8'));
  receipt.browserExecutables = {};
  for (const browser of browsers) {
    const path = playwright[browser].executablePath();
    receipt.browserExecutables[browser] = { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
  }
  await save();
  const completionOutput = join(output, 'browser-completion-issuers');
  await run('browser-completion-issuers', process.execPath, ['tooling/qualification/completion-issuers/index.mjs', '--output', completionOutput], {}, 300_000);
  const completionEnvironment = { COMPLETION_APPLICATION_IDENTITY: join(completionOutput, 'application-identity.json'), COMPLETION_ISSUER_MANIFEST: join(completionOutput, 'host-final-issuers.json') };
  receipt.browserCompletionInputs = [];
  for (const [name, path] of Object.entries(completionEnvironment)) {
    const bytes = await readFile(path);
    receipt.browserCompletionInputs.push({ name, path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await chmod(path, 0o444);
  }
  await save();
  for (const step of browserPlan.steps) {
    let childFailure;
    try { await npm(step.id, step.args, { ...step.env, ...completionEnvironment }, step.timeoutMs ?? 300_000); }
    catch (error) { childFailure = error; }
    const command = receipt.commands.at(-1);
    if (step.browser) {
      const observed = await retainBrowserEvidence(step, output);
      Object.assign(command, observed);
      if (observed.outcome !== 'PASS') command.status = 'failed';
      await save();
    }
    if (childFailure) throw childFailure;
    if (command.status !== 'passed') throw Error(`${step.id} produced incomplete or failing browser evidence; required/discovered/executed equality, skips, flakes and empty discovery cannot pass`);
  }
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed'; receipt.failure = String(error); process.exitCode = 1;
  console.error(error);
} finally {
  if (receipt.sourceManifestSha256) {
    try {
      const after = await sourceManifest();
      await writeFile(join(output, 'source-manifest-after.json'), after);
      receipt.sourceManifestAfterSha256 = createHash('sha256').update(after).digest('hex');
      receipt.sourceUnchanged = receipt.sourceManifestAfterSha256 === receipt.sourceManifestSha256;
      if (!receipt.sourceUnchanged) throw Error('Copied source bytes changed during qualification');
      const inputsAfter = await verifyInstalledInputs();
      receipt.inputPacketAfterSha256 = inputsAfter.manifestSha256;
      if (receipt.inputPacketAfterSha256 !== receipt.inputPacket.manifestSha256) throw Error('Sealed input packet changed during qualification');
      receipt.installedInputsAfter = inputsAfter.installed;
      if (inputsAfter.installed.gitSha256 !== receipt.inputPacket.installed.gitSha256) throw Error('Installed qualification Git history changed during qualification');
      for (const input of receipt.browserCompletionInputs ?? []) {
        const bytes = await readFile(input.path);
        if (bytes.length !== input.bytes || createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw Error('Browser completion input changed during qualification');
      }
    } catch (error) {
      receipt.status = 'failed'; receipt.sourceVerificationFailure = String(error); process.exitCode = 1;
    }
  }
  recordInterruption();
  receipt.finishedAt = new Date().toISOString(); await save();
  // A signal delivered during the final asynchronous write still gets a durable
  // interrupted outcome before the caller-owned handlers are removed.
  if (recordInterruption()) await save();
  try {
    if (evidenceMonitor) { const audit = await evidenceMonitor.finish({ receiptPath: join(output, 'receipt.json'), outcome: receipt.status }); await retainEvidenceAudit(evidenceMonitor.reference, output); console.log(JSON.stringify({ evidenceStorage: { status: audit.status } })); if (audit.status !== 'PASS' && process.exitCode !== 1) process.exitCode = audit.status === 'FAIL' ? 1 : 2; }
    console.log(`Retained container qualification: ${output}`);
  } finally {
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
  }
}
