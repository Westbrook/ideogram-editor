// Pure admission for a reviewed new attempt in the retained local allocation.
// Caller owns authenticated reads, Docker observations, exclusivity and rechecks.
// This is neither a filesystem/engine probe nor evidence of runtime completion.
import {createHash} from 'node:crypto';
import {posix as path} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {containerImageLabelsMatch} from './local-image-labels.mjs';

export const RETAINED_RUN_ID = 'ie-linux-0c9ca8d9e4ad4072a11099707f76d6d0';
export const RETAINED_VOLUME = RETAINED_RUN_ID + '-capsule';
export const REQUIRED_ADMISSION_SOURCES = Object.freeze([
  'tooling/rollback-producer/local-control.mjs',
  'tooling/rollback-producer/local-accounting.mjs',
  'tooling/rollback-producer/local-retained-volume.mjs',
  'tooling/rollback-producer/local-volume-observer.py',
  'tooling/rollback-producer/local-toolchain-quiescence.mjs',
  'tooling/rollback-producer/local-cgroup-observer.py',
  'tooling/rollback-producer/local-image-labels.mjs',
  'tooling/qualification/container/bounded-child.mjs',
  'tooling/qualification/campaigns/host.mjs',
  'tooling/qualification/evidence-volume.mjs',
  'tooling/bootstrap-toolchain.py', 'tooling/toolchain.json',
  'tests/store/no-network.mjs',
]);
const GiB = 1024 ** 3;
const roles = ['image', 'retiredObserver', 'observer', 'init', 'build'];
const issued = new WeakSet();
const require = (ok, code) => {if (!ok) throw Error(code);};
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => typeof value === 'string' && value.length <= 4096 && value.startsWith('/') && !value.startsWith('//') && !/[\\\x00-\x1f\x7f]/.test(value) && path.normalize(value) === value && (value === '/' || !value.endsWith('/'));
const beneath = (root, name) => canonical(name) && name.startsWith(root + '/');
const ref = value => exact(value, ['path', 'bytes', 'sha256']) && canonical(value.path) && integer(value.bytes) && value.bytes <= 4 * 1024 ** 2 && digest(value.sha256);
const identity = value => exact(value, ['dev', 'ino']) && integer(value.dev) && integer(value.ino, 1);
const labels = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, entry]) => key.length > 0 && key.length <= 1024 && typeof entry === 'string' && entry.length <= 4096) && Buffer.byteLength(JSON.stringify(value)) <= 65536;
const rootFields = value => exact(value, ['dev', 'ino', 'uid', 'gid', 'mode']) && identity({dev: value.dev, ino: value.ino}) && integer(value.uid, 1) && integer(value.gid, 1) && value.mode === 0o700;
const frozen = value => {if (value && typeof value === 'object') {for (const child of Object.values(value)) frozen(child); Object.freeze(value);} return value;};
function json(bytes) {
  try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));}
  catch {throw Error('RETAINED_JSON_INVALID');}
}
function rootMatches(root, admission) {
  require(rootFields(root) && root.dev === admission.rootIdentity.dev && root.ino === admission.rootIdentity.ino && root.uid === admission.owner.uid && root.gid === admission.owner.gid, 'RETAINED_ROOT_CHANGED');
}

// All mounts must be supplied, not only the volume-filtered subset. The admission
// scanner permits only exact hash-bound control files. The producer's complete
// read-only source/directory closure is separately authenticated by its controller;
// this boundary grants no executable authority to those read-only mounts.
function mountsMatch(admission, mounts, producer) {
  require(Array.isArray(mounts) && mounts.length >= 1 && mounts.length <= 129, 'RETAINED_MOUNT_BOUND');
  const expected = {type: 'volume', source: admission.volumeName, destination: '/capsule', rw: producer, subpath: producer ? admission.volumeSubpath : ''};
  const volumes = mounts.filter(row => row?.type === 'volume');
  require(volumes.length === 1 && isDeepStrictEqual(volumes[0], expected), 'RETAINED_VOLUME_MOUNT');
  const destinations = new Set();
  for (const row of mounts) {
    require(exact(row, ['type', 'source', 'destination', 'rw', 'subpath']) && canonical(row.destination) && row.destination !== '/' && !destinations.has(row.destination), 'RETAINED_MOUNT_SHAPE');
    destinations.add(row.destination);
    if (row.type === 'volume') continue;
    require(row.type === 'bind' && row.rw === false && row.subpath === '' && canonical(row.source), 'RETAINED_CONTROL_BIND');
    if (!producer) require(beneath('/inputs', row.destination) && admission.sourceRefs.some(source => source.path === row.source), 'RETAINED_OBSERVER_BIND');
  }
  const sorted = [...destinations].sort();
  require(!sorted.some((name, i) => sorted.slice(i + 1).some(other => other.startsWith(name + '/'))), 'RETAINED_MOUNT_OVERLAP');
}

