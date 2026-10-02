import test from 'node:test';
import assert from 'node:assert/strict';
import { publicQueueMove } from '../../tooling/qualification/campaigns/browser-queue-order.mjs';

const view = () => ({ orderVersion: '500', jobs: [
  { id: 'older', version: '4', attempts: [{ state: 'not-started', count: 'none', hold: false }] },
  { id: 'scenario', version: '2', attempts: [{ state: 'not-started', count: 'none', hold: false }] },
], waiting: { older: { position: 1, previous: null, next: { id: 'scenario', version: '2' } }, scenario: { position: 2, previous: { id: 'older', version: '4' }, next: null } } });
test('protocol setup uses the exact published adjacent identities and order version', () => {
  assert.deepEqual(publicQueueMove(view(), 'scenario'), { type: 'ReorderLocalQueue', jobId: 'scenario', expectedVersion: '2', neighborId: 'older', expectedNeighborVersion: '4', expectedOrderVersion: '500', direction: 'up' });
  assert.equal(publicQueueMove(view(), 'older'), null);
});
test('missing authority, stale neighbor, reserved attempt or contradictory oldest proof refuse', () => {
  for (const mutate of [
    v => { delete v.orderVersion; }, v => { v.waiting.scenario.previous.version = '3'; },
    v => { v.waiting.older.position = 3; }, v => { v.jobs[1].attempts[0].count = 'reserved'; },
    v => { v.jobs[1].attempts[0].state = 'acknowledged'; }, v => { v.jobs[1].attempts[0].hold = true; },
    v => { v.waiting.scenario.position = 1; }, v => { v.jobs[1].attempts.push({ state: 'not-started', count: 'none', hold: false }); },
  ]) { const value = view(); mutate(value); assert.throws(() => publicQueueMove(value, 'scenario')); }
});
