/** Runtime bridge for the developer cells. P cells share one explicitly owned
 * source workspace; each I1/I2 sample owns a fresh workspace. Neither route
 * invokes a whole ten-sample campaign for an individual runtime cell. */
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open, readFile, writeFile, mkdir, lstat, realpath, rename, unlink, readdir, copyFile} from 'node:fs/promises';
import {dirname, join, resolve, isAbsolute, sep} from 'node:path';
import {editScopes, withTemporaryEdit} from '../dev.mjs';
import {createBrowserPlan} from '../container/browser-plan.mjs';
import {prepareInputs, verifyInputs, installInputs} from '../container/inputs.mjs';
import {PrerequisiteError} from '../campaigns/common.mjs';
import {buildIdentity} from '../campaigns/identity.mjs';
import {sourceIdentity} from '../core.mjs';
import {json, sha256, hashFile, fileManifest, sourcePaths, createWorkspace, toolchain, cleanEnvironment, execute, assertSuccess, verifyManifest, safeRelative} from './common.mjs';
import {auditBuild, auditDependencies, commandBudgets, observeD11Build, runDeveloperGroup} from './commands.mjs';
import {readFocused, discoverNodeFiles} from './selectors.mjs';
import {runNodeSelection, runBrowserSelection} from './suites.mjs';
import {browserCacheIdentity} from './verify-browsers.mjs';

const finite = value => Number.isFinite(value) && value >= 0;
const successful = status => ['PASS', 'pass', 'passed', 'completed', 'passed-local-sample'].includes(status);
const failed = status => ['FAIL', 'fail', 'failed'].includes(status);
const abort = signal => { if (signal?.aborted) throw signal.reason ?? Error('Developer campaign interrupted'); };
function revokeProduct(state) {
  delete state.productRepo; delete state.sourceDigest; delete state.buildProvenancePath; delete state.playwrightBrowsersPath;
}
const pStages = Object.freeze({
  'C0/setup': 'setup', 'C1/clean-install': 'clean-install', 'C2/full-types': 'full-types',
  'C2/production-build': 'production-build', 'C3/public-leaf': 'incremental-public-leaf',
  'C3/domain-type': 'incremental-domain-type', 'C4/focused-unit': 'focused-unit', 'C4/full-unit': 'full-unit',
  'C5/focused-integration': 'focused-integration', 'C5/full-integration': 'full-integration',
  'C6/browser-cache': 'browser-cache', 'C6/focused-browser': 'focused-browser', 'C6/full-browser': 'full-browser',
  'C8/audit': 'audit',
});
const stageOrder = Object.values(pStages);
export const developerBuildByteNames = Object.freeze([
  'D11BuildStartupJsGzipBytes', 'D11BuildLazyFeatureGzipBytes', 'D11BuildTextEngineRawBytes',
  'D11BuildTextEngineGzipBytes', 'D11BuildUiCssFontGzipBytes',
]);

/** Propagate an actual build audit without substituting emitted graph bytes for
 * H's independently observed startup delivery or executed-script evidence. */
export function developerBuildByteObservation(observation, required = false) {
  const d11 = observation.d11 ?? observation.artifacts?.d11;
  const missing = [], measurements = {}; let derived;
  if (!d11) return {d11: null, measurements, missing: required ? ['Actual C D11 artifact-build observation is unavailable'] : [], failed: false};
  const identity = /^sha256:[a-f0-9]{64}$/;
  if (d11.kind !== 'd11-build-observation-1' || d11.scope !== 'artifact-build' || !['PASS', 'FAIL', 'INCONCLUSIVE'].includes(d11.status) ||
    !Array.isArray(d11.missing) || !identity.test(d11.buildSha256 ?? '') || d11.inventory?.kind !== 'perf-d11-build-1' || d11.inventory.sha256 !== d11.buildSha256 ||
    !Array.isArray(d11.featureIds) || d11.featureIds.some(value => typeof value !== 'string' || !value) || new Set(d11.featureIds).size !== d11.featureIds.length || !Array.isArray(d11.features) || !Array.isArray(d11.measurements)) {
    missing.push('C D11 artifact-build observation has an incomplete identity or role contract');
  } else {
    try {
      derived = observeD11Build(d11.inventory, {artifact: d11.artifact});
      const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
      if (canonical(d11) !== canonical(derived)) missing.push('C D11 observation differs from the values rederived from its sealed build inventory');
    } catch (error) { missing.push(`C D11 sealed inventory cannot establish its retained measurements: ${error.message}`); }
    missing.push(...d11.missing);
    if (d11.status !== 'PASS') missing.push('C D11 artifact-build roles are not completely qualified');
    for (const name of developerBuildByteNames) {
      const rows = d11.measurements.filter(row => row?.name === name), row = rows[0];
      if (rows.length !== 1 || !Number.isSafeInteger(row.value) || row.value < 0 || row.unit !== 'bytes' || typeof row.method !== 'string' || !row.method || !row.evidence || typeof row.evidence !== 'object' || Array.isArray(row.evidence)) {
        missing.push(`C D11 measured artifact bytes unavailable or ambiguous: ${name}`); continue;
      }
      measurements[name] = structuredClone(row);
    }
    if (d11.measurements.some(row => !developerBuildByteNames.includes(row?.name))) missing.push('C D11 audit contains an unknown or runtime-only measurement');
  }
  return {d11, measurements, missing, failed: d11.status === 'FAIL' || derived?.status === 'FAIL'};
}

export function selectDeveloperStage(cell) {
  if (cell?.handler !== 'developer') throw new PrerequisiteError('This adapter accepts only developer cells');
  const stage = pStages[cell.id];
  if (stage) {
    const operation = stage === 'setup' ? 'developer.setup' : stage === 'audit' ? 'developer.audit' : 'developer.command';
    if (cell.operation !== operation) throw Error('Developer cell identity and operation disagree');
    return {kind: 'P', stage};
  }
  if (cell.id === 'I1/command-groups' && cell.operation === 'developer.command-group') return {kind: 'I1'};
  if (cell.id === 'I2/archive-update' && cell.operation === 'developer.archive-update') return {kind: 'I2'};
  if (cell.id === 'H0/setup' && cell.operation === 'developer.setup') return {kind: 'H', stage: 'setup'};
  if (cell.id === 'H6/audit' && cell.operation === 'developer.audit') return {kind: 'H', stage: 'audit'};
  throw new PrerequisiteError(`Developer cell ${cell.id} needs its own host/artifact router; no substitute command group is executed`);
}

