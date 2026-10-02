// Ordinary C import proof. No lifecycle, browser, provider or compatibility claim.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readFile, realpath} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {attemptIdentity, digest, exclusiveJSON} from './common.mjs';
import {verifyAdapterResourceSampling} from './adapter-resource-sampling-verification.mjs';

const CHUNK = 1048576, MAX_PROOF = 2 * CHUNK, verified = new WeakMap();
const SHA = /^sha256:[a-f0-9]{64}$/, integer = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b, label) => assert(isDeepStrictEqual(a, b), label);
const validRef = value => SHA.test(value?.hash ?? '') && /^[1-9][0-9]*$/.test(value?.byteLength ?? '') && Number.isSafeInteger(Number(value.byteLength));
const counterKeys = ['submit', 'upload', 'poll', 'cancel', 'fetch', 'socket', 'dns', 'datagram'].sort();
export const isOrdinaryAdapterImport = cell => cell?.handler === 'adapters' && cell.host === 'C' && cell.kind === 'operation' && cell.workload === 'WA' && cell.operation === 'adapter.import';

/** One actual backing buffer, booked across every awaited file read and send.
 * Unlike a prefetching stream, no unobserved next chunk remains queued. */
export async function* observedAdapterFileChunks(path, {signal, resources, expectedBytes} = {}) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let release = null, releaseReader = null;
  try {
    releaseReader = resources?.handle?.('adapter-import-observer', 'file-reader') ?? null;
    const before = await file.stat(); assert(before.isFile(), 'Adapter input must be a regular file');
    if (expectedBytes !== undefined) assert(before.size === expectedBytes, 'Stored object length differs before read allocation');
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK, before.size + 1));
    release = resources?.buffer('adapter-import-observer', 'file-buffer', buffer) ?? (() => {});
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted(); const {bytesRead} = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead; assert(offset <= before.size, 'Adapter input grew during its bounded read');
      yield buffer.subarray(0, bytesRead);
    }
    const after = await file.stat();
    assert(offset === before.size && ['dev','ino','size','mtimeMs','ctimeMs'].every(key => before[key] === after[key]), 'Adapter input changed during its bounded read');
  } finally {
    try {await file.close(); releaseReader?.();}
    finally {release?.();}
    // A failed close deliberately retains its observed handle ownership.
  }
}

/** Private qualification observer only. Public adapter content remains
 * withheld. The exact typed hash selects one immutable object inside this
 * campaign's already-owned store; no arbitrary file or tensor decode occurs. */
export async function readBackAdapterAsset(root, asset, signal, resources) {
  assert(validRef(asset?.blob) && Number(asset.blob.byteLength) <= 1024 * CHUNK, 'Imported asset has no bounded complete byte identity');
  assert(typeof root === 'string' && isAbsolute(root) && resolve(root) === root && await realpath(root) === root, 'Private adapter store must be canonical');
  const hex = asset.blob.hash.slice(7), directory = join(root, 'objects', 'sha256', hex.slice(0, 2));
  for (const path of [root, join(root, 'objects'), join(root, 'objects', 'sha256'), directory]) {
    const info = await lstat(path); assert(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path, 'Private object directory is not an ordinary owned path');
  }
  const path = join(directory, hex), before = await lstat(path);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'Private object must be a single ordinary file');
  const hash = createHash('sha256'), expected = Number(asset.blob.byteLength); let bytes = 0, chunks = 0, maxChunk = 0;
  for await (const value of observedAdapterFileChunks(path, {signal, resources, expectedBytes: expected})) {
    hash.update(value); bytes += value.byteLength; chunks++; maxChunk = Math.max(maxChunk, value.byteLength);
  }
  const after = await lstat(path);
  assert(['dev','ino','size','mtimeMs','ctimeMs'].every(key => before[key] === after[key]), 'Private object path changed during readback');
  const observed = {assetId: asset.id, expected: asset.blob, hash: 'sha256:' + hash.digest('hex'), bytes, chunks, maxChunk};
  same(observed.hash, asset.blob.hash, 'Stored adapter bytes changed'); same(String(bytes), asset.blob.byteLength, 'Stored adapter length changed');
  return observed;
}

