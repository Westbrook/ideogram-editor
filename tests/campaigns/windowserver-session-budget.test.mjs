import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, writeFile, symlink, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deriveSessionReservation, inspectSessionEvidenceBudget, verifySessionEvidenceAdmission, verifySessionEvidenceFinalSample} from '../../tooling/qualification/campaigns/windowserver-session-budget.mjs';

// Synthetic arithmetic and retained-byte replay, plus one temporary filesystem
// fixture for allocation-path rejection. No collector is launched; these tests
// cannot establish native qualification.
const KiB = 1024, MiB = 1024 * KiB;
const MAX = Number.MAX_SAFE_INTEGER;
const PROFILE = 'interaction-100-2400-60hz-60s-1';
const clone = value => structuredClone(value);
const config = () => ({schemaVersion: 2, profile: PROFILE, displayID: 1, expectedBrowserPid: 321,
  roi: {x: 0, y: 0, width: 2, height: 3}});
const reservation = () => ({bytes: MAX,
  trace: {bytes: 4097, files: 3, directories: 2},
  oracle: {bytes: 1, files: 2, directories: 1},
  control: {bytes: 777, files: 1, directories: 0}});
const input = () => ({config: config(), evidenceReservation: reservation(), filesystemBlockBytes: 4096, allocationSourceBytes: 301});
const sum = values => values.reduce((total, value) => total + value, 0);
function category(logicalBytes, files, directories, roundingBytes, blockBytes) {
  const directoryBytes = directories * blockBytes;
  return {logicalBytes, files, directories, roundingBytes, directoryBytes,
    allocatedBytes: logicalBytes + roundingBytes + directoryBytes};
}
function plainJSON(value) {
  if (value === null || typeof value !== 'object') {
    assert.ok(value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value));
    return;
  }
  assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
  for (const child of Object.values(value)) plainJSON(child);
}

test('session reservation independently accounts for the full fixed interaction profile', () => {
  const result = deriveSessionReservation(input());
  const pixelBytes = 24 * 9012;
  const metadataBytes = 9012 * 4096 + 5114 * 256;
  const manifestBytes = 9012 * 256 + 32768;
  assert.deepEqual(result.capacity, {durationMs: 75000, measurementDurationMs: 60000, refreshHz: 60,
    continuousGestures: 20, pointsPerGesture: 120, discreteGestures: 80, discreteSubsteps: 125,
    maxFrames: 9012, maxClockRecords: 5114, maxPixelBytes: pixelBytes,
    metadataByteLimit: metadataBytes, manifestByteLimit: manifestBytes,
    requiredArtifactBytes: pixelBytes + metadataBytes + manifestBytes});
  assert.deepEqual(Object.keys(result).sort(), ['capacity', 'categories', 'requiredReservationBytes', 'reservationBytes',
    'reservationSufficient', 'filesystemBlockBytes', 'files', 'directories'].sort());
  assert.equal(result.reservationBytes, MAX);
  assert.equal(result.reservationSufficient, true);
  assert.equal(result.filesystemBlockBytes, 4096);
});

test('native frame files round separately and retained metadata includes every bounded owner', () => {
  const result = deriveSessionReservation(input()), block = 4096;
  const nativeLogical = 24 * 9012 + 9012 * 4096 + 5114 * 256 + 9012 * 256 + 32768;
  const expected = {
    native: category(nativeLogical, 9014, 0, 9012 * (4096 - 24) + 1536 + 3072, block),
    stdout: category(9012 * 4096 + 5114 * 256 + 65536, 1, 0, 1536, block),
    stderr: category(MiB, 1, 0, 0, block),
    supervisor: category(4 * 128 * KiB + 301 + 64 * KiB, 6, 4, 4096 - 301, block),
    // Combined log-pair limits have unknown splits; each of the four log files
    // receives a worst-tail allowance instead of rounding one combined file.
    build: category(2 * 128 * KiB + 4 * MiB + 128 * MiB + MiB + 16 * MiB + 64 * MiB, 9, 0, 4 * 4095, block),
    trace: category(4097, 3, 2, 3 * 4095, block),
    oracle: category(1, 2, 1, 2 * 4095, block),
    control: category(777, 1, 0, 4095, block),
  };
  assert.deepEqual(result.categories, expected);
  assert.equal(result.requiredReservationBytes, sum(Object.values(expected).map(value => value.allocatedBytes)));
  assert.equal(result.files, 9037);
  assert.equal(result.directories, 7);
});

