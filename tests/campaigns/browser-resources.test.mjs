import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createBrowserResourceSampler, parseResourceBirths, parseResourceProcesses, resourceProcessTree, resourceProductProjection } from '../../tooling/qualification/campaigns/browser-resources.mjs';

const birth = 'Wed Sep 30 12:34:56 2026';
const completeLedger = () => ({ cpuBytes: 100, gpuBytes: 200, previewCacheBytes: 300, unusedHandles: 0, textureSide: 512, deviceTextureLimit: 4096, complete: true, coverage: { cpu: true, gpu: true, previewCache: true, handles: true, textureLimits: true } });
const canvasLedger = () => ({ ...completeLedger(), textureSide: null, deviceTextureLimit: null,
  coverage: { cpu: true, gpu: true, previewCache: true, handles: true, textureLimits: false },
  rendererOwnership: { contract: 'canvas2d-owned-rgba-v1', backend: 'main-thread-canvas-2d', appOwnedTextureAPIs: [], appOwnedTextureCount: 0, textureLimitApplicability: 'not-applicable', rgbaBackingEstimateBytes: 200 } });

async function fakeSampler(t, options = {}) {
  const output = await mkdtemp(join(tmpdir(), 'browser-resources-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  let time = 0, sequence = 0, rootsChanged = false, recycleDescendant = false, rssReads = 0;
  const timers = new Map(), commands = [];
  const hooks = {
    workerPid: 90, now: () => time,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async execute(command, args) {
      assert.equal(command, '/bin/ps'); commands.push(args); time += 0.1;
      if (args[0] === '-e') { rssReads++; assert.deepEqual(args, ['-e', '-o', 'pid=,ppid=,rss=']); return { stdout: '90 1 7\n100 90 10\n101 100 11\n200 90 20\n201 200 21\n300 1 999\n' }; }
      assert.deepEqual(args.slice(2), ['-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=']);
      return { stdout: args[1].split(',').map(id => `${id} ${id === '100' || id === '101' ? '100' : '90'} ${rootsChanged && id === '100' || recycleDescendant && id === '101' && rssReads % 2 === 0 ? 'Wed Sep 30 12:35:56 2026' : birth}`).join('\n') };
    },
    productSnapshot: async () => ({ allocations: options.ledger?.() ?? null, lifecycle: { releasing: false, releases: 1, lastReleaseMilliseconds: 5, consumers: { 'editor-shell': { decodedBitmaps: 0, nativeWorkers: 0, privatePrompt: 'secret caption', unusedHandles: 0 } } } }),
    ...options.hooks,
  };
  const sampler = createBrowserResourceSampler({ browserPid: 100, backendPid: 200, page: {}, output }, hooks);
  async function runTimer(delay = 0) {
    const [id, value] = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0] ?? [];
    assert(value, 'scheduled sample exists'); timers.delete(id); time = value.due + delay;
    const previous = sampler.evidence().counts.samples; value.callback();
    for (let i = 0; i < 1000 && (sampler.evidence().counts.samples === previous || !timers.size); i++) await new Promise(resolve => setImmediate(resolve));
    assert(sampler.evidence().counts.samples > previous, 'scheduled sample finished');
  }
  return { sampler, commands, runTimer, recycleRoot: () => { rootsChanged = true; }, recycleDescendant: () => { recycleDescendant = true; } };
}

test('numeric RSS parser attributes both trees and rejects malformed or duplicate rows', () => {
  const rows = parseResourceProcesses('1 0 100\n10 1 200\n11 10 300\n20 1 400\n');
  assert.deepEqual(resourceProcessTree(rows, 10).map(row => row.pid), [10, 11]);
  assert.equal(resourceProcessTree(rows, 10).reduce((sum, row) => sum + row.rssBytes, 0), 500 * 1024);
  assert.deepEqual(resourceProcessTree(rows, 404), []);
  for (const bad of ['PID PPID RSS', '1 0 -1', '1 0 1.5', '1 0 NaN', '1 0 2\n1 0 3', '1 0 12 secret command']) assert.throws(() => parseResourceProcesses(bad));
});

test('birth identity parser accepts only fixed OS identity metadata', () => {
  assert.deepEqual(parseResourceBirths(`100 90 ${birth}`), [{ pid: 100, pgid: 90, startedAtIdentity: birth }]);
  for (const bad of ['100 90 secret command line', `100 90 ${birth}\n100 90 ${birth}`, `100 0 ${birth}`, `100 90 ${birth} secret`]) assert.throws(() => parseResourceBirths(bad));
});

test('document lifecycle zeros never masquerade as a complete CPU/GPU/handle ledger', () => {
  const projected = resourceProductProjection({ allocations: { cpuBytes: 12, unusedHandles: 0, gpuBytes: NaN }, lifecycle: { consumers: { 'editor-shell': { decodedBitmaps: 0, privatePrompt: 'secret' } } } });
  assert.equal(projected.values.cpuBytes, 12); assert.equal(projected.values.gpuBytes, null); assert.equal(projected.values.unusedHandles, null);
  assert.equal(projected.allocationCoverage.complete, false); assert(!JSON.stringify(projected).includes('secret'));
  const complete = resourceProductProjection({ allocations: completeLedger() }); assert.equal(complete.values.unusedHandles, 0); assert.equal(complete.allocationCoverage.complete, true);
});

test('Canvas2D declaration alone never substitutes for reviewed source and build evidence', () => {
  for (const proof of [null, { status: 'PASS' }, { kind: 'renderer-ownership-proof-1', contract: 'canvas2d-owned-rgba-v1' }]) {
    const projected = resourceProductProjection({ allocations: canvasLedger() }, proof);
    assert.equal(projected.values.textureSide, null); assert.equal(projected.values.deviceTextureLimit, null);
    assert.equal(projected.values.gpuBytes, 200); assert.equal(projected.values.unusedHandles, null);
    assert.equal(projected.allocationCoverage.complete, false); assert.equal(projected.allocationCoverage.textureLimits, false);
    assert.deepEqual(projected.rendererOwnership, canvasLedger().rendererOwnership);
  }
  const invented = canvasLedger(); invented.textureSide = 0; invented.deviceTextureLimit = 4096; invented.coverage.textureLimits = true;
  assert.equal(resourceProductProjection({ allocations: invented }).allocationCoverage.complete, false);
});

test('renderer diagnostics retain only bounded ownership fields without dropping an unknown API into an empty list', () => {
  const ledger = canvasLedger();
  ledger.rendererOwnership.appOwnedTextureAPIs = ['webgpu', 'private content'];
  ledger.rendererOwnership.privatePrompt = 'private content';
  const projected = resourceProductProjection({ allocations: ledger });
  assert.equal(projected.rendererOwnership.appOwnedTextureAPIs, null);
  assert(!JSON.stringify(projected).includes('private content'));
  assert.equal(projected.allocationCoverage.complete, false);
});

test('resource artifacts preserve Canvas2D N/A declarations without inventing a queried device limit', async t => {
  const { sampler, runTimer } = await fakeSampler(t, { ledger: canvasLedger });
  await sampler.start(); await runTimer(); const evidence = await sampler.stop();
  const saved = JSON.parse(await readFile(evidence.artifact.path, 'utf8'));
  assert.equal(evidence.complete, false); assert.equal(evidence.peaks.textureSide, null); assert.equal(evidence.peaks.deviceTextureLimit, null);
  for (const sample of saved.samples) {
    assert.equal(sample.rendererOwnership.contract, 'canvas2d-owned-rgba-v1');
    assert.equal(sample.rendererOwnershipProof, null); assert.equal(sample.textureSide, null); assert.equal(sample.deviceTextureLimit, null);
    assert.equal(sample.allocationCoverage.complete, false);
  }
});

test('sampler seals exact metadata bytes and keeps absent ledgers explicitly incomplete', async t => {
  const { sampler, commands, runTimer } = await fakeSampler(t);
  assert.equal(sampler.identity(), null); await sampler.start(); const identity = sampler.identity(); assert.match(identity, /^sha256:[0-9a-f]{64}$/);
  await runTimer(); const measured = await sampler.measure();
  assert.equal(measured.browserRssBytes, 21 * 1024); assert.equal(measured.backendRssBytes, 41 * 1024); assert.equal(measured.settledBytes, 62 * 1024);
  assert.equal(measured.cpuBytes, null); assert.equal(measured.gpuBytes, null); assert.equal(measured.unusedHandles, null);
  assert.equal(sampler.evidence().sha256, null);
  const evidence = await sampler.stop(), bytes = await readFile(evidence.artifact.path), saved = JSON.parse(bytes);
  assert.equal(evidence.sha256, 'sha256:' + createHash('sha256').update(bytes).digest('hex')); assert.equal(evidence.artifact.bytes, bytes.length);
  assert.equal(evidence.complete, false); assert(evidence.missing.includes('complete-product-allocation-ledger-unavailable'));
  assert.equal(saved.roots.find(root => root.kind === 'worker').pid, 90); assert.equal(sampler.identity(), identity);
  assert(!bytes.includes(Buffer.from('secret caption'))); assert.equal(saved.samples.length, evidence.counts.samples);
  assert(commands.every(args => !args.join(',').match(/comm|args|command/)));
  assert.deepEqual(await sampler.stop(), evidence); await assert.rejects(sampler.measure(), /not running/);
});

test('PID reuse invalidates attribution rather than counting a replacement process', async t => {
  const { sampler, recycleRoot } = await fakeSampler(t, { ledger: completeLedger });
  await sampler.start(); const identity = sampler.identity(); recycleRoot(); const measured = await sampler.measure();
  assert.equal(measured.browserRssBytes, null); assert.equal(measured.backendRssBytes, null); assert.equal(measured.settledBytes, null);
  const evidence = await sampler.stop(); assert.equal(evidence.complete, false); assert.equal(sampler.identity(), identity);
  assert(evidence.missing.includes('process-tree-or-birth-observation-unavailable'));
});

test('descendant PID recycling between RSS and birth snapshots invalidates its sample', async t => {
  const { sampler, recycleDescendant } = await fakeSampler(t, { ledger: completeLedger });
  await sampler.start(); recycleDescendant(); const measured = await sampler.measure();
  assert.equal(measured.browserRssBytes, null); assert.equal(measured.settledBytes, null);
  const evidence = await sampler.stop(); assert.equal(evidence.complete, false);
  assert(evidence.missing.includes('process-tree-or-birth-observation-unavailable'));
});

test('actual scheduled gaps cannot be hidden by complete point-in-time ledgers', async t => {
  const { sampler, runTimer } = await fakeSampler(t, { ledger: completeLedger });
  await sampler.start(); await runTimer(350); const evidence = await sampler.stop();
  assert.equal(evidence.complete, false); assert(evidence.maximumGapMs >= 450); assert(evidence.counts.missedIntervals >= 3);
  assert(evidence.missing.includes('sampling-gap-over-two-intervals'));
});

test('sample bound retains existing observations and prevents a complete claim', async t => {
  const { sampler } = await fakeSampler(t, { ledger: completeLedger, hooks: { maxEntries: 2 } });
  await sampler.start(); await sampler.measure(); await sampler.measure(); const evidence = await sampler.stop();
  assert.equal(evidence.counts.samples, 2); assert.equal(evidence.complete, false); assert(evidence.missing.includes('resource-sample-limit'));
  assert.equal(JSON.parse(await readFile(evidence.artifact.path, 'utf8')).samples.length, 2);
});

test('complete evidence requires a sealed continuous sampler and every explicit allocation coverage field', async t => {
  const { sampler, runTimer } = await fakeSampler(t, { ledger: completeLedger });
  await sampler.start(); await runTimer(); assert.equal(sampler.evidence().complete, false);
  const evidence = await sampler.stop(); assert.equal(evidence.complete, true); assert.deepEqual(evidence.missing, []);
});

test('an unresponsive renderer leaves one bounded observation and does not block sealing', async t => {
  let reads = 0;
  const { sampler } = await fakeSampler(t, { hooks: { productTimeoutMs: 5, productSnapshot: () => { reads++; return new Promise(() => {}); } } });
  await sampler.start(); await sampler.measure(); const evidence = await sampler.stop();
  assert.equal(reads, 1); assert.equal(evidence.complete, false);
  assert(evidence.missing.includes('read-only-product-resource-snapshot-unavailable'));
  assert.match(evidence.sha256, /^sha256:[0-9a-f]{64}$/);
});

test('a failed artifact seal closes the owned handle and cannot report complete evidence', async t => {
  let closes = 0;
  const { sampler } = await fakeSampler(t, { hooks: { open: async () => ({ writeFile: async () => {}, sync: async () => { throw Error('Injected sync failure'); }, close: async () => { closes++; } }) } });
  await sampler.start(); await assert.rejects(sampler.stop(), /Injected sync failure/);
  assert.equal(closes, 1); assert.equal(sampler.evidence().complete, false); assert.equal(sampler.evidence().sha256, null);
  assert(sampler.evidence().missing.includes('resource-artifact-seal-failed'));
  await assert.rejects(sampler.stop(), /Injected sync failure/); assert.equal(closes, 1);
});

test('a partially persisted sample is never sealed under a false successful-write hash', async t => {
  let fail = false, writes = 0, closes = 0, persisted = '';
  const { sampler } = await fakeSampler(t, { hooks: { open: async () => ({
    writeFile: async text => { writes++; persisted += fail ? text.slice(0, 12) : text; if (fail) throw Error('Injected partial write'); },
    sync: async () => { throw Error('Incomplete bytes must never be synced as a sealed artifact'); }, close: async () => { closes++; },
  }) } });
  await sampler.start(); fail = true; await assert.rejects(sampler.measure(), /Injected partial write/); const previousWrites = writes;
  const evidence = await sampler.stop();
  assert(persisted.length > 12); assert.equal(writes, previousWrites); assert.equal(closes, 1);
  assert.equal(evidence.sha256, null); assert.equal(evidence.artifact.bytes, null); assert.equal(evidence.complete, false); assert(evidence.missing.includes('resource-artifact-write-failed'));
});
