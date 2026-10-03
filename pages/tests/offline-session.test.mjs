import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionClient } from '../offline-session-client.ts';

// Import the real Pages-only shim directly under Node's TypeScript support.
// The repository no-network preload remains installed throughout these cases.
function guardedClient(t) {
  const guard = globalThis.__storeNetworkCounters;
  assert.equal(typeof guard?.read, 'function', 'Run beneath tests/store/no-network.mjs');
  const networkBefore = guard.read(), storageAccesses = [], descriptors = new Map();
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'document']) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, get() {
      storageAccesses.push(name); throw Error(`Unexpected browser persistence access: ${name}`);
    } });
  }
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
    assert.deepEqual(storageAccesses, [], 'The offline client must not read or write browser persistence or cookies');
    assert.deepEqual(guard.read(), networkBefore, 'No attempted network operation may be hidden by a caught error');
  });
  return createSessionClient();
}
function offline(client, secret = 'one-use-pairing-token') {
  const state = client.state.value.get();
  assert.equal(state.connection, 'offline'); assert.equal(state.busy, false);
  assert.equal(state.capabilities, null); assert.equal(state.expiresAt, null);
  assert.match(state.message, /offline.*preview/i); assert.match(state.message, /local editor/i);
  assert.equal(client.identity(), null); assert.equal(client.csrf(), '');
  assert.deepEqual(client.ownership, { controlReads: 0, controlCleanupFailures: 0, sessionModels: 0 });
  assert.equal(JSON.stringify(state).includes(secret), false);
}

test('Pages session begins offline without an identity, capabilities, credentials or owned requests', async t => {
  const client = guardedClient(t); offline(client);
  assert.deepEqual(client.renderCapabilities(null), []);
  await client.dispose(); offline(client);
});

test('pairing, checks, renewal and disconnect remain offline without persisting the supplied token', async t => {
  const client = guardedClient(t), secret = 'one-use-pairing-token';
  for (const action of [() => client.start(secret), () => client.start(), () => client.resume(),
    () => client.renew(), () => client.revoke(), () => client.release(), () => client.dispose(),
    () => client.start(secret), () => client.resume()]) {
    const completion = action(); offline(client, secret);
    await completion; offline(client, secret);
  }
  await client.dispose(); offline(client, secret);
});

test('overlapping lifecycle calls and repeated cleanup cannot create a connection or request owner', async t => {
  const client = guardedClient(t), pending = [client.start('one-use-pairing-token'), client.resume(),
    client.renew(), client.revoke(), client.dispose(), client.release(), client.dispose()];
  offline(client);
  await Promise.all(pending); offline(client);
  await Promise.all([client.start(), client.dispose(), client.release()]); offline(client);
});

test('every offline transport operation refuses before network effects or request-option access', async t => {
  const client = guardedClient(t);
  await client.start('one-use-pairing-token');
  for (const [path, method] of [['/api/v1/session', 'GET'], ['/api/v1/capabilities', 'HEAD'],
    ['/api/v1/commands', 'POST'], ['/api/v1/session/revoke', 'DELETE'],
    ['https://example.invalid/provider', 'PUT']]) {
    await assert.rejects(client.transport(path, { method, credentials: 'include', headers: { Authorization: 'one-use-pairing-token' } }), /^Error: PAGES_OFFLINE$/);
    offline(client);
  }
  const init = new Proxy({}, { get() { assert.fail('An offline refusal must not inspect or retain request credentials'); } });
  await assert.rejects(client.transport('/api/v1/commands', init), /^Error: PAGES_OFFLINE$/);
  await client.dispose();
  await assert.rejects(client.transport('/api/v1/session'), /^Error: PAGES_OFFLINE$/);
  offline(client);
});

test('caller-supplied capabilities cannot grant authority or allocate render owners', async t => {
  const client = guardedClient(t);
  const capabilities = { protocolVersion: 1, limits: [], profiles: [{ name: 'invented-provider-capability' }] };
  assert.throws(() => client.renderCapabilities(capabilities), /SESSION_CAPABILITIES_UNOWNED/);
  offline(client); assert.deepEqual(client.renderCapabilities(null), []);
  await client.resume(); await client.release();
  assert.throws(() => client.renderCapabilities(capabilities), /SESSION_CAPABILITIES_UNOWNED/);
  await client.dispose(); offline(client);
});
