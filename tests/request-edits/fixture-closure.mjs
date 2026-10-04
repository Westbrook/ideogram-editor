// Global store ownership, checked only after the storage worker's real drains.
// This is a fixture receipt; it does not claim exclusive provider attribution.
import assert from 'node:assert/strict';

export function fixtureClosureResources(store, fixture) {
  const raster = store.rasters.resourceOwnership();
  return {
    objects: store.objects.reservationInventory(),
    raster: { activeWorkers: raster.activeWorkers, reservedCPU: raster.bookedCPUBytes, workerService: raster.workerService },
    text: { reservedCPU: store.texts.reservedCPU, externalBytes: store.texts.externalBytes() },
    fixture: { ...fixture },
  };
}

export function assertFixtureClosure(resources, errors, egress) {
  assert.deepEqual(errors, []);
  assert.deepEqual(egress, []);
  assert.equal(resources.objects.activeTransfers, 0);
  assert.equal(resources.objects.reservedBytes, '0');
  assert.equal(resources.raster.activeWorkers, 0);
  assert.equal(resources.raster.reservedCPU, 0);
  assert.deepEqual(resources.fixture, { listening: false, sockets: 0, pending: false });
}
