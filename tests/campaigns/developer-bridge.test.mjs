import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createDeveloperAdapter, selectDeveloperStage, normalizeDeveloperObservation, developerBuildByteNames, developerBuildByteObservation} from '../../tooling/qualification/developer-campaigns/bridge.mjs';
import {observeD11Build} from '../../tooling/qualification/developer-campaigns/commands.mjs';

const cell = (id, operation, parameters = {}) => ({id, operation, parameters, handler: 'developer', requiredMeasurements: []});
const I1 = cell('I1/command-groups', 'developer.command-group');
const I2 = cell('I2/archive-update', 'developer.archive-update');
const attempt = (cache = 'cold', ordinal = 1) => ({cache, ordinal, prime: false});
const successful = () => ({status: 'completed', commands: [{id: 'one', outcome: 'PASS'}], suites: [], phases: [{id: 'full-types', elapsedMs: 3, outcome: 'PASS'}]});
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const buildAudit = () => {
  const artifact = (file, kind) => ({file, kind, sha256: 'sha256:' + 'f'.repeat(64), rawBytes: 200, gzipBytes: 100});
  const inventory = {kind: 'perf-d11-build-1', files: [artifact('assets/startup.js', 'js'), artifact('assets/lazy.js', 'js'), artifact('assets/engine.wasm', 'wasm'), artifact('assets/style.css', 'css')],
    textWasmHash: 'sha256:' + 'f'.repeat(64), roles: {complete: true, missing: [], startupFiles: ['assets/startup.js'], textEngineFiles: ['assets/engine.wasm'], uiCssFontFiles: ['assets/style.css'], lazyFeatures: [{id: 'fixture-lazy-module', files: ['assets/lazy.js']}]}};
  inventory.sha256 = 'sha256:' + createHash('sha256').update(canonical(inventory)).digest('hex');
  return observeD11Build(inventory);
};

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'developer-bridge-unit-'));
  const owned = [];
  t.after(async () => { for (const adapter of owned) await adapter.close(); await rm(root, {recursive: true, force: true}); });
  const repo = join(root, 'subject'), output = join(root, 'output'); await mkdir(repo); await mkdir(output);
  await writeFile(join(repo, 'package-lock.json'), '{}\n');
  const source = {sha256: 'a'.repeat(64), files: []};
  const context = {repo, output, configuration: {developerStateDirectory: join(root, 'state'), developerInstall: true, ...extra}, signal: new AbortController().signal};
  const injected = {sourceSeal: async () => source, toolchain: async () => ({node: '26.10.0', npm: '12.1.0'}), readFocused: async () => ({fixture: 'injected unit selector'}),
    prepareInputs: async () => ({qualification: false}), verifyInputs: async () => ({manifestSha256: 'c'.repeat(64)}),
    createWorkspace: async () => { const workspace = join(root, 'workspace'), sourcePath = join(workspace, 'source'); await mkdir(sourcePath, {recursive: true}); return {workspace, source: sourcePath, sourceManifest: source}; }};
  return {root, repo, source, context, injected, own(adapter) { owned.push(adapter); return adapter; }};
}

test('developer bridge maps exact P stages and declines missing multi-host routes', () => {
  assert.deepEqual(selectDeveloperStage(cell('C0/setup', 'developer.setup')), {kind: 'P', stage: 'setup'});
  assert.deepEqual(selectDeveloperStage(cell('C3/domain-type', 'developer.command')), {kind: 'P', stage: 'incremental-domain-type'});
  assert.deepEqual(selectDeveloperStage(I1), {kind: 'I1'});
  assert.deepEqual(selectDeveloperStage(I2), {kind: 'I2'});
  assert.throws(() => selectDeveloperStage(cell('C0/setup', 'developer.command')), /disagree/);
  assert.throws(() => selectDeveloperStage(cell('I0/core-normal', 'developer.core-pipeline')), {code: 'CAMPAIGN_PREREQUISITE'});
  assert.deepEqual(selectDeveloperStage(cell('H0/setup', 'developer.setup')), {kind: 'H', stage: 'setup'});
});

