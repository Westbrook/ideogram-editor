import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, fstatSync, openSync, statSync, writeSync } from 'node:fs';
import { readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { rootFor } from '../store/helpers.mjs';
import { readWebPMetadata, webpExifOrientation, webpSourceStamp, WEBP_METADATA_BYTES } from '../../dist/local/server/raster/webp-metadata.js';
import { hash, runRaster } from '../../dist/local/server/raster/engine.js';
import { inspectContainer } from '../../dist/local/server/raster/container.js';

const width = 17, height = 13;
const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + (data.length % 2));
  out.write(type, 0, 4, 'latin1'); out.writeUInt32LE(data.length, 4); data.copy(out, 8); return out;
}
function chunks(data) {
  const result = [];
  for (let at = 12; at < data.length;) {
    const size = data.readUInt32LE(at + 4);
    result.push({ type: data.toString('latin1', at, at + 4), data: data.subarray(at + 8, at + 8 + size) });
    at += 8 + size + (size % 2);
  }
  return result;
}
function riff(items) {
  const body = Buffer.concat([Buffer.from('WEBP'), ...items.map(item => chunk(item.type, item.data))]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body]);
}
async function image() {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + Math.floor(i / 17) * 23) % 256;
  return sharp(pixels, { raw: { width, height, channels: 3 } }).webp({ quality: 91 }).toBuffer();
}
function withMetadata(base, exif, icc, flags = (exif !== undefined ? 8 : 0) | (icc !== undefined ? 32 : 0)) {
  const extended = Buffer.alloc(10); extended[0] = flags;
  extended.writeUIntLE(width - 1, 4, 3); extended.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([Buffer.from('WEBP'), chunk('VP8X', extended),
    ...(icc === undefined ? [] : [chunk('ICCP', icc)]),
    ...chunks(base).filter(item => ['ALPH', 'VP8 ', 'VP8L'].includes(item.type)).map(item => chunk(item.type, item.data)),
    ...(exif === undefined ? [] : [chunk('EXIF', exif)])]);
  const head = Buffer.alloc(8); head.write('RIFF'); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body]);
}
function descriptor(path, data) {
  const result = { width, height, encodedBytes: data.length, flags: null, bitstreamHasAlpha: false, stamp: webpSourceStamp(statSync(path, { bigint: true })) };
  for (let at = 12; at < data.length;) {
    const type = data.toString('latin1', at, at + 4), length = data.readUInt32LE(at + 4);
    if (type === 'VP8X' && at === 12) result.flags = data[at + 8];
    if (type === 'VP8L') result.bitstreamHasAlpha = Boolean(data.readUInt32LE(at + 9) & 0x10000000);
    if (type === 'VP8 ' || type === 'VP8L') result.image = { type, offset: at + 8, length };
    if (type === 'ALPH') result.alpha = { offset: at + 8, length };
    if (type === 'ICCP') result.icc = { offset: at + 8, length };
    if (type === 'EXIF') result.exif = { offset: at + 8, length };
    at += 8 + length + (length % 2);
  }
  return result;
}
function tiff(entries, { little = true, prefix = true, declared = entries.length } = {}) {
  const u16 = (bytes, value, offset) => little ? bytes.writeUInt16LE(value, offset) : bytes.writeUInt16BE(value, offset);
  const u32 = (bytes, value, offset) => little ? bytes.writeUInt32LE(value >>> 0, offset) : bytes.writeUInt32BE(value >>> 0, offset);
  const head = Buffer.alloc(8 + 2 + entries.length * 12 + 4), tail = [];
  head.write(little ? 'II' : 'MM'); u16(head, 42, 2); u32(head, 8, 4); u16(head, declared, 8);
  let next = head.length;
  entries.forEach((entry, index) => {
    const at = 10 + index * 12, format = entry.format ?? 3, count = entry.count ?? 1;
    const data = entry.data ?? Buffer.alloc((sizes[format] ?? 0) * count);
    if (!entry.data && data.length) {
      if ([1, 6, 7].includes(format)) data[0] = entry.value ?? 6;
      else if ([3, 8].includes(format)) u16(data, (entry.value ?? 6) & 0xffff, 0);
      else if ([4, 5, 9, 10].includes(format)) { u32(data, entry.value ?? 6, 0); if ([5, 10].includes(format)) u32(data, entry.denominator ?? 1, 4); }
    }
    u16(head, entry.tag ?? 0x0112, at); u16(head, format, at + 2); u32(head, count, at + 4);
    if (data.length > 4) { u32(head, entry.pointer ?? next, at + 8); tail.push(data); next += data.length; }
    else { data.copy(head, at + 8); if (entry.pointer !== undefined) u32(head, entry.pointer, at + 8); }
  });
  return Buffer.concat([...(prefix ? [Buffer.from('Exif\0\0', 'latin1')] : []), head, ...tail]);
}
async function compare(t, base, label, exif, expected, options = {}) {
  const root = await rootFor(t), path = join(root, 'metadata.webp'), bytes = withMetadata(base, exif, options.icc, options.flags);
  await writeFile(path, bytes, { mode: 0o600 });
  const actual = readWebPMetadata(path, descriptor(path, bytes));
  const oracle = await sharp(bytes, { failOn: 'warning', ignoreIcc: true }).metadata();
  assert.equal(actual.orientation, oracle.orientation ?? 1, label);
  if (expected !== undefined) assert.equal(actual.orientation, expected, label);
  assert.deepEqual(actual.icc, oracle.icc, label + ' ICC'); assert.deepEqual(actual.exif, oracle.exif, label + ' EXIF');
  assert.equal(actual.hasAlpha, oracle.hasAlpha, label + ' alpha flag');
  assert.deepEqual([actual.format, actual.width, actual.height, actual.space, actual.depth], [oracle.format, oracle.width, oracle.height, oracle.space, oracle.depth], label + ' dimensions');
  return actual;
}

