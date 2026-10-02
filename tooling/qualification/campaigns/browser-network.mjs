// Browser HTTP(S) egress boundary configured through public launch options. Unlike
// Playwright routing, an explicit HTTP proxy leaves the browser cache enabled.
// This is a URL-transport guard, not an operating-system network sandbox.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { digest, monotonic, PrerequisiteError } from './common.mjs';

const issue = message => { throw new PrerequisiteError(message); };
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const HOP = new Set(['connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const ENGINES = new Set(['chromium', 'firefox', 'webkit']);
const CHALLENGE_PREFIX = '/.well-known/ideogram-campaign-proxy/';
const OBSERVATION_REQUEST_LIMIT = 4096;
const ROUTE_ID = '[A-Za-z0-9_-]{1,128}';

/** Classification is evidence, not admission. Never retain a query or decode a
 * caller-controlled path into an apparent immutable ID. The consumer must bind
 * each exposed ID to its actual fixture/returned production identity. */
export function classifyBrowserRequestPath(pathname) {
  const fixed = {
    '/': 'document-root', '/favicon.ico': 'favicon',
    '/api/v1/session': 'session', '/api/v1/session/bootstrap': 'session-bootstrap',
    '/api/v1/session/renew': 'session-renew', '/api/v1/session/revoke': 'session-revoke',
    '/api/v1/capabilities': 'capabilities', '/api/v1/adapters': 'adapter-list',
    '/api/v1/assets/staging': 'asset-staging-create', '/api/v1/assets/staging/recovery': 'asset-staging-recovery',
    '/api/v1/commands': 'command-submit', '/api/v1/commands/pending': 'command-inventory', '/api/v1/documents': 'document-list',
    '/api/v1/ui': 'ui-inventory', '/api/v1/queue': 'queue', '/api/v1/provider': 'provider',
    '/api/v1/events': 'events', '/api/v1/events/stream': 'events-stream',
  };
  if (typeof pathname !== 'string' || pathname.length > 16384 || /[\u0000-\u0020\u007f\\?#]/.test(pathname)) return { route: 'unknown', id: null };
  if (Object.hasOwn(fixed, pathname)) return { route: fixed[pathname], id: null };
  if (new RegExp('^' + CHALLENGE_PREFIX.replaceAll('.', '\\.') + '[a-f0-9]{64}$').exec(pathname)?.[0] === pathname) return { route: 'proxy-challenge', id: null };
  const patterns = [
    ['adapter-deletion-review', '/api/v1/adapters/deletion-reviews/'],
    ['adapter-updates', '/api/v1/adapters/', '/updates'], ['adapter-view', '/api/v1/adapters/'],
    ['asset-transfer-review', '/api/v1/assets/staging/transfer-reviews/'],
    ['asset-staging-finalize', '/api/v1/assets/staging/', '/finalize'], ['asset-staging', '/api/v1/assets/staging/'],
    ['asset-raster-import-inspection', '/api/v1/assets/raster-import-inspections/'],
    ['asset-raster-review', '/api/v1/assets/raster-reviews/'],
    ...['content', 'display', 'display-tile', 'sample', 'raster'].map(suffix => ['asset-' + suffix, '/api/v1/assets/', '/' + suffix]),
    ['asset-view', '/api/v1/assets/'], ['command-view', '/api/v1/commands/'],
    ['command-result', '/api/v1/commands/', '/result'], ['command-original', '/api/v1/commands/', '/original'],
    ['document-view', '/api/v1/documents/'],
    ...['image', 'history', 'checkpoints', 'save-status', 'closure', 'composition', 'text', 'candidates', 'deletion'].map(suffix => ['document-' + suffix, '/api/v1/documents/', '/' + suffix]),
    ['ui-view', '/api/v1/ui/'],
    ...['request', 'request-reviews', 'composition', 'text'].map(suffix => ['ui-' + suffix, '/api/v1/ui/', '/' + suffix]),
    ['snapshot', '/api/v1/snapshots/'], ['protocol-content', '/api/v1/protocol-content/'],
    ['namespace-events', '/api/v1/namespace-events/'], ['recovery-release', '/api/v1/recovery/', '/release'],
  ];
  for (const [route, prefix, suffix = ''] of patterns) {
    const match = new RegExp('^' + prefix + '(' + ROUTE_ID + ')' + suffix + '$').exec(pathname);
    if (match && match[0] === pathname) return { route, id: match[1] };
  }
  return { route: 'unknown', id: null };
}

export function normalizeBrowserOrigins(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) issue('Browser egress needs one to eight exact product origins');
  const origins = values.map(value => {
    if (typeof value !== 'string' || value.trim() !== value || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) issue('Browser egress allows only exact literal IPv4 HTTP origins with an explicit port');
    // WHATWG URLs omit the default port, so retain the explicitly supplied :80.
    const port = Number(value.slice(value.lastIndexOf(':') + 1));
    if (!Number.isSafeInteger(port) || port > 65535 || port < 1) issue('Browser egress origin port is invalid');
    const url = new URL(value);
    if (url.hostname !== '127.0.0.1' || url.username || url.password) issue('Browser egress origin is invalid');
    return 'http://127.0.0.1:' + port;
  });
  if (new Set(origins).size !== origins.length) issue('Browser egress origins must be unique');
  return origins;
}

/** No DNS lookup or socket is opened while inspecting an untrusted request. */
export function inspectBrowserProxyRequest(request, allowedOrigins) {
  const deny = reason => ({ allowed: false, reason });
  if (request?.method === 'CONNECT') return deny('connect-tunnel-denied');
  if (!METHODS.has(request?.method)) return deny('method-denied');
  if (request.headers?.upgrade !== undefined) return deny('upgrade-denied');
  const value = request.url;
  if (typeof value !== 'string' || value.length > 16384 || value.includes('#') || /[\u0000-\u0020\u007f\\]/.test(value) || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\//.test(value)) return deny('absolute-literal-http-url-required');
  let url;
  try { url = new URL(value); } catch { return deny('invalid-url'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash) return deny('origin-denied');
  const port = Number(url.port || 80), origin = 'http://127.0.0.1:' + port;
  if (!allowedOrigins.includes(origin)) return deny('origin-denied');
  if (request.headers?.host !== url.host) return deny('host-mismatch');
  return { allowed: true, origin, hostname: '127.0.0.1', port, path: url.pathname + url.search, host: url.host, method: request.method };
}

export function browserProxyLaunchOptions(proxyOrigin, engine = 'chromium') {
  if (!ENGINES.has(engine)) issue('Cache-preserving browser proxy launch requires a supported pinned Playwright engine');
  const [server] = normalizeBrowserOrigins([proxyOrigin]);
  // Playwright 1.63.0 Firefox Juggler installs an explicit channel proxy with
  // no failover; its bundled preferences enable these same localhost settings.
  // Firefox bypass entries are hostname suffixes, not Chromium rule tokens.
  // https://github.com/microsoft/playwright/blob/v1.63.0/browser_patches/firefox/preferences/playwright.cfg
  if (engine === 'firefox') return {
    proxy: { server, bypass: '' },
    firefoxUserPrefs: {
      'network.proxy.allow_hijacking_localhost': true,
      'network.proxy.testing_localhost_is_secure_when_hijacked': true,
    },
  };
  // Pinned WebKit forwards this public option to its platform proxy settings.
  // Omit bypass: macOS WebKit's loopback routing changes when rules are present.
  // Every runtime still has to pass verifyBrowserRoute before product navigation.
  // https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/webkit/webkit.ts
  // https://github.com/microsoft/playwright/blob/main/tests/library/browsercontext-proxy.spec.ts
  if (engine === 'webkit') return { proxy: { server } };
  return {
    proxy: { server, bypass: '<-loopback>' },
    // Avoid a UDP transport outside the explicit URL proxy. Hostname resolution
    // for HTTP proxy destinations is performed here, using only literal IPv4.
    args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  };
}

export function inspectUndoProxyCommand(bytes, expected, admitted = 0) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 65536) return { allowed: false, reason: 'undo-command-envelope-bound' };
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return { allowed: false, reason: 'undo-command-envelope-invalid' }; }
  const command = value?.command;
  if (command?.body?.type !== 'Undo') return { allowed: true, undo: false };
  if (admitted !== 0 || command.documentId !== expected.id || command.expectedDocumentRevision !== expected.revision || command.body.historyHead !== expected.historyHead) return { allowed: false, reason: 'undo-target-or-revision-changed' };
  return { allowed: true, undo: true };
}

function forwardedHeaders(headers) {
  const remove = new Set(HOP);
  const connection = headers.connection;
  if (typeof connection === 'string') for (const token of connection.split(',')) remove.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => !remove.has(name.toLowerCase()) && value !== undefined));
}

