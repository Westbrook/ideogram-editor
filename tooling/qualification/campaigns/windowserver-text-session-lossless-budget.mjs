import {createHash} from 'node:crypto';
import {lstat, realpath, statfs} from 'node:fs/promises';
import {isAbsolute, normalize} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {loadAllocation, sampleVolume, volumeAlarm, evidenceDestination} from '../evidence-volume.mjs';
import {windowServerTextSessionLosslessCapacity, validateWindowServerTextSessionLosslessConfig} from './windowserver-text-session-lossless.mjs';

const KiB = 1024, MiB = 1024 ** 2, MAX = Number.MAX_SAFE_INTEGER;
const AUTHORITY_LIMIT = 16 * MiB, ADMISSION_LIMIT = 128 * KiB, SAMPLE_LIMIT = 64 * KiB;
const PROFILE = 'interaction-text-106-247-60s-1';
const STORAGE_FORMAT = 'rfc1951-previous-roi-1';
const ALLOCATION_KEYS = ['kind', 'allocationId', 'purpose', 'capacityBytes', 'root', 'issuedAt', 'owner'];
const SHA = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const demand = (condition, message) => {if (!condition) throw Error(message);};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX;
const utc = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => structuredClone(value);
function exact(value, keys, label) {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.getOwnPropertySymbols(value).length === 0 &&
    Object.getOwnPropertyNames(value).sort().join(',') === [...keys].sort().join(',') &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(entry => Object.hasOwn(entry, 'value')), `Invalid exact ${label}`);
}
function absolute(value, label) {
  demand(typeof value === 'string' && value.length <= 32768 && isAbsolute(value) && normalize(value) === value && !value.endsWith('/') &&
    !/[\\\x00-\x1f\x7f]/.test(value), `Invalid absolute ${label}`); return value;
}
function identity(value, label, maximum = MAX) {
  exact(value, ['bytes', 'sha256'], label);
  demand(integer(value.bytes) && value.bytes > 0 && value.bytes <= maximum && typeof value.sha256 === 'string' && SHA.test(value.sha256), `Invalid ${label}`);
}
function allocationPin(value) {
  exact(value, ['path', 'bytes', 'sha256'], 'evidence allocation pin'); absolute(value.path, 'allocation path');
  identity({bytes: value.bytes, sha256: value.sha256}, 'evidence allocation identity', AUTHORITY_LIMIT); return copy(value);
}
function declaredAllocation(value) {
  exact(value, ALLOCATION_KEYS, 'allocation authority');
  demand(value.kind === 'evidence-volume-allocation-1' && value.purpose === 'qualification-evidence-only' &&
    typeof value.allocationId === 'string' && ID.test(value.allocationId) && typeof value.owner === 'string' && ID.test(value.owner) &&
    integer(value.capacityBytes) && value.capacityBytes > 0 && utc(value.issuedAt), 'Invalid allocation authority');
  absolute(value.root, 'allocation root'); return copy(value);
}
function rawConfig(value, nativeArtifactBytes) {
  exact(value, ['schemaVersion', 'profile', 'storageFormat', 'displayID', 'expectedBrowserPid', 'roi'], 'raw session config');
  demand(value.schemaVersion === 4 && value.profile === PROFILE && value.storageFormat === STORAGE_FORMAT && integer(value.displayID) && value.displayID > 0 && value.displayID <= 0xffffffff &&
    integer(value.expectedBrowserPid) && value.expectedBrowserPid > 0 && value.expectedBrowserPid <= 0x7fffffff, 'Invalid raw session identity');
  exact(value.roi, ['x', 'y', 'width', 'height'], 'raw session ROI');
  const config = copy(value), capacity = windowServerTextSessionLosslessCapacity(config.roi, nativeArtifactBytes); return {config, capacity};
}
function reservationInput(value) {
  exact(value, ['bytes', 'nativeArtifactBytes', 'trace', 'oracle', 'control'], 'session evidence reservation');
  demand(integer(value.bytes) && value.bytes > 0, 'Invalid total evidence reservation');
  demand(integer(value.nativeArtifactBytes) && value.nativeArtifactBytes > 0, 'Invalid selected native artifact allowance');
  for (const name of ['trace', 'oracle', 'control']) {
    exact(value[name], ['bytes', 'files', 'directories'], `${name} reservation`);
    demand(Object.values(value[name]).every(integer) && value[name].bytes > 0 && value[name].files > 0, `Invalid finite positive ${name} reservation`);
  }
  return copy(value);
}
function safe(value, label) {demand(value >= 0n && value <= BigInt(MAX), `${label} exceeds safe finite accounting`); return Number(value);}

