import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootFor } from '../store/helpers.mjs';
import { Objects } from '../../dist/local/server/storage/objects.js';
import { Displays } from '../../dist/local/server/storage/display.js';
import { AssetRoutes } from '../../dist/local/server/assets.js';
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const ref = (bytes, mediaType) => ({ hash: hash(bytes), byteLength: String(bytes.length), mediaType });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Actual Objects and Displays own files/leases. Only expensive raster output is
// deterministic here, so cancellation and native-file fault boundaries can be held.
async function fixture(t, onWork) {
  const root = await rootFor(t), objects = new Objects(root, () => {}, () => {});
  const retain = (bytes, type) => { const id = objects.begin(String(bytes.length), type, hash(bytes)); objects.chunk(id, bytes); return objects.finish(id); };
  const pixels = retain(Buffer.from([1,2,3,0,20,30,40,255]), 'application/x-ideogram-rgba8');
  const manifest = retain(Buffer.from('{}'), 'application/json');
  const png = retain(Buffer.from([137,80,78,71]), 'image/png');
  const asset = { id: 'image', safety: 'safe', qualification: 'canonical-raster', availability: 'available', blob: png, measuredMediaType: 'image/png',
    raster: { width: 2, height: 1, pixels, manifest, pixelIdentity: hash('identity'), pipeline: 'test', role: 'composite' } };
  let stop = () => {}, count = 0;
  const rasters = { manifest() { return { tiles: [{ x: 0, y: 0, width: 2, height: 1, hash: pixels.hash }] }; }, async displayWork(job, slot, check) {
    count++; await onWork?.({ job, slot, check, setStop: value => { stop = value; }, count }); check();
    const bytes = Buffer.from([137,80,78,71,job.options?.resize.width ?? 2,job.options?.resize.height ?? 1]);
    const png = ref(bytes, 'image/png'); await writeFile(join(job.directory, 'output.png'), bytes, { mode: 0o600 });
    return { png, info: { ...asset.raster, ...(job.options?.resize ?? {}) }, files: [{ name: 'output.png', ref: png }] };
  }, async stopDisplayWork() { stop(); } };
  const displays = new Displays(objects, { safeAsset: () => asset }, rasters, root, () => {});
  t.after(async () => { await displays.close(); objects.close(); });
  return { root, objects, displays, asset, rasters, count: () => count, query: edge => ({ kind: 'preview', basis: 'pixels', identity: asset.raster.pixelIdentity, edge }) };
}
function idle(f) { assert.equal(f.displays.diagnostics().active, 0); assert.equal(f.objects.reservationInventory().activeTransfers, 0); assert.equal(f.objects.proofInventory().retained, 0); assert.equal(f.objects.proofInventory().pending, 0); }

test('canceling pending display work drains its worker before releasing proofs, scratch and IO', async t => {
  const started = defer(), gate = defer();
  const f = await fixture(t, ({ setStop }) => { setStop(() => gate.resolve()); started.resolve(); return gate.promise; });
  const prepared = f.displays.begin('pending', 'image', f.query(256)); const failed = assert.rejects(prepared, { code: 'CLOSED' });
  await started.promise; assert.equal(f.objects.reservationInventory().activeTransfers, 1);
  assert.equal(f.objects.proofInventory().retained, 2);
  await f.displays.release('pending'); await failed; idle(f);
  assert.deepEqual(await readdir(join(f.root, 'display-cache')), []);
});

test('duplicate cold derivatives cannot overwrite a pinned entry or leave an unindexed cache directory', async t => {
  const started = defer(), gate = defer();
  const f = await fixture(t, () => { started.resolve(); return gate.promise; });
  const first = f.displays.begin('one', 'image', f.query(256)); await started.promise;
  await assert.rejects(f.displays.begin('two', 'image', f.query(256)), { code: 'QUEUE_FULL' });
  gate.resolve(); const info = await first;
  assert.equal(f.count(), 1); assert.equal(f.displays.diagnostics().entries, 1);
  assert.equal((await readdir(join(f.root, 'display-cache'))).length, 1);
  assert.equal(hash(f.displays.read('one', '0', Number(info.byteLength))), info.hash);
  await f.displays.release('one'); idle(f);
});

