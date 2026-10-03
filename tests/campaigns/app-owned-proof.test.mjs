import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJSON } from '../../tooling/qualification/core.mjs';
import { digest } from '../../tooling/qualification/campaigns/common.mjs';
import { APP_OWNED_ALLOCATION_CONTRACT, REVIEWED_RENDERER_OWNERSHIP, captureRendererOwnershipProof,
  verifyRendererOwnershipProof, isAppOwnedAllocationScope, isAppOwnedAllocationPoint,
  validateAppOwnershipObservation } from '../../tooling/qualification/campaigns/renderer-ownership.mjs';

const resourceKeys = ['cpuBytes', 'gpuBytes', 'previewCacheBytes', 'handles'];
const kinds = ['copy', 'staging', 'scratch', 'blob', 'font', 'text', 'canvas', 'bitmap', 'prompt', 'control'];
const missing = ['app-payload-ownership-incomplete', 'native-image-and-canvas-implementation-overhead',
  'native-blob-residency', 'engine-and-dom-allocations', 'renderer-ownership-proof-required'];
const ledgerInstanceId = '5cc12ea8-706f-4b4c-b7c1-b31b6d3899aa';
const amounts = () => ({ cpuBytes: 0, gpuBytes: 0, previewCacheBytes: 0, handles: 0 });
const counts = () => ({ records: 0, ...amounts() });

function context() {
  // Deliberately unreviewed inputs. No live build, filesystem approval, or
  // synthetic approved registry entry is needed for these rejection tests.
  const sourceFiles = [{ path: 'src/unreviewed-app-owner.ts', bytes: 1, sha256: digest('x').slice(7) }];
  const buildFiles = [{ path: 'dist/app/unreviewed.js', bytes: 1, sha256: digest('x') }];
  return { sourceFiles, buildFiles, executableIdentity: {
    sourceDigest: digestJSON(sourceFiles), buildDigest: digest(buildFiles), toolsDigest: digest('test tools'),
  } };
}

function unreviewedProof(version = 2) {
  const name = version === 2 ? 'renderer-ownership-v2.json' : 'renderer-ownership.json';
  return { kind: 'renderer-ownership-proof-' + version, reviewId: 'unreviewed-app-owner',
    reviewSha256: digest('self-declared application ownership review'), contract: 'canvas2d-owned-rgba-v1',
    executableIdentity: context().executableIdentity,
    artifact: { path: '/retained/' + name, retainedPath: name, bytes: 1, sha256: digest('x') } };
}

function observation({ phase = 'sealed', reservation = false } = {}) {
  // Synthetic numeric fixtures exercise only the pure structural validator.
  // None is an approved proof, measured campaign result, or source review.
  const cpuBytes = reservation ? 40 : 0, handles = reservation ? 1 : 0, transitionSequence = reservation ? 1 : 0;
  const sealed = phase === 'sealed', sequence = 2;
  const pointKinds = kinds.map(kind => ({ kind, ...counts() }));
  Object.assign(pointKinds[0], { records: handles, cpuBytes, handles });
  const point = { kind: 'app-ownership-point-1', schemaVersion: 1, ledgerInstanceId,
    transitionSequence, cpuSequence: sequence, clock: 'browser-performance', clockOriginMs: 1000, atMs: 20,
    totals: { cpuBytes, gpuBytes: 0, previewCacheBytes: 0, handles }, centralCpuBytes: cpuBytes,
    textBytes: 0, textSequence: 0, kinds: pointKinds, observationComplete: true, globalCoverageComplete: false };
  const rows = kinds.map(kind => ({ kind, initial: counts(), current: counts(),
    transitions: { reserved: 0, resized: 0, released: 0, observed: 0 }, added: amounts(), removed: amounts() }));
  if (reservation) {
    Object.assign(rows[0].current, { records: 1, cpuBytes, handles });
    Object.assign(rows[0].added, { cpuBytes, handles });
    rows[0].transitions.reserved = 1;
  }
  const window = { kind: 'app-ownership-window-1', schemaVersion: 1,
    scope: 'application-owned-conservative-reservations', ledgerInstanceId, id: 'owned-window', ordinal: 1,
    clock: 'browser-performance', clockOriginMs: 1000, startMs: 10, endMs: sealed ? 20 : null,
    cpuStartSequence: 1, cpuEndSequence: sealed ? sequence : null, ledgerStartSequence: 0,
    ledgerEndSequence: sealed ? transitionSequence : null, lastTransitionSequence: transitionSequence,
    sealed, budgetRefusals: 0, kinds: rows,
    text: { initialBytes: 0, currentBytes: 0, startSequence: 0, endSequence: sealed ? 0 : null, observationComplete: true },
    peaks: { gpuBytes: 0, previewCacheBytes: 0, handles }, observationComplete: true, reconciled: true,
    failures: [], globalCoverageComplete: false };
  const cpuWindow = { kind: 'combined-cpu-window-1', schemaVersion: 1, ledgerInstanceId,
    id: window.id, ordinal: 1, clock: 'browser-performance', clockOriginMs: 1000, startMs: 10,
    endMs: sealed ? 20 : null, peakAtMs: reservation ? 20 : 10, startSequence: 1,
    endSequence: sealed ? sequence : null, peakSequence: reservation ? 2 : 1,
    currentBytes: cpuBytes, peakBytes: cpuBytes, ledgerBytesAtPeak: cpuBytes, textBytesAtPeak: 0,
    textStartSequence: 0, textEndSequence: sealed ? 0 : null, sealed,
    observationComplete: true, ownerCoverageComplete: false, failures: [], missing: [...missing] };
  return {
    appOwnership: { kind: 'app-ownership-observation-1', schemaVersion: 1, ledgerInstanceId,
      transitionSequence, point, window: phase === 'none' ? null : window },
    combinedCpu: { kind: 'combined-cpu-observation-1', schemaVersion: 1,
      scope: 'browser-ledger-plus-text-reservations', ledgerInstanceId, sequence,
      currentBytes: cpuBytes, observedPeakBytes: cpuBytes, observationComplete: false,
      ownerCoverageComplete: false, missing: [...missing], window: phase === 'none' ? null : cpuWindow },
  };
}

