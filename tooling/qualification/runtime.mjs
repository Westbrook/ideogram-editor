import { retainDiagnosticEvidence } from './campaigns/diagnostic-evidence.mjs';
import { startEvidenceMonitor, retainEvidenceAudit } from './evidence-volume.mjs';
// Exploratory real raster/storage observations. This is NOT a PERF P/Q3 campaign.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, createReadStream, openSync, writeFileSync } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { campaignJobs } from './manifest.mjs';
import { acquireTimingLock, timingHostIdentity, timingLockDirectory } from './campaigns/host.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MiB = 1024 * 1024;
const GUARD = join(REPO, 'tests/store/no-network.mjs');
const manifestPath = join(REPO, 'tests/raster/fixtures/resource-inputs.json');
const sha256 = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const serializableError = error => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) });
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const LIMITS = [
  'Exploratory local observations only; no P/Q3/E qualification, approved baseline, or A-R01 closure.',
  '2048x2048 and 5000x5000 raster dimensions match W1/W2, but one raster contribution, zero document layers/history/jobs, and uniform-white inputs are not those complete workloads.',
  'Cold means fresh Node process and empty writer root. OS/filesystem caches are uncontrolled. Warm retains the process/writer/object store after one unscored prime.',
  'Each raster operation creates its actual fresh worker, verifies sealed codecs, disables Sharp cache, and uses concurrency one; warm does not mean retained decoder cache.',
  'No browser/GPU/physical display/native IME, full editor lifecycle, transfer shaping, provider request, or exclusive/qualified H/C host claim.',
  'Whole-process RSS includes this driver and all worker threads. High-water RSS is cumulative within a warm process, not an independent per-operation peak.',
  'Raw failures, refused admission, timed-out/missing samples and primes are retained. No retry, ceiling relaxation, or successful-only passing statistic.',
];

// The established perf:runtime entry point supports explicit P/Q3 dispatch.
// Without --campaign it retains the separately labelled exploratory protocol.
export function routeRuntimeArguments(args) {
  const positions = args.flatMap((value, index) => value === '--campaign' ? [index] : []);
  if (!positions.length) return null;
  if (positions.length !== 1) throw Error('Duplicate --campaign selection');
  const index = positions[0], value = args[index + 1];
  if (!value || value.startsWith('--')) throw Error('Missing --campaign value');
  if (['P', 'Q3'].includes(value)) return [...args];
  if (args.includes('--jobs')) throw Error('A campaign job shorthand cannot also declare --jobs');
  const selected = value.split(',');
  if (new Set(selected).size !== selected.length) throw Error('Duplicate campaign job');
  const family = ['P', 'Q3'].find(campaign => selected.every(id => campaignJobs(campaign, 'adapters').includes(id)));
  if (!family) throw Error('Choose P/Q3 or implemented jobs from one campaign family');
  const routed = [...args]; routed[index + 1] = family;
  return [...routed, '--jobs', selected.join(',')];
}

export function optionsFromArgs(args) {
  const values = { sizes: 'normal,maximum', formats: 'png', cold: 1, warm: 1, timeoutSeconds: 600 };
  const known = new Set(['sizes', 'formats', 'cold', 'warm', 'timeout-seconds', 'output']);
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !known.has(name) || seen.has(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Expected unique --sizes, --formats, --cold, --warm, --timeout-seconds, or --output values');
    seen.add(name); values[name === 'timeout-seconds' ? 'timeoutSeconds' : name] = args[i + 1];
  }
  for (const key of ['cold', 'warm', 'timeoutSeconds']) {
    if (!/^\d+$/.test(String(values[key]))) throw Error(`Invalid ${key}`);
    values[key] = Number(values[key]);
  }
  if (values.cold < 1 || values.cold > 5 || values.warm < 1 || values.warm > 5) throw Error('Cold and warm repeats must each be 1..5');
  if (values.timeoutSeconds < 10 || values.timeoutSeconds > 1800) throw Error('Per-operation timeout must be 10..1800 seconds');
  for (const [key, allowed] of [['sizes', ['normal', 'maximum']], ['formats', ['png', 'jpeg', 'webp-lossy', 'webp-lossless']]]) {
    values[key] = String(values[key]).split(',');
    if (new Set(values[key]).size !== values[key].length || values[key].some(v => !allowed.includes(v))) throw Error(`Invalid ${key}`);
  }
  return values;
}

