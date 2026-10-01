// Single-attempt diagnostic. Never run alongside fixture generation, native
// builds, other resource measurements or the ordinary functional gate ladder.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { EMPTY_EXPECTED_VERSIONS } from '../../dist/local/src/protocol/store.js';
import { diagnosticIdentity } from './diagnostic-identity.mjs';
import { beginDiagnosticNetwork, finishDiagnosticNetwork, sharedDiagnosticCounters } from './diagnostic-network.mjs';

const [receiptArgument, fixtureName, outputArgument, ...extra] = process.argv.slice(2);
assert(receiptArgument && fixtureName && outputArgument && (!extra.length || extra.length === 2 && extra[0] === '--oracle'),
  'Usage: node --import ./tests/store/no-network.mjs tooling/raster/measure-adversarial-webp.mjs generated-receipt.json fixture-name NEW-receipt.json [--oracle sealed-oracle.json]');
const fixtureReceiptPath = resolve(receiptArgument), output = resolve(outputArgument);
const oraclePath = extra.length ? resolve(extra[1]) : null;
// Refuse to overwrite another attempt or the generated receipt. This descriptor
// remains owned through finalization, including failures during writer setup.
const receiptFile = await open(output, 'wx', 0o600);
const limit = 512 * 1024 * 1024, blockBytes = 1024 * 1024;
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const facts = {
  schemaVersion: 1, kind: 'adversarial-webp-writer-diagnostic-v1', at: new Date().toISOString(), status: 'running', outcome: null, qualification: false,
  fixtureReceipt: fixtureReceiptPath, fixtureName, commands: [], errors: [], rssLimit: limit,
  accounting: 'Whole-process OS maxRSS includes this driver, storage/raster worker threads, V8, loaded codecs, source staging, bounded object hashing and resident allocations through writer close. Native peak is the decoder allocation metric only. No forced GC. No fixture encoder runs in this process.',
  networkCounterScope: 'The required no-network preload shares all eight effect counters between this driver and the storage worker. Raster child workers inherit the guard but their separate counters are not aggregated into this receipt.',
  scope: 'Exactly one PrepareRaster for one generated fixture; no retries, conversion approval, quality fallback, resize, composition or export. Accepted pixels are verified against the fixture oracle where defined. Resource-refused is a retained original command, not a supported decode or successful pixel result. This is not P3, PERF, complete R19, platform, repeated-writer or lifecycle qualification.',
};
let writer, original, preparedCommand, fixture, input, fixtureReceiptSeal, sourceSeal, deadline, oracle, oracleReceiptSeal, networkGuardSnapshot;
function checkDeadline() { if (deadline !== undefined && performance.now() >= deadline) throw Error('Diagnostic exceeded its 120 second work deadline'); }
async function checkpoint() {
  const bytes = Buffer.from(JSON.stringify(facts, null, 2) + '\n');
  for (let offset = 0; offset < bytes.length;) { const part = await receiptFile.write(bytes, offset, bytes.length - offset, offset); assert(part.bytesWritten > 0); offset += part.bytesWritten; }
  await receiptFile.truncate(bytes.length); await receiptFile.sync();
}
function failure(stage, error) { facts.status = 'failed'; facts.errors.push({ stage, error: String(error) }); process.exitCode = 1; }
async function recordAttempt(stage, run) { try { return await run(); } catch (error) { failure(stage, error); } }
function stamp(value) { return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':'); }

