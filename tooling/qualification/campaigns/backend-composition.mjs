import {createWarmOwner,captureWarmInputRefs,observeWarmInputs,warmInventory,warmDigest,warmCell,retainWarmProof} from './backend-warm-proof.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { openSync, readSync, closeSync } from 'node:fs';
import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// This module contains campaign cells, not a replacement parser or writer. All
// acceptance, storage, and envelope processing below calls the built product.
export const compositionCaseIds = Object.freeze(Array.from({ length: 30 }, (_, i) => `WJ${String(i + 1).padStart(2, '0')}`));
export const rawCaseIds = Object.freeze(['RAW16M', 'RAW16M_PLUS1']);
export const supportedCells = Object.freeze([...compositionCaseIds, ...rawCaseIds, ...Array.from({ length: 16 }, (_, i) => `CP${String(i + 1).padStart(2, '0')}`)]);
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const caption = () => ({ high_level_description: '', compositional_deconstruction: { background: '', elements: [] } });
const encode = value => Buffer.from(JSON.stringify(value));

/** Pure, deterministic corpus preparation. Call outside scored spans and seal bytes. */
export function makeCompositionFixture(id) {
  if (!compositionCaseIds.includes(id)) throw Error('Unknown composition fixture: ' + id);
  let value = caption(), raw, state = 'supported', code, facts = {};
  switch (id) {
    case 'WJ01': value.high_level_description = 'Café 東京 العربية 👩🏾‍🔬'; value.compositional_deconstruction.elements = [{ type: 'text', text: 'Cafe\u0301\n東京', desc: 'Blue lettering' }]; break;
    case 'WJ02': value.compositional_deconstruction.elements = Array.from({ length: 256 }, () => ({ type: 'obj', desc: '' })); facts.elements = 256; break;
    case 'WJ03': value.high_level_description = '\u0000\b\f\n\r\t"\\'; break;
    case 'WJ04': raw = JSON.stringify('Plain returned description'); state = 'unsupported'; code = 'ENCODED_STRING_ROOT'; break;
    case 'WJ05': raw = '{"high_level_description":'; state = 'malformed'; code = 'MALFORMED_JSON'; break;
    case 'WJ06': raw = '[]'; state = 'unsupported'; code = 'UNSUPPORTED_ROOT'; break;
    case 'WJ07': raw = 'null'; state = 'unsupported'; code = 'UNSUPPORTED_ROOT'; break;
    case 'WJ08': raw = JSON.stringify(JSON.stringify(value)); state = 'unsupported'; code = 'ENCODED_STRING_ROOT'; break;
    case 'WJ09': value.compositional_deconstruction.background = 7; state = 'unsupported'; code = 'STRING_REQUIRED'; break;
    case 'WJ10': raw = '{"high_level_description":"","high_level_description":"second"}'; state = 'ambiguous'; code = 'DUPLICATE_KEY'; break;
    case 'WJ11': raw = '{"high_level_description":"","high_level_descrip\\u0074ion":"second"}'; state = 'ambiguous'; code = 'DUPLICATE_KEY'; break;
    case 'WJ12': raw = '['.repeat(16) + ']'.repeat(16); state = 'unsupported'; code = 'UNSUPPORTED_ROOT'; facts.depth = 16; break;
    case 'WJ13': raw = '['.repeat(17) + ']'.repeat(17); state = 'over-limit'; code = 'DEPTH_LIMIT'; facts.depth = 17; break;
    case 'WJ14': raw = '[[],' + Array(24998).fill('0').join(',') + ']'; state = 'unsupported'; code = 'UNSUPPORTED_ROOT'; facts.tokens = 50000; break;
    case 'WJ15': raw = '[[0],' + Array(24998).fill('0').join(',') + ']'; state = 'over-limit'; code = 'TOKEN_LIMIT'; facts.tokens = 50001; break;
    case 'WJ16': raw = JSON.stringify(value); raw += ' '.repeat(262144 - Buffer.byteLength(raw)); facts.byteLength = 262144; break;
    case 'WJ17': raw = JSON.stringify(value); raw += ' '.repeat(262145 - Buffer.byteLength(raw)); state = 'over-limit'; code = 'BYTE_LIMIT'; facts.byteLength = 262145; break;
    case 'WJ18': value.compositional_deconstruction.elements = Array.from({ length: 257 }, () => ({ type: 'obj', desc: '' })); state = 'unsupported'; code = 'ELEMENT_LIMIT'; facts.elements = 257; break;
    case 'WJ19': value.high_level_description = 'a'.repeat(16384); facts.stringBytes = 16384; break;
    case 'WJ20': value.high_level_description = 'a'.repeat(16385); state = 'over-limit'; code = 'STRING_LIMIT'; facts.stringBytes = 16385; break;
    case 'WJ21': value.future_field = true; state = 'unsupported'; code = 'UNKNOWN_FIELD'; break;
    case 'WJ22': value.profile_version = 'future-profile-2'; state = 'unsupported'; code = 'UNKNOWN_FIELD'; break;
    case 'WJ23': value.compositional_deconstruction.elements = [{ type: 'obj', bbox: [-1, 0, 900, 900], desc: '' }]; state = 'unsupported'; code = 'BBOX_FORMAT'; break;
    case 'WJ24': raw = '{"images":[],"prompt":"' + 'arrived prefix 東京\\n'.repeat(1000); state = 'partial'; facts.complete = false; break;
    case 'WJ25': value = { texts: ['a'.repeat(16385)], expected: 'TEXT_BYTES' }; state = 'native-rejected'; break;
    case 'WJ26': value = { texts: Array.from({ length: 65 }, (_, i) => 'a'.repeat(i === 64 ? 1 : 16384)), expected: 'TEXT_DOCUMENT_LIMIT' }; state = 'native-rejected'; break;
    case 'WJ27': value = { texts: ['\n'.repeat(256)], expected: 'TEXT_LINES' }; state = 'native-rejected'; break;
    case 'WJ28': value = { texts: ['\ud800'], expected: 'TEXT_SURROGATE' }; state = 'native-rejected'; break;
    case 'WJ29': value = { texts: ['a'.repeat(16384), '\n'.repeat(255)], expected: null }; state = 'native-admitted'; break;
    case 'WJ30': value = { texts: Array.from({ length: 75 }, (_, i) => 'a'.repeat(Math.floor(1048576 / 75) + (i < 1048576 % 75 ? 1 : 0))), expected: null }; state = 'native-admitted'; facts.layers = 75; facts.documentBytes = 1048576; break;
  }
  const bytes = Buffer.from(raw ?? JSON.stringify(value));
  return { id, role: id < 'WJ24' ? 'caption-raw' : id === 'WJ24' ? 'partial-envelope' : 'native-admission', bytes, expected: { state, ...(code ? { code } : {}), ...facts }, sha256: sha(bytes), byteLength: bytes.length };
}

