import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { normalizeBrowserOrigins, inspectBrowserProxyRequest, browserProxyLaunchOptions, inspectUndoProxyCommand, classifyBrowserRequestPath, createCachePreservingEgress } from '../../tooling/qualification/campaigns/browser-network.mjs';

const origins = () => normalizeBrowserOrigins(['http://127.0.0.1:4100', 'http://127.0.0.1:4200']);
const request = (patch = {}) => ({ method: 'GET', url: 'http://127.0.0.1:4100/assets/app.js?v=1', headers: { host: '127.0.0.1:4100' }, ...patch });
function denied(value, allowedOrigins = origins(), reason) {
  const result = inspectBrowserProxyRequest(value, allowedOrigins);
  assert.equal(result.allowed, false); assert.equal(typeof result.reason, 'string');
  assert.deepEqual(Object.keys(result).sort(), ['allowed', 'reason'], 'A refusal must not echo untrusted URL or header data');
  if (reason) assert.equal(result.reason, reason);
}

// The first section is pure validation and launch-option contracts; unsupported
// factories use throwing HTTP constructor mocks. The final transport section
// binds only ephemeral literal 127.0.0.1 servers and never launches a browser.

test('origin normalization accepts explicit literal IPv4 HTTP ports and preserves port 80', () => {
  const input = ['http://127.0.0.1:1', 'http://127.0.0.1:80', 'http://127.0.0.1:65535'];
  const normalized = normalizeBrowserOrigins(input);
  assert.deepEqual(normalized, input); assert.notEqual(normalized, input);
  normalized[0] = 'changed'; assert.equal(input[0], 'http://127.0.0.1:1');
  assert.equal(normalizeBrowserOrigins(Array.from({ length: 8 }, (_, index) => 'http://127.0.0.1:' + (4100 + index))).length, 8);
});

test('origin configuration rejects missing, duplicate, excessive or malformed allowlists', () => {
  for (const value of [undefined, null, {}, 'http://127.0.0.1:4100', [], ['http://127.0.0.1:4100', 'http://127.0.0.1:4100'], Array.from({ length: 9 }, (_, index) => 'http://127.0.0.1:' + (4100 + index))]) {
    assert.throws(() => normalizeBrowserOrigins(value), { code: 'CAMPAIGN_PREREQUISITE' });
  }
});

test('origin configuration accepts no credentials, paths, queries, fragments, schemes or hostname aliases', () => {
  for (const value of [
    null, 4100, 'http://127.0.0.1', 'http://127.0.0.1:4100/', 'http://127.0.0.1:4100/path',
    'http://127.0.0.1:4100?x=1', 'http://127.0.0.1:4100#fragment', 'http://127.0.0.1:4100#',
    'http://user:secret@127.0.0.1:4100', 'http://127.0.0.1:4100@foreign.test', 'http://foreign.test@127.0.0.1:4100',
    'https://127.0.0.1:4100', 'ws://127.0.0.1:4100', 'HTTP://127.0.0.1:4100',
    'http://localhost:4100', 'http://[::1]:4100', 'http://[::ffff:127.0.0.1]:4100', 'http://127.0.0.2:4100',
    'http://127.0.0.1.foreign.test:4100', 'http://127.1:4100', 'http://2130706433:4100',
    'http://0x7f000001:4100', 'http://0177.0.0.1:4100', 'http://%31%32%37.0.0.1:4100',
    ' http://127.0.0.1:4100', 'http://127.0.0.1:4100\n', 'http://127.0.0.1\\:4100',
  ]) assert.throws(() => normalizeBrowserOrigins([value]), { code: 'CAMPAIGN_PREREQUISITE' });
});

test('origin configuration rejects ambiguous, missing, zero and out-of-range ports', () => {
  for (const port of ['', '0', '00', '04100', '+4100', '-1', '4.1', '4e3', '65536', '999999', 'port', '4100:4200']) {
    assert.throws(() => normalizeBrowserOrigins(['http://127.0.0.1:' + port]), { code: 'CAMPAIGN_PREREQUISITE' });
  }
});

test('allowed requests bind exact origin and method while preserving ordinary path and query bytes', () => {
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const port of [4100, 4200]) {
      const path = '/assets/a%20b.png?next=http://foreign.test/&keep=%23&slash=%2F%2F';
      const result = inspectBrowserProxyRequest(request({ method, url: 'http://127.0.0.1:' + port + path, headers: { host: '127.0.0.1:' + port, cookie: 'local-session', 'x-app-client': 'LP-1' } }), origins());
      assert.deepEqual(result, { allowed: true, origin: 'http://127.0.0.1:' + port, hostname: '127.0.0.1', port, path, host: '127.0.0.1:' + port, method });
    }
  }
});

test('default HTTP port is eligible only when explicitly present in the origin allowlist', () => {
  const allowed = normalizeBrowserOrigins(['http://127.0.0.1:80']);
  for (const url of ['http://127.0.0.1/path?x=1', 'http://127.0.0.1:80/path?x=1']) {
    const value = request({ url, headers: { host: '127.0.0.1' } });
    assert.deepEqual(inspectBrowserProxyRequest(value, allowed), { allowed: true, origin: 'http://127.0.0.1:80', hostname: '127.0.0.1', port: 80, path: '/path?x=1', host: '127.0.0.1', method: 'GET' });
    denied(value, origins(), 'origin-denied');
  }
});

test('request targets cannot use other schemes, loopback aliases, userinfo or foreign origins', () => {
  for (const url of [
    'https://127.0.0.1:4100/', 'ws://127.0.0.1:4100/', 'wss://127.0.0.1:4100/', 'file:///private/file', 'data:text/plain,body',
    '//127.0.0.1:4100/', '/api/v1/documents', '*', 'http://foreign.test/', 'http://127.0.0.1.foreign.test:4100/',
    'http://localhost:4100/', 'http://[::1]:4100/', 'http://[::ffff:127.0.0.1]:4100/', 'http://127.0.0.2:4100/',
    'http://127.1:4100/', 'http://2130706433:4100/', 'http://0x7f000001:4100/', 'http://0177.0.0.1:4100/', 'http://%31%32%37.0.0.1:4100/',
    'http://127.0.0.1:4101/', 'http://127.0.0.1:4100@foreign.test/', 'http://foreign.test@127.0.0.1:4100/',
    'http://user:secret@127.0.0.1:4100/', 'http://foreign.test/?next=http://127.0.0.1:4100/',
  ]) denied(request({ url, headers: { host: '127.0.0.1:4100', origin: 'http://127.0.0.1:4100', referer: 'http://127.0.0.1:4100/' } }));
});

test('malformed URLs, fragments, control characters and backslashes fail closed', () => {
  for (const url of [
    null, undefined, 4100, '', 'not a URL', 'http://127.0.0.1:4100',
    'http://127.0.0.1:0/', 'http://127.0.0.1:65536/', 'http://127.0.0.1:port/', 'http://127.0.0.1:4100:4200/',
    'http://127.0.0.1:4100/path#fragment', 'http://127.0.0.1:4100/path#', 'http://127.0.0.1:4100/a\\b',
    ' http://127.0.0.1:4100/', 'http://127.0.0.1:4100/a b', 'http://127.0.0.1:4100/a\tb',
    'http://127.0.0.1:4100/a\r\nb', 'http://127.0.0.1:4100/a\0b', 'http://127.0.0.1:4100/a\u007fb',
  ]) denied(request({ url }));
});

