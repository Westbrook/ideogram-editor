import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCachePreservingEgress } from '../../tooling/qualification/campaigns/browser-network.mjs';

// Actual literal-loopback proxy transport tests. The small page-shaped adapter
// below verifies proxy challenge state, not browser routing or presentation.
async function origin(t, body) {
  const server = http.createServer((_request, response) => response.end(body));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}

function through(proxy, target) {
  return new Promise((resolve, reject) => {
    const destination = new URL(target), address = new URL(proxy);
    const request = http.get({ hostname: '127.0.0.1', port: address.port, path: target, headers: { host: destination.host }, agent: false }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.once('error', reject);
  });
}

function transportPage(proxy) {
  let current = 'about:blank';
  return { url: () => current, async goto(url) {
    if (url === 'about:blank') { current = url; return null; }
    const value = await through(proxy, url); current = url;
    return { status: () => value.status, headers: () => value.headers, url: () => url,
      request: () => ({ method: () => 'GET' }), fromServiceWorker: () => false, text: async () => value.body };
  } };
}

test('backend replacement removes exactly its previous origin and requires a new route challenge', async t => {
  const first = await origin(t, 'first'), second = await origin(t, 'second'), third = await origin(t, 'third');
  const proxy = await createCachePreservingEgress({ allowedOrigins: [first] }); t.after(() => proxy.close());
  const page = transportPage(proxy.origin);
  await proxy.verifyBrowserRoute(page); assert.equal(proxy.evidence().cachePreserved, true);
  assert.equal((await through(proxy.origin, first + '/')).body, 'first');
  proxy.replaceOwnedOrigin(first, second);
  assert.deepEqual(proxy.evidence().allowedOrigins, [second]);
  assert.equal(proxy.evidence().cachePreserved, false);
  assert.equal((await through(proxy.origin, first + '/')).status, 403);
  assert.equal((await through(proxy.origin, third + '/')).status, 403);
  assert.equal((await through(proxy.origin, second + '/')).body, 'second');
  await proxy.verifyBrowserRoute(page, { origin: second });
  assert.equal(proxy.evidence().cachePreserved, true);
  assert.equal(proxy.evidence().routeVerification.completed, 2);
  assert.equal(proxy.evidence().events.filter(row => row.kind === 'owned-origin-replaced').length, 1);
});

test('stale owner, same origin, aliases and multiple-origin state cannot replace the allowlist', async t => {
  const first = await origin(t, 'first'), second = await origin(t, 'second');
  const proxy = await createCachePreservingEgress({ allowedOrigins: [first] }); t.after(() => proxy.close());
  for (const [before, after] of [[second, first], [first, first], [first, 'http://localhost:1234'], [first, 'https://127.0.0.1:1234']]) {
    assert.throws(() => proxy.replaceOwnedOrigin(before, after), { code: 'CAMPAIGN_PREREQUISITE' });
    assert.deepEqual(proxy.evidence().allowedOrigins, [first]);
  }
  const multiple = await createCachePreservingEgress({ allowedOrigins: [first, second] }); t.after(() => multiple.close());
  assert.throws(() => multiple.replaceOwnedOrigin(first, second), { code: 'CAMPAIGN_PREREQUISITE' });
  assert.deepEqual(multiple.evidence().allowedOrigins, [first, second]);
});

test('origin replacement cannot race an active challenge or revive a closed proxy', async t => {
  const first = await origin(t, 'first'), second = await origin(t, 'second');
  const proxy = await createCachePreservingEgress({ allowedOrigins: [first] }); t.after(() => proxy.close());
  let reject;
  const attempt = proxy.verifyBrowserRoute({ url: () => 'about:blank', goto: () => new Promise((_resolve, fail) => { reject = fail; }) });
  assert.throws(() => proxy.replaceOwnedOrigin(first, second), { code: 'CAMPAIGN_PREREQUISITE' });
  reject(Error('Fixture canceled challenge')); await assert.rejects(attempt, { code: 'CAMPAIGN_PREREQUISITE' });
  await proxy.close();
  assert.throws(() => proxy.replaceOwnedOrigin(first, second), { code: 'CAMPAIGN_PREREQUISITE' });
});
