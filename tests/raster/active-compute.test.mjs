import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';
import {diagnosticMemoryURL,phasesURL} from '../owned-preview-module.mjs';

// These deterministic accounting tests exercise the real kernel timer. They do
// not measure a device, qualify R10 or substitute for the parent operation clock.
const data = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const coreURL=data((await transformWithOxc(await readFile('src/raster/core.ts','utf8'),'core.ts')).code);
const resourcePlanURL=data((await transformWithOxc(await readFile('server/raster/resource-plan.ts','utf8'),'resource-plan.ts')).code.replaceAll('../../src/raster/core.js',coreURL));
const activeCode = (await transformWithOxc(await readFile('server/raster/active-compute.ts', 'utf8'), 'active-compute.ts')).code
  .replaceAll('../../src/observability/phases.js', phasesURL).replaceAll('../../src/observability/diagnostic-memory.js',diagnosticMemoryURL).replaceAll('./resource-plan.js',resourcePlanURL);
const { ActiveCompute } = await import(data(activeCode));

const owners=new Set(),reads=[];
function createActive(options){const value=new ActiveCompute(options);owners.add(value);return value;}
function readActive(compute){const read=compute.readSnapshot();reads.push(read);return read.value;}
function finishActive(compute,outcome){compute.finish(outcome);return readActive(compute);}
test.afterEach(()=>{for(const read of reads.splice(0))read.release();for(const value of owners)value.dispose();owners.clear();});
function fixture(options = {}) {
  let time = 100;
  const compute = createActive({ now: () => time, wallNow: () => 1_800_000_000_100, ...options });
  return { compute, at(value) { time = value; } };
}

const emptyOperations = { accumulator: 0, contribution: 0, fold: 0, finish: 0, preserve: 0, resample: 0, matte: 0, 'coverage-scan': 0 };

test('idle accounting has explicit worker identity without fabricating compute intervals', () => {
  const f = fixture();
  assert.deepEqual(readActive(f.compute), { schemaVersion: 1, kind: 'raster-active-compute-1', lane: 'raster-worker', clockOriginUnixMs: 1_800_000_000_000, clockUncertaintyMs: null, context: {}, boundary: 'synchronous-kernel-elapsed-excluding-io', outcome: 'incomplete', complete: false, startedMs: null, endedMs: null, unionMs: 0, totalMs: 0, intervalCount: 0, intervals: [], omittedIntervals: 0, invalid: 0, operations: emptyOperations });
  f.at(500); assert.equal(f.compute.exclude(() => 'outside-kernel'), 'outside-kernel');
  assert.equal(readActive(f.compute).startedMs, null); assert.equal(readActive(f.compute).intervalCount, 0); assert.equal(readActive(f.compute).unionMs, 0);
});

test('synchronous kernels preserve results while excluding between-kernel elapsed gaps', () => {
  const f = fixture();
  assert.equal(f.compute.run('contribution', () => { f.at(112); return 42; }), 42);
  f.at(1_000); f.compute.run('fold', () => { f.at(1_025); });
  const snapshot = finishActive(f.compute);
  assert.equal(snapshot.startedMs, 100); assert.equal(snapshot.endedMs, 1_025); assert.equal(snapshot.unionMs, 37); assert.equal(snapshot.totalMs, 37);
  assert.deepEqual(snapshot.intervals, [{ startMs: 100, endMs: 112 }, { startMs: 1_000, endMs: 1_025 }]);
  assert.equal(snapshot.intervalCount, 2); assert.equal(snapshot.complete, true); assert.equal(snapshot.outcome, 'completed');
  assert.deepEqual(snapshot.operations, { ...emptyOperations, contribution: 1, fold: 1 });
});

test('nested kernels contribute one interval union instead of double counting elapsed work', () => {
  const f = fixture();
  f.compute.run('contribution', () => {
    f.at(110); assert.equal(f.compute.run('resample', () => { f.at(125); return 'sampled'; }), 'sampled');
    f.at(140);
  });
  const snapshot = finishActive(f.compute);
  assert.equal(snapshot.unionMs, 40); assert.equal(snapshot.totalMs, 40); assert.equal(snapshot.intervalCount, 1);
  assert.deepEqual(snapshot.intervals, [{ startMs: 100, endMs: 140 }]);
  assert.deepEqual(snapshot.operations, { ...emptyOperations, contribution: 1, resample: 1 });
});

test('lazy synchronous reads split active compute and remain excluded from R10 child time', () => {
  const f = fixture();
  f.compute.run('preserve', () => {
    f.at(110); assert.equal(f.compute.exclude(() => { f.at(150); return 'decoded-row'; }), 'decoded-row');
    f.at(170);
  });
  const snapshot = finishActive(f.compute);
  assert.deepEqual(snapshot.intervals, [{ startMs: 100, endMs: 110 }, { startMs: 150, endMs: 170 }]);
  assert.equal(snapshot.unionMs, 30); assert.equal(snapshot.totalMs, 30); assert.equal(snapshot.endedMs - snapshot.startedMs, 70);
  assert.equal(snapshot.complete, true);
});

