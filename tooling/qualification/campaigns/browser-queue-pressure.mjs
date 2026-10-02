// Internal writer fixture only. Every held byte is admitted by the real Objects
// reservation ledger. No quota property, statfs result, or write path is patched.
import assert from 'node:assert/strict';
import { statfsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const isCapacity = error => error?.code === 'CAPACITY';
export function createQueueAdmissionPressure(store, admissionBytes, { filesystem = () => statfsSync(store.root, { bigint: true }) } = {}) {
  assert(typeof admissionBytes === 'bigint' && admissionBytes > 0n, 'Actual product queue admission bytes are required');
  const id = 'campaign-admission-pressure:' + randomUUID(), probe = id + ':probe';
  let active = null, last = null;
  const space = () => { const fs = filesystem(); return { freeBytes: String(fs.bavail * fs.bsize), totalBytes: String(fs.blocks * fs.bsize) }; };
  const available = () => { try { store.objects.reserve(probe, admissionBytes); } finally { store.objects.unreserve(probe); } };
  return {
    get witness() { return active ?? last; },
    activate() {
      assert.equal(active, null, 'Storage admission pressure is already active');
      const before = store.objects.reservationInventory(), filesystemBefore = space();
      available(); // Refuse an already exhausted host instead of claiming injected pressure.
      let low = 0n, high = BigInt(filesystemBefore.freeBytes), iterations = 0;
      try {
        // Monotonic actual admission search, bounded by the integer byte range.
        // Failed reserve restores the previous admitted liability by contract.
        while (low < high) {
          assert(++iterations <= 128, 'Storage admission search exceeded its bound');
          const candidate = (low + high + 1n) / 2n;
          try { store.objects.reserve(id, candidate); low = candidate; }
          catch (error) { if (!isCapacity(error)) throw error; high = candidate - 1n; }
        }
        assert(low > 0n, 'No real storage reservation was admitted');
        store.objects.reserve(id, low);
        let refused = false;
        try { available(); } catch (error) { if (!isCapacity(error)) throw error; refused = true; }
        assert(refused, 'Available storage changed; real queue admission is not exhausted');
        const held = store.objects.reservationInventory();
        assert(BigInt(held.reservedBytes) > BigInt(before.reservedBytes), 'Fault has no actual ledger liability');
        active = { kind: 'real-object-reservation-pressure-1', reservationId: id, admissionBytes: String(admissionBytes), costBytes: String(low), before, held, filesystemBefore, filesystemHeld: space(), actualAdmissionRefused: true, physicalEnospcClaim: false, active: true };
        return active;
      } catch (error) { store.objects.unreserve(id); throw error; }
    },
    release() {
      if (!active) return last;
      const prior = active; store.objects.unreserve(id);
      const after = store.objects.reservationInventory();
      assert.equal(after.reservedBytes, prior.before.reservedBytes, 'Storage reservation was not exactly released');
      available(); // Real product reserve succeeds again; never bypass its admission check.
      last = { ...prior, active: false, after, filesystemAfter: space(), actualAdmissionRecovered: true };
      active = null; return last;
    },
  };
}