test('reusing a released request ID cannot adopt or remove another retained cache directory', async t => {
  const f = await fixture(t, ({ count }) => { if (count === 2) throw Error('worker-failure'); });
  const first = await f.displays.begin('reused', 'image', f.query(256)); await f.displays.release('reused');
  const directories = await readdir(join(f.root, 'display-cache'));
  await assert.rejects(f.displays.begin('reused', 'image', f.query(1024)), /worker-failure/);
  assert.deepEqual(await readdir(join(f.root, 'display-cache')), directories);
  const again = await f.displays.begin('read-again', 'image', f.query(256));
  assert.equal(again.hash, first.hash); assert.equal(f.count(), 2);
  await f.displays.release('read-again'); idle(f);
});

test('cached bytes are fenced against mutation and still require current asset safety and identity', async t => {
  const f = await fixture(t); await f.displays.begin('seed', 'image', f.query(256)); await f.displays.release('seed');
  const directory = (await readdir(join(f.root, 'display-cache')))[0], path = join(f.root, 'display-cache', directory, 'data');
  const previous = await readFile(path); await writeFile(path, Buffer.from(previous).fill(7));
  await assert.rejects(f.displays.begin('changed', 'image', f.query(256)), { code: 'CORRUPT_OBJECT' }); idle(f);
  const stale = { ...f.query(1024), identity: hash('other') };
  await assert.rejects(f.displays.begin('stale', 'image', stale), { code: 'OFFSET_MISMATCH' }); idle(f);
});

test('cache hits reuse only hash-proven source stamps and reject a changed source without rehashing the full image', async t => {
  const f = await fixture(t), proven = [], prove = f.objects.prove.bind(f.objects);
  f.objects.prove = (ref, check) => { proven.push(ref.hash); return prove(ref, check); };
  await f.displays.begin('first', 'image', f.query(256)); await f.displays.release('first');
  await f.displays.begin('cached', 'image', f.query(256)); await f.displays.release('cached');
  assert.equal(proven.filter(value => value === f.asset.raster.pixels.hash).length, 1);
  assert.equal(proven.filter(value => value === f.asset.raster.manifest.hash).length, 2);
  await writeFile(f.objects.path(f.asset.raster.pixels), Buffer.alloc(8, 99));
  await assert.rejects(f.displays.begin('mutated', 'image', f.query(256)), { code: 'CORRUPT_OBJECT' }); idle(f);
});

test('LOD0 verifies the manifest tile hash without a whole-image proof and fences subsequent reads', async t => {
  const f = await fixture(t), proven = [], prove = f.objects.prove.bind(f.objects);
  f.objects.prove = (ref, check) => { proven.push(ref.hash); return prove(ref, check); };
  const query = { kind: 'tile', basis: 'pixels', identity: f.asset.raster.pixelIdentity, x: 0, y: 0, lod: 0 };
  const info = await f.displays.begin('tile', 'image', query);
  assert.deepEqual(proven, [f.asset.raster.manifest.hash]); assert.equal(info.hash, f.asset.raster.pixels.hash);
  assert.deepEqual(f.displays.read('tile', '0', 8), Buffer.from([1,2,3,0,20,30,40,255]));
  await writeFile(f.objects.path(f.asset.raster.pixels), Buffer.alloc(8, 42));
  assert.throws(() => f.displays.read('tile', '0', 8), { code: 'CORRUPT_OBJECT' });
  await f.displays.release('tile'); idle(f);
  await assert.rejects(f.displays.begin('bad-hash', 'image', query), { code: 'CORRUPT_OBJECT' }); idle(f);
});

test('an HTTP disconnect while the root check is pending never launches deferred display work', async () => {
  const root = defer(); let begins = 0, releases = 0;
  const routes = new AssetRoutes({ displayBegin() { begins++; throw Error('must not begin'); }, async displayRelease() { releases++; } }, () => 0);
  const req = new EventEmitter(); req.aborted = false; const res = new EventEmitter(); res.destroyed = false;
  const route = routes.match('/api/v1/assets/image/display');
  const result = routes.handle(req, res, route, new URLSearchParams({ edge: '256', basis: 'pixels', identity: hash('source') }), () => ({}), () => root.promise);
  res.destroyed = true; res.emit('close'); root.resolve(); await result;
  assert.equal(begins, 0); assert.ok(releases >= 1);
});


