// Produce an alternate decoded-pixel reference in a separate process BEFORE a
// writer RSS diagnostic. No product decoder, output bridge or writer is loaded.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url), repository = resolve(dirname(scriptPath), '../..');
const guardPath = join(repository, 'tests/store/no-network.mjs');
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^sha256:[0-9a-f]{64}$/;
const stamp = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
const decoderOptions = { failOn: 'warning', limitInputPixels: 25_000_000, sequentialRead: true, ignoreIcc: true };
const decodeRecipe = { options: decoderOptions, colourspace: 'srgb', ensureAlpha: true, raw: { depth: 'uchar' }, cache: false, concurrency: 1, orientation: 'Generated fixtures must have no orientation transform or embedded ICC/EXIF.' };

async function identity(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true }); assert(before.isFile());
    const size = Number(before.size); assert(Number.isSafeInteger(size));
    const block = Buffer.alloc(1024 * 1024), digest = createHash('sha256');
    for (let at = 0; at < size;) { const result = await file.read(block, 0, Math.min(block.length, size - at), at); assert(result.bytesRead > 0, 'Truncated source'); digest.update(block.subarray(0, result.bytesRead)); at += result.bytesRead; }
    assert.equal(stamp(await file.stat({ bigint: true })), stamp(before), 'Source changed while hashing');
    return { bytes: size, hash: 'sha256:' + digest.digest('hex') };
  } finally { await file.close(); }
}
async function readJSON(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true }); assert(before.isFile() && before.size <= 1024n * 1024n, 'JSON receipt exceeds 1 MiB');
    const bytes = await file.readFile(); assert.equal(stamp(await file.stat({ bigint: true })), stamp(before));
    return { value: JSON.parse(bytes), seal: { bytes: bytes.length, hash: hash(bytes) } };
  } finally { await file.close(); }
}
async function fixtureBinding(receiptPath, name) {
  const { value: generated, seal } = await readJSON(receiptPath);
  assert.equal(generated.kind, 'adversarial-webp-memory-fixtures-v1'); assert.equal(generated.status, 'passed'); assert.equal(generated.qualification, false);
  const fixture = generated.fixtures.find(item => item.name === name), source = generated.sources.find(item => item.file === fixture?.source);
  assert(fixture?.status === 'passed' && source?.status === 'passed', 'Completed generated fixture/source required');
  assert.equal(fixture.file, basename(fixture.file)); assert(fixture.file !== '.' && fixture.file !== '..');
  assert(Number.isSafeInteger(fixture.bytes) && fixture.bytes > 0 && hashPattern.test(fixture.hash));
  assert(Number.isInteger(fixture.width) && Number.isInteger(fixture.height) && fixture.width > 0 && fixture.height > 0 && fixture.width <= 8192 && fixture.height <= 8192 && fixture.width * fixture.height <= 25_000_000);
  assert.equal(source.rgbaHash, fixture.oracle.sourceRgbaHash); assert.equal(source.alphaHash, fixture.oracle.expectedDecodedAlphaHash);
  assert(hashPattern.test(source.rgbaHash) && hashPattern.test(source.alphaHash));
  assert.equal(fixture.oracle.rawBytes, fixture.width * fixture.height * 4); assert.equal(fixture.oracle.alphaBytes, fixture.width * fixture.height);
  assert.equal(fixture.oracle.rgbaExact, fixture.encoderOptions.lossless); assert.equal(fixture.encoderOptions.alphaQuality, 100);
  assert.equal(fixture.oracle.expectedDecodedRgbaHash, fixture.oracle.rgbaExact ? source.rgbaHash : null);
  const input = join(dirname(receiptPath), fixture.file), inputSeal = await identity(input);
  assert.deepEqual(inputSeal, { bytes: fixture.bytes, hash: fixture.hash });
  return {
    receiptPath, receiptSeal: seal, input, inputSeal,
    fixture: { name, file: fixture.file, width: fixture.width, height: fixture.height, bytes: fixture.bytes, hash: fixture.hash },
    sourceOracle: fixture.oracle, generatorSource: generated.source, generatorCodecIdentity: generated.encoder.codecIdentity,
  };
}
async function codecBinding() {
  const profilePath = process.platform === 'darwin' && process.arch === 'arm64' ? 'tooling/raster/codecs.json'
    : process.platform === 'linux' && ['arm64', 'x64'].includes(process.arch) ? `tooling/raster/linux-codecs/1.0.0/linux-${process.arch}/codecs.json` : null;
  assert(profilePath, 'No sealed Sharp profile for this platform');
  const { value: codecs, seal } = await readJSON(join(repository, profilePath));
  assert.equal(codecs.platform, process.platform); assert.equal(codecs.arch, process.arch);
  assert.equal(codecs.node, process.versions.node); assert.equal(codecs.zlib, process.versions.zlib);
  for (const file of codecs.files) assert.deepEqual(await identity(join(repository, file.path)), { bytes: file.bytes, hash: file.hash }, file.path);
  for (const [name, file] of Object.entries(codecs.profiles)) assert.deepEqual(await identity(join(repository, 'tooling/raster', name + '.icc')), { bytes: file.bytes, hash: file.hash }, name);
  return { profilePath, profileSeal: seal, codecIdentity: hash(JSON.stringify(codecs)), platform: codecs.platform, arch: codecs.arch, node: codecs.node, zlib: codecs.zlib, versions: codecs.versions, verifiedFiles: codecs.files.length };
}
async function producerBinding() { return { source: await identity(scriptPath), networkGuard: await identity(guardPath) }; }
function sealReceipt(facts) { return { ...facts, seal: { algorithm: 'sha256', payloadHash: hash(JSON.stringify(facts)) } }; }

