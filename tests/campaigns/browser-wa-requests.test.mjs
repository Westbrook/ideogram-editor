import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {setImmediate as immediate} from 'node:timers/promises';
import {createBrowserWARequests} from '../../tooling/qualification/campaigns/browser-wa-requests.mjs';

// SOURCE ONLY: authored but not run. These emitters test refusals and missing
// evidence; they are never a browser/network/cache or H qualification receipt.
const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const sizes = {requestBodySize: 0, requestHeadersSize: 80, responseBodySize: 4, responseHeadersSize: 80};
const runtime = {engine: 'chromium', version: 'synthetic', revision: 'synthetic'};
class Page extends EventEmitter {
  constructor() {super(); this.frame = {page: () => this}; this.workerList = []; this.location = 'about:blank';}
  url() {return this.location;} mainFrame() {return this.frame;} workers() {return this.workerList;}
  route() {assert.fail('No routing');} evaluate() {assert.fail('No script injection');}
}
class Context extends EventEmitter {
  constructor(page) {super(); this.page = page; this.serviceWorkerList = [];}
  pages() {return [this.page];} serviceWorkers() {return this.serviceWorkerList;}
  route() {assert.fail('No routing');} newCDPSession() {assert.fail('No CDP');} addInitScript() {assert.fail('No global patches');}
}
class Request {
  constructor(page, options = {}) {this.page = page; this.options = options; this.jsonReads = 0;}
  url() {return this.options.url ?? 'http://127.0.0.1:4100/api/v1/adapters?token=SECRET';}
  method() {return this.options.method ?? 'GET';} resourceType() {return this.options.resourceType ?? 'fetch';}
  headers() {return this.options.headers ?? {};}
  frame() {if (this.options.frameThrows) throw Error('PRIVATE'); return this.page.mainFrame();}
  serviceWorker() {return this.options.serviceWorker ?? null;}
  sizes() {return this.options.sizes ? this.options.sizes() : Promise.resolve(sizes);}
  postDataBuffer() {return this.options.bytes ?? (this.options.body ? Buffer.from(JSON.stringify(this.options.body)) : null);}
  postDataJSON() {this.jsonReads++; return this.options.body;}
}
const response = (request, options = {}) => ({request: () => request, status: () => options.status ?? 200,
  fromServiceWorker: () => options.serviceWorker ?? false, headerValue: async () => options.contentType ?? null});
function setup(options = {}) {
  const page = new Page(), context = new Context(page);
  const collector = createBrowserWARequests({page, context, runtime, ...options});
  return {page, context, collector};
}
function assertLimited(result) {
  assert.equal(result.qualification, false); assert.equal(result.globalComplete, false);
  assert.equal(result.recordingComplete, false);
  assert.ok(result.missing.includes('runtime-identity-incomplete'));
}

test('same URL/method on distinct request objects cannot be collapsed into one identity', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('duplicates');
  for (let n = 0; n < 2; n++) {const req = new Request(page); context.emit('request', req); context.emit('response', response(req)); context.emit('requestfinished', req);}
  const result = await collector.endObservation('duplicates'); assertLimited(result);
  assert.equal(result.rows.length, 2); assert.notEqual(result.rows[0].requestId, result.rows[1].requestId);
  assert.equal(result.rows[0].urlSha256, sha('http://127.0.0.1:4100/api/v1/adapters?token=SECRET'));
  assert.equal(result.rows[0].urlSha256, result.rows[1].urlSha256);
  assert.equal(result.proxyJoin.semantics, 'counted-multiset-not-unique-request-identity');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|token=/); await collector.close();
});

test('beacon/other and unfamiliar HTTP resource types are not silently filtered', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('all-types');
  for (const resourceType of ['ping', 'other', 'future-http-type']) context.emit('request', new Request(page, {method: 'POST', resourceType}));
  const result = await collector.endObservation('all-types'); assertLimited(result);
  assert.equal(result.rows.length, 3); assert.ok(result.rows.every(row => row.method === 'POST'));
  assert.ok(result.missing.includes('ordinary-requests-active-at-boundary')); await collector.close();
});