export async function createCachePreservingEgress({ engine = 'chromium', allowedOrigins, onBlocked = () => {} } = {}) {
  const origins = normalizeBrowserOrigins(allowedOrigins);
  if (typeof onBlocked !== 'function') issue('Browser egress observations require a callback function');
  if (!ENGINES.has(engine)) {
    const value = { kind: 'browser-proxy-egress-1', supported: false, engine, cachePreserved: false, reason: 'No source-supported explicit-proxy launch configuration for this engine; retain the existing route guard and mark warm-cache evidence missing' };
    return { supported: false, cachePolicy: value.reason, evidence: () => ({ ...value }), close: async () => {} };
  }
  const startedMs = monotonic(), sockets = new Set(), pending = new Set(), entries = [], counts = { accepted: 0, blocked: 0, upstreamErrors: 0, connections: 0, peakConnections: 0, challengesServed: 0 };
  const routeVerification = { required: true, verified: false, totalAttempts: 0, completed: 0, failed: 0, inProgress: false };
  let closed = false, closePromise, droppedEntries = 0, sequence = 0, callbackErrors = 0, undoFence = null, challenge = null;
  const proxyInstanceId = randomBytes(16).toString('hex'), observedRequests = new WeakMap(), activeObserved = new Map();
  let requestOrdinal = 0, observationOrdinal = 0, observation = null, activeRequestCount = 0, originGeneration = 0, lastRouteChallenge = null, observationErrors = 0;
  const observationError = () => { observationErrors++; if (observation) observation.observerErrors++; };
  const includeObserved = (row, carriedIn = false) => {
    if (!observation || observation.requests.has(row.requestId)) return;
    if (observation.requests.size >= OBSERVATION_REQUEST_LIMIT) { observation.droppedRequests++; return; }
    observation.requests.set(row.requestId, { row, carriedIn });
  };
  const observeTerminal = (row, outcome) => {
    if (!row || row.terminal) return;
    row.terminal = { outcome, observedMs: monotonic() };
    activeObserved.delete(row.requestId); activeRequestCount--;
  };
  const observeResponse = (row, status) => {
    if (!row || row.response) return;
    if (!Number.isInteger(status) || status < 100 || status > 999) { observationError(); return; }
    row.response = { status, observedMs: monotonic() };
  };
  const observeRequest = (request, response, socket) => {
    try {
      const raw = request?.url, urlComplete = typeof raw === 'string' && raw.length <= 16384;
      let originIndex = -1, classification = { route: 'unknown', id: null };
      if (urlComplete) {
        try {
          const url = new URL(raw);
          if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && !url.hash) {
            originIndex = origins.indexOf('http://127.0.0.1:' + Number(url.port || 80));
            if (originIndex >= 0) classification = classifyBrowserRequestPath(url.pathname);
          }
        } catch { /* Invalid/CONNECT targets remain redacted unknown routes. */ }
      }
      const row = { requestId: proxyInstanceId + ':' + ++requestOrdinal,
        method: typeof request?.method === 'string' && /^[A-Z-]{1,32}$/.test(request.method) ? request.method : 'OTHER',
        urlSha256: urlComplete ? digest(raw) : null, urlComplete, originIndex, ...classification,
        requestBytes: null, uploadOffset: null,
        receivedMs: monotonic(), forwardedMs: null, blocked: null, response: null, terminal: null };
      // Header declarations witness the original request envelope, not consumed
      // body bytes. Keep only bounded canonical integers, never other headers.
      for (const name of ['content-length', 'upload-offset']) {
        const value = request?.headers?.[name];
        if (typeof value !== 'string' || value.length < 1 || value.length > 20 || /[^0-9]/.test(value)
          || value.length > 1 && value[0] === '0' || request.headersDistinct?.[name]?.length !== 1) continue;
        if (name === 'upload-offset') row.uploadOffset = value;
        else if (Number.isSafeInteger(Number(value))) row.requestBytes = Number(value);
      }
      if (request) observedRequests.set(request, row);
      activeRequestCount++;
      if (activeObserved.size < OBSERVATION_REQUEST_LIMIT) activeObserved.set(row.requestId, row);
      else observationError();
      includeObserved(row);
      if (response) {
        response.once('finish', () => { observeResponse(row, response.statusCode); observeTerminal(row, 'finished'); });
        response.once('close', () => observeTerminal(row, 'closed'));
      } else socket?.once('close', () => observeTerminal(row, 'socket-closed'));
      return row;
    } catch { observationError(); return null; }
  };
  const observationState = () => ({ proxyInstanceId, pid: process.pid, startedMs, originGeneration,
    allowedOrigins: [...origins], proxyOrigin: origin, closed, routeVerification: { ...routeVerification },
    routeChallenge: lastRouteChallenge ? { ...lastRouteChallenge } : null,
    activeRequestCount, activeRequests: [...activeObserved.values()].map(row => structuredClone(row)),
    activeUpstreamRequests: pending.size, activeConnections: sockets.size,
    counts: { ...counts }, callbackErrors, observerErrors: observationErrors });
  const observationSnapshot = (id, ended = false) => {
    if (!observation || observation.id !== id) issue('Proxy observation requires its exact active window ID');
    const after = observationState(), rows = [...observation.requests.values()].map(({ row, carriedIn }) => ({ ...structuredClone(row), carriedIn }));
    const recordingComplete = observation.droppedRequests === 0 && observation.observerErrors === 0 && after.observerErrors === 0
      && observation.before.activeRequestCount === observation.before.activeRequests.length && after.activeRequestCount === after.activeRequests.length;
    return { kind: 'browser-proxy-observation-1', id, windowOrdinal: observation.ordinal, ended,
      startedMs: observation.startedMs, observedMs: monotonic(), requestLimit: OBSERVATION_REQUEST_LIMIT,
      before: structuredClone(observation.before), after, requests: rows,
      droppedRequests: observation.droppedRequests, observerErrors: observation.observerErrors,
      recordingComplete, terminalComplete: recordingComplete && after.activeRequestCount === 0,
      // Retention completeness is separate from transport binding and from any
      // consumer's allowlist/zero-fetch verdict. An active SSE never blocks end.
      routeBindingStable: observation.before.originGeneration === after.originGeneration
        && observation.before.closed === false && after.closed === false
        && observation.before.routeVerification.verified && after.routeVerification.verified
        && observation.before.routeVerification.totalAttempts === after.routeVerification.totalAttempts
        && !observation.before.routeVerification.inProgress && !after.routeVerification.inProgress,
      scope: 'HTTP proxy requests observed during this window, including explicit carry-in; not browser cache, browser API attempts, tensor decode, or OS egress' };
  };
  const append = value => { const event = { sequence: ++sequence, observedMs: monotonic(), ...value }; if (entries.length < 256) entries.push(event); else droppedEntries++; return event; };
  const blocked = (request, reason, observed = request ? observedRequests.get(request) : null) => {
    counts.blocked++;
    if (observed) observed.blocked = { reason, observedMs: monotonic() };
    const event = append({ kind: 'blocked', reason, method: METHODS.has(request?.method) || request?.method === 'CONNECT' ? request.method : 'OTHER', requestHash: digest(String(request?.url ?? '').slice(0, 16384)) });
    try { const result = onBlocked({ ...event }); if (result && typeof result.then === 'function') result.catch(() => { callbackErrors++; }); } catch { callbackErrors++; }
  };
  const refuse = (response, code = 403) => { response.writeHead(code, { 'content-type': 'text/plain', 'cache-control': 'no-store', connection: 'close' }); response.end('Browser campaign transport denied.'); };
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 8 });
  const server = http.createServer({ maxHeaderSize: 32768, requestTimeout: 120000, headersTimeout: 30000, keepAliveTimeout: 5000 }, (request, response) => {
    const observed = observeRequest(request, response);
    if (closed) { request.resume(); return refuse(response, 503); }
    const target = inspectBrowserProxyRequest(request, origins);
    if (!target.allowed) { blocked(request, target.reason); request.resume(); return refuse(response); }
    // The response nonce is independent of the URL nonce and never reaches the
    // product server. A direct/bypassed request cannot echo a successful proof.
    if (target.path.startsWith(CHALLENGE_PREFIX)) {
      const current = challenge;
      if (!current || target.origin !== current.origin || target.path !== current.path || target.method !== 'GET' || current.observation) {
        blocked(request, 'route-challenge-not-active'); request.resume(); return refuse(response);
      }
      counts.challengesServed++;
      current.observation = append({ kind: 'route-challenge-served', method: 'GET', originIndex: origins.indexOf(target.origin), requestHash: digest(request.url), responseHash: digest(current.nonce), upstreamForwarded: false });
      request.resume();
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(current.nonce)), 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'x-ideogram-proxy-challenge': current.nonce });
      return response.end(current.nonce);
    }
    if (pending.size >= 256) { blocked(request, 'concurrent-request-bound'); request.resume(); return refuse(response, 503); }
    const forward = bytes => {
      if (closed) return refuse(response, 503);
      counts.accepted++;
      if (observed) observed.forwardedMs = monotonic();
      append({ kind: 'forwarded', method: target.method, originIndex: origins.indexOf(target.origin) });
      const headers = forwardedHeaders(request.headers); headers.host = target.host;
      const upstream = http.request({ hostname: '127.0.0.1', family: 4, port: target.port, method: target.method, path: target.path, headers, agent }, reply => {
        observeResponse(observed, reply.statusCode ?? 502);
        response.writeHead(reply.statusCode ?? 502, forwardedHeaders(reply.headers));
        reply.on('error', () => { observeTerminal(observed, 'upstream-response-error'); response.destroy(); });
        reply.pipe(response);
      });
      pending.add(upstream);
      upstream.once('close', () => pending.delete(upstream));
      upstream.once('error', () => { counts.upstreamErrors++; observeTerminal(observed, 'upstream-error'); if (!response.headersSent) refuse(response, 502); else response.destroy(); });
      request.once('aborted', () => { observeTerminal(observed, 'request-aborted'); upstream.destroy(); });
      request.once('error', () => { observeTerminal(observed, 'request-error'); upstream.destroy(); });
      response.once('close', () => { if (!response.writableFinished) upstream.destroy(); });
      if (bytes) upstream.end(bytes); else request.pipe(upstream);
    };
    const fence = undoFence;
    if (fence && target.method === 'POST' && target.path.split('?')[0] === '/api/v1/commands') {
      const chunks = []; let length = 0, denied = false;
      const deny = reason => { if (denied) return; denied = true; chunks.length = 0; blocked(request, reason); fence.reject(new PrerequisiteError('Public Undo was blocked before dispatch: ' + reason)); request.resume(); refuse(response); };
      request.on('data', chunk => { if (denied) return; length += chunk.length; if (length > 65536) deny('undo-command-envelope-bound'); else chunks.push(chunk); });
      request.once('end', () => {
        if (denied) return;
        const bytes = Buffer.concat(chunks, length); chunks.length = 0;
        // A body that outlives its reset action cannot use a stale fence.
        if (undoFence !== fence) return deny('undo-fence-expired');
        const decision = inspectUndoProxyCommand(bytes, fence.expected, fence.admitted);
        if (!decision.allowed) return deny(decision.reason);
        if (decision.undo) { fence.admitted++; append({ kind: 'undo-fence-admitted', unchangedBytes: true }); }
        forward(bytes);
      });
      request.once('aborted', () => { observeTerminal(observed, 'request-aborted'); chunks.length = 0; fence.reject(new PrerequisiteError('Public Undo request was aborted before forwarding')); });
      request.once('error', () => { observeTerminal(observed, 'request-error'); chunks.length = 0; fence.reject(new PrerequisiteError('Public Undo request failed before forwarding')); });
    } else forward();
  });
  // HTTPS/wss CONNECT is always denied before opening any upstream socket.
  server.on('connect', (request, socket) => { const observed = observeRequest(request, null, socket); blocked(request, 'connect-tunnel-denied', observed); observeResponse(observed, 403); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  // Production campaigns have no HMR. Shared-dev-server WebSocket forwarding
  // needs separate real transport qualification; do not silently tunnel it.
  server.on('upgrade', (request, socket) => { const observed = observeRequest(request, null, socket); blocked(request, 'upgrade-denied', observed); observeResponse(observed, 403); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.on('connection', socket => {
    if (closed || sockets.size >= 256) { socket.destroy(); return; }
    sockets.add(socket); counts.connections++; counts.peakConnections = Math.max(counts.peakConnections, sockets.size);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => { const observed = observeRequest(null, null, socket); blocked(null, 'malformed-http', observed); socket.destroy(); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  } catch (error) { agent.destroy(); for (const socket of sockets) socket.destroy(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') { server.close(); agent.destroy(); issue('Browser proxy did not bind its exact literal loopback address'); }
  const origin = 'http://127.0.0.1:' + address.port, launchOptions = browserProxyLaunchOptions(origin, engine);
  return {
    supported: true, origin, launchOptions,
    beginObservation(id) {
      if (closed || observation || typeof id !== 'string' || id.length < 1 || id.length > 128 || /[^A-Za-z0-9_-]/.test(id)) issue('One open proxy observation requires a bounded window ID and live proxy');
      observation = { id, ordinal: ++observationOrdinal, startedMs: monotonic(), before: observationState(), requests: new Map(), droppedRequests: 0, observerErrors: 0 };
      for (const row of activeObserved.values()) includeObserved(row, true);
      return observationSnapshot(id);
    },
    snapshotObservation(id) { return observationSnapshot(id); },
    endObservation(id) { const value = observationSnapshot(id, true); observation = null; return value; },
    cachePolicy: engine === 'chromium'
      ? 'Chromium explicit HTTP proxy with <-loopback>; no Playwright routes, cache-disabling CDP commands, or proxy response cache'
      : engine + ' public explicit HTTP proxy with verified literal-loopback routing; no Playwright routes, cache-disabling commands, or proxy response cache',
    evidence: () => ({ kind: 'browser-proxy-egress-1', supported: true, engine, cachePreserved: routeVerification.verified, scope: engine + ' campaign page URL HTTP/HTTPS/WS/WSS transport after launch initialization; not an OS network sandbox', allowedOrigins: [...origins], proxyOrigin: origin, loopbackBypassDisabled: routeVerification.verified, directFallback: false, connectPolicy: 'deny', upgradePolicy: 'deny-unqualified-HMR', startedMs, closed, routeVerification: { ...routeVerification }, counts: { ...counts }, activeConnections: sockets.size, activeRequests: pending.size, callbackErrors, droppedEntries, events: entries.map(entry => ({ ...entry })) }),
    async verifyBrowserRoute(page, { origin: productOrigin = origins[0], signal } = {}) {
      if (closed || challenge || routeVerification.totalAttempts >= 64 || !origins.includes(productOrigin) || typeof page?.goto !== 'function' || typeof page?.url !== 'function' || page.url() !== 'about:blank') issue('Browser proxy verification requires one fresh blank page and an exact allowed product origin');
      signal?.throwIfAborted();
      const current = { origin: productOrigin, path: CHALLENGE_PREFIX + randomBytes(32).toString('hex'), nonce: randomBytes(32).toString('hex'), observation: null };
      const url = new URL(current.origin + current.path).href;
      challenge = current; routeVerification.totalAttempts++; routeVerification.inProgress = true;
      // Each attempted context must succeed. Earlier success cannot mask a
      // later context that bypasses the proxy or fails its cleanup navigation.
      routeVerification.verified = false;
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        signal?.throwIfAborted();
        const headers = response?.headers();
        if (closed || !current.observation || response?.status() !== 200 || response.url() !== url || response.request().method() !== 'GET' || response.fromServiceWorker() || page.url() !== url || headers?.['cache-control'] !== 'no-store' || headers?.['x-ideogram-proxy-challenge'] !== current.nonce || headers?.['content-length'] !== String(current.nonce.length)) issue('Browser navigation did not prove passage through the exact product-origin proxy challenge');
        if (await response.text() !== current.nonce) issue('Browser proxy challenge response body did not match its private nonce');
        signal?.throwIfAborted();
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });
        if (closed || page.url() !== 'about:blank') issue('Browser proxy challenge did not restore a blank unscored page');
        signal?.throwIfAborted();
        const proof = { kind: 'browser-proxy-route-challenge-1', engine, originIndex: origins.indexOf(productOrigin), observedMs: current.observation.observedMs, requestHash: current.observation.requestHash, responseHash: current.observation.responseHash, cacheDisabled: false, upstreamForwarded: false };
        lastRouteChallenge = { ...proof };
        routeVerification.completed++; routeVerification.verified = true;
        append({ kind: 'route-challenge-completed', originIndex: proof.originIndex, requestHash: proof.requestHash, responseHash: proof.responseHash, cacheDisabled: false });
        return proof;
      } catch (error) {
        routeVerification.failed++;
        append({ kind: 'route-challenge-failed', originIndex: origins.indexOf(productOrigin) });
        // Raw Playwright navigation errors may include the private URL. Preserve
        // cancellation, otherwise report a fixed prerequisite without that URL.
        if (signal?.aborted) throw signal.reason;
        if (error?.code === 'CAMPAIGN_PREREQUISITE') throw error;
        issue('Browser proxy route challenge could not complete through public page navigation');
      } finally {
        if (challenge === current) challenge = null;
        routeVerification.inProgress = false;
      }
    },
    replaceOwnedOrigin(previous, next) {
      if (closed || challenge || undoFence || origins.length !== 1 || origins[0] !== previous) issue('Proxy origin replacement requires exactly the previous owned origin and no active challenge or command fence');
      const replacement = normalizeBrowserOrigins([next])[0];
      if (replacement === previous) issue('Backend replacement must establish a fresh exact origin');
      // Destroy old-origin keepalive requests before admitting the new server.
      // The process owner has already observed the old backend exit.
      for (const request of pending) request.destroy();
      agent.destroy(); origins[0] = replacement; originGeneration++; routeVerification.verified = false; lastRouteChallenge = null;
      append({ kind: 'owned-origin-replaced', previousHash: digest(previous), nextHash: digest(replacement), allowedOriginCount: 1, cacheDisabled: false });
    },
    async withUndoFence(expected, action) {
      if (closed || undoFence || typeof action !== 'function' || !/^[A-Za-z0-9_-]{1,160}$/.test(expected?.id ?? '') || !/^[0-9]+$/.test(expected?.revision ?? '') || !/^[A-Za-z0-9_-]{1,160}$/.test(expected?.historyHead ?? '')) issue('One live proxy Undo fence requires an exact document revision and history head');
      let reject; const blockedCommand = new Promise((_resolve, fail) => { reject = fail; }); blockedCommand.catch(() => {});
      const fence = { expected: { id: expected.id, revision: expected.revision, historyHead: expected.historyHead }, admitted: 0, reject }; undoFence = fence;
      const work = Promise.resolve().then(action); work.catch(() => {});
      try {
        const result = await Promise.race([work, blockedCommand]);
        if (fence.admitted !== 1) issue('Exactly one original public Undo command must cross the proxy fence');
        append({ kind: 'undo-fence-completed', admitted: 1, cacheDisabled: false }); return result;
      } finally { if (undoFence === fence) undoFence = null; }
    },
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      challenge = null;
      undoFence?.reject(new PrerequisiteError('Browser proxy closed during Undo reset')); undoFence = null;
      const children = [...pending, ...sockets].map(child => new Promise(resolve => { child.once('close', resolve); child.destroy(); }));
      agent.destroy();
      closePromise = Promise.all([new Promise(resolve => server.close(() => resolve())), ...children]).then(() => {});
      server.closeAllConnections();
      return closePromise;
    },
  };
}
