import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {classifyBrowserRequestPath, normalizeBrowserOrigins} from './browser-network.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
const now = () => performance.now();
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const boundedString = (value, limit = 256) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const sizeKeys = ['requestBodySize', 'requestHeadersSize', 'responseBodySize', 'responseHeadersSize'];
const routeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const contentHash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
const purposes = ['image', 'mask', 'adapter', 'font', 'caption', 'bundle', 'text'];

function projectPreferences(prefs) {
  if (!prefs || !(prefs.documentId === null || routeId(prefs.documentId)) || !['select', 'transform', 'crop', 'mask', 'text'].includes(prefs.tool) ||
      ![prefs.viewport?.x, prefs.viewport?.y, prefs.viewport?.zoom, prefs.panels?.left, prefs.panels?.right].every(Number.isFinite) ||
      prefs.viewport.zoom <= 0 || prefs.panels.left < 0 || prefs.panels.right < 0 || !['layers', 'history', 'assets'].includes(prefs.panels.active) ||
      !Array.isArray(prefs.selectedLayerIds) || prefs.selectedLayerIds.length > 100 || !prefs.selectedLayerIds.every(routeId) || new Set(prefs.selectedLayerIds).size !== prefs.selectedLayerIds.length) throw Error();
  return {documentHash: prefs.documentId === null ? null : hash(prefs.documentId), tool: prefs.tool,
    selectedLayerIdsHash: hash(JSON.stringify(prefs.selectedLayerIds)), viewport: {x: prefs.viewport.x, y: prefs.viewport.y, zoom: prefs.viewport.zoom},
    panels: {left: prefs.panels.left, right: prefs.panels.right, active: prefs.panels.active}};
}
function projectDraft(draft, includeStatus = false) {
  if (!draft || ![draft.id, draft.documentId, draft.assetId].every(routeId) || !decimal(draft.generation) || !decimal(draft.expectedDocumentRevision) ||
      !(draft.targetLayerId === null || routeId(draft.targetLayerId)) || !['prompt', 'inspector', 'text', 'mask', 'composition', 'request'].includes(draft.kind) || typeof draft.composing !== 'boolean') throw Error();
  if (includeStatus && !['saved-unapplied', 'applied'].includes(draft.status)) throw Error();
  return {id: draft.id, generation: draft.generation, kind: draft.kind, documentHash: hash(draft.documentId), targetLayerId: draft.targetLayerId,
    expectedDocumentRevision: draft.expectedDocumentRevision, assetId: draft.assetId, composing: draft.composing,
    ...(includeStatus ? {status: draft.status} : {})};
}