export function admitRetainedVolume({grantBytes, expectedGrantSha256, artifacts, observed}) {
  require(grantBytes instanceof Uint8Array && grantBytes.byteLength > 0 && grantBytes.byteLength <= 128 * 1024 && digest(expectedGrantSha256) && hash(grantBytes) === expectedGrantSha256, 'RETAINED_GRANT_IDENTITY');
  const grant = json(grantBytes);
  require(exact(grant, ['kind', 'attemptId', 'evidenceAllocation', 'dockerAllocation', 'prior', 'sourceRoot', 'sources', 'output', 'owner']) && grant.kind === 'local-retained-volume-admission-1' && /^attempt-[a-f0-9]{32}$/.test(grant.attemptId), 'RETAINED_GRANT_SHAPE');
  require(exact(grant.prior, ['receipt', 'finalization']) && [grant.evidenceAllocation, grant.dockerAllocation, grant.prior.receipt, grant.prior.finalization].every(ref), 'RETAINED_PRIOR_REFS');
  // This admission is for the original local501:20 volume, not a permission
  // migration. Root ownership or a differently owned replacement must refuse.
  require(exact(grant.owner, ['uid', 'gid']) && grant.owner.uid === 501 && grant.owner.gid === 20 && canonical(grant.sourceRoot), 'RETAINED_OWNER_SOURCE');
  require(Array.isArray(grant.sources) && grant.sources.length >= REQUIRED_ADMISSION_SOURCES.length && grant.sources.length <= 128 && grant.sources.every(row => ref(row) && beneath(grant.sourceRoot, row.path)), 'RETAINED_SOURCE_REFS');
  require(REQUIRED_ADMISSION_SOURCES.every(name => grant.sources.some(row => row.path === path.join(grant.sourceRoot, name))), 'RETAINED_SOURCE_CLOSURE');
  const refs = [grant.evidenceAllocation, grant.dockerAllocation, grant.prior.receipt, grant.prior.finalization, ...grant.sources];
  require(new Set(refs.map(row => row.path)).size === refs.length && artifacts instanceof Map && artifacts.size === refs.length, 'RETAINED_ARTIFACT_MEMBERSHIP');
  let total = 0;
  for (const row of refs) {
    const bytes = artifacts.get(row.path);
    require(bytes instanceof Uint8Array && bytes.byteLength === row.bytes && hash(bytes) === row.sha256, 'RETAINED_ARTIFACT_IDENTITY');
    total += bytes.byteLength; require(total <= 16 * 1024 ** 2, 'RETAINED_ARTIFACT_BOUND');
  }
  const read = row => json(artifacts.get(row.path));
  const allocation = read(grant.evidenceAllocation), docker = read(grant.dockerAllocation);
  require(exact(allocation, ['kind', 'allocationId', 'purpose', 'capacityBytes', 'root', 'issuedAt', 'owner']) && allocation.kind === 'evidence-volume-allocation-1' && allocation.allocationId === 'linux-source-01' && allocation.purpose === 'qualification-evidence-only' && allocation.capacityBytes === 4 * GiB && canonical(allocation.root), 'RETAINED_HOST_ALLOCATION');
  require(grant.evidenceAllocation.path === path.join(allocation.root, 'allocation.json') && grant.dockerAllocation.path === path.join(allocation.root, 'docker-allocation-03.json') && grant.output === path.join(allocation.root, grant.attemptId), 'RETAINED_OUTPUT_SCOPE');
  require(exact(docker, ['kind', 'allocationId', 'runId', 'context', 'issuedAt', 'owner', 'volume', 'engine']) && docker.kind === 'linux-docker-accounting-allocation-1' && docker.allocationId === 'linux-source-01-docker-03' && docker.runId === RETAINED_RUN_ID && docker.context === 'desktop-linux' && isDeepStrictEqual(docker.volume, {name: RETAINED_VOLUME, capacityBytes: 32 * GiB}) && isDeepStrictEqual(docker.engine, {containerWritableCapacityBytes: 4 * GiB, imageReportedCapacityBytes: 4 * GiB, meaning: 'per-object-engine-reported-nonexclusive-bytes'}), 'RETAINED_DOCKER_ALLOCATION');
  const priorRoot = path.join(allocation.root, 'run-02/bootstrap-continuation-02');
  require(grant.prior.receipt.path === path.join(priorRoot, 'receipt.json') && grant.prior.finalization.path === path.join(priorRoot, 'finalization.json'), 'RETAINED_FAILURE_PATH');
  const prior = read(grant.prior.receipt), final = read(grant.prior.finalization);
  require(prior.kind === 'linux-capsule-controller-phase-2' && prior.phase === 'bootstrap' && prior.result === 'failed' && prior.runId === RETAINED_RUN_ID && prior.runRoot === path.join(allocation.root, 'run-02') && prior.cleanupComplete === true && identity(prior.volumeIdentity), 'RETAINED_FAILED_BOOTSTRAP');
  require(isDeepStrictEqual(prior.allocation, {root: allocation.root, receipt: grant.evidenceAllocation}) && isDeepStrictEqual(prior.dockerAllocation, grant.dockerAllocation), 'RETAINED_PRIOR_ALLOCATION');
  require(final.kind === 'linux-capsule-controller-finalization-2' && final.result === 'failed' && final.dockerObservationStatus === 'FAIL' && final.timingLockReleased === true && final.qualification === false && final.hostAudit?.status === 'PASS' && final.hostVerification?.status === 'PASS' && isDeepStrictEqual(final.receipt, grant.prior.receipt), 'RETAINED_FAILURE_CLOSURE');
  require(exact(prior.containers, roles) && /^sha256:[a-f0-9]{64}$/.test(prior.imageId), 'RETAINED_PRIOR_CONTAINERS');
  const historical = roles.map(role => prior.containers[role]);
  require(historical.every(row => digest(row?.id) && typeof row.name === 'string' && row.name.startsWith(RETAINED_RUN_ID + '-') && row.stopped?.observed?.Running === false && row.stopped.observed.Restarting === false && row.stopped.observed.Paused === false) && new Set(historical.map(row => row.id)).size === historical.length, 'RETAINED_HISTORICAL_CLOSURE');
  require(exact(observed, ['volume', 'image', 'root', 'historicalContainers', 'attachments', 'attempt', 'admissionObserver']), 'RETAINED_OBSERVATION_SHAPE');
  require(isDeepStrictEqual(observed.volume, {name: RETAINED_VOLUME, driver: 'local', labels: {'org.ideogram.rollback-run': RETAINED_RUN_ID}, optionCount: 0}), 'RETAINED_VOLUME_IDENTITY');
  // The caller reads Config.Labels from this exact immutable image ID. The
  // requested labels retain them all; only the two explicit owner overrides
  // replace inherited values. The shared comparator permits only the observed
  // Desktop v2 metadata omission, never a missing owner or arbitrary label.
  require(exact(observed.image, ['id', 'labels']) && observed.image.id === prior.imageId && labels(observed.image.labels), 'RETAINED_IMAGE_LABELS');
  const admission = {kind: 'local-retained-volume-admission-1', grantSha256: expectedGrantSha256, attemptId: grant.attemptId, output: grant.output, volumeName: RETAINED_VOLUME, volumeSubpath: grant.attemptId, attemptPath: '/capsule/' + grant.attemptId, owner: grant.owner, rootIdentity: prior.volumeIdentity, evidenceCapacityBytes: 4 * GiB, volumeCapacityBytes: 32 * GiB, containerWritableCapacityBytes: 4 * GiB, imageReportedCapacityBytes: 4 * GiB, sourceRefs: grant.sources, priorReceipt: prior, priorFinalization: final, wholeVolumeRequest: {kind: 'capsule-volume-request-1', mode: 'sample', ownerUid: grant.owner.uid, ownerGid: grant.owner.gid, rootIdentity: prior.volumeIdentity, policyId: 'capsule-allocated-inodes-1'}, initialEmpty: false, resume: false, priorFailurePreserved: true, qualification: false};
  rootMatches(observed.root, admission);
  require(Array.isArray(observed.historicalContainers) && observed.historicalContainers.length === historical.length && new Set(observed.historicalContainers.map(row => row.id)).size === historical.length, 'RETAINED_CONTAINER_CENSUS');
  for (const row of observed.historicalContainers) require(exact(row, ['id', 'name', 'running', 'restarting', 'paused', 'dead']) && historical.some(old => old.id === row.id && old.name === row.name) && row.running === false && row.restarting === false && row.paused === false && row.dead === false, 'RETAINED_CONTAINER_NOT_CLOSED');
  const observer = observed.admissionObserver;
  require(exact(observer, ['id', 'name', 'image', 'user', 'labels', 'networkMode', 'pidMode', 'readonlyRootfs', 'capDrop', 'securityOpt', 'privileged', 'running', 'restarting', 'paused', 'dead', 'mounts']) && digest(observer.id) && !historical.some(row => row.id === observer.id) && observer.name === RETAINED_RUN_ID + '-' + grant.attemptId + '-observer' && observer.image === prior.imageId && observer.user === grant.owner.uid + ':' + grant.owner.gid && containerImageLabelsMatch(observer.labels, observed.image.labels, {'org.ideogram.rollback-run': RETAINED_RUN_ID, 'org.ideogram.rollback-attempt': grant.attemptId}) && observer.networkMode === 'none' && observer.pidMode === '' && observer.readonlyRootfs === true && isDeepStrictEqual(observer.capDrop, ['ALL']) && isDeepStrictEqual(observer.securityOpt, ['no-new-privileges']) && observer.privileged === false && observer.running === true && observer.restarting === false && observer.paused === false && observer.dead === false, 'RETAINED_ADMISSION_OBSERVER');
  mountsMatch(admission, observer.mounts, false);
  const attachments = [...historical.filter(row => row !== prior.containers.image).map(row => row.id), observer.id].sort();
  require(Array.isArray(observed.attachments) && isDeepStrictEqual([...observed.attachments].sort(), attachments), 'RETAINED_ATTACHMENT_CENSUS');
  require(isDeepStrictEqual(observed.attempt, {path: admission.attemptPath, absence: 'ENOENT', parentIdentity: prior.volumeIdentity}), 'RETAINED_ATTEMPT_NOT_FRESH');
  admission.admissionObserverId = observer.id;
  admission.imageLabels = structuredClone(observed.image.labels);
  issued.add(admission);
  return frozen(admission);
}