function validate(value) { return validateAppOwnershipObservation(value.appOwnership, value.combinedCpu); }
function refusesProof(proof, value = observation()) {
  for (const resourceKey of resourceKeys) {
    assert.equal(isAppOwnedAllocationScope(proof, { ...value, resourceKey }), false, resourceKey + ' scoped proof');
    assert.equal(isAppOwnedAllocationPoint(proof, { ...value, resourceKey }), false, resourceKey + ' point proof');
  }
}

test('app ownership contract retains resource scope and explicit global exclusions', () => {
  assert.deepEqual(APP_OWNED_ALLOCATION_CONTRACT, {
    contract: 'application-owned-conservative-reservations-v1', scope: 'application-owned-conservative-reservations',
    resourceKeys, excluded: ['native-image-and-canvas-implementation-overhead', 'native-blob-residency', 'engine-and-dom-allocations'],
    globalCoverageComplete: false,
  });
  assert(Object.isFrozen(APP_OWNED_ALLOCATION_CONTRACT));
  assert(Object.isFrozen(APP_OWNED_ALLOCATION_CONTRACT.resourceKeys));
  assert(Object.isFrozen(APP_OWNED_ALLOCATION_CONTRACT.excluded));
  assert(Object.isFrozen(REVIEWED_RENDERER_OWNERSHIP));
  assert(Array.isArray(REVIEWED_RENDERER_OWNERSHIP));
  for (const review of REVIEWED_RENDERER_OWNERSHIP) assert(Object.isFrozen(review));
  // Positive authority comes only from the separately reviewed real-input
  // integration. The deliberately unreviewed contexts below must still fail.
});

test('unreviewed source cannot capture an application ownership proof', async () => {
  const result = await captureRendererOwnershipProof({ repo: '/must-not-be-read', output: '/must-not-be-written', ...context() });
  assert.deepEqual(result, { proof: null, artifact: null, missing: ['No exact reviewed production renderer source closure is available'] });
  refusesProof(result.proof);
});

test('well-formed fabricated v2 metadata fails before retained evidence is read', async () => {
  const proof = JSON.parse(JSON.stringify(unreviewedProof()));
  assert(Buffer.byteLength(JSON.stringify(proof)) < 1024);
  let reads = 0;
  await assert.rejects(verifyRendererOwnershipProof(proof, { output: '/retained', ...context(),
    readRetained: async () => { reads++; return Buffer.from('x'); } }), /no exact approved source review/);
  assert.equal(reads, 0);
  refusesProof(proof, observation({ reservation: true }));
});

