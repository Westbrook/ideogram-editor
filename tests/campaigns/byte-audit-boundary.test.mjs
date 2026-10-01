import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyByteAuditStartupBoundary } from '../../tooling/qualification/campaigns/verification.mjs';

function specimen() {
  return {
    cell: { operation: 'navigation.ready', workload: 'W1' },
    fixture: { documentId: 'qualification_w1' },
    attempt: { status: 'PASS', result: { status: 'PASS', d11: { scope: 'startup' }, observations: {
      documentId: 'qualification_w1', startupBoundary: 'document-ready-via-Open', publicOpenCompleted: true,
    } } },
  };
}

test('startup byte audits bind the actual public Open boundary to the selected document', () => {
  assert.deepEqual(verifyByteAuditStartupBoundary(specimen()), { applicable: true, verified: true,
    boundary: 'document-ready-via-Open', documentId: 'qualification_w1' });
});

test('startup byte audits reject a different document, shell-only boundary, or missing public Open', () => {
  for (const change of [
    state => { state.attempt.result.observations.documentId = 'another_document'; },
    state => { state.attempt.result.observations.startupBoundary = 'shell-ready-no-document'; },
    state => { state.attempt.result.observations.publicOpenCompleted = false; },
    state => { delete state.attempt.result.observations; },
    state => { state.fixture.documentId = null; },
  ]) {
    const state = specimen(); change(state);
    assert.throws(() => verifyByteAuditStartupBoundary(state), /boundary/);
  }
});

test('actual H startup boundaries remain distinct from the C artifact role union', () => {
  const shell = specimen(); shell.cell.workload = 'W0'; shell.fixture.documentId = null;
  shell.attempt.result.observations = { documentId: null, startupBoundary: 'shell-ready-no-document', publicOpenCompleted: false };
  assert.deepEqual(verifyByteAuditStartupBoundary(shell), { applicable: true, verified: true,
    boundary: 'shell-ready-no-document', documentId: null });
  const large = specimen(); large.cell.workload = 'W2';
  large.fixture.documentId = large.attempt.result.observations.documentId = 'qualification_w2';
  assert.equal(verifyByteAuditStartupBoundary(large).verified, true);
});

test('failed startup actions preserve partial bytes without claiming the missing ready boundary', () => {
  for (const status of ['FAIL', 'INCONCLUSIVE']) {
    const state = specimen();
    state.attempt.status = state.attempt.result.status = status;
    state.attempt.result.observations = null;
    assert.deepEqual(verifyByteAuditStartupBoundary(state), { applicable: true, verified: false });
  }
  const forged = specimen(); forged.attempt.status = 'FAIL'; forged.attempt.result.observations = null;
  assert.throws(() => verifyByteAuditStartupBoundary(forged), /Passing startup/);
});

test('text engine audits do not claim or require the navigation startup boundary', () => {
  const state = specimen(); state.cell.operation = 'text.mixed-ready'; state.attempt.result.d11.scope = 'text-engine';
  assert.deepEqual(verifyByteAuditStartupBoundary(state), { applicable: false });
  state.attempt.result.d11.scope = 'startup';
  assert.throws(() => verifyByteAuditStartupBoundary(state), /navigation-ready/);
});
