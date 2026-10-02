import test from 'node:test';
import assert from 'node:assert/strict';
import {createContext, runInContext} from 'node:vm';
import {installE4DeliveryObserver} from './e4-delivery-observer.mjs';

const origin = 'http://127.0.0.1:4381';
const encode = value => new TextEncoder().encode(value);
const plain = value => JSON.parse(JSON.stringify(value));
const queueText = (id = 'job-1') => JSON.stringify({jobs: [{id, version: '2', attempts: [{secret: 'not retained'}]}], private: 'not retained'});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };

// Each installation gets its own JSON and window. Native stream/response
// instances are real; instrumentation below only records their original calls.
// No host global or native prototype is patched, and no request leaves this VM.
function fixture(t, options = {}) {
  const fetchCalls = [], incoming = [], resources = [], clock = {wall: 100, monotonic: 20};
  class ClockDate extends Date { static now() { return clock.wall; } }
  function originalFetch(...args) {
    const call = {receiver: this, args}; fetchCalls.push(call);
    const next = incoming.shift();
    if (!next) throw Error('Unexpected fixture fetch');
    if (next.throw) { call.error = next.throw; throw next.throw; }
    call.promise = next.promise ?? (next.reject ? Promise.reject(next.reject) : Promise.resolve(next.response));
    return call.promise;
  }
  const context = createContext({fetch: originalFetch, Request, Response, Headers, ReadableStream,
    ReadableStreamDefaultReader, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, URL,
    Date: ClockDate, performance: {now: () => clock.monotonic}, location: {href: origin + '/', origin}, __options: options});
  runInContext(`'use strict'; globalThis.window = globalThis;
    globalThis.__parseCalls = [];
    const originalParse = JSON.parse;
    JSON.parse = function (...args) {
      const call = {receiver:this,args}; __parseCalls.push(call);
      try { return call.value = Reflect.apply(originalParse,this,args); }
      catch(error) { call.error = error; throw error; }
    };
    globalThis.__baselineParse = JSON.parse;`, context);
  const json = runInContext('JSON', context), baselineParse = json.parse;
  t.after(async () => {
    context.__p25DeliveryObserver?.dispose();
    for (const resource of resources.reverse()) {
      for (const reader of resource.readers) { try { await reader.cancel('fixture cleanup'); } catch {} try { reader.releaseLock(); } catch {} }
      if (!resource.response.body.locked) { try { await resource.response.body.cancel('fixture cleanup'); } catch {} }
    }
    assert.equal(context.fetch, originalFetch);
    assert.equal(json.parse, baselineParse);
  });
  runInContext(`(${installE4DeliveryObserver.toString()})(__options)`, context);
  const observer = context.__p25DeliveryObserver;
  function response(text, {path = '/api/v1/queue', length = encode(text).length, contentType = 'application/json', status = 200} = {}) {
    let controller;
    const calls = {getReader: [], read: [], cancel: [], json: [], streamCancel: [], forbidden: []};
    const stream = new ReadableStream({start(value) { controller = value; }, cancel(reason) { calls.streamCancel.push(reason); }}, {highWaterMark: 0});
    const value = new Response(stream, {status, headers: {'content-type': contentType, ...(length === null ? {} : {'content-length': String(length)})}});
    Object.defineProperty(value, 'url', {configurable: true, value: new URL(path, origin).href});
    const readers = [], getReader = stream.getReader, jsonMethod = value.json;
    const record = {response: value, controller, calls, readers, text}; resources.push(record);
    stream.getReader = function (...args) {
      const call = {receiver: this, args}; calls.getReader.push(call);
      try { call.reader = Reflect.apply(getReader, this, args); }
      catch (error) { call.error = error; throw error; }
      const reader = call.reader, read = reader.read, cancel = reader.cancel;
      readers.push(reader);
      reader.read = function (...readArgs) {
        const entry = {receiver: this, args: readArgs}; calls.read.push(entry);
        try { return entry.promise = Reflect.apply(read, this, readArgs); }
        catch (error) { entry.error = error; throw error; }
      };
      reader.cancel = function (...cancelArgs) {
        const entry = {receiver: this, args: cancelArgs}; calls.cancel.push(entry);
        try { return entry.promise = Reflect.apply(cancel, this, cancelArgs); }
        catch (error) { entry.error = error; throw error; }
      };
      return reader;
    };
    value.json = function (...args) {
      const call = {receiver: this, args}; calls.json.push(call);
      try { return call.promise = Reflect.apply(jsonMethod, this, args); }
      catch (error) { call.error = error; throw error; }
    };
    for (const [target, key] of [[value, 'clone'], [value, 'text'], [stream, 'tee']]) {
      target[key] = () => { calls.forbidden.push(key); throw Error('Observer must not call ' + key); };
    }
    record.originals = {getReader: stream.getReader, json: value.json};
    return record;
  }
  async function fetchResponse(record, path = record.response.url, init) {
    incoming.push({response: record.response});
    const promise = init === undefined ? context.fetch(path) : context.fetch(path, init);
    assert.equal(promise, fetchCalls.at(-1).promise, 'fetch returns its original promise');
    assert.equal(await promise, record.response, 'fetch returns its original response');
    return record.response;
  }
  async function consume(record, chunks = [encode(record.text)]) {
    await fetchResponse(record);
    const reader = record.response.body.getReader();
    assert.equal(reader, record.calls.getReader.at(-1).reader);
    for (const chunk of chunks) {
      record.controller.enqueue(chunk);
      const promise = reader.read();
      assert.equal(promise, record.calls.read.at(-1).promise);
      const result = await promise;
      assert.equal(result.value, chunk);
      assert.equal(result.done, false);
    }
    record.controller.close();
    const done = reader.read();
    assert.equal(done, record.calls.read.at(-1).promise);
    assert.equal((await done).done, true);
    reader.releaseLock();
    return reader;
  }
  return {context, json, observer, clock, incoming, fetchCalls, originalFetch, response, fetchResponse, consume,
    parse: (...args) => Reflect.apply(json.parse, json, args), rows: () => context.__p25Deliveries, errors: () => context.__p25DeliveryErrors};
}