function needsResponseMetadata(row) {
  return row.method === 'POST' && ['command-submit', 'asset-staging-create', 'ui-view'].includes(row.route) ||
    ['GET', 'PUT'].includes(row.method) && row.route === 'asset-staging' ||
    row.method === 'GET' && ['command-view', 'command-result', 'ui-view'].includes(row.route);
}
function controlResponseMetadata(value, row) {
  // GET UI returns the raw UICheckpoint, without protocolVersion. Its binding
  // is the actual session path; it is not a POST receipt or a document mutation.
  if (row.route === 'ui-view' && row.method === 'GET') {
    if (!routeId(value?.sessionId) || value.sessionId !== row.id || !decimal(value.uiSeq) || !Array.isArray(value.drafts) || value.drafts.length > 256) throw Error();
    return {status: 'observed', kind: 'ui-checkpoint', sessionHash: hash(value.sessionId), uiSeq: value.uiSeq,
      preferences: projectPreferences(value.preferences), drafts: value.drafts.map(draft => projectDraft(draft, true))};
  }
  if (value?.protocolVersion !== 1) throw Error();
  if (['asset-staging', 'asset-staging-create'].includes(row.route)) {
    const expectedId = row.route === 'asset-staging' ? row.id : row.commandMetadata.stagingId;
    if (!routeId(value.stagingId) || value.stagingId !== expectedId || !purposes.includes(value.purpose) || !decimal(value.expectedBytes) ||
        !contentHash(value.sha256) || !decimal(value.committedOffset) || BigInt(value.committedOffset) > BigInt(value.expectedBytes) ||
        !['receiving', 'complete', 'finalized', 'failed'].includes(value.state) || !routeId(value.ownerClientId)) throw Error();
    return {status: 'observed', kind: 'stage', stagingId: value.stagingId, purpose: value.purpose,
      expectedBytes: value.expectedBytes, sha256: value.sha256, committedOffset: value.committedOffset, state: value.state, ownerHash: hash(value.ownerClientId)};
  }
  if (row.route === 'ui-view') {
    if (!routeId(value.requestId) || value.requestId !== row.commandMetadata.requestId || !['accepted', 'rejected'].includes(value.status) || !decimal(value.uiSeq)) throw Error();
    return {status: 'observed', kind: 'ui-receipt', requestId: value.requestId, receiptStatus: value.status, uiSeq: value.uiSeq};
  }
  const commandId = row.route === 'command-submit' ? row.commandMetadata.commandId : row.id;
  if (!routeId(commandId)) throw Error();
  if (value.kind === 'receipt') {
    const receipt = value.receipt;
    if (receipt?.commandId !== commandId || !['accepted', 'rejected'].includes(receipt.status)) throw Error();
    const result = {status: 'observed', kind: 'command-result', evidence: 'receipt', commandId,
      receiptStatus: receipt.status, assets: null, assetsStatus: 'not-present-in-receipt'};
    if (receipt.status === 'accepted') {
      if (!routeId(receipt.transactionId) || !decimal(receipt.fromSeq) || !decimal(receipt.toSeq) || BigInt(receipt.fromSeq) < 1n || BigInt(receipt.toSeq) < BigInt(receipt.fromSeq)) throw Error();
      Object.assign(result, {transactionId: receipt.transactionId, fromSeq: receipt.fromSeq, toSeq: receipt.toSeq});
    }
    return result;
  }
  if (value.kind === 'pending' && value.commandId === commandId) {
    if (!routeId(value.operationId) || !['preparing', 'waiting-for-resources'].includes(value.phase) || value.receiptUrl !== '/api/v1/commands/' + commandId) throw Error();
    return {status: 'observed', kind: 'command-result', evidence: 'pending', commandId, receiptStatus: 'pending',
      operationId: value.operationId, phase: value.phase, assets: null, assetsStatus: 'pending-not-terminal'};
  }
  if (value.kind === 'unknown' && value.commandId === commandId) return {status: 'unknown', kind: 'command-result', commandId, reason: 'command-result-unknown'};
  if (row.route !== 'command-result' || value.kind !== 'batches' || value.more !== false || !Array.isArray(value.batches) || value.batches.length !== 1) throw Error();
  const batch = value.batches[0];
  if (batch?.kind !== 'inline') return {status: 'unknown', kind: 'command-result', commandId, reason: 'command-events-not-inline'};
  if (!routeId(batch.transactionId) || !decimal(batch.fromSeq) || !decimal(batch.toSeq) || BigInt(batch.fromSeq) < 1n ||
      !Array.isArray(batch.events) || !batch.events.length || batch.events.length > 256 ||
      BigInt(batch.toSeq) - BigInt(batch.fromSeq) + 1n !== BigInt(batch.events.length) || value.nextCursor !== batch.toSeq ||
      !routeId(value.recovery?.recoveryId) || value.recovery.highWater !== batch.toSeq) throw Error();
  const assets = [], eventTypes = new Set();
  for (const [index, event] of batch.events.entries()) {
    if (event?.commandId !== commandId || event.transactionId !== batch.transactionId || event.workspaceSeq !== String(BigInt(batch.fromSeq) + BigInt(index)) || !boundedString(event.type, 128)) throw Error();
    eventTypes.add(event.type);
    if (event.type !== 'AssetRegistered') continue;
    const asset = event.payload?.asset, blob = asset?.blob;
    if (!routeId(asset?.id) || !purposes.includes(asset.purpose) || !contentHash(blob?.hash) || !decimal(blob.byteLength) ||
        !boundedString(blob.mediaType, 128) || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(blob.mediaType) || assets.length >= 64) throw Error();
    assets.push({id: asset.id, purpose: asset.purpose, blob: {hash: blob.hash, byteLength: blob.byteLength, mediaType: blob.mediaType}});
  }
  return {status: 'observed', kind: 'command-result', evidence: 'inline-events', commandId, receiptStatus: null,
    transactionId: batch.transactionId, fromSeq: batch.fromSeq, toSeq: batch.toSeq, eventTypes: [...eventTypes].sort(), assets, assetsStatus: 'observed-inline-events',
    recovery: {recoveryId: value.recovery.recoveryId, highWater: value.recovery.highWater}};
}
async function readControlResponse(response, row) {
  const allowedStatus = row.responseStatus === 200 || row.responseStatus === 201 && row.route === 'asset-staging-create' ||
    row.responseStatus === 202 && ['command-submit', 'command-view', 'command-result'].includes(row.route);
  if (row.originIndex < 0 || !needsResponseMetadata(row) || !allowedStatus) throw Error();
  const length = await response.headerValue('content-length');
  if (typeof length !== 'string' || !/^(0|[1-9][0-9]{0,4})$/.test(length) || Number(length) > 65536) throw Error();
  const type = await response.headerValue('content-type'), encoding = await response.headerValue('content-encoding');
  if (typeof type !== 'string' || type.length > 128 || !/^application\/json(?:\s*;|\s*$)/i.test(type) || encoding !== null && encoding !== 'identity') throw Error();
  const bytes = await response.body();
  if (!Buffer.isBuffer(bytes) || bytes.length !== Number(length) || bytes.length > 65536) throw Error();
  return {...controlResponseMetadata(JSON.parse(bytes.toString('utf8')), row), bodyBytes: bytes.length};
}

