// H-WA evidence covers the source-reviewed selected-File opaque upload path and
// the owned application's HTTP lifecycle. It is not a claim about arbitrary
// JavaScript tensor interpretation, all browser networking or OS egress.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { exclusiveJSON, fileIdentity } from './common.mjs';
import { readPhaseSnapshot } from './browser-phase-snapshot.mjs';
import { createBrowserWARequests } from './browser-wa-requests.mjs';
import { analyzeWANetwork } from './browser-wa-network.mjs';
export { analyzeWANetwork } from './browser-wa-network.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
export const waMetadataIdentity = value => hash(canonical(value));
const natural = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value ?? '');
const equal = isDeepStrictEqual;
const freeze = value => {if (value && typeof value === 'object') {for (const item of Object.values(value)) freeze(item); Object.freeze(value);} return value;};
const copy = value => structuredClone(value);
const authority = new WeakMap();
export const WA_BROWSER_SCOPE = 'reviewed-selected-file-opaque-upload-and-owned-application-http-1';
// Exact product-path review closure carried by correction103. Runtime callers
// cannot supply approvals; a changed path remains unavailable until reviewed.
export const WA_OPAQUE_PATH_SOURCE_PINS = freeze([
  {
    "path": "src/observability/adapter-upload-hook.ts",
    "bytes": 1214,
    "sha256": "sha256:756a93d71aff8092d41c9eefa8ddabbe5983acdcc2f5350e958b3b263db8ceb9"
  },
  {
    "path": "src/observability/adapter-upload.ts",
    "bytes": 13589,
    "sha256": "sha256:77d8bc7603e9a7db0df09369078b02381bca012c92c30c7df1a3b014b198dbba"
  },
  {
    "path": "src/ui/adapter-library.ts",
    "bytes": 54986,
    "sha256": "sha256:2d74226de4868f840641a453d874cead9a35e432b23471d6b3d7e282ee595d80"
  },
  {
    "path": "src/observability/browser.ts",
    "bytes": 21101,
    "sha256": "sha256:bf2d6fa12ae6de9e8d13405574643e664b32fed12ff57d697b6eaacd9c9bc2a1"
  },
  {
    "path": "src/state/editor-client.ts",
    "bytes": 126951,
    "sha256": "sha256:a6724c187618d422bbf913946bba65fc1cbe3cae26458c66176e05f5fa5a26b9"
  },
  {
    "path": "src/protocol/sha256.ts",
    "bytes": 2672,
    "sha256": "sha256:6125bfb8366910293774bd3efb05edcbc8f37fddd3642d6c43a7921ed0e73684"
  },
  {
    "path": "src/state/session-client.ts",
    "bytes": 10034,
    "sha256": "sha256:7d134699839c9c260022e736260b8581931d07a8b44d5cac06882c3f702a386a"
  },
  {
    "path": "src/state/draft-persistence.ts",
    "bytes": 19231,
    "sha256": "sha256:6fce26e74b45da071e17331726e961a72b6f3006a63aaa47edb8089d91f65a5f"
  },
  {
    "path": "src/state/control-memory.ts",
    "bytes": 3960,
    "sha256": "sha256:80b1f564855ef58462d44a708fc211770ed73f481ba44f71db13fdef75716d75"
  },
  {
    "path": "src/state/command-results.ts",
    "bytes": 15408,
    "sha256": "sha256:b771ee97323f8393f0eea83998af06e733bfd7349b902f63b4abf32a63ea9b4b"
  },
  {
    "path": "src/observability/model-memory.ts",
    "bytes": 5243,
    "sha256": "sha256:79d5f368134a38dcc01abdf29d42bff9840c4f42d6e3f8aa3c83864d5e58f118"
  },
  {
    "path": "src/observability/prompt-memory.ts",
    "bytes": 6877,
    "sha256": "sha256:65d2bd5efb45197f2f4edecbcbde7b40f0fc65acb278fde42e02f57146eb30dc"
  },
  {
    "path": "src/observability/allocations.ts",
    "bytes": 39758,
    "sha256": "sha256:95ea4f1dd0e6cba1cce3950d48df473d78168a76cd5c2bc16d5e83c92ab16e9d"
  },
  {
    "path": "src/observability/diagnostic-memory.ts",
    "bytes": 7157,
    "sha256": "sha256:1c0fb3ff0c1ea0e346106d84ca6f561cf1a097fb1ec355f96ff49429318d27cf"
  },
  {
    "path": "src/ui/request.ts",
    "bytes": 136351,
    "sha256": "sha256:56021ccf277ea102d2ca41d8ff69f18013fc9047f1636e6eb744b472da8c6b76"
  }
]);