// Call only with the successful admission above and a NEW actual observation
// after the fixed exclusive mkdir/chown initializer. Root identity is unchanged;
// its timestamps may honestly change when the new leaf is created.
export function validateCreatedAttempt(admission, observed) {
  require(issued.has(admission) && exact(observed, ['root', 'attempt']), 'RETAINED_CREATED_SHAPE');
  rootMatches(observed.root, admission);
  const leaf = observed.attempt;
  require(exact(leaf, ['path', 'dev', 'ino', 'uid', 'gid', 'mode', 'empty']) && leaf.path === admission.attemptPath && rootFields({dev: leaf.dev, ino: leaf.ino, uid: leaf.uid, gid: leaf.gid, mode: leaf.mode}) && leaf.dev === admission.rootIdentity.dev && leaf.ino !== admission.rootIdentity.ino && leaf.uid === admission.owner.uid && leaf.gid === admission.owner.gid && leaf.empty === true, 'RETAINED_CREATED_IDENTITY');
  return frozen({path: leaf.path, dev: leaf.dev, ino: leaf.ino, uid: leaf.uid, gid: leaf.gid, mode: leaf.mode});
}

export function validateRetainedVolumeMounts(admission, {observer, producer}) {
  require(issued.has(admission), 'RETAINED_ADMISSION_REQUIRED');
  mountsMatch(admission, observer, false);
  mountsMatch(admission, producer, true);
  return true;
}