// Read a held, no-follow descriptor in aligned chunks. The alpha scratch is
// exactly 256 KiB, independent of image dimensions; source reads use 1 MiB.
async function inspectFile(path, withAlpha = false, expectedBytes) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), before = await file.stat({ bigint: true });
  const hash = createHash('sha256'), alphaHash = withAlpha ? createHash('sha256') : null;
  const block = Buffer.alloc(blockBytes), alpha = withAlpha ? Buffer.alloc(blockBytes / 4) : null;
  try {
    assert(before.isFile(), 'Expected a regular retained file');
    const size = Number(before.size); assert(Number.isSafeInteger(size), 'Unsafe file size');
    if (expectedBytes !== undefined) assert.equal(size, expectedBytes, 'Stored object length mismatch');
    if (withAlpha) assert.equal(size % 4, 0, 'Raw RGBA length is not aligned');
    for (let offset = 0; offset < size;) {
      const wanted = Math.min(block.length, size - offset); let got = 0;
      while (got < wanted) { const part = await file.read(block, got, wanted - got, offset + got); assert(part.bytesRead > 0, 'Truncated retained object'); got += part.bytesRead; }
      hash.update(block.subarray(0, got));
      if (withAlpha) { assert.equal(got % 4, 0); for (let pixel = 0; pixel < got / 4; pixel++) alpha[pixel] = block[pixel * 4 + 3]; alphaHash.update(alpha.subarray(0, got / 4)); }
      offset += got;
    }
    assert.equal(stamp(await file.stat({ bigint: true })), stamp(before), 'Retained file changed while hashing');
    return { bytes: size, hash: 'sha256:' + hash.digest('hex'), ...(withAlpha ? { alphaBytes: size / 4, alphaHash: 'sha256:' + alphaHash.digest('hex') } : {}) };
  } finally { await file.close(); }
}
function objectPath(ref) {
  assert(/^sha256:[0-9a-f]{64}$/.test(ref.hash) && /^(0|[1-9][0-9]*)$/.test(ref.byteLength), 'Invalid retained object reference');
  return join(facts.root, 'objects', 'sha256', ref.hash.slice(7, 9), ref.hash.slice(7));
}
async function proveOriginal() {
  const projection = await writer.assetProjection(original.id), asset = projection.asset;
  assert(asset, 'Original asset disappeared'); assert.equal(asset.id, original.id); assert.deepEqual(asset.blob, original.blob);
  assert.equal(asset.availability, 'available'); assert.equal(asset.qualification, 'pending-decoder'); assert.equal(asset.measuredMediaType, 'image/webp');
  assert.equal(asset.raster, undefined, 'An original must not be relabelled as a canonical output');
  const bytes = await inspectFile(objectPath(asset.blob), false, fixture.bytes);
  assert.deepEqual(bytes, { bytes: fixture.bytes, hash: fixture.hash }, 'Retained original object changed');
  return { projection, object: { path: objectPath(asset.blob), ...bytes }, proof: 'Read-only held-descriptor stream hash of the owned original object. assetVerify was not called: pending-decoder content is intentionally withheld by that API.' };
}
function requestFor(body) {
  return { protocolVersion: 1, command: { schemaVersion: 1, commandId: randomUUID(), clientId: auth.clientId, sessionId: 'adversarial-webp-provenance', correlationId: randomUUID(), causationId: null, transactionId: randomUUID(), documentId: null, expectedDocumentRevision: null, expectedEntityVersions: EMPTY_EXPECTED_VERSIONS, issuedAt: new Date().toISOString(), body } };
}
const auth = { clientId: 'adversarial-webp', sessionHash: 'c'.repeat(64), now: Date.now(), expires: Date.now() + 43200000 };
async function command(body, raster) {
  checkDeadline();
  const request = requestFor(body), serialized = JSON.stringify(request), commandId = request.command.commandId, started = performance.now();
  const observed = { commandId, type: body.type, request, requestHash: digest(serialized), status: 'submitted' };
  facts.commands.push(observed); if (body.type === 'PrepareRaster') preparedCommand = observed;
  await checkpoint();
  await writer[raster ? 'rasterCommand' : 'assetCommand'](Buffer.from(serialized), auth);
  while (true) {
    checkDeadline(); const state = await writer.commandState(commandId);
    if (state.record || state.pending?.phase === 'waiting-for-resources') {
      observed.elapsedMs = performance.now() - started; observed.state = state;
      const retained = await writer.originalCommand(commandId, auth.clientId);
      assert.equal(retained, serialized, 'Original command bytes changed'); observed.originalCommandRetained = true;
      if (state.record) {
        observed.status = state.record.receipt.status; observed.receipt = state.record.receipt;
        assert.equal(state.record.receipt.status, 'accepted', 'Original command received a rejected receipt');
        const events = await writer.events(String(BigInt(state.record.receipt.fromSeq) - 1n), 1), event = events.events[0];
        assert.equal(event?.type, 'AssetRegistered'); assert.equal(event.commandId, commandId, 'Receipt event belongs to another command');
        return { outcome: 'accepted', commandId, asset: event.payload.asset };
      }
      assert.equal(body.type, 'PrepareRaster', 'Staging did not finish before decode');
      assert.equal(state.pending.command.commandId, commandId); assert.deepEqual(state.pending.command.body, body);
      observed.status = 'resource-pending';
      return { outcome: 'resource-refused', commandId, pending: state.pending };
    }
    await pause(10);
  }
}
async function stage() {
  const stagingId = randomUUID();
  await writer.assetCreate({ protocolVersion: 1, stagingId, purpose: 'image', expectedBytes: String(fixture.bytes), sha256: fixture.hash, mediaType: 'image/webp' }, auth);
  const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW), block = Buffer.alloc(blockBytes), staged = createHash('sha256');
  let offset = 0;
  try {
    while (offset < fixture.bytes) {
      checkDeadline(); const wanted = Math.min(block.length, fixture.bytes - offset); let got = 0;
      while (got < wanted) { const part = await file.read(block, got, wanted - got, offset + got); assert(part.bytesRead > 0, 'Fixture shortened while staging'); got += part.bytesRead; }
      const bytes = block.subarray(0, got); staged.update(bytes);
      const token = await writer.assetBeginChunk(stagingId, String(offset), got, auth); await writer.assetChunk(token, bytes, auth); offset += got;
    }
    assert.equal(Number((await file.stat()).size), fixture.bytes); assert.equal('sha256:' + staged.digest('hex'), fixture.hash, 'Fixture changed while staging');
  } finally { await file.close(); }
  facts.staging = { stagingId, bytes: offset, chunkBytes: blockBytes };
  return (await command({ type: 'FinalizeStaging', stagingId, expectedSha256: fixture.hash }, false)).asset;
}
async function decodeObservation(commandId) {
  // A receipt commit can become visible just before its metrics are appended.
  // Poll read-only diagnostics, without retrying or resubmitting the command.
  const until = Math.min(deadline, performance.now() + 2000);
  while (true) {
    const diagnostics = await writer.diagnostics(), found = diagnostics.rasters.observations.find(item => item.commandId === commandId && item.nativeBudget !== undefined);
    if (found) return { observation: found, diagnostics };
    assert(performance.now() < until, 'Accepted decode has no bounded native metrics'); await pause(10);
  }
}
async function readOracle(generated) {
  const handle = await open(oraclePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = await handle.stat({ bigint: true }); assert(before.isFile() && before.size <= 1024n * 1024n, 'Oracle receipt exceeds 1 MiB');
    bytes = await handle.readFile(); assert.equal(stamp(await handle.stat({ bigint: true })), stamp(before));
  } finally { await handle.close(); }
  oracleReceiptSeal = { bytes: bytes.length, hash: digest(bytes) };
  const result = JSON.parse(bytes), { seal, ...payload } = result;
  assert.equal(seal?.algorithm, 'sha256'); assert.equal(seal.payloadHash, digest(JSON.stringify(payload)), 'Oracle payload seal mismatch');
  assert.equal(result.schemaVersion, 1); assert.equal(result.kind, 'adversarial-webp-sharp-oracle-v1'); assert.equal(result.status, 'passed'); assert.equal(result.qualification, false);
  assert(Number.isFinite(Date.parse(result.finishedAt)) && Date.parse(result.finishedAt) <= Date.parse(facts.at), 'Oracle must finish before starting the writer diagnostic');
  assert.deepEqual(result.errors, []); assert.equal(result.childExit.exited, true); assert.equal(result.childExit.code, 0); assert.equal(result.childExit.signal, null); assert.equal(result.childExit.timedOut, false);
  const binding = result.fixture;
  assert.deepEqual(binding.receiptSeal, fixtureReceiptSeal); assert.deepEqual(binding.inputSeal, { bytes: fixture.bytes, hash: fixture.hash });
  assert.deepEqual(binding.fixture, { name: fixture.name, file: fixture.file, width: fixture.width, height: fixture.height, bytes: fixture.bytes, hash: fixture.hash });
  assert.deepEqual(binding.sourceOracle, fixture.oracle); assert.deepEqual(binding.generatorSource, generated.source); assert.equal(binding.generatorCodecIdentity, generated.encoder.codecIdentity);
  assert.equal(result.codec.codecIdentity, facts.measuredSources.codecIdentity, 'Oracle and product codec identities differ');
  assert.equal(result.codec.platform, process.platform); assert.equal(result.codec.arch, process.arch); assert.equal(result.codec.node, process.versions.node); assert.equal(result.codec.zlib, process.versions.zlib);
  const producer = { source: await inspectFile(new URL('./seal-memory-oracle.mjs', import.meta.url)), networkGuard: await inspectFile(new URL('../../tests/store/no-network.mjs', import.meta.url)) };
  assert.deepEqual(result.producer, producer, 'Oracle producer or guard differs from the current reviewed source');
  assert.deepEqual(result.producerAfter, result.producer); assert.deepEqual(result.fixtureAfter, result.fixture); assert.deepEqual(result.codecAfter, result.codec);
  assert.deepEqual(result.decodeRecipe, { options: { failOn: 'warning', limitInputPixels: 25_000_000, sequentialRead: true, ignoreIcc: true }, colourspace: 'srgb', ensureAlpha: true, raw: { depth: 'uchar' }, cache: false, concurrency: 1, orientation: 'Generated fixtures must have no orientation transform or embedded ICC/EXIF.' });
  const { seal: childSeal, ...child } = result.child.receipt;
  assert.equal(childSeal.algorithm, 'sha256'); assert.equal(childSeal.payloadHash, digest(JSON.stringify(child)));
  assert.equal(child.status, 'passed'); assert.equal(child.pid, result.childExit.pid); assert.equal(child.kind, 'adversarial-webp-sharp-oracle-child-v1'); assert.deepEqual(child.errors, []);
  assert.deepEqual(child.binding, { producer: result.producer, fixture: result.fixture, codec: result.codec, decodeRecipe: result.decodeRecipe }); assert.deepEqual(child.bindingSeal, result.bindingSeal);
  assert.deepEqual(child.producerAfter, result.producer); assert.deepEqual(child.fixtureAfter, result.fixture); assert.deepEqual(child.codecAfter, result.codec);
  assert(child.networkEffects && Object.values(child.networkEffects).every(count => count === 0));
  assert.deepEqual(result.decoded, child.decoded); assert.equal(result.decoded.width, fixture.width); assert.equal(result.decoded.height, fixture.height); assert.equal(result.decoded.channels, 4);
  assert.equal(result.decoded.rawBytes, fixture.width * fixture.height * 4); assert.equal(result.decoded.alphaBytes, fixture.width * fixture.height); assert(/^sha256:[0-9a-f]{64}$/.test(result.decoded.rgbaHash));
  assert.equal(result.decoded.alphaHash, fixture.oracle.expectedDecodedAlphaHash);
  if (fixture.oracle.rgbaExact) assert.equal(result.decoded.rgbaHash, fixture.oracle.expectedDecodedRgbaHash);
  facts.oracle = { path: oraclePath, receiptSeal: oracleReceiptSeal, producer, codec: result.codec, decoded: result.decoded, childExit: result.childExit,
    independence: result.independence, scope: 'Only a small precomputed receipt is loaded. Its completed timestamp precedes this diagnostic, and its child-exit record is successful. No oracle decode or full oracle pixels are allocated by this writer diagnostic.' };
  return result;
}

