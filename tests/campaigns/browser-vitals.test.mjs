import test from 'node:test';
import assert from 'node:assert/strict';
import { safeVitalRecord, summarizeVisit } from '../../tooling/qualification/campaigns/browser-vitals.mjs';

test('raw Web Vitals ingress accepts only metadata scalars and fixed entry kinds', () => {
  const base = { kind: 'entry', timeOrigin: 123456, atMs: 100, type: 'event', startTime: 80, duration: 24, interactionId: 7 };
  assert.deepEqual(safeVitalRecord({ ...base, target: 'secret prompt', name: 'private caption', url: 'https://secret.invalid/?token=secret', processingStart: 'private text' }), base);
  for (const patch of [{ kind: 'secret' }, { type: 'resource' }, { timeOrigin: Infinity }, { duration: -1 }, { startTime: 'secret' }]) assert.equal(safeVitalRecord({ ...base, ...patch }), null);
});
test('missing interactions are unavailable, never INP zero or interaction-p95 substitute', () => {
  const visit = summarizeVisit({ id: 1, timeOrigin: 10, startMs: 0, visible: true, entries: [], finalized: true, endMs: 100, overflow: false });
  assert.equal(visit.inp, null); assert.equal(visit.lcp, null); assert.equal(visit.cls, null); assert.equal(visit.eligibleInteractionIds, 0); assert.equal(visit.status, 'INCONCLUSIVE');
});
test('visit finalization and bounded observer loss remain explicit in evidence', () => {
  const result = summarizeVisit({ id: 1, timeOrigin: 10, startMs: 0, entries: [{ type: 'event', interactionId: 1 }, { type: 'event', interactionId: 1 }, { type: 'event', interactionId: 2 }], finalized: false, overflow: true });
  assert.equal(result.eligibleInteractionIds, 2); assert(result.missing.some(reason => reason.includes('final'))); assert(result.missing.some(reason => reason.includes('limit')));
});