/** Pure conservative reservation arithmetic; it creates no storage authority.
 * The selected nativeArtifactBytes covers only pixels.bin, frames.ndjson and
 * manifest.json. Its complete encoded-file cap comes from the frozen lossless
 * capacity helper; it never consumes the separate total reservation. The full
 * 9012-frame text profile remains fixed. The frozen helper budgets 106 actions,
 * 247 substeps and 560 clock records (494 dispatch, 2 anchors, 64 protocol margin).
 * Capacity is not proof of those actions, 496 actual ACKs, or physical input.
 * A minimum allowance permits an attempt,
 * not guaranteed completion at an assumed compression ratio; exhaustion fails.
 * Fixed files are rounded individually. An aggregate with unknown file sizes
 * reserves at most (blockBytes - 1) tail bytes for every intended file. Directory
 * blocks are an explicit estimate, not a guarantee about filesystem metadata,
 * copy-on-write, compression, snapshots, or future allocations by other writers.
 * Trace, oracle and control each require explicit positive byte/file bounds;
 * an all-zero declaration cannot stand in for an omitted full-session input.
 * The four private directories are supervisor, capture, build-evidence and
 * evidence-budget (counting the existing supervisor directory conservatively).
 */
export function deriveTextSessionLosslessReservation(options) {
  exact(options, ['config', 'evidenceReservation', 'filesystemBlockBytes', 'allocationSourceBytes'], 'reservation derivation options');
  const reservation = reservationInput(options.evidenceReservation), {capacity} = rawConfig(options.config, reservation.nativeArtifactBytes);
  demand(integer(options.filesystemBlockBytes) && options.filesystemBlockBytes > 0, 'Invalid filesystem allocation block bytes');
  demand(integer(options.allocationSourceBytes) && options.allocationSourceBytes > 0 && options.allocationSourceBytes <= AUTHORITY_LIMIT, 'Invalid bounded allocation source bytes');
  const block = BigInt(options.filesystemBlockBytes), rounded = bytes => (bytes + block - 1n) / block * block;
  function category(sizes, aggregates = [], directories = 0) {
    let logical = 0n, allocated = 0n, files = 0n;
    for (const entry of sizes) {const bytes = BigInt(entry.bytes), count = BigInt(entry.files ?? 1); logical += bytes * count; allocated += rounded(bytes) * count; files += count;}
    for (const entry of aggregates) {const bytes = BigInt(entry.bytes), count = BigInt(entry.files); logical += bytes; allocated += bytes + count * (block - 1n); files += count;}
    const directoryBytes = BigInt(directories) * block;
    return {logicalBytes: safe(logical, 'Category logical bytes'), files: safe(files, 'Category file count'), directories,
      roundingBytes: safe(allocated - logical, 'Category rounding bytes'), directoryBytes: safe(directoryBytes, 'Category directory bytes'),
      allocatedBytes: safe(allocated + directoryBytes, 'Category allocated bytes')};
  }
  const categories = {
    native: category([{bytes: capacity.maxEncodedPixelBytes}, {bytes: capacity.metadataByteLimit}, {bytes: capacity.manifestByteLimit}]),
    stdout: category([{bytes: capacity.metadataByteLimit + 65536}]),
    stderr: category([{bytes: MiB}]),
    // Config, process receipt, preparation admission, final admission, exact
    // authority bytes and final sample. Every writer must enforce these caps.
    supervisor: category([{bytes: 128 * KiB, files: 4}, {bytes: options.allocationSourceBytes}, {bytes: SAMPLE_LIMIT}], [], 4),
    // Nine files: manifest, original receipt, source, SDK manifest, two version
    // logs (combined 1 MiB), two build logs (combined 16 MiB), executable.
    build: category([{bytes: 128 * KiB, files: 2}, {bytes: 4 * MiB}, {bytes: 128 * MiB}, {bytes: 64 * MiB}],
      [{bytes: MiB, files: 2}, {bytes: 16 * MiB, files: 2}]),
  };
  for (const name of ['trace', 'oracle', 'control']) categories[name] = category([], [reservation[name]], reservation[name].directories);
  const sum = name => safe(Object.values(categories).reduce((value, entry) => value + BigInt(entry[name]), 0n), `Total ${name}`);
  const requiredReservationBytes = sum('allocatedBytes');
  return {capacity, categories, requiredReservationBytes, reservationBytes: reservation.bytes,
    reservationSufficient: reservation.bytes >= requiredReservationBytes, filesystemBlockBytes: options.filesystemBlockBytes,
    files: sum('files'), directories: sum('directories')};
}

