import test from 'node:test';
import assert from 'node:assert/strict';
import {createContext, runInContext} from 'node:vm';
import {installE4DeliveryObserver,matchV45Deliveries} from './e4-delivery-observer.mjs';

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
  async function consume(record, chunks = [encode(record.text)], init) {
    await fetchResponse(record, record.response.url, init);
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


const v45Post = (path, identity, epoch = 0) => ({epoch, path, request: path === '/api/v1/commands'
  ? {protocolVersion: 1, command: {commandId: identity, body: {type: 'CreateDocument'}}}
  : {protocolVersion: 1, sessionId: path.slice('/api/v1/ui/'.length), requestId: identity, body: {type: 'SetPreferences'}}});
const postInit = f => runInContext('({method:"POST"})', f.context);
const epochRows = (f, epoch = 0) => f.rows().map(row => ({...plain(row), epoch}));

test('V45 opt-in keeps original native JSON promise/receiver/result and pending command IDs without invented UI IDs', async t => {
  const f = fixture(t, {profile: 'v45-post'}), value = {protocolVersion: 1, kind: 'pending', commandId: 'command-1', operationId: 'operation-1', phase: 'running', receiptUrl: '/api/v1/commands/command-1'};
  const r = f.response(JSON.stringify(value), {path: '/api/v1/commands', status: 202});
  await f.fetchResponse(r, r.response.url, postInit(f));
  const argument = {ignored: true}, promise = r.response.json(argument), original = r.calls.json.at(-1);
  assert.equal(promise, original.promise); assert.equal(original.receiver, r.response); assert.equal(original.args[0], argument);
  r.controller.enqueue(encode(r.text)); r.controller.close(); const result = await promise;
  assert.equal(result, await original.promise); assert.deepEqual(result, value);
  const joined = matchV45Deliveries([v45Post('/api/v1/commands', 'command-1')], epochRows(f), true);
  assert.equal(joined.length, 1); assert.deepEqual(joined[0].delivery.value, value); assert.equal(joined[0].delivery.value.requestId, undefined);
  result.phase = 'mutated'; assert.equal(f.rows()[0].value.phase, 'running'); assert.equal(Object.isFrozen(f.rows()[0].value), true);
  assert.deepEqual(r.calls.forbidden, []); assert.equal(f.errors().length, 0); assert.equal(f.observer.snapshot().pending, 0);
});

test('V45 complete original reader parse retains exact nested review and ordinary UI receipt fields', async t => {
  const f = fixture(t, {profile: 'v45-post'}), path = '/api/v1/ui/ui_1';
  const value = {protocolVersion: 1, requestId: 'review-1', status: 'accepted', uiSeq: '7', review: {kind: 'request-review-v45-1', prompt: 'Café 東京', request: {modelRequest: {seed: '900719925474099312345'}, references: [{assetId: 'a', version: '1'}]}}};
  const r = f.response(JSON.stringify(value), {path}); await f.consume(r, [...encode(r.text)].map(byte => Uint8Array.of(byte)), postInit(f));
  assert.equal(f.rows().length, 0, 'EOF and unlock alone cannot qualify');
  const receiver = {parse: true}, result = Reflect.apply(f.json.parse, receiver, [r.text]), original = f.context.__parseCalls.findLast(call => call.receiver === receiver);
  assert.equal(original.receiver, receiver); assert.equal(result, original.value); assert.equal(original.args[0], r.text);
  const joined = matchV45Deliveries([v45Post(path, 'review-1')], epochRows(f), true); assert.deepEqual(joined[0].delivery.value, value);
  result.review.request.references[0].assetId = 'mutated'; assert.equal(f.rows()[0].value.review.request.references[0].assetId, 'a'); assert.equal(Object.isFrozen(f.rows()[0].value.review.request.references[0]), true);
  assert.equal(r.calls.read.length, encode(r.text).length + 1); assert.deepEqual(r.calls.forbidden, []);
  const ordinary = {protocolVersion: 1, requestId: 'preferences-1', status: 'accepted', reason: null, uiSeq: '8'}, next = f.response(JSON.stringify(ordinary), {path});
  await f.consume(next, undefined, postInit(f)); f.parse(next.text);
  assert.equal(matchV45Deliveries([v45Post(path, 'review-1'), v45Post(path, 'preferences-1')], epochRows(f), true).length, 2);
});

test('V45 scope is exact, opt-in, same-origin and POST-only without changing E4 default projection', async t => {
  const ordinary = {protocolVersion: 1, requestId: 'preferences-1', status: 'accepted', uiSeq: '8'}, text = JSON.stringify(ordinary);
  const f = fixture(t, {profile: 'v45-post'});
  for (const [path, method] of [['/api/v1/ui/ui_1', 'GET'], ['/api/v1/ui/ui_1/extra', 'POST'], ['/api/v1/ui/ui_1?extra=1', 'POST'], ['/api/v1/ui/ui_1#extra', 'POST'], ['/api/v1/ui/' + 'x'.repeat(129), 'POST'], ['https://other.invalid/api/v1/ui/ui_1', 'POST'], ['http://user:password@127.0.0.1:4381/api/v1/ui/ui_1', 'POST'], ['/api/v1/queue', 'GET'], ['/api/v1/commands/command-1', 'GET']]) {
    const r = f.response(text, {path}); await f.fetchResponse(r, r.response.url, runInContext('({method:' + JSON.stringify(method) + '})', f.context));
    r.controller.enqueue(encode(text)); r.controller.close(); assert.deepEqual(await r.response.json(), ordinary); assert.equal(r.response.json, r.originals.json);
  }
  assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0);
  const defaultObserver = fixture(t), ui = defaultObserver.response(text, {path: '/api/v1/ui/ui_1'});
  await defaultObserver.fetchResponse(ui, ui.response.url, postInit(defaultObserver)); ui.controller.enqueue(encode(text)); ui.controller.close(); await ui.response.json();
  assert.equal(defaultObserver.rows().length, 0); assert.equal(defaultObserver.errors().length, 0);
  for (const profile of ['v45', 'all', false, null, {}, 1]) {
    const context = createContext({__options: {profile}}); runInContext('globalThis.window = globalThis', context);
    assert.throws(() => runInContext(`(${installE4DeliveryObserver.toString()})(__options)`, context), /E4_OBSERVER_PROFILE/); assert.equal(context.__p25DeliveryObserver, undefined);
  }
});

test('V45 join requires a bijection of real UI, pending and final command identities across document epochs', () => {
  const post = v45Post('/api/v1/commands', 'command-1');
  const delivery = {epoch: 0, path: post.path, method: 'POST', status: 200, scope: 'original-response-parse-delivery', source: 'original-reader-json-parse', value: {protocolVersion: 1, kind: 'receipt', receipt: {commandId: 'command-1', status: 'accepted', fromSeq: '1', toSeq: '2'}}};
  assert.equal(matchV45Deliveries([post], [], false).length, 0);
  assert.throws(() => matchV45Deliveries([post], [], true), /V45_DELIVERY_MISSING_RESPONSE/);
  assert.deepEqual(matchV45Deliveries([post], [delivery], true), [{post, delivery}]);
  assert.throws(() => matchV45Deliveries([post, post], [delivery], true), /V45_DELIVERY_AMBIGUOUS_POST/);
  assert.throws(() => matchV45Deliveries([post], [delivery, delivery], true), /V45_DELIVERY_AMBIGUOUS_RESPONSE/);
  assert.throws(() => matchV45Deliveries([], [delivery], false), /V45_DELIVERY_UNMATCHED_RESPONSE/);
  for (const changed of [{epoch: 1}, {value: {...delivery.value, receipt: {commandId: 'different'}}}]) assert.throws(() => matchV45Deliveries([post], [{...delivery, ...changed}], true), /V45_DELIVERY_UNMATCHED_RESPONSE/);
  for (const changed of [{method: 'GET'}, {scope: 'network-body'}, {source: 'durable-database'}, {epoch: -1}, {path: '/api/v1/commands/command-1'}, {value: {kind: 'receipt', receipt: {commandId: 'command-1'}}}]) assert.throws(() => matchV45Deliveries([post], [{...delivery, ...changed}], true), /V45_DELIVERY_RESPONSE_IDENTITY/);
  for (const changed of [{status: 202}, {value: {protocolVersion: 1, kind: 'pending', commandId: 'command-1'}}, {value: {protocolVersion: 1, requestId: 'command-1', status: 'accepted'}}]) assert.throws(() => matchV45Deliveries([post], [{...delivery, ...changed}], true), /V45_DELIVERY_COMMAND_RECEIPT/);
  const ui = v45Post('/api/v1/ui/ui_1', 'ui-1'), uiDelivery = {...delivery, path: ui.path, value: {protocolVersion: 1, requestId: 'ui-1', status: 'accepted', uiSeq: '3'}};
  assert.equal(matchV45Deliveries([ui], [uiDelivery], true).length, 1);
  assert.throws(() => matchV45Deliveries([{...ui, request: {...ui.request, sessionId: 'foreign'}}], [uiDelivery], true), /V45_DELIVERY_POST_IDENTITY/);
  assert.throws(() => matchV45Deliveries([ui], [{...uiDelivery, value: {protocolVersion: 1, status: 'accepted', commandId: 'ui-1'}}], true), /V45_DELIVERY_RESPONSE_IDENTITY/);
  assert.equal(matchV45Deliveries([post, {...post, epoch: 1}], [delivery, {...delivery, epoch: 1}], true).length, 2);
});

