import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompositionFixture, makeCompositionFixture, runCell } from '../../tooling/qualification/campaigns/backend-composition.mjs';
import { compositionState, validateInputDescriptor } from '../../tooling/qualification/campaigns/backend-composition-worker-ops.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

async function preparedContext(t, id) {
  // The private mailbox deliberately rejects symlinked path components. macOS
  // may spell the temporary directory through /var rather than /private/var.
  const output = await realpath(await mkdtemp(join(tmpdir(), 'ideogram-composition-warm-')));
  t.after(() => rm(output, { recursive: true, force: true }));
  const specimen = makeCompositionFixture(id), path = join(output, id + '.raw');
  await writeFile(path, specimen.bytes, { mode: 0o600 });
  return { repo, output, fixture: { corpus: { files: [{ id, path, sha256: specimen.sha256, byteLength: specimen.byteLength }] } } };
}

function retainedResult(result, writer) {
  assert.deepEqual(result.observations.guardedNetworkEffects, {submit: 0, upload: 0, poll: 0, cancel: 0, fetch: 0, socket: 0, dns: 0, datagram: 0}, 'Every guarded network effect is observed and zero');
  assert.equal(result.observations.providerEffects, 0);
  assert(result.assertions.every(assertion => assertion.passed), JSON.stringify(result));
  assert.equal(result.observations.retainedWriter, true); assert.deepEqual(result.observations.writer, writer);
  assert.match(result.observations.replayVerification, /final fixture close outside measured samples/);
  for (const assertion of result.assertions) assert.doesNotMatch(assertion.name, /after restart|after reopen|writer restart/i, 'A warm sample cannot claim a restart it did not perform');
  for (const phase of result.phases) { assert(Number.isFinite(phase.startMs)); assert(Number.isFinite(phase.endMs)); assert.equal(phase.durationMs, phase.endMs - phase.startMs); assert(phase.durationMs >= 0); }
}

async function resetWithRealUndo(fixture, cell, baseline, descriptor, writer) {
  const prior = await fixture.writer.document(fixture.documentId), highWater = (await fixture.writer.capture()).highWater;
  const reset = await fixture.resetCell(cell, { cache: 'warm', repetition: 1 });
  assert.equal(reset.status, 'pass'); assert.equal(reset.qualification, undefined); assert.deepEqual(reset.warmReset.after.inputs,reset.warmReset.baseline.inputs,'Exact immutable input bytes remain'); assert(reset.warmReset.after.inventory.events_v2>reset.warmReset.baseline.inventory.events_v2,'Earlier results and public Undo events are explicitly retained');
  assert(reset.phases.some(phase => phase.name === 'composition.warm-reset-public-undo'));
  assert.equal(fixture.writer, writer); assert.deepEqual(fixture.compositionWorker.descriptor, descriptor);
  assert.deepEqual(await fixture.writer.imageState(fixture.documentId), baseline);
  const events = (await fixture.writer.events(highWater)).events;
  const undo = events.find(event => event.type === 'HistoryNavigated' && event.payload.action === 'Undo');
  assert(undo, 'Reset must issue an accepted public Undo event'); assert.equal(undo.payload.previousHead, prior.historyHead);
  const command = await fixture.writer.commandState(undo.commandId); assert.equal(command.record.receipt.status, 'accepted');
  return reset;
}

async function assertFinalReplay(root, descriptor, commandId) {
  const replay = JSON.parse(await readFile(join(root, 'qualification-composition-final-replay.json'), 'utf8'));
  assert.equal(replay.passed, true); assert.equal(replay.samples, 2); assert.equal(replay.commandId, commandId);
  assert.deepEqual(replay.priorWriter, descriptor); assert.notEqual(replay.replayWriter.epoch, descriptor.epoch);
  assert(Number.isSafeInteger(replay.replayWriter.threadId));
}