function decode(bytes, maximum, label) {
  demand(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum, `Invalid bounded ${label}`);
  const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  // Reject duplicate JSON keys as well as malformed JSON; externally pinned
  // bytes must have one unambiguous meaning in the live and offline paths.
  const text = bytes.toString('utf8'), stack = [], tokens = /"(?:[^"\\]|\\.)*"|[{}\[\],:]|true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0], top = stack.at(-1);
    if (token === '{') stack.push({keys: new Set(), key: true});
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') {if (top) top.key = true;}
    else if (token === ':') {if (top) top.key = false;}
    else if (token.startsWith('"') && top?.key) {const key = JSON.parse(token); demand(!top.keys.has(key), `Duplicate ${label} key`); top.keys.add(key);}
  }
  return value;
}
function pinned(bytes, expected, maximum, label) {
  identity(expected, `${label} identity`, maximum);
  demand(Buffer.isBuffer(bytes) && bytes.length === expected.bytes && hash(bytes) === expected.sha256, `${label} differs from selected byte identity`);
  return decode(bytes, maximum, label);
}
function counterSample(value) {
  exact(value, ['kind', 'startedAt', 'finishedAt', 'startMs', 'endMs', 'method', 'consistency', 'completeTraversal', 'entries', 'concurrentChanges', 'uniqueFiles', 'repeatedInodes', 'observedLogicalBytes', 'observedAllocatedBytes', 'failures', 'limitations'], 'evidence counter sample');
  demand(value.kind === 'evidence-volume-sample-1' && utc(value.startedAt) && utc(value.finishedAt) && Date.parse(value.finishedAt) >= Date.parse(value.startedAt) &&
    number(value.startMs) && number(value.endMs) && value.endMs >= value.startMs && value.method === 'bounded-nofollow-streaming-lstat' &&
    value.consistency === 'non-atomic-observation-window' && typeof value.completeTraversal === 'boolean', 'Invalid evidence sample span or method');
  demand(['entries', 'concurrentChanges', 'uniqueFiles', 'repeatedInodes'].every(key => integer(value[key]) && value[key] <= 100001) &&
    ['observedLogicalBytes', 'observedAllocatedBytes'].every(key => value[key] === null || integer(value[key])), 'Invalid bounded evidence sample counts');
  demand(Array.isArray(value.failures) && value.failures.length <= 1 && Array.isArray(value.limitations) && value.limitations.length <= 8 &&
    value.limitations.every(entry => typeof entry === 'string' && entry.length <= 512), 'Invalid bounded evidence sample diagnostics');
  for (const failure of value.failures) {
    exact(failure, ['code', 'message'], 'sample failure');
    demand(typeof failure.code === 'string' && failure.code.length <= 128 && typeof failure.message === 'string' && failure.message.length <= 512, 'Invalid bounded sample failure');
  }
  demand(!value.completeTraversal || value.failures.length === 0 && value.observedAllocatedBytes !== null && value.observedLogicalBytes !== null, 'Contradictory complete evidence sample');
  return copy(value);
}
function directoryIdentity(value) {
  exact(value, ['dev', 'ino', 'uid', 'mode'], 'directory identity');
  demand(Object.values(value).every(entry => typeof entry === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(entry)) &&
    BigInt(value.dev) <= 18446744073709551615n && BigInt(value.ino) <= 18446744073709551615n && BigInt(value.uid) <= 0xffffffffn && BigInt(value.mode) <= 0o177777n &&
    (BigInt(value.mode) & 0o170000n) === 0o040000n && (BigInt(value.mode) & 0o077n) === 0n, 'Invalid private directory identity'); return copy(value);
}
const describeDirectory = stat => directoryIdentity({dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), mode: String(stat.mode)});
async function ownedDirectory(path) {
  const stat = await lstat(path, {bigint: true});
  demand(typeof process.getuid === 'function' && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid()) && await realpath(path) === path, 'Evidence directory must be canonical and privately owned');
  return describeDirectory(stat);
}
const LIMITATIONS = [
  'A fresh allocation sample is a non-atomic observation, not a storage reservation or filesystem quota.',
  'Logical file bounds, block rounding and directory allowances do not bound filesystem-wide metadata, snapshots or concurrent writers.',
  'The existing outer evidence monitor must remain active and its separately retained final audit must pass; this admission grants no qualification.',
];
function makeAdmission({config, pin, authority, allocationDirectoryIdentity, outputDirectory, outputIdentity, sample, filesystemBlockBytes, evidenceReservation}) {
  demand(allocationDirectoryIdentity.uid === outputIdentity.uid, 'Recorded output and allocation directory owners differ');
  const reservation = deriveTextSessionLosslessReservation({config, evidenceReservation, filesystemBlockBytes, allocationSourceBytes: pin.bytes});
  const alarm = volumeAlarm(sample, authority.capacityBytes);
  let status = 'PASS', reason = null;
  if (alarm.status === 'FAIL') {status = 'FAIL'; reason = 'actual-capacity-ceiling';}
  else if (alarm.status !== 'PASS') {status = 'INCONCLUSIVE'; reason = 'sample-incomplete';}
  else if (!reservation.reservationSufficient) {status = 'INCONCLUSIVE'; reason = 'reservation-insufficient';}
  // The unchanged outer counter visits at most 100000 entries. Conservatively
  // include every declared file/directory, including already-present private
  // directories: admit no workload whose maximum layout defeats that observer.
  else if (BigInt(sample.entries) + BigInt(reservation.files) + BigInt(reservation.directories) > 100000n) {status = 'INCONCLUSIVE'; reason = 'monitor-entry-bound';}
  else if ((BigInt(sample.observedAllocatedBytes) + BigInt(reservation.reservationBytes)) * 10n >= BigInt(authority.capacityBytes) * 9n) {status = 'INCONCLUSIVE'; reason = 'projected-capacity-ceiling';}
  const derived = status === 'PASS' ? validateWindowServerTextSessionLosslessConfig({...config, evidenceBudget: {
    capacityBytes: authority.capacityBytes, observedAllocatedBytes: sample.observedAllocatedBytes,
    reservationBytes: reservation.reservationBytes, nativeArtifactBytes: evidenceReservation.nativeArtifactBytes, allocationSha256: pin.sha256,
  }}) : null;
  return {kind: 'windowserver-text-session-evidence-admission-1', allocationPath: pin.path,
    allocation: {...authority, identity: {bytes: pin.bytes, sha256: pin.sha256}, directoryIdentity: copy(allocationDirectoryIdentity)},
    outputDirectory, directoryIdentity: copy(outputIdentity), sample: copy(sample), alarm, filesystemBlockBytes,
    capacity: reservation.capacity, evidenceReservation: copy(evidenceReservation), reservation, config: derived,
    status, reason, qualification: false, limitations: [...LIMITATIONS]};
}
function admitted(admission, allocationSourceBytes) {
  demand(Buffer.byteLength(JSON.stringify(admission, null, 2) + '\n') <= ADMISSION_LIMIT, 'Admission metadata exceeds retained bound');
  if (admission.status !== 'PASS') {
    const error = Error(`Native session evidence admission refused: ${admission.reason}`);
    error.sessionEvidenceAdmission = copy(admission); error.evidenceVolumeStatus = admission.status;
    error.allocationSourceBytes = Buffer.from(allocationSourceBytes); throw error;
  }
  return {status: 'admitted', admission: copy(admission), allocationSourceBytes: Buffer.from(allocationSourceBytes)};
}