test('V45 missing, cancelled, errored or unparsable original consumers cannot be replaced by inspector or durable receipt claims', async t => {
  for (const mode of ['unconsumed', 'eof-only', 'cancel', 'read-error', 'parse-error']) await t.test(mode, async t => {
    const f = fixture(t, {profile: 'v45-post'}), path = '/api/v1/ui/ui_1', text = mode === 'parse-error' ? '{' : JSON.stringify({protocolVersion: 1, requestId: 'ui-1', status: 'accepted', uiSeq: '1'}), r = f.response(text, {path});
    if (mode === 'parse-error' || mode === 'eof-only') {
      await f.consume(r, undefined, postInit(f));
      if (mode === 'parse-error') assert.throws(() => f.parse(text), error => error === f.context.__parseCalls.at(-1).error);
    } else {
      await f.fetchResponse(r, r.response.url, postInit(f));
      if (mode !== 'unconsumed') {
        const reader = r.response.body.getReader(), reason = Error(mode);
        if (mode === 'cancel') { const promise = reader.cancel(reason); assert.equal(promise, r.calls.cancel.at(-1).promise); await promise; assert.equal(r.calls.streamCancel[0], reason); }
        else { const promise = reader.read(); assert.equal(promise, r.calls.read.at(-1).promise); r.controller.error(reason); await assert.rejects(promise, error => error === reason); }
      }
    }
    assert.equal(f.rows().length, 0); assert.throws(() => matchV45Deliveries([v45Post(path, 'ui-1')], epochRows(f), true), /V45_DELIVERY_MISSING_RESPONSE/);
    assert.deepEqual(r.calls.forbidden, []);
  });
});

test('V45 identical complete bodies remain ambiguous even when the two POST paths differ', async t => {
  const f = fixture(t, {profile: 'v45-post'}), text = JSON.stringify({protocolVersion: 1, requestId: 'ui-1', status: 'accepted', uiSeq: '1'});
  for (const path of ['/api/v1/ui/ui_1', '/api/v1/ui/ui_2']) await f.consume(f.response(text, {path}), undefined, postInit(f));
  assert.equal(f.parse(text).requestId, 'ui-1'); assert.equal(f.rows().length, 0); assert.equal(f.observer.snapshot().disabled, true);
  assert.ok(f.errors().some(error => error.code === 'E4_OBSERVER_AMBIGUOUS_BODY'));
  assert.throws(() => matchV45Deliveries([v45Post('/api/v1/ui/ui_1', 'ui-1'), v45Post('/api/v1/ui/ui_2', 'ui-1')], epochRows(f), true), /V45_DELIVERY_MISSING_RESPONSE/);
});

test('V45 full receipt capture preserves body and cumulative evidence ceilings without consuming ahead', async t => {
  const path = '/api/v1/ui/ui_1', value = {protocolVersion: 1, requestId: 'ui-1', status: 'accepted', uiSeq: '1', review: {prompt: 'retained'}}, text = JSON.stringify(value);
  await t.test('body cap', async t => {
    const f = fixture(t, {profile: 'v45-post', limits: {bodyBytes: encode(text).length - 1}}), r = f.response(text, {path}); await f.fetchResponse(r, r.response.url, postInit(f));
    assert.equal(r.response.bodyUsed, false); assert.equal(r.calls.read.length, 0); assert.ok(f.errors().some(error => error.code === 'E4_OBSERVER_BODY_LIMIT'));
    assert.throws(() => matchV45Deliveries([v45Post(path, 'ui-1')], epochRows(f), true), /V45_DELIVERY_MISSING_RESPONSE/);
  });
  await t.test('row retention cap', async t => {
    const f = fixture(t, {profile: 'v45-post', limits: {totalBytes: encode(text).length * 3}}), r = f.response(text, {path}); await f.consume(r, undefined, postInit(f));
    assert.equal(f.parse(text).requestId, 'ui-1'); assert.equal(f.rows().length, 0); assert.equal(f.observer.snapshot().disabled, true); assert.ok(f.errors().some(error => error.code === 'E4_OBSERVER_ROW_LIMIT'));
    assert.equal(f.observer.snapshot().retainedBytes, 0); assert.throws(() => matchV45Deliveries([v45Post(path, 'ui-1')], epochRows(f), true), /V45_DELIVERY_MISSING_RESPONSE/);
  });
});


for (const profile of ['queue-ui', 'portable-review']) test(profile+' original consumer keeps full immutable identity after exact original EOF and parse', async t => {
  const f = fixture(t, {profile}), path = profile === 'queue-ui' ? '/api/v1/ui/ui_1' : '/api/v1/bundle-reviews/review-1';
  const value = profile === 'queue-ui' ? {protocolVersion:1,requestId:'request-1',status:'accepted',uiSeq:'2',review:{id:'review-1',draft:{draftId:'draft-1',generation:'7'}}} : {protocolVersion:1,reviewId:'review-1',reviewHash:'sha256:'+'a'.repeat(64),targetClientId:'client-1',documentId:'mapped-1',editable:true,counts:{assets:1}};
  const text = JSON.stringify(value), r = f.response(text, {path}), init = profile === 'queue-ui' ? postInit(f) : undefined;
  await f.consume(r, [...encode(text)].map(byte=>Uint8Array.of(byte)), init);
  assert.equal(f.rows().length,0,'EOF alone is insufficient');const parsed=f.parse(text);assert.deepEqual(plain(parsed),value);
  assert.equal(f.rows().length,1);assert.equal(f.rows()[0].source,'original-reader-json-parse');assert.equal(f.rows()[0].url,origin+path);assert.equal(f.rows()[0].method,profile==='queue-ui'?'POST':'GET');assert.deepEqual(plain(f.rows()[0].value),value);
  if(profile==='queue-ui'){const post=v45Post(path,'request-1',3);assert.equal(matchV45Deliveries([post],epochRows(f,3),true)[0].post,post);assert.throws(()=>matchV45Deliveries([post],epochRows(f,4),true),/UNMATCHED_RESPONSE/);parsed.review.draft.generation='changed';assert.equal(f.rows()[0].value.review.draft.generation,'7');}
  else{parsed.counts.assets=9;assert.equal(f.rows()[0].value.counts.assets,1);assert.equal(f.rows()[0].value.documentId,'mapped-1');}
  assert(Object.isFrozen(f.rows()[0].value));assert.deepEqual(r.calls.forbidden,[]);assert.equal(r.calls.read.length,encode(text).length+1);assert.equal(f.errors().length,0);assert.equal(f.observer.snapshot().pending,0);
});

for (const profile of ['queue-ui','portable-review']) test(profile+' selection excludes other methods, endpoints, origins and ambiguous URL forms', async t => {
  const f=fixture(t,{profile}),path=profile==='queue-ui'?'/api/v1/ui/ui_1':'/api/v1/bundle-reviews/review-1',method=profile==='queue-ui'?'POST':'GET',text='{"protocolVersion":1,"requestId":"request-1"}';
  for(const [route,verb] of [[path,method==='POST'?'GET':'POST'],[path+'/extra',method],[path+'?extra=1',method],[path+'#extra',method],[path.replace(/[^/]+$/,'x'.repeat(129)),method],['https://other.invalid'+path,method],['http://user:password@127.0.0.1:4381'+path,method],['/api/v1/queue','GET'],['/api/v1/commands','POST'],[profile==='queue-ui'?'/api/v1/bundle-reviews/review-1':'/api/v1/ui/ui_1',profile==='queue-ui'?'GET':'POST']]){
    const r=f.response(text,{path:route});await f.fetchResponse(r,r.response.url,runInContext('({method:'+JSON.stringify(verb)+'})',f.context));assert.equal(r.response.json,r.originals.json);r.controller.enqueue(encode(text));r.controller.close();await r.response.json();
  }
  assert.equal(f.rows().length,0);assert.equal(f.errors().length,0);assert.equal(f.observer.snapshot().operations,0);
});

for (const profile of ['queue-ui','portable-review']) test(profile+' missing or failed original parser never becomes a retained body', async t => {
  for(const mode of ['unconsumed','eof-only','cancel','read-error','parse-error'])await t.test(mode,async t=>{
    const f=fixture(t,{profile}),path=profile==='queue-ui'?'/api/v1/ui/ui_1':'/api/v1/bundle-reviews/review-1',text=mode==='parse-error'?'{':'{"protocolVersion":1,"requestId":"request-1","reviewId":"review-1"}',r=f.response(text,{path}),init=profile==='queue-ui'?postInit(f):undefined;
    if(mode==='eof-only'||mode==='parse-error'){await f.consume(r,undefined,init);if(mode==='parse-error')assert.throws(()=>f.parse(text));}
    else{await f.fetchResponse(r,r.response.url,init);if(mode!=='unconsumed'){const reader=r.response.body.getReader(),reason=Error(mode);if(mode==='cancel'){const pending=reader.cancel(reason);assert.equal(pending,r.calls.cancel.at(-1).promise);await pending;}else{const pending=reader.read();assert.equal(pending,r.calls.read.at(-1).promise);r.controller.error(reason);await assert.rejects(pending,error=>error===reason);}}}
    assert.equal(f.rows().length,0);assert.deepEqual(r.calls.forbidden,[]);
    if(profile==='queue-ui')assert.throws(()=>matchV45Deliveries([v45Post(path,'request-1')],epochRows(f),true),/MISSING_RESPONSE/);
  });
});