test('nested read exclusions resume only after the outer excluded syscall window ends', () => {
  const f = fixture();
  f.compute.run('contribution', () => {
    f.at(105); f.compute.exclude(() => {
      f.at(115); f.compute.exclude(() => { f.at(140); });
      f.at(160);
    });
    f.at(170);
  });
  const snapshot = finishActive(f.compute);
  assert.deepEqual(snapshot.intervals, [{ startMs: 100, endMs: 105 }, { startMs: 160, endMs: 170 }]);
  assert.equal(snapshot.unionMs, 15); assert.equal(snapshot.intervalCount, 2); assert.equal(snapshot.complete, true);
});

test('an exclusion inside a nested kernel does not resume duplicate outer intervals', () => {
  const f = fixture();
  f.compute.run('contribution', () => {
    f.at(110); f.compute.run('resample', () => { f.at(120); f.compute.exclude(() => { f.at(150); }); f.at(160); });
    f.at(180);
  });
  const snapshot = finishActive(f.compute);
  assert.equal(snapshot.unionMs, 50); assert.equal(snapshot.intervalCount, 2);
  assert.deepEqual(snapshot.intervals, [{ startMs: 100, endMs: 120 }, { startMs: 150, endMs: 180 }]);
});

test('kernel exceptions retain elapsed intervals, rethrow the original and make completion failed', () => {
  const f = fixture(), failure = Error('Private provider prompt must not enter the metric');
  assert.throws(() => f.compute.run('fold', () => { f.at(120); throw failure; }), error => error === failure);
  const snapshot = finishActive(f.compute,'completed');
  assert.equal(snapshot.outcome, 'failed'); assert.equal(snapshot.complete, false); assert.equal(snapshot.unionMs, 20); assert.equal(snapshot.intervalCount, 1);
  assert(!JSON.stringify(snapshot).includes('Private')); assert(!JSON.stringify(snapshot).includes('provider prompt'));
});

test('a read failure remains a failed compute attempt even if a surrounding kernel catches it', () => {
  const f = fixture(), failure = Error('Read failed');
  f.compute.run('preserve', () => {
    f.at(110); assert.throws(() => f.compute.exclude(() => { f.at(140); throw failure; }), error => error === failure);
    f.at(150);
  });
  const snapshot = finishActive(f.compute);
  assert.equal(snapshot.outcome, 'failed'); assert.equal(snapshot.complete, false); assert.equal(snapshot.unionMs, 20);
  assert.deepEqual(snapshot.intervals, [{ startMs: 100, endMs: 110 }, { startMs: 140, endMs: 150 }]);
});

test('a caught nested kernel failure cannot be relabeled as successful outer compute', () => {
  const f = fixture(), failure = Error('Kernel failed');
  f.compute.run('contribution', () => { f.at(110); assert.throws(() => f.compute.run('resample', () => { f.at(120); throw failure; }), error => error === failure); f.at(130); });
  const snapshot = finishActive(f.compute); assert.equal(snapshot.outcome, 'failed'); assert.equal(snapshot.complete, false); assert.equal(snapshot.unionMs, 30); assert.equal(snapshot.intervalCount, 1);
});

test('Promise and thenable returns cannot masquerade as finished synchronous kernel work', () => {
  for (const result of [Promise.resolve(1), { then() {} }, Object.assign(() => {}, { then() {} })]) {
    const f = fixture(); assert.throws(() => f.compute.run('matte', () => result), /ACTIVE_COMPUTE_ASYNC/);
    assert.equal(finishActive(f.compute).outcome, 'failed'); assert.equal(readActive(f.compute).complete, false);
  }
  const f = fixture(); assert.throws(() => f.compute.run('preserve', () => f.compute.exclude(() => Promise.resolve())), /ACTIVE_COMPUTE_ASYNC/);
  assert.equal(finishActive(f.compute).outcome, 'failed');
});

test('clock reversal and nonfinite samples invalidate the measurement instead of certifying zero work', () => {
  for (const bad of [90, -1, NaN, Infinity]) {
    const f = fixture(); f.compute.run('fold', () => f.at(bad));
    const snapshot = finishActive(f.compute); assert(snapshot.invalid > 0); assert.equal(snapshot.complete, false); assert(Number.isFinite(snapshot.totalMs)); assert(snapshot.totalMs >= 0);
  }
});

test('nonfinite origin and initial monotonic clock remain visibly invalid through finalization', () => {
  for (const wall of [NaN, Infinity, -Infinity]) {
    const f = fixture({ wallNow: () => wall }); f.compute.run('fold', () => f.at(110));
    const snapshot = finishActive(f.compute); assert(snapshot.invalid > 0); assert.equal(snapshot.complete, false); assert(Number.isFinite(snapshot.clockOriginUnixMs));
  }
  let now = NaN; const compute = createActive({ now: () => now, wallNow: () => 1_000 }); now = 10; compute.run('fold', () => { now = 20; });
  assert.equal(finishActive(compute).complete, false); assert(readActive(compute).invalid > 0);
});