test('serialized installation preserves fetch, reader, parse and cancel identities without consuming ahead', async t => {
  const f = fixture(t), text = queueText(), r = f.response(text), receiver = {fetchReceiver: true}, init = runInContext('({method:"GET"})', f.context), input = new Request(r.response.url);
  f.incoming.push({response: r.response});
  const fetched = Reflect.apply(f.context.fetch, receiver, [input, init]);
  assert.equal(fetched, f.fetchCalls[0].promise);
  assert.equal(f.fetchCalls[0].receiver, receiver);
  assert.equal(f.fetchCalls[0].args[0], input); assert.equal(f.fetchCalls[0].args[1], init);
  assert.equal(await fetched, r.response);
  assert.equal(r.response.bodyUsed, false); assert.equal(r.calls.read.length, 0); assert.deepEqual(r.calls.forbidden, []);
  const readerOptions = {}, reader = r.response.body.getReader(readerOptions);
  assert.equal(reader, r.calls.getReader[0].reader); assert.equal(r.calls.getReader[0].receiver, r.response.body);
  assert.equal(r.calls.getReader[0].args[0], readerOptions);
  const chunk = encode(text), readArgument = {ignoredByNativeRead: true}; r.controller.enqueue(chunk);
  const pending = reader.read(readArgument), nativePending = r.calls.read[0].promise;
  assert.equal(pending, nativePending); assert.equal(r.calls.read[0].receiver, reader); assert.equal(r.calls.read[0].args[0], readArgument);
  const result = await pending; assert.equal(result, await nativePending); assert.equal(result.value, chunk);
  assert.equal(f.rows().length, 0); assert.equal(r.calls.read.length, 1);
  f.parse(text); assert.equal(f.rows().length, 0, 'complete bytes alone are not EOF');
  r.controller.close(); await reader.read();
  assert.equal(f.rows().length, 0, 'EOF alone is not a parse delivery');
  f.parse(text); assert.equal(f.rows().length, 0, 'a reader still holding its lock is not a completed consumer');
  assert.equal(reader.releaseLock(), undefined);
  f.clock.wall = 800; f.clock.monotonic = 75;
  const parseReceiver = {parseReceiver: true}, parsed = Reflect.apply(f.json.parse, parseReceiver, [text]);
  const parseCall = f.context.__parseCalls.at(-1);
  assert.equal(parseCall.receiver, parseReceiver); assert.equal(parseCall.args[0], text); assert.equal(parsed, parseCall.value);
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].at, 800); assert.equal(f.rows()[0].monotonic, 75);
  assert.equal(f.rows()[0].origin, origin); assert.equal(f.rows()[0].url, r.response.url); assert.equal(f.rows()[0].status, 200); assert.equal(f.rows()[0].method, 'GET');
  assert.equal(f.rows()[0].source, 'original-reader-json-parse'); assert.equal(f.observer.snapshot().retainedBytes, 0);
  assert.equal(r.calls.read.length, 2); assert.deepEqual(r.calls.forbidden, []); assert.equal(f.errors().length, 0);
  assert.equal(r.response.json, r.originals.json); assert.equal(r.response.body.getReader, r.originals.getReader);
  assert.equal(f.observer.snapshot().ownedMethods, 0, 'consumed responses do not accumulate method restorers');
});