for (const profile of ['queue-ui','portable-review']) test(profile+' obeys unchanged body and cumulative row-evidence ceilings', async t => {
  const path=profile==='queue-ui'?'/api/v1/ui/ui_1':'/api/v1/bundle-reviews/review-1',text='{"protocolVersion":1,"requestId":"request-1","reviewId":"review-1","detail":{"nested":"retained"}}';
  for(const [limits,code] of [[{bodyBytes:encode(text).length-1},'E4_OBSERVER_BODY_LIMIT'],[{totalBytes:encode(text).length*3},'E4_OBSERVER_ROW_LIMIT']])await t.test(code,async t=>{
    const f=fixture(t,{profile,limits}),r=f.response(text,{path}),init=profile==='queue-ui'?postInit(f):undefined;
    if(limits.bodyBytes){await f.fetchResponse(r,r.response.url,init);assert.equal(r.response.bodyUsed,false);assert.equal(r.calls.read.length,0);}else{await f.consume(r,undefined,init);f.parse(text);}
    assert.equal(f.rows().length,0);assert(f.errors().some(error=>error.code===code));assert.equal(f.observer.snapshot().disabled,true);
  });
});

for (const profile of ['queue-ui','portable-review']) test(profile+' identical completed original bodies refuse ambiguous parse assignment', async t=>{
  const f=fixture(t,{profile}),prefix=profile==='queue-ui'?'/api/v1/ui/':'/api/v1/bundle-reviews/',text='{"protocolVersion":1,"requestId":"request-1","reviewId":"review-1"}';
  for(const suffix of ['one','two'])await f.consume(f.response(text,{path:prefix+suffix}),undefined,profile==='queue-ui'?postInit(f):undefined);
  assert.equal(f.parse(text).protocolVersion,1);assert.equal(f.rows().length,0);assert(f.errors().some(error=>error.code==='E4_OBSERVER_AMBIGUOUS_BODY'));
});


// Original transaction timing is a diagnostic-only fixture lane. Its isolated
// IDB boundary uses real EventTarget dispatch and an injected monotonic clock;
// no test sleeps, fetches, stored values or alternate transactions are needed.
import {installE4TransactionTiming,observeE4AuthorityWrite} from './e4-transaction-timing.mjs';
function transactionTimingFixture(t) {
  const clock={wall:1000,mono:10}, calls=[], phase={released:0,failValue:false,failRelease:false,records:[],dropped:0,invalid:0};
  class TimingDate extends Date {static now(){return clock.wall;}}
  class Transaction extends EventTarget {
    constructor(stores,mode){super();this.mode=mode;this.objectStoreNames={length:stores.length,item:i=>stores[i]};}
    get result(){throw Error('Diagnostic must not read native values');}
    get error(){throw Error('Diagnostic must not read native error payload');}
  }
  class Database {
    constructor(name='ie-projection-private-name'){this.name=name;}
    transaction(...args){calls.push({receiver:this,args});if(this.failure)throw this.failure;clock.mono+=2;return this.last=new Transaction(Array.isArray(args[0])?args[0]:[args[0]],args[1]??'readonly');}
  }
  const descriptor=Object.getOwnPropertyDescriptor(Database.prototype,'transaction');
  const context=createContext({Date:TimingDate,performance:{now:()=>clock.mono,timeOrigin:990},IDBDatabase:Database,TextEncoder,
    __IDEOGRAM_PHASES__:{readSnapshot(key){assert.equal(key,'e4-transaction-timing');return {get value(){if(phase.failValue)throw Error('private read failure');return {trace:{records:phase.records,dropped:phase.dropped,invalid:phase.invalid,clockOriginUnixMs:990}};},release(){phase.released++;if(phase.failRelease)throw Error('private release failure');}};}}});
  runInContext('globalThis.window=globalThis',context);
  runInContext(`(${installE4TransactionTiming.toString()})()`,context);
  const observer=context.__p25TransactionTiming;
  t.after(()=>{observer.dispose();assert.deepEqual(Object.getOwnPropertyDescriptor(Database.prototype,'transaction'),descriptor);});
  return {clock,calls,phase,Database,observer,context,descriptor,snapshot:()=>plain(observer.snapshot())};
}
test('E4 transaction timing preserves the original receiver, arguments, result and property descriptor',t=>{
  const f=transactionTimingFixture(t),db=new f.Database(),stores=['meta','rows'],options={durability:'strict'};
  const tx=db.transaction(stores,'readonly',options);
  assert.equal(tx,db.last);assert.equal(f.calls.length,1);assert.equal(f.calls[0].receiver,db);
  assert.equal(f.calls[0].args[0],stores);assert.equal(f.calls[0].args[2],options);
  const changed=Object.getOwnPropertyDescriptor(f.Database.prototype,'transaction');
  for(const key of ['writable','enumerable','configurable'])assert.equal(changed[key],f.descriptor[key]);
  assert.deepEqual(f.snapshot().records[0],{id:1,scope:'recovery',mode:'readonly',stores:['meta','rows'],startedWallMs:1000,startedMs:10,returnedMs:12,terminalMs:null,terminalWallMs:null,outcome:'pending',errorEvents:0});
  tx.dispatchEvent(new Event('complete'));
});
test('E4 transaction timing preserves the exact original synchronous exception without retries',t=>{
  const f=transactionTimingFixture(t),db=new f.Database(),error=Error('native original');db.failure=error;
  assert.throws(()=>db.transaction('meta'),e=>e===error);assert.equal(f.calls.length,1);assert.equal(f.snapshot().observed,0);
});
test('E4 transaction timing waits for the real complete event and does not replace product listeners',t=>{
  const f=transactionTimingFixture(t),db=new f.Database(),tx=db.transaction('meta','readonly'),seen=[];
  tx.addEventListener('complete',()=>seen.push('product complete'));
  f.clock.mono=50;f.clock.wall=1040;assert.equal(f.snapshot().records[0].outcome,'pending');
  tx.dispatchEvent(new Event('complete'));
  const row=f.snapshot().records[0];assert.equal(row.startedMs,10);assert.equal(row.returnedMs,12);assert.equal(row.terminalMs,50);assert.equal(row.terminalWallMs,1040);assert.equal(row.outcome,'complete');assert.deepEqual(seen,['product complete']);assert.equal(f.snapshot().pending,0);
});
test('E4 transaction error events are nonterminal and the actual abort remains distinct',t=>{
  const f=transactionTimingFixture(t),tx=new f.Database('ie-delivery-private-owner').transaction('entries','readwrite');
  tx.dispatchEvent(new Event('error'));tx.dispatchEvent(new Event('error'));
  assert.equal(f.snapshot().records[0].outcome,'pending');assert.equal(f.snapshot().pending,1);
  f.clock.mono=31;tx.dispatchEvent(new Event('abort'));
  const row=f.snapshot().records[0];assert.equal(row.scope,'journal');assert.equal(row.errorEvents,2);assert.equal(row.outcome,'abort');assert.equal(row.terminalMs,31);
});
test('E4 transaction completion does not erase a preceding error event',t=>{
  const f=transactionTimingFixture(t),tx=new f.Database().transaction('rows','readwrite');
  tx.dispatchEvent(new Event('error'));tx.dispatchEvent(new Event('complete'));tx.dispatchEvent(new Event('abort'));
  const row=f.snapshot().records[0];assert.equal(row.outcome,'complete');assert.equal(row.errorEvents,1);assert.equal(f.snapshot().pending,0);
});
test('E4 transaction snapshots omit database identities and never read native result or error',t=>{
  const f=transactionTimingFixture(t),db=new f.Database('ie-projection-private-sentinel'),tx=db.transaction(['meta','rows'],'readonly');
  tx.dispatchEvent(new Event('error'));tx.dispatchEvent(new Event('abort'));
  assert.equal(JSON.stringify(f.snapshot()).includes('private-sentinel'),false);assert.equal(f.calls.length,1);
});
test('E4 transaction observer leaves unrelated databases unobserved and native calls intact',t=>{
  const f=transactionTimingFixture(t),db=new f.Database('unrelated-private-database'),tx=db.transaction('secret','readwrite');
  assert.equal(tx,db.last);assert.equal(f.snapshot().ignored,1);assert.deepEqual(f.snapshot().records,[]);assert.deepEqual(f.snapshot().errors,[]);
});
test('E4 transaction records have a fixed bound and explicitly retain drops without refusing native work',t=>{
  const f=transactionTimingFixture(t),db=new f.Database();
  for(let i=0;i<4097;i++)db.transaction('meta','readonly').dispatchEvent(new Event('complete'));
  const s=f.snapshot();assert.equal(f.calls.length,4097);assert.equal(s.observed,4096);assert.equal(s.dropped,1);assert.equal(s.pending,0);assert.ok(s.errors.includes('E4_IDB_TIMING_CAPACITY'));assert.ok(s.records.length===4096||s.errors.includes('E4_IDB_TIMING_OUTPUT'));
});
test('E4 simultaneous transaction references are bounded and completion releases only observed references',t=>{
  const f=transactionTimingFixture(t),db=new f.Database(),transactions=[];
  for(let i=0;i<257;i++)transactions.push(db.transaction('meta','readonly'));
  assert.equal(f.snapshot().pending,256);assert.equal(f.snapshot().dropped,1);assert.equal(f.calls.length,257);
  for(const tx of transactions)tx.dispatchEvent(new Event('complete'));
  assert.equal(f.snapshot().pending,0);assert.equal(f.snapshot().records.length,256);
});
test('E4 diagnostic disposal restores the native method but cannot claim pending transaction completion',t=>{
  const f=transactionTimingFixture(t),db=new f.Database(),tx=db.transaction('meta','readonly');
  f.observer.dispose();tx.dispatchEvent(new Event('complete'));
  assert.equal(f.snapshot().disposed,true);assert.equal(f.snapshot().records[0].outcome,'pending');assert.equal(f.snapshot().pending,0);
  assert.equal(Object.getOwnPropertyDescriptor(f.Database.prototype,'transaction').value,f.descriptor.value);
  db.transaction('meta','readonly');assert.equal(f.calls.length,2);assert.equal(f.snapshot().records.length,1);
});
test('E4 phase projection selects existing command spans, preserves exact command identity and releases its owner',t=>{
  const f=transactionTimingFixture(t);f.phase.records=[{sequence:1,phase:'command.accept',startedMs:1,endedMs:9,durationMs:8,outcome:'ok',context:{commandId:'command_1',transactionId:'tx_1',documentId:'doc_1',prompt:'secret prompt',assetId:'secret asset'}},{phase:'source.capture',context:{commandId:'not-selected'}}];
  const s=f.snapshot();assert.equal(f.phase.released,1);assert.deepEqual(s.phases.records,[{sequence:1,phase:'command.accept',startedMs:1,endedMs:9,durationMs:8,outcome:'ok',context:{commandId:'command_1',transactionId:'tx_1',documentId:'doc_1'}}]);assert.equal(JSON.stringify(s).includes('secret'),false);
});
test('E4 phase diagnostic retains missing-read and release failures without replacing original errors',t=>{
  const f=transactionTimingFixture(t);f.phase.failValue=true;f.phase.failRelease=true;
  const s=f.snapshot();assert.equal(f.phase.released,1);assert.deepEqual(s.phases.errors,['E4_PHASE_TIMING_UNAVAILABLE','E4_PHASE_TIMING_RELEASE']);assert.equal(JSON.stringify(s).includes('private'),false);
});
test('E4 phase projection preserves source drops and invalid counts and bounds selected rows',t=>{
  const f=transactionTimingFixture(t);f.phase.dropped=4;f.phase.invalid=2;f.phase.records=Array.from({length:257},(_,sequence)=>({sequence,phase:'command.accept',context:{},startedMs:1,endedMs:2,durationMs:1,outcome:'ok'}));
  const s=f.snapshot();assert.equal(s.phases.records.length,256);assert.deepEqual(s.phases.errors,['E4_PHASE_TIMING_CAPACITY']);assert.equal(s.phases.dropped,4);assert.equal(s.phases.invalid,2);assert.equal(f.phase.released,1);
});
test('E4 diagnostic snapshot copies cannot mutate retained timing records',t=>{
  const f=transactionTimingFixture(t),tx=new f.Database().transaction('meta','readonly');const first=f.observer.snapshot();first.records[0].stores.push('invented');first.records[0].outcome='invented';
  assert.equal(f.snapshot().records[0].outcome,'pending');assert.deepEqual(f.snapshot().records[0].stores,['meta']);tx.dispatchEvent(new Event('complete'));
});
test('E4 authority write timing delegates once, preserves return identity and leaves original authority untouched',()=>{
  const record={phase:'P1',at:123,monotonic:4},result={},times=[7,11];let calls=0;
  assert.equal(observeE4AuthorityWrite(record,()=>{calls++;return result;},()=>times.shift()),result);
  assert.equal(calls,1);assert.deepEqual(record,{phase:'P1',at:123,monotonic:4,diagnosticWrite:{startedMs:7,endedMs:11,outcome:'returned',clockError:false}});
});
test('E4 authority write timing preserves the original failed write and records no successful return',()=>{
  const record={at:123},error=Error('original write failed'),times=[7,11];let calls=0;
  assert.throws(()=>observeE4AuthorityWrite(record,()=>{calls++;throw error;},()=>times.shift()),e=>e===error);assert.equal(calls,1);assert.deepEqual(record.diagnosticWrite,{startedMs:7,endedMs:11,outcome:'threw',clockError:false});
});
test('E4 diagnostic clock failure cannot prevent or replace an original authority write outcome',()=>{
  for(const fails of [false,true]){const record={},result={},error=Error('original'),clockError=Error('clock');let calls=0;const write=()=>{calls++;if(fails)throw error;return result;};
    if(fails)assert.throws(()=>observeE4AuthorityWrite(record,write,()=>{throw clockError;}),e=>e===error);else assert.equal(observeE4AuthorityWrite(record,write,()=>{throw clockError;}),result);
    assert.equal(calls,1);assert.equal(record.diagnosticWrite.clockError,true);assert.equal(record.diagnosticWrite.outcome,fails?'threw':'returned');}
});