test('request inspection has a fixed URL envelope and does not truncate an oversized target into an allowed one', () => {
  const prefix = 'http://127.0.0.1:4100/';
  const url = prefix + 'a'.repeat(16384 - prefix.length);
  assert.equal(inspectBrowserProxyRequest(request({ url }), origins()).allowed, true);
  denied(request({ url: url + 'a' }), origins(), 'absolute-literal-http-url-required');
});

test('the Host witness must exactly match the URL hostname and port', () => {
  for (const headers of [
    undefined, null, {}, { host: 'foreign.test' }, { host: '127.0.0.1:4200' }, { host: '127.0.0.1' },
    { host: '127.0.0.1:4100, foreign.test' }, { host: ['127.0.0.1:4100', 'foreign.test'] },
    { host: '127.0.0.1:4100 ' }, { host: '127.0.0.1:4100\r\nX-Header: injected' },
  ]) denied(request({ headers }), origins(), 'host-mismatch');
  denied(request({ url: 'http://127.0.0.1:4200/', headers: { host: '127.0.0.1:4100' } }), origins(), 'host-mismatch');
});

test('CONNECT tunnels are denied for both allowed and foreign targets before HTTP URL inspection', () => {
  for (const url of ['127.0.0.1:4100', 'foreign.test:443', 'http://127.0.0.1:4100/', undefined]) {
    denied(request({ method: 'CONNECT', url }), origins(), 'connect-tunnel-denied');
  }
});

test('upgrades and unsupported methods cannot cross the HTTP allowlist', () => {
  for (const upgrade of ['websocket', 'WebSocket', 'h2c', '', null, ['websocket']]) {
    denied(request({ headers: { host: '127.0.0.1:4100', connection: 'keep-alive, Upgrade', upgrade } }), origins(), 'upgrade-denied');
  }
  for (const method of ['TRACE', 'TRACK', 'PROPFIND', 'get', 'connect', '', undefined, null]) denied(request({ method }), origins(), 'method-denied');
  denied(null, origins(), 'method-denied');
});

