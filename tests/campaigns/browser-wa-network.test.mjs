import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {analyzeWANetwork, WA_NETWORK_SCOPE} from '../../tooling/qualification/campaigns/browser-wa-network.mjs';

// Synthetic reducer unit fixtures only. These are not runtime observations,
// browser/cache qualification receipts, or evidence that any campaign passed.
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const origin = 'http://127.0.0.1:4100';
const zeroEffects = () => Object.fromEntries(['submit', 'upload', 'poll', 'cancel', 'fetch', 'socket', 'dns', 'datagram'].map(key => [key, 0]));
const blob = (name, bytes) => ({hash: hash(name), byteLength: String(bytes), mediaType: 'application/octet-stream'});

function addRow(fixture, label, route, pathname, patch = {}) {
  const requestId = fixture.raw.browser.rows.length + 1, sequence = requestId * 3;
  const row = {requestId, method: 'GET', urlSha256: hash(origin + pathname), route, id: null,
    originIndex: 0, requestBytes: null, uploadOffset: null, query: {keys: [], validControl: true},
    clientHash: fixture.owner.clientHash, resourceType: 'fetch', isHTTP: true, requestEventObserved: true,
    requestObservedMs: sequence, requestSequence: sequence, responseObservedMs: sequence + 1, responseSequence: sequence + 1,
    responseStatus: 200, fromServiceWorker: false, requestServiceWorker: false,
    terminal: 'finished', terminalObservedMs: sequence + 2, terminalSequence: sequence + 2, terminalWithinWindow: true,
    activeAtStart: false, activeAtEnd: false, longLivedSSE: false,
    sizes: {status: 'reported', source: 'public-request.sizes', values: {requestBodySize: 0, requestHeadersSize: 80, responseBodySize: 80, responseHeadersSize: 80}},
    commandMetadata: {status: 'not-applicable'}, responseMetadata: {status: 'not-applicable'}, missing: [], ...patch};
  fixture.raw.browser.rows.push(row); fixture.by[label] = row; return row;
}

function syncProxy(fixture) {
  const {browser, proxy} = fixture.raw;
  browser.observation.startSequence = 0;
  browser.observation.endSequence = Math.max(0, ...browser.rows.flatMap(row => [row.requestSequence, row.terminalSequence ?? row.requestSequence]));
  proxy.requests = browser.rows.map(row => ({requestId: 'proxy-' + row.requestId, method: row.method, urlSha256: row.urlSha256,
    urlComplete: true, route: row.route, id: row.id, originIndex: row.originIndex, requestBytes: row.requestBytes, uploadOffset: row.uploadOffset,
    receivedMs: row.requestObservedMs, forwardedMs: row.requestObservedMs, blocked: null,
    response: {status: row.responseStatus, observedMs: row.responseObservedMs},
    terminal: row.terminal === null ? null : {outcome: row.terminal === 'finished' ? 'finished' : 'request-error', observedMs: row.terminalObservedMs},
    carriedIn: row.activeAtStart}));
  browser.activeAtStart = browser.rows.filter(row => row.activeAtStart).map(row => row.requestId);
  browser.activeAtEnd = browser.rows.filter(row => row.activeAtEnd).map(row => row.requestId);
  browser.activeSSEAtEnd = browser.rows.filter(row => row.activeAtEnd && row.longLivedSSE).map(row => row.requestId);
  proxy.before.activeRequests = proxy.requests.filter(row => row.carriedIn).map(row => ({...clone(row), terminal: null}));
  proxy.after.activeRequests = proxy.requests.filter(row => row.terminal === null).map(clone);
  proxy.before.activeRequestCount = proxy.before.activeRequests.length; proxy.after.activeRequestCount = proxy.after.activeRequests.length;
  proxy.terminalComplete = proxy.after.activeRequestCount === 0;
}

function addCommand(fixture, label, metadata, registeredAsset) {
  const commandId = label + '_command', transactionId = label + '_transaction', recoveryId = label + '_recovery';
  const command = {status: 'observed', kind: 'command', bodyBytes: 180, commandId, transactionId,
    ownerStatus: 'observed', clientHash: fixture.owner.clientHash, sessionHash: fixture.owner.sessionHash,
    documentHash: null, expectedDocumentRevision: null, ...metadata};
  const shared = {status: 'observed', kind: 'command-result', commandId, transactionId, fromSeq: '1', toSeq: '1'};
  addRow(fixture, label + 'Submit', 'command-submit', '/api/v1/commands', {method: 'POST', requestBytes: 180,
    commandMetadata: command, sizes: {status: 'reported', source: 'public-request.sizes', values: {requestBodySize: 180, requestHeadersSize: 80, responseBodySize: 80, responseHeadersSize: 80}},
    responseMetadata: {...shared, evidence: 'receipt', receiptStatus: 'accepted', assets: null, assetsStatus: 'not-present-in-receipt'}});
  addRow(fixture, label + 'Result', 'command-result', '/api/v1/commands/' + commandId + '/result', {id: commandId,
    responseMetadata: {...shared, evidence: 'inline-events', receiptStatus: null, assets: [clone(registeredAsset)], assetsStatus: 'observed-inline-events', eventTypes: ['AssetRegistered'], recovery: {recoveryId, highWater: '1'}}});
  addRow(fixture, label + 'Events', 'events', '/api/v1/events?after=1&recoveryId=' + recoveryId, {query: {keys: ['after', 'recoveryId'], validControl: true}});
  addRow(fixture, label + 'Release', 'recovery-release', '/api/v1/recovery/' + recoveryId + '/release', {method: 'POST', id: recoveryId, responseStatus: 204, requestBytes: 64,
    commandMetadata: {status: 'observed', kind: 'recovery-release', protocolVersion: 1, recoveryId, bodyBytes: 64},
    sizes: {status: 'reported', source: 'public-request.sizes', values: {requestBodySize: 64, requestHeadersSize: 80, responseBodySize: 0, responseHeadersSize: 80}}});
}

