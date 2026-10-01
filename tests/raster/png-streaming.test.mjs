import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { crc32, inflateSync } from 'node:zlib';
import { rootFor } from '../store/helpers.mjs';
import { encodePNG } from '../../dist/local/server/raster/png.js';
import { encodeLegacyPNG } from './png-legacy-fixture.mjs';

function pixels(width, height, kind) {
  const bytes = Buffer.alloc(width * height * 4);
  let seed = 0x8f31b957;
  for (let i = 0; i < bytes.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    bytes[i] = kind === 'entropy' ? seed & 255 : kind === 'transparent' ? (i % 4 === 3 ? 0 : (i * 29) & 255) : kind === 'white' ? 255 : (i % 4 === 3 ? (i >>> 2) & 255 : (i * 17 + (i >>> 7)) & 255);
  }
  return bytes;
}

function verifyPNG(bytes, rgba, width, height) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = [], framing = [];
  let at = 8, ended = false;
  while (at < bytes.length) {
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    assert.ok(at + size + 12 <= bytes.length);
    assert.equal(bytes.readUInt32BE(at + size + 8), crc32(bytes.subarray(at + 4, at + size + 8)));
    if (type === 'IDAT') { idat.push(bytes.subarray(at + 8, at + 8 + size)); framing.push(size); }
    if (type === 'IEND') { assert.equal(size, 0); assert.equal(at + 12, bytes.length); ended = true; }
    at += size + 12;
  }
  assert.equal(ended, true);
  const filtered = inflateSync(Buffer.concat(idat));
  assert.equal(filtered.length, (width * 4 + 1) * height);
  for (let row = 0; row < height; row++) {
    const start = row * (width * 4 + 1);
    assert.equal(filtered[start], 0);
    assert.deepEqual(filtered.subarray(start + 1, start + 1 + width * 4), rgba.subarray(row * width * 4, (row + 1) * width * 4));
  }
  return framing;
}

async function delayedSink(t, run) {
  const create = fs.createWriteStream, write = fs.write, writev = fs.writev;
  let delayedWrites = 0;
  const replacement = t.mock.method(fs, 'createWriteStream', (path, options) => create(path, {
    ...options, highWaterMark: 1,
    fs: {
      open: fs.open, close: fs.close,
      write(...args) { delayedWrites++; setTimeout(() => write(...args), 2); },
      writev(...args) { delayedWrites++; setTimeout(() => writev(...args), 2); },
    },
  }));
  syncBuiltinESMExports();
  try { await run(); assert.ok(delayedWrites > 3, 'the encoder exercised delayed physical writes'); }
  finally { replacement.mock.restore(); syncBuiltinESMExports(); }
}

test('reusable PNG producer preserves complete legacy bytes and exact alpha across row boundaries', async t => {
  const root = await rootFor(t);
  for (const [width, height, kind] of [[1, 1, 'white'], [31, 29, 'transparent'], [257, 263, 'alpha'], [8192, 1, 'entropy'], [1, 8192, 'alpha'], [8192, 17, 'entropy'], [4093, 37, 'entropy']]) {
    const label = `${width}-${height}-${kind}`, raw = join(root, label + '.rgba'), current = join(root, label + '.png'), legacy = join(root, label + '-legacy.png');
    const rgba = pixels(width, height, kind); await writeFile(raw, rgba, { mode: 0o600 });
    await encodeLegacyPNG(raw, legacy, width, height, () => {});
    await encodePNG(raw, current, width, height, () => {});
    const before = await readFile(legacy), after = await readFile(current);
    const oldFraming = verifyPNG(before, rgba, width, height), newFraming = verifyPNG(after, rgba, width, height);
    assert.equal(after.equals(before), true, `${label}: complete encoded bytes, legacy IDAT ${oldFraming}, current IDAT ${newFraming}`);
  }
});

test('PNG IDAT framing and bytes survive slow output backpressure exactly as the frozen encoder', async t => {
  const root = await rootFor(t), width = 8191, height = 41, rgba = pixels(width, height, 'entropy'), raw = join(root, 'pixels.rgba');
  await writeFile(raw, rgba, { mode: 0o600 });
  const paths = ['legacy-normal', 'current-normal', 'legacy-delayed', 'current-delayed'].map(name => join(root, name + '.png'));
  await encodeLegacyPNG(raw, paths[0], width, height, () => {});
  await encodePNG(raw, paths[1], width, height, () => {});
  await delayedSink(t, async () => {
    await encodeLegacyPNG(raw, paths[2], width, height, () => {});
    await encodePNG(raw, paths[3], width, height, () => {});
  });
  const bytes = await Promise.all(paths.map(path => readFile(path)));
  const framing = bytes.map(value => verifyPNG(value, rgba, width, height));
  assert.ok(framing[0].length > 10, 'incompressible rows span many output chunks');
  assert.equal(bytes[2].equals(bytes[0]), true, `frozen legacy transport itself changed under backpressure: ${framing[0]} -> ${framing[2]}`);
  assert.equal(bytes[1].equals(bytes[0]), true, `normal sink IDAT: ${framing[0]} -> ${framing[1]}`);
  assert.equal(bytes[3].equals(bytes[2]), true, `delayed sink IDAT: ${framing[2]} -> ${framing[3]}`);
});

test('PNG emits output and accepts cancellation before consuming the complete input', async t => {
  const root = await rootFor(t), width = 2048, height = 512, rgba = pixels(width, height, 'entropy'), raw = join(root, 'pixels.rgba'), output = join(root, 'cancelled.png');
  await writeFile(raw, rgba, { mode: 0o600 });
  const identity = fs.statSync(raw), read = fs.read, readSync = fs.readSync;
  let readBytes = 0, largestRead = 0, cancelled = false;
  const isInput = fd => { const stat = fs.fstatSync(fd); return stat.dev === identity.dev && stat.ino === identity.ino; };
  const asyncRead = t.mock.method(fs, 'read', (fd, ...args) => {
    const source = isInput(fd), callback = args.pop();
    return read(fd, ...args, (error, count, buffer) => {
      if (source && !error) { readBytes += count; largestRead = Math.max(largestRead, count); }
      callback(error, count, buffer);
    });
  });
  const syncRead = t.mock.method(fs, 'readSync', (fd, ...args) => {
    const source = isInput(fd), count = readSync(fd, ...args);
    if (source) { readBytes += count; largestRead = Math.max(largestRead, count); }
    return count;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(encodePNG(raw, output, width, height, () => {
      if (fs.existsSync(output) && fs.statSync(output).size > 65536) { cancelled = true; throw Error('TEST_PNG_CANCEL'); }
    }), /TEST_PNG_CANCEL/);
  } finally { asyncRead.mock.restore(); syncRead.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(cancelled, true);
  assert.ok(readBytes > 0 && readBytes < rgba.length / 2, `read ${readBytes} of ${rgba.length} bytes before cancellation`);
  assert.ok(largestRead <= 256 * 1024, `single input read consumed ${largestRead} bytes`);
  // Returning means all writes are closed: immediate removal and retry are safe.
  await unlink(output);
  await encodePNG(raw, output, width, height, () => {});
  verifyPNG(await readFile(output), rgba, width, height);
  assert.deepEqual(await readFile(raw), rgba);
});
