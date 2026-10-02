import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRawTraceEvents,
  isRawTraceNumber,
  TraceJSONDecodeError,
} from '../../tooling/qualification/campaigns/display-feedback-json.mjs';

const encoder = new TextEncoder();

async function* bytes(text, chunkBytes = 7) {
  const encoded = encoder.encode(text);
  for (let offset = 0; offset < encoded.byteLength; offset += chunkBytes) {
    yield encoded.subarray(offset, offset + chunkBytes);
  }
}

async function* chunks(...values) {
  yield* values;
}

async function collect(input, options) {
  const events = [];
  for await (const event of decodeRawTraceEvents(input, options)) events.push(event);
  return events;
}

function document(event) {
  return `{"traceEvents":[${event}]}`;
}

function fails(text, options, code = 'TRACE_JSON_INVALID') {
  return assert.rejects(collect(bytes(text, 1), options), (error) => {
    assert.ok(error instanceof TraceJSONDecodeError);
    assert.equal(error.code, code);
    assert.ok(Number.isSafeInteger(error.byteOffset));
    assert.ok(!error.message.includes(text));
    return true;
  });
}

test('raw integer, decimal and exponent lexemes survive every nested position unchanged', async () => {
  const tokens = ['0', '-0', '9007199254740993', '18446744073709551615',
    '-9223372036854775808', '123456789.000000001', '1e9999', '1E+003', '-2.50e-07'];
  const source = document(`{"id":18446744073709551615,"ts":123456789.000000001,"args":{"values":[${tokens.join(',')}],"string":"18446744073709551615"}}`);
  const [event] = await collect(bytes(source, 1));
  assert.equal(Object.getPrototypeOf(event), Object.prototype);
  assert.equal(event.id.raw, '18446744073709551615');
  assert.equal(event.ts.raw, '123456789.000000001');
  assert.deepEqual(event.args.values.map((value) => value.raw), tokens);
  for (const token of [event.id, event.ts, ...event.args.values]) {
    assert.ok(isRawTraceNumber(token));
    assert.ok(Object.isFrozen(token));
    assert.deepEqual(Object.keys(token), ['kind', 'raw']);
    assert.equal(token.kind, 'trace-number');
    assert.throws(() => { token.raw = '0'; }, TypeError);
  }
  assert.equal(event.args.string, '18446744073709551615');
  assert.equal(isRawTraceNumber(event.args.string), false);
});

test('literal marker-shaped trace objects cannot impersonate numeric tokens', async () => {
  const [event] = await collect(bytes(document('{"real":7,"fake":{"kind":"trace-number","raw":"7"}}')));
  assert.deepEqual(event.real, event.fake);
  assert.equal(isRawTraceNumber(event.real), true);
  assert.equal(isRawTraceNumber(event.fake), false);
  Object.freeze(event.fake);
  assert.equal(isRawTraceNumber(event.fake), false);
  assert.equal(isRawTraceNumber(null), false);
  assert.equal(isRawTraceNumber(7), false);
});

test('every byte split preserves UTF-8, escapes, numbers and delimiters', async () => {
  const source = ' \r\n{"before":{"valid":[true,false,null,-0,1e99]},"traceEvents":[{"name":"é雪🎯","escaped":"\\uD834\\uDD1E\\u0000\\n\\t\\/\\\\\\\"","args":{"id":9007199254740993}}],"after":"ok"}\t';
  const encoded = encoder.encode(source);
  for (let split = 0; split <= encoded.byteLength; split += 1) {
    const [event] = await collect(chunks(encoded.subarray(0, split), encoded.subarray(split)));
    assert.equal(event.name, 'é雪🎯');
    assert.equal(event.escaped, '𝄞\0\n\t/\\"');
    assert.equal(event.args.id.raw, '9007199254740993');
  }
});