await checkpoint();
try {
  facts.root = await mkdtemp(join(await realpath(tmpdir()), 'raster-adversarial-webp-'));
  networkGuardSnapshot = await beginDiagnosticNetwork(); facts.networkGuard = networkGuardSnapshot;
  sourceSeal = await inspectFile(new URL(import.meta.url)); facts.script = sourceSeal;
  facts.measuredSources = await diagnosticIdentity();
  const receiptHandle = await open(fixtureReceiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let receiptBytes;
  try { assert((await receiptHandle.stat()).size <= 1024 * 1024, 'Fixture receipt is unexpectedly large'); receiptBytes = await receiptHandle.readFile(); }
  finally { await receiptHandle.close(); }
  fixtureReceiptSeal = { bytes: receiptBytes.length, hash: digest(receiptBytes) }; facts.fixtureReceiptSeal = fixtureReceiptSeal;
  const generated = JSON.parse(receiptBytes);
  assert.equal(generated.kind, 'adversarial-webp-memory-fixtures-v1'); assert.equal(generated.status, 'passed'); assert.equal(generated.qualification, false);
  fixture = generated.fixtures.find(item => item.name === fixtureName);
  assert(fixture && fixture.status === 'passed' && fixture.file === basename(fixture.file), 'Missing or unsafe completed fixture');
  assert(Number.isSafeInteger(fixture.bytes) && fixture.bytes > 0 && /^sha256:[0-9a-f]{64}$/.test(fixture.hash));
  assert(Number.isInteger(fixture.width) && Number.isInteger(fixture.height) && fixture.width > 0 && fixture.height > 0 && fixture.width <= 8192 && fixture.height <= 8192 && fixture.width * fixture.height <= 25_000_000);
  const source = generated.sources.find(item => item.file === fixture.source);
  assert(source?.status === 'passed'); assert.equal(source.rgbaHash, fixture.oracle.sourceRgbaHash); assert.equal(source.alphaHash, fixture.oracle.expectedDecodedAlphaHash);
  assert.equal(fixture.oracle.rawBytes, fixture.width * fixture.height * 4); assert.equal(fixture.oracle.alphaBytes, fixture.width * fixture.height);
  assert.equal(fixture.oracle.rgbaExact, fixture.encoderOptions.lossless);
  assert.equal(fixture.oracle.expectedDecodedRgbaHash, fixture.oracle.rgbaExact ? source.rgbaHash : null);
  facts.fixture = fixture; facts.generator = { source: generated.source, encoder: generated.encoder, parameters: generated.parameters, procedure: generated.procedure, source };
  input = join(dirname(fixtureReceiptPath), fixture.file); facts.input = input;
  facts.inputSealBefore = await inspectFile(input, false, fixture.bytes); assert.deepEqual(facts.inputSealBefore, { bytes: fixture.bytes, hash: fixture.hash });
  if (oraclePath) oracle = await readOracle(generated);
  await checkpoint(); deadline = performance.now() + 120000;
  writer = await openWriter({ root: facts.root }, { effectCounters: sharedDiagnosticCounters() }); await writer.protocolDefaults(); await writer.rememberClient(auth.sessionHash, auth.clientId, auth.expires);
  facts.initialRSS = process.memoryUsage().rss;
  original = await stage(); facts.original = original; facts.originalBefore = await proveOriginal();
  const result = await command({ type: 'PrepareRaster', assetId: original.id }, true);
  facts.outcome = result.outcome === 'resource-refused' ? 'resource-pending-unclassified' : result.outcome;
  if (result.outcome === 'resource-refused') {
    const diagnostics = await writer.diagnostics(), failures = diagnostics.rasters.observations.filter(item => item.commandId === result.commandId && item.phase === 'failure');
    // The writer also pauses unexpected failures. Require the explicit capacity
    // code; the pending phase alone cannot establish a resource refusal.
    assert(failures.some(item => item.code === 'CAPACITY'), 'Waiting command has no explicit capacity failure');
    facts.outcome = 'resource-refused';
    facts.refusal = { pending: result.pending, failures, scope: 'Explicit writer CAPACITY outcome; this receipt does not attribute it solely to the native allocation budget.' };
    facts.pendingOutputProjection = await writer.assetProjection(result.pending.operationId);
    assert.equal(facts.pendingOutputProjection.asset, null, 'Resource-pending command published an output asset');
    facts.decoded = { status: 'not-produced', supportedDecode: false, rawOracle: null, nativeCleanupMetrics: 'No native success observation is available for a resource-refused command.' };
  } else {
    const preview = result.asset, info = preview.raster; facts.preview = preview;
    assert.equal(preview.qualification, 'raster-preview'); assert.equal(preview.availability, 'available'); assert.equal(preview.safety, 'safe');
    assert.equal(info?.width, fixture.width); assert.equal(info.height, fixture.height);
    assert.equal(info.pixels.byteLength, String(fixture.width * fixture.height * 4));
    const actual = await inspectFile(objectPath(info.pixels), true, fixture.width * fixture.height * 4);
    assert.equal(actual.hash, info.pixels.hash, 'Stored raw bytes differ from the asset identity');
    assert.equal(actual.alphaHash, fixture.oracle.expectedDecodedAlphaHash, 'Independent alpha oracle mismatch');
    if (fixture.oracle.rgbaExact) assert.equal(actual.hash, fixture.oracle.expectedDecodedRgbaHash, 'Independent lossless RGBA oracle mismatch');
    if (oracle) { assert.equal(actual.hash, oracle.decoded.rgbaHash, 'Stored RGBA differs from the sealed Sharp reference'); assert.equal(actual.alphaHash, oracle.decoded.alphaHash, 'Stored alpha differs from the sealed Sharp reference'); }
    const { observation } = await decodeObservation(result.commandId);
    for (const key of ['nativeBudget', 'nativePeak', 'nativeRemaining', 'nativeDenied']) assert(Number.isSafeInteger(observation[key]) && observation[key] >= 0, 'Invalid native metric ' + key);
    assert(observation.nativeBudget > 0 && observation.nativeBudget <= 128 * 1024 * 1024); assert(observation.nativePeak <= observation.nativeBudget);
    assert.equal(observation.nativeRemaining, 0); assert.equal(observation.nativeDenied, 0);
    facts.decoded = { status: 'verified', supportedDecode: true, rawOracle: { ...actual, independentSourceRgbaExact: fixture.oracle.rgbaExact, fullRgbaCompared: fixture.oracle.rgbaExact || !!oracle, sharpReferenceEquality: oracle ? 'passed' : 'not-provided', lossyRgbQualification: false }, observation,
      scope: oracle ? 'Every stored RGBA byte matches the separately produced sealed Sharp reference; alpha also matches its independently generated source oracle. Sharp shares libwebp lineage with the product decoder, so this is alternate-path equality, not independent native-codec or product qualification.' : fixture.oracle.rgbaExact ? 'Stored lossless RGBA and alpha match the independently generated source hashes.' : 'Stored RGBA matches its declared object hash and alpha matches the independent source oracle. Lossy RGB has no expected reference hash and remains unqualified.' };
  }
  checkDeadline(); facts.workElapsedMs = 120000 - (deadline - performance.now());
  facts.status = 'completed';
} catch (error) { failure('diagnostic', error); }
finally {
  if (writer && original) await recordAttempt('original-retention', async () => { facts.originalAfter = await proveOriginal(); });
  if (writer && preparedCommand) await recordAttempt('original-command-retention', async () => {
    const serialized = await writer.originalCommand(preparedCommand.commandId, auth.clientId);
    assert.equal(serialized, JSON.stringify(preparedCommand.request)); facts.originalCommandAfter = { commandId: preparedCommand.commandId, hash: digest(serialized), state: await writer.commandState(preparedCommand.commandId) };
    if (facts.outcome === 'resource-refused') { assert.equal(facts.originalCommandAfter.state.record, null); assert.equal(facts.originalCommandAfter.state.pending?.phase, 'waiting-for-resources'); }
  });
  if (writer) { await recordAttempt('diagnostics', async () => { facts.diagnostics = await writer.diagnostics(); }); await recordAttempt('writer-close', async () => { await writer.close(); facts.writerClosed = true; }); }
  await recordAttempt('network-guard', async () => {
    facts.networkGuardAfter = await finishDiagnosticNetwork(networkGuardSnapshot);
    assert.equal(facts.networkGuardAfter.status, 'passed', 'Diagnostic network guard or effect counters failed');
  });
  if (input) await recordAttempt('fixture-unchanged', async () => { facts.inputSealAfter = await inspectFile(input, false, fixture.bytes); assert.deepEqual(facts.inputSealAfter, facts.inputSealBefore); });
  if (fixtureReceiptSeal) await recordAttempt('fixture-receipt-unchanged', async () => { facts.fixtureReceiptSealAfter = await inspectFile(fixtureReceiptPath); assert.deepEqual(facts.fixtureReceiptSealAfter, fixtureReceiptSeal); });
  if (oracleReceiptSeal) await recordAttempt('oracle-receipt-unchanged', async () => { facts.oracleReceiptSealAfter = await inspectFile(oraclePath); assert.deepEqual(facts.oracleReceiptSealAfter, oracleReceiptSeal); });
  if (oracle) await recordAttempt('oracle-producer-unchanged', async () => { assert.deepEqual(await inspectFile(new URL('./seal-memory-oracle.mjs', import.meta.url)), oracle.producer.source); assert.deepEqual(await inspectFile(new URL('../../tests/store/no-network.mjs', import.meta.url)), oracle.producer.networkGuard); });
  if (sourceSeal) await recordAttempt('script-unchanged', async () => { facts.scriptAfter = await inspectFile(new URL(import.meta.url)); assert.deepEqual(facts.scriptAfter, sourceSeal); });
  await recordAttempt('measured-sources-unchanged', async () => { facts.measuredSourcesAfter = await diagnosticIdentity(); if (facts.measuredSources) assert.deepEqual(facts.measuredSourcesAfter, facts.measuredSources); });
  facts.peakRSS = process.resourceUsage().maxRSS * 1024;
  facts.rss = { status: facts.peakRSS <= limit ? 'passed' : 'failed', limitBytes: limit, maxRSSBytes: facts.peakRSS, includesWriterClose: facts.writerClosed === true };
  if (facts.peakRSS > limit) failure('whole-process-rss', Error('Whole-process RSS ceiling exceeded'));
  facts.process = { versions: process.versions, platform: process.platform, arch: process.arch }; facts.finishedAt = new Date().toISOString();
  try { await checkpoint(); } finally { await receiptFile.close(); }
  console.log(JSON.stringify({ status: facts.status, outcome: facts.outcome, errors: facts.errors, peakRSS: facts.peakRSS, rss: facts.rss.status, root: facts.root, receipt: output, qualification: false }));
}
