import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';

export const WA_NETWORK_SCOPE = 'reviewed-selected-file-opaque-upload-and-owned-application-http-1';
const natural = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const list = value => Array.isArray(value) && value.length <= 4096 ? value : [];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = values => [...new Set(values)];
const counterKeys = ['submit','upload','poll','cancel','fetch','socket','dns','datagram'].sort();
const payloadRoutes = new Set(['asset-content','asset-display','asset-display-tile','asset-sample','asset-raster']);
const unresolvedRecovery = new Set(['events','events-stream','snapshot','namespace-events','protocol-content','recovery-release','ui-inventory','command-inventory','asset-staging-recovery']);
const documentRoutes = new Set(['document-view','document-image','document-history','document-save-status']);

function counterDelta(before, after) {
  if (!before || !after || !equal(Object.keys(before).sort(), counterKeys) || !equal(Object.keys(after).sort(), counterKeys)) return null;
  let count = 0;
  for (const key of counterKeys) {
    if (!natural(before[key]) || !natural(after[key]) || after[key] < before[key]) return null;
    count += after[key] - before[key];
  }
  return natural(count) ? count : null;
}
const blob = value => value && sha(value.hash) && decimal(value.byteLength) && natural(Number(value.byteLength)) && typeof value.mediaType === 'string' && value.mediaType.length <= 128;
const asset = value => value && id(value.id) && ['adapter','caption','text'].includes(value.purpose) && blob(value.blob);
const sameAsset = (a, b) => a?.id === b?.id && a?.purpose === b?.purpose && equal(a?.blob, b?.blob);
const bodyBytes = row => row?.sizes?.status === 'reported' && row.sizes.source === 'public-request.sizes' && natural(row.sizes.values?.requestBodySize) ? row.sizes.values.requestBodySize : null;
const projection = row => [row.method,row.urlSha256,row.route,row.id,row.originIndex,row.requestBytes,row.uploadOffset,
  row.responseStatus ?? row.response?.status ?? null,Boolean(row.activeAtStart ?? row.carriedIn)];
function multiset(rows) {
  const result = new Map();
  for (const row of rows) {const key = JSON.stringify(projection(row)); result.set(key, (result.get(key) ?? 0) + 1);}
  return [...result].sort(([a], [b]) => a.localeCompare(b));
}

/** Pure reduction of retained public request, proxy, producer and oracle facts.
 * expected.metadataURLHashes is declared by the owning collector before the
 * window, never learned from rows. draftAssets is the oracle's exact immutable
 * metadata digest/ref binding; draftFacts is its narrow projection. Neither a
 * URL family nor an opaque caption implies a referenced prompt-asset lineage.
 * Repeated transport tuples are compared as a counted multiset. This does not
 * invent an individual cross-ledger identity or use ordering/time proximity.
 */