export const isBrowserWALifecycle = cell => cell?.host === 'H' && cell.handler === 'browser' && cell.kind === 'lifecycle' && cell.workload === 'WA' && cell.operation === 'adapter.lifecycle' && /^(AH2|I8H)\/WA-lifecycle$/.test(cell.id);

export function waExecutableBinding(identity) {
  if (!identity || !Array.isArray(identity.sourceFiles) || !Array.isArray(identity.buildFiles)
    || hash(identity.sourceFiles).slice(7) !== identity.sourceDigest || hash(identity.buildFiles) !== identity.buildDigest || !sha(identity.toolsDigest)) return null;
  const sources = new Map(identity.sourceFiles.map(row => [row.path, row]));
  if (!WA_OPAQUE_PATH_SOURCE_PINS.length || WA_OPAQUE_PATH_SOURCE_PINS.some(pin => {
    const actual = sources.get(pin.path); return !actual || actual.deleted || actual.bytes !== pin.bytes || 'sha256:' + actual.sha256 !== pin.sha256;
  })) return null;
  const builds = identity.buildFiles.filter(row => row.path.startsWith('dist/app/'));
  if (!builds.length || !builds.some(row => row.path === 'dist/app/build-evidence.json') || builds.some(row => !natural(row.bytes) || !sha(row.sha256))) return null;
  return {scope: WA_BROWSER_SCOPE, sourceDigest: identity.sourceDigest, buildDigest: identity.buildDigest, toolsDigest: identity.toolsDigest,
    reviewedSources: copy(WA_OPAQUE_PATH_SOURCE_PINS), appBuildFiles: copy(builds)};
}

function readRuns(value, bytes, maximum) {
  if (!value || !Array.isArray(value.runs) || value.runs.length < 1 || value.runs.length > 8 || value.from !== 0 || value.to !== bytes
    || value.byteLength !== bytes || value.contiguous !== true || !natural(value.chunks) || !natural(value.maxChunk) || value.maxChunk > maximum) return false;
  let offset = 0, chunks = 0, largest = 0;
  for (const run of value.runs) {
    if (!run || run.offset !== offset || !natural(run.length) || run.length < 1 || run.length > maximum || !natural(run.chunks) || run.chunks < 1) return false;
    const length = run.length * run.chunks; if (!natural(length) || !natural(offset + length)) return false;
    offset += length; chunks += run.chunks; largest = Math.max(largest, run.length);
  }
  return offset === bytes && chunks === value.chunks && largest === value.maxChunk;
}
function acknowledged(value, bytes) {
  if (value.initialCommittedOffset !== '0' || value.lastCommittedOffset !== String(bytes) || value.lastState !== 'complete'
    || value.acks !== value.chunks || !Array.isArray(value.ackRuns) || value.ackRuns.length < 1 || value.ackRuns.length > 8) return false;
  let offset = 0, count = 0;
  for (const run of value.ackRuns) {
    if (!run || run.from !== String(offset) || !natural(run.step) || run.step < 1 || run.step > 1048576 || !natural(run.count) || run.count < 1) return false;
    offset += run.step * run.count; count += run.count;
    if (!natural(offset) || run.to !== String(offset)) return false;
  }
  if (offset !== bytes || count !== value.acks || !Array.isArray(value.runs)) return false;
  // Equal totals are insufficient: the actual ACK must follow each exact read.
  let readIndex = 0, readRemaining = value.runs[0]?.chunks ?? 0;
  for (const ack of value.ackRuns) {
    let remaining = ack.count;
    while (remaining > 0) {
      const read = value.runs[readIndex];
      if (!read || read.length !== ack.step || !natural(readRemaining) || readRemaining < 1) return false;
      const matched = Math.min(remaining, readRemaining); remaining -= matched; readRemaining -= matched;
      if (readRemaining === 0) {readIndex++; readRemaining = value.runs[readIndex]?.chunks ?? 0;}
    }
  }
  return readIndex === value.runs.length && readRemaining === 0;
}

/** Replay the actual producer's compact read/ACK transcripts; no decoder-zero
 * counter, File size alone, or source inventory alone establishes this claim. */
