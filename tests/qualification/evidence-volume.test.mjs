import { prepareFunctionalOutput } from '../../tooling/qualification/functional-output.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, copyFile, rm, stat, readdir, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllocation, sampleVolume, volumeAlarm, startEvidenceMonitor, createRetentionIndex, verifyEvidenceExport, eligibleEvidence, retentionDeadline, retainEvidenceAudit, verifyEvidenceAudit, readEvidenceJSON } from '../../tooling/qualification/evidence-volume.mjs';
import { trendPoints, renderTrends, publishTrends } from '../../tooling/qualification/evidence-trends.mjs';
const createdAt = '2025-01-01T00:00:00.000Z', old = '2026-09-30T00:00:00.000Z';
async function fixture(t, capacityBytes = 1024 * 1024 * 1024) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ideogram-evidence-test-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const volume = join(root, 'volume'); await mkdir(volume, { mode: 0o700 });
  const path = join(root, 'allocation.json'); await writeFile(path, JSON.stringify({ kind: 'evidence-volume-allocation-1', allocationId: 'test-volume', purpose: 'qualification-evidence-only', capacityBytes, root: volume, issuedAt: createdAt, owner: 'Build' }));
  return { root, volume, path, allocation: await loadAllocation(path) };
}
test('allocation is explicit; unknown fields and symlink roots are refused', async t => {
  const f = await fixture(t); await assert.rejects(loadAllocation(null));
  const value = JSON.parse(await readFile(f.path)); value.token = 'never-retain-extra'; await writeFile(f.path, JSON.stringify(value)); await assert.rejects(loadAllocation(f.path), /Unknown allocation/);
  delete value.token; await symlink(f.volume, join(f.root, 'alias')); value.root = join(f.root, 'alias'); await writeFile(f.path, JSON.stringify(value)); await assert.rejects(loadAllocation(f.path));
});
test('counter measures nested allocated/logical bytes and deduplicates hardlinks', async t => {
  const f = await fixture(t); await mkdir(join(f.volume, 'raw')); await writeFile(join(f.volume, 'raw', 'a'), Buffer.alloc(8192)); await link(join(f.volume, 'raw', 'a'), join(f.volume, 'raw', 'b'));
  const result = await sampleVolume(f.allocation); assert.equal(result.completeTraversal, true); assert.equal(result.observedLogicalBytes, 8192); assert.equal(result.uniqueFiles, 1); assert.equal(result.repeatedInodes, 1); assert.ok(result.observedAllocatedBytes >= 8192);
});
test('counter never follows an unrelated symlink and reports incomplete scope', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'unrelated')); await writeFile(join(f.root, 'unrelated', 'secret'), Buffer.alloc(102400)); await symlink(join(f.root, 'unrelated'), join(f.volume, 'escape'));
  const result = await sampleVolume(f.allocation); assert.equal(result.completeTraversal, false); assert.equal(result.observedLogicalBytes, 0); assert.equal(volumeAlarm(result, 1).level, 'unknown');
});
test('bounded traversal is inconclusive rather than fabricated complete count', async t => {
  const f = await fixture(t); await writeFile(join(f.volume, 'a'), 'a'); const result = await sampleVolume(f.allocation, { maxEntries: 1 }); assert.equal(result.completeTraversal, false); assert.equal(result.failures[0].code, 'EVIDENCE_BOUND');
});
test('80% target and 90% ceiling include exact threshold equality', () => {
  const sample = bytes => ({ observedAllocatedBytes: bytes, completeTraversal: true });
  assert.equal(volumeAlarm(sample(79), 100).level, 'normal'); assert.equal(volumeAlarm(sample(80), 100).level, 'target'); assert.equal(volumeAlarm(sample(89), 100).status, 'PASS'); assert.equal(volumeAlarm(sample(90), 100).status, 'FAIL');
  assert.equal(volumeAlarm({ observedAllocatedBytes: null, completeTraversal: false }, 100).status, 'INCONCLUSIVE');
});
test('missing diagnostic allocation stays explicitly unavailable', async () => {
  const monitor = await startEvidenceMonitor({ output: '/not-scanned/output', campaignId: 'diagnostic', allocationPath: null, allowUnavailable: true }); assert.equal(monitor.reference.status, 'INCONCLUSIVE'); assert.equal((await monitor.finish()).qualification, false);
});
test('retention minima preserve failures and indefinite supported releases', () => {
  assert.equal(retentionDeadline({ category: 'raw', createdAt }), '2025-04-01T00:00:00.000Z');
  assert.equal(retentionDeadline({ category: 'aggregate', createdAt }), '2026-01-01T00:00:00.000Z');
  assert.equal(retentionDeadline({ category: 'baseline', createdAt }), '2026-01-01T00:00:00.000Z');
  assert.equal(retentionDeadline({ category: 'release-defining', createdAt }), null);
  assert.equal(retentionDeadline({ category: 'source-fixture', createdAt, supportEndsAt: '2026-01-01T00:00:00.000Z' }), '2027-01-01T00:00:00.000Z');
  assert.throws(() => retentionDeadline({ category: 'release-defining', createdAt, supportEndsAt: '2024-01-01T00:00:00.000Z' }));
});
async function indexed(t) {
  const f = await fixture(t); await writeFile(join(f.volume, 'failed.json'), '{"status":"FAIL"}');
  f.indexPath = join(f.volume, 'index.json'); await createRetentionIndex({ allocation: f.allocation, output: f.indexPath, entries: [{ path: 'failed.json', category: 'raw', createdAt }], createdAt });
  f.exportRoot = join(f.root, 'export'); await mkdir(f.exportRoot); await copyFile(join(f.volume, 'failed.json'), join(f.exportRoot, 'failed.json'));
  f.exportReceiptPath = join(f.volume, 'export.json'); return f;
}
test('expired raw evidence remains ineligible until an independent export verifies', async t => {
  const f = await indexed(t); await assert.rejects(eligibleEvidence({ ...f, now: old }));
  await verifyEvidenceExport({ ...f, output: f.exportReceiptPath }); const result = await eligibleEvidence({ ...f, now: old }); assert.equal(result.entries[0].eligible, true); assert.equal(result.deletesFiles, false); assert.equal(await readFile(join(f.volume, 'failed.json'), 'utf8'), '{"status":"FAIL"}');
});
test('unexpired and release-support claims override weaker expired raw index', async t => {
  const f = await indexed(t); await verifyEvidenceExport({ ...f, output: f.exportReceiptPath });
  assert.equal((await eligibleEvidence({ ...f, now: '2025-03-31T23:59:59.999Z' })).entries[0].eligible, false);
  await createRetentionIndex({ allocation: f.allocation, output: join(f.volume, 'release.json'), entries: [{ path: 'failed.json', category: 'release-defining', createdAt }] });
  const result = await eligibleEvidence({ ...f, now: old }); assert.equal(result.entries[0].eligible, false); assert.equal(result.entries[0].retainUntil, null);
});
test('export refuses corruption, hardlinks and export inside evidence allocation', async t => {
  const f = await indexed(t); await writeFile(join(f.exportRoot, 'failed.json'), 'changed'); await assert.rejects(verifyEvidenceExport({ ...f, output: f.exportReceiptPath }));
  await rm(join(f.exportRoot, 'failed.json')); await link(join(f.volume, 'failed.json'), join(f.exportRoot, 'failed.json')); await assert.rejects(verifyEvidenceExport({ ...f, output: f.exportReceiptPath }), /hardlink/);
  await assert.rejects(verifyEvidenceExport({ ...f, exportRoot: f.volume, output: f.exportReceiptPath }), /outside/);
});
test('eligibility rechecks changed exported or retained bytes and never deletes', async t => {
  const f = await indexed(t); await verifyEvidenceExport({ ...f, output: f.exportReceiptPath }); await writeFile(join(f.exportRoot, 'failed.json'), 'changed'); await assert.rejects(eligibleEvidence({ ...f, now: old })); assert.ok((await stat(join(f.volume, 'failed.json'))).isFile());
});
test('duplicate or escaping index members are rejected', async t => {
  const f = await fixture(t); await writeFile(join(f.volume, 'a'), 'a');
  await assert.rejects(createRetentionIndex({ allocation: f.allocation, output: join(f.volume, 'i.json'), entries: [{ path: '../allocation.json', category: 'raw', createdAt }] }));
  await assert.rejects(createRetentionIndex({ allocation: f.allocation, output: join(f.volume, 'i.json'), entries: [{ path: 'a', category: 'raw', createdAt }, { path: 'a', category: 'raw', createdAt }] }));
});
const raw = { path: 'run/receipt.json', absolutePath: '/allocation/run/receipt.json', bytes: 50, sha256: 'a'.repeat(64) };
const receipt = () => ({ receiptId: 'run-1', revision: 'PERF-8', finishedAt: createdAt, identity: { before: { head: 'b'.repeat(40), digest: 'c'.repeat(64) } }, inputIdentities: { fixtureManifest: { sha256: 'd'.repeat(64) } }, groups: [{ cache: 'cold', cell: { id: 'cell-1', workload: 'W1', width: 1024 }, attempts: [{ id: 'start-1', status: 'PASS', elapsedMs: 42 }, { id: 'start-2', status: 'FAIL', elapsedMs: 100, censor: { lowerMs: 100, upperMs: null } }] }] });
test('trends retain failed/right-censored starts without treating censor bounds as completed time', () => {
  const points = trendPoints(receipt(), raw); assert.equal(points.length, 2); assert.equal(points[1].status, 'FAIL'); assert.equal(points[1].measuredMs, null); assert.equal(points[1].lowerMs, 100); assert.equal(points[1].upperMs, null);
});
test('trends separate cold/warm, exact fixture, dimensions and scope revisions', () => {
  const base = trendPoints(receipt(), raw)[0].series;
  for (const mutate of [value => value.groups[0].cache = 'warm', value => value.groups[0].cell.width = 512, value => value.inputIdentities.fixtureManifest.sha256 = 'e'.repeat(64), value => value.revision = 'PERF-9']) { const value = receipt(); mutate(value); assert.notEqual(trendPoints(value, raw)[0].series, base); }
});
test('unknown fixture identities isolate receipts and cannot establish comparison completeness', () => {
  const value = receipt(); value.inputIdentities = {}; const point = trendPoints(value, raw)[0]; assert.equal(point.completeIdentity, false); assert.notEqual(point.series, trendPoints(value, { ...raw, sha256: 'f'.repeat(64) })[0].series);
});
test('static trend output links raw evidence, escapes content and uses no script/network', () => {
  const value = receipt(); value.groups[0].cell.id = '<script>alert(1)</script>'; const points = trendPoints(value, raw), html = renderTrends({ points, receipts: 1, unavailable: [], recordedAt: createdAt }, '/allocation/audit');
  assert.match(html, /\.\.\/run\/receipt.json/); assert.match(html, /right-censored/); assert.doesNotMatch(html, /<script|https?:\/\//); assert.match(html, /default-src 'none'/);
});
test('real monitor final audit is replayable after portable retention and rejects journal tampering', async t => {
  const f = await fixture(t), output = join(f.volume, 'run'); await mkdir(output); const monitor = await startEvidenceMonitor({ allocationPath: f.path, output, campaignId: 'run-1', intervalMs: 30000 });
  const body = { ...receipt(), evidenceStorage: monitor.reference }; await writeFile(join(output, 'receipt.json'), JSON.stringify(body));
  await monitor.checkpoint(); const audit = await monitor.finish({ receiptPath: join(output, 'receipt.json'), outcome: 'PASS' }); assert.equal(audit.status, 'PASS');
  await retainEvidenceAudit(monitor.reference, output); assert.equal((await verifyEvidenceAudit(monitor.reference, join(output, 'receipt.json'))).status, 'PASS');
  assert.ok((await readdir(join(output, 'evidence-storage'))).includes('trends.html'));
  await writeFile(join(output, 'evidence-storage', 'samples.jsonl'), '{}\n'); await assert.rejects(verifyEvidenceAudit(monitor.reference, join(output, 'receipt.json')), /journal changed/);
});

test('symlink output and index/trend write parents never touch outside allocation', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside'); await mkdir(outside); await symlink(outside, join(f.volume, 'alias'));
  await assert.rejects(startEvidenceMonitor({ allocationPath: f.path, output: join(f.volume, 'alias'), campaignId: 'escape' }));
  await writeFile(join(f.volume, 'raw'), 'retained');
  await assert.rejects(createRetentionIndex({ allocation: f.allocation, output: join(f.volume, 'alias', 'index.json'), entries: [{ path: 'raw', category: 'raw', createdAt }] }));
  await assert.rejects(publishTrends({ allocation: f.allocation, receiptPath: join(f.volume, 'raw'), outputDirectory: join(f.volume, 'alias') }));
  assert.deepEqual(await readdir(outside), []);
});
test('initial alarm failure drains actual journal descriptor before rejecting', async t => {
  const f = await fixture(t), output = join(f.volume, 'run'); await mkdir(output); let descriptor;
  await assert.rejects(startEvidenceMonitor({ allocationPath: f.path, output, campaignId: 'alarm-fault', openJournal: async path => { descriptor = await open(path, 'wx', 0o600); return descriptor; }, onAlarm() { throw Error('Injected alarm sink failure'); } }), /alarm sink/);
  await assert.rejects(descriptor.stat(), /closed|EBADF/);
});
test('final receipt failure drains descriptor and leaves an explicit failed finalization', async t => {
  const f = await fixture(t), output = join(f.volume, 'run'); await mkdir(output); let descriptor;
  const monitor = await startEvidenceMonitor({ allocationPath: f.path, output, campaignId: 'final-fault', openJournal: async path => { descriptor = await open(path, 'wx', 0o600); return descriptor; } });
  await assert.rejects(monitor.finish({ receiptPath: join(output, 'missing.json') })); await assert.rejects(descriptor.stat(), /closed|EBADF/); await assert.rejects(monitor.finish(), /already finished/);
});
test('eligibility refuses an export replaced with a source hardlink after verification', async t => {
  const f = await indexed(t); await verifyEvidenceExport({ ...f, output: f.exportReceiptPath }); await rm(join(f.exportRoot, 'failed.json')); await link(join(f.volume, 'failed.json'), join(f.exportRoot, 'failed.json'));
  await assert.rejects(eligibleEvidence({ ...f, now: old }), /independently/);
});
test('authentic per-group sealed fixture object overrides catalog identity', () => {
  const value = receipt(); value.groups[0].fixtureIdentity = { path: '/controlled/w1.json', sha256: 'e'.repeat(64), bytes: 512, retainedPath: 'inputs/w1.json' };
  assert.equal(trendPoints(value, raw)[0].fixture, 'e'.repeat(64));
});
test('missing previously indexed receipt remains unavailable while other trends publish', async t => {
  const f = await fixture(t); await mkdir(join(f.volume, 'first')); await mkdir(join(f.volume, 'second')); const source = join(f.volume, 'old.json'); await writeFile(source, JSON.stringify(receipt()));
  await publishTrends({ allocation: f.allocation, receiptPath: source, outputDirectory: join(f.volume, 'first') }); await rm(source);
  const next = receipt(); next.receiptId = 'run-2'; const current = join(f.volume, 'new.json'); await writeFile(current, JSON.stringify(next));
  const published = await publishTrends({ allocation: f.allocation, receiptPath: current, outputDirectory: join(f.volume, 'second') }); assert.equal(published.unavailable, 1); assert.equal(published.points, 2);
});
test('offline audit rejects recomputed-hash null/string timing and malformed allocation values', async t => {
  const f = await fixture(t), output = join(f.volume, 'run'); await mkdir(output); const monitor = await startEvidenceMonitor({ allocationPath: f.path, output, campaignId: 'forged', intervalMs: 30000 });
  const receiptPath = join(output, 'receipt.json'); await writeFile(receiptPath, JSON.stringify({ ...receipt(), evidenceStorage: monitor.reference })); await monitor.finish({ receiptPath }); await retainEvidenceAudit(monitor.reference, output);
  const directory = join(output, 'evidence-storage'), auditPath = join(directory, 'audit.json'), journalPath = join(directory, 'samples.jsonl'), originalAudit = JSON.parse(await readFile(auditPath)), originalJournal = await readFile(journalPath, 'utf8');
  const sha = value => createHash('sha256').update(value).digest('hex');
  for (const bad of [null, '0', -1]) {
    const records = originalJournal.trim().split('\n').map(JSON.parse); let previous = null;
    records[0].sample.startMs = bad;
    for (const record of records) { const { hash, ...body } = record; body.previous = previous; record.previous = previous; record.hash = sha(JSON.stringify(body)); previous = record.hash; }
    const journal = records.map(record => JSON.stringify(record)).join('\n') + '\n'; const audit = { ...originalAudit, journalHead: previous, journal: { bytes: Buffer.byteLength(journal), sha256: sha(journal) } };
    await writeFile(journalPath, journal); await writeFile(auditPath, JSON.stringify(audit)); await assert.rejects(verifyEvidenceAudit(monitor.reference, receiptPath), /schema|span/);
  }
  await writeFile(journalPath, originalJournal);
  for (const values of [{ maximumGapMs: null }, { intervalMs: '2000' }, { capacityBytes: null }, { coverageComplete: 'true' }, { unknownSamples: -1 }]) { await writeFile(auditPath, JSON.stringify({ ...originalAudit, ...values })); await assert.rejects(verifyEvidenceAudit(monitor.reference, receiptPath), /schema/); }
});