export function analyzeWANetwork(raw, selected = {}, operations = []) {
  const missing = [], failures = [], browser = raw?.browser, proxy = raw?.proxy, expected = raw?.expected;
  const absent = reason => missing.push(reason), fail = reason => failures.push(reason);
  const records = (value, label, limit = 4096) => {
    if (!Array.isArray(value) || value.length > limit) {absent(label); return [];}
    if (value.some(item => !record(item))) absent(label);
    return value.filter(record);
  };
  const rows = records(browser?.rows, 'bounded-network-ledgers-required'), proxyRows = records(proxy?.requests, 'bounded-network-ledgers-required');
  let unexpected = 0;
  const disallowed = reason => {unexpected++; fail(reason);};
  operations = records(operations, 'bounded-upload-operation-inventory-required', 256);
  if (!record(selected)) {absent('selected-immutable-facts-required'); selected = {};}
  if (browser?.kind !== 'browser-wa-requests-1' || proxy?.kind !== 'browser-proxy-observation-1') absent('owned-browser-and-proxy-observations-required');
  if (raw?.binding?.engine !== 'chromium') absent('source-supported-Chromium-network-cohort-required');
  if (!Array.isArray(browser?.rows) || browser.rows.length > 4096 || !Array.isArray(proxy?.requests) || proxy.requests.length > 4096) absent('bounded-network-ledgers-required');
  if (browser?.recordingComplete !== true || !Array.isArray(browser?.missing) || browser.missing.length || !Array.isArray(browser?.unsupported) || browser.unsupported.length
    || browser?.observation?.status !== 'ended' || browser.observation.metadataDrain !== 'drained' || browser.observation.droppedRows !== 0
    || browser.observation.listenerContinuityObserved !== true || browser?.listenerStartup?.installedBeforeProductNavigationObserved !== true) absent('browser-request-ledger-coverage');
  if (proxy?.recordingComplete !== true || proxy?.routeBindingStable !== true || proxy?.ended !== true || proxy.droppedRequests !== 0 || proxy.observerErrors !== 0
    || browser?.observation?.id !== proxy?.id) absent('proxy-request-ledger-and-route-coverage');
  const before = proxy?.before, after = proxy?.after;
  const beforeActive = records(before?.activeRequests, 'proxy-active-baseline-inventory-required'), afterActive = records(after?.activeRequests, 'proxy-active-end-inventory-required');
  if (!Array.isArray(browser?.activeAtStart) || !Array.isArray(browser?.activeAtEnd) || !browser.activeAtStart.every(natural) || !browser.activeAtEnd.every(natural)
    || before?.activeRequestCount !== beforeActive.length || after?.activeRequestCount !== afterActive.length) absent('typed-active-request-inventories-required');
  if (!before || !after || before.proxyInstanceId !== after.proxyInstanceId || before.pid !== after.pid || !natural(before.pid) || before.pid < 1
    || before.startedMs !== after.startedMs || before.originGeneration !== after.originGeneration || before.closed !== false || after.closed !== false
    || !equal(before.allowedOrigins, after.allowedOrigins) || !Array.isArray(before.allowedOrigins) || before.allowedOrigins.length !== 1 || typeof before.allowedOrigins[0] !== 'string' || before.proxyOrigin !== after.proxyOrigin
    || before.routeVerification?.verified !== true || after.routeVerification?.verified !== true || before.routeVerification.inProgress !== false || after.routeVerification.inProgress !== false
    || before.routeVerification.totalAttempts !== after.routeVerification.totalAttempts || !equal(before.routeChallenge, after.routeChallenge)
    || before.routeChallenge?.kind !== 'browser-proxy-route-challenge-1' || before.routeChallenge.engine !== 'chromium' || before.routeChallenge.originIndex !== 0
    || !sha(before.routeChallenge.requestHash) || !sha(before.routeChallenge.responseHash) || before.routeChallenge.cacheDisabled !== false || before.routeChallenge.upstreamForwarded !== false
    || before.observerErrors !== 0 || after.observerErrors !== 0 || before.callbackErrors !== 0 || after.callbackErrors !== 0) absent('exact-proxy-process-origin-and-route-challenge-required');
  const backendDelta = counterDelta(raw?.backendBefore, raw?.backendAfter);
  if (backendDelta === null) absent('backend-patched-api-observation-unavailable');
  else if (backendDelta > 0) {fail('backend-guarded-network-effect-attempt'); absent('backend-attempt-owned-payload-attribution-unavailable');}
  const owner = operations[0]?.owner;
  const typedOwner = value => value && sha(value.sessionHash) && sha(value.clientHash) && sha(value.draftSessionHash) && sha(value.documentHash);
  if (!typedOwner(owner) || !sha(expected?.documentHash) || operations.some(value => !typedOwner(value.owner))) absent('typed-selected-upload-owner-and-document-required');
  if (typedOwner(owner) && (sha(expected?.documentHash) && owner.documentHash !== expected.documentHash
    || operations.some(value => typedOwner(value.owner) && !equal(value.owner, owner)))) disallowed('selected-upload-owner-or-document-mismatch');
  const metadataHashes = list(expected?.metadataURLHashes);
  const validMetadataHashes = metadataHashes.length > 0 && metadataHashes.every(sha) && new Set(metadataHashes).size === metadataHashes.length;
  if (!validMetadataHashes) absent('predeclared-exact-metadata-URL-hashes-required');
  if (expected?.metadataRegistration !== 'before-cycle-observers') absent('metadata-query-admission-must-precede-observation');

  const admittedAssets = new Map(), stageOperations = new Map(), requiredDraftAssetIds = new Set();
  const selectedPairs = [['adapter-weights','weights','weightsAssetId','adapter'],['adapter-config','config','configAssetId','caption'],['adapter-provenance','provenance','provenanceAssetId','caption']];
  for (const [role, refName, assetName, purpose] of selectedPairs) {
    if (refName === 'provenance' && !selected[refName]) continue;
    const op = operations.find(value => value.role === role), fact = {id: selected[assetName], purpose, blob: selected[refName]};
    if (op && asset(fact) && (sha(op.hash?.sha256) && op.hash.sha256 !== fact.blob.hash || natural(op.bytes) && String(op.bytes) !== fact.blob.byteLength)) fail('selected-upload-immutable-fact-mismatch');
    if (!op || !asset(fact) || !id(op.stagingId) || op.purpose !== purpose || op.hash?.sha256 !== fact.blob.hash || String(op.bytes) !== fact.blob.byteLength) {
      absent('selected-stage-asset-fact-lineage-required'); continue;
    }
    if (admittedAssets.has(fact.id) || stageOperations.has(op.stagingId)) absent('selected-stage-asset-identity-ambiguous');
    admittedAssets.set(fact.id, fact); stageOperations.set(op.stagingId, op);
  }
  const saveRows = rows.filter(row => row.commandMetadata?.status === 'observed' && row.commandMetadata.type === 'SaveDraft');
  const draftBindings = records(expected?.draftAssets, 'retained-draft-bindings-required'), draftFacts = records(expected?.draftFacts, 'retained-draft-facts-required'),
    draftReferences = records(expected?.draftReferences, 'retained-draft-reference-inventory-required');
  const retainedFact = fact => {
    const bindings = draftBindings.filter(value => value.id === fact?.id);
    return asset(fact) && sha(fact.metadataSha256) && bindings.length === 1 && bindings[0].metadataSha256 === fact.metadataSha256
      && Array.isArray(bindings[0].refs) && bindings[0].refs.length <= 64 && bindings[0].refs.every(record) && bindings[0].refs.some(ref => ref.hash === fact.blob.hash && ref.byteLength === fact.blob.byteLength);
  };
  for (const row of saveRows) {
    const draft = row.commandMetadata.draft, facts = draftFacts.filter(value => value.id === draft?.assetId), bindings = draftBindings.filter(value => value.id === draft?.assetId);
    if (facts.length === 1 && bindings.length === 1 && sha(facts[0].metadataSha256) && sha(bindings[0].metadataSha256)
      && facts[0].metadataSha256 !== bindings[0].metadataSha256) fail('retained-draft-asset-metadata-identity-mismatch');
    if (!draft || facts.length !== 1 || bindings.length !== 1 || !asset(facts[0]) || facts[0].purpose !== 'caption' || !sha(facts[0].metadataSha256)
      || facts[0].metadataSha256 !== bindings[0].metadataSha256 || !Array.isArray(bindings[0].refs) || bindings[0].refs.length > 64
      || !bindings[0].refs.every(record) || !bindings[0].refs.some(ref => ref.hash === facts[0].blob.hash && ref.byteLength === facts[0].blob.byteLength)) {
      absent('retained-SaveDraft-caption-asset-lineage-required'); continue;
    }
    // Asset metadata closure is not caption content. Admit the saved outer
    // caption first, then only a separately verified prompt-text reference.
    admittedAssets.set(facts[0].id, {id: facts[0].id, purpose: facts[0].purpose, blob: facts[0].blob});
    requiredDraftAssetIds.add(facts[0].id);
    const references = draftReferences.filter(value => value.assetId === facts[0].id);
    if (references.length !== 1 || !['request-draft-1','request-draft-v45-1'].includes(references[0].kind) || references[0].schemaVersion !== 1 || references[0].caption?.hash !== facts[0].blob.hash || references[0].caption?.byteLength !== facts[0].blob.byteLength
      || !blob(references[0].promptText) || references[0].promptText.mediaType !== 'text/plain') {
      absent('verified-saved-request-caption-prompt-reference-required'); continue;
    }
    const prompt = references[0].promptText;
    const promptFacts = draftFacts.filter(fact => fact.purpose === 'text' && fact.blob?.hash === prompt.hash && fact.blob?.byteLength === prompt.byteLength);
    if (!promptFacts.length) absent('retained-request-prompt-text-asset-required');
    for (const fact of promptFacts) {
      if (!retainedFact(fact) || fact.blob.mediaType !== 'application/octet-stream') {absent('retained-request-prompt-text-fact-binding-required'); continue;}
      admittedAssets.set(fact.id, {id:fact.id,purpose:fact.purpose,blob:fact.blob});
      requiredDraftAssetIds.add(fact.id);
    }
  }

  const commandRows = rows.filter(row => row.method === 'POST' && row.route === 'command-submit');
  const commands = new Map(), stageFacts = new Map(), completedCommands = new Set(), recoveries = new Map();
  for (const row of commandRows) {
    const command = row.commandMetadata;
    if (command?.status !== 'observed' || command.kind !== 'command' || !id(command.commandId)) {absent('typed-command-body-required'); continue;}
    if (commands.has(command.commandId)) {absent('command-submit-identity-ambiguous'); continue;}
    commands.set(command.commandId, row);
    if (command.ownerStatus !== 'observed' || !sha(command.sessionHash) || !sha(command.clientHash) || !id(command.transactionId)) absent('typed-command-owner-required');
    else if (typedOwner(owner) && (command.sessionHash !== owner.sessionHash || command.clientHash !== owner.clientHash || command.documentHash !== null || command.expectedDocumentRevision !== null)) disallowed('command-owner-or-global-command-scope-mismatch');
    const results = rows.filter(value => value.responseMetadata?.status === 'observed' && value.responseMetadata.kind === 'command-result' && value.responseMetadata.commandId === command.commandId);
    const receipts = results.filter(value => value.responseMetadata.evidence === 'receipt' && value.responseMetadata.receiptStatus === 'accepted').map(value => value.responseMetadata);
    const events = results.filter(value => value.responseMetadata.evidence === 'inline-events').map(value => value.responseMetadata);
    if (results.some(value => value.responseMetadata.receiptStatus === 'rejected')) fail('owned-command-rejected');
    if (events.length === 1 && id(events[0].transactionId) && (id(command.transactionId) && events[0].transactionId !== command.transactionId
      || receipts.some(value => id(value.transactionId) && decimal(value.fromSeq) && decimal(value.toSeq)
        && !equal([value.transactionId,value.fromSeq,value.toSeq], [events[0].transactionId,events[0].fromSeq,events[0].toSeq])))) fail('command-receipt-inline-result-identity-mismatch');
    if (!receipts.length || events.length !== 1 || receipts.some(value => !equal([value.transactionId,value.fromSeq,value.toSeq], [events[0]?.transactionId,events[0]?.fromSeq,events[0]?.toSeq]))
      || events[0]?.transactionId !== command.transactionId || events[0]?.assetsStatus !== 'observed-inline-events' || !Array.isArray(events[0]?.assets)) {
      absent('accepted-command-receipt-and-exact-inline-result-required'); continue;
    }
    const result = events[0]; completedCommands.add(command.commandId);
    if (!id(result.recovery?.recoveryId) || !decimal(result.recovery?.highWater)) absent('actual-command-result-recovery-descriptor-required');
    else if (result.recovery.highWater !== result.toSeq) fail('command-result-recovery-watermark-mismatch');
    else {
      if (recoveries.has(result.recovery.recoveryId)) absent('command-result-recovery-identity-ambiguous');
      let proofURLSha256 = null;
      try {proofURLSha256 = digest(new URL('/api/v1/events?after=' + result.toSeq + '&recoveryId=' + result.recovery.recoveryId, before.allowedOrigins[0]).href);}
      catch {absent('owned-command-proof-origin-unavailable');}
      recoveries.set(result.recovery.recoveryId, {commandId:command.commandId,proofURLSha256});
    }
    if (command.type === 'FinalizeStaging') {
      if (result.assets.length !== 1 || !asset(result.assets[0]) || result.assets[0].blob.hash !== command.expectedSha256) {
        fail('finalized-stage-registered-asset-mismatch'); continue;
      }
      const fact = admittedAssets.get(result.assets[0].id);
      if (!fact) {absent('finalized-stage-owned-asset-lineage-unresolved'); continue;}
      if (!sameAsset(fact, result.assets[0])) {fail('finalized-stage-owned-asset-mismatch'); continue;}
      const operation = stageOperations.get(command.stagingId);
      if (operation && (operation.hash?.sha256 !== fact.blob.hash || String(operation.bytes) !== fact.blob.byteLength)) fail('selected-upload-finalized-stage-mismatch');
      if (stageFacts.has(command.stagingId)) absent('finalized-stage-identity-ambiguous');
      stageFacts.set(command.stagingId, fact);
    } else if (command.type === 'RegisterAdapterVersion') {
      if (command.weightsAssetId !== selected.weightsAssetId || command.configAssetId !== selected.configAssetId || command.provenanceAssetId !== (selected.provenanceAssetId ?? null)) disallowed('registered-adapter-selected-source-mismatch');
      if (result.assets.length !== 1 || !sameAsset(result.assets[0], {id:selected.versionId,purpose:'adapter',blob:selected.weights})) fail('registered-adapter-result-asset-mismatch');
    } else disallowed('unexpected-command-submit');
  }
  if (commandRows.filter(row => row.commandMetadata?.type === 'RegisterAdapterVersion').length !== 1) absent('one-selected-adapter-registration-required');
  for (const [stagingId, operation] of stageOperations) if (!stageFacts.has(stagingId)) absent('selected-upload-finalization-lineage-required');
  for (const assetId of requiredDraftAssetIds) if (![...stageFacts.values()].some(fact => fact.id === assetId)) absent('saved-draft-observed-finalization-lineage-required');

  // A stage ACK is product evidence; Content-Length alone is not transferred
  // bytes. Every PUT must match public sizes and its exact offset progression.
  for (const [stagingId, fact] of stageFacts) {
    const creates = rows.filter(row => row.method === 'POST' && row.route === 'asset-staging-create' && row.commandMetadata?.stagingId === stagingId);
    const gets = rows.filter(row => row.method === 'GET' && row.route === 'asset-staging' && row.id === stagingId);
    const puts = rows.filter(row => row.method === 'PUT' && row.route === 'asset-staging' && row.id === stagingId).sort((a, b) => a.requestSequence - b.requestSequence);
    if (creates.length !== 1 || gets.length !== 1 || fact.blob.byteLength !== '0' && !puts.length) absent('stage-create-read-and-transfer-inventory-required');
    let offset = 0;
    for (const row of [...creates, ...gets, ...puts]) {
      const ack = row.responseMetadata;
      if (ack?.status !== 'observed' || ack.kind !== 'stage') {absent('actual-product-staging-ACK-required'); continue;}
      if (!sha(ack.ownerHash) || !sha(owner?.clientHash)) absent('staging-ACK-owner-required');
      if (ack.stagingId !== stagingId || ack.sha256 !== fact.blob.hash || ack.expectedBytes !== fact.blob.byteLength || ack.purpose !== fact.purpose
        || sha(ack.ownerHash) && sha(owner?.clientHash) && ack.ownerHash !== owner.clientHash) fail('staging-ACK-owner-or-immutable-identity-mismatch');
      if (row.method === 'PUT') {
        const size = bodyBytes(row);
        if (size === null || !natural(row.requestBytes) || !decimal(row.uploadOffset)) {absent('actual-browser-staging-body-size-and-offset-required'); continue;}
        if (size < 1 || size > 1048576 || size !== row.requestBytes || row.uploadOffset !== String(offset)) fail('staging-browser-body-size-or-range-mismatch');
        const operation = stageOperations.get(stagingId);
        if (operation) {
          const runs = list(operation.transfer?.runs), validRuns = runs.length > 0 && runs.every(run => record(run) && natural(run.offset) && natural(run.length) && run.length > 0 && natural(run.chunks) && run.chunks > 0);
          if (!validRuns) absent('typed-upload-producer-transfer-runs-required');
          else if (!runs.some(run => offset >= run.offset && (offset - run.offset) % run.length === 0 && (offset - run.offset) / run.length < run.chunks && size === run.length)) fail('browser-transfer-disagrees-with-upload-producer');
        }
        offset += size;
        if (!natural(offset) || ack.committedOffset !== String(offset) || ack.state !== (String(offset) === fact.blob.byteLength ? 'complete' : 'receiving')) fail('staging-product-ACK-range-mismatch');
      } else if (ack.committedOffset !== '0' || ack.state !== (fact.blob.byteLength === '0' ? 'complete' : 'receiving')) fail('staging-initial-ACK-mismatch');
    }
    if (String(offset) !== fact.blob.byteLength) absent('complete-staging-transfer-required');
  }

  const carries = records(expected?.carryInSSE, 'retained-carry-in-inventory-required'), admittedCarry = new Set(), admittedProxyCarry = new Set();
  for (const carry of carries) {
    const bs = rows.filter(row => row.requestId === carry.browserRequestId), ps = proxyRows.filter(row => row.requestId === carry.proxyRequestId);
    if (bs.length !== 1 || ps.length !== 1 || carry.method !== 'GET' || carry.route !== 'events-stream' || carry.id !== null || carry.originIndex !== 0 || !sha(carry.urlSha256)
      || !equal(projection(bs[0]).slice(0,5), projection(carry).slice(0,5)) || !equal(projection(ps[0]).slice(0,5), projection(carry).slice(0,5))
      || bs[0].activeAtStart !== true || ps[0].carriedIn !== true || bs[0].longLivedSSE !== true
      || !list(browser?.activeAtStart).includes(carry.browserRequestId) || !beforeActive.some(row => row.requestId === carry.proxyRequestId)) {
      absent('exact-carried-in-SSE-identity-required'); continue;
    }
    if (bs[0].activeAtEnd !== !ps[0].terminal || (bs[0].terminal === 'finished') !== (ps[0].terminal?.outcome === 'finished')) absent('carried-in-SSE-terminal-lifecycle-mismatch');
    if (admittedCarry.has(carry.browserRequestId) || admittedProxyCarry.has(carry.proxyRequestId)) absent('carried-in-SSE-identity-ambiguous');
    admittedCarry.add(carry.browserRequestId); admittedProxyCarry.add(carry.proxyRequestId);
  }

  let payloadFetches = 0;
  for (const row of rows) {
    if (row.method === 'GET' && payloadRoutes.has(row.route)) payloadFetches++;
    if (!natural(row.requestId) || !sha(row.urlSha256) || typeof row.method !== 'string' || row.requestEventObserved !== true || !natural(row.requestSequence)) absent('browser-request-identity-unavailable');
    if (row.originIndex !== 0 || row.isHTTP === false) {disallowed('request-outside-owned-HTTP-origin'); continue;}
    if (row.fromServiceWorker !== false || row.requestServiceWorker !== false || row.redirectedFrom != null || row.redirectedTo != null) absent('service-worker-or-redirect-attribution-unavailable');
    if (row.query?.validControl === false) {disallowed('unexpected-application-query'); continue;}
    if (row.query?.validControl !== true || !Array.isArray(row.query?.keys)) {absent('actual-query-classification-required'); continue;}
    if (row.activeAtStart && !admittedCarry.has(row.requestId)) absent('unclassified-browser-carry-in');
    const isSSE = admittedCarry.has(row.requestId);
    if (!isSSE && (row.terminal !== 'finished' || row.activeAtEnd !== false || bodyBytes(row) === null)) absent('finished-browser-request-and-body-size-required');
    if (row.responseStatus >= 400 || row.terminal === 'failed') fail('owned-application-http-error');
    else if (!Number.isSafeInteger(row.responseStatus) || row.responseStatus < 200 || row.responseStatus >= 300) absent('successful-application-response-required');
    const meta = row.commandMetadata;
    if (meta?.status === 'unexpected') {disallowed(meta.reason ?? 'unexpected-control-request'); continue;}
    if (row.method === 'POST' && ['command-submit','asset-staging-create','ui-view','recovery-release'].includes(row.route)) {
      if (meta?.status !== 'observed' || !natural(meta.bodyBytes) || bodyBytes(row) === null) absent('actual-control-body-size-required');
      else if (meta.bodyBytes !== bodyBytes(row) || row.requestBytes !== null && row.requestBytes !== meta.bodyBytes) fail('control-body-size-mismatch');
    }
    if (isSSE) continue;
    if (row.method === 'GET' && row.route === 'adapter-list') {
      if (!validMetadataHashes) absent('predeclared-exact-metadata-URL-hashes-required');
      else if (!metadataHashes.includes(row.urlSha256)) disallowed('metadata-query-not-predeclared');
    } else if (row.method === 'GET' && row.route === 'adapter-view') {
      if (row.id !== selected.versionId || row.query.keys.length) disallowed('unowned-adapter-metadata-request');
    } else if (row.method === 'GET' && documentRoutes.has(row.route)) {
      if (!id(row.id) || !sha(expected?.documentHash)) absent('owned-document-route-identity-required');
      else if (digest(row.id) !== expected.documentHash || row.query.keys.length) disallowed('unowned-document-metadata-request');
    } else if (row.method === 'GET' && row.route === 'asset-view') {
      if (!admittedAssets.has(row.id)) absent('asset-metadata-owned-lineage-unresolved');
      if (row.query.keys.length) disallowed('unexpected-asset-metadata-query');
    } else if (row.route === 'asset-staging' && ['GET','PUT'].includes(row.method)) {
      if (!stageFacts.has(row.id)) absent('staging-owned-asset-lineage-unresolved');
      if (row.query.keys.length) disallowed('unexpected-staging-query');
    } else if (row.method === 'POST' && row.route === 'asset-staging-create') {
      const fact = stageFacts.get(meta?.stagingId);
      if (!fact) absent('staging-create-owned-asset-lineage-unresolved');
      else if (meta.sha256 !== fact.blob.hash || meta.expectedBytes !== fact.blob.byteLength || meta.purpose !== fact.purpose) fail('staging-create-immutable-identity-mismatch');
    } else if (row.method === 'POST' && row.route === 'command-submit') {
      if (!completedCommands.has(meta?.commandId)) absent('command-terminal-result-lineage-unresolved');
    } else if (row.method === 'GET' && ['command-view','command-result'].includes(row.route)) {
      if (!commands.has(row.id)) absent('command-read-owned-submission-lineage-unresolved');
      if (row.query.keys.length) disallowed('unexpected-command-query');
    } else if (row.route === 'ui-view' && ['GET','POST'].includes(row.method)) {
      if (!sha(owner?.draftSessionHash) || !id(row.id)) absent('typed-UI-session-required');
      else if (digest(row.id) !== owner.draftSessionHash) disallowed('UI-session-owner-mismatch');
      if (row.query.keys.length) disallowed('unexpected-UI-query');
      if (row.method === 'GET') {
        const checkpoint = row.responseMetadata;
        if (checkpoint?.status !== 'observed' || checkpoint.kind !== 'ui-checkpoint' || !sha(checkpoint.sessionHash)) absent('actual-owned-UI-checkpoint-required');
        else if (sha(owner?.draftSessionHash) && checkpoint.sessionHash !== owner.draftSessionHash) disallowed('UI-checkpoint-session-owner-mismatch');
      }
      if (row.method === 'POST') {
        if (!sha(meta?.sessionHash) || !sha(owner?.draftSessionHash)) absent('typed-UI-body-session-owner-required');
        else if (meta.sessionHash !== owner.draftSessionHash) disallowed('UI-body-session-owner-mismatch');
        const receipt = row.responseMetadata;
        if (receipt?.status !== 'observed' || receipt.kind !== 'ui-receipt' || receipt.requestId !== meta?.requestId) absent('actual-UI-receipt-required');
        else if (receipt.receiptStatus !== 'accepted') fail('owned-UI-request-rejected');
        else if (!decimal(receipt.uiSeq) || !decimal(meta.expectedUISeq)) absent('typed-UI-receipt-sequence-required');
        else if (BigInt(receipt.uiSeq) !== BigInt(meta.expectedUISeq) + 1n) fail('UI-receipt-sequence-mismatch');
        if (meta?.type === 'SaveDraft') {
          const draft = meta.draft;
          if (!sha(expected?.documentHash) || !sha(draft?.documentHash)) absent('SaveDraft-owned-document-identity-required');
          if (draft && (draft.kind !== 'request' || draft.composing !== false || draft.targetLayerId !== null
            || sha(draft.documentHash) && sha(expected?.documentHash) && draft.documentHash !== expected.documentHash)) disallowed('SaveDraft-owned-request-document-mismatch');
          if (!admittedAssets.has(draft?.assetId)) absent('SaveDraft-closed-caption-lineage-required');
          const checkpoints = rows.filter(value => value.method === 'GET' && value.route === 'ui-view' && value.id === row.id
            && value.responseMetadata?.status === 'observed' && value.responseMetadata.kind === 'ui-checkpoint'
            && value.responseMetadata.sessionHash === meta.sessionHash && natural(value.requestSequence) && value.requestSequence > row.responseSequence);
          const superseded = saveRows.some(value => value.commandMetadata.draft?.id === draft?.id && value.requestSequence > row.requestSequence);
          if (!superseded && !checkpoints.some(value => list(value.responseMetadata.drafts).some(saved => equal(saved, {...draft,status:'saved-unapplied'})))) absent('persisted-owned-SaveDraft-checkpoint-required');
        } else if (meta?.type === 'SetPreferences') {
          const checkpoints = rows.filter(value => value.method === 'GET' && value.route === 'ui-view' && value.id === row.id && value.responseMetadata?.status === 'observed'
            && value.responseMetadata.kind === 'ui-checkpoint' && value.responseMetadata.sessionHash === owner?.draftSessionHash && value.responseMetadata.uiSeq === meta.expectedUISeq
            && natural(value.responseSequence) && value.responseSequence < row.requestSequence);
          const allowed = checkpoints.filter(value => equal(meta.preferences, {...value.responseMetadata.preferences,documentHash:null,selectedLayerIdsHash:digest('[]')}));
          if (!allowed.length) absent('actual-close-preferences-checkpoint-lineage-required');
        } else absent('typed-owned-UI-control-required');
      }
    } else if (row.method === 'GET' && row.route === 'events') {
      // This exact control URL is derived from the observed owned command's
      // receipt/result descriptor. It does not prove the response's protocol
      // meaning, and no arbitrary events query is admitted by its path alone.
      if (![...recoveries.values()].some(value => sha(value.proofURLSha256) && row.urlSha256 === value.proofURLSha256)) absent('recovery-descriptor-owner-lineage-unresolved');
    } else if (row.method === 'POST' && row.route === 'recovery-release') {
      if (!recoveries.has(row.id)) absent('recovery-descriptor-owner-lineage-unresolved');
      if (meta?.status !== 'observed' || meta.kind !== 'recovery-release' || meta.protocolVersion !== 1 || !id(meta.recoveryId)) absent('typed-recovery-release-body-required');
      else if (meta.recoveryId !== row.id || row.query.keys.length) disallowed('recovery-release-identity-or-query-mismatch');
      if (row.responseStatus !== 204) absent('actual-recovery-release-response-required');
    } else if (unresolvedRecovery.has(row.route) && ['GET','POST'].includes(row.method)) absent('recovery-descriptor-owner-lineage-unresolved');
    else disallowed('unexpected-application-http-request');
  }
  for (const [recoveryId, recovery] of recoveries) {
    if (rows.filter(row => row.method === 'POST' && row.route === 'recovery-release' && row.id === recoveryId).length !== 1) absent('one-release-per-owned-result-recovery-required');
    if (rows.filter(row => row.method === 'GET' && row.route === 'events' && row.urlSha256 === recovery.proofURLSha256).length !== 1) absent('one-exact-proof-read-per-owned-result-recovery-required');
  }
  if (new Set(rows.map(row => row.requestId)).size !== rows.length || new Set(proxyRows.map(row => row.requestId)).size !== proxyRows.length) absent('duplicate-network-request-identities');
  for (const row of proxyRows) {
    if (row.blocked) disallowed('proxy-blocked-request');
    if (row.originIndex !== 0) disallowed('proxy-request-outside-owned-origin');
    if (payloadRoutes.has(row.route) || ['unknown','favicon','proxy-challenge'].includes(row.route)) disallowed('unexpected-proxy-http-route');
    if (row.urlComplete !== true || !sha(row.urlSha256) || !Number.isFinite(row.forwardedMs)) absent('actual-proxy-forwarding-required');
    if (row.carriedIn && !admittedProxyCarry.has(row.requestId)) absent('unclassified-proxy-carry-in');
    if (!admittedProxyCarry.has(row.requestId) && row.terminal?.outcome !== 'finished') absent('finished-proxy-request-required');
    if (row.response?.status >= 400) fail('owned-application-http-error');
    if (['request-aborted','request-error','upstream-error','upstream-response-error'].includes(row.terminal?.outcome)) fail('owned-proxy-transport-error');
  }
  if (!equal(multiset(rows), multiset(proxyRows))) absent('exact-browser-proxy-transport-multiset-required');
  if (!equal([...admittedCarry].sort(), list(browser?.activeAtStart).slice().sort()) || !equal([...admittedProxyCarry].sort(), beforeActive.map(row => row.requestId).sort())) absent('complete-carry-in-inventory-required');
  if (!equal(rows.filter(row => row.activeAtEnd).map(row => row.requestId).sort(), list(browser?.activeAtEnd).slice().sort())
    || !equal(proxyRows.filter(row => !row.terminal).map(row => row.requestId).sort(), afterActive.map(row => row.requestId).sort())) absent('complete-active-at-end-inventory-required');

  const lookup = raw?.lookup, beforeList = list(lookup?.beforeRequestIds), beforeIds = new Set(beforeList), afterIds = list(lookup?.afterRequestIds);
  const selectedRows = rows.filter(row => afterIds.includes(row.requestId) && !beforeIds.has(row.requestId));
  const observation = browser?.observation;
  // Lookup snapshots must describe prefixes of this same retained request
  // ledger. No missing ID, foreign window, carry-in or reordered boundary can
  // manufacture attribution merely by supplying two metadata hashes.
  const sequenceRows = rows.every(row => natural(row.requestId) && natural(row.requestSequence));
  const beforeSequence = Math.max(-1, ...rows.filter(row => beforeIds.has(row.requestId)).map(row => row.requestSequence));
  const afterSequence = Math.max(-1, ...rows.filter(row => afterIds.includes(row.requestId)).map(row => row.requestSequence));
  const lookupWindow = Array.isArray(lookup?.beforeRequestIds) && Array.isArray(lookup?.afterRequestIds)
    && lookup.beforeRequestIds.length <= 4096 && lookup.afterRequestIds.length <= 4096
    && beforeIds.size === beforeList.length && new Set(afterIds).size === afterIds.length
    && new Set(rows.map(row => row.requestId)).size === rows.length && sequenceRows
    && beforeList.every(value => natural(value) && afterIds.includes(value))
    && afterIds.every(value => natural(value) && rows.some(row => row.requestId === value))
    && rows.every(row => (row.requestSequence <= beforeSequence) === beforeIds.has(row.requestId)
      && (row.requestSequence <= afterSequence) === afterIds.includes(row.requestId))
    && observation?.status === 'ended' && typeof observation.id === 'string' && observation.id === proxy?.id
    && natural(observation.startSequence) && natural(observation.endSequence) && observation.startSequence <= observation.endSequence
    && selectedRows.every(row => row.activeAtStart === false && row.requestEventObserved === true
      && row.requestSequence > observation.startSequence && row.requestSequence <= observation.endSequence && row.requestSequence > beforeSequence);
  let selectedMetadataURL = null;
  try {if (id(selected.versionId)) selectedMetadataURL = digest(new URL('/api/v1/adapters/' + selected.versionId, before.allowedOrigins[0]).href);}
  catch { /* Missing origin cannot grant numeric lookup attribution. */ }
  const metadata = selectedRows.filter(row => row.method === 'GET' && row.route === 'adapter-view' && row.id === selected.versionId
    && row.urlSha256 === lookup?.urlSha256 && row.urlSha256 === selectedMetadataURL && row.originIndex === 0 && row.isHTTP === true
    && row.query?.validControl === true && Array.isArray(row.query.keys) && row.query.keys.length === 0
    && row.requestServiceWorker === false && row.fromServiceWorker === false && row.activeAtStart === false
    && row.terminal === 'finished' && row.activeAtEnd === false && row.responseStatus >= 200 && row.responseStatus < 300 && bodyBytes(row) === 0);
  const lookupDelta = counterDelta(lookup?.backendBefore, lookup?.backendAfter);
  if (lookupDelta > 0) {fail('backend-guarded-network-effect-attempt'); absent('backend-attempt-owned-payload-attribution-unavailable');}
  if (backendDelta !== null && lookupDelta !== null && counterKeys.some(key => lookup.backendBefore[key] < raw.backendBefore[key] || lookup.backendAfter[key] > raw.backendAfter[key])) absent('lookup-backend-counters-outside-cycle');
  const lookupIdentity = lookupWindow && metadata.length === 1 && sha(lookup?.urlSha256) && sha(lookup?.expectedSha256) && sha(lookup?.observedSha256);
  const identityMismatch = lookupIdentity ? Number(lookup.expectedSha256 !== lookup.observedSha256) : null;
  if (!lookupIdentity || lookupDelta === null) absent('actual-repeated-owned-metadata-lookup-required');
  if (identityMismatch) fail('owned-adapter-cache-identity-mismatch');
  // server/assets.ts classifies each payload route's path ID as an Asset ID.
  // Adapter registration creates selected.versionId as an Asset whose blob is
  // selected.weights (server/storage/adapters.ts). Foreign assets still fail
  // the network allowlist above, but they are not unchanged-owned fetches.
  const ownedAssetIds = [selected.versionId,selected.weightsAssetId,selected.configAssetId,
    ...(selected.provenance ? [selected.provenanceAssetId] : [])];
  const ownedAssetIdentity = ownedAssetIds.every(id) && blob(selected.weights) && blob(selected.config)
    && (!selected.provenance || blob(selected.provenance));
  const payloadCandidates = selectedRows.filter(row => row.method === 'GET' && payloadRoutes.has(row.route));
  const payloadAttribution = lookupIdentity && ownedAssetIdentity && payloadCandidates.every(row => id(row.id) && sha(row.urlSha256)
    && Number.isInteger(row.originIndex) && row.isHTTP === true);
  const repeatedPayloadFetches = payloadAttribution
    ? payloadCandidates.filter(row => row.originIndex === 0 && ownedAssetIds.includes(row.id)).length : null;
  if (!payloadAttribution) absent('repeated-owned-payload-attribution-unavailable');
  if (unexpected) fail('unexpected-application-http-request');
  return {scope:WA_NETWORK_SCOPE,complete:missing.length === 0,missing:unique(missing),failures:unique(failures),unexpected,
    patchedBackendAttempts:backendDelta,payloadFetches,repeatedPayloadFetches,identityMismatch,metadataRequests:metadata.length,globalNetworkCoverage:false,
    transportJoin:'exact-counted-multiset-no-individual-cross-ledger-identity'};
}