test('refusal evidence contains only a fixed reason and never credential or path contents', () => {
  const result = inspectBrowserProxyRequest(request({ url: 'http://name:private-secret@127.0.0.1:4100/private-path?token=private-token' }), origins());
  assert.deepEqual(result, { allowed: false, reason: 'absolute-literal-http-url-required' });
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('request classification distinguishes adapter metadata from asset payload and staging routes using literal IDs', () => {
  const cases = [
    ['/', 'document-root', null], ['/api/v1/adapters', 'adapter-list', null],
    ['/api/v1/adapters/owned_version', 'adapter-view', 'owned_version'],
    ['/api/v1/adapters/owned_version/updates', 'adapter-updates', 'owned_version'],
    ['/api/v1/adapters/deletion-reviews/owned_review', 'adapter-deletion-review', 'owned_review'],
    ['/api/v1/assets/owned_asset', 'asset-view', 'owned_asset'],
    ['/api/v1/assets/owned_asset/content', 'asset-content', 'owned_asset'],
    ['/api/v1/assets/owned_asset/display', 'asset-display', 'owned_asset'],
    ['/api/v1/assets/owned_asset/display-tile', 'asset-display-tile', 'owned_asset'],
    ['/api/v1/assets/staging', 'asset-staging-create', null],
    ['/api/v1/assets/staging/recovery', 'asset-staging-recovery', null],
    ['/api/v1/assets/staging/owned_upload', 'asset-staging', 'owned_upload'],
    ['/api/v1/assets/staging/owned_upload/finalize', 'asset-staging-finalize', 'owned_upload'],
    ['/api/v1/commands', 'command-submit', null],
    ['/api/v1/commands/pending', 'command-inventory', null],
    ['/api/v1/commands/owned_command/result', 'command-result', 'owned_command'],
    ['/api/v1/commands/owned_command/original', 'command-original', 'owned_command'],
    ['/api/v1/ui/owned_document/request', 'ui-request', 'owned_document'],
    ['/api/v1/events', 'events', null], ['/api/v1/events/stream', 'events-stream', null],
    ['/api/v1/recovery/owned_lease/release', 'recovery-release', 'owned_lease'],
    ['/api/v1/namespace-events/owned_namespace', 'namespace-events', 'owned_namespace'],
    ['/api/v1/protocol-content/owned_content', 'protocol-content', 'owned_content'],
    ['/api/v1/snapshots/owned_snapshot', 'snapshot', 'owned_snapshot'],
    ['/api/v1/session/renew', 'session-renew', null],
  ];
  for (const [pathname, route, id] of cases) assert.deepEqual(classifyBrowserRequestPath(pathname), { route, id });
  assert.deepEqual(classifyBrowserRequestPath('/.well-known/ideogram-campaign-proxy/' + 'a'.repeat(64)), { route: 'proxy-challenge', id: null });
  assert.deepEqual(classifyBrowserRequestPath('/api/v1/adapters/' + 'a'.repeat(128)), { route: 'adapter-view', id: 'a'.repeat(128) });
});

test('request classification refuses ambiguous or encoded identities and never returns unknown private paths', () => {
  for (const pathname of [
    null, undefined, {}, 123, '', '/private-path', '/api/v1/adapters/', '/api/v1/adapters/owned_version/',
    '/api/v1/adapters/owned%5Fversion', '/api/v1/adapters/owned%2Fversion', '/api/v1/adapters/owned.version',
    '/api/v1/adapters/../private-path', '/api/v1/adapters/owned_version?private-token=secret',
    '/api/v1/adapters/owned_version#private-token', '/api/v1/adapters/' + 'a'.repeat(129),
    '/api/v1/adapters/owned_version\n', '/api/v1/documents/owned_document/events', '/' + 'a'.repeat(16384),
  ]) assert.deepEqual(classifyBrowserRequestPath(pathname), { route: 'unknown', id: null });
});

test('Chromium launch explicitly proxies loopback and configures QUIC and WebRTC UDP policy flags', () => {
  const expected = { proxy: { server: 'http://127.0.0.1:4300', bypass: '<-loopback>' }, args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] };
  assert.deepEqual(browserProxyLaunchOptions('http://127.0.0.1:4300'), expected);
  assert.deepEqual(browserProxyLaunchOptions('http://127.0.0.1:4300', 'chromium'), expected);
  assert.equal(browserProxyLaunchOptions('http://127.0.0.1:80').proxy.server, 'http://127.0.0.1:80');
  const changed = browserProxyLaunchOptions('http://127.0.0.1:4300'); changed.proxy.bypass = '*'; changed.args.push('--disable-cache');
  assert.deepEqual(browserProxyLaunchOptions('http://127.0.0.1:4300'), expected, 'One caller cannot mutate another launch configuration');
});

test('Firefox launch uses its own public loopback preferences and an empty proxy bypass list', () => {
  const expected = { proxy: { server: 'http://127.0.0.1:4300', bypass: '' }, firefoxUserPrefs: {
    'network.proxy.allow_hijacking_localhost': true,
    'network.proxy.testing_localhost_is_secure_when_hijacked': true,
  } };
  assert.deepEqual(browserProxyLaunchOptions('http://127.0.0.1:4300', 'firefox'), expected);
  const changed = browserProxyLaunchOptions('http://127.0.0.1:4300', 'firefox');
  changed.proxy.bypass = '*'; changed.firefoxUserPrefs['network.proxy.allow_hijacking_localhost'] = false;
  assert.deepEqual(browserProxyLaunchOptions('http://127.0.0.1:4300', 'firefox'), expected);
});

test('WebKit launch uses the public proxy server without Chromium bypass syntax or arguments', () => {
  const expected = { proxy: { server: 'http://127.0.0.1:4300' } };
  assert.deepEqual(browserProxyLaunchOptions('http://127.0.0.1:4300', 'webkit'), expected);
  assert.equal(browserProxyLaunchOptions('http://127.0.0.1:80', 'webkit').proxy.server, 'http://127.0.0.1:80');
  const changed = browserProxyLaunchOptions('http://127.0.0.1:4300', 'webkit'); changed.proxy.bypass = '*';
  assert.deepEqual(browserProxyLaunchOptions('http://127.0.0.1:4300', 'webkit'), expected);
});

test('launch options reject unsupported engines and any proxy outside the same exact loopback policy', () => {
  for (const engine of ['chrome', 'Chromium', 'safari', 'unknown', '', null]) {
    assert.throws(() => browserProxyLaunchOptions('http://127.0.0.1:4300', engine), { code: 'CAMPAIGN_PREREQUISITE' });
  }
  for (const origin of ['http://localhost:4300', 'https://127.0.0.1:4300', 'http://127.0.0.1:4300/', 'http://user:secret@127.0.0.1:4300', 'http://127.0.0.1:0']) {
    assert.throws(() => browserProxyLaunchOptions(origin), { code: 'CAMPAIGN_PREREQUISITE' });
  }
});

test('unsupported engines return missing-cache evidence without constructing an HTTP server or agent', async t => {
  const server = t.mock.method(http, 'createServer', () => assert.fail('Unsupported engines must not construct a proxy server'));
  const agent = t.mock.method(http, 'Agent', function () { assert.fail('Unsupported engines must not construct an upstream agent'); });
  let blockedCalls = 0;
  for (const engine of ['chrome', 'Chromium']) {
    const guard = await createCachePreservingEgress({ engine, allowedOrigins: origins(), onBlocked() { blockedCalls++; } });
    assert.equal(guard.supported, false); assert.equal(guard.origin, undefined); assert.equal(guard.launchOptions, undefined);
    const evidence = guard.evidence();
    assert.equal(evidence.kind, 'browser-proxy-egress-1'); assert.equal(evidence.engine, engine); assert.equal(evidence.supported, false); assert.equal(evidence.cachePreserved, false);
    assert.match(evidence.reason, /supported|engine|proxy|qualified/i); assert.equal(guard.cachePolicy, evidence.reason);
    evidence.cachePreserved = true; assert.equal(guard.evidence().cachePreserved, false);
    await guard.close(); await guard.close();
  }
  assert.equal(server.mock.callCount(), 0); assert.equal(agent.mock.callCount(), 0); assert.equal(blockedCalls, 0);
});

test('invalid configuration fails before constructing network services, even for unsupported engines', async t => {
  const server = t.mock.method(http, 'createServer', () => assert.fail('Invalid allowlist must not bind a server'));
  const agent = t.mock.method(http, 'Agent', function () { assert.fail('Invalid allowlist must not create an upstream agent'); });
  for (const engine of ['chromium', 'firefox']) {
    await assert.rejects(createCachePreservingEgress({ engine, allowedOrigins: ['http://foreign.test:4100'] }), { code: 'CAMPAIGN_PREREQUISITE' });
  }
  assert.equal(server.mock.callCount(), 0); assert.equal(agent.mock.callCount(), 0);
});

const undoTarget = () => ({ id: 'owned_document', revision: '7', historyHead: 'owned_head' });
const undoEnvelope = () => ({ protocolVersion: 1, command: { documentId: 'owned_document', expectedDocumentRevision: '7', body: { type: 'Undo', historyHead: 'owned_head' } } });
const undoBytes = () => Buffer.from('{  "protocolVersion": 1,\n "command": { "body": { "historyHead": "owned_head", "type": "Undo" }, "expectedDocumentRevision": "7", "documentId": "owned_document" } }\n');

test('Undo inspection admits the exact envelope without mutating or reserializing its bytes', () => {
  const bytes = undoBytes(), original = Buffer.from(bytes), expected = undoTarget();
  assert.deepEqual(inspectUndoProxyCommand(bytes, expected), { allowed: true, undo: true });
  assert.deepEqual(bytes, original); assert.deepEqual(expected, undoTarget());
  const canonical = Buffer.from(JSON.stringify(undoEnvelope()));
  assert.deepEqual(inspectUndoProxyCommand(canonical, expected), { allowed: true, undo: true });
});

test('Undo inspection binds the exact document, revision and head and rejects any second Undo', () => {
  for (const patch of [{ documentId: 'foreign_document' }, { expectedDocumentRevision: '8' }, { expectedDocumentRevision: 7 }, { body: { type: 'Undo', historyHead: 'foreign_head' } }, { documentId: undefined }, { expectedDocumentRevision: undefined }, { body: { type: 'Undo' } }]) {
    const value = undoEnvelope(); Object.assign(value.command, patch);
    assert.deepEqual(inspectUndoProxyCommand(Buffer.from(JSON.stringify(value)), undoTarget()), { allowed: false, reason: 'undo-target-or-revision-changed' });
  }
  for (const admitted of [1, 2, -1, '0', NaN]) assert.deepEqual(inspectUndoProxyCommand(undoBytes(), undoTarget(), admitted), { allowed: false, reason: 'undo-target-or-revision-changed' });
});

test('valid other commands pass through a live Undo fence without consuming its one admission', () => {
  for (const type of ['SaveCheckpoint', 'PrepareRequestSource', 'QueueInference']) {
    const bytes = Buffer.from(JSON.stringify({ protocolVersion: 1, command: { documentId: 'another_document', expectedDocumentRevision: '99', body: { type } } }));
    for (const admitted of [0, 1]) assert.deepEqual(inspectUndoProxyCommand(bytes, undoTarget(), admitted), { allowed: true, undo: false });
  }
});

test('Undo inspection refuses non-Buffer, invalid JSON and oversized command bodies', () => {
  for (const bytes of [null, undefined, '{}', Uint8Array.from(undoBytes()), Array.from(undoBytes())]) {
    assert.deepEqual(inspectUndoProxyCommand(bytes, undoTarget()), { allowed: false, reason: 'undo-command-envelope-bound' });
  }
  for (const bytes of [Buffer.alloc(0), Buffer.from('{'), Buffer.from('{"command":'), Buffer.from('not JSON')]) {
    assert.deepEqual(inspectUndoProxyCommand(bytes, undoTarget()), { allowed: false, reason: 'undo-command-envelope-invalid' });
  }
  const valid = undoBytes(), maximum = Buffer.concat([valid, Buffer.alloc(65536 - valid.length, 32)]);
  assert.deepEqual(inspectUndoProxyCommand(maximum, undoTarget()), { allowed: true, undo: true });
  assert.deepEqual(inspectUndoProxyCommand(Buffer.concat([maximum, Buffer.from(' ')]), undoTarget()), { allowed: false, reason: 'undo-command-envelope-bound' });
});

async function loopbackTransport(t, respond, options = {}) {
  const received = [], blocked = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('error', () => response.destroy());
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const entry = { method: request.method, path: request.url, headers: { ...request.headers }, bytes: Buffer.concat(chunks) };
      received.push(entry);
      if (respond) respond(entry, response);
      else { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"accepted":true}'); }
    });
  });
  let guard, closing;
  const close = () => closing ??= (async () => {
    if (guard) await guard.close();
    if (upstream.listening) await new Promise((resolve, reject) => { upstream.close(error => error ? reject(error) : resolve()); upstream.closeAllConnections(); });
    if (guard) {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(guard.evidence().closed, true); assert.equal(guard.evidence().activeConnections, 0); assert.equal(guard.evidence().activeRequests, 0);
    }
    assert.equal(upstream.listening, false);
  })();
  t.after(close);
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', () => { upstream.off('error', reject); resolve(); }); });
  const address = upstream.address(); assert.equal(address.address, '127.0.0.1');
  const origin = 'http://127.0.0.1:' + address.port;
  guard = await createCachePreservingEgress({ engine: options.engine ?? 'chromium', allowedOrigins: [origin], onBlocked(event) { blocked.push(event); } });
  return { origin, guard, received, blocked, close };
}