test('only an exact unique completed text qualifies, and equal bodies cannot be assigned by FIFO', async t => {
  const f = fixture(t), text = queueText(), first = f.response(text), second = f.response(text, {path: '/api/v1/jobs/job-1/candidates?poll=2'});
  await f.consume(first);
  f.parse(' ' + text); f.parse(' ' + text, (_key, value) => value); f.parse({toString: () => text});
  assert.equal(f.rows().length, 0); assert.equal(f.observer.snapshot().pending, 1);
  await f.consume(second);
  const parsed = f.parse(text); assert.equal(parsed.jobs[0].id, 'job-1');
  assert.equal(f.rows().length, 0); assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.observer.snapshot().retainedBytes, 0);
  assert.equal(f.observer.snapshot().disabled, true); assert.ok(f.errors().some(error => error.code === 'E4_OBSERVER_AMBIGUOUS_BODY'));
  f.parse(text); assert.equal(f.rows().length, 0);
});

test('a reviver keeps its native result and retires the unmatched observation instead of qualifying a later parse', async t => {
  const f = fixture(t), text = queueText(); await f.consume(f.response(text));
  const reviver = (key, value) => key === 'id' ? 'revived' : value;
  const result = f.parse(text, reviver), call = f.context.__parseCalls.at(-1);
  assert.equal(result, call.value); assert.equal(call.args[1], reviver); assert.equal(result.jobs[0].id, 'revived');
  assert.equal(f.rows().length, 0); assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.observer.snapshot().retainedBytes, 0);
  assert.equal(f.parse(text).jobs[0].id, 'job-1'); assert.equal(f.rows().length, 0);
});

test('chunk joins use exact bytes through EOF, including split multibyte UTF-8', async t => {
  const f = fixture(t), text = queueText('Café-東京-😀'), bytes = encode(text), r = f.response(text);
  await f.consume(r, [...bytes].map(byte => Uint8Array.of(byte)));
  assert.equal(f.rows().length, 0); assert.equal(f.parse(text).jobs[0].id, 'Café-東京-😀');
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].value.jobs[0].id, 'Café-東京-😀');
  assert.equal(r.calls.read.length, bytes.length + 1); assert.equal(f.errors().length, 0);
});