test('zero size counters and absent requests never become cache-hit evidence', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('zero');
  const req = new Request(page, {sizes: async () => ({requestBodySize: 0, requestHeadersSize: 0, responseBodySize: 0, responseHeadersSize: 0})});
  context.emit('request', req); context.emit('response', response(req)); context.emit('requestfinished', req);
  const result = await collector.endObservation('zero'); assertLimited(result);
  assert.equal(result.rows[0].sizes.status, 'reported'); assert.equal(result.rows[0].cache.status, 'unknown');
  collector.beginObservation('empty'); const empty = await collector.endObservation('empty');
  assert.equal(empty.cacheEvidence.status, 'unknown'); assert.equal(empty.cacheEvidence.noRequestObservedDoesNotEstablishCacheHit, true);
  await collector.close();
});

test('SSE active before and after the window remains explicit without forced terminal events', async () => {
  const {page, context, collector} = setup();
  const req = new Request(page, {resourceType: 'eventsource', url: 'http://127.0.0.1:4100/api/v1/events/stream'});
  context.emit('request', req); context.emit('response', response(req, {contentType: 'text/event-stream'}));
  collector.beginObservation('sse'); const result = await collector.endObservation('sse'); assertLimited(result);
  assert.equal(result.rows[0].activeAtStart, true); assert.equal(result.rows[0].activeAtEnd, true);
  assert.equal(result.rows[0].terminal, null); assert.deepEqual(result.activeSSEAtEnd, [result.rows[0].requestId]);
  assert.equal(result.missing.includes('ordinary-requests-active-at-boundary'), false); await collector.close();
});

test('service-worker event and response paths are explicitly unsupported', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('sw');
  context.emit('serviceworker', {}); const req = new Request(page, {serviceWorker: {}});
  context.emit('request', req); context.emit('response', response(req, {serviceWorker: true})); context.emit('requestfinished', req);
  const result = await collector.endObservation('sw'); assertLimited(result);
  assert.equal(result.rows[0].fromServiceWorker, true);
  assert.ok(result.unsupported.includes('service-worker-response-unsupported'));
  assert.ok(result.unsupported.includes('service-worker-context-event-unsupported')); await collector.close();
});

test('unobserved starts, failed requests and unknown realms cannot establish closure', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('orphans');
  const req = new Request(page, {frameThrows: true}); context.emit('requestfailed', req);
  const result = await collector.endObservation('orphans'); assertLimited(result);
  assert.equal(result.rows[0].requestEventObserved, false); assert.equal(result.rows[0].terminal, 'failed');
  assert.equal(result.rows[0].sizes.status, 'unknown'); assert.ok(result.missing.includes('request-start-event-missing'));
  assert.ok(result.missing.includes('request-realm-unavailable')); await collector.close();
});

test('unexpected pages, workers and navigation are missing coverage, never accepted silently', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('realms');
  context.emit('page', new Page()); const worker = new EventEmitter(); page.emit('worker', worker); worker.emit('close');
  page.emit('framenavigated', page.mainFrame()); page.emit('frameattached', {});
  const result = await collector.endObservation('realms'); assertLimited(result);
  for (const reason of ['unexpected-page-created', 'worker-created-during-observation', 'worker-closed-during-observation', 'main-frame-navigation-during-observation', 'frame-attached-during-observation']) assert.ok(result.missing.includes(reason));
  await collector.close();
});

test('row and active-request overflow stay bounded and visible', async () => {
  const {page, context, collector} = setup({maxRows: 2}); collector.beginObservation('overflow');
  const a = new Request(page), b = new Request(page), c = new Request(page);
  for (const req of [a, b, c]) context.emit('request', req);
  context.emit('requestfinished', c); context.emit('requestfinished', a);
  context.emit('request', new Request(page)); const result = await collector.endObservation('overflow'); assertLimited(result);
  assert.equal(result.rows.length, 2); assert.equal(result.globalAfter.droppedRequests, 1);
  assert.equal(result.observation.droppedRows, 1); assert.ok(result.missing.includes('global-active-request-bound'));
  assert.ok(result.missing.includes('window-request-row-bound')); await collector.close();
});