function completeFixture() {
  const owner = {sessionHash: hash('upload_session'), draftSessionHash: hash('draft_session'), clientHash: hash('owned_client'), documentHash: hash('owned_document')};
  const selected = {versionId: 'owned_version', weightsAssetId: 'weights_asset', configAssetId: 'config_asset', provenanceAssetId: null,
    weights: blob('selected-weights', 4), config: blob('selected-config', 3), provenance: null};
  const challenge = {kind: 'browser-proxy-route-challenge-1', engine: 'chromium', originIndex: 0,
    requestHash: hash('observed-route-request'), responseHash: hash('observed-route-response'), cacheDisabled: false, upstreamForwarded: false};
  const state = {proxyInstanceId: 'owned_proxy', pid: 123, startedMs: 1, originGeneration: 0, allowedOrigins: [origin],
    proxyOrigin: 'http://127.0.0.1:4200', closed: false, observerErrors: 0, callbackErrors: 0,
    routeVerification: {verified: true, inProgress: false, totalAttempts: 1}, routeChallenge: challenge, activeRequestCount: 0, activeRequests: []};
  const raw = {binding: {engine: 'chromium'}, backendBefore: zeroEffects(), backendAfter: zeroEffects(),
    expected: {documentHash: owner.documentHash, metadataRegistration: 'before-cycle-observers', metadataURLHashes: [hash(origin + '/api/v1/adapters?search=owned')], draftAssets: [], draftFacts: [], draftReferences: [], carryInSSE: []},
    browser: {kind: 'browser-wa-requests-1', qualification: false, globalComplete: false, recordingComplete: true,
      missing: [], unsupported: [], rows: [], activeAtStart: [], activeAtEnd: [], activeSSEAtEnd: [],
      observation: {id: 'owned_cycle', status: 'ended', metadataDrain: 'drained', droppedRows: 0, listenerContinuityObserved: true},
      listenerStartup: {installedBeforeProductNavigationObserved: true}},
    proxy: {kind: 'browser-proxy-observation-1', id: 'owned_cycle', recordingComplete: true, routeBindingStable: true, ended: true,
      droppedRequests: 0, observerErrors: 0, requests: [], before: clone(state), after: clone(state)}};
  const fixture = {raw, selected, operations: [], owner, by: {}};
  for (const [label, role, assetKey, refKey, purpose] of [
    ['weights', 'adapter-weights', 'weightsAssetId', 'weights', 'adapter'], ['config', 'adapter-config', 'configAssetId', 'config', 'caption'],
  ]) {
    const ref = selected[refKey], stagingId = label + '_stage', bytes = Number(ref.byteLength);
    fixture.operations.push({role, stagingId, purpose, hash: {sha256: ref.hash}, bytes, owner: clone(owner), transfer: {runs: [{offset: 0, length: bytes, chunks: 1}]}});
    const ack = {status: 'observed', kind: 'stage', stagingId, purpose, expectedBytes: ref.byteLength, sha256: ref.hash,
      committedOffset: '0', state: 'receiving', ownerHash: owner.clientHash};
    addRow(fixture, label + 'Create', 'asset-staging-create', '/api/v1/assets/staging', {method: 'POST', requestBytes: 96,
      commandMetadata: {status: 'observed', kind: 'staging-create', bodyBytes: 96, stagingId, expectedBytes: ref.byteLength, sha256: ref.hash, purpose},
      sizes: {status: 'reported', source: 'public-request.sizes', values: {requestBodySize: 96, requestHeadersSize: 80, responseBodySize: 80, responseHeadersSize: 80}}, responseMetadata: clone(ack)});
    addRow(fixture, label + 'Get', 'asset-staging', '/api/v1/assets/staging/' + stagingId, {id: stagingId, responseMetadata: clone(ack)});
    addRow(fixture, label + 'Put', 'asset-staging', '/api/v1/assets/staging/' + stagingId, {method: 'PUT', id: stagingId, requestBytes: bytes, uploadOffset: '0',
      sizes: {status: 'reported', source: 'public-request.sizes', values: {requestBodySize: bytes, requestHeadersSize: 80, responseBodySize: 80, responseHeadersSize: 80}},
      responseMetadata: {...ack, committedOffset: ref.byteLength, state: 'complete'}});
    addCommand(fixture, label + 'Finalize', {type: 'FinalizeStaging', stagingId, expectedSha256: ref.hash}, {id: selected[assetKey], purpose, blob: clone(ref)});
  }
  addCommand(fixture, 'register', {type: 'RegisterAdapterVersion', weightsAssetId: selected.weightsAssetId, configAssetId: selected.configAssetId, provenanceAssetId: null},
    {id: selected.versionId, purpose: 'adapter', blob: clone(selected.weights)});
  addRow(fixture, 'list', 'adapter-list', '/api/v1/adapters?search=owned', {query: {keys: ['search'], validControl: true}});
  addRow(fixture, 'initialMetadata', 'adapter-view', '/api/v1/adapters/' + selected.versionId, {id: selected.versionId});
  const beforeRequestIds = raw.browser.rows.map(row => row.requestId);
  const repeated = addRow(fixture, 'repeatedMetadata', 'adapter-view', '/api/v1/adapters/' + selected.versionId, {id: selected.versionId});
  raw.lookup = {beforeRequestIds, afterRequestIds: raw.browser.rows.map(row => row.requestId), urlSha256: repeated.urlSha256,
    backendBefore: zeroEffects(), backendAfter: zeroEffects(), expectedSha256: hash('owned-version-metadata'), observedSha256: hash('owned-version-metadata')};
  syncProxy(fixture); return fixture;
}

const analyze = fixture => analyzeWANetwork(fixture.raw, fixture.selected, fixture.operations);
function assertIncomplete(result, reason) {
  assert.equal(result.complete, false); assert.deepEqual(result.failures, []);
  if (reason) assert(result.missing.includes(reason), 'Expected missing evidence: ' + reason);
}
function assertFailure(result, reason) {
  assert(result.failures.length > 0, 'An observed contradiction must remain a failure');
  if (reason) assert(result.failures.includes(reason), 'Expected observed failure: ' + reason);
}