test('legacy v1 metadata cannot grant application point or window scope', async () => {
  // This deliberately unreviewed legacy claim must remain rejected even when
  // the fixed registry contains a separately reviewed production v2 entry.
  const proof = unreviewedProof(1);
  let reads = 0;
  await assert.rejects(verifyRendererOwnershipProof(proof, { output: '/retained', ...context(),
    readRetained: async () => { reads++; return Buffer.from('x'); } }), /no exact approved source review/);
  assert.equal(reads, 0);
  refusesProof(proof);
  refusesProof(proof, observation({ phase: 'none' }));
});

test('absent, malformed, and caller-approved metadata never grant resource scope', () => {
  for (const proof of [undefined, null, {}, { status: 'PASS' }, { ...unreviewedProof(), reviewed: true },
    { ...unreviewedProof(), globalCoverageComplete: true }, { ...unreviewedProof(), kind: 'renderer-ownership-proof-99' }]) refusesProof(proof);
  const declared = observation({ reservation: true });
  declared.appOwnership.complete = true;
  declared.appOwnership.coverage = Object.fromEntries(resourceKeys.map(key => [key, true]));
  declared.appOwnership.point.globalCoverageComplete = true;
  declared.appOwnership.window.globalCoverageComplete = true;
  declared.combinedCpu.ownerCoverageComplete = true;
  refusesProof(unreviewedProof(), declared);
  for (const resourceKey of ['rssBytes', 'settledBytes', 'textureLimits', '', null]) {
    assert.equal(isAppOwnedAllocationScope(unreviewedProof(), { ...observation(), resourceKey }), false);
    assert.equal(isAppOwnedAllocationPoint(unreviewedProof(), { ...observation(), resourceKey }), false);
  }
});

test('v2 proof replay rejects unknown and oversized metadata without reading evidence', async () => {
  const oversized = unreviewedProof(); oversized.artifact.path = '/' + 'x'.repeat(2048) + '/renderer-ownership-v2.json';
  for (const proof of [{ ...unreviewedProof(), status: 'PASS' }, oversized]) {
    let reads = 0;
    await assert.rejects(verifyRendererOwnershipProof(proof, { output: '/retained', ...context(),
      readRetained: async () => { reads++; return Buffer.from('x'); } }), /Malformed renderer ownership proof metadata/);
    assert.equal(reads, 0);
    refusesProof(proof);
  }
});

test('pure validation accepts null, open, and sealed reconciled structural observations without approving them', () => {
  for (const phase of ['none', 'open', 'sealed']) for (const reservation of [false, true]) {
    const value = observation({ phase, reservation }), before = structuredClone(value);
    assert.deepEqual(validate(value), { point: value.appOwnership.point, window: value.appOwnership.window, cpuWindow: value.combinedCpu.window });
    assert.deepEqual(value, before, 'pure validation must not rewrite evidence');
    refusesProof(unreviewedProof(), value);
  }
});

test('a legitimate incomplete point preserves unknown CPU and text values without gaining approval', () => {
  const value = observation({ phase: 'none', reservation: true });
  value.appOwnership.point.observationComplete = false;
  value.appOwnership.point.atMs = null;
  value.appOwnership.point.textBytes = null;
  value.appOwnership.point.textSequence = null;
  value.appOwnership.point.totals.cpuBytes = null;
  const before = structuredClone(value);
  assert.deepEqual(validate(value), { point: value.appOwnership.point, window: null, cpuWindow: null });
  assert.deepEqual(value, before);
  refusesProof(unreviewedProof(), value);
});

test('point validation rejects mismatched identities, sequences, counts, and simultaneous CPU totals', () => {
  const changes = [
    ['ledger identity', value => { value.appOwnership.point.ledgerInstanceId = 'other-ledger'; }],
    ['transition sequence', value => { value.appOwnership.point.transitionSequence++; }],
    ['CPU sequence', value => { value.appOwnership.point.cpuSequence++; }],
    ['central total', value => { value.appOwnership.point.centralCpuBytes++; }],
    ['combined current', value => { value.combinedCpu.currentBytes++; }],
    ['text sum', value => { value.appOwnership.point.textBytes++; }],
    ['GPU sum', value => { value.appOwnership.point.totals.gpuBytes++; }],
    ['cache sum', value => { value.appOwnership.point.totals.previewCacheBytes++; }],
    ['handle sum', value => { value.appOwnership.point.totals.handles++; }],
    ['unsafe count', value => { value.appOwnership.point.kinds[0].records = Number.MAX_SAFE_INTEGER + 1; }],
    ['negative amount', value => { value.appOwnership.point.kinds[0].cpuBytes = -1; }],
    ['kind order', value => { value.appOwnership.point.kinds.reverse(); }],
    ['unknown kind', value => { value.appOwnership.point.kinds[0].kind = 'unknown'; }],
    ['incomplete inventory', value => { value.appOwnership.point.kinds.pop(); }],
    ['nonfinite clock', value => { value.appOwnership.point.atMs = NaN; }],
    ['missing complete text', value => { value.appOwnership.point.textBytes = null; }],
    ['global coverage', value => { value.appOwnership.point.globalCoverageComplete = true; }],
    ['unknown field', value => { value.appOwnership.point.approved = true; }],
  ];
  for (const [label, change] of changes) {
    const value = observation({ phase: 'none', reservation: true }); change(value);
    assert.throws(() => validate(value), Error, label);
  }
});

