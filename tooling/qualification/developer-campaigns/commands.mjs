import {readFile, writeFile, mkdir, lstat, realpath} from 'node:fs/promises';
import {join, dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {editScopes, withTemporaryEdit} from '../dev.mjs';
import {evaluateCohort, nearestRank} from '../statistics.mjs';
import {createBrowserPlan} from '../container/browser-plan.mjs';
import {prepareInputs, installInputs} from '../container/inputs.mjs';
import {json, sha256, hashFile, fileManifest, verifyManifest, sourcePaths, createWorkspace, toolchain, cleanEnvironment, execute, assertSuccess, observedEnvironment, createRun} from './common.mjs';
import {readFocused, discoverNodeFiles} from './selectors.mjs';
import {runNodeSelection, runBrowserSelection} from './suites.mjs';
import {browserCacheIdentity} from './verify-browsers.mjs';
import {loadD11Build} from '../campaigns/browser-d11-build.mjs';
import {REQUIRED_MEASUREMENT_REGISTRY} from '../campaigns/inventory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const commandBudgets = Object.freeze({
  'install-cold': ['D01', 120000, 240000], 'install-warm': ['D01', 60000, 120000],
  'browser-cold': ['D02', 180000, 300000], 'browser-warm': ['D02', 15000, 45000],
  'full-types': ['D04', 10000, 20000], 'cold-build': ['D03', 30000, 60000],
  'public-leaf-types': ['D04', 1000, 3000], 'domain-type-types': ['D04', 1000, 3000],
  'public-leaf-build': ['D04', 2000, 5000], 'domain-type-build': ['D04', 2000, 5000],
  'focused-unit': ['D06', 2000, 5000], 'full-unit': ['D07', 15000, 30000],
  'focused-integration': ['D06', 5000, 10000], 'full-integration': ['D07', 30000, 60000],
  'focused-browser': ['D06', 15000, 30000], 'full-browser': ['D07', 60000, 120000],
});
export function commandSchedule() {
  return ['cold', 'warm'].flatMap(cache => Array.from({length: 5}, (_, i) => ({id: `${cache}-${i + 1}`, cache, ordinal: i + 1})));
}
export function developerCommandPlan() {
  return {kind: 'developer-command-campaign-plan-1', job: 'I1', schedule: commandSchedule(), budgets: commandBudgets,
    cache: {cold: 'Each group has fresh source, empty node_modules/output/build/npm/browser caches.', warm: 'Fresh source/node_modules/output/build caches; same campaign-owned primed npm/browser caches, immutable version/key checks retained.'},
    samples: 'Ten complete independent command groups. I0 observations are never reused. Each group includes all C1–C6 commands and exact two edit scopes/restores.',
    requiredFocusedCounts: {unit: 100, integration: 10, browser: 5},
    fullCounts: 'Discovered from every declared full suite; no trimming to WD 2000/100/30 sizing envelope. Excess cases create a visible PERF-A08 amendment requirement.',
    workers: 'Existing repository serial guards/workers preserved; proposed two-correctness-worker C profile is not claimed.',
    qualification: false};
}
export async function auditDependencies(source, lockIdentity) {
  const lockBytes = await readFile(join(source, 'package-lock.json'));
  if (sha256(lockBytes) !== lockIdentity) throw Error('Install changed the sealed lock');
  const lock = JSON.parse(lockBytes);
  for (const [path, value] of Object.entries(lock.packages)) {
    if (!path) continue;
    const absolute = join(source, path), stat = await lstat(absolute).catch(error => { if (error.code === 'ENOENT' && value.optional) return null; throw error; });
    if (!stat) continue;
    if (!path.startsWith('node_modules/') || path.split('/').includes('..') || stat.isSymbolicLink() || !(await realpath(absolute)).startsWith(join(source, 'node_modules') + sep)) throw Error(`Linked or external installed dependency: ${path}`);
    if (JSON.parse(await readFile(join(absolute, 'package.json'))).version !== value.version) throw Error(`Installed dependency version mismatch: ${path}`);
  }
  return {lock: lockIdentity, packages: Object.keys(lock.packages).length - 1};
}
const d11BuildRules = REQUIRED_MEASUREMENT_REGISTRY.D11.filter(rule => rule.scope === 'artifact-build');
const canonicalD11 = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonicalD11(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonicalD11(value[key]))])) : value);
const d11Identity = /^sha256:[a-f0-9]{64}$/;
const byteCount = value => Number.isSafeInteger(value) && value >= 0;