test('a single large input chunk is sliced without losing a split UTF-8 character', async () => {
  const prefix = '{"traceEvents":[{"name":"';
  const padding = 'x'.repeat(16 * 1024 - encoder.encode(prefix).byteLength - 1);
  const [event] = await collect(chunks(encoder.encode(prefix + padding + '🎯雪é"}]}')));
  assert.equal(event.name, padding + '🎯雪é');
  const [escaped] = await collect(bytes(document('{"high":"\\uD800","low":"\\uDC00"}'), 1));
  assert.equal(escaped.high, '\uD800');
  assert.equal(escaped.low, '\uDC00');
});

test('prototype-sensitive properties stay ordinary own keys without mutation', async () => {
  const [event] = await collect(bytes(document('{"__proto__":{"polluted":true},"constructor":5,"prototype":"own"}')));
  assert.equal(Object.getPrototypeOf(event), Object.prototype);
  assert.equal(Object.hasOwn(event, '__proto__'), true);
  assert.equal(event.__proto__.polluted, true);
  assert.equal(event.constructor.raw, '5');
  assert.equal(event.prototype, 'own');
  assert.equal(Object.hasOwn({}, 'polluted'), false);
});

test('root accepts only one object containing one traceEvents array of objects', async () => {
  assert.deepEqual(await collect(bytes('{"traceEvents":[]}')), []);
  assert.deepEqual(await collect(bytes('{"trace\\u0045vents":[{}]}')), [{}]);
  for (const invalid of ['[]', '{}', 'null', '{"metadata":[]}', '{"traceEvents":{}}',
    '{"traceEvents":null}', '{"traceEvents":[null]}', '{"traceEvents":[[]]}',
    '{"traceEvents":[1]}', '{"traceEvents":["event"]}']) {
    await fails(invalid);
  }
});

test('duplicates are rejected after key decoding in events and discarded metadata', async () => {
  for (const invalid of [
    '{"traceEvents":[],"traceEvents":[]}',
    '{"traceEvents":[],"trace\\u0045vents":[]}',
    '{"metadata":1,"traceEvents":[],"metadata":2}',
    document('{"x":1,"\\u0078":2}'),
    document('{"args":{"id":1,"id":2}}'),
    '{"metadata":{"nested":[{"a":1,"\\u0061":2}]},"traceEvents":[]}',
    '{"traceEvents":[{}],"metadata":{"__proto__":1,"__proto__":2}}',
  ]) await fails(invalid);
});

test('JSON grammar is checked in discarded values and across all truncated suffixes', async () => {
  for (const value of ['01', '-01', '+1', '.1', '1.', '1e', '1e+', '--1',
    'NaN', 'Infinity', 'truefalse', '[1,]', '{"x":1,}', '"\\x00"',
    '"\\u00X0"', '"raw\nline"', '"unterminated', '/* comment */0']) {
    await fails(`{"traceEvents":[],"metadata":${value}}`);
    await fails(document(`{"value":${value}}`));
  }
  const complete = document('{"name":"é雪🎯","args":[true,false,null,-1.25e+09,"\\u1234"]}');
  for (let end = 0; end < complete.length; end += 1) {
    await assert.rejects(collect(bytes(complete.slice(0, end), 1)), TraceJSONDecodeError);
  }
});

test('malformed UTF-8, BOM and UTF-8 trailing fragments fail without replacement', async () => {
  const prefix = encoder.encode('{"traceEvents":[{"name":"');
  const suffix = encoder.encode('"}]}');
  for (const malformed of [
    new Uint8Array([0xc0, 0xaf]), // Overlong encoding.
    new Uint8Array([0xed, 0xa0, 0x80]), // UTF-8 encoded surrogate.
    new Uint8Array([0xf4, 0x90, 0x80, 0x80]), // Above Unicode range.
    new Uint8Array([0x80]),
    new Uint8Array([0xe2, 0x28, 0xa1]),
  ]) {
    await assert.rejects(collect(chunks(prefix, malformed, suffix)), { code: 'TRACE_UTF8_INVALID' });
  }
  for (const fragment of [new Uint8Array([0xc3]), new Uint8Array([0xe2, 0x82]), new Uint8Array([0xf0, 0x9f, 0x8e])]) {
    await assert.rejects(collect(chunks(encoder.encode('{"traceEvents":[]}'), fragment)), { code: 'TRACE_UTF8_INVALID' });
  }
  await fails('\uFEFF{"traceEvents":[]}');
  await fails('{"traceEvents":[]}\uFEFF');
});