function proxyRequest(guard, target, { method = 'GET', body, headers = {} } = {}) {
  const proxy = new URL(guard.origin), destination = new URL(target);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', family: 4, port: Number(proxy.port), path: target, method, agent: false, headers: { host: destination.host, ...(body ? { 'content-length': String(body.length) } : {}), ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: { ...response.headers }, bytes: Buffer.concat(chunks) }));
    });
    outgoing.once('error', reject); outgoing.setTimeout(2000, () => outgoing.destroy(Error('Loopback proxy response timeout'))); outgoing.end(body);
  });
}

function proxyConnect(guard, target) {
  const proxy = new URL(guard.origin);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', family: 4, port: Number(proxy.port), path: target, method: 'CONNECT', agent: false, headers: { host: target } });
    outgoing.once('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    outgoing.once('response', response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    outgoing.once('error', reject); outgoing.setTimeout(2000, () => outgoing.destroy(Error('Loopback CONNECT response timeout'))); outgoing.end();
  });
}

// This adapter exercises only the challenge's public Playwright-shaped contract
// over the real loopback proxy. It is deliberately not a browser or proof of any
// engine's launch behavior, HTTP cache hits, or startup network coverage.
function challengePage(guard, options = {}) {
  const state = { currentUrl: options.initialUrl ?? 'about:blank', navigations: [], responses: [] };
  const page = {
    url: () => state.currentUrl,
    async goto(url, navigationOptions) {
      assert.deepEqual(navigationOptions, { waitUntil: 'domcontentloaded', timeout: 10000 });
      state.navigations.push(url);
      if (url === 'about:blank') {
        if (options.blankError) throw options.blankError;
        if (!options.leaveNonblank) state.currentUrl = 'about:blank';
        return null;
      }
      await options.beforeRequest?.(url);
      const reply = options.bypass
        ? { status: 200, headers: { 'cache-control': 'no-store', 'content-length': '64', 'x-ideogram-proxy-challenge': '0'.repeat(64) }, bytes: Buffer.from('0'.repeat(64)) }
        : await proxyRequest(guard, url);
      state.responses.push({ url, ...reply });
      state.currentUrl = options.pageUrl ? options.pageUrl(url) : url;
      await options.afterResponse?.(url, reply);
      const response = {
        headers: () => ({ ...reply.headers }), status: () => reply.status, url: () => url,
        request: () => ({ method: () => 'GET' }), fromServiceWorker: () => false,
        text: async () => reply.bytes.toString('utf8'),
      };
      return options.response ? options.response(response, reply, url) : response;
    },
  };
  return { page, state };
}

const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');

async function terminalObservation(guard, id) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const value = guard.snapshotObservation(id);
    if (value.after.activeRequestCount === 0) return value;
    assert(Date.now() < deadline, 'Actual loopback requests must reach their terminal events');
    await new Promise(resolve => setImmediate(resolve));
  }
}

for (const engine of ['chromium', 'firefox', 'webkit']) test(engine + ' proxy challenge contract requires its own observed nonce and restores a blank page', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t, undefined, { engine });
  assert.deepEqual(fixture.guard.launchOptions, browserProxyLaunchOptions(fixture.guard.origin, engine));
  assert.equal(fixture.guard.evidence().cachePreserved, false); assert.equal(fixture.guard.evidence().loopbackBypassDisabled, false);
  assert.deepEqual(fixture.guard.evidence().routeVerification, { required: true, verified: false, totalAttempts: 0, completed: 0, failed: 0, inProgress: false });
  const { page, state } = challengePage(fixture.guard), proof = await fixture.guard.verifyBrowserRoute(page);
  const served = state.responses[0];
  assert.equal(served.status, 200); assert.equal(served.headers['cache-control'], 'no-store'); assert.equal(served.headers['content-length'], '64');
  assert.equal(served.headers['x-ideogram-proxy-challenge'], served.bytes.toString('utf8'));
  assert.match(served.url, new RegExp('^' + fixture.origin.replaceAll('.', '\\.') + '/\\.well-known/ideogram-campaign-proxy/[a-f0-9]{64}$'));
  assert.deepEqual(proof, { kind: 'browser-proxy-route-challenge-1', engine, originIndex: 0, observedMs: proof.observedMs, requestHash: digest(served.url), responseHash: digest(served.bytes), cacheDisabled: false, upstreamForwarded: false });
  assert(Number.isFinite(proof.observedMs)); assert.deepEqual(state.navigations, [served.url, 'about:blank']); assert.equal(page.url(), 'about:blank');
  assert.deepEqual(fixture.received, []); assert.equal(fixture.guard.evidence().counts.accepted, 0); assert.equal(fixture.guard.evidence().counts.challengesServed, 1);
  const evidence = fixture.guard.evidence();
  assert.equal(evidence.cachePreserved, true); assert.equal(evidence.loopbackBypassDisabled, true);
  assert.deepEqual(evidence.routeVerification, { required: true, verified: true, totalAttempts: 1, completed: 1, failed: 0, inProgress: false });
  assert.equal(JSON.stringify(evidence).includes(served.url), false); assert.equal(JSON.stringify(evidence).includes(served.bytes.toString('utf8')), false);
  evidence.routeVerification.verified = false; assert.equal(fixture.guard.evidence().routeVerification.verified, true);
});

test('route verification rejects invalid pages or foreign origins before navigation or counting an attempt', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t);
  let navigations = 0;
  const goto = async () => { navigations++; assert.fail('Invalid challenge input must not navigate'); };
  for (const page of [null, {}, { goto }, { url: () => 'about:blank' }, { goto, url: () => fixture.origin + '/editor' }, { goto, url: () => 'about:blank#changed' }]) {
    await assert.rejects(fixture.guard.verifyBrowserRoute(page), { code: 'CAMPAIGN_PREREQUISITE' });
  }
  for (const origin of ['http://foreign.invalid:4100', fixture.origin + '/', fixture.origin.replace('127.0.0.1', 'localhost')]) {
    await assert.rejects(fixture.guard.verifyBrowserRoute({ goto, url: () => 'about:blank' }, { origin }), { code: 'CAMPAIGN_PREREQUISITE' });
  }
  assert.equal(navigations, 0); assert.equal(fixture.guard.evidence().routeVerification.totalAttempts, 0); assert.equal(fixture.guard.evidence().counts.challengesServed, 0); assert.deepEqual(fixture.received, []);
});

test('an aborted challenge preserves its reason before navigation and after a real proxy response', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t), before = new AbortController(), beforeReason = Error('cancel before challenge'); before.abort(beforeReason);
  const untouched = challengePage(fixture.guard);
  await assert.rejects(fixture.guard.verifyBrowserRoute(untouched.page, { signal: before.signal }), error => error === beforeReason);
  assert.deepEqual(untouched.state.navigations, []); assert.equal(fixture.guard.evidence().routeVerification.totalAttempts, 0);
  const during = new AbortController(), duringReason = Error('cancel after response');
  const active = challengePage(fixture.guard, { afterResponse() { during.abort(duringReason); } });
  await assert.rejects(fixture.guard.verifyBrowserRoute(active.page, { signal: during.signal }), error => error === duringReason);
  assert.equal(active.state.navigations.length, 1); assert.equal(fixture.guard.evidence().routeVerification.failed, 1); assert.equal(fixture.guard.evidence().routeVerification.inProgress, false); assert.equal(fixture.guard.evidence().cachePreserved, false);
});

