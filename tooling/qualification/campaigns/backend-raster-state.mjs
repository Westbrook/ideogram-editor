import { retainDiagnosticEvidence, diagnosticContext, detachedRasterPhase } from './diagnostic-evidence.mjs';
// Actual product raster, persistence and recovery operations. The caller owns
// cold-process versus retained-process cohorts. Preparation is never scored.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { auth, createProductFixture, encode, envelope, finish, phase, result } from './backend-common.mjs';
import { deterministicChunks, workloadDefinition, validateObserved } from './fixtures.mjs';
import { compositeActiveEvidence } from './raster-active-compute.mjs';

export const rasterStateOperations = Object.freeze(['raster.composite', 'raster.decode', 'raster.encode', 'state.snapshot-read', 'state.replay', 'state.command-accept-dispatch', 'asset.persist', 'asset.cache-lookup']);
const required = message => Object.assign(Error(message), { code: 'FIXTURE_REQUIRED' });

export function identifyRasterStateCell(cell) {
  if (!rasterStateOperations.includes(cell?.operation)) throw Object.assign(Error('Unsupported raster/state cell'), { code: 'CELL_UNSUPPORTED' });
  const p = cell.parameters ?? {}, specification = workloadDefinition(cell.workload);
  if (!['W1', 'W2', 'WNarrow'].includes(specification.id)) throw required('Raster/state cells require the declared W1, W2 or separate WNarrow fixture');
  if (cell.operation === 'raster.decode' && (!['png', 'jpeg', 'webp'].includes(p.format) || p.format === 'webp' && !['lossy', 'lossless'].includes(p.codec))) throw Error('Decode requires an exact PNG, JPEG or lossy/lossless WebP input');
  if (cell.operation === 'raster.encode' && (!['png', 'jpeg'].includes(p.format) || p.format === 'jpeg' && p.quality !== .9)) throw Error('Encode requires PNG or JPEG quality 0.9');
  if (cell.operation === 'state.replay' && !['snapshot-tail', 'full'].includes(p.mode)) throw Error('Replay requires an exact snapshot-tail or full mode');
  if (cell.operation === 'state.replay' && p.mode === 'snapshot-tail' && p.tailEvents !== 500) throw Error('Snapshot replay requires all 500 retained tail events');
  if (cell.operation === 'state.replay' && p.mode === 'full' && (cell.workload !== 'W2' || p.events !== 100000 || p.snapshot !== false)) throw Error('Full replay requires W2, 100000 events and no snapshot');
  if (cell.operation === 'asset.persist' && (p.bytes !== (cell.workload === 'W1' ? 8 : 32) * 1048576 || p.incompressible !== true)) throw Error('Persist requires the independent exact incompressible 8/32MiB cell');
  if (specification.id === 'WNarrow' && (cell.operation !== 'raster.decode' || p.width !== 8192 || p.height !== 3000)) throw Error('WNarrow is only the distinct 8192 by 3000 decode specimen');
  return { ...p, specification };
}

