import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical } from '../../dist/local/src/protocol/json.js';
import { loadProviderConfiguration } from '../../dist/local/server/provider/config.js';
import { PRODUCTION_PRIVACY, PRODUCTION_PROFILE } from '../../dist/local/server/provider/production-profile.js';
import { fixture, call, pair, cookieFrom, readHeaders, mutationHeaders } from '../session/helpers.mjs';
import { egressAttempts } from './no-egress.mjs';

const sentinel = 'fal-http-sentinel-not-a-credential';
function configuration() {
  const now = Date.now();
  const manifest = { schemaVersion: 1, id: 'http-approval',
    approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
    endpoint: 'ideogram/v4', operation: 'generate', maxRequests: 2, maxImages: 2,
    output: { width: 1024, height: 1024, count: 1, format: 'png' }, expansion: 'None',
    profileId: PRODUCTION_PROFILE.id, profileVersion: PRODUCTION_PROFILE.version,
    evidenceDigest: PRODUCTION_PROFILE.evidenceDigest, disclosureDigest: PRODUCTION_PRIVACY.disclosureDigest,
    acknowledgeChargeAndPrivacy: true };
  return { mode: 'fal', manifest, manifestHash: createHash('sha256').update(canonical(manifest)).digest('hex'), key: sentinel };
}
async function paired(t, options = {}) {
  const server = await fixture(t, options), session = await pair(server);
  assert.equal(session.status, 200);
  const headers = readHeaders(cookieFrom(session));
  return { server, session, headers, read: path => call(server.origin, path, { headers }) };
}
function publicResponse(response, server) {
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.text.includes(sentinel), false);
  assert.equal(response.text.includes(server.root), false);
  assert.equal(Object.hasOwn(response.json, 'key'), false);
  assert.equal(Object.hasOwn(response.json, 'manifest'), false);
}
function denied(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.json.error.code, code);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.text.includes(sentinel), false);
}

test('provider HTTP defaults disabled and exposes no credential or local configuration', async t => {
  const x = await paired(t), response = await x.read('/api/v1/provider');
  publicResponse(response, x.server);
  assert.deepEqual(Object.keys(response.json).sort(), ['protocolVersion', 'mode', 'ready', 'state',
    'configurationId', 'configurationHash', 'epoch', 'credentialConfigured', 'operation', 'endpoint',
    'profile', 'limits', 'message'].sort());
  assert.equal(response.json.protocolVersion, 1);
  assert.equal(response.json.mode, 'disabled');
  assert.equal(response.json.state, 'disabled');
  assert.equal(response.json.ready, false);
  assert.equal(response.json.credentialConfigured, false);
  assert.equal(response.json.configurationId, null);
  assert.equal(response.json.configurationHash, null);
  assert.equal(response.json.profile, null);
  assert.equal(response.json.limits, null);
  assert.match(response.json.epoch, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal((await x.read('/api/v1/capabilities')).json.credentialConfigured, false);
  assert.deepEqual(egressAttempts(), []);
});

test('configured provider HTTP returns only bounded public approval and privacy fields', async t => {
  const provider = configuration(), x = await paired(t, { provider, credentialConfigured: false });
  const response = await x.read('/api/v1/provider');
  publicResponse(response, x.server);
  assert.equal(response.json.mode, 'fal');
  assert.equal(response.json.state, 'ready');
  assert.equal(response.json.ready, true);
  assert.equal(response.json.credentialConfigured, true);
  assert.equal(response.json.configurationId, provider.manifest.id);
  assert.equal(response.json.configurationHash, provider.manifestHash);
  assert.equal(response.json.endpoint, 'ideogram/v4');
  assert.equal(response.json.operation, 'generate');
  assert.deepEqual(response.json.profile, PRODUCTION_PRIVACY);
  assert.deepEqual(response.json.limits, { maximumRequests: 2, maximumImages: 2, usedRequests: 0,
    usedImages: 0, width: 1024, height: 1024, imagesPerRequest: 1, format: 'png', expansion: 'None',
    expiresAt: provider.manifest.expiresAt });
  const capabilities = await x.read('/api/v1/capabilities');
  publicResponse(capabilities, x.server);
  assert.equal(capabilities.json.credentialConfigured, true);
  const queue = await x.read('/api/v1/queue');
  assert.deepEqual(queue.json.jobs, []);
  assert.deepEqual(queue.json.counts, { reserved: 0, dispatched: 0, remaining: null, active: 0 });
  assert.deepEqual(egressAttempts(), []);
});

test('provider HTTP requires a paired same-origin session and accepts only exact GET reads', async t => {
  const x = await paired(t, { provider: configuration() }), { server, session, headers } = x;
  denied(await call(server.origin, '/api/v1/provider', { headers: { Origin: server.origin } }), 401, 'SESSION_REQUIRED');
  denied(await call(server.origin, '/api/v1/provider', { headers: { Cookie: cookieFrom(session) } }), 403, 'ORIGIN_DENIED');
  denied(await call(server.origin, '/api/v1/provider', { headers: { ...headers, Origin: 'https://example.com' } }), 403, 'ORIGIN_DENIED');
  const post = await call(server.origin, '/api/v1/provider', { method: 'POST',
    headers: mutationHeaders(server, session), body: { mode: 'fal', key: sentinel } });
  denied(post, 405, 'METHOD_NOT_ALLOWED');
  assert.equal(post.headers.allow, 'GET');
  for (const query of ['?', '?mode=fal', '?key=' + sentinel, '?configurationId=http-approval', '?x=%']) {
    denied(await x.read('/api/v1/provider' + query), 400, 'MALFORMED_REQUEST');
  }
  const head = await call(server.origin, '/api/v1/provider', { method: 'HEAD', headers });
  assert.equal(head.status, 405);
  assert.equal(head.headers.allow, 'GET');
  assert.equal(head.text, '');
  assert.equal((await x.read('/api/v1/provider')).json.state, 'ready');
  const revoked = await call(server.origin, '/api/v1/session/revoke', { method: 'POST',
    headers: mutationHeaders(server, session), body: { protocolVersion: 1 } });
  assert.equal(revoked.status, 204);
  denied(await x.read('/api/v1/provider'), 401, 'SESSION_REQUIRED');
  assert.deepEqual(egressAttempts(), []);
});

test('explicit disabled configuration overrides credential display hints and an ambient key cannot enable it', async t => {
  const provider = loadProviderConfiguration({ FAL_KEY: sentinel });
  assert.deepEqual(provider, { mode: 'disabled' });
  const disabled = await paired(t, { provider, credentialConfigured: true });
  const view = await disabled.read('/api/v1/provider'), capabilities = await disabled.read('/api/v1/capabilities');
  publicResponse(view, disabled.server);
  publicResponse(capabilities, disabled.server);
  assert.equal(view.json.mode, 'disabled');
  assert.equal(view.json.credentialConfigured, false);
  assert.equal(capabilities.json.credentialConfigured, false);
  // Existing embedders may retain their display-only hint without runtime authority.
  const legacy = await paired(t, { credentialConfigured: true });
  assert.equal((await legacy.read('/api/v1/capabilities')).json.credentialConfigured, true);
  const legacyView = await legacy.read('/api/v1/provider');
  publicResponse(legacyView, legacy.server);
  assert.equal(legacyView.json.mode, 'disabled');
  assert.equal(legacyView.json.ready, false);
  assert.equal(legacyView.json.credentialConfigured, false);
  assert.deepEqual(egressAttempts(), []);
});
