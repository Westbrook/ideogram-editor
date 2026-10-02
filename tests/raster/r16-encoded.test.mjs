import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { chmod, link, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { rootFor } from '../store/helpers.mjs';
import {
  decodeR16, encodeR16, R16_ENCODED_ALLOCATION_BYTES, R16_ENCODED_CHUNK_BYTES,
  R16_ENCODED_CODEC, R16_ENCODED_MEDIA_TYPE,
} from '../../dist/local/server/raster/r16-encoded.js';

const check = () => {};
const execFileAsync = promisify(execFile);
const ref = bytes => ({
  hash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
  byteLength: String(bytes.length), mediaType: 'application/x-ideogram-r16le',
});
const privateWrite = (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
const absent = async path => assert.rejects(stat(path), { code: 'ENOENT' });
function samples(width, height) {
  const bytes = Buffer.alloc(width * height * 2);
  // Covers all 65536 R16 values before repeating, including values that cannot
  // survive the 8-bit quantization used by an image/mask transport preview.
  for (let i = 0; i < width * height; i++) bytes.writeUInt16LE((i * 40503 + 17) & 65535, i * 2);
  return bytes;
}
function independentFile(bytes, width, height) {
  const header = Buffer.alloc(24);
  header.set([0x49, 0x45, 0x52, 0x31, 0x36, 0x4c, 0x45, 1]);
  header.writeUInt32LE(width, 8); header.writeUInt32LE(height, 12);
  header.writeBigUInt64LE(BigInt(width * height * 2), 16);
  return Buffer.concat([header, deflateRawSync(bytes, { level: 6 })]);
}
async function fixture(t, width = 257, height = 259) {
  const root = await rootFor(t), input = join(root, 'input.r16'), encoded = join(root, 'encoded.r16d');
  const raw = samples(width, height);
  await privateWrite(input, raw);
  await encodeR16(input, encoded, width, height, check);
  return { root, input, encoded, raw, width, height, expected: ref(raw) };
}

test('R16 encoding preserves every 16-bit value across 64 KiB blocks and is deterministic', async t => {
  const f = await fixture(t), output = join(f.root, 'decoded.r16'), second = join(f.root, 'second.r16d');
  assert.ok(f.raw.length > R16_ENCODED_CHUNK_BYTES * 2);
  assert.equal(f.raw.readUInt16LE(0), 17);
  assert.notEqual(f.raw.readUInt16LE(0) % 257, 0);
  assert.equal(R16_ENCODED_CHUNK_BYTES, 65536);
  assert.equal(R16_ENCODED_ALLOCATION_BYTES, 512 * 1024);
  assert.equal(R16_ENCODED_MEDIA_TYPE, 'application/x-ideogram-r16le-deflate');
  assert.equal(R16_ENCODED_CODEC, 'r16le-deflate-v1');
  await encodeR16(f.input, second, f.width, f.height, check);
  const encoded = await readFile(f.encoded);
  assert.deepEqual(await readFile(second), encoded);
  assert.deepEqual(encoded.subarray(0, 8), Buffer.from([0x49, 0x45, 0x52, 0x31, 0x36, 0x4c, 0x45, 1]));
  assert.equal(encoded.readUInt32LE(8), f.width);
  assert.equal(encoded.readUInt32LE(12), f.height);
  assert.equal(encoded.readBigUInt64LE(16), BigInt(f.raw.length));
  assert.deepEqual(inflateRawSync(encoded.subarray(24)), f.raw);
  await decodeR16(f.encoded, output, f.width, f.height, f.expected, check);
  assert.deepEqual(await readFile(output), f.raw);
  for (const path of [f.encoded, second, output]) assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('decoder accepts an independently assembled complete version-1 file', async t => {
  const root = await rootFor(t), input = join(root, 'independent.r16d'), output = join(root, 'decoded.r16');
  const raw = Buffer.from([0, 0, 1, 0, 255, 0, 0, 1, 1, 1, 254, 127, 1, 128, 255, 255]);
  await privateWrite(input, independentFile(raw, 4, 2));
  await decodeR16(input, output, 4, 2, ref(raw), check);
  assert.deepEqual(await readFile(output), raw);
});

test('corrupt DEFLATE terminal errors settle, clean output, and permit an exact next decode', { timeout: 15000 }, async t => {
  const f = await fixture(t, 4, 4), valid = await readFile(f.encoded);
  const input = join(f.root, 'deflate-corrupt.r16d'), output = join(f.root, 'terminal-retry.raw');
  // BTYPE=3 is reserved: the actual inflater must terminate on this input.
  const corrupt = Buffer.concat([valid.subarray(0, 24), Buffer.from([7])]);
  await privateWrite(input, corrupt);
  // A separate process bounds the missing-write-callback regression even when
  // an unresolved decode keeps the test runner alive. The next good decode is
  // deliberately in that same child, using the same exclusive output path.
  const program = String.raw`
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
const [codecURL, input, output, encoded, rawPath, widthText, heightText, expectedText] = process.argv.slice(1);
const { decodeR16 } = await import(codecURL);
const width = Number(widthText), height = Number(heightText), expected = JSON.parse(expectedText);
const check = () => {}, absent = path => assert.rejects(stat(path), { code: 'ENOENT' });
const corrupt = await readFile(input), valid = await readFile(encoded), raw = await readFile(rawPath);
await assert.rejects(decodeR16(input, output, width, height, expected, check), /R16_STREAM/);
await absent(output);
await new Promise(resolve => setImmediate(resolve));
await absent(output);
assert.deepEqual(await readFile(input), corrupt);
assert.deepEqual(await readFile(encoded), valid);
assert.deepEqual(await readFile(rawPath), raw);
await decodeR16(encoded, output, width, height, expected, check);
assert.deepEqual(await readFile(output), raw);
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(await readFile(output), raw);
assert.equal((await stat(output)).mode & 0o777, 0o600);
assert.deepEqual(await readFile(input), corrupt);
assert.deepEqual(await readFile(encoded), valid);
assert.deepEqual(await readFile(rawPath), raw);
process.stdout.write(JSON.stringify({ recovered: true, decodedBytes: raw.length }));
`;
  const { stdout } = await execFileAsync(process.execPath, [
    '--import', fileURLToPath(new URL('../session/no-egress.mjs', import.meta.url)),
    '--input-type=module', '--eval', program,
    new URL('../../dist/local/server/raster/r16-encoded.js', import.meta.url).href,
    input, output, f.encoded, f.input, String(f.width), String(f.height), JSON.stringify(f.expected),
  ], { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
  assert.deepEqual(JSON.parse(stdout), { recovered: true, decodedBytes: f.raw.length });
  assert.deepEqual(await readFile(output), f.raw);
  assert.deepEqual(await readFile(input), corrupt);
  assert.deepEqual(await readFile(f.encoded), valid);
  assert.deepEqual(await readFile(f.input), f.raw);
});

test('decoder rejects malformed headers, truncated streams and every trailing stream byte', { timeout: 15000 }, async t => {
  const f = await fixture(t, 4, 4), valid = await readFile(f.encoded);
  const mutated = edit => { const b = Buffer.from(valid); edit(b); return b; };
  const cases = [
    ['magic', mutated(b => { b[0] ^= 1; }), /R16_FORMAT/],
    ['version', mutated(b => { b[7] = 2; }), /R16_FORMAT/],
    ['width', mutated(b => b.writeUInt32LE(5, 8)), /R16_FORMAT/],
    ['height', mutated(b => b.writeUInt32LE(5, 12)), /R16_FORMAT/],
    ['header-length', mutated(b => b.writeBigUInt64LE(31n, 16)), /R16_FORMAT/],
    ['header-short', valid.subarray(0, 23), /R16_FORMAT/],
    ['payload-missing', valid.subarray(0, 24), /R16_FORMAT/],
    ['deflate-truncated', valid.subarray(0, valid.length - 1), /R16_STREAM/],
    ['trailing-byte', Buffer.concat([valid, Buffer.from([0])]), /R16_TRAILING/],
    ['trailing-stream', Buffer.concat([valid, deflateRawSync(f.raw)]), /R16_TRAILING/],
    ['trailing-blocks', Buffer.concat([valid, Buffer.alloc(65537)]), /R16_TRAILING/],
  ];
  for (const [name, bytes, error] of cases) await t.test(name, async () => {
    const input = join(f.root, name + '.r16d'), output = join(f.root, name + '.raw');
    await privateWrite(input, bytes);
    await assert.rejects(decodeR16(input, output, f.width, f.height, f.expected, check), error);
    await absent(output);
  });
});

test('decoded length and canonical raw hash are independently enforced, including expanding input', async t => {
  const f = await fixture(t, 4, 4);
  for (const [name, raw] of [
    ['short', f.raw.subarray(0, f.raw.length - 2)],
    ['long', Buffer.concat([f.raw, Buffer.from([1, 0])])],
    ['expanding', Buffer.alloc(2 * 1024 * 1024)],
  ]) {
    const input = join(f.root, name + '.r16d'), output = join(f.root, name + '.raw');
    await privateWrite(input, independentFile(raw, f.width, f.height));
    await assert.rejects(decodeR16(input, output, f.width, f.height, f.expected, check), /R16_LENGTH/);
    await absent(output);
  }
  const output = join(f.root, 'wrong-hash.raw');
  await assert.rejects(decodeR16(f.encoded, output, f.width, f.height, { ...f.expected, hash: 'sha256:' + '0'.repeat(64) }, check), /R16_HASH/);
  await absent(output);
});

test('raw source size, extent and raw BlobRef shape are validated without usable output', async t => {
  const f = await fixture(t, 4, 4);
  for (const [name, raw] of [['short', f.raw.subarray(0, 30)], ['long', Buffer.concat([f.raw, Buffer.from([0, 0])])]]) {
    const input = join(f.root, name + '.raw'), output = join(f.root, name + '.r16d');
    await privateWrite(input, raw);
    await assert.rejects(encodeR16(input, output, 4, 4, check), /R16_LENGTH/);
    await absent(output);
  }
  for (const [width, height] of [[0, 4], [4, 0], [1.5, 4], [8193, 1], [5001, 5000]]) {
    const output = join(f.root, 'extent-' + width + '-' + height);
    await assert.rejects(encodeR16(f.input, output, width, height, check), /RASTER_EXTENT/);
    await assert.rejects(decodeR16(f.encoded, output, width, height, f.expected, check), /RASTER_EXTENT/);
    await absent(output);
  }
  const identities = [
    { ...f.expected, byteLength: '032' }, { ...f.expected, byteLength: '34' },
    { ...f.expected, mediaType: R16_ENCODED_MEDIA_TYPE }, { ...f.expected, hash: '0'.repeat(64) },
    { ...f.expected, extra: true },
  ];
  for (const [index, expected] of identities.entries()) {
    const output = join(f.root, 'identity-' + index);
    await assert.rejects(decodeR16(f.encoded, output, 4, 4, expected, check), /R16_IDENTITY/);
    await absent(output);
  }
});

test('cancellation after output begins removes owned output before rejection settles', async t => {
  const f = await fixture(t);
  for (const operation of ['encode', 'decode']) {
    const output = join(f.root, operation + '-cancelled'), cancelled = new Error(operation + '-cancelled');
    let sawOutput = false;
    const cancel = () => {
      if (existsSync(output) && statSync(output).size > 0) { sawOutput = true; throw cancelled; }
    };
    const running = operation === 'encode'
      ? encodeR16(f.input, output, f.width, f.height, cancel)
      : decodeR16(f.encoded, output, f.width, f.height, f.expected, cancel);
    await assert.rejects(running, error => error === cancelled);
    assert.equal(sawOutput, true);
    await absent(output);
    await new Promise(resolve => setImmediate(resolve));
    await absent(output);
  }
});

test('private input protections and exclusive output creation preserve unrelated files', async t => {
  const f = await fixture(t, 4, 4), sentinel = Buffer.from('existing output must survive');
  for (const operation of ['encode', 'decode']) {
    const source = operation === 'encode' ? f.input : f.encoded;
    const run = (input, output) => operation === 'encode'
      ? encodeR16(input, output, 4, 4, check)
      : decodeR16(input, output, 4, 4, f.expected, check);
    const existing = join(f.root, operation + '-existing');
    await privateWrite(existing, sentinel);
    await assert.rejects(run(source, existing), { code: 'EEXIST' });
    assert.deepEqual(await readFile(existing), sentinel);
    const outputLink = join(f.root, operation + '-output-link');
    await symlink(existing, outputLink);
    await assert.rejects(run(source, outputLink));
    assert.deepEqual(await readFile(existing), sentinel);
    const inputLink = join(f.root, operation + '-input-link'), output = join(f.root, operation + '-unsafe-output');
    await symlink(source, inputLink);
    await assert.rejects(run(inputLink, output), { code: 'ROOT_UNSAFE' });
    await absent(output);
    const unsafe = join(f.root, operation + '-public');
    await privateWrite(unsafe, await readFile(source)); await chmod(unsafe, 0o644);
    await assert.rejects(run(unsafe, output), { code: 'ROOT_UNSAFE' });
    await absent(output);
    const hard = join(f.root, operation + '-hardlink');
    await link(source, hard);
    await assert.rejects(run(hard, output), { code: 'ROOT_UNSAFE' });
    await absent(output);
  }
});