export async function collectAdapterImportProof({writer, root, resources, imported, phases, signal, counters}) {
  const assets = imported.storedAssets, readBack = [];
  for (const role of ['weights', 'config', 'registration']) readBack.push({role, ...await readBackAdapterAsset(root, assets[role], signal, resources)});
  const metadata = [];
  for (const [role, ref] of [['provenance', imported.asset.adapter.origin.provenance], ['validation', imported.asset.adapter.validation.report]]) {
    assert(validRef(ref) && Number(ref.byteLength) <= 65536, 'Imported metadata exceeds its bounded read');
    metadata.push(await writer.consumeMetadata(ref, bytes => {
      const value = {role, expected: ref, bytes: bytes.byteLength, hash: digest(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))};
      assert(value.hash === ref.hash && String(value.bytes) === ref.byteLength, 'Imported metadata hash or length changed'); return value;
    }));
  }
  const durability = [];
  for (const name of ['weights-stage-hash-durable', 'config-stage-hash-durable', 'header-profile-config-inspection-and-registration-durable']) {
    const phase = phases.find(value => value.name === name); assert(phase?.commandId && phase.receipt?.status === 'accepted');
    const record = await writer.lookup(phase.commandId), events = await writer.events(String(BigInt(phase.receipt.fromSeq) - 1n));
    const event = events.events.find(value => value.commandId === phase.commandId && value.seq === phase.eventSeq);
    same(record?.receipt, phase.receipt, 'Persisted import receipt changed'); same(event, phase.event, 'Persisted import event changed');
    durability.push({phase: name, commandId: phase.commandId, receipt: record.receipt, event});
  }
  let ownedLookup = null;
  if (counters && typeof counters.read === 'function' && counters.shared instanceof SharedArrayBuffer && counters.shared.byteLength === 32) {
    const before = counters.read(), observed = await writer.adapterView(imported.asset.id), after = counters.read();
    ownedLookup = {before, after, expected: imported.view, observed, scope: 'patched-network-APIs-main-and-writer'};
  }
  return {readBack, metadata, durability, ownedLookup};
}

