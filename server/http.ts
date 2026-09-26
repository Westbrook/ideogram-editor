import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { CapabilitiesView } from '../src/protocol/session.js';
import { ProtocolError } from './errors.js';
import { readSessionRequest } from './control-json.js';
import { Sessions, readCookie, sessionCookie, expiredCookie } from './sessions.js';
import { assertSeparateDirectories, preparePrivateRoot } from './private-root.js';
import { BOOTSTRAP_CSP, loadStatic } from './static.js';

export type ServerOptions = { root: string; staticDirectory?: string; now?: () => number; credentialConfigured?: boolean };
const methods: Record<string, readonly string[]> = {
  '/api/v1/session/bootstrap': ['POST'], '/api/v1/session': ['GET'],
  '/api/v1/session/renew': ['POST'], '/api/v1/session/revoke': ['POST'], '/api/v1/capabilities': ['GET'],
};
const unavailable = /^\/api\/v1\/(?:commands|events|documents|jobs|assets|bundles|snapshots|protocol-content|recovery)(?:\/|$)/;

function securityHeaders(response: ServerResponse, origin: string): void {
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' ${BOOTSTRAP_CSP}; style-src 'self'; connect-src ${origin}; img-src 'self' blob:; font-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
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
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new ProtocolError('ORIGIN_DENIED');
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

export async function startLocalServer(options: ServerOptions) {
  const root = await preparePrivateRoot(options.root);
  if (options.staticDirectory) {
    await assertSeparateDirectories(root.path, options.staticDirectory);
  }
  const files = await loadStatic(options.staticDirectory);
  const wall = Date.now();
  const monotonic = performance.now();
  const sessions = new Sessions(options.now ?? (() => wall + performance.now() - monotonic));
  let origin = '';
  let rootInvalid = false;
  let closed = false;
  const capabilities: CapabilitiesView = {
    protocolVersion: 1, serverVersion: '0.1.0', projectionSchema: 2,
    credentialConfigured: options.credentialConfigured ?? false,
    storageState: 'unavailable', connectionState: 'unknown', limits: [],
    profiles: [
      { id: 'LP-1', version: '1', state: 'unqualified' },
      { id: 'LS-1', version: '1', state: 'unqualified' },
      { id: 'EF-1', version: '1', state: 'unavailable' },
      { id: 'PF-1', version: '1', state: 'unavailable' },
    ],
  };
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
    void handle(request, response);
  });
  server.setTimeout(15_000, socket => socket.destroy());
  // There is no websocket/proxy tunnel or development security exemption.
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });

  async function assertRoot(): Promise<void> {
    try { if (rootInvalid || closed) throw new Error(); await root.assertUnchanged(); }
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
      // This display flag is never a return URL or an authentication input.
      if (query !== undefined) {
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
        const allow = methods[path];
        if (!allow) throw new ProtocolError(unavailable.test(path) ? 'SERVER_UNAVAILABLE' : 'NOT_FOUND');
        if (!allow.includes(request.method!)) { response.setHeader('Allow', allow.join(', ')); throw new ProtocolError('METHOD_NOT_ALLOWED'); }
        if (bootstrap) {
          const body = await readSessionRequest(request, true);
          await assertRoot();
          const paired = sessions.bootstrap(body.pairingToken as string, cookie);
          response.setHeader('Set-Cookie', sessionCookie(paired.cookie));
          json(response, 200, paired.view);
        } else if (mutation) {
          await readSessionRequest(request, false);
          await assertRoot();
          // Body reads can yield: recheck expiry/revocation/rotation after them.
          const session = sessions.authenticate(cookie, String(request.headers['x-app-csrf'] ?? ''));
          if (path.endsWith('/renew')) {
            const renewed = sessions.renew(session);
            response.setHeader('Set-Cookie', sessionCookie(renewed.cookie));
            json(response, 200, renewed.view);
          } else {
            sessions.revoke(session);
            response.setHeader('Set-Cookie', expiredCookie);
            response.writeHead(204); response.end();
          }
        } else {
          const view = sessions.view(sessions.authenticate(cookie));
          json(response, 200, path === '/api/v1/session' ? view : capabilities);
        }
      } else {
        const file = files.get(path);
        if (!file) throw new ProtocolError('NOT_FOUND');
        if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw new ProtocolError('METHOD_NOT_ALLOWED'); }
        if (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) throw new ProtocolError('MALFORMED_REQUEST');
        response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.bytes.length });
        response.end(file.bytes);
      }
    } catch (error) {
      if (response.destroyed || response.headersSent) { response.destroy(); return; }
      // Never echo a request URL, body, cookie, filesystem path or native error.
      const safe = error instanceof ProtocolError ? error : new ProtocolError('SERVER_UNAVAILABLE');
      response.setHeader('Connection', 'close');
      json(response, safe.status, safe.toWire());
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true; sessions.invalidate();
    const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closing;
  }
  try { await root.recordLaunch(origin); } catch (error) { await close(); throw error; }
  return {
    origin, root: root.path, close,
    issuePairingURL(): string {
      if (closed || rootInvalid) throw new ProtocolError('SERVER_UNAVAILABLE');
      return `${origin}/#pairing=${sessions.issuePairing()}`;
    },
  };
}