function addCarry(fixture) {
  const row = addRow(fixture, 'carry', 'events-stream', '/api/v1/events/stream?after=0', {resourceType: 'eventsource',
    query: {keys: ['after'], validControl: true}, requestObservedMs: 0, requestSequence: 0,
    responseObservedMs: 1, responseSequence: 1, activeAtStart: true, activeAtEnd: true, longLivedSSE: true,
    terminal: null, terminalObservedMs: null, terminalSequence: null, terminalWithinWindow: false,
    sizes: {status: 'unknown', reason: 'request-not-finished'}});
  fixture.raw.lookup.beforeRequestIds.push(row.requestId); fixture.raw.lookup.afterRequestIds.push(row.requestId);
  syncProxy(fixture);
  fixture.raw.expected.carryInSSE = [{browserRequestId: row.requestId, proxyRequestId: 'proxy-' + row.requestId,
    method: 'GET', urlSha256: row.urlSha256, route: 'events-stream', id: null, originIndex: 0}];
  return row;
}

function addAuxiliaryStage(fixture, label, fact) {
  const stagingId = label + '_stage', bytes = Number(fact.blob.byteLength);
  const ack = {status: 'observed', kind: 'stage', stagingId, purpose: fact.purpose, expectedBytes: fact.blob.byteLength,
    sha256: fact.blob.hash, committedOffset: '0', state: 'receiving', ownerHash: fixture.owner.clientHash};
  addRow(fixture, label + 'Create', 'asset-staging-create', '/api/v1/assets/staging', {method: 'POST', requestBytes: 96,
    commandMetadata: {status: 'observed', kind: 'staging-create', bodyBytes: 96, stagingId, expectedBytes: fact.blob.byteLength, sha256: fact.blob.hash, purpose: fact.purpose},
    sizes: {status: 'reported', source: 'public-request.sizes', values: {requestBodySize: 96, requestHeadersSize: 80, responseBodySize: 80, responseHeadersSize: 80}}, responseMetadata: clone(ack)});
  addRow(fixture, label + 'Get', 'asset-staging', '/api/v1/assets/staging/' + stagingId, {id: stagingId, responseMetadata: clone(ack)});
  addRow(fixture, label + 'Put', 'asset-staging', '/api/v1/assets/staging/' + stagingId, {method: 'PUT', id: stagingId, requestBytes: bytes, uploadOffset: '0',
    sizes: {status: 'reported', source: 'public-request.sizes', values: {requestBodySize: bytes, requestHeadersSize: 80, responseBodySize: 80, responseHeadersSize: 80}},
    responseMetadata: {...ack, committedOffset: fact.blob.byteLength, state: 'complete'}});
  addCommand(fixture, label + 'Finalize', {type: 'FinalizeStaging', stagingId, expectedSha256: fact.blob.hash}, {id: fact.id, purpose: fact.purpose, blob: clone(fact.blob)});
}

function addSavedDraft(fixture) {
  const caption = {id: 'draft_caption', purpose: 'caption', blob: blob('saved-caption', 8), metadataSha256: hash('saved-caption-metadata')};
  const prompt = {id: 'draft_prompt', purpose: 'text', blob: blob('saved-prompt', 5), metadataSha256: hash('saved-prompt-metadata')};
  fixture.raw.expected.draftFacts = [caption, prompt];
  fixture.raw.expected.draftAssets = [caption, prompt].map(fact => ({id: fact.id, metadataSha256: fact.metadataSha256, refs: [{hash: fact.blob.hash, byteLength: fact.blob.byteLength}]}));
  fixture.raw.expected.draftReferences = [{assetId: caption.id, kind: 'request-draft-1', schemaVersion: 1,
    caption: {hash: caption.blob.hash, byteLength: caption.blob.byteLength}, promptText: {...prompt.blob, mediaType: 'text/plain'}}];
  addAuxiliaryStage(fixture, 'draftPrompt', prompt); addAuxiliaryStage(fixture, 'draftCaption', caption);
  const draft = {id: 'owned_draft', generation: '1', kind: 'request', documentHash: fixture.owner.documentHash,
    expectedDocumentRevision: '7', targetLayerId: null, assetId: caption.id, composing: false};
  addRow(fixture, 'saveDraft', 'ui-view', '/api/v1/ui/draft_session', {method: 'POST', id: 'draft_session', requestBytes: 120,
    commandMetadata: {status: 'observed', kind: 'ui', type: 'SaveDraft', bodyBytes: 120, requestId: 'save_request', sessionHash: fixture.owner.draftSessionHash, expectedUISeq: '2', draft},
    sizes: {status: 'reported', source: 'public-request.sizes', values: {requestBodySize: 120, requestHeadersSize: 80, responseBodySize: 80, responseHeadersSize: 80}},
    responseMetadata: {status: 'observed', kind: 'ui-receipt', requestId: 'save_request', receiptStatus: 'accepted', uiSeq: '3'}});
  addRow(fixture, 'draftCheckpoint', 'ui-view', '/api/v1/ui/draft_session', {id: 'draft_session',
    responseMetadata: {status: 'observed', kind: 'ui-checkpoint', sessionHash: fixture.owner.draftSessionHash, uiSeq: '3', drafts: [{...draft, status: 'saved-unapplied'}],
      preferences: {documentHash: fixture.owner.documentHash, selectedLayerIdsHash: hash('["selected_layer"]'), tool: 'select', viewport: {x: 0, y: 0, zoom: 1}, panels: {left: 280, right: 280, active: 'layers'}}}});
  addRow(fixture, 'promptMetadata', 'asset-view', '/api/v1/assets/' + prompt.id, {id: prompt.id});
  syncProxy(fixture); return draft;
}

