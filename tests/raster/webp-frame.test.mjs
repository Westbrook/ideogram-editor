import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { rootFor } from '../store/helpers.mjs';
import { decodeWebPFrame, webpFrameBytes } from '../../dist/local/server/raster/webp-frame.js';
import { webpSourceStamp } from '../../dist/local/server/raster/webp-metadata.js';

function chunk(type, data, padding = 0) {
  const bytes = Buffer.alloc(8 + data.length + data.length % 2, padding);
  bytes.write(type, 0, 4, 'latin1'); bytes.writeUInt32LE(data.length, 4); data.copy(bytes, 8); return bytes;
}
function riff(parts) {
  const body = Buffer.concat([Buffer.from('WEBP'), ...parts]), header = Buffer.alloc(8);
  header.write('RIFF'); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body]);
}
function fixtureImage(name) {
  const bytes = readFileSync(new URL('./fixtures/' + name, import.meta.url));
  for (let at = 12; at < bytes.length;) {
    const type = bytes.toString('latin1', at, at + 4), length = bytes.readUInt32LE(at + 4);
    if (type === 'VP8 ' || type === 'VP8L') return { type, data: Buffer.from(bytes.subarray(at + 8, at + 8 + length)) };
    at += 8 + length + length % 2;
  }
  throw Error('Fixture has no image bitstream');
}
async function privateFrame(t, { lossless = false, odd = false } = {}) {
  const root = await rootFor(t), path = join(root, 'original.webp');
  const image = fixtureImage(lossless ? 'alpha-lossless.webp' : 'white-lossy.webp');
  if (odd && image.data.length % 2 === 0) image.data = Buffer.concat([image.data, Buffer.from([0])]);
  const bits = image.type === 'VP8L' ? image.data.readUInt32LE(1) : 0;
  const width = image.type === 'VP8L' ? 1 + (bits & 16383) : image.data.readUInt16LE(6) & 16383;
  const height = image.type === 'VP8L' ? 1 + ((bits >>> 14) & 16383) : image.data.readUInt16LE(8) & 16383;
  const extended = Buffer.alloc(10); extended.writeUIntLE(width - 1, 4, 3); extended.writeUIntLE(height - 1, 7, 3);
  // Its invalid compression/reserved bits must never reach the decoder when
  // the frozen demuxer's clear alpha flag causes it to discard this plane.
  const alpha = chunk('ALPH', Buffer.from([255, 170, 187]));
  const imageChunk = chunk(image.type, image.data, 165);
  const parts = [chunk('VP8X', extended), ...(lossless ? [imageChunk, alpha] : [alpha, imageChunk]), chunk('EXIF', Buffer.from('kept'))];
  const bytes = riff(parts); writeFileSync(path, bytes, { mode: 0o600 });
  let imageOffset, alphaOffset;
  for (let at = 12; at < bytes.length;) {
    const type = bytes.toString('latin1', at, at + 4), length = bytes.readUInt32LE(at + 4);
    if (type === image.type) imageOffset = at + 8;
    if (type === 'ALPH') alphaOffset = at + 8;
    at += 8 + length + length % 2;
  }
  const stamp = webpSourceStamp(statSync(path, { bigint: true }));
  const descriptor = { width, height, encodedBytes: bytes.length, flags: 0, bitstreamHasAlpha: Boolean(bits & 0x10000000),
    image: { type: image.type, offset: imageOffset, length: image.data.length }, alpha: { offset: alphaOffset, length: 3 }, stamp };
  return { root, path, bytes, stamp, descriptor, expected: riff([chunk(image.type, image.data)]) };
}
function noScratch(root) { assert.deepEqual(readdirSync(root).filter(name => name.startsWith('.webp-frame-')), []); }
function unchanged(source) {
  assert.deepEqual(readFileSync(source.path), source.bytes);
  assert.deepEqual(webpSourceStamp(statSync(source.path, { bigint: true })), source.stamp);
}

test('private WebP frame callback receives exact simple VP8 bytes with ignored malformed alpha removed', async t => {
  for (const odd of [false, true]) {
    const source = await privateFrame(t, { odd }), result = { decoded: true }; let framePath;
    const actual = await decodeWebPFrame(source.path, source.descriptor, source.root, (path, bytes) => {
      framePath = path; assert.equal(dirname(path), source.root); assert.match(basename(path), /^\.webp-frame-/);
      const stat = lstatSync(path); assert.ok(stat.isFile()); assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1);
      assert.equal(bytes, source.expected.length); assert.equal(stat.size, bytes);
      assert.deepEqual(readFileSync(path), source.expected);
      return result;
    }, () => {});
    assert.equal(actual, result); assert.equal(webpFrameBytes(source.descriptor), source.expected.length);
    assert.equal(existsSync(framePath), false); noScratch(source.root); unchanged(source);
  }
});

