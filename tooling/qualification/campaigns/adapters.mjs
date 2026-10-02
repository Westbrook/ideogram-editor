// Actual adapter storage/transport actions for the PERF P-A and I7A/I8 campaigns.
// Cohort counts, process isolation, B0/idle sampling and verdicts belong to run.mjs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adapterLifecycleResult, measureAdapterAction } from './adapter-lifecycle.mjs';
import { resolveAdapterCorpus, assertImportedAdapterBinding } from './adapter-corpus.mjs';
import { createAdapterRetainedOracle } from './adapter-retained-oracle.mjs';
import { retainAdapterCycleMeasurements } from './adapter-measurements.mjs';
import { createAdapterResourceSampler, adapterReleaseWitness } from './adapter-resources.mjs';
import {observedAdapterFileChunks, collectAdapterImportProof, retainAdapterImportObservation} from './adapter-import-observation.mjs';

export const ADAPTER_CHUNK = 1024 * 1024;
export const ADAPTER_NORMAL_BYTES = 256 * ADAPTER_CHUNK;
export const ADAPTER_STRESS_BYTES = 1024 * ADAPTER_CHUNK;
export const OFFICIAL_ADAPTER = Object.freeze({ hash: 'sha256:bd0b96a2fcc3141400ebeffd8585b2d3c4c0d475b10e1468ba5c40acad748bc5', byteLength: '85299896', mediaType: 'application/octet-stream' });
const HEADER_BYTES = 1024;
const RECIPE = 'wa-u8-affine-byte-stream-1';
const CONFIG = Buffer.from('{"fixture":"wa-u8-affine-byte-stream-1","purpose":"bounded import qualification","runtime_compatibility":"unverified"}\n');
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const abort = signal => { if (signal?.aborted) throw signal.reason ?? Error('Campaign aborted'); };
const wait = ms => new Promise(done => setTimeout(done, ms));
const moduleAt = (repo, path) => import(pathToFileURL(join(repo, 'dist/local', path)).href);
const ref = (identity, mediaType) => ({ hash: identity.hash, byteLength: String(identity.bytes), mediaType });

/** Bounded deterministic real bytes; no sparse-file or truncate substitution. */
export function adapterFixtureHeader(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= HEADER_BYTES + 8) throw Error('Invalid adapter fixture length');
  const dataBytes = bytes - HEADER_BYTES - 8;
  const text = JSON.stringify({ __metadata__: { fixture: RECIPE, compatibility: 'structural-only' }, weights: { dtype: 'U8', shape: [dataBytes], data_offsets: [0, dataBytes] } });
  const header = Buffer.alloc(8 + HEADER_BYTES, 0x20);
  header.writeBigUInt64LE(BigInt(HEADER_BYTES)); header.write(text, 8, 'utf8');
  return header;
}

export async function hashAdapterFile(path, signal, resources) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Adapter fixture must be a regular nonsymlinked file');
  const hash = createHash('sha256'); let bytes = 0, chunks = 0, maxChunk = 0;
  for await (const chunk of resources ? observedAdapterFileChunks(path, {signal, resources}) : createReadStream(path, { highWaterMark: ADAPTER_CHUNK })) {
    abort(signal); hash.update(chunk); bytes += chunk.length; chunks++; maxChunk = Math.max(maxChunk, chunk.length);
  }
  const after = await lstat(path);
  if (info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs || bytes !== info.size) throw Error('Adapter fixture changed during hashing');
  return { hash: 'sha256:' + hash.digest('hex'), bytes, chunks, maxChunk };
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) { const result = await file.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) throw Error('Fixture write made no progress'); offset += result.bytesWritten; }
}
function fixturePattern() { const pattern = Buffer.alloc(ADAPTER_CHUNK); for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 73 + 19) & 255; return pattern; }
/** Independent of the on-disk manifest; changing file+manifest cannot bless a different recipe. */
export function adapterFixtureDigest(bytes) {
  const header = adapterFixtureHeader(bytes), hash = createHash('sha256').update(header), pattern = fixturePattern(); let remaining = bytes - header.length;
  while (remaining) { const count = Math.min(pattern.length, remaining); hash.update(pattern.subarray(0, count)); remaining -= count; }
  return 'sha256:' + hash.digest('hex');
}

/** Exported small sizes are for generator unit checks, never a WA measurement. */
export async function writeAdapterFixture(path, bytes, { signal } = {}) {
  const header = adapterFixtureHeader(bytes), file = await open(path, 'wx', 0o600), hash = createHash('sha256');
  const pattern = fixturePattern();
  let written = 0;
  try {
    await writeAll(file, header); hash.update(header); written += header.length;
    while (written < bytes) { abort(signal); const chunk = pattern.subarray(0, Math.min(pattern.length, bytes - written)); await writeAll(file, chunk); hash.update(chunk); written += chunk.length; }
    await file.sync();
  } finally { await file.close(); }
  return { path, bytes: written, hash: 'sha256:' + hash.digest('hex'), mediaType: 'application/octet-stream', recipe: RECIPE, locallyEligible: false };
}