export function analyzeWAUploads(before, imported, after, selected) {
  const missing = [], failures = [], absent = reason => missing.push(reason);
  for (const value of [before, imported, after]) if (value?.kind !== 'adapter-upload-observation-1' || value.schemaVersion !== 1
    || value.scope !== 'ownedUpload-opaque-hash-and-transfer' || typeof value.realmId !== 'string'
    || !natural(value.sequence) || !natural(value.dropped) || !natural(value.invalid) || value.overflow !== false
    || value.active !== 0 || !Array.isArray(value.operations) || value.operations.length > 256) absent('opaque-upload-producer-boundary-unavailable');
  if (missing.length) return {complete: false, missing, failures, operations: []};
  if (before.realmId !== imported.realmId || before.realmId !== after.realmId || imported.sequence < before.sequence
    || after.sequence !== imported.sequence || before.dropped !== imported.dropped || imported.dropped !== after.dropped
    || before.invalid !== imported.invalid || imported.invalid !== after.invalid) absent('opaque-upload-realm-sequence-or-selection-read-coverage');
  if ([before, imported, after].some(value => value.operations.some(row => !row || typeof row !== 'object' || !natural(row.sequence) || row.sequence < 1 || row.sequence > value.sequence || row.id !== value.realmId + ':' + row.sequence) || new Set(value.operations.map(row => row?.id)).size !== value.operations.length)) absent('opaque-upload-malformed-operation');
  if (missing.length) return {complete: false, missing, failures, operations: []};
  if (!equal(imported.operations, after.operations)) absent('opaque-upload-post-import-operation-inventory-changed');
  const operations = imported.operations.filter(row => row.sequence > before.sequence);
  const expected = [['adapter-weights', selected?.weights], ['adapter-config', selected?.config], ...(selected?.provenance ? [['adapter-provenance', selected.provenance]] : [])];
  if (operations.length !== expected.length || imported.sequence - before.sequence !== expected.length) absent('opaque-upload-exact-selected-file-inventory');
  const ids = new Set(), stageIds = new Set();
  let owner = null;
  for (let i = 0; i < operations.length; i++) {
    const row = operations[i], pair = expected[i], ref = pair?.[1], size = Number(ref?.byteLength);
    if (!pair || row.role !== pair[0] || row.purpose !== (row.role === 'adapter-weights' ? 'adapter' : 'caption')
      || row.sequence !== before.sequence + i + 1 || row.id !== imported.realmId + ':' + row.sequence
      || ids.has(row.id) || stageIds.has(row.stagingId) || typeof row.stagingId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.stagingId)) absent('opaque-upload-file-lineage-or-operation-identity');
    ids.add(row.id); stageIds.add(row.stagingId);
    if (!natural(size) || size < 1 || !sha(ref?.hash)) absent('opaque-upload-selected-file-identity-unavailable');
    else if (row.bytes !== size || row.hash?.sha256 !== ref.hash) failures.push('opaque-upload-selected-file-digest-or-length-mismatch');
    if (row.outcome !== 'complete' || row.settled !== true || row.liveReads !== 0 || !Array.isArray(row.missing) || row.missing.length
      || !readRuns(row.hash, size, 65536) || !readRuns(row.transfer, size, 1048576) || !acknowledged(row.transfer, size)) absent('opaque-upload-complete-read-hash-ack-settlement');
    const identity = row.owner;
    if (!identity || !sha(identity.sessionHash) || !sha(identity.clientHash) || identity.draftSessionHash !== null && !sha(identity.draftSessionHash)
      || identity.documentHash !== null && !sha(identity.documentHash) || !natural(identity.documentEpoch) || !natural(identity.editorEpoch)) absent('opaque-upload-owner-identity-unavailable');
    if (owner && !equal(owner, identity)) absent('opaque-upload-owner-changed'); owner ??= identity;
    const retained = after.operations.find(value => value?.id === row.id); if (!equal(retained, row)) absent('opaque-upload-settled-transcript-changed-during-selection');
  }
  return {complete: missing.length === 0 && failures.length === 0, missing: [...new Set(missing)], failures: [...new Set(failures)], operations: copy(operations)};
}

