import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {admitRetainedVolume, validateCreatedAttempt, validateRetainedVolumeMounts, RETAINED_RUN_ID, RETAINED_VOLUME, REQUIRED_ADMISSION_SOURCES} from '../../tooling/rollback-producer/local-retained-volume.mjs';

// Synthetic reviewed-grant models only. These tests do not probe Docker, grant
// a real attempt, read retained private receipts, or issue qualification credit.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const clone = value => structuredClone(value);
function fixture() {
  const root = '/repo/artifacts/evidence-linux-source-01', attemptId = 'attempt-' + 'b'.repeat(32), owner = {uid: 501, gid: 20};
  const artifacts = new Map();
  const put = (path, body) => {const raw = bytes(body); artifacts.set(path, raw); return {path, bytes: raw.length, sha256: sha(raw)};};
  const evidenceAllocation = put(root + '/allocation.json', {kind: 'evidence-volume-allocation-1', allocationId: 'linux-source-01', purpose: 'qualification-evidence-only', capacityBytes: 4 * 1024 ** 3, root, issuedAt: '2026-10-03T15:51:42.571Z', owner: 'Build-root-agent'});
  const dockerAllocation = put(root + '/docker-allocation-03.json', {kind: 'linux-docker-accounting-allocation-1', allocationId: 'linux-source-01-docker-03', runId: RETAINED_RUN_ID, context: 'desktop-linux', issuedAt: '2026-10-03T16:02:38.120Z', owner: 'Build-root-agent', volume: {name: RETAINED_VOLUME, capacityBytes: 32 * 1024 ** 3}, engine: {containerWritableCapacityBytes: 4 * 1024 ** 3, imageReportedCapacityBytes: 4 * 1024 ** 3, meaning: 'per-object-engine-reported-nonexclusive-bytes'}});
  const containers = Object.fromEntries(['image', 'retiredObserver', 'observer', 'init', 'build'].map((role, i) => [role, {id: String(i + 1).repeat(64), name: RETAINED_RUN_ID + '-' + role, stopped: {observed: {Running: false, Restarting: false, Paused: false}}}]));
  const prior = {kind: 'linux-capsule-controller-phase-2', phase: 'bootstrap', result: 'failed', runId: RETAINED_RUN_ID, runRoot: root + '/run-02', allocation: {root, receipt: evidenceAllocation}, dockerAllocation, cleanupComplete: true, volumeIdentity: {dev: 65025, ino: 1180799}, containers, imageId: 'sha256:' + 'a'.repeat(64)};
  const receipt = put(root + '/run-02/bootstrap-continuation-02/receipt.json', prior);
  const final = {kind: 'linux-capsule-controller-finalization-2', result: 'failed', receipt, dockerObservationStatus: 'FAIL', timingLockReleased: true, qualification: false, hostAudit: {status: 'PASS'}, hostVerification: {status: 'PASS'}};
  const finalization = put(root + '/run-02/bootstrap-continuation-02/finalization.json', final);
  const sources = REQUIRED_ADMISSION_SOURCES.map(name => put('/repo/' + name, {synthetic: name}));
  const grant = {kind: 'local-retained-volume-admission-1', attemptId, evidenceAllocation, dockerAllocation, prior: {receipt, finalization}, sourceRoot: '/repo', sources, output: root + '/' + attemptId, owner};
  const observedRoot = {...prior.volumeIdentity, ...owner, mode: 0o700};
  const volumeMount = {type: 'volume', source: RETAINED_VOLUME, destination: '/capsule', rw: false, subpath: ''};
  const imageLabels = {'org.opencontainers.image.version': '24.04', 'org.ideogram.rollback-run': RETAINED_RUN_ID};
  const observer = {id: 'f'.repeat(64), name: RETAINED_RUN_ID + '-' + attemptId + '-observer', image: prior.imageId, user: '501:20', labels: {...imageLabels, 'org.ideogram.rollback-run': RETAINED_RUN_ID, 'org.ideogram.rollback-attempt': attemptId}, networkMode: 'none', pidMode: '', readonlyRootfs: true, capDrop: ['ALL'], securityOpt: ['no-new-privileges'], privileged: false, running: true, restarting: false, paused: false, dead: false, mounts: [volumeMount, {type: 'bind', source: sources[3].path, destination: '/inputs/volume-observer.py', rw: false, subpath: ''}]};
  const observed = {volume: {name: RETAINED_VOLUME, driver: 'local', labels: {'org.ideogram.rollback-run': RETAINED_RUN_ID}, optionCount: 0}, image: {id: prior.imageId, labels: imageLabels}, root: observedRoot, historicalContainers: Object.values(containers).map(row => ({id: row.id, name: row.name, running: false, restarting: false, paused: false, dead: false})), attachments: [...Object.entries(containers).filter(([role]) => role !== 'image').map(([, row]) => row.id), observer.id], attempt: {path: '/capsule/' + attemptId, absence: 'ENOENT', parentIdentity: clone(prior.volumeIdentity)}, admissionObserver: observer};
  const call = () => {const grantBytes = bytes(grant); return admitRetainedVolume({grantBytes, expectedGrantSha256: sha(grantBytes), artifacts, observed});};
  const changeArtifact = (ref, change) => {const body = JSON.parse(artifacts.get(ref.path)); change(body); const updated = put(ref.path, body); Object.assign(ref, updated);};
  const changePrior = change => {
    changeArtifact(grant.prior.receipt, change);
    changeArtifact(grant.prior.finalization, body => {body.receipt = grant.prior.receipt;});
  };
  return {root, grant, artifacts, observed, call, changeArtifact, changePrior};
}
function created(f, admission) {return {root: clone(f.observed.root), attempt: {path: admission.attemptPath, dev: admission.rootIdentity.dev, ino: 1180900, uid: 501, gid: 20, mode: 0o700, empty: true}};}
function mounts(f, admission) {return {observer: clone(f.observed.admissionObserver.mounts), producer: [{type: 'volume', source: RETAINED_VOLUME, destination: '/capsule', rw: true, subpath: admission.volumeSubpath}, {type: 'bind', source: '/repo/retained-sources', destination: '/inputs/producers', rw: false, subpath: ''}]};}

