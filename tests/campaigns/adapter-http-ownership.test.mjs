import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { consumeControlBytes, parseControlJSON, CONTROL_BYTES } from '../../dist/local/server/control-json.js';
import { observeProtocolStream, sendJSON, writeProtocolBytes } from '../../dist/local/server/protocol.js';
import { adapterResources } from '../../dist/local/server/observability/adapter-resources.js';

const options = { timeout: 10000, concurrency: false };
const deferred = () => Promise.withResolvers();
const group = (snapshot, owner, kind) => snapshot.groups.find(value => value.owner === owner && value.kind === kind) ?? { buffers: 0, handles: 0 };
function baseline() {
  const value = adapterResources.snapshot();
  assert.equal(value.activeLeases, 0, 'previous HTTP operation retained a lease');
  assert.equal(value.returnedBuffers, 0, 'previous HTTP operation retained returned bytes');
  assert.equal(value.cpuBytes, 0, 'previous HTTP operation retained backing bytes');
  adapterResources.resetPeaks();
  return value;
}
function released(before) {
  const after = adapterResources.snapshot();
  for (const key of ['cpuBytes', 'backingStores', 'activeLeases', 'returnedBuffers', 'droppedTransitions', 'unscopedReturnedBuffers']) {
    assert.equal(after[key], before[key], `${key} did not return to its initial value`);
  }
  assert.equal(after.aggregate.currentCpuBytes, before.aggregate.currentCpuBytes);
}