async function child(bindingPath, outputPath) {
  const facts = { schemaVersion: 1, kind: 'adversarial-webp-sharp-oracle-child-v1', status: 'running', qualification: false, pid: process.pid, errors: [] };
  try {
    const { value: expected } = await readJSON(bindingPath);
    assert(globalThis.__storeNetworkCounters, 'The no-network preload is required in the oracle child');
    const producer = await producerBinding(), fixture = await fixtureBinding(expected.fixture.receiptPath, expected.fixture.fixture.name), codec = await codecBinding();
    assert.deepEqual(producer, expected.producer); assert.deepEqual(fixture, expected.fixture); assert.deepEqual(codec, expected.codec); assert.deepEqual(expected.decodeRecipe, decodeRecipe);
    facts.binding = expected; facts.bindingSeal = await identity(bindingPath);
    // All installed native inputs are checked before this import. This is the
    // only process that loads Sharp or allocates the complete decoded surface.
    const { default: sharp } = await import('sharp'); assert.deepEqual(sharp.versions, codec.versions);
    sharp.cache(false); sharp.concurrency(1);
    const source = await open(fixture.input, constants.O_RDONLY | constants.O_NOFOLLOW), before = await source.stat({ bigint: true });
    try {
      const input = '/dev/fd/' + source.fd, metadata = await sharp(input, decoderOptions).metadata();
      assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, fixture.fixture.width); assert.equal(metadata.height, fixture.fixture.height);
      assert.equal(metadata.depth, 'uchar'); assert(!metadata.icc && !metadata.exif && !metadata.xmp, 'Only generated untagged fixtures are in scope');
      assert(metadata.orientation === undefined || metadata.orientation === 1); assert(metadata.pages === undefined || metadata.pages === 1); assert(!metadata.delay && !metadata.loop);
      const decoded = await sharp(input, decoderOptions).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
      const expectedBytes = fixture.fixture.width * fixture.fixture.height * 4;
      assert.equal(decoded.info.width, fixture.fixture.width); assert.equal(decoded.info.height, fixture.fixture.height); assert.equal(decoded.info.channels, 4); assert.equal(decoded.data.length, expectedBytes);
      const rgbaHash = hash(decoded.data), alpha = createHash('sha256'), scratch = Buffer.alloc(256 * 1024);
      for (let pixel = 0; pixel < expectedBytes / 4;) {
        const count = Math.min(scratch.length, expectedBytes / 4 - pixel);
        for (let i = 0; i < count; i++) scratch[i] = decoded.data[(pixel + i) * 4 + 3];
        alpha.update(scratch.subarray(0, count)); pixel += count;
      }
      const alphaHash = 'sha256:' + alpha.digest('hex');
      assert.equal(alphaHash, fixture.sourceOracle.expectedDecodedAlphaHash, 'Sharp alpha differs from the independent source oracle');
      if (fixture.sourceOracle.rgbaExact) assert.equal(rgbaHash, fixture.sourceOracle.expectedDecodedRgbaHash, 'Sharp lossless RGBA differs from the independent source oracle');
      assert.equal(stamp(await source.stat({ bigint: true })), stamp(before), 'Fixture changed during native decode');
      facts.decoded = { width: fixture.fixture.width, height: fixture.fixture.height, channels: 4, rawBytes: expectedBytes, rgbaHash, alphaBytes: expectedBytes / 4, alphaHash };
    } finally { await source.close(); }
    facts.producerAfter = await producerBinding(); facts.fixtureAfter = await fixtureBinding(expected.fixture.receiptPath, expected.fixture.fixture.name); facts.codecAfter = await codecBinding();
    assert.deepEqual(facts.producerAfter, expected.producer); assert.deepEqual(facts.fixtureAfter, expected.fixture); assert.deepEqual(facts.codecAfter, expected.codec);
    facts.status = 'passed';
  } catch (error) { facts.status = 'failed'; facts.errors.push(String(error)); process.exitCode = 1; }
  finally {
    facts.networkEffects = globalThis.__storeNetworkCounters?.read() ?? null;
    if (!facts.networkEffects || Object.values(facts.networkEffects).some(value => value !== 0)) { facts.status = 'failed'; facts.errors.push('Oracle child attempted a network effect or lacked its guard'); process.exitCode = 1; }
    facts.process = { versions: process.versions, platform: process.platform, arch: process.arch, maxRSSBytes: process.resourceUsage().maxRSS * 1024 };
    await writeFile(outputPath, JSON.stringify(sealReceipt(facts), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
}

async function parent(receiptPath, name, outputPath) {
  const out = await open(outputPath, 'wx', 0o600);
  const facts = {
    schemaVersion: 1, kind: 'adversarial-webp-sharp-oracle-v1', status: 'running', qualification: false, at: new Date().toISOString(), errors: [],
    method: 'Separate short-lived, network-guarded Sharp process; ignoreIcc=true, toColourspace(srgb), ensureAlpha, raw uchar. Full RGBA and alpha hashes are returned; raw pixels are never imported into the product writer process.',
    independence: 'Alternate sealed Sharp/libvips decode path, independent of the product bounded wrapper and output bridge. It shares libwebp lineage/version and is not an independent native codec implementation. Lossless RGBA and all alpha values also have an independently generated source oracle.',
    accounting: 'Oracle child maxRSS is generation evidence only. It is not product whole-writer RSS or a 512 MiB qualification result. Wait for this process and its child to exit before launching any product RSS probe.',
  };
  async function checkpoint() {
    const bytes = Buffer.from(JSON.stringify(sealReceipt(facts), null, 2) + '\n');
    for (let at = 0; at < bytes.length;) { const part = await out.write(bytes, at, bytes.length - at, at); assert(part.bytesWritten > 0); at += part.bytesWritten; }
    await out.truncate(bytes.length); await out.sync();
  }
  try {
    await checkpoint(); facts.work = await mkdtemp(join(dirname(outputPath), '.oracle-work-'));
    const binding = { producer: await producerBinding(), fixture: await fixtureBinding(receiptPath, name), codec: await codecBinding(), decodeRecipe };
    facts.producer = binding.producer; facts.fixture = binding.fixture; facts.codec = binding.codec; facts.decodeRecipe = decodeRecipe;
    const bindingPath = join(facts.work, 'binding.json'), childPath = join(facts.work, 'child.json');
    await writeFile(bindingPath, JSON.stringify(binding, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    facts.bindingSeal = await identity(bindingPath);
    const stdout = await open(join(facts.work, 'stdout.log'), 'wx', 0o600), stderr = await open(join(facts.work, 'stderr.log'), 'wx', 0o600);
    // A no-network preload is explicit even if the parent was launched without
    // one. Preserve caller preloads/flags; never remove inherited test guards.
    const args = [...process.execArgv, '--import', guardPath, scriptPath, '--child', bindingPath, childPath];
    facts.childCommand = { executable: process.execPath, args, timeoutMs: 120000 }; await checkpoint();
    try {
      const worker = spawn(process.execPath, args, { cwd: repository, stdio: ['ignore', stdout.fd, stderr.fd] });
      facts.childExit = await new Promise((resolveExit, reject) => {
        let timedOut = false, force;
        const timer = setTimeout(() => { timedOut = true; worker.kill('SIGTERM'); force = setTimeout(() => worker.kill('SIGKILL'), 5000); }, 120000);
        worker.once('error', error => { clearTimeout(timer); clearTimeout(force); reject(error); });
        worker.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(force); resolveExit({ pid: worker.pid, code, signal, timedOut, exited: true }); });
      });
    } finally { await stdout.close(); await stderr.close(); }
    assert.equal(facts.childExit.code, 0, 'Oracle child failed; retained logs identify the attempt'); assert.equal(facts.childExit.signal, null); assert.equal(facts.childExit.timedOut, false);
    const { value: childResult, seal: childSeal } = await readJSON(childPath), { seal: payloadSeal, ...childFacts } = childResult;
    assert.equal(payloadSeal.algorithm, 'sha256'); assert.equal(payloadSeal.payloadHash, hash(JSON.stringify(childFacts)));
    assert.equal(childFacts.kind, 'adversarial-webp-sharp-oracle-child-v1'); assert.equal(childFacts.status, 'passed'); assert.equal(childFacts.pid, facts.childExit.pid);
    assert.deepEqual(childFacts.binding, binding); assert.deepEqual(childFacts.bindingSeal, facts.bindingSeal);
    facts.child = { path: childPath, seal: childSeal, receipt: childResult }; facts.decoded = childFacts.decoded;
    facts.producerAfter = await producerBinding(); facts.fixtureAfter = await fixtureBinding(receiptPath, name); facts.codecAfter = await codecBinding();
    assert.deepEqual(facts.producerAfter, binding.producer); assert.deepEqual(facts.fixtureAfter, binding.fixture); assert.deepEqual(facts.codecAfter, binding.codec);
    facts.status = 'passed';
  } catch (error) { facts.status = 'failed'; facts.errors.push(String(error)); process.exitCode = 1; }
  finally { facts.finishedAt = new Date().toISOString(); await checkpoint(); await out.close(); console.log(JSON.stringify({ status: facts.status, errors: facts.errors, receipt: outputPath, work: facts.work, childExited: facts.childExit?.exited === true, qualification: false })); }
}

const args = process.argv.slice(2);
if (args[0] === '--child') { assert.equal(args.length, 3); await child(resolve(args[1]), resolve(args[2])); }
else {
  assert.equal(args.length, 3, 'Usage: node --import ./tests/store/no-network.mjs tooling/raster/seal-memory-oracle.mjs generated-receipt.json fixture-name NEW-oracle.json');
  await parent(resolve(args[0]), args[1], resolve(args[2]));
}