test('bounded WebP metadata matches frozen Sharp for all orientations, TIFF byte orders and prefixes', async t => {
  const base = await image();
  for (const little of [false, true]) for (const prefix of [false, true]) for (let orientation = 1; orientation <= 8; orientation++) {
    await compare(t, base, `${little ? 'II' : 'MM'} prefix=${prefix} orientation=${orientation}`, tiff([{ value: orientation }], { little, prefix }), orientation);
  }
});

test('bounded orientation preserves pinned numeric conversions, first-value handling and rational numerators', async t => {
  const base = await image();
  for (const little of [false, true]) for (const format of [1, 3, 4, 6, 8, 9]) for (const count of [1, 2, 9, 10]) {
    await compare(t, base, `format=${format} count=${count} little=${little}`, tiff([{ format, count, value: 6 }], { little }), count < 10 ? 6 : 1);
  }
  for (const [format, value, expected] of [[4, 65542, 6], [9, -65530, 6], [8, -1, 1], [6, 255, 1], [5, 6, 6], [10, 6, 6], [10, -6, 1]]) {
    await compare(t, base, `numeric=${format}/${value}`, tiff([{ format, value, denominator: 0 }]), expected);
  }
});

test('malformed and ignored WebP EXIF matches frozen Sharp without expanding its tag graph', async t => {
  const base = await image(), magic = tiff([{ value: 6 }]), offset = tiff([{ value: 6 }]), truncated = tiff([{ value: 6 }], { declared: 65535 }).subarray(0, -4);
  magic.writeUInt16LE(43, 8); offset.writeUInt32LE(0xffffffff, 10);
  const cases = [
    ['empty', Buffer.alloc(0), 1], ['one byte', Buffer.from([73]), 1], ['three bytes', Buffer.from('III'), 1],
    ['bad prefix', Buffer.from('ExifXXII*\0\x08\0\0\0', 'latin1'), 1], ['bad byte order', Buffer.from('NOPE'), 1],
    ['bad magic', magic, 1], ['bad IFD offset', offset, 1], ['truncated table', truncated, 6],
    ['missing tag', tiff([{ tag: 0x1234 }]), 1], ['out of range zero', tiff([{ value: 0 }]), 1], ['out of range nine', tiff([{ value: 9 }]), 1],
    ['first valid duplicate', tiff([{ value: 3 }, { value: 6 }]), 3],
    ['empty duplicate skipped', tiff([{ count: 0 }, { value: 6 }]), 6],
    ['unknown format skipped', tiff([{ format: 13 }, { value: 6 }]), 6],
    ['bad payload skipped', tiff([{ format: 3, count: 3, pointer: 0xffffffff }, { value: 6 }]), 6],
    ['valid ASCII duplicate blocks', tiff([{ format: 2, data: Buffer.from('6'), count: 1 }, { value: 6 }]), 1],
    ['valid undefined duplicate blocks', tiff([{ format: 7, value: 6 }, { value: 6 }]), 1],
  ];
  for (const [label, exif, expected] of cases) await compare(t, base, label, exif, expected);
  await compare(t, base, 'unflagged EXIF ignored', tiff([{ value: 6 }]), 1, { flags: 0 });
  const beyond = Buffer.alloc(65580); tiff([{ value: 6 }], { prefix: false }).copy(beyond, 65530); beyond.write('II'); beyond.writeUInt16LE(42, 2); beyond.writeUInt32LE(65538, 4);
  await compare(t, base, 'orientation beyond libexif TIFF cap', beyond, 1);
});

