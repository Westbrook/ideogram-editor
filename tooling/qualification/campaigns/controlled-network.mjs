// Local real-byte transfer pacing. This does not assert kernel-level RTT/loss.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHUNK = 65536;
const withoutPrefix = value => String(value).replace(/^sha256:/, '');
async function delay(ms, signal) {
  signal?.throwIfAborted(); if (ms <= 0) return;
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? Error('Transfer aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function write(file, bytes) { let offset = 0; while (offset < bytes.length) { const result = await file.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) throw Error('Upload storage made no progress'); offset += result.bytesWritten; } }

export function pacingDeadline(startMs, cumulativeBytes, mbps) {
  if (![startMs, cumulativeBytes, mbps].every(Number.isFinite) || startMs < 0 || cumulativeBytes < 0 || mbps <= 0) throw Error('Invalid transfer pacing input');
  return startMs + cumulativeBytes * 8 / (mbps * 1000);
}

/** Every chunk is actual bytes, paced before its write, with no token-bucket burst. */
export async function* pacedChunks(chunks, { mbps, signal, observations = [] }) {
  const startMs = performance.now(); let bytes = 0;
  for await (const input of chunks) {
    if (!(input instanceof Uint8Array) || !input.length || input.length > 1048576) throw Error('Expected bounded nonempty transfer chunks');
    for (let offset = 0; offset < input.length; offset += CHUNK) {
      const chunk = input.subarray(offset, Math.min(input.length, offset + CHUNK)); bytes += chunk.length;
      const deadlineMs = pacingDeadline(startMs, bytes, mbps); await delay(Math.max(0, deadlineMs - performance.now()), signal);
      observations.push({ cumulativeBytes: bytes, chunkBytes: chunk.length, deadlineMs, releasedMs: performance.now() }); yield chunk;
    }
  }
}

export async function startControlledNetwork({ downloadFile, downloadBytes, downloadHash, signal, output, upMbps = 20, downMbps = 100, rttMs = 40 }) {
  if (upMbps !== 20 || downMbps !== 100 || rttMs !== 40) throw Error('This fixture implements only the declared normal N application pacing');
  const controller = new AbortController(), abort = () => controller.abort(signal.reason ?? Error('Transfer aborted'));
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const directory = output ? join(output, 'network-' + randomUUID()) : await mkdtemp(join(tmpdir(), 'ideogram-network-'));
  if (output) await mkdir(directory, { mode: 0o700 });
  const effects = [], errors = [], downloads = new Map(), expectedUploads = [], pending = new Set(), sockets = new Set();
  let origin, closed = false;
  async function addDownload(file, bytes, hash) {
    const info = await stat(file); assert.equal(info.size, Number(bytes)); assert(/^[a-f0-9]{64}$/.test(withoutPrefix(hash)));
    const path = '/image/' + randomUUID(); downloads.set(path, { file, bytes: Number(bytes), hash: withoutPrefix(hash) }); return origin + path;
  }
  const server = createServer((request, response) => {
    const work = (async () => {
      const effect = { method: request.method, path: request.url, startedMs: performance.now(), bytes: 0, hash: null, pacing: [], outcome: 'incomplete' }; effects.push(effect);
      // Application response delay is retained explicitly; no claim that this
      // changes TCP handshake, ACK behavior or physical link RTT is made.
      await delay(rttMs, controller.signal);
      if (request.method === 'POST' && request.url === '/upload') {
        const expected = expectedUploads.shift(); if (!expected) throw Error('Unexpected upload; no declared byte/hash identity');
        assert.equal(request.headers['content-length'], String(expected.bytes));
        const filePath = join(directory, randomUUID() + '.upload'), file = await open(filePath, 'wx', 0o600), hash = createHash('sha256');
        try {
          for await (const chunk of request) {
            controller.signal.throwIfAborted(); assert(chunk.length <= 1048576); effect.bytes += chunk.length; assert(effect.bytes <= expected.bytes);
            hash.update(chunk); await write(file, chunk);
          }
          assert.equal(effect.bytes, expected.bytes); effect.hash = hash.digest('hex'); assert.equal(effect.hash, withoutPrefix(expected.hash)); await file.sync();
        } finally { await file.close(); }
        const url = await addDownload(filePath, effect.bytes, effect.hash); const body = Buffer.from(JSON.stringify({ url }));
        Object.assign(effect, { outcome: 'complete', finishedMs: performance.now(), file: filePath, providerReadableURL: url });
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length }); response.end(body); return;
      }
      if (request.method === 'GET' && downloads.has(request.url)) {
        const download = downloads.get(request.url), hash = createHash('sha256');
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': download.bytes, etag: '"' + download.hash + '"' });
        for await (const chunk of pacedChunks(createReadStream(download.file, { highWaterMark: CHUNK }), { mbps: downMbps, signal: controller.signal, observations: effect.pacing })) {
          effect.bytes += chunk.length; hash.update(chunk);
          if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
        }
        effect.hash = hash.digest('hex'); assert.equal(effect.bytes, download.bytes); assert.equal(effect.hash, download.hash);
        Object.assign(effect, { outcome: 'complete', finishedMs: performance.now() }); response.end(); return;
      }
      throw Error('Unexpected controlled transfer route');
    })().catch(error => { errors.push({ message: error.message, code: error.code ?? null }); if (!response.headersSent) response.writeHead(500); response.destroy(error); });
    pending.add(work); void work.finally(() => pending.delete(work));
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = 'http://127.0.0.1:' + server.address().port;
  const downloadURL = downloadFile ? await addDownload(downloadFile, downloadBytes, downloadHash) : null;
  return {
    origin, uploadURL: origin + '/upload', downloadURL, directory, effects, errors,
    policy: { mode: 'application-pacing', uploadMbps: upMbps, downloadMbps: downMbps, responseDelayMs: rttMs, physicalRTTQualified: false, physicalPacketLossQualified: false },
    addDownload,
    expectUpload(identity) { if (!Number.isSafeInteger(Number(identity.bytes)) || Number(identity.bytes) < 0 || !/^[a-f0-9]{64}$/.test(withoutPrefix(identity.hash))) throw Error('Expected upload needs exact byte/hash identity'); expectedUploads.push({ bytes: Number(identity.bytes), hash: identity.hash }); },
    uploadChunks(chunks, observations = []) { return pacedChunks(chunks, { mbps: upMbps, signal: controller.signal, observations }); },
    async close() {
      if (closed) return; closed = true; controller.abort(Error('Controlled transfer fixture closed'));
      signal?.removeEventListener('abort', abort); const stopped = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy();
      await stopped; await Promise.allSettled([...pending]);
      return { directory, activeSockets: sockets.size, incompleteExpectedUploads: expectedUploads.length, effects, errors, retained: true };
    },
  };
}