test('same-allocation admission preserves failed provenance and scans the whole retained root', () => {
  const f = fixture(), before = bytes(f.grant), admitted = f.call();
  assert.equal(admitted.resume, false); assert.equal(admitted.initialEmpty, false); assert.equal(admitted.qualification, false);
  assert.equal(admitted.priorReceipt.result, 'failed'); assert.equal(admitted.priorFinalization.result, 'failed');
  assert.equal(admitted.wholeVolumeRequest.mode, 'sample'); assert.deepEqual(admitted.wholeVolumeRequest.rootIdentity, {dev: 65025, ino: 1180799});
  assert.equal(admitted.volumeCapacityBytes, 32 * 1024 ** 3); assert.equal(admitted.evidenceCapacityBytes, 4 * 1024 ** 3);
  assert.equal(admitted.attemptPath, '/capsule/' + f.grant.attemptId); assert.deepEqual(bytes(f.grant), before);
  assert.ok(Object.isFrozen(admitted.sourceRefs)); assert.ok(Object.isFrozen(admitted.priorReceipt));
});
test('external grant identity and every current source byte must match before admission', () => {
  const f = fixture(), grantBytes = bytes(f.grant);
  assert.throws(() => admitRetainedVolume({grantBytes, expectedGrantSha256: '0'.repeat(64), artifacts: f.artifacts, observed: f.observed}), /GRANT_IDENTITY/);
  f.artifacts.set(f.grant.sources[0].path, Buffer.from('changed'));
  assert.throws(f.call, /ARTIFACT_IDENTITY/);
});
test('missing, extra and duplicate source artifacts or omitted required owners refuse', () => {
  for (const change of [f => f.artifacts.delete(f.grant.sources[0].path), f => f.artifacts.set('/repo/extra', Buffer.from('extra')), f => {f.grant.sources.push(f.grant.sources[0]);}, f => {f.artifacts.delete(f.grant.sources.at(-1).path); f.grant.sources.pop();}]) {
    const f = fixture(); change(f); assert.throws(f.call);
  }
  for (const name of ['local-toolchain-quiescence.mjs', 'local-cgroup-observer.py', 'local-image-labels.mjs']) {
    const f = fixture(), omitted = f.grant.sources.find(row => row.path.endsWith('/' + name));
    f.artifacts.delete(omitted.path); f.grant.sources = f.grant.sources.filter(row => row !== omitted);
    // An unrelated file cannot supply the missing mechanism's mandatory seal.
    const raw = Buffer.from('unrelated'), substitute = {path: '/repo/unrelated.mjs', bytes: raw.length, sha256: sha(raw)};
    f.artifacts.set(substitute.path, raw); f.grant.sources.push(substitute);
    assert.throws(f.call, /SOURCE_CLOSURE/);
  }
});
test('changed allocation, volume, capacity or original owner cannot be relabelled as a fresh attempt', () => {
  for (const change of [f => {f.grant.owner.uid = 0;}, f => {f.grant.owner.uid = 10001;}, f => f.changeArtifact(f.grant.evidenceAllocation, row => {row.capacityBytes *= 2;}), f => f.changeArtifact(f.grant.dockerAllocation, row => {row.volume.name += '-new';}), f => f.changeArtifact(f.grant.dockerAllocation, row => {row.engine.imageReportedCapacityBytes *= 2;})]) {
    const f = fixture(); change(f); assert.throws(f.call);
  }
});
test('failed bootstrap is provenance, never a successful resume or a substitute for closed custody', () => {
  for (const change of [f => f.changePrior(row => {row.result = 'passed';}), f => f.changePrior(row => {row.cleanupComplete = false;}), f => f.changeArtifact(f.grant.prior.finalization, row => {row.timingLockReleased = false;}), f => f.changeArtifact(f.grant.prior.finalization, row => {row.result = 'passed';}), f => f.changeArtifact(f.grant.prior.finalization, row => {row.receipt.sha256 = '0'.repeat(64);})]) {
    const f = fixture(); change(f); assert.throws(f.call);
  }
});
test('volume root identity, labels, modes and fresh-leaf absence are actual required observations', () => {
  for (const change of [f => {f.observed.root.ino++;}, f => {f.observed.root.mode = 0o755;}, f => {f.observed.volume.optionCount = 1;}, f => {f.observed.volume.labels['org.ideogram.rollback-run'] = 'other';}, f => {f.observed.attempt.absence = 'EACCES';}, f => {f.observed.attempt.parentIdentity.ino++;}, f => {f.observed.attempt.path = '/capsule/toolchain';}]) {
    const f = fixture(); change(f); assert.throws(f.call);
  }
});
test('new attempts cannot target historical host output, tainted paths or traversal aliases', () => {
  for (const change of [f => {f.grant.output = f.root + '/run-02/bootstrap-continuation-02';}, f => {f.grant.output += '/..';}, f => {f.grant.attemptId = '../toolchain';}, f => {f.grant.attemptId = 'toolchain';}, f => {f.grant.sourceRoot = '/repo/../repo';}]) {
    const f = fixture(); change(f); assert.throws(f.call);
  }
});
test('every original container and exact volume attachment must remain accounted and stopped', () => {
  for (const change of [f => {f.observed.historicalContainers[0].running = true;}, f => {f.observed.historicalContainers[1].paused = true;}, f => {f.observed.historicalContainers.pop();}, f => {f.observed.attachments.pop();}, f => {f.observed.attachments.push('e'.repeat(64));}, f => {f.observed.historicalContainers[0].id = f.observed.historicalContainers[1].id;}]) {
    const f = fixture(); change(f); assert.throws(f.call);
  }
});
test('admission observer must be independent, exact and read-only with known source binds', () => {
  for (const change of [o => {o.id = '1'.repeat(64);}, o => {o.networkMode = 'bridge';}, o => {o.pidMode = 'host';}, o => {o.privileged = true;}, o => {o.capDrop = [];}, o => {o.mounts[0].rw = true;}, o => {o.mounts[0].subpath = 'toolchain';}, o => {o.mounts[1].source = '/private/unreviewed.py';}, o => {o.mounts.push({type: 'bind', source: '/repo/tooling/bootstrap-toolchain.py', destination: '/inputs', rw: false, subpath: ''});}]) {
    const f = fixture(); change(f.observed.admissionObserver); assert.throws(f.call);
  }
});
test('immutable image labels are inherited exactly without hiding extra or changed observer labels', () => {
  const f = fixture();
  assert.equal(f.call().imageLabels['org.opencontainers.image.version'], '24.04');
  f.observed.image.labels['org.example.retained'] = 'exact'; f.observed.admissionObserver.labels['org.example.retained'] = 'exact';
  assert.equal(f.call().imageLabels['org.example.retained'], 'exact');
  for (const change of [o => {o.image.id = 'sha256:' + '0'.repeat(64);}, o => {o.image.labels = null;}, o => {o.image.labels.extra = 42;}, o => {delete o.admissionObserver.labels['org.opencontainers.image.version'];}, o => {o.admissionObserver.labels.extra = 'unissued';}, o => {o.admissionObserver.labels['org.opencontainers.image.version'] = 'wrong';}, o => {o.admissionObserver.labels['org.ideogram.rollback-attempt'] = 'other';}]) {
    const value = fixture(); change(value.observed); assert.throws(value.call);
  }
});
test('exclusive creation requires a new private empty inode on the original volume', () => {
  const f = fixture(), admission = f.call();
  const result = validateCreatedAttempt(admission, created(f, admission)); assert.equal(result.ino, 1180900); assert.ok(Object.isFrozen(result));
  for (const change of [o => {o.attempt.empty = false;}, o => {o.attempt.ino = o.root.ino;}, o => {o.attempt.dev++;}, o => {o.attempt.uid = 0;}, o => {o.attempt.mode = 0o755;}, o => {o.attempt.path = '/capsule/toolchain';}, o => {o.root.ino++;}]) {
    const observed = created(f, admission); change(observed); assert.throws(() => validateCreatedAttempt(admission, observed));
  }
});
test('producer gets only the fresh volume subpath and observer retains the full volume', () => {
  const f = fixture(), admission = f.call(); assert.equal(validateRetainedVolumeMounts(admission, mounts(f, admission)), true);
  for (const change of [m => {m.producer[0].subpath = '';}, m => {m.producer[0].subpath = 'toolchain';}, m => {m.producer[0].source += '-replacement';}, m => {m.producer[1].rw = true;}, m => {m.observer[0].subpath = admission.volumeSubpath;}, m => {m.producer.push({...m.producer[0], destination: '/other'});}, m => {m.producer.push({type: 'tmpfs', source: '', destination: '/tmp', rw: true, subpath: ''});}, m => {m.producer.push({type: 'bind', source: '/repo/archive', destination: '/capsule/toolchain', rw: false, subpath: ''});}, m => {m.producer[1].destination = '/';}]) {
    const value = mounts(f, admission); change(value); assert.throws(() => validateRetainedVolumeMounts(admission, value));
  }
});
test('serialized or hand-frozen admissions do not grant post-creation or mount validation', () => {
  const f = fixture(), admission = f.call(), forged = Object.freeze(clone(admission));
  assert.throws(() => validateCreatedAttempt(forged, created(f, admission)), /CREATED_SHAPE/);
  assert.throws(() => validateRetainedVolumeMounts(forged, mounts(f, admission)), /ADMISSION_REQUIRED/);
});

