// Finite diagnostic only. Run after the pinned build and functional raster gates.
import { mkdtemp, readFile, realpath, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { EMPTY_EXPECTED_VERSIONS } from '../../dist/local/src/protocol/store.js';
import { diagnosticIdentity } from './diagnostic-identity.mjs';
import {beginDiagnosticNetwork,finishDiagnosticNetwork,sharedDiagnosticCounters} from './diagnostic-network.mjs';
const networkGuard=await beginDiagnosticNetwork();
const [input, out] = process.argv.slice(2);
if (!input || !out) throw Error('Usage: node --import ./tests/store/no-network.mjs tooling/raster/measure-jpeg-export.mjs input.webp receipt.json');
const digest = b => 'sha256:' + createHash('sha256').update(b).digest('hex'), limit = 512 * 1024 * 1024;
const root = await mkdtemp(join(await realpath(tmpdir()), 'raster-jpeg-observe-'));
const auth = { clientId: 'jpeg-observe', sessionHash: 'b'.repeat(64), now: Date.now(), expires: Date.now() + 43200000 };
const sources = diagnosticIdentity;
const facts = { schemaVersion: 1, networkGuard, at: new Date().toISOString(), qualification: false, input, root, sourceHash: digest(await readFile(new URL(import.meta.url))), measuredSources: await sources(), commands: [], exports: [], rssLimit: limit, status: 'running', limits: 'One writer with one opaque WebP source and four sequential JPEG exports. Full-process OS maxRSS includes driver and all storage/raster workers. No forced GC; four125ms RSS observations after each export. This is a regression diagnostic, not PERF/H-C/W1/W2 qualification or proof for every image. No external effects.' };
let w;
async function command(body, raster = true) {
  const id = randomUUID(), value = { protocolVersion: 1, command: { schemaVersion: 1, commandId: id, clientId: auth.clientId, sessionId: 'jpeg-observe-provenance', correlationId: randomUUID(), causationId: null, transactionId: randomUUID(), documentId: null, expectedDocumentRevision: null, expectedEntityVersions: EMPTY_EXPECTED_VERSIONS, issuedAt: new Date().toISOString(), body } };
  const observed = { commandId: id, type: body.type, status: 'submitted' }, start = performance.now(); facts.commands.push(observed);
  await w[raster ? 'rasterCommand' : 'assetCommand'](Buffer.from(JSON.stringify(value)), auth);
  let state; const deadline = performance.now() + 120000;
  while (performance.now() < deadline) {
    state = await w.commandState(id); if (state.record) break;
    if (state.pending?.phase === 'waiting-for-resources') { observed.pending = state.pending; observed.status = 'resource-pending'; throw Error('Resource pending for original command ' + id); }
    await pause(5);
  }
  observed.elapsedMs = performance.now() - start;
  if (state?.record?.receipt.status !== 'accepted') { observed.state = state; throw Error('Missing accepted receipt ' + id); }
  observed.status = 'accepted'; observed.receipt = state.record.receipt;
  return { commandId: id, payload: (await w.events(String(BigInt(state.record.receipt.fromSeq) - 1n))).events[0].payload };
}
async function stage() {
  const size = (await stat(input)).size, id = randomUUID(), h = createHash('sha256');
  for await (const part of createReadStream(input, { highWaterMark: 1048576 })) h.update(part);
  const hash = 'sha256:' + h.digest('hex'); facts.inputSeal = { hash, bytes: size };
  await w.assetCreate({ protocolVersion: 1, stagingId: id, purpose: 'image', expectedBytes: String(size), sha256: hash, mediaType: 'image/webp' }, auth);
  let at = 0;
  for await (const part of createReadStream(input, { highWaterMark: 1048576 })) { const token = await w.assetBeginChunk(id, String(at), part.length, auth); await w.assetChunk(token, part, auth); at += part.length; }
  return (await command({ type: 'FinalizeStaging', stagingId: id, expectedSha256: hash }, false)).payload.asset;
}
try {
  w = await openWriter({ root },{effectCounters:sharedDiagnosticCounters()}); await w.protocolDefaults(); await w.rememberClient(auth.sessionHash, auth.clientId, auth.expires);
  const original = await stage(), prepared = (await command({ type: 'PrepareRaster', assetId: original.id })).payload.asset;
  const review = (await command({ type: 'ReviewRaster', assetId: prepared.id })).payload;
  const source = (await command({ type: 'ApproveRaster', assetId: prepared.id, reviewId: review.reviewId, reviewHash: review.reviewHash })).payload.asset;
  facts.source = source; facts.beforeExportsRSS = process.memoryUsage().rss;
  for (let iteration = 1; iteration <= 4; iteration++) {
    const beforeRSS = process.memoryUsage().rss, result = await command({ type: 'ExportRaster', assetId: source.id, options: { format: 'jpeg', quality: 0.9, matte: '#ffffff', resize: null } });
    const exported = result.payload.asset;
    if (exported.blob.mediaType !== 'image/jpeg' || exported.raster.width !== source.raster.width || exported.raster.height !== source.raster.height || exported.raster.pixels.hash !== source.raster.pixels.hash) throw Error('Opaque export raw identity or extent mismatch');
    const diagnostics = await w.diagnostics(), observation = diagnostics.rasters.observations.find(o => o.commandId === result.commandId && o.plan);
    if (!observation) throw Error('Missing exporter memory observation');
    const settledRSS = []; for (let n = 0; n < 4; n++) { await pause(125); settledRSS.push(process.memoryUsage().rss); }
    facts.exports.push({ iteration, commandId: result.commandId, beforeRSS, settledRSS, asset: exported, observation });
    if (process.resourceUsage().maxRSS * 1024 > limit) throw Error('Whole-process RSS ceiling exceeded');
    await writeFile(out, JSON.stringify(facts, null, 2) + '\n');
  }
  facts.measuredSourcesAfter = await sources(); if (JSON.stringify(facts.measuredSources) !== JSON.stringify(facts.measuredSourcesAfter)) throw Error('Measured source changed');
  facts.status = 'passed';
} catch (error) { facts.status = 'failed'; facts.error = String(error); process.exitCode = 1; }
finally {
  facts.process = process.versions;
  if (w) { facts.diagnostics = await w.diagnostics(); await w.close(); }
  facts.networkGuardAfter=await finishDiagnosticNetwork(networkGuard);if(facts.networkGuardAfter.status!=='passed'){facts.status='failed';facts.error='Network guard verification failed';process.exitCode=1;}
  facts.peakRSS = process.resourceUsage().maxRSS * 1024;
  facts.measuredSourcesAfter = await sources();
  if (JSON.stringify(facts.measuredSources) !== JSON.stringify(facts.measuredSourcesAfter)) { facts.status='failed'; facts.error='Measured source changed'; process.exitCode=1; }
  if (facts.peakRSS > limit) { facts.status='failed'; facts.error='Whole-process RSS ceiling exceeded'; process.exitCode=1; }
  await writeFile(out, JSON.stringify(facts, null, 2) + '\n');
  console.log(JSON.stringify({ status: facts.status, error: facts.error, exports: facts.exports.length, peakRSS: facts.peakRSS, root }));
}
