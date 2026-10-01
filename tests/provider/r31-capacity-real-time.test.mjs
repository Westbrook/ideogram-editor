import test from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { Objects } from '../../dist/local/server/storage/objects.js';
import { r31Reservation, TransportEvidenceStore } from '../../dist/local/server/provider/evidence.js';
import { resolvePrivacy } from '../../dist/local/server/provider/policy.js';
import { fixtureProfile } from './emulator.mjs';
import { capacityRecheckGapMs, observeCapacityChecks } from '../../tooling/qualification/campaigns/adapter-transfers.mjs';

// Observe documented async lifecycle events for timers created by each real
// reservation, including timers rearmed from their own callbacks. No clock or
// production timer function is replaced by this test.
function reservationTimers() {
  let current = null;
  const created = new Map(), active = new Set();
  const hook = createHook({
    init(id, type, trigger, resource) {
      const owner = current ?? created.get(trigger)?.owner;
      if (type !== 'Timeout' || !owner) return;
      created.set(id, { owner, resource }); active.add(id);
    },
    destroy(id) { active.delete(id); },
  }).enable();
  return {
    capture(owner, work) { const prior = current; current = owner; try { return work(); } finally { current = prior; } },
    active(owner) { return [...active].filter(id => !owner || created.get(id).owner === owner); },
    assertUnref() { for (const id of active) assert.equal(created.get(id).resource.hasRef(), false, 'Reservation timer must not retain the process'); },
    close() { hook.disable(); },
  };
}

test('known-length R31 transfers recheck real capacity during >30s backpressure, refuse latched completion and release timers/slots', { timeout: 60_000 }, async t => {
  const timers = reservationTimers(), roots = [], reservations = [], objectStores = [], observers = [], fixtures = [];
  t.after(() => {
    for (const fixture of fixtures) if (!fixture.closed) { try { fixture.sink.finish(false); } catch { /* Keep the original test failure while releasing its descriptor. */ } }
    for (const reservation of reservations) reservation.release();
    for (const observer of observers) observer.restore();
    for (const objects of objectStores) objects.close();
    timers.close();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function fixture(name, quota) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'r31-real-time-'))); roots.push(root); chmodSync(root, 0o700);
    const objects = new Objects(root, () => {}, () => {}, quota); objectStores.push(objects);
    const observer = observeCapacityChecks(objects); observers.push(observer);
    const evidence = new TransportEvidenceStore(root), policy = resolvePrivacy(fixtureProfile(), 'ideogram/v4', randomUUID()).applied;
    const reservation = timers.capture(name, () => r31Reservation(objects, randomUUID(), 'provider-media', () => {})); reservations.push(reservation);
    const sink = evidence.begin(randomUUID(), 'response', reservation, policy, { 'content-length': '65536' });
    const fixture = { root, objects, observer, evidence, reservation, sink, closed: false }; fixtures.push(fixture);
    const startMs = performance.now(); timers.capture(name, () => sink.prepare(65536n));
    timers.capture(name, () => sink.append(Buffer.alloc(32768, 37)));
    fixture.startMs = startMs; return fixture;
  }
  const normal = fixture('normal');
  // A real private-root quota supplies a small reproducible disk-pressure
  // boundary without filling the host disk or replacing statfs/capacity.
  const constrained = fixture('constrained', String(1024 ** 3 + 64 * 1024 ** 2 + 3 * 1024 ** 2));
  writeFileSync(join(constrained.root, 'retained-quota-pressure.bin'), Buffer.alloc(4 * 1024 ** 2, 71), { mode: 0o600, flag: 'wx' });
  await nextTurn(); timers.assertUnref();
  assert.equal(timers.active('normal').length, 1); assert.equal(timers.active('constrained').length, 1);

  // Real elapsed time; no chunks, ensure calls or fabricated interval markers
  // occur here. Only the production reservation timer can recheck capacity.
  await delay(31_250, undefined, { signal: t.signal });
  const heldUntilMs = performance.now(); assert(heldUntilMs - normal.startMs > 30_000);
  const normalChecks = normal.observer.checks.filter(check => check.outcome === 'expected');
  assert(normalChecks.length >= 3, 'Initial known-length reservation plus at least two real idle capacity checks');
  assert(normalChecks.slice(1).every(check => check.requestedBytes === '0'), 'Held reservation is included in the actual ledger instead of counted twice');
  assert(capacityRecheckGapMs(normal.startMs, heldUntilMs, normal.observer.checks) <= 30_000, 'Actual capacity-check gaps must stay below the R31 ceiling');
  assert(constrained.observer.checks.some(check => check.outcome === 'failed' && check.code === 'CAPACITY'), 'Actual retained bytes must cause the timed quota check to refuse');
  assert.equal(timers.active('constrained').length, 0, 'First capacity failure stops its timer');

  timers.capture('normal', () => normal.sink.append(Buffer.alloc(32768, 83)));
  const completed = timers.capture('normal', () => normal.sink.finish(true)); normal.closed = true;
  assert.equal(completed.completeness, 'complete'); assert.equal(completed.receivedBytes, '65536');
  assert.equal(Buffer.concat([...normal.evidence.read(completed.recordId)]).byteLength, 65536);
  assert.equal(normal.sink.finish(true).completeness, 'complete', 'Successful completion remains idempotent');

  assert.throws(() => timers.capture('constrained', () => constrained.sink.finish(true)), error => error.code === 'CAPACITY', 'Acknowledgement cannot bypass a failure latched while waiting');
  const partial = constrained.sink.finish(false), saved = constrained.evidence.inspect(partial.recordId); constrained.closed = true;
  assert.equal(saved.completeness, 'partial'); assert.equal(saved.retainedBytes, '32768');
  assert.deepEqual(Buffer.concat([...constrained.evidence.read(partial.recordId)]), Buffer.alloc(32768, 37));
  assert.throws(() => constrained.sink.finish(true), error => error.code === 'PROVENANCE', 'A closed partial cannot be promoted after capacity failure');
  assert.equal(constrained.evidence.inspect(partial.recordId).completeness, 'partial');

  await nextTurn(); await nextTurn();
  assert.equal(timers.active().length, 0, 'Documented timer destroy events prove release without waiting for another interval');
  for (const fixture of [normal, constrained]) {
    assert.deepEqual(fixture.objects.reservationInventory(), { reservedBytes: '0', activeTransfers: 0 });
    assert.equal(fixture.objects.hasLeases(), false);
    fixture.reservation.release();
    assert.deepEqual(fixture.objects.reservationInventory(), { reservedBytes: '0', activeTransfers: 0 });
  }
});
