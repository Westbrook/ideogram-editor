// Diagnostic receipt only: this finite same-writer run is not PERF qualification.
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { EMPTY_EXPECTED_VERSIONS } from '../../dist/local/src/protocol/store.js';
import { BOUNDED_WEBP } from '../../dist/local/server/raster/webp-platform.js';
import { diagnosticIdentity } from './diagnostic-identity.mjs';
import {beginDiagnosticNetwork,finishDiagnosticNetwork,sharedDiagnosticCounters} from './diagnostic-network.mjs';
const networkGuard=await beginDiagnosticNetwork();

const [out] = process.argv.slice(2);
if (!out) throw Error('Usage: node --import ./tests/store/no-network.mjs tooling/raster/measure-repeated-webp.mjs receipt.json');
const hash = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
const measuredSources = diagnosticIdentity;
const limit = 512 * 1024 * 1024, root = await mkdtemp(join(await realpath(tmpdir()), 'raster-webp-repeat-'));
const facts = {
  schemaVersion: 1, networkGuard, at: new Date().toISOString(), qualification: false, root,
  sourceHash: hash(await readFile(new URL(import.meta.url))), measuredSources: await measuredSources(), decoder: BOUNDED_WEBP,
  commands: [], iterations: [], status: 'running', rssLimit: limit,
  accounting: 'One Node process including driver, storage/raster worker threads, V8, loaded codecs and resident allocator pages. OS maxRSS is a whole-process high-water mark. Native peak counts exact mapped codec allocations and allowance only. No forced GC; four samples over 500 ms after each terminal decode report observed settled RSS, not a proof of eventual release.',
  limits: 'Two cycles of the sealed synthetic white 25 MP lossless/lossy WebP fixtures. Independent white RGBA hash, bounded native metrics and native cleanup checked. No formal PERF/H-C/W1/platform qualification, adversarial image coverage, browser/GPU accounting or external effects.',
};
const auth = { clientId: 'webp-repeat', sessionHash: 'a'.repeat(64), now: Date.now(), expires: Date.now() + 43200000 };
const envelope = body => ({ protocolVersion: 1, command: { schemaVersion: 1, commandId: randomUUID(), clientId: auth.clientId, sessionId: 'webp-repeat-provenance', correlationId: randomUUID(), causationId: null, transactionId: randomUUID(), documentId: null, expectedDocumentRevision: null, expectedEntityVersions: EMPTY_EXPECTED_VERSIONS, issuedAt: new Date().toISOString(), body } });
let writer;
async function command(body, raster = true) {
  const value = envelope(body), id = value.command.commandId, started = performance.now();
  const observation = { type: body.type, commandId: id, status: 'submitted' }; facts.commands.push(observation);
  await writer[raster ? 'rasterCommand' : 'assetCommand'](Buffer.from(JSON.stringify(value)), auth);
  const deadline = performance.now() + 120000; let state;
  while (performance.now() < deadline) {
    state = await writer.commandState(id);
    if (state.record) break;
    if (state.pending?.phase === 'waiting-for-resources') {
      Object.assign(observation, { status: 'resource-pending', pending: state.pending });
      throw Error('Resource pending for original command ' + id);
    }
    await pause(5);
  }
  observation.elapsedMs = performance.now() - started;
  if (state?.record?.receipt.status !== 'accepted') {
    observation.state = state; throw Error('No accepted receipt for original command ' + id);
  }
  Object.assign(observation, { status: 'accepted', receipt: state.record.receipt });
  const events = await writer.events(String(BigInt(state.record.receipt.fromSeq) - 1n));
  return { event: events.events[0], commandId: id };
}
async function originalFor(input, declaration) {
  const bytes = await readFile(input), encodedHash = hash(bytes);
  if (encodedHash !== 'sha256:' + declaration.sha256 || bytes.length !== declaration.bytes) throw Error('Fixture seal mismatch');
  const stagingId = randomUUID();
  await writer.assetCreate({ protocolVersion: 1, stagingId, purpose: 'image', expectedBytes: String(bytes.length), sha256: encodedHash, mediaType: 'image/webp' }, auth);
  for (let offset = 0; offset < bytes.length; offset += 1048576) {
    const part = bytes.subarray(offset, offset + 1048576), token = await writer.assetBeginChunk(stagingId, String(offset), part.length, auth);
    await writer.assetChunk(token, part, auth);
  }
  return (await command({ type: 'FinalizeStaging', stagingId, expectedSha256: encodedHash }, false)).event.payload.asset;
}
function whiteHash(bytes) {
  const block = Buffer.alloc(1048576, 255), digest = createHash('sha256');
  for (let offset = 0; offset < bytes; offset += block.length) digest.update(block.subarray(0, Math.min(block.length, bytes - offset)));
  return 'sha256:' + digest.digest('hex');
}
try {
  writer = await openWriter({ root },{effectCounters:sharedDiagnosticCounters()}); await writer.protocolDefaults(); await writer.rememberClient(auth.sessionHash, auth.clientId, auth.expires);
  facts.initialRSS = process.memoryUsage().rss;
  const declarations = JSON.parse(await readFile('tests/raster/fixtures/resource-inputs.json', 'utf8')).fixtures;
  for (let cycle = 1; cycle <= 2; cycle++) for (const codec of ['lossless', 'lossy']) {
    const input = `tests/raster/fixtures/max-webp-${codec}.webp`, declaration = declarations.find(f => f.file === input);
    const iteration = { cycle, input, fixture: declaration, beforeRSS: process.memoryUsage().rss, status: 'running' }; facts.iterations.push(iteration);
    const original = await originalFor(input, declaration), prepared = await command({ type: 'PrepareRaster', assetId: original.id });
    const preview = prepared.event.payload.asset, review = (await command({ type: 'ReviewRaster', assetId: preview.id })).event.payload;
    const approved = (await command({ type: 'ApproveRaster', assetId: preview.id, reviewId: review.reviewId, reviewHash: review.reviewHash })).event.payload.asset;
    const info = approved.raster, expected = whiteHash(declaration.width * declaration.height * 4);
    if (info.width !== declaration.width || info.height !== declaration.height || info.pixels.hash !== expected) throw Error('Independent raw white oracle mismatch');
    const diagnostics = await writer.diagnostics(), decode = diagnostics.rasters.observations.find(o => o.commandId === prepared.commandId && o.nativeBudget !== undefined);
    if (!decode || decode.nativeRemaining !== 0 || decode.nativeDenied !== 0 || decode.nativePeak > decode.nativeBudget) throw Error('Missing or invalid bounded native cleanup metrics');
    iteration.settledRSS = [];
    for (let sample = 0; sample < 4; sample++) { await pause(125); iteration.settledRSS.push(process.memoryUsage().rss); }
    Object.assign(iteration, { originalAssetId: original.id, approvedAssetId: approved.id, prepareCommandId: prepared.commandId, pipeline: info.pipeline, pixels: info.pixels, expectedRawHash: expected, decode, peakRSS: process.resourceUsage().maxRSS * 1024 });
    if (iteration.peakRSS > limit) throw Error('Whole-process RSS ceiling exceeded');
    iteration.status = 'passed';
    await writeFile(out, JSON.stringify(facts, null, 2) + '\n');
  }
  facts.measuredSourcesAfter = await measuredSources();
  if (JSON.stringify(facts.measuredSources) !== JSON.stringify(facts.measuredSourcesAfter)) throw Error('Measured source changed during run');
  facts.status = 'passed';
} catch (error) { facts.status = 'failed'; facts.error = String(error); process.exitCode = 1; }
finally {
  facts.process = process.versions;
  if (writer) { facts.diagnostics = await writer.diagnostics(); await writer.close(); }
  facts.networkGuardAfter=await finishDiagnosticNetwork(networkGuard);if(facts.networkGuardAfter.status!=='passed'){facts.status='failed';facts.error='Network guard verification failed';process.exitCode=1;}
  facts.peakRSS = process.resourceUsage().maxRSS * 1024;
  facts.measuredSourcesAfter = await measuredSources();
  if (JSON.stringify(facts.measuredSources) !== JSON.stringify(facts.measuredSourcesAfter)) { facts.status='failed'; facts.error='Measured source changed'; process.exitCode=1; }
  if (facts.peakRSS > limit) { facts.status='failed'; facts.error='Whole-process RSS ceiling exceeded'; process.exitCode=1; }
  await writeFile(out, JSON.stringify(facts, null, 2) + '\n');
  console.log(JSON.stringify({ status: facts.status, error: facts.error, completedIterations: facts.iterations.filter(i => i.status === 'passed').length, peakRSS: facts.peakRSS, root }));
}