test('bounded JSON refuses growth and short reads while draining its descriptor', async t => {
  const f = await fixture(t), path = join(f.volume, 'growing.json'); await writeFile(path, '{"x":1}'); let descriptor, injected = false;
  await assert.rejects(readEvidenceJSON(path, { openFile: async (...args) => { descriptor = await open(...args); return { stat: (...values) => descriptor.stat(...values), close: () => descriptor.close(), async read(...values) { const result = await descriptor.read(...values); if (!injected) { injected = true; await writeFile(path, '{"x":1} trailing-growth'); } return result; } }; } }), /changed/);
  await assert.rejects(descriptor.stat(), /closed|EBADF/);
  await writeFile(path, '{"x":1}');
  await assert.rejects(readEvidenceJSON(path, { openFile: async (...args) => { descriptor = await open(...args); return { stat: (...values) => descriptor.stat(...values), close: () => descriptor.close(), async read() { return { bytesRead: 0 }; } }; } }), /shortened/);
  await assert.rejects(descriptor.stat(), /closed|EBADF/);
});

test('exact original allocation bytes bind capacity despite forged replay-consistent copies', async t => {
  const f = await fixture(t), output = join(f.volume, 'run'); await mkdir(output); const monitor = await startEvidenceMonitor({ allocationPath: f.path, output, campaignId: 'allocation-forgery', intervalMs: 30000 });
  const receiptPath = join(output, 'receipt.json'); await writeFile(receiptPath, JSON.stringify({ ...receipt(), evidenceStorage: monitor.reference })); await monitor.finish({ receiptPath }); await retainEvidenceAudit(monitor.reference, output);
  const directory = join(output, 'evidence-storage'); assert.deepEqual(await readFile(join(directory, 'allocation-source.json')), await readFile(f.path));
  const allocation = JSON.parse(await readFile(join(directory, 'allocation.json'))), audit = JSON.parse(await readFile(join(directory, 'audit.json'))), records = (await readFile(join(directory, 'samples.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const sha = value => createHash('sha256').update(value).digest('hex'); allocation.capacityBytes *= 2; audit.capacityBytes = allocation.capacityBytes; let previous = null;
  for (const record of records) { record.alarm = volumeAlarm(record.sample, audit.capacityBytes); record.previous = previous; const { hash, ...body } = record; record.hash = sha(JSON.stringify(body)); previous = record.hash; }
  const journal = records.map(record => JSON.stringify(record)).join('\n') + '\n'; audit.journal = { bytes: Buffer.byteLength(journal), sha256: sha(journal) }; audit.journalHead = previous; audit.alarms.final = records.at(-1).alarm;
  await writeFile(join(directory, 'allocation.json'), JSON.stringify(allocation)); await writeFile(join(directory, 'audit.json'), JSON.stringify(audit)); await writeFile(join(directory, 'samples.jsonl'), journal);
  await assert.rejects(verifyEvidenceAudit(monitor.reference, receiptPath), /allocation source/);
});

test('fresh functional checkout supports external allocated output and keeps exclusive lock parent', async t => {
  const f = await fixture(t), checkout = join(f.root, 'fresh-checkout'); await mkdir(checkout);
  const selected = join(f.volume, 'functional'), prepared = prepareFunctionalOutput(checkout, 'opaque-run', selected);
  assert.equal(prepared.directory, selected); assert.ok((await stat(join(checkout, 'artifacts', 'qualification'))).isDirectory());
  const lock = await open(prepared.lock, 'wx', 0o600); try { await assert.rejects(open(prepared.lock, 'wx', 0o600), error => error.code === 'EEXIST'); } finally { await lock.close(); }
  assert.throws(() => prepareFunctionalOutput(checkout, 'retry', selected), error => error.code === 'EEXIST');
});

test('counter rejects an unbounded caller limit', async t => { const f = await fixture(t); await assert.rejects(sampleVolume(f.allocation, { maxEntries: Infinity }), /bounded/); await assert.rejects(sampleVolume(f.allocation, { maxEntries: 100001 }), /bounded/); });

// Message-only diagnostics retain the public sample/alarm schema and opaque
// error boundary. The supplied metadata deltas are deterministic unit controls.
test('bounded mutation comparison preserves unknown alarm and sanitized member context',async t=>{
 const {lstat}=await import('node:fs/promises'),f=await fixture(t),name='"'+'x'.repeat(178)+'z',target=join(f.volume,name);await writeFile(target,'x');let visits=0;
 const result=await sampleVolume(f.allocation,{async statEntry(path,options){const value=await lstat(path,options);if(path===target&&++visits===2)value.ino+=1n;return value;}});
 const prefix='Evidence observation unavailable; phase=identity; code=EVIDENCE_MUTATION; member='+name.replace(/[\\"]/g,'?').slice(0,160),suffix='; mutation-v1=02; kinds=file>file';
 assert.deepEqual(result.failures,[{code:'EVIDENCE_MUTATION',message:prefix+suffix}]);assert.deepEqual(Object.keys(result.failures[0]).sort(),['code','message']);
 assert(Buffer.byteLength(suffix)<=80);assert(!result.failures[0].message.includes(f.root));assert.equal(result.entries,2);assert.equal(result.uniqueFiles,1);assert.equal(result.observedLogicalBytes,1);
 assert.deepEqual(volumeAlarm(result,f.allocation.capacityBytes),{status:'INCONCLUSIVE',level:'unknown',percent:null});assert.equal(result.consistency,'non-atomic-observation-window');
});

for(const kind of ['root-identity','unsupported-entry','injected-mutation'])test(kind+' does not acquire a comparison diagnostic or a different refusal',async t=>{
 const {lstat}=await import('node:fs/promises'),f=await fixture(t),target=kind==='root-identity'?f.volume:join(f.volume,'entry');if(target!==f.volume)await writeFile(target,'x');let visits=0;
 const result=await sampleVolume(f.allocation,{async statEntry(path,options){
  const value=await lstat(path,options);
  if(path===target){visits++;if(kind==='injected-mutation')throw Object.assign(Error('untrusted mutation-v1=7f /private/secret'),{code:'EVIDENCE_MUTATION',comparison:'forged'});
   if(visits===2){if(kind==='root-identity')value.ino+=1n;else value.isSymbolicLink=()=>true;}}
  return value;
 }});
 const expected=kind==='root-identity'?'EVIDENCE_ROOT':kind==='unsupported-entry'?'EVIDENCE_ENTRY':'EVIDENCE_MUTATION';
 assert.equal(result.completeTraversal,false);assert.equal(result.failures.length,1);assert.equal(result.failures[0].code,expected);
 assert.deepEqual(Object.keys(result.failures[0]).sort(),['code','message']);assert(!result.failures[0].message.includes('mutation-v1'));assert(!result.failures[0].message.includes('private'));assert(!result.failures[0].message.includes('forged'));
 assert.equal(volumeAlarm(result,f.allocation.capacityBytes).status,'INCONCLUSIVE');assert.equal(visits,kind==='injected-mutation'?1:2);
});