test('bounded WebP metadata retains exact P3 and sRGB profile bytes', async t => {
  const base = await image();
  for (const profile of ['p3', 'srgb']) {
    const tagged = await sharp(base).withIccProfile(profile).webp().toBuffer(), icc = (await sharp(tagged).metadata()).icc;
    assert.ok(icc);
    const result = await compare(t, base, profile, tiff([{ value: 8 }]), 8, { icc });
    assert.deepEqual(result.icc, icc);
    await compare(t, base, profile + ' unflagged', undefined, 1, { icc, flags: 0 });
  }
});

test('simple and extended alpha flags retain frozen WebP metadata and pixel semantics', async t => {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([(i * 17) % 256, (i * 19) % 256, (i * 23) % 256, (i / 4 * 29) % 256], i);
  for (const lossless of [false, true]) {
    const base = await sharp(pixels, { raw: { width, height, channels: 4 } }).webp({ lossless, quality: 91 }).toBuffer();
    const cases = [['original', base], ['extended alpha', withMetadata(base, undefined, undefined, 16)], ['extended alpha cleared', withMetadata(base, undefined, undefined, 0)]];
    if (lossless) {
      const frame = chunks(base).find(item => item.type === 'VP8L'), ignoredAlpha = { type: 'ALPH', data: Buffer.from([255]) };
      cases.push(['simple adjacent ALPH clears intrinsic alpha', riff([frame, ignoredAlpha])],
        ['simple separated ALPH preserves intrinsic alpha', riff([frame, { type: 'JUNK', data: Buffer.alloc(0) }, ignoredAlpha])]);
    } else {
      cases.push(['malformed unflagged ALPH is ignored', riff(chunks(withMetadata(base, undefined, undefined, 0)).map(item => item.type === 'ALPH' ? { type: 'ALPH', data: Buffer.from([255]) } : item))]);
    }
    for (const [label, bytes] of cases) {
      const root = await rootFor(t), path = join(root, 'alpha.webp'); await writeFile(path, bytes, { mode: 0o600 });
      const actual = readWebPMetadata(path, descriptor(path, bytes)), oracle = await sharp(bytes, { ignoreIcc: true }).metadata();
      assert.equal(actual.hasAlpha, oracle.hasAlpha, `${lossless}/${label}`);
      const expected = await sharp(bytes, { ignoreIcc: true }).ensureAlpha().raw().toBuffer();
      await runRaster({ type: 'decode', directory: root, path, mediaType: 'image/webp', sourceAssetId: 'fixture', original: { hash: hash(bytes), byteLength: String(bytes.length), mediaType: 'image/webp' } }, async () => {}, () => {});
      assert.deepEqual(await readFile(join(root, 'pixels.rgba')), expected, `${lossless}/${label} pixels`);
      assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.webp-frame-')), [], 'private frame cleanup');
    }
  }
});