/** Read-only live admission. Every observation comes from the managed allocation
 * APIs and real statfs; no caller snapshot or claimed capacity is accepted.
 * Traversal is finite (at most 100000 entries, depth 128), not a wall-time bound.
 * The caller creates this private output directory before inspecting and retains
 * returned bytes only after admission. Repeat immediately before native spawn.
 */
export async function inspectTextSessionLosslessEvidenceBudget(options) {
  exact(options, ['config', 'evidenceAllocation', 'evidenceReservation', 'outputDirectory'], 'session evidence inspection options');
  const evidenceReservation = reservationInput(options.evidenceReservation), {config} = rawConfig(options.config, evidenceReservation.nativeArtifactBytes), pin = allocationPin(options.evidenceAllocation);
  const outputDirectory = absolute(options.outputDirectory, 'session output directory');
  demand(process.env.IE_EVIDENCE_ALLOCATION === pin.path, 'Evidence allocation path differs from controller environment');
  demand(await realpath(pin.path) === pin.path, 'Evidence allocation authority path must be canonical');
  const allocation = await loadAllocation(pin.path);
  demand(isDeepStrictEqual(allocation.identity, {bytes: pin.bytes, sha256: pin.sha256}), 'Evidence allocation differs from selected byte identity');
  const allocationSourceBytes = Buffer.from(allocation.sourceBytes), authority = declaredAllocation(pinned(allocationSourceBytes, allocation.identity, AUTHORITY_LIMIT, 'allocation authority'));
  await evidenceDestination(authority.root, outputDirectory, {directory: true, mustExist: true});
  const allocationDirectoryIdentity = await ownedDirectory(authority.root), outputIdentity = await ownedDirectory(outputDirectory);
  demand(allocationDirectoryIdentity.dev === allocation.directoryIdentity.dev && allocationDirectoryIdentity.ino === allocation.directoryIdentity.ino, 'Allocated evidence root changed after load');
  const filesystem = await statfs(outputDirectory, {bigint: true});
  demand(typeof filesystem.bsize === 'bigint' && filesystem.bsize > 0n && filesystem.bsize <= BigInt(MAX), 'Filesystem allocation block size unavailable');
  const filesystemBlockBytes = Number(filesystem.bsize), sample = counterSample(await sampleVolume(allocation));
  await evidenceDestination(authority.root, outputDirectory, {directory: true, mustExist: true});
  demand(await realpath(pin.path) === pin.path, 'Evidence allocation authority path changed from its canonical location');
  demand(isDeepStrictEqual(await ownedDirectory(authority.root), allocationDirectoryIdentity) && isDeepStrictEqual(await ownedDirectory(outputDirectory), outputIdentity), 'Evidence directory identity changed during admission');
  const afterFilesystem = await statfs(outputDirectory, {bigint: true});
  demand(afterFilesystem.bsize === filesystem.bsize, 'Filesystem allocation block size changed during admission');
  return admitted(makeAdmission({config, pin, authority, allocationDirectoryIdentity, outputDirectory, outputIdentity, sample, filesystemBlockBytes, evidenceReservation}), allocationSourceBytes);
}