function inspect(packet, cell, attempt, processIdentity, samplingReplay) {
  assert(packet.kind === 'ordinary-adapter-import-observation-1' && isOrdinaryAdapterImport(cell), 'Ordinary import proof belongs to another operation');
  same(packet.cellId, cell.id, 'Import proof cell changed'); same(packet.attemptId, attempt.id, 'Import proof attempt changed');
  same(packet.workerProcessIdentity, processIdentity, 'Import proof process changed');
  const resourceIdentity = JSON.parse(packet.processIdentity);
  assert(resourceIdentity.pid === processIdentity.pid && resourceIdentity.startedAt === processIdentity.startedAt && typeof resourceIdentity.writerEpoch === 'string', 'Import resource process is unbound');
  if (samplingReplay) for (const sample of samplingReplay.samples) assert(sample.producer?.worker?.writerEpoch === resourceIdentity.writerEpoch, 'Resource observation belongs to another writer epoch');
  const imported = packet.imported, assets = imported?.storedAssets;
  assert(assets && assets.registration.id === imported.asset.id, 'Import asset inventory is unavailable');
  same(assets.registration, imported.asset, 'Registration asset changed');
  assert(new Set(Object.values(assets).map(asset => asset.id)).size === 3, 'Imported role identities are not distinct');
  same(imported.asset.adapter.sources, {weightsAssetId: assets.weights.id, configAssetId: assets.config.id, provenanceAssetId: null}, 'Registration source bindings changed');
  assert(imported.view.available === true && imported.view.qualification === 'structurally-valid', 'Imported view is not available structural metadata');
  same(packet.phases.map(phase => phase.name), ['local-weights-hash', 'local-config-hash', 'weights-stage-hash-durable', 'config-stage-hash-durable',
    'header-profile-config-inspection-and-registration-durable', 'durable-entry-observation', 'adapter.import-durable'], 'Import phase inventory is incomplete or duplicated');
  const expectedBytes = cell.parameters?.bytes;
  assert(integer(expectedBytes) && expectedBytes > 0 && expectedBytes <= 1024 * CHUNK, 'Import workload byte size is unavailable');
  assert(validRef(assets.weights.blob) && Number(assets.weights.blob.byteLength) === expectedBytes && validRef(assets.config.blob) && Number(assets.config.blob.byteLength) <= CHUNK, 'Import weights/config violate the exact workload');
  for (const role of ['weights','config']) {
    const file = role === 'weights' ? imported.fixture : imported.config, blob = assets[role].blob;
    same({hash: file.hash, byteLength: String(file.bytes), mediaType: file.mediaType}, blob, 'Local import identity differs from stored asset');
    same(imported.asset.adapter[role], blob, 'Registered adapter identity differs from staged bytes'); same(imported.view[role], blob, 'Observed adapter view differs from staged bytes');
    const phase = packet.phases.find(value => value.name === 'local-' + role + '-hash');
    assert(phase?.outcome === 'expected' && phase.hash === blob.hash && phase.bytes === Number(blob.byteLength) && phase.maxChunk <= CHUNK && phase.chunks >= 1, 'Original full file hash witness is unavailable');
  }
  assert(imported.asset.adapter.validation.runtimeVerified === false && imported.asset.adapter.validation.locallyEligible === false
    && imported.asset.adapter.qualification === 'structurally-valid' && imported.view.versionId === imported.asset.id && imported.view.runtimeVerified === false && imported.view.locallyEligible === false,
  'Structural import invented supported or runtime eligibility');
  assert(imported.asset.adapter.origin.kind === 'import' && imported.asset.adapter.origin.original === null, 'Ordinary structural import has an unexpected provenance source');
  same(imported.asset.dependencies, [assets.config.blob, imported.asset.adapter.origin.provenance, imported.asset.adapter.validation.report], 'Imported dependency closure differs from exact typed metadata');
  assert(Array.isArray(packet.metadata) && packet.metadata.length === 2, 'Imported metadata byte closure is incomplete');
  for (const [index, role] of ['provenance', 'validation'].entries()) {
    const ref = role === 'provenance' ? imported.asset.adapter.origin.provenance : imported.asset.adapter.validation.report, observed = packet.metadata[index];
    assert(validRef(ref) && Number(ref.byteLength) <= 65536, 'Imported metadata reference is invalid');
    same(observed.role, role, 'Imported metadata role changed'); same(observed.expected, ref, 'Imported metadata expected reference changed');
    assert(observed.hash === ref.hash && String(observed.bytes) === ref.byteLength, 'Imported metadata full hash/length differs');
  }
  assert(Array.isArray(packet.readBack) && packet.readBack.length === 3, 'Complete stored byte readback is unavailable');
  assert(Array.isArray(packet.durability) && packet.durability.length === 3, 'Complete durable registration proof is unavailable');
  assert(new Set(packet.durability.map(value => value.commandId)).size === 3, 'Durable import command identities are not distinct');
  const phaseNames = ['weights-stage-hash-durable', 'config-stage-hash-durable', 'header-profile-config-inspection-and-registration-durable'];
  for (const [index, role] of ['weights','config','registration'].entries()) {
    const asset = assets[role], actual = packet.readBack[index], durable = packet.durability[index], phase = packet.phases.find(value => value.name === phaseNames[index]);
    assert(validRef(asset.blob), 'Imported role has no full immutable identity');
    same(actual.role, role, 'Readback role changed'); same(actual.assetId, asset.id, 'Readback asset changed'); same(actual.expected, asset.blob, 'Readback expected identity changed');
    assert(actual.hash === asset.blob.hash && String(actual.bytes) === asset.blob.byteLength && integer(actual.chunks) && actual.chunks > 0 && integer(actual.maxChunk) && actual.maxChunk > 0 && actual.maxChunk <= CHUNK, 'Stored byte hash/length proof differs');
    assert(phase?.outcome === 'expected' && phase.commandId === durable.commandId && durable.phase === phase.name && durable.receipt?.status === 'accepted' && durable.receipt.commandId === durable.commandId,
      'Durable command identity is unavailable');
    same(durable.receipt, phase.receipt, 'Durable receipt differs from original acknowledgement'); same(durable.event, phase.event, 'Durable event differs from original publication');
    assert(durable.event?.commandId === durable.commandId && durable.event.seq === phase.eventSeq && /^[1-9][0-9]*$/.test(durable.event.seq)
      && BigInt(durable.event.seq) >= BigInt(durable.receipt.fromSeq) && BigInt(durable.event.seq) <= BigInt(durable.receipt.toSeq), 'Durable event escapes accepted receipt sequence');
    assert(durable.event.type === 'AssetRegistered', 'Import event type changed');
    same(durable.event.payload?.asset, asset, 'Durable event does not retain exact imported asset');
    assert(phase.commandType === (role === 'registration' ? 'RegisterAdapterVersion' : 'FinalizeStaging'), 'Import command role changed');
  }
  const imports = packet.phases.filter(value => value.name === 'adapter.import-durable'); assert(imports.length === 1, 'Import timing boundary is not unique');
  const span = imports[0], window = packet.sampling?.observationWindow;
  assert(Number.isFinite(span.startMs) && Number.isFinite(span.endMs) && span.endMs >= span.startMs && span.outcome === 'expected', 'Import action boundary is invalid');
  const missing = [], rows = [
    {name: 'T05IncompleteOrUnverifiedIdentityAcceptanceCount', value: 0, unit: 'violations', method: 'Compared full local and stored hashes, exact accepted registration/view references and retained ineligible structural-only status.'},
    {name: 'T05BrowserTensorBytes', value: 0, unit: 'bytes', method: 'The sealed C adapter-only worker has no browser; actual bounded private object reads are retained; public adapter content remains withheld.'},
    {name: 'T06ArtifactHashOrDurabilityMismatchCount', value: 0, unit: 'violations', method: 'Re-read all stored weights/config bytes and exact provenance/validation metadata and compared original plus repeated durable command receipts/domain events against the exact accepted assets.'},
  ];
  assert(integer(packet.backendHighWaterRssBytes), 'Actual OS process high-water RSS is unavailable');
  if (samplingReplay) assert(samplingReplay.samples.every(sample => sample.backendRssBytes === null || packet.backendHighWaterRssBytes >= sample.backendRssBytes), 'OS process high water is below an actual retained RSS observation');
  rows.push({name: 'R17BackendRssBytes', value: packet.backendHighWaterRssBytes, unit: 'bytes', method: 'Actual OS process-lifetime high-water RSS, including main and worker threads, setup and warm primes; independent of booked allocation bytes.'});
  const bracketed = window?.startObservation?.endMs <= span.startMs && window?.endObservation?.startMs >= span.endMs;
  const continuous = samplingReplay?.recomputed?.allocationPeaks?.cpuBytes;
  if (samplingReplay?.complete === true && bracketed && continuous?.complete === true) {
    rows.push({name: 'R18CpuAllocationBytes', value: continuous.value, unit: 'bytes', method: 'Retained and replayed continuous shared ownership maximum in an independent window enclosing the full import and verification; driver file buffers are booked in the same aggregate.'});
  } else {
    missing.push('The exact import lacks complete retained continuous allocation ownership and boundary proof.');
    // Unknown total coverage cannot qualify a small observed subtotal, but
    // cannot hide a real above-ceiling owned-byte observation either.
    const observations = (samplingReplay?.samples ?? []).filter(sample => sample.scored === true && integer(sample.cpuBytes)
      && sample.observation.startMs >= span.startMs && sample.observation.endMs <= span.endMs).map(sample => sample.cpuBytes);
    if (bracketed && continuous?.window?.integrityComplete === true && integer(continuous.value)) observations.push(continuous.value);
    const lowerBound = observations.length ? Math.max(...observations) : null;
    if (lowerBound !== null && lowerBound > 512 * CHUNK) rows.push({name: 'R18CpuAllocationBytes', value: lowerBound, unit: 'bytes', lowerBound: true,
      method: 'Authenticated in-window owned allocation lower bound exceeds the unchanged 512 MiB ceiling; incomplete total coverage cannot erase this observed failure.'});
  }
  const lookup = packet.ownedLookup;
  if (lookup) {
    same(lookup.scope, 'patched-network-APIs-main-and-writer', 'Owned lookup counter scope changed');
    for (const counters of [lookup.before, lookup.after]) {same(Object.keys(counters).sort(), counterKeys, 'Owned lookup counter inventory is incomplete'); assert(counterKeys.every(key => integer(counters[key])), 'Owned lookup counter is invalid');}
    assert(counterKeys.every(key => lookup.after[key] >= lookup.before[key]), 'Owned lookup counters moved backwards');
    same(lookup.expected, imported.view, 'Owned lookup baseline changed'); same(lookup.observed, imported.view, 'Owned lookup immutable metadata changed');
    const value = counterKeys.reduce((sum, key) => sum + lookup.after[key] - lookup.before[key], 0); assert(integer(value));
    rows.push({name: 'T06UnchangedOwnedAssetFetches', value, unit: 'count', method: 'Actual shared main/writer deny-counter deltas during a separate exact-owned metadata lookup; scope is the eight patched APIs, not unobserved workers or DNS APIs.'});
  } else missing.push('Shared main/writer no-network counter evidence is unavailable for the owned lookup.');
  return {rows, missing};
}

