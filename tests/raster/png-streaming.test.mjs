import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { crc32, inflateSync, deflateSync } from 'node:zlib';
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
  const idat = [], framing = [], types = [], nonIDAT = [];
  let at = 8, ended = false;
  while (at < bytes.length) {
    assert.ok(at + 12 <= bytes.length);
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    assert.ok(at + size + 12 <= bytes.length);
    assert.equal(bytes.readUInt32BE(at + size + 8), crc32(bytes.subarray(at + 4, at + size + 8)));
    types.push(type);
    const data = bytes.subarray(at + 8, at + 8 + size);
    if (type === 'IDAT') { assert.ok(size > 0); idat.push(data); framing.push(size); }
    else nonIDAT.push(bytes.subarray(at, at + size + 12));
    if (type === 'IHDR') {
      assert.equal(size, 13); assert.equal(data.readUInt32BE(0), width); assert.equal(data.readUInt32BE(4), height);
      assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0]);
    }
    if (type === 'sRGB') assert.deepEqual([...data], [0]);
    if (type === 'IEND') { assert.equal(size, 0); assert.equal(at + 12, bytes.length); ended = true; }
    at += size + 12;
  }
  assert.equal(ended, true);
  assert.ok(framing.length > 0);
  assert.deepEqual(types, ['IHDR', 'sRGB', ...framing.map(() => 'IDAT'), 'IEND'], 'ordered PNG structure with contiguous IDAT chunks');
  const compressed = Buffer.concat(idat), filtered = inflateSync(compressed);
  assert.equal(filtered.length, (width * 4 + 1) * height);
  for (let row = 0; row < height; row++) {
    const start = row * (width * 4 + 1);
    assert.equal(filtered[start], 0);
    assert.deepEqual(filtered.subarray(start + 1, start + 1 + width * 4), rgba.subarray(row * width * 4, (row + 1) * width * 4));
  }
  return { framing, compressed, nonIDAT: Buffer.concat(nonIDAT) };
}

// Native end timing can place the final flush in a different deflate invocation.
// Preserve every compressed byte and the exact ordered non-IDAT container bytes;
// verifyPNG independently checks every chunk CRC, legal ordering and every pixel.
function assertEncodingEqual(before, after, label) {
  assert.equal(after.compressed.equals(before.compressed), true, `${label}: exact compressed IDAT payload`);
  assert.equal(after.nonIDAT.equals(before.nonIDAT), true, `${label}: exact non-IDAT container bytes`);
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

test('reusable PNG producer preserves exact legacy compressed data, container metadata and alpha across row boundaries', async t => {
  const root = await rootFor(t);
  for (const [width, height, kind] of [[1, 1, 'white'], [31, 29, 'transparent'], [257, 263, 'alpha'], [8192, 1, 'entropy'], [1, 8192, 'alpha'], [8192, 17, 'entropy'], [4093, 37, 'entropy']]) {
    const label = `${width}-${height}-${kind}`, raw = join(root, label + '.rgba'), current = join(root, label + '.png'), legacy = join(root, label + '-legacy.png');
    const rgba = pixels(width, height, kind); await writeFile(raw, rgba, { mode: 0o600 });
    await encodeLegacyPNG(raw, legacy, width, height, () => {});
    await encodePNG(raw, current, width, height, () => {});
    const before = await readFile(legacy), after = await readFile(current);
    const oldEncoding = verifyPNG(before, rgba, width, height), newEncoding = verifyPNG(after, rgba, width, height);
    assertEncodingEqual(oldEncoding, newEncoding, label);
  }
});

test('PNG compressed data and container metadata survive slow output backpressure exactly as the frozen encoder', async t => {
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
  const encodings = bytes.map(value => verifyPNG(value, rgba, width, height));
  assert.ok(encodings[0].framing.length > 10, 'incompressible rows span many output chunks');
  assertEncodingEqual(encodings[0], encodings[2], 'frozen encoder under backpressure');
  assertEncodingEqual(encodings[0], encodings[1], 'current encoder with normal sink');
  assertEncodingEqual(encodings[2], encodings[3], 'current encoder with delayed sink');
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

test('PNG equivalence permits only IDAT splitting while rejecting changed compression, metadata, CRC and ordering', async t => {
  const root = await rootFor(t), width = 31, height = 29, rgba = pixels(width, height, 'alpha');
  const raw = join(root, 'controls.rgba'), output = join(root, 'controls.png');
  await writeFile(raw, rgba, { mode: 0o600 });
  await encodePNG(raw, output, width, height, () => {});
  const original = await readFile(output), expected = verifyPNG(original, rgba, width, height), chunks = [];
  for (let at = 8; at < original.length;) {
    const size = original.readUInt32BE(at), type = original.toString('ascii', at + 4, at + 8);
    chunks.push({ type, data: original.subarray(at + 8, at + 8 + size) }); at += size + 12;
  }
  const chunk = (type, data) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); result.write(type, 4, 4, 'ascii'); result.set(data, 8);
    result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4); return result;
  };
  const render = list => Buffer.concat([original.subarray(0, 8), ...list.map(({ type, data }) => chunk(type, data))]);
  const ihdr = chunks[0], srgb = chunks[1], end = chunks.at(-1);
  const first = { type: 'IDAT', data: expected.compressed.subarray(0, 1) };
  const rest = { type: 'IDAT', data: expected.compressed.subarray(1) };
  const split = render([ihdr, srgb, first, rest, end]);
  assertEncodingEqual(expected, verifyPNG(split, rgba, width, height), 'legal contiguous split');

  // Recompression still decodes to identical RGBA, but must not pass the pinned
  // compressed-byte regression. No expected PNG is re-encoded for the positives.
  const different = { type: 'IDAT', data: deflateSync(inflateSync(expected.compressed), { level: 0 }) };
  const recompressed = verifyPNG(render([ihdr, srgb, different, end]), rgba, width, height);
  assert.throws(() => assertEncodingEqual(expected, recompressed, 'changed compression'), /exact compressed IDAT payload/);
  assert.throws(() => verifyPNG(render([ihdr, srgb, first, srgb, rest, end]), rgba, width, height), /ordered PNG structure/);
  assert.throws(() => verifyPNG(render([ihdr, { type: 'sRGB', data: Buffer.from([1]) }, first, rest, end]), rgba, width, height));
  assert.throws(() => verifyPNG(render([ihdr, srgb, first, rest]), rgba, width, height));
  const badCRC = Buffer.from(split), firstIDAT = 8 + ihdr.data.length + 12 + srgb.data.length + 12;
  badCRC[firstIDAT + 8 + first.data.length] ^= 1;
  assert.throws(() => verifyPNG(badCRC, rgba, width, height));
  assert.deepEqual(await readFile(raw), rgba);
});