/** Account only for roles established by the sealed production build reader.
 * This is artifact accounting, never an assertion about browser evaluation. */
export function observeD11Build(inventory, {artifact} = {}) {
  const {sha256: identity, ...contents} = inventory ?? {};
  if (inventory?.kind !== 'perf-d11-build-1' || !d11Identity.test(identity ?? '') || identity !== 'sha256:' + sha256(canonicalD11(contents))) throw Error('D11 build inventory seal is invalid');
  if (!Array.isArray(inventory.files) || !inventory.files.length) throw Error('D11 emitted file inventory is missing');
  if (artifact && (typeof artifact.path !== 'string' || resolve(artifact.path) !== artifact.path || artifact.sha256 !== 'sha256:' + sha256(json(inventory)) || artifact.bytes !== Buffer.byteLength(json(inventory)))) throw Error('D11 retained inventory artifact identity is invalid');
  const files = new Map();
  for (const file of inventory.files) {
    if (typeof file.file !== 'string' || !file.file || files.has(file.file) || !d11Identity.test(file.sha256 ?? '') || !byteCount(file.rawBytes) || !byteCount(file.gzipBytes)) throw Error('D11 build file identity is invalid or duplicated');
    files.set(file.file, file);
  }
  const result = {kind: 'd11-build-observation-1', scope: 'artifact-build', buildSha256: identity, inventory,
    ...(artifact ? {artifact} : {}), status: 'INCONCLUSIVE', missing: [], violations: [], featureIds: [], features: [], measurements: []};
  const evidence = selected => ({buildSha256: identity, files: selected.map(({file, sha256, rawBytes, gzipBytes}) => ({file, sha256, rawBytes, gzipBytes})), ...(artifact ? {artifact} : {})});
  const roles = inventory.roles;
  if (roles?.missing !== undefined && (!Array.isArray(roles.missing) || roles.missing.some(value => typeof value !== 'string' || !value))) throw Error('D11 role omissions are malformed');
  // Positive evidence of prohibited eager assets remains a failure even when
  // another part of role classification is incomplete. It is not a zero-byte
  // substitution for any of the five required artifact budgets.
  const knownStartup = Array.isArray(roles?.startupFiles) ? [...new Set(roles.startupFiles)].map(path => files.get(path)).filter(Boolean) : [];
  for (const [id, selected] of [
    ['D11-build-eager-authoring-font', knownStartup.filter(file => file.kind === 'font' && file.authoringFont === true)],
    ['D11-build-eager-text-wasm', knownStartup.filter(file => file.kind === 'wasm' && file.sha256 === inventory.textWasmHash)],
  ]) if (selected.length) result.violations.push({id, method: 'verified-source-eager-role-violation-v1', evidence: evidence(selected)});
  if (!roles || roles.complete !== true || !Array.isArray(roles.missing) || roles.missing.length) {
    result.missing = [...new Set(['Complete source-bound D11 build role classification is unavailable', ...(Array.isArray(roles?.missing) ? roles.missing : [])])];
    if (result.violations.length) result.status = 'FAIL';
    return result;
  }
  function select(paths, label, accepts = () => true) {
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string') || new Set(paths).size !== paths.length) throw Error(`D11 ${label} role inventory is invalid or duplicated`);
    return [...paths].sort().map(path => { const file = files.get(path); if (!file || !accepts(file)) throw Error(`D11 ${label} role has an unknown or incompatible artifact: ${path}`); return file; });
  }
  // The eager graph also contains CSS/font assets; the startup JS budget
  // measures only its JavaScript, including the sealed inline bootstrap.
  const startup = select(roles.startupFiles, 'startup', file => ['js', 'css', 'wasm'].includes(file.kind) || file.kind === 'font' && typeof file.authoringFont === 'boolean').filter(file => file.kind === 'js');
  const engine = select(roles.textEngineFiles, 'text engine', file => ['js', 'wasm'].includes(file.kind));
  const ui = select(roles.uiCssFontFiles, 'UI CSS/font', file => file.kind === 'css' || file.kind === 'font' && !file.authoringFont);
  if (!startup.length || !engine.some(file => file.kind === 'wasm' && file.sha256 === inventory.textWasmHash)) throw Error('D11 startup or sealed text engine role is empty');
  const total = (selected, field) => { const value = selected.reduce((sum, file) => sum + file[field], 0); if (!byteCount(value)) throw Error('D11 artifact byte sum is invalid'); return value; };
  const gzipMethod = 'verified-emitted-byte-gzip-default-sum-v1', rawMethod = 'verified-emitted-byte-raw-sum-v1';
  const enginePaths = new Set(engine.map(file => file.file));
  if (!Array.isArray(roles.lazyFeatures)) throw Error('D11 lazy feature role inventory is invalid');
  for (const feature of roles.lazyFeatures) {
    if (typeof feature?.id !== 'string' || !feature.id || result.featureIds.includes(feature.id)) throw Error('D11 lazy feature identity is invalid or duplicated');
    const selected = select(feature.files, 'lazy feature');
    if (!selected.length || selected.some(file => enginePaths.has(file.file))) throw Error('D11 lazy feature includes text-engine artifacts or has no artifacts');
    result.featureIds.push(feature.id);
    result.features.push({id: feature.id, files: selected.map(file => file.file), rawBytes: total(selected, 'rawBytes'), gzipBytes: total(selected, 'gzipBytes'), method: gzipMethod, evidence: evidence(selected)});
  }
  result.features.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); result.featureIds = result.features.map(feature => feature.id);
  const values = [
    ['D11BuildStartupJsGzipBytes', total(startup, 'gzipBytes'), gzipMethod, evidence(startup)],
    ['D11BuildLazyFeatureGzipBytes', Math.max(0, ...result.features.map(feature => feature.gzipBytes)), 'verified-lazy-feature-gzip-default-maximum-v1', {buildSha256: identity, featureIds: result.featureIds, features: result.features.map(({id, gzipBytes}) => ({id, gzipBytes})), ...(artifact ? {artifact} : {})}],
    ['D11BuildTextEngineRawBytes', total(engine, 'rawBytes'), rawMethod, evidence(engine)],
    ['D11BuildTextEngineGzipBytes', total(engine, 'gzipBytes'), gzipMethod, evidence(engine)],
    ['D11BuildUiCssFontGzipBytes', total(ui, 'gzipBytes'), gzipMethod, evidence(ui)],
  ];
  result.measurements = values.map(([name, value, method, evidence]) => ({name, value, unit: 'bytes', method, evidence}));
  result.budgets = d11BuildRules.map(rule => ({...rule, value: result.measurements.find(row => row.name === rule.name).value,
    outcome: result.measurements.find(row => row.name === rule.name).value > rule.ceiling ? 'FAIL' : 'PASS'}));
  result.status = result.violations.length || result.budgets.some(rule => rule.outcome === 'FAIL') ? 'FAIL' : 'PASS';
  return result;
}