test('a plausible response that bypassed the proxy cannot supply a route proof', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t), { page, state } = challengePage(fixture.guard, { bypass: true });
  await assert.rejects(fixture.guard.verifyBrowserRoute(page), { code: 'CAMPAIGN_PREREQUISITE' });
  assert.equal(state.navigations.length, 1); assert.deepEqual(fixture.received, []);
  assert.equal(fixture.guard.evidence().counts.challengesServed, 0); assert.equal(fixture.guard.evidence().cachePreserved, false);
  assert.deepEqual(fixture.guard.evidence().routeVerification, { required: true, verified: false, totalAttempts: 1, completed: 0, failed: 1, inProgress: false });
});

test('a served challenge still rejects changed response, method, service-worker, header, body or page witnesses', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t);
  const variants = [
    { response: response => ({ ...response, status: () => 201 }) },
    { response: (response, _reply, url) => ({ ...response, url: () => url + '?redirected' }) },
    { response: response => ({ ...response, request: () => ({ method: () => 'POST' }) }) },
    { response: response => ({ ...response, fromServiceWorker: () => true }) },
    { response: response => ({ ...response, headers: () => ({ ...response.headers(), 'cache-control': 'max-age=3600' }) }) },
    { response: response => ({ ...response, headers: () => ({ ...response.headers(), 'x-ideogram-proxy-challenge': 'wrong-nonce' }) }) },
    { response: response => ({ ...response, headers: () => ({ ...response.headers(), 'content-length': '63' }) }) },
    { response: response => ({ ...response, text: async () => 'wrong-private-body' }) },
    { pageUrl: url => url + '#changed' },
  ];
  for (const options of variants) {
    const { page, state } = challengePage(fixture.guard, options);
    await assert.rejects(fixture.guard.verifyBrowserRoute(page), { code: 'CAMPAIGN_PREREQUISITE' });
    assert.equal(state.navigations.length, 1, 'Failed verification must not imply that the page was safely reset');
    assert.equal(fixture.guard.evidence().routeVerification.inProgress, false); assert.equal(fixture.guard.evidence().cachePreserved, false);
  }
  assert.deepEqual(fixture.received, []); assert.equal(fixture.guard.evidence().counts.challengesServed, variants.length);
  assert.equal(fixture.guard.evidence().routeVerification.completed, 0); assert.equal(fixture.guard.evidence().routeVerification.failed, variants.length);
});

test('challenge proof requires successful cleanup navigation and sanitizes raw navigation failures', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t);
  for (const options of [{ leaveNonblank: true }, { blankError: Error('private browser URL or nonce must not escape') }]) {
    const { page } = challengePage(fixture.guard, options);
    await assert.rejects(fixture.guard.verifyBrowserRoute(page), error => {
      assert.equal(error.code, 'CAMPAIGN_PREREQUISITE'); assert.equal(error.message.includes('private browser URL or nonce'), false); return true;
    });
    assert.equal(fixture.guard.evidence().cachePreserved, false); assert.equal(fixture.guard.evidence().routeVerification.completed, 0);
  }
  const failing = challengePage(fixture.guard, { beforeRequest(url) { throw Error('Navigation failed at ' + url); } });
  await assert.rejects(fixture.guard.verifyBrowserRoute(failing.page), error => {
    assert.equal(error.code, 'CAMPAIGN_PREREQUISITE'); assert.equal(error.message.includes(fixture.origin), false); assert.equal(error.message.includes('/.well-known/'), false); return true;
  });
  assert.equal(fixture.guard.evidence().routeVerification.failed, 3); assert.equal(fixture.guard.evidence().routeVerification.inProgress, false);
});

test('an earlier successful page cannot mask a later page that bypasses the proxy', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t), first = challengePage(fixture.guard);
  await fixture.guard.verifyBrowserRoute(first.page); assert.equal(fixture.guard.evidence().cachePreserved, true);
  const second = challengePage(fixture.guard, { bypass: true });
  await assert.rejects(fixture.guard.verifyBrowserRoute(second.page), { code: 'CAMPAIGN_PREREQUISITE' });
  assert.equal(fixture.guard.evidence().cachePreserved, false); assert.equal(fixture.guard.evidence().loopbackBypassDisabled, false);
  assert.deepEqual(fixture.guard.evidence().routeVerification, { required: true, verified: false, totalAttempts: 2, completed: 1, failed: 1, inProgress: false });
});

test('challenge requests reject wrong methods, altered paths, duplicates and expired nonces without forwarding upstream', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t), replies = [];
  const { page, state } = challengePage(fixture.guard, {
    async beforeRequest(url) {
      replies.push(await proxyRequest(fixture.guard, url, { method: 'POST' }));
      replies.push(await proxyRequest(fixture.guard, url + '?altered=1'));
    },
    async afterResponse(url) { replies.push(await proxyRequest(fixture.guard, url)); },
  });
  await fixture.guard.verifyBrowserRoute(page);
  replies.push(await proxyRequest(fixture.guard, state.responses[0].url));
  assert.deepEqual(replies.map(reply => reply.status), [403, 403, 403, 403]); assert.deepEqual(fixture.received, []);
  assert.equal(fixture.guard.evidence().counts.challengesServed, 1); assert.equal(fixture.guard.evidence().counts.blocked, 4); assert.equal(fixture.guard.evidence().counts.accepted, 0);
  assert(fixture.blocked.every(event => event.reason === 'route-challenge-not-active'));
});

test('a guard permits only one active route challenge and releases that slot after completion', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const first = challengePage(fixture.guard, { async beforeRequest() { enter(); await held; } });
  const pending = fixture.guard.verifyBrowserRoute(first.page); pending.catch(() => {});
  await entered; assert.equal(fixture.guard.evidence().routeVerification.inProgress, true);
  const second = challengePage(fixture.guard);
  try { await assert.rejects(fixture.guard.verifyBrowserRoute(second.page), { code: 'CAMPAIGN_PREREQUISITE' }); assert.deepEqual(second.state.navigations, []); }
  finally { release(); }
  await pending; assert.equal(fixture.guard.evidence().routeVerification.totalAttempts, 1);
  await fixture.guard.verifyBrowserRoute(second.page); assert.equal(fixture.guard.evidence().routeVerification.completed, 2); assert.equal(fixture.guard.evidence().routeVerification.inProgress, false);
});

test('route challenge attempts are bounded at 64 even when every page bypasses the proxy', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t);
  for (let index = 0; index < 64; index++) {
    await assert.rejects(fixture.guard.verifyBrowserRoute(challengePage(fixture.guard, { bypass: true }).page), { code: 'CAMPAIGN_PREREQUISITE' });
  }
  const excess = challengePage(fixture.guard, { bypass: true });
  await assert.rejects(fixture.guard.verifyBrowserRoute(excess.page), { code: 'CAMPAIGN_PREREQUISITE' });
  assert.deepEqual(excess.state.navigations, []); assert.deepEqual(fixture.received, []); assert.equal(fixture.guard.evidence().counts.challengesServed, 0);
  assert.deepEqual(fixture.guard.evidence().routeVerification, { required: true, verified: false, totalAttempts: 64, completed: 0, failed: 64, inProgress: false });
});