test('events remain provisional until the full root and trailer are exhausted', async () => {
  for (const tail of ['', ']} garbage', ']} {}', '],"metadata":{"x":1,"x":2}}', '],"metadata":1e}']) {
    const input = bytes('{"traceEvents":[{"id":18446744073709551615}' + tail, 1);
    const iterator = decodeRawTraceEvents(input);
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal(first.value.id.raw, '18446744073709551615');
    await assert.rejects(iterator.next(), TraceJSONDecodeError);
  }
  const valid = decodeRawTraceEvents(bytes('{"traceEvents":[{}],"metadata":{"ok":true}} \n'));
  assert.deepEqual(await valid.next(), { done: false, value: {} });
  assert.deepEqual(await valid.next(), { done: true, value: undefined });
});

test('a stream failure after an otherwise complete root prevents successful exhaustion', async () => {
  async function* broken() {
    yield encoder.encode('{"traceEvents":[{}]}');
    throw new Error('untrusted input detail');
  }
  const iterator = decodeRawTraceEvents(broken());
  assert.deepEqual(await iterator.next(), { done: false, value: {} });
  await assert.rejects(iterator.next(), { code: 'TRACE_STREAM_INVALID' });
});

test('event byte limits count exact original UTF-8 bytes and internal whitespace', async () => {
  assert.deepEqual(await collect(bytes(document('{}')), { maxEventBytes: 2 }), [{}]);
  await fails(document('{}'), { maxEventBytes: 1 }, 'TRACE_JSON_LIMIT');
  const event = '{"name":"é雪🎯", "payload": "abcdefghijklmnop"}';
  const size = encoder.encode(event).byteLength;
  assert.equal((await collect(bytes(document(event)), { maxEventBytes: size })).length, 1);
  await fails(document(event), { maxEventBytes: size - 1 }, 'TRACE_JSON_LIMIT');
  const ascii = '{"payload":"' + 'a'.repeat(64 * 1024) + '"}';
  await fails(document(ascii), undefined, 'TRACE_JSON_LIMIT');
  assert.equal((await collect(bytes(document(ascii), 8192), { maxEventBytes: 128 * 1024 })).length, 1);
});

test('total byte and event count limits include the full document and all events', async () => {
  const source = '{"metadata":"é雪🎯","traceEvents":[{},{}]} \n';
  const size = encoder.encode(source).byteLength;
  assert.equal((await collect(bytes(source), { maxTotalBytes: size, maxEvents: 2 })).length, 2);
  await fails(source, { maxTotalBytes: size - 1 }, 'TRACE_JSON_LIMIT');
  const iterator = decodeRawTraceEvents(bytes(source, 1), { maxEvents: 1 });
  assert.deepEqual(await iterator.next(), { done: false, value: {} });
  await assert.rejects(iterator.next(), { code: 'TRACE_JSON_LIMIT' });
});

test('nesting depth is enforced for retained events and discarded metadata', async () => {
  const event = document('{"value":{"nested":[]}}');
  assert.equal((await collect(bytes(event), { maxDepth: 5 })).length, 1);
  await fails(event, { maxDepth: 4 }, 'TRACE_JSON_LIMIT');
  const metadata = '{"traceEvents":[],"metadata":[{"nested":[]}]}';
  assert.deepEqual(await collect(bytes(metadata), { maxDepth: 4 }), []);
  await fails(metadata, { maxDepth: 3 }, 'TRACE_JSON_LIMIT');
  const depth64 = '{"traceEvents":[],"metadata":' + '['.repeat(63) + 'null' + ']'.repeat(63) + '}';
  assert.deepEqual(await collect(bytes(depth64)), []);
  await fails('{"traceEvents":[],"metadata":' + '['.repeat(64) + 'null' + ']'.repeat(64) + '}', undefined, 'TRACE_JSON_LIMIT');
});

