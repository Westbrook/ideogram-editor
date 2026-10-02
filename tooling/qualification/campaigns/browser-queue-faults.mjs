import assert from 'node:assert/strict';
import { PrerequisiteError } from './common.mjs';

const identity = value => Number.isSafeInteger(value?.pid) && value.pid > 0 && Number.isSafeInteger(value.pgid) && value.pgid > 0 && typeof value.startedAtIdentity === 'string' && value.startedAtIdentity.trim().length > 0;
const providerIdentity = value => Number.isSafeInteger(value?.ownerPid) && value.ownerPid > 0 && typeof value.instance === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.instance) && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value.origin);

/** A tab, realm, writer thread, or navigation replacement cannot satisfy a
 * process-restart specimen. Native exit and birth identities are mandatory. */
export function verifyQueueProcessRestart(witness, target, expectedProvider) {
  if (!['backend', 'browser'].includes(target) || witness?.kind !== 'queue-process-restart-1' || witness.target !== target || !identity(witness.before) || !identity(witness.after) || witness.oldExited !== true || witness.oldExit?.pid !== witness.before.pid || !Number.isFinite(witness.oldExit.observedMs) || !(Number.isInteger(witness.oldExit.code) || typeof witness.oldExit.signal === 'string')) throw new PrerequisiteError('A native owned process exit and replacement birth identity are required');
  if (witness.before.pid === witness.after.pid && witness.before.startedAtIdentity === witness.after.startedAtIdentity) throw new PrerequisiteError('Page reload or thread replacement cannot stand in for process restart');
  if (typeof witness.rootBefore !== 'string' || !witness.rootBefore.startsWith('/') || witness.rootAfter !== witness.rootBefore || witness.rootRetained !== true) throw new PrerequisiteError('Restart must retain the exact existing durable root');
  if (!providerIdentity(expectedProvider) || !providerIdentity(witness.providerBefore) || !providerIdentity(witness.providerAfter)) throw new PrerequisiteError('An independently owned persistent fixture provider is required');
  assert.deepEqual(witness.providerBefore, expectedProvider, 'Restart used another provider owner');
  assert.deepEqual(witness.providerAfter, expectedProvider, 'Restart replaced the provider request map');
  if (target === 'backend') {
    const before = witness.workerBefore, after = witness.workerAfter;
    if (before?.pid !== witness.before.pid || after?.pid !== witness.after.pid || !Number.isSafeInteger(before.threadId) || !Number.isSafeInteger(after.threadId) || typeof before.epoch !== 'string' || typeof after.epoch !== 'string' || before.epoch === after.epoch) throw new PrerequisiteError('Restart must reopen the real sole writer with a new epoch');
  }
  return { ...witness, physicalPresentationClaim: false };
}

export function verifyQueueRestartRecovery(before, after, beforeEffects, afterEffects) {
  assert.equal(after?.id, before?.id, 'Restart changed the durable job identity');
  assert.equal(before.attempts.length, 1, 'Restart specimen needs exactly one attempt');
  assert.equal(after.attempts.length, 1, 'Recovery created another attempt');
  const a = before.attempts[0], b = after.attempts[0];
  assert.equal(b.id, a.id); assert.equal(b.requestId, a.requestId); assert.equal(b.payloadHash, a.payloadHash);
  assert.equal(typeof a.requestId, 'string', 'A real acknowledged provider request is required');
  assert(a.requestId.length > 0); assert.deepEqual(after.review, before.review, 'Recovery changed the frozen request');
  assert.equal(afterEffects.counts.submissions, beforeEffects.counts.submissions, 'Restart or recovery issued another POST');
  assert.deepEqual(afterEffects.providerIdentity, beforeEffects.providerIdentity, 'Provider identity changed during recovery');
  assert.deepEqual(afterEffects.failures, [], 'Provider or writer failed during restart');
  return { jobId: after.id, attemptId: b.id, requestId: b.requestId, payloadHash: b.payloadHash, additionalAttempts: 0, additionalSubmissions: 0 };
}