// These positive tests require real dist output and the guarded store runtime.
// They intentionally create no browser and exercise no provider transport.
test('WJ01 retained samples use one writer and public Undo, with replay only on final close', async t => {
  const context = await preparedContext(t, 'WJ01'), cell = { id: 'WJ01' };
  const fixture = await createCompositionFixture(context, cell), writer = fixture.writer, descriptor = { ...fixture.compositionWorker.descriptor };
  const baseline = await writer.imageState(fixture.documentId); let closed = false;
  try {
    const initial = await fixture.resetCell(cell, { cache: 'warm', repetition: 0 }); assert.equal(initial.status, 'pass'); assert.equal(initial.phases.length, 0); assert(initial.warmReset.owner.ownerId); assert.equal(initial.warmReset.before,null);
    const first = await runCell({ ...context, productFixture: fixture }, cell);
    assert.equal(first.status, 'pass', JSON.stringify(first)); retainedResult(first, descriptor); assert.equal(first.warmInput.verdict.complete,true);
    const firstRecord = first.evidence.find(item => item.commandId); assert(firstRecord);
    assert.notEqual((await writer.imageState(fixture.documentId)).composition.id, baseline.composition?.id);
    await assert.rejects(fixture.resetCell({ id: 'WJ02' }), /owns one cell/);
    await resetWithRealUndo(fixture, cell, baseline, descriptor, writer);
    const second = await runCell({ ...context, productFixture: fixture }, cell);
    assert.equal(second.status, 'pass', JSON.stringify(second)); retainedResult(second, descriptor); assert.equal(second.warmInput.verdict.serial,2); assert(second.warmInput.verdict.retainedGrowth.after.events_v2>first.warmInput.verdict.retainedGrowth.after.events_v2);
    const secondRecord = second.evidence.find(item => item.commandId); assert(secondRecord); assert.notEqual(secondRecord.commandId, firstRecord.commandId);
    assert.equal(fixture.writer, writer); assert.deepEqual(fixture.compositionWorker.descriptor, descriptor);
    assert.deepEqual((await writer.commandState(firstRecord.commandId)).record.receipt, firstRecord.receipt, 'Undo retains the original accepted receipt');
    assert.equal(fixture.compositionState.samples, 2);
    closed = true; await fixture.close(); await assertFinalReplay(fixture.root, descriptor, secondRecord.commandId);
  } finally { if (!closed) await fixture.close(); }
});

test('WJ24 retained partial ingestion preserves one worker without accumulating active holds', async t => {
  const context = await preparedContext(t, 'WJ24'), cell = { id: 'WJ24' };
  const fixture = await createCompositionFixture(context, cell), writer = fixture.writer, descriptor = { ...fixture.compositionWorker.descriptor };
  const baseline = await writer.imageState(fixture.documentId), initialQueue = await writer.queueView(); let closed = false;
  try {
    assert.equal(initialQueue.counts.active, 0); await fixture.resetCell(cell, { cache: 'warm', repetition: 0 });
    const records = [];
    for (let index = 0; index < 2; index++) {
      if (index) await resetWithRealUndo(fixture, cell, baseline, descriptor, writer);
      const result = await runCell({ ...context, productFixture: fixture }, cell);
      assert.equal(result.status, 'inconclusive', JSON.stringify(result)); retainedResult(result, descriptor);
      assert.deepEqual(result.missing, ['sealed newer durable native text version predating the late partial provenance response']);
      assert.equal(result.observations.actualCandidateProvenance, true); assert.equal(result.observations.complete, false);
      assert.equal(result.observations.nativeLayersChecked, 0); assert(result.observations.seededTerminalStatus);
      assert.equal(result.phases.filter(phase => phase.name === 'caption.partial-envelope-ingest-hash-durability').length, 1);
      const record = result.evidence.find(item => item.commandId); assert(record?.jobId && record.attemptId); records.push(record);
      const queue = await writer.queueView(); assert.equal(queue.totalJobs, initialQueue.totalJobs + index + 1);
      assert.equal(queue.counts.active, initialQueue.counts.active, 'Completed fixture status releases the real product hold');
      for (const item of records) {
        const recovery = await writer.queueRecovery(item.jobId, item.attemptId); assert.equal(recovery.attempt.hold, false);
        const view = await writer.candidateView(item.jobId, item.attemptId); assert.equal(view.provenance.complete, false); assert.equal(view.provenance.returnedPrompt, null); assert.equal(view.observation.phase, 'quarantined');
        await assert.rejects(writer.candidatePrompt(item.jobId, item.attemptId, 'returned', '0'), error => ['NOT_FOUND', 'CONTENT_WITHHELD'].includes(error.code));
      }
      assert.equal(fixture.writer, writer); assert.deepEqual(fixture.compositionWorker.descriptor, descriptor);
    }
    assert.notEqual(records[0].jobId, records[1].jobId); assert.notEqual(records[0].attemptId, records[1].attemptId);
    closed = true; await fixture.close(); await assertFinalReplay(fixture.root, descriptor, records[1].commandId);
  } finally { if (!closed) await fixture.close(); }
});