export function analyzeBrowserWAObservation(raw, expected) {
  const missing = [], failures = [];
  if (raw?.kind !== 'wa-browser-observation-1' || raw.scope !== WA_BROWSER_SCOPE || !isBrowserWALifecycle(expected?.cell)) missing.push('planned-H-WA-observation-required');
  const binding = raw?.binding;
  if (!binding || typeof binding.processIdentity !== 'string' || !binding.processIdentity || !sha(binding.fixtureIdentity) || !Number.isSafeInteger(binding.cycle) || binding.cycle < 1 || binding.cycle > 2 || binding.cellId !== expected?.cell?.id || binding.cycle !== expected?.cycle || binding.processIdentity !== expected?.processIdentity
    || binding.fixtureIdentity !== expected?.fixtureIdentity || !equal(binding.executable, waExecutableBinding(expected?.executableIdentity))) missing.push('exact-H-WA-executable-cycle-fixture-binding');
  if (!binding?.executable || !equal(raw?.selected, expected?.selected)) missing.push('reviewed-opaque-path-and-imported-identity-required');
  const uploads = analyzeWAUploads(raw?.uploads?.before, raw?.uploads?.afterImport, raw?.uploads?.after, raw?.selected);
  const network = analyzeWANetwork(raw?.network, raw?.selected ?? {}, uploads.operations);
  const producerMissing = Array.isArray(raw?.missing) && raw.missing.length <= 128 && raw.missing.every(value => typeof value === 'string' && value.length <= 256) ? raw.missing : ['producer-missing-inventory-unavailable'];
  missing.push(...producerMissing, ...uploads.missing, ...network.missing); failures.push(...uploads.failures, ...network.failures);
  const bindingValid = !!binding?.executable && !missing.some(reason => ['exact-H-WA-executable-cycle-fixture-binding','reviewed-opaque-path-and-imported-identity-required','planned-H-WA-observation-required'].includes(reason)) ;
  const tensor = bindingValid && uploads.failures.length ? false : bindingValid && !producerMissing.length && uploads.complete ? true : null;
  const fetch = bindingValid && network.failures.length ? false : bindingValid && !producerMissing.length && network.complete ? true : null;
  const measurements = [];
  if (natural(network.repeatedPayloadFetches) && bindingValid && (!producerMissing.length && network.complete || network.repeatedPayloadFetches > 0)) for (const name of ['T06UnchangedOwnedAssetFetches','R32UnchangedOwnedAssetFetches']) measurements.push({name, value: network.repeatedPayloadFetches, unit: 'count', complete: bindingValid && !producerMissing.length && network.complete});
  if (network.identityMismatch !== null && bindingValid && (!producerMissing.length && network.complete || network.identityMismatch > 0)) measurements.push({name: 'R32CacheIdentityMismatchCount', value: network.identityMismatch, unit: 'violations', complete: bindingValid && !producerMissing.length && network.complete});
  return {scope: WA_BROWSER_SCOPE, authenticated: bindingValid, complete: missing.length === 0 && failures.length === 0, assertions: {noBrowserTensorDecode: tensor, zeroUnexpectedFetches: fetch},
    missing: [...new Set(missing)], failures: bindingValid ? [...new Set(failures)] : [], measurements, uploads, network};
}

export function waSelectedImport(imported, specimen) {
  const asset = imported?.asset, binding = imported?.binding?.binding;
  if (!asset || !binding) return null;
  return {versionId: binding.versionId, weights: copy(binding.weights), config: copy(binding.config), provenance: copy(asset.adapter?.origin?.original ?? null),
    weightsAssetId: asset.adapter?.sources?.weightsAssetId ?? null, configAssetId: asset.adapter?.sources?.configAssetId ?? null, provenanceAssetId: asset.adapter?.sources?.provenanceAssetId ?? null};
}

/** Installed on the fresh owned context before product navigation. Collection
 * is passive; the only initialization call loads the product diagnostic owner
 * before B0. The existing lifecycle and repeated metadata reads do all work. */