test('declared Desktop v2 metadata may be omitted or retained without losing the full image label record', () => {
  for (const present of [false, true]) {
    const f = fixture();
    f.observed.image.labels['desktop.docker.io/ports.scheme'] = 'v2';
    if (present) f.observed.admissionObserver.labels['desktop.docker.io/ports.scheme'] = 'v2';
    const before = clone(f.observed), admission = f.call();
    assert.equal(admission.imageLabels['desktop.docker.io/ports.scheme'], 'v2');
    assert.equal(admission.imageLabels['org.opencontainers.image.version'], '24.04');
    assert.ok(Object.isFrozen(admission.imageLabels));
    assert.deepEqual(f.observed, before);
  }
});
test('Desktop omission admits no wrong value, undeclared metadata, missing owner or other label drift', () => {
  const key = 'desktop.docker.io/ports.scheme';
  for (const change of [
    o => {o.image.labels[key] = 'v3';},
    o => {o.admissionObserver.labels[key] = 'v3';},
    o => {delete o.image.labels[key]; o.admissionObserver.labels[key] = 'v2';},
    o => {delete o.admissionObserver.labels['org.ideogram.rollback-run'];},
    o => {delete o.admissionObserver.labels['org.ideogram.rollback-attempt'];},
    o => {delete o.admissionObserver.labels['org.opencontainers.image.version'];},
    o => {o.admissionObserver.labels['org.opencontainers.image.version'] = 'wrong';},
    o => {o.admissionObserver.labels['desktop.docker.io/unknown'] = 'v2';},
    o => {o.image.labels['org.example.required'] = 'retained';},
  ]) {
    const f = fixture(); f.observed.image.labels[key] = 'v2'; change(f.observed);
    assert.throws(f.call);
  }
});