test('window validation rejects broken per-kind conservation and transition reconciliation', () => {
  const changes = [
    ['byte conservation', value => { value.appOwnership.window.kinds[0].added.cpuBytes++; }],
    ['record conservation', value => { value.appOwnership.window.kinds[0].transitions.reserved++; }],
    ['transition sum', value => { value.appOwnership.window.kinds[0].transitions.observed++; }],
    ['ledger end', value => { value.appOwnership.window.ledgerEndSequence++; }],
    ['negative initial', value => { value.appOwnership.window.kinds[0].initial.records = -1; }],
    ['unsafe transition', value => { value.appOwnership.window.kinds[0].transitions.resized = Number.MAX_SAFE_INTEGER + 1; }],
    ['unknown kind', value => { value.appOwnership.window.kinds[0].kind = 'unknown'; }],
    ['duplicate kind', value => { value.appOwnership.window.kinds[1].kind = 'copy'; }],
    ['wrong kind order', value => { value.appOwnership.window.kinds.reverse(); }],
    ['omitted kind', value => { value.appOwnership.window.kinds.pop(); }],
    ['invalid refusal count', value => { value.appOwnership.window.budgetRefusals = -1; }],
    ['unknown field', value => { value.appOwnership.window.approved = true; }],
  ];
  for (const [label, change] of changes) {
    const value = observation({ reservation: true }); change(value);
    assert.throws(() => validate(value), Error, label);
  }
});

test('window validation binds CPU and app identities, boundaries, and text sequences', () => {
  const changes = [
    ['window id', value => { value.appOwnership.window.id = 'other-window'; }],
    ['window ordinal', value => { value.appOwnership.window.ordinal++; }],
    ['window ledger', value => { value.appOwnership.window.ledgerInstanceId = 'other-ledger'; }],
    ['clock origin', value => { value.appOwnership.window.clockOriginMs++; }],
    ['start time', value => { value.appOwnership.window.startMs++; }],
    ['end time', value => { value.appOwnership.window.endMs++; }],
    ['CPU start', value => { value.appOwnership.window.cpuStartSequence++; }],
    ['CPU end', value => { value.appOwnership.window.cpuEndSequence++; }],
    ['text start', value => { value.appOwnership.window.text.startSequence++; }],
    ['text end', value => { value.appOwnership.window.text.endSequence++; }],
    ['CPU current decomposition', value => { value.combinedCpu.window.currentBytes++; }],
    ['CPU peak decomposition', value => { value.combinedCpu.window.textBytesAtPeak++; }],
    ['CPU peak below current', value => { value.combinedCpu.window.peakBytes = 0; value.combinedCpu.window.ledgerBytesAtPeak = 0; }],
    ['one absent window', value => { value.combinedCpu.window = null; }],
    ['scope', value => { value.appOwnership.window.scope = 'global-process-residency'; }],
    ['global coverage', value => { value.appOwnership.window.globalCoverageComplete = true; }],
    ['CPU coverage', value => { value.combinedCpu.window.ownerCoverageComplete = true; }],
  ];
  for (const [label, change] of changes) {
    const value = observation({ reservation: true }); change(value);
    assert.throws(() => validate(value), Error, label);
  }
});

