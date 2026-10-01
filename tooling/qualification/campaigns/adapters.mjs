// Actual adapter storage/transport actions for the PERF P-A and I7A/I8 campaigns.
// Cohort counts, process isolation, B0/idle sampling and verdicts belong to run.mjs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adapterLifecycleResult, measureAdapterAction } from './adapter-lifecycle.mjs';

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

export async function hashAdapterFile(path, signal) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Adapter fixture must be a regular nonsymlinked file');
  const hash = createHash('sha256'); let bytes = 0, chunks = 0, maxChunk = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: ADAPTER_CHUNK })) {
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
        assert(event, 'A durable accepted receipt must have its domain event'); detail.eventSeq = event.seq;
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
    for await (const bytes of createReadStream(file.path, { highWaterMark: ADAPTER_CHUNK })) {
      abort(options.signal); const token = await writer.assetBeginChunk(stagingId, String(offset), bytes.length, auth());
      await writer.assetChunk(token, bytes, auth()); offset += bytes.length; chunks++; maximumChunk = Math.max(maximumChunk, bytes.length);
    }
    assert.equal(offset, file.bytes); Object.assign(detail, { bytes: offset, chunks, maximumChunk });
    const asset = await command({ type: 'FinalizeStaging', stagingId, expectedSha256: file.hash }, 'assetCommand', detail);
    assert.deepEqual(asset.blob, ref(file, file.mediaType)); return asset;
  }
  const register = (weights, config, name, detail) => command({ type: 'RegisterAdapterVersion', adapterId: null, previousVersionId: null, weightsAssetId: weights.id, configAssetId: config?.id ?? null,
    provenanceAssetId: null, name, declaredFamily: 'ideogram-v4', declaredFormat: 'fal', provenanceText: 'Deterministic qualification fixture. Structural inspection is not provider runtime verification.' }, 'adapterCommand', detail);
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
  const { repo, output, signal } = context; let writer, io, fixtures, library, closeTransport, rootPrepared = false, draftGeneration = 0;
  const root = join(output, 'adapter-store');
  const documentId = context.fixture?.documentId ?? 'wa-campaign-document';
  const startedAt = context.processIdentity?.startedAt ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
  async function ensureWriter() {
    if (writer) return;
    if (!rootPrepared && context.fixture?.root) { await cp(context.fixture.root, root, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true }); library = context.fixture.adapterLibrary ?? context.fixture.adapters?.library ?? null; }
    await mkdir(root, { recursive: true, mode: 0o700 }); const { openWriter } = await moduleAt(repo, 'server/storage/writer.js');
    writer = await openWriter({ root }, globalThis.__storeNetworkCounters ? { effectCounters: globalThis.__storeNetworkCounters.shared } : undefined); await writer.protocolDefaults(); io = await adapterIO(writer, { repo, output, signal });
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
  async function currentSelection() {
    const state = await writer.uiRead('campaign-adapter-session', io.auth()), draft = state.drafts.find(item => item.id === 'wa-campaign-request');
    if (!draft) return [];
    const content = await writer.assetVerify(draft.assetId);
    try {
      const size = Number(content.asset.blob.byteLength); assert(size <= 65536, 'Qualification selection draft is bounded metadata');
      const bytes = await writer.assetContent(draft.assetId, content.handle, '0', size), value = JSON.parse(Buffer.from(bytes).toString('utf8'));
      assert(Array.isArray(value.adapters)); return value.adapters;
    } finally { await writer.assetRelease(content.handle); }
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
    if (!fixtures?.weights.some(item => item.bytes === bytes)) {
      const prepared = await prepareAdapterFixtures(join(output, 'adapter-fixtures-' + bytes), { sizes: [bytes], signal });
      fixtures = fixtures ? { ...prepared, weights: [...fixtures.weights, ...prepared.weights] } : prepared;
    }
    await ensureWriter();
    if (!library && operation(cell) !== 'adapter.audit') library = await prepareAdapterLibrary(writer, fixtures, { repo, root, output, signal, officialPath: context.fixture?.officialAdapterPath });
    if (operation(cell) === 'adapter.lifecycle') {
      if (!await writer.document(documentId)) { const request = io.envelope({ type: 'NewDocument', width: 2048, height: 2048, color: 'sRGB', depth: 8 }); request.command.documentId = documentId; assert.equal((await writer.submit(Buffer.from(JSON.stringify(request)), writer.epoch)).status, 'accepted'); }
      await preferences(false);
    }
    return { fixture: fixtures, root, library, limitations: ['Filesystem cache state is supplied and attested by the outer campaign controller; this module does not flush OS caches.'] };
  }
  async function imported(cell, phases) {
    const importStartMs = performance.now();
    const bytes = cellInput(cell).bytes ?? ADAPTER_NORMAL_BYTES, fixture = fixtures.weights.find(item => item.bytes === bytes); assert(fixture, 'Prepare this exact fixture size first');
    await phase(phases, 'local-weights-hash', async entry => { Object.assign(entry, await hashAdapterFile(fixture.path, signal)); assert.equal(entry.hash, fixture.hash); });
    await phase(phases, 'local-config-hash', async entry => { Object.assign(entry, await hashAdapterFile(fixtures.config.path, signal)); assert.equal(entry.hash, fixtures.config.hash); });
    const weights = await phase(phases, 'weights-stage-hash-durable', entry => io.stage(fixture, 'adapter', entry));
    const config = await phase(phases, 'config-stage-hash-durable', entry => io.stage(fixtures.config, 'caption', entry));
    const asset = await phase(phases, 'header-profile-config-inspection-and-registration-durable', entry => io.register(weights, config, `WA ${bytes} byte import`, entry));
    assert.equal(asset.adapter.qualification, 'structurally-valid'); assert.equal(asset.adapter.validation.locallyEligible, false); assert.equal(asset.adapter.validation.runtimeVerified, false);
    assert.deepEqual(asset.adapter.weights, weights.blob); assert.deepEqual(asset.adapter.config, config.blob);
    const view = await phase(phases, 'durable-entry-observation', () => writer.adapterView(asset.id)); assert.equal(view.versionId, asset.id);
    const importEndMs = performance.now(); phases.push({ name: 'adapter.import-durable', startMs: importStartMs, endMs: importEndMs, elapsedMs: importEndMs - importStartMs, outcome: 'expected' });
    return { asset, view, fixture, config: fixtures.config };
  }
  async function execute(cell, sample = {}) {
    if (operation(cell) === 'adapter.audit') { const { performAdapterAudit } = await import('./adapter-audit.mjs'); return performAdapterAudit(context, cell); }
    if (!writer || !fixtures) await prepareCell(cell); const phases = [], op = operation(cell);
    if (op === 'adapter.import') {
      const importedValue = await imported(cell, phases);
      const answer = result(phases, { ...importedValue, browserTensorBytes: 0, assertions: ['Exact weights/config hashes and byte counts retained.', 'Production streaming stage, full hash, bounded header/config inspection and durable registration completed.', 'Synthetic structure did not gain V4 eligibility.'] });
      answer.measurements = [
        { name: 'T05IncompleteOrUnverifiedIdentityAcceptanceCount', value: 0, unit: 'violations', method: 'Production receipt and retained metadata identity assertions; ineligible weights remain ineligible.', evidence: [importedValue.asset.id] },
        { name: 'T05BrowserTensorBytes', value: 0, unit: 'bytes', method: 'This C backend process has no browser and streams bounded files through production storage APIs.', evidence: [process.pid] },
        { name: 'R17BackendRssBytes', value: process.resourceUsage().maxRSS * 1024, unit: 'bytes', method: 'OS cumulative Node-process high-water RSS including writer worker threads, setup and warm primes.', evidence: [process.pid] },
      ];
      if (globalThis.__storeNetworkCounters) {
        const before = globalThis.__storeNetworkCounters.read(); const reread = await writer.adapterView(importedValue.asset.id); assert.deepEqual(reread, importedValue.view); const after = globalThis.__storeNetworkCounters.read(); assert.deepEqual(after, before);
        answer.measurements.push({ name: 'T06UnchangedOwnedAssetFetches', value: 0, unit: 'count', method: 'Separate exact-owned metadata lookup under shared main/worker no-network counters; not a transfer specimen.', evidence: [{ before, after }] });
      }
      return answer;
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
      const fixedWeights = fixtures.weights.find(item => item.bytes === ADAPTER_NORMAL_BYTES), fixedConfig = fixtures.config;
      assert(fixedWeights && fixedConfig, 'WA lifecycle has fixed normal weights and config');
      await phase(phases, 'open-document-and-library-consumers', async entry => { entry.receipt = await preferences(true); entry.page = await writer.adapterList(); });
      const importedValue = await measureAdapterAction(lifecyclePhases, phases, 'import', () => imported(cell, phases));
      assert.equal(importedValue.asset.adapter.weights.hash, fixedWeights.hash); assert.equal(importedValue.asset.adapter.config.hash, fixedConfig.hash);
      const entries = library.eligibleEntries;
      const assertions = { fixedArtifactsImported: true, selectionRestored: null, durableFixturePreserved: null, noBrowserTensorDecode: true, zeroUnexpectedFetches: null };
      if (entries.length !== 3) return adapterLifecycleResult({ phases: lifecyclePhases, childPhases: phases, assertions, weightsIdentity: fixedWeights.hash, configIdentity: fixedConfig.hash, observations: { imported: importedValue, cycle: sample.cycle ?? null, actionsCompleted: ['open', 'import'], forcedGC: false }, missing: ['Three supported immutable selection versions are absent; remaining WA lifecycle actions cannot be represented by synthetic eligibility.'] });
      let selectionAfter, diagnostics;
      await measureAdapterAction(lifecyclePhases, phases, 'select', () => phase(phases, 'select-three-immutable-adapters-in-durable-request-draft', async entry => {
        entry.receipt = await saveSelection(entries); entry.versions = entries.map(item => item.versionId); entry.observedSelection = await currentSelection();
        assert.deepEqual(entry.observedSelection.map(item => ({ version: item.version, hash: item.hash })), entries.map(item => ({ version: item.versionId, hash: item.weights.hash })));
      }));
      await measureAdapterAction(lifecyclePhases, phases, 'unselect', () => phase(phases, 'unselect-all-adapters-in-durable-request-draft', async entry => {
        entry.receipt = await saveSelection([]); selectionAfter = await currentSelection(); assert.deepEqual(selectionAfter, selectionBefore); assertions.selectionRestored = true;
      }));
      await measureAdapterAction(lifecyclePhases, phases, 'close', () => phase(phases, 'close-document-consumers', async entry => { entry.receipt = await preferences(false); }));
      await measureAdapterAction(lifecyclePhases, phases, 'release', () => phase(phases, 'release-transient-operation-consumers', async entry => {
        const state = await writer.uiRead('campaign-adapter-session', io.auth()); assert.equal(state.preferences.documentId, null); entry.openDocument = null; diagnostics = entry.diagnostics = await writer.diagnostics();
      }));
      const countersAfter = globalThis.__storeNetworkCounters?.read() ?? null;
      if (countersBefore && countersAfter) { assert.deepEqual(countersAfter, countersBefore); assertions.zeroUnexpectedFetches = true; }
      return adapterLifecycleResult({ phases: lifecyclePhases, childPhases: phases, assertions, selectedEntries: entries, weightsIdentity: fixedWeights.hash, configIdentity: fixedConfig.hash,
        observations: { imported: importedValue, cycle: sample.cycle ?? null, selectionBefore, selectionAfter, countersBefore, countersAfter, diagnostics, selectedImportedIdentity: false, actionsCompleted: ['open', 'import', 'select', 'unselect', 'close', 'release'], forcedGC: false },
        missing: ['The synthetic 256 MiB imported identity has no eligible profile; actual durable draft selection uses distinct sealed 85,299,896-byte versions. Same-import WA lifecycle remains unqualified.', 'No complete retained-fixture byte-closure or unused-handle/release-duration observation is available in this backend-only workflow.', ...(!context.fixture?.documentId ? ['No full sealed W1 document fixture supplied; this run used a real empty 2048x2048 document.'] : [])] });
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
  return { prepareCell, resetCell: async (cell, sample) => ({ cell: cell.id, cache: sample.cache, processReset: false, retainedFixtureIdentities: fixtures?.weights.map(item => item.hash) ?? [] }), execute,
    lifecycleCycle: execute,
    async lifecycleIdentity() { return { pid: process.pid, startedAt, writerEpoch: writer?.epoch ?? null, root }; },
    get fixtureIdentity() { return context.fixture?.seal?.sha256 ?? context.fixture?.manifestHash ?? context.fixture?.sha256 ?? null; },
    get weightsIdentity() { return fixtures?.weights.find(item => item.bytes === ADAPTER_NORMAL_BYTES)?.hash ?? null; },
    get configIdentity() { return fixtures?.config.hash ?? null; },
    async measureResources() { const diagnostics = writer ? await writer.diagnostics() : null; return { backendRssBytes: process.memoryUsage().rss, browserRssBytes: null, cpuBytes: null, gpuBytes: null, previewCacheBytes: null, settledBytes: null, unusedHandles: null, textureSide: null, deviceTextureLimit: null, processTree: { kind: 'node-process-and-worker-threads', pid: process.pid }, diagnostics, activeResources: process.getActiveResourcesInfo(), forcedGC: false }; },
    async releaseEvidence() { return { consumers: [], browserConsumersPresent: false, retainedDurableFixtures: true, diagnostics: writer ? await writer.diagnostics() : null, missing: ['No browser consumer release measurement is provided by the backend-only adapter.'] }; },
    async close() { await closeTransport?.(); if (writer) { await writer.close(); writer = null; } } };
}