/** Metadata returned to the runtime never invents successful tests or missing
 * D11 browser observations from a successful shell exit. */
export function normalizeDeveloperObservation(cell, observation) {
  const phases = (observation.phases ?? []).map(phase => ({...phase,
    name: phase.name ?? `developer.command.${phase.id}`, durationMs: phase.durationMs ?? phase.elapsedMs}));
  if (phases.some(phase => typeof phase.name !== 'string' || !finite(phase.durationMs))) throw Error('Malformed measured developer phase');
  const buildBytes = developerBuildByteObservation(observation, cell.budgets?.includes('D11') === true);
  const missing = [...(observation.missing ?? []), ...buildBytes.missing];
  const measurements = {...(observation.measurements ?? {}), ...buildBytes.measurements};
  const suites = observation.suites ?? [];
  if (!phases.length) missing.push('No measured developer command phases');
  if (phases.some(phase => !successful(phase.outcome) && !failed(phase.outcome))) missing.push('A developer phase has no completed outcome');
  for (const suite of suites) {
    if (!Number.isSafeInteger(suite.executed) || suite.executed <= 0 || !Array.isArray(suite.summaries) || !suite.summaries.length) missing.push(`Incomplete ${suite.mode}-${suite.group} case inventory`);
  }
  for (const rule of cell.requiredMeasurements ?? []) {
    const metric = measurements[rule.name];
    if (!metric || !finite(metric.value) || metric.unit !== rule.unit || typeof metric.method !== 'string' || !metric.method || metric.evidence === undefined) missing.push(`Required measurement unavailable: ${rule.name}`);
  }
  const didFail = failed(observation.status) || buildBytes.failed || phases.some(phase => failed(phase.outcome)) ||
    (observation.commands ?? []).some(command => !successful(command.outcome) || command.timedOut || command.interrupted) ||
    suites.some(suite => suite.summaries?.some(summary => summary.outcome !== 'PASS'));
  const status = didFail ? 'FAIL' : successful(observation.status) && !missing.length ? 'PASS' : 'INCONCLUSIVE';
  return {status, phases, measurements, missing: [...new Set(missing)], observations: observation, ...(buildBytes.d11 ? {d11: buildBytes.d11} : {}),
    evidence: observation.evidence ?? [], assertions: status === 'INCONCLUSIVE' ? [] : [{id: 'developer-observed-outcome', passed: status === 'PASS',
      evidence: {status: observation.status, commands: observation.commands?.length ?? 0, suites: suites.length}}]};
}

async function privateDirectory(path, {create = false} = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw new PrerequisiteError('Developer state requires an explicit canonical absolute directory');
  if (create) {
    if (await realpath(dirname(path)) !== dirname(path)) throw Error('Developer state parent cannot contain links');
    await mkdir(path, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path ||
    (stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw Error('Developer state must be an owner-only canonical directory');
  return path;
}

/** Matches snapshotSource's identity, including file modes, without retaining
 * complete archive bytes in memory. Every streamed source is re-statted. */
export async function developerSourceSeal(root) {
  const paths = sourcePaths(root), files = [];
  for (const path of paths) {
    const absolute = join(root, path);
    if (await realpath(absolute) !== absolute) throw Error(`Source links are not permitted: ${path}`);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat(), hash = createHash('sha256'); let bytes = 0;
      if (!before.isFile()) throw Error('Developer source must contain regular files');
      for await (const chunk of handle.createReadStream({autoClose: false})) { hash.update(chunk); bytes += chunk.length; }
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== before.size) throw Error(`Source changed during sealing: ${path}`);
      files.push({path, bytes, sha256: hash.digest('hex'), mode: before.mode & 0o777});
    } finally { await handle.close(); }
  }
  if (json(paths) !== json(sourcePaths(root))) throw Error('Source inventory changed during sealing');
  return {sha256: sha256(json(files)), files};
}

async function readState(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024 * 1024) throw Error('Invalid developer state record');
    const envelope = JSON.parse(await handle.readFile('utf8'));
    if (envelope.kind !== 'developer-runtime-state-1' || sha256(json(envelope.state)) !== envelope.sha256) throw Error('Developer state seal mismatch');
    return envelope.state;
  } finally { await handle.close(); }
}
async function writeState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(json({kind: 'developer-runtime-state-1', sha256: sha256(json(state)), state})); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

function phaseMeasurements(observation) {
  const values = {};
  for (const phase of observation.phases ?? []) if (finite(phase.elapsedMs)) values[`developer.${phase.id}.ms`] = {
    value: phase.elapsedMs, unit: 'ms', method: 'local monotonic boundary around the complete declared command phase', evidence: {phase: phase.id, outcome: phase.outcome}};
  for (const suite of observation.suites ?? []) if (Number.isSafeInteger(suite.executed)) values[`developer.${suite.mode}-${suite.group}.cases`] = {
    value: suite.executed, unit: 'count', method: 'exact framework case identities and completed reporter inventory', evidence: suite.summaries.map(summary => ({identity: summary.identity, report: summary.report}))};
  return values;
}

