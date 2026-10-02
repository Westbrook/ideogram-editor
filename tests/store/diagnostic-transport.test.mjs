import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sendDiagnosticResult } from './diagnostic-transport.mjs';

function fixture(value = { settings: { page_count: 7 }, inventory: { z: [2, 1], a: { second: 2, first: 1 } } }) {
  let reads = 0, releases = 0, live = false, callback, sent;
  const channel = new EventEmitter(); channel.connected = true;
  channel.send = (message, done) => { sent = message; callback = done; return false; };
  const writer = { async readDiagnostics() {
    reads++; live = true;
    return { get value() { assert.ok(live); return value; }, release() { assert.ok(live); live = false; releases++; } };
  } };
  return { writer, channel, state: () => ({ reads, releases, live, sent }), finish: error => callback(error) };
}
const message = (method = 'diagnosticScalar', selector = 'settings.page_count') => ({ id: 1, method, args: [selector] });
const turn = () => new Promise(resolve => setImmediate(resolve));

test('diagnostic selectors reject raw graph methods and unknown paths before any read', async () => {
  const f = fixture();
  for (const request of [message('diagnostics'), message('readDiagnostics'), message('diagnosticScalar', 'settings'), message('diagnosticScalar', '__proto__'), message('diagnosticJSON', 'missing'), { ...message(), args: [] }, { ...message(), args: ['settings.page_count', 'extra'] }]) {
    await assert.rejects(sendDiagnosticResult(f.writer, request, f.channel), { code: 'MALFORMED_REQUEST' });
  }
  assert.deepEqual(f.state(), { reads: 0, releases: 0, live: false, sent: undefined });
});

test('backpressure keeps the read alive until the actual IPC callback', async () => {
  const f = fixture(), pending = sendDiagnosticResult(f.writer, message(), f.channel);
  await turn(); assert.equal(f.state().live, true); assert.equal(f.state().releases, 0);
  assert.deepEqual(f.state().sent, { type: 'result', id: 1, result: 7 });
  f.finish(); await pending;
  assert.equal(f.state().releases, 1); assert.equal(f.channel.listenerCount('disconnect'), 0);
});

test('inventory JSON ignores object key order and preserves array order without graph transport', async () => {
  const results = [];
  for (const inventory of [{ z: [2, 1], a: { second: 2, first: 1 } }, { a: { first: 1, second: 2 }, z: [2, 1] }, { a: { first: 1, second: 2 }, z: [1, 2] }]) {
    const f = fixture({ inventory }), pending = sendDiagnosticResult(f.writer, message('diagnosticJSON', 'inventory'), f.channel);
    await turn(); assert.equal(typeof f.state().sent.result, 'string'); results.push(f.state().sent.result);
    f.finish(); await pending; assert.equal(f.state().releases, 1);
  }
  assert.equal(results[0], '{"a":{"first":1,"second":2},"z":[2,1]}');
  assert.equal(results[0], results[1]); assert.notEqual(results[0], results[2]);
});

test('serialized full and core-log views retain evidence while exposing strings only', async () => {
  const value = { node: '26.10.0', sqlite: 'fixture', settings: { page_count: 7 }, filesystem: { mode: 'private' }, resources: { count: 0 }, observations: { rows: ['kept'] }, processMemory: { rss: 3 }, extra: 'full-only' };
  for (const selector of ['all', 'core-log']) {
    const f = fixture(value), pending = sendDiagnosticResult(f.writer, message('diagnosticJSON', selector), f.channel);
    await turn(); const expected = selector === 'all' ? value : { runtime: value.node, sqlite: value.sqlite, settings: value.settings, filesystem: value.filesystem, resources: value.resources, observations: value.observations, memory: value.processMemory };
    assert.equal(f.state().sent.result, JSON.stringify(expected)); assert.equal(f.state().live, true);
    f.finish(); await pending; assert.equal(f.state().releases, 1);
  }
});

test('callback errors release exactly once and remain failures', async () => {
  const f = fixture(), failure = Error('native send failed'), pending = sendDiagnosticResult(f.writer, message(), f.channel);
  const rejected = assert.rejects(pending, failure); await turn(); f.finish(failure); await rejected;
  f.finish(); assert.equal(f.state().releases, 1); assert.equal(f.channel.listenerCount('disconnect'), 0);
});

test('synchronous send failure and serialization failure release the retained read', async () => {
  const f = fixture(), failure = Error('send threw'); f.channel.send = () => { throw failure; };
  await assert.rejects(sendDiagnosticResult(f.writer, message(), f.channel), failure); assert.equal(f.state().releases, 1);
  const big = fixture({ unsupported: 1n });
  await assert.rejects(sendDiagnosticResult(big.writer, message('diagnosticJSON', 'all'), big.channel), TypeError);
  assert.equal(big.state().releases, 1); assert.equal(big.state().sent, undefined);
});

test('definite disconnect releases once; a late callback cannot revive or refund again', async () => {
  const f = fixture(), pending = sendDiagnosticResult(f.writer, message(), f.channel);
  const rejected = assert.rejects(pending, /disconnected/); await turn();
  f.channel.connected = false; f.channel.emit('disconnect'); await rejected;
  f.finish(); assert.equal(f.state().releases, 1); assert.equal(f.channel.listenerCount('disconnect'), 0);
});