test('a sizes promise deadline leaves unknown evidence and immutable terminal snapshots', {timeout: 1000}, async () => {
  let resolve; const waiting = new Promise(yes => {resolve = yes;});
  const {page, context, collector} = setup({drainTimeoutMs: 3}); collector.beginObservation('pending');
  const req = new Request(page, {sizes: () => waiting}); context.emit('request', req); context.emit('response', response(req)); context.emit('requestfinished', req);
  const result = await collector.endObservation('pending'); assertLimited(result);
  assert.equal(result.rows[0].sizes.status, 'unknown'); assert.ok(result.missing.includes('metadata-drain-timeout'));
  resolve(sizes); await immediate(); assert.deepEqual(collector.snapshotObservation('pending'), result);
  const close = await collector.close(); assert.equal(close.closed, true);
});

test('metadata added while ending shares the original deadline instead of a false drained label', {timeout: 1000}, async () => {
  let releaseType, releaseSizes;
  const type = new Promise(resolve => {releaseType = resolve;}), pendingSizes = new Promise(resolve => {releaseSizes = resolve;});
  const {page, context, collector} = setup({drainTimeoutMs: 5}); collector.beginObservation('late-metadata');
  const req = new Request(page, {sizes: () => pendingSizes});
  context.emit('request', req); context.emit('response', {...response(req), headerValue: () => type});
  const ending = collector.endObservation('late-metadata');
  context.emit('requestfinished', req); releaseType(null);
  const result = await ending; assertLimited(result);
  assert.equal(result.observation.metadataDrain, 'deadline'); assert.equal(result.rows[0].terminalWithinWindow, false);
  assert.equal(result.rows[0].sizes.status, 'unknown'); releaseSizes(sizes); await immediate();
  assert.deepEqual(collector.snapshotObservation('late-metadata'), result); await collector.close();
});

test('sizes rejection and malformed counters stay unknown rather than becoming zero transfer', async () => {
  for (const read of [async () => {throw Error('PRIVATE');}, async () => ({...sizes, responseBodySize: -1})]) {
    const {page, context, collector} = setup(); collector.beginObservation('bad-sizes');
    const req = new Request(page, {sizes: read}); context.emit('request', req); context.emit('requestfinished', req);
    const result = await collector.endObservation('bad-sizes'); assertLimited(result);
    assert.equal(result.rows[0].sizes.status, 'unknown'); assert.ok(result.missing.includes('request-sizes-unavailable'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); await collector.close();
  }
});

test('command metadata retains only permitted IDs/hashes and rejects other commands', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('commands');
  const bodies = [
    {command: {commandId: 'finalize', body: {type: 'FinalizeStaging', stagingId: 'stage', expectedSha256: sha('bytes'), prompt: 'SECRET'}}},
    {command: {commandId: 'register', body: {type: 'RegisterAdapterVersion', weightsAssetId: 'weights', configAssetId: null, provenanceAssetId: 'provenance', name: 'SECRET', provenanceText: 'SECRET'}}},
    {command: {commandId: 'unexpected', body: {type: 'DeleteDocument', documentId: 'SECRET'}}},
  ];
  for (const body of bodies) {const req = new Request(page, {url: 'http://127.0.0.1:4100/api/v1/commands', method: 'POST', body}); context.emit('request', req); context.emit('requestfinished', req);}
  const result = await collector.endObservation('commands'); assertLimited(result);
  assert.equal(result.rows[0].commandMetadata.stagingId, 'stage'); assert.equal(result.rows[1].commandMetadata.weightsAssetId, 'weights');
  assert.deepEqual(result.failures, ['unexpected-command-submit']); assert.doesNotMatch(JSON.stringify(result), /SECRET|provenanceText|prompt/);
  await collector.close();
});