test('E4 IDB metadata observation failure preserves the exact native transaction and is explicit',t=>{
  const f=transactionTimingFixture(t),db=new f.Database();Object.defineProperty(db,'name',{get(){throw Error('private metadata error');}});
  const tx=db.transaction('meta','readonly');assert.equal(tx,db.last);assert.equal(f.calls.length,1);
  assert.deepEqual(f.snapshot().errors,['E4_IDB_TIMING_OBSERVATION']);assert.deepEqual(f.snapshot().records,[]);
});
test('E4 transaction installation is idempotent and does not stack native wrappers',t=>{
  const f=transactionTimingFixture(t),installed=f.Database.prototype.transaction;
  runInContext(`(${installE4TransactionTiming.toString()})()`,f.context);
  assert.equal(f.Database.prototype.transaction,installed);assert.equal(f.context.__p25TransactionTiming,f.observer);
  new f.Database().transaction('meta','readonly').dispatchEvent(new Event('complete'));assert.equal(f.calls.length,1);assert.equal(f.snapshot().records.length,1);
});
test('E4 missing native transaction API remains an explicit incomplete diagnostic',()=>{
  const context=createContext({Date,performance:{now:()=>1,timeOrigin:0},TextEncoder});runInContext('globalThis.window=globalThis',context);
  runInContext(`(${installE4TransactionTiming.toString()})()`,context);
  const snapshot=plain(context.__p25TransactionTiming.snapshot());assert.deepEqual(snapshot.errors,['E4_IDB_TIMING_UNAVAILABLE']);assert.deepEqual(snapshot.phases.errors,['E4_PHASE_TIMING_UNAVAILABLE']);context.__p25TransactionTiming.dispose();
});

// Opt-in E4 phase diagnostics use the original consumer and its existing side
// branch only. These clocks describe callback observation, not network EOF or
// the instant at which the native promise settled.
test('phase diagnostics require true and an omitted profile before patching the realm', async t => {
  for (const phaseDiagnostics of [false, null, 0, 'true', {}]) await t.test(String(phaseDiagnostics), t => {
    assert.throws(() => fixture(t, {phaseDiagnostics}), /E4_OBSERVER_PHASE_PROFILE/);
  });
  for (const profile of ['v45-post', 'queue-ui', 'portable-review']) await t.test(profile, t => {
    assert.throws(() => fixture(t, {profile, phaseDiagnostics: true}), /E4_OBSERVER_PHASE_PROFILE/);
  });
});

test('omitted diagnostics preserve every profile snapshot and the original single publication clock read', async t => {
  for (const profile of [undefined, 'v45-post', 'queue-ui', 'portable-review']) await t.test(profile ?? 'E4', async t => {
    const f = fixture(t, profile ? {profile} : {}), text = queueText();
    let clockReads = 0;
    Object.defineProperty(f.clock, 'monotonic', {get() { clockReads++; return 20; }});
    const path = profile === 'portable-review' ? '/api/v1/bundle-reviews/review-1' : profile === 'queue-ui' ? '/api/v1/ui/action-1' : profile === 'v45-post' ? '/api/v1/commands' : '/api/v1/queue';
    const init = ['v45-post', 'queue-ui'].includes(profile) ? runInContext('({method:"POST"})', f.context) : undefined;
    const r = f.response(text, {path}); await f.consume(r, [encode(text)], init);
    assert.equal(clockReads, 0, 'default reader observation adds no phase clock calls');
    const value = f.parse(text);
    assert.equal(value, f.context.__parseCalls.find(call => call.args[0] === text).value);
    assert.equal(clockReads, 1); assert.equal(f.rows().length, 1);
    assert.deepEqual(Object.keys(f.observer.snapshot()).sort(), ['pending', 'ownedMethods', 'retainedBytes', 'recordBytes', 'rows', 'errors', 'droppedErrors', 'operations', 'disabled', 'disposed'].sort());
    assert.deepEqual(plain(f.rows()[0].value), profile ? JSON.parse(text) : {jobs: [{id: 'job-1', version: '2'}]});
    assert.equal(f.observer.snapshot().rows, 1);
    assert.equal(f.observer.snapshot().recordBytes, JSON.stringify(f.rows()[0]).length * 2);
    assert.deepEqual(r.calls.forbidden, []); assert.equal(r.calls.read.length, 2); assert.equal(f.errors().length, 0);
  });
});

