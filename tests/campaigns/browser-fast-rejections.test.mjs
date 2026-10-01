import test from 'node:test';
import assert from 'node:assert/strict';
import { fastRejectionCase, summarizeFastIssues, verifyNoFastSubmission, runFastRejection } from '../../tooling/qualification/campaigns/browser-fast-rejections.mjs';

const cell = (caseId, scenario) => ({ operation: 'fast.workflow', parameters: { caseId, ...(scenario ? { scenario } : {}) } });
const noEffects = () => ({ counts: { submissions: 0 }, failures: [] });
const witness = () => ({ beforeJobs: [{ id: 'job-1', attempts: [{ id: 'attempt-1' }] }], afterJobs: [{ id: 'job-1', attempts: [{ id: 'attempt-1' }] }], beforeEffects: noEffects(), afterEffects: noEffects(), enqueueCommands: 0 });
const issue = field => ({ target: 'request-' + field, message: `INACTIVE_INPUT: Keep ${field} in the saved draft explicitly, or choose a compatible operation.` });

test('each Fast invalid case is bound to its exact field and prescribed scenario', () => {
  assert.deepEqual(['WF07', 'WF08', 'WF09', 'WF10', 'WF11', 'WF12'].map(id => fastRejectionCase(cell(id)).field), ['source', 'mask', 'adapters', 'acceleration', 'expansion', 'size']);
  for (const invalid of [cell('WF06'), cell('WF13'), cell('__proto__'), cell('constructor'), cell('WF07', 'reject-mask'), { ...cell('WF07'), operation: 'queue.fault' }]) assert.throws(() => fastRejectionCase(invalid), { code: 'CAMPAIGN_PREREQUISITE' });
});

test('sole actionable expected field is required; generic or additional errors never qualify', () => {
  const descriptor = fastRejectionCase(cell('WF07'));
  const good = summarizeFastIssues([issue('source')], descriptor);
  assert.equal(good.valid, true); assert.match(good.issues[0].messageHash, /^sha256:[a-f0-9]{64}$/);
  for (const bad of [[], null, [issue('mask')], [issue('source'), issue('acceleration')], [{ target: 'request-source', message: 'private provider echo' }]]) {
    const result = summarizeFastIssues(bad, descriptor); assert.equal(result.valid, false); assert.deepEqual(result.issues, []); assert(!JSON.stringify(result).includes('private'));
  }
});

test('Large and exact1600×900 dimension errors stay distinct', () => {
  const large = { target: 'request-expansion', message: 'EXPANSION: Choose a supported expansion; no downgrade is automatic.' };
  const size = { target: 'request-size', message: 'SIZE: Custom dimensions violate metadata eligibility 512–2048, multiples of 16. No rounding.' };
  assert.equal(summarizeFastIssues([large], fastRejectionCase(cell('WF11'))).valid, true);
  assert.equal(summarizeFastIssues([size], fastRejectionCase(cell('WF12'))).valid, true);
  assert.equal(summarizeFastIssues([size], fastRejectionCase(cell('WF11'))).valid, false);
  assert.equal(summarizeFastIssues([{ ...size, target: 'request-height' }], fastRejectionCase(cell('WF12'))).valid, false);
});

test('zero submission proof requires actual finite counters and unchanged jobs and attempts', () => {
  assert.deepEqual(verifyNoFastSubmission(witness()), { queuedJobsAdded: 0, attemptsAdded: 0, enqueueCommands: 0, submissions: 0, retainedJobs: 1 });
  const patches = [
    { enqueueCommands: 1 }, { enqueueCommands: undefined },
    { afterJobs: [{ id: 'job-2', attempts: [] }] },
    { afterJobs: [{ id: 'job-1', attempts: [{ id: 'attempt-1' }, { id: 'attempt-2' }] }] },
    { afterJobs: [{ id: 'job-1', attempts: [] }, { id: 'job-1', attempts: [] }] },
    { afterEffects: { counts: { submissions: 1 }, failures: [] } },
    { afterEffects: { counts: { submissions: NaN }, failures: [] } },
    { afterEffects: { counts: {}, failures: [] } },
    { afterEffects: { counts: { submissions: 0 }, failures: ['failure'] } },
  ];
  for (const patch of patches) assert.throws(() => verifyNoFastSubmission({ ...witness(), ...patch }));
});

test('missing actual emulator or eligible adapter fails prerequisites before touching UI', async () => {
  let touched = false; const page = new Proxy({}, { get() { touched = true; throw Error('UI must remain untouched'); } });
  await assert.rejects(runFastRejection({ page, cell: cell('WF10'), fixture: { documentId: 'doc-1' } }), { code: 'CAMPAIGN_PREREQUISITE' });
  await assert.rejects(runFastRejection({ page, cell: cell('WF09'), fixture: { documentId: 'doc-1' }, controls: { read: async () => noEffects() } }), { code: 'CAMPAIGN_PREREQUISITE' });
  assert.equal(touched, false);
});