export async function auditBuild(source, {d11Output} = {}) {
  const files = await fileManifest(join(source, 'dist'));
  const inventory = await loadD11Build({repo: source});
  // The full app/server identity precedes test-consumer outputs. Recheck it
  // after the detailed app audit so the two identities share one boundary.
  if (json(await fileManifest(join(source, 'dist'))) !== json(files)) throw Error('Build inventory changed during D11 artifact audit');
  let artifact;
  if (d11Output) {
    const path = resolve(d11Output), parent = await realpath(dirname(path)), dist = join(source, 'dist');
    if (path !== d11Output || parent !== dirname(path) || path === dist || path.startsWith(dist + sep)) throw Error('D11 evidence must be a new canonical file outside build outputs');
    const bytes = json(inventory); await writeFile(path, bytes, {flag: 'wx', mode: 0o600});
    artifact = {path, sha256: 'sha256:' + sha256(bytes), bytes: Buffer.byteLength(bytes)};
  }
  return {files, sha256: sha256(json(files)), d11: observeD11Build(inventory, {artifact}), qualification: false,
    byteScope: 'Verified finalized production artifacts and source-bound roles; browser fetch and evaluation require independent H evidence.',
    missing: ['H evaluated module list, Resource Timing and runtime font accounting']};
}

export async function runDeveloperGroup({sourceRoot, paths, expectedSource, directory, cache, ordinal, warmCaches, pinned, focused, registry, browserDownloadHost, inputPacket, abortSignal, primeOnly = false}) {
  await mkdir(directory, {recursive: true}); const startedAt = new Date().toISOString(), start = performance.now();
  const result = {id: primeOnly ? 'warm-cache-prime' : `${cache}-${ordinal}`, cache, ordinal, scored: !primeOnly, startedAt,
    commands: [], phases: [], edits: [], suites: [], status: 'running', qualification: false};
  let context;
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort('I1 group 20-minute ceiling exceeded'), 1200000);
  const signal = abortSignal ? AbortSignal.any([abortSignal, deadline.signal]) : deadline.signal;
  const persist = () => writeFile(join(directory, 'group.json'), json(result));
  try {
    context = await createWorkspace(sourceRoot, paths); result.workspace = context.workspace; result.source = context.sourceManifest;
    if (expectedSource && expectedSource !== result.source.sha256) throw Error('Source drift between command groups');
    if (!primeOnly) {
      const fixtureStart = performance.now();
      if (!inputPacket) { inputPacket = join(context.workspace, 'fixture-inputs'); await prepareInputs({root: sourceRoot, output: inputPacket}); }
      result.fixtureInputs = {packet: inputPacket, ...await installInputs({root: context.source, packet: inputPacket}), elapsedMs: performance.now() - fixtureStart};
    }
    const source = context.source, npmCache = cache === 'warm' ? warmCaches.npm : join(context.workspace, 'npm-cache'), browserCache = cache === 'warm' ? warmCaches.browsers : join(context.workspace, 'browsers');
    const environment = await cleanEnvironment({workspace: context.workspace, npmCache, browserCache, registry, browserDownloadHost});
    result.cacheState = {nodeModules: 'absent', build: 'absent', npm: cache === 'cold' ? 'empty' : primeOnly ? 'empty-prime' : 'campaign-owned-primed', browsers: cache === 'cold' ? 'empty' : primeOnly ? 'empty-prime' : 'campaign-owned-primed', npmCache, browserCache};
    const lock = sha256(await readFile(join(source, 'package-lock.json'))), pkg = JSON.parse(await readFile(join(source, 'package.json')));
    result.cacheKey = sha256(json({source: result.source.sha256, lock, node: pinned.node, npm: pinned.npm, typescript: pkg.devDependencies.typescript,
      vite: pkg.devDependencies.vite, playwright: pkg.devDependencies['@playwright/test'], environment: observedEnvironment(), commands: developerCommandPlan(), selection: focused}));
    if (!primeOnly && cache === 'warm' && warmCaches.key !== result.cacheKey) throw Error('Warm cache key mismatch; retain this attempt and start a fresh complete matched cohort');
    async function command(id, args, extra = {}, executable = pinned.executable, timeoutMs = 300000) {
      const observed = await execute({id: `${String(result.commands.length + 1).padStart(3, '0')}.${id}`, command: [executable, ...args], cwd: source,
        env: {...environment, ...extra}, directory: join(directory, 'logs'), timeoutMs, abortSignal: signal});
      result.commands.push(observed); await persist(); assertSuccess(observed); return observed;
    }
    const npm = (id, args, extra) => command(id, [pinned.npmCli, ...args], extra);
    async function phase(id, action, scored = true) {
      const begin = performance.now(), entry = {id, scored: scored && !primeOnly, startedAt: new Date().toISOString(), outcome: 'FAIL'};
      result.phases.push(entry);
      try { await action(); entry.outcome = 'PASS'; }
      finally { entry.elapsedMs = performance.now() - begin; entry.endedAt = new Date().toISOString(); await persist(); }
      const budget = commandBudgets[id];
      if (entry.scored && budget && entry.elapsedMs > budget[2]) { entry.outcome = 'FAIL'; entry.failure = 'measured-ceiling-breach'; await persist(); throw Error(`${id} exceeded its ${budget[2]}ms ceiling`); }
    }
    await phase(`install-${cache}`, async () => {
      await npm('vendor-before', ['run', 'verify:vendor']);
      let cacheFailure;
      try {
        if (cache === 'warm' && !primeOnly) await npm('cache-verify', ['cache', 'verify']);
        await npm('install', ['ci', '--no-audit', '--no-fund', ...(cache === 'warm' && !primeOnly ? ['--offline'] : [])]);
      } catch (error) {
        if (cache !== 'warm' || primeOnly || signal.aborted) throw error;
        cacheFailure = String(error); result.cacheFallback = {failure: cacheFailure, originalCache: npmCache, disposition: 'failed-warm-sample-retained; clean install is recovery evidence only'};
        environment.npm_config_cache = join(context.workspace, 'clean-recovery-npm-cache');
        await npm('clean-cache-recovery-install', ['ci', '--no-audit', '--no-fund']);
      }
      await npm('dependency-graph', ['ls', '--all', '--json']); await npm('vendor-after', ['run', 'verify:vendor']);
      result.dependencies = await auditDependencies(source, lock);
      if (cacheFailure) throw Error('Warm cache failed; clean install recovery is retained, and the complete matched cohort must be rerun');
    });
    if (primeOnly) {
      await phase('browser-prime', async () => {
        await command('browser-install', ['node_modules/@playwright/test/cli.js', 'install', 'chromium', 'firefox', 'webkit']);
        await command('browser-verify', ['tooling/qualification/developer-campaigns/verify-browsers.mjs', join(directory, 'browsers.json')]);
      }, false);
      result.browsers = JSON.parse(await readFile(join(directory, 'browsers.json'))); warmCaches.key = result.cacheKey; warmCaches.identity = result.browsers; warmCaches.identityPath = join(directory, 'browsers.json');
    } else {
      await phase('full-types', () => npm('full-types', ['run', 'typecheck']));
      const build = async () => { await npm('build-app', ['run', 'build:app']); await npm('build-server', ['run', 'build:server']); };
      const types = async () => {
        for (const [id, config] of [['consumer', 'tsconfig.json'], ['app', 'tsconfig.app.json'], ['server', 'tsconfig.server.json']])
          await command(`incremental-types-${id}`, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', join(context.workspace, `${id}.tsbuildinfo`), '-p', config]);
      };
      await phase('cold-build', build); result.artifacts = await auditBuild(source, {d11Output: join(directory, 'd11-build.json')});
      result.d11 = result.artifacts.d11; await persist();
      if (result.d11.status === 'FAIL') throw Error('D11 production artifact budget or lazy-loading requirement failed');
      for (const scope of editScopes) {
        await phase(`${scope.id}-prime`, async () => { await types(); await build(); }, false);
        await withTemporaryEdit(join(source, scope.path), scope, async edit => {
          result.edits.push(edit); await phase(`${scope.id}-types`, types); await phase(`${scope.id}-build`, build);
          edit.artifacts = await auditBuild(source);
        }, async edit => {
          await phase(`${scope.id}-restore`, async () => { await types(); await build(); }, false);
          edit.restoredArtifacts = await auditBuild(source);
          if (edit.restoredArtifacts.sha256 !== result.artifacts.sha256) throw Error(`Restored build changed: ${scope.id}`);
        });
      }
      const inventory = await discoverNodeFiles(source); result.nodeInventory = inventory;
      for (const group of ['unit', 'integration']) for (const mode of ['focused', 'full']) await phase(`${mode}-${group}`, async () => { result.suites.push(await runNodeSelection({source, directory, group, mode, focused, inventory, command, pinned, abortSignal: signal})); });
      await phase(`browser-${cache}`, async () => {
        if (cache === 'cold') await command('browser-install', ['node_modules/@playwright/test/cli.js', 'install', 'chromium', 'firefox', 'webkit']);
        const expectedPath = join(directory, 'expected-browsers.json');
        if (cache === 'warm') await writeFile(expectedPath, json(warmCaches.identity), {flag: 'wx'});
        try {
          await command('browser-verify', ['tooling/qualification/developer-campaigns/verify-browsers.mjs', join(directory, 'browsers.json'), 'chromium,firefox,webkit', ...(cache === 'warm' ? [expectedPath] : [])]);
        } catch (error) {
          if (cache !== 'warm' || signal.aborted) throw error;
          result.browserCacheFallback = {failure: String(error), disposition: 'failed-warm-sample-retained; fresh browser install is recovery evidence only'};
          environment.PLAYWRIGHT_BROWSERS_PATH = join(context.workspace, 'clean-recovery-browsers');
          await command('clean-browser-recovery-install', ['node_modules/@playwright/test/cli.js', 'install', 'chromium', 'firefox', 'webkit']);
          await command('clean-browser-recovery-verify', ['tooling/qualification/developer-campaigns/verify-browsers.mjs', join(directory, 'recovery-browsers.json')]);
          throw Error('Warm browser cache failed; fresh install recovery retained; complete matched cohort requires rerun');
        }
        result.browsers = JSON.parse(await readFile(join(directory, 'browsers.json')));
        if (cache === 'warm' && json(result.browsers.engines.map(({engine, version, sha256}) => ({engine, version, sha256}))) !== json(warmCaches.identity.engines.map(({engine, version, sha256}) => ({engine, version, sha256})))) throw Error('Warm browser cache identity mismatch');
      });
      const plan = createBrowserPlan({selection: 'chromium', scope: 'features', output: join(directory, 'full-browser')});
      // Build test-only consumers/fixtures as declared C6 setup, outside each
      // complete focused/full test command but inside the command-group timer.
      await phase('browser-prerequisites', async () => {
        for (const step of plan.steps.filter(step => !step.config)) await npm(step.id, step.args, step.env);
      }, false);
      for (const mode of ['focused', 'full']) await phase(`${mode}-browser`, async () => { result.suites.push(await runBrowserSelection({source, directory, mode, focused, plan, command, pinned})); });
      result.browserCacheAfter = await browserCacheIdentity(environment.PLAYWRIGHT_BROWSERS_PATH);
      if (result.browserCacheAfter.sha256 !== result.browsers.cache.sha256) throw Error('Browser distribution changed during required browser suites');
    }
    await verifyManifest(context.source, context.sourceManifest.files);
    result.status = 'completed';
  } catch (error) { result.status = 'failed'; result.failure = String(error); }
  finally {
    const terminal = () => {
      result.endedAt = new Date().toISOString(); result.elapsedMs = performance.now() - start;
      if (signal.aborted) { result.status = 'failed'; result.failure = String(signal.reason); }
      if (result.elapsedMs > 1200000) { result.status = 'failed'; result.failure = 'I1 group 20-minute ceiling exceeded, including final publication'; }
    };
    try { terminal(); await persist(); const previous = result.status; terminal(); if (result.status !== previous) await persist(); }
    finally { clearTimeout(timer); }
  }
  return result;
}