test('post data is bounded before JSON parsing and no unavailable body is guessed', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('body-bound');
  const req = new Request(page, {url: 'http://127.0.0.1:4100/api/v1/commands', method: 'POST', bytes: Buffer.alloc(65537)});
  context.emit('request', req); const result = await collector.endObservation('body-bound'); assertLimited(result);
  assert.equal(req.jsonReads, 0); assert.equal(result.rows[0].commandMetadata.status, 'unknown');
  assert.ok(result.missing.includes('command-or-staging-metadata-unavailable')); await collector.close();
});

test('a missing or non-string command type cannot impersonate adapter registration metadata', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('missing-type');
  for (const type of [undefined, null, 7]) {
    const body = {command: {commandId: 'register', body: {type, weightsAssetId: 'weights', configAssetId: null, provenanceAssetId: null}}};
    context.emit('request', new Request(page, {url: 'http://127.0.0.1:4100/api/v1/commands', method: 'POST', body}));
  }
  const result = await collector.endObservation('missing-type'); assertLimited(result);
  assert.ok(result.rows.every(row => row.commandMetadata.status === 'unknown'));
  assert.ok(result.missing.includes('command-or-staging-metadata-unavailable')); await collector.close();
});

test('actual header metadata and origin indexes are bounded without retaining query or raw headers', async () => {
  const {page, context, collector} = setup({allowedOrigins: ['http://127.0.0.1:4100']}); collector.beginObservation('headers');
  for (const headers of [
    {'content-length': '123', 'upload-offset': '9007199254740993', authorization: 'SECRET'},
    {'content-length': '9007199254740993', 'upload-offset': '001', authorization: 'SECRET'},
  ]) context.emit('request', new Request(page, {headers}));
  const result = await collector.endObservation('headers'); assertLimited(result);
  assert.equal(result.rows[0].originIndex, 0); assert.equal(result.rows[0].requestBytes, 123);
  assert.equal(result.rows[0].uploadOffset, '9007199254740993');
  assert.equal(result.rows[1].requestBytes, null); assert.equal(result.rows[1].uploadOffset, null);
  assert.ok(result.rows[1].missing.includes('request-length-header-invalid'));
  assert.doesNotMatch(JSON.stringify(result), /SECRET|authorization|token=/); await collector.close();
});

test('SaveDraft and SetPreferences retain bounded bindings while other UI commands fail explicitly', async () => {
  const {page, context, collector} = setup({allowedOrigins: ['http://127.0.0.1:4100']}); collector.beginObservation('ui');
  const identity = {protocolVersion: 1, requestId: 'ui_request', sessionId: 'session_one', expectedUISeq: '2'};
  const bodies = [
    {...identity, body: {type: 'SaveDraft', draft: {id: 'draft_one', generation: '1', kind: 'request', documentId: 'private_document', targetLayerId: null, expectedDocumentRevision: '3', assetId: 'caption_one', composing: false, text: 'SECRET'}}},
    {...identity, body: {type: 'SetPreferences', preferences: {documentId: null, tool: 'select', selectedLayerIds: [], viewport: {x: 0, y: 0, zoom: 1}, panels: {left: 280, right: 280, active: 'layers'}}}},
    {...identity, body: {type: 'ClearDraft', draftId: 'SECRET', generation: '1'}},
    {...identity, body: {type: null}},
  ];
  for (const body of bodies) context.emit('request', new Request(page, {url: 'http://127.0.0.1:4100/api/v1/ui/session_one', method: 'POST', headers: {'x-app-client': 'private_client'}, body}));
  const result = await collector.endObservation('ui'); assertLimited(result);
  assert.equal(result.rows[0].clientHash, sha('private_client'));
  assert.equal(result.rows[0].commandMetadata.sessionHash, sha('session_one'));
  assert.equal(result.rows[0].commandMetadata.draft.documentHash, sha('private_document'));
  assert.equal(result.rows[0].commandMetadata.draft.assetId, 'caption_one');
  assert.equal(result.rows[1].commandMetadata.preferences.documentHash, null);
  assert.equal(result.rows[1].commandMetadata.preferences.selectedLayerIdsHash, sha('[]'));
  assert.deepEqual(result.failures, ['unexpected-ui-submit']);
  assert.equal(result.rows[3].commandMetadata.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private_document|private_client/); await collector.close();
});