test('UTF-8 faults, BOM and wrong byte lengths never fabricate parse delivery', async t => {
  const text = queueText(), bytes = encode(text);
  const cases = [
    {name: 'invalid continuation', bytes: Uint8Array.of(0xc3, 0x28), length: 2, parse: text},
    {name: 'truncated code point', bytes: Uint8Array.of(0xf0, 0x9f, 0x98), length: 3, parse: text},
    {name: 'short body', bytes, length: bytes.length + 1, parse: text},
    {name: 'long body', bytes, length: bytes.length - 1, parse: text},
    {name: 'BOM is not silently removed', bytes: Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes]), length: bytes.length + 3, parse: '\ufeff' + text, syntax: true},
  ];
  for (const item of cases) await t.test(item.name, async t => {
    const f = fixture(t), r = f.response(text, {length: item.length}); await f.consume(r, [item.bytes]);
    if (item.syntax) {
      assert.throws(() => f.parse(item.parse), error => error === f.context.__parseCalls.at(-1).error);
      assert.equal(f.errors().length, 0, 'application parse errors are not observer failures');
    } else { assert.equal(f.parse(item.parse).jobs[0].id, 'job-1'); assert.ok(f.errors().length > 0); }
    assert.equal(f.rows().length, 0); assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.observer.snapshot().retainedBytes, 0);
  });
});

test('consumer cancellation, stream rejection and parse failure keep native outcomes and release pending data', async t => {
  for (const mode of ['cancel', 'read-error', 'parse-error']) await t.test(mode, async t => {
    const f = fixture(t), text = mode === 'parse-error' ? '{"jobs":[' : queueText(), r = f.response(text);
    if (mode === 'parse-error') {
      await f.consume(r);
      assert.throws(() => f.parse(text), error => error === f.context.__parseCalls.at(-1).error);
    } else {
      await f.fetchResponse(r); const reader = r.response.body.getReader(), reason = Error(mode);
      if (mode === 'cancel') {
        r.controller.enqueue(encode(text).subarray(0, 4)); await reader.read();
        const cancelled = reader.cancel(reason); assert.equal(cancelled, r.calls.cancel.at(-1).promise);
        assert.equal(r.calls.cancel.at(-1).receiver, reader); assert.equal(r.calls.cancel.at(-1).args[0], reason); await cancelled;
        assert.equal(r.calls.streamCancel[0], reason);
      } else {
        const reading = reader.read(); assert.equal(reading, r.calls.read.at(-1).promise); r.controller.error(reason);
        await assert.rejects(reading, error => error === reason);
      }
    }
    assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0); assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.observer.snapshot().retainedBytes, 0);
  });
});

test('delivery rows are minimal deeply frozen snapshots, independent of the actual returned result', async t => {
  const f = fixture(t), value = {jobs: [{id: 'j', version: '2', attempts: [{token: 'secret'}]}], receipt: {commandId: 'c', toSeq: '9', raw: 'secret'},
    jobId: 'j', items: [{id: 'i', version: '3', state: 'prepared', preparedAssetId: 'a', url: 'secret'}], observation: {digest: 'sha256:abc', raw: 'secret'}, private: 'secret'}, text = JSON.stringify(value);
  await f.consume(f.response(text, {path: '/api/v1/documents/doc-1/candidates'})); const result = f.parse(text), row = f.rows()[0];
  const expected = {jobs: [{id: 'j', version: '2'}], receipt: {commandId: 'c', toSeq: '9'}, jobId: 'j', items: [{id: 'i', version: '3', state: 'prepared', preparedAssetId: 'a'}], observation: {digest: 'sha256:abc'}};
  assert.deepEqual(plain(row.value), expected); assert.equal(row.path, '/api/v1/documents/doc-1/candidates');
  assert.equal(row.scope, 'original-response-parse-delivery'); assert.equal(row.clock, 'browser-wall-ms');
  const visit = item => { if (item && typeof item === 'object') { assert.equal(Object.isFrozen(item), true); for (const child of Object.values(item)) visit(child); } }; visit(row);
  assert.notEqual(row.value, result); assert.notEqual(row.value.jobs, result.jobs); assert.notEqual(row.value.jobs[0], result.jobs[0]);
  result.jobs[0].id = 'changed'; result.items[0].state = 'changed'; result.observation.digest = 'changed'; result.receipt.toSeq = 'changed';
  assert.deepEqual(plain(row.value), expected); assert.equal(JSON.stringify(row).includes('secret'), false);
  assert.equal(f.observer.snapshot().retainedBytes, 0); assert.equal(f.observer.snapshot().pending, 0);
  f.rows().length = 0; assert.equal(f.observer.snapshot().rows, 1, 'draining exposed rows does not reset lifetime limits');
});

