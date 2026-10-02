import '../session/no-egress.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {createBrowserWARequests} from '../../tooling/qualification/campaigns/browser-wa-requests.mjs';

// SOURCE ONLY: authored, not executed. The shared Node registry owns this real
// Chromium case (method B); no environment gates or skips substitute emitters.
// This checks the public context ledger, not H/cache/performance qualification.
const executeFile = promisify(execFile);
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function fileIdentity(path) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) {bytes += chunk.length; hash.update(chunk);}
  return {bytes, sha256: 'sha256:' + hash.digest('hex')};
}
async function registerBrowser(browserServer, executable, directory) {
  const child = browserServer.process();
  assert.ok(Number.isSafeInteger(child?.pid) && child.pid > 0);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  const first = await executeFile('/bin/ps', ['-p', String(child.pid), '-o', 'pgid=,lstart='], {timeout: 5000});
  const row = first.stdout.match(/^\s*(\d+)\s+(.+?)\s*$/);
  assert.ok(row, 'Actual owned browser birth is required');
  const second = await executeFile('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], {timeout: 5000});
  const startedAtIdentity = second.stdout.trim();
  assert.equal(startedAtIdentity, row[2]);
  const value = {kind: 'browser', pid: child.pid, pgid: Number(row[1]), startedAtIdentity, executable};
  const path = join(directory, 'owned-browser.json');
  await writeFile(path, JSON.stringify({kind: 'perf-owned-processes-1', ownerPid: process.pid, processes: [value]}), {flag: 'wx', mode: 0o600});
  return {...value, registration: {path, ...await fileIdentity(path)}};
}

test('actual pinned Chromium public requests retain object identities, beacon metadata and an open SSE boundary', {timeout: 120000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ideogram-wa-observation-'));
  let browserServer, browser, context, page, observer;
  const streams = new Set(), sockets = new Set();
  const server = createServer((request, response) => {
    request.resume();
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/') {
      response.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
      response.end('<!doctype html><title>Request observer fixture</title><link rel="icon" href="data:,">');
    } else if (pathname === '/api/v1/events/stream') {
      response.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'});
      response.write('data: fixture\n\n'); streams.add(response);
      response.on('close', () => streams.delete(response));
    } else if (pathname === '/api/v1/assets/asset_one/content') {
      response.writeHead(200, {'Content-Type': 'text/plain', 'Content-Length': '7', 'Cache-Control': 'public, max-age=3600'});
      response.end('fixture');
    } else if (pathname === '/api/v1/commands' && request.method === 'POST') {
      const bytes = Buffer.from(JSON.stringify({protocolVersion: 1, kind: 'receipt', receipt: {commandId: 'fixture_finalize',
        status: 'accepted', transactionId: 'fixture_transaction', fromSeq: '1', toSeq: '1', documentRevision: null}}));
      response.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store'});
      response.end(bytes);
    } else if (pathname === '/api/v1/commands/fixture_finalize/result') {
      const bytes = Buffer.from(JSON.stringify({protocolVersion: 1, kind: 'batches', more: false, nextCursor: '1',
        recovery: {recoveryId: 'fixture_recovery', writerEpoch: 'fixture_epoch', projectionSchema: 1, highWater: '1', expiresAt: '2100-01-01T00:00:00.000Z'},
        batches: [{kind: 'inline', transactionId: 'fixture_transaction', fromSeq: '1', toSeq: '1', events: [{schemaVersion: 1, payloadVersion: 1,
          eventId: 'fixture_event', workspaceSeq: '1', streamId: 'workspace', streamSeq: '1', documentId: null, resultingDocumentRevision: null,
          commandId: 'fixture_finalize', correlationId: 'fixture_correlation', causationId: null, transactionId: 'fixture_transaction',
          writerEpoch: 'fixture_epoch', recordedAt: '2026-10-01T00:00:00.000Z', type: 'AssetRegistered', payload: {asset: {
            id: 'asset_one', purpose: 'caption', blob: {hash: digest('fixture'), byteLength: '7', mediaType: 'text/plain'}}}}]}]}));
      response.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store'});
      response.end(bytes);
    } else if (pathname === '/beacon' && request.method === 'POST') {response.writeHead(204); response.end();}
    else if (pathname === '/hold') {
      response.writeHead(200, {'Content-Type': 'text/plain', 'Cache-Control': 'no-store'});
      response.flushHeaders(); streams.add(response); response.on('close', () => streams.delete(response));
    } else {response.writeHead(404); response.end();}
  });
  server.on('connection', socket => {sockets.add(socket); socket.once('close', () => sockets.delete(socket));});
  t.after(async () => {
    const errors = [];
    for (const cleanup of [
      () => observer?.close(), () => context?.close(), () => browser?.close(), () => browserServer?.close(),
      async () => {for (const response of streams) response.end(); for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));},
      () => rm(directory, {recursive: true, force: true}),
    ]) {try {await cleanup();} catch (error) {errors.push(error);}}
    if (errors.length) throw new AggregateError(errors, 'Observer fixture cleanup failed');
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const origin = 'http://127.0.0.1:' + server.address().port;
  const require = createRequire(import.meta.url);
  const pin = JSON.parse(await readFile(join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8')).browsers.find(row => row.name === 'chromium');
  assert.ok(pin?.revision && pin?.browserVersion, 'The installed pinned Playwright browser inventory is required');
  const executable = chromium.executablePath(), executableIdentity = await fileIdentity(executable);
  browserServer = await chromium.launchServer({headless: true, executablePath: executable, host: '127.0.0.1', timeout: 30000});
  const ownedProcess = await registerBrowser(browserServer, executable, directory);
  assert.equal(new URL(browserServer.wsEndpoint()).hostname, '127.0.0.1');
  browser = await chromium.connect(browserServer.wsEndpoint(), {timeout: 15000});
  assert.equal(browser.version(), pin.browserVersion);
  const runtime = {engine: 'chromium', version: browser.version(), revision: pin.revision, executable,
    executableIdentity, browserPid: browserServer.process().pid, ownedLaunch: {process: ownedProcess, context: {createdBy: 'browser.newContext', freshAtLaunch: true}}};
  context = await browser.newContext(); context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000);
  page = await context.newPage();
  observer = createBrowserWARequests({context, page, runtime, allowedOrigins: [origin]});
  await Promise.all([context.waitForEvent('requestfinished', {predicate: request => request.isNavigationRequest()}), page.goto(origin, {waitUntil: 'load'})]);
  const streamURL = origin + '/api/v1/events/stream?after=0';
  await Promise.all([
    context.waitForEvent('response', {predicate: response => response.url() === streamURL}),
    page.evaluate(url => new Promise((resolve, reject) => {
      const stream = new EventSource(url); window.fixtureStream = stream;
      stream.onmessage = () => resolve(true); stream.onerror = () => reject(Error('Fixture SSE failed'));
    }), streamURL),
  ]);
  const assetURL = origin + '/api/v1/assets/asset_one/content';
  async function fetchAsset() {
    await Promise.all([
      context.waitForEvent('requestfinished', {predicate: request => request.url() === assetURL}),
      page.evaluate(async url => {if (await (await fetch(url)).text() !== 'fixture') throw Error('Unexpected fixture');}, assetURL),
    ]);
  }
  await fetchAsset(); // Warm the browser naturally; install no routes/cache switches.
  observer.beginObservation('cached-public-ledger');
  await fetchAsset(); await fetchAsset();
  const cached = await observer.endObservation('cached-public-ledger');
  const assets = cached.rows.filter(row => row.urlSha256 === digest(assetURL));
  assert.equal(assets.length, 2); assert.notEqual(assets[0].requestId, assets[1].requestId);
  assert.equal(cached.rows.filter(row => row.terminal !== null).length, 2);
  for (const row of assets) {
    assert.equal(row.route, 'asset-content'); assert.equal(row.id, 'asset_one'); assert.equal(row.originIndex, 0);
    assert.equal(row.method, 'GET'); assert.equal(row.terminal, 'finished');
    assert.equal(row.fromServiceWorker, false); assert.equal(row.cache.status, 'unknown');
    assert.ok(['reported', 'unknown'].includes(row.sizes.status));
    assert.deepEqual(row.missing, row.sizes.status === 'unknown' ? ['request-sizes-unavailable'] : []);
    if (row.sizes.status === 'unknown') assert.equal(row.sizes.values, undefined);
    else for (const key of ['requestBodySize', 'requestHeadersSize', 'responseBodySize', 'responseHeadersSize'])
      assert.ok(Number.isSafeInteger(row.sizes.values?.[key]) && row.sizes.values[key] >= 0);
  }
  // Repeated requests keep their actual object identities. Public size metadata
  // may be unavailable; that remains incomplete evidence, never zero I/O or a
  // proven cache hit. The separate control window below still requires complete
  // recording of fresh HTTP requests and the existing open SSE boundary.
  const unknownAssetSizes = assets.filter(row => row.sizes.status === 'unknown').length;
  assert.equal(cached.recordingComplete, unknownAssetSizes === 0);
  assert.deepEqual([...cached.missing].sort(), unknownAssetSizes
    ? ['finished-request-sizes-unknown', 'request-sizes-unavailable'] : []);
  assert.equal(cached.qualification, false); assert.equal(cached.globalComplete, false);
  assert.equal(cached.observation.metadataDrain, 'drained');
  observer.beginObservation('public-ledger');
  const commandURL = origin + '/api/v1/commands';
  const command = {protocolVersion: 1, command: {schemaVersion: 1, commandId: 'fixture_finalize', clientId: 'fixture_client',
    sessionId: 'fixture_session', transactionId: 'fixture_transaction', documentId: null, expectedDocumentRevision: null,
    body: {type: 'FinalizeStaging', stagingId: 'fixture_stage', expectedSha256: digest('fixture')}}};
  await Promise.all([
    context.waitForEvent('requestfinished', {predicate: request => request.url() === commandURL && request.method() === 'POST'}),
    page.evaluate(async ({url, command}) => {await (await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-App-Client': 'LP-1'}, body: JSON.stringify(command)})).json();}, {url: commandURL, command}),
  ]);
  const beaconURL = origin + '/beacon';
  await Promise.all([
    context.waitForEvent('requestfinished', {predicate: request => request.url() === beaconURL && request.method() === 'POST'}),
    page.evaluate(url => {if (!navigator.sendBeacon(url, 'fixture')) throw Error('Fixture beacon rejected');}, beaconURL),
  ]);
  const resultURL = origin + '/api/v1/commands/fixture_finalize/result';
  await Promise.all([
    context.waitForEvent('requestfinished', {predicate: request => request.url() === resultURL}),
    page.evaluate(async url => {await (await fetch(url)).json();}, resultURL),
  ]);
  const result = await observer.endObservation('public-ledger');
  assert.equal(result.recordingComplete, true, JSON.stringify({missing: result.missing.slice(0, 10), rows: result.rows
    .filter(row => row.missing.length || row.terminal === 'finished' && row.sizes.status !== 'reported').slice(0, 10)
    .map(row => ({requestId: row.requestId, route: row.route, resourceType: row.resourceType, terminal: row.terminal,
      sizes: {status: row.sizes.status, reason: row.sizes.reason ?? null,
        ...Object.fromEntries(['requestBodySize', 'requestHeadersSize', 'responseBodySize', 'responseHeadersSize']
          .filter(key => typeof row.sizes.values?.[key] === 'number').map(key => [key, row.sizes.values[key]]))},
      missing: row.missing.slice(0, 10)}))}));
  assert.equal(result.qualification, false); assert.equal(result.globalComplete, false);
  assert.equal(result.listenerStartup.installedBeforeProductNavigationObserved, true);
  assert.equal(result.runtimeIdentity.browserPid, ownedProcess.pid);
  assert.equal(result.runtimeIdentity.startedAtIdentity, ownedProcess.startedAtIdentity);
  assert.equal(result.runtimeIdentity.executableSha256, executableIdentity.sha256);
  assert.equal(result.observation.metadataDrain, 'drained');
  const beacon = result.rows.find(row => row.urlSha256 === digest(beaconURL));
  assert.ok(beacon); assert.equal(beacon.method, 'POST'); assert.equal(beacon.terminal, 'finished');
  assert.ok(['ping', 'other'].includes(beacon.resourceType)); assert.equal(beacon.responseMetadata.status, 'not-applicable');
  const commandRow = result.rows.find(row => row.urlSha256 === digest(commandURL));
  assert.equal(commandRow?.route, 'command-submit'); assert.equal(commandRow.clientHash, digest('LP-1'));
  assert.equal(commandRow.commandMetadata.type, 'FinalizeStaging'); assert.equal(commandRow.commandMetadata.stagingId, 'fixture_stage');
  assert.equal(commandRow.commandMetadata.expectedSha256, digest('fixture'));
  assert.equal(commandRow.commandMetadata.ownerStatus, 'observed'); assert.equal(commandRow.commandMetadata.clientHash, digest('fixture_client'));
  assert.equal(commandRow.responseMetadata.status, 'observed'); assert.equal(commandRow.responseMetadata.receiptStatus, 'accepted');
  assert.equal(commandRow.responseMetadata.evidence, 'receipt'); assert.equal(commandRow.responseMetadata.assets, null);
  const commandResult = result.rows.find(row => row.urlSha256 === digest(resultURL));
  assert.equal(commandResult?.responseMetadata.evidence, 'inline-events');
  assert.equal(commandResult.responseMetadata.commandId, 'fixture_finalize');
  assert.deepEqual(commandResult.responseMetadata.assets, [{id: 'asset_one', purpose: 'caption', blob: {hash: digest('fixture'), byteLength: '7', mediaType: 'text/plain'}}]);
  const sse = result.rows.find(row => row.urlSha256 === digest(streamURL));
  assert.ok(sse); assert.equal(sse.route, 'events-stream'); assert.equal(sse.activeAtStart, true);
  assert.equal(sse.activeAtEnd, true); assert.equal(sse.longLivedSSE, true); assert.equal(sse.terminal, null);
  assert.deepEqual(result.activeSSEAtEnd, [sse.requestId]);
  assert.deepEqual(cached.activeSSEAtEnd, [sse.requestId]);
  assert.deepEqual(sse.query, {keys: ['after'], validControl: true});
  assert.equal(result.proxyJoin.semantics, 'counted-multiset-not-unique-request-identity');
  assert.doesNotMatch(JSON.stringify(result), /beacon=|fixture=only/);

  // A real aborted fetch retains its terminal failure and unknown bytes. The
  // browser's absent size response never becomes a zero-transfer/cache claim.
  observer.beginObservation('aborted-public-request');
  const heldURL = origin + '/hold';
  await Promise.all([
    context.waitForEvent('response', {predicate: response => response.url() === heldURL}),
    page.evaluate(url => {window.fixtureAbort = new AbortController(); window.fixtureFetch = fetch(url, {signal: window.fixtureAbort.signal}).then(response => response.text()).catch(() => null);}, heldURL),
  ]);
  await Promise.all([
    context.waitForEvent('requestfailed', {predicate: request => request.url() === heldURL}),
    page.evaluate(() => window.fixtureAbort.abort()),
  ]);
  const aborted = await observer.endObservation('aborted-public-request');
  const failure = aborted.rows.find(row => row.urlSha256 === digest(heldURL));
  assert.ok(failure); assert.equal(failure.terminal, 'failed'); assert.equal(failure.sizes.status, 'unknown');
  assert.equal(failure.cache.status, 'unknown'); assert.equal(aborted.qualification, false);
  await page.evaluate(() => window.fixtureStream.close());
  t.diagnostic(JSON.stringify({scope: 'actual-public-context-ledger-only', qualification: false, globalComplete: false,
    runtime: result.runtimeIdentity, registeredOwnedProcess: ownedProcess, executableIdentity,
    positiveWindow: {rows: result.rows.length, recordingComplete: result.recordingComplete},
    repeatedAssetWindow: {rows: cached.rows.length, recordingComplete: cached.recordingComplete, unknownAssetSizes, cacheSource: 'unknown'},
    failedRequestObserved: failure.terminal === 'failed'}));
});