test('query recognition rejects duplicates, unbounded values and unknown controls without keeping values', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('queries');
  const suffixes = ['/events?after=0', '/events?after=0&after=1', '/events/stream?after=0&recoveryId=one', '/adapters?search=SECRET', '/adapters?search=SECRET&unknown=x', '/commands?unknown=SECRET'];
  for (const suffix of suffixes) context.emit('request', new Request(page, {url: 'http://127.0.0.1:4100/api/v1' + suffix}));
  const result = await collector.endObservation('queries'); assertLimited(result);
  assert.deepEqual(result.rows.map(row => row.query.validControl), [true, false, false, true, false, false]);
  assert.ok(result.missing.includes('request-query-control-unavailable'));
  assert.doesNotMatch(JSON.stringify(result), /SECRET/); await collector.close();
});

test('control response body guards reject oversize/mismatched declarations before producing metadata', async () => {
  const {page, context, collector} = setup({allowedOrigins: ['http://127.0.0.1:4100']}); collector.beginObservation('response-bounds');
  const reads = [];
  for (const declared of ['65537', '1']) {
    const req = new Request(page, {url: 'http://127.0.0.1:4100/api/v1/assets/staging/stage_one'});
    context.emit('request', req); context.emit('response', {...response(req),
      headerValue: async key => key === 'content-length' ? declared : key === 'content-type' ? 'application/json' : null,
      body: async () => {reads.push(declared); return Buffer.from('{"SECRET":true}');}});
    context.emit('requestfinished', req);
  }
  const result = await collector.endObservation('response-bounds'); assertLimited(result);
  assert.deepEqual(reads, ['1']); assert.ok(result.rows.every(row => row.responseMetadata.status === 'unknown'));
  assert.ok(result.missing.includes('control-response-metadata-unavailable'));
  assert.doesNotMatch(JSON.stringify(result), /SECRET/); await collector.close();
});

test('receipt-only and reference-backed command responses cannot invent an asset result', async () => {
  const {page, context, collector} = setup({allowedOrigins: ['http://127.0.0.1:4100']}); collector.beginObservation('response-references');
  const payloads = [
    {protocolVersion: 1, kind: 'receipt', receipt: {commandId: 'cmd_one', status: 'accepted', transactionId: 'tx_one', fromSeq: '1', toSeq: '1'}},
    {protocolVersion: 1, kind: 'batches', more: false, batches: [{kind: 'transaction-ref', transactionId: 'tx_one', content: {url: 'SECRET'}}]},
  ];
  for (const value of payloads) {
    const bytes = Buffer.from(JSON.stringify(value)), req = new Request(page, {url: 'http://127.0.0.1:4100/api/v1/commands/cmd_one/result'});
    context.emit('request', req); context.emit('response', {...response(req),
      headerValue: async key => key === 'content-length' ? String(bytes.length) : key === 'content-type' ? 'application/json' : null,
      body: async () => bytes}); context.emit('requestfinished', req);
  }
  const result = await collector.endObservation('response-references'); assertLimited(result);
  assert.equal(result.rows[0].responseMetadata.evidence, 'receipt'); assert.equal(result.rows[0].responseMetadata.assets, null);
  assert.equal(result.rows[1].responseMetadata.status, 'unknown'); assert.equal(result.rows[1].responseMetadata.reason, 'command-events-not-inline');
  assert.ok(result.missing.includes('control-response-metadata-unavailable')); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  await collector.close();
});