test('open and sealed window markers cannot be mixed or advance beyond the current owner sequence', () => {
  const cases = [
    ['open end time', 'open', value => { value.appOwnership.window.endMs = 20; }],
    ['open ledger end', 'open', value => { value.appOwnership.window.ledgerEndSequence = 1; }],
    ['open CPU end', 'open', value => { value.appOwnership.window.cpuEndSequence = 2; }],
    ['open text end', 'open', value => { value.appOwnership.window.text.endSequence = 0; }],
    ['open outer sequence', 'open', value => { value.appOwnership.transitionSequence++; value.appOwnership.point.transitionSequence++; }],
    ['sealed absent end', 'sealed', value => { value.appOwnership.window.endMs = null; }],
    ['sealed absent ledger end', 'sealed', value => { value.appOwnership.window.ledgerEndSequence = null; }],
    ['sealed owner sequence behind', 'sealed', value => { value.appOwnership.transitionSequence = 0; value.appOwnership.point.transitionSequence = 0; }],
  ];
  for (const [label, phase, change] of cases) {
    const value = observation({ phase, reservation: true }); change(value);
    assert.throws(() => validate(value), Error, label);
  }
});

test('failure diagnostics remain bounded and cannot claim complete reconciled coverage', () => {
  for (const failures of [['unknown-failure'], ['observer-incomplete', 'observer-incomplete']]) {
    const value = observation();
    value.appOwnership.window.observationComplete = false;
    value.appOwnership.window.reconciled = false;
    value.appOwnership.window.failures = failures;
    assert.throws(() => validate(value), Error);
  }
  const contradictory = observation();
  contradictory.appOwnership.window.failures = ['observer-incomplete'];
  assert.throws(() => validate(contradictory), Error, 'complete reconciled window cannot contain observation failures');
  const incomplete = observation();
  incomplete.appOwnership.window.observationComplete = false;
  incomplete.appOwnership.window.reconciled = false;
  incomplete.appOwnership.window.text.observationComplete = false;
  incomplete.appOwnership.window.failures = ['observer-incomplete'];
  incomplete.combinedCpu.window.observationComplete = false;
  incomplete.combinedCpu.window.failures = ['text-observer-unavailable'];
  assert.deepEqual(validate(incomplete), { point: incomplete.appOwnership.point,
    window: incomplete.appOwnership.window, cpuWindow: incomplete.combinedCpu.window });
  refusesProof(unreviewedProof(), incomplete);
});

test('an open observation point cannot precede its already recorded CPU peak', () => {
  const value = observation({ phase: 'open', reservation: true });
  value.combinedCpu.window.peakAtMs = 30;
  assert.equal(value.appOwnership.point.atMs, 20);
  assert.throws(() => validate(value), /point\/window clock/);
});

test('sealed and live observations at unchanged owner or CPU sequences cannot contradict each other', () => {
  const ownership = observation({ reservation: true });
  ownership.appOwnership.window.kinds[0].current.cpuBytes = 20;
  ownership.appOwnership.window.kinds[0].added.cpuBytes = 20;
  ownership.combinedCpu.window.currentBytes = 20;
  assert.equal(ownership.appOwnership.transitionSequence, ownership.appOwnership.window.lastTransitionSequence);
  assert.throws(() => validate(ownership), /unchanged live ownership/);

  const cpu = observation({ reservation: true });
  cpu.appOwnership.point.textBytes = 10;
  cpu.appOwnership.point.totals.cpuBytes = 50;
  cpu.combinedCpu.currentBytes = 50;
  cpu.combinedCpu.observedPeakBytes = 50;
  assert.equal(cpu.combinedCpu.sequence, cpu.combinedCpu.window.endSequence);
  assert.throws(() => validate(cpu), /sealed CPU point differs at the same sequence/);
});

test('a later reservation advances the live point while preserving the sealed window', () => {
  const value = observation({ reservation: true });
  const sealed = structuredClone({ window: value.appOwnership.window, cpuWindow: value.combinedCpu.window });
  // A second 20-byte, one-handle reservation occurs after the sealed boundary.
  value.appOwnership.transitionSequence = 2;
  Object.assign(value.appOwnership.point, { transitionSequence: 2, cpuSequence: 3, atMs: 30, centralCpuBytes: 60 });
  Object.assign(value.appOwnership.point.totals, { cpuBytes: 60, handles: 2 });
  Object.assign(value.appOwnership.point.kinds[0], { records: 2, cpuBytes: 60, handles: 2 });
  Object.assign(value.combinedCpu, { sequence: 3, currentBytes: 60, observedPeakBytes: 60 });
  assert.deepEqual(validate(value), { point: value.appOwnership.point, window: value.appOwnership.window, cpuWindow: value.combinedCpu.window });
  assert.deepEqual({ window: value.appOwnership.window, cpuWindow: value.combinedCpu.window }, sealed);
  refusesProof(unreviewedProof(), value);
});

