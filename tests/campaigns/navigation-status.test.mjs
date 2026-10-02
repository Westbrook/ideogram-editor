import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyNavigationStatus} from '../../tooling/qualification/campaigns/navigation-status.mjs';

// Source-authored semantic specimens, never product/runtime evidence.
function specimen({autoOpen = false} = {}) {
  const navigationNonce = 'navigation-fixture', documentId = 'document-fixture';
  const acceptedEdit = {commandId: 'fixture-edit', documentId, status: 'accepted', documentRevision: '1', transactionId: 'fixture-transaction'};
  const rows = [];
  let current = {sourceId: '01234567-89ab-4cde-8fab-0123456789ab', lifecycle: 0, documentGeneration: 0, sessionId: 'editor_null', documentId: null, revision: null, cursor: '0'};
  const row = (kind, patch = {}, rest = {}) => {current = {...current, ...patch}; rows.push({kind, sequence: rows.length + 1, atMs: (rows.length + 1) * 10, ...current, ...rest});};
  const state = (status, busy = false, patch = {}) => row('state', patch, {status, ready: !['connect', 'recovering'].includes(status), busy, hasError: false, hasRecovery: false});
  state('connect'); state('recovering', false, {lifecycle: 1, sessionId: 'editor_owner'});
  state('recovering', false, {sessionId: 'ui_fixture'});
  if (autoOpen) state('recovering', false, {documentGeneration: 1, documentId, revision: '1', cursor: '3'});
  row('recovered'); state('recovered');
  state('opening', true); state('opening', true, {documentGeneration: autoOpen ? 2 : 1, documentId, revision: '1', cursor: '3'});
  row('opened'); state('opened', true); state('opened'); state('saving', true);
  row('checkpoint', {cursor: '5'}, {commandId: acceptedEdit.commandId, transactionId: acceptedEdit.transactionId, fromSeq: '4', toSeq: '5'});
  state('saved', true); state('saved');
  const first = status => rows.find(row => row.status === status);
  const authority = kind => rows.find(row => row.kind === kind);
  const phase = (sequence, name, start, end, outcome, context) => ({sequence, phase: name, startedMs: start, endedMs: end, durationMs: end - start, outcome, context});
  const status = {kind: 'navigation-status-1', timeOriginMs: 200000, capacity: 128, dropped: 0, invalid: 0, closed: false, rows};
  const phaseSnapshot = {navigationStatus: status, trace: {schemaVersion: 1, lane: 'browser-main', clockOriginUnixMs: 200000.25, clockUncertaintyMs: null, dropped: 0, invalid: 0, records: [
    phase(1, 'reopen', first('opening').atMs + 1, first('opened').atMs - 1, 'incomplete', {documentId, revision: '1', boundary: 'observed'}),
    phase(2, 'command.accept', first('saving').atMs + 1, authority('checkpoint').atMs - 1, 'ok', {commandId: acceptedEdit.commandId, transactionId: acceptedEdit.transactionId, documentId, revision: '1', replay: false, boundary: 'authority-durable'}),
  ]}};
  const witness = {kind: 'navigation-semantic-witness-1', navigationNonce, status};
  return {witness, rows, status, phaseSnapshot, acceptedEdit, options: {navigationNonce, documentId, acceptedEdit, phaseSnapshot}, first, authority};
}
const verify = value => verifyNavigationStatus(value.witness, value.options);
const renumber = rows => rows.forEach((row, index) => {row.sequence = index + 1;});
const incomplete = (value, reason) => {
  const result = verify(value); assert.equal(result.complete, false); assert.equal(result.falsePendingOrCompletionCount, null);
  assert(result.missing.includes('navigation-status:' + reason), JSON.stringify(result));
};