test('missing measured values stay inconclusive without a false failed assertion', () => {
  const required = {...I1, requiredMeasurements: [{name: 'unobserved', unit: 'bytes'}]};
  const observed = normalizeDeveloperObservation(required, successful());
  assert.equal(observed.status, 'INCONCLUSIVE'); assert.deepEqual(observed.assertions, []);
  assert.ok(observed.missing.some(value => value.includes('unobserved')));
  assert.equal(normalizeDeveloperObservation(I1, {status: 'completed', phases: []}).status, 'INCONCLUSIVE');
});

test('C2 exposes the exact artifact-build audit and distinct actual C byte measurements', () => {
  const d11 = buildAudit(), production = {...cell('C2/production-build', 'developer.command'), budgets: ['D03', 'D11'], requiredMeasurements: developerBuildByteNames.map(name => ({name, unit: 'bytes'}))};
  const result = normalizeDeveloperObservation(production, {...successful(), artifacts: {d11}});
  assert.equal(result.status, 'PASS'); assert.equal(result.d11, d11);
  assert.deepEqual(Object.keys(result.measurements).sort(), [...developerBuildByteNames].sort());
  for (const row of d11.measurements) assert.deepEqual(result.measurements[row.name], row);
  for (const name of ['D11StartupJsGzipBytes', 'D11StartupEvaluatedJsBytes', 'D11StartupUiCssAndFontsGzipBytes', 'D11TextEngineRawBytes', 'D11TextEngineGzipBytes']) assert.equal(result.measurements[name], undefined);
});

test('required C byte evidence cannot be replaced by omitted, duplicate or malformed audit rows', () => {
  const production = {...cell('C2/production-build', 'developer.command'), budgets: ['D11']};
  assert.equal(normalizeDeveloperObservation(production, successful()).status, 'INCONCLUSIVE');
  for (const change of [d11 => d11.measurements.pop(), d11 => d11.measurements.push({...d11.measurements[0]}), d11 => d11.measurements[0].value = NaN,
    d11 => d11.measurements[0].unit = 'ms', d11 => d11.measurements[0].method = '', d11 => d11.measurements[0].evidence = null,
    d11 => d11.measurements[0].name = 'D11StartupJsGzipBytes', d11 => d11.inventory.sha256 = 'sha256:' + 'e'.repeat(64), d11 => d11.featureIds.push(d11.featureIds[0]),
    d11 => d11.features = undefined, d11 => d11.missing.push('Text engine role has not been established'), d11 => d11.status = 'INCONCLUSIVE']) {
    const d11 = buildAudit(); change(d11);
    const result = normalizeDeveloperObservation(production, {...successful(), artifacts: {d11}});
    assert.equal(result.status, 'INCONCLUSIVE'); assert.ok(result.missing.length); assert.deepEqual(result.assertions, []);
  }
});

test('a failed C byte audit stays failed even after successful commands and with missing roles', () => {
  const d11 = buildAudit(); d11.status = 'FAIL'; d11.missing.push('One additional role missing');
  const result = normalizeDeveloperObservation({...I1, budgets: ['D11']}, {...successful(), artifacts: {d11}});
  assert.equal(result.status, 'FAIL'); assert.equal(result.d11.status, 'FAIL');
  assert.equal(developerBuildByteObservation(successful()).d11, null);
});