/** Existing manifests are accepted only after checking every byte again. */
export async function prepareAdapterFixtures(directory, { sizes = [ADAPTER_NORMAL_BYTES, ADAPTER_STRESS_BYTES], signal } = {}) {
  if (!Array.isArray(sizes) || !sizes.length || new Set(sizes).size !== sizes.length || sizes.some(n => ![ADAPTER_NORMAL_BYTES, ADAPTER_STRESS_BYTES].includes(n))) throw Error('WA fixtures must be exactly 256 MiB or 1 GiB');
  directory = resolve(directory); await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw Error('Fixture directory must be canonical and nonsymlinked');
  const manifestPath = join(directory, 'adapter-fixtures.json');
  let existing;
  try { existing = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    assert.equal(existing.recipe, RECIPE); assert.equal(existing.schemaVersion, 1);
    for (const bytes of sizes) {
      const item = existing.weights.find(item => item.bytes === bytes); assert(item, 'Existing fixture set lacks a requested immutable size');
      assert.equal(item.path, join(directory, `weights-${bytes}.safetensors`)); const identity = await hashAdapterFile(item.path, signal);
      assert.equal(identity.hash, item.hash); assert.equal(identity.hash, adapterFixtureDigest(bytes)); assert.equal(identity.bytes, bytes); assert.equal(item.mediaType, 'application/octet-stream'); assert.equal(item.recipe, RECIPE); assert.equal(item.locallyEligible, false);
    }
    assert.equal(existing.config.path, join(directory, 'config.json')); const config = await hashAdapterFile(existing.config.path, signal);
    assert.equal(config.hash, digest(CONFIG)); assert.equal(config.bytes, CONFIG.length); assert.equal(existing.config.mediaType, 'text/plain');
    return existing;
  }
  const weights = [];
  for (const bytes of sizes) weights.push(await writeAdapterFixture(join(directory, `weights-${bytes}.safetensors`), bytes, { signal }));
  const configPath = join(directory, 'config.json'); await writeFile(configPath, CONFIG, { flag: 'wx', mode: 0o600 });
  const manifest = { schemaVersion: 1, recipe: RECIPE, weights, config: { path: configPath, hash: digest(CONFIG), bytes: CONFIG.length, mediaType: 'text/plain' },
    limits: ['Synthetic U8 payloads prove streamed hash/header/config/storage behavior only.', 'These hashes have no V4 compatibility profile and never acquire inference eligibility.', 'No provider request, training, or model execution occurs.'] };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return manifest;
}

export function adapterEnvelope(body, clientId = 'campaign-adapter-client', emptyVersions) {
  assert(emptyVersions, 'The production EMPTY_EXPECTED_VERSIONS reference is required');
  return { protocolVersion: 1, command: { schemaVersion: 1, commandId: randomUUID(), clientId, sessionId: 'campaign-adapter-session', correlationId: randomUUID(), causationId: null,
    transactionId: randomUUID(), documentId: null, expectedDocumentRevision: null, expectedEntityVersions: emptyVersions, issuedAt: new Date().toISOString(), body } };
}

