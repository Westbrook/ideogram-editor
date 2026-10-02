// Pure replay of retained product publications. No DOM polling, receipt lookup,
// elapsed-time inference, or caller-declared success supplies missing rows.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,127})$/.test(value);
const positive = value => decimal(value) && value !== '0';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const common = ['kind', 'sequence', 'atMs', 'sourceId', 'lifecycle', 'documentGeneration', 'sessionId', 'documentId', 'revision', 'cursor'];
const flags = ['status', 'ready', 'busy', 'hasError', 'hasRecovery'];
const checkpoint = ['commandId', 'transactionId', 'fromSeq', 'toSeq'];
const stages = ['connect', 'recovering', 'recovered', 'opening', 'opened', 'saving', 'saved'];
const header = ['kind', 'timeOriginMs', 'capacity', 'dropped', 'invalid', 'closed', 'rows'];
// All admitted row fields are scalar. Never recursively inspect an arbitrary
// nested value merely to decide whether two retained snapshots agree.
function sameLedger(left, right) {
  return exactKeys(right, header) && header.filter(key => key !== 'rows').every(key => left[key] === right[key]) && Array.isArray(right.rows) && right.rows.length === left.rows.length && left.rows.every((row, index) => {
    const keys = row?.kind === 'state' ? [...common, ...flags] : row?.kind === 'checkpoint' ? [...common, ...checkpoint] : common;
    return exactKeys(row, keys) && exactKeys(right.rows[index], keys) && keys.every(key => row[key] === right.rows[index][key]);
  });
}

/** The enclosing native verifier also binds status.timeOriginMs to the retained
 * navigation's performance.timeOrigin. Phase times below are performance-relative;
 * trace.clockOriginUnixMs is never subtracted from those times. */