test('an actual pending response shape is progress without a fabricated accepted receipt or asset', async () => {
  const {page, context, collector} = setup({allowedOrigins: ['http://127.0.0.1:4100']}); collector.beginObservation('pending-receipt');
  const value = {protocolVersion: 1, kind: 'pending', commandId: 'cmd_one', operationId: 'operation_one', phase: 'preparing', receiptUrl: '/api/v1/commands/cmd_one'};
  const bytes = Buffer.from(JSON.stringify(value)), req = new Request(page, {url: 'http://127.0.0.1:4100/api/v1/commands/cmd_one'});
  context.emit('request', req); context.emit('response', {...response(req, {status: 202}),
    headerValue: async key => key === 'content-length' ? String(bytes.length) : key === 'content-type' ? 'application/json' : null,
    body: async () => bytes}); context.emit('requestfinished', req);
  const result = await collector.endObservation('pending-receipt'); assertLimited(result);
  const metadata = result.rows[0].responseMetadata;
  assert.equal(metadata.status, 'observed'); assert.equal(metadata.evidence, 'pending'); assert.equal(metadata.receiptStatus, 'pending');
  assert.equal(metadata.assets, null); assert.equal(metadata.assetsStatus, 'pending-not-terminal');
  assert.equal(result.missing.includes('control-response-metadata-unavailable'), false); await collector.close();
});

test('checkpoint metadata hashes owners and documents and rejects a checkpoint from another session', async () => {
  const {page, context, collector} = setup({allowedOrigins: ['http://127.0.0.1:4100']}); collector.beginObservation('checkpoint');
  const checkpoint = {sessionId: 'session_one', uiSeq: '5', preferences: {documentId: 'private_document', tool: 'select',
    selectedLayerIds: ['private_layer'], viewport: {x: 2, y: 3, zoom: 1.5}, panels: {left: 280, right: 280, active: 'layers'}},
    drafts: [{id: 'draft_one', generation: '1', kind: 'request', documentId: 'private_document', targetLayerId: null,
      expectedDocumentRevision: '3', assetId: 'caption_one', composing: false, status: 'saved-unapplied', text: 'SECRET'}], reconciledLayerIds: []};
  for (const sessionId of ['session_one', 'session_other']) {
    const bytes = Buffer.from(JSON.stringify({...checkpoint, sessionId}));
    const req = new Request(page, {url: 'http://127.0.0.1:4100/api/v1/ui/session_one'});
    context.emit('request', req); context.emit('response', {...response(req),
      headerValue: async key => key === 'content-length' ? String(bytes.length) : key === 'content-type' ? 'application/json' : null,
      body: async () => bytes}); context.emit('requestfinished', req);
  }
  const result = await collector.endObservation('checkpoint'); assertLimited(result);
  const observed = result.rows[0].responseMetadata;
  assert.equal(observed.kind, 'ui-checkpoint'); assert.equal(observed.sessionHash, sha('session_one'));
  assert.equal(observed.preferences.documentHash, sha('private_document')); assert.equal(observed.preferences.selectedLayerIdsHash, sha('["private_layer"]'));
  assert.equal(observed.drafts[0].assetId, 'caption_one'); assert.equal(observed.drafts[0].status, 'saved-unapplied');
  assert.equal(result.rows[1].responseMetadata.status, 'unknown');
  assert.ok(result.missing.includes('control-response-metadata-unavailable')); assert.doesNotMatch(JSON.stringify(result), /SECRET|private_document|private_layer/);
  await collector.close();
});

test('staging creation retains exact decimal sizes and hashes without filenames or text', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('staging');
  const body = {stagingId: 'stage', expectedBytes: '9007199254740993', sha256: sha('payload'), purpose: 'adapter', filename: 'SECRET'};
  const req = new Request(page, {url: 'http://127.0.0.1:4100/api/v1/assets/staging', method: 'POST', body});
  context.emit('request', req); const result = await collector.endObservation('staging'); assertLimited(result);
  assert.equal(result.rows[0].commandMetadata.expectedBytes, '9007199254740993'); assert.doesNotMatch(JSON.stringify(result), /SECRET|filename/);
  await collector.close();
});

test('close detaches listeners idempotently and observation identities cannot overlap or repeat', async () => {
  const {page, context, collector} = setup(); collector.beginObservation('once');
  assert.throws(() => collector.beginObservation('twice')); const end = await collector.endObservation('once'); assertLimited(end);
  assert.throws(() => collector.beginObservation('once')); assert.throws(() => collector.snapshotObservation('unknown'));
  const first = collector.close(); assert.equal(collector.close(), first); await first;
  assert.equal(context.listenerCount('request'), 0); assert.equal(page.listenerCount('worker'), 0);
  assert.throws(() => collector.beginObservation('after-close'));
});

