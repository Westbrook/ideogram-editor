import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsFromArgs, makePlan, verifyFixture, whitePixelHash, summarize, runCampaign, recoverSamples, routeRuntimeArguments, withTimingLockAt } from '../../tooling/qualification/runtime.mjs';
import { acquireTimingLock, timingHostIdentity, timingLockDirectory } from '../../tooling/qualification/campaigns/host.mjs';

test('exploratory execution shares the fixed host lock across TMPDIR changes and releases after failure', async t => {
  const directory = await realpath('/tmp'), oldTMPDIR = process.env.TMPDIR;
  const alternate = await mkdtemp(join(directory, 'runtime-timing-path-'));
  t.after(async () => { if (oldTMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTMPDIR; await rm(alternate, { recursive: true, force: true }); });
  process.env.TMPDIR = alternate;
  assert.equal(await timingLockDirectory(), directory, 'Production lock directory ignores TMPDIR');
  let entered = false;
  await assert.rejects(withTimingLockAt(alternate, async lock => {
    entered = true;
    assert.equal(lock.path, join(alternate, `ideogram-perf-${timingHostIdentity().hostnameHash.slice(7, 31)}.lock`));
    assert.equal(lock.borrowed, false);
    await assert.rejects(acquireTimingLock(alternate, { receiptId: randomUUID() }), { code: 'EEXIST' });
    const plan = spawnSync(process.execPath, [fileURLToPath(new URL('../../tooling/qualification/runtime.mjs', import.meta.url)), 'plan', '--sizes', 'normal'], { encoding: 'utf8' });
    assert.equal(plan.status, 0, plan.stderr); assert.equal(JSON.parse(plan.stdout).qualification, false);
    throw Error('Exploratory sample failed');
  }), /Exploratory sample failed/);
  assert.equal(entered, true);
  const next = await acquireTimingLock(alternate, { receiptId: randomUUID() });
  await next.release();
});

test('exploratory nested work validates an inherited lease and never accepts a boolean bypass', async t => {
  const alternate = await mkdtemp(join(tmpdir(), 'runtime-lease-'));
  t.after(() => rm(alternate, { recursive: true, force: true }));
  const owner = await acquireTimingLock(alternate, { receiptId: randomUUID() });
  try {
    for (const timingLease of [false, true, { ...owner.lease, lockNonce: 'substituted' }]) {
      let entered = false;
      await assert.rejects(withTimingLockAt(alternate, () => { entered = true; }, { timingLease }), /Timing lease/);
      assert.equal(entered, false);
    }
    const value = await withTimingLockAt(alternate, async lock => {
      assert.equal(lock.borrowed, true); assert.equal(lock.path, owner.path); assert.deepEqual(lock.identity, owner.identity);
      return 'measured callback';
    }, { timingLease: owner.lease });
    assert.equal(value, 'measured callback');
    await assert.rejects(acquireTimingLock(alternate, { receiptId: randomUUID() }), { code: 'EEXIST' });
  } finally { await owner.release(); }
});

test('explicit runtime campaign dispatch preserves exploratory mode and exact P/Q3 job scope', () => {
  assert.equal(routeRuntimeArguments(['plan', '--sizes', 'normal']), null);
  assert.deepEqual(routeRuntimeArguments(['run', '--campaign', 'H7,AH2', '--output', 'artifacts/new']), ['run', '--campaign', 'P', '--output', 'artifacts/new', '--jobs', 'H7,AH2']);
  assert.deepEqual(routeRuntimeArguments(['--campaign', 'I3']), ['--campaign', 'Q3', '--jobs', 'I3']);
  assert.deepEqual(routeRuntimeArguments(['plan', '--campaign', 'Q3', '--jobs', 'I0,I1']), ['plan', '--campaign', 'Q3', '--jobs', 'I0,I1']);
  for (const args of [['--campaign'], ['--campaign', 'P', '--campaign', 'Q3'], ['--campaign', 'C1', '--jobs', 'H1'], ['--campaign', 'C1,I3'], ['--campaign', 'H7,H7'], ['--campaign', 'TC1']]) assert.throws(() => routeRuntimeArguments(args));
});

const manifest = JSON.parse(await readFile(new URL('../raster/fixtures/resource-inputs.json', import.meta.url), 'utf8'));
const plan = (args = []) => makePlan(optionsFromArgs(args), manifest);
const completed = (selected, sequence, scored) => ({ sequence, scored, outcome: 'completed', phases: selected.phases.map(name => ({ name, outcome: 'completed', elapsedMs: 1 })) });

test('raster plan selects exact sealed normal/maximum codecs and explicit nonqualification scope', () => {
  const result = plan(['--formats', 'png,jpeg,webp-lossy,webp-lossless', '--cold', '2', '--warm', '3']);
  assert.equal(result.cells.length, 8); assert.equal(result.expected.scored, 40); assert.equal(result.expected.primes, 8); assert.equal(result.expected.childProcesses, 24);
  assert.equal(result.qualification, false);
  assert.equal(result.cells.find(c => c.id === 'maximum-jpeg').fixture.file, 'tests/raster/fixtures/max-progressive-jpeg.jpg');
  assert.deepEqual(new Set(result.cells.map(c => c.dimensions.width)), new Set([2048, 5000]));
  assert(result.limits.some(s => s.includes('not those complete workloads')));
  assert.equal(result.resourceCeilingBytes, 512 * 1024 * 1024);
  const fewer = plan(['--warm', '1']), more = plan(['--warm', '5']);
  assert(BigInt(more.estimatedDiskAdmissionBytes) > BigInt(fewer.estimatedDiskAdmissionBytes), 'Every retained warm repetition consumes disk headroom');
});

test('repeat, dimensions, unknown and duplicate command line input cannot change workload or produce unbounded jobs', () => {
  for (const args of [['--cold', '0'], ['--warm', '6'], ['--cold', '1.5'], ['--sizes', '2048'], ['--formats', 'png,png'], ['--output'], ['--cold', '1', '--cold', '2'], ['--timeout-seconds', '1801'], ['--qualified', 'true']]) assert.throws(() => optionsFromArgs(args));
  const edited = structuredClone(manifest); edited.fixtures[0].width = 1024;
  assert.throws(() => makePlan(optionsFromArgs([]), edited), /Invalid fixture/);
});

test('fixture verification checks actual bytes and rejects a substituted identity or symlink', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-fixture-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'tests/raster/fixtures'); await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('sealed synthetic bytes'), name = 'tests/raster/fixtures/test.png';
  const fixture = { file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(join(root, name), bytes); assert.equal((await verifyFixture(fixture, root)).bytes, bytes.length);
  await writeFile(join(root, name), Buffer.from('tampered synthetic byte')); await assert.rejects(verifyFixture(fixture, root), /identity mismatch/);
  await rm(join(root, name)); await writeFile(join(directory, 'other.png'), bytes); await symlink('other.png', join(root, name));
  await assert.rejects(verifyFixture(fixture, root), /ordinary file/);
  await assert.rejects(verifyFixture({ ...fixture, file: '../escape.png' }, root), /Unexpected fixture path/);
});