test('storage clear skips live pins and raw LOD0, then removes only released derivatives and recomputes them', async t => {
  const f = await fixture(t), original = await readFile(f.objects.path(f.asset.raster.pixels));
  const info = await f.displays.begin('pinned-preview', 'image', f.query(256));
  const raw = {kind:'tile',basis:'pixels',identity:f.asset.raster.pixelIdentity,x:0,y:0,lod:0};
  await f.displays.begin('raw-tile', 'image', raw);
  assert.equal(f.displays.hasReaders(), true);
  const pinned = f.displays.clearRegistered();
  assert.equal(pinned.removedEntries, 0); assert.equal(pinned.pinnedEntries, 1);
  assert.equal(pinned.freedLogicalBytes, '0'); assert.equal(pinned.outcome, 'complete');
  assert.equal(hash(f.displays.read('pinned-preview', '0', Number(info.byteLength))), info.hash);
  assert.deepEqual(f.displays.read('raw-tile', '0', original.length), original);
  await f.displays.release('pinned-preview'); await f.displays.release('raw-tile');
  assert.equal(f.displays.hasReaders(), false);
  const cleared = f.displays.clearRegistered();
  assert.equal(cleared.outcome, 'complete'); assert.equal(cleared.removedEntries, 1);
  assert.equal(cleared.freedLogicalBytes, info.byteLength); assert.deepEqual(cleared.failures, []);
  assert.deepEqual(await readdir(join(f.root, 'display-cache')), []);
  assert.deepEqual(await readFile(f.objects.path(f.asset.raster.pixels)), original);
  const again = await f.displays.begin('recomputed', 'image', f.query(256));
  assert.equal(again.hash, info.hash); assert.equal(f.count(), 2);
  await f.displays.release('recomputed'); idle(f);
});

test('storage clear retains unexpected members and changed registered file identities', async t => {
  const f = await fixture(t);
  await f.displays.begin('seed', 'image', f.query(256)); await f.displays.release('seed');
  const directory = join(f.root, 'display-cache', (await readdir(join(f.root, 'display-cache')))[0]);
  const sentinel = join(directory, 'unregistered'), data = join(directory, 'data'), before = await readFile(data);
  await writeFile(sentinel, 'keep', {mode:0o600});
  const refused = f.displays.clearRegistered();
  assert.equal(refused.outcome, 'partial'); assert.equal(refused.removedEntries, 0);
  assert.equal(refused.freedLogicalBytes, '0'); assert.equal(refused.retainedEntries, 1);
  assert.equal(refused.failures.length, 1); assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  assert.deepEqual(await readFile(data), before); idle(f);
  const separate = await fixture(t);
  await separate.displays.begin('seed', 'image', separate.query(256)); await separate.displays.release('seed');
  const changed = join(separate.root, 'display-cache', (await readdir(join(separate.root, 'display-cache')))[0]), changedData = join(changed, 'data');
  await writeFile(changedData, Buffer.from('changed'));
  const rejected = separate.displays.clearRegistered();
  assert.equal(rejected.outcome, 'partial'); assert.equal(rejected.removedEntries, 0);
  assert.equal(rejected.failures[0].reason, 'identity'); assert.equal(await readFile(changedData, 'utf8'), 'changed'); idle(separate);
});

test('storage clear observes but never deletes an active derivative build', async t => {
  const started = defer(), gate = defer();
  const f = await fixture(t, ({setStop}) => {setStop(() => gate.resolve()); started.resolve(); return gate.promise;});
  const pending = f.displays.begin('building', 'image', f.query(256)); await started.promise;
  const directories = await readdir(join(f.root, 'display-cache'));
  const result = f.displays.clearRegistered();
  assert.equal(result.activeBuilds, 1); assert.equal(result.removedEntries, 0);
  assert.deepEqual(await readdir(join(f.root, 'display-cache')), directories);
  gate.resolve(); await pending; await f.displays.release('building'); idle(f);
});