function queryMetadata(parsed, route) {
  const entries = [...parsed.searchParams];
  if (entries.length > 16 || entries.some(([key]) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key))) return {keys: [], validControl: false};
  const keys = entries.map(([key]) => key).sort(), unique = new Set(keys).size === keys.length;
  let validControl = unique && entries.length === 0;
  if (route === 'events' || route === 'events-stream') validControl = unique && decimal(parsed.searchParams.get('after')) &&
    entries.every(([key, value]) => key === 'after' || route === 'events' && key === 'recoveryId' && routeId(value));
  // Recognition does not admit an adapter query. The reducer must join the
  // exact captured URL digest to its selected repeat, including query values.
  else if (route === 'adapter-list' && entries.length) validControl = unique && entries.length === 1 &&
    entries[0][0] === 'search' && entries[0][1].length <= 256 && !/[\u0000-\u001f\u007f]/.test(entries[0][1]);
  else if (['snapshot', 'namespace-events', 'protocol-content'].includes(route) && entries.length) validControl = unique &&
    entries.length === 1 && entries[0][0] === 'recoveryId' && routeId(entries[0][1]);
  else if (['ui-inventory', 'command-inventory', 'asset-staging-recovery'].includes(route) && entries.length) validControl = unique &&
    entries.length === 1 && entries[0][0] === 'cursor' && routeId(entries[0][1]);
  return {keys, validControl};
}

function commandMetadata(request, route, method, classifiedId) {
  if (method !== 'POST' || !['command-submit', 'asset-staging-create', 'ui-view', 'recovery-release'].includes(route)) return {status: 'not-applicable'};
  try {
    const bytes = request.postDataBuffer();
    if (!Buffer.isBuffer(bytes) || bytes.length > 65536) return {status: 'unknown', reason: 'post-data-absent-or-over-bound'};
    // The public immutable Request provides both views. Bound its original bytes
    // before invoking its JSON parser; retain only these narrow non-text fields.
    const value = request.postDataJSON();
    if (route === 'recovery-release') {
      if (!value || Array.isArray(value) || Object.keys(value).join(',') !== 'protocolVersion' || value.protocolVersion !== 1 || !routeId(classifiedId)) throw Error();
      return {status: 'observed', kind: 'recovery-release', protocolVersion: 1, recoveryId: classifiedId, bodyBytes: bytes.length};
    }
    if (route === 'ui-view') {
      if (typeof value?.body?.type !== 'string') throw Error();
      if (!['SaveDraft', 'SetPreferences'].includes(value.body.type)) return {status: 'unexpected', reason: 'unexpected-ui-submit'};
      if (value.protocolVersion !== 1 || !routeId(value.requestId) || !routeId(value.sessionId) || value.sessionId !== classifiedId || !decimal(value.expectedUISeq)) throw Error();
      const identity = {status: 'observed', kind: 'ui', type: value.body.type, bodyBytes: bytes.length,
        requestId: value.requestId, sessionHash: hash(value.sessionId), expectedUISeq: value.expectedUISeq};
      if (value.body.type === 'SaveDraft') return {...identity, draft: projectDraft(value.body.draft)};
      return {...identity, preferences: projectPreferences(value.body.preferences)};
    }
    if (route === 'asset-staging-create') {
      if (!routeId(value?.stagingId) || !contentHash(value.sha256) || typeof value.expectedBytes !== 'string' ||
          !/^(0|[1-9][0-9]{0,19})$/.test(value.expectedBytes) || !['image', 'mask', 'adapter', 'font', 'caption', 'bundle', 'text'].includes(value.purpose)) throw Error();
      return {status: 'observed', kind: 'staging-create', bodyBytes: bytes.length, stagingId: value.stagingId,
        expectedBytes: value.expectedBytes, sha256: value.sha256, purpose: value.purpose};
    }
    const command = value?.command, body = command?.body;
    if (body && typeof body.type === 'string' && !['FinalizeStaging', 'RegisterAdapterVersion'].includes(body.type)) return {status: 'unexpected', reason: 'unexpected-command-submit', commandId: routeId(command?.commandId) ? command.commandId : null};
    if (!routeId(command?.commandId) || !['FinalizeStaging', 'RegisterAdapterVersion'].includes(body?.type)) throw Error();
    const ownerComplete = [command.clientId, command.sessionId, command.transactionId].every(routeId) &&
      (command.documentId === null || routeId(command.documentId)) && (command.expectedDocumentRevision === null || decimal(command.expectedDocumentRevision));
    const owner = {ownerStatus: ownerComplete ? 'observed' : 'unknown',
      clientHash: routeId(command.clientId) ? hash(command.clientId) : null,
      sessionHash: routeId(command.sessionId) ? hash(command.sessionId) : null,
      documentHash: routeId(command.documentId) ? hash(command.documentId) : null,
      expectedDocumentRevision: decimal(command.expectedDocumentRevision) ? command.expectedDocumentRevision : null,
      transactionId: routeId(command.transactionId) ? command.transactionId : null};
    if (body.type === 'FinalizeStaging') {
      if (!routeId(body.stagingId) || !contentHash(body.expectedSha256)) throw Error();
      return {status: 'observed', kind: 'command', type: body.type, bodyBytes: bytes.length, ...owner,
        commandId: command.commandId, stagingId: body.stagingId, expectedSha256: body.expectedSha256};
    }
    if (!routeId(body.weightsAssetId) || ![body.configAssetId, body.provenanceAssetId].every(value => value === null || routeId(value))) throw Error();
    return {status: 'observed', kind: 'command', type: body.type, bodyBytes: bytes.length, ...owner,
      commandId: command.commandId, weightsAssetId: body.weightsAssetId, configAssetId: body.configAssetId, provenanceAssetId: body.provenanceAssetId};
  } catch {return {status: 'unknown', reason: 'bounded-post-data-metadata-unavailable'};}
}
const initialCounts = () => ({requests: 0, responses: 0, finished: 0, failed: 0, orphanEvents: 0, nonHTTP: 0,
  droppedRequests: 0, serviceWorkers: 0, pageChanges: 0, workerChanges: 0, frameChanges: 0, metadataFailures: 0});

