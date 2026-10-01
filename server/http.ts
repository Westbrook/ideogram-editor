import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { CapabilitiesView } from '../src/protocol/session.js';
import { ProtocolError } from './errors.js';
import { readSessionRequest } from './control-json.js';
import { Sessions, cookieDigest, readCookie, sessionCookie, expiredCookie } from './sessions.js';
import { assertSeparateDirectories, preparePrivateRoot } from './private-root.js';
import { BOOTSTRAP_CSP, SHELL_STYLE_CSP, loadStatic } from './static.js';
import { ProtocolRoutes, storeError } from './protocol.js';
import type { WriterTestOptions } from './storage/writer.js';
import { openWriter } from './storage/writer.js';
import type { ProviderRuntimeConfig } from './provider/config.js';

export const DEVELOPMENT_HMR_PATH = '/__ideogram_hmr';
/** Explicit in-process development composition only. The production launcher
 * never supplies this factory; no request, environment flag or persisted state
 * can enable it. API/session routing always precedes this source middleware. */
export type DevelopmentApplication = {
  websocketToken: string;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
};
export type DevelopmentFactory = (context: { server: Server; origin: string; nonce: string; hmrPath: string }) => Promise<DevelopmentApplication>;
export type ServerOptions = { root: string; staticDirectory?: string; now?: () => number; credentialConfigured?: boolean; provider?: ProviderRuntimeConfig; development?: DevelopmentFactory };
const methods: Record<string, readonly string[]> = {
  '/api/v1/session/bootstrap': ['POST'], '/api/v1/session': ['GET'],
  '/api/v1/session/renew': ['POST'], '/api/v1/session/revoke': ['POST'], '/api/v1/capabilities': ['GET'],
};
const unavailable = /^\/api\/v1\/(?:commands|events|documents|jobs|assets|bundles|snapshots|protocol-content|recovery|ui|image-previews|image-edit-reviews)(?:\/|$)/;