test('complete typed unit facts establish only scoped absence and reduction does not mutate input', () => {
  const fixture = completeFixture(), before = clone(fixture), result = analyze(fixture);
  assert.equal(result.scope, WA_NETWORK_SCOPE); assert.equal(result.complete, true); assert.deepEqual(result.missing, []); assert.deepEqual(result.failures, []);
  assert.equal(result.globalNetworkCoverage, false); assert.equal(result.transportJoin, 'exact-counted-multiset-no-individual-cross-ledger-identity');
  assert.equal(result.payloadFetches, 0); assert.equal(result.repeatedPayloadFetches, 0); assert.equal(result.patchedBackendAttempts, 0);
  assert.equal(result.identityMismatch, 0); assert.equal(result.metadataRequests, 1); assert.deepEqual(fixture, before);
});

test('absent ledgers and accepted receipts without inline asset results remain incomplete', () => {
  assertIncomplete(analyzeWANetwork(), 'owned-browser-and-proxy-observations-required');
  for (const metadata of [{status: 'unknown', reason: 'command-result-pending'}, {status: 'unknown', reason: 'command-events-not-inline'}]) {
    const fixture = completeFixture(); fixture.by.weightsFinalizeResult.responseMetadata = metadata;
    assertIncomplete(analyze(fixture), 'accepted-command-receipt-and-exact-inline-result-required');
  }
});

test('an observed disallowed command remains a failure alongside incomplete recording', () => {
  const fixture = completeFixture();
  addRow(fixture, 'unexpected', 'command-submit', '/api/v1/commands', {method: 'POST', commandMetadata: {status: 'unexpected', reason: 'unexpected-command-submit'}});
  syncProxy(fixture); fixture.raw.browser.recordingComplete = false; fixture.raw.browser.missing.push('window-request-row-bound');
  const result = analyze(fixture); assert.equal(result.complete, false); assertFailure(result, 'unexpected-command-submit');
});

test('transport comparison preserves duplicate multiplicity and never joins by row order or nearest time', () => {
  const fixture = completeFixture();
  addRow(fixture, 'duplicateMetadata', 'adapter-view', '/api/v1/adapters/' + fixture.selected.versionId, {id: fixture.selected.versionId});
  syncProxy(fixture); assert.equal(analyze(fixture).complete, true);
  fixture.raw.browser.rows.reverse();
  fixture.raw.proxy.requests.forEach((row, index) => {row.requestId = 'unrelated-local-' + index; row.receivedMs = 90000 - index; row.forwardedMs = 100000 - index;});
  assert.equal(analyze(fixture).complete, true, 'Local IDs and clock order must not invent cross-ledger attribution');
  fixture.raw.proxy.requests.splice(fixture.raw.proxy.requests.findIndex(row => row.route === 'adapter-view'), 1);
  assertIncomplete(analyze(fixture), 'exact-browser-proxy-transport-multiset-required');
});

test('transport equality includes exact URL digest, method, body declaration and offset', () => {
  for (const mutate of [row => {row.urlSha256 = hash('different-query-value');}, row => {row.method = 'HEAD';}, row => {row.requestBytes++;}, row => {row.uploadOffset = '1';}]) {
    const fixture = completeFixture(), proxy = fixture.raw.proxy.requests.find(row => row.requestId === 'proxy-' + fixture.by.weightsPut.requestId);
    mutate(proxy); assertIncomplete(analyze(fixture), 'exact-browser-proxy-transport-multiset-required');
  }
});

test('missing sizes or ACKs remain incomplete while observed size and ACK contradictions fail', () => {
  for (const mutate of [row => {row.sizes = {status: 'unknown'};}, row => {row.responseMetadata = {status: 'unknown'};}]) {
    const fixture = completeFixture(); mutate(fixture.by.weightsPut); assertIncomplete(analyze(fixture));
  }
  for (const [mutate, reason] of [
    [row => {row.sizes.values.requestBodySize = 3;}, 'staging-browser-body-size-or-range-mismatch'],
    [row => {row.responseMetadata.committedOffset = '3';}, 'staging-product-ACK-range-mismatch'],
    [row => {row.responseMetadata.state = 'receiving';}, 'staging-product-ACK-range-mismatch'],
    [row => {row.responseMetadata.ownerHash = hash('foreign-owner');}, 'staging-ACK-owner-or-immutable-identity-mismatch'],
  ]) {const fixture = completeFixture(); mutate(fixture.by.weightsPut); assertFailure(analyze(fixture), reason);}
});

test('browser control bytes and transfer producer ranges must match the actual retained envelopes', () => {
  const control = completeFixture(); control.by.registerSubmit.commandMetadata.bodyBytes++;
  assertFailure(analyze(control), 'control-body-size-mismatch');
  const transfer = completeFixture(); transfer.operations[0].transfer.runs[0].length = 3;
  assertFailure(analyze(transfer), 'browser-transfer-disagrees-with-upload-producer');
});

test('missing owner identity is incomplete while fully observed foreign owners and command scope fail', () => {
  const missing = completeFixture(); missing.operations.forEach(operation => {delete operation.owner.clientHash;});
  assertIncomplete(analyze(missing), 'typed-selected-upload-owner-and-document-required');
  const conflict = completeFixture(); conflict.operations[1].owner.clientHash = hash('foreign-client'); assertFailure(analyze(conflict));
  const document = completeFixture(); document.operations.forEach(operation => {operation.owner.documentHash = hash('foreign-document');}); assertFailure(analyze(document));
  const command = completeFixture(); command.by.registerSubmit.commandMetadata.sessionHash = hash('foreign-session');
  assertFailure(analyze(command), 'command-owner-or-global-command-scope-mismatch');
});

test('observed selected hashes and receipt transaction conflicts cannot be reduced to missing lineage', () => {
  const selected = completeFixture(); selected.operations[0].hash.sha256 = hash('different-selected-bytes'); assertFailure(analyze(selected));
  const receipt = completeFixture(); receipt.by.weightsFinalizeResult.responseMetadata.transactionId = 'foreign_transaction'; assertFailure(analyze(receipt));
  const registered = completeFixture(); registered.by.registerSubmit.commandMetadata.weightsAssetId = 'foreign_asset';
  assertFailure(analyze(registered), 'registered-adapter-selected-source-mismatch');
});