test('bounded container checks match the frozen static WebP demux ordering', async t => {
  const base = await image(), frame = chunks(base).find(item => item.type === 'VP8 '), exif = { type: 'EXIF', data: tiff([{ value: 6 }]) };
  const extended = chunks(withMetadata(base, undefined, undefined, 0))[0];
  const flagged = flags => ({ type: 'VP8X', data: Buffer.from(extended.data.map((value, index) => index === 0 ? flags : value)) });
  const alpha = { type: 'ALPH', data: Buffer.from([255]) }, junk = { type: 'JUNK', data: Buffer.alloc(0) };
  const cases = [
    ['unknown first', [junk, extended, frame], false], ['EXIF first', [exif, extended, frame], false], ['ALPH first', [alpha, frame], false],
    ['reserved first VP8X flags', [flagged(1), frame], false], ['unknown before image', [extended, junk, frame], true],
    ['missing flagged metadata', [flagged(40), frame], true], ['ignored late VP8X flags', [frame, flagged(41), exif], true],
    ['ALPH adjacent before VP8', [flagged(16), alpha, frame], true], ['unflagged ALPH adjacent before VP8', [extended, alpha, frame], true],
    ['unknown splits ALPH frame', [flagged(16), alpha, junk, frame], false], ['EXIF splits ALPH frame', [flagged(24), alpha, exif, frame], false],
    ['flagged ALPH after VP8', [flagged(16), frame, alpha], false], ['unflagged ALPH after VP8', [extended, frame, alpha], true],
    ['separated ALPH after VP8', [extended, frame, junk, alpha], false],
    ['simple adjacent ALPH', [frame, alpha], true], ['simple separated ALPH', [frame, junk, alpha], true],
  ];
  const reservedBytes = { type: 'VP8X', data: Buffer.from(extended.data) }; reservedBytes.data.fill(255, 1, 4);
  cases.push(['ignored reserved VP8X bytes', [reservedBytes, frame], true]);
  for (const [label, items, accepted] of cases) {
    const root = await rootFor(t), path = join(root, 'ordering.webp'), bytes = riff(items); await writeFile(path, bytes, { mode: 0o600 });
    if (accepted) {
      const container = await inspectContainer(path, 'image/webp'); assert.deepEqual([container.width, container.height], [width, height], label);
      const oracle = await sharp(bytes, { failOn: 'warning', ignoreIcc: true }).metadata(), actual = readWebPMetadata(path, descriptor(path, bytes));
      assert.equal(actual.orientation, oracle.orientation ?? 1, label); assert.equal(actual.hasAlpha, oracle.hasAlpha, label);
      assert.deepEqual(actual.exif, oracle.exif, label);
    } else {
      await assert.rejects(inspectContainer(path, 'image/webp'), /RASTER_FORMAT/, label);
      await assert.rejects(sharp(bytes, { failOn: 'warning', ignoreIcc: true }).metadata(), undefined, label);
    }
  }
});

test('container bounds zero-length unknown chunk structures independently of payload bytes', async t => {
  const base = await image(), items = chunks(withMetadata(base, undefined, undefined, 0));
  const unknown = Array.from({ length: 1023 }, (_, i) => ({ type: 'Z' + i.toString(36).padStart(3, '0'), data: Buffer.alloc(0) }));
  for (const [count, accepted] of [[1022, true], [1023, false]]) {
    const root = await rootFor(t), path = join(root, 'chunks.webp'), bytes = riff([items[0], ...unknown.slice(0, count), items[1]]);
    await writeFile(path, bytes, { mode: 0o600 });
    if (accepted) await inspectContainer(path, 'image/webp');
    else await assert.rejects(inspectContainer(path, 'image/webp'), /RASTER_RESOURCES/);
  }
});