test('C byte rows and ceiling outcomes are rederived from their sealed inventory', () => {
  const production = {...cell('C2/production-build', 'developer.command'), budgets: ['D11']};
  const forged = buildAudit(); forged.measurements[0].value++;
  assert.equal(normalizeDeveloperObservation(production, {...successful(), d11: forged}).status, 'INCONCLUSIVE');
  const drift = buildAudit(); drift.inventory.files[0].gzipBytes++;
  assert.equal(normalizeDeveloperObservation(production, {...successful(), d11: drift}).status, 'INCONCLUSIVE');
  const large = buildAudit().inventory; delete large.sha256; large.files[0].gzipBytes = 600 * 1024;
  large.sha256 = 'sha256:' + createHash('sha256').update(canonical(large)).digest('hex');
  const hiddenBreach = observeD11Build(large); assert.equal(hiddenBreach.status, 'FAIL'); hiddenBreach.status = 'PASS';
  hiddenBreach.measurements[0].value = 100;
  assert.equal(normalizeDeveloperObservation(production, {...successful(), d11: hiddenBreach}).status, 'FAIL');
});

test('failure, skipped cases, missing inventories and malformed clocks never become successful commands', () => {
  assert.equal(normalizeDeveloperObservation(I1, {...successful(), status: 'failed'}).status, 'FAIL');
  assert.equal(normalizeDeveloperObservation(I1, {...successful(), commands: [{outcome: 'PASS', timedOut: true}]}).status, 'FAIL');
  assert.equal(normalizeDeveloperObservation(I1, {...successful(), suites: [{mode: 'full', group: 'unit', executed: 1, summaries: [{outcome: 'FAIL', skipped: 1}]}]}).status, 'FAIL');
  assert.equal(normalizeDeveloperObservation(I1, {...successful(), suites: [{mode: 'full', group: 'unit', executed: 0, summaries: []}]}).status, 'INCONCLUSIVE');
  assert.throws(() => normalizeDeveloperObservation(I1, {...successful(), phases: [{id: 'x', elapsedMs: -1}]}), /Malformed/);
});

test('explicit private state and install configuration are required before any action', async t => {
  const f = await fixture(t); let actions = 0; f.injected.runDeveloperGroup = async () => { actions++; return successful(); };
  await assert.rejects(createDeveloperAdapter({...f.context, configuration: {developerInstall: true}}, f.injected), {code: 'CAMPAIGN_PREREQUISITE'});
  await assert.rejects(createDeveloperAdapter({...f.context, configuration: {developerStateDirectory: join(f.root, 'second-state')}}, f.injected), {code: 'CAMPAIGN_PREREQUISITE'});
  const target = join(f.root, 'real-state'); await mkdir(target, {mode: 0o700}); const link = join(f.root, 'linked-state'); await symlink(target, link);
  await assert.rejects(createDeveloperAdapter({...f.context, configuration: {...f.context.configuration, developerStateDirectory: link}}, f.injected), /canonical/);
  assert.equal(actions, 0);
});

test('P stages share prepared source and invoke only their individual stage', async t => {
  const f = await fixture(t), calls = [];
  f.injected.runDeveloperGroup = () => { throw Error('Whole I1 group must never run for a P stage'); };
  f.injected.runDeveloperStage = async options => { calls.push({stage: options.stage, source: options.state.p.source}); options.state.p.completed.push(options.stage); await options.save(); return successful(); };
  let adapter = await createDeveloperAdapter(f.context, f.injected);
  const setup = cell('C0/setup', 'developer.setup'); await adapter.prepareCell(setup); await adapter.resetCell(setup, attempt()); assert.equal((await adapter.execute(setup, attempt())).status, 'PASS'); await adapter.close();
  adapter = await createDeveloperAdapter({...f.context, output: join(f.root, 'next-output')}, f.injected);
  const install = cell('C1/clean-install', 'developer.command', {cache: 'cold'}); await adapter.prepareCell(install); await adapter.resetCell(install, attempt()); await adapter.execute(install, attempt()); await adapter.close();
  assert.deepEqual(calls.map(call => call.stage), ['setup', 'clean-install']); assert.equal(calls[0].source, calls[1].source);
});