test('owned inline command results require the exact recovery descriptor and one matching release', () => {
  const missing = completeFixture(); delete missing.by.weightsFinalizeResult.responseMetadata.recovery;
  assertIncomplete(analyze(missing), 'actual-command-result-recovery-descriptor-required');
  const duplicate = completeFixture(), release = clone(duplicate.by.weightsFinalizeRelease);
  addRow(duplicate, 'duplicateRelease', release.route, '/api/v1/recovery/' + release.id + '/release', {method: 'POST', id: release.id,
    requestBytes: release.requestBytes, commandMetadata: release.commandMetadata, sizes: release.sizes, responseStatus: 204});
  syncProxy(duplicate); assertIncomplete(analyze(duplicate), 'one-release-per-owned-result-recovery-required');
  const conflict = completeFixture(); conflict.by.weightsFinalizeRelease.commandMetadata.recoveryId = 'foreign_recovery';
  assertFailure(analyze(conflict), 'recovery-release-identity-or-query-mismatch');
  const descriptor = completeFixture(); descriptor.by.weightsFinalizeEvents.urlSha256 = hash(origin + '/api/v1/events?after=1&recoveryId=foreign_recovery'); syncProxy(descriptor);
  assertIncomplete(analyze(descriptor));
});

test('saved captions admit prompt metadata only through exact oracle references and a later persisted checkpoint', () => {
  const complete = completeFixture(); addSavedDraft(complete); assert.equal(analyze(complete).complete, true);
  const reference = completeFixture(); addSavedDraft(reference); reference.raw.expected.draftReferences = [];
  assertIncomplete(analyze(reference), 'verified-saved-request-caption-prompt-reference-required');
  const checkpoint = completeFixture(); addSavedDraft(checkpoint); checkpoint.by.draftCheckpoint.responseMetadata.drafts = [];
  assertIncomplete(analyze(checkpoint), 'persisted-owned-SaveDraft-checkpoint-required');
  const conflict = completeFixture(); addSavedDraft(conflict); conflict.raw.expected.draftAssets[0].metadataSha256 = hash('foreign-caption-metadata');
  assertFailure(analyze(conflict), 'retained-draft-asset-metadata-identity-mismatch');
  const unrelated = completeFixture(); addSavedDraft(unrelated);
  addAuxiliaryStage(unrelated, 'unrelatedCaption', {id: 'unrelated_caption', purpose: 'caption', blob: blob('unrelated-caption', 6)}); syncProxy(unrelated);
  assertIncomplete(analyze(unrelated), 'finalized-stage-owned-asset-lineage-unresolved');
  const foreign = completeFixture(); addSavedDraft(foreign); foreign.by.saveDraft.commandMetadata.draft.documentHash = hash('foreign-document');
  assertFailure(analyze(foreign), 'SaveDraft-owned-request-document-mismatch');
});

test('closing preferences must derive exactly from the observed owned UI checkpoint', () => {
  const fixture = completeFixture(); addSavedDraft(fixture);
  const preferences = {...clone(fixture.by.draftCheckpoint.responseMetadata.preferences), documentHash: null, selectedLayerIdsHash: hash('[]')};
  const row = addRow(fixture, 'closePreferences', 'ui-view', '/api/v1/ui/draft_session', {method: 'POST', id: 'draft_session', requestBytes: 120,
    commandMetadata: {status: 'observed', kind: 'ui', type: 'SetPreferences', bodyBytes: 120, requestId: 'close_request', sessionHash: fixture.owner.draftSessionHash, expectedUISeq: '3', preferences},
    sizes: {status: 'reported', source: 'public-request.sizes', values: {requestBodySize: 120, requestHeadersSize: 80, responseBodySize: 80, responseHeadersSize: 80}},
    responseMetadata: {status: 'observed', kind: 'ui-receipt', requestId: 'close_request', receiptStatus: 'accepted', uiSeq: '4'}});
  syncProxy(fixture); assert.equal(analyze(fixture).complete, true);
  row.commandMetadata.preferences.viewport.x = 1;
  assertIncomplete(analyze(fixture), 'actual-close-preferences-checkpoint-lineage-required');
});

test('UI acceptance advances the exact expected sequence without guessing malformed receipt values', () => {
  const missing = completeFixture(); addSavedDraft(missing); missing.by.saveDraft.responseMetadata.uiSeq = null;
  assertIncomplete(analyze(missing), 'typed-UI-receipt-sequence-required');
  const mismatch = completeFixture(); addSavedDraft(mismatch); mismatch.by.saveDraft.responseMetadata.uiSeq = '9';
  assertFailure(analyze(mismatch), 'UI-receipt-sequence-mismatch');
});

test('metadata hashes must be declared before capture and an invalid declaration cannot prove a forbidden query', () => {
  for (const declaration of [undefined, [], ['not-a-digest']]) {
    const fixture = completeFixture(); fixture.raw.expected.metadataURLHashes = declaration;
    assertIncomplete(analyze(fixture), 'predeclared-exact-metadata-URL-hashes-required');
  }
  const changed = completeFixture(); changed.by.list.urlSha256 = hash(origin + '/api/v1/adapters?search=other'); syncProxy(changed);
  assertFailure(analyze(changed), 'metadata-query-not-predeclared');
  const unknownQuery = completeFixture(); delete unknownQuery.by.list.query;
  assertIncomplete(analyze(unknownQuery), 'actual-query-classification-required');
  const invalidQuery = completeFixture(); invalidQuery.by.list.query.validControl = false;
  assertFailure(analyze(invalidQuery), 'unexpected-application-query');
  const lateDeclaration = completeFixture(); lateDeclaration.raw.expected.metadataRegistration = 'after-cycle-observers';
  assertIncomplete(analyze(lateDeclaration), 'metadata-query-admission-must-precede-observation');
});

test('null ledger and oracle entries produce bounded missing evidence instead of throwing or disappearing silently', () => {
  for (const mutate of [
    fixture => {fixture.raw.browser.rows.push(null);}, fixture => {fixture.raw.proxy.requests.push(null);},
    fixture => {fixture.operations.push(null);}, fixture => {fixture.raw.expected.draftAssets.push(null);},
    fixture => {fixture.raw.expected.draftFacts.push(null);}, fixture => {fixture.raw.expected.draftReferences.push(null);},
    fixture => {fixture.raw.expected.carryInSSE.push(null);},
  ]) {const fixture = completeFixture(); mutate(fixture); assertIncomplete(analyze(fixture));}
});