test('native Response.json returns its original promise and result; failures add no delivery', async t => {
  for (const mode of ['success', 'syntax', 'stream-error', 'locked']) await t.test(mode, async t => {
    const f = fixture(t), text = mode === 'syntax' ? '{' : queueText(), r = f.response(text, {path: '/api/v1/commands/command-1'});
    await f.fetchResponse(r);
    if (mode === 'locked') r.response.body.getReader();
    const argument = {ignoredByNativeJSON: true}, promise = r.response.json(argument), nativeCall = r.calls.json.at(-1);
    assert.equal(promise, nativeCall.promise); assert.equal(nativeCall.receiver, r.response); assert.equal(nativeCall.args[0], argument);
    const reason = Error('native stream failure');
    if (mode === 'stream-error') r.controller.error(reason);
    else if (mode !== 'locked') { r.controller.enqueue(encode(text)); r.controller.close(); }
    if (mode === 'success') {
      f.clock.wall = 900; const value = await promise;
      assert.equal(value, await nativeCall.promise); assert.equal(value.jobs[0].id, 'job-1');
      assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].source, 'original-response-json'); assert.equal(f.rows()[0].at, 900);
      f.parse(text); assert.equal(f.rows().length, 1, 'native JSON does not leave a pending text witness');
    } else {
      let actual; try { await promise; assert.fail('native json should reject'); } catch (error) { actual = error; }
      await assert.rejects(nativeCall.promise, error => error === actual);
      if (mode === 'stream-error') assert.equal(actual, reason);
      assert.equal(f.rows().length, 0);
    }
    assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.observer.snapshot().retainedBytes, 0); assert.deepEqual(r.calls.forbidden, []);
  });
});

test('unselected responses and the original-fetch bypass cannot create application delivery rows', async t => {
  const f = fixture(t), text = queueText();
  for (const [path, method] of [['/api/v1/queue-extra', 'GET'], ['/api/v1/jobs/job-1', 'GET'], ['https://elsewhere.invalid/api/v1/queue', 'GET'],
    ['/api/v1/commands', 'GET'], ['/api/v1/queue', 'POST'], ['/api/v1/commands/command-1/result', 'GET']]) {
    const r = f.response(text, {path}), init = runInContext('({method:' + JSON.stringify(method) + '})', f.context);
    await f.fetchResponse(r, r.response.url, init); r.controller.enqueue(encode(text)); r.controller.close();
    assert.equal((await r.response.json()).jobs[0].id, 'job-1'); assert.equal(r.response.json, r.originals.json);
  }
  const bypass = f.response(text); f.incoming.push({response: bypass.response});
  const promise = f.context.__p25OriginalFetch(bypass.response.url); assert.equal(promise, f.fetchCalls.at(-1).promise); await promise;
  bypass.controller.enqueue(encode(text)); bypass.controller.close(); await bypass.response.json();
  assert.equal(bypass.response.json, bypass.originals.json); assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0); assert.equal(f.observer.snapshot().pending, 0);
});

test('the selected POST command route retains only the actual command receipt identity', async t => {
  const f = fixture(t), text = JSON.stringify({receipt: {commandId: 'cancel-1', toSeq: '12', private: 'not retained'}}), r = f.response(text, {path: '/api/v1/commands'});
  await f.fetchResponse(r, r.response.url, runInContext('({method:"POST"})', f.context)); r.controller.enqueue(encode(text)); r.controller.close();
  const value = await r.response.json(); assert.equal(value.receipt.private, 'not retained');
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].method, 'POST'); assert.equal(f.rows()[0].path, '/api/v1/commands');
  assert.deepEqual(plain(f.rows()[0].value), {receipt: {commandId: 'cancel-1', toSeq: '12'}});
});

