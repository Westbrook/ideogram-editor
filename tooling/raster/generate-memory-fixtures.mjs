// Original CC0 fixtures. Generation is deliberately separate from product RSS
// measurement: the encoder's memory is not a product decoder measurement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflate, crc32 } from 'node:zlib';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const choices = ['opaque-entropy-lossless', 'opaque-entropy-lossy', 'alpha-entropy-lossless', 'alpha-entropy-lossy', 'alpha-noise-lossy'];
const usage = 'Usage: node tooling/raster/generate-memory-fixtures.mjs --out artifacts/NEW-NAME [--width 5000 --height 5000] [--seed 0x6d2b79f5] [--effort 4] [--fixtures ' + choices.join(',') + ']';
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  assert(['--out', '--width', '--height', '--seed', '--effort', '--fixtures'].includes(key) && args[index + 1] !== undefined && !(key in options), usage);
  options[key] = args[index + 1];
}
assert(options['--out'], usage);
const width = Number(options['--width'] ?? 5000), height = Number(options['--height'] ?? 5000);
const seed = Number(options['--seed'] ?? '0x6d2b79f5'), effort = Number(options['--effort'] ?? 4);
assert(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 25_000_000, 'Extent must stay within the accepted 8192-axis / 25 MP envelope');
assert(Number.isInteger(seed) && seed > 0 && seed <= 0xffffffff, 'A nonzero unsigned 32-bit seed is required');
assert(Number.isInteger(effort) && effort >= 0 && effort <= 6, 'WebP effort must be an integer in 0..6');
const selected = options['--fixtures']?.split(',') ?? choices;
assert(selected.length && new Set(selected).size === selected.length && selected.every(name => choices.includes(name)), usage);
// Restrict output to one freshly created direct child of the ignored artifacts
// directory. Never overwrite existing fixtures or recursively follow a link.
const output = resolve(repository, options['--out']), name = relative(join(repository, 'artifacts'), output);
assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && name !== '..', '--out must name a new direct child of this repository\'s artifacts directory');
const artifacts = join(repository, 'artifacts');
await mkdir(artifacts, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
assert((await lstat(artifacts)).isDirectory() && await realpath(artifacts) === artifacts, 'Artifacts directory must not be a symlink');
await mkdir(output, { mode: 0o700 }); // EEXIST is intentional, including prior failures.

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function identity(path) {
  const digest = createHash('sha256'); let bytes = 0;
  for await (const part of createReadStream(path, { highWaterMark: 65536 })) { bytes += part.length; digest.update(part); }
  return { bytes, hash: 'sha256:' + digest.digest('hex') };
}
const sourceIdentity = await identity(fileURLToPath(import.meta.url));
const facts = {
  schemaVersion: 1, kind: 'adversarial-webp-memory-fixtures-v1', status: 'running', qualification: false,
  createdAt: new Date().toISOString(), license: 'CC0-1.0', output,
  source: { path: relative(repository, fileURLToPath(import.meta.url)), ...sourceIdentity },
  parameters: { width, height, seed, seedHex: '0x' + seed.toString(16).padStart(8, '0'), effort, fixtures: selected },
  procedure: {
    version: 'xorshift32-rgba-row-v1',
    rng: 'Reset state to seed for each source. For each row-major pixel: state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0. R,G,B are bits 0..7,8..15,16..23 of the resulting unsigned state.',
    opaque: 'Alpha=255 for every pixel.',
    alpha: 'alpha-entropy uses Alpha=[0,1,32,127,254,255][((x >>> 4) + (y >>> 4)) % 6]. alpha-noise uses bits 24..31 of each resulting RNG state as alpha. Both force RGB to zero whenever alpha=0. Tiled and noisy alpha are separate diagnostics: the latter exposes an old classifier that charged ALPH image data to metadata.',
    png: 'PNG signature; IHDR RGBA8 non-interlaced; sRGB intent0; filter0 row bytes; zlib level6 and 65536-byte chunkSize; compressed bytes reframed into fixed 65536-byte IDAT payloads plus a final shorter payload; IEND. Hashes cover all row-major RGBA bytes and, separately, alpha bytes before encoding.',
    serial: 'Sources and all Sharp encodes run sequentially. Retain canonical PNG intermediates and every output, including partial files on failure. No full source image buffer is constructed by this script.',
  },
  accounting: 'Generation-only process maxRSS includes fixture row production, hashes, PNG compression, the Sharp encoder and seal verification. It is not whole-writer RSS, a native decoder allocation bound, a product admission decision or resource qualification. Sharp encoding may allocate a full image or more.',
  scope: 'Synthetic static untagged-sRGB inputs, RGBA8, within 8192 per axis and 25 MP. Header checks do not prove full decode. A resource refusal by the bounded decoder is a separate observable outcome, not a generated fixture failure. No P3, PERF, platform, repeated-writer, recovery or lifecycle qualification.',
  sources: [], fixtures: [],
};
let checkpointNumber = 0;
async function checkpoint() {
  const temporary = join(output, '.receipt-' + ++checkpointNumber + '.json');
  await writeFile(temporary, JSON.stringify(facts, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, join(output, 'receipt.json'));
}

async function verifyInstalledCodec() {
  const profilePath = process.platform === 'darwin' && process.arch === 'arm64' ? 'tooling/raster/codecs.json'
    : process.platform === 'linux' && ['arm64', 'x64'].includes(process.arch) ? `tooling/raster/linux-codecs/1.0.0/linux-${process.arch}/codecs.json` : null;
  assert(profilePath, 'No sealed codec producer profile for this platform');
  const bytes = await readFile(join(repository, profilePath)), codecs = JSON.parse(bytes);
  assert.equal(process.versions.node, codecs.node); assert.equal(process.versions.zlib, codecs.zlib);
  assert.equal(process.platform, codecs.platform); assert.equal(process.arch, codecs.arch);
  for (const file of codecs.files) assert.deepEqual(await identity(join(repository, file.path)), { bytes: file.bytes, hash: file.hash }, file.path);
  for (const [profile, file] of Object.entries(codecs.profiles)) assert.deepEqual(await identity(join(repository, 'tooling/raster', profile + '.icc')), { bytes: file.bytes, hash: file.hash }, profile);
  // Load the native encoder only after checking its complete sealed input set.
  const { default: sharp } = await import('sharp');
  assert.deepEqual(sharp.versions, codecs.versions);
  facts.encoder = { profile: profilePath, profileFile: { bytes: bytes.length, hash: hash(bytes) }, codecIdentity: hash(JSON.stringify(codecs)), versions: sharp.versions, filesVerified: codecs.files.length, cache: false, concurrency: 1 };
  sharp.cache(false); sharp.concurrency(1);
  return sharp;
}

function chunk(type, bytes) {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); result.write(type, 4, 4, 'ascii'); result.set(bytes, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}
async function writeAll(file, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    assert(result.bytesWritten > 0, 'Short fixture write'); offset += result.bytesWritten;
  }
}
async function makeSource(pattern) {
  const filename = pattern + '.rgba.png', path = join(output, filename), started = performance.now();
  const record = { pattern, file: filename, status: 'running', width, height, rawBytes: width * height * 4 };
  facts.sources.push(record); await checkpoint();
  const rgba = createHash('sha256'), alpha = createHash('sha256'), levels = [0, 1, 32, 127, 254, 255];
  let state = seed, rowsProduced = 0;
  function* rows() {
    for (let y = 0; y < height; y++) {
      const row = Buffer.alloc(1 + width * 4), alphaRow = Buffer.alloc(width);
      for (let x = 0; x < width; x++) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
        const a = pattern === 'opaque-entropy' ? 255 : pattern === 'alpha-noise' ? state >>> 24 : levels[((x >>> 4) + (y >>> 4)) % levels.length], offset = 1 + x * 4;
        row[offset] = a ? state & 255 : 0; row[offset + 1] = a ? (state >>> 8) & 255 : 0; row[offset + 2] = a ? (state >>> 16) & 255 : 0;
        row[offset + 3] = a; alphaRow[x] = a;
      }
      rgba.update(row.subarray(1)); alpha.update(alphaRow); rowsProduced++; yield row;
    }
  }
  const target = await open(path, 'wx', 0o600), zip = createDeflate({ level: 6, chunkSize: 65536 });
  let producing;
  try {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
    await writeAll(target, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await writeAll(target, chunk('IHDR', ihdr)); await writeAll(target, chunk('sRGB', Buffer.from([0])));
    producing = pipeline(Readable.from(rows(), { objectMode: false, highWaterMark: 65536 }), zip); producing.catch(() => {});
    // Async iteration may coalesce deflate emissions depending on IO timing.
    // Reframe compressed bytes explicitly, so PNG framing is reproducible too.
    const pending = Buffer.alloc(65536); let pendingBytes = 0;
    for await (const bytes of zip) for (let offset = 0; offset < bytes.length;) {
      const length = Math.min(pending.length - pendingBytes, bytes.length - offset);
      pending.set(bytes.subarray(offset, offset + length), pendingBytes); pendingBytes += length; offset += length;
      if (pendingBytes === pending.length) { await writeAll(target, chunk('IDAT', pending)); pendingBytes = 0; }
    }
    if (pendingBytes) await writeAll(target, chunk('IDAT', pending.subarray(0, pendingBytes)));
    await producing; assert.equal(rowsProduced, height);
    await writeAll(target, chunk('IEND', Buffer.alloc(0))); await target.sync();
  } finally { zip.destroy(); if (producing) await Promise.allSettled([producing]); await target.close(); }
  Object.assign(record, { status: 'passed', ...await identity(path), rgbaHash: 'sha256:' + rgba.digest('hex'), alphaHash: 'sha256:' + alpha.digest('hex'), elapsedMs: performance.now() - started });
  await checkpoint(); return record;
}

async function inspectWebP(path) {
  const file = await open(path, 'r'), bytes = (await file.stat()).size, chunks = [];
  let metadataBytes = 0, alphaPayloadBytes = 0, images = 0;
  async function read(position, length) {
    assert(position + length <= bytes, 'Truncated RIFF'); const result = Buffer.alloc(length);
    for (let offset = 0; offset < length;) { const part = await file.read(result, offset, length - offset, position + offset); assert(part.bytesRead > 0, 'Truncated RIFF'); offset += part.bytesRead; }
    return result;
  }
  const dimensions = (w, h) => { assert.equal(w, width, 'Encoded width changed'); assert.equal(h, height, 'Encoded height changed'); };
  try {
    const header = await read(0, 12);
    assert.equal(header.toString('ascii', 0, 4), 'RIFF'); assert.equal(header.toString('ascii', 8, 12), 'WEBP'); assert.equal(header.readUInt32LE(4) + 8, bytes);
    const seen = new Set();
    for (let offset = 12; offset < bytes;) {
      const header = await read(offset, 8), type = header.toString('ascii', 0, 4), length = header.readUInt32LE(4);
      assert(!seen.has(type), 'Duplicate RIFF chunk'); seen.add(type);
      assert(offset + 8 + length + length % 2 <= bytes, 'Truncated RIFF payload');
      assert(['VP8X', 'ALPH', 'VP8 ', 'VP8L'].includes(type), 'Unexpected metadata or animation chunk: ' + type);
      chunks.push({ type, bytes: length });
      if (type === 'VP8X') { assert.equal(length, 10); const data = await read(offset + 8, 10); assert.equal(data[0] & 2, 0, 'Animation is not eligible'); dimensions(data.readUIntLE(4, 3) + 1, data.readUIntLE(7, 3) + 1); }
      if (type === 'VP8 ') { assert(length >= 10); const data = await read(offset + 8, 10); assert.equal(data[0] & 1, 0); assert(data.subarray(3, 6).equals(Buffer.from([157, 1, 42]))); dimensions(data.readUInt16LE(6) & 16383, data.readUInt16LE(8) & 16383); images++; }
      else if (type === 'VP8L') { assert(length >= 5); const data = await read(offset + 8, 5); assert.equal(data[0], 47); assert.equal(data[4] >>> 5, 0); const bits = data.readUInt32LE(1); dimensions((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1); images++; }
      else if (type === 'ALPH') alphaPayloadBytes += length;
      else metadataBytes += length;
      offset += 8 + length + length % 2;
    }
    assert.equal(images, 1); assert(metadataBytes <= 4 * 1024 * 1024, 'Encoded metadata exceeds the product pre-decode envelope');
    return { status: 'header-envelope-checked', width, height, metadataBytes, alphaPayloadBytes, legacyAlphAsMetadataBytes: metadataBytes + alphaPayloadBytes,
      legacyAlphMetadataBudgetExceeded: metadataBytes + alphaPayloadBytes > 4 * 1024 * 1024,
      alphaMeaning: 'ALPH is encoded image data. A product revision charging it to the 4 MiB metadata budget can refuse this valid candidate before native decode; capture that outcome separately.',
      chunks, fullDecodeVerified: false };
  } finally { await file.close(); }
}

await checkpoint();
try {
  const sharp = await verifyInstalledCodec(), sources = new Map();
  for (const name of selected) {
    const lossless = name.endsWith('-lossless'), pattern = name.startsWith('opaque-') ? 'opaque-entropy' : name.startsWith('alpha-noise-') ? 'alpha-noise' : 'alpha-entropy';
    if (!sources.has(pattern)) sources.set(pattern, await makeSource(pattern));
    const source = sources.get(pattern), filename = name + '.webp', path = join(output, filename), started = performance.now();
    const webpOptions = { quality: lossless ? 100 : 90, alphaQuality: 100, lossless, nearLossless: false, smartSubsample: false, smartDeblock: false, effort, minSize: false, mixed: false, preset: 'default', exact: true };
    const fixture = {
      name, file: filename, status: 'running', width, height, mediaType: 'image/webp', source: source.file, encoderOptions: webpOptions,
      oracle: { rawBytes: width * height * 4, alphaBytes: width * height, sourceRgbaHash: source.rgbaHash, alphaHash: source.alphaHash, expectedDecodedRgbaHash: lossless ? source.rgbaHash : null, expectedDecodedAlphaHash: source.alphaHash, rgbaExact: lossless,
        derivation: 'Independent seeded row generator, before any native codec runs; not captured from the implementation under test.',
        limitation: lossless ? 'Exact source RGBA is the expected lossless decoded output. Zero-alpha source RGB is zero, so this expectation does not require hidden RGB preservation.' : 'Lossy RGB is not equal to source RGB. The exact alpha oracle applies with alphaQuality100; full decoded RGB equality requires a separately obtained native/reference oracle.' },
    };
    facts.fixtures.push(fixture); await checkpoint();
    // The exclusive output descriptor makes refusal to overwrite independent of
    // Sharp's usual pathname replacement behavior. The directory is private.
    const target = await open(path, 'wx', 0o600);
    try {
      fixture.encoderResult = await sharp(join(output, source.file), { failOn: 'warning', limitInputPixels: 25_000_000, sequentialRead: true, ignoreIcc: true }).webp(webpOptions).toFile('/dev/fd/' + target.fd);
      await target.sync();
    } finally { await target.close(); }
    assert.equal(fixture.encoderResult.width, width); assert.equal(fixture.encoderResult.height, height); assert.equal(fixture.encoderResult.format, 'webp');
    Object.assign(fixture, await identity(path), { envelope: await inspectWebP(path), elapsedMs: performance.now() - started, status: 'passed' });
    await checkpoint();
  }
  assert.deepEqual(await identity(fileURLToPath(import.meta.url)), sourceIdentity, 'Generator changed during fixture production');
  const encoderBefore = JSON.stringify(facts.encoder); await verifyInstalledCodec();
  assert.equal(JSON.stringify(facts.encoder), encoderBefore, 'Encoder profile changed during fixture production'); facts.encoderSealUnchanged = true;
  facts.status = 'passed';
} catch (error) { facts.status = 'failed'; facts.error = String(error); process.exitCode = 1; }
finally {
  facts.finishedAt = new Date().toISOString(); facts.generationProcess = { node: process.version, platform: process.platform, arch: process.arch, maxRSSBytes: process.resourceUsage().maxRSS * 1024 };
  await checkpoint();
  console.log(JSON.stringify({ status: facts.status, error: facts.error, fixtures: facts.fixtures.map(({ name, status, bytes, hash }) => ({ name, status, bytes, hash })), receipt: join(output, 'receipt.json'), qualification: false }));
}