export function makePlan(options, manifest) {
  const names = { png: 'png.png', jpeg: 'jpeg.jpg', 'webp-lossy': 'webp-lossy.webp', 'webp-lossless': 'webp-lossless.webp' };
  const cells = [];
  for (const size of options.sizes) for (const format of options.formats) {
    const name = `${size === 'normal' ? 'normal' : 'max'}-${size === 'maximum' && format === 'jpeg' ? 'progressive-' : ''}${names[format]}`;
    const fixture = manifest.fixtures.find(f => f.file === `tests/raster/fixtures/${name}`);
    if (!fixture) throw Error('Missing sealed fixture: ' + name);
    const side = size === 'normal' ? 2048 : 5000;
    if (fixture.width !== side || fixture.height !== side || !/^[a-f0-9]{64}$/.test(fixture.sha256) || !Number.isSafeInteger(fixture.bytes) || fixture.bytes < 1) throw Error('Invalid fixture declaration');
    cells.push({ id: `${size}-${format}`, size, format, fixture: { ...fixture }, dimensions: { width: side, height: side }, cold: options.cold, warm: options.warm, primes: 1 });
  }
  return {
    schemaVersion: 1, kind: 'exploratory-runtime-plan', qualification: false,
    limits: LIMITS, cells, operationTimeoutMs: options.timeoutSeconds * 1000,
    cacheProtocol: { cold: 'One fresh process/root per scored sample.', warm: 'One independent fresh process/root per cell: one unscored complete prime, then scored repetitions in that process/root. Stop this cohort after any noncompleted sample.' },
    phases: ['stage-finalize', 'decode-prepare', 'review', 'approve-import', 'compose', 'export', 'verify-retained-output'],
    expected: { scored: cells.length * (options.cold + options.warm), primes: cells.length, childProcesses: cells.length * (options.cold + 1) },
    // Conservative disk headroom for independent roots, staging/final overlap, and interrupted jobs; not a product budget amendment.
    estimatedDiskAdmissionBytes: String(cells.reduce((sum, cell) => sum + BigInt(cell.fixture.width * cell.fixture.height * 4 * 6) * BigInt(options.cold + options.warm + 1), 1024n * 1024n * 1024n)),
    resourceCeilingBytes: 512 * MiB,
  };
}

export async function fileIdentity(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Expected an ordinary file: ' + path);
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: MiB })) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: 'sha256:' + hash.digest('hex') };
}

export async function verifyFixture(fixture, repo = REPO) {
  if (!/^tests\/raster\/fixtures\/[a-z0-9-]+\.(png|jpg|webp)$/.test(fixture.file)) throw Error('Unexpected fixture path');
  const identity = await fileIdentity(join(repo, fixture.file));
  if (identity.bytes !== fixture.bytes || identity.sha256 !== 'sha256:' + fixture.sha256) throw Error('Fixture identity mismatch: ' + fixture.file);
  return identity;
}

export function whitePixelHash(width, height) {
  assert(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 && width * height <= 25000000);
  let remaining = width * height * 4;
  const hash = createHash('sha256'), white = Buffer.alloc(Math.min(MiB, remaining), 255);
  while (remaining) { const n = Math.min(white.length, remaining); hash.update(white.subarray(0, n)); remaining -= n; }
  return 'sha256:' + hash.digest('hex');
}