test('borrowed methods preserve native receivers without attributing another body to the wrapped response', async t => {
  for (const method of ['json', 'getReader', 'read', 'cancel']) await t.test(method, async t => {
    const f = fixture(t), text = queueText(), wrapped = f.response(text), other = f.response(text, {path: '/other'});
    await f.fetchResponse(wrapped);
    if (method === 'json') {
      other.controller.enqueue(encode(text)); other.controller.close();
      const promise = Reflect.apply(wrapped.response.json, other.response, []); assert.equal(promise, wrapped.calls.json.at(-1).promise);
      assert.equal((await promise).jobs[0].id, 'job-1'); assert.equal(wrapped.calls.json.at(-1).receiver, other.response);
    } else if (method === 'getReader') {
      const reader = Reflect.apply(wrapped.response.body.getReader, other.response.body, []);
      other.controller.enqueue(encode(text)); other.controller.close(); await reader.read(); await reader.read(); reader.releaseLock(); f.parse(text);
      assert.equal(wrapped.calls.getReader.at(-1).receiver, other.response.body);
    } else {
      const originalReader = wrapped.response.body.getReader(), otherReader = other.response.body.getReader();
      if (method === 'read') {
        other.controller.enqueue(encode(text)); other.controller.close();
        const promise = Reflect.apply(originalReader.read, otherReader, []); assert.equal(promise, wrapped.calls.read.at(-1).promise); await promise;
        await Reflect.apply(originalReader.read, otherReader, []); otherReader.releaseLock(); originalReader.releaseLock(); f.parse(text);
        assert.equal(wrapped.calls.read.at(-1).receiver, otherReader);
      } else {
        const reason = {other: true}, promise = Reflect.apply(originalReader.cancel, otherReader, [reason]);
        assert.equal(promise, wrapped.calls.cancel.at(-1).promise); await promise;
        assert.equal(wrapped.calls.cancel.at(-1).receiver, otherReader); assert.equal(other.calls.streamCancel[0], reason);
      }
    }
    assert.equal(f.rows().length, 0);
  });
});

test('serialization in a non-strict realm preserves null and primitive receivers and native reader failures', async t => {
  const f = fixture(t);
  for (const receiver of [null, undefined, 7, 'receiver']) {
    const response = f.response(queueText(), {path: '/unselected'}); f.incoming.push({response: response.response});
    const promise = Reflect.apply(f.context.fetch, receiver, [response.response.url]);
    assert.equal(promise, f.fetchCalls.at(-1).promise); assert.equal(f.fetchCalls.at(-1).receiver, receiver); await promise;
    assert.equal(Reflect.apply(f.json.parse, receiver, ['7']), 7); assert.equal(f.context.__parseCalls.at(-1).receiver, receiver);
  }
  const r = f.response(queueText()); await f.fetchResponse(r);
  assert.throws(() => Reflect.apply(r.response.body.getReader, null, []), error => error === r.calls.getReader.at(-1).error);
  const reader = r.response.body.getReader();
  for (const method of ['read', 'cancel']) {
    const promise = Reflect.apply(reader[method], null, []), call = r.calls[method].at(-1);
    assert.equal(promise, call.promise); assert.equal(call.receiver, null);
    let caught; try { await promise; assert.fail('Invalid native receiver should reject'); } catch (error) { caught = error; }
    await assert.rejects(call.promise, error => error === caught);
  }
  assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0);
});

