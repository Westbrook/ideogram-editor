import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueAdmissionPressure } from '../../tooling/qualification/campaigns/browser-queue-pressure.mjs';

// Finite unit model of the production reservation contract. These tests do not
// certify disk behavior; the public campaign must observe the product's real
// QUEUE_METADATA_ADMISSION receipt under its actual Objects instance.
function ledger(limit = 10_000_000n) {
  const owned = new Map(), calls = [];
  const total = () => [...owned.values()].reduce((a, b) => a + b, 0n);
  const capacity = () => Object.assign(Error('CAPACITY'), { code: 'CAPACITY' });
  return { root: '/unit-only', calls, objects: {
    reserve(id, cost, enforce = true) {
      assert.equal(enforce, true, 'Fault holder must never bypass actual admission'); calls.push({ id, cost });
      const prior = owned.get(id); owned.delete(id);
      const charged = cost + (cost + 3n) / 4n;
      if (charged + total() > limit) { if (prior !== undefined) owned.set(id, prior); throw capacity(); }
      owned.set(id, charged);
    },
    unreserve(id) { owned.delete(id); },
    reservationInventory() { return { reservedBytes: String(total()), activeTransfers: 0 }; },
  } };
}
const filesystem = () => ({ bavail: 10_000_000n, bsize: 1n, blocks: 20_000_000n });

test('pressure holds actual admitted liability, exhausts the exact queue bound and releases it', () => {
  const store = ledger(), pressure = createQueueAdmissionPressure(store, 524288n, { filesystem });
  const held = pressure.activate();
  assert.equal(held.active, true); assert.equal(held.actualAdmissionRefused, true); assert.equal(held.physicalEnospcClaim, false);
  assert.equal(held.admissionBytes, '524288'); assert(BigInt(held.held.reservedBytes) > 0n);
  assert.throws(() => pressure.activate(), /already active/);
  const released = pressure.release();
  assert.equal(released.active, false); assert.equal(released.actualAdmissionRecovered, true); assert.equal(released.after.reservedBytes, '0');
  assert.deepEqual(store.objects.reservationInventory(), held.before);
  assert(store.calls.length < 128); assert.deepEqual(pressure.release(), released);
});

test('an already exhausted writer is not misreported as an injected fault', () => {
  const store = ledger(1n), pressure = createQueueAdmissionPressure(store, 524288n, { filesystem });
  assert.throws(() => pressure.activate(), error => error.code === 'CAPACITY');
  assert.equal(pressure.witness, null); assert.equal(store.objects.reservationInventory().reservedBytes, '0');
});

test('failed post-hold verification releases the actual owned reservation', () => {
  const store = ledger(); let probes = 0;
  const reserve = store.objects.reserve;
  store.objects.reserve = (id, cost) => { if (id.endsWith(':probe') && ++probes === 2) throw Error('verification failed'); return reserve(id, cost); };
  const pressure = createQueueAdmissionPressure(store, 524288n, { filesystem });
  assert.throws(() => pressure.activate(), /verification failed/); assert.equal(store.objects.reservationInventory().reservedBytes, '0');
});
