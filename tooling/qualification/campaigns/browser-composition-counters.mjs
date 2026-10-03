// Exact producer-journal arithmetic. No sampled maxima or unexercised zeroes.
import assert from 'node:assert/strict';
const natural = value => Number.isSafeInteger(value) && value >= 0;
const time = value => Number.isFinite(value) && value >= 0;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const names = ['R38DerivedSnapshotBytes', 'R38IssueBytes', 'R38RawPageBytes', 'R38MaterializedRawInspectionBytes', 'R38TextCaptionWorkspaceBytes', 'R38RawTruncationOrFalseCompletenessCount'];
const rowKeys = ['sequence', 'atMs', 'kind', 'complete', 'promptOwnedBytes', 'rawInspectionOwnedBytes', 'compositionControlOwnedBytes', 'inspectionSerial', 'activeInspections'];
const states = new Set(['supported', 'ambiguous', 'unsupported', 'malformed', 'over-limit']);
const inspectionModes = new Set(['page', 'parse', 'decode', 'opaque']);
function keys(value, expected) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Producer record fields differ');
}
function counters(value) {
  assert(natural(value.promptOwnedBytes) && natural(value.rawInspectionOwnedBytes) && value.rawInspectionOwnedBytes <= value.promptOwnedBytes &&
    natural(value.compositionControlOwnedBytes) && natural(value.promptOwnedBytes + value.compositionControlOwnedBytes));
  assert(natural(value.inspectionSerial) && natural(value.activeInspections) && value.activeInspections <= 64 && value.activeInspections <= value.inspectionSerial);
}
function reservations(previous, row) {
  if (row.kind === 'ownership') assert(row.compositionControlOwnedBytes === previous.compositionControlOwnedBytes, 'Prompt ownership changed Composition control reservations');
  else if (row.kind === 'control-ownership') assert(row.promptOwnedBytes === previous.promptOwnedBytes && row.rawInspectionOwnedBytes === previous.rawInspectionOwnedBytes, 'Composition control ownership changed prompt reservations');
  else assert(row.promptOwnedBytes === previous.promptOwnedBytes && row.rawInspectionOwnedBytes === previous.rawInspectionOwnedBytes &&
    row.compositionControlOwnedBytes === previous.compositionControlOwnedBytes, 'Nonownership row changed reservations');
  assert(row.inspectionSerial === previous.inspectionSerial + (row.kind === 'raw-inspection-begin' ? 1 : 0), 'Inspection serial changed outside begin');
  assert(row.activeInspections === previous.activeInspections + (row.kind === 'raw-inspection-begin' ? 1 : row.kind === 'raw-inspection-end' ? -1 : 0), 'Inspection activity transition differs');
}
function maximum(values) { let result = 0; for (const value of values) result = Math.max(result, value); return result; }
function validateRow(row) {
  assert(natural(row.sequence) && row.sequence > 0 && time(row.atMs)); counters(row);
  const shape = extras => keys(row, [...rowKeys, ...extras]);
  if (row.kind === 'ownership' || row.kind === 'control-ownership') { shape([]); assert(row.complete === true); }
  else if (row.kind === 'derived-snapshot' || row.kind === 'issues') {
    shape(['operation', 'utf8Bytes', ...(row.kind === 'issues' ? ['issueCount'] : [])]);
    assert(['parse', 'serialize', ...(row.kind === 'issues' ? ['ui-issues'] : [])].includes(row.operation));
    assert(row.complete === true && natural(row.utf8Bytes) && row.utf8Bytes > 0);
    if (row.kind === 'issues') assert(natural(row.issueCount) && row.utf8Bytes >= 2 && (row.issueCount !== 0 || row.utf8Bytes === 2));
  } else if (row.kind === 'raw-read') {
    shape(['operation', 'receivedBytes', 'sourceBytes', ...(row.inspectionId === undefined ? [] : ['inspectionId'])]);
    assert(['blob-read', 'stream-read'].includes(row.operation) && natural(row.receivedBytes) && natural(row.sourceBytes) && row.receivedBytes <= row.sourceBytes);
    assert(row.inspectionId === undefined || natural(row.inspectionId) && row.inspectionId > 0 && row.inspectionId <= row.inspectionSerial);
    assert(row.complete === (row.receivedBytes === row.sourceBytes));
  } else if (row.kind === 'raw-page') {
    shape(['operation', 'sourceHash', 'sourceBytes', 'offset', 'receivedBytes', 'violations', 'retainedIdentity']);
    assert(row.operation === 'retained-page' && row.complete === true && row.retainedIdentity === true && hash(row.sourceHash));
    assert(natural(row.sourceBytes) && natural(row.offset) && natural(row.receivedBytes));
    const expected = Math.max(0, Math.min(32768, row.sourceBytes - row.offset));
    assert(row.violations === (row.receivedBytes !== expected || row.offset > row.sourceBytes ? 1 : 0), 'Raw page violation arithmetic differs');
  } else if (row.kind === 'raw-inspection') {
    assert(typeof row.retainedIdentity === 'boolean');
    shape(['operation', 'receivedBytes', 'sourceBytes', 'parseState', 'derivedPresent', 'violations', 'retainedIdentity', ...(row.retainedIdentity ? ['sourceHash'] : [])]);
    assert(row.operation === 'parse' && row.complete === true && natural(row.receivedBytes) && natural(row.sourceBytes) && states.has(row.parseState) && typeof row.derivedPresent === 'boolean');
    assert(row.retainedIdentity ? hash(row.sourceHash) : row.receivedBytes === row.sourceBytes);
    const violation = row.receivedBytes > row.sourceBytes || row.receivedBytes < row.sourceBytes && row.parseState !== 'over-limit' ||
      row.sourceBytes > 262144 && row.parseState !== 'over-limit' || row.parseState === 'supported' && !row.derivedPresent ? 1 : 0;
    assert(row.violations === violation, 'Raw inspection violation arithmetic differs');
  } else if (row.kind === 'raw-inspection-begin') {
    shape(['inspectionId', 'mode', 'sourceHash', 'sourceBytes', 'offset']);
    assert(row.complete === true && row.inspectionId === row.inspectionSerial && row.inspectionId > 0 && inspectionModes.has(row.mode));
    assert(hash(row.sourceHash) && natural(row.sourceBytes) && natural(row.offset));
  } else if (row.kind === 'raw-inspection-read') {
    shape(['inspectionId', 'receivedBytes']);
    assert(row.complete === true && natural(row.inspectionId) && row.inspectionId > 0 && row.inspectionId <= row.inspectionSerial && natural(row.receivedBytes));
  } else if (row.kind === 'raw-inspection-end') {
    shape(['inspectionId', 'outcome', ...(row.parseState === undefined ? [] : ['parseState'])]);
    assert(natural(row.inspectionId) && row.inspectionId > 0 && row.inspectionId <= row.inspectionSerial);
    assert(['page', 'parsed', 'opaque', 'decoded', 'failed'].includes(row.outcome) && row.complete === (row.outcome !== 'failed'));
    assert(row.parseState === undefined || states.has(row.parseState));
  } else assert.fail('Unknown composition observation kind');
}
function validateSnapshot(snapshot) {
  keys(snapshot, ['kind', 'schemaVersion', 'lane', 'instanceId', 'atMs', 'birth', 'clockOriginUnixMs', 'cursor', 'oldestSequence', 'dropped', 'invalid', 'inspectionInvalid', 'ownershipStarted', 'promptOwnedBytes', 'rawInspectionOwnedBytes', 'compositionControlOwnedBytes', 'inspectionSerial', 'activeInspections', 'ownershipBasis', 'physicalMemoryComplete', 'observerMetadata', 'records']);
  assert(snapshot.kind === 'composition-resource-observations-1' && snapshot.schemaVersion === 2 && snapshot.lane === 'browser-main');
  assert(uuid(snapshot.instanceId) && time(snapshot.atMs) && Number.isFinite(snapshot.clockOriginUnixMs));
  assert(natural(snapshot.cursor) && natural(snapshot.invalid) && natural(snapshot.inspectionInvalid) && typeof snapshot.ownershipStarted === 'boolean'); counters(snapshot);
  assert(snapshot.ownershipBasis === 'application-logical-payload-reservations' && snapshot.physicalMemoryComplete === false);
  const birth = snapshot.birth;
  keys(birth, ['kind', 'instanceId', 'atMs', 'cursor', 'invalid', 'inspectionInvalid', 'ownershipStarted', 'promptOwnedBytes', 'rawInspectionOwnedBytes', 'compositionControlOwnedBytes', 'inspectionSerial', 'activeInspections']);
  assert(birth.kind === 'composition-observer-birth-1' && birth.instanceId === snapshot.instanceId && time(birth.atMs) && birth.atMs <= snapshot.atMs);
  assert(birth.cursor === 0 && birth.invalid === 0 && birth.inspectionInvalid === 0 && birth.ownershipStarted === false && birth.promptOwnedBytes === 0 && birth.rawInspectionOwnedBytes === 0 && birth.compositionControlOwnedBytes === 0 && birth.inspectionSerial === 0 && birth.activeInspections === 0);
  const metadata = snapshot.observerMetadata;
  keys(metadata, ['complete', 'ringCapacity', 'retainedRecords', 'snapshotRecords', 'capacityBytes', 'snapshotAllowanceBytes', 'basis']);
  assert(metadata.complete === true && metadata.basis === 'admitted-application-diagnostic-payload-allowances');
  assert(natural(metadata.ringCapacity) && metadata.ringCapacity >= 1 && metadata.ringCapacity <= 8192);
  assert(metadata.capacityBytes === metadata.ringCapacity * 1024 + 65536 && natural(metadata.snapshotAllowanceBytes) && metadata.snapshotAllowanceBytes >= 65536);
  assert(Array.isArray(snapshot.records));
  const count = Math.min(snapshot.cursor, metadata.ringCapacity), oldest = Math.max(1, snapshot.cursor - count + 1);
  assert(snapshot.records.length === count && metadata.retainedRecords === count && metadata.snapshotRecords === count);
  assert(snapshot.oldestSequence === oldest && snapshot.dropped === Math.max(0, snapshot.cursor - metadata.ringCapacity));
  let previous = oldest === 1 ? birth : null, at = birth.atMs;
  for (let index = 0; index < snapshot.records.length; index++) {
    const row = snapshot.records[index]; validateRow(row);
    assert(row.sequence === oldest + index && row.atMs >= at && row.atMs <= snapshot.atMs); at = row.atMs;
    if (previous) reservations(previous, row);
    previous = row;
  }
  const last = snapshot.records.at(-1) ?? birth;
  assert(last.promptOwnedBytes === snapshot.promptOwnedBytes && last.rawInspectionOwnedBytes === snapshot.rawInspectionOwnedBytes &&
    last.compositionControlOwnedBytes === snapshot.compositionControlOwnedBytes, 'Producer endpoint reservations differ');
  assert(last.inspectionSerial === snapshot.inspectionSerial && last.activeInspections === snapshot.activeInspections, 'Producer endpoint inspection state differs');
  if (!snapshot.ownershipStarted) assert(snapshot.promptOwnedBytes === 0 && snapshot.rawInspectionOwnedBytes === 0 && !snapshot.records.some(row => row.kind === 'ownership'));
  if (snapshot.cursor === 0) assert(snapshot.ownershipStarted === false);
}