test('phase times surround the original methods and uniquely matched parser with exact read ordinals', async t => {
  const f = fixture(t, {phaseDiagnostics: true}), text = queueText(), r = f.response(text), original = r.response.body.getReader;
  r.response.body.getReader = function (...args) {
    const reader = Reflect.apply(original, this, args), release = reader.releaseLock;
    reader.releaseLock = function (...args) { const value = Reflect.apply(release, this, args); f.clock.monotonic = 81; return value; };
    f.clock.monotonic = 11; return reader;
  };
  await f.fetchResponse(r); f.clock.monotonic = 10;
  const options = {}, reader = r.response.body.getReader(options);
  assert.equal(r.calls.getReader[0].receiver, r.response.body); assert.equal(r.calls.getReader[0].args[0], options);
  const bytes = encode(text), chunks = [bytes.subarray(0, 7), bytes.subarray(7)];
  for (let index = 0; index < chunks.length; index++) {
    f.clock.monotonic = 20 + index * 20; const argument = {index}, promise = reader.read(argument);
    assert.equal(promise, r.calls.read.at(-1).promise); assert.equal(r.calls.read.at(-1).args[0], argument);
    assert.equal(r.calls.read.at(-1).receiver, reader); f.clock.monotonic = 30 + index * 20;
    r.controller.enqueue(chunks[index]); assert.equal((await promise).value, chunks[index]);
  }
  f.clock.monotonic = 60; const done = reader.read(); assert.equal(done, r.calls.read.at(-1).promise);
  f.clock.monotonic = 70; r.controller.close(); assert.equal((await done).done, true);
  f.clock.monotonic = 80; assert.equal(reader.releaseLock(), undefined);
  const calls = f.context.__parseCalls, push = calls.push;
  calls.push = function (call) { f.clock.monotonic = 91; return Reflect.apply(push, this, [call]); };
  f.clock.monotonic = 90; const receiver = {}, parsed = Reflect.apply(f.json.parse, receiver, [text]);
  assert.equal(parsed, calls.at(-1).value); assert.equal(calls.at(-1).receiver, receiver);
  const snapshot = f.observer.snapshot(), diagnostic = plain(snapshot.phaseDiagnostics), row = diagnostic.records[0];
  assert.equal(row.operation, f.rows()[0].operation);
  assert.deepEqual([row.getReaderEntry, row.getReaderReturn, row.getReaderOutcome], [10, 11, 'returned']);
  assert.deepEqual([row.readCalls, row.readCallbacks, row.firstReadOrdinal, row.firstReadEntry, row.lastReadOrdinal, row.lastReadEntry], [3, 3, 1, 20, 3, 60]);
  assert.deepEqual([row.firstCallbackReadOrdinal, row.firstReadCallback, row.firstReadOutcome, row.lastCallbackReadOrdinal, row.lastReadCallback, row.lastReadOutcome], [1, 30, 'fulfilled', 3, 70, 'fulfilled']);
  assert.deepEqual([row.doneReadOrdinal, row.doneReadEntry, row.doneCallback, row.nativeEOF], [3, 60, 70, null]);
  assert.deepEqual([row.releaseLockEntry, row.releaseLockReturn, row.releaseLockOutcome], [80, 81, 'returned']);
  assert.deepEqual([row.parseEntry, row.parseReturn, row.parseOutcome], [90, 91, 'returned']);
  assert.deepEqual([row.responseJsonEntry, row.responseJsonCallback, row.responseJsonOutcome], [null, null, null]);
  assert.equal(row.retired, true); assert.equal(row.retirement, 'delivered');
  assert.equal(f.rows()[0].monotonic, 91); assert.equal(snapshot.rows, 2);
  assert.equal(snapshot.recordBytes, diagnostic.reservedBytes + JSON.stringify(f.rows()[0]).length * 2);
  assert.equal(diagnostic.reservedBytes, 4096); assert.equal(snapshot.pending, 0); assert.equal(snapshot.retainedBytes, 0);
  assert.equal(r.calls.read.length, 3); assert.deepEqual(r.calls.forbidden, []); assert.equal(f.errors().length, 0);
});

test('overlapping native reads attribute the first done callback to its own entry rather than the latest read', async t => {
  const f = fixture(t, {phaseDiagnostics: true}), text = queueText(), r = f.response(text); await f.fetchResponse(r);
  const reader = r.response.body.getReader(), promises = [];
  for (const at of [10, 20, 30]) { f.clock.monotonic = at; const promise = reader.read(); assert.equal(promise, r.calls.read.at(-1).promise); promises.push(promise); }
  f.clock.monotonic = 40; r.controller.enqueue(encode(text)); await promises[0];
  f.clock.monotonic = 60; r.controller.close(); const results = await Promise.all(promises.slice(1));
  assert.equal(results.every(result => result.done === true), true); reader.releaseLock(); f.parse(text);
  const row = f.observer.snapshot().phaseDiagnostics.records[0];
  assert.deepEqual([row.readCalls, row.readCallbacks, row.lastReadOrdinal, row.lastReadEntry], [3, 3, 3, 30]);
  assert.deepEqual([row.doneReadOrdinal, row.doneReadEntry, row.doneCallback], [2, 20, 60]);
  assert.equal(row.lastCallbackReadOrdinal, 3); assert.equal(row.nativeEOF, null); assert.equal(f.rows().length, 1); assert.equal(f.errors().length, 0);
});

test('phase parser association refuses incomplete locked unmatched coerced and reviver calls', async t => {
  for (const mode of ['incomplete', 'locked', 'unmatched', 'coerced', 'reviver']) await t.test(mode, async t => {
    const f = fixture(t, {phaseDiagnostics: true}), text = queueText(), r = f.response(text);
    if (mode === 'incomplete' || mode === 'locked') {
      await f.fetchResponse(r); const reader = r.response.body.getReader(); r.controller.enqueue(encode(text)); await reader.read();
      if (mode === 'locked') { r.controller.close(); await reader.read(); }
    } else await f.consume(r);
    const result = mode === 'reviver' ? f.parse(text, (key, value) => key === 'id' ? 'changed' : value)
      : mode === 'coerced' ? f.parse({toString: () => text}) : f.parse(mode === 'unmatched' ? ' ' + text : text);
    assert.equal(result, f.context.__parseCalls.at(-1).value);
    const row = f.observer.snapshot().phaseDiagnostics.records[0];
    assert.deepEqual([row.parseEntry, row.parseReturn, row.parseOutcome], [null, null, null]);
    assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0);
    if (mode === 'reviver') { assert.equal(result.jobs[0].id, 'changed'); assert.equal(row.retired, true); }
  });
});

test('ambiguous completed bodies retain refusal and no diagnostic parser attribution', async t => {
  const f = fixture(t, {phaseDiagnostics: true}), text = queueText();
  await f.consume(f.response(text)); await f.consume(f.response(text, {path: '/api/v1/jobs/job-1/candidates'}));
  assert.equal(f.parse(text).jobs[0].id, 'job-1');
  const snapshot = f.observer.snapshot(); assert.equal(snapshot.disabled, true); assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.phaseDiagnostics.records.length, 2);
  for (const row of snapshot.phaseDiagnostics.records) { assert.equal(row.parseEntry, null); assert.equal(row.parseReturn, null); assert.equal(row.retired, true); assert.equal(row.retirement, 'observer-failure'); }
  assert.equal(f.rows().length, 0); assert.ok(f.errors().some(error => error.code === 'E4_OBSERVER_AMBIGUOUS_BODY'));
});

test('native Response.json phases retain original promise result and rejection without claiming hidden parse or EOF', async t => {
  for (const mode of ['fulfilled', 'rejected']) await t.test(mode, async t => {
    const f = fixture(t, {phaseDiagnostics: true}), text = queueText(), r = f.response(text); await f.fetchResponse(r);
    f.clock.monotonic = 10; const argument = {}, promise = r.response.json(argument), call = r.calls.json.at(-1);
    assert.equal(promise, call.promise); assert.equal(call.receiver, r.response); assert.equal(call.args[0], argument);
    f.clock.monotonic = 50; const error = Error('private response failure');
    if (mode === 'fulfilled') { r.controller.enqueue(encode(text)); r.controller.close(); assert.equal(await promise, await call.promise); }
    else { r.controller.error(error); await assert.rejects(promise, value => value === error); }
    const row = f.observer.snapshot().phaseDiagnostics.records[0];
    assert.deepEqual([row.responseJsonEntry, row.responseJsonCallback, row.responseJsonOutcome], [10, 50, mode]);
    for (const key of ['getReaderEntry', 'getReaderReturn', 'firstReadEntry', 'doneReadOrdinal', 'doneCallback', 'nativeEOF', 'releaseLockEntry', 'parseEntry', 'parseReturn']) assert.equal(row[key], null, key);
    assert.equal(row.readCalls, 0); assert.equal(row.readCallbacks, 0); assert.equal(row.retired, true);
    assert.equal(f.rows().length, mode === 'fulfilled' ? 1 : 0); assert.equal(f.errors().length, 0); assert.deepEqual(r.calls.forbidden, []);
    assert.equal(JSON.stringify(row).includes('private response failure'), false);
  });
});

