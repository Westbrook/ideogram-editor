// Exact producer-journal arithmetic. No sampled maxima or unexercised zeroes.
import assert from 'node:assert/strict';
const natural = value => Number.isSafeInteger(value) && value >= 0;
const time = value => Number.isFinite(value) && value >= 0;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const names = ['R38DerivedSnapshotBytes', 'R38IssueBytes', 'R38RawPageBytes', 'R38MaterializedRawInspectionBytes', 'R38TextCaptionWorkspaceBytes', 'R38RawTruncationOrFalseCompletenessCount'];
const rowKeys = ['sequence', 'atMs', 'kind', 'complete', 'promptOwnedBytes', 'rawInspectionOwnedBytes', 'compositionControlOwnedBytes'];
const states = new Set(['supported', 'ambiguous', 'unsupported', 'malformed', 'over-limit']);
function keys(value, expected) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Producer record fields differ');
}
function counters(value) {
  assert(natural(value.promptOwnedBytes) && natural(value.rawInspectionOwnedBytes) && value.rawInspectionOwnedBytes <= value.promptOwnedBytes &&
    natural(value.compositionControlOwnedBytes) && natural(value.promptOwnedBytes + value.compositionControlOwnedBytes));
}
function reservations(previous, row) {
  if (row.kind === 'ownership') assert(row.compositionControlOwnedBytes === previous.compositionControlOwnedBytes, 'Prompt ownership changed Composition control reservations');
  else if (row.kind === 'control-ownership') assert(row.promptOwnedBytes === previous.promptOwnedBytes && row.rawInspectionOwnedBytes === previous.rawInspectionOwnedBytes, 'Composition control ownership changed prompt reservations');
  else assert(row.promptOwnedBytes === previous.promptOwnedBytes && row.rawInspectionOwnedBytes === previous.rawInspectionOwnedBytes &&
    row.compositionControlOwnedBytes === previous.compositionControlOwnedBytes, 'Nonownership row changed reservations');
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
    shape(['operation', 'receivedBytes', 'sourceBytes']);
    assert(['blob-read', 'stream-read'].includes(row.operation) && natural(row.receivedBytes) && natural(row.sourceBytes) && row.receivedBytes <= row.sourceBytes);
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
  } else assert.fail('Unknown composition observation kind');
}
function validateSnapshot(snapshot) {
  keys(snapshot, ['kind', 'schemaVersion', 'lane', 'instanceId', 'atMs', 'birth', 'clockOriginUnixMs', 'cursor', 'oldestSequence', 'dropped', 'invalid', 'ownershipStarted', 'promptOwnedBytes', 'rawInspectionOwnedBytes', 'compositionControlOwnedBytes', 'ownershipBasis', 'physicalMemoryComplete', 'observerMetadata', 'records']);
  assert(snapshot.kind === 'composition-resource-observations-1' && snapshot.schemaVersion === 1 && snapshot.lane === 'browser-main');
  assert(uuid(snapshot.instanceId) && time(snapshot.atMs) && Number.isFinite(snapshot.clockOriginUnixMs));
  assert(natural(snapshot.cursor) && natural(snapshot.invalid) && typeof snapshot.ownershipStarted === 'boolean'); counters(snapshot);
  assert(snapshot.ownershipBasis === 'application-logical-payload-reservations' && snapshot.physicalMemoryComplete === false);
  const birth = snapshot.birth;
  keys(birth, ['kind', 'instanceId', 'atMs', 'cursor', 'invalid', 'ownershipStarted', 'promptOwnedBytes', 'rawInspectionOwnedBytes', 'compositionControlOwnedBytes']);
  assert(birth.kind === 'composition-observer-birth-1' && birth.instanceId === snapshot.instanceId && time(birth.atMs) && birth.atMs <= snapshot.atMs);
  assert(birth.cursor === 0 && birth.invalid === 0 && birth.ownershipStarted === false && birth.promptOwnedBytes === 0 && birth.rawInspectionOwnedBytes === 0 && birth.compositionControlOwnedBytes === 0);
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
  if (!snapshot.ownershipStarted) assert(snapshot.promptOwnedBytes === 0 && snapshot.rawInspectionOwnedBytes === 0 && !snapshot.records.some(row => row.kind === 'ownership'));
  if (snapshot.cursor === 0) assert(snapshot.ownershipStarted === false);
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
        assert(snapshot.cursor >= previous.cursor && snapshot.atMs >= previous.atMs && snapshot.invalid >= previous.invalid, 'Producer cursor, clock or invalid counter reset');
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
    let cursor = before.cursor, at = before.atMs, ownershipStarted = before.ownershipStarted, prompt = before.promptOwnedBytes, raw = before.rawInspectionOwnedBytes, control = before.compositionControlOwnedBytes;
    for (const row of records) {
      assert(row.sequence === ++cursor, 'Producer journal overflow/gap'); assert(row.atMs >= at, 'Producer clock moved backward'); at = row.atMs;
      if (row.kind === 'ownership') ownershipStarted = true;
      reservations({promptOwnedBytes: prompt, rawInspectionOwnedBytes: raw, compositionControlOwnedBytes: control}, row);
      prompt = row.promptOwnedBytes; raw = row.rawInspectionOwnedBytes; control = row.compositionControlOwnedBytes;
    }
    assert(cursor === after.cursor && snapshots.every(snapshot => snapshot.invalid === 0), 'Producer journal incomplete/invalid');
    assert(prompt === after.promptOwnedBytes && raw === after.rawInspectionOwnedBytes && control === after.compositionControlOwnedBytes &&
      ownershipStarted === after.ownershipStarted, 'Producer interval endpoint differs');
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
  add('R38MaterializedRawInspectionBytes', inspection.length ? [before?.rawInspectionOwnedBytes, ...records.map(row => row.rawInspectionOwnedBytes)] : [], 'Exact interval maximum of overlapping application raw-inspection payload reservations; physical JS/native overhead separate', owned);
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
    observerMetadataComplete: false,
    scope: 'Composition parse/serialize/issues/raw-view boundaries, all application prompt reservations and three selected Composition control owners; shared control/staging/copy/scratch, diagnostic metadata, physical JS/native/DOM memory and original-byte integrity remain separate' } };
}
