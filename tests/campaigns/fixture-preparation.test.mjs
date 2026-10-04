import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, lstat, writeFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runFixturePreparation, preparationArguments, preparationGuardArguments, parsePreparationArguments} from '../../tooling/qualification/campaigns/fixture-preparation.mjs';
import {boundedChild} from '../../tooling/qualification/container/bounded-child.mjs';
import {verifyEvidenceAudit} from '../../tooling/qualification/evidence-volume.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const identity = {digest: 'a'.repeat(64), files: [{path: 'synthetic-subject', bytes: 1, sha256: 'b'.repeat(64)}]};
const normal = {status: 'PASS', level: 'normal', percent: 1};
async function fixture(t) {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'fixture-accounting-')));
  t.after(() => rm(repo, {recursive: true, force: true}));
  const root = join(repo, 'artifacts', 'evidence'); await mkdir(root, {recursive: true, mode: 0o700});
  const allocation = join(root, 'allocation.json');
  await writeFile(allocation, JSON.stringify({kind: 'evidence-volume-allocation-1', allocationId: 'fixture-accounting-unit',
    purpose: 'qualification-evidence-only', capacityBytes: 4 * 1024 ** 3, root, issuedAt: '2026-10-04T00:00:00.000Z', owner: 'fixture-accounting-unit'}));
  const allocationBytes = await readFile(allocation);
  const allocationIdentity = {bytes: allocationBytes.length, sha256: createHash('sha256').update(allocationBytes).digest('hex')};
  const output = join(root, 'run-01'); const events = []; let alarm, childCalls = 0;
  const deps = {
    sourceProvider: async () => identity, dependencyProvider: async () => identity,
    hostLeaseProvider: async () => ({path: join(repo, 'synthetic-host-lock'), identity: {testOnly: true}, async release() {events.push('release');}}),
    monitorFactory: async options => {
      alarm = options.onAlarm; alarm(normal); events.push('monitor');
      return {reference: {kind: 'test-monitor-reference', root, allocationIdentity}, async finish({receiptPath, outcome}) {
        assert(receiptPath); assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).rawOutcome, outcome);
        events.push('finish'); return {status: 'PASS'};
      }};
    },
    auditRetainer: async () => {events.push('retain');}, auditVerifier: async () => {events.push('verify'); return {status: 'PASS'};},
    childRunner: async (_executable, argv, options) => {
      childCalls++; events.push('child');
      assert.equal(argv.at(-2), '--output'); assert.equal(argv.at(-1), join(output, 'prepared'));
      await assert.rejects(lstat(argv.at(-1)), {code: 'ENOENT'});
      assert.equal(options.env.NODE_OPTIONS, undefined); assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.env.TMPDIR, join(output, 'tmp')); assert(options.timeoutMs > 0 && options.graceMs === 5000);
      await mkdir(argv.at(-1)); await writeFile(join(argv.at(-1), 'seed.json'), '{"synthetic":true}\n');
      events.push('closed'); return {code: 0, signal: null, timedOut: false, interrupted: false};
    },
  };
  const options = {repo, output, timeoutMs: 30000, args: ['prepare-seed', '--allow-heavy'], execArgv: [],
    environment: {IE_EVIDENCE_ALLOCATION: allocation, PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require secret', OPENAI_API_KEY: 'not-a-real-key'}};
  return {repo, root, output, allocation, events, deps, options, alarm: value => alarm(value), childCalls: () => childCalls};
}

test('preparation arguments retain fixed producer scope, explicit heavy opt-in and issued output', () => {
  assert.deepEqual(parsePreparationArguments(['--output', '/new', '--timeout-ms', '30000', '--', 'prepare-seed', '--allow-heavy']),
    {output: '/new', timeoutMs: 30000, args: ['prepare-seed', '--allow-heavy']});
  for (const args of [['prepare-seed'], ['catalog', '--allow-heavy'], ['prepare-seed', '--allow-heavy', '--output', '/escape'],
    ['prepare', '--allow-heavy', '--repo', '/other'], ['prepare', '--allow-heavy', '--catalog-output', '/elsewhere'],
    ['prepare', '--allow-heavy', '--allow-heavy'], ['prepare', '--allow-heavy', '--seed', 'bad\npath']]) assert.throws(() => preparationArguments(args));
});

test('guards propagate by exact known import and stricter inherited store guard is never weakened for seed', () => {
  const session = join(REPO, 'tests/session/no-egress.mjs'), store = join(REPO, 'tests/store/no-network.mjs');
  assert.deepEqual(preparationGuardArguments(REPO, 'prepare', ['--import', session]), ['--import', session, '--import', store]);
  assert.deepEqual(preparationGuardArguments(REPO, 'prepare-seed', ['--import=' + session]), ['--import', session]);
  for (const args of [['--import', store], ['--import', '/unknown.mjs'], ['--require', '/guard.cjs'], ['-r/guard.cjs']]) assert.throws(() => preparationGuardArguments(REPO, 'prepare-seed', args));
});

test('fresh outer output leaves the producer child absent and seals only after producer cleanup', async t => {
  const f = await fixture(t), result = await runFixturePreparation(f.options, f.deps);
  assert.equal(result.effectiveOutcome, 'PASS'); assert.equal(result.qualification, false);
  assert.deepEqual(f.events, ['monitor', 'child', 'closed', 'finish', 'retain', 'verify', 'release']);
  assert.equal(result.producerCloseObserved, true); assert.equal(result.leaseReleased, true); assert.equal(result.checkoutReleased, true);
  const receipt = JSON.parse(await readFile(join(f.output, 'receipt.json'), 'utf8'));
  assert.equal(receipt.descriptor.bytes, 19); assert.equal(receipt.rawOutcome, 'PASS');
  await assert.rejects(lstat(join(f.repo, 'artifacts/qualification/active.lock')), {code: 'ENOENT'});
  await assert.rejects(runFixturePreparation(f.options, f.deps), /already exists/); assert.equal(f.childCalls(), 1);
});

test('allocation escape and symlink ancestors are refused before child or output creation', async t => {
  const f = await fixture(t);
  await assert.rejects(runFixturePreparation({...f.options, output: join(f.repo, 'artifacts', 'outside')}, f.deps));
  await symlink(f.root, join(f.root, 'alias'));
  await assert.rejects(runFixturePreparation({...f.options, output: join(f.root, 'alias', 'new')}, f.deps), /alias/);
  assert.equal(f.childCalls(), 0); await assert.rejects(lstat(f.output), {code: 'ENOENT'});
});

test('initial unknown or ceiling refuses preparation but still finishes and retains acquired monitor', async t => {
  for (const alarm of [{status: 'INCONCLUSIVE', level: 'unknown', percent: null}, {status: 'FAIL', level: 'ceiling', percent: 90}]) {
    const f = await fixture(t), original = f.deps.monitorFactory;
    f.deps.monitorFactory = options => original({...options, onAlarm: () => options.onAlarm(alarm)});
    const result = await runFixturePreparation(f.options, f.deps);
    assert.equal(result.rawOutcome, 'FAIL'); assert.equal(f.childCalls(), 0);
    assert.deepEqual(f.events, ['monitor', 'finish', 'retain', 'verify', 'release']);
  }
});

test('eighty-percent target warning preserves the admitted original threshold', async t => {
  const f = await fixture(t), original = f.deps.monitorFactory;
  f.deps.monitorFactory = options => original({...options, onAlarm: () => options.onAlarm({status: 'PASS', level: 'target', percent: 80})});
  assert.equal((await runFixturePreparation(f.options, f.deps)).effectiveOutcome, 'PASS'); assert.equal(f.childCalls(), 1);
});

test('later storage alarm reaches the child abort and audit waits for its cleanup settlement', async t => {
  const f = await fixture(t);
  f.deps.childRunner = async (_exe, _argv, options) => {
    f.events.push('child'); f.alarm({status: 'FAIL', level: 'ceiling', percent: 90});
    assert.equal(options.abortSignal.aborted, true);
    await new Promise(resolve => setImmediate(resolve)); f.events.push('closed');
    return {code: null, signal: 'SIGKILL', timedOut: false, interrupted: true, exitObserved: true};
  };
  const result = await runFixturePreparation(f.options, f.deps);
  assert.equal(result.rawOutcome, 'FAIL'); assert.deepEqual(f.events, ['monitor', 'child', 'closed', 'finish', 'retain', 'verify', 'release']);
  assert.equal(JSON.parse(await readFile(join(f.output, 'receipt.json'), 'utf8')).storageAlarm.level, 'ceiling');
});

test('original producer failure and partial artifact survive passing storage', async t => {
  const f = await fixture(t);
  f.deps.childRunner = async (_exe, argv) => {
    await mkdir(argv.at(-1)); await writeFile(join(argv.at(-1), 'failure-evidence'), 'unchanged');
    return {code: 1, signal: null, timedOut: false, interrupted: false};
  };
  const result = await runFixturePreparation(f.options, f.deps);
  assert.equal(result.rawOutcome, 'FAIL'); assert.equal(result.effectiveOutcome, 'FAIL');
  assert.equal(await readFile(join(f.output, 'prepared/failure-evidence'), 'utf8'), 'unchanged');
  assert(f.events.includes('finish') && f.events.includes('release'));
});

test('zero exit without descriptor and changed source cannot claim effective preparation success', async t => {
  const f = await fixture(t);
  f.deps.childRunner = async () => ({code: 0, signal: null, timedOut: false, interrupted: false});
  assert.equal((await runFixturePreparation(f.options, f.deps)).effectiveOutcome, 'FAIL');
  const g = await fixture(t); let reads = 0;
  g.deps.sourceProvider = async () => ({...identity, digest: (++reads === 1 ? 'a' : 'b').repeat(64)});
  const result = await runFixturePreparation(g.options, g.deps);
  assert.equal(result.rawOutcome, 'PASS'); assert.equal(result.effectiveOutcome, 'INCONCLUSIVE');
});

test('failed audit still attempts retention while uncertain producer error retains owned exclusion', async t => {
  const f = await fixture(t), original = f.deps.monitorFactory;
  f.deps.monitorFactory = async options => {const m = await original(options); return {...m, async finish() {f.events.push('finish'); throw Error('synthetic audit failure');}};};
  f.deps.childRunner = async () => {throw Error('original producer refusal');};
  const result = await runFixturePreparation(f.options, f.deps);
  assert.equal(result.effectiveOutcome, 'FAIL'); assert.deepEqual(f.events, ['monitor', 'finish', 'retain', 'verify']);
  assert.equal(result.exclusionRetained, true); assert.equal(result.leaseReleased, false); assert.equal(result.checkoutReleased, false);
  assert((await lstat(join(f.repo, 'artifacts/qualification/active.lock'))).isFile());
  const receipt = JSON.parse(await readFile(join(f.output, 'receipt.json'), 'utf8'));
  assert.equal(receipt.errors[0].message, 'original producer refusal'); assert(result.lifecycleErrors.some(x => x.stage === 'audit-finish'));
});

test('an existing checkout lock is never replaced or removed on rejected preparation', async t => {
  const f = await fixture(t), lock = join(f.repo, 'artifacts/qualification/active.lock');
  await mkdir(dirname(lock), {recursive: true}); await writeFile(lock, 'another owner');
  const result = await runFixturePreparation(f.options, f.deps);
  assert.equal(result.rawOutcome, 'FAIL'); assert.equal(f.childCalls(), 0); assert.equal(await readFile(lock, 'utf8'), 'another owner');
});

test('real synthetic child, real monitor and independent audit replay preserve closed output', async t => {
  const f = await fixture(t); delete f.deps.monitorFactory; delete f.deps.auditRetainer; delete f.deps.auditVerifier;
  f.deps.childRunner = (executable, argv, options) => {
    const target = JSON.stringify(argv.at(-1));
    const script = `const fs=require('node:fs');fs.mkdirSync(${target});fs.writeFileSync(${target}+'/seed.json','{"synthetic":true}\\n');`;
    return boundedChild(executable, ['--import', join(REPO, 'tests/session/no-egress.mjs'), '-e', script], options);
  };
  const result = await runFixturePreparation(f.options, f.deps);
  assert.equal(result.effectiveOutcome, 'PASS'); assert.equal(result.producerCloseObserved, true); assert.equal(result.qualification, false);
  const path = join(f.output, 'receipt.json'), receipt = JSON.parse(await readFile(path, 'utf8'));
  assert.equal((await verifyEvidenceAudit(receipt.evidenceStorage, path)).status, 'PASS');
  assert.equal(JSON.parse(await readFile(join(f.output, 'evidence-storage/retention.json'), 'utf8')).automaticPruning, false);
});

test('real synthetic child is reaped on injected storage ceiling before final storage sealing', async t => {
  const f = await fixture(t);
  f.deps.childRunner = (executable, _argv, options) => boundedChild(executable,
    ['--import', join(REPO, 'tests/session/no-egress.mjs'), '-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
    {...options, onStdout: bytes => {options.onStdout(bytes); f.alarm({status: 'FAIL', level: 'ceiling', percent: 90});}});
  const result = await runFixturePreparation(f.options, f.deps);
  assert.equal(result.rawOutcome, 'FAIL'); assert.equal(result.producerCloseObserved, true);
  const receipt = JSON.parse(await readFile(join(f.output, 'receipt.json'), 'utf8'));
  assert.equal(receipt.producer.interrupted, true); assert.deepEqual(receipt.producer.requestedSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.leaseReleased, true); assert.equal(result.checkoutReleased, true);
});

test('changed allocation identity at monitor admission refuses the child and still seals acquired audit', async t => {
  const f = await fixture(t), original = f.deps.monitorFactory;
  f.deps.monitorFactory = async options => {
    const monitor = await original(options);
    return {...monitor, reference: {...monitor.reference, allocationIdentity: {bytes: 1, sha256: 'b'.repeat(64)}}};
  };
  const result = await runFixturePreparation(f.options, f.deps);
  assert.equal(result.rawOutcome, 'FAIL'); assert.equal(f.childCalls(), 0);
  assert.deepEqual(f.events, ['monitor', 'finish', 'retain', 'verify', 'release']);
  assert.match(JSON.parse(await readFile(join(f.output, 'receipt.json'), 'utf8')).errors[0].message, /allocation changed/);
});

test('cancellation during final audit replay cannot turn a finished producer into effective PASS', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.deps.auditVerifier = async () => {f.events.push('verify'); controller.abort('synthetic late cancellation'); return {status: 'PASS'};};
  const result = await runFixturePreparation({...f.options, signal: controller.signal}, f.deps);
  const receipt = JSON.parse(await readFile(join(f.output, 'receipt.json'), 'utf8'));
  assert.equal(receipt.rawOutcome, 'PASS'); assert.equal(receipt.interrupted, false);
  assert.equal(result.rawOutcome, 'PASS'); assert.equal(result.effectiveOutcome, 'FAIL'); assert.equal(result.interrupted, true);
  assert.equal(result.leaseReleased, true); assert.equal(result.checkoutReleased, true);
});

test('timed-out child without observed close retains exclusions after bounded cancellation', async t => {
  const f = await fixture(t);
  f.deps.childRunner = async () => ({code: null, signal: null, timedOut: true, interrupted: false, exitObserved: false, requestedSignals: ['SIGTERM', 'SIGKILL']});
  const result = await runFixturePreparation(f.options, f.deps);
  assert.equal(result.effectiveOutcome, 'FAIL'); assert.equal(result.producerCloseObserved, false); assert.equal(result.exclusionRetained, true);
  assert.equal(result.leaseReleased, false); assert.equal(result.checkoutReleased, false); assert(!f.events.includes('release'));
  assert((await lstat(result.retainedExclusions.checkout)).isFile());
  assert.equal(result.lifecycleErrors.find(row => row.stage === 'producer-closure').message,
    'Producer close unobserved; owned host and checkout exclusions retained for inspection');
});

test('missing source or installed dependency identity refuses before producer and releases unused exclusion', async t => {
  for (const [provider, value] of [['dependencyProvider', null], ['dependencyProvider', {...identity, files: []}], ['sourceProvider', {digest: 'not-a-digest', files: identity.files}]]) {
    const f = await fixture(t); f.deps[provider] = async () => value;
    const result = await runFixturePreparation(f.options, f.deps);
    assert.equal(f.childCalls(), 0); assert.equal(result.producerStarted, false); assert.equal(result.effectiveOutcome, 'FAIL');
    assert.equal(result.leaseReleased, true); assert.equal(result.checkoutReleased, true); assert.equal(result.exclusionRetained, false);
    assert.match(JSON.parse(await readFile(join(f.output, 'receipt.json'), 'utf8')).errors[0].message, /existing usable source and installed dependency identities/);
  }
});

test('cancellation during finalization write retains a supplement and returns failure without rewriting prior records', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.deps.finalizationWriter = async (path, bytes, options) => {
    await writeFile(path, bytes, options);
    if (path.endsWith('/finalization.json')) controller.abort('synthetic final-write cancellation');
  };
  const result = await runFixturePreparation({...f.options, signal: controller.signal}, f.deps);
  const original = JSON.parse(await readFile(join(f.output, 'finalization.json'), 'utf8'));
  const late = JSON.parse(await readFile(join(f.output, 'interruption-after-finalization.json'), 'utf8'));
  assert.equal(original.effectiveOutcome, 'PASS'); assert.equal(original.interrupted, false);
  assert.equal(result.effectiveOutcome, 'FAIL'); assert.equal(result.interrupted, true); assert.equal(result.finalizationRecordPrecedesInterruption, true);
  assert.deepEqual(result, late); assert.equal(JSON.parse(await readFile(join(f.output, 'receipt.json'), 'utf8')).rawOutcome, 'PASS');
});