async function serve(t, handler) {
  const finished = deferred();
  finished.promise.catch(() => {});
  const server = createServer((request, response) => {
    Promise.resolve().then(() => handler(request, response)).then(finished.resolve, error => {
      response.destroy(); finished.reject(error);
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { port: server.address().port, finished: finished.promise };
}
function exchange(port, headers = {}, method = 'POST') {
  const received = deferred(), complete = deferred();
  received.promise.catch(() => {}); complete.promise.catch(() => {});
  const request = httpRequest({ hostname: '127.0.0.1', port, path: '/', method, headers, agent: false });
  request.on('error', error => { received.reject(error); complete.reject(error); });
  request.on('response', response => {
    received.resolve(response);
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('error', complete.reject);
    response.on('end', () => complete.resolve(Buffer.concat(chunks)));
  });
  return { request, received: received.promise, complete: complete.promise };
}
function reached(server, promise) {
  return Promise.race([promise, server.finished.then(() => { throw Error('HTTP handler ended before the expected barrier'); })]);
}

test('HTTP control ownership observes incoming/assembled overlap and survives an awaited consumer', options, async t => {
  const before = baseline(), entered = deferred(), resume = deferred();
  t.after(() => resume.resolve());
  // Unpooled output guarantees a distinct assembled backing, independent of TCP fragmentation.
  const body = Buffer.from(JSON.stringify({ text: 'x'.repeat(48000) }));
  const server = await serve(t, async (request, response) => {
    const result = await consumeControlBytes(request, async bytes => {
      assert.equal(Buffer.compare(bytes, body), 0);
      entered.resolve({ snapshot: adapterResources.snapshot(), backing: bytes.buffer.byteLength });
      await resume.promise;
      assert.equal(Buffer.compare(bytes, body), 0);
      return parseControlJSON(bytes);
    });
    assert.equal(result.text.length, 48000);
    response.end('ok');
  });
  const client = exchange(server.port, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  client.request.end(body);
  const inside = await reached(server, entered.promise);
  assert.equal(group(inside.snapshot, 'control-http', 'incoming-chunk').buffers, 0);
  assert.equal(group(inside.snapshot, 'control-http', 'read-stream').handles, 0);
  assert.equal(group(inside.snapshot, 'control-http', 'body-bytes').buffers, 1);
  assert.equal(group(inside.snapshot, 'control-http', 'consumer').handles, 1);
  assert.equal(inside.snapshot.cpuBytes, inside.backing);
  assert.ok(inside.snapshot.peakCpuBytes >= body.length + inside.backing,
    'peak must include incoming storage while the assembled copy is acquired');
  assert.equal(group(adapterResources.snapshot(), 'control-http', 'body-bytes').buffers, 1);
  resume.resolve();
  assert.equal((await client.complete).toString(), 'ok');
  await server.finished;
  released(before);
});

test('HTTP malformed JSON releases control chunks, assembled bytes, and consumer ownership', options, async t => {
  const before = baseline();
  const server = await serve(t, async (request, response) => {
    await assert.rejects(consumeControlBytes(request, parseControlJSON), error => error.code === 'MALFORMED_REQUEST');
    released(before);
    response.writeHead(400); response.end();
  });
  const client = exchange(server.port, { 'Content-Type': 'application/json' });
  client.request.end('{"unfinished":');
  await client.complete; await server.finished;
  released(before);
});

test('HTTP chunked overflow releases incoming ownership without entering a consumer', options, async t => {
  const before = baseline(); let consumed = false;
  const server = await serve(t, async (request, response) => {
    await assert.rejects(consumeControlBytes(request, () => { consumed = true; }), error => error.code === 'PAYLOAD_TOO_LARGE');
    assert.equal(consumed, false);
    released(before);
    request.resume(); response.writeHead(413); response.end();
  });
  const client = exchange(server.port, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
  client.request.end(Buffer.alloc(CONTROL_BYTES + 1, 0x20));
  await client.complete; await server.finished;
  released(before);
});

test('HTTP asynchronous consumer rejection releases the retained control body', options, async t => {
  const before = baseline(), entered = deferred(), resume = deferred(), failure = Error('consumer rejected');
  t.after(() => resume.resolve());
  const server = await serve(t, async (request, response) => {
    await assert.rejects(consumeControlBytes(request, async () => {
      entered.resolve(); await resume.promise; throw failure;
    }), error => error === failure);
    released(before);
    response.writeHead(500); response.end();
  });
  const client = exchange(server.port, { 'Content-Type': 'application/json' });
  client.request.end('{}');
  await reached(server, entered.promise);
  assert.equal(group(adapterResources.snapshot(), 'control-http', 'body-bytes').buffers, 1);
  assert.equal(group(adapterResources.snapshot(), 'control-http', 'consumer').handles, 1);
  resume.resolve();
  await client.complete; await server.finished;
  released(before);
});

test('sendJSON after an actual client close acquires no stranded response buffer', options, async t => {
  const before = baseline(), entered = deferred(), closed = deferred(), resume = deferred();
  t.after(() => resume.resolve());
  const server = await serve(t, async (_request, response) => {
    response.once('close', closed.resolve);
    entered.resolve();
    await resume.promise;
    assert.equal(response.closed, true);
    sendJSON(response, 200, { text: 'closed response'.repeat(1000) });
    released(before);
  });
  const client = exchange(server.port, {}, 'GET'); client.request.end();
  await reached(server, entered.promise);
  client.request.destroy();
  await closed.promise;
  resume.resolve(); await server.finished;
  released(before);
});

test('content response finish releases its stream handle and returned byte consumer', options, async t => {
  const before = baseline(), entered = deferred(), resume = deferred(); let returnedReleased = false;
  t.after(() => resume.resolve());
  const server = await serve(t, async (_request, response) => {
    observeProtocolStream(response, 'content-stream');
    const finished = once(response, 'finish');
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.flushHeaders();
    entered.resolve(); await resume.promise;
    const bytes = adapterResources.returnedBuffer('http-ownership-test', 'returned-bytes', new Uint8Array(32768));
    try { await writeProtocolBytes(response, bytes); }
    finally { returnedReleased = adapterResources.releaseReturned(bytes); }
    response.end(); await finished;
  });
  const client = exchange(server.port, {}, 'GET'); client.request.end();
  await client.received; await reached(server, entered.promise);
  assert.equal(group(adapterResources.snapshot(), 'protocol-http', 'content-stream').handles, 1);
  resume.resolve();
  assert.equal((await client.complete).length, 32768);
  await server.finished;
  assert.equal(returnedReleased, true); released(before);
});

test('SSE response ownership remains active until an actual client disconnect', options, async t => {
  const before = baseline();
  const server = await serve(t, async (_request, response) => {
    observeProtocolStream(response, 'sse-stream');
    const closed = new Promise(resolve => response.once('close', resolve));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
    await closed;
  });
  const client = exchange(server.port, {}, 'GET'); client.request.end();
  const incoming = await client.received;
  assert.equal(group(adapterResources.snapshot(), 'protocol-http', 'sse-stream').handles, 1);
  incoming.destroy();
  await server.finished;
  released(before);
});

for (const failurePath of ['socket-close', 'write-error']) {
  test(`native ${failurePath} settles a pending content write and releases returned bytes in finally`, options, async t => {
    const before = baseline(); let returnedReleased = false;
    const server = await serve(t, async (_request, response) => {
      observeProtocolStream(response, 'content-stream');
      const closed = new Promise(resolve => response.once('close', resolve));
      const bytes = adapterResources.returnedBuffer('http-ownership-test', 'returned-bytes', new Uint8Array(32768));
      const failure = Error('controlled disconnect');
      // With implicit chunked encoding, native response corking holds the callback.
      // Socket-only destruction requires the close fallback; response destruction
      // uncorks pending writes with the supplied native error.
      response.cork();
      const pending = (async () => {
        try { await writeProtocolBytes(response, bytes); }
        finally { returnedReleased = adapterResources.releaseReturned(bytes); }
      })();
      const rejected = assert.rejects(pending, error => failurePath === 'write-error'
        ? error === failure : error.message === 'HTTP response closed');
      assert.equal(adapterResources.snapshot().returnedBuffers, 1);
      assert.equal(group(adapterResources.snapshot(), 'protocol-http', 'content-stream').handles, 1);
      if (failurePath === 'write-error') response.destroy(failure);
      else response.socket.destroy();
      await rejected; await closed;
      // Dispose Node's corked storage. A late write callback must be harmless.
      response.uncork();
      assert.equal(adapterResources.releaseReturned(bytes), false);
      assert.equal(response.destroyed, true);
    });
    const client = exchange(server.port, {}, 'GET'); client.request.end();
    await server.finished;
    assert.equal(returnedReleased, true);
    released(before);
  });
}