export function createBrowserWAObservation({page, context, proxy, server, runtime, executableIdentity, output}) {
  const requests = createBrowserWARequests({context, page, runtime, allowedOrigins: [server.origin]}), initialRuntime = copy(runtime), executable = waExecutableBinding(executableIdentity);
  const setupMissing = []; let current = null, closed = false;
  const uploads = () => readPhaseSnapshot(page, owner => owner?.value?.adapterUploads ?? null);
  async function observed(work, label, fallback = null) {
    try {return await work();} catch { (current?.missing ?? setupMissing).push(label); return fallback; }
  }
  async function prepare() {
    await observed(async () => {
      const initialized = await page.evaluate(async () => {
        const value = globalThis.__IDEOGRAM_PHASES__;
        if (typeof value?.ensureAdapterUploads !== 'function') return false;
        await value.ensureAdapterUploads(); return true;
      });
      if (!initialized) throw Error('WA observer unavailable');
      const value = await uploads(); if (value?.kind !== 'adapter-upload-observation-1' || value.active !== 0) throw Error('WA observer baseline unavailable');
    }, 'product-opaque-upload-initialization-unavailable');
  }
  async function beginCycle({cell, cycle, processIdentity, fixtureIdentity, documentId, metadataSearchName}) {
    assert(!closed && !current && isBrowserWALifecycle(cell), 'H-WA observation requires its exact active lifecycle');
    current = {kind: 'wa-browser-observation-1', scope: WA_BROWSER_SCOPE, id: randomUUID(),
      binding: {cellId: cell.id, cycle, processIdentity, fixtureIdentity, executable, runtime: copy(initialRuntime)},
      uploads: {before: null, afterImport: null, after: null}, network: {binding: {engine: initialRuntime.engine}, browser: null, proxy: null, backendBefore: null, backendAfter: null, lookup: null, expected: {documentHash: typeof documentId === 'string' ? hash(documentId) : null, metadataRegistration: 'before-cycle-observers', metadataURLHashes: typeof metadataSearchName === 'string' ? [...new Set(['/api/v1/adapters', '/api/v1/adapters?search=' + encodeURIComponent(metadataSearchName), '/api/v1/adapters?' + new URLSearchParams({search: metadataSearchName})].map(path => hash(new URL(path, server.origin).href)))] : [], draftFacts: [], draftAssets: []}},
      selected: null, missing: [...setupMissing], instrumentation: {owner: 'external-campaign-worker', productResourceAccounting: 'Browser/backend resource sampling excludes the external campaign worker; its request/proxy ledgers and bounded retained-file proof are observer overhead.', browserRequestLimit: 4096, proxyRequestLimit: 4096, retainedProofBytes: 16 * 1048576, productUploadMetadata: 'Actual producer allowance and read handles are charged by DiagnosticMemory and the product allocation ledger.'}};
    const raw = current;
    raw.uploads.before = await observed(uploads, 'product-upload-cycle-baseline-unavailable');
    raw.network.backendBefore = await observed(() => server.effects(), 'backend-cycle-effects-baseline-unavailable');
    const proxyStart = await observed(() => proxy.beginObservation(raw.id), 'proxy-cycle-start-unavailable');
    const browserStart = await observed(() => requests.beginObservation(raw.id), 'browser-cycle-start-unavailable');
    raw.network.expected.carryInSSE = [];
    for (const row of browserStart?.rows ?? []) {
      if (!row.activeAtStart || !row.longLivedSSE || row.method !== 'GET' || row.route !== 'events-stream' || row.originIndex !== 0) continue;
      const matches = (proxyStart?.requests ?? []).filter(other => other.carriedIn && other.method === row.method && other.urlSha256 === row.urlSha256 && other.route === row.route && other.originIndex === row.originIndex && !other.blocked);
      if (matches.length === 1) raw.network.expected.carryInSSE.push({browserRequestId: row.requestId, proxyRequestId: matches[0].requestId, method: row.method, urlSha256: row.urlSha256, route: row.route, id: row.id, originIndex: 0});
      else raw.missing.push('carry-in-SSE-baseline-identity-unavailable');
    }
    return raw.id;
  }
  async function afterImport() {if (current) current.uploads.afterImport = await observed(uploads, 'product-upload-import-settlement-unavailable');}
  async function beforeLookup({path, expected}) {
    if (!current) return;
    const snapshot = await observed(() => requests.snapshotObservation(current.id), 'browser-lookup-start-unavailable');
    current.network.lookup = {urlSha256: hash(new URL(path, server.origin).href), expectedSha256: waMetadataIdentity(expected), observedSha256: null,
      beforeRequestIds: (snapshot?.rows ?? []).map(row => row.requestId), afterRequestIds: null,
      backendBefore: await observed(() => server.effects(), 'backend-lookup-start-unavailable'), backendAfter: null};
  }
  async function afterLookup(observedEntry) {
    const lookup = current?.network.lookup; if (!lookup) return;
    lookup.observedSha256 = waMetadataIdentity(observedEntry);
    const snapshot = await observed(() => requests.snapshotObservation(current.id), 'browser-lookup-end-unavailable');
    lookup.afterRequestIds = (snapshot?.rows ?? []).map(row => row.requestId);
    lookup.backendAfter = await observed(() => server.effects(), 'backend-lookup-end-unavailable');
  }
  async function finishNetwork() {
    if (!current || current.network.ended) return;
    current.network.backendAfter = await observed(() => server.effects(), 'backend-cycle-effects-end-unavailable');
    current.network.browser = await observed(() => requests.endObservation(current.id), 'browser-cycle-end-unavailable');
    current.network.proxy = await observed(() => proxy.endObservation(current.id), 'proxy-cycle-end-unavailable');
    current.network.ended = true;
  }
  async function draftAssetIds() {
    if (!current) return [];
    // Drain actual response metadata after the fixed product actions, before
    // read-only retained-byte proof; no later browser action is introduced.
    await finishNetwork();
    const snapshot = current.network.browser;
    const ids = new Set();
    for (const row of snapshot?.rows ?? []) {
      const draft = row.commandMetadata?.type === 'SaveDraft' ? row.commandMetadata.draft : null;
      if (draft?.assetId) ids.add(draft.assetId);
      for (const asset of row.responseMetadata?.assets ?? []) if (asset?.purpose === 'caption' || asset?.purpose === 'text') ids.add(asset.id);
    }
    if (ids.size > 64) {current.missing.push('draft-asset-lineage-bound'); return [];}
    return [...ids].filter(id => /^[A-Za-z0-9_-]{1,128}$/.test(id)).sort();
  }
  async function endCycle({cell, imported, specimen, phases, draftFacts = [], draftReferences = [], closure}) {
    if (!current) return null;
    const raw = current;
    try {
      raw.uploads.after = await observed(uploads, 'product-upload-cycle-end-unavailable');
      await finishNetwork();
      raw.selected = waSelectedImport(imported, specimen); raw.phases = copy(phases);
      raw.network.expected.draftFacts = copy(draftFacts);
      raw.network.expected.draftReferences = copy(draftReferences);
      raw.network.expected.draftAssets = copy(closure?.importedAssetBindings ?? []);
      raw.retainedClosure = {status: closure?.status ?? null, importedBindingsSha256: closure?.importedBindingsSha256 ?? null, importedAssetBindings: copy(closure?.importedAssetBindings ?? [])};
      const expected = {cell, cycle: raw.binding.cycle, processIdentity: raw.binding.processIdentity, fixtureIdentity: raw.binding.fixtureIdentity,
        executableIdentity, selected: raw.selected};
      const analysis = analyzeBrowserWAObservation(raw, expected);
      const path = join(output, 'wa-cycle-' + raw.binding.cycle + '-browser-observation.json');
      await exclusiveJSON(path, raw);
      return {kind: 'retained-wa-browser-observation-1', scope: WA_BROWSER_SCOPE, selected: copy(raw.selected), analysis, artifact: {path, ...await fileIdentity(path)}};
    } finally {current = null;}
  }
  async function abandonCycle() {
    if (!current) return;
    const raw = current;
    try {
      raw.missing.push('product-cycle-did-not-complete');
      await finishNetwork();
      await exclusiveJSON(join(output, 'wa-cycle-' + raw.binding.cycle + '-browser-incomplete.json'), raw);
    } finally {current = null;}
  }
  return {prepare, beginCycle, afterImport, beforeLookup, afterLookup, draftAssetIds, endCycle, abandonCycle,
    isRequestDraftAsset(id) {return !!current?.network?.browser?.rows?.some(row => row.commandMetadata?.status === 'observed' && row.commandMetadata.type === 'SaveDraft' && row.commandMetadata.draft?.kind === 'request' && row.commandMetadata.draft.assetId === id);},
    async close() {if (closed) return; closed = true; await abandonCycle(); await requests.close();}};
}