test('an unavailable live point preserves a previously complete sealed window', () => {
  const value = observation({ reservation: true });
  const sealed = structuredClone({ window: value.appOwnership.window, cpuWindow: value.combinedCpu.window });
  Object.assign(value.appOwnership.point, { observationComplete: false, atMs: null, textBytes: null, textSequence: null });
  value.appOwnership.point.totals.cpuBytes = null;
  assert.equal(value.combinedCpu.sequence, value.combinedCpu.window.endSequence);
  assert.deepEqual(validate(value), { point: value.appOwnership.point, window: value.appOwnership.window, cpuWindow: value.combinedCpu.window });
  assert.deepEqual({ window: value.appOwnership.window, cpuWindow: value.combinedCpu.window }, sealed);
  assert.equal(value.appOwnership.window.observationComplete, true);
  refusesProof(unreviewedProof(), value);
});

test('point, initial, and current kind snapshots cannot own resources with zero records', () => {
  const changes = [
    ['point', value => { value.appOwnership.point.kinds[0].records = 0; }],
    ['initial', value => {
      value.appOwnership.window.kinds[0].initial.cpuBytes = 20;
      value.appOwnership.window.kinds[0].added.cpuBytes = 20;
    }],
    ['current', value => {
      value.appOwnership.window.kinds[0].current.records = 0;
      value.appOwnership.window.kinds[0].transitions.reserved = 0;
      value.appOwnership.window.kinds[0].transitions.observed = 1;
    }],
  ];
  for (const [label, change] of changes) {
    const value = observation({ reservation: true }); change(value);
    assert.throws(() => validate(value), /ownership without a record/, label);
  }
});

test('a lower text end sequence requires disclosed incomplete rebind or discontinuity diagnostics', () => {
  for (const reason of ['text-observer-rebound', 'text-sequence-discontinuity']) {
    const value = observation();
    Object.assign(value.appOwnership.window, { observationComplete: false, failures: ['observer-incomplete'] });
    Object.assign(value.appOwnership.window.text, { startSequence: 5, endSequence: 0, observationComplete: false });
    Object.assign(value.combinedCpu.window, { textStartSequence: 5, textEndSequence: 0,
      observationComplete: false, failures: [reason] });
    assert.equal(value.appOwnership.point.textSequence, 0);
    assert.deepEqual(validate(value), { point: value.appOwnership.point, window: value.appOwnership.window, cpuWindow: value.combinedCpu.window });
    refusesProof(unreviewedProof(), value);
    for (const [label, complete, failures] of [
      ['complete CPU', true, []], ['undisclosed rebind', false, []],
      ['unrelated fault', false, ['text-observer-unavailable']],
    ]) {
      const invalid = structuredClone(value);
      Object.assign(invalid.combinedCpu.window, { observationComplete: complete, failures });
      assert.throws(() => validate(invalid), /CPU sealed boundary/, label);
    }
  }
});

test('a zero-transition kind cannot manufacture offsetting added and removed amounts', () => {
  const value = observation();
  value.appOwnership.window.kinds[0].added.cpuBytes = 12;
  value.appOwnership.window.kinds[0].removed.cpuBytes = 12;
  assert.equal(value.appOwnership.window.kinds[0].current.cpuBytes, 0);
  assert.throws(() => validate(value), /kind deltas without a transition/);
});

test('overflow diagnostics can retain changed current ownership after transition counters freeze', () => {
  const value = observation({ reservation: true }), saturated = Number.MAX_SAFE_INTEGER;
  value.appOwnership.transitionSequence = saturated;
  Object.assign(value.appOwnership.point, { transitionSequence: saturated, observationComplete: false });
  Object.assign(value.appOwnership.window, { ledgerStartSequence: saturated, ledgerEndSequence: saturated,
    lastTransitionSequence: saturated, observationComplete: false, reconciled: false,
    failures: ['counter-overflow', 'kind-reconciliation', 'cpu-window-binding', 'observer-incomplete'] });
  value.appOwnership.window.text.observationComplete = false;
  value.appOwnership.window.kinds[0].transitions.reserved = 0;
  value.appOwnership.window.kinds[0].added = amounts();
  assert.equal(value.appOwnership.window.kinds[0].current.cpuBytes, 40);
  assert.deepEqual(validate(value), { point: value.appOwnership.point, window: value.appOwnership.window, cpuWindow: value.combinedCpu.window });
  refusesProof(unreviewedProof(), value);
});