test('I1 calls exactly one command group per sample and refuses duplicate or out-of-order starts', async t => {
  const f = await fixture(t), calls = []; f.injected.runDeveloperGroup = async options => { calls.push(options); return successful(); };
  const adapter = f.own(await createDeveloperAdapter(f.context, f.injected));
  await adapter.prepareCell(I1); await adapter.resetCell(I1, attempt()); assert.equal((await adapter.execute(I1, attempt())).status, 'PASS');
  assert.equal(calls.length, 1); assert.equal(calls[0].ordinal, 1); assert.equal(calls[0].cache, 'cold');
  await assert.rejects(adapter.execute(I1, attempt()), /duplicate/);
  await assert.rejects(adapter.execute(I1, attempt('cold', 3)), /out-of-order/);
  assert.equal(calls.length, 1);
});

test('I1 forwards its one actual command-group build audit without a second build or byte audit', async t => {
  const f = await fixture(t), d11 = buildAudit(); let calls = 0;
  f.injected.runDeveloperGroup = async () => { calls++; return {...successful(), artifacts: {d11}}; };
  const selected = {...I1, budgets: ['D11'], requiredMeasurements: developerBuildByteNames.map(name => ({name, unit: 'bytes'}))};
  const adapter = f.own(await createDeveloperAdapter(f.context, f.injected)); await adapter.prepareCell(selected); await adapter.resetCell(selected, attempt());
  const result = await adapter.execute(selected, attempt());
  assert.equal(calls, 1); assert.equal(result.status, 'PASS'); assert.equal(result.d11, d11);
  assert.equal(result.observations.artifacts.d11, d11);
  for (const row of d11.measurements) assert.deepEqual(result.measurements[row.name], row);
});

test('I1 warm prime is explicit, retained once, and never substitutes a scored sample', async t => {
  const f = await fixture(t, {developerWarmPrime: true}), calls = [];
  f.injected.runDeveloperGroup = async options => {
    calls.push({cache: options.cache, ordinal: options.ordinal, primeOnly: options.primeOnly === true});
    if (options.primeOnly) { options.warmCaches.key = 'sealed-cache'; options.warmCaches.identity = {engines: []}; await mkdir(options.directory, {recursive: true}); await writeFile(join(options.directory, 'group.json'), '{}\n'); }
    return successful();
  };
  const adapter = f.own(await createDeveloperAdapter(f.context, f.injected)); await adapter.prepareCell(I1);
  for (let ordinal = 1; ordinal <= 5; ordinal++) { await adapter.resetCell(I1, attempt('cold', ordinal)); await adapter.execute(I1, attempt('cold', ordinal)); }
  for (let ordinal = 1; ordinal <= 2; ordinal++) { await adapter.resetCell(I1, attempt('warm', ordinal)); await adapter.execute(I1, attempt('warm', ordinal)); }
  assert.equal(calls.filter(call => call.primeOnly).length, 1); assert.equal(calls.filter(call => !call.primeOnly).length, 7);
  const state = JSON.parse(await readFile(join(f.root, 'state', 'bridge-state.json'))).state;
  assert.equal(state.i1.samples.length, 7); assert.equal(state.i1.warmCaches.key, 'sealed-cache'); assert.match(state.i1.prime.sha256, /^[a-f0-9]{64}$/);
});

test('I2 dispatches one archive sample with exact cache, ordinal and shared state', async t => {
  const f = await fixture(t, {developerArchiveRecipePath: '/sealed/recipe.json'}), calls = [];
  f.injected.runArchiveSample = async options => { calls.push(options); return {status: 'passed-local-sample', commands: [{outcome: 'PASS'}], run: {status: 'passed', browserCounts: {passed: 2}, timings: {sourceInstall: 1, producer: 2, upgrade: 3, resetAndReceipt: 1, wholeRun: 5}}}; };
  const adapter = f.own(await createDeveloperAdapter(f.context, f.injected)); await adapter.prepareCell(I2); await adapter.resetCell(I2, attempt());
  assert.equal((await adapter.execute(I2, attempt())).status, 'PASS'); assert.equal(calls.length, 1);
  assert.equal(calls[0].cache, 'cold'); assert.equal(calls[0].ordinal, 1); assert.equal(calls[0].install, true);
  assert.equal(calls[0].cacheStateDirectory, join(f.root, 'state', 'archive-cache-state'));
});