/** R38's inspection bound is one original-byte input extent. Copies and parsed
 * or decoded representations belong to the separate resident-workspace row.
 * A complete token is still not a proof of the partial page's byte hash. */
function replayInspections(records, before, after, snapshots, continuous) {
  const reads = [], active = new Map(); let complete = false, completed = 0, unmatchedReads = 0;
  try {
    assert(continuous && before.activeInspections === 0 && after.activeInspections === 0, 'Inspection interval begins or ends in flight');
    assert(snapshots.every(value => value.inspectionInvalid === 0), 'Inspection observer rejected an operation');
    let serial = before.inspectionSerial;
    for (const row of records) {
      if (row.kind === 'raw-inspection-begin') {
        assert(row.inspectionId === ++serial && !active.has(row.inspectionId), 'Inspection identity is reused');
        assert(row.offset <= row.sourceBytes && (row.mode === 'page' || row.offset === 0), 'Inspection source range differs');
        active.set(row.inspectionId, {begin: row, read: null, genericRead: false});
      } else if (row.kind === 'raw-inspection-read') {
        const state = active.get(row.inspectionId); assert(state && state.read === null, 'Inspection read is unmatched or repeated');
        const begin = state.begin, count = row.receivedBytes;
        assert(count <= begin.sourceBytes - begin.offset, 'Inspection exceeds original source');
        // Budget ceilings are evaluated from observed values, never used to
        // discard an otherwise complete oversized observation. Source bounds
        // and actual full-input claims remain evidence-integrity requirements.
        if (begin.mode === 'page') assert(count > 0 || begin.offset === begin.sourceBytes, 'Inspection page extent differs');
        else if (begin.mode === 'decode') assert(count === begin.sourceBytes, 'Inspection decode extent differs');
        else assert(begin.mode === 'parse', 'Metadata-only opaque decision materialized input');
        state.read = count;
      } else if (row.kind === 'raw-read') {
        const state = active.get(row.inspectionId);
        if (!state || state.genericRead || state.read !== row.receivedBytes ||
          (row.operation === 'blob-read' ? row.sourceBytes !== state.begin.sourceBytes : row.sourceBytes !== row.receivedBytes)) {unmatchedReads++; continue;}
        state.genericRead = true;
      } else if (row.kind === 'raw-inspection-end') {
        const state = active.get(row.inspectionId); assert(state, 'Inspection end is unmatched');
        const begin = state.begin;
        assert(row.outcome !== 'failed', 'Inspection operation failed or was abandoned');
        if (begin.mode === 'opaque') assert(state.read === null && begin.sourceBytes > 262144 && row.outcome === 'opaque' && (row.parseState === undefined || row.parseState === 'over-limit'), 'Opaque decision differs');
        else {
          assert(state.read !== null, 'Inspection completed without actual input');
          if (begin.mode === 'page') assert(row.outcome === 'page' && row.parseState === undefined, 'Inspection page outcome differs');
          else if (begin.mode === 'decode') assert(row.outcome === 'decoded' && row.parseState === undefined, 'Inspection decode outcome differs');
          else if (state.read < begin.sourceBytes || begin.sourceBytes > 262144) assert(row.outcome === 'opaque' && row.parseState === 'over-limit', 'Partial or oversized parse was not opaque');
          else assert(states.has(row.parseState) && (row.outcome === 'parsed' || row.outcome === 'opaque' && row.parseState === 'over-limit'), 'Inspection parse outcome differs');
          reads.push(state.read);
        }
        completed++;active.delete(row.inspectionId);
      }
    }
    assert(serial === after.inspectionSerial && active.size === 0 && unmatchedReads === 0, 'Inspection coverage is incomplete');
    complete = true;
  } catch { /* Other composition byte and workspace observations keep their own authority. */ }
  return {reads, complete, completedOperations: completed, materializedOperations: reads.length, unmatchedReads,
    activeAtStart: before?.activeInspections ?? null, activeAtEnd: after?.activeInspections ?? null};
}