test('loopback proxy preserves original request bytes and response cache headers without caching upstream responses', { timeout: 10000 }, async t => {
  const payload = Buffer.from([0, 255, 1, 128, 13, 10, 42]), responseBody = Buffer.from([255, 0, 17, 10, 100]);
  const fixture = await loopbackTransport(t, (_entry, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=3600', etag: '"fixture-etag"', connection: 'x-private-response', 'x-private-response': 'remove-before-forwarding' }); response.end(responseBody);
  });
  const reply = await proxyRequest(fixture.guard, fixture.origin + '/api/v1/assets/raw?preserve=%2F', { method: 'POST', body: payload, headers: { connection: 'x-private-request, close', 'x-private-request': 'remove-before-forwarding', 'content-type': 'application/octet-stream' } });
  assert.equal(reply.status, 200); assert.deepEqual(reply.bytes, responseBody); assert.equal(reply.headers['cache-control'], 'public, max-age=3600'); assert.equal(reply.headers.etag, '"fixture-etag"'); assert.equal(reply.headers['x-private-response'], undefined);
  assert.equal(fixture.received.length, 1); assert.deepEqual(fixture.received[0].bytes, payload); assert.equal(fixture.received[0].path, '/api/v1/assets/raw?preserve=%2F'); assert.equal(fixture.received[0].headers['x-private-request'], undefined);
  const again = await proxyRequest(fixture.guard, fixture.origin + '/api/v1/assets/raw?preserve=%2F', { method: 'POST', body: payload });
  assert.deepEqual(again.bytes, responseBody); assert.equal(fixture.received.length, 2); assert.equal(fixture.guard.evidence().counts.accepted, 2); assert.equal(fixture.guard.evidence().counts.blocked, 0);
  await fixture.close(); await fixture.close();
});

test('loopback proxy denies foreign HTTP and CONNECT targets before opening an upstream request', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t);
  const reply = await proxyRequest(fixture.guard, 'http://foreign.invalid/private-path?secret=never-forward');
  assert.equal(reply.status, 403); assert.equal(reply.headers['cache-control'], 'no-store');
  for (const target of [new URL(fixture.origin).host, 'foreign.invalid:443']) assert.equal(await proxyConnect(fixture.guard, target), 403);
  assert.deepEqual(fixture.received, []); assert.equal(fixture.blocked.length, 3);
  assert.equal(fixture.guard.evidence().counts.accepted, 0); assert.equal(fixture.guard.evidence().counts.blocked, 3);
  assert(fixture.blocked.every(event => /^sha256:[a-f0-9]{64}$/.test(event.requestHash))); assert.equal(JSON.stringify(fixture.guard.evidence()).includes('never-forward'), false);
});

test('loopback Undo fence forwards the exact original bytes and does not count unrelated commands as Undo', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t), bytes = undoBytes(), original = Buffer.from(bytes);
  const other = Buffer.from('{ "command": { "body": { "type": "SaveCheckpoint" } } }');
  const reply = await fixture.guard.withUndoFence(undoTarget(), async () => {
    assert.equal((await proxyRequest(fixture.guard, fixture.origin + '/api/v1/commands', { method: 'POST', body: other })).status, 200);
    return proxyRequest(fixture.guard, fixture.origin + '/api/v1/commands?receipt=1', { method: 'POST', body: bytes, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(reply.status, 200); assert.equal(fixture.received.length, 2); assert.deepEqual(fixture.received[0].bytes, other); assert.deepEqual(fixture.received[1].bytes, original); assert.deepEqual(bytes, original);
  const events = fixture.guard.evidence().events;
  assert.deepEqual(events.filter(event => event.kind === 'undo-fence-admitted').map(event => event.unchangedBytes), [true]);
  assert.deepEqual(events.filter(event => event.kind === 'undo-fence-completed').map(event => [event.admitted, event.cacheDisabled]), [[1, false]]);
});

test('loopback Undo fence rejects changed targets and duplicate Undo before forwarding those requests', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t);
  for (const patch of [{ documentId: 'foreign_document' }, { expectedDocumentRevision: '8' }, { body: { type: 'Undo', historyHead: 'concurrent_head' } }]) {
    const envelope = undoEnvelope(); Object.assign(envelope.command, patch); let reply;
    await assert.rejects(fixture.guard.withUndoFence(undoTarget(), () => { reply = proxyRequest(fixture.guard, fixture.origin + '/api/v1/commands', { method: 'POST', body: Buffer.from(JSON.stringify(envelope)) }); return reply; }), { code: 'CAMPAIGN_PREREQUISITE' });
    assert.equal((await reply).status, 403); assert.equal(fixture.received.length, 0);
  }
  let duplicate;
  await assert.rejects(fixture.guard.withUndoFence(undoTarget(), async () => {
    assert.equal((await proxyRequest(fixture.guard, fixture.origin + '/api/v1/commands', { method: 'POST', body: undoBytes() })).status, 200);
    duplicate = proxyRequest(fixture.guard, fixture.origin + '/api/v1/commands', { method: 'POST', body: undoBytes() }); return duplicate;
  }), { code: 'CAMPAIGN_PREREQUISITE' });
  assert.equal((await duplicate).status, 403); assert.equal(fixture.received.length, 1);
  assert.deepEqual(fixture.received[0].bytes, undoBytes()); assert.equal(fixture.guard.evidence().counts.blocked, 4);
});