test('phase observation preserves original synchronous getReader read releaseLock and json errors', async t => {
  for (const method of ['getReader', 'read', 'releaseLock', 'json']) await t.test(method, async t => {
    const f = fixture(t, {phaseDiagnostics: true}), r = f.response(queueText()), error = Error('private native error');
    const throwing = function () { throw error; };
    if (method === 'json') r.response.json = throwing;
    else if (method === 'getReader') r.response.body.getReader = throwing;
    else {
      const original = r.response.body.getReader;
      r.response.body.getReader = function (...args) { const reader = Reflect.apply(original, this, args); reader[method] = throwing; return reader; };
    }
    await f.fetchResponse(r); f.clock.monotonic = 10;
    if (method === 'json') assert.throws(() => r.response.json(), value => value === error);
    else if (method === 'getReader') assert.throws(() => r.response.body.getReader(), value => value === error);
    else { const reader = r.response.body.getReader(); assert.throws(() => reader[method](), value => value === error); }
    const snapshot = f.observer.snapshot(), row = snapshot.phaseDiagnostics.records[0];
    assert.equal(snapshot.pending, 0); assert.equal(snapshot.retainedBytes, 0); assert.equal(row.retired, true);
    if (method === 'getReader') assert.deepEqual([row.getReaderEntry, row.getReaderReturn, row.getReaderOutcome], [10, null, 'threw']);
    if (method === 'releaseLock') assert.deepEqual([row.releaseLockEntry, row.releaseLockReturn, row.releaseLockOutcome], [10, null, 'threw']);
    if (method === 'json') assert.deepEqual([row.responseJsonEntry, row.responseJsonCallback, row.responseJsonOutcome], [10, null, 'threw']);
    if (method === 'read') { assert.equal(row.readCalls, 1); assert.equal(row.readCallbacks, 0); assert.equal(row.doneCallback, null); }
    assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0); assert.equal(JSON.stringify(row).includes('private native error'), false);
  });
});

test('matched original parser errors are preserved and recorded as throws without a fabricated return', async t => {
  const f = fixture(t, {phaseDiagnostics: true}), text = '{"jobs":['; await f.consume(f.response(text));
  f.clock.monotonic = 70; assert.throws(() => f.parse(text), value => value === f.context.__parseCalls.at(-1).error);
  const row = f.observer.snapshot().phaseDiagnostics.records[0];
  assert.deepEqual([row.parseEntry, row.parseReturn, row.parseOutcome], [70, null, 'threw']);
  assert.equal(row.retired, true); assert.equal(f.observer.snapshot().retainedBytes, 0); assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0);
});

test('original cancellation and rejected read callback retire diagnostics without changing their promises', async t => {
  for (const mode of ['cancel', 'reject']) await t.test(mode, async t => {
    const f = fixture(t, {phaseDiagnostics: true}), r = f.response(queueText()); await f.fetchResponse(r);
    const reader = r.response.body.getReader(), error = Error('private failure'); f.clock.monotonic = 10;
    const promise = reader.read(); assert.equal(promise, r.calls.read.at(-1).promise); f.clock.monotonic = 30;
    if (mode === 'cancel') { const cancel = reader.cancel(error); assert.equal(cancel, r.calls.cancel.at(-1).promise); await cancel; assert.equal((await promise).done, true); }
    else { r.controller.error(error); await assert.rejects(promise, value => value === error); }
    const row = f.observer.snapshot().phaseDiagnostics.records[0];
    assert.equal(row.retired, true); assert.equal(row.doneCallback, null); assert.equal(row.parseEntry, null);
    assert.equal(row.readCallbacks, mode === 'reject' ? 1 : 0);
    assert.equal(row.firstReadOutcome, mode === 'reject' ? 'rejected' : null);
    assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.observer.snapshot().retainedBytes, 0); assert.equal(f.errors().length, 0);
  });
});

test('dispose freezes the retained phase history while pending original reader and json promises still settle', async t => {
  for (const mode of ['reader', 'json']) await t.test(mode, async t => {
    const f = fixture(t, {phaseDiagnostics: true}), text = queueText(), r = f.response(text); await f.fetchResponse(r);
    const promise = mode === 'reader' ? r.response.body.getReader().read() : r.response.json();
    f.observer.dispose(); const sealed = plain(f.observer.snapshot().phaseDiagnostics);
    assert.equal(sealed.records[0].retirement, 'disposed'); assert.equal(sealed.records[0].retired, true);
    r.controller.enqueue(encode(text)); r.controller.close(); await promise;
    assert.deepEqual(plain(f.observer.snapshot().phaseDiagnostics), sealed);
    assert.equal(f.observer.snapshot().ownedMethods, 0); assert.equal(f.observer.snapshot().retainedBytes, 0); assert.equal(f.rows().length, 0); assert.equal(f.errors().length, 0);
  });
});

test('phase snapshots expose immutable detached scalar history and never body or error references', async t => {
  const f = fixture(t, {phaseDiagnostics: true}), text = queueText(), r = f.response(text); await f.fetchResponse(r);
  const first = f.observer.snapshot().phaseDiagnostics, row = first.records[0];
  assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.records), true); assert.equal(Object.isFrozen(row), true);
  assert.throws(() => { row.operation = 99; }, TypeError);
  const reader = r.response.body.getReader(); r.controller.enqueue(encode(text)); await reader.read(); r.controller.close(); await reader.read(); reader.releaseLock(); f.parse(text);
  const last = f.observer.snapshot().phaseDiagnostics;
  assert.notEqual(last, first); assert.notEqual(last.records[0], row); assert.equal(row.getReaderEntry, null); assert.equal(row.retired, false);
  assert.equal(last.records[0].retired, true);
  for (const value of Object.values(last.records[0])) assert.ok(value === null || ['number', 'string', 'boolean'].includes(typeof value));
  for (const privateText of [text, 'not retained', 'job-1', '/api/', origin]) assert.equal(JSON.stringify(last).includes(privateText), false);
});

test('diagnostic rows and byte reservations share the existing lifetime caps without resetting on drains', async t => {
  await t.test('row cap', async t => {
    const f = fixture(t, {phaseDiagnostics: true, limits: {rows: 1}}), text = queueText(); await f.consume(f.response(text));
    assert.equal(f.parse(text).jobs[0].id, 'job-1'); assert.equal(f.rows().length, 0);
    assert.ok(f.errors().some(error => error.code === 'E4_OBSERVER_ROW_LIMIT')); assert.equal(f.observer.snapshot().rows, 1);
    assert.equal(f.observer.snapshot().phaseDiagnostics.records[0].retirement, 'observer-failure');
    f.rows().length = 0; f.errors().length = 0;
    assert.equal(f.observer.snapshot().rows, 1); assert.equal(f.observer.snapshot().recordBytes, 4096);
  });
  await t.test('phase reservation', async t => {
    const f = fixture(t, {phaseDiagnostics: true, limits: {totalBytes: 4095}}), text = queueText(), r = f.response(text);
    await f.consume(r); assert.equal(f.parse(text).jobs[0].id, 'job-1');
    assert.equal(f.observer.snapshot().phaseDiagnostics.records.length, 0); assert.equal(f.observer.snapshot().recordBytes, 0);
    assert.ok(f.errors().some(error => error.code === 'E4_OBSERVER_PHASE_LIMIT')); assert.equal(f.rows().length, 0);
  });
  await t.test('original body reservation still counts', async t => {
    const text = queueText(), f = fixture(t, {phaseDiagnostics: true, limits: {totalBytes: 4096 + encode(text).length * 3 - 1}}), r = f.response(text);
    await f.consume(r); assert.equal(f.parse(text).jobs[0].id, 'job-1');
    assert.ok(f.errors().some(error => error.code === 'E4_OBSERVER_TOTAL_LIMIT')); assert.equal(f.observer.snapshot().retainedBytes, 0);
    assert.equal(f.observer.snapshot().recordBytes, 4096); assert.equal(f.rows().length, 0);
  });
});

test('an invalid diagnostic clock disables only observation and still returns the original reader', async t => {
  const f = fixture(t, {phaseDiagnostics: true}), r = f.response(queueText()); await f.fetchResponse(r);
  f.clock.monotonic = NaN; const reader = r.response.body.getReader();
  assert.equal(reader, r.calls.getReader.at(-1).reader); assert.equal(f.observer.snapshot().disabled, true);
  assert.equal(f.observer.snapshot().phaseDiagnostics.records[0].retirement, 'observer-failure');
  assert.ok(f.errors().some(error => error.code === 'E4_OBSERVER_PHASE_CLOCK')); assert.equal(f.rows().length, 0);
  assert.equal(f.observer.snapshot().pending, 0); assert.equal(f.observer.snapshot().retainedBytes, 0);
  r.controller.enqueue(encode(r.text)); const promise = reader.read(); assert.equal(promise, r.calls.read.at(-1).promise); assert.equal((await promise).done, false);
});

test('a repeated locked getReader attempt records a fresh thrown pair without borrowing the prior return', async t => {
  const f = fixture(t, {phaseDiagnostics: true}), r = f.response(queueText()); await f.fetchResponse(r);
  f.clock.monotonic = 10; const reader = r.response.body.getReader();
  assert.equal(reader, r.calls.getReader[0].reader); f.clock.monotonic = 30;
  assert.throws(() => r.response.body.getReader(), error => error === r.calls.getReader.at(-1).error);
  const row = f.observer.snapshot().phaseDiagnostics.records[0];
  assert.deepEqual([row.getReaderEntry, row.getReaderReturn, row.getReaderOutcome], [30, null, 'threw']);
  assert.equal(row.retired, true); assert.equal(row.parseEntry, null); assert.equal(f.observer.snapshot().retainedBytes, 0);
  assert.equal(f.errors().length, 0); assert.equal(f.rows().length, 0);
});

// Append to the existing tests/recovery/e4-delivery-observer.test.mjs owner.
// This fragment deliberately uses its native Response/ReadableStream fixture;
// it creates no separate test inventory entry and performs no browser campaign.
import {bindE4ProfilerContext} from './e4-profiler-binding.mjs';

