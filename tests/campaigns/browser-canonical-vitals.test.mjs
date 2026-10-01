import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { canonicalVitalsVersion, safeCanonicalVitalRecord, createCanonicalVitalsStore, canonicalVitalsBrowserCollector, loadCanonicalVitalsLibrary } from '../../tooling/qualification/campaigns/browser-canonical-vitals.mjs';

const documentId = '12345678-1234-4567-8901-123456789abc';
const library = { name: 'web-vitals', version: canonicalVitalsVersion, sha256: 'a'.repeat(64) };
const metricId = 'v6-1700000000000-1000000000000';
const cohort = { cache: 'warm', cohortKey: 'chromium-H-Q3' };
const record = (kind, sequence, extras = {}) => ({ kind, documentId, visit: 0, sequence, ...extras });
const start = record('start', 0, { visibility: 'visible', restored: false });
const metric = (sequence, name = 'INP', value = 72) => record('metric', sequence, { metric: name, metricId, value, observerSupported: true, interactions: 1 });
const lifecycle = (sequence, event) => record('lifecycle', sequence, { event, trusted: true, persisted: false });
const makeStore = options => createCanonicalVitalsStore({ library, cohort, ...options });

test('canonical boundary retains only enum/numeric identities and no browser contents', () => {
  const input = { ...metric(1), entries: [{ target: { textContent: 'private' }, name: 'https://secret.test' }], attribution: { inputTarget: '#secret' }, message: 'secret' };
  assert.deepEqual(safeCanonicalVitalRecord(input), metric(1));
  for (const patch of [{ value: NaN }, { value: Infinity }, { value: -1 }, { interactions: 0.5 }, { metricId: 'private' }, { documentId: 'https://private' }, { sequence: 100001 }]) assert.equal(safeCanonicalVitalRecord({ ...input, ...patch }), null);
  assert.equal(safeCanonicalVitalRecord({ ...lifecycle(2, 'hidden'), trusted: false }), null);
});

test('unavailable INP stays null and a visible visit is not finalized', () => {
  const store = makeStore(); store.accept(start, 'page');
  const [result] = store.snapshot({ metric: 'INP' }).reports;
  assert.equal(result.value, null); assert.equal(result.finalized, false);
  assert.equal(result.observerSupported, false); assert.equal(result.interactions, 0);
  store.accept(lifecycle(1, 'hidden'), 'page');
  assert.equal(store.snapshot({ metric: 'INP' }).reports[0].value, null);
});

test('real hidden lifecycle finalizes canonical value and resuming invalidates finalization', () => {
  const store = makeStore(); store.accept(start, 'page'); store.accept(metric(1), 'page');
  store.accept(lifecycle(2, 'hidden'), 'page');
  assert.deepEqual(store.snapshot({ metric: 'INP' }).reports[0], {
    visitId: `${documentId}:0`, navigationId: `${documentId}:0`, metricId, sequence: 2,
    metric: 'INP', finalized: true, observerSupported: true, lifecycleComplete: true,
    visibility: 'visible', interactions: 1, value: 72, libraryVersion: canonicalVitalsVersion, ...cohort,
  });
  store.accept(lifecycle(3, 'visible'), 'page');
  assert.equal(store.snapshot({ metric: 'INP' }).reports[0].finalized, false);
  store.accept(metric(4, 'INP', 112), 'page'); store.accept(lifecycle(5, 'pagehide'), 'page');
  assert.equal(store.snapshot({ metric: 'INP' }).reports[0].value, 112);
  assert.equal(store.snapshot({ metric: 'INP' }).reports[0].finalized, false);
  store.accept(lifecycle(6, 'hidden'), 'page');
  assert.equal(store.snapshot({ metric: 'INP' }).reports[0].finalized, true);
});

test('BFCache restoration creates a distinct visit without carrying prior INP', () => {
  const store = makeStore(); store.accept(start, 'page'); store.accept(metric(1), 'page'); store.accept(lifecycle(2, 'pagehide'), 'page');
  store.accept({ ...start, visit: 1, restored: true }, 'page');
  const snapshot = store.snapshot({ metric: 'INP' });
  assert.equal(snapshot.expectedVisits.length, 2);
  assert.equal(snapshot.reports[1].value, null);
  assert.notEqual(snapshot.reports[0].navigationId, snapshot.reports[1].navigationId);
  store.accept(metric(3, 'INP', 999), 'page');
  assert.equal(store.snapshot({ metric: 'INP' }).rejectedRecords, 1);
  assert.equal(store.snapshot({ metric: 'INP' }).reports[0].value, 72);
});

test('cohort claims exclude setup visits and reject reassignment of scored visits', () => {
  const store = makeStore({ cohort: null }); store.accept(start, 'page');
  assert.deepEqual(store.snapshot({ metric: 'INP', ...cohort, expectedVisits: [] }).reports, []);
  store.setCohort(cohort, { page: 'page', includeCurrentVisit: true });
  assert.equal(store.snapshot({ metric: 'INP' }).expectedVisits.length, 1);
  assert.throws(() => store.setCohort({ ...cohort, cache: 'cold' }, { page: 'page', includeCurrentVisit: true }), /cannot be reassigned/);
  assert.equal(store.snapshot().cache, 'warm');
  assert.throws(() => store.setCohort(cohort, { page: 'absent', includeCurrentVisit: true }), /No observed/);
});