test('private WebP frame preserves a lossless bitstream and returns the synchronous decoder result', async t => {
  const source = await privateFrame(t, { lossless: true }); let calls = 0;
  const result = await decodeWebPFrame(source.path, source.descriptor, source.root, (path, bytes) => {
    calls++; assert.deepEqual(readFileSync(path), source.expected); assert.equal(bytes, source.expected.length); return 42;
  }, () => {});
  assert.equal(result, 42); assert.equal(calls, 1); noScratch(source.root); unchanged(source);
});

test('private WebP frame removes its scratch file on cancellation before copy, during copy and after decode', async t => {
  for (const cancelAt of [1, 2, 4]) {
    const source = await privateFrame(t), cancellation = Error('TEST_CANCEL'); let checks = 0, calls = 0;
    await assert.rejects(decodeWebPFrame(source.path, source.descriptor, source.root, () => { calls++; }, () => {
      if (++checks === cancelAt) throw cancellation;
    }), error => error === cancellation);
    assert.equal(calls, cancelAt === 4 ? 1 : 0); noScratch(source.root); unchanged(source);
  }
});

test('private WebP frame fences stale and changed sources before invoking the decoder', async t => {
  for (const stage of ['before', 'during']) {
    const source = await privateFrame(t); let checks = 0, calls = 0;
    if (stage === 'before') appendFileSync(source.path, Buffer.from([0]));
    await assert.rejects(decodeWebPFrame(source.path, source.descriptor, source.root, () => { calls++; }, () => {
      if (stage === 'during' && ++checks === 2) appendFileSync(source.path, Buffer.from([0]));
    }), /RASTER_INPUT_CHANGED/);
    assert.equal(calls, 0); noScratch(source.root);
    assert.deepEqual(readFileSync(source.path), Buffer.concat([source.bytes, Buffer.from([0])]));
  }
});

test('private WebP frame removes scratch output after a short source read', async t => {
  const source = await privateFrame(t); let checks = 0, calls = 0;
  await assert.rejects(decodeWebPFrame(source.path, source.descriptor, source.root, () => { calls++; }, () => {
    if (++checks === 2) truncateSync(source.path, source.descriptor.image.offset + source.descriptor.image.length - 1);
  }), /RASTER_INPUT_CHANGED/);
  assert.equal(calls, 0); noScratch(source.root);
});

test('private WebP frame preserves decoder failures and cleans the owned temporary file', async t => {
  const source = await privateFrame(t), failure = Error('TEST_DECODE'); let framePath;
  await assert.rejects(decodeWebPFrame(source.path, source.descriptor, source.root, path => {
    framePath = path; assert.deepEqual(readFileSync(path), source.expected); throw failure;
  }, () => {}), error => error === failure);
  assert.equal(existsSync(framePath), false); noScratch(source.root); unchanged(source);
});

test('private WebP frame detects original pathname replacement after the decoder callback', async t => {
  const source = await privateFrame(t), retained = source.path + '.retained', replacement = Buffer.from('replacement');
  await assert.rejects(decodeWebPFrame(source.path, source.descriptor, source.root, () => {
    renameSync(source.path, retained); writeFileSync(source.path, replacement, { mode: 0o600 }); return 42;
  }, () => {}), /RASTER_INPUT_CHANGED/);
  assert.deepEqual(readFileSync(retained), source.bytes); assert.deepEqual(readFileSync(source.path), replacement); noScratch(source.root);
});

test('private WebP frame refuses scratch pathname replacement without deleting the replacement', async t => {
  const source = await privateFrame(t), replacement = Buffer.from('unrelated replacement'); let framePath;
  await assert.rejects(decodeWebPFrame(source.path, source.descriptor, source.root, path => {
    framePath = path; unlinkSync(path); writeFileSync(path, replacement, { mode: 0o600 }); return 42;
  }, () => {}), /RASTER_INPUT_CHANGED/);
  assert.deepEqual(readFileSync(framePath), replacement); unchanged(source);
  unlinkSync(framePath); noScratch(source.root);
});

test('private WebP frame detects in-place scratch modification during the decoder callback', async t => {
  const source = await privateFrame(t); let framePath;
  await assert.rejects(decodeWebPFrame(source.path, source.descriptor, source.root, path => {
    framePath = path;
    // Appending is an in-place write on the held inode, not a pathname swap.
    appendFileSync(path, Buffer.from([0])); return 42;
  }, () => {}), /RASTER_INPUT_CHANGED/);
  assert.equal(existsSync(framePath), false); noScratch(source.root); unchanged(source);
});

test('private WebP frame refuses a symbolic source before creating scratch output', async t => {
  const source = await privateFrame(t), linked = source.path + '.link'; let calls = 0;
  await symlink(source.path, linked);
  await assert.rejects(decodeWebPFrame(linked, source.descriptor, source.root, () => { calls++; }, () => {}), error => ['ROOT_UNSAFE', 'ELOOP'].includes(error.code));
  assert.equal(calls, 0); noScratch(source.root); unchanged(source);
});