/** Replay externally pinned retained bytes without reading historical paths.
 * This validates the recorded observation and derivation; it does not fabricate
 * a new live sample or establish the authority of the caller's external pins.
 */
export function verifyTextSessionLosslessEvidenceAdmission(options) {
  exact(options, ['admissionBytes', 'allocationSourceBytes', 'expectedAdmission', 'evidenceAllocation', 'evidenceReservation', 'config', 'outputDirectory'], 'admission verification options');
  const evidenceReservation = reservationInput(options.evidenceReservation), {config} = rawConfig(options.config, evidenceReservation.nativeArtifactBytes), pin = allocationPin(options.evidenceAllocation);
  const outputDirectory = absolute(options.outputDirectory, 'session output directory');
  const authority = declaredAllocation(pinned(options.allocationSourceBytes, {bytes: pin.bytes, sha256: pin.sha256}, AUTHORITY_LIMIT, 'allocation authority'));
  const admission = pinned(options.admissionBytes, options.expectedAdmission, ADMISSION_LIMIT, 'session admission');
  exact(admission, ['kind', 'allocationPath', 'allocation', 'outputDirectory', 'directoryIdentity', 'sample', 'alarm', 'filesystemBlockBytes', 'capacity', 'evidenceReservation', 'reservation', 'config', 'status', 'reason', 'qualification', 'limitations'], 'retained session admission');
  exact(admission.allocation, [...ALLOCATION_KEYS, 'identity', 'directoryIdentity'], 'retained admission allocation');
  const expected = makeAdmission({config, pin, authority, allocationDirectoryIdentity: directoryIdentity(admission.allocation.directoryIdentity),
    outputDirectory, outputIdentity: directoryIdentity(admission.directoryIdentity), sample: counterSample(admission.sample), filesystemBlockBytes: admission.filesystemBlockBytes, evidenceReservation});
  // A relocated artifact still records its original strictly-contained output.
  demand(outputDirectory.startsWith(authority.root + '/'), 'Recorded output escapes its allocated root');
  demand(isDeepStrictEqual(admission, expected), 'Retained session admission cannot be reproduced from selected authority and reservation');
  return admitted(expected, options.allocationSourceBytes);
}

