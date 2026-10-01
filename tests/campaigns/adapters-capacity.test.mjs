import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityRecheckGapMs, observeCapacityChecks } from '../../tooling/qualification/campaigns/adapter-transfers.mjs';

test('capacity gap requires actual successful observations and includes both transfer edges', () => {
  assert.equal(capacityRecheckGapMs(0, 40000, []), null);
  assert.equal(capacityRecheckGapMs(0, 40000, [{ startMs: 100, endMs: 101, outcome: 'failed' }]), null);
  assert.equal(capacityRecheckGapMs(0, 40000, [{ startMs: 99, endMs: 100, outcome: 'expected' }]), 39900);
  assert.equal(capacityRecheckGapMs(0, 40000, [{ startMs: 99, endMs: 100, outcome: 'expected' }, { startMs: 15999, endMs: 16000, outcome: 'expected' }, { startMs: 31999, endMs: 32000, outcome: 'expected' }]), 16000);
  assert.equal(capacityRecheckGapMs(0, 40000, [{ startMs: -2, endMs: -1, outcome: 'expected' }, { startMs: 40000, endMs: 40001, outcome: 'expected' }]), null);
  assert.throws(() => capacityRecheckGapMs(10, 1, []));
});

test('capacity observer preserves method receiver, result, errors and original property ownership', () => {
  // This is an instrumentation unit, not capacity or performance qualification.
  const refusal = Object.assign(Error('fixture refusal'), { code: 'CAPACITY' });
  class Fixture { capacity(bytes) { assert.equal(this, instance); if (bytes === 3n) throw refusal; return bytes + 1n; } }
  const instance = new Fixture(), original = instance.capacity, observer = observeCapacityChecks(instance);
  assert.equal(observer.checks.length, 0, 'Installing the observer performs no check');
  assert.equal(instance.capacity(2n), 3n);
  assert.throws(() => instance.capacity(3n), error => error === refusal);
  assert.deepEqual(observer.checks.map(check => [check.requestedBytes, check.outcome]), [['2', 'expected'], ['3', 'failed']]);
  assert(observer.checks.every(check => check.endMs >= check.startMs));
  observer.restore(); observer.restore();
  assert.equal(instance.capacity, original); assert.equal(Object.hasOwn(instance, 'capacity'), false);
  instance.capacity(1n); assert.equal(observer.checks.length, 2);
});