test('an explicitly identified carried-in event stream can remain live without fabricated terminal evidence', () => {
  const fixture = completeFixture(), row = addCarry(fixture), result = analyze(fixture);
  assert.equal(result.complete, true); assert.deepEqual(result.failures, []); assert.equal(result.globalNetworkCoverage, false);
  assert.equal(row.terminal, null); assert.equal(fixture.raw.proxy.after.activeRequestCount, 1);
  fixture.raw.expected.carryInSSE[0].proxyRequestId = 'unobserved-proxy-request';
  assertIncomplete(analyze(fixture), 'exact-carried-in-SSE-identity-required');
});

test('reduction preserves multiple unsorted active identities and their exact caller-owned arrays', () => {
  const fixture = completeFixture(); addCarry(fixture); const first = clone(fixture.raw.expected.carryInSSE[0]); addCarry(fixture);
  fixture.raw.expected.carryInSSE.push(first); fixture.raw.browser.activeAtStart.reverse(); fixture.raw.browser.activeAtEnd.reverse();
  fixture.raw.proxy.before.activeRequests.reverse(); fixture.raw.proxy.after.activeRequests.reverse();
  const before = clone(fixture); const result = analyze(fixture);
  assert.equal(result.complete, true); assert.deepEqual(result.failures, []); assert.deepEqual(fixture, before);
});

test('carry-in stream end states must agree across their explicitly paired browser and proxy identities', () => {
  const fixture = completeFixture(), row = addCarry(fixture);
  row.activeAtEnd = false; row.terminal = 'finished'; row.terminalObservedMs = 100; row.terminalSequence = 100;
  fixture.raw.browser.activeAtEnd = []; fixture.raw.browser.activeSSEAtEnd = [];
  assertIncomplete(analyze(fixture));
  const errored = completeFixture(), stream = addCarry(errored);
  const proxy = errored.raw.proxy.requests.find(value => value.requestId === 'proxy-' + stream.requestId);
  proxy.terminal = {outcome: 'upstream-error', observedMs: 100}; errored.raw.proxy.after.activeRequests = []; errored.raw.proxy.after.activeRequestCount = 0;
  assertFailure(analyze(errored));
});

test('unfinished ordinary requests and unowned recovery routes cannot use the SSE exception', () => {
  const ordinary = completeFixture(), row = ordinary.by.initialMetadata;
  row.activeAtEnd = true; row.terminal = null; syncProxy(ordinary);
  assertIncomplete(analyze(ordinary), 'finished-browser-request-and-body-size-required');
  const unresolved = completeFixture(); addCarry(unresolved); unresolved.raw.expected.carryInSSE = [];
  assertIncomplete(analyze(unresolved), 'recovery-descriptor-owner-lineage-unresolved');
  const payload = completeFixture(), disguised = addCarry(payload); disguised.route = 'asset-content'; disguised.id = payload.selected.weightsAssetId;
  disguised.urlSha256 = hash(origin + '/api/v1/assets/' + disguised.id + '/content'); syncProxy(payload);
  assertFailure(analyze(payload), 'unexpected-application-http-request');
});

test('extra forbidden proxy traffic remains a failure even without a browser event', () => {
  for (const route of ['unknown', 'favicon', 'asset-content']) {
    const fixture = completeFixture(), extra = clone(fixture.raw.proxy.requests[0]);
    Object.assign(extra, {requestId: 'proxy-only', route, id: null, urlSha256: hash('proxy-only-' + route)}); fixture.raw.proxy.requests.push(extra);
    const result = analyze(fixture); assert.equal(result.complete, false); assertFailure(result, 'unexpected-proxy-http-route');
  }
});

test('a payload request is counted while unattributed backend attempts remain separate from cache claims', () => {
  const fixture = completeFixture();
  const row = addRow(fixture, 'payload', 'asset-content', '/api/v1/assets/' + fixture.selected.weightsAssetId + '/content', {id: fixture.selected.weightsAssetId});
  fixture.raw.lookup.afterRequestIds.push(row.requestId); syncProxy(fixture);
  const result = analyze(fixture); assertFailure(result, 'unexpected-application-http-request');
  assert.equal(result.payloadFetches, 1); assert.equal(result.repeatedPayloadFetches, 1); assert.equal(result.globalNetworkCoverage, false);
  const backend = completeFixture(); backend.raw.lookup.backendAfter.fetch = 1; backend.raw.backendAfter.fetch = 1;
  const attempted = analyze(backend); assertFailure(attempted, 'backend-guarded-network-effect-attempt');
  assert.equal(attempted.patchedBackendAttempts, 1); assert.equal(attempted.payloadFetches, 0); assert.equal(attempted.repeatedPayloadFetches, 0);
  assert.equal(attempted.complete, false); assert(attempted.missing.includes('backend-attempt-owned-payload-attribution-unavailable'));
  const zero = completeFixture(); zero.by.repeatedMetadata.sizes.values.responseBodySize = 0;
  const reduced = analyze(zero); assert.equal(reduced.complete, true); assert.equal(Object.hasOwn(reduced, 'cacheHit'), false);
});

test('repeated metadata identity and exact request inventory remain necessary', () => {
  const identity = completeFixture(); identity.raw.lookup.observedSha256 = hash('different-owned-metadata');
  assertFailure(analyze(identity), 'owned-adapter-cache-identity-mismatch');
  const ids = completeFixture(); ids.raw.lookup.afterRequestIds.push(ids.raw.lookup.afterRequestIds[0]);
  assertIncomplete(analyze(ids), 'actual-repeated-owned-metadata-lookup-required');
  const absent = completeFixture(); absent.raw.lookup.expectedSha256 = null;
  assertIncomplete(analyze(absent), 'actual-repeated-owned-metadata-lookup-required');
});

