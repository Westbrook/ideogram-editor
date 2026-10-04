// Test-only loopback policy and scheduler. No application entry point imports this module.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import sharp from 'sharp';
import { emulator, fixtureProfile, SENTINEL_KEY, SENTINEL_COOKIE } from '../provider/emulator.mjs';
import { egressAttempts } from '../provider/no-egress.mjs';
import { QueueDispatcher } from '../../dist/local/server/provider/dispatcher.js';
import { ResultObserver } from '../../dist/local/server/provider/observer.js';
import { fixtureClosureResources, assertFixtureClosure } from './fixture-closure.mjs';

const endpoint = 'ideogram/v4/inpaint';
const profile = fixtureProfile({ id: 'local-fixture-inpaint-v1', endpoint });
const sha256 = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

async function inspectUpload(id, bytes, url) {
  const { data, info } = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let blackPixels = 0, whitePixels = 0, opaquePixels = 0;
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3] !== 255) continue;
    opaquePixels++;
    if (data[at] === 0 && data[at + 1] === 0 && data[at + 2] === 0) blackPixels++;
    if (data[at] === 255 && data[at + 1] === 255 && data[at + 2] === 255) whitePixels++;
  }
  return {
    id, url, bytes: bytes.length, sha256: sha256(bytes), pixelSha256: sha256(data),
    width: info.width, height: info.height, channels: info.channels,
    opaquePixels, blackPixels, whitePixels,
    binaryOpaque: blackPixels + whitePixels === info.width * info.height,
  };
}