async function codeIdentity() {
  const files = ['package.json', 'package-lock.json', 'tooling/qualification/runtime.mjs', 'tests/store/no-network.mjs', 'tests/raster/fixtures/resource-inputs.json'];
  async function walk(path) {
    for (const entry of (await readdir(join(REPO, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path + '/' + entry.name;
      if (entry.isSymbolicLink()) throw Error('Unexpected source/build symlink: ' + child);
      if (entry.isDirectory()) await walk(child);
      else if (/\.(ts|js|json|wasm)$/.test(entry.name)) files.push(child);
    }
  }
  for (const path of ['src', 'server', 'dist/local']) await walk(path);
  const identities = [];
  for (const path of files.sort()) identities.push({ path, ...await fileIdentity(join(REPO, path)) });
  return { hash: sha256(JSON.stringify(identities)), files: identities };
}

export function summarize(plan, groups) {
  const samples = groups.flatMap(group => group.samples ?? []), scored = samples.filter(s => s.scored), primes = samples.filter(s => !s.scored);
  const counts = { plannedScored: plan.expected.scored, plannedPrimes: plan.expected.primes, observedScored: scored.length, observedPrimes: primes.length, completedScored: scored.filter(s => s.outcome === 'completed').length, completedPrimes: primes.filter(s => s.outcome === 'completed').length };
  const expected = new Map(), seen = new Set(), integrityErrors = [];
  for (const cell of plan.cells) {
    for (let n = 1; n <= cell.cold; n++) expected.set(`${cell.id}/cold/${n}`, { count: 1, cache: 'cold' });
    expected.set(`${cell.id}/warm/1`, { count: cell.warm + cell.primes, cache: 'warm' });
  }
  for (const group of groups) {
    const key = `${group.cell?.id}/${group.cache}/${group.ordinal}`, cohort = expected.get(key);
    if (!cohort || seen.has(key)) { integrityErrors.push('Unknown or duplicate group: ' + key); continue; }
    seen.add(key);
    const present = group.samples ?? [];
    if (present.length > cohort.count || group.outcome === 'completed' && present.length !== cohort.count) integrityErrors.push('Wrong completed sample count: ' + key);
    for (let index = 0; index < present.length; index++) {
      const sample = present[index];
      if (sample.sequence !== index + 1 || sample.scored !== (cohort.cache === 'cold' || index > 0)) integrityErrors.push('Wrong sequence/cache/prime: ' + key);
      if (sample.outcome === 'completed' && (JSON.stringify(sample.phases?.map(p => p.name)) !== JSON.stringify(plan.phases) || sample.phases.some(p => p.outcome !== 'completed' || !Number.isFinite(p.elapsedMs) || p.elapsedMs < 0))) integrityErrors.push('Missing completed phase evidence: ' + key);
    }
  }
  const failures = groups.filter(g => ['failed', 'timed-out', 'missing-receipt'].includes(g.outcome)).length + samples.filter(s => ['failed', 'timed-out'].includes(s.outcome)).length;
  const complete = counts.completedScored === counts.plannedScored && counts.completedPrimes === counts.plannedPrimes && groups.length === plan.expected.childProcesses && groups.every(g => g.outcome === 'completed');
  return { qualification: false, outcome: failures || integrityErrors.length ? 'failed' : complete ? 'completed-exploratory' : 'incomplete', counts, integrityErrors, statistics: 'Raw phase durations only; no pooled percentile, performance baseline, or qualified ceiling verdict.' };
}

async function createOutput(path) {
  const artifactRoot = join(await realpath(REPO), 'artifacts'), output = resolve(REPO, path);
  if (!output.startsWith(artifactRoot + sep)) throw Error('Output must be a new directory beneath this checkout artifacts/');
  const components = relative(artifactRoot, dirname(output)).split(sep).filter(Boolean);
  await mkdir(artifactRoot, { recursive: true });
  let current = artifactRoot;
  for (const component of ['', ...components]) {
    if (component) { current = join(current, component); await mkdir(current, { recursive: true }); }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw Error('Output parent must be canonical and nonsymlinked');
  }
  await mkdir(output, { mode: 0o700 }); // No reuse, overwrite, or deletion of previous campaigns.
  return output;
}

function environment() {
  let cpu = null, ram = null;
  try { cpu = cpus().map(c => c.model); } catch {}
  try { ram = totalmem(); } catch {}
  return { platform: platform(), architecture: arch(), kernel: release(), node: process.versions, cpuModels: cpu, totalMemoryBytes: ram, qualifiedHost: false, unmeasured: ['OS marketing/build identity', 'exclusive host occupancy', 'physical core pinning', 'power mode', 'GPU/driver/display', 'OS cache state'] };
}

export async function runWorker(spec) {
  if (!globalThis.__storeNetworkCounters || !process.execArgv.some(arg => arg.includes('no-network.mjs'))) throw Error('Run with the existing tests/store/no-network.mjs preload');
  if (process.versions.node !== '26.10.0') throw Error('Use pinned Node 26.10.0');
  await verifyFixture(spec.cell.fixture);
  const facts = { schemaVersion: 1, kind: 'exploratory-runtime-process', qualification: false, cell: spec.cell, cache: spec.cache, ordinal: spec.ordinal, root: join(dirname(spec.receipt), 'store'), startedAt: new Date().toISOString(), environment: environment(), samples: [], outcome: 'incomplete', limits: LIMITS };
  const start = performance.now(); let writer, cumulativePeak = process.memoryUsage().rss;
  const sampleRSS = () => { cumulativePeak = Math.max(cumulativePeak, process.memoryUsage().rss); };
  const sampling = setInterval(sampleRSS, 20); sampling.unref();
  const trace = async value => {
    // An append-only event stream survives timeout/kill even if final receipt cannot be written.
    await writeFile(spec.receipt + '.events.jsonl', JSON.stringify({ at: new Date().toISOString(), monotonicMs: performance.now(), ...value }) + '\n', { flag: 'a', mode: 0o600 });
  };
  try {
    await mkdir(facts.root, { mode: 0o700 });
    const { openWriter } = await import(pathToFileURL(join(REPO, 'dist/local/server/storage/writer.js')).href);
    const { EMPTY_EXPECTED_VERSIONS } = await import(pathToFileURL(join(REPO, 'dist/local/src/protocol/store.js')).href);
    writer = await openWriter({ root: facts.root }, { effectCounters: globalThis.__storeNetworkCounters.shared });
    await writer.protocolDefaults();
    const sessionHash = createHash('sha256').update(randomUUID()).digest('hex'), clientId = 'runtime-' + randomUUID(), expires = Date.now() + 12 * 60 * 60 * 1000;
    const auth = () => ({ clientId, sessionHash, now: Date.now(), expires });
    await writer.rememberClient(sessionHash, clientId, expires);
    const golden = whitePixelHash(spec.cell.fixture.width, spec.cell.fixture.height);
    for (let i = 0; i < spec.count; i++) {
      const sample = { sequence: i + 1, scored: spec.cache === 'cold' || i > 0, cache: spec.cache, startedAt: new Date().toISOString(), phases: [], outcome: 'incomplete', rssBefore: process.memoryUsage().rss };
      facts.samples.push(sample); const began = performance.now();
      await trace({ event: 'sample-start', sequence: sample.sequence, scored: sample.scored });
      async function phase(name, action) {
        const entry = { name, startedAt: new Date().toISOString(), startMonotonicMs: performance.now(), rssBefore: process.memoryUsage().rss };
        sample.phases.push(entry);
        await trace({ event: 'phase-start', sequence: sample.sequence, phase: entry });
        // Writer work cannot be safely cancelled by racing a Promise. A hung phase
        // kills this isolated child after synchronously retaining its timeout event.
        // The controller preserves its root/log and reconstructs the partial sample.
        const watchdog = setTimeout(() => {
          writeFileSync(spec.receipt + '.events.jsonl', JSON.stringify({ at: new Date().toISOString(), event: 'phase-timeout', sequence: sample.sequence, phase: { ...entry, elapsedMs: performance.now() - entry.startMonotonicMs, outcome: 'timed-out' }, boundary: 'phase operation or diagnostic capture', timeoutMs: spec.timeoutMs }) + '\n', { flag: 'a', mode: 0o600 });
          process.exit(124);
        }, spec.timeoutMs);
        try { const result = await action(entry); entry.outcome = 'completed'; return result; }
        catch (error) { entry.outcome = error?.code === 'RESOURCE_PENDING' ? 'resource-refused' : error?.code === 'OPERATION_TIMEOUT' ? 'timed-out' : 'failed'; entry.error = serializableError(error); throw error; }
        finally {
          entry.elapsedMs = performance.now() - entry.startMonotonicMs; entry.rssAfter = process.memoryUsage().rss; sampleRSS();
          entry.processCumulativeHighWaterRSS = process.resourceUsage().maxRSS * 1024;
          try {
            try { const read = await writer.readDiagnostics(); try { entry.rasterDiagnostics = await retainDiagnosticEvidence(dirname(spec.receipt), 'phase-' + sample.sequence + '-' + sample.phases.length, read.value.rasters); } finally { read.release(); } } catch (error) { entry.diagnosticsError = serializableError(error); throw error; }
            await trace({ event: 'phase-end', sequence: sample.sequence, phase: entry });
          } finally { clearTimeout(watchdog); }
        }
      }
      async function command(body, entry, asset = false) {
        const envelope = { protocolVersion: 1, command: { schemaVersion: 1, commandId: randomUUID(), clientId, sessionId: 'runtime-local', correlationId: randomUUID(), causationId: null, transactionId: randomUUID(), documentId: null, expectedDocumentRevision: null, expectedEntityVersions: EMPTY_EXPECTED_VERSIONS, issuedAt: new Date().toISOString(), body } };
        entry.commandId = envelope.command.commandId; entry.commandType = body.type;
        const started = performance.now(); await writer[asset ? 'assetCommand' : 'rasterCommand'](Buffer.from(JSON.stringify(envelope)), auth());
        for (;;) {
          const state = await writer.commandState(entry.commandId);
          if (state.record) {
            entry.receipt = state.record.receipt;
            entry.commandToObservedReceiptMs = performance.now() - started;
            entry.receiptObservation = 'Submission to observed durable receipt, with 5ms polling; phase elapsed additionally includes event read, and staging where applicable. Diagnostics are outside phase elapsed.';
            if (entry.receipt.status !== 'accepted') throw Object.assign(Error('Command rejected: ' + JSON.stringify(entry.receipt)), { code: 'COMMAND_REJECTED' });
            const batch = await writer.events(String(BigInt(entry.receipt.fromSeq) - 1n));
            const event = batch.events.find(e => e.commandId === entry.commandId);
            assert(event, 'Accepted command must have its durable event'); return event.payload;
          }
          if (state.pending?.phase === 'waiting-for-resources') { entry.pending = state.pending; throw Object.assign(Error('Resource admission refused; no automatic retry'), { code: 'RESOURCE_PENDING' }); }
          if (performance.now() - started >= spec.timeoutMs) throw Object.assign(Error('Command did not reach a durable terminal receipt'), { code: 'OPERATION_TIMEOUT' });
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      try {
        const original = await phase('stage-finalize', async entry => {
          const fixture = spec.cell.fixture, id = randomUUID(), mediaType = 'image/' + fixture.format;
          await writer.assetCreate({ protocolVersion: 1, stagingId: id, purpose: 'image', expectedBytes: String(fixture.bytes), sha256: 'sha256:' + fixture.sha256, mediaType }, auth());
          let offset = 0;
          for await (const bytes of createReadStream(join(REPO, fixture.file), { highWaterMark: MiB })) {
            const token = await writer.assetBeginChunk(id, String(offset), bytes.length, auth()); await writer.assetChunk(token, bytes, auth()); offset += bytes.length;
          }
          entry.stagedBytes = offset;
          return (await command({ type: 'FinalizeStaging', stagingId: id, expectedSha256: 'sha256:' + fixture.sha256 }, entry, true)).asset;
        });
        const preview = await phase('decode-prepare', async entry => (await command({ type: 'PrepareRaster', assetId: original.id }, entry)).asset);
        const review = await phase('review', entry => command({ type: 'ReviewRaster', assetId: preview.id }, entry));
        const approved = await phase('approve-import', async entry => (await command({ type: 'ApproveRaster', assetId: preview.id, reviewId: review.reviewId, reviewHash: review.reviewHash }, entry)).asset);
        assert.equal(approved.raster.width, spec.cell.fixture.width); assert.equal(approved.raster.height, spec.cell.fixture.height);
        assert.equal(approved.raster.pixels.hash, golden, 'Independent uniform-white pixel golden');
        const composed = await phase('compose', async entry => (await command({ type: 'ComposeRaster', width: approved.raster.width, height: approved.raster.height, layers: [{ assetId: approved.id, transform: [1, 0, 0, 1, 0, 0], opacity: 1, mask: null }] }, entry)).asset);
        assert.equal(composed.raster.pixelIdentity, approved.raster.pixelIdentity, 'Identity composition must preserve every pixel');
        const exported = await phase('export', async entry => (await command({ type: 'ExportRaster', assetId: composed.id }, entry)).asset);
        assert.equal(exported.raster.pixelIdentity, approved.raster.pixelIdentity, 'Export must preserve every pixel');
        await phase('verify-retained-output', async entry => {
          entry.manifest = await writer.rasterManifest(exported.id);
          // Sampling requires a canonical-raster asset; the exported asset is canonical-png.
          const pixel = await writer.rasterSample(composed.id, 0, 0); assert.deepEqual(pixel.rgba, [255, 255, 255, 255]);
          const { handle, asset } = await writer.assetVerify(exported.id), hash = createHash('sha256'); let bytes = 0;
          try {
            while (bytes < Number(asset.blob.byteLength)) {
              const chunk = await writer.assetContent(exported.id, handle, String(bytes), Math.min(MiB, Number(asset.blob.byteLength) - bytes));
              if (!chunk.length) throw Error('Unexpected empty retained output'); hash.update(chunk); bytes += chunk.length;
            }
          } finally { await writer.assetRelease(handle); }
          entry.output = { bytes, hash: 'sha256:' + hash.digest('hex'), pixels: asset.raster.pixels, pixelIdentity: asset.raster.pixelIdentity };
          assert.equal(entry.output.hash, asset.blob.hash); assert.equal(String(bytes), asset.blob.byteLength);
          assert.equal(asset.raster.pixels.hash, golden);
        });
        sample.original = { blob: original.blob, assetId: original.id }; sample.result = { blob: exported.blob, pixels: exported.raster.pixels, assetId: exported.id };
        sample.outcome = 'completed';
      } catch (error) {
        sample.outcome = error?.code === 'RESOURCE_PENDING' ? 'resource-refused' : error?.code === 'OPERATION_TIMEOUT' ? 'timed-out' : 'failed'; sample.error = serializableError(error);
      } finally {
        sample.elapsedMs = performance.now() - began; sample.rssAfter = process.memoryUsage().rss;
        sample.processCumulativeHighWaterRSS = process.resourceUsage().maxRSS * 1024;
        if (sample.processCumulativeHighWaterRSS > 512 * MiB) { sample.resourceCeilingViolation = true; sample.outcome = 'failed'; }
        await trace({ event: 'sample-end', sample });
      }
      if (sample.outcome !== 'completed') break;
    }
    facts.outcome = facts.samples.some(s => ['failed', 'timed-out'].includes(s.outcome)) ? 'failed' : facts.samples.length === spec.count && facts.samples.every(s => s.outcome === 'completed') ? 'completed' : 'incomplete';
  } catch (error) { facts.outcome = 'failed'; facts.error = serializableError(error); }
  finally {
    try { if (writer) { const read = await writer.readDiagnostics(); try { facts.finalDiagnostics = await retainDiagnosticEvidence(dirname(spec.receipt), 'final', read.value); } finally { read.release(); } } } catch (error) { facts.diagnosticsError = serializableError(error); facts.outcome = 'failed'; }
    try { await writer?.close(); facts.writerClosed = true; } catch (error) { facts.closeError = serializableError(error); facts.outcome = 'failed'; }
    clearInterval(sampling); sampleRSS();
    facts.parentWriterNetworkCounters = globalThis.__storeNetworkCounters.read();
    if (Object.values(facts.parentWriterNetworkCounters).some(n => n !== 0)) facts.outcome = 'failed';
    facts.networkScope = 'Existing no-network preload enforced in parent/writer/raster workers. Displayed shared counters aggregate parent+writer only; raster workers have separate guard counters.';
    facts.sampledPeakRSS = cumulativePeak; facts.processHighWaterRSS = process.resourceUsage().maxRSS * 1024;
    if (facts.processHighWaterRSS > 512 * MiB) { facts.resourceCeilingViolation = true; facts.outcome = 'failed'; }
    facts.elapsedMs = performance.now() - start; facts.finishedAt = new Date().toISOString(); await json(spec.receipt, facts);
  }
  return facts;
}

async function launch(spec, folder) {
  await mkdir(folder, { mode: 0o700 }); const specPath = join(folder, 'input.json'); await json(specPath, spec);
  const argv = ['--import', GUARD, fileURLToPath(import.meta.url), '--worker', specPath];
  const log = openSync(join(folder, 'process.log'), 'wx', 0o600);
  const startedAt = new Date().toISOString(), began = performance.now(); let timedOut = false;
  const subprocess = spawn(process.execPath, argv, { cwd: REPO, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', log, log] });
  const timer = setTimeout(() => { timedOut = true; subprocess.kill('SIGKILL'); }, spec.timeoutMs * 7 * spec.count + 60000);
  const outcome = await new Promise(resolve => { subprocess.once('error', error => resolve({ exitCode: null, signal: null, error: serializableError(error) })); subprocess.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
  clearTimeout(timer); closeSync(log); timedOut ||= outcome.exitCode === 124;
  let receipt;
  try { receipt = JSON.parse(await readFile(spec.receipt, 'utf8')); } catch (error) {
    receipt = { cell: spec.cell, cache: spec.cache, ordinal: spec.ordinal, outcome: timedOut ? 'timed-out' : 'missing-receipt', samples: [], error: serializableError(error), partialReceipt: true };
    try { receipt.samples = recoverSamples(await readFile(spec.receipt + '.events.jsonl', 'utf8'), timedOut); }
    catch (traceError) { receipt.traceError = serializableError(traceError); }
  }
  if (timedOut) receipt.outcome = 'timed-out';
  if (outcome.exitCode !== 0 && receipt.outcome === 'completed') receipt.outcome = 'failed';
  const result = { ...receipt, process: { executable: process.execPath, argv, startedAt, elapsedMs: performance.now() - began, ...outcome, timedOut }, receipt: spec.receipt };
  await json(join(folder, 'process.json'), result); return result;
}

export function recoverSamples(events, timedOut = false) {
  const samples = new Map();
  for (const line of events.split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { break; } // A killed trailing append is incomplete evidence.
    if (event.event === 'sample-start') samples.set(event.sequence, { sequence: event.sequence, scored: event.scored, startedAt: event.at, phases: [], outcome: 'incomplete' });
    if (event.event === 'sample-end') samples.set(event.sample.sequence, event.sample);
    if (event.event === 'phase-end' || event.event === 'phase-timeout') {
      const sample = samples.get(event.sequence);
      if (sample) { sample.phases.push(event.phase); if (event.event === 'phase-timeout') sample.outcome = 'timed-out'; }
    }
  }
  const result = [...samples.values()];
  if (timedOut && result.at(-1)?.outcome === 'incomplete') result.at(-1).outcome = 'timed-out';
  return result;
}

export async function runCampaign(plan, output, launchGroup = launch) {
  const groups = [];
  for (const cell of plan.cells) {
    for (let i = 0; i < cell.cold; i++) {
      const folder = join(output, cell.id + '-cold-' + (i + 1));
      groups.push(await launchGroup({ cell, cache: 'cold', ordinal: i + 1, count: 1, timeoutMs: plan.operationTimeoutMs, receipt: join(folder, 'receipt.json') }, folder));
    }
    const folder = join(output, cell.id + '-warm');
    groups.push(await launchGroup({ cell, cache: 'warm', ordinal: 1, count: cell.primes + cell.warm, timeoutMs: plan.operationTimeoutMs, receipt: join(folder, 'receipt.json') }, folder));
  }
  return { groups, summary: summarize(plan, groups) };
}

// Exploratory observations contend with formal runtime and developer work on
// the same fixed host lock. A changed workspace/TMPDIR never creates a lane.
export async function withExploratoryTimingLock(action, { timingLease } = {}) {
  return withTimingLockAt(await timingLockDirectory(), action, { timingLease });
}
// Explicit directory seam for isolated lock protocol tests; CLI callers always
// use the fixed physical-host directory through withExploratoryTimingLock.
export async function withTimingLockAt(directory, action, { timingLease } = {}) {
  const owner = await acquireTimingLock(directory, {
    host: timingHostIdentity(), receiptId: timingLease?.receiptId ?? randomUUID(), lease: timingLease ?? null,
  });
  try { return await action({ path: owner.path, identity: owner.identity, borrowed: owner.borrowed }); }
  finally { await owner.release(); }
}

async function main(args) {
  const routed = routeRuntimeArguments(args);
  if (routed) { const { main: campaignMain } = await import('./campaigns/run.mjs'); return campaignMain(routed); }
  if (args[0] === '--worker') {
    if (args.length !== 2 || !isAbsolute(args[1])) throw Error('Invalid worker invocation');
    const facts = await runWorker(JSON.parse(await readFile(args[1], 'utf8')));
    process.exitCode = facts.outcome === 'completed' ? 0 : facts.outcome === 'incomplete' ? 2 : 1; return;
  }
  const usage = 'Usage: node tooling/qualification/runtime.mjs [plan|run] [--sizes normal,maximum] [--formats png,jpeg,webp-lossy,webp-lossless] [--cold 1..5] [--warm 1..5] [--timeout-seconds 10..1800] [--output artifacts/NEW-DIRECTORY]. Default is read-only plan. Run needs the existing no-network preload and current server build.';
  if (args[0] === '--help') { console.log(usage + '\nExplicit campaigns: [plan|run] --campaign P|Q3 [--jobs C1,H1,...] or --campaign C1|I3|...; campaign output is separate from exploratory observations.'); return; }
  const mode = args.shift() ?? 'plan';
  if (!['plan', 'run'].includes(mode)) throw Error(usage);
  const options = optionsFromArgs(args), plan = makePlan(options, JSON.parse(await readFile(manifestPath, 'utf8')));
  if (mode === 'plan') { console.log(JSON.stringify(plan, null, 2)); return; }
  if (!options.output) throw Error('Run requires --output artifacts/NEW-DIRECTORY');
  if (process.versions.node !== '26.10.0' || !globalThis.__storeNetworkCounters) throw Error('Use pinned Node with --import ./tests/store/no-network.mjs');
  await withExploratoryTimingLock(async timingLock => {
    await access(join(REPO, 'dist/local/server/storage/writer.js'));
    for (const cell of plan.cells) await verifyFixture(cell.fixture);
    const before = await codeIdentity(), disk = await statfs(REPO, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(plan.estimatedDiskAdmissionBytes)) throw Error('Insufficient free disk for this retained exploratory campaign plus 1GiB margin');
    const output = await createOutput(options.output), startedAt = new Date().toISOString();
    const evidenceMonitor = await startEvidenceMonitor({ output, campaignId: 'exploratory-' + randomUUID(), allowUnavailable: true, onAlarm: alarm => console.error(JSON.stringify({ evidenceStorageAlarm: alarm })) });
    let retainedReceiptPath = null, storageOutcome = 'FAIL';
    try {
    await json(join(output, 'plan.json'), plan); await json(join(output, 'source-before.json'), before);
    const result = await runCampaign(plan, output);
    const after = await codeIdentity(); await json(join(output, 'source-after.json'), after);
    result.sourceStable = before.hash === after.hash;
    if (!result.sourceStable && result.summary.outcome !== 'failed') result.summary.outcome = 'incomplete-source-changed';
    const receipt = { schemaVersion: 1, kind: 'exploratory-runtime-campaign', qualification: false, evidenceStorage: evidenceMonitor.reference, startedAt, finishedAt: new Date().toISOString(), environment: environment(), timingLock, nodeExecutable: { path: process.execPath, ...await fileIdentity(process.execPath) }, argv: process.argv, plan, ...result, limits: LIMITS };
    await json(join(output, 'receipt.json'), receipt); retainedReceiptPath = join(output, 'receipt.json'); storageOutcome = receipt.summary.outcome;
    console.log(JSON.stringify({ output, ...receipt.summary, sourceStable: receipt.sourceStable }));
    process.exitCode = receipt.summary.outcome === 'completed-exploratory' ? 0 : receipt.summary.outcome === 'failed' ? 1 : 2;
    } finally {
      const audit = await evidenceMonitor.finish({ receiptPath: retainedReceiptPath, outcome: storageOutcome });
      if (retainedReceiptPath) await retainEvidenceAudit(evidenceMonitor.reference, output);
      console.log(JSON.stringify({ evidenceStorage: { status: audit.status, qualification: audit.qualification } }));
      if (audit.status !== 'PASS' && process.exitCode !== 1) process.exitCode = audit.status === 'FAIL' ? 1 : 2;
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