/** Birth replay uses the producer's retained constructor record in this realm.
 * The caller must separately bind its navigation, executable and capture bytes.
 * An ordinary interval still requires two actual snapshots in the same realm. */
export function deriveCompositionMeasurements(snapshots, { required = names, failed = false, start = 'boundary' } = {}) {
  const wanted = new Set(required), measurements = [], missing = [];
  let records = [], continuous = false, before, after, instanceId = null;
  try {
    assert(start === 'boundary' || start === 'birth', 'Unknown composition interval start');
    assert(Array.isArray(snapshots) && snapshots.length >= (start === 'birth' ? 1 : 2), 'Actual producer cursor snapshots required');
    const first = snapshots[0], rows = new Map(), sources = new Map(); let previous;
    for (const snapshot of snapshots) {
      validateSnapshot(snapshot);
      assert(snapshot.instanceId === first.instanceId && snapshot.clockOriginUnixMs === first.clockOriginUnixMs, 'Producer realm changed');
      assert.deepEqual(snapshot.birth, first.birth, 'Producer birth changed');
      assert(snapshot.observerMetadata.ringCapacity === first.observerMetadata.ringCapacity, 'Producer ring capacity changed');
      if (previous) {
        assert(snapshot.cursor >= previous.cursor && snapshot.atMs >= previous.atMs && snapshot.invalid >= previous.invalid && snapshot.inspectionInvalid >= previous.inspectionInvalid, 'Producer cursor, clock or invalid counter reset');
        assert(!previous.ownershipStarted || snapshot.ownershipStarted, 'Producer ownership state reset');
      }
      for (const row of snapshot.records) {
        if (rows.has(row.sequence)) assert.deepEqual(row, rows.get(row.sequence), 'Producer journal record changed'); else rows.set(row.sequence, row);
        if (row.sourceHash) {
          if (sources.has(row.sourceHash)) assert(sources.get(row.sourceHash) === row.sourceBytes, 'Retained identity length changed');
          else sources.set(row.sourceHash, row.sourceBytes);
        }
      }
      previous = snapshot;
    }
    before = start === 'birth' ? first.birth : first; after = snapshots.at(-1); instanceId = first.instanceId;
    records = [...rows.values()].filter(row => row.sequence > before.cursor && row.sequence <= after.cursor).sort((a, b) => a.sequence - b.sequence);
    let cursor = before.cursor, at = before.atMs, ownershipStarted = before.ownershipStarted, prompt = before.promptOwnedBytes, raw = before.rawInspectionOwnedBytes, control = before.compositionControlOwnedBytes, inspectionSerial = before.inspectionSerial, activeInspections = before.activeInspections;
    for (const row of records) {
      assert(row.sequence === ++cursor, 'Producer journal overflow/gap'); assert(row.atMs >= at, 'Producer clock moved backward'); at = row.atMs;
      if (row.kind === 'ownership') ownershipStarted = true;
      reservations({promptOwnedBytes: prompt, rawInspectionOwnedBytes: raw, compositionControlOwnedBytes: control, inspectionSerial, activeInspections}, row);
      prompt = row.promptOwnedBytes; raw = row.rawInspectionOwnedBytes; control = row.compositionControlOwnedBytes;
      inspectionSerial = row.inspectionSerial; activeInspections = row.activeInspections;
    }
    assert(cursor === after.cursor && snapshots.every(snapshot => snapshot.invalid === 0), 'Producer journal incomplete/invalid');
    assert(prompt === after.promptOwnedBytes && raw === after.rawInspectionOwnedBytes && control === after.compositionControlOwnedBytes &&
      ownershipStarted === after.ownershipStarted && inspectionSerial === after.inspectionSerial && activeInspections === after.activeInspections, 'Producer interval endpoint differs');
    continuous = true;
  } catch { /* Only fully shape-validated records survive as incomplete observations. */ }
  const add = (name, values, method, complete = continuous) => {
    if (!wanted.has(name)) return;
    const numbers = values.filter(natural);
    if (numbers.length) measurements.push({ name, value: maximum(numbers), unit: 'bytes', method, complete: !failed && complete });
    if (!numbers.length || failed || !complete) missing.push(name + ': ' + (!numbers.length ? 'operation was not observed' : 'producer journal coverage incomplete'));
  };
  const completed = kind => records.filter(row => row.kind === kind && row.complete === true);
  add('R38DerivedSnapshotBytes', completed('derived-snapshot').map(row => row.utf8Bytes), 'Exact JSON UTF8 bytes of actual completed parsed/serialized caption snapshots');
  add('R38IssueBytes', completed('issues').map(row => row.utf8Bytes), 'Exact JSON UTF8 bytes of actual computed parse/serializer/UI issue arrays');
  add('R38RawPageBytes', completed('raw-page').map(row => row.receivedBytes), 'Actual original-byte page lengths bound to retained source identity and offset; no independent byte-integrity claim');
  const ownership = records.filter(row => row.kind === 'ownership'), controlOwnership = records.filter(row => row.kind === 'control-ownership'), inspection = [...completed('raw-page'), ...completed('raw-inspection')];
  const owned = continuous && (before?.ownershipStarted === true || start === 'birth' && ownership.length > 0);
  const inspected = replayInspections(records, before, after, snapshots, continuous);
  add('R38MaterializedRawInspectionBytes', inspected.reads, 'Maximum original-byte extent of completed source-bound inspection inputs; decoded/copy/parser representations and resident workspace are separate', inspected.complete);
  // A failed outer action cannot erase a completed, independently replayed
  // oversized inspection. This narrowly preserves a lower bound only when
  // the entire inspection journal itself is valid; partial/tampered token
  // evidence never receives lower-bound authority.
  if (failed && inspected.complete) {
    const row = measurements.find(value => value.name === 'R38MaterializedRawInspectionBytes');
    if (row) row.lowerBound = true;
  }
  const reservationObserved = before?.ownershipStarted === true || ownership.length > 0 || inspection.length > 0 || inspected.materializedOperations > 0;
  const rawInspectionReservations = {observedPeakBytes: reservationObserved ? maximum([before?.rawInspectionOwnedBytes, ...records.map(row => row.rawInspectionOwnedBytes)].filter(natural)) : null,
    transitionCoverageComplete: owned && !failed, physicalMemoryComplete: false,
    scope: 'Selected raw-owner logical reservations, including parser allowances; neither an inspection-extent measurement nor complete resident-workspace coverage'};
  const logicalOwned = continuous && (before?.ownershipStarted === true || before?.compositionControlOwnedBytes > 0 || ownership.length + controlOwnership.length > 0);
  const observedReservations = ownership.length + controlOwnership.length > 0 || before?.promptOwnedBytes > 0 || before?.compositionControlOwnedBytes > 0;
  add('R38TextCaptionWorkspaceBytes', observedReservations ? [before, ...records].map(row => row?.promptOwnedBytes + row?.compositionControlOwnedBytes) : [],
    'Simultaneous maximum of all prompt-kind and the three selected Composition control-owner payload reservations; shared control/staging/copy/scratch and physical JS/native/DOM overhead remain separate', logicalOwned);
  if (wanted.has('R38RawTruncationOrFalseCompletenessCount')) {
    const bound = inspection.filter(row => row.retainedIdentity === true);
    const complete = continuous && bound.length > 0 && bound.length === inspection.length && !failed;
    if (bound.length) measurements.push({ name: 'R38RawTruncationOrFalseCompletenessCount', value: bound.reduce((sum, row) => sum + row.violations, 0), unit: 'violations',
      method: 'Replayed retained-source page extent and full-input/bounded-prefix parse-state checks; no independent original-byte hash claim', complete });
    if (!complete) missing.push('R38RawTruncationOrFalseCompletenessCount: complete retained-source page/inspection witnesses required');
  }
  return { measurements, missing, evidence: { kind: 'composition-producer-interval-1', complete: continuous && !failed, start, instanceId, fromCursor: before?.cursor ?? null, toCursor: after?.cursor ?? null,
    fromAtMs: before?.atMs ?? null, toAtMs: after?.atMs ?? null, recordCount: records.length, ownershipUpdates: ownership.length + controlOwnership.length, promptOwnershipUpdates: ownership.length, compositionControlOwnershipUpdates: controlOwnership.length, rawInspections: inspection.length,
    rawInspection: {complete: inspected.complete && !failed, journalComplete: inspected.complete, completedOperations: inspected.completedOperations, materializedOperations: inspected.materializedOperations,
      unmatchedReads: inspected.unmatchedReads, activeAtStart: inspected.activeAtStart, activeAtEnd: inspected.activeAtEnd}, rawInspectionReservations,
    observerMetadataComplete: false,
    scope: 'Composition parse/serialize/issues/raw-view boundaries, all application prompt reservations and three selected Composition control owners; shared control/staging/copy/scratch, diagnostic metadata, physical JS/native/DOM memory and original-byte integrity remain separate' } };
}