test('failed warm priming remains a terminal prerequisite across worker outputs', async t => {
  const f = await fixture(t, {developerWarmPrime: true}); let primes = 0;
  f.injected.runDeveloperGroup = async options => { if (options.primeOnly) { primes++; return {...successful(), status: 'failed'}; } return successful(); };
  let adapter = await createDeveloperAdapter(f.context, f.injected); await adapter.prepareCell(I1);
  for (let ordinal = 1; ordinal <= 5; ordinal++) await adapter.execute(I1, attempt('cold', ordinal));
  await assert.rejects(adapter.resetCell(I1, attempt('warm', 1)), /prime failed/); await adapter.close();
  adapter = f.own(await createDeveloperAdapter({...f.context, output: join(f.root, 'resumed-output')}, f.injected)); await adapter.prepareCell(I1);
  await assert.rejects(adapter.resetCell(I1, attempt('warm', 1)), {code: 'CAMPAIGN_PREREQUISITE'}); assert.equal(primes, 1);
  const state = JSON.parse(await readFile(join(f.root, 'state', 'bridge-state.json'))).state;
  assert.equal(state.i1.primeAttempt.status, 'running'); assert.equal(state.i1.warmCaches, null);
});

test('late cancellation retains a failed sample instead of publishing the completed helper result', async t => {
  const f = await fixture(t), controller = new AbortController(); f.context.signal = controller.signal;
  f.injected.runDeveloperGroup = async () => { controller.abort(Error('late cancellation')); return successful(); };
  const adapter = f.own(await createDeveloperAdapter(f.context, f.injected)); await adapter.prepareCell(I1);
  await assert.rejects(adapter.execute(I1, attempt()), /late cancellation/);
  const state = JSON.parse(await readFile(join(f.root, 'state', 'bridge-state.json'))).state;
  assert.equal(state.i1.samples[0].status, 'FAIL'); assert.match(state.i1.samples[0].failure, /late cancellation/);
});

test('failed samples are retained and block later samples without retrying the group', async t => {
  const f = await fixture(t); let calls = 0; f.injected.runDeveloperGroup = async () => { calls++; return {...successful(), status: 'failed'}; };
  const adapter = f.own(await createDeveloperAdapter(f.context, f.injected)); await adapter.prepareCell(I1);
  assert.equal((await adapter.execute(I1, attempt())).status, 'FAIL');
  await assert.rejects(adapter.execute(I1, attempt('cold', 2)), {code: 'CAMPAIGN_PREREQUISITE'}); assert.equal(calls, 1);
  const state = JSON.parse(await readFile(join(f.root, 'state', 'bridge-state.json'))).state; assert.equal(state.i1.samples[0].status, 'FAIL');
});

test('source drift and changed sealed state refuse continuation', async t => {
  const f = await fixture(t); const adapter = await createDeveloperAdapter(f.context, f.injected);
  f.source.sha256 = 'b'.repeat(64); await assert.rejects(adapter.prepareCell(I1), /source changed/); await adapter.close();
  const path = join(f.root, 'state', 'bridge-state.json'), envelope = JSON.parse(await readFile(path)); envelope.state.identity = 'changed'; await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(createDeveloperAdapter(f.context, f.injected), /seal mismatch/);
});

test('a second worker cannot own the same developer state concurrently', async t => {
  const f = await fixture(t), adapter = f.own(await createDeveloperAdapter(f.context, f.injected));
  await assert.rejects(createDeveloperAdapter(f.context, f.injected), {code: 'CAMPAIGN_PREREQUISITE'});
});