export function verifyNavigationStatus(witness, {navigationNonce, documentId, acceptedEdit, phaseSnapshot} = {}) {
  const missing = new Set();
  const absent = reason => missing.add('navigation-status:' + reason);
  const result = count => ({complete: missing.size === 0, falsePendingOrCompletionCount: missing.size ? null : count, missing: [...missing]});
  if (!exactKeys(witness, ['kind', 'navigationNonce', 'status']) || witness.kind !== 'navigation-semantic-witness-1' || !id(navigationNonce) || witness.navigationNonce !== navigationNonce) {
    absent('witness-identity'); return result(0);
  }
  if (!id(documentId) || !object(acceptedEdit) || !id(acceptedEdit.commandId) || !id(acceptedEdit.transactionId) || acceptedEdit.documentId !== documentId || acceptedEdit.status !== 'accepted' || !decimal(acceptedEdit.documentRevision)) {
    absent('accepted-edit'); return result(0);
  }
  const ledger = witness.status;
  if (!exactKeys(ledger, header) || ledger.kind !== 'navigation-status-1' || !time(ledger.timeOriginMs) || ledger.capacity !== 128 || ledger.dropped !== 0 || ledger.invalid !== 0 || ledger.closed !== false || !Array.isArray(ledger.rows) || ledger.rows.length < 1 || ledger.rows.length > 128) {
    absent('ledger-completeness'); return result(0);
  }
  if (!object(phaseSnapshot) || !sameLedger(ledger, phaseSnapshot.navigationStatus)) absent('retained-snapshot-binding');
  const trace = phaseSnapshot?.trace;
  if (!object(trace) || trace.schemaVersion !== 1 || trace.lane !== 'browser-main' || !time(trace.clockOriginUnixMs) || trace.clockUncertaintyMs !== null || trace.dropped !== 0 || trace.invalid !== 0 || !Array.isArray(trace.records) || trace.records.length > 16384) {
    absent('phase-trace'); return result(0);
  }
  let lastPhaseEnd = -1;
  for (let index = 0; index < trace.records.length; index++) {
    const row = trace.records[index];
    if (!object(row) || row.sequence !== index + 1 || typeof row.phase !== 'string' || row.phase.length > 64 || !time(row.startedMs) || !time(row.endedMs) || row.endedMs < row.startedMs || row.endedMs < lastPhaseEnd || row.durationMs !== row.endedMs - row.startedMs || !object(row.context)) {
      absent('phase-record'); return result(0);
    }
    lastPhaseEnd = row.endedMs;
  }
  let previous, stage = -1, violations = 0, recoveryGeneration = 0, openingGeneration = null;
  let recoveredAuthority, openedAuthority, checkpointAuthority;
  let recoveredReady = false, openedIdle, firstOpening, firstOpened, firstSaving, firstSaved, lastState;
  const authorityCounts = {recovered: 0, opened: 0, checkpoint: 0};
  for (let index = 0; index < ledger.rows.length; index++) {
    const row = ledger.rows[index], state = row?.kind === 'state';
    const keys = state ? [...common, ...flags] : row?.kind === 'checkpoint' ? [...common, ...checkpoint] : common;
    if (!exactKeys(row, keys) || !['state', 'recovered', 'opened', 'checkpoint'].includes(row.kind) || row.sequence !== index + 1 || !time(row.atMs) || !uuid(row.sourceId) || !integer(row.lifecycle) || !integer(row.documentGeneration) || !id(row.sessionId) || !(row.documentId === null && row.revision === null || row.documentId === documentId && decimal(row.revision)) || !decimal(row.cursor)) {
      absent('row-shape'); return result(violations);
    }
    if (state && (typeof row.status !== 'string' || !stages.includes(row.status) || flags.slice(1).some(key => typeof row[key] !== 'boolean'))) {
      absent('unknown-state'); return result(violations);
    }
    if (index === 0 && (!state || row.status !== 'connect' || row.ready || row.busy || row.documentId !== null || row.lifecycle !== 0 || row.documentGeneration !== 0 || row.cursor !== '0')) absent('initial-publication');
    const nextStage = state ? stages.indexOf(row.status) : stage;
    if (state && (nextStage < stage || nextStage > stage + 1)) absent('state-progression');
    if (state) stage = nextStage;
    if (previous) {
      if (row.sourceId !== previous.sourceId || row.atMs < previous.atMs || BigInt(row.cursor) < BigInt(previous.cursor)) absent('row-continuity');
      if (row.lifecycle !== previous.lifecycle && !(previous.lifecycle === 0 && row.lifecycle === 1 && state && row.status === 'recovering')) absent('lifecycle');
      if (row.sessionId !== previous.sessionId && stage !== 1) absent('session');
      const increment = row.documentGeneration - previous.documentGeneration;
      if (increment !== 0 && !(increment === 1 && (stage === 1 || stage === 3))) absent('document-generation');
      if (previous.documentId !== null && row.documentId === null || previous.documentId === null && row.documentId !== null && increment !== 1) absent('document-binding');
      if (previous.revision !== null && row.revision !== null && BigInt(row.revision) < BigInt(previous.revision)) absent('revision-regression');
    }
    if (stage > 0 && row.lifecycle !== 1) absent('lifecycle');
    if (stage === 0 && (row.documentId !== null || row.documentGeneration !== 0 || row.lifecycle !== 0)) absent('initial-publication');
    if (stage === 1) {
      recoveryGeneration = row.documentGeneration;
      if (recoveryGeneration > 1 || (row.documentId === null) !== (recoveryGeneration === 0)) absent('recovery-document');
    }
    if (state) {
      lastState = row;
      if (row.hasError || row.hasRecovery) absent('error-or-recovery-state');
      if (stage < 2 && row.ready || stage >= 2 && !row.ready) absent('readiness');
      if ((row.status === 'opening' || row.status === 'saving') && !row.busy) violations++;
      if (row.status === 'recovered' && row.ready) {
        if (!recoveredAuthority || !matchesPublication(recoveredAuthority, row)) violations++;
        if (!row.busy) recoveredReady = true;
      }
      if (row.status === 'opening' && !firstOpening) {firstOpening = row; openingGeneration = previous?.documentGeneration ?? row.documentGeneration;}
      if (row.status === 'opened') {
        firstOpened ??= row;
        if (!openedAuthority || !matchesPublication(openedAuthority, row)) violations++;
        if (!row.busy) openedIdle ??= row;
      }
      if (row.status === 'saving') firstSaving ??= row;
      if (row.status === 'saved') {
        firstSaved ??= row;
        if (!checkpointAuthority || !matchesPublication(checkpointAuthority, row)) violations++;
      }
    } else {
      if (++authorityCounts[row.kind] !== 1) absent('duplicate-authority');
      if (row.kind === 'recovered') {
        if (stage !== 1 && stage !== 2) absent('recovered-authority-order');
        recoveredAuthority = row;
      } else if (row.kind === 'opened') {
        if (stage !== 3 && stage !== 4 || row.documentId !== documentId) absent('opened-authority-order');
        openedAuthority = row;
      } else {
        if (stage !== 5 && stage !== 6 || row.documentId !== documentId || row.revision !== acceptedEdit.documentRevision || row.commandId !== acceptedEdit.commandId || row.transactionId !== acceptedEdit.transactionId || !positive(row.fromSeq) || !positive(row.toSeq) || BigInt(row.fromSeq) > BigInt(row.toSeq) || BigInt(row.cursor) < BigInt(row.toSeq) || ['fromSeq', 'toSeq'].some(key => Object.hasOwn(acceptedEdit, key) && acceptedEdit[key] !== row[key])) absent('checkpoint-binding');
        checkpointAuthority = row;
      }
    }
    previous = row;
  }
  if (!recoveredReady || !firstOpening || !firstOpened || !openedIdle || !firstSaving || !firstSaved || stage !== 6 || !lastState?.ready || lastState?.busy || lastState?.documentId !== documentId || lastState?.revision !== acceptedEdit.documentRevision) absent('full-sequence');
  if (openingGeneration !== recoveryGeneration || firstOpened?.documentGeneration !== recoveryGeneration + 1 || lastState?.documentGeneration !== recoveryGeneration + 1) absent('public-open-generation');
  // Preserve a real violation even if its ledger authority is absent. The
  // independently retained phase still must prove the original public action.
  const opens = trace.records.filter(row => row.phase === 'reopen' && row.context.documentId === documentId && row.outcome === 'incomplete' && row.context.boundary === 'observed' && row.context.revision === firstOpened?.revision && row.startedMs >= (firstOpening?.atMs ?? Infinity) && row.endedMs <= (openedIdle?.atMs ?? -1));
  if (opens.length !== 1) absent('public-open-phase');
  const accepts = trace.records.filter(row => row.phase === 'command.accept' && row.context.commandId === acceptedEdit.commandId && row.context.documentId === documentId && row.context.transactionId === acceptedEdit.transactionId && row.context.replay === false && row.outcome === 'ok' && row.context.boundary === 'authority-durable' && row.startedMs >= (firstSaving?.atMs ?? Infinity) && row.endedMs <= (checkpointAuthority?.atMs ?? firstSaved?.atMs ?? -1) && row.endedMs <= (firstSaved?.atMs ?? -1));
  if (accepts.length !== 1) absent('original-checkpoint-phase');
  return result(violations);
}

function matchesPublication(authority, row) {
  return authority.sequence < row.sequence && authority.atMs <= row.atMs && ['sourceId', 'lifecycle', 'documentGeneration', 'sessionId', 'documentId', 'revision'].every(key => authority[key] === row[key]) && BigInt(authority.cursor) <= BigInt(row.cursor);
}
