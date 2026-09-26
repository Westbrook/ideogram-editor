import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ABSOLUTE_MS, IDLE_MS, PAIRING_MS } from '../../dist/local/server/sessions.js';
import { fixture, call, pair, tokenFrom, cookieFrom, readHeaders, mutationHeaders, exchange } from './helpers.mjs';

function denied(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.json.protocolVersion, 1);
  assert.match(response.json.requestId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(response.json.error.code, code);
  assert.equal(response.json.error.retry, 'none');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
}

test('SEC01/02: exact OS-selected origin, anonymous shell, authenticated typed session/capabilities', async t => {
  const server = await fixture(t);
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
  const record = JSON.parse(await readFile(join(server.root, 'launch.json')));
  assert.equal(record.origin, server.origin);
  assert.deepEqual(Object.keys(record).sort(), ['origin', 'pid', 'protocolVersion', 'startedAt']);
  const shell = await call(server.origin, '/');
  assert.equal(shell.status, 200);
  assert.equal(shell.headers['referrer-policy'], 'no-referrer');
  assert.equal(shell.headers['x-content-type-options'], 'nosniff');
  assert.ok(shell.headers['content-security-policy'].includes(`connect-src ${server.origin};`));
  for (const policy of ["default-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(shell.headers['content-security-policy'].includes(policy));
  assert.equal(shell.headers['set-cookie'], undefined);
  denied(await call(server.origin, '/api/v1/capabilities', { headers: { Origin: server.origin } }), 401, 'SESSION_REQUIRED');
  const paired = await pair(server);
  assert.equal(paired.status, 200);
  const cookie = cookieFrom(paired);
  assert.match(paired.headers['set-cookie'][0], /^ie_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.match(paired.json.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(cookie.split('=')[1], paired.json.csrfToken);
  assert.deepEqual(Object.keys(paired.json).sort(), ['clientId', 'csrfToken', 'idleExpiresAt', 'protocolVersion', 'sessionExpiresAt']);
  const session = await call(server.origin, '/api/v1/session', { headers: readHeaders(cookie) });
  assert.equal(session.status, 200);
  assert.equal(session.json.clientId, paired.json.clientId);
  const capabilities = await call(server.origin, '/api/v1/capabilities', { headers: readHeaders(cookie) });
  assert.deepEqual(capabilities.json, { protocolVersion: 1, serverVersion: '0.1.0', projectionSchema: 2, credentialConfigured: false,
    storageState: 'unavailable', connectionState: 'unknown', limits: [], profiles: [
      { id: 'LP-1', version: '1', state: 'unqualified' }, { id: 'LS-1', version: '1', state: 'unqualified' },
      { id: 'EF-1', version: '1', state: 'unavailable' }, { id: 'PF-1', version: '1', state: 'unavailable' }] });
});

test('SEC01: hostile hosts, origins, duplicate and forwarded headers do not consume pairing', async t => {
  const server = await fixture(t);
  const token = tokenFrom(server.issuePairingURL());
  const port = new URL(server.origin).port;
  const attacks = [
    ...['evil.test', `localhost:${port}`, `[::1]:${port}`, `127.1:${port}`, `2130706433:${port}`, `0177.0.0.1:${port}`, `127.0.0.1.:${port}`, '127.0.0.1:1', `user@127.0.0.1:${port}`].map(Host => ({ Host })),
    ...['null', 'https://evil.test', `${server.origin}/`, `http://localhost:${port}`, `http://127.1:${port}`, `https://127.0.0.1:${port}`].map(Origin => ({ Origin })),
    { Origin: [server.origin, server.origin] }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
    { Forwarded: `host=127.0.0.1:${port}` }, { 'X-Forwarded-Host': `127.0.0.1:${port}` }, { 'X-Forwarded-Proto': 'http' },
    { 'X-Forwarded-Anything': '' }, { 'Sec-Fetch-Mode': 'navigate' }, { 'Sec-Fetch-Dest': 'image' },
  ];
  for (const attack of attacks) {
    const response = await call(server.origin, '/api/v1/session/bootstrap', { method: 'POST',
      headers: { Origin: server.origin, ...attack }, body: { protocolVersion: 1, pairingToken: token } });
    denied(response, 403, 'ORIGIN_DENIED');
    assert.ok(!response.text.includes(token));
    assert.equal(response.headers['set-cookie'], undefined);
  }
  denied(await call(server.origin, '/api/v1/session/bootstrap', { method: 'POST', body: { protocolVersion: 1, pairingToken: token } }), 403, 'ORIGIN_DENIED');
  assert.equal((await pair(server, token)).status, 200);
});

test('SEC02: missing-Origin reads require both same-origin metadata and LP-1 marker; no navigation bypass', async t => {
  const server = await fixture(t);
  const paired = await pair(server);
  const cookie = cookieFrom(paired);
  for (const headers of [{ Cookie: cookie }, { Cookie: cookie, 'X-App-Client': 'LP-1' },
    { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' }, { ...readHeaders(cookie), 'X-App-Client': 'wrong' },
    { ...readHeaders(cookie), 'Sec-Fetch-Site': 'none' }, { ...readHeaders(cookie), 'Sec-Fetch-Mode': 'navigate' },
    { ...readHeaders(cookie), Origin: 'null' }]) {
    denied(await call(server.origin, '/api/v1/session', { headers }), 403, 'ORIGIN_DENIED');
  }
  assert.equal((await call(server.origin, '/api/v1/session', { headers: readHeaders(cookie) })).status, 200);
  assert.equal((await call(server.origin, '/api/v1/session', { headers: { Cookie: cookie, Origin: server.origin } })).status, 200);
  denied(await call(server.origin, '/api/v1/session', { headers: { ...readHeaders(cookie), Cookie: `${cookie}; ${cookie}` } }), 401, 'SESSION_REQUIRED');
  denied(await call(server.origin, '/api/v1/session', { headers: readHeaders(cookie), raw: Buffer.from('{}') }), 400, 'MALFORMED_REQUEST');
  const head = await call(server.origin, '/api/v1/session', { method: 'HEAD', headers: readHeaders(cookie) });
  assert.equal(head.status, 405); assert.equal(head.headers.allow, 'GET'); assert.equal(head.text, '');
});

test('SEC03: one-use pairing is atomic and expires at precisely five minutes', async t => {
  let now = Date.parse('2026-09-26T00:00:00Z');
  const server = await fixture(t, { now: () => now });
  const token = tokenFrom(server.issuePairingURL());
  const responses = await Promise.all([pair(server, token), pair(server, token)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
  denied(await pair(server, token), 401, 'PAIRING_INVALID');
  const superseded = tokenFrom(server.issuePairingURL());
  const fresh = tokenFrom(server.issuePairingURL());
  denied(await pair(server, superseded), 401, 'PAIRING_INVALID');
  now += PAIRING_MS - 1;
  assert.equal((await pair(server, fresh)).status, 200);
  const expired = tokenFrom(server.issuePairingURL());
  now += PAIRING_MS;
  denied(await pair(server, expired), 401, 'PAIRING_INVALID');
});

test('SEC03: rotation, revoke and concurrent pending mutations invalidate old credentials', async t => {
  const server = await fixture(t);
  const paired = await pair(server);
  const body = { protocolVersion: 1 };
  const headers = mutationHeaders(server, paired);
  for (const csrf of [undefined, '', 'wrong', cookieFrom(paired).split('=')[1]]) {
    const wrong = { ...headers };
    if (csrf === undefined) delete wrong['X-App-CSRF']; else wrong['X-App-CSRF'] = csrf;
    denied(await call(server.origin, '/api/v1/session/renew', { method: 'POST', headers: wrong, body }), 403, 'CSRF_DENIED');
  }
  const responses = await Promise.all([1, 2].map(() => call(server.origin, '/api/v1/session/renew', { method: 'POST', headers, body })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
  const renewed = responses.find(r => r.status === 200);
  assert.equal(renewed.json.clientId, paired.json.clientId);
  assert.equal(renewed.json.sessionExpiresAt, paired.json.sessionExpiresAt);
  assert.notEqual(cookieFrom(renewed), cookieFrom(paired));
  assert.notEqual(renewed.json.csrfToken, paired.json.csrfToken);
  denied(await call(server.origin, '/api/v1/session', { headers: readHeaders(cookieFrom(paired)) }), 401, 'SESSION_REQUIRED');
  denied(await call(server.origin, '/api/v1/session/renew', { method: 'POST', headers: { ...mutationHeaders(server, renewed), 'X-App-CSRF': paired.json.csrfToken }, body }), 403, 'CSRF_DENIED');
  const pending = exchange(server.origin, '/api/v1/session/renew', { method: 'POST', headers: mutationHeaders(server, renewed), raw: Buffer.from(JSON.stringify(body)), defer: true });
  pending.request.write('{');
  const revoked = await call(server.origin, '/api/v1/session/revoke', { method: 'POST', headers: mutationHeaders(server, renewed), body });
  assert.equal(revoked.status, 204); assert.equal(revoked.text, ''); assert.match(revoked.headers['set-cookie'][0], /Max-Age=0/);
  pending.request.end('"protocolVersion":1}');
  denied(await pending.response, 401, 'SESSION_REQUIRED');
  denied(await call(server.origin, '/api/v1/session', { headers: readHeaders(cookieFrom(renewed)) }), 401, 'SESSION_REQUIRED');
});

test('SEC03: exact idle and absolute expiry; valid reads slide idle but renewal cannot extend twelve hours', async t => {
  const start = Date.parse('2026-09-26T00:00:00Z');
  let now = start;
  const server = await fixture(t, { now: () => now });
  const idle = await pair(server);
  assert.equal(idle.json.sessionExpiresAt, new Date(start + ABSOLUTE_MS).toISOString());
  assert.equal(idle.json.idleExpiresAt, new Date(start + IDLE_MS).toISOString());
  now += IDLE_MS;
  denied(await call(server.origin, '/api/v1/session', { headers: readHeaders(cookieFrom(idle)) }), 401, 'SESSION_REQUIRED');
  denied(await call(server.origin, '/api/v1/session/renew', { method: 'POST', headers: mutationHeaders(server, idle), body: { protocolVersion: 1 } }), 401, 'SESSION_REQUIRED');
  let active = await pair(server);
  const absolute = now + ABSOLUTE_MS;
  while (now + IDLE_MS - 1 < absolute) {
    now += IDLE_MS - 1;
    active = await call(server.origin, '/api/v1/session/renew', { method: 'POST', headers: mutationHeaders(server, active), body: { protocolVersion: 1 } });
    assert.equal(active.status, 200);
    assert.equal(active.json.sessionExpiresAt, new Date(absolute).toISOString());
  }
  now = absolute - 1;
  assert.equal((await call(server.origin, '/api/v1/session', { headers: readHeaders(cookieFrom(active)) })).status, 200);
  now = absolute;
  denied(await call(server.origin, '/api/v1/session', { headers: readHeaders(cookieFrom(active)) }), 401, 'SESSION_REQUIRED');
  // Invalid requests cannot keep a session alive.
  const untouched = await pair(server);
  now += IDLE_MS - 1;
  denied(await call(server.origin, '/api/v1/session/renew', { method: 'POST', headers: { ...mutationHeaders(server, untouched), 'X-App-CSRF': 'bad' }, body: { protocolVersion: 1 } }), 403, 'CSRF_DENIED');
  now++;
  denied(await call(server.origin, '/api/v1/session', { headers: readHeaders(cookieFrom(untouched)) }), 401, 'SESSION_REQUIRED');
});

test('LP-1: strict bounded UTF-8 JSON and exact route envelopes reject before pairing effects', async t => {
  const server = await fixture(t);
  const token = tokenFrom(server.issuePairingURL());
  const post = (raw, extra = {}) => call(server.origin, '/api/v1/session/bootstrap', { method: 'POST', headers: { Origin: server.origin, ...extra }, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw) });
  const valid = JSON.stringify({ protocolVersion: 1, pairingToken: token });
  for (const raw of [
    `{"protocolVersion":1,"protocolVersion":1,"pairingToken":"${token}"}`,
    `{"protocolVersion":1,"protocol\\u0056ersion":1,"pairingToken":"${token}"}`,
    valid.replace('"protocolVersion":1', '"protocolVersion":1e999'),
    valid.replace(token, '\\ud800'), valid.replace(token, '\\udc00'),
    valid.replace('"protocolVersion":1', '"protocolVersion":null'),
    valid.replace('"protocolVersion":1', '"protocolVersion":"1"'),
    valid.slice(0, -1) + ',"unknown":{"nested":1,"nested":2}}',
    valid.slice(0, -1) + ',"__proto__":{}}', valid + '{}', '[]', 'null', '',
    Buffer.concat([Buffer.from(valid.slice(0, -1)), Buffer.from([0xff]), Buffer.from('}')]),
  ]) denied(await post(raw), 400, 'MALFORMED_REQUEST');
  denied(await post(valid, { 'Content-Type': 'text/plain' }), 415, 'MEDIA_TYPE');
  denied(await post(valid, { 'Content-Encoding': 'gzip' }), 415, 'MEDIA_TYPE');
  const version = await post(valid.replace('"protocolVersion":1', '"protocolVersion":2'));
  denied(version, 426, 'PROTOCOL_VERSION');
  assert.deepEqual(version.json.error.details, { kind: 'inline', value: { kind: 'protocol-version', supportedVersions: [1] } });
  denied(await post(' '.repeat(65537)), 413, 'PAYLOAD_TOO_LARGE');
  const chunked = exchange(server.origin, '/api/v1/session/bootstrap', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, defer: true });
  chunked.request.end(' '.repeat(65537));
  denied(await chunked.response, 413, 'PAYLOAD_TOO_LARGE');
  for (const path of ['/api/v1/session/bootstrap?pairingToken=' + token, '/api/v1/session/bootstrap?x=1', '/api/v1/session/bootstrap?']) {
    const response = await call(server.origin, path, { method: 'POST', headers: { Origin: server.origin }, raw: Buffer.from(valid) });
    denied(response, 400, 'MALFORMED_REQUEST'); assert.ok(!response.text.includes(token));
  }
  const method = await call(server.origin, '/api/v1/session/bootstrap', { headers: { Origin: server.origin } });
  denied(method, 405, 'METHOD_NOT_ALLOWED'); assert.equal(method.headers.allow, 'POST');
  assert.equal((await post(valid + ' '.repeat(65536 - Buffer.byteLength(valid)))).status, 200);
});

test('P1a boundary: all unfinished routes deny content and mutations; keys never reach responses', async t => {
  const sentinel = 'provider-secret-never-returned';
  const saved = process.env.FAL_KEY;
  process.env.FAL_KEY = sentinel;
  t.after(() => saved === undefined ? delete process.env.FAL_KEY : process.env.FAL_KEY = saved);
  const server = await fixture(t, { credentialConfigured: true });
  const paired = await pair(server);
  for (const path of ['/api/v1/commands', '/api/v1/events/stream', '/api/v1/documents/a', '/api/v1/jobs/a', '/api/v1/assets/a/content', '/api/v1/assets/a/thumbnail', '/api/v1/bundles/a/content', '/api/v1/protocol-content/a', '/api/v1/snapshots/a']) {
    denied(await call(server.origin, path, { headers: { Origin: server.origin } }), 401, 'SESSION_REQUIRED');
    const response = await call(server.origin, path, { headers: { ...readHeaders(cookieFrom(paired)), Range: 'bytes=0-7' } });
    denied(response, 503, 'SERVER_UNAVAILABLE');
    assert.ok(!response.text.includes(sentinel));
  }
  for (const path of ['/api/v1/commands', '/api/v1/assets/staging', '/api/v1/bundles/import']) denied(await call(server.origin, path, { method: 'POST', headers: mutationHeaders(server, paired), body: { protocolVersion: 1 } }), 503, 'SERVER_UNAVAILABLE');
  const cap = await call(server.origin, '/api/v1/capabilities', { headers: readHeaders(cookieFrom(paired)) });
  assert.equal(cap.json.credentialConfigured, true); assert.ok(!cap.text.includes(sentinel));
  for (const path of ['/api/v1/unknown', '/api/v1/session/bootstrap/', '/api/v1/%73ession']) denied(await call(server.origin, path, { headers: readHeaders(cookieFrom(paired)) }), 404, 'NOT_FOUND');
  for (const path of ['/server/http.ts', '/.env', '/launch.json', '/../launch.json', '/%2e%2e/launch.json']) assert.equal((await call(server.origin, path)).status, 404);
});