async function adapterIO(writer, options) {
  const { EMPTY_EXPECTED_VERSIONS } = await moduleAt(options.repo, 'src/protocol/store.js');
  const clientId = options.clientId ?? 'campaign-adapter-client', sessionHash = createHash('sha256').update(clientId).digest('hex');
  const expires = Date.now() + 12 * 60 * 60 * 1000;
  const auth = () => ({ clientId, sessionHash, now: Date.now(), expires });
  await writer.rememberClient(sessionHash, clientId, expires);
  const envelope = body => adapterEnvelope(body, clientId, EMPTY_EXPECTED_VERSIONS);
  async function command(body, method, detail = {}) {
    abort(options.signal); const request = envelope(body); Object.assign(detail, { commandId: request.command.commandId, commandType: body.type });
    const start = performance.now(); await writer[method](Buffer.from(JSON.stringify(request)), auth());
    for (;;) {
      abort(options.signal); const record = await writer.lookup(request.command.commandId);
      if (record) {
        detail.receipt = record.receipt; detail.receiptObservedMs = performance.now() - start;
        assert.equal(record.receipt.status, 'accepted', JSON.stringify(record.receipt));
        const event = (await writer.events(String(BigInt(record.receipt.fromSeq) - 1n))).events.find(event => event.commandId === request.command.commandId);
        assert(event, 'A durable accepted receipt must have its domain event'); detail.eventSeq = event.seq; if (options.resources?.()) detail.event = event;
        return event.payload.asset;
      }
      if (performance.now() - start > 180000) throw Error('Adapter command did not publish a durable receipt within 180 seconds');
      await wait(5);
    }
  }
  async function stage(file, purpose, detail = {}) {
    const stagingId = randomUUID(); detail.stagingId = stagingId;
    await writer.assetCreate({ protocolVersion: 1, stagingId, purpose, expectedBytes: String(file.bytes), sha256: file.hash, mediaType: file.mediaType }, auth());
    let offset = 0, chunks = 0, maximumChunk = 0;
    for await (const bytes of options.resources?.() ? observedAdapterFileChunks(file.path, {signal: options.signal, resources: options.resources()}) : createReadStream(file.path, { highWaterMark: ADAPTER_CHUNK })) {
      abort(options.signal); const token = await writer.assetBeginChunk(stagingId, String(offset), bytes.length, auth());
      await writer.assetChunk(token, bytes, auth()); offset += bytes.length; chunks++; maximumChunk = Math.max(maximumChunk, bytes.length);
    }
    assert.equal(offset, file.bytes); Object.assign(detail, { bytes: offset, chunks, maximumChunk });
    const asset = await command({ type: 'FinalizeStaging', stagingId, expectedSha256: file.hash }, 'assetCommand', detail);
    assert.deepEqual(asset.blob, ref(file, file.mediaType)); return asset;
  }
  const register = (weights, config, name, detail, declaration = {}) => command({ type: 'RegisterAdapterVersion', adapterId: null, previousVersionId: null, weightsAssetId: weights.id, configAssetId: config?.id ?? null,
    provenanceAssetId: declaration.provenanceAssetId ?? null, name, declaredFamily: declaration.declaredFamily ?? 'ideogram-v4', declaredFormat: declaration.declaredFormat ?? 'fal', provenanceText: 'Sealed local qualification fixture. Structural inspection is not provider runtime verification.' }, 'adapterCommand', detail);
  return { auth, envelope, stage, register, command };
}