test('complete public recovery, Open and original checkpoint have zero false states', () => {
  const value = specimen(), before = structuredClone(value.witness);
  assert.deepEqual(verify(value), {complete: true, falsePendingOrCompletionCount: 0, missing: []});
  assert.deepEqual(value.witness, before, 'pure verification never edits retained rows');
});
test('recovery may auto-open the exact fixture before the separate public Open', () => {
  assert.deepEqual(verify(specimen({autoOpen: true})), {complete: true, falsePendingOrCompletionCount: 0, missing: []});
});
test('serialized copies bind by exact content rather than object identity', () => {
  const value = specimen(); value.phaseSnapshot.navigationStatus = JSON.parse(JSON.stringify(value.status));
  assert.equal(verify(value).complete, true);
});
test('the actual reopen span may end after opened message publication but before run releases busy', () => {
  const value = specimen(), row = value.phaseSnapshot.trace.records[0];
  row.endedMs = value.first('opened').atMs + 1; row.durationMs = row.endedMs - row.startedMs;
  assert.deepEqual(verify(value), {complete: true, falsePendingOrCompletionCount: 0, missing: []});
});
test('false pending is a complete nonzero violation, not missing evidence', () => {
  const value = specimen(); value.first('opening').busy = false; value.first('saving').busy = false;
  assert.deepEqual(verify(value), {complete: true, falsePendingOrCompletionCount: 2, missing: []});
});
test('missing recovered, opened or checkpoint authority produces false completion with a complete independent trace', () => {
  for (const [kind, expected] of [['recovered', 1], ['opened', 2], ['checkpoint', 2]]) {
    const value = specimen(); value.rows.splice(value.rows.indexOf(value.authority(kind)), 1); renumber(value.rows);
    assert.deepEqual(verify(value), {complete: true, falsePendingOrCompletionCount: expected, missing: []}, kind);
  }
});
test('later matching recovery authority does not retroactively justify an earlier ready publication', () => {
  const value = specimen(), row = value.authority('recovered'); value.rows.splice(value.rows.indexOf(row), 1);
  const ready = value.first('recovered'); row.atMs = ready.atMs + 1; value.rows.splice(value.rows.indexOf(ready) + 1, 0, row); renumber(value.rows);
  assert.deepEqual(verify(value), {complete: true, falsePendingOrCompletionCount: 1, missing: []});
});
test('wrong navigation, snapshot contents or original accepted edit cannot qualify', () => {
  let value = specimen(); value.options.navigationNonce = 'other'; incomplete(value, 'witness-identity');
  value = specimen(); value.phaseSnapshot.navigationStatus = structuredClone(value.status); value.phaseSnapshot.navigationStatus.rows[0].cursor = '1'; incomplete(value, 'retained-snapshot-binding');
  value = specimen(); value.acceptedEdit.status = 'rejected'; incomplete(value, 'accepted-edit');
  value = specimen(); value.acceptedEdit.documentId = 'other'; incomplete(value, 'accepted-edit');
});
test('drops, invalid observations, closed ledgers and capacity overflow are incomplete', () => {
  for (const [key, next] of [['dropped', 1], ['invalid', 1], ['closed', true], ['capacity', 127]]) {
    const value = specimen(); value.status[key] = next; incomplete(value, 'ledger-completeness');
  }
  const value = specimen(); while (value.rows.length <= 128) value.rows.push({...value.rows.at(-1)}); incomplete(value, 'ledger-completeness');
});
test('unknown states, visible errors and unresolved recovery are not zero violations', () => {
  let value = specimen(); value.first('saving').status = 'other'; incomplete(value, 'unknown-state');
  for (const key of ['hasError', 'hasRecovery']) {value = specimen(); value.first('opening')[key] = true; incomplete(value, 'error-or-recovery-state');}
});
test('constructor publication and full terminal sequence are mandatory', () => {
  let value = specimen(); value.rows.shift(); renumber(value.rows); incomplete(value, 'initial-publication');
  value = specimen(); value.rows.pop(); incomplete(value, 'full-sequence');
  value = specimen(); value.first('connect').ready = true; incomplete(value, 'initial-publication');
});
test('source, sequence, monotonic clock and cursor must remain contiguous', () => {
  let value = specimen(); value.rows[4].sourceId = '11234567-89ab-4cde-8fab-0123456789ab'; incomplete(value, 'row-continuity');
  value = specimen(); value.rows[4].sequence++; incomplete(value, 'row-shape');
  value = specimen(); value.rows[4].atMs = 0; incomplete(value, 'row-continuity');
  value = specimen(); value.rows.at(-1).cursor = '0'; incomplete(value, 'row-continuity');
});
test('session or lifecycle replacement after recovery is incomplete', () => {
  let value = specimen(); value.first('opening').sessionId = 'ui_other'; incomplete(value, 'session');
  value = specimen(); value.first('opening').lifecycle++; incomplete(value, 'lifecycle');
});
test('auto-open may not select a different document or increment the generation twice', () => {
  let value = specimen({autoOpen: true}); value.rows.find(row => row.documentId).documentId = 'other'; incomplete(value, 'row-shape');
  value = specimen({autoOpen: true}); value.rows.find(row => row.documentId).documentGeneration++; incomplete(value, 'recovery-document');
});
test('public Open must actually advance document generation', () => {
  const value = specimen({autoOpen: true}); for (const row of value.rows) if (row.documentGeneration === 2) row.documentGeneration = 1;
  incomplete(value, 'public-open-generation');
});
test('checkpoint binds command, transaction, accepted revision and original sequence interval', () => {
  for (const [key, next] of [['commandId', 'different-command'], ['transactionId', 'different-transaction'], ['revision', '2'], ['fromSeq', '6'], ['toSeq', '6']]) {
    const value = specimen(); value.authority('checkpoint')[key] = next; incomplete(value, 'checkpoint-binding');
  }
  const value = specimen(); value.acceptedEdit.fromSeq = '3'; incomplete(value, 'checkpoint-binding');
});
test('duplicated authority, malformed scalars and unexpected fields are not accepted', () => {
  let value = specimen(); const row = value.authority('opened'); value.rows.splice(value.rows.indexOf(row), 0, {...row}); renumber(value.rows); incomplete(value, 'duplicate-authority');
  for (const [key, next] of [['atMs', NaN], ['documentGeneration', -1], ['cursor', '01'], ['sourceId', 'not-a-uuid']]) {
    value = specimen(); value.rows[0][key] = next; incomplete(value, 'row-shape');
  }
  value = specimen(); value.rows[0].claimedComplete = true; incomplete(value, 'row-shape');
});
test('only the public Open interval with observed outcome can supply the reopen proof', () => {
  for (const change of [row => {row.outcome = 'ok';}, row => {row.context.boundary = 'presented';}, row => {row.context.documentId = 'other';}, row => {row.context.revision = '2';}]) {
    const value = specimen(); change(value.phaseSnapshot.trace.records[0]); incomplete(value, 'public-open-phase');
  }
  const value = specimen(); const row = value.phaseSnapshot.trace.records[0]; row.startedMs = 0; row.durationMs = row.endedMs; incomplete(value, 'public-open-phase');
});
test('checkpoint requires its actual original command.accept phase before the terminal message', () => {
  for (const change of [row => {row.context.replay = true;}, row => {row.context.commandId = 'other';}, row => {row.context.transactionId = 'other';}, row => {row.context.boundary = 'local-durable';}, row => {row.outcome = 'rejected';}]) {
    const value = specimen(); change(value.phaseSnapshot.trace.records[1]); incomplete(value, 'original-checkpoint-phase');
  }
  const value = specimen(), row = value.phaseSnapshot.trace.records[1]; row.endedMs = value.rows.at(-1).atMs + 1; row.durationMs = row.endedMs - row.startedMs; incomplete(value, 'original-checkpoint-phase');
});
test('phase records with missing rows, drops or inconsistent intervals cannot replace raw trace evidence', () => {
  let value = specimen(); value.phaseSnapshot.trace.invalid = 1; incomplete(value, 'phase-trace');
  value = specimen(); value.phaseSnapshot.trace.records[0].durationMs++; incomplete(value, 'phase-record');
  value = specimen(); value.phaseSnapshot.trace.records.shift(); incomplete(value, 'phase-record');
});
test('malformed absent input returns bounded incomplete output', () => {
  assert.deepEqual(verifyNavigationStatus(null), {complete: false, falsePendingOrCompletionCount: null, missing: ['navigation-status:witness-identity']});
});
test('malformed nested scalar fields are refused without recursive snapshot traversal', () => {
  const value = specimen(); value.phaseSnapshot.navigationStatus = structuredClone(value.status);
  const left = {}, right = {}; let a = left, b = right;
  for (let index = 0; index < 20000; index++) {a.next = {}; b.next = {}; a = a.next; b = b.next;}
  value.rows[0].sourceId = left; value.phaseSnapshot.navigationStatus.rows[0].sourceId = right;
  incomplete(value, 'row-shape');
});