export function summarizeCommands(groups) {
  const cells = [];
  for (const cache of ['cold', 'warm']) for (const [id, [budgetId, targetMs, ceilingMs]] of Object.entries(commandBudgets)) {
    if ((id.startsWith('install-') || id.startsWith('browser-')) && !id.endsWith(cache)) continue;
    const key = `${cache}:${id}`;
    const attempts = groups.filter(group => group.cache === cache && group.scored).flatMap(group => group.phases.filter(phase => phase.id === id).map(phase => ({id: `${group.id}:${id}`, phase: 'scored', ordinal: group.ordinal, cohortKey: key,
      elapsedMs: phase.elapsedMs, outcome: phase.outcome === 'PASS' ? 'expected' : 'unexpected-error'})));
    cells.push(evaluateCohort({profile: 'D', cache, cohortKey: key, budgetId, targetMs, ceilingMs, attempts}));
  }
  const median = (cache, id) => { const values = groups.filter(group => group.cache === cache && group.status === 'completed' && group.scored).flatMap(group => group.phases.filter(phase => phase.id === id).map(phase => phase.elapsedMs)); return values.length === 5 ? nearestRank(values, .5) : null; };
  const coldInstall = median('cold', 'install-cold'), warmInstall = median('warm', 'install-warm');
  const ratios = [{id: 'D10-install', ratio: coldInstall > 0 && warmInstall !== null ? warmInstall / coldInstall : null, target: .6, ceiling: .8}];
  for (const cache of ['cold', 'warm']) for (const scope of editScopes) {
    const build = median(cache, 'cold-build'), incremental = median(cache, `${scope.id}-build`);
    ratios.push({id: `D10-${cache}-${scope.id}`, ratio: build > 0 && incremental !== null ? incremental / build : null, target: .2, ceiling: .35});
  }
  for (const ratio of ratios) ratio.outcome = ratio.ratio === null ? 'INCONCLUSIVE' : ratio.ratio > ratio.ceiling ? 'FAIL' : 'PASS';
  const required = commandSchedule(); const complete = required.every(item => groups.some(group => group.id === item.id && group.status === 'completed')) && groups.length === 10;
  const envelopes = groups.filter(group => group.elapsedMs > 1200000).map(group => group.id);
  const identities = groups.filter(group => group.status === 'completed' && group.artifacts).map(group => ({id: group.id, source: group.source.sha256, lock: group.dependencies.lock, artifacts: group.artifacts.sha256,
    browsers: {cache: group.browsers?.cache?.sha256, engines: group.browsers?.engines?.map(({engine, version, revision, sha256}) => ({engine, version, revision, sha256})), after: group.browserCacheAfter?.sha256},
    suites: group.suites.map(suite => ({group: suite.group, mode: suite.mode, executed: suite.executed, cases: suite.summaries.map(summary => summary.identity)}))}));
  const identityMismatch = identities.length > 1 && identities.some(({id, ...identity}) => json(identity) !== json((({id, ...value}) => value)(identities[0])));
  const buildObservations = groups.filter(group => group.scored).map(group => {
    const observed = group.d11 ?? group.artifacts?.d11;
    if (!observed) return {id: group.id, status: 'INCONCLUSIVE', missing: ['D11 production build observation is absent']};
    try {
      const expected = observeD11Build(observed.inventory, {artifact: observed.artifact});
      for (const key of ['kind', 'scope', 'buildSha256', 'status', 'missing', 'violations', 'featureIds', 'features', 'measurements', 'budgets'])
        if (canonicalD11(observed[key]) !== canonicalD11(expected[key])) throw Error(`D11 retained ${key} differs from its sealed build`);
      return {id: group.id, status: expected.status, missing: expected.missing, buildSha256: expected.buildSha256,
        violations: expected.violations, featureIds: expected.featureIds, features: expected.features, measurements: expected.measurements, budgets: expected.budgets};
    } catch (error) { return {id: group.id, status: 'FAIL', failure: String(error)}; }
  });
  const buildIdentities = buildObservations.filter(observed => observed.status === 'PASS').map(observed => canonicalD11({buildSha256: observed.buildSha256, featureIds: observed.featureIds,
    methods: observed.measurements.map(({name, method}) => ({name, method}))}));
  const buildIdentityMismatch = new Set(buildIdentities).size > 1;
  const buildComplete = buildObservations.length === 10 && buildObservations.every(observed => observed.status === 'PASS');
  return {cells, ratios, complete, identities, identityMismatch, buildObservations, buildIdentityMismatch, groupCeilingViolations: envelopes,
    outcome: groups.some(group => group.status === 'failed') || cells.some(cell => cell.outcome === 'FAIL') || ratios.some(ratio => ratio.outcome === 'FAIL') || envelopes.length || identityMismatch || buildIdentityMismatch || buildObservations.some(observed => observed.status === 'FAIL') ? 'FAIL' : !complete || !buildComplete || cells.some(cell => cell.outcome !== 'PASS') ? 'INCONCLUSIVE' : 'PASS'};
}