export async function retainAdapterImportObservation({output, cell, sample, workerProcessIdentity, processIdentity, imported, phases, proof, sampling, backendHighWaterRssBytes}) {
  const packet = {kind: 'ordinary-adapter-import-observation-1', cellId: cell.id, attemptId: attemptIdentity(cell, sample.cache, sample.ordinal, sample.prime),
    workerProcessIdentity, processIdentity, imported, phases, ...proof, sampling, backendHighWaterRssBytes};
  const replay = sampling?.artifact?.path ? verifyAdapterResourceSampling(await readFile(sampling.artifact.path), sampling, {processIdentity, allowPriorSealedWindow: true}) : null;
  assert(replay?.status !== 'FAIL', 'Actual import resource stream contradicts its receipt');
  const analysis = inspect(packet, cell, {id: packet.attemptId}, workerProcessIdentity, replay);
  const bytes = Buffer.from(JSON.stringify(packet, null, 2) + '\n'); assert(bytes.length <= MAX_PROOF, 'Ordinary import proof exceeds its fixed bound');
  const path = join(output, 'adapter-import-' + randomUUID() + '.json'); await exclusiveJSON(path, packet);
  const evidence = {kind: packet.kind, artifact: {path, bytes: bytes.length, sha256: digest(bytes)}};
  return {observation: evidence, measurements: analysis.rows.map(row => ({...row, evidence})), missing: analysis.missing};
}

