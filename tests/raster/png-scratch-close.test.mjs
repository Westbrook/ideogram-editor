// Install beside png-scratch.test.mjs. These tests use real zlib and filesystem
// streams; only terminal callback timing and one physical write error are held.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { rootFor } from '../store/helpers.mjs';
import { encodeScratchPNG } from '../../dist/local/server/raster/png-scratch.js';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out: ' + label)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function turns() { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); }
function sourceUnchanged(fd, before) {
  const after = fs.fstatSync(fd, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key], 'Borrowed source remains open and unchanged: ' + key);
}
function pixels(width, height) {
  const bytes = Buffer.alloc(width * height * 4), alpha = [0, 1, 127, 128, 254, 255]; let seed = 0x563e289a;
  for (let i = 0; i < bytes.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; bytes[i] = i % 4 === 3 ? alpha[(i >>> 2) % alpha.length] : seed & 255; }
  return bytes;
}
function exactPixels(png, expected, width, height) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const types = [], idat = []; let at = 8;
  while (at < png.length) {
    assert(at + 12 <= png.length); const length = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8), end = at + 12 + length;
    assert(end <= png.length); assert.equal(png.readUInt32BE(end - 4), zlib.crc32(png.subarray(at + 4, end - 4))); types.push(type);
    if (type === 'IHDR') { assert.equal(length, 13); assert.equal(png.readUInt32BE(at + 8), width); assert.equal(png.readUInt32BE(at + 12), height); assert.deepEqual([...png.subarray(at + 16, at + 21)], [8, 6, 0, 0, 0]); }
    if (type === 'sRGB') assert.deepEqual([...png.subarray(at + 8, end - 4)], [0]);
    if (type === 'IDAT') idat.push(png.subarray(at + 8, end - 4));
    if (type === 'IEND') { assert.equal(length, 0); assert.equal(end, png.length); }
    at = end;
  }
  assert.deepEqual(types.slice(0, 2), ['IHDR', 'sRGB']); assert.equal(types.at(-1), 'IEND'); assert(idat.length > 0); assert(types.slice(2, -1).every(type => type === 'IDAT'));
  const filtered = zlib.inflateSync(Buffer.concat(idat)); assert.equal(filtered.length, height * (width * 4 + 1));
  for (let y = 0; y < height; y++) { const at = y * (width * 4 + 1); assert.equal(filtered[at], 0); assert.deepEqual(filtered.subarray(at + 1, at + 1 + width * 4), expected.subarray(y * width * 4, (y + 1) * width * 4)); }
}

