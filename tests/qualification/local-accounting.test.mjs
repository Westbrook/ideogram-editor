import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {validateDockerAllocation, containerSize, imageSize, coverage, createAccounting, workerCanonical, volumeSize} from '../../tooling/rollback-producer/local-accounting.mjs';
const runId = 'ie-linux-' + 'a'.repeat(32), volume = runId + '-capsule', id = 'b'.repeat(64), image = 'sha256:' + 'c'.repeat(64);
const allocation = () => ({kind: 'linux-docker-accounting-allocation-1', allocationId: 'test-only', runId, context: 'desktop-linux', issuedAt: '2026-10-01T00:00:00.000Z', owner: 'pure-fixture', volume: {name: volume, capacityBytes: 100000}, engine: {containerWritableCapacityBytes: 10000, imageReportedCapacityBytes: 100000, meaning: 'per-object-engine-reported-nonexclusive-bytes'}});
const row = (startedMs, boundary, extra = {}) => ({startedMs, endedMs: startedMs + 100, boundary, bytes: 1, error: null, ...extra});
test('allocation requires three explicit independent capacities with exact owned names', () => {
  assert.equal(validateDockerAllocation(allocation(), {runId, volume}).engine.imageReportedCapacityBytes, 100000);
  for (const alter of [x => { x.volume.capacityBytes = null; }, x => { x.engine.containerWritableCapacityBytes = 0; }, x => { x.engine.meaning = 'exclusive physical allocation'; }, x => { x.volume.name = 'user-data'; }, x => { x.context = 'remote'; }, x => { x.unrecognized = true; }]) {
    const value = allocation(); alter(value); assert.throws(() => validateDockerAllocation(value, {runId, volume}));
  }
});
test('engine observations authenticate full CID, exact run name/label and selected image', () => {
  const expected = {id, name: runId + '-build', runId, image}, value = {Id: id, Name: '/' + expected.name, Run: runId, Image: image, SizeRw: 200, SizeRootFs: 1000};
  assert.deepEqual(containerSize(value, expected), {writableBytes: 200, rootFilesystemBytes: 1000, physicalExclusiveBytes: null});
  for (const change of [{Id: 'd'.repeat(64)}, {Name: '/unrelated-database'}, {Run: 'another'}, {Image: 'sha256:' + 'e'.repeat(64)}, {SizeRw: null}, {SizeRootFs: -1}, {SizeRw: 1001}, {SizeRw: Number.MAX_SAFE_INTEGER + 1}]) assert.throws(() => containerSize({...value, ...change}, expected));
});
test('image Size retains shared-base semantics and never becomes exclusive allocation', () => {
  const value = {Id: image, Os: 'linux', Architecture: 'arm64', Size: 1234};
  assert.deepEqual(imageSize(value, image), {reportedBytes: 1234, physicalExclusiveBytes: null, includesSharedBase: true});
  for (const change of [{Size: null}, {Id: 'sha256:' + 'e'.repeat(64)}, {Architecture: 'amd64'}, {Os: 'darwin'}]) assert.throws(() => imageSize({...value, ...change}, image));
});
test('coverage requires actual initial and final observations, not two nominal ticks', () => {
  assert.equal(coverage([row(0, 'initial'), row(2000, 'final')], 100).status, 'PASS');
  for (const rows of [[], [row(0, 'initial')], [row(0, 'periodic'), row(2000, 'final')], [row(0, 'initial'), row(2000, 'periodic')], [row(0, 'initial'), row(4001, 'final')]]) assert.equal(coverage(rows, 100).status, 'INCONCLUSIVE');
});
test('bounded remote-call intervals prevent false coverage across unrelated clock epochs', () => {
  const result = coverage([row(0, 'initial'), row(3900, 'final', {endedMs: 4100})], 100);
  assert.equal(result.maximumStartGapMs, 3900); assert.equal(result.maximumPossibleObservationStartGapMs, 4100); assert.equal(result.status, 'INCONCLUSIVE');
});
test('later success does not erase unknown observation or exceeded allocation ceiling', () => {
  assert.equal(coverage([row(0, 'initial'), row(1000, 'periodic', {error: {message: 'unavailable'}, bytes: null}), row(2000, 'final')], 100).status, 'INCONCLUSIVE');
  assert.equal(coverage([row(0, 'initial', {bytes: 90}), row(2000, 'final')], 100).status, 'FAIL');
  assert.throws(() => coverage([row(2000, 'initial'), row(1000, 'final')], 100));
});
function fixture(observe = async () => ({bytes: 1}), retain = async () => {}) {
  let now = 0; const failures = [], records = [], scheduled = [];
  const monitor = createAccounting({observe, retain: async row => { records.push(row); await retain(row); }, onFailure: e => failures.push(e), clock: () => now, schedule: callback => { const token = {callback, unref() {}}; scheduled.push(token); return token; }, cancel: token => { token.cancelled = true; }});
  return {monitor, failures, records, scheduled, time: n => { now = n; }};
}
test('observer failures are retained then latched even if the final observation succeeds', async () => {
  let n = 0; const f = fixture(async () => { if (++n === 2) throw Error('Docker unavailable'); return {bytes: 1}; });
  await f.monitor.add({key: 'owned', capacityBytes: 100}); f.time(1000); await f.monitor.checkpoint('owned'); f.time(2000);
  const result = await f.monitor.finish(); assert.equal(result.status, 'FAIL'); assert.equal(f.records[1].error.message, 'Docker unavailable'); assert.equal(f.records[2].error, null); assert.equal(f.failures.length, 1);
});
test('gap failure abort callback fires before a later phase could continue', async () => {
  const f = fixture(); await f.monitor.add({key: 'owned', capacityBytes: 100}); f.time(4001); await f.monitor.checkpoint('owned');
  assert.match(f.failures[0].message, /coverage unavailable/); f.time(4500); assert.equal((await f.monitor.finish()).status, 'FAIL');
});
test('journal failure stays unsuccessful and finalization still drains queued observations', async () => {
  let n = 0; const f = fixture(undefined, async () => { if (++n === 2) throw Error('journal full'); });
  await f.monitor.add({key: 'owned', capacityBytes: 100}); f.time(1000); await assert.rejects(f.monitor.checkpoint('owned'), /journal full/); f.time(2000);
  assert.equal((await f.monitor.finish()).status, 'FAIL'); assert.equal(f.records.at(-1).boundary, 'final');
});
test('a target added during a periodic await receives its initial sample first', async () => {
  let release, signalEntered; const entered = new Promise(resolve => { signalEntered = resolve; });
  let calls = 0;
  const f = fixture(async target => { if (target.key === 'first' && ++calls === 2) { signalEntered(); await new Promise(resolve => { release = resolve; }); } return {bytes: 1}; });
  await f.monitor.add({key: 'first', capacityBytes: 100}); f.time(1000); f.scheduled[0].callback(); await entered;
  const adding = f.monitor.add({key: 'new', capacityBytes: 100}); release(); await adding; f.time(2000); await f.monitor.finish();
  assert.deepEqual(f.records.filter(row => row.key === 'new').map(row => row.boundary), ['initial', 'final']);
});
test('volume retirement happens once before sidecar drain; engine final sample remains later', async () => {
  const calls = [], f = fixture(async target => { calls.push(target.key); return {bytes: 1}; });
  await f.monitor.add({key: 'volume', capacityBytes: 100}); await f.monitor.add({key: 'engine', capacityBytes: 100});
  f.time(1000); await f.monitor.retire('volume'); calls.push('sidecar-drained'); f.time(2000); const result = await f.monitor.finish();
  assert.deepEqual(calls, ['volume', 'engine', 'volume', 'sidecar-drained', 'engine']); assert.equal(result.status, 'PASS'); assert.equal(result.qualification, false); assert.equal(result.exclusivePhysicalTotalBytes, null); assert.equal(result.physicalDockerUsageStatus, 'UNOBSERVABLE');
  await assert.rejects(f.monitor.checkpoint('volume')); await assert.rejects(f.monitor.finish());
});
const digest = value => 'sha256:' + createHash('sha256').update(workerCanonical(value)).digest('hex');
function volumeFixture() {
  const request = {kind: 'capsule-volume-request-1', mode: 'sample', ownerUid: 501, ownerGid: 20, rootIdentity: {dev: 1, ino: 2}, policyId: 'capsule-allocated-inodes-1'};
  const root = {dev: 1, ino: 2, mode: 16832, uid: 501, gid: 20, nlink: 2, size: 4096, blocks: 8, mtimeNs: '0', ctimeNs: '0'};
  const attempt = {sequence: 0, previous: null, startMonotonicUs: 50, endMonotonicUs: 100, startWallUs: 1000, endWallUs: 1050, rootBefore: root, rootAfter: {...root}, status: 'complete', drained: true, counts: {entries: 1, uniqueInodes: 1, directories: 1, regularFiles: 0, symlinks: 0, allocatedBytes: 4096, regularLogicalBytes: 0, symlinkAllocatedBytes: 0}, errors: []}; attempt.hash = digest(attempt);
  return {request, value: {kind: 'capsule-volume-observation-1', request, requestHash: digest(request), policyId: request.policyId, bounds: {maxEntries: 1000000, maxDepth: 128, maxAttempts: 3, maxWindowUs: 1000000}, windowStartMonotonicUs: 0, windowEndMonotonicUs: 200, attempts: [attempt], selectedAttempt: 0, status: 'complete', drained: true}};
}
test('actual worker request and hashed attempt bind volume identity and allocated bytes', () => {
  const {request, value} = volumeFixture(); assert.equal(volumeSize(value, request).bytes, 4096);
  for (const alter of [x => { x.requestHash = 'sha256:' + '0'.repeat(64); }, x => { x.attempts[0].counts.allocatedBytes++; }, x => { x.drained = false; }, x => { x.selectedAttempt = null; }, x => { x.windowEndMonotonicUs = 1000001; }, x => { x.bounds.maxEntries++; }]) { const changed = structuredClone(value); alter(changed); assert.throws(() => volumeSize(changed, request)); }
  assert.throws(() => volumeSize(value, {...request, rootIdentity: {dev: 1, ino: 3}}));
});
test('nonmutation retry cannot be converted into an accepted later scan', () => {
  const {request, value} = volumeFixture(), first = {...value.attempts[0], status: 'unknown', counts: null, errors: [{code: 'ACCESS_DENIED'}]}; delete first.hash; first.hash = digest(first);
  const next = {...value.attempts[0], sequence: 1, previous: first.hash}; delete next.hash; next.hash = digest(next);
  assert.throws(() => volumeSize({...value, attempts: [first, next], selectedAttempt: 1}, request), /Nonmutation/);
});
test('lifecycle transition waits for active scan and excludes later scans until closure',async()=>{
  const order=[];let release,entered;const enteredPromise=new Promise(resolve=>{entered=resolve;});let calls=0;
  const f=fixture(async()=>{order.push('scan-'+(++calls));if(calls===2){entered();await new Promise(resolve=>{release=resolve;});}return {bytes:1};});
  await f.monitor.add({key:'volume',capacityBytes:100});const scan=f.monitor.checkpoint('volume');await enteredPromise;
  const close=f.monitor.coordinate(async()=>{order.push('close');});const final=f.monitor.checkpoint('volume');
  release();await Promise.all([scan,close,final]);assert.deepEqual(order,['scan-1','scan-2','close','scan-3']);await f.monitor.finish();
});
test('serialized transition time remains inside conservative coverage and cannot reset it',async()=>{
  const f=fixture();await f.monitor.add({key:'volume',capacityBytes:100});await f.monitor.coordinate(async()=>{f.time(4001);});await f.monitor.checkpoint('volume');
  assert.equal((await f.monitor.finish()).status,'FAIL');assert.match(f.failures[0].message,/coverage/);
});