export async function runDeveloperCommandCampaign({sourceRoot = root, output, registry, browserDownloadHost, inputPacket, abortSignal, timingLease} = {}) {
  sourceRoot = await realpath(sourceRoot); const run = await createRun(sourceRoot, output, {timingLease});
  const started = performance.now();
  const receipt = {kind: 'developer-command-campaign-receipt-1', job: 'I1', startedAt: new Date().toISOString(), plan: developerCommandPlan(),
    pinned: null, environment: observedEnvironment(), registry: registry ?? null, browserDownloadHost: browserDownloadHost ?? null, groups: [], status: 'running', qualification: false};
  try {
    const pinned = await toolchain(sourceRoot); receipt.pinned = pinned;
    if (!inputPacket) { inputPacket = join(run.directory, 'fixture-inputs'); receipt.fixturePreparation = await prepareInputs({root: sourceRoot, output: inputPacket}); }
    receipt.inputPacket = inputPacket;
    const paths = sourcePaths(sourceRoot), focused = await readFocused(sourceRoot); receipt.focused = focused;
    const warmCaches = {npm: join(run.workspace, 'warm-npm-cache'), browsers: join(run.workspace, 'warm-browsers')};
    // Explicit unscored prime with real npm ci and all-three browser install.
    receipt.prime = await runDeveloperGroup({sourceRoot, paths, directory: join(run.directory, 'warm-prime'), cache: 'warm', ordinal: 0, warmCaches, pinned, focused, registry, browserDownloadHost, abortSignal, primeOnly: true});
    await run.save(receipt);
    if (receipt.prime.status !== 'completed') throw Error('Warm-cache priming failed; retained without substituting a scored sample');
    for (const group of commandSchedule()) {
      const observed = await runDeveloperGroup({sourceRoot, paths, expectedSource: receipt.prime.source.sha256, directory: join(run.directory, group.id), ...group, warmCaches, pinned, focused, registry, browserDownloadHost, inputPacket, abortSignal});
      receipt.groups.push(observed); await run.save(receipt);
      // Preserve the failed group and stop. A new cohort is an explicit new run,
      // never a hidden replacement of an unsuccessful or slow sample.
      if (observed.status !== 'completed' || abortSignal?.aborted) break;
    }
    receipt.evaluation = summarizeCommands(receipt.groups);
    receipt.status = receipt.evaluation.outcome;
    receipt.scopeChanges = receipt.groups.flatMap(group => group.suites.filter(suite => suite.mode === 'full' && suite.executed > {unit: 2000, integration: 100, browser: 30}[suite.group]).map(suite => ({group: group.id, method: suite.group, actual: suite.executed, sizingEnvelope: {unit: 2000, integration: 100, browser: 30}[suite.group], required: 'PERF-A08 scope/cost amendment; all cases retained'})));
    receipt.missingQualification = ['Qualified C host and isolated physical scheduling', 'Controlled N registry and browser download evidence', 'Paired base/candidate run order where a comparison is requested', 'D11 H evaluated-module/Resource Timing and font traces', 'Repository serial-worker amendment to the proposed C two-worker policy', ...(receipt.scopeChanges.length ? ['PERF-A08 scope amendment for actual full suite counts'] : [])];
  } catch (error) { receipt.status = 'FAIL'; receipt.failure = String(error); }
  finally {
    receipt.endedAt = new Date().toISOString(); receipt.elapsedMs = performance.now() - started;
    receipt.aggregateBudget = {targetMs: 7200000, ceilingMs: 12000000};
    const terminal = () => {
      receipt.elapsedMs = performance.now() - started;
      if (abortSignal?.aborted) { receipt.status = 'FAIL'; receipt.interrupted = String(abortSignal.reason); }
      if (receipt.elapsedMs > receipt.aggregateBudget.ceilingMs) { receipt.status = 'FAIL'; receipt.failure = 'I1 200-minute aggregate ceiling exceeded, including prime/setup/receipt work'; }
    };
    try {
      terminal(); await run.save(receipt);
      // Retain final-publication cost as well. A slow publication may turn a
      // completed computation into a failed campaign, never into a faster pass.
      const previous = receipt.status; terminal();
      if (receipt.status !== previous || abortSignal?.aborted) await run.save(receipt);
    } finally { await run.close(); }
  }
  return receipt;
}

