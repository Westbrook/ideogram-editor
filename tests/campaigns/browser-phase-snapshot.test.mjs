import assert from 'node:assert/strict';
import test from 'node:test';
import { readPhaseSnapshot, releasePendingPhaseSnapshots } from '../../tooling/qualification/campaigns/browser-phase-snapshot.mjs';

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture({ extraction, projectFailure, failProject = projectFailure !== undefined, acquisitionFailures = 0, releaseFailures = 0, disposeFailures = 0, missing = false } = {}) {
  const events = [], handles = [], owners = new Map();
  const page = {
    async evaluateHandle(create, key) {
      events.push('acquire');
      assert.match(key, /^[A-Za-z0-9_-]{1,64}$/);
      assert.match(create.toString(), /readSnapshot/);
      assert.doesNotMatch(create.toString(), /\.snapshot\(/);
      if (owners.has(key)) return owners.get(key);
      let released = false;
      const owner = missing ? null : Object.freeze({ get value() { assert.equal(released, false, 'extraction must keep the owner live'); return { trace: { records: [1, 2] }, allocations: { cpuBytes: 42 } }; }, release() { events.push('product-release'); released = true; } });
      const handle = {
        async evaluate(project) {
          if (!project.toString().includes('owner.release()')) {
            events.push('extract-start');
            const value = project(owner);
            if (extraction) await extraction.promise;
            assert.equal(released, false, 'owner must survive the whole transport wait');
            events.push('extract-end');
            if (failProject) throw projectFailure;
            return value;
          }
          events.push('release-attempt');
          if (releaseFailures-- > 0) throw Error('release transport failed');
          return project(owner);
        },
        async dispose() { events.push('dispose'); if (disposeFailures-- > 0) throw Error('dispose transport failed'); },
      };
      handles.push(handle); owners.set(key, handle);
      if (acquisitionFailures-- > 0) throw Error('acquire acknowledgement lost');
      return handle;
    },
  };
  return { page, events, handles };
}

test('retains the owner until extraction transport resolves, then releases before dispose', async () => {
  const extraction = deferred(), f = fixture({ extraction });
  const read = readPhaseSnapshot(f.page, owner => owner.value.allocations);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.events, ['acquire', 'extract-start']);
  extraction.resolve(); assert.deepEqual(await read, { cpuBytes: 42 });
  assert.deepEqual(f.events, ['acquire', 'extract-start', 'extract-end', 'release-attempt', 'product-release', 'dispose']);
  assert.deepEqual(await releasePendingPhaseSnapshots(f.page), { pendingHandles: 0, complete: true });
});

test('failed extraction still releases and preserves the original failure', async () => {
  const problem = Error('serialization failed'), f = fixture({ projectFailure: problem });
  await assert.rejects(readPhaseSnapshot(f.page), error => error === problem);
  assert.deepEqual(f.events.slice(-3), ['release-attempt', 'product-release', 'dispose']);
});

test('failed release cannot return a successful sample and retains the exact handle for cleanup retry', async () => {
  const f = fixture({ releaseFailures: 1 });
  await assert.rejects(readPhaseSnapshot(f.page), { code: 'PHASE_SNAPSHOT_RELEASE' });
  assert.equal(f.events.includes('dispose'), false);
  assert.deepEqual(await releasePendingPhaseSnapshots(f.page), { pendingHandles: 0, complete: true });
  assert.equal(f.handles.length, 1, 'retry must use the retained owner, not acquire a replacement');
  assert.deepEqual(f.events.slice(-3), ['release-attempt', 'product-release', 'dispose']);
});

test('failed disposal retains the handle but does not release the product twice', async () => {
  const f = fixture({ disposeFailures: 1 });
  await assert.rejects(readPhaseSnapshot(f.page), { code: 'PHASE_SNAPSHOT_RELEASE' });
  await releasePendingPhaseSnapshots(f.page);
  assert.equal(f.events.filter(value => value === 'product-release').length, 1);
  assert.equal(f.events.filter(value => value === 'dispose').length, 2);
});

test('cleanup waits for active extraction and prohibits racing acquisitions', async () => {
  const extraction = deferred(), f = fixture({ extraction });
  const read = readPhaseSnapshot(f.page);
  await Promise.resolve(); await Promise.resolve();
  const cleanup = releasePendingPhaseSnapshots(f.page);
  await assert.rejects(readPhaseSnapshot(f.page), /CLEANUP_ACTIVE/);
  assert.equal(f.events.includes('product-release'), false);
  extraction.resolve(); await read; await cleanup;
  assert.equal(f.events.filter(value => value === 'product-release').length, 1);
});

test('unavailable scoped instrumentation remains null, with its remote handle disposed', async () => {
  const f = fixture({ missing: true });
  assert.equal(await readPhaseSnapshot(f.page), null);
  assert.deepEqual(f.events.slice(-2), ['release-attempt', 'dispose']);
});

test('a later read must finish failed cleanup before acquiring another product slot', async () => {
  const f = fixture({ releaseFailures: 2 });
  await assert.rejects(readPhaseSnapshot(f.page), { code: 'PHASE_SNAPSHOT_RELEASE' });
  await assert.rejects(readPhaseSnapshot(f.page), { code: 'PHASE_SNAPSHOT_RELEASE' });
  assert.equal(f.handles.length, 1);
  await releasePendingPhaseSnapshots(f.page);
  assert.deepEqual(await readPhaseSnapshot(f.page), { trace: { records: [1, 2] }, allocations: { cpuBytes: 42 } });
});

test('falsey extraction failures are not converted into successful observations', async () => {
  for (const problem of [undefined, null, 0, false, '']) {
    const f = fixture({ projectFailure: problem, failProject: true });
    let rejected = false;
    try { await readPhaseSnapshot(f.page); } catch (error) { rejected = true; assert.equal(error, problem); }
    assert.equal(rejected, true);
    assert.deepEqual(f.events.slice(-3), ['release-attempt', 'product-release', 'dispose']);
  }
});

test('ambiguous acquisition recovers and releases the original keyed owner without returning success', async () => {
  const f = fixture({ acquisitionFailures: 1 });
  await assert.rejects(readPhaseSnapshot(f.page), /acquire acknowledgement lost/);
  assert.equal(f.handles.length, 1);
  assert.deepEqual(f.events, ['acquire', 'acquire', 'release-attempt', 'product-release', 'dispose']);
  assert.deepEqual(await releasePendingPhaseSnapshots(f.page), { pendingHandles: 0, complete: true });
});

test('at most four runner read entries can wait on product extraction', async () => {
  const extraction = deferred(), f = fixture({ extraction });
  const reads = Array.from({ length: 4 }, () => readPhaseSnapshot(f.page));
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(readPhaseSnapshot(f.page), /PHASE_SNAPSHOT_READ_LIMIT/);
  assert.equal(f.handles.length, 4);
  extraction.resolve(); await Promise.all(reads);
  assert.equal(f.events.filter(value => value === 'product-release').length, 4);
  assert.deepEqual(await releasePendingPhaseSnapshots(f.page), { pendingHandles: 0, complete: true });
});