test('one-byte blocks eliminate file rounding while preserving directory accounting', () => {
  const value = input(); value.filesystemBlockBytes = 1;
  const result = deriveSessionReservation(value);
  for (const entry of Object.values(result.categories)) {
    assert.equal(entry.roundingBytes, 0);
    assert.equal(entry.directoryBytes, entry.directories);
    assert.equal(entry.allocatedBytes, entry.logicalBytes + entry.directories);
  }
  assert.equal(result.requiredReservationBytes, sum(Object.values(result.categories).map(entry => entry.logicalBytes)) + result.directories);
});

test('filesystem rounding follows non-power-of-two blocks without bitwise truncation', () => {
  const value = input(); value.filesystemBlockBytes = 3000;
  const result = deriveSessionReservation(value), native = result.categories.native;
  const rounded = bytes => Math.ceil(bytes / 3000) * 3000;
  assert.equal(native.allocatedBytes, 9012 * rounded(24) + rounded(9012 * 4096 + 5114 * 256) + rounded(9012 * 256 + 32768));
  assert.equal(result.categories.trace.roundingBytes, 3 * 2999);
  assert.equal(result.categories.supervisor.directoryBytes, 4 * 3000);
});

test('generic evidence declarations require positive byte and file allowances for each owner', () => {
  const value = input();
  value.evidenceReservation.trace = {bytes: 1, files: 1, directories: 0};
  value.evidenceReservation.oracle = {bytes: 1, files: 1, directories: 0};
  value.evidenceReservation.control = {bytes: 1, files: 1, directories: 3};
  const result = deriveSessionReservation(value);
  assert.deepEqual(result.categories.trace, category(1, 1, 0, 4095, 4096));
  assert.deepEqual(result.categories.oracle, category(1, 1, 0, 4095, 4096));
  assert.deepEqual(result.categories.control, category(1, 1, 3, 4095, 4096));
  for (const name of ['trace', 'oracle', 'control']) for (const field of ['bytes', 'files']) {
    const invalid = input(); invalid.evidenceReservation[name][field] = 0;
    assert.throws(() => deriveSessionReservation(invalid), undefined, `${name}.${field}`);
  }
});

test('reservation admission distinguishes exact capacity from a one-byte short declaration', () => {
  const value = input(), required = deriveSessionReservation(value).requiredReservationBytes;
  value.evidenceReservation.bytes = required;
  const exact = deriveSessionReservation(value);
  assert.equal(exact.reservationSufficient, true);
  assert.equal(exact.reservationBytes, required);
  value.evidenceReservation.bytes = required - 1;
  const short = deriveSessionReservation(value);
  assert.equal(short.reservationSufficient, false);
  assert.equal(short.requiredReservationBytes, required);
  assert.equal(short.reservationBytes, required - 1);
  value.evidenceReservation.bytes = 1;
  assert.equal(deriveSessionReservation(value).reservationSufficient, false);
});

test('actual allocation source length is accounted through the inclusive 16-MiB bound', () => {
  const smallInput = input(); smallInput.allocationSourceBytes = 1;
  const largeInput = input(); largeInput.allocationSourceBytes = 16 * MiB;
  const small = deriveSessionReservation(smallInput), large = deriveSessionReservation(largeInput);
  assert.equal(large.categories.supervisor.logicalBytes - small.categories.supervisor.logicalBytes, 16 * MiB - 1);
  assert.equal(large.requiredReservationBytes - small.requiredReservationBytes, 16 * MiB - 4096);
  assert.equal(large.categories.supervisor.files, small.categories.supervisor.files);
  for (const allocationSourceBytes of [0, -1, 0.5, 16 * MiB + 1, MAX + 1, NaN, Infinity, '301', null]) {
    assert.throws(() => deriveSessionReservation({...input(), allocationSourceBytes}), undefined, String(allocationSourceBytes));
  }
});

test('large valid native reservations are not truncated to 32 bits or an arbitrary campaign cap', () => {
  const value = input(); value.config.roi = {x: 0, y: 0, width: 8192, height: 8192};
  const result = deriveSessionReservation(value);
  assert.equal(result.capacity.maxPixelBytes, 256 * MiB * 9012);
  assert.ok(result.requiredReservationBytes > 2 ** 40);
  assert.ok(Number.isSafeInteger(result.requiredReservationBytes));
  assert.equal(result.reservationBytes, MAX);
  assert.equal(result.reservationSufficient, true);
});