const profilerContextKeys = ['p4WallMs', 'realmTimeOriginMs', 'f5WallMs', 'f5MonotonicMs',
  'f6WallMs', 'f6MonotonicMs', 'queueReadEntryMonotonicMs', 'queueReadCallbackMonotonicMs'];

async function profilerBindingFixture(t) {
  const f = fixture(t, {phaseDiagnostics: true}), timeOrigin = 1000;
  const jobId = 'job-profiler-private', attemptId = 'attempt-profiler-private';
  const candidate = {id: 'candidate-profiler-private', version: '4', preparedAssetId: 'asset-profiler-private',
    state: 'prepared', jobId, attemptId, documentId: 'document-profiler-private'};
  async function originalRead(text, path, timing) {
    const r = f.response(text, {path}); await f.fetchResponse(r);
    f.clock.monotonic = timing.getReader; const reader = r.response.body.getReader();
    const bytes = encode(text), chunks = timing.reads.length === 1 ? [bytes] : [bytes.subarray(0, 7), bytes.subarray(7)];
    for (let index = 0; index < chunks.length; index++) {
      f.clock.monotonic = timing.reads[index][0]; const pending = reader.read();
      assert.equal(pending, r.calls.read.at(-1).promise);
      f.clock.monotonic = timing.reads[index][1]; r.controller.enqueue(chunks[index]);
      assert.equal((await pending).value, chunks[index]);
    }
    f.clock.monotonic = timing.done[0]; const done = reader.read();
    f.clock.monotonic = timing.done[1]; r.controller.close(); assert.equal((await done).done, true);
    f.clock.monotonic = timing.unlock; reader.releaseLock();
    f.clock.monotonic = timing.parse; f.clock.wall = timeOrigin + timing.parse; f.parse(text);
    assert.deepEqual(r.calls.forbidden, []);
    return r;
  }
  const queue = await originalRead(JSON.stringify({jobs: [{id: jobId, version: '7', attempts: [{id: attemptId}]}]}),
    '/api/v1/queue', {getReader: 340, reads: [[350, 675], [676, 679]], done: [680, 681], unlock: 682, parse: 683});
  const prepared = await originalRead(JSON.stringify({jobId, documentId: candidate.documentId, items: [candidate]}),
    '/api/v1/jobs/' + jobId + '/candidates?attempt=' + attemptId + '&after=',
    {getReader: 684, reads: [[685, 690]], done: [691, 692], unlock: 693, parse: 694});
  assert.deepEqual(plain(f.errors()), []); assert.equal(f.observer.snapshot().pending, 0);
  const realm = {origin, timeOrigin};
  const input = {
    authority: [{phase: 'P3', clock: 'writer-wall-ms', at: 1280, jobId, attemptId},
      {phase: 'P4', clock: 'writer-wall-ms', at: 1400, monotonic: 80, jobId, attemptId, candidate}],
    deliveries: plain(f.rows()).map(row => ({...row, application: true, profilerCollection: 2})),
    phaseSnapshots: [{run: {family: 'e4', browser: 'firefox'}, collection: 2, realm,
      diagnostics: plain(f.observer.snapshot().phaseDiagnostics)}],
    states: [{name: 'F1'}, {name: 'F2'}, {name: 'F3'}, {name: 'F4'},
      {name: 'F5', publication: 'P3', text: 'Late result available; retrieving and verifying owned image bytes.',
        at: 1300, monotonic: 300, jobId, attemptId, profilerRealm: {...realm}},
      {name: 'F6', publication: 'P4', text: 'Output 1: prepared',
        at: 1710, monotonic: 710, jobId, attemptId, profilerRealm: {...realm}}],
    jobId, attemptId, deliveryErrors: [], phaseErrors: [],
  };
  return {input, f, queue, prepared};
}

function assertProfilerUnknown(input) {
  const result = bindE4ProfilerContext(input);
  assert.equal(result.status, 'unknown'); assert.equal(result.context, null);
  assert.equal(result.diagnosticOnly, true); assert.equal(result.qualification, false);
  assert.deepEqual(Object.keys(result).sort(), ['diagnosticOnly', 'qualification', 'status', 'reason', 'context'].sort());
  assert.match(result.reason, /^[A-Z_]+$/); assert.equal(Object.isFrozen(result), true);
  return result;
}

test('profiler binding joins actual original reader phases and retains a failing P4 interval without qualification', async t => {
  const {input, queue, prepared} = await profilerBindingFixture(t), before = structuredClone(input);
  // An inspector read is retained alongside application observations in E4.
  // It can occur earlier but cannot establish this binding.
  input.deliveries.unshift({at: 1401, path: input.deliveries[1].path, value: structuredClone(input.deliveries[1].value)});
  const result = bindE4ProfilerContext(input);
  assert.equal(result.status, 'bound'); assert.equal(result.reason, 'SAME_RUN_ORIGINAL_READ');
  assert.equal(result.diagnosticOnly, true); assert.equal(result.qualification, false);
  assert.equal(result.deliveryIntervalMs, 294); assert.ok(result.deliveryIntervalMs > 250);
  assert.deepEqual(Object.keys(result.context).sort(), [...profilerContextKeys].sort());
  assert.deepEqual(result.context, {p4WallMs: 1400, realmTimeOriginMs: 1000, f5WallMs: 1300, f5MonotonicMs: 300,
    f6WallMs: 1710, f6MonotonicMs: 710, queueReadEntryMonotonicMs: 350, queueReadCallbackMonotonicMs: 675});
  assert.ok(Object.values(result.context).every(value => typeof value === 'number' && Number.isFinite(value)));
  assert.equal(result.collection, 2); assert.equal(result.queueOperation, 1); assert.equal(result.candidateOperation, 2);
  assert.equal(result.clockToleranceMs, 5); assert.equal(result.wallClockUnitMs, 1); assert.equal(result.clockUncertaintyMs, null); assert.equal(Object.hasOwn(result, 'observedClockResolutionMs'), false);
  assert.equal(result.f5ClockResidualMs, 0); assert.equal(result.f6ClockResidualMs, 0);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.context), true);
  assert.equal(JSON.stringify(result).includes('profiler-private'), false);
  assert.equal(JSON.stringify(result).includes(origin), false);
  assert.equal(JSON.stringify(result).includes('retrieving'), false);
  assert.deepEqual(input.authority, before.authority); assert.deepEqual(input.phaseSnapshots, before.phaseSnapshots);
  assert.deepEqual(input.states, before.states); assert.equal(input.publications, undefined, 'P4 assertion can fail before a publication row exists');
  assert.equal(queue.calls.read.length, 3); assert.equal(prepared.calls.read.length, 2);
  assert.equal(result.context.queueReadCallbackMonotonicMs, input.phaseSnapshots[0].diagnostics.records[0].firstReadCallback);
  assert.notEqual(result.context.queueReadCallbackMonotonicMs, input.phaseSnapshots[0].diagnostics.records[0].doneCallback);
});

test('profiler binding tolerates cumulative phase snapshots without substituting a different collection', async t => {
  const {input} = await profilerBindingFixture(t), old = structuredClone(input.phaseSnapshots[0]);
  old.collection = 1; input.phaseSnapshots.unshift(old);
  assert.equal(bindE4ProfilerContext(input).status, 'bound');
  input.phaseSnapshots[1].diagnostics.records = input.phaseSnapshots[1].diagnostics.records.filter(row => row.operation !== 2);
  assertProfilerUnknown(input);
});

test('profiler binding never replaces the first matching original candidate with a later healthier read', async t => {
  const {input} = await profilerBindingFixture(t), later = structuredClone(input.deliveries[1]);
  later.operation = 4; later.at += 20; later.monotonic += 20;
  input.deliveries.push(later);
  const phases = input.phaseSnapshots[0].diagnostics.records;
  const laterPhase = (row, operation) => {
    const copy = structuredClone(row); copy.operation = operation;
    for (const key of ['getReaderEntry', 'getReaderReturn', 'firstReadEntry', 'lastReadEntry', 'firstReadCallback',
      'lastReadCallback', 'doneReadEntry', 'doneCallback', 'releaseLockEntry', 'releaseLockReturn', 'parseEntry', 'parseReturn']) copy[key] += 20;
    return copy;
  };
  phases.push(laterPhase(phases[0], 3), laterPhase(phases[1], 4));
  input.deliveries.push({...structuredClone(input.deliveries[0]), operation: 3, at: 1703, monotonic: 703});
  input.states[5].monotonic = 730; input.states[5].at = 1730;
  const alternateOnly = structuredClone(input); alternateOnly.deliveries = alternateOnly.deliveries.filter(row => row.operation >= 3);
  assert.equal(bindE4ProfilerContext(alternateOnly).status, 'bound', 'later read is independently complete; it still cannot replace the first matching original');
  input.deliveries[1].source = 'original-response-json';
  assertProfilerUnknown(input);
});

