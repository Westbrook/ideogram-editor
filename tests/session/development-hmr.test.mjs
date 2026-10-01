import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {createHash} from 'node:crypto';
import {fixture, call, pair, cookieFrom, readHeaders} from './helpers.mjs';
import {DEVELOPMENT_HMR_PATH, startLocalServer} from '../../dist/local/server/http.js';

const token = 'owned_vite_token_1234';
function upgrade(origin, {path = `${DEVELOPMENT_HMR_PATH}?token=${token}`, headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = request({hostname: '127.0.0.1', port: url.port, path, headers: Object.fromEntries(Object.entries({
      Connection: 'Upgrade', Upgrade: 'websocket', Origin: origin,
      'Sec-WebSocket-Key': 'MDEyMzQ1Njc4OWFiY2RlZg==', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'vite-hmr', ...headers,
    }).filter(([, value]) => value !== undefined)), agent: false});
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.on('error', error => { if (error.code === 'ECONNRESET') resolve(0); else reject(error); });
    req.setTimeout(2000, () => req.destroy(Error('Unexpected upgrade timeout'))); req.end();
  });
}
function application(observed) {
  return async ({server, origin, nonce, hmrPath}) => {
    observed.context = {origin, nonce, hmrPath};
    const listener = (req, socket) => {
      observed.upgrades.push(req.url);
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`);
    };
    server.on('upgrade', listener);
    return {websocketToken: token, handle: async (req, res) => { observed.requests.push(req.url); res.writeHead(200, {'Content-Type': 'text/javascript'}); res.end('export const development = true;'); },
      close: async () => { observed.closed++; server.off('upgrade', listener); }};
  };
}

test('development source serving preserves Host/Origin guards and real session API routing', async t => {
  const observed = {requests: [], upgrades: [], closed: 0}, server = await fixture(t, {development: application(observed)});
  assert.equal(observed.context.origin, server.origin); assert.equal(observed.context.hmrPath, DEVELOPMENT_HMR_PATH);
  const source = await call(server.origin, '/src/main.ts?t=123', {headers: {Origin: server.origin}});
  assert.equal(source.status, 200);
  const csp = source.headers['content-security-policy'];
  assert.ok(csp.includes(`connect-src ${server.origin} ${server.origin.replace('http:', 'ws:')};`));
  assert.ok(csp.includes(`'nonce-${observed.context.nonce}'`)); assert.ok(!csp.includes("'unsafe-inline'"));
  const head = await call(server.origin, '/src/main.ts', {method: 'HEAD', headers: {Origin: server.origin}});
  assert.equal(head.status, 200); assert.equal(head.text, '');
  for (const headers of [{Origin: 'https://foreign.test'}, {Host: 'localhost:' + new URL(server.origin).port}, {'X-Forwarded-Host': new URL(server.origin).host}, {'Sec-Fetch-Site': 'cross-site'}]) {
    assert.equal((await call(server.origin, '/src/main.ts', {headers})).status, 403);
  }
  assert.equal(observed.requests.length, 2);
  assert.equal((await call(server.origin, '/api/v1/session', {headers: {Origin: server.origin}})).status, 401);
  const paired = await pair(server); assert.equal(paired.status, 200);
  const session = await call(server.origin, '/api/v1/session', {headers: readHeaders(cookieFrom(paired))});
  assert.equal(session.status, 200); assert.equal(observed.requests.length, 2);
  assert.ok(session.headers['content-security-policy'].includes(`connect-src ${server.origin};`));
  assert.ok(!session.headers['content-security-policy'].includes('ws:'));
  await server.close(); assert.equal(observed.closed, 1);
});

test('development websocket gate runs before attached Vite-style listeners', async t => {
  const observed = {requests: [], upgrades: [], closed: 0}, server = await fixture(t, {development: application(observed)});
  assert.equal(await upgrade(server.origin), 101); assert.equal(observed.upgrades.length, 1);
  for (const attack of [
    {headers: {Origin: 'https://foreign.test'}}, {headers: {Origin: undefined}},
    {headers: {Host: 'localhost:' + new URL(server.origin).port}},
    {headers: {Origin: [server.origin, server.origin]}}, {headers: {'Sec-WebSocket-Protocol': ['vite-hmr', 'vite-hmr']}},
    {headers: {'Sec-WebSocket-Protocol': 'other'}}, {headers: {'X-Forwarded-For': '127.0.0.1'}},
    {headers: {'Sec-Fetch-Site': 'cross-site'}}, {headers: {'Sec-Fetch-Mode': 'navigate'}},
    {path: '/api/v1/session?token=' + token}, {path: '/?token=' + token},
    {path: DEVELOPMENT_HMR_PATH + '?token=wrong'}, {path: DEVELOPMENT_HMR_PATH + '?token=' + token + '&token=' + token},
  ]) {
    assert.notEqual(await upgrade(server.origin, attack), 101);
  }
  assert.equal(observed.upgrades.length, 1); assert.equal(observed.requests.length, 0);
});

test('production keeps its original CSP and rejects even a valid-shaped development upgrade', async t => {
  const server = await fixture(t);
  const response = await call(server.origin, '/');
  assert.ok(response.headers['content-security-policy'].includes(`connect-src ${server.origin};`));
  assert.ok(!response.headers['content-security-policy'].includes('nonce-'));
  assert.equal(await upgrade(server.origin), 0);
  await assert.rejects(startLocalServer({root: server.root, development: application({}), staticDirectory: server.directory}), /Development application/);
  await assert.rejects(startLocalServer({root: server.root, development: application({}), credentialConfigured: true}), /Development application/);
});