test('observed inline command results retain their exact recovery ID and typed releases read no 204 body', async () => {
  const {page, context, collector} = setup({allowedOrigins: ['http://127.0.0.1:4100']}); collector.beginObservation('result-release');
  const value = {protocolVersion: 1, kind: 'batches', more: false, nextCursor: '4', recovery: {recoveryId: 'recovery_one', highWater: '4'},
    batches: [{kind: 'inline', transactionId: 'tx_one', fromSeq: '4', toSeq: '4', events: [{commandId: 'cmd_one', transactionId: 'tx_one',
      workspaceSeq: '4', type: 'AssetRegistered', payload: {asset: {id: 'asset_one', purpose: 'caption', blob: {hash: sha('bytes'), byteLength: '5', mediaType: 'text/plain'}}}}]}]};
  const bytes = Buffer.from(JSON.stringify(value));
  const resultRequest = new Request(page, {url: 'http://127.0.0.1:4100/api/v1/commands/cmd_one/result'});
  context.emit('request', resultRequest); context.emit('response', {...response(resultRequest),
    headerValue: async key => key === 'content-length' ? String(bytes.length) : key === 'content-type' ? 'application/json' : null,
    body: async () => bytes}); context.emit('requestfinished', resultRequest);
  const body = {protocolVersion: 1}, release = new Request(page, {url: 'http://127.0.0.1:4100/api/v1/recovery/recovery_one/release', method: 'POST', body});
  context.emit('request', release); context.emit('response', {...response(release, {status: 204}), body: () => {assert.fail('204 release has no control response body');}});
  context.emit('requestfinished', release);
  const result = await collector.endObservation('result-release'); assertLimited(result);
  assert.deepEqual(result.rows[0].responseMetadata.recovery, {recoveryId: 'recovery_one', highWater: '4'});
  assert.deepEqual(result.rows[1].commandMetadata, {status: 'observed', kind: 'recovery-release', protocolVersion: 1, recoveryId: 'recovery_one', bodyBytes: Buffer.byteLength(JSON.stringify(body))});
  assert.equal(result.rows[1].responseStatus, 204); assert.equal(result.rows[1].responseMetadata.status, 'not-applicable');
  assert.equal(result.rows[1].terminal, 'finished'); await collector.close();
});

test('unavailable result recovery identities and malformed release bodies stay unknown', async () => {
  const {page, context, collector} = setup({allowedOrigins: ['http://127.0.0.1:4100']}); collector.beginObservation('invalid-release');
  const value = {protocolVersion: 1, kind: 'batches', more: false, nextCursor: '1', recovery: {highWater: '1'},
    batches: [{kind: 'inline', transactionId: 'tx_one', fromSeq: '1', toSeq: '1', events: [{commandId: 'cmd_one', transactionId: 'tx_one', workspaceSeq: '1', type: 'AssetRegistered', payload: {}}]}]};
  const bytes = Buffer.from(JSON.stringify(value)), req = new Request(page, {url: 'http://127.0.0.1:4100/api/v1/commands/cmd_one/result'});
  context.emit('request', req); context.emit('response', {...response(req),
    headerValue: async key => key === 'content-length' ? String(bytes.length) : key === 'content-type' ? 'application/json' : null,
    body: async () => bytes}); context.emit('requestfinished', req);
  for (const body of [{protocolVersion: 2}, {protocolVersion: 1, unrelated: 'SECRET'}, null]) {
    context.emit('request', new Request(page, {url: 'http://127.0.0.1:4100/api/v1/recovery/recovery_one/release', method: 'POST', body}));
  }
  const result = await collector.endObservation('invalid-release'); assertLimited(result);
  assert.equal(result.rows[0].responseMetadata.status, 'unknown');
  assert.ok(result.rows.slice(1).every(row => row.commandMetadata.status === 'unknown'));
  assert.ok(result.missing.includes('control-response-metadata-unavailable')); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  await collector.close();
});