export async function runNativeHandoff({cell, state, save, sourceRoot, directory, pinned, registry, browserDownloadHost, handoff, ensureInputs, abortSignal}) {
  await mkdir(directory, {recursive: true});
  const result = {kind: 'developer-H-stage-1', stage: cell.id, status: 'running', commands: [], phases: [], suites: [], evidence: []};
  const start = performance.now();
  try {
    if (cell.id === 'H6/audit') {
      if (!state.h?.completed || state.h.audited) throw new PrerequisiteError('H6 needs one completed native H0 and cannot repeat');
      await verifyManifest(state.h.source, state.source.files);
      const current = await buildIdentity(state.h.source);
      if (current.digest !== state.h.buildDigest) throw Error('Native received product artifacts changed');
      for (const file of state.h.evidence) { const actual = await hashFile(file.path); if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw Error('Native setup evidence changed'); }
      result.evidence = state.h.evidence; result.productRepo = state.h.source; state.h.audited = true;
    } else {
      if (state.h) throw new PrerequisiteError('Native H0 already started; interrupted or failed preparation cannot be silently retried');
      if (!handoff || typeof handoff.manifestPath !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(handoff.sha256)) throw new PrerequisiteError('Native H0 requires a sealed ciHandoff packet');
      state.h = {active: true, output: directory}; await save();
      const manifestIdentity = await hashFile(handoff.manifestPath);
      if (manifestIdentity.sha256 !== handoff.sha256.replace(/^sha256:/, '')) throw Error('C2 handoff packet seal mismatch');
      const packet = JSON.parse(await readFile(handoff.manifestPath));
      if (packet.kind !== 'ci-c2-artifact-1' || !Array.isArray(packet.artifacts?.files) || !packet.artifacts.files.length ||
        typeof packet.root !== 'string' || !isAbsolute(packet.root) || await realpath(packet.root) !== packet.root) throw Error('Invalid C2 handoff packet');
      const subject = sourceIdentity(sourceRoot);
      if (packet.source?.commit !== subject.head || packet.source?.digest !== subject.digest) throw Error('C2 handoff belongs to a different subject revision');
      const c2Identity = await hashFile(packet.c2.receiptPath);
      if (c2Identity.sha256 !== packet.c2.sha256.replace(/^sha256:/, '')) throw Error('C2 stage receipt seal mismatch');
      const c2 = JSON.parse(await readFile(packet.c2.receiptPath));
      if (c2.kind !== 'developer-P-stage-1' || c2.stage !== 'production-build' || c2.status !== 'completed' || c2.source?.head !== subject.head || c2.source?.digest !== subject.digest ||
        !Array.isArray(c2.commands) || c2.commands.filter(command => /\.build-(app|server)$/.test(command.id)).length !== 2 || c2.commands.some(command => command.outcome !== 'PASS' || command.exitCode !== 0)) throw Error('C2 receipt does not prove both declared production builds');
      if (!packet.buildProvenance || !c2.buildProvenance) throw Error('C2 handoff lacks its immutable build provenance');
      const provenanceIdentity = await hashFile(packet.buildProvenance.path);
      if (provenanceIdentity.sha256 !== packet.buildProvenance.sha256.replace(/^sha256:/, '') || provenanceIdentity.bytes !== packet.buildProvenance.bytes ||
        provenanceIdentity.sha256 !== c2.buildProvenance.sha256 || provenanceIdentity.bytes !== c2.buildProvenance.bytes) throw Error('Relocated C2 build provenance differs from the sealed stage');
      const c2Provenance = JSON.parse(await readFile(packet.buildProvenance.path));
      if (c2Provenance.kind !== 'perf-build-provenance-1' || c2Provenance.sourceDigest !== subject.digest || c2Provenance.sourceHead !== subject.head ||
        json(c2Provenance.sourceManifest) !== json(state.source)) throw Error('C2 build provenance source binding differs');
      const buildCommands = c2.commands.filter(command => /\.build-(app|server)$/.test(command.id));
      if (json(c2Provenance.commands) !== json(buildCommands)) throw Error('C2 provenance commands differ from the retained stage');
      const relocatedCommands = [];
      for (const command of buildCommands) {
        const relocated = {...command};
        for (const stream of ['stdout', 'stderr']) {
          const original = command[stream], matches = (packet.receiptLogs ?? []).filter(log => log.originalPath === original.path);
          if (matches.length !== 1) throw Error('Handoff lacks one exact retained build log');
          const copy = matches[0], actual = await hashFile(copy.path);
          if (actual.bytes !== original.bytes || actual.sha256 !== original.sha256 || copy.bytes !== original.bytes || copy.sha256.replace(/^sha256:/, '') !== original.sha256) throw Error('Relocated build log differs');
          relocated[stream] = {path: copy.path, ...actual, originalPath: original.path};
        }
        relocatedCommands.push(relocated);
      }
      const expectedFiles = c2.artifacts.files.map(file => ({...file, path: `dist/${safeRelative(file.path)}`}));
      if (json(packet.artifacts.files) !== json(expectedFiles) || packet.artifacts.sha256.replace(/^sha256:/, '') !== sha256(json(expectedFiles))) throw Error('C2 handoff artifact inventory differs from its receipt');
      for (const file of expectedFiles) {
        if (!safeRelative(file.path).startsWith('dist/')) throw Error('Handoff must contain only product dist files');
        const actual = await hashFile(join(packet.root, file.path));
        if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw Error(`Received product artifact differs: ${file.path}`);
      }
      const workspace = await createWorkspace(sourceRoot, state.source.files.map(file => file.path));
      if (workspace.sourceManifest.sha256 !== state.source.sha256) throw Error('Native workspace source differs from sealed revision');
      const inputPacket = await ensureInputs();
      result.testInputs = await installInputs({root: workspace.source, packet: inputPacket.path});
      const warm = cell.parameters?.cache === 'normal';
      if (warm && !state.hWarmCaches) throw new PrerequisiteError('Normal native H0 requires its explicit owned cache prime');
      const npmCache = warm ? state.hWarmCaches.npm : join(workspace.workspace, 'npm-cache');
      const browserCache = warm ? state.hWarmCaches.browsers : join(workspace.workspace, 'browser-cache');
      if (!warm) { await mkdir(npmCache); await mkdir(browserCache); }
      state.h = {...workspace, completed: false, sourceDigest: subject.digest, handoff: {path: handoff.manifestPath, ...manifestIdentity}, npmCache, browserCache}; await save();
      const environment = await cleanEnvironment({workspace: join(directory, 'environment'), npmCache, browserCache, registry, browserDownloadHost});
      const command = async (id, args) => {
        const observed = await execute({id, command: [pinned.executable, ...args], cwd: workspace.source, env: environment, directory: join(directory, 'logs'), timeoutMs: 420000, abortSignal});
        result.commands.push(observed); assertSuccess(observed); return observed;
      };
      await command('native-vendor-before', [pinned.npmCli, 'run', 'verify:vendor']);
      if (warm) await command('native-cache-verify', [pinned.npmCli, 'cache', 'verify']);
      await command('native-install', [pinned.npmCli, 'ci', '--no-audit', '--no-fund', ...(warm ? ['--offline'] : [])]);
      result.dependencies = await auditDependencies(workspace.source, state.lock);
      await command('native-vendor-verification', [pinned.npmCli, 'run', 'verify:vendor']);
      if (!warm) await command('native-browser-install', ['node_modules/@playwright/test/cli.js', 'install', 'chromium']);
      const browserRecord = join(directory, 'native-browsers.json');
      const expectedBrowser = join(directory, 'expected-native-browser-cache.json');
      if (warm) await writeFile(expectedBrowser, json(state.hWarmCaches.identity), {flag: 'wx', mode: 0o600});
      await command('native-browser-verify', ['tooling/qualification/developer-campaigns/verify-browsers.mjs', browserRecord, 'chromium', ...(warm ? [expectedBrowser] : [])]);
      result.browsers = JSON.parse(await readFile(browserRecord)); state.h.browserIdentity = result.browsers;
      if (warm && json(result.browsers.engines) !== json(state.hWarmCaches.identity.engines)) throw Error('Native warm browser identity changed');
      for (const file of expectedFiles) { const destination = join(workspace.source, file.path); await mkdir(dirname(destination), {recursive: true}); await copyFile(join(packet.root, file.path), destination, constants.COPYFILE_EXCL); }
      const product = await buildIdentity(workspace.source);
      if (product.digest !== c2Provenance.buildDigest) throw Error('Native received product identity differs from C2 provenance');
      const nativeProvenance = {kind: 'perf-build-provenance-1', sourceDigest: subject.digest, sourceHead: subject.head, buildDigest: product.digest,
        sourceManifest: state.source, subjectSourceManifest: subject.files, sourceRepo: sourceRoot, productRepo: workspace.source,
        commands: relocatedCommands, handoff: {path: handoff.manifestPath, ...manifestIdentity}, nativeInstall: result.commands};
      const provenancePath = join(directory, 'build-provenance.json'); await writeFile(provenancePath, json(nativeProvenance), {flag: 'wx', mode: 0o600});
      result.buildProvenance = {path: provenancePath, ...await hashFile(provenancePath)};
      const smokeRoot = join(directory, 'native-smoke-root'); await mkdir(smokeRoot, {mode: 0o700});
      const smoke = "import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path'; const {startLocalServer}=await import(pathToFileURL(resolve('dist/local/server/http.js')).href); const server=await startLocalServer({root:process.argv[1],staticDirectory:resolve('dist/app'),credentialConfigured:false}); try { const response=await fetch(server.origin); assert.equal(response.status,200); await response.arrayBuffer(); console.log(JSON.stringify({nativeBackendReady:true,providerConfigured:false})); } finally {await server.close();}";
      // This smoke deliberately makes one HTTP request to the native listener.
      // Its session guard permits only literal 127.0.0.1; the all-network-denied
      // storage preload belongs to writer-only assertions, not this client.
      await command('native-backend-readiness', ['--import', './tests/session/no-egress.mjs', '--input-type=module', '-e', smoke, smokeRoot]);
      await verifyManifest(workspace.source, state.source.files);
      if ((await buildIdentity(workspace.source)).digest !== product.digest) throw Error('Native setup changed received product outputs');
      state.h.completed = true; state.h.buildDigest = product.digest; state.h.evidence = [result.buildProvenance, {path: packet.buildProvenance.path, ...provenanceIdentity}, {path: packet.c2.receiptPath, ...c2Identity}, state.h.handoff];
      state.productRepo = result.productRepo = workspace.source; state.sourceDigest = subject.digest; state.buildProvenancePath = provenancePath;
      state.playwrightBrowsersPath = browserCache;
      result.evidence = state.h.evidence; result.cacheTreatment = warm ? 'explicit owned primed native caches; clean offline native npm ci; no received node_modules' : 'fresh native npm cache and clean native install; no received node_modules';
      result.backendLifetime = 'Readiness smoke closes its server; each H browser cell owns its subsequent server process';
    }
    abort(abortSignal); result.status = 'completed';
  } catch (error) { result.status = error.code === 'CAMPAIGN_PREREQUISITE' ? 'inconclusive' : 'failed'; result.failure = String(error); revokeProduct(state); }
  result.phases.push({id: cell.id === 'H6/audit' ? 'native-artifact-audit' : 'native-handoff-setup', outcome: result.status === 'completed' ? 'PASS' : result.status === 'failed' ? 'FAIL' : 'INCONCLUSIVE', elapsedMs: performance.now() - start});
  const receiptPath = join(directory, 'stage.json');
  await writeFile(receiptPath, json(result), {flag: 'wx', mode: 0o600}); await save();
  if (abortSignal?.aborted) {
    result.status = 'failed'; result.failure = 'Native developer stage interrupted before publication'; result.phases.at(-1).outcome = 'FAIL';
    revokeProduct(state);
    if (state.h) { state.h.completed = false; state.h.audited = false; state.h.failure = result.failure; }
    await writeFile(receiptPath, json(result)); await save();
  }
  return result;
}