function runtimeIdentity(runtime) {
  const process = runtime?.ownedLaunch?.process;
  return {source: 'browser-parent-runtime-requires-owning-receipt',
    engine: ['chromium', 'firefox', 'webkit'].includes(runtime?.engine) ? runtime.engine : null,
    version: boundedString(runtime?.version), revision: boundedString(runtime?.revision),
    browserPid: Number.isSafeInteger(runtime?.browserPid) && runtime.browserPid > 0 ? runtime.browserPid : null,
    ownedProcessPid: Number.isSafeInteger(process?.pid) && process.pid > 0 ? process.pid : null,
    startedAtIdentity: boundedString(process?.startedAtIdentity),
    executableSha256: /^(?:sha256:)?[a-f0-9]{64}$/.test(runtime?.executableIdentity?.sha256 ?? '') ? runtime.executableIdentity.sha256 : null};
}

/**
 * Passive public-Playwright BrowserContext request ledger. Install immediately
 * after creating the owned blank page, before route verification/product goto.
 * This observer never installs routes, opens CDP, evaluates scripts, touches the
 * cache. Only bounded command/staging/UI control JSON is
 * transiently parsed into fixed IDs/hashes; no user text/body bytes are retained.
 * Object identity is local to this
 * instance; URL hash + full method identifies a multiset, not an individual
 * proxy request. Cache-source attribution is unavailable through these APIs.
 * One observation is live at a time. Completed snapshots are detached copies.
 */