test('metadata reader validates the combined budget and range before reading', async t => {
  const root = await rootFor(t), path = join(root, 'metadata.webp'), bytes = withMetadata(await image(), tiff([{ value: 6 }]));
  await writeFile(path, bytes, { mode: 0o600 }); const d = descriptor(path, bytes);
  for (const exif of [{ offset: 19, length: 1 }, { offset: -1, length: 1 }, { offset: 20, length: -1 }, { offset: 20, length: 1.5 }, { offset: 20, length: WEBP_METADATA_BYTES + 1 }, { offset: bytes.length, length: 1 }]) {
    assert.throws(() => readWebPMetadata(path, { ...d, exif }), /RASTER_METADATA/);
  }
  assert.throws(() => readWebPMetadata(path, { ...d, encodedBytes: 2 * WEBP_METADATA_BYTES + 100, icc: { offset: 20, length: WEBP_METADATA_BYTES }, exif: { offset: WEBP_METADATA_BYTES + 20, length: 1 } }), /RASTER_RESOURCES/);
  assert.throws(() => readWebPMetadata(path, { ...d, icc: d.exif }), /RASTER_METADATA/);
  assert.throws(() => readWebPMetadata(path, { ...d, flags: 2 }), /RASTER_ANIMATION/);
  for (const flags of [1, 64, 128]) assert.throws(() => readWebPMetadata(path, { ...d, flags }), /RASTER_FORMAT/);
  assert.throws(() => readWebPMetadata(path, d, () => { throw Error('TEST_CANCEL'); }), /TEST_CANCEL/);
});

test('metadata reader fences source mutation and replacement before and during bounded reads', async t => {
  const root = await rootFor(t), path = join(root, 'metadata.webp'), bytes = withMetadata(await image(), Buffer.concat([tiff([{ value: 6 }]), Buffer.alloc(128 * 1024)]));
  await writeFile(path, bytes, { mode: 0o600 }); let d = descriptor(path, bytes);
  await writeFile(path, Buffer.concat([bytes, Buffer.from([0])]), { mode: 0o600 });
  assert.throws(() => readWebPMetadata(path, d), /RASTER_INPUT_CHANGED/);
  await writeFile(path, bytes, { mode: 0o600 }); d = descriptor(path, bytes); let checks = 0;
  assert.throws(() => readWebPMetadata(path, d, () => {
    if (++checks === 3) { const fd = openSync(path, 'r+'); try { writeSync(fd, Buffer.from('JUNK'), 0, 4, 12); } finally { closeSync(fd); } }
  }), /RASTER_INPUT_CHANGED/);
  await writeFile(path, bytes, { mode: 0o600 }); d = descriptor(path, bytes);
  await rename(path, path + '.old'); await writeFile(path, bytes, { mode: 0o600 });
  assert.throws(() => readWebPMetadata(path, d), /RASTER_INPUT_CHANGED/);
  await symlink(path, path + '.link'); assert.throws(() => readWebPMetadata(path + '.link', descriptor(path, bytes)), error => ['ROOT_UNSAFE', 'ELOOP'].includes(error.code));
});

test('metadata reader reads bounded payloads past a large sparse encoded gap', async t => {
  const root = await rootFor(t), path = join(root, 'sparse.webp'), exif = tiff([{ value: 7 }]), offset = 256 * 1024 * 1024;
  const fd = openSync(path, 'wx', 0o600); let d;
  try {
    writeSync(fd, Buffer.from('RIFF'), 0, 4, 0); writeSync(fd, exif, 0, exif.length, offset);
    const stamp = webpSourceStamp(fstatSync(fd, { bigint: true }));
    d = { width, height, encodedBytes: offset + exif.length, flags: 8, bitstreamHasAlpha: false, image: { type: 'VP8 ', offset: 20, length: 10 }, exif: { offset, length: exif.length }, stamp };
  } finally { closeSync(fd); }
  const result = readWebPMetadata(path, d); assert.deepEqual(result.exif, exif); assert.equal(result.orientation, 7);
  assert.equal(webpExifOrientation(exif), 7);
});