test('changed proxy process, route proof and listener coverage invalidate a scoped zero result', () => {
  for (const mutate of [
    fixture => {fixture.raw.proxy.after.pid++;}, fixture => {fixture.raw.proxy.after.originGeneration++;},
    fixture => {fixture.raw.proxy.after.routeChallenge.responseHash = hash('different-route-proof');},
    fixture => {fixture.raw.proxy.after.observerErrors = 1;}, fixture => {fixture.raw.browser.observation.listenerContinuityObserved = false;},
  ]) {const fixture = completeFixture(); mutate(fixture); assertIncomplete(analyze(fixture));}
});

function assertLookupUnavailable(result) {
  assert.equal(result.complete, false); assert.equal(result.identityMismatch, null); assert.equal(result.repeatedPayloadFetches, null);
  assert(result.missing.includes('actual-repeated-owned-metadata-lookup-required'));
  assert(result.missing.includes('repeated-owned-payload-attribution-unavailable'));
  assert.equal(result.failures.includes('owned-adapter-cache-identity-mismatch'), false, 'Unattributed hashes cannot establish an owned metadata identity mismatch');
}
function unequalLookupHashes(fixture) {fixture.raw.lookup.observedSha256 = hash('different-repeated-metadata');}
function addLookupPayload(fixture, label, patch = {}) {
  const row = addRow(fixture, label, 'asset-content', '/api/v1/assets/' + fixture.selected.weightsAssetId + '/content', {id: fixture.selected.weightsAssetId, ...patch});
  fixture.raw.lookup.afterRequestIds.push(row.requestId); syncProxy(fixture); return row;
}

test('lookup identity comparison requires one exact canonical owned GET before hashes can match or conflict', () => {
  const equal = completeFixture(); assert.equal(analyze(equal).identityMismatch, 0); assert.equal(analyze(equal).repeatedPayloadFetches, 0);
  const unequal = completeFixture(); unequalLookupHashes(unequal);
  const observed = analyze(unequal); assert.equal(observed.identityMismatch, 1); assertFailure(observed, 'owned-adapter-cache-identity-mismatch');
  for (const mutate of [
    row => {row.method = 'HEAD';}, row => {row.route = 'asset-view';}, row => {row.id = 'foreign_version';},
    row => {row.urlSha256 = hash(origin + '/api/v1/adapters/foreign_version');},
    row => {row.originIndex = -1;}, row => {row.isHTTP = false;}, row => {row.query.keys = ['cursor'];},
    row => {row.fromServiceWorker = true;}, row => {row.requestServiceWorker = true;},
    row => {row.terminal = 'failed';}, row => {row.responseStatus = 404;}, row => {row.sizes.values.requestBodySize = 1;},
  ]) {
    const fixture = completeFixture(); unequalLookupHashes(fixture); mutate(fixture.by.repeatedMetadata); syncProxy(fixture);
    assertLookupUnavailable(analyze(fixture));
  }
});

test('foreign metadata origin and adapter failures survive unavailable owned lookup attribution', () => {
  for (const [mutate, reason] of [
    [row => {row.originIndex = -1;}, 'request-outside-owned-HTTP-origin'],
    [row => {row.id = 'foreign_version';}, 'unowned-adapter-metadata-request'],
  ]) {
    const fixture = completeFixture(); unequalLookupHashes(fixture); mutate(fixture.by.repeatedMetadata); syncProxy(fixture);
    const result = analyze(fixture); assertLookupUnavailable(result); assertFailure(result, reason);
  }
});

test('missing, noncanonical or ambiguous metadata requests cannot attribute either metric', () => {
  const missing = completeFixture(); unequalLookupHashes(missing);
  missing.raw.browser.rows = missing.raw.browser.rows.filter(row => row.requestId !== missing.by.repeatedMetadata.requestId);
  missing.raw.lookup.afterRequestIds = [...missing.raw.lookup.beforeRequestIds]; syncProxy(missing);
  assertLookupUnavailable(analyze(missing));
  const outside = completeFixture(); unequalLookupHashes(outside); outside.raw.lookup.afterRequestIds = [...outside.raw.lookup.beforeRequestIds];
  assertLookupUnavailable(analyze(outside));
  const forgedURL = completeFixture(); unequalLookupHashes(forgedURL);
  forgedURL.by.repeatedMetadata.urlSha256 = hash(origin + '/api/v1/adapters/' + forgedURL.selected.versionId + '?forged=1');
  forgedURL.raw.lookup.urlSha256 = forgedURL.by.repeatedMetadata.urlSha256; syncProxy(forgedURL);
  assertLookupUnavailable(analyze(forgedURL));
  const wrongDigest = completeFixture(); unequalLookupHashes(wrongDigest); wrongDigest.raw.lookup.urlSha256 = hash('URL-not-in-the-lookup');
  assertLookupUnavailable(analyze(wrongDigest));
  const duplicate = completeFixture(); unequalLookupHashes(duplicate);
  const row = addRow(duplicate, 'ambiguousMetadata', 'adapter-view', '/api/v1/adapters/' + duplicate.selected.versionId, {id: duplicate.selected.versionId});
  duplicate.raw.lookup.afterRequestIds.push(row.requestId); syncProxy(duplicate);
  const result = analyze(duplicate); assert.equal(result.metadataRequests, 2); assertLookupUnavailable(result);
});