for (const phase of ['success', 'cancel', 'output-error']) {
  test('scratch PNG drains actual compressor close before ' + phase + ' settles', { timeout: 15000, concurrency: false }, async t => {
    const root = await rootFor(t), raw = join(root, 'pixels.rgba'), output = join(root, 'scratch.png'), width = 73, height = 37, input = pixels(width, height);
    await writeFile(raw, input, { flag: 'wx', mode: 0o600 });
    const fd = fs.openSync(raw, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), before = fs.fstatSync(fd, { bigint: true });
    const destroyHeld = deferred(), compressorClosed = deferred(), targetClosed = deferred(), compressorFinished = deferred();
    const injected = Object.assign(Error('TEST_SCRATCH_' + phase), { code: phase === 'output-error' ? 'EIO' : 'TEST_CANCEL' });
    const realDeflate = zlib.createDeflate, realTarget = fs.createWriteStream, realWrite = fs.write, realWritev = fs.writev;
    let compressor, target, terminalCallback, releaseRequested = false, nativeDestroyCompleted = false, closeCount = 0, targetCloseCount = 0, finishObserved = false;
    let headerObserved = false, cancelArmed = false, failNextWrite = false, faultCount = 0, settlement = 'pending', pending, abortHeaderWait, completed = false;
    const release = () => { releaseRequested = true; if (terminalCallback) { const callback = terminalCallback; terminalCallback = undefined; callback(); } };
    const deflatePatch = t.mock.method(zlib, 'createDeflate', (...args) => {
      assert.equal(compressor, undefined, 'One real compressor is created'); compressor = realDeflate(...args);
      compressor.once('finish', () => { finishObserved = true; compressorFinished.resolve(); });
      compressor.once('close', () => { closeCount++; compressorClosed.resolve(); });
      const actualDestroy = compressor._destroy;
      compressor._destroy = function(error, callback) {
        // Run real native teardown; withhold only its final Transform callback.
        actualDestroy.call(this, error, innerError => {
          nativeDestroyCompleted = true; terminalCallback = () => callback(innerError); destroyHeld.resolve();
          if (releaseRequested) release();
        });
      };
      return compressor;
    });
    const targetPatch = t.mock.method(fs, 'createWriteStream', (path, options) => {
      assert.equal(path, output); assert.equal(target, undefined);
      const physical = (buffers, perform, callback) => {
        if (failNextWrite) { failNextWrite = false; faultCount++; queueMicrotask(() => callback(injected)); return; }
        const header = !headerObserved && buffers.some(bytes => bytes.length === 8 && bytes.toString('ascii', 4, 8) === 'IDAT');
        if (header) headerObserved = true;
        perform((error, ...values) => {
          if (error || !header || phase === 'success') { callback(error, ...values); return; }
          if (releaseRequested) { callback(Error('TEST_SCRATCH_CLEANUP')); return; }
          // This tiny image fits zlib's readable queue. Let real production
          // finish before faulting, so an unresolved row producer cannot hide
          // a missing terminal-close await on the encoder's error path.
          let completedHeader = false;
          abortHeaderWait = () => { if (completedHeader) return; completedHeader = true; abortHeaderWait = undefined; callback(Error('TEST_SCRATCH_CLEANUP')); };
          compressorFinished.promise.then(() => {
            if (completedHeader) return; completedHeader = true; abortHeaderWait = undefined;
            if (phase === 'cancel') cancelArmed = true; else failNextWrite = true;
            callback(null, ...values);
          });
        });
      };
      target = realTarget(path, { ...options, fs: {
        open: fs.open, close: fs.close,
        write(file, buffer, offset, length, position, callback) { physical([buffer.subarray(offset, offset + length)], next => realWrite(file, buffer, offset, length, position, next), callback); },
        writev(file, buffers, position, callback) { physical(buffers, next => realWritev(file, buffers, position, next), callback); },
      } });
      target.once('close', () => { targetCloseCount++; targetClosed.resolve(); }); return target;
    });
    syncBuiltinESMExports();
    try {
      pending = encodeScratchPNG(fd, output, width, height, () => { if (cancelArmed) { faultCount++; throw injected; } }).then(
        () => { settlement = 'fulfilled'; return { status: 'fulfilled' }; },
        error => { settlement = 'rejected'; return { status: 'rejected', error }; },
      );
      await bounded(destroyHeld.promise, 'real compressor destroy callback');
      assert(nativeDestroyCompleted); assert(finishObserved, 'Every row was consumed before terminal observation'); assert(headerObserved);
      if (phase !== 'success') await bounded(targetClosed.promise, 'failed target physical close');
      await turns();
      assert.equal(closeCount, 0, 'Compressor close is genuinely held'); assert.equal(compressor.closed, false);
      assert.equal(settlement, 'pending', 'Encoder must not settle while the compressor terminal callback is held');
      sourceUnchanged(fd, before);
      release(); await bounded(compressorClosed.promise, 'released compressor physical close');
      const result = await bounded(pending, 'encoder settlement after close');
      assert.equal(closeCount, 1); assert.equal(targetCloseCount, 1); assert.equal(compressor.closed, true); assert.equal(target.closed, true);
      if (phase === 'success') { assert.equal(result.status, 'fulfilled'); assert.equal(faultCount, 0); exactPixels(await readFile(output), input, width, height); }
      else { assert.equal(result.status, 'rejected'); assert.equal(result.error, injected, 'Terminal cleanup must preserve the original cancellation/write error'); assert.equal(faultCount, 1); }
      sourceUnchanged(fd, before); assert.deepEqual(await readFile(raw), input); completed = true;
    } finally {
      // An assertion on the unfixed encoder must still release the real stream
      // and settle all owned work before rootFor removes its scratch directory.
      release(); compressor?.destroy(); target?.destroy(); abortHeaderWait?.();
      try {
        const drains = [];
        if (pending) drains.push(bounded(pending, 'emergency encoder settlement'));
        if (compressor) drains.push(bounded(compressorClosed.promise, 'emergency compressor close'));
        if (target) drains.push(bounded(targetClosed.promise, 'emergency target close'));
        const drained = await Promise.allSettled(drains);
        // Preserve any original assertion failure; on an otherwise successful
        // path, an incomplete emergency drain must itself fail the test.
        if (completed) for (const result of drained) assert.equal(result.status, 'fulfilled', result.reason?.message);
      }
      finally { deflatePatch.mock.restore(); targetPatch.mock.restore(); syncBuiltinESMExports(); fs.closeSync(fd); }
    }
    await unlink(output); assert.deepEqual(await readdir(root), ['pixels.rgba']);
    const retry = fs.openSync(raw, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { await encodeScratchPNG(retry, output, width, height, () => {}); assert.equal(fs.fstatSync(retry).size, input.length); }
    finally { fs.closeSync(retry); }
    exactPixels(await readFile(output), input, width, height); assert.deepEqual(await readFile(raw), input);
    await unlink(output); assert.deepEqual(await readdir(root), ['pixels.rgba'], 'Returned promise permits same-path cleanup and retry');
  });
}