test('bounded interval samples preserve exact aggregate time and exact omitted interval count', () => {
  const f = fixture({ capacity: 2 });
  for (let i = 0; i < 6; i++) { f.at(100 + i * 10); f.compute.run('fold', () => f.at(103 + i * 10)); }
  const snapshot = finishActive(f.compute);
  assert.equal(snapshot.intervalCount, 6); assert.equal(snapshot.omittedIntervals, 4); assert.equal(snapshot.unionMs, 18); assert.equal(snapshot.totalMs, 18); assert.equal(snapshot.operations.fold, 6);
  assert.deepEqual(snapshot.intervals, [{ startMs: 100, endMs: 103 }, { startMs: 110, endMs: 113 }]);
  assert.equal(snapshot.complete, true, 'Omitted diagnostic samples do not erase known scalar accounting');
});

test('fractional interval accounting retains the same total with or without retained samples', () => {
  const f = fixture({ capacity: 1 });
  for (let i = 0; i < 16; i++) { f.at(100 + i); f.compute.run('fold', () => f.at(100 + i + 0.125)); }
  const snapshot = finishActive(f.compute); assert.equal(snapshot.totalMs, 2); assert.equal(snapshot.unionMs, 2); assert.equal(snapshot.intervalCount, 16); assert.equal(snapshot.omittedIntervals, 15);
});

test('private metadata and getters are omitted while safe source identities remain immutable', () => {
  let getters = 0;
  const context = { assetId: 'asset-existing', documentId: 'document-existing', width: 512, prompt: 'Private prompt', url: 'https://remote.invalid/secret' };
  Object.defineProperty(context, 'caption', { enumerable: true, get() { getters++; throw Error('Private getter'); } });
  const f = fixture({ context }); context.assetId = 'mutated-input'; f.compute.run('fold', () => f.at(105));
  const snapshot = finishActive(f.compute); assert.equal(getters, 0); assert.deepEqual(snapshot.context, { assetId: 'asset-existing', documentId: 'document-existing', width: 512 });
  assert(!JSON.stringify(snapshot).includes('Private')); assert(!JSON.stringify(snapshot).includes('remote.invalid'));
  snapshot.context.assetId = 'mutated-output'; snapshot.intervals[0].startMs = -1; snapshot.operations.fold = 99;
  assert.equal(readActive(f.compute).context.assetId, 'asset-existing'); assert.equal(readActive(f.compute).intervals[0].startMs, 100); assert.equal(readActive(f.compute).operations.fold, 1);
});

test('finalization is idempotent and later work cannot mutate the completed accounting', () => {
  const f = fixture(); f.compute.run('fold', () => f.at(110)); const final = finishActive(f.compute);
  f.at(200); assert.deepEqual(finishActive(f.compute,'failed'), final);
  assert.throws(() => f.compute.run('fold', () => {}), /ACTIVE_COMPUTE_FINISHED/); assert.throws(() => f.compute.exclude(() => {}), /ACTIVE_COMPUTE_FINISHED/);
  assert.deepEqual(readActive(f.compute), final);
});

test('explicitly incomplete or failed lifecycle cannot certify complete compute', () => {
  for (const outcome of ['incomplete', 'failed']) {
    const f = fixture(); f.compute.run('fold', () => f.at(110)); const snapshot = finishActive(f.compute,outcome);
    assert.equal(snapshot.outcome, outcome); assert.equal(snapshot.complete, false); assert.equal(snapshot.totalMs, 10);
  }
});

test('invalid capacity and arbitrary kernel labels cannot bypass bounded private telemetry', () => {
  for (const capacity of [0, -1, 1.5, NaN, Infinity, 129, '2']) assert.throws(() => fixture({ capacity }), /ACTIVE_COMPUTE_CAPACITY/);
  const f = fixture(); let calls = 0;
  for (const kind of ['', 'Private prompt', 'https://remote.invalid/token', 'toString', '__proto__']) assert.throws(() => f.compute.run(kind, () => calls++), /ACTIVE_COMPUTE_KERNEL/);
  assert.equal(calls, 0); assert.equal(readActive(f.compute).intervalCount, 0); assert.deepEqual(readActive(f.compute).operations, emptyOperations);
});

test('finalizing from inside an excluded interval stays invalid and frozen while the stack unwinds', () => {
  const f = fixture(); let final;
  f.compute.run('preserve', () => { f.at(110); f.compute.exclude(() => { f.at(120); final = finishActive(f.compute); f.at(130); }); f.at(140); });
  assert.equal(final.complete, false); assert(final.invalid > 0); assert.deepEqual(readActive(f.compute), final);
});

test('arbitrary final outcomes are omitted and cannot certify successful or private telemetry', () => {
  const f = fixture(); f.compute.run('fold', () => f.at(110));
  const snapshot = finishActive(f.compute,'Private failure text https://remote.invalid/secret');
  assert.equal(snapshot.outcome, 'incomplete'); assert.equal(snapshot.complete, false); assert(snapshot.invalid > 0);
  assert(!JSON.stringify(snapshot).includes('Private')); assert(!JSON.stringify(snapshot).includes('remote.invalid'));
});