test('worker input descriptors require private owned paths, exact hashes and bounded bytes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ideogram-composition-input-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'qualification-composition-inputs'); await mkdir(directory, { mode: 0o700 });
  const bytes = Buffer.from('sealed local input'), path = 'qualification-composition-inputs/' + randomUUID() + '.bin', absolute = join(root, path);
  await writeFile(absolute, bytes, { mode: 0o600 });
  const descriptor = { path, sha256: sha(bytes), byteLength: String(bytes.length) };
  assert.equal(await validateInputDescriptor({ root }, descriptor), absolute);
  await assert.rejects(validateInputDescriptor({ root }, { ...descriptor, path: '../outside.bin' }));
  await assert.rejects(validateInputDescriptor({ root }, { ...descriptor, sha256: 'sha256:' + '0'.repeat(64) }));
  await assert.rejects(validateInputDescriptor({ root }, { ...descriptor, byteLength: String(bytes.length + 1) }));
  await chmod(absolute, 0o644); await assert.rejects(validateInputDescriptor({ root }, descriptor)); await chmod(absolute, 0o600);
  const symbolic = 'qualification-composition-inputs/symlink.bin'; await symlink(absolute, join(root, symbolic));
  await assert.rejects(validateInputDescriptor({ root }, { ...descriptor, path: symbolic }));
  const hard = join(directory, 'hardlink.bin'); await link(absolute, hard); await assert.rejects(validateInputDescriptor({ root }, descriptor)); await rm(hard);
  await truncate(absolute, 64 * 1048576 + 1);
  await assert.rejects(validateInputDescriptor({ root }, { ...descriptor, byteLength: String(64 * 1048576 + 1) }));
});


// Deterministic immutable input records, with the real semantic projection and
// CompositionMemory. This does not claim a durable native-renderer fixture.
test('WJ24 semantic facts consume nonempty native layers only inside their admitted scope', async () => {
  const { product } = await import('../../tooling/qualification/campaigns/backend-common.mjs');
  const [core, { CompositionMemory }] = await Promise.all([product({ repo }, 'src/composition/core.js'), product({ repo }, 'server/storage/composition-memory.js')]);
  const records = new Map(), text = 'New durable native text';
  const put = (value, mediaType = 'application/json') => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), ref = { hash: sha(bytes), byteLength: String(bytes.length), mediaType }; records.set(ref.hash, bytes); return ref; };
  const textRef = put(text, 'text/plain'), source = put({ text: { frame: { width: 80, height: 40 }, textUtf8: textRef } });
  const layer = { id: 'native_layer', version: '2', kind: 'text', assetId: 'native_asset', source, layerToDocument: [1, 0, 0, 1, 0, 0], appearanceDescription: 'Native appearance' };
  const graph = core.emptyComposition(100, 100, 'retained_graph'), element = core.emptyElement('text', 'native_element');
  element.text = core.linkField('text-content', { id: layer.id, version: '1', kind: 'text', text: 'Earlier reviewed native text', appearance: '', bounds: { rect: [0, 0, 80, 40], transform: layer.layerToDocument } }); graph.elements = [element];
  const state = { schemaVersion: 5, width: 100, height: 100, layers: [layer], composition: { id: graph.id, value: put(graph), bindings: { [layer.id]: layer.id } } };
  let other = 0, memory, graphReads = 0, nativeReads = 0, assetReads = 0, failText = false;
  memory = new CompositionMemory(() => memory.bytes + other, () => 0);
  const failure = new Error('native input read failed');
  const store = { histories: { state: id => { assert.equal(id, 'document'); return state; } }, rasters: { compositionMemory: memory },
    assets: { asset: id => { assert.equal(id, layer.assetId); assert(memory.bytes > 4 * 1024 ** 2); assetReads++; return { id, raster: { width: 80, height: 40 } }; } },
    objects: { verify: ref => { if (ref.hash === state.composition.value.hash) { assert(memory.bytes > 1024 ** 2); graphReads++; } if ([source.hash, textRef.hash].includes(ref.hash)) { assert(memory.bytes > 4 * 1024 ** 2); nativeReads++; } if (failText && ref.hash === textRef.hash) throw failure; const bytes = records.get(ref.hash); assert(bytes); assert.equal(sha(bytes), ref.hash); assert.equal(String(bytes.length), ref.byteLength); return Uint8Array.from(bytes); } } };
  const actual = await compositionState(store, { documentId: 'document' }, { repo });
  assert.equal(memory.bytes, 0); assert.equal(graphReads, 1); assert.equal(nativeReads, 2); assert.equal(assetReads, 1);
  assert.deepEqual(actual.graph, graph); assert.equal(Object.hasOwn(actual, 'layerValues'), false);
  assert.deepEqual(actual.staleNativeLinks, [{ elementId: element.id, field: 'text', binding: element.text, layerId: layer.id, version: '2' }]);
  assert.notEqual(actual.staleNativeLinks[0].binding, element.text, 'Only copied semantic evidence escapes the borrowed projection');
  assert(Buffer.byteLength(JSON.stringify(actual)) < 60 * 1024);
  other = 511 * 1024 ** 2; graphReads = 0; nativeReads = 0; assetReads = 0;
  await assert.rejects(compositionState(store, { documentId: 'document' }, { repo }), { code: 'CAPACITY' });
  assert.equal(graphReads, 0); assert.equal(nativeReads, 0); assert.equal(assetReads, 0); assert.equal(memory.bytes, 0);
  other = 0; failText = true;
  await assert.rejects(compositionState(store, { documentId: 'document' }, { repo }), error => error === failure);
  assert.equal(memory.bytes, 0, 'A native source failure releases the real borrowed owner');
});