/** Called before browser server ownership begins. All 100 entries are real API registrations. */
export async function prepareAdapterLibrary(writer, fixtures, options) {
  const io = await adapterIO(writer, options), tinyPath = join(options.output, 'library-structural.safetensors');
  let tiny;
  try { const id = await hashAdapterFile(tinyPath, options.signal); assert.equal(id.bytes, 16384); assert.equal(id.hash, adapterFixtureDigest(16384)); tiny = { ...id, path: tinyPath, mediaType: 'application/octet-stream' }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; tiny = await writeAdapterFixture(tinyPath, 16384, { signal: options.signal }); }
  const base = await io.stage(tiny, 'adapter'), entries = [], eligibleEntries = [];
  const officialPath = options.officialPath ?? join(options.repo, 'artifacts/p27-evidence/fal-public-lora-example/provider-example.safetensors');
  let officialIdentity = null;
  try { officialIdentity = await hashAdapterFile(officialPath, options.signal); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (officialIdentity) { assert.equal(officialIdentity.hash, OFFICIAL_ADAPTER.hash); assert.equal(String(officialIdentity.bytes), OFFICIAL_ADAPTER.byteLength); }
  const original = officialIdentity ? await io.stage({ ...officialIdentity, path: officialPath, mediaType: 'application/octet-stream' }, 'adapter') : null;
  for (let index = 0; index < 100; index++) {
    const eligible = index < 3 && original;
    const asset = await io.register(eligible ? original : base, null, eligible ? `WA eligible selection ${index + 1}` : `WA metadata entry ${String(index + 1).padStart(3, '0')}`);
    const entry = await writer.adapterView(asset.id); assert.equal(entry.runtimeVerified, false);
    if (eligible) { assert.equal(entry.locallyEligible, true); assert.equal(entry.profileId, 'v4-fal-public-example-1'); eligibleEntries.push(entry); }
    else assert.equal(entry.locallyEligible, false);
    entries.push(entry);
  }
  const paged = []; let after = '';
  do { const page = await writer.adapterList(after); assert(page.items.length <= 20); assert(Buffer.byteLength(JSON.stringify(page)) <= 65536); paged.push(...page.items); after = page.nextAfter; } while (after);
  assert.equal(paged.length, 100); assert.equal(new Set(paged.map(entry => entry.versionId)).size, 100);
  return { entries, eligibleEntries, official: officialIdentity ? { path: officialPath, ...OFFICIAL_ADAPTER } : null, fixtureManifest: fixtures,
    limitations: eligibleEntries.length === 3 ? ['Selected eligible 85,299,896-byte reference versions are distinct from synthetic 256 MiB/1 GiB imported weights.'] : ['Official immutable profile fixture absent: attachment and WA same-import lifecycle are unqualified.'] };
}

function cellInput(cell) { return cell.parameters ?? cell.input ?? cell.workload ?? cell; }
const operation = cell => cell.operation ?? cell.action;
const result = (phases, observations, missing = []) => ({ status: missing.length ? 'inconclusive' : 'pass', phases, assertions: (observations.assertions ?? []).map((value, index) => typeof value === 'string' ? { id: 'adapter-' + (index + 1), passed: true, evidence: value } : value), observations, evidence: observations.evidence ?? [], missing });

export async function createAdapterCampaign(context) {
  const { repo, output, signal } = context; let writer, io, fixtures, library, closeTransport, rootPrepared = false, draftGeneration = 0, lifecycleOracle = null, corpusResolution = null, lastRelease = null, resourceSampler = null;
  const ownedSelectionReads = new Map();
  let oracleBaseline = null, importResources = null, activeImportSampler = null;
  const root = join(output, 'adapter-store');
  const documentId = context.fixture?.documentId ?? 'wa-campaign-document';
  const startedAt = context.processIdentity?.startedAt ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
  async function ensureWriter() {
    if (writer) return;
    if (!rootPrepared && context.fixture?.root) { await cp(context.fixture.root, root, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true }); library = context.fixture.adapterLibrary ?? context.fixture.adapters?.library ?? null; }
    await mkdir(root, { recursive: true, mode: 0o700 }); const { openWriter } = await moduleAt(repo, 'server/storage/writer.js');
    writer = await openWriter({ root }, globalThis.__storeNetworkCounters ? { effectCounters: globalThis.__storeNetworkCounters.shared } : undefined); await writer.protocolDefaults();
    // The sealed fixture already contains its preparation client binding. A
    // fresh cohort client preserves that original row and avoids duplicate
    // primary-key insertion when a transfer reopens the copied store.
    io = await adapterIO(writer, { repo, output, signal, resources: () => importResources, clientId: 'campaign-adapter-' + randomUUID() });
    rootPrepared = true;
  }
  async function caption(text) {
    const bytes = Buffer.from(text), path = join(output, randomUUID() + '.txt'); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return io.stage({ path, bytes: bytes.length, hash: digest(bytes), mediaType: 'text/plain' }, 'caption');
  }
  async function ui(body) {
    const state = await writer.uiRead('campaign-adapter-session', io.auth());
    const receipt = await writer.uiPersist(Buffer.from(JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), sessionId: 'campaign-adapter-session', expectedUISeq: state.uiSeq, body })), io.auth());
    assert.equal(receipt.status, 'accepted', JSON.stringify(receipt)); return receipt;
  }
  async function preferences(open) {
    const state = await writer.uiRead('campaign-adapter-session', io.auth());
    return ui({ type: 'SetPreferences', preferences: { ...state.preferences, documentId: open ? documentId : null, selectedLayerIds: [] } });
  }
  async function saveSelection(entries) {
    const { newDraft } = await moduleAt(repo, 'src/request/core.js'), prompt = await caption('Sealed adapter qualification selection; no submission.');
    const draft = newDraft(prompt.blob); draft.operation = 'generate-adapters';
    draft.adapters = entries.map(entry => ({ version: entry.versionId, hash: entry.weights.hash, scale: '1', runtimeAcknowledged: true }));
    const staged = await caption(JSON.stringify(draft)); draftGeneration++;
    return ui({ type: 'SaveDraft', draft: { id: 'wa-campaign-request', generation: String(draftGeneration), kind: 'request', documentId, targetLayerId: null,
      expectedDocumentRevision: await writer.documentRevision(documentId), assetId: staged.id, composing: false } });
  }
  async function currentSelection({ retain = false } = {}) {
    const state = await writer.uiRead('campaign-adapter-session', io.auth()), draft = state.drafts.find(item => item.id === 'wa-campaign-request');
    if (!draft) return [];
    const content = await writer.assetVerify(draft.assetId);
    ownedSelectionReads.set(content.handle, { acquiredMs: performance.now(), assetId: draft.assetId, handleIdentity: digest(content.handle) });
    let retained = false, bytes = null;
    try {
      const size = Number(content.asset.blob.byteLength); assert(size <= 65536, 'Qualification selection draft is bounded metadata');
      bytes = await writer.assetContent(draft.assetId, content.handle, '0', size);
      const value = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
      assert(Array.isArray(value.adapters)); retained = retain; return value.adapters;
    } finally { if (bytes) writer.releaseResourceBytes?.(bytes); if (!retained) { await writer.assetRelease(content.handle); ownedSelectionReads.delete(content.handle); } }
  }
  async function phase(phases, name, work) {
    abort(signal); const startMs = performance.now(), entry = { name, startedAt: new Date().toISOString(), startMs, startMonotonicMs: startMs, outcome: 'running' }; phases.push(entry);
    await context.trace?.({ event: 'adapter-phase-start', phase: { ...entry } });
    try { const value = await work(entry); entry.outcome = 'expected'; return value; }
    catch (error) { entry.outcome = 'failed'; entry.error = { message: String(error.message ?? error), code: error.code ?? null }; throw error; }
    finally { entry.endMs = performance.now(); entry.durationMs = entry.elapsedMs = entry.endMs - entry.startMs; await context.trace?.({ event: 'adapter-phase-end', phase: entry }); }
  }
  async function prepareCell(cell) {
    if (!['adapter.import', 'adapter.select', 'adapter.lifecycle', 'adapter.transfer', 'adapter.setup', 'adapter.audit'].includes(operation(cell))) throw Error('Unsupported adapter operation: ' + operation(cell));
    if (operation(cell) === 'adapter.audit') return { kind: 'adapter-predecessor-audit', unrelatedWriterOpened: false, declaredReceipts: context.configuration?.auditReceipts ?? [] };
    const input = cellInput(cell), bytes = input.bytes ?? ADAPTER_NORMAL_BYTES;
    if (operation(cell) === 'adapter.lifecycle') {
      corpusResolution ??= await resolveAdapterCorpus(context.fixture, { signal, requiredBytes: ADAPTER_NORMAL_BYTES });
      if (corpusResolution.specimen) fixtures = { weights: [corpusResolution.specimen.weights], config: corpusResolution.specimen.config };
      await ensureWriter();
      if (!context.fixture?.documentId || !await writer.document(documentId)) throw Object.assign(Error('WA requires its complete sealed W1 document; no empty replacement is created'), { code: 'CAMPAIGN_PREREQUISITE' });
      if (library?.entries?.length !== 100) throw Object.assign(Error('WA requires its existing sealed 100-entry library'), { code: 'CAMPAIGN_PREREQUISITE' });
      await preferences(false);
      if (!lifecycleOracle) {
        lifecycleOracle = await createAdapterRetainedOracle({ repo, root, fixture: context.fixture, output, signal });
        oracleBaseline = await lifecycleOracle.baseline();
        if (oracleBaseline.status === 'FAIL') throw Error('The sealed WA baseline failed its retained metadata/byte proof');
      }
      return { root, corpus: corpusResolution, baseline: oracleBaseline, library, missing: corpusResolution.missing };
    }
    if (!fixtures?.weights.some(item => item.bytes === bytes)) {
      const prepared = await prepareAdapterFixtures(join(output, 'adapter-fixtures-' + bytes), { sizes: [bytes], signal });
      fixtures = fixtures ? { ...prepared, weights: [...fixtures.weights, ...prepared.weights] } : prepared;
    }
    await ensureWriter();
    if (!library && operation(cell) !== 'adapter.audit') library = await prepareAdapterLibrary(writer, fixtures, { repo, root, output, signal, officialPath: context.fixture?.officialAdapterPath });
    return { fixture: fixtures, root, library, limitations: ['Filesystem cache state is supplied and attested by the outer campaign controller; this module does not flush OS caches.'] };
  }
  async function imported(cell, phases, specimen = null) {
    const importStartMs = performance.now();
    const bytes = cellInput(cell).bytes ?? ADAPTER_NORMAL_BYTES, fixture = fixtures.weights.find(item => item.bytes === bytes); assert(fixture, 'Prepare this exact fixture size first');
    await phase(phases, 'local-weights-hash', async entry => { Object.assign(entry, await hashAdapterFile(fixture.path, signal, importResources)); assert.equal(entry.hash, fixture.hash); });
    await phase(phases, 'local-config-hash', async entry => { Object.assign(entry, await hashAdapterFile(fixtures.config.path, signal, importResources)); assert.equal(entry.hash, fixtures.config.hash); });
    const weights = await phase(phases, 'weights-stage-hash-durable', entry => io.stage(fixture, 'adapter', entry));
    const config = await phase(phases, 'config-stage-hash-durable', entry => io.stage(fixtures.config, 'caption', entry));
    const provenance = specimen?.provenance ? await phase(phases, 'provenance-stage-hash-durable', entry => io.stage(specimen.provenance, 'caption', entry)) : null;
    const asset = await phase(phases, 'header-profile-config-inspection-and-registration-durable', entry => io.register(weights, config, `WA ${bytes} byte import`, entry, { ...specimen, provenanceAssetId: provenance?.id ?? null }));
    assert.equal(asset.adapter.validation.runtimeVerified, false);
    if (!specimen) { assert.equal(asset.adapter.qualification, 'structurally-valid'); assert.equal(asset.adapter.validation.locallyEligible, false); }
    assert.deepEqual(asset.adapter.weights, weights.blob); assert.deepEqual(asset.adapter.config, config.blob);
    const view = await phase(phases, 'durable-entry-observation', () => writer.adapterView(asset.id)); assert.equal(view.versionId, asset.id);
    const importEndMs = performance.now(); phases.push({ name: 'adapter.import-durable', startMs: importStartMs, endMs: importEndMs, elapsedMs: importEndMs - importStartMs, durationMs: importEndMs - importStartMs, outcome: 'expected' });
    const binding = specimen ? assertImportedAdapterBinding({ asset, view, specimen, ...(await moduleAt(repo, 'src/adapters/profile.js')) }) : null;
    return { asset, view, fixture, config: fixtures.config, binding, ...(importResources ? {storedAssets: {weights, config, registration: asset}} : {}) };
  }
  async function execute(cell, sample = {}) {
    if (operation(cell) === 'adapter.audit') { const { performAdapterAudit } = await import('./adapter-audit.mjs'); return performAdapterAudit(context, cell); }
    if (!writer || !fixtures) await prepareCell(cell); const phases = [], op = operation(cell);
    if (op === 'adapter.import') {
      const processIdentity = JSON.stringify(rawLifecycleIdentity());
      importResources = (await moduleAt(repo, 'server/observability/adapter-resources.js')).adapterResources;
      activeImportSampler = createAdapterResourceSampler({writer: () => writer, output, processIdentity, signal});
      let sampling;
      try {
        // The independent shared allocation window starts before the first
        // input read and ends after all stored-byte/receipt verification.
        await activeImportSampler.measure();
        const importedValue = await imported(cell, phases);
        const proof = await collectAdapterImportProof({writer, root, resources: importResources, imported: importedValue, phases, signal, counters: globalThis.__storeNetworkCounters});
        sampling = await activeImportSampler.stop();
        const retained = await retainAdapterImportObservation({output, cell, sample, workerProcessIdentity: context.processIdentity,
          processIdentity, imported: importedValue, phases, proof, sampling, backendHighWaterRssBytes: process.resourceUsage().maxRSS * 1024});
        const answer = result(phases, {...importedValue, browserTensorBytes: 0}, retained.missing);
        answer.adapterImport = retained.observation; answer.measurements = retained.measurements;
        return answer;
      } finally {
        // Closing a failed observation retains its raw failure bytes. It must
        // not leave a window active across a later warm attempt or cleanup.
        try {if (!sampling) await activeImportSampler.stop();}
        finally {activeImportSampler = null; importResources = null;}
      }
    }
    if (op === 'adapter.select') {
      const viewed = await phase(phases, 'metadata-library-selection-read', async () => {
        const selected = [];
        for (const entry of library.eligibleEntries) { const actual = await writer.adapterView(entry.versionId); assert.deepEqual(actual, entry); selected.push(actual); }
        return selected;
      });
      return result(phases, { entries: library.entries.length, viewed, browserTensorBytes: 0 }, ['Backend metadata view does not measure browser attachment or presented paint; use browser-adapters.mjs on H.']);
    }
    if (op === 'adapter.lifecycle') {
      const lifecyclePhases = [], countersBefore = globalThis.__storeNetworkCounters?.read() ?? null, selectionBefore = await currentSelection();
      assert.deepEqual(selectionBefore, [], 'This isolated WA cohort starts with no request attachments');
      const specimen = corpusResolution?.specimen, missing = [...(corpusResolution?.missing ?? [])], resourceSamples = [];
      const sampleResources = async action => { const value = { ...await measureResources(), action, observedMs: performance.now() }; resourceSamples.push(value); return value; };
      const ownershipKeys = ['processTree', 'workerThreads', 'stagingBuffers', 'hashBuffers', 'headerBuffers', 'configBuffers', 'ioCopies', 'metadataConsumers', 'assetReadHandles', 'proofHandles', 'streamHandles'];
      const allocationsCovered = value => value.cpuBytes !== null && ownershipKeys.every(key => value.backendOwnership?.coverage?.[key] === true);
      const assertions = { fixedArtifactsImported: null, selectionRestored: null, durableFixturePreserved: null, noBrowserTensorDecode: true, zeroUnexpectedFetches: null };
      await sampleResources('before-open');
      await phase(phases, 'open-document-and-library-consumers', async entry => { entry.receipt = await preferences(true); entry.page = await writer.adapterList(); });
      let importedValue = null, selectionAfter = null, closure = null, ownedLookup = null, entries = [];
      if (specimen) {
        importedValue = await measureAdapterAction(lifecyclePhases, phases, 'import', () => imported(cell, phases, specimen));
        assertions.fixedArtifactsImported = true;
        missing.push(...importedValue.binding.missing);
        await sampleResources('after-import');
        if (globalThis.__storeNetworkCounters) {
          const before = globalThis.__storeNetworkCounters.read(), observed = await writer.adapterView(importedValue.asset.id), after = globalThis.__storeNetworkCounters.read();
          ownedLookup = { before, after, expected: importedValue.view, observed }; assert.deepEqual(observed, importedValue.view); assert.deepEqual(after, before);
        }
        if (importedValue.binding.eligible) {
          // Every selected version is the durable version created in this cycle.
          // The separately sealed 85 MiB reference library cannot substitute.
          entries = [importedValue.view];
          await measureAdapterAction(lifecyclePhases, phases, 'select', () => phase(phases, 'select-exact-imported-version-in-durable-request-draft', async entry => {
            entry.receipt = await saveSelection(entries); entry.versions = entries.map(item => item.versionId);
            entry.observedSelection = await currentSelection({ retain: true });
            assert.deepEqual(entry.observedSelection.map(item => ({ version: item.version, hash: item.hash })), entries.map(item => ({ version: item.versionId, hash: item.weights.hash })));
          }));
          await sampleResources('after-select');
          await measureAdapterAction(lifecyclePhases, phases, 'unselect', () => phase(phases, 'unselect-exact-imported-version-in-durable-request-draft', async entry => {
            entry.receipt = await saveSelection([]); selectionAfter = await currentSelection(); assert.deepEqual(selectionAfter, selectionBefore); assertions.selectionRestored = true;
          }));
        }
      } else missing.push('The sealed fixed-size WA import specimen is unavailable; no replacement fixture was generated.');
      await measureAdapterAction(lifecyclePhases, phases, 'close', () => phase(phases, 'close-document-consumers', async entry => { entry.receipt = await preferences(false); }));
      await measureAdapterAction(lifecyclePhases, phases, 'release', () => phase(phases, 'release-owned-selection-read-consumers', async entry => {
        const startMs = performance.now(), acquired = [...ownedSelectionReads.values()];
        for (const handle of [...ownedSelectionReads.keys()]) { await writer.assetRelease(handle); ownedSelectionReads.delete(handle); }
        const scopedEndMs = performance.now();
        const state = await writer.uiRead('campaign-adapter-session', io.auth()); assert.equal(state.preferences.documentId, null);
        let resourceObservation = await sampleResources('after-release');
        lastRelease = adapterReleaseWitness({ startMs, scopedEndMs, acquired, resources: resourceObservation, processIdentity: JSON.stringify(rawLifecycleIdentity()) });
        // A completed writer call is not proof that its last consumer released.
        // Observe real ownership until quiescent or the specified release limit.
        while (acquired.length && !lastRelease.completeOwnerCoverage && performance.now() - startMs < 5000
          && resourceObservation.producer?.aggregate?.integrityComplete === true) {
          abort(signal); await wait(Math.min(100, Math.max(1, 5000 - (performance.now() - startMs)))); abort(signal);
          resourceObservation = await sampleResources('after-release');
          lastRelease = adapterReleaseWitness({ startMs, scopedEndMs, acquired, resources: resourceObservation, processIdentity: JSON.stringify(rawLifecycleIdentity()) });
        }
        const observedReaders = resourceObservation.campaignConsumers?.retainedOracleReaders;
        lastRelease.releaseLimitViolation = lastRelease.endMs !== null && lastRelease.endMs - startMs > 5000
          && (resourceObservation.unusedHandles > 0 || resourceObservation.campaignConsumers?.scopedSelectionReaders > 0
            || observedReaders?.openFiles > 0 || observedReaders?.openDatabases > 0);
        entry.release = lastRelease;
      }));
      if (lifecycleOracle) {
        closure = await phase(phases, 'complete-retained-fixture-byte-closure', () => lifecycleOracle.checkpoint({ importedAssetIds: importedValue ? [importedValue.asset.id] : [] }));
        assertions.durableFixturePreserved = closure.assertions?.durableFixturePreserved ?? null;
        missing.push(...(closure.missing ?? []));
      }
      const countersAfter = globalThis.__storeNetworkCounters?.read() ?? null;
      if (countersBefore && countersAfter) { assert.deepEqual(countersAfter, countersBefore); assertions.zeroUnexpectedFetches = true; }
      if (!entries.length) missing.push('Selection/unselection require actual supported eligibility for the exact imported weights/config; no other version was attached.');
      const ownedCoverage = resourceSamples.every(allocationsCovered);
      if (!ownedCoverage || lastRelease?.completeOwnerCoverage !== true)
        missing.push('Actual backend allocation or post-release unused-handle ownership evidence is incomplete; scoped reader release alone cannot establish it.');
      const measurements = await retainAdapterCycleMeasurements({ output, cell, cycle: sample.cycle, processIdentity: JSON.stringify(await lifecycleIdentity()), fixtureIdentity: context.fixture?.seal?.sha256, specimen, imported: importedValue, closure, ownedLookup, phases: lifecyclePhases });
      const answer = adapterLifecycleResult({ phases: lifecyclePhases, childPhases: phases, assertions, selectedEntries: entries,
        weightsIdentity: specimen?.weights.hash ?? null, configIdentity: specimen?.config.hash ?? null, releaseMs: lastRelease?.durationMs ?? null, resourceSamples,
        observations: { imported: importedValue, importedBinding: importedValue?.binding.binding ?? null, cycle: sample.cycle ?? null, selectionBefore, selectionAfter,
          countersBefore, countersAfter, ownedLookup, closure, selectedImportedIdentity: entries.length ? true : null, release: lastRelease, forcedGC: false },
        missing });
      answer.measurements = measurements;
      if (lastRelease?.releaseLimitViolation) { answer.status = 'FAIL'; answer.capViolation = true; }
      return answer;
    }
    if (op === 'adapter.transfer') {
      const transport = await import('./adapter-transfers.mjs');
      const execution = await transport.runAdapterTransfer({ context, cell, fixtures, root, writer, io, phase: (name, work) => phase(phases, name, work), releaseWriter: async () => { await writer.close(); writer = null; io = null; }, resumeWriter: async () => { await ensureWriter(); return io; } });
      phases.push({ name: 'adapter.transfer-durable', startMs: execution.observations.firstTransferStartMs, endMs: execution.observations.firstTransferEndMs, elapsedMs: execution.observations.firstTransferToBothDurableMs, outcome: 'expected' });
      closeTransport = execution.close;
      const answer = result(phases, execution.observations, execution.missing ?? []);
      answer.measurements = [
        { name: 'T06ArtifactHashOrDurabilityMismatchCount', value: 0, unit: 'violations', method: 'Actual streamed transport hashes, fsync evidence and durable original registration assertions.', evidence: execution.observations.fixtureHashes },
        { name: 'R17BackendRssBytes', value: process.resourceUsage().maxRSS * 1024, unit: 'bytes', method: 'OS cumulative Node-process high-water RSS including writer worker threads and transfer evidence storage.', evidence: [process.pid] },
      ];
      if (execution.observations.capacityRecheckGapMs !== null) answer.measurements.push({ name: 'R31TransferCapacityRecheckGapMs', value: execution.observations.capacityRecheckGapMs, unit: 'ms',
        method: 'Worst gap between actual production Objects.capacity successful completions across the weights and config transfers, including each transfer\'s leading and trailing intervals.', evidence: execution.observations.transfers.map(transfer => ({ role: transfer.role, ...transfer.capacity })) });
      return answer;
    }
    if (op === 'adapter.setup') return result(phases, { fixture: fixtures, library, root });
    throw Error('Unsupported adapter operation: ' + op);
  }
  function rawLifecycleIdentity() { return { pid: process.pid, startedAt, writerEpoch: writer?.epoch ?? null, root }; }
  async function lifecycleIdentity() {
    resourceSampler ??= createAdapterResourceSampler({ writer: () => writer, output, processIdentity: () => JSON.stringify(rawLifecycleIdentity()), signal,
      readCampaignConsumers: () => ({ scopedSelectionReaders: ownedSelectionReads.size, retainedOracleReaders: lifecycleOracle?.readerObservation() ?? null }) });
    await resourceSampler.start(); return rawLifecycleIdentity();
  }
  async function measureResources() {
    await lifecycleIdentity();
    return resourceSampler.measure();
  }
  return { prepareCell, resetCell: async (cell, sample) => ({ cell: cell.id, cache: sample.cache, processReset: false, retainedFixtureIdentities: fixtures?.weights.map(item => item.hash) ?? [] }), execute,
    lifecycleCycle: execute, lifecycleIdentity, measureResources,
    get fixtureIdentity() { return context.fixture?.seal?.sha256 ?? context.fixture?.manifestHash ?? context.fixture?.sha256 ?? null; },
    get weightsIdentity() { return corpusResolution?.specimen?.weights.hash ?? fixtures?.weights.find(item => item.bytes === ADAPTER_NORMAL_BYTES)?.hash ?? null; },
    get configIdentity() { return corpusResolution?.specimen?.config.hash ?? fixtures?.config.hash ?? null; },
    async releaseEvidence() { return { release: lastRelease, scopedSelectionReaders: ownedSelectionReads.size, completeOwnerCoverage: lastRelease?.completeOwnerCoverage === true, resourceObservation: lastRelease?.resourceObservation ?? null }; },
    async finalizeLifecycle() { return lifecycleOracle ? lifecycleOracle.completeSeries() : { status: 'INCONCLUSIVE', complete: false, missing: ['The initial WA retained fixture oracle was unavailable.'] }; },
    async resourceSamplingEvidence() { return resourceSampler ? resourceSampler.stop() : { kind: 'attributed-backend-process-and-allocation-ledger', complete: false, missing: ['No continuous resource sampler was started before B0.'] }; },
    async close() { if (resourceSampler) await resourceSampler.stop(); await closeTransport?.(); if (writer) { for (const handle of [...ownedSelectionReads.keys()]) { await writer.assetRelease(handle); ownedSelectionReads.delete(handle); } await writer.close(); writer = null; } await lifecycleOracle?.close(); } };
}