test('independent pixel golden spans the chunk boundary without a decoded image allocation', () => {
  for (const [width, height] of [[1, 1], [513, 513]]) {
    const expected = 'sha256:' + createHash('sha256').update(Buffer.alloc(width * height * 4, 255)).digest('hex');
    assert.equal(whitePixelHash(width, height), expected);
  }
  assert.throws(() => whitePixelHash(5001, 5000));
});

test('campaign requests independent cold children and one primed warm child per cell, retaining refusal and missing samples', async () => {
  const selected = plan(['--sizes', 'normal', '--cold', '2', '--warm', '3']); const invocations = [];
  const result = await runCampaign(selected, '/unused', async spec => {
    invocations.push(spec);
    return { cell: spec.cell, cache: spec.cache, ordinal: spec.ordinal, ...(spec.cache === 'warm' ? { outcome: 'incomplete', samples: [{ sequence: 1, scored: false, outcome: 'resource-refused' }] } : { outcome: 'completed', samples: [completed(selected, 1, true)] }) };
  });
  assert.deepEqual(invocations.map(s => [s.cache, s.count]), [['cold', 1], ['cold', 1], ['warm', 4]]);
  assert.equal(new Set(invocations.map(s => s.receipt)).size, 3);
  assert.equal(result.summary.outcome, 'incomplete');
  assert.deepEqual(result.summary.counts, { plannedScored: 5, plannedPrimes: 1, observedScored: 2, observedPrimes: 1, completedScored: 2, completedPrimes: 0 });
});

test('complete samples cannot hide process failure or missing primes and do not claim qualification', () => {
  const selected = plan(['--sizes', 'normal']);
  const good = [{ cell: selected.cells[0], cache: 'cold', ordinal: 1, outcome: 'completed', samples: [completed(selected, 1, true)] }, { cell: selected.cells[0], cache: 'warm', ordinal: 1, outcome: 'completed', samples: [completed(selected, 1, false), completed(selected, 2, true)] }];
  assert.equal(summarize(selected, good).outcome, 'completed-exploratory'); assert.equal(summarize(selected, good).qualification, false);
  const missingPrime = structuredClone(good); missingPrime[1].samples.shift(); assert.equal(summarize(selected, missingPrime).outcome, 'failed');
  const failure = structuredClone(good); failure[1].outcome = 'timed-out'; assert.equal(summarize(selected, failure).outcome, 'failed');
  const ceiling = structuredClone(good); ceiling[1].samples[1].outcome = 'failed'; assert.equal(summarize(selected, ceiling).outcome, 'failed');
  const shuffled = structuredClone(good); shuffled[0].samples.push(shuffled[1].samples.pop()); assert.equal(summarize(selected, shuffled).outcome, 'failed', 'Aggregate totals cannot substitute for per-cache cohorts');
  const missingPhase = structuredClone(good); missingPhase[1].samples[1].phases.pop(); assert.equal(summarize(selected, missingPhase).outcome, 'failed');
});

test('timeout recovery retains completed prime and partial scored attempt without inventing completed work', () => {
  const events = [
    { event: 'sample-start', sequence: 1, scored: false },
    { event: 'sample-end', sample: { sequence: 1, scored: false, outcome: 'completed', phases: [{ name: 'export' }] } },
    { event: 'sample-start', sequence: 2, scored: true },
    { event: 'phase-end', sequence: 2, phase: { name: 'stage-finalize', outcome: 'completed' } },
    { event: 'phase-timeout', sequence: 2, phase: { name: 'decode-prepare', outcome: 'timed-out' } },
  ].map(v => JSON.stringify(v)).join('\n') + '\n{"truncated';
  const recovered = recoverSamples(events, true);
  assert.equal(recovered.length, 2); assert.equal(recovered[0].outcome, 'completed'); assert.equal(recovered[1].outcome, 'timed-out');
  assert.deepEqual(recovered[1].phases.map(p => p.name), ['stage-finalize', 'decode-prepare']);
});