test('lookup ID inventories must remain bounded unique natural same-ledger prefixes', () => {
  const cases = [
    fixture => {delete fixture.raw.lookup.beforeRequestIds;}, fixture => {delete fixture.raw.lookup.afterRequestIds;},
    fixture => {fixture.raw.lookup.beforeRequestIds = null;}, fixture => {fixture.raw.lookup.afterRequestIds = 'not-an-array';},
    fixture => {fixture.raw.lookup.beforeRequestIds.push(fixture.raw.lookup.beforeRequestIds[0]);},
    fixture => {fixture.raw.lookup.afterRequestIds.push(fixture.raw.lookup.afterRequestIds[0]);},
    fixture => {fixture.raw.lookup.beforeRequestIds[0] = String(fixture.raw.lookup.beforeRequestIds[0]);},
    fixture => {fixture.raw.lookup.afterRequestIds[0] = -1;},
    fixture => {fixture.raw.lookup.afterRequestIds.push(999999);},
    fixture => {fixture.raw.lookup.beforeRequestIds.splice(0, 1);},
    fixture => {fixture.raw.lookup.afterRequestIds.splice(0, 1);},
    fixture => {fixture.raw.lookup.beforeRequestIds = Array.from({length: 4097}, (_, index) => index);},
    fixture => {fixture.raw.lookup.afterRequestIds = Array.from({length: 4097}, (_, index) => index);},
  ];
  for (const mutate of cases) {const fixture = completeFixture(); unequalLookupHashes(fixture); mutate(fixture); assertLookupUnavailable(analyze(fixture));}
});

test('lookup attribution requires the same ended observation and newly observed request sequences inside its bounds', () => {
  for (const mutate of [
    fixture => {fixture.raw.browser.observation.id = 'foreign_cycle';},
    fixture => {fixture.raw.browser.observation.status = 'active';},
    fixture => {delete fixture.raw.browser.observation.startSequence;},
    fixture => {delete fixture.raw.browser.observation.endSequence;},
    fixture => {fixture.raw.browser.observation.startSequence = fixture.by.repeatedMetadata.requestSequence;},
    fixture => {fixture.raw.browser.observation.endSequence = fixture.by.repeatedMetadata.requestSequence - 1;},
    fixture => {fixture.by.repeatedMetadata.requestSequence = null;},
    fixture => {fixture.by.repeatedMetadata.requestEventObserved = false;},
    fixture => {fixture.by.repeatedMetadata.activeAtStart = true;},
  ]) {const fixture = completeFixture(); unequalLookupHashes(fixture); mutate(fixture); assertLookupUnavailable(analyze(fixture));}
});

test('foreign payloads and known asset IDs at foreign origins are forbidden without becoming owned fetch counts', () => {
  for (const patch of [{id: 'foreign_asset'}, {originIndex: -1}]) {
    const fixture = completeFixture(), row = addLookupPayload(fixture, 'foreignPayload', patch);
    row.urlSha256 = hash((patch.originIndex === -1 ? 'http://foreign.invalid' : origin) + '/api/v1/assets/' + row.id + '/content'); syncProxy(fixture);
    const result = analyze(fixture); assertFailure(result, 'unexpected-application-http-request');
    assert.equal(result.identityMismatch, 0); assert.equal(result.repeatedPayloadFetches, 0); assert.equal(result.payloadFetches, 1);
  }
});

test('only payload GETs inside the exact repeat count; HEAD, POST, metadata and later requests do not', () => {
  for (const method of ['HEAD', 'POST']) {
    const fixture = completeFixture(); addLookupPayload(fixture, 'nonGetPayload', {method});
    const result = analyze(fixture); assertFailure(result, 'unexpected-application-http-request'); assert.equal(result.repeatedPayloadFetches, 0);
  }
  const metadata = completeFixture();
  const view = addRow(metadata, 'assetMetadata', 'asset-view', '/api/v1/assets/' + metadata.selected.weightsAssetId, {id: metadata.selected.weightsAssetId});
  metadata.raw.lookup.afterRequestIds.push(view.requestId); syncProxy(metadata);
  assert.equal(analyze(metadata).repeatedPayloadFetches, 0);
  const later = completeFixture(); addRow(later, 'laterPayload', 'asset-content', '/api/v1/assets/' + later.selected.weightsAssetId + '/content', {id: later.selected.weightsAssetId}); syncProxy(later);
  const result = analyze(later); assertFailure(result, 'unexpected-application-http-request'); assert.equal(result.payloadFetches, 1); assert.equal(result.repeatedPayloadFetches, 0);
});

test('malformed payload identity preserves the network failure while owned payload attribution stays unavailable', () => {
  for (const patch of [{id: null}, {id: 7}, {originIndex: null}, {originIndex: '0'}, {isHTTP: null}, {urlSha256: null}]) {
    const fixture = completeFixture(); addLookupPayload(fixture, 'unattributedPayload', patch);
    const result = analyze(fixture); assertFailure(result, 'unexpected-application-http-request');
    assert.equal(result.identityMismatch, 0); assert.equal(result.repeatedPayloadFetches, null);
    assert(result.missing.includes('repeated-owned-payload-attribution-unavailable'));
  }
});

test('every exact selected owned Asset ID can supply a counted payload GET without relying on URL order', () => {
  const fixture = completeFixture();
  fixture.selected.provenanceAssetId = 'provenance_asset'; fixture.selected.provenance = blob('selected-provenance', 2);
  fixture.operations.push({role: 'adapter-provenance', stagingId: 'selectedProvenance_stage', purpose: 'caption',
    hash: {sha256: fixture.selected.provenance.hash}, bytes: 2, owner: clone(fixture.owner), transfer: {runs: [{offset: 0, length: 2, chunks: 1}]}});
  fixture.by.registerSubmit.commandMetadata.provenanceAssetId = fixture.selected.provenanceAssetId;
  addAuxiliaryStage(fixture, 'selectedProvenance', {id: fixture.selected.provenanceAssetId, purpose: 'caption', blob: fixture.selected.provenance});
  fixture.raw.lookup.afterRequestIds = fixture.raw.browser.rows.map(row => row.requestId);
  const ids = [fixture.selected.versionId, fixture.selected.weightsAssetId, fixture.selected.configAssetId, fixture.selected.provenanceAssetId];
  for (const [index, assetId] of ids.entries()) {
    const row = addLookupPayload(fixture, 'ownedPayload' + index, {id: assetId});
    row.urlSha256 = hash(origin + '/api/v1/assets/' + assetId + '/content');
  }
  syncProxy(fixture); fixture.raw.proxy.requests.reverse();
  const result = analyze(fixture); assertFailure(result, 'unexpected-application-http-request');
  assert.equal(result.identityMismatch, 0); assert.equal(result.repeatedPayloadFetches, ids.length);
});