test('identity changes, report overflow and dropped visits cannot create eligible evidence', () => {
  const store = makeStore({ maxVisits: 1, maxReports: 3 }); store.accept(start, 'page');
  store.accept(metric(1), 'page');
  store.accept({ ...metric(2), metricId: 'v6-1700000000000-2000000000000' }, 'page');
  store.accept(metric(3), 'page'); store.accept(metric(4), 'page'); store.accept(lifecycle(5, 'hidden'), 'page');
  store.accept({ ...start, visit: 1, restored: true }, 'page');
  const result = store.snapshot({ metric: 'INP' });
  assert.equal(result.overflow, true); assert.equal(result.droppedVisits, 1);
  assert.equal(result.reports[0].finalized, false);
  assert.equal(result.reports[0].lifecycleComplete, false);
  assert.throws(() => makeStore({ maxReports: 10001 }), /limits/);
});

function browserHarness() {
  const listeners = new Map(), callbacks = {}, records = [];
  const scope = {
    location: { origin: 'http://127.0.0.1:4381' }, crypto: { randomUUID: () => documentId },
    document: { visibilityState: 'visible' }, performance: { interactionCount: 0 },
    PerformanceObserver: { supportedEntryTypes: ['largest-contentful-paint', 'layout-shift', 'paint', 'event'] },
    PerformanceEventTiming: class { get interactionId() { return 1; } },
    __binding: async value => { records.push(value); }, queueMicrotask,
    addEventListener: (name, callback) => { const list = listeners.get(name) ?? []; list.push(callback); listeners.set(name, list); },
    webVitals: Object.fromEntries(['LCP', 'CLS', 'INP'].map(name => [`on${name}`, (callback, options) => { callbacks[name] = callback; assert.deepEqual(JSON.parse(JSON.stringify(options)), { reportAllChanges: true, reportSoftNavs: false }); }])),
  };
  scope.top = scope; const context = vm.createContext(scope);
  const run = () => vm.runInContext(`(${canonicalVitalsBrowserCollector.toString()})(${JSON.stringify({ binding: '__binding', allowedOrigins: ['http://127.0.0.1:4381'], maxReports: 3, maxVisits: 2 })})`, context);
  const dispatch = async (name, event) => { for (const callback of listeners.get(name) ?? []) callback(event); await Promise.resolve(); };
  return { run, dispatch, scope, records, callbacks };
}

test('browser adapter forwards official values, strips entries and ignores synthetic lifecycle events', async () => {
  const { run, dispatch, scope, records, callbacks } = browserHarness(); run();
  callbacks.INP({ name: 'INP', id: metricId, value: 88, entries: [{ entryType: 'event', interactionId: 3, target: { secret: true } }], attribution: { secret: true } });
  assert.equal(records[1].value, 88); assert.equal(records[1].interactions, 1);
  assert.equal('entries' in records[1], false); assert.equal('attribution' in records[1], false);
  scope.document.visibilityState = 'hidden';
  await dispatch('visibilitychange', { isTrusted: false }); await dispatch('pagehide', { isTrusted: false });
  assert.equal(records.length, 2);
  await dispatch('visibilitychange', { isTrusted: true });
  assert.equal(records[2].event, 'hidden');
  await dispatch('pageshow', { isTrusted: true, persisted: true });
  assert.equal(records[3].kind, 'start'); assert.equal(records[3].visit, 1);
  assert.equal(records[3].restored, true);
});

test('browser transport is bounded and irrelevant origins are not observed', () => {
  const { run, callbacks, records } = browserHarness(); run();
  for (let index = 0; index < 20; index++) callbacks.CLS({ name: 'CLS', id: metricId, value: index / 100, entries: [] });
  assert.equal(records.length, 5); assert.equal(records.at(-1).kind, 'overflow');
  const blank = browserHarness(); blank.scope.location.origin = 'null'; blank.run();
  assert.equal(blank.records.length, 0); assert.deepEqual(blank.callbacks, {});
});

test('subject checkout loader seals exact installed bytes and refuses mismatched lock/package identities', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ie-vitals-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'node_modules/web-vitals'); await mkdir(join(packageRoot, 'dist'), { recursive: true });
  const bytes = '/* metadata-loader fixture only; not a metric algorithm */\n';
  const locked = { version: canonicalVitalsVersion, integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, resolved: `https://registry.npmjs.org/web-vitals/-/web-vitals-${canonicalVitalsVersion}.tgz` };
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { 'web-vitals': canonicalVitalsVersion } })),
    writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/web-vitals': locked } })),
    writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'web-vitals', version: canonicalVitalsVersion, main: 'dist/web-vitals.umd.cjs', repository: { url: 'https://github.com/GoogleChrome/web-vitals.git' } })),
    writeFile(join(packageRoot, 'dist/web-vitals.umd.cjs'), ''), writeFile(join(packageRoot, 'dist/web-vitals.iife.js'), bytes),
  ]);
  const loaded = await loadCanonicalVitalsLibrary(root);
  assert.equal(loaded.library.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(loaded.library.bytes, Buffer.byteLength(bytes)); assert.equal(loaded.content, bytes);
  const value = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')); value.packages['node_modules/web-vitals'].version = '0.0.1';
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(value));
  await assert.rejects(loadCanonicalVitalsLibrary(root), error => error.code === 'CAMPAIGN_PREREQUISITE');
});