function securityHeaders(response: ServerResponse, origin: string, wasmWorker = false, developmentNonce?: string): void {
  const nonce = developmentNonce ? ` 'nonce-${developmentNonce}'` : '';
  const websocket = developmentNonce ? ` ${origin.replace(/^http:/, 'ws:')}` : '';
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' ${BOOTSTRAP_CSP}${nonce}${wasmWorker ? " 'wasm-unsafe-eval'" : ''}; style-src 'self'${nonce}; style-src-attr 'unsafe-hashes' ${SHELL_STYLE_CSP}; connect-src ${origin}${websocket}; img-src 'self' blob:; font-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
}
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
function checkBoundary(request: IncomingMessage, origin: string): void {
  const headers = request.headersDistinct;
  if (Object.keys(headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-'))) throw new ProtocolError('ORIGIN_DENIED');
  for (const name of ['host', 'origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'cookie', 'x-app-client', 'x-app-csrf', 'content-type', 'content-encoding']) {
    if ((headers[name]?.length ?? 0) > 1) throw new ProtocolError('ORIGIN_DENIED');
  }
  if (request.headers.host !== origin.slice('http://'.length)) throw new ProtocolError('ORIGIN_DENIED');
  if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new ProtocolError('ORIGIN_DENIED');
  const site = request.headers['sec-fetch-site'];
  // The independent loopback report may navigate to the anonymous landing
  // page. This never permits API/assets/fetch/frame access or a foreign Origin.
  const reportLanding = site === 'same-site' && request.method === 'GET' &&
    request.url?.split('?')[0] === '/' && request.headers.origin === undefined &&
    request.headers['sec-fetch-mode'] === 'navigate' &&
    request.headers['sec-fetch-dest'] === 'document' && request.headers['sec-fetch-user'] === '?1';
  if (site !== undefined && site !== 'same-origin' && site !== 'none' && !reportLanding) throw new ProtocolError('ORIGIN_DENIED');
  // Reject proxy-form, normalized traversal and query credentials before routing.
  if (!request.url?.startsWith('/') || request.url.startsWith('//') || /[\\#\x00-\x20]/.test(request.url)) throw new ProtocolError('MALFORMED_REQUEST');
}
function checkAPIContext(request: IncomingMessage): void {
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (!read && request.headers.origin === undefined) throw new ProtocolError('ORIGIN_DENIED');
  if (read && request.headers.origin === undefined &&
      (request.headers['sec-fetch-site'] !== 'same-origin' || request.headers['x-app-client'] !== 'LP-1')) throw new ProtocolError('ORIGIN_DENIED');
  // JSON cannot be obtained through navigations, forms, scripts or image tags.
  if (request.headers['sec-fetch-mode'] !== undefined && !['cors', 'same-origin'].includes(request.headers['sec-fetch-mode'] as string)) throw new ProtocolError('ORIGIN_DENIED');
  if (request.headers['sec-fetch-dest'] !== undefined && request.headers['sec-fetch-dest'] !== 'empty') throw new ProtocolError('ORIGIN_DENIED');
  if (request.headers['sec-fetch-site'] === 'none') throw new ProtocolError('ORIGIN_DENIED');
  if (read && (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))) throw new ProtocolError('MALFORMED_REQUEST');
}

// Internal process barriers only; never sourced from HTTP/CLI/environment.
export async function startLocalServer(options: ServerOptions, testing?: { writer?: WriterTestOptions }) {
  if (options.development && (typeof options.development !== 'function' || options.staticDirectory || options.provider?.mode === 'fal' || options.credentialConfigured)) throw new Error('Development application requires an explicit factory, disabled provider and separate source serving.');
  const root = await preparePrivateRoot(options.root);
  if (options.staticDirectory) {
    await assertSeparateDirectories(root.path, options.staticDirectory);
  }
  const files = await loadStatic(options.staticDirectory);
  const writer = await openWriter({ root: root.path, provider: options.provider },testing?.writer);
  // Failure to provision the fixed default must not prevent metadata recovery.
  await writer.protocolDefaults().catch(() => {});
  const wall = Date.now();
  const monotonic = performance.now();
  const now = options.now ?? (() => wall + performance.now() - monotonic);
  const sessions = new Sessions(now);
  const protocol = new ProtocolRoutes(writer,now);
  let origin = '';
  let rootInvalid = false;
  let closed = false;
  let development: DevelopmentApplication | undefined;
  const developmentNonce = options.development ? randomBytes(24).toString('base64') : undefined;
  const upgraded = new Set<Duplex>();
  const capabilities: CapabilitiesView = {
    protocolVersion: 1, serverVersion: '0.1.0', projectionSchema: 8,
    credentialConfigured: options.provider ? options.provider.mode==='fal'&&Boolean(options.provider.key) : options.credentialConfigured ?? false,
    storageState: 'unavailable', connectionState: 'unknown', limits: [],
    profiles: [
      { id: 'LP-1', version: '1', state: 'unqualified' },
      { id: 'LS-1', version: '1', state: 'unqualified' },
      { id: 'EF-1', version: '1', state: 'unavailable' },
      { id: 'PF-1', version: '3', state: 'unqualified' },
      { id: 'TEXT-DURABLE', version: '1', state: 'unqualified' },
    ],
  };
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 0, headersTimeout: 10_000,
    ...(options.development ? { shouldUpgradeCallback: (request: IncomingMessage) => {
      try {
        if (!development || closed || rootInvalid || !writer.available) return false;
        checkBoundary(request, origin);
        if (request.method !== 'GET' || request.headers.origin !== origin || request.headers.upgrade?.toLowerCase() !== 'websocket') return false;
        for (const name of ['upgrade', 'connection', 'sec-websocket-protocol', 'sec-websocket-key', 'sec-websocket-version']) if (request.headersDistinct[name]?.length !== 1) return false;
        if (!['vite-hmr', 'vite-ping'].includes(String(request.headers['sec-websocket-protocol'])) || request.headers['sec-websocket-version'] !== '13') return false;
        if (request.headers['sec-fetch-mode'] !== undefined && request.headers['sec-fetch-mode'] !== 'websocket') return false;
        if (request.headers['sec-fetch-dest'] !== undefined && request.headers['sec-fetch-dest'] !== 'empty') return false;
        if (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) return false;
        const target = new URL(request.url!, origin), entries = [...target.searchParams];
        if (target.pathname !== DEVELOPMENT_HMR_PATH || entries.length !== 1 || entries[0][0] !== 'token') return false;
        const received = Buffer.from(entries[0][1]), expected = Buffer.from(development.websocketToken);
        return received.length === expected.length && timingSafeEqual(received, expected);
      } catch { return false; }
    } } : {}),
  }, (request, response) => {
    void handle(request, response);
  });
  server.setTimeout(15_000, socket => socket.destroy());
  // Production has no WebSocket tunnel. In the explicit development process,
  // Node's pre-dispatch callback rejects hostile requests before Vite's own
  // listener can see a socket. CONNECT remains forbidden in every mode.
  server.on('upgrade', (_request, socket) => {
    if (!options.development) { socket.destroy(); return; }
    upgraded.add(socket); socket.once('close', () => upgraded.delete(socket));
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });

  async function assertRoot(): Promise<void> {
    try { if (rootInvalid || closed || !writer.available) throw new Error(); await root.assertUnchanged(); }
    catch { rootInvalid = true; sessions.invalidate(); throw new ProtocolError('SERVER_UNAVAILABLE'); }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    securityHeaders(response, origin);
    try {
      checkBoundary(request, origin);
      const target = request.url!;
      const question = target.indexOf('?');
      const path = question < 0 ? target : target.slice(0, question);
      const query = question < 0 ? undefined : target.slice(question + 1);
      // A denied development upgrade falls back to the HTTP request handler.
      // It must never become a source middleware request or API request.
      if (options.development && request.headers.upgrade !== undefined) throw new ProtocolError('ORIGIN_DENIED');
      // This display flag is never a return URL or an authentication input.
      if (query !== undefined && !path.startsWith('/api/') && !options.development) {
        const entries = [...new URLSearchParams(query)];
        if (path !== '/' || entries.length !== 1 || entries[0][0] !== 'progress-report') throw new ProtocolError('MALFORMED_REQUEST');
      }
      if (path === '/api' || path.startsWith('/api/')) {
        checkAPIContext(request);
        await assertRoot();
        const bootstrap = path === '/api/v1/session/bootstrap';
        const cookie = readCookie(request.headers.cookie);
        const mutation = request.method !== 'GET' && request.method !== 'HEAD';
        // Authenticate all API routes except the exact bootstrap exchange.
        if (!bootstrap) sessions.authenticate(cookie, mutation ? String(request.headers['x-app-csrf'] ?? '') : undefined);
        const route = protocol.match(path);
        const params = new URLSearchParams(query ?? '');
        const allowedQuery = route?.query ?? [];
        const seen = new Set<string>();
        for (const [key] of params) {
          if (!allowedQuery.includes(key) || seen.has(key)) throw new ProtocolError('MALFORMED_REQUEST'); seen.add(key);
        }
        if (query !== undefined && (!query || /%(?![0-9a-f]{2})/i.test(query))) throw new ProtocolError('MALFORMED_REQUEST');
        const allow = route?.allow ?? methods[path];
        if (!allow) throw new ProtocolError(unavailable.test(path) ? 'SERVER_UNAVAILABLE' : 'NOT_FOUND');
        if (!allow.includes(request.method!)) { response.setHeader('Allow', allow.join(', ')); throw new ProtocolError('METHOD_NOT_ALLOWED'); }
        if (route) {
          await protocol.handle(request,response,route,params,() => {
            const session = sessions.authenticate(cookie,mutation ? String(request.headers['x-app-csrf'] ?? '') : undefined);
            sessions.view(session); return session;
          },assertRoot);
        } else if (bootstrap) {
          const body = await readSessionRequest(request, true);
          await assertRoot();
          // A fresh OS-delivered pairing token is still mandatory after restart.
          // Possession of the prior cookie can restore only its bound client ID;
          // it cannot authenticate a request or restore old session credentials.
          const restored = cookie ? await writer.recoverClient(cookieDigest(cookie),Math.floor(now())) : null;
          const paired = sessions.bootstrap(body.pairingToken as string, cookie, restored ?? undefined);
          try { await writer.rememberClient(cookieDigest(paired.cookie),paired.view.clientId,Date.parse(paired.view.sessionExpiresAt),cookie ? cookieDigest(cookie) : undefined); }
          catch (e) { sessions.invalidate(); throw e; }
          response.setHeader('Set-Cookie', sessionCookie(paired.cookie));
          json(response, 200, paired.view);
        } else if (mutation) {
          await readSessionRequest(request, false);
          await assertRoot();
          // Body reads can yield: recheck expiry/revocation/rotation after them.
          const session = sessions.authenticate(cookie, String(request.headers['x-app-csrf'] ?? ''));
          if (path.endsWith('/renew')) {
            const renewed = sessions.renew(session);
            try { await writer.rememberClient(cookieDigest(renewed.cookie),renewed.view.clientId,Date.parse(renewed.view.sessionExpiresAt),session.cookieHash); }
            catch (e) { sessions.invalidate(); throw e; }
            response.setHeader('Set-Cookie', sessionCookie(renewed.cookie));
            json(response, 200, renewed.view);
          } else {
            await writer.forgetClient(session.cookieHash);
            sessions.revoke(session);
            response.setHeader('Set-Cookie', expiredCookie);
            response.writeHead(204); response.end();
          }
        } else {
          const view = sessions.view(sessions.authenticate(cookie));
          if (path === '/api/v1/capabilities') {
            const health = await writer.health();
            capabilities.storageState = health.missingCount ? 'unavailable' : health.diskWarning || health.snapshotPressure ? 'pressure' : 'ready';
          }
          json(response, 200, path === '/api/v1/session' ? view : capabilities);
        }
      } else {
        if (options.development) {
          if (!development) throw new ProtocolError('SERVER_UNAVAILABLE');
          if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); throw new ProtocolError('METHOD_NOT_ALLOWED'); }
          if (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) throw new ProtocolError('MALFORMED_REQUEST');
          await assertRoot();
          securityHeaders(response, origin, request.headers['sec-fetch-dest'] === 'worker', developmentNonce);
          await development.handle(request, response);
          return;
        }
        const file = files.get(path);
        if (!file) throw new ProtocolError('NOT_FOUND');
        if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw new ProtocolError('METHOD_NOT_ALLOWED'); }
        if (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) throw new ProtocolError('MALFORMED_REQUEST');
        // Native text uses sealed WASM in a dedicated worker. Keep document
        // script policy unchanged; only trusted built JS worker responses gain
        // WASM compilation (never JavaScript eval) permission.
        if (file.type.startsWith('text/javascript') && request.headers['sec-fetch-dest'] === 'worker') securityHeaders(response, origin, true);
        response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.bytes.length });
        response.end(file.bytes);
      }
    } catch (error) {
      if (response.destroyed || response.headersSent) { response.destroy(); return; }
      // Never echo a request URL, body, cookie, filesystem path or native error.
      const safe = storeError(error,request.method === 'POST');
      response.setHeader('Connection', 'close');
      json(response, safe.status, safe.toWire());
    }
  }
  try { await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  }); } catch (error) { await writer.close(); throw error; }
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true; sessions.invalidate();
    for (const socket of upgraded) socket.destroy();
    const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    try { await development?.close(); await closing; } finally { await writer.close(); }
  }
  try {
    if (options.development) {
      development = await options.development({ server, origin, nonce: developmentNonce!, hmrPath: DEVELOPMENT_HMR_PATH });
      if (!development || typeof development.handle !== 'function' || typeof development.close !== 'function' || !/^[A-Za-z0-9_-]{12,128}$/.test(development.websocketToken)) throw new Error('Invalid development application.');
    }
    await root.recordLaunch(origin);
  } catch (error) { await close(); throw error; }
  return {
    origin, root: root.path, close,
    // Owning local process maintenance. Never registered as an HTTP route.
    rasterMaintenance:{state:()=>writer.rasterWorkerState(),restartIdle:(generation:number)=>writer.restartRasterWorker(generation)},
    issuePairingURL(): string {
      if (closed || rootInvalid) throw new ProtocolError('SERVER_UNAVAILABLE');
      return `${origin}/#pairing=${sessions.issuePairing()}`;
    },
  };
}