function identifier(cell) {
  if (cell?.operation === 'caption.raw-ingest' && [16777216, 16777217].includes(cell.parameters?.bytes)) return cell.parameters.bytes === 16777216 ? 'RAW16M' : 'RAW16M_PLUS1';
  for (const value of [typeof cell === 'string' ? cell : cell.operation, cell?.parameters?.caseId, cell?.id]) {
    if (supportedCells.includes(value)) return value;
    const match = typeof value === 'string' && /(?:^|[-/:])(WJ\d\d|CP\d\d|RAW16M_PLUS1|RAW16M)(?:$|[-/:])/.exec(value);
    if (match && supportedCells.includes(match[1])) return match[1];
  }
  throw Error('Unsupported composition campaign cell');
}
async function product(context, file) { return import(pathToFileURL(join(context.repo ?? process.cwd(), 'dist/local', file)).href); }
async function timed(phases, name, fn) {
  const phase = { name, startMs: performance.now(), endMs: null, durationMs: null, outcome: 'running' };
  phases.push(phase);
  try { const value = await fn(); phase.outcome = 'completed'; return value; }
  catch (error) { phase.outcome = 'failed'; phase.error = { name: error.name, code: error.code ?? null, message: String(error.message) }; throw error; }
  finally { phase.endMs = performance.now(); phase.durationMs = phase.endMs - phase.startMs; }
}
async function corpus(context, id) {
  const expected = makeCompositionFixture(id), entry = context.fixture?.corpus?.files?.find(value => value.id === id);
  if (!entry) return { ...expected, sealed: false };
  const bytes = await readFile(resolve(context.fixture.root ?? '', entry.path));
  assert.equal(sha(bytes).replace(/^sha256:/, ''), String(entry.sha256).replace(/^sha256:/, ''), 'sealed corpus hash');
  assert.equal(sha(bytes), expected.sha256, 'canonical corpus identity');
  assert.equal(Number(entry.byteLength), bytes.length, 'sealed corpus byte length');
  return { ...expected, bytes, sealed: true };
}
function result(phases) { return { status: 'pass', phases, assertions: [], observations: {}, evidence: [], missing: [] }; }
function failed(out, error) {
  const unavailable = error?.name === 'AbortError' || ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ABORT_ERR'].includes(error?.code);
  out.status = unavailable ? 'inconclusive' : 'fail';
  const detail = { code: error?.code ?? error?.name ?? null, message: String(error?.message ?? error) };
  if (unavailable) out.missing.push(detail); else out.assertions.push({ name: 'production campaign invariant', passed: false, error: detail });
  return out;
}
function checked(out, name, fn) { fn(); out.assertions.push({ name, passed: true }); }
/** Retain the real writer and reset image content through accepted Undo. Global
 * journal and retained branch growth are reported instead of erased behind it. */