test('observation retains real GET and PUT outcomes without changing bytes or exposing URL, header or body secrets', { timeout: 10000 }, async t => {
  const body = Buffer.from('private-request-body\0\xff'), replyBody = Buffer.from('private-response-body\0\xfe');
  const fixture = await loopbackTransport(t, (_entry, response) => {
    response.writeHead(202, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=3600', etag: '"private-response-etag"' });
    response.end(replyBody);
  });
  const proof = await fixture.guard.verifyBrowserRoute(challengePage(fixture.guard).page);
  const initial = fixture.guard.beginObservation('owned-adapter-cycle');
  assert.equal(initial.kind, 'browser-proxy-observation-1'); assert.equal(initial.id, 'owned-adapter-cycle'); assert.equal(initial.ended, false);
  assert.equal(initial.requestLimit, 4096); assert.equal(initial.recordingComplete, true); assert.equal(initial.terminalComplete, true);
  assert.deepEqual(initial.requests, []); assert.equal(initial.before.activeRequestCount, 0); assert.deepEqual(initial.before.activeRequests, []);
  assert.equal(initial.before.routeVerification.verified, true); assert.deepEqual(initial.before.routeChallenge, proof);
  assert.equal(initial.before.pid, process.pid); assert(Number.isFinite(initial.before.startedMs));
  assert.equal(typeof initial.before.proxyInstanceId, 'string'); assert(initial.before.proxyInstanceId.length > 0);
  assert.deepEqual(initial.before.allowedOrigins, [fixture.origin]); assert.equal(initial.before.proxyOrigin, fixture.guard.origin);
  const targets = [fixture.origin + '/api/v1/adapters/owned_version?private-query=one', fixture.origin + '/api/v1/assets/staging/owned_upload?private-query=two'];
  for (const [index, method] of ['GET', 'PUT'].entries()) {
    const reply = await proxyRequest(fixture.guard, targets[index], { method, ...(method === 'PUT' ? { body } : {}), headers: { ...(method === 'PUT' ? { 'Upload-Offset': '1048576' } : {}), 'x-private-request': 'private-header-value', cookie: 'private-cookie-value' } });
    assert.equal(reply.status, 202); assert.deepEqual(reply.bytes, replyBody);
    assert.equal(reply.headers['cache-control'], 'public, max-age=3600'); assert.equal(reply.headers.etag, '"private-response-etag"');
  }
  await terminalObservation(fixture.guard, initial.id);
  const result = fixture.guard.endObservation(initial.id);
  assert.equal(result.ended, true); assert.equal(result.recordingComplete, true); assert.equal(result.terminalComplete, true);
  assert.equal(result.droppedRequests, 0); assert.equal(result.observerErrors, 0); assert.equal(result.requests.length, 2);
  assert.deepEqual(result.before, initial.before); assert.equal(result.after.proxyInstanceId, initial.before.proxyInstanceId);
  assert.equal(result.after.originGeneration, initial.before.originGeneration); assert.equal(result.after.closed, false);
  assert.equal(result.after.activeRequestCount, 0); assert.deepEqual(result.after.activeRequests, []);
  assert.equal(new Set(result.requests.map(entry => entry.requestId)).size, 2);
  for (const [index, entry] of result.requests.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), ['blocked', 'carriedIn', 'forwardedMs', 'id', 'method', 'originIndex', 'receivedMs', 'requestBytes', 'requestId', 'response', 'route', 'terminal', 'uploadOffset', 'urlComplete', 'urlSha256']);
    assert.equal(entry.method, ['GET', 'PUT'][index]); assert.equal(entry.urlSha256, digest(targets[index])); assert.equal(entry.urlComplete, true);
    assert.equal(entry.originIndex, 0); assert.equal(entry.route, ['adapter-view', 'asset-staging'][index]); assert.equal(entry.id, ['owned_version', 'owned_upload'][index]); assert.equal(entry.carriedIn, false);
    assert.equal(entry.requestBytes, index === 0 ? null : body.length); assert.equal(entry.uploadOffset, index === 0 ? null : '1048576');
    assert(Number.isFinite(entry.receivedMs)); assert(Number.isFinite(entry.forwardedMs)); assert(entry.forwardedMs >= entry.receivedMs);
    assert.equal(entry.blocked, null); assert.equal(entry.response.status, 202); assert(Number.isFinite(entry.response.observedMs));
    assert.equal(entry.terminal.outcome, 'finished'); assert(entry.terminal.observedMs >= entry.receivedMs);
  }
  assert.deepEqual(fixture.received.map(entry => entry.method), ['GET', 'PUT']);
  assert.deepEqual(fixture.received[0].bytes, Buffer.alloc(0)); assert.deepEqual(fixture.received[1].bytes, body);
  assert.equal(fixture.received[1].path, '/api/v1/assets/staging/owned_upload?private-query=two');
  assert.equal(fixture.received[0].headers['content-length'], undefined); assert.equal(fixture.received[0].headers['upload-offset'], undefined);
  assert.equal(fixture.received[1].headers['content-length'], String(body.length)); assert.equal(fixture.received[1].headers['upload-offset'], '1048576');
  assert.equal(fixture.received[1].headers['x-private-request'], 'private-header-value'); assert.equal(fixture.received[1].headers.cookie, 'private-cookie-value');
  const serialized = JSON.stringify(result);
  for (const secret of ['private-query', 'private-request-body', 'private-response-body', 'private-response-etag', 'private-header-value', 'private-cookie-value', '/api/v1/adapters/']) assert.equal(serialized.includes(secret), false);
});

test('observation retains only one canonical numeric upload offset from actual loopback headers', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t), body = Buffer.from('private-upload-body');
  const offsets = ['private-upload-secret', '0007', '-1', '+1', '1e3', '1'.repeat(21), ['1048576', 'private-upload-secret'], ['1048576', '1048576'], '0', '9'.repeat(20)];
  fixture.guard.beginObservation('upload-header-retention');
  for (const value of offsets) {
    const reply = await proxyRequest(fixture.guard, fixture.origin + '/api/v1/assets/staging/owned_upload', { method: 'PUT', body, headers: { 'Upload-Offset': value } });
    assert.equal(reply.status, 200);
  }
  await terminalObservation(fixture.guard, 'upload-header-retention');
  const result = fixture.guard.endObservation('upload-header-retention');
  assert.equal(result.recordingComplete, true); assert.equal(result.terminalComplete, true); assert.equal(result.requests.length, offsets.length);
  assert.deepEqual(result.requests.map(entry => entry.uploadOffset), [null, null, null, null, null, null, null, null, '0', '9'.repeat(20)]);
  for (const entry of result.requests) {
    assert.equal(entry.requestBytes, body.length); assert.equal(entry.route, 'asset-staging'); assert.equal(entry.id, 'owned_upload');
    assert.equal(entry.response.status, 200); assert.equal(entry.terminal.outcome, 'finished');
  }
  assert.equal(fixture.received.length, offsets.length);
  for (const [index, entry] of fixture.received.entries()) {
    assert.deepEqual(entry.bytes, body);
    assert.equal(entry.headers['upload-offset'], Array.isArray(offsets[index]) ? offsets[index].join(', ') : offsets[index]);
  }
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('private-upload-secret'), false); assert.equal(serialized.includes('private-upload-body'), false);
});

test('observation retains real denied HTTP and CONNECT status and terminal evidence without opening upstream requests', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t);
  fixture.guard.beginObservation('denied-transports');
  const target = 'http://foreign.invalid/private-external-path?private-token=secret';
  assert.equal((await proxyRequest(fixture.guard, target)).status, 403);
  assert.equal(await proxyConnect(fixture.guard, 'foreign.invalid:443'), 403);
  await terminalObservation(fixture.guard, 'denied-transports');
  const result = fixture.guard.endObservation('denied-transports');
  assert.equal(result.recordingComplete, true); assert.equal(result.terminalComplete, true); assert.equal(result.requests.length, 2);
  assert.deepEqual(fixture.received, []); assert.equal(fixture.blocked.length, 2);
  assert.deepEqual(result.requests.map(entry => entry.method), ['GET', 'CONNECT']);
  assert.deepEqual(result.requests.map(entry => entry.blocked.reason), ['absolute-literal-http-url-required', 'connect-tunnel-denied']);
  assert.deepEqual(result.requests.map(entry => entry.response.status), [403, 403]);
  assert.deepEqual(result.requests.map(entry => entry.forwardedMs), [null, null]);
  assert.deepEqual(result.requests.map(entry => entry.terminal.outcome), ['finished', 'socket-closed']);
  assert.equal(result.requests[0].urlSha256, digest(target)); assert.equal(result.requests[1].urlSha256, digest('foreign.invalid:443'));
  for (const entry of result.requests) {
    assert.equal(entry.originIndex, -1); assert.equal(entry.route, 'unknown'); assert.equal(entry.id, null); assert.equal(entry.carriedIn, false); assert(Number.isFinite(entry.blocked.observedMs));
    assert(Number.isFinite(entry.response.observedMs)); assert(Number.isFinite(entry.terminal.observedMs));
  }
  const serialized = JSON.stringify(result);
  for (const secret of ['foreign.invalid', 'private-external-path', 'private-token', 'secret']) assert.equal(serialized.includes(secret), false);
});