export async function setup(store) {
  const effects = [], uploads = [], submissions = [], requests = new Map(), uploadedBytes = new Map();
  const errors = [], diagnostics = [], failures = [], sockets = new Set();
  let origin = '', pending, closing = false, context = null;
  const fixtureOptions = new URL(import.meta.url).searchParams;
  assert([...fixtureOptions.keys()].every(key => key === 'resultSize') && fixtureOptions.getAll('resultSize').length <= 1, 'Unknown or repeated local fixture option');
  const configuredSize = fixtureOptions.get('resultSize') ?? '512';
  assert(configuredSize === '256' || configuredSize === '512', 'Only the two local fixture result grids are allowed');
  const resultSize = Number(configuredSize);
  const png = await sharp({ create: { width: resultSize, height: resultSize, channels: 4, background: '#2468ac' } }).png().toBuffer();
  const mark = (phase, jobId, attemptId) => {
    context = { phase, jobId, attemptId, endpoint, profileId: profile.id };
    diagnostics.push({ ...context });
    if (diagnostics.length > 256) diagnostics.shift();
  };
  const failure = (error, where = context) => {
    errors.push(String(error));
    failures.push({ ...where, error: { name: error.name, message: error.message, stack: error.stack } });
  };
  const write = extra => {
    const filename = join(store.root, 'request-edits-fixture.json');
    writeFileSync(filename + '.tmp', JSON.stringify({
      effects, uploads, submissions, errors, egressAttempts: egressAttempts(),
      counts: {
        total: effects.length,
        uploads: effects.filter(e => e.method === 'POST' && e.path === '/upload').length,
        submissions: effects.filter(e => e.method === 'POST' && e.path === '/' + endpoint).length,
        status: effects.filter(e => e.method === 'GET' && e.path.endsWith('/status')).length,
        results: effects.filter(e => e.method === 'GET' && /^\/ideogram\/v4\/inpaint\/requests\/[^/]+$/.test(e.path)).length,
        media: effects.filter(e => e.method === 'GET' && e.path.startsWith('/image/')).length,
      },
      profiles: [{ id: profile.id, endpoint: profile.endpoint, version: profile.version }],
      result: { width: resultSize, height: resultSize, rgba: [36, 104, 172, 255], bytes: png.length, sha256: sha256(png) },
      diagnostics, failures, ...extra,
    }, null, 2), { mode: 0o600 });
    renameSync(filename + '.tmp', filename);
  };
  const server = createServer(async (req, res) => {
    try {
      const parts = [];
      for await (const bytes of req) parts.push(bytes);
      const body = Buffer.concat(parts), path = new URL(req.url, origin).pathname;
      effects.push({ method: req.method, path, bytes: body.length, sha256: sha256(body) });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', SENTINEL_COOKIE);
      if (req.method === 'POST' && path === '/upload') {
        const id = 'upload_' + (uploads.length + 1), url = origin + '/uploaded/' + id;
        const upload = await inspectUpload(id, body, url);
        uploads.push(upload);
        uploadedBytes.set(id, body);
        res.end(JSON.stringify({ url }));
      } else if (req.method === 'POST' && path === '/' + endpoint) {
        const value = JSON.parse(body.toString()), id = 'fixture_' + (requests.size + 1);
        const source = uploads.find(upload => upload.url === value.image_url);
        const mask = uploads.find(upload => upload.url === value.mask_url);
        assert(source, 'Submission source must be a retained fixture upload');
        assert(mask, 'Submission mask must be a retained fixture upload');
        assert.notEqual(source.id, mask.id, 'Source and mask are separate uploads');
        for (const upload of [source, mask]) {
          assert.equal(upload.width, 512, 'Frozen request width');
          assert.equal(upload.height, 512, 'Frozen request height');
        }
        assert.equal(mask.binaryOpaque, true, 'Provider mask is opaque binary black/white');
        const submission = { id, endpoint, value, sourceUploadId: source.id, maskUploadId: mask.id };
        submissions.push(submission);
        requests.set(id, submission);
        const base = origin + '/' + endpoint + '/requests/' + id;
        res.end(JSON.stringify({ request_id: id, status_url: base + '/status', response_url: base, cancel_url: base + '/cancel' }));
      } else if (req.method === 'GET' && path.startsWith('/image/')) {
        const id = path.slice('/image/'.length);
        assert(requests.has(id), 'Image belongs to an acknowledged request');
        res.setHeader('Content-Type', 'image/png');
        res.end(png);
      } else if (req.method === 'GET' && path.startsWith('/uploaded/')) {
        const bytes = uploadedBytes.get(path.slice('/uploaded/'.length));
        assert(bytes, 'Uploaded image exists');
        res.setHeader('Content-Type', 'image/png');
        res.end(bytes);
      } else {
        assert.equal(req.method, 'GET');
        const match = /^\/ideogram\/v4\/inpaint\/requests\/([^/]+)(\/status)?$/.exec(path);
        assert(match, 'Only exact inpaint status and result routes are allowed');
        const request = requests.get(match[1]);
        assert(request, 'Request identity exists');
        if (match[2]) res.end(JSON.stringify({ request_id: request.id, status: 'COMPLETED' }));
        else res.end(JSON.stringify({
          images: [{ url: origin + '/image/' + request.id + '?token=fixture-transfer-secret', content_type: 'image/png', file_size: png.length, width: resultSize, height: resultSize }],
          prompt: request.value.prompt, seed: 31, timings: { inference: 0.4 }, has_nsfw_concepts: [false],
        }));
      }
      write({ closed: false });
    } catch (error) {
      failure(error, { phase: 'emulator', jobId: null, attemptId: null, endpoint, profileId: profile.id });
      res.statusCode = 500;
      res.end('{}');
      write({ closed: false });
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  const provider = emulator({ queueOrigin: origin, mediaOrigin: origin, uploadOrigin: origin, profiles: [profile] });
  const dispatcher = new QueueDispatcher(store.queue, provider, {
    queueOrigin: origin, mediaOrigin: origin, uploadURL: origin + '/upload', profileId: profile.id,
  });
  // Selection and diagnostics only: transitions still use the real stores and dispatcher.
  const candidates = new Proxy(store.candidates, { get(target, key) {
    if (key === 'due') return now => target.due(now).filter(f => store.queue.recovery(f.jobId, f.attemptId).endpoint === endpoint);
    if (key === 'retries') return () => target.retries().filter(c => store.queue.recovery(c.jobId, c.attemptId).endpoint === endpoint);
    const value = target[key];
    if (typeof value !== 'function') return value;
    if (key === 'transfer') return (...args) => {
      const fence = args[0];
      mark('transfer', fence.jobId, fence.attemptId);
      return value.apply(target, args);
    };
    return value.bind(target);
  } });
  const reads = new Proxy(dispatcher, { get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    if (key === 'readKnown') return (jobId, attemptId, kind) => {
      mark(kind, jobId, attemptId);
      return value.call(target, jobId, attemptId, kind);
    };
    return value.bind(target);
  } });
  const observer = new ResultObserver(candidates, provider, reads, profile.id, [SENTINEL_KEY, SENTINEL_COOKIE]);
  const timer = setInterval(() => {
    if (closing || pending) return;
    pending = (async () => {
      for (const job of store.queue.view().jobs) {
        if (closing) break;
        if (job.review.endpoint === endpoint && job.attempts.at(-1).state === 'not-started') {
          mark('submit', job.id, job.attempts.at(-1).id);
          await dispatcher.submit(job.id);
        }
      }
      await observer.tick();
    })().catch(error => {
      failure(error);
      closing = true;
      clearInterval(timer);
      write({ closed: false });
    }).finally(() => { pending = undefined; });
  }, 100);
  write({ closed: false });
  const close = async () => {
    closing = true;
    clearInterval(timer);
    observer.close();
    await pending;
    const socketClosures = [...sockets].map(socket => new Promise(resolve => socket.once('close', resolve)));
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
    await Promise.all([closed, ...socketClosures]);
    write({ closed: false, fixtureStopped: true });
  };
  // The storage worker calls this only after its existing real owner drains.
  // Raster observation rings are disposed then; read live ownership scalars,
  // not a stale pre-drain diagnostic or invented empty observation arrays.
  close.afterStoreDrain = () => {
    const resources = fixtureClosureResources(store, { listening: server.listening, sockets: sockets.size, pending: Boolean(pending) });
    write({ closed: false, fixtureStopped: true, resources });
    assertFixtureClosure(resources, errors, egressAttempts());
    write({ closed: true, fixtureStopped: true, resources });
  };
  return close;
}