/** Only successful retained replay grants this private authority. Mutating or
 * cloning the result/cell invalidates it, including after an asynchronous read. */
export function readVerifiedBrowserWA(result, cell) {
  const value = authority.get(result);
  return value && value.scope === WA_BROWSER_SCOPE && value.resultHash === hash(result) && value.cellHash === hash(cell) && value.bindingHash === hash(value.bindingOwner) ? value.cycles : null;
}

/** Replay retained bytes under an immutable expected binding. This scoped
 * helper grants no lifecycle authority; the full verifier below separately
 * requires the planned workload, actual launch, fixture and owning receipt. */
export async function verifyRetainedBrowserWAObservation({artifact, expected, readRetained}) {
  const artifactBefore = hash(artifact), expectedBefore = hash(expected), sealed = copy(artifact), binding = copy(expected);
  assert(sealed && typeof sealed.path === 'string' && sha(sealed.sha256) && natural(sealed.bytes) && sealed.bytes > 0 && sealed.bytes <= 16 * 1048576, 'H-WA retained observation identity unavailable');
  const bytes = await readRetained(sealed.path);
  assert(bytes instanceof Uint8Array, 'H-WA retained reader did not return bytes');
  assert.equal(bytes.length, sealed.bytes, 'H-WA retained observation length differs'); assert.equal(hash(bytes), sealed.sha256, 'H-WA retained observation digest differs');
  const raw = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  const analysis = analyzeBrowserWAObservation(raw, binding);
  assert.equal(hash(artifact), artifactBefore, 'H-WA artifact identity changed during retained replay');
  assert.equal(hash(expected), expectedBefore, 'H-WA expected binding changed during retained replay');
  return freeze({raw, analysis});
}