/** This helper executes only one P stage. The persisted stage journal refuses
 * skipped prerequisites, duplicate starts, and continuation after a failure. */
export async function runDeveloperStage({cell, stage, state, save, sourceRoot, directory, pinned, focused, registry, browserDownloadHost, ensureInputs, abortSignal}) {
  await mkdir(directory, {recursive: true});
  const result = {kind: 'developer-P-stage-1', stage, status: 'running', commands: [], phases: [], suites: [], edits: [], evidence: [], startedAt: new Date().toISOString()};
  const record = state.p;
  const source = record.source, expectedIndex = record.completed.length;
  if (record.failure || record.active || stageOrder[expectedIndex] !== stage) throw new PrerequisiteError(`P stage ${stage} requires completed stages in order without interrupted work; expected ${stageOrder[expectedIndex] ?? 'new session'}`);
  record.active = {stage, directory, startedAt: result.startedAt}; await save();
  await verifyManifest(source, state.source.files);
  const environment = await cleanEnvironment({workspace: join(directory, 'environment'), npmCache: record.npmCache, browserCache: record.browserCache, registry, browserDownloadHost});
  const persist = async () => { await writeFile(join(directory, 'stage.json'), json(result)); await save(); };
  const command = async (id, args, extra = {}, executable = pinned.executable, timeoutMs = 300000) => {
    abort(abortSignal);
    const observed = await execute({id: `${String(result.commands.length + 1).padStart(3, '0')}.${id}`, command: [executable, ...args], cwd: source,
      env: {...environment, ...extra}, directory: join(directory, 'logs'), timeoutMs, abortSignal});
    result.commands.push(observed); await persist(); assertSuccess(observed); return observed;
  };
  const npm = (id, args, extra = {}) => command(id, [pinned.npmCli, ...args], extra);
  const phase = async (id, action, scored = true) => {
    const start = performance.now(), entry = {id, scored, outcome: 'FAIL'}; result.phases.push(entry);
    try { await action(); entry.outcome = 'PASS'; }
    finally { entry.elapsedMs = performance.now() - start; await persist(); }
    if (scored && commandBudgets[id] && entry.elapsedMs > commandBudgets[id][2]) { entry.outcome = 'FAIL'; throw Error(`${id} measured ceiling exceeded`); }
  };
  const build = async () => { await npm('build-app', ['run', 'build:app']); await npm('build-server', ['run', 'build:server']); };
  const types = async () => {
    for (const [id, config] of [['consumer', 'tsconfig.json'], ['app', 'tsconfig.app.json'], ['server', 'tsconfig.server.json']])
      await command(`incremental-types-${id}`, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', join(record.workspace, `${id}.tsbuildinfo`), '-p', config]);
  };
  try {
    if (stage === 'setup') await phase('setup', async () => {
      const packet = await ensureInputs();
      record.testInputs = result.testInputs = await installInputs({root: source, packet: packet.path});
      await npm('vendor', ['run', 'verify:vendor']);
    }, false);
    else if (stage === 'clean-install') {
      const warm = cell.parameters.cache === 'normal'; record.cache = warm ? 'warm' : 'cold';
      if (await lstat(join(source, 'node_modules')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw Error('C1 requires absent node_modules');
      if (!warm && (await readdir(record.npmCache)).length) throw Error('Cold npm cache is not empty');
      if (warm && !record.npmPrime) throw new PrerequisiteError('Normal-cache P needs an explicitly retained cache prime');
      await phase(`install-${record.cache}`, async () => {
        await npm('vendor-before', ['run', 'verify:vendor']);
        if (warm) await npm('cache-verify', ['cache', 'verify']);
        await npm('install', ['ci', '--no-audit', '--no-fund', ...(warm ? ['--offline'] : [])]);
        await npm('dependency-graph', ['ls', '--all', '--json']); await npm('vendor-after', ['run', 'verify:vendor']);
        result.dependencies = await auditDependencies(source, state.lock);
      });
    } else if (stage === 'full-types') await phase('full-types', () => npm('full-types', ['run', 'typecheck']));
    else if (stage === 'production-build') {
      if (await lstat(join(source, 'dist')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw Error('C2 production build requires fresh outputs');
      const before = sourceIdentity(sourceRoot);
      await phase('cold-build', build); record.artifacts = result.artifacts = await auditBuild(source, {d11Output: join(directory, 'd11-build.json')});
      result.d11 = result.artifacts.d11;
      if (result.d11?.artifact) result.evidence.push(result.d11.artifact);
      if (result.d11?.status === 'FAIL') throw Error('D11 production artifact budget or lazy-loading requirement failed');
      if (sourceIdentity(sourceRoot).digest !== before.digest) throw Error('Subject source changed while producing C2 artifacts');
      const built = await buildIdentity(source);
      result.source = {head: before.head, digest: before.digest};
      const provenance = {kind: 'perf-build-provenance-1', sourceDigest: before.digest, sourceHead: before.head, buildDigest: built.digest,
        sourceManifest: state.source, subjectSourceManifest: before.files,
        sourceRepo: sourceRoot, productRepo: source, commands: result.commands.filter(command => /\.build-(app|server)$/.test(command.id)),
        builtAt: new Date().toISOString()};
      const path = join(directory, 'build-provenance.json'); await writeFile(path, json(provenance), {flag: 'wx', mode: 0o600});
      record.buildProvenance = result.buildProvenance = {path, ...await hashFile(path)}; result.evidence.push(result.buildProvenance);
      state.productRepo = source; state.sourceDigest = before.digest; state.buildProvenancePath = path;
    } else if (stage.startsWith('incremental-')) {
      const scope = editScopes.find(scope => stage === `incremental-${scope.id}`);
      await phase(`${scope.id}-prime`, async () => { await types(); await build(); }, false);
      await withTemporaryEdit(join(source, scope.path), scope, async edit => {
        result.edits.push(edit); await phase(`${scope.id}-types`, types); await phase(`${scope.id}-build`, build);
        edit.artifacts = await auditBuild(source);
      }, async edit => {
        await phase(`${scope.id}-restore`, async () => { await types(); await build(); }, false);
        edit.restoredArtifacts = await auditBuild(source);
        if (edit.restoredArtifacts.sha256 !== record.artifacts.sha256) throw Error(`Restored artifact identity differs: ${scope.id}`);
      });
    } else if (/^(focused|full)-(unit|integration)$/.test(stage)) {
      const [mode, group] = stage.split('-');
      await phase(stage, async () => result.suites.push(await runNodeSelection({source, directory, group, mode, focused, inventory: await discoverNodeFiles(source), command, pinned, abortSignal})));
    } else if (stage === 'browser-cache') {
      const cold = cell.parameters.cache === 'cold';
      await phase(`browser-${cold ? 'cold' : 'warm'}`, async () => {
        if (cold) await command('browser-install', ['node_modules/@playwright/test/cli.js', 'install', 'chromium']);
        else if (!record.browserPrime) throw new PrerequisiteError('Normal-cache browser verification requires an explicit retained prime');
        const browserRecord = join(directory, 'browsers.json');
        const expectedBrowser = join(directory, 'expected-browser-cache.json');
        if (!cold) await writeFile(expectedBrowser, json(record.browserPrime.identity), {flag: 'wx', mode: 0o600});
        await command('browser-verify', ['tooling/qualification/developer-campaigns/verify-browsers.mjs', browserRecord, 'chromium', ...(!cold ? [expectedBrowser] : [])]);
        result.browsers = JSON.parse(await readFile(browserRecord)); record.browserIdentity = result.browsers;
        if (!cold && json(result.browsers.engines) !== json(record.browserPrime.identity.engines)) throw Error('Warm P browser cache identity changed');
      });
    } else if (stage.endsWith('-browser')) {
      const mode = stage.split('-')[0];
      const fixtureRoot = record.browserPrerequisites?.fixtureRoot ?? join(directory, 'full-browser');
      const plan = createBrowserPlan({selection: 'chromium', scope: 'features', output: join(directory, 'full-browser'), fixtureRoot});
      if (record.browserPrerequisites && (!record.browserPrerequisites.fixtureRoot || !Array.isArray(record.browserPrerequisites.outputs))) throw new PrerequisiteError('Legacy browser preparation has no output seal; start a fresh owned campaign workspace');
      if (!record.browserPrerequisites) {
        await phase('browser-prerequisites', async () => { for (const step of plan.steps.filter(step => !step.config)) await npm(step.id, step.args, step.env); }, false);
        record.browserPrerequisites = {fixtureRoot, outputs: await Promise.all([join(source,'dist/consumer'),...plan.steps.filter(step => !step.config && step.output).map(step=>step.output)].map(async path => ({path, files: await fileManifest(path)})))};
      }
      for (const output of record.browserPrerequisites.outputs) await verifyManifest(output.path, output.files);
      await phase(stage, async () => result.suites.push(await runBrowserSelection({source, directory, mode, focused, plan, command, pinned})));
      if (mode === 'full') await phase('browser-cache-audit', async () => {
        if (!record.browserIdentity?.cache?.sha256) throw new PrerequisiteError('P browser suites require their earlier sealed browser distribution identity');
        const current = await browserCacheIdentity(record.browserCache);
        if (current.sha256 !== record.browserIdentity.cache.sha256) throw Error('P browser distribution changed during suite execution');
        result.browserCacheAfter = current;
      }, false);
    } else if (stage === 'audit') await phase('artifact-audit', async () => {
      result.dependencies = await auditDependencies(source, state.lock); result.artifacts = await auditBuild(source);
      // C6 may add explicitly declared test-consumer outputs. Every original
      // C2 production file must still match its seal; retain the later full
      // manifest rather than pretending the extra test artifacts never exist.
      await verifyManifest(join(source, 'dist'), record.artifacts.files);
      for (const previous of record.receipts) {
        const actual = await hashFile(previous.path); if (actual.sha256 !== previous.sha256 || actual.bytes !== previous.bytes) throw Error('Earlier P stage receipt changed');
      }
      result.evidence.push(...record.receipts); result.counts = record.suites;
      result.cacheRatioClaim = false;
    }, false);
    await verifyManifest(source, state.source.files); abort(abortSignal);
    result.status = 'completed'; record.completed.push(stage); record.suites.push(...result.suites); record.active = null;
  } catch (error) { result.status = error.code === 'CAMPAIGN_PREREQUISITE' ? 'inconclusive' : 'failed'; result.failure = String(error); record.failure = {stage, failure: result.failure}; revokeProduct(state); }
  result.finishedAt = new Date().toISOString(); result.measurements = {...phaseMeasurements(result), ...developerBuildByteObservation(result).measurements};
  try {
    abort(abortSignal); await persist(); abort(abortSignal);
    record.receipts.push({path: join(directory, 'stage.json'), ...await hashFile(join(directory, 'stage.json'))}); await save(); abort(abortSignal);
  } catch (error) {
    result.status = 'failed'; result.failure = String(error); record.failure = {stage, failure: result.failure};
    revokeProduct(state);
    record.completed.length = expectedIndex; record.active = {stage, directory, interruptedOrPublicationFailed: true};
    record.receipts = record.receipts.filter(receipt => receipt.path !== join(directory, 'stage.json'));
    await persist();
  }
  return result;
}

export async function createDeveloperAdapter(context, injected = {}) {
  const config = context.configuration ?? {}, repo = await realpath(context.repo);
  const stateDirectory = await privateDirectory(config.developerStateDirectory, {create: true});
  if (stateDirectory === repo || stateDirectory.startsWith(repo + sep)) throw new PrerequisiteError('Developer state must be outside the live subject checkout');
  if (config.developerInstall !== true) throw new PrerequisiteError('Developer execution requires configuration.developerInstall:true for isolated installs');
  const dependencies = {sourceSeal: developerSourceSeal, toolchain, readFocused, createWorkspace, prepareInputs, verifyInputs, runDeveloperGroup, runDeveloperStage, runNativeHandoff, ...injected};
  const statePath = join(stateDirectory, 'bridge-state.json'), lockPath = join(stateDirectory, 'bridge.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new PrerequisiteError('Developer state is already owned by another process or has an interrupted lock'); throw error; }
  let state, selected, prepared, closed = false;
  const save = () => writeState(statePath, state);
  const ensureInputs = async () => {
    if (!state.inputPacket) {
      const path = config.developerInputPacket ?? join(stateDirectory, 'test-inputs');
      if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw new PrerequisiteError('Developer input packet must have a canonical absolute path');
      if (!config.developerInputPacket) await dependencies.prepareInputs({root: repo, output: path});
      const checked = await dependencies.verifyInputs({packet: path});
      state.inputPacket = {path, manifestSha256: checked.manifestSha256}; await save();
      await context.trace?.({event: 'developer-test-inputs-prepared', inputPacket: state.inputPacket});
    } else {
      const checked = await dependencies.verifyInputs({packet: state.inputPacket.path});
      if (checked.manifestSha256 !== state.inputPacket.manifestSha256) throw Error('Developer input packet identity changed');
    }
    return state.inputPacket;
  };
  const sourceCheck = async () => {
    const actual = await dependencies.sourceSeal(repo);
    if (actual.sha256 !== state.source.sha256) throw Error('Developer source changed after session preparation');
    return actual;
  };
  const sampleDirectory = (cell, attempt) => join(context.output, `${cell.id.replaceAll('/', '-')}-${attempt.cache}-${attempt.ordinal}${attempt.prime ? '-prime' : ''}`);
  try {
    await lock.writeFile(json({pid: process.pid, output: context.output})); await lock.sync();
    const source = await dependencies.sourceSeal(repo), pinned = await dependencies.toolchain(repo), focused = await dependencies.readFocused(repo);
    const identity = {repo, source: source.sha256, toolchain: pinned, focused: sha256(json(focused)), registry: config.developerRegistry ?? null, browserDownloadHost: config.developerBrowserDownloadHost ?? null, inputPacket: config.developerInputPacket ?? null};
    state = await readState(statePath);
    if (state && state.identity !== sha256(json(identity))) throw Error('Developer state belongs to a different source, toolchain, selector, or registry');
    if (!state) {
      state = {identity: sha256(json(identity)), source: structuredClone(source), pinned, focused, lock: sha256(await readFile(join(repo, 'package-lock.json'))), p: null, i1: {samples: [], warmCaches: null}, i2: {samples: []}};
      await save();
    }
    return {
      async prepareCell(cell) {
        abort(context.signal); selected = selectDeveloperStage(cell); prepared = cell.id; await sourceCheck();
        if (selected.kind === 'P' && !state.p) {
          if (selected.stage !== 'setup') throw new PrerequisiteError('Run C0/setup before continuing the P developer session');
          const workspace = await dependencies.createWorkspace(repo, state.source.files.map(file => file.path));
          if (workspace.sourceManifest.sha256 !== state.source.sha256) throw Error('Prepared P workspace differs from sealed subject source');
          const npmCache = join(workspace.workspace, 'npm-cache'), browserCache = join(workspace.workspace, 'browser-cache');
          await mkdir(npmCache); await mkdir(browserCache);
          state.p = {...workspace, npmCache, browserCache, completed: [], receipts: [], suites: [], failure: null}; await save();
        }
        if (selected.kind === 'I2' && !config.developerArchiveRecipePath) throw new PrerequisiteError('I2 requires a sealed developerArchiveRecipePath');
        if (selected.kind === 'H' && selected.stage === 'setup' && !config.ciHandoff) throw new PrerequisiteError('H0 requires a sealed ciHandoff packet');
        return {kind: selected.kind, source: state.source.sha256, stateDirectory, sharedPWorkspace: state.p?.workspace ?? null};
      },
      async resetCell(cell, attempt) {
        if (prepared !== cell.id) throw Error('Prepare this exact developer cell before reset');
        abort(context.signal); await sourceCheck();
        const primeEvidence = [];
        if (selected.kind === 'H' && selected.stage === 'setup' && cell.parameters?.cache === 'normal' && !state.hWarmCaches) {
          if (config.developerWarmPrime !== true || state.hWarmPrimeAttempt) throw new PrerequisiteError('Normal H0 requires one explicit, previously unattempted native cache prime');
          const directory = join(context.output, 'explicit-native-prime'); await mkdir(directory);
          state.hWarmPrimeAttempt = {directory, status: 'running'}; await save();
          const workspace = await dependencies.createWorkspace(repo, state.source.files.map(file => file.path));
          if (workspace.sourceManifest.sha256 !== state.source.sha256) throw Error('Native cache-prime source identity differs');
          const caches = {npm: join(stateDirectory, 'h-warm-npm'), browsers: join(stateDirectory, 'h-warm-browsers')};
          const environment = await cleanEnvironment({workspace: workspace.workspace, npmCache: caches.npm, browserCache: caches.browsers, registry: config.developerRegistry, browserDownloadHost: config.developerBrowserDownloadHost});
          const commands = [], run = async (id, args) => { const observed = await execute({id, command: [pinned.executable, ...args], cwd: workspace.source, env: environment, directory, abortSignal: context.signal}); commands.push(observed); assertSuccess(observed); };
          await run('vendor-before', [pinned.npmCli, 'run', 'verify:vendor']);
          await run('prime-ci', [pinned.npmCli, 'ci', '--no-audit', '--no-fund']);
          await run('prime-browser', ['node_modules/@playwright/test/cli.js', 'install', 'chromium']);
          await run('prime-browser-verify', ['tooling/qualification/developer-campaigns/verify-browsers.mjs', join(directory, 'browsers.json'), 'chromium']);
          const evidence = {kind: 'native-cache-prime', source: state.source.sha256, workspace: workspace.workspace, commands, scored: false};
          const path = join(directory, 'prime.json'); await writeFile(path, json(evidence), {flag: 'wx', mode: 0o600});
          abort(context.signal);
          state.hWarmPrimeAttempt.status = 'PASS'; state.hWarmCaches = {...caches, identity: JSON.parse(await readFile(join(directory, 'browsers.json'))), receipt: {path, ...await hashFile(path)}};
          primeEvidence.push(evidence); await save(); await context.trace?.({event: 'developer-explicit-unscored-prime', observation: evidence});
        }
        if (selected.kind === 'I1') await ensureInputs();
        if (selected.kind === 'I1' && attempt.cache === 'warm' && !state.i1.warmCaches) {
          if (config.developerWarmPrime !== true || state.i1.primeAttempt) throw new PrerequisiteError('Warm I1 requires one explicit, previously unattempted cache prime');
          const caches = {npm: join(stateDirectory, 'i1-warm-npm'), browsers: join(stateDirectory, 'i1-warm-browsers')};
          state.i1.primeAttempt = {directory: join(context.output, 'i1-explicit-warm-prime'), status: 'running'}; await save();
          const prime = await dependencies.runDeveloperGroup({sourceRoot: repo, paths: state.source.files.map(file => file.path), expectedSource: state.source.sha256,
            directory: join(context.output, 'i1-explicit-warm-prime'), cache: 'warm', ordinal: 0, warmCaches: caches, pinned, focused,
            registry: config.developerRegistry, browserDownloadHost: config.developerBrowserDownloadHost, inputPacket: state.inputPacket.path, abortSignal: context.signal, primeOnly: true});
          primeEvidence.push(prime); await context.trace?.({event: 'developer-explicit-unscored-prime', observation: prime});
          if (prime.status !== 'completed') throw Error('Explicit I1 warm-cache prime failed');
          abort(context.signal); state.i1.primeAttempt.status = 'PASS';
          state.i1.warmCaches = caches; state.i1.prime = {path: join(context.output, 'i1-explicit-warm-prime', 'group.json'), ...await hashFile(join(context.output, 'i1-explicit-warm-prime', 'group.json'))}; await save();
        }
        if (selected.kind === 'P' && ['clean-install', 'browser-cache'].includes(selected.stage) && cell.parameters.cache === 'normal') {
          const kind = selected.stage === 'clean-install' ? 'npmPrime' : 'browserPrime';
          if (!state.p[kind]) {
            state.p.primeAttempts ??= {};
            if (config.developerWarmPrime !== true || state.p.primeAttempts[kind]) throw new PrerequisiteError('Normal P caches require one explicit, previously unattempted cache prime');
            state.p.primeAttempts[kind] = {output: context.output, status: 'running'}; await save();
            const primeWorkspace = await dependencies.createWorkspace(repo, state.source.files.map(file => file.path));
            if (primeWorkspace.sourceManifest.sha256 !== state.source.sha256) throw Error('Cache-prime source identity differs');
            const directory = join(context.output, `explicit-${kind}`); await mkdir(directory);
            const environment = await cleanEnvironment({workspace: primeWorkspace.workspace, npmCache: state.p.npmCache, browserCache: state.p.browserCache, registry: config.developerRegistry, browserDownloadHost: config.developerBrowserDownloadHost});
            const commands = [], run = async (id, args) => { const result = await execute({id, command: [pinned.executable, ...args], cwd: primeWorkspace.source, env: environment, directory, abortSignal: context.signal}); commands.push(result); assertSuccess(result); };
            await run('vendor-before', [pinned.npmCli, 'run', 'verify:vendor']);
            await run('prime-ci', [pinned.npmCli, 'ci', '--no-audit', '--no-fund']);
            if (kind === 'browserPrime') {
              await run('prime-browser', ['node_modules/@playwright/test/cli.js', 'install', 'chromium']);
              await run('prime-browser-verify', ['tooling/qualification/developer-campaigns/verify-browsers.mjs', join(directory, 'browsers.json'), 'chromium']);
            }
            const evidence = {kind, source: state.source.sha256, workspace: primeWorkspace.workspace, commands, scored: false};
            const path = join(directory, 'prime.json'); await writeFile(path, json(evidence), {flag: 'wx', mode: 0o600});
            abort(context.signal); state.p.primeAttempts[kind].status = 'PASS';
            state.p[kind] = {path, ...await hashFile(path), ...(kind === 'browserPrime' ? {identity: JSON.parse(await readFile(join(directory, 'browsers.json')))} : {})};
            primeEvidence.push(evidence); await save(); await context.trace?.({event: 'developer-explicit-unscored-prime', observation: evidence});
          }
        }
        return {kind: 'developer-sample-reset-1', cache: attempt.cache, ordinal: attempt.ordinal, source: state.source.sha256,
          freshWorkspaceInAction: selected.kind !== 'P', sharedWorkspace: selected.kind === 'P' ? state.p.workspace : null, primeEvidence};
      },
      async execute(cell, attempt) {
        if (prepared !== cell.id) throw Error('Prepare this exact developer cell before execution');
        abort(context.signal); await sourceCheck(); const directory = sampleDirectory(cell, attempt);
        let observation, marker;
        try {
        if (selected.kind === 'P') observation = await dependencies.runDeveloperStage({cell, stage: selected.stage, state, save, sourceRoot: repo, directory, pinned, focused, registry: config.developerRegistry, browserDownloadHost: config.developerBrowserDownloadHost, ensureInputs, abortSignal: context.signal});
        else if (selected.kind === 'H') observation = await dependencies.runNativeHandoff({cell, state, save, sourceRoot: repo, directory, pinned, registry: config.developerRegistry,
          browserDownloadHost: config.developerBrowserDownloadHost, handoff: config.ciHandoff, ensureInputs, abortSignal: context.signal});
        else {
          const samples = selected.kind === 'I1' ? state.i1.samples : state.i2.samples;
          const id = `${attempt.cache}-${attempt.ordinal}`;
          const expected = samples.length < 5 ? `cold-${samples.length + 1}` : `warm-${samples.length - 4}`;
          if (attempt.prime || !['cold', 'warm'].includes(attempt.cache) || !Number.isInteger(attempt.ordinal) || attempt.ordinal < 1 || attempt.ordinal > 5 || samples.some(sample => sample.id === id) || id !== expected) throw Error('Invalid, duplicate, or out-of-order developer campaign sample');
          if (samples.some(sample => sample.status !== 'PASS')) throw new PrerequisiteError('An earlier developer sample failed or remains incomplete; use a new complete session');
          marker = {id, status: 'running', output: directory}; samples.push(marker); await save();
          if (selected.kind === 'I1') observation = await dependencies.runDeveloperGroup({sourceRoot: repo, paths: state.source.files.map(file => file.path), expectedSource: state.source.sha256,
            directory, cache: attempt.cache, ordinal: attempt.ordinal, warmCaches: state.i1.warmCaches ?? {}, pinned, focused, registry: config.developerRegistry, browserDownloadHost: config.developerBrowserDownloadHost,
            inputPacket: (await ensureInputs()).path, abortSignal: context.signal});
          else {
            const runSample = dependencies.runArchiveSample ?? (await import('./archive.mjs')).runArchiveSample;
            if (typeof runSample !== 'function') throw new PrerequisiteError('Single-start archive adapter is unavailable');
            observation = await runSample({sourceRoot: repo, output: directory, recipePath: config.developerArchiveRecipePath, cache: attempt.cache, ordinal: attempt.ordinal,
              cacheStateDirectory: join(stateDirectory, 'archive-cache-state'), abortSignal: context.signal, install: true, registry: config.developerRegistry, timingLease: context.timingLease});
            const run = observation.run ?? observation.runs?.[0];
            observation.phases = Object.entries(run?.timings ?? {}).map(([id, elapsedMs]) => ({id: `archive.${id}`, name: `developer.archive.${id}`, elapsedMs, outcome: run?.status === 'passed' ? 'PASS' : 'FAIL'}));
            observation.suites ??= []; if (run?.browserCounts?.passed !== 2) observation.missing = [...(observation.missing ?? []), 'Exact two completed archive consumer cases'];
          }
          observation.measurements = {...phaseMeasurements(observation), ...(observation.measurements ?? {})};
        }
        await sourceCheck(); abort(context.signal);
        await context.trace?.({event: 'developer-sample-complete', cell: cell.id, observation});
        abort(context.signal);
        const result = normalizeDeveloperObservation(cell, observation);
        if (marker) { marker.status = result.status; await save(); abort(context.signal); }
        return result;
        } catch (error) {
          if (marker) { marker.status = 'FAIL'; marker.failure = String(error); }
          if (selected.kind === 'P' && state.p) state.p.failure = {stage: selected.stage, failure: String(error)};
          if (selected.kind === 'H' && state.h) { state.h.completed = false; state.h.failure = String(error); }
          if (['P', 'H'].includes(selected.kind)) revokeProduct(state);
          await save(); throw error;
        }
      },
      async close() {
        if (closed) return {closed: true}; closed = true;
        await lock.close(); await unlink(lockPath);
        return {closed: true, retainedState: stateDirectory, retainedPWorkspace: state.p?.workspace ?? null};
      },
    };
  } catch (error) { await lock.close(); await unlink(lockPath); throw error; }
}