/** Replay only retained packet bytes. A JSON self-declaration never authorizes
 * rows in the campaign summary; authority is attached to this exact result. */
export async function verifyAdapterImportObservation({cell, attempt, workerProcessIdentity, readRetained}) {
  if (!isOrdinaryAdapterImport(cell)) return {applicable: false};
  const result = attempt.result, ref = result?.adapterImport?.artifact;
  if (!ref) {if (result?.status === 'PASS') throw Error('Passing ordinary import lacks retained proof'); return {applicable: true, complete: false};}
  assert(ref.bytes > 0 && ref.bytes <= MAX_PROOF && SHA.test(ref.sha256), 'Ordinary import artifact identity is invalid');
  const bytes = await readRetained(ref.path, {maximum: MAX_PROOF}); assert(Buffer.isBuffer(bytes) && bytes.length === ref.bytes && digest(bytes) === ref.sha256, 'Ordinary import retained bytes changed');
  const packet = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  same(packet.phases, result.phases, 'Import retained phase inventory changed');
  const sampling = packet.sampling, resourceBytes = sampling?.artifact?.path ? await readRetained(sampling.artifact.path, {maximum: 128 * CHUNK}) : null;
  const replay = resourceBytes ? verifyAdapterResourceSampling(resourceBytes, sampling, {processIdentity: packet.processIdentity, allowPriorSealedWindow: true}) : null;
  assert(replay?.status !== 'FAIL', 'Retained ordinary import resource evidence contradicts its receipt');
  const analysis = inspect(packet, cell, attempt, workerProcessIdentity, replay);
  const rows = analysis.rows.map(row => ({...row, evidence: result.adapterImport})); same(result.measurements, rows, 'Ordinary import rows differ from retained actual observations');
  if (analysis.missing.length && result.status === 'PASS') throw Error('Passing import omits required resource or network evidence');
  verified.set(result, {cellId: cell.id, fingerprint: digest(result), rows: structuredClone(rows)});
  return {applicable: true, complete: analysis.missing.length === 0, missing: analysis.missing};
}
export function verifiedAdapterImportMeasurements(result, cell) {
  const proof = result && verified.get(result);
  return proof?.cellId === cell.id && proof.fingerprint === digest(result) ? structuredClone(proof.rows) : [];
}