test('observer limits bound body, aggregate buffers, pending operations and cumulative rows', async t => {
  await t.test('exact body limit succeeds and one byte over is refused without consuming', async t => {
    const text = queueText(), f = fixture(t, {limits: {bodyBytes: encode(text).length}});
    await f.consume(f.response(text)); f.parse(text); assert.equal(f.rows().length, 1);
    const over = f.response(text + ' '); await f.fetchResponse(over);
    assert.equal(over.response.bodyUsed, false); assert.equal(over.calls.read.length, 0); assert.equal(f.observer.snapshot().disabled, true); assert.ok(f.errors().length > 0);
  });
  await t.test('aggregate reservation succeeds exactly and rejects the next buffer', async t => {
    const text = queueText(), f = fixture(t, {limits: {totalBytes: encode(text).length * 3}}), first = f.response(text), second = f.response(text);
    await f.fetchResponse(first); first.response.body.getReader(); assert.equal(f.observer.snapshot().retainedBytes, encode(text).length * 3);
    await f.fetchResponse(second); second.response.body.getReader();
    assert.equal(f.observer.snapshot().retainedBytes, 0); assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.observer.snapshot().disabled, true);
  });
  await t.test('pending limit includes fetched responses before any body is read', async t => {
    const f = fixture(t, {limits: {pending: 1}}), first = f.response(queueText()), second = f.response(queueText('job-2'));
    await f.fetchResponse(first); assert.equal(f.observer.snapshot().pending, 1); await f.fetchResponse(second);
    assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.observer.snapshot().disabled, true); assert.equal(first.response.bodyUsed, false); assert.equal(second.response.bodyUsed, false);
  });
  await t.test('pending limit also includes original fetch promises waiting for headers', async t => {
    const f = fixture(t, {limits: {pending: 1}}), first = f.response(queueText()), second = f.response(queueText('job-2')), gate = deferred();
    t.after(() => gate.resolve(first.response)); f.incoming.push({promise: gate.promise});
    const pending = f.context.fetch(first.response.url); assert.equal(pending, gate.promise); assert.equal(f.observer.snapshot().pending, 1);
    await f.fetchResponse(second); assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.observer.snapshot().disabled, true);
    gate.resolve(first.response); assert.equal(await pending, first.response);
    assert.equal(first.response.json, first.originals.json); assert.equal(f.rows().length, 0);
  });
  await t.test('draining exposed rows does not evade the lifetime row cap', async t => {
    const f = fixture(t, {limits: {rows: 1}}), first = queueText('first'), second = queueText('second');
    await f.consume(f.response(first)); f.parse(first); assert.equal(f.observer.snapshot().rows, 1); f.rows().length = 0;
    await f.consume(f.response(second)); assert.equal(f.parse(second).jobs[0].id, 'second');
    assert.equal(f.rows().length, 0); assert.equal(f.observer.snapshot().rows, 1); assert.equal(f.observer.snapshot().disabled, true); assert.equal(f.observer.snapshot().retainedBytes, 0);
  });
  await t.test('small total limit also bounds completed delivery projections', async t => {
    const text = '{}', f = fixture(t, {limits: {totalBytes: 6}}); await f.consume(f.response(text)); f.parse(text);
    assert.equal(f.rows().length, 0); assert.equal(f.observer.snapshot().retainedBytes, 0); assert.equal(f.observer.snapshot().disabled, true);
  });
});

test('bounded error reporting retains codes only and counts dropped restoration failures', async t => {
  const f = fixture(t, {limits: {errors: 2}});
  for (let index = 0; index < 4; index++) {
    const r = f.response(queueText('job-' + index)); await f.fetchResponse(r);
    Object.defineProperty(r.response, 'json', {configurable: false, writable: false, value: r.response.json});
  }
  f.observer.dispose();
  const snapshot = f.observer.snapshot(); assert.equal(f.errors().length, 2); assert.equal(snapshot.errors, 4); assert.equal(snapshot.droppedErrors, 2);
  assert.equal(snapshot.pending, 0); assert.equal(snapshot.retainedBytes, 0); assert.equal(snapshot.disabled, true);
  for (const error of f.errors()) { assert.deepEqual(Object.keys(error).sort(), ['at', 'code']); assert.equal(typeof error.code, 'string'); assert.equal(Object.isFrozen(error), true); }
});