export function createBrowserWARequests({context, page, runtime, allowedOrigins = [], maxRows = 4096, drainTimeoutMs = 5000} = {}) {
  if (!context || !page || !['on', 'off'].every(name => typeof context[name] === 'function' && typeof page[name] === 'function')) throw Error('Public owned context and page required');
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 4096) throw Error('Invalid request row bound');
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 10000) throw Error('Invalid metadata drain deadline');
  if (!Array.isArray(allowedOrigins)) throw Error('Owned origin array required');
  const origins = allowedOrigins.length ? normalizeBrowserOrigins(allowedOrigins) : [];
  const installedMs = now(), identity = runtimeIdentity(runtime), counts = initialCounts();
  const ids = new WeakMap(), records = new WeakMap(), active = new Map(), pending = new Set(), subscriptions = [];
  const knownWorkers = new Set(), globalMissing = new Set(), unsupported = new Set(), usedWindows = new Set();
  let nextId = 0, sequence = 0, current = null, previous = null, closed = false, closePromise, contextClosed = false;
  const missing = value => {globalMissing.add(value); if (current?.phase === 'active') current.missing.add(value);};
  const unsupportedReason = value => {unsupported.add(value); missing(value);};
  if (!identity.engine || !identity.version || !identity.revision || !identity.browserPid || identity.browserPid !== identity.ownedProcessPid || !identity.startedAtIdentity || !identity.executableSha256) missing('runtime-identity-incomplete');
  if (!origins.length) missing('owned-origins-unavailable');
  function listen(target, event, handler) {
    if (subscriptions.length >= 1024) {missing('listener-inventory-bound'); return;}
    const guarded = value => {if (closed) return; try {handler(value);} catch {missing('observer-callback-failed');}};
    target.on(event, guarded); subscriptions.push([target, event, guarded]);
  }
  function realmChange(reason, key) {counts[key]++; if (current?.phase === 'active') current.missing.add(reason);}
  function observeWorker(worker, startup = false) {
    if (!object(worker) || knownWorkers.has(worker)) return;
    if (knownWorkers.size >= 256) {missing('worker-inventory-bound'); return;}
    knownWorkers.add(worker);
    if (!startup) realmChange('worker-created-during-observation', 'workerChanges');
    if (typeof worker.on === 'function' && typeof worker.off === 'function') listen(worker, 'close', () => {
      knownWorkers.delete(worker); realmChange('worker-closed-during-observation', 'workerChanges');
    });
    else missing('worker-close-observer-unavailable');
  }
  function attach(row) {
    if (current?.phase !== 'active' || current.rows.has(row.requestId)) return;
    if (current.rows.size >= maxRows) {current.droppedRows++; current.missing.add('window-request-row-bound'); return;}
    current.rows.set(row.requestId, row);
  }
  function metadataTask(row, operation, apply, reason) {
    if (pending.size >= maxRows * 2) {row.missing.add('metadata-promise-bound'); missing('metadata-promise-bound'); return;}
    const task = Promise.resolve().then(operation).then(value => {apply(value);}, () => {
      counts.metadataFailures++; row.missing.add(reason);
    }).catch(() => {counts.metadataFailures++; row.missing.add(reason);}).finally(() => pending.delete(task));
    pending.add(task); row.tasks.add(task);
  }
  function requestMetadata(request, requestEventObserved) {
    let method = null, urlSha256 = null, route = 'unknown', routeId = null, resourceType = null, isHTTP = null, originIndex = -1;
    let requestBytes = null, uploadOffset = null, clientHash = null, query = {keys: [], validControl: false};
    const rowMissing = new Set();
    try {
      const value = request.method();
      if (typeof value === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(value)) method = value;
      else rowMissing.add('request-method-unavailable');
    } catch {rowMissing.add('request-method-unavailable');}
    try {
      const value = request.url();
      if (typeof value !== 'string' || value.length > 16384) throw Error();
      urlSha256 = hash(value); const parsed = new URL(value); isHTTP = parsed.protocol === 'http:' || parsed.protocol === 'https:';
      originIndex = origins.indexOf(parsed.protocol + '//' + parsed.hostname + ':' + (parsed.port || (parsed.protocol === 'https:' ? '443' : '80')));
      if (originIndex < 0) rowMissing.add('request-origin-unowned');
      const classification = classifyBrowserRequestPath(parsed.pathname);
      route = classification.route; routeId = classification.id;
      query = queryMetadata(parsed, route);
      if (!query.validControl) rowMissing.add('request-query-control-unavailable');
      if (!isHTTP) {counts.nonHTTP++; rowMissing.add('non-http-request-event');}
    } catch {rowMissing.add('request-url-or-classification-unavailable');}
    try {
      const headers = request.headers();
      if (headers['x-app-client'] !== undefined) {
        const client = boundedString(headers['x-app-client'], 128);
        if (client) clientHash = hash(client); else rowMissing.add('request-client-header-unavailable');
      }
      for (const [name, limit] of [['content-length', 16], ['upload-offset', 20]]) {
        const value = headers[name];
        if (value === undefined) continue;
        if (typeof value !== 'string' || value.length > limit || !/^(0|[1-9][0-9]*)$/.test(value)) {rowMissing.add('request-length-header-invalid'); continue;}
        if (name === 'content-length') {const number = Number(value); if (Number.isSafeInteger(number)) requestBytes = number; else rowMissing.add('request-length-header-invalid');}
        else uploadOffset = value;
      }
    } catch {rowMissing.add('request-length-headers-unavailable');}
    try {resourceType = boundedString(request.resourceType(), 64); if (!resourceType) throw Error();}
    catch {rowMissing.add('resource-type-unavailable');}
    let serviceWorker = null;
    try {
      if (typeof request.serviceWorker !== 'function') throw Error();
      serviceWorker = Boolean(request.serviceWorker());
      if (serviceWorker) unsupportedReason('service-worker-request-unsupported');
    } catch {rowMissing.add('request-service-worker-origin-unknown');}
    if (!serviceWorker) {
      try {
        const frame = request.frame();
        if (frame.page() !== page) rowMissing.add('request-from-unexpected-page');
        if (frame !== page.mainFrame()) rowMissing.add('request-from-unexpected-frame');
      } catch {rowMissing.add('request-realm-unavailable');}
    }
    const metadata = commandMetadata(request, route, method, routeId);
    if (metadata.status === 'unknown') rowMissing.add('command-or-staging-metadata-unavailable');
    if (metadata.kind === 'command' && metadata.ownerStatus !== 'observed') rowMissing.add('command-owner-metadata-unavailable');
    return {requestId: ids.get(request), method, urlSha256, route, id: routeId, query, clientHash, resourceType, isHTTP, originIndex, requestBytes, uploadOffset, commandMetadata: metadata,
      requestEventObserved, requestObservedMs: requestEventObserved ? now() : null, requestSequence: requestEventObserved ? sequence : null,
      responseObservedMs: null, responseSequence: null, responseStatus: null, fromServiceWorker: null, requestServiceWorker: serviceWorker,
      terminal: null, terminalObservedMs: null, terminalSequence: null,
      responseMetadata: {status: 'not-applicable'},
      longLivedSSE: resourceType === 'eventsource', sizes: {status: 'unknown', reason: 'request-not-finished'},
      missing: rowMissing, tasks: new Set(), sizesStarted: false};
  }
  function lookup(request, source) {
    if (!object(request)) {missing('request-object-unavailable'); return null;}
    if (!ids.has(request)) ids.set(request, ++nextId);
    let row = records.get(request);
    if (records.has(request)) return row;
    if (active.size >= maxRows) {records.set(request, null); counts.droppedRequests++; missing('global-active-request-bound'); return null;}
    row = requestMetadata(request, source === 'request'); records.set(request, row);
    if (source !== 'request') {counts.orphanEvents++; row.missing.add('request-start-event-missing'); missing('request-start-event-missing');}
    active.set(row.requestId, row); attach(row);
    return row;
  }
  function requestStarted(request) {
    sequence++; counts.requests++;
    const existed = records.has(request), row = lookup(request, 'request'); if (!row) return;
    if (existed) {row.missing.add('duplicate-or-late-request-event'); missing('duplicate-or-late-request-event');}
  }
  function responseObserved(response) {
    sequence++; counts.responses++;
    const request = response.request(), row = lookup(request, 'response'); if (!row) return;
    if (row.responseObservedMs !== null) {row.missing.add('duplicate-response-event'); return;}
    row.responseObservedMs = now(); row.responseSequence = sequence;
    try {const status = response.status(); if (!Number.isSafeInteger(status) || status < 100 || status > 599) throw Error(); row.responseStatus = status;}
    catch {row.missing.add('response-status-unavailable');}
    try {const sw = response.fromServiceWorker(); if (typeof sw !== 'boolean') throw Error(); row.fromServiceWorker = sw; if (sw) unsupportedReason('service-worker-response-unsupported');}
    catch {row.missing.add('response-service-worker-origin-unknown');}
    if (typeof response.headerValue === 'function') metadataTask(row, () => response.headerValue('content-type'), value => {
      if (value !== null && typeof value !== 'string') throw Error();
      if (typeof value === 'string' && value.length <= 256 && /^text\/event-stream(?:\s*;|\s*$)/i.test(value)) row.longLivedSSE = true;
    }, 'response-content-type-unavailable');
    else row.missing.add('response-content-type-unavailable');
    if (needsResponseMetadata(row)) {
      row.responseMetadata = {status: 'unknown', reason: 'response-metadata-pending'};
      metadataTask(row, () => readControlResponse(response, row), value => {
        row.responseMetadata = value;
        if (value.status !== 'observed') row.missing.add('control-response-metadata-unavailable');
      }, 'control-response-metadata-unavailable');
    }
  }
  function terminal(request, outcome) {
    sequence++; counts[outcome === 'finished' ? 'finished' : 'failed']++;
    const row = lookup(request, outcome); if (!row) return;
    if (row.terminal !== null) {row.missing.add('duplicate-terminal-event'); return;}
    row.terminal = outcome; row.terminalObservedMs = now(); row.terminalSequence = sequence; active.delete(row.requestId);
    // No body/failure-message reads. Sizes are meaningful only as reported byte
    // counters; zero counters never establish a cache hit or absence of I/O.
    if (outcome === 'finished' && !row.sizesStarted) {
      row.sizesStarted = true; row.sizes = {status: 'unknown', reason: 'sizes-pending'};
      if (typeof request.sizes !== 'function') {row.sizes.reason = 'sizes-api-unavailable'; row.missing.add('request-sizes-unavailable'); return;}
      metadataTask(row, () => request.sizes(), value => {
        if (!value || !sizeKeys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) throw Error();
        row.sizes = {status: 'reported', values: Object.fromEntries(sizeKeys.map(key => [key, value[key]])), source: 'public-request.sizes'};
      }, 'request-sizes-unavailable');
    } else if (outcome === 'failed') row.sizes = {status: 'unknown', reason: 'request-failed'};
  }
  // Install context listeners before inventories. No filtering by resource type:
  // sendBeacon/ping/other/fetch and future HTTP resource types remain visible.
  listen(context, 'request', requestStarted); listen(context, 'response', responseObserved);
  listen(context, 'requestfinished', request => terminal(request, 'finished'));
  listen(context, 'requestfailed', request => terminal(request, 'failed'));
  listen(context, 'serviceworker', () => {counts.serviceWorkers++; unsupportedReason('service-worker-context-event-unsupported');});
  listen(context, 'page', other => {if (other !== page) {realmChange('unexpected-page-created', 'pageChanges'); missing('unexpected-page-created');}});
  listen(context, 'close', () => {contextClosed = true; missing('context-closed-before-observer');});
  listen(page, 'worker', worker => observeWorker(worker));
  listen(page, 'frameattached', () => realmChange('frame-attached-during-observation', 'frameChanges'));
  listen(page, 'framedetached', () => realmChange('frame-detached-during-observation', 'frameChanges'));
  listen(page, 'framenavigated', frame => {if (current?.phase === 'active') realmChange(frame === page.mainFrame() ? 'main-frame-navigation-during-observation' : 'child-frame-navigation-during-observation', 'frameChanges');});
  listen(page, 'close', () => missing('observed-page-closed'));
  let blankAtInstall = false, initialPages = null, initialWorkers = null, initialServiceWorkers = null;
  try {blankAtInstall = page.url() === 'about:blank'; if (!blankAtInstall) missing('observer-installed-after-navigation');} catch {missing('initial-page-url-unavailable');}
  try {const pages = context.pages(); initialPages = pages.length; if (pages.length !== 1 || pages[0] !== page) missing('unexpected-initial-page-inventory');} catch {missing('page-inventory-unavailable');}
  try {const workers = page.workers(); initialWorkers = workers.length; for (const worker of workers) observeWorker(worker, true);} catch {missing('worker-inventory-unavailable');}
  try {const workers = context.serviceWorkers(); initialServiceWorkers = workers.length; if (workers.length) unsupportedReason('existing-service-worker-unsupported');} catch {missing('service-worker-inventory-unavailable');}
  const listenerStartup = {installedMs, blankAtInstall, initialPages, initialWorkers, initialServiceWorkers,
    installedBeforeProductNavigationObserved: blankAtInstall && initialPages === 1, mode: 'passive-public-context-events'};

  function rowSnapshot(row, window) {
    const atEnd = window.endActive?.has(row.requestId) ?? active.has(row.requestId);
    return {requestId: row.requestId, method: row.method, urlSha256: row.urlSha256, route: row.route, id: row.id,
      originIndex: row.originIndex, requestBytes: row.requestBytes, uploadOffset: row.uploadOffset,
      query: copy(row.query), clientHash: row.clientHash,
      resourceType: row.resourceType, isHTTP: row.isHTTP, requestEventObserved: row.requestEventObserved,
      requestObservedMs: row.requestObservedMs, requestSequence: row.requestSequence,
      responseObservedMs: row.responseObservedMs, responseSequence: row.responseSequence, responseStatus: row.responseStatus,
      fromServiceWorker: row.fromServiceWorker, requestServiceWorker: row.requestServiceWorker,
      terminal: row.terminal, terminalObservedMs: row.terminalObservedMs, terminalSequence: row.terminalSequence,
      terminalWithinWindow: row.terminalObservedMs !== null && row.terminalObservedMs >= window.startedMs && (window.endedMs === null || row.terminalObservedMs <= window.endedMs),
      activeAtStart: window.startActive.has(row.requestId), activeAtEnd: atEnd,
      longLivedSSE: row.longLivedSSE, sizes: copy(row.sizes), commandMetadata: copy(row.commandMetadata),
      responseMetadata: copy(row.responseMetadata),
      cache: {status: 'unknown', reason: 'public-response-and-request-sizes-do-not-identify-cache-source'},
      missing: [...row.missing]};
  }
  function snapshot(window) {
    const rows = [...window.rows.values()].map(row => rowSnapshot(row, window));
    const allMissing = new Set([...window.missing, ...rows.flatMap(row => row.missing)]);
    if (window.phase !== 'ended') allMissing.add('observation-not-ended');
    if (rows.some(row => row.activeAtEnd && !row.longLivedSSE)) allMissing.add('ordinary-requests-active-at-boundary');
    if (rows.some(row => row.terminal === 'finished' && row.sizes.status !== 'reported')) allMissing.add('finished-request-sizes-unknown');
    if (rows.some(row => row.terminal === 'finished' && row.responseObservedMs === null)) allMissing.add('finished-response-event-missing');
    const recordingComplete = window.phase === 'ended' && allMissing.size === 0 && unsupported.size === 0 &&
      listenerStartup.installedBeforeProductNavigationObserved && !contextClosed;
    return {kind: 'browser-wa-requests-1', qualification: false, globalComplete: false, recordingComplete,
      scope: 'public-context-http-request-events-not-all-browser-network-or-storage',
      runtimeIdentity: copy(identity), listenerStartup: copy(listenerStartup), allowedOriginCount: origins.length,
      observation: {id: window.id, status: window.phase, startedMs: window.startedMs, endedMs: window.endedMs,
        startSequence: window.startSequence, endSequence: window.endSequence, metadataDrain: window.metadataDrain,
        maxRows, droppedRows: window.droppedRows, listenerContinuityObserved: !contextClosed,
        startWorkerCount: window.startWorkerCount, endWorkerCount: window.endWorkerCount ?? knownWorkers.size},
      globalBefore: copy(window.before), globalAfter: copy(window.after ?? counts),
      rows, activeAtStart: [...window.startActive], activeAtEnd: [...(window.endActive ?? active.keys())],
      activeSSEAtEnd: rows.filter(row => row.activeAtEnd && row.longLivedSSE).map(row => row.requestId),
      unsupported: [...unsupported], missing: [...allMissing],
      failures: [...new Set(rows.filter(row => row.commandMetadata.status === 'unexpected').map(row => row.commandMetadata.reason))],
      cacheEvidence: {status: 'unknown', noRequestObservedDoesNotEstablishCacheHit: true},
      proxyJoin: {keys: ['urlSha256', 'method'], semantics: 'counted-multiset-not-unique-request-identity', exactObjectIdentityWithinThisLedger: true}};
  }
  function selected(id) {
    if (current?.id === id) return current;
    if (previous?.id === id) return previous;
    throw Error('Unknown observation identity');
  }
  function beginObservation(id) {
    if (closed || current || !token(id) || usedWindows.has(id) || usedWindows.size >= 256) throw Error('One fresh bounded observation identity is required');
    usedWindows.add(id); previous = null;
    current = {id, phase: 'active', startedMs: now(), endedMs: null, startSequence: sequence, endSequence: null,
      rows: new Map(), startActive: new Set(active.keys()), endActive: null, before: copy(counts), after: null,
      missing: new Set(globalMissing), droppedRows: 0, startWorkerCount: knownWorkers.size, endWorkerCount: null, metadataDrain: 'not-requested', endPromise: null};
    for (const row of active.values()) attach(row);
    return snapshot(current);
  }
  function snapshotObservation(id) {const window = selected(id); return window.final ? copy(window.final) : snapshot(window);}
  async function drain(source) {
    let timer;
    const seen = new Set();
    const deadline = new Promise(resolve => {timer = setTimeout(() => resolve(false), drainTimeoutMs);});
    try {
      for (;;) {
        const tasks = (typeof source === 'function' ? source() : source).filter(task => !seen.has(task));
        if (!tasks.length) return true;
        tasks.forEach(task => seen.add(task));
        if (!await Promise.race([Promise.allSettled(tasks).then(() => true), deadline])) return false;
      }
    }
    finally {clearTimeout(timer);}
  }
  function endObservation(id) {
    const window = selected(id);
    if (window.final) return Promise.resolve(copy(window.final));
    if (window.endPromise) return window.endPromise.then(copy);
    window.phase = 'ending'; window.endedMs = now(); window.endSequence = sequence;
    window.endActive = new Set(active.keys()); window.endWorkerCount = knownWorkers.size; window.after = copy(counts);
    const tasks = () => [...new Set([...window.rows.values()].flatMap(row => [...row.tasks]))];
    window.endPromise = (async () => {
      const drained = await drain(tasks); window.metadataDrain = drained ? 'drained' : 'deadline';
      if (!drained) window.missing.add('metadata-drain-timeout');
      window.phase = 'ended'; window.final = snapshot(window);
      current = null; previous = window;
      return copy(window.final);
    })();
    return window.endPromise;
  }
  function close() {
    if (closePromise) return closePromise;
    // Detach before awaiting metadata; late browser events cannot change closure.
    for (const [target, event, handler] of subscriptions) {try {target.off(event, handler);} catch {missing('listener-detach-failed');}}
    closed = true;
    closePromise = (async () => {
      let observation = null;
      if (current) {current.missing.add('observer-closed-with-live-observation'); observation = await endObservation(current.id);}
      const drained = await drain([...pending]);
      return {kind: 'browser-wa-requests-close-1', qualification: false, globalComplete: false,
        closed: true, metadataDrain: drained ? 'drained' : 'deadline', activeRequests: active.size,
        pendingMetadata: pending.size, counts: copy(counts), observation, missing: [...globalMissing], unsupported: [...unsupported]};
    })();
    return closePromise;
  }
  return Object.freeze({beginObservation, snapshotObservation, endObservation, close});
}