test('metadata is discarded with bounded duplicate-key tracking', async () => {
  const source = '{"metadata":{"large":"' + 'x'.repeat(128 * 1024) + '","number":' + '9'.repeat(128 * 1024) + '},"traceEvents":[{}]}';
  assert.deepEqual(await collect(bytes(source, 16 * 1024), { maxEventBytes: 64 }), [{}]);
  assert.deepEqual(await collect(bytes('{"traceEvents":[],"metadata":{"a":0,"b":0}}'), { maxObjectKeys: 2 }), []);
  await fails('{"traceEvents":[],"metadata":{"a":0,"b":0,"c":0}}', { maxObjectKeys: 2 }, 'TRACE_JSON_LIMIT');
  await fails('{"traceEvents":[],"metadata":{"' + 'a'.repeat(65) + '":0}}', { maxEventBytes: 64 }, 'TRACE_JSON_LIMIT');
  await fails('{"traceEvents":[],"metadata":{"' + 'a'.repeat(31) + '":0,"' + 'b'.repeat(31) + '":0}}', { maxEventBytes: 64 }, 'TRACE_JSON_LIMIT');
});

test('limits reject unsafe, unsupported and coercible configurations', async () => {
  for (const options of [null, [], { maxEvents: 0 }, { maxDepth: 65 },
    { maxEventBytes: 4 * 1024 * 1024 + 1 }, { maxTotalBytes: 128 * 1024 * 1024 + 1 },
    { maxEvents: 1_000_001 }, { maxObjectKeys: 65_537 }, { maxDepth: '3' },
    { maxEvents: NaN }, { maxEventBytes: 1.5 }, { maxTotalBytes: Infinity },
    { maxEventSize: 1024 }]) {
    await assert.rejects(collect(bytes('{"traceEvents":[]}'), options), TypeError);
  }
});

test('invalid input chunks and stream failures are terminal and sanitized', async () => {
  for (const value of ['{"traceEvents":[]}', new ArrayBuffer(1), null]) {
    await assert.rejects(collect(chunks(value)), { code: 'TRACE_STREAM_INVALID' });
  }
  const broken = {
    async *[Symbol.asyncIterator]() {
      yield encoder.encode('{"traceEvents":[');
      throw new Error('secret raw trace contents');
    },
  };
  await assert.rejects(collect(broken), (error) => {
    assert.equal(error.code, 'TRACE_STREAM_INVALID');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  await assert.rejects(collect([encoder.encode('{"traceEvents":[]}')]), TypeError);
});

test('an unbounded stream of empty chunks cannot evade the byte progress limit', async () => {
  async function* input(count) {
    for (let index = 0; index < count; index += 1) yield new Uint8Array();
    yield encoder.encode('{"traceEvents":[]}');
  }
  assert.deepEqual(await collect(input(4096)), []);
  await assert.rejects(collect(input(4097)), { code: 'TRACE_JSON_LIMIT' });
});

test('generator cancellation and parser failure close the upstream iterator', async () => {
  let closed = 0;
  async function* input() {
    try {
      yield encoder.encode('{"traceEvents":[{},{}]}');
      yield encoder.encode(' ');
    } finally { closed += 1; }
  }
  const iterator = decodeRawTraceEvents(input());
  await iterator.next();
  await iterator.return();
  assert.equal(closed, 1);
  async function* invalid() {
    try { yield encoder.encode('{"traceEvents":[1]}'); }
    finally { closed += 1; }
  }
  await assert.rejects(collect(invalid()), TraceJSONDecodeError);
  assert.equal(closed, 2);
});

test('an upstream cleanup failure does not replace the original parser failure', async () => {
  const source = {
    [Symbol.asyncIterator]() {
      return {
        async next() { return { done: false, value: encoder.encode('{"traceEvents":[1]}') }; },
        async return() { throw new Error('untrusted cleanup detail'); },
      };
    },
  };
  await assert.rejects(collect(source), { code: 'TRACE_JSON_INVALID' });
});