export function parseDeveloperOptions(args) {
  const options = {}, values = {'--output': 'output', '--registry': 'registry', '--browser-download-host': 'browserDownloadHost', '--input-packet': 'inputPacket'};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], key = values[arg] ?? {'--run': 'run', '--plan': 'plan', '--install': 'install'}[arg];
    if (!key || Object.hasOwn(options, key)) throw Error('Unknown or duplicate developer campaign argument');
    if (values[arg]) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value for ${arg}`);
      options[key] = args[++i];
    } else options[key] = true;
  }
  if (options.run && options.plan) throw Error('Choose plan or run');
  if (!options.run && Object.keys(options).some(key => key !== 'plan')) throw Error('Execution options require --run');
  if (options.run && !options.install) throw Error('--run requires --install for ten isolated npm ci groups and the explicit warm-cache prime');
  return options;
}
if (import.meta.main) {
  try {
    const options = parseDeveloperOptions(process.argv.slice(2));
    if (!options.run) console.log(json(developerCommandPlan()));
    else {
      const controller = new AbortController(), onInterrupt = () => controller.abort('SIGINT'), onTerminate = () => controller.abort('SIGTERM');
      process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
      try {
        const receipt = await runDeveloperCommandCampaign({...options, abortSignal: controller.signal});
        console.log(json({status: receipt.status, qualification: false, groups: receipt.groups.length, missing: receipt.missingQualification}));
        if (receipt.status !== 'PASS' || controller.signal.aborted) process.exitCode = 1;
      } finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); }
    }
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