test('derivation leaves inputs unchanged and returns detached plain JSON', () => {
  const value = input(), original = clone(value), result = deriveSessionReservation(value), expected = clone(result);
  assert.deepEqual(value, original);
  value.config.roi.width = 999;
  value.evidenceReservation.trace.bytes = 0;
  value.evidenceReservation.trace.files = 0;
  value.evidenceReservation.bytes = 1;
  assert.deepEqual(result, expected);
  assert.notStrictEqual(result.categories.trace, value.evidenceReservation.trace);
  plainJSON(result);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('raw config rejects injected admission and qualification fields', () => {
  for (const field of ['evidenceBudget', 'qualification', 'durationMs', 'maxFrames']) {
    const value = input(); value.config[field] = field === 'qualification' ? true : {};
    assert.throws(() => deriveSessionReservation(value), undefined, field);
  }
  for (const field of Object.keys(config())) {
    const value = input(); delete value.config[field];
    assert.throws(() => deriveSessionReservation(value), undefined, field);
  }
  for (const invalid of [null, [], 'config']) assert.throws(() => deriveSessionReservation({...input(), config: invalid}));
});

test('native identity and ROI scalar limits are rejected before budgeting', () => {
  for (const [field, values] of Object.entries({schemaVersion: [1, '2', null], profile: ['', 'unknown'],
    displayID: [0, -1, 1.5, 0x100000000, '1'], expectedBrowserPid: [0, -1, 1.5, 0x80000000, '321']})) {
    for (const invalid of values) {const value = input(); value.config[field] = invalid; assert.throws(() => deriveSessionReservation(value), undefined, `${field}:${invalid}`);}
  }
  for (const [field, invalid] of [['x', -1], ['y', 32769], ['width', 0], ['height', 0], ['width', 32769], ['height', 1.5], ['x', '0']]) {
    const value = input(); value.config.roi[field] = invalid; assert.throws(() => deriveSessionReservation(value), undefined, `${field}:${invalid}`);
  }
  const oversized = input(); oversized.config.roi = {x: 0, y: 0, width: 8192, height: 8193};
  assert.throws(() => deriveSessionReservation(oversized));
  const extra = input(); extra.config.roi.deviceScaleFactor = 2; assert.throws(() => deriveSessionReservation(extra));
});

test('reservation declarations reject omitted, extra, and non-integer scalar inputs', () => {
  for (const name of ['bytes', 'trace', 'oracle', 'control']) {
    const value = input(); delete value.evidenceReservation[name]; assert.throws(() => deriveSessionReservation(value), undefined, name);
  }
  const extra = input(); extra.evidenceReservation.qualification = true; assert.throws(() => deriveSessionReservation(extra));
  for (const name of ['trace', 'oracle', 'control']) {
    for (const field of ['bytes', 'files', 'directories']) {
      const missing = input(); delete missing.evidenceReservation[name][field]; assert.throws(() => deriveSessionReservation(missing));
      for (const invalid of [-1, 0.5, MAX + 1, NaN, Infinity, '1', null]) {
        const value = input(); value.evidenceReservation[name][field] = invalid; assert.throws(() => deriveSessionReservation(value), undefined, `${name}.${field}:${invalid}`);
      }
    }
    const value = input(); value.evidenceReservation[name].path = '/ignored'; assert.throws(() => deriveSessionReservation(value));
  }
  for (const bytes of [0, -1, 0.5, MAX + 1, NaN, Infinity, '1', null]) {
    const value = input(); value.evidenceReservation.bytes = bytes; assert.throws(() => deriveSessionReservation(value), undefined, String(bytes));
  }
});

test('filesystem block size must be a positive safe integer', () => {
  for (const filesystemBlockBytes of [0, -1, 0.5, MAX + 1, NaN, Infinity, '4096', null]) {
    assert.throws(() => deriveSessionReservation({...input(), filesystemBlockBytes}), undefined, String(filesystemBlockBytes));
  }
});

test('rounding and directory multiplication reject unsafe allocated-byte totals', () => {
  const fileOverflow = input(); fileOverflow.evidenceReservation.trace = {bytes: 1, files: MAX, directories: 0};
  assert.throws(() => deriveSessionReservation(fileOverflow));
  const directoryOverflow = input(); directoryOverflow.evidenceReservation.control = {bytes: 1, files: 1, directories: MAX};
  assert.throws(() => deriveSessionReservation(directoryOverflow));
  assert.throws(() => deriveSessionReservation({...input(), filesystemBlockBytes: MAX}));
});

test('safe individual declarations cannot overflow the aggregate reservation', () => {
  const value = input(); value.filesystemBlockBytes = 1;
  value.evidenceReservation.trace = {bytes: Math.floor(MAX / 2), files: 1, directories: 0};
  value.evidenceReservation.oracle = {bytes: Math.floor(MAX / 2), files: 1, directories: 0};
  value.evidenceReservation.control = {bytes: 1, files: 1, directories: 0};
  assert.throws(() => deriveSessionReservation(value));
  const counts = input(); counts.filesystemBlockBytes = 1;
  counts.evidenceReservation.trace = {bytes: 1, files: MAX, directories: 0};
  assert.throws(() => deriveSessionReservation(counts));
});

function inspectInput() {
  // Both sentinels are intentionally unopened: one always differs from the
  // current environment without mutating shared process.env in the test.
  const first = '/windowserver-session-budget-no-io-a/allocation.json';
  const path = process.env.IE_EVIDENCE_ALLOCATION === first ? '/windowserver-session-budget-no-io-b/allocation.json' : first;
  return {config: config(), evidenceAllocation: {path, bytes: 301, sha256: 'a'.repeat(64)},
    evidenceReservation: reservation(), outputDirectory: '/windowserver-session-budget-no-io-output'};
}

test('inspection rejects allocation/environment disagreement before any filesystem read', async () => {
  await assert.rejects(async () => inspectSessionEvidenceBudget(inspectInput()), /allocation.*environment/i);
});

test('inspection rejects invalid raw config before allocation/environment or filesystem work', async () => {
  const value = inspectInput(); value.config.qualification = true;
  await assert.rejects(async () => inspectSessionEvidenceBudget(value), /config/i);
});

test('inspection rejects unsafe output and malformed allocation pins before opening them', async () => {
  for (const outputDirectory of ['', 'relative-output', '/tmp/../output', '/output\u0000tail', '/output/']) {
    const value = inspectInput(); value.outputDirectory = outputDirectory;
    await assert.rejects(async () => inspectSessionEvidenceBudget(value), /session output directory/i);
  }
  for (const evidenceAllocation of [{path: 'relative', bytes: 301, sha256: 'a'.repeat(64)},
    {path: '/unopened/allocation.json', bytes: 0, sha256: 'a'.repeat(64)},
    {path: '/unopened/allocation.json', bytes: 301, sha256: 'not-a-digest'},
    {path: '/unopened/allocation.json', bytes: 301, sha256: 'a'.repeat(64), qualification: true}]) {
    const value = inspectInput(); value.evidenceAllocation = evidenceAllocation;
    await assert.rejects(async () => inspectSessionEvidenceBudget(value), error => {
      assert.match(error.message, /allocation|pin|path/i);
      assert.doesNotMatch(error.message, /controller environment/i);
      return true;
    });
  }
});

const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const byteIdentity = bytes => ({bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
const limitations = [
  'A fresh allocation sample is a non-atomic observation, not a storage reservation or filesystem quota.',
  'Logical file bounds, block rounding and directory allowances do not bound filesystem-wide metadata, snapshots or concurrent writers.',
  'The existing outer evidence monitor must remain active and its separately retained final audit must pass; this admission grants no qualification.',
];
function counter(overrides = {}) {
  return {kind: 'evidence-volume-sample-1', startedAt: '2026-09-30T12:00:00.000Z', finishedAt: '2026-09-30T12:00:00.001Z',
    startMs: 20, endMs: 21, method: 'bounded-nofollow-streaming-lstat', consistency: 'non-atomic-observation-window',
    completeTraversal: true, entries: 3, concurrentChanges: 0, uniqueFiles: 1, repeatedInodes: 0,
    observedLogicalBytes: 90000000, observedAllocatedBytes: 100000000, failures: [],
    limitations: ['Synthetic non-atomic sample; no live allocation was observed.'], ...overrides};
}
function expectedAlarm(sample, capacityBytes) {
  if (!sample.completeTraversal || sample.observedAllocatedBytes === null) return {status: 'INCONCLUSIVE', level: 'unknown', percent: null};
  const percent = sample.observedAllocatedBytes / capacityBytes * 100;
  return {status: percent >= 90 ? 'FAIL' : 'PASS', level: percent >= 90 ? 'ceiling' : percent >= 80 ? 'target' : 'normal', percent};
}
function offlineAdmission({capacityBytes = 2000000000, reservationBytes = 500000000, sample = counter(), status = 'PASS', reason = null} = {}) {
  // Historical names deliberately have no corresponding fixture directory.
  const authority = {kind: 'evidence-volume-allocation-1', allocationId: 'synthetic-budget', purpose: 'qualification-evidence-only',
    capacityBytes, root: '/synthetic-offline-session-evidence', issuedAt: '2026-09-30T11:00:00.000Z', owner: 'synthetic-owner'};
  const allocationSourceBytes = encode(authority), allocationIdentity = byteIdentity(allocationSourceBytes);
  const evidenceAllocation = {path: '/synthetic-offline-authority/allocation.json', ...allocationIdentity};
  const outputDirectory = authority.root + '/retained-session', raw = config(), evidenceReservation = reservation();
  evidenceReservation.bytes = reservationBytes;
  const derived = deriveSessionReservation({config: raw, evidenceReservation, filesystemBlockBytes: 4096, allocationSourceBytes: allocationSourceBytes.length});
  const directoryIdentity = {dev: '1', ino: '22', uid: '501', mode: String(0o40700)};
  const admission = {kind: 'windowserver-session-evidence-admission-1', allocationPath: evidenceAllocation.path,
    allocation: {...authority, identity: allocationIdentity, directoryIdentity: {...directoryIdentity, ino: '11'}},
    outputDirectory, directoryIdentity, sample: clone(sample), alarm: expectedAlarm(sample, capacityBytes), filesystemBlockBytes: 4096,
    capacity: clone(derived.capacity), evidenceReservation: clone(evidenceReservation), reservation: derived,
    config: status === 'PASS' ? {...clone(raw), evidenceBudget: {capacityBytes, observedAllocatedBytes: sample.observedAllocatedBytes,
      reservationBytes, allocationSha256: allocationIdentity.sha256}} : null,
    status, reason, qualification: false, limitations: [...limitations]};
  const fixture = {admission, options: {admissionBytes: null, allocationSourceBytes, expectedAdmission: null,
    evidenceAllocation, evidenceReservation, config: raw, outputDirectory}};
  return resealAdmission(fixture);
}
function resealAdmission(fixture) {
  fixture.options.admissionBytes = encode(fixture.admission);
  fixture.options.expectedAdmission = byteIdentity(fixture.options.admissionBytes);
  return fixture;
}
function refusal(fixture, status, reason) {
  assert.throws(() => verifySessionEvidenceAdmission(fixture.options), error => {
    assert.equal(error.evidenceVolumeStatus, status);
    assert.equal(error.sessionEvidenceAdmission?.reason, reason);
    assert.deepEqual(error.sessionEvidenceAdmission, fixture.admission);
    assert.equal(error.sessionEvidenceAdmission.qualification, false);
    assert.ok(Buffer.isBuffer(error.allocationSourceBytes));
    assert.deepEqual(error.allocationSourceBytes, fixture.options.allocationSourceBytes);
    assert.notStrictEqual(error.allocationSourceBytes, fixture.options.allocationSourceBytes);
    return true;
  });
}

test('offline admission replays pinned bytes without opening historical paths and returns detached evidence', () => {
  const fixture = offlineAdmission(), result = verifySessionEvidenceAdmission(fixture.options);
  assert.equal(result.status, 'admitted');
  assert.deepEqual(result.admission, fixture.admission);
  assert.equal(result.admission.qualification, false);
  assert.deepEqual(result.allocationSourceBytes, fixture.options.allocationSourceBytes);
  assert.notStrictEqual(result.allocationSourceBytes, fixture.options.allocationSourceBytes);
  const retained = clone(result.admission);
  fixture.admission.sample.observedAllocatedBytes = 0;
  fixture.options.evidenceReservation.trace.bytes = 0;
  fixture.options.allocationSourceBytes.fill(0);
  assert.deepEqual(result.admission, retained);
  assert.notEqual(result.allocationSourceBytes[0], 0);
});

test('offline admission authenticates authority and admission bytes against external pins', () => {
  for (const target of ['admissionBytes', 'allocationSourceBytes']) {
    const fixture = offlineAdmission(); fixture.options[target] = Buffer.concat([fixture.options[target], Buffer.from(' ')]);
    assert.throws(() => verifySessionEvidenceAdmission(fixture.options), /byte identity/);
  }
  for (const target of ['expectedAdmission', 'evidenceAllocation']) {
    const fixture = offlineAdmission(); fixture.options[target].sha256 = 'b'.repeat(64);
    assert.throws(() => verifySessionEvidenceAdmission(fixture.options), /byte identity/);
  }
  const fixture = offlineAdmission(), authority = JSON.parse(fixture.options.allocationSourceBytes.toString('utf8'));
  authority.capacityBytes *= 2; fixture.options.allocationSourceBytes = encode(authority);
  assert.throws(() => verifySessionEvidenceAdmission(fixture.options), /byte identity/);
});

test('resealed admission fields cannot override selected allocation, config, reservation, or statfs accounting', () => {
  const mutations = {
    'allocation capacity': value => {value.allocation.capacityBytes *= 2;},
    'allocation identity': value => {value.allocation.identity.sha256 = 'b'.repeat(64);},
    'allocation source path': value => {value.allocationPath = '/different-authority/allocation.json';},
    'output path': value => {value.outputDirectory += '-different';},
    'frame capacity': value => {value.capacity.maxFrames--;},
    'native category': value => {value.reservation.categories.native.allocatedBytes--;},
    'total reservation': value => {value.reservation.requiredReservationBytes--;},
    'reservation declaration': value => {value.evidenceReservation.trace.files++;},
    'statfs block bytes': value => {value.filesystemBlockBytes = 8192;},
    'derived evidence capacity': value => {value.config.evidenceBudget.capacityBytes *= 2;},
    'derived browser owner': value => {value.config.expectedBrowserPid++;},
    'claimed qualification': value => {value.qualification = true;},
    'changed limitation': value => {value.limitations.pop();},
    'unknown retained field': value => {value.claimedHeadroom = true;},
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const fixture = offlineAdmission(); mutate(fixture.admission); resealAdmission(fixture);
    assert.throws(() => verifySessionEvidenceAdmission(fixture.options), undefined, label);
  }
});

test('offline admission rejects nonprivate directory modes and output outside the allocation root', () => {
  for (const target of ['directoryIdentity', 'allocation']) {
    for (const mode of [0o40755, 0o100600]) {
      const fixture = offlineAdmission(), identity = target === 'allocation' ? fixture.admission.allocation.directoryIdentity : fixture.admission.directoryIdentity;
      identity.mode = String(mode); resealAdmission(fixture);
      assert.throws(() => verifySessionEvidenceAdmission(fixture.options), /directory identity/);
    }
  }
  const fixture = offlineAdmission();
  fixture.options.outputDirectory = '/synthetic-offline-session-evidence-sibling/retained-session';
  fixture.admission.outputDirectory = fixture.options.outputDirectory; resealAdmission(fixture);
  assert.throws(() => verifySessionEvidenceAdmission(fixture.options), /escapes/);
});

test('offline admission requires canonical authority/output paths and matching recorded owners', () => {
  const output = offlineAdmission(); output.options.outputDirectory += '/';
  assert.throws(() => verifySessionEvidenceAdmission(output.options), /session output directory/);
  const root = offlineAdmission(), authority = JSON.parse(root.options.allocationSourceBytes.toString('utf8'));
  authority.root += '/'; root.options.allocationSourceBytes = encode(authority);
  Object.assign(root.options.evidenceAllocation, byteIdentity(root.options.allocationSourceBytes));
  assert.throws(() => verifySessionEvidenceAdmission(root.options), /allocation root/);
  const owner = offlineAdmission(); owner.admission.directoryIdentity.uid = '502'; resealAdmission(owner);
  assert.throws(() => verifySessionEvidenceAdmission(owner.options), /owners differ/);
});

test('offline admission retains insufficient and exactly-90-percent projected refusals', () => {
  refusal(offlineAdmission({reservationBytes: 1, status: 'INCONCLUSIVE', reason: 'reservation-insufficient'}), 'INCONCLUSIVE', 'reservation-insufficient');
  refusal(offlineAdmission({capacityBytes: 1000000000, reservationBytes: 800000000,
    status: 'INCONCLUSIVE', reason: 'projected-capacity-ceiling'}), 'INCONCLUSIVE', 'projected-capacity-ceiling');
  const below = offlineAdmission({capacityBytes: 1000000000, reservationBytes: 799999999});
  assert.equal(verifySessionEvidenceAdmission(below.options).status, 'admitted');
});

test('actual 90-percent allocation failure takes priority over insufficient reservation', () => {
  const sample = counter({observedAllocatedBytes: 1800000000});
  refusal(offlineAdmission({sample, reservationBytes: 1, status: 'FAIL', reason: 'actual-capacity-ceiling'}), 'FAIL', 'actual-capacity-ceiling');
});

test('projected evidence entries preserve the existing monitor traversal bound', () => {
  const reference = offlineAdmission(), reservedEntries = reference.admission.reservation.files + reference.admission.reservation.directories;
  const atLimit = counter({entries: 100000 - reservedEntries});
  assert.equal(verifySessionEvidenceAdmission(offlineAdmission({sample: atLimit}).options).status, 'admitted');
  const aboveLimit = counter({entries: 100001 - reservedEntries});
  refusal(offlineAdmission({sample: aboveLimit, status: 'INCONCLUSIVE', reason: 'monitor-entry-bound'}), 'INCONCLUSIVE', 'monitor-entry-bound');
  refusal(offlineAdmission({sample: aboveLimit, reservationBytes: 1, status: 'INCONCLUSIVE', reason: 'reservation-insufficient'}), 'INCONCLUSIVE', 'reservation-insufficient');
  refusal(offlineAdmission({sample: counter({entries: 100001, observedAllocatedBytes: 1800000000}),
    status: 'FAIL', reason: 'actual-capacity-ceiling'}), 'FAIL', 'actual-capacity-ceiling');
});

test('unknown allocation coverage prevents admission and an 80-percent target alarm grants no qualification', () => {
  const unknown = counter({completeTraversal: false, observedLogicalBytes: null, observedAllocatedBytes: null,
    failures: [{code: 'EVIDENCE_MUTATION', message: 'Synthetic concurrent membership change.'}]});
  refusal(offlineAdmission({sample: unknown, status: 'INCONCLUSIVE', reason: 'sample-incomplete'}), 'INCONCLUSIVE', 'sample-incomplete');
  const fixture = offlineAdmission({capacityBytes: 10000000000, sample: counter({observedAllocatedBytes: 8000000000})});
  const result = verifySessionEvidenceAdmission(fixture.options);
  assert.deepEqual(result.admission.alarm, {status: 'PASS', level: 'target', percent: 80});
  assert.equal(result.admission.qualification, false);
});

test('offline admission rejects resealed duplicate keys, malformed UTF-8, and oversized JSON', () => {
  const duplicate = offlineAdmission();
  duplicate.options.admissionBytes = Buffer.from('{"kind":"windowserver-session-evidence-admission-1",' + duplicate.options.admissionBytes.toString('utf8').trim().slice(1));
  duplicate.options.expectedAdmission = byteIdentity(duplicate.options.admissionBytes);
  assert.throws(() => verifySessionEvidenceAdmission(duplicate.options), /Duplicate/);
  const allocationDuplicate = offlineAdmission();
  allocationDuplicate.options.allocationSourceBytes = Buffer.from('{"kind":"evidence-volume-allocation-1",' + allocationDuplicate.options.allocationSourceBytes.toString('utf8').trim().slice(1));
  Object.assign(allocationDuplicate.options.evidenceAllocation, byteIdentity(allocationDuplicate.options.allocationSourceBytes));
  assert.throws(() => verifySessionEvidenceAdmission(allocationDuplicate.options), /Duplicate/);
  const escapedDuplicate = offlineAdmission();
  escapedDuplicate.options.admissionBytes = Buffer.from(escapedDuplicate.options.admissionBytes.toString('utf8').replace('"x": 0', '"x": 0, "\\u0078": 0'));
  escapedDuplicate.options.expectedAdmission = byteIdentity(escapedDuplicate.options.admissionBytes);
  assert.throws(() => verifySessionEvidenceAdmission(escapedDuplicate.options), /Duplicate/);
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('{'), Buffer.alloc(128 * KiB + 1, 32)]) {
    const fixture = offlineAdmission(); fixture.options.admissionBytes = bytes; fixture.options.expectedAdmission = byteIdentity(bytes);
    assert.throws(() => verifySessionEvidenceAdmission(fixture.options));
  }
});

test('offline admission rejects contradictory samples and unbounded diagnostic fields', () => {
  const mutations = [value => {value.sample.failures = [{code: 'EVIDENCE_IO', message: 'Incomplete despite claimed complete traversal.'}];},
    value => {value.sample.observedAllocatedBytes = null;}, value => {value.sample.endMs = value.sample.startMs - 1;},
    value => {value.sample.entries = 100002;}, value => {value.sample.limitations = ['x'.repeat(513)];},
    value => {value.sample.method = 'caller-claimed-total';}, value => {value.sample.qualification = true;}];
  for (const mutate of mutations) {
    const fixture = offlineAdmission(); mutate(fixture.admission); resealAdmission(fixture);
    assert.throws(() => verifySessionEvidenceAdmission(fixture.options));
  }
});

function offlineFinal(sample = counter()) {
  const fixture = offlineAdmission();
  const value = {kind: 'windowserver-session-evidence-final-sample-1', allocationIdentity: clone(fixture.admission.allocation.identity),
    capacityBytes: fixture.admission.allocation.capacityBytes, sample: clone(sample), alarm: expectedAlarm(sample, fixture.admission.allocation.capacityBytes)};
  const options = {sampleBytes: null, expectedSample: null, allocationIdentity: clone(value.allocationIdentity), capacityBytes: value.capacityBytes};
  return resealFinal({value, options});
}
function resealFinal(fixture) {
  fixture.options.sampleBytes = encode(fixture.value); fixture.options.expectedSample = byteIdentity(fixture.options.sampleBytes); return fixture;
}

test('offline final samples recompute PASS, target, FAIL, and unknown alarms without qualification', () => {
  const cases = [
    {sample: counter(), status: 'PASS', level: 'normal', percent: 5},
    {sample: counter({observedAllocatedBytes: 1600000000}), status: 'PASS', level: 'target', percent: 80},
    {sample: counter({observedAllocatedBytes: 1800000000}), status: 'FAIL', level: 'ceiling', percent: 90},
    {sample: counter({completeTraversal: false, observedAllocatedBytes: null, observedLogicalBytes: null}), status: 'INCONCLUSIVE', level: 'unknown', percent: null},
  ];
  for (const {sample, status, level, percent} of cases) {
    const fixture = offlineFinal(sample), result = verifySessionEvidenceFinalSample(fixture.options);
    assert.equal(result.status, status);
    assert.equal(result.qualification, false);
    assert.deepEqual(result.alarm, {status, level, percent});
    assert.deepEqual(result.allocationIdentity, fixture.options.allocationIdentity);
    assert.deepEqual(result.sample, sample);
    assert.notStrictEqual(result.sample, fixture.value.sample);
  }
});

test('offline final sample binding rejects resealed capacity, identity, alarm, and schema substitutions', () => {
  const mutations = [value => {value.capacityBytes *= 2;}, value => {value.allocationIdentity.sha256 = 'b'.repeat(64);},
    value => {value.alarm.percent = 0;}, value => {value.alarm.status = 'FAIL';}, value => {value.alarm.level = 'target';},
    value => {value.sample.observedAllocatedBytes = 1800000000;}, value => {value.kind = 'other';}, value => {value.qualification = true;}];
  for (const mutate of mutations) {
    const fixture = offlineFinal(); mutate(fixture.value); resealFinal(fixture);
    assert.throws(() => verifySessionEvidenceFinalSample(fixture.options));
  }
  const external = offlineFinal(); external.options.allocationIdentity.sha256 = 'b'.repeat(64);
  assert.throws(() => verifySessionEvidenceFinalSample(external.options), /authority/);
  const changedBytes = offlineFinal(); changedBytes.options.sampleBytes = Buffer.concat([changedBytes.options.sampleBytes, Buffer.from(' ')]);
  assert.throws(() => verifySessionEvidenceFinalSample(changedBytes.options), /byte identity/);
});

test('offline final sample parser rejects duplicate keys and enforces the 64-KiB retained bound', () => {
  const duplicate = offlineFinal();
  duplicate.options.sampleBytes = Buffer.from('{"kind":"windowserver-session-evidence-final-sample-1",' + duplicate.options.sampleBytes.toString('utf8').trim().slice(1));
  duplicate.options.expectedSample = byteIdentity(duplicate.options.sampleBytes);
  assert.throws(() => verifySessionEvidenceFinalSample(duplicate.options), /Duplicate/);
  const oversized = offlineFinal(); oversized.options.sampleBytes = Buffer.alloc(64 * KiB + 1, 32);
  oversized.options.expectedSample = byteIdentity(oversized.options.sampleBytes);
  assert.throws(() => verifySessionEvidenceFinalSample(oversized.options));
});

test('live inspection rejects an allocation path whose parent is a symlink', {concurrency: false}, async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'windowserver-session-budget-alias-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const root = join(directory, 'evidence'), outputDirectory = join(root, 'session');
  const authorityDirectory = join(directory, 'authority'), aliasDirectory = join(directory, 'authority-alias');
  await mkdir(root, {mode: 0o700});
  await mkdir(outputDirectory, {mode: 0o700});
  await mkdir(authorityDirectory, {mode: 0o700});
  const authority = {kind: 'evidence-volume-allocation-1', allocationId: 'synthetic-parent-alias',
    purpose: 'qualification-evidence-only', capacityBytes: 10000000000000, root,
    issuedAt: '2026-09-30T11:00:00.000Z', owner: 'synthetic-owner'};
  const authorityBytes = encode(authority);
  await writeFile(join(authorityDirectory, 'allocation.json'), authorityBytes, {flag: 'wx', mode: 0o600});
  await symlink(authorityDirectory, aliasDirectory, 'dir');
  const path = join(aliasDirectory, 'allocation.json'), evidenceReservation = reservation();
  evidenceReservation.bytes = 1000000000000;
  const priorAllocation = process.env.IE_EVIDENCE_ALLOCATION;
  try {
    process.env.IE_EVIDENCE_ALLOCATION = path;
    await assert.rejects(() => inspectSessionEvidenceBudget({config: config(), evidenceAllocation: {path, ...byteIdentity(authorityBytes)},
      evidenceReservation, outputDirectory}), /canonical.*allocation|allocation.*canonical/i);
  } finally {
    if (priorAllocation === undefined) delete process.env.IE_EVIDENCE_ALLOCATION;
    else process.env.IE_EVIDENCE_ALLOCATION = priorAllocation;
  }
});