test('dispose restores instance methods and globals, releases pending copies and prevents late resurrection', async t => {
  const f = fixture(t), r = f.response(queueText()); await f.fetchResponse(r);
  const reader = r.response.body.getReader(), pending = reader.read(); assert.equal(pending, r.calls.read.at(-1).promise);
  const before = f.observer.snapshot(); assert.ok(before.retainedBytes > 0); assert.equal(before.pending, 1);
  f.observer.dispose(); assert.equal(f.context.fetch, f.originalFetch); assert.equal(r.response.json, r.originals.json); assert.equal(r.response.body.getReader, r.originals.getReader);
  assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.observer.snapshot().retainedBytes, 0);
  r.controller.enqueue(encode(r.text)); r.controller.close(); assert.equal((await pending).done, false); await reader.read(); f.parse(r.text);
  assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0); assert.equal(f.observer.snapshot().disposed, true);
  f.observer.dispose(); assert.equal(f.observer.snapshot().retainedBytes, 0);
  await t.test('native JSON already in flight still returns its value after disposal', async t => {
    const f = fixture(t), r = f.response(queueText()); await f.fetchResponse(r);
    const promise = r.response.json(); assert.equal(promise, r.calls.json.at(-1).promise); assert.equal(f.observer.snapshot().pending, 1);
    f.observer.dispose(); r.controller.enqueue(encode(r.text)); r.controller.close();
    assert.equal((await promise).jobs[0].id, 'job-1'); assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0); assert.equal(f.observer.snapshot().pending, 0);
  });
  await t.test('fetch already in flight returns an unmodified response after disposal', async t => {
    const f = fixture(t), r = f.response(queueText()), gate = deferred(); t.after(() => gate.resolve(r.response));
    f.incoming.push({promise: gate.promise}); const promise = f.context.fetch(r.response.url); assert.equal(promise, gate.promise);
    assert.equal(f.observer.snapshot().pending, 1); f.observer.dispose(); gate.resolve(r.response); assert.equal(await promise, r.response);
    assert.equal(r.response.json, r.originals.json); assert.equal(r.response.body.getReader, r.originals.getReader);
    assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0);
  });
});

test('fetch native throws and rejections pass through unchanged and invalid limits fail before patching', async t => {
  const f = fixture(t), thrown = Error('fetch throw'), rejected = Error('fetch reject');
  f.incoming.push({throw: thrown}); assert.throws(() => f.context.fetch(origin + '/api/v1/queue'), error => error === thrown);
  f.incoming.push({reject: rejected}); const promise = f.context.fetch(origin + '/api/v1/queue'); assert.equal(promise, f.fetchCalls.at(-1).promise);
  await assert.rejects(promise, error => error === rejected); assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0);
  const ceilings = {bodyBytes: 65536, totalBytes: 1048576, pending: 32, rows: 4096, errors: 64};
  for (const [key, ceiling] of Object.entries(ceilings)) for (const invalid of [0, -1, 1.5, ceiling + 1, NaN, Infinity, '1']) {
    const context = createContext({__options: {limits: {[key]: invalid}}}); runInContext('globalThis.window = globalThis', context);
    assert.throws(() => runInContext(`(${installE4DeliveryObserver.toString()})(__options)`, context), /E4_OBSERVER_LIMITS/);
    assert.equal(context.__p25DeliveryObserver, undefined);
  }
  for (const invalid of [null, [], 2, {limits: null}, {limits: []}, {limits: 2}, {unknown: 1}, {limits: {unknown: 1}}, {limits: {toString: 1}}]) {
    const context = createContext({__options: invalid}); runInContext('globalThis.window = globalThis', context);
    assert.throws(() => runInContext(`(${installE4DeliveryObserver.toString()})(__options)`, context), /E4_OBSERVER_LIMITS/);
    assert.equal(context.__p25DeliveryObserver, undefined);
  }
});