export async function verifyBrowserWALifecycle({cell, result, fixture, executableIdentity, workerProcessIdentity, runtimePath, readRetained}) {
  if (!isBrowserWALifecycle(cell)) return null;
  const before = hash(result), cellBefore = hash(cell), bindingOwner = {fixture, executableIdentity, workerProcessIdentity, runtimePath}, bindingHash = hash(bindingOwner);
  const snapshot = copy(result), selectedCell = copy(cell), executable = copy(executableIdentity), processOwner = copy(workerProcessIdentity);
  const selectedFixture = copy(fixture);
  assert.equal(snapshot?.fixtureIdentity, selectedFixture?.seal?.sha256, 'H-WA result differs from consumed fixture');
  const cycles = []; let runtime = null;
  for (const cycle of snapshot?.cycles ?? []) {
    const observation = cycle.action?.observations?.browserWA, artifact = observation?.artifact;
    if (!artifact || !sha(artifact.sha256) || !natural(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 16 * 1048576) {
      cycles.push({ordinal: cycle.ordinal, assertions: {noBrowserTensorDecode: null, zeroUnexpectedFetches: null}, measurements: [], missing: ['retained-H-WA-observation-unavailable'], failures: []}); continue;
    }
    const expected = {cell: selectedCell, cycle: cycle.ordinal, processIdentity: snapshot.processIdentity, fixtureIdentity: snapshot.fixtureIdentity,
      executableIdentity: executable, selected: waSelectedImport(cycle.action?.observations?.imported)};
    const retained = await verifyRetainedBrowserWAObservation({artifact, expected, readRetained}), raw = retained.raw;
    assert(typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.id), 'H-WA outer observation identity unavailable');
    assert.equal(raw.network?.browser?.observation?.id, raw.id, 'H-WA browser observation belongs to another window');
    assert.equal(raw.network?.proxy?.id, raw.id, 'H-WA proxy observation belongs to another window');
    runtime ??= JSON.parse(await readRetained(runtimePath));
    assert.equal(runtime.engine, selectedCell.parameters?.browser ?? 'chromium', 'H-WA browser engine differs from planned cell');
    assert.deepEqual(raw.binding?.runtime, runtime, 'H-WA runtime differs from its retained owned launch');
    assert.equal(raw.network?.binding?.engine, runtime.engine, 'H-WA network observer engine differs from retained runtime');
    assert.equal(raw.network?.proxy?.before?.pid, processOwner?.pid, 'H-WA proxy belongs to another worker');
    assert.equal(raw.network?.proxy?.after?.pid, processOwner?.pid, 'H-WA proxy worker changed');
    const runtimeObservation = raw.network?.browser?.runtimeIdentity;
    assert.equal(runtimeObservation?.browserPid, runtime.browserPid, 'H-WA request observer belongs to another browser');
    assert.equal(runtimeObservation?.ownedProcessPid, runtime.ownedLaunch?.process?.pid, 'H-WA request observer lacks owned launch');
    assert.equal(runtimeObservation?.startedAtIdentity, runtime.ownedLaunch?.process?.startedAtIdentity, 'H-WA browser birth identity differs');
    assert.equal(runtimeObservation?.executableSha256, runtime.executableIdentity?.sha256, 'H-WA browser executable differs');
    assert.equal(runtimeObservation?.version, runtime.version, 'H-WA browser version differs');
    assert.equal(runtimeObservation?.revision, runtime.revision, 'H-WA browser revision differs');
    assert.deepEqual(raw.phases, cycle.action?.phases, 'H-WA retained observation differs from actual lifecycle actions');
    assert.equal(raw.network?.expected?.documentHash, hash(selectedFixture.documentId), 'H-WA observed document differs from consumed fixture');
    assert.deepEqual(raw.network?.expected?.draftFacts, cycle.action?.observations?.draftFacts ?? [], 'H-WA draft facts differ from actual read-only oracle');
    assert.deepEqual(raw.network?.expected?.draftReferences, cycle.action?.observations?.draftReferences ?? [], 'H-WA prompt references differ from actual bounded caption read');
    const closure = cycle.action?.observations?.closure;
    if (closure?.artifact) {
      const {artifact: closedArtifact, ...closedValue} = closure;
      assert(sha(closedArtifact.sha256) && natural(closedArtifact.bytes) && closedArtifact.bytes > 0 && closedArtifact.bytes <= 16 * 1048576, 'H-WA closure artifact identity unavailable');
      const closedBytes = await readRetained(closedArtifact.path);
      assert.equal(closedBytes.length, closedArtifact.bytes, 'H-WA closure artifact length differs');
      assert.equal(hash(closedBytes), closedArtifact.sha256, 'H-WA closure artifact digest differs');
      assert.deepEqual(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(closedBytes)), closedValue, 'H-WA retained closure differs from oracle output');
    }
    assert.deepEqual(raw.retainedClosure, {status: closure?.status ?? null, importedBindingsSha256: closure?.importedBindingsSha256 ?? null, importedAssetBindings: closure?.importedAssetBindings ?? []}, 'H-WA retained draft closure differs from parent oracle');
    assert.deepEqual(raw.network?.expected?.draftAssets, closure?.importedAssetBindings ?? [], 'H-WA network asset closure differs from parent oracle');
    const roots = snapshot.sampling?.roots;
    assert(Array.isArray(roots) && hash({schema: 'browser-resource-process-identity-1', roots}) === JSON.parse(snapshot.processIdentity), 'H-WA sampling process identity differs');
    assert(roots.some(root => root.kind === 'browser' && root.pid === runtime.browserPid && root.startedAtIdentity === runtime.ownedLaunch?.process?.startedAtIdentity), 'H-WA resource process differs from owned browser');

    assert.equal(expected?.selected?.weights?.hash, snapshot.weightsIdentity, 'H-WA weights differ from the selected workload');
    assert.equal(expected?.selected?.config?.hash, snapshot.configIdentity, 'H-WA config differs from the selected workload');
    assert.equal(expected?.selected?.weights?.byteLength, String(256 * 1048576), 'H-WA requires the genuine fixed256MiB specimen');
    assert(natural(Number(expected?.selected?.config?.byteLength)) && Number(expected?.selected.config.byteLength) > 0 && Number(expected?.selected.config.byteLength) <= 1048576, 'H-WA config size is outside the fixed workload');
    assert.deepEqual(observation.selected, expected?.selected, 'H-WA imported identity differs from its parent action');
    const importedView = cycle.action?.observations?.imported?.view, origin = raw.network.proxy.before.allowedOrigins[0];
    assert(importedView && typeof importedView.name === 'string' && importedView.name.length <= 256, 'H-WA imported metadata identity unavailable');
    const metadataPaths = ['/api/v1/adapters', '/api/v1/adapters?search=' + encodeURIComponent(importedView.name), '/api/v1/adapters?' + new URLSearchParams({search: importedView.name})];
    assert.deepEqual(raw.network.expected.metadataURLHashes, [...new Set(metadataPaths.map(path => hash(new URL(path, origin).href)))], 'H-WA metadata queries differ from actual imported entry');
    assert.equal(raw.network.lookup?.urlSha256, hash(new URL('/api/v1/adapters/' + encodeURIComponent(expected.selected.versionId), origin).href), 'H-WA repeat lookup differs from actual imported version');
    assert.equal(raw.network.lookup?.expectedSha256, waMetadataIdentity(importedView), 'H-WA repeat lookup comparison differs from actual imported metadata');

    const replay = retained.analysis;
    if (replay.complete || replay.measurements.some(row => row.complete)) assert(closure?.artifact && closure.complete === true && closure.status === 'PASS' && closure.fixtureSha256 === selectedFixture.seal.sha256, 'Complete H-WA observation requires retained fixture closure');
    assert.deepEqual(observation.analysis, replay, 'H-WA receipt differs from retained producer replay');
    for (const key of ['noBrowserTensorDecode','zeroUnexpectedFetches']) {
      if (cycle.action.assertions?.[key] === true) assert.equal(replay.assertions[key], true, 'Unsupported H-WA semantic claim');
      if (replay.assertions[key] === false) assert.equal(cycle.action.assertions?.[key], false, 'H-WA observed violation was omitted');
    }
    for (const row of cycle.action.measurements?.filter(value => ['T06UnchangedOwnedAssetFetches','R32UnchangedOwnedAssetFetches','R32CacheIdentityMismatchCount'].includes(value.name)) ?? []) {
      const derived = replay.measurements.find(value => value.name === row.name);
      assert(derived && derived.value === row.value && derived.unit === row.unit && derived.complete === row.complete, 'H-WA serialized measurement lacks retained authority');
    }
    for (const row of replay.measurements) {
      const actual = cycle.action.measurements?.find(value => value.name === row.name);
      assert(actual && actual.value === row.value && actual.unit === row.unit && actual.complete === row.complete, 'H-WA measurement differs from raw observation');
    }
    cycles.push({ordinal: cycle.ordinal, ...replay});
  }
  assert.equal(hash(result), before, 'H-WA lifecycle changed during retained replay'); assert.equal(hash(cell), cellBefore, 'H-WA cell changed during retained replay');
  assert.equal(hash(bindingOwner), bindingHash, 'H-WA source/build/fixture/process binding changed during retained replay');
  const values = freeze(copy(cycles)); authority.set(result, {scope: WA_BROWSER_SCOPE, resultHash: before, cellHash: cellBefore, bindingOwner, bindingHash, cycles: values}); return values;
}