test('profiler binding refuses missing conflicting and unoriginal candidate or authority evidence', async t => {
  const {input} = await profilerBindingFixture(t);
  const mutations = [
    ['missing P4', x => {x.authority.pop();}],
    ['duplicate P4', x => {x.authority.push(structuredClone(x.authority[1]));}],
    ['different authority job', x => {x.authority[1].jobId = 'job-other';}],
    ['different authority attempt', x => {x.authority[1].attemptId = 'attempt-other';}],
    ['wrong authority clock', x => {x.authority[1].clock = 'browser-wall-ms';}],
    ['missing authority prepared asset', x => {delete x.authority[1].candidate.preparedAssetId;}],
    ['authority not prepared', x => {x.authority[1].candidate.state = 'retrieving';}],
    ['conflicting full candidate job', x => {x.authority[1].candidate.jobId = 'job-other';}],
    ['conflicting full candidate attempt', x => {x.authority[1].candidate.attemptId = 'attempt-other';}],
    ['missing full candidate job', x => {delete x.authority[1].candidate.jobId;}],
    ['missing full candidate attempt', x => {delete x.authority[1].candidate.attemptId;}],
    ['inspector-only candidate', x => {delete x.deliveries[1].application;}],
    ['native response json candidate', x => {x.deliveries[1].source = 'original-response-json';}],
    ['different candidate version', x => {x.deliveries[1].value.items[0].version = '5';}],
    ['different candidate asset', x => {x.deliveries[1].value.items[0].preparedAssetId = 'asset-other';}],
    ['duplicate matching candidate item', x => {x.deliveries[1].value.items.push(structuredClone(x.deliveries[1].value.items[0]));}],
    ['candidate before authority', x => {x.deliveries[1].at = 1399;}],
    ['uncollected candidate', x => {delete x.deliveries[1].profilerCollection;}],
    ['duplicate candidate operation', x => {x.deliveries.push(structuredClone(x.deliveries[1]));}],
    ['document history endpoint', x => {const d = x.deliveries[1]; d.path = '/api/v1/documents/document-profiler-private/candidates'; d.url = origin + d.path + '?attempt=' + x.attemptId + '&after=';}],
    ['different URL attempt', x => {x.deliveries[1].url = x.deliveries[1].url.replace(x.attemptId, 'attempt-other');}],
    ['later candidate page', x => {x.deliveries[1].url += 'next-page';}],
    ['extra candidate query', x => {x.deliveries[1].url += '&prompt=requested';}],
    ['missing empty after query', x => {x.deliveries[1].url = x.deliveries[1].url.replace('&after=', '');}],
    ['different candidate origin', x => {x.deliveries[1].url = x.deliveries[1].url.replace('4381', '4382');}],
    ['candidate redirect status', x => {x.deliveries[1].status = 302;}],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {const value = structuredClone(input); mutate(value); assertProfilerUnknown(value);});
});

test('profiler binding requires the preceding queue and completed exact original phase records', async t => {
  const {input} = await profilerBindingFixture(t);
  const mutations = [
    ['queue absent', x => {x.deliveries.shift();}],
    ['queue not adjacent operation', x => {x.deliveries[0].operation = 3;}],
    ['queue from another collection', x => {x.deliveries[0].profilerCollection = 1;}],
    ['queue duplicate operation', x => {x.deliveries.push(structuredClone(x.deliveries[0]));}],
    ['queue without target job', x => {x.deliveries[0].value.jobs[0].id = 'job-other';}],
    ['queue with duplicate target job', x => {x.deliveries[0].value.jobs.push(structuredClone(x.deliveries[0].value.jobs[0]));}],
    ['queue page cursor', x => {x.deliveries[0].url += '?after=next';}],
    ['queue inspector read', x => {delete x.deliveries[0].application;}],
    ['queue native json', x => {x.deliveries[0].source = 'original-response-json';}],
    ['queue publication after candidate reader', x => {x.deliveries[0].monotonic = 685; x.deliveries[0].at = 1685;}],
    ['missing candidate phase', x => {x.phaseSnapshots[0].diagnostics.records.pop();}],
    ['missing queue phase', x => {x.phaseSnapshots[0].diagnostics.records.shift();}],
    ['ambiguous candidate phase', x => {x.phaseSnapshots[0].diagnostics.records.push(structuredClone(x.phaseSnapshots[0].diagnostics.records[1]));}],
    ['ambiguous queue phase', x => {x.phaseSnapshots[0].diagnostics.records.push(structuredClone(x.phaseSnapshots[0].diagnostics.records[0]));}],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {const value = structuredClone(input); mutate(value); assertProfilerUnknown(value);});
  const phaseMutations = [
    ['read still pending', row => {row.readCallbacks--;}],
    ['reader still live', row => {row.retired = false;}],
    ['discarded reader', row => {row.retirement = 'disposed';}],
    ['getReader threw', row => {row.getReaderOutcome = 'threw';}],
    ['missing first read entry', row => {row.firstReadEntry = null;}],
    ['first callback belongs to read two', row => {row.firstCallbackReadOrdinal = 2;}],
    ['first read rejected', row => {row.firstReadOutcome = 'rejected';}],
    ['missing first callback', row => {row.firstReadCallback = null;}],
    ['EOF never observed', row => {row.doneCallback = null;}],
    ['overlapping later read unfinished', row => {row.doneReadOrdinal--;}],
    ['native EOF invented', row => {row.nativeEOF = row.doneCallback;}],
    ['release lock threw', row => {row.releaseLockOutcome = 'threw';}],
    ['parser threw', row => {row.parseOutcome = 'threw';}],
    ['response json mixed with reader', row => {row.responseJsonEntry = row.getReaderEntry;}],
    ['parse before unlock', row => {row.parseEntry = row.releaseLockEntry - 1;}],
    ['first callback before entry', row => {row.firstReadCallback = row.firstReadEntry - 1;}],
  ];
  for (const index of [0, 1]) for (const [name, mutate] of phaseMutations) await t.test((index ? 'candidate ' : 'queue ') + name, () => {
    const value = structuredClone(input); mutate(value.phaseSnapshots[0].diagnostics.records[index]); assertProfilerUnknown(value);
  });
});

test('profiler binding refuses missing semantic clocks and ambiguous or changed realms', async t => {
  const {input} = await profilerBindingFixture(t);
  const mutations = [
    ['missing F5', x => {x.states.splice(4, 1);}],
    ['missing F6', x => {x.states.pop();}],
    ['duplicate F5', x => {x.states[3] = structuredClone(x.states[4]);}],
    ['wrong F5 publication', x => {x.states[4].publication = 'P4';}],
    ['different F6 job', x => {x.states[5].jobId = 'job-other';}],
    ['different F6 attempt', x => {x.states[5].attemptId = 'attempt-other';}],
    ['missing F5 realm', x => {delete x.states[4].profilerRealm;}],
    ['missing F6 realm', x => {delete x.states[5].profilerRealm;}],
    ['F5 same origin different reload', x => {x.states[4].profilerRealm.timeOrigin += 1;}],
    ['F6 same origin different reload', x => {x.states[5].profilerRealm.timeOrigin += 1;}],
    ['F5 different server realm', x => {x.states[4].profilerRealm.origin = 'http://127.0.0.1:4382';}],
    ['F6 different server realm', x => {x.states[5].profilerRealm.origin = 'http://127.0.0.1:4382';}],
    ['F5 after queue start', x => {x.states[4].monotonic = 351; x.states[4].at = 1351;}],
    ['F6 before original delivery', x => {x.states[5].monotonic = 693; x.states[5].at = 1693;}],
    ['F6 before authority', x => {x.states[5].at = 1399;}],
    ['F5 wall clock drift', x => {x.states[4].at += 6;}],
    ['F6 wall clock drift', x => {x.states[5].at += 6;}],
    ['candidate wall clock drift', x => {x.deliveries[1].at += 6;}],
    ['queue wall clock drift', x => {x.deliveries[0].at += 6;}],
    ['candidate parser-publication gap', x => {x.deliveries[1].at += 6; x.deliveries[1].monotonic += 6;}],
    ['unknown browser realm', x => {x.phaseSnapshots[0].run.browser = 'chromium';}],
    ['missing snapshot', x => {x.phaseSnapshots = [];}],
    ['duplicate selected snapshot', x => {x.phaseSnapshots.push(structuredClone(x.phaseSnapshots[0]));}],
    ['missing time origin', x => {delete x.phaseSnapshots[0].realm.timeOrigin;}],
    ['wrong phase kind', x => {x.phaseSnapshots[0].diagnostics.kind = 'legacy-timing';}],
    ['wrong phase clock', x => {x.phaseSnapshots[0].diagnostics.clock = 'browser-wall-ms';}],
    ['delivery observer error', x => {x.deliveryErrors.push({code: 'E4_OBSERVER_LENGTH'});}],
    ['phase observer error', x => {x.phaseErrors.push('E4_DELIVERY_PHASE_SNAPSHOTS');}],
    ['non-finite semantic time', x => {x.states[5].monotonic = Infinity;}],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {const value = structuredClone(input); mutate(value); assertProfilerUnknown(value);});
});


import {e4ProfilerRequested} from './e4-profiler-binding.mjs';
test('E4 native profiler requires explicit exact opt-in on the selected Linux Firefox fixture',()=>{
 for(const browser of ['chromium','firefox','webkit'])assert.equal(e4ProfilerRequested({},browser,'darwin','arm64'),false);
 assert.equal(e4ProfilerRequested({IE_E4_FIREFOX_PROFILER:'1'},'firefox','linux','x64'),true);
 for(const [value,browser,platform,architecture] of [['true','firefox','linux','x64'],['0','firefox','linux','x64'],['','firefox','linux','x64'],[true,'firefox','linux','x64'],['1','chromium','linux','x64'],['1','webkit','linux','x64'],['1','firefox','darwin','arm64'],['1','firefox','linux','arm64']])assert.throws(()=>e4ProfilerRequested({IE_E4_FIREFOX_PROFILER:value},browser,platform,architecture),/^Error: E4_PROFILER_SELECTION$/);
});