export function selectRasterSpecimen(context, cell) {
  const p = identifyRasterStateCell(cell), files = context.fixture?.corpus?.files;
  if (!Array.isArray(files)) throw required('The sealed workload must carry its actual generated raster corpus');
  const specimen = files.find(file => ['raster-original', 'raster-codec'].includes(file.role) && String(file.format).replace(/^image\//, '') === p.format && (p.format !== 'webp' || file.codec === p.codec) && file.width === p.specification.width && file.height === p.specification.height);
  if (!specimen) throw required(`Missing ${cell.workload} ${p.format}${p.codec ? ' ' + p.codec : ''} corpus specimen; no uniform substitute is permitted`);
  if (!/^sha256:[a-f0-9]{64}$/.test(specimen.sha256) || !/^[1-9][0-9]*$/.test(String(specimen.byteLength))) throw Error('Invalid sealed raster descriptor');
  return { ...specimen, format: p.format, path: resolve(context.fixture.root, specimen.path) };
}

async function stageSpecimen(f, specimen) {
  const before = await lstat(specimen.path);
  assert(before.isFile() && !before.isSymbolicLink()); assert.equal(String(before.size), specimen.byteLength);
  const stagingId = randomUUID(), digest = createHash('sha256'); let offset = 0;
  await f.writer.assetCreate({ protocolVersion: 1, stagingId, purpose: 'image', expectedBytes: specimen.byteLength, sha256: specimen.sha256, mediaType: 'image/' + specimen.format }, auth());
  for await (const bytes of createReadStream(specimen.path, { highWaterMark: 65536 })) {
    f.context.signal?.throwIfAborted(); digest.update(bytes);
    const token = await f.writer.assetBeginChunk(stagingId, String(offset), bytes.length, auth());
    await f.writer.assetChunk(token, bytes, auth()); offset += bytes.length;
  }
  const after = await lstat(specimen.path);
  assert.deepEqual([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs], [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
  assert.equal('sha256:' + digest.digest('hex'), specimen.sha256); assert.equal(String(offset), specimen.byteLength);
  const completed = await finish(f.writer, envelope({ type: 'FinalizeStaging', stagingId, expectedSha256: specimen.sha256 }), 'assetCommand', f.context.signal);
  const asset = completed.events.find(event => event.type === 'AssetRegistered')?.payload.asset; assert(asset); return asset;
}

/** Select only same-command records. Local monotonic lanes are never mixed or
 * subtracted. A missed/invalid matching trace cannot turn into a passing zero. */
export function rasterPhaseEvidence(diagnostics, commandId, name, observations, missing, expected) {
  const snapshots = diagnostics.rasters?.workerPhases ?? [];
  const matching = snapshots.filter(snapshot => snapshot.records?.some(record => record.context?.commandId === commandId));
  const rows = matching.flatMap(snapshot => snapshot.records.filter(record => record.context?.commandId === commandId && record.phase === name).map(record => ({ ...record, lane: snapshot.lane, clockOriginUnixMs: snapshot.clockOriginUnixMs })));
  observations.workerTelemetry = matching;
  if (matching.some(snapshot => snapshot.invalid || snapshot.dropped || snapshot.lane !== 'raster-worker')) missing.push('Required raster worker telemetry is incomplete or invalid');
  if (rows.length !== 1 || rows[0]?.outcome !== 'ok' || rows[0]?.context?.boundary !== (name === 'raster.decode' ? 'decoded' : 'observed') || !Number.isFinite(rows[0]?.durationMs) || rows[0]?.durationMs < 0 || Math.abs(rows[0].durationMs - (rows[0].endedMs - rows[0].startedMs)) > .001) { missing.push('One complete exact-command ' + name + ' product phase is required'); return []; }
  const phases = rows.map(record => ({ name: name === 'raster.composite' ? 'raster.composite.wall' : name, startMs: record.startedMs, endMs: record.endedMs, durationMs: record.durationMs, outcome: 'completed', clock: record.lane, context: record.context, boundary: name === 'raster.decode' ? 'Encoded input through normalized decoded raw file fsync; excludes staging and later PNG encode' : name === 'raster.encode' ? 'Actual product encoder through complete output file fsync; excludes later registration' : 'Product composite wall-time including row IO, fsync and cooperative yields' }));
  if (name === 'raster.composite') {
    const evidence = matching.length === 1 ? compositeActiveEvidence(matching[0], rows[0], expected) : { phase: null, missing: ['R10 requires one exact-command worker snapshot'] };
    missing.push(...evidence.missing); observations.activeCompute = matching[0]?.activeCompute ?? null;
    if (evidence.phase) phases.push(evidence.phase);
  }
  return phases;
}

async function allJobs(writer) { const jobs = []; let cursor = ''; do { const page = await writer.queueView(cursor); jobs.push(...page.jobs); cursor = page.nextCursor; } while (cursor); return jobs; }
async function clearLocalHolds(f, setup) {
  for (const job of await allJobs(f.writer)) {
    const held = job.attempts.find(attempt => attempt.hold); if (!held) continue;
    const body = held.state === 'not-started' ? { type: 'CancelUnstartedJob', jobId: job.id, expectedVersion: job.version } : held.state === 'submission-uncertain' ? { type: 'OverrideUncertainHold', jobId: job.id, attemptId: held.id, expectedVersion: job.version, acknowledgeOverlapAndChargeRisk: true } : null;
    if (!body) throw required('The copied fixture contains a live acknowledged hold; an isolated eligible dispatch slot is required');
    const request = envelope(body), receipt = await phase(setup, 'release-copied-emulator-hold', () => f.writer.queueCommand(encode(request), auth())); assert.equal(receipt.status, 'accepted');
  }
  const view = await f.writer.queueView();
  const receipt = await f.writer.queueCommand(encode(envelope({ type: 'SetSpendGuard', spendSessionId: view.session.id, expectedConfigVersion: view.session.version, cap: null })), auth()); assert.equal(receipt.status, 'accepted');
}

export async function createRasterStateFixture(context, cell) {
  const p = identifyRasterStateCell(cell);
  if (!context.fixture?.root || !context.fixture.seal || !context.fixture.documentId && cell.workload !== 'WNarrow') throw required('Raster/state operations need the actual sealed workload root and document identity');
  validateObserved(p.specification, context.fixture.observed);
  const f = await createProductFixture(cell.workload === 'WNarrow' ? { ...context, fixture: undefined } : { ...context, queueFixture: cell.operation === 'state.command-accept-dispatch' });
  f.rasterState = { operation: cell.operation, workload: cell.workload, p, serial: 0, setup: [], originalSeal: context.fixture.seal, root: f.root };
  const s = f.rasterState;
  try {
    if (cell.workload !== 'WNarrow') {
      s.document = await f.writer.document(f.documentId); s.image = await f.writer.imageState(f.documentId); s.capture = await f.writer.capture();
      assert(s.document && s.image, 'Actual workload document/image state must exist');
      assert.equal(s.document.width, p.specification.width); assert.equal(s.document.height, p.specification.height);
      assert.equal(s.image.layers.length, p.specification.layers); assert.equal(s.image.layers.filter(layer => layer.visible).length, p.specification.visibleLayers);
      assert.equal(s.capture.highWater, String(p.specification.events), 'Canonical fixture event count changed before the cell');
      assert.equal(String(BigInt(s.capture.highWater) - BigInt(s.capture.snapshot?.seq ?? '0')), '500', 'Canonical 500-event tail required');
      s.compositeAssetId = s.document.image?.compositeAssetId;
      assert(s.compositeAssetId, 'Complete fixture composite must be durable');
      s.composite = (await f.writer.assetProjection(s.compositeAssetId)).asset; assert(s.composite?.raster);
    }
    if (cell.operation === 'raster.decode') {
      s.specimen = selectRasterSpecimen(context, cell);
      s.original = await phase(s.setup, 'encoded-corpus-stage-and-verify-outside-decode', () => stageSpecimen(f, s.specimen));
    }
    if (cell.operation === 'raster.composite') {
      assert(s.image.layers.every(layer => layer.kind === 'image'), 'O2 raster workload must not silently omit native text');
      s.layers = s.image.layers.filter(layer => layer.visible).map(layer => ({ assetId: layer.assetId, transform: layer.layerToDocument, opacity: layer.opacity, mask: layer.mask }));
      for (const layer of s.layers) { const asset = (await f.writer.assetProjection(layer.assetId)).asset; assert(asset?.raster?.pixels, 'O2 must begin with real decoded canonical pixel inputs'); }
    }
    if (cell.operation === 'state.command-accept-dispatch') await clearLocalHolds(f, s.setup);
    if (cell.operation === 'state.replay' && p.mode === 'full') {
      // Only the owned copy's recomputable snapshot index is invalidated. All
      // source journal, receipts, object bytes and sealed source remain intact.
      await f.closeWriter();
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(f.root, 'metadata.sqlite'), { allowExtension: false });
      try { db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; DELETE FROM snapshot_roots; DELETE FROM snapshots; COMMIT;'); }
      finally { db.close(); }
      s.fullReplayReset = { cache: 'snapshot index only', retainedEvents: s.capture.highWater, sourceRootUnchanged: true };
    }
    f.resetCell = async (next, sample = {}) => {
      assert.equal(next.operation, s.operation); assert.equal(next.workload, s.workload);
      if (sample.cache === 'cold' && s.serial) throw required('Each cold sample requires a fresh campaign process and fixture');
      const phases = [];
      if (s.operation === 'state.replay') await phase(phases, 'writer-close-before-replay-clock', () => f.closeWriter());
      if (s.operation === 'asset.persist') {
        s.persistSeed = randomUUID(); const h = createHash('sha256'); s.persistBytes = Buffer.alloc(p.bytes); let offset = 0;
        for (const chunk of deterministicChunks(p.bytes, { seed: s.persistSeed, chunkBytes: 65536 })) { h.update(chunk); chunk.copy(s.persistBytes, offset); offset += chunk.length; }
        s.persistHash = 'sha256:' + h.digest('hex');
      }
      if (s.operation === 'asset.cache-lookup' && sample.cache === 'cold') await phase(phases, 'fresh-writer-before-cold-metadata-read', () => f.reopen());
      if (s.operation === 'state.command-accept-dispatch') {
        await clearLocalHolds(f, phases);
        const { prepareQueue } = await import('./backend-queue.mjs');
        s.prepared = await prepareQueue(f, phases);
        assert(f.queueWorker, 'Retained writer queue fixture required');
        s.queueBefore = await f.queueWorker.configure('ideogram/v4', { status: 'IN_QUEUE' });
      }
      s.serial++;
      return result(next, phases, { sample, root: f.root, fixtureSeal: s.originalSeal, resetOrdinal: s.serial, retainedWriter: s.operation !== 'state.replay', inputReadiness: s.operation === 'raster.composite' ? 'Decoded canonical visible layers with original transforms and masks' : s.operation === 'raster.decode' ? 'Original encoded corpus bytes durably staged; no prepared result reused' : s.operation === 'raster.encode' ? 'Canonical full-document composite raw pixels durable' : s.operation === 'state.replay' ? 'Writer closed outside replay clock; actual startup recovery inside clock' : 'Real product identity retained', operatingSystemCache: 'uncontrolled, never reported as purged', preparation: s.setup, fullReplayReset: s.fullReplayReset ?? null });
    };
    return f;
  } catch (error) { await f.close(); throw error; }
}

export async function readSnapshot(writer, id, signal) {
  const content = await writer.snapshotContent(id), digest = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0, rows = 0, pending = Buffer.alloc(0);
  try {
    while (bytes < Number(content.blob.byteLength)) {
      signal?.throwIfAborted(); const chunk = Buffer.from(await writer.content(content.handle, String(bytes), Math.min(65536, Number(content.blob.byteLength) - bytes)));
      assert(chunk.length, 'Snapshot stream made no progress'); bytes += chunk.length; digest.update(chunk);
      const part = Buffer.concat([pending, chunk]); let at = 0, end;
      while ((end = part.indexOf(10, at)) !== -1) { assert(end - at < 16384); JSON.parse(decoder.decode(part.subarray(at, end))); rows++; at = end + 1; }
      pending = part.subarray(at); assert(pending.length <= 16384);
    }
    assert.equal(pending.length, 0); assert.equal(String(bytes), content.blob.byteLength); assert.equal(String(rows), content.recordCount); assert.equal('sha256:' + digest.digest('hex'), content.blob.hash);
    return { snapshotId: id, bytes, rows, hash: content.blob.hash };
  } finally { await writer.dropContent(content.handle); }
}

export async function runCell(context, cell) {
  identifyRasterStateCell(cell);
  const owned = !context.productFixture, f = context.productFixture ?? await createRasterStateFixture(context, cell), s = f.rasterState;
  if (!s) throw required('Raster/state preparation must run before execution');
  const phases = [], missing = [], assertions = [], observations = { root: f.root, documentId: f.documentId, fixtureSeal: s.originalSeal, operation: cell.operation, cache: context.sample?.cache ?? null };
  try {
    if (!s.serial) observations.reset = await f.resetCell(cell, context.sample);
    if (cell.operation.startsWith('raster.')) {
      const body = cell.operation === 'raster.composite' ? { type: 'ComposeRaster', width: s.document.width, height: s.document.height, layers: s.layers } : cell.operation === 'raster.decode' ? { type: 'PrepareRaster', assetId: s.original.id } : { type: 'ExportRaster', assetId: s.compositeAssetId, options: { format: s.p.format, resize: null, matte: s.p.format === 'jpeg' ? '#ffffff' : null, quality: s.p.format === 'jpeg' ? .9 : null } };
      const request = envelope(body);
      const completed = await phase(phases, 'raster.command-through-durable-output', () => finish(f.writer, request, 'rasterCommand', context.signal));
      const asset = completed.events.find(event => event.type === 'AssetRegistered')?.payload.asset; assert(asset?.raster);
      assert.equal(asset.raster.width, s.p.specification.width); assert.equal(asset.raster.height, s.p.specification.height);
      const diagnosticRead = await f.writer.readDiagnostics();
      try {
        const diagnostics = diagnosticRead.value, rawObservations = {};
        const childPhases = rasterPhaseEvidence(diagnostics, request.command.commandId, cell.operation, rawObservations, missing,
          cell.operation === 'raster.composite' ? { width: s.document.width, height: s.document.height, layerCount: s.layers.length } : undefined);
        if (cell.operation === 'raster.decode' && s.p.format === 'webp') for (const child of childPhases) child.name = 'raster.webp-decode';
        phases.push(...childPhases.map(detachedRasterPhase));
        const retained = await retainDiagnosticEvidence(context.output, 'raster-command', diagnostics);
        observations.workerTelemetry = { ...retained, selector: 'rasters.workerPhases', commandId: request.command.commandId };
        observations.resource = { ...retained, selector: 'rasters.observations', commandId: request.command.commandId };
        if (cell.operation === 'raster.composite') observations.activeCompute = { ...retained, selector: 'rasters.workerPhases.activeCompute', commandId: request.command.commandId };
      } finally { diagnosticRead.release(); }
      observations.output = { id: asset.id, blob: asset.blob, pixelIdentity: asset.raster.pixelIdentity, commandId: request.command.commandId, receipt: completed.receipt };
      if (cell.operation === 'raster.composite') {
        assert.equal(asset.raster.pixelIdentity, s.composite.raster.pixelIdentity, 'Full transformed/masked visible stack must reproduce the retained canonical document');
      }
      if (cell.operation === 'raster.encode' && s.p.format === 'png') assert.equal(asset.raster.pixelIdentity, s.composite.raster.pixelIdentity, 'PNG must preserve canonical pixels');
      assertions.push({ name: 'New command generated a real bounded product worker result with declared full dimensions', passed: true });
    } else if (cell.operation === 'state.snapshot-read') {
      observations.snapshot = await phase(phases, 'document.snapshot-read', () => readSnapshot(f.writer, s.capture.snapshot.id, context.signal));
    } else if (cell.operation === 'state.replay') {
      await phase(phases, 'writer.open-through-recovered-readiness', () => f.reopen());
      const current = await f.writer.document(f.documentId); assert.deepEqual(current, s.document, 'Recovery must reproduce the complete canonical projection');
      const diagnosticRead = await f.writer.readDiagnostics();
      try {
        const diagnostics = diagnosticRead.value, rows = diagnostics.observations.phases.records.filter(row => row.phase === 'document.replay');
        observations.replayTelemetry = await retainDiagnosticEvidence(context.output, 'document-replay', diagnostics.observations.phases);
        if (rows.length !== 1 || rows[0]?.outcome !== 'ok' || diagnostics.observations.phases.invalid || diagnostics.observations.phases.dropped) missing.push('One complete actual product replay trace required');
        else { const row = rows[0]; phases.push({ name: s.p.mode === 'full' ? 'document.full-replay' : 'document.replay', startMs: row.startedMs, endMs: row.endedMs, durationMs: row.durationMs, outcome: 'completed', clock: 'server-writer', context: diagnosticContext(row.context) }); }
      } finally { diagnosticRead.release(); }
      const capture = await f.writer.capture(); assert.equal(capture.highWater, s.capture.highWater);
      if (s.p.mode === 'full') assert.equal(capture.snapshot, null); else assert.equal(capture.snapshot.seq, s.capture.snapshot.seq);
      observations.replayedEvents = s.p.mode === 'full' ? capture.highWater : String(BigInt(capture.highWater) - BigInt(capture.snapshot.seq));
      observations.replayEffects = { providerConfiguration: 'disabled', journalHighWaterUnchanged: true, actualGuardCounters: globalThis.__storeNetworkCounters?.read?.() ?? null };
      if (!globalThis.__storeNetworkCounters) missing.push('Existing store no-network preload counters are required to prove zero replay side effects');
      else assert(Object.values(globalThis.__storeNetworkCounters.read()).every(value => value === 0), 'Replay must have zero attempted network effects');
      assertions.push({ name: 'Normal production startup replay reproduced the complete document without new journal events', passed: true });
    } else if (cell.operation === 'asset.persist') {
      const descriptor = { hash: s.persistHash, byteLength: String(s.p.bytes), mediaType: 'application/octet-stream' };
      observations.persisted = await phase(phases, 'asset.persist-hash', () => f.writer.putObject((function* () { for (let at = 0; at < s.persistBytes.length; at += 65536) yield s.persistBytes.subarray(at, at + 65536); })(), descriptor, f.writer.epoch));
      assert.deepEqual(observations.persisted, descriptor);
      assertions.push({ name: 'Independent incompressible bytes streamed through product hash, fsync and immutable object publication', passed: true });
    } else if (cell.operation === 'asset.cache-lookup') {
      const projection = await phase(phases, 'asset.cache-lookup', () => f.writer.assetProjection(s.compositeAssetId));
      assert.deepEqual(projection.asset, s.composite); observations.assetId = s.compositeAssetId; observations.contentReadCalls = 0;
      observations.cacheBoundary = 'Product immutable asset metadata lookup; no assetVerify/assetContent/remote fetch calls';
      observations.writerEpoch = f.writer.epoch; observations.identityPreparedBeforeColdRestart = context.sample?.cache === 'cold';
    } else if (cell.operation === 'state.command-accept-dispatch') {
      const request = envelope(s.prepared.body), receipt = await phase(phases, 'writer.queue-command-through-durable-receipt', () => f.writer.queueCommand(encode(request), auth())); assert.equal(receipt.status, 'accepted');
      const event = (await f.writer.events(String(BigInt(receipt.fromSeq) - 1n))).events.find(event => event.commandId === request.command.commandId && event.type === 'JobQueued'); assert(event);
      const acknowledgement = await phase(phases, 'queue.eligible-dispatch-through-emulator-acknowledgement', () => f.queueWorker.submit(event.payload.id));
      const attempt = acknowledgement?.attempts.at(-1); assert.equal(attempt?.state, 'acknowledged');
      const provider = await f.queueWorker.snapshot('ideogram/v4');
      const posts = provider.effects.slice(s.queueBefore.effects.length).filter(effect => effect.method === 'POST'); assert.equal(posts.length, 1);
      const local = provider.submissions?.find(row => row.jobId === event.payload.id) ?? provider.lastSubmit;
      const diagnosticRead = await f.writer.readDiagnostics();
      try {
        const trace = diagnosticRead.value.observations.phases;
        const accepted = trace.records.filter(row => row.context?.commandId === request.command.commandId && row.phase === 'event.append' && row.outcome === 'ok').at(-1);
        if (local?.jobId === event.payload.id && Number.isFinite(accepted?.endedMs) && Number.isFinite(local.postObservedMs) && local.postObservedMs >= accepted.endedMs) phases.push({ name: 'job.submit.eligible-dispatch', startMs: accepted.endedMs, endMs: local.postObservedMs, durationMs: local.postObservedMs - accepted.endedMs, outcome: 'completed', clock: 'server-writer', boundary: 'Actual durable acceptance with a free dispatch slot through emulator receipt of complete POST body; includes intervening harness/IPC delay and excludes acknowledgement' });
        else missing.push('Real emulator POST completed, but same-writer-clock durable-acceptance-to-POST observation is unavailable');
        observations.commandId = request.command.commandId; observations.dispatch = { jobId: event.payload.id, attemptId: attempt.id, payloadHash: attempt.payloadHash, epoch: attempt.writerEpoch }; observations.emulatorPosts = posts; observations.serverTelemetry = await retainDiagnosticEvidence(context.output, 'dispatch-command', trace);
        for (const name of ['command.validate', 'command.accept', 'event.append']) {
          const rows = trace.records.filter(row => row.phase === name && row.context.commandId === request.command.commandId && row.outcome === 'ok');
          if (!rows.length || trace.invalid || trace.dropped) missing.push('Missing complete exact-command ' + name + ' phase');
          else for (const row of rows) phases.push({ name, startMs: row.startedMs, endMs: row.endedMs, durationMs: row.durationMs, outcome: 'completed', clock: 'server-writer', context: diagnosticContext(row.context) });
        }
      } finally { diagnosticRead.release(); }
      assertions.push({ name: 'New validated immutable request accepted durably and exactly one actual production dispatcher POST reached the local emulator', passed: true });
      // Real local status reconciliation settles this attempt before the next
      // independent warm command. It does not invent a provider result asset.
      await f.queueWorker.observeStatus(event.payload.id, attempt.id, 'COMPLETED');

    }
    return result(cell, phases, observations, assertions, missing);
  } finally { if (owned) await f.close(); }
}