test('observation snapshots are detached and require the exact single live window identity', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t);
  const proof = await fixture.guard.verifyBrowserRoute(challengePage(fixture.guard).page);
  for (const id of ['', 'private/window', 'private window', 'private-window\n', 'x'.repeat(129), null, undefined, 123, true, ['window']]) assert.throws(() => fixture.guard.beginObservation(id), { code: 'CAMPAIGN_PREREQUISITE' });
  assert.throws(() => fixture.guard.snapshotObservation('no-open-window'), { code: 'CAMPAIGN_PREREQUISITE' });
  assert.throws(() => fixture.guard.endObservation('no-open-window'), { code: 'CAMPAIGN_PREREQUISITE' });
  const first = fixture.guard.beginObservation('window-first');
  assert.throws(() => fixture.guard.beginObservation('window-overlap'), { code: 'CAMPAIGN_PREREQUISITE' });
  assert.throws(() => fixture.guard.snapshotObservation('window-other'), { code: 'CAMPAIGN_PREREQUISITE' });
  assert.throws(() => fixture.guard.endObservation('window-other'), { code: 'CAMPAIGN_PREREQUISITE' });
  first.before.allowedOrigins.push('http://127.0.0.1:1'); first.after.allowedOrigins.length = 0;
  first.before.routeVerification.verified = false; first.after.routeChallenge.requestHash = 'changed';
  first.requests.push({ requestId: 'invented' });
  assert.equal((await proxyRequest(fixture.guard, fixture.origin + '/api/v1/adapters/owned_version')).status, 200);
  const second = await terminalObservation(fixture.guard, 'window-first');
  assert.deepEqual(second.before.allowedOrigins, [fixture.origin]); assert.deepEqual(second.after.allowedOrigins, [fixture.origin]);
  assert.equal(second.before.routeVerification.verified, true); assert.deepEqual(second.after.routeChallenge, proof);
  assert.equal(second.requests.length, 1); assert.equal(second.requests[0].response.status, 200);
  second.requests[0].response.status = 599; second.requests[0].terminal.outcome = 'invented'; second.requests[0].id = 'invented';
  second.after.routeVerification.completed = 999; second.before.routeChallenge.responseHash = 'changed';
  const ended = fixture.guard.endObservation('window-first');
  assert.equal(ended.requests[0].response.status, 200); assert.equal(ended.requests[0].terminal.outcome, 'finished'); assert.equal(ended.requests[0].id, 'owned_version');
  assert.equal(ended.after.routeVerification.completed, 1); assert.deepEqual(ended.before.routeChallenge, proof);
  const next = fixture.guard.beginObservation('window-next');
  assert.equal(next.windowOrdinal, ended.windowOrdinal + 1); assert.deepEqual(next.requests, []); assert.equal(next.before.activeRequestCount, 0);
  fixture.guard.endObservation('window-next');
  assert.equal(ended.requests.length, 1, 'A later observation must not change an already returned snapshot');
});

test('a finite observation carries a real in-flight response and reports its unfinished terminal state', { timeout: 10000 }, async t => {
  let announce, finish;
  const streaming = new Promise(resolve => { announce = resolve; });
  const fixture = await loopbackTransport(t, (_entry, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }); response.write('first-');
    finish = () => response.end('last'); announce();
  });
  const target = fixture.origin + '/api/v1/adapters/owned_version';
  const pending = proxyRequest(fixture.guard, target); pending.catch(() => {});
  await streaming;
  const opened = fixture.guard.beginObservation('carry-in');
  assert.equal(opened.before.activeRequestCount, 1); assert.equal(opened.before.activeRequests.length, 1);
  assert.equal(opened.requests.length, 1); assert.equal(opened.requests[0].carriedIn, true); assert.equal(opened.requests[0].urlSha256, digest(target));
  assert.equal(opened.requests[0].terminal, null); assert.equal(opened.terminalComplete, false);
  const ended = fixture.guard.endObservation('carry-in');
  assert.equal(ended.ended, true); assert.equal(ended.recordingComplete, true); assert.equal(ended.terminalComplete, false);
  assert.equal(ended.after.activeRequestCount, 1); assert.equal(ended.requests[0].terminal, null);
  const following = fixture.guard.beginObservation('carry-through');
  assert.equal(following.requests[0].requestId, ended.requests[0].requestId); assert.equal(following.requests[0].carriedIn, true);
  finish(); const reply = await pending;
  assert.equal(reply.status, 200); assert.equal(reply.bytes.toString('utf8'), 'first-last');
  await terminalObservation(fixture.guard, 'carry-through');
  const completed = fixture.guard.endObservation('carry-through');
  assert.equal(completed.recordingComplete, true); assert.equal(completed.terminalComplete, true);
  assert.equal(completed.requests[0].terminal.outcome, 'finished'); assert.equal(completed.requests[0].carriedIn, true);
  assert.equal(ended.requests[0].terminal, null); assert.equal(ended.after.activeRequestCount, 1, 'Ending the window must retain its unfinished boundary rather than mutate later');
});

test('observation remains independent of the 256-row diagnostics and fails complete recording at request 4097', { timeout: 60000 }, async t => {
  const fixture = await loopbackTransport(t);
  fixture.guard.beginObservation('bounded-real-requests');
  const target = fixture.origin + '/api/v1/adapters/owned_version';
  for (let index = 0; index < 4097; index++) {
    assert.equal((await proxyRequest(fixture.guard, target)).status, 200);
    if (index === 256) {
      const partial = fixture.guard.snapshotObservation('bounded-real-requests');
      assert.equal(partial.requests.length, 257); assert.equal(partial.droppedRequests, 0); assert.equal(partial.recordingComplete, true);
      assert.equal(fixture.guard.evidence().events.length, 256); assert(fixture.guard.evidence().droppedEntries > 0);
    }
    if (index === 4095) {
      const full = fixture.guard.snapshotObservation('bounded-real-requests');
      assert.equal(full.requests.length, 4096); assert.equal(full.droppedRequests, 0); assert.equal(full.recordingComplete, true);
    }
  }
  await terminalObservation(fixture.guard, 'bounded-real-requests');
  const result = fixture.guard.endObservation('bounded-real-requests');
  assert.equal(fixture.received.length, 4097); assert.equal(result.requestLimit, 4096); assert.equal(result.requests.length, 4096);
  assert.equal(result.droppedRequests, 1); assert.equal(result.observerErrors, 0); assert.equal(result.recordingComplete, false); assert.equal(result.terminalComplete, false);
  assert.equal(result.after.activeRequestCount, 0); assert.equal(new Set(result.requests.map(entry => entry.requestId)).size, 4096);
  assert(result.requests.every(entry => entry.response.status === 200 && entry.terminal.outcome === 'finished'));
});

test('observation preserves origin generation and route proof invalidation across replacement and closure', { timeout: 10000 }, async t => {
  const fixture = await loopbackTransport(t), replacement = await loopbackTransport(t);
  await fixture.guard.verifyBrowserRoute(challengePage(fixture.guard).page);
  const opened = fixture.guard.beginObservation('origin-replacement');
  assert.equal(opened.before.routeVerification.verified, true); assert.equal(opened.before.closed, false);
  fixture.guard.replaceOwnedOrigin(fixture.origin, replacement.origin);
  assert.equal((await proxyRequest(fixture.guard, replacement.origin + '/api/v1/adapters/owned_version')).status, 200);
  await terminalObservation(fixture.guard, 'origin-replacement');
  const replaced = fixture.guard.endObservation('origin-replacement');
  assert.equal(replaced.after.proxyInstanceId, replaced.before.proxyInstanceId); assert.equal(replaced.after.originGeneration, replaced.before.originGeneration + 1);
  assert.deepEqual(replaced.before.allowedOrigins, [fixture.origin]); assert.deepEqual(replaced.after.allowedOrigins, [replacement.origin]);
  assert.equal(replaced.after.routeVerification.verified, false); assert.equal(replaced.after.routeChallenge, null); assert.equal(replaced.routeBindingStable, false); assert.equal(replaced.requests.length, 1);
  assert.deepEqual(fixture.received, []); assert.equal(replacement.received.length, 1);
  fixture.guard.beginObservation('proxy-closure');
  await fixture.close();
  const closed = fixture.guard.endObservation('proxy-closure');
  assert.equal(closed.before.closed, false); assert.equal(closed.after.closed, true); assert.equal(closed.after.activeRequestCount, 0); assert.equal(closed.routeBindingStable, false);
  assert.throws(() => fixture.guard.beginObservation('after-close'), { code: 'CAMPAIGN_PREREQUISITE' });
});