export async function createCompositionFixture(context, cell) {
  const common = await import('./backend-common.mjs');
  // Undo reads canonical stored image metadata; object insertion order is not state.
  const { canonical } = await product(context, 'src/protocol/json.js');
  const f = await common.createProductFixture({ ...context, compositionFixture: true });
  let baseline, baselineDocument;
  try { await common.createDocument(f); baseline = await f.writer.imageState(f.documentId); baselineDocument = await f.writer.document(f.documentId); }
  catch (error) { await f.close(); throw error; }
  const initialWriter = f.writer, descriptor = f.compositionWorker.descriptor, underlyingClose = f.close.bind(f);
  try {
  const owner = createWarmOwner(f.writer,f.root,descriptor), inputRefs = await captureWarmInputRefs(f.writer,f.documentId);
  const observe = async () => {const [document,image,queue] = await Promise.all([f.writer.document(f.documentId),f.writer.imageState(f.documentId),f.writer.queueView()]);return {imageHash:warmDigest(canonical(image)),historyHead:document.historyHead,revision:document.revision,activeJobs:queue.counts.active,inputs:await observeWarmInputs(f.root,inputRefs,context.signal),inventory:warmInventory(f.root)};};
  const initial = await observe(), entry=context.fixture?.corpus?.files?.find(value=>value.id===identifier(cell));
  const input=entry?{sha256:String(entry.sha256).startsWith('sha256:')?entry.sha256:'sha256:'+entry.sha256,byteLength:String(entry.byteLength)}:null;
  const state = f.compositionState = { id: identifier(cell), sample: {}, samples: 0, baseline, baselineHead: baselineDocument.historyHead, descriptor, lastCommand: null, owner, observe, initial, input, reset:null, previous:null };
  f.resetCell = async (next, sample = {}) => {
    assert.equal(identifier(next), state.id, 'A retained composition fixture owns one cell');
    const phases = [], out = result(phases); state.sample = sample; const before=state.samples?await observe():null; let undo=null;
    assert.equal(f.writer, initialWriter, 'Warm reset retains the actual writer capability');
    assert.deepEqual(f.compositionWorker.descriptor, descriptor, 'Warm reset retains worker epoch and thread');
    if (state.samples) {
      const current = await f.writer.document(f.documentId);
      if (current.historyHead !== state.baselineHead) {
        const request = common.envelope({ type: 'Undo', historyHead: current.historyHead }, { documentId: f.documentId, expectedDocumentRevision: current.revision });
        const accepted=await timed(phases, 'composition.warm-reset-public-undo', () => common.finish(f.writer, request, 'historyCommand', context.signal)); undo={commandId:request.command.commandId,transactionId:request.command.transactionId,documentId:request.command.documentId,expectedDocumentRevision:request.command.expectedDocumentRevision,action:'Undo',previousHead:request.command.body.historyHead,receipt:accepted.receipt};
      }
      assert.deepEqual(await f.writer.imageState(f.documentId), baseline, 'Public Undo restores the exact seeded composition and native state');
      assert.equal((await f.writer.document(f.documentId)).historyHead, state.baselineHead);
    }
    out.observations = { root: f.root, sample, writerEpoch: descriptor.epoch, writerThreadId: descriptor.threadId, retainedWriter: true, baselineRestored: true, earlierSamples: state.samples, reset: state.samples ? 'Accepted public Undo; immutable earlier branches and journal retained' : 'Initial exact sealed namespace copy', operatingSystemPageCache: 'not purged or inferred' };
    out.warmReset=state.reset={owner:owner(f.writer),baseline:initial,input,before,after:await observe(),undo};
    return out;
  };
  let closed = false;
  f.close = async () => {
    if (closed) return; closed = true;
    try {
      // Replay proof is outside every measured sample. Reopening here cannot
      // accidentally turn the next warm sample into a cold writer sample.
      const document = await f.writer.document(f.documentId), image = await f.writer.imageState(f.documentId);
      const command = state.lastCommand ? await f.writer.commandState(state.lastCommand) : null;
      await f.reopen();
      assert.deepEqual(await f.writer.document(f.documentId), document);
      assert.deepEqual(await f.writer.imageState(f.documentId), image);
      if (command) assert.deepEqual((await f.writer.commandState(state.lastCommand)).record?.receipt, command.record?.receipt);
      await writeFile(join(f.root, 'qualification-composition-final-replay.json'), JSON.stringify({ schema: 1, passed: true, samples: state.samples, priorWriter: descriptor, replayWriter: f.compositionWorker.descriptor, documentId: f.documentId, historyHead: document.historyHead, commandId: state.lastCommand }), { mode: 0o600 });
    } finally { await underlyingClose(); }
  };
  return f;
  } catch(error) {await underlyingClose();throw error;}
}
async function ownInput(fixture, source, identity) {
  const directory = join(fixture.root, 'qualification-composition-inputs'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = 'qualification-composition-inputs/' + randomUUID() + '.bin', file = await open(join(fixture.root, path), 'wx', 0o600);
  const digest = createHash('sha256'); let bytes = 0;
  try { for (const chunk of source) { digest.update(chunk); bytes += chunk.length; await file.writeFile(chunk); } await file.sync(); } finally { await file.close(); }
  assert.equal('sha256:' + digest.digest('hex'), identity.sha256.startsWith('sha256:') ? identity.sha256 : 'sha256:' + identity.sha256); assert.equal(bytes, Number(identity.byteLength));
  return { path, sha256: identity.sha256.startsWith('sha256:') ? identity.sha256 : 'sha256:' + identity.sha256, byteLength: String(bytes) };
}
export async function runCompositionWorkerOperation(store, payload, subject) {
  assert(payload && typeof payload === 'object');
  assert(subject && subject.root === store.root && typeof subject.repo === 'string' && subject.repo === resolve(subject.repo),
    'Composition worker requires its trusted selected subject configuration');
  const context = { repo: subject.repo, root: subject.root };
  const worker = await import('./backend-composition-worker-ops.mjs');
  if (payload.action === 'native-admission') {
    const path = await worker.validateInputDescriptor(store, payload.stateFile);
    assert(Number(payload.stateFile.byteLength) <= 1048576, 'Native admission state descriptor is bounded');
    const bytes = Buffer.alloc(Number(payload.stateFile.byteLength)); let offset = 0;
    for (const chunk of worker.chunks(path)) {
      assert(offset + chunk.length <= bytes.length, 'Native admission state exceeds its declared length');
      bytes.set(chunk, offset); offset += chunk.length;
    }
    assert.equal(offset, bytes.length); assert.equal(sha(bytes), payload.stateFile.sha256);
    const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return (await import('./backend-composition-native.mjs')).runNativeWorkerAdmission(store, payload, { ...context, state });
  }
  if (['raw-ingest', 'partial-ingest'].includes(payload.action)) return worker.ingest(store, payload, context);
  if (payload.action === 'composition-state') return worker.compositionState(store, payload, context);
  throw Error('Unsupported composition worker action');
}
async function useFixture(context, common) { return context.productFixture ?? common.createProductFixture(context); }
async function verifyRestart(fixture) { if (!fixture.compositionState) await fixture.reopen(); }
async function closeOwned(context, fixture) { if (!context.productFixture) await fixture.close(); }
async function captionCell(context, id) {
  const phases = [], out = result(phases), specimen = await corpus(context, id);
  const [api, requestAPI] = await Promise.all([product(context, 'src/composition/core.js'), product(context, 'src/request/core.js')]);
  const common = await import('./backend-common.mjs');
  const fixture = await useFixture(context, common);
  try {
    const document = await common.createDocument(fixture);
    const originalHash = sha(specimen.bytes);
    const parsed = await timed(phases, 'composition.parse', () => api.parseCaption(specimen.bytes));
    checked(out, 'exact named recognition outcome', () => { assert.equal(parsed.state, specimen.expected.state); if (specimen.expected.code) assert(parsed.issues.some(issue => issue.code === specimen.expected.code)); });
    let graph = api.emptyComposition(document.width, document.height, randomUUID()), projected = null;
    graph.frame.width = 512; graph.frame.height = 512;
    graph.frame.documentToRequest = [512 / document.width, 0, 0, 512 / document.height, 0, 0];
    if (parsed.state === 'supported') {
      projected = await timed(phases, 'composition.project-serialize', () => {
        graph = api.fromCaption(parsed.value, graph.frame, graph.id, randomUUID);
        const projected = api.serialize(graph, [], {});
        // The bounded parser deliberately returns null-prototype dictionaries.
        // Compare exact canonical JSON values, not dictionary prototypes.
        const recognized = JSON.stringify(parsed.value);
        assert.equal(JSON.stringify(projected.caption), recognized, 'projection preserves the independently recognized original caption');
        const promptRef = { hash: sha(Buffer.from(projected.prompt)), byteLength: String(Buffer.byteLength(projected.prompt)), mediaType: 'text/plain' };
        const draft = requestAPI.newDraft(promptRef);
        Object.assign(draft.fields, { width: '512', height: '512', expansion: 'None', seed: '31', count: '1', format: 'png' });
        draft.guidanceAcknowledged = true;
        const request = requestAPI.resolve(draft, projected.prompt), frozenRequest = structuredClone(request);
        const body = requestAPI.bodyTemplate(request, projected.prompt), wire = JSON.parse(body);
        assert.deepEqual(request, frozenRequest, 'wire construction cannot mutate the resolved request');
        assert.equal(JSON.stringify(JSON.parse(wire.prompt)), recognized);
        assert.equal(wire.expansion_model, 'None'); assert.equal(wire.num_images, 1); assert.equal(wire.enable_safety_checker, true); assert.equal(wire.sync_mode, false);
        assert.deepEqual(wire.image_size, { width: 512, height: 512 });
        const bodyBytes = Buffer.byteLength(body), promptBytes = Buffer.byteLength(JSON.stringify(projected.prompt)), otherBytes = bodyBytes - promptBytes;
        assert(promptBytes <= 1572864); assert(otherBytes <= 65536); assert(bodyBytes <= 1638400);
        assert(!body.includes(graph.id));
        return { ...projected, bodyBytes, promptBytes, otherBytes, requestKind: request.kind };
      });
      out.assertions.push({ name: 'production request wire preserves the independently recognized exact caption and separate byte limits', passed: true });
    }
    if (id === 'WJ23') checked(out, 'invalid frame projection rejects without native geometry change', () => {
      const geometry = { rect: [-1, 0, 100, 100], transform: [1, 0, 0, 1, 0, 0] }, before = structuredClone(geometry);
      assert.throws(() => api.projectBounds(geometry, graph.frame, 'inside'), /OUT_OF_FRAME/); assert.deepEqual(geometry, before);
    });
    const retained = await timed(phases, 'composition.retained-bytes', async () => {
      const asset = await common.stageBlob(fixture, specimen.bytes, 'text', 'application/octet-stream'); graph.raw = [asset.blob];
      if (projected) {
        const prompt = await common.stageCaption(fixture, projected.prompt);
        graph.review = { serializer: 'caption-json-1', sourceId: graph.id, frame: graph.frame, request: graph.request, dependencies: projected.dependencies, boxes: projected.boxes, prompt: prompt.blob };
      }
      const assetGraph = await common.stageBlob(fixture, encode(graph), 'text', 'application/octet-stream');
      return { raw: asset, graph: { ...assetGraph.blob, mediaType: 'application/json' } };
    });
    const command = common.envelope({ type: projected ? 'ApprovePromptProjection' : 'CommitCompositionVersion', composition: { id: graph.id, value: retained.graph, bindings: {} }, draft: null });
    command.command.documentId = fixture.documentId ?? 'document_1'; command.command.expectedDocumentRevision = await fixture.writer.documentRevision(command.command.documentId);
    const accepted = await timed(phases, 'composition.durable-append', () => common.finish(fixture.writer, command, 'historyCommand', context.signal));
    const acceptedDocument = await fixture.writer.document(command.command.documentId);
    assert.equal(acceptedDocument.compositionVersion, graph.id);
    await timed(phases, 'composition.retention-verification', async () => {
      await verifyRestart(fixture);
      assert.equal(sha(specimen.bytes), originalHash);
      const actual = await readFile(join(fixture.root, 'objects', 'sha256', retained.raw.blob.hash.slice(7, 9), retained.raw.blob.hash.slice(7)));
      assert.equal(sha(actual), originalHash); assert.deepEqual(actual, specimen.bytes);
      const document = await fixture.writer.document(command.command.documentId);
      assert.deepEqual(document, acceptedDocument);
      const replayed = await fixture.writer.commandState(command.command.commandId); assert.deepEqual(replayed.record.receipt, accepted.receipt);
      const state = await fixture.writer.imageState(command.command.documentId); assert.equal(state.composition.id, graph.id); assert.deepEqual(state.composition.value, retained.graph);
      const graphBytes = await readFile(join(fixture.root, 'objects', 'sha256', retained.graph.hash.slice(7, 9), retained.graph.hash.slice(7)));
      assert.equal(sha(graphBytes), retained.graph.hash); assert.deepEqual(JSON.parse(graphBytes.toString('utf8')), graph);
      const wanted = new Set([retained.raw.blob.hash, retained.graph.hash, ...(graph.review ? [graph.review.prompt.hash] : [])]);
      let cursor = '';
      do { const page = await fixture.writer.historyClosure(command.command.documentId, cursor); for (const ref of page.items) wanted.delete(ref.hash); cursor = page.next; } while (cursor);
      assert.equal(wanted.size, 0, 'accepted composition history roots exact raw, graph and approved prompt after restart');
    });
    out.assertions.push({ name: 'exact original, graph and approved prompt remain history-rooted with identical receipt after restart', passed: true });
    out.observations = { id, originalBytes: specimen.bytes.length, originalHash, parseState: parsed.state, issueCodes: parsed.issues.map(x => x.code), projectedWireBytes: projected?.bodyBytes ?? null, projectedPromptBytes: projected?.promptBytes ?? null, projectedOtherBytes: projected?.otherBytes ?? null, requestKind: projected?.requestKind ?? null, sealedCorpus: specimen.sealed, providerEffects: 0 };
    out.evidence.push({ root: fixture.root, originalRef: retained.raw.blob, graphRef: retained.graph, commandId: command.command.commandId, receipt: accepted.receipt });
    if (!specimen.sealed) { out.status = 'inconclusive'; out.missing.push('presealed WJ corpus manifest'); }
    return out;
  } catch (error) { out.evidence.push({ root: fixture.root }); return failed(out, error); } finally { await closeOwned(context, fixture); }
}

const RAW_UNIT = 'Café 東京\n"\\😀';
/** Bound each returned chunk; no whole 16MiB string or envelope is materialized. */
export function* rawPromptChunks(byteLength) {
  if (![16777216, 16777217].includes(byteLength)) throw Error('Unsupported raw cell size');
  const unit = Buffer.from(RAW_UNIT), batch = Buffer.from(RAW_UNIT.repeat(256));
  let remaining = byteLength;
  while (remaining >= batch.length) { yield batch; remaining -= batch.length; }
  while (remaining >= unit.length) { yield unit; remaining -= unit.length; }
  if (remaining) yield Buffer.alloc(remaining, 97);
}
export function* rawEnvelopeChunks(byteLength) {
  yield Buffer.from('{"images":[{"url":"https://fixture.invalid/owned.png","width":512,"height":512,"content_type":"image/png"}],"has_nsfw_concepts":[false],"prompt":"');
  for (const bytes of rawPromptChunks(byteLength)) {
    const escaped = Buffer.from(JSON.stringify(bytes.toString('utf8')).slice(1, -1));
    // 8191 deliberately bisects UTF-8 scalars and JSON escape sequences.
    for (let at = 0; at < escaped.length; at += 8191) yield escaped.subarray(at, at + 8191);
  }
  yield Buffer.from('","seed":31,"timings":{"inference":0.4}}');
}

function* fileChunks(path) {
  const fd = openSync(path, 'r');
  try { for (;;) { const bytes = Buffer.alloc(32768), count = readSync(fd, bytes); if (!count) break; yield bytes.subarray(0, count); } }
  finally { closeSync(fd); }
}
async function rawCorpus(context, id, bytes) {
  const expected = createHash('sha256'); let length = 0;
  for (const chunk of rawEnvelopeChunks(bytes)) { expected.update(chunk); length += chunk.length; }
  const digest = expected.digest('hex'), entry = context.fixture?.corpus?.files?.find(value => value.id === id);
  if (!entry) return { sealed: false, chunks: () => rawEnvelopeChunks(bytes), sha256: digest, byteLength: length };
  const path = resolve(context.fixture.root ?? '', entry.path), actual = createHash('sha256'); let seen = 0;
  for (const chunk of fileChunks(path)) { actual.update(chunk); seen += chunk.length; }
  assert.equal(actual.digest('hex'), digest, 'canonical raw envelope fixture hash'); assert.equal(seen, length, 'canonical raw envelope fixture size');
  assert.equal(String(entry.sha256).replace(/^sha256:/, ''), digest, 'sealed raw envelope identity'); assert.equal(Number(entry.byteLength), length);
  return { sealed: true, chunks: () => fileChunks(path), sha256: digest, byteLength: length };
}

async function rawCell(context, id) {
  const phases = [], out = result(phases), expectedBytes = id === 'RAW16M' ? 16777216 : 16777217;
  const specimen = await rawCorpus(context, id, expectedBytes);
  const [common, queueHarness, { resolvePrivacy }] = await Promise.all([import('./backend-common.mjs'), import('./backend-queue.mjs'), product(context, 'server/provider/policy.js')]);
  const fixture = await useFixture(context, common), setup = [];
  const expectedHash = createHash('sha256'); for (const chunk of rawPromptChunks(expectedBytes)) expectedHash.update(chunk); const expected = expectedHash.digest('hex');
  let source, view;
  try {
    // Corpus initialization is retained separately. The raw cell starts when
    // the sealed response is available; it is not a provider submission cell.
    const prepared = await queueHarness.prepareQueue(fixture, setup, { caseId: id }), queued = await queueHarness.enqueue(fixture, prepared.body, setup);
    const attemptId = queued.job.attempts[0].id; let store = null, workerReceipt = null;
    if (fixture.compositionWorker) {
      const cleared = await common.ui(fixture, { type: 'ClearDraft', draftId: prepared.draftId, generation: '1' }); assert.equal(cleared.status, 'accepted');
      const input = await ownInput(fixture, specimen.chunks(), specimen);
      workerReceipt = await fixture.compositionWorker.execute({ action: 'raw-ingest', caseId: id, jobId: queued.job.id, attemptId, input });
      phases.push(...workerReceipt.phases); if (workerReceipt.error) throw Object.assign(Error(workerReceipt.error.message), workerReceipt.error); source = workerReceipt.source; view = workerReceipt.view;
    } else {
      store = await fixture.direct(); const requestId = 'sealed_fixture';
    const profile = { id: 'campaign-local-only', version: 1, evidenceDigest: '0'.repeat(64), endpoint: 'ideogram/v4', mode: 'fixture', enforcement: 'observed', lifecycleSeconds: 3600, minimumCompatibleSeconds: 3600, acl: 'private', supportedLifetimes: [3600], supportedACLs: ['private'], mostPrivateACL: 'private', deferredFetch: 'bounded', requiredLifetimeSeconds: 3600, renewalQualified: false };
    const policy = resolvePrivacy(profile, profile.endpoint, attemptId).applied;
    assert(store.queue.reserve(queued.job.id)); const dispatch = store.queue.dispatch(queued.job.id, attemptId, {}, policy); assert(dispatch);
    const base = 'https://queue.fal.run/ideogram/v4/requests/' + requestId, urls = { status: base + '/status', result: base, cancel: base + '/cancel' };
    const ackSink = store.queue.sink(attemptId, 'response', policy); ackSink.append(encode({ request_id: requestId, status_url: urls.status, response_url: urls.result, cancel_url: urls.cancel }));
    const ack = ackSink.finish(true); store.queue.outcome(queued.job.id, attemptId, dispatch.epoch, { kind: 'ack', requestId, urls, responseRecord: ack.recordId });
    const fence = store.queue.resultFence(queued.job.id, attemptId);
    await timed(phases, 'result.prompt-ingest-durable', () => {
      const response = store.queue.sink(attemptId, 'response', policy);
      try { for (const chunk of specimen.chunks()) response.append(chunk); source = response.finish(true); } catch (error) { response.finish(false); throw error; }
      assert.equal(source.sha256, specimen.sha256, 'actual consumed envelope matches its seal'); assert.equal(Number(source.receivedBytes), specimen.byteLength);
      // This is the actual response→decoded prompt→Objects→candidate journal and
      // ownership-root transaction, not an orphan object-file approximation.
      view = store.candidates.receive(fence, source, policy, []);
      assert.equal(view.provenance.complete, true); assert.equal(view.provenance.returnedBytes, String(expectedBytes)); assert.equal(view.provenance.returnedPrompt.hash, 'sha256:' + expected);
    });
    }
    const owned = view.provenance.returnedPrompt;
    await timed(phases, 'caption.bounded-page-and-closure-verification', async () => {
      assert.equal(view.items.length, 1); assert.equal(view.items[0].safety, 'safe'); assert.equal(view.provenance.inspection, 'opaque');
      if (store) { assert(store.db.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=?').get('candidate-provenance:' + attemptId, owned.hash), 'returned prompt has durable candidate ownership'); store.objects.verify(owned); assert.deepEqual(store.objects.reservationInventory(), { reservedBytes: '0', activeTransfers: 0 }); }
      await verifyRestart(fixture); const restored = await fixture.writer.candidateView(queued.job.id, attemptId);
      assert.deepEqual(restored.provenance, view.provenance); assert.equal(restored.items.length, 1);
      const digest = createHash('sha256'); let offset = '0', bytes = 0;
      do { const page = await fixture.writer.candidatePrompt(queued.job.id, attemptId, 'returned', offset); assert(page.bytes.length <= 32768); digest.update(page.bytes); bytes += page.bytes.length; offset = page.nextOffset; } while (offset);
      assert.equal(bytes, expectedBytes); assert.equal(digest.digest('hex'), expected);
    });
    out.assertions.push({ name: 'exact decoded prompt registered and rooted in candidate transaction', passed: true }, { name: 'known image slot and escaped multibyte boundaries retained', passed: true }, { name: 'bounded full prompt hash and provenance survive writer restart', passed: true });
    out.observations = { id, promptBytes: expectedBytes, promptHash: 'sha256:' + expected, envelopeBytes: source.receivedBytes, corpusHash:'sha256:'+specimen.sha256.replace(/^sha256:/,''),corpusBytes:specimen.byteLength, inspection: view.provenance.inspection, slots: 1, providerEffects: 0, localFixturePolicyOnly: true, seededAcknowledgement: true, seededTerminalStatus: workerReceipt?.seededTerminalStatus ?? null, sealedCorpus: specimen.sealed, setupPhases: setup };
    out.evidence.push({ root: fixture.root, jobId: queued.job.id, attemptId, protectedRecordId: source.recordId, ownedRef: owned });
    if (!specimen.sealed) { out.status = 'inconclusive'; out.missing.push('presealed raw envelope corpus'); }
    return out;
  } catch (error) { out.evidence.push({ root: fixture.root }); return failed(out, error); } finally { await closeOwned(context, fixture); }
}

async function partialCell(context) {
  const id = 'WJ24', phases = [], out = result(phases), specimen = await corpus(context, id);
  const common = await import('./backend-common.mjs');
  const [{ TransportEvidenceStore }, { resolvePrivacy }, api, workerOperations, queueHarness, { readdir }] = await Promise.all([
    product(context, 'server/provider/evidence.js'), product(context, 'server/provider/policy.js'), product(context, 'src/composition/core.js'), import('./backend-composition-worker-ops.mjs'), import('./backend-queue.mjs'), import('node:fs/promises')]);
  const fixture = await useFixture(context, common), setup = [];
  try {
    await common.createDocument(fixture);
    const prepared = await queueHarness.prepareQueue(fixture, setup, { caseId: id }), queued = await queueHarness.enqueue(fixture, prepared.body, setup);
    const before = await fixture.writer.imageState(fixture.documentId);
    const nativeBefore = before.layers.filter(layer => layer.kind === 'text');
    const store = fixture.compositionWorker ? null : await fixture.direct(), evidence = store?.queue.evidence, attemptId = queued.job.attempts[0].id, requestId = 'late_partial_fixture';
    const storedComposition = fixture.compositionWorker ? await fixture.compositionWorker.execute({ action: 'composition-state', documentId: fixture.documentId }) : await workerOperations.compositionState(store, { documentId: fixture.documentId }, context);
    const beforeGraph = storedComposition.graph, staleNativeLinks = storedComposition.staleNativeLinks;
    const bindings = structuredClone(before.composition?.bindings ?? {});
    let source, prefix, view, workerReceipt = null;
    if (fixture.compositionWorker) {
      const cleared = await common.ui(fixture, { type: 'ClearDraft', draftId: prepared.draftId, generation: '1' }); assert.equal(cleared.status, 'accepted');
      const input = await ownInput(fixture, [specimen.bytes], specimen);
      workerReceipt = await fixture.compositionWorker.execute({ action: 'partial-ingest', caseId: id, jobId: queued.job.id, attemptId, input });
      phases.push(...workerReceipt.phases); if (workerReceipt.error) throw Object.assign(Error(workerReceipt.error.message), workerReceipt.error); ({ source, prefix, view } = workerReceipt);
    } else {
    const profile = { id: 'campaign-local-only', version: 1, evidenceDigest: '0'.repeat(64), endpoint: 'ideogram/v4', mode: 'fixture', enforcement: 'observed', lifecycleSeconds: 3600, minimumCompatibleSeconds: 3600, acl: 'private', supportedLifetimes: [3600], supportedACLs: ['private'], mostPrivateACL: 'private', deferredFetch: 'bounded', requiredLifetimeSeconds: 3600, renewalQualified: false };
    const policy = resolvePrivacy(profile, profile.endpoint, attemptId).applied;
    assert(store.queue.reserve(queued.job.id)); const dispatch = store.queue.dispatch(queued.job.id, attemptId, {}, policy); assert(dispatch);
    const base = 'https://queue.fal.run/ideogram/v4/requests/' + requestId, urls = { status: base + '/status', result: base, cancel: base + '/cancel' };
    const ackSink = store.queue.sink(attemptId, 'response', policy); ackSink.append(encode({ request_id: requestId, status_url: urls.status, response_url: urls.result, cancel_url: urls.cancel }));
    const ack = ackSink.finish(true); store.queue.outcome(queued.job.id, attemptId, dispatch.epoch, { kind: 'ack', requestId, urls, responseRecord: ack.recordId });
    const fence = store.queue.resultFence(queued.job.id, attemptId);
    await timed(phases, 'caption.partial-envelope-ingest-hash-durability', async () => {
      const response = store.queue.sink(attemptId, 'response', policy);
      try { for (let at = 0; at < specimen.bytes.length; at += 8191) response.append(specimen.bytes.subarray(at, at + 8191)); source = response.finish(false); }
      catch (error) { response.finish(false); throw error; }
      assert.equal(source.completeness, 'partial'); assert.equal(source.sha256, specimen.sha256.slice(7)); assert.equal(source.receivedBytes, String(specimen.byteLength));
      const priorRecords = new Set(await readdir(evidence.directory));
      // Real queue authority invokes derivation exactly once and journals the
      // incomplete provenance under this dispatched/acknowledged attempt.
      view = store.candidates.receive(fence, source, policy, []);
      assert.equal(view.provenance.complete, false); assert.equal(view.provenance.returnedPrompt, null); assert.equal(view.provenance.inspection, 'unavailable'); assert(BigInt(view.provenance.returnedBytes) > 0n);
      assert.equal(view.provenance.sourceBodyHash, specimen.sha256); assert.equal(view.observation.resultDigest, source.sha256); assert.equal(view.observation.phase, 'quarantined');
      const newRecords = (await readdir(evidence.directory)).filter(name => !priorRecords.has(name) && name.endsWith('.json')).map(name => evidence.inspect(name.slice(0, -5))).filter(record => record.attemptId === attemptId && record.direction === 'response');
      assert.equal(newRecords.length, 1, 'actual candidate receive retains one decoded-prefix record'); prefix = newRecords[0];
      assert.equal(prefix.completeness, 'partial'); assert.equal(prefix.receivedBytes, view.provenance.returnedBytes);
      assert(store.db.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=?').get('candidate-provenance:' + attemptId, view.provenance.privacyPolicy.hash), 'partial provenance policy is journal-owned');
      assert.throws(() => store.candidates.prompt(queued.job.id, attemptId, 'returned', '0'), error => ['NOT_FOUND', 'CONTENT_WITHHELD'].includes(error.code));
    });
    }
    out.assertions.push({ name: 'actual candidate receive journals attempt-owned partial provenance and refuses complete returned-prompt access', passed: true });
    const verifyProtectedPrefixes = () => {
      const reopened = new TransportEvidenceStore(fixture.root);
      for (const original of [source, prefix]) {
        const observed = reopened.inspect(original.recordId); assert.equal(observed.completeness, 'partial'); assert.equal(observed.receivedBytes, original.receivedBytes); assert.equal(observed.retainedBytes, original.receivedBytes); assert.equal(observed.sha256, original.sha256);
        assert.equal(observed.attemptId, attemptId);
        const digest = createHash('sha256'); let byteLength = 0;
        for (const chunk of reopened.read(original.recordId)) { context.signal?.throwIfAborted(); if (original === source) assert.deepEqual(chunk, specimen.bytes.subarray(byteLength, byteLength + chunk.length)); digest.update(chunk); byteLength += chunk.length; }
        assert.equal(digest.digest('hex'), original.sha256); assert.equal(String(byteLength), original.receivedBytes);
      }
    };
    const verifyProvenance = async () => { const restored = await fixture.writer.candidateView(queued.job.id, attemptId); assert.deepEqual(restored.provenance, view.provenance); assert.equal(restored.observation.resultDigest, source.sha256); assert.equal(restored.observation.phase, 'quarantined'); await assert.rejects(() => fixture.writer.candidatePrompt(queued.job.id, attemptId, 'returned', '0'), error => ['NOT_FOUND', 'CONTENT_WITHHELD'].includes(error.code)); };
    await timed(phases, 'caption.partial-prefix-reopen-verification', async () => { await verifyRestart(fixture); verifyProtectedPrefixes(); await verifyProvenance(); });
    const recovery = { schemaVersion: 1, kind: 'campaign-partial-provenance-recovery', sourceHash: 'sha256:' + source.sha256, arrivedBytes: source.receivedBytes, decodedPrefixBytes: prefix.receivedBytes, complete: false, inspection: view.provenance.inspection };
    const graph = beforeGraph ? structuredClone(beforeGraph) : api.emptyComposition(before.width, before.height, randomUUID());
    graph.id = randomUUID(); graph.review = null;
    let recoveryAsset;
    const retained = await timed(phases, 'caption.partial-recovery-retained-bytes', async () => {
      recoveryAsset = await common.stageBlob(fixture, encode(recovery), 'text', 'application/octet-stream'); graph.raw.push(recoveryAsset.blob);
      return common.stageBlob(fixture, encode(graph), 'text', 'application/octet-stream');
    });
    const graphRef = { ...retained.blob, mediaType: 'application/json' };
    const command = common.envelope({ type: 'CommitCompositionVersion', composition: { id: graph.id, value: graphRef, bindings }, draft: null }, { documentId: fixture.documentId, expectedDocumentRevision: await fixture.writer.documentRevision(fixture.documentId) });
    const accepted = await timed(phases, 'caption.partial-recovery-durable-append', () => common.finish(fixture.writer, command, 'historyCommand', context.signal));
    const acceptedDocument = await fixture.writer.document(fixture.documentId);
    await timed(phases, 'caption.late-native-state-verification', async () => {
      await verifyRestart(fixture); verifyProtectedPrefixes(); await verifyProvenance();
      assert.deepEqual(await fixture.writer.document(fixture.documentId), acceptedDocument);
      assert.deepEqual((await fixture.writer.commandState(command.command.commandId)).record.receipt, accepted.receipt);
      const after = await fixture.writer.imageState(fixture.documentId);
      assert.deepEqual(after.layers, before.layers);
      assert.deepEqual(after.layers.filter(layer => layer.kind === 'text'), nativeBefore);
      assert.deepEqual(after.composition.bindings, bindings); assert.deepEqual(after.composition.value, graphRef);
      const actualGraphBytes = await readFile(join(fixture.root, 'objects', 'sha256', graphRef.hash.slice(7, 9), graphRef.hash.slice(7)));
      assert.equal(sha(actualGraphBytes), graphRef.hash); const actualGraph = JSON.parse(actualGraphBytes.toString('utf8')); assert.deepEqual(actualGraph, graph);
      if (beforeGraph) {
        const semantic = value => { const { id, raw, review, ...rest } = value; return rest; };
        assert.deepEqual(semantic(actualGraph), semantic(beforeGraph)); assert.deepEqual(actualGraph.raw.slice(0, -1), beforeGraph.raw); assert.equal(actualGraph.review, null);
      }
      const observedComposition = fixture.compositionWorker ? await fixture.compositionWorker.execute({ action: 'composition-state', documentId: fixture.documentId }) : await workerOperations.compositionState(await fixture.direct(), { documentId: fixture.documentId }, context);
      if (!fixture.compositionWorker) await fixture.reopen();
      assert.deepEqual(observedComposition.staleNativeLinks, staleNativeLinks, 'Fresh admitted native projection preserves every stale-link fact');
      for (const previous of staleNativeLinks) { const retainedBinding = actualGraph.elements.find(element => element.id === previous.elementId)[previous.field]; assert.deepEqual(retainedBinding, previous.binding); }
      const wanted = new Set([graphRef.hash, recoveryAsset.blob.hash, ...(beforeGraph?.raw ?? []).map(ref => ref.hash)]); let cursor = '';
      do { const page = await fixture.writer.historyClosure(fixture.documentId, cursor); for (const ref of page.items) wanted.delete(ref.hash); cursor = page.next; } while (cursor);
      assert.equal(wanted.size, 0, 'new recovery metadata and earlier raw records remain rooted after restart');
    });
    out.assertions.push({ name: 'late recovery preserves actual semantic fields, bindings, earlier raw records and native layers after restart', passed: true }, { name: 'exact protected arrived envelope and decoded prefix remain partial and hash-verified after reopen', passed: true });
    if (staleNativeLinks.length) out.assertions.push({ name: 'actual retained native text bindings remain stale against newer durable native versions', passed: true });
    out.observations = { id, corpusHash:specimen.sha256,corpusBytes:specimen.byteLength, arrivedBytes: source.receivedBytes, decodedPrefixBytes: prefix.receivedBytes, complete: false, nativeLayersChecked: nativeBefore.length, actualStaleNativeLinksChecked: staleNativeLinks.length, existingCompositionPreserved: beforeGraph !== null, sealedCorpus: specimen.sealed, providerEffects: 0, seededAcknowledgement: true, seededTerminalStatus: workerReceipt?.seededTerminalStatus ?? null, actualCandidateProvenance: true, setupPhases: setup };
    out.evidence.push({ root: fixture.root, jobId: queued.job.id, attemptId, protectedRecordId: source.recordId, partialPromptRecordId: prefix.recordId, graphRef, recoveryRef: recoveryAsset.blob, commandId: command.command.commandId, receipt: accepted.receipt });
    if (!specimen.sealed) out.missing.push('presealed WJ24 partial envelope');
    if (!nativeBefore.length || !staleNativeLinks.length || !context.fixture?.observed?.nativeTextAdvancedBeforeLateProvenance) out.missing.push('sealed newer durable native text version predating the late partial provenance response');
    if (out.missing.length) out.status = 'inconclusive';
    return out;
  } catch (error) { out.evidence.push({ root: fixture.root }); return failed(out, error); } finally { await closeOwned(context, fixture); }
}

export async function runCell(context, cell) {
  const id = identifier(cell);
  const before = globalThis.__storeNetworkCounters?.read();
  let out;
  if (id.startsWith('CP')) out = await (await import('./backend-composition-cp.mjs')).runCell(context, { ...(typeof cell === 'object' ? cell : {}), operation: id });
  else if (rawCaseIds.includes(id)) out = await rawCell(context, id);
  else if (id <= 'WJ23') out = await captionCell(context, id);
  else if (id === 'WJ24') out = await partialCell(context);
  else out = await (await import('./backend-composition-native.mjs')).runCell(context, { ...(typeof cell === 'object' ? cell : {}), operation: id });
  const after = globalThis.__storeNetworkCounters?.read();
  const effects = before && after ? Object.fromEntries(Object.entries(after).map(([name, value]) => [name, value - before[name]])) : null;
  if (effects && Object.values(effects).some(value => value !== 0)) { out.status = 'fail'; out.assertions.push({ name: 'composition cells have zero guarded network effects', passed: false, effects }); }
  if (context.productFixture?.compositionState) { const state = context.productFixture.compositionState; ++state.samples; state.lastCommand = out.evidence.find(item => item.commandId)?.commandId ?? null; out.assertions = out.assertions.map(item => ({ ...item, name: item.name.replaceAll('after restart', 'in retained writer').replaceAll('after reopen', 'in retained writer').replaceAll('writer restart', 'retained writer readback') })); out.observations = { ...out.observations, retainedWriter: true, writer: context.productFixture.compositionWorker.descriptor, replayVerification: 'Scheduled on final fixture close outside measured samples; qualification-composition-final-replay.json records completion' }; }
  out.observations = { ...out.observations, providerEffects: effects ? Object.values(effects).reduce((sum, value) => sum + value, 0) : null, guardedNetworkEffects: effects, networkObservation: effects ? 'shared store no-network counters' : 'transport effect counts not observed by this module' };
  if(context.productFixture?.compositionState && out.status==='pass'){
    const fixture=context.productFixture,state=fixture.compositionState;
    const packet={kind:'backend-warm-input-proof-1',family:'WJ',cell:warmCell(context.warmCell??cell),sample:{cache:state.sample.cache,ordinal:state.sample.ordinal??null,prime:state.sample.prime??null},serial:state.samples,previous:state.previous?warmDigest(state.previous):null,
      owner:state.owner(fixture.writer),baseline:state.initial,input:state.input,before:state.reset.after,after:await state.observe(),
      cache:{kind:'retained-writer-connection-and-module-loader-1',decodedResultCache:'not-used-by-selected-operation',derivedResultCache:'per-operation-or-not-used',operatingSystemPageCache:'unobserved'}};
    out.warmInput=await retainWarmProof(context.output,packet,{cell:context.warmCell??cell,sample:state.sample,previous:state.previous,reset:state.reset,operation:out,fixture:context.fixture});state.previous=packet;
  }
  return out;
}