/** Final observation has no reservation projection: completed capture bytes are
 * already included in the sample. The caller supplies allocationIdentity and
 * capacityBytes obtained from the authenticated admission, not an arbitrary
 * larger capacity. Even a PASS here remains separate from the outer audit.
 */
export function verifyTextSessionLosslessEvidenceFinalSample(options) {
  exact(options, ['sampleBytes', 'expectedSample', 'allocationIdentity', 'capacityBytes'], 'final sample verification options');
  identity(options.allocationIdentity, 'selected allocation identity', AUTHORITY_LIMIT);
  demand(integer(options.capacityBytes) && options.capacityBytes > 0, 'Invalid selected allocation capacity');
  const value = pinned(options.sampleBytes, options.expectedSample, SAMPLE_LIMIT, 'final evidence sample');
  exact(value, ['kind', 'allocationIdentity', 'capacityBytes', 'sample', 'alarm'], 'final evidence sample envelope');
  demand(value.kind === 'windowserver-session-evidence-final-sample-1' && isDeepStrictEqual(value.allocationIdentity, options.allocationIdentity) && value.capacityBytes === options.capacityBytes, 'Final sample allocation authority differs');
  const sample = counterSample(value.sample), alarm = volumeAlarm(sample, options.capacityBytes);
  demand(isDeepStrictEqual(value.alarm, alarm), 'Final sample alarm cannot be reproduced');
  return {status: alarm.status, qualification: false, allocationIdentity: copy(options.allocationIdentity), capacityBytes: options.capacityBytes, sample, alarm};
}
