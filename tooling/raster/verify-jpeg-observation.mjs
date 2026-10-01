// Run in a fresh guarded process AFTER the JPEG writer campaign has exited.
// This decoder allocation belongs only to the pixel oracle, never writer RSS.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url), repository = resolve(dirname(scriptPath), '../..');
const [measurementArgument, outputArgument, ...extra] = process.argv.slice(2);
assert(measurementArgument && outputArgument && !extra.length,
  'Usage: node --import ./tests/store/no-network.mjs tooling/raster/verify-jpeg-observation.mjs PASSED-jpeg-measurement.json NEW-oracle.json');
const measurementPath = resolve(measurementArgument), outputPath = resolve(outputArgument);
const output = await open(outputPath, 'wx', 0o600);
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const stamp = value => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].map(key => [key, String(value[key])]));
const facts = {
  schemaVersion: 1, kind: 'white-jpeg-observation-oracle-v1', status: 'running', qualification: false, at: new Date().toISOString(), errors: [], exports: [], decodedObjects: [],
  measurementPath, outputPath,
  scope: 'Only the current sealed uniform-white5000x5000 WebP fixture and four JPEG exports from a passed current writer diagnostic. Actual encoded JPEG bytes and complete decoded RGBA are checked here. No writer or product raster worker is opened.',
  independence: 'Independent all-255 RGBA oracle and a separate invocation of the pinned Sharp/libvips/mozjpeg decoder. The native codec is shared with the application; this is not an independent codec implementation, adversarial-image coverage or product qualification.',
  accounting: 'This fresh process may allocate full JPEG decoder and100MB RGBA surfaces. Its RSS belongs only to oracle verification and is not added to, substituted for, or claimed as the earlier whole-writer RSS measurement.',
  networkCounterScope: 'Required JavaScript no-network guard covers this verifier process. No storage/raster worker is started. Native internal networking and the OS are outside that API guard.',
};
let phase = 'initialization', network, networkBefore, measurement, measurementSeal, diagnosticIdentity, codecsBefore, sourcesBefore, scriptBefore;
const rememberedObjects = new Map();
function noteFailure(stage, error) {
  facts.status = 'failed'; process.exitCode = 1;
  facts.errors.push({ stage, name: error?.name ?? null, code: error?.code ?? null, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null, cause: error?.cause instanceof Error ? { name: error.cause.name, message: error.cause.message, code: error.cause.code ?? null } : error?.cause === undefined ? null : String(error.cause) });
}
async function attempt(stage, action) { try { await action(); } catch (error) { noteFailure(stage, error); } }
async function checkpoint() {
  const sealed = { ...facts, seal: { algorithm: 'sha256', payloadHash: digest(JSON.stringify(facts)) } }, bytes = Buffer.from(JSON.stringify(sealed, null, 2) + '\n');
  for (let at = 0; at < bytes.length;) { const part = await output.write(bytes, at, bytes.length - at, at); assert(part.bytesWritten > 0); at += part.bytesWritten; }
  await output.truncate(bytes.length); await output.sync();
}
async function hashHandle(file, size) {
  const block = Buffer.alloc(1024 * 1024), hash = createHash('sha256');
  for (let at = 0; at < size;) { const read = await file.read(block, 0, Math.min(block.length, size - at), at); assert(read.bytesRead > 0, 'Truncated retained file'); hash.update(block.subarray(0, read.bytesRead)); at += read.bytesRead; }
  return { bytes: size, hash: 'sha256:' + hash.digest('hex') };
}
async function identity(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true }); assert(before.isFile()); assert(Number.isSafeInteger(Number(before.size)));
    const value = await hashHandle(file, Number(before.size)); assert.deepEqual(stamp(await file.stat({ bigint: true })), stamp(before), 'File changed while hashing'); return value;
  } finally { await file.close(); }
}
async function readJSON(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true }); assert(before.isFile() && before.size <= 4n * 1024n * 1024n, 'JSON receipt exceeds4MiB');
    const bytes = await file.readFile(); assert.deepEqual(stamp(await file.stat({ bigint: true })), stamp(before));
    return { value: JSON.parse(bytes), seal: { bytes: bytes.length, hash: digest(bytes) } };
  } finally { await file.close(); }
}
async function codecSeal() {
  const profilePath = process.platform === 'darwin' && process.arch === 'arm64' ? 'tooling/raster/codecs.json'
    : process.platform === 'linux' && ['arm64', 'x64'].includes(process.arch) ? `tooling/raster/linux-codecs/1.0.0/linux-${process.arch}/codecs.json` : null;
  assert(profilePath, 'No adopted sealed Sharp profile for this host');
  const { value: codecs, seal } = await readJSON(join(repository, profilePath));
  assert.equal(codecs.platform, process.platform); assert.equal(codecs.arch, process.arch); assert.equal(codecs.node, process.versions.node); assert.equal(codecs.zlib, process.versions.zlib);
  for (const file of codecs.files) assert.deepEqual(await identity(join(repository, file.path)), { bytes: file.bytes, hash: file.hash }, file.path);
  for (const [name, file] of Object.entries(codecs.profiles)) assert.deepEqual(await identity(join(repository, 'tooling/raster', name + '.icc')), { bytes: file.bytes, hash: file.hash }, name);
  return { profilePath, profileSeal: seal, codecIdentity: digest(JSON.stringify(codecs)), versions: codecs.versions, profiles: codecs.profiles, platform: codecs.platform, arch: codecs.arch, node: codecs.node, zlib: codecs.zlib, filesVerified: codecs.files.length };
}
async function privateComponents(root, directory) {
  assert.equal(resolve(root), root); assert.equal(await realpath(root), root, 'Measurement root must remain canonical');
  let current = parse(directory).root;
  for (const part of relative(current, directory).split('/').filter(Boolean)) {
    current = join(current, part); const info = await lstat(current, { bigint: true });
    assert(info.isDirectory() && !info.isSymbolicLink(), 'Unsafe object directory: ' + current);
    if (current === root || current.startsWith(root + '/')) { assert.equal(info.uid, BigInt(process.getuid())); assert.equal(info.mode & 0o777n, 0o700n); }
  }
}
async function openPrivateObject(root, ref) {
  assert(/^sha256:[0-9a-f]{64}$/.test(ref.hash) && /^(0|[1-9][0-9]*)$/.test(ref.byteLength), 'Invalid JPEG blob identity');
  const size = Number(ref.byteLength); assert(Number.isSafeInteger(size) && size > 0);
  const path = join(root, 'objects', 'sha256', ref.hash.slice(7, 9), ref.hash.slice(7));
  await privateComponents(root, dirname(path));
  const before = await lstat(path, { bigint: true });
  assert(before.isFile() && !before.isSymbolicLink()); assert.equal(before.uid, BigInt(process.getuid())); assert.equal(before.mode & 0o777n, 0o600n); assert.equal(before.nlink, 1n); assert.equal(before.size, BigInt(size));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { assert.deepEqual(stamp(await file.stat({ bigint: true })), stamp(before), 'JPEG object changed before open'); }
  catch (error) { await file.close(); throw error; }
  return { path, file, before, size };
}
async function unchangedObject(opened) {
  assert.deepEqual(stamp(await opened.file.stat({ bigint: true })), stamp(opened.before), 'Held JPEG object changed');
  assert.deepEqual(stamp(await lstat(opened.path, { bigint: true })), stamp(opened.before), 'JPEG object path changed');
}
function whiteHash(bytes) {
  const white = Buffer.alloc(1024 * 1024, 255), hash = createHash('sha256');
  for (let at = 0; at < bytes; at += white.length) hash.update(white.subarray(0, Math.min(white.length, bytes - at)));
  return 'sha256:' + hash.digest('hex');
}
function zeroEffects(snapshot) {
  assert.equal(snapshot?.status, 'passed'); assert.equal(snapshot.explicitGuardImport, true);
  assert.deepEqual(Object.keys(snapshot.counters).sort(), ['submit', 'upload', 'poll', 'cancel', 'fetch', 'socket', 'dns', 'datagram'].sort());
  assert(Object.values(snapshot.counters).every(value => value === 0));
}

await checkpoint();
try {
  phase = 'network-guard'; network = await import('./diagnostic-network.mjs'); networkBefore = await network.beginDiagnosticNetwork(); facts.networkGuard = networkBefore;
  phase = 'source-bindings'; scriptBefore = await identity(scriptPath); facts.script = scriptBefore;
  ({ diagnosticIdentity } = await import('./diagnostic-identity.mjs')); sourcesBefore = await diagnosticIdentity(); facts.measuredSources = sourcesBefore;
  const loaded = await readJSON(measurementPath); measurement = loaded.value; measurementSeal = loaded.seal; facts.measurementSeal = measurementSeal;
  assert.equal(measurement.schemaVersion, 1); assert.equal(measurement.status, 'passed'); assert.equal(measurement.qualification, false);
  assert(Array.isArray(measurement.exports) && measurement.exports.length === 4, 'A passed four-export JPEG campaign is required');
  assert.equal(measurement.sourceHash, (await identity(join(repository, 'tooling/raster/measure-jpeg-export.mjs'))).hash, 'Measurement driver source differs');
  facts.measurementDriverHash = measurement.sourceHash;
  assert.deepEqual(measurement.measuredSources, sourcesBefore, 'Measurement compile identity differs'); assert.deepEqual(measurement.measuredSourcesAfter, sourcesBefore);
  assert.deepEqual(measurement.process, process.versions, 'Measurement runtime differs');
  zeroEffects(measurement.networkGuard); zeroEffects(measurement.networkGuardAfter); assert.equal(measurement.networkGuardAfter.identityUnchanged, true);
  for (const key of ['guardSource', 'helperSource']) { assert.deepEqual(measurement.networkGuard[key], networkBefore[key]); assert.deepEqual(measurement.networkGuardAfter[key], networkBefore[key]); }
  assert.equal(measurement.rssLimit, 512 * 1024 * 1024); assert(Number.isSafeInteger(measurement.peakRSS) && measurement.peakRSS > 0 && measurement.peakRSS <= measurement.rssLimit, 'Measurement did not pass its own RSS declaration');
  facts.measurement = { root: measurement.root, at: measurement.at, input: measurement.input, sourceHash: measurement.sourceHash, process: measurement.process, peakRSSDeclaration: measurement.peakRSS,
    note: 'The prior receipt declares this writer RSS. This helper does not remeasure or independently verify the earlier process high-water mark.' };
  phase = 'white-fixture-binding';
  const { value: fixtureManifest, seal: manifestSeal } = await readJSON(join(repository, 'tests/raster/fixtures/resource-inputs.json'));
  const allowed = ['tests/raster/fixtures/max-webp-lossless.webp', 'tests/raster/fixtures/max-webp-lossy.webp'];
  const fixture = fixtureManifest.fixtures.find(item => allowed.includes(item.file) && resolve(repository, item.file) === resolve(repository, measurement.input));
  assert(fixture && fixture.width === 5000 && fixture.height === 5000 && fixture.format === 'webp', 'Only sealed uniform-white25MP WebP campaigns are in scope');
  const fixtureSeal = await identity(join(repository, fixture.file)); assert.deepEqual(fixtureSeal, { bytes: fixture.bytes, hash: 'sha256:' + fixture.sha256 }); assert.deepEqual(measurement.inputSeal, fixtureSeal);
  facts.fixture = { declaration: fixture, manifestSeal, seal: fixtureSeal };
  const expectedRawBytes = 5000 * 5000 * 4, expectedHash = whiteHash(expectedRawBytes);
  facts.oracle = { width: 5000, height: 5000, channels: 4, rawBytes: expectedRawBytes, rgbaHash: expectedHash, algorithm: 'SHA256 over100000000 independently generated bytes of0xff, produced in repeated1MiB blocks. No decoded image supplies the expected values.' };
  assert.equal(measurement.source.qualification, 'canonical-raster'); assert.equal(measurement.source.raster.width, 5000); assert.equal(measurement.source.raster.height, 5000); assert.equal(measurement.source.raster.pixels.hash, expectedHash); assert.equal(measurement.source.raster.pixels.byteLength, String(expectedRawBytes));
  phase = 'codec-seal'; codecsBefore = await codecSeal(); facts.codec = codecsBefore; assert.equal(codecsBefore.codecIdentity, sourcesBefore.codecIdentity);
  // Import native Sharp only after all installed package/profile files match.
  const { default: sharp } = await import('sharp'); assert.deepEqual(sharp.versions, codecsBefore.versions); sharp.cache(false); sharp.concurrency(1);
  facts.decodeRecipe = { options: { failOn: 'warning', limitInputPixels: 25_000_000, sequentialRead: true, ignoreIcc: true }, colourspace: 'srgb', ensureAlpha: true, raw: { depth: 'uchar' }, cache: false, concurrency: 1 };
  const seenCommands = new Set();
  for (let index = 0; index < measurement.exports.length; index++) {
    const entry = measurement.exports[index], asset = entry.asset;
    phase = 'export-binding-' + (index + 1); assert.equal(entry.iteration, index + 1); assert(!seenCommands.has(entry.commandId)); seenCommands.add(entry.commandId);
    const command = measurement.commands.find(item => item.commandId === entry.commandId); assert.equal(command?.type, 'ExportRaster'); assert.equal(command.status, 'accepted'); assert.equal(command.receipt.status, 'accepted'); assert.equal(command.receipt.commandId, entry.commandId);
    assert.equal(asset.qualification, 'canonical-jpeg'); assert.equal(asset.availability, 'available'); assert.equal(asset.safety, 'safe'); assert.equal(asset.blob.mediaType, 'image/jpeg');
    assert.equal(asset.raster.width, 5000); assert.equal(asset.raster.height, 5000); assert.equal(asset.raster.pixels.hash, expectedHash); assert.equal(asset.raster.pixels.byteLength, String(expectedRawBytes));
    const record = { iteration: entry.iteration, commandId: entry.commandId, assetId: asset.id, blob: asset.blob, status: 'running' }; facts.exports.push(record); await checkpoint();
    const opened = await openPrivateObject(measurement.root, asset.blob);
    try {
      phase = 'jpeg-byte-seal-' + (index + 1);
      const encoded = await hashHandle(opened.file, opened.size); assert.deepEqual(encoded, { bytes: Number(asset.blob.byteLength), hash: asset.blob.hash }); await unchangedObject(opened);
      record.object = { path: opened.path, stamp: stamp(opened.before), ...encoded };
      if (!rememberedObjects.has(asset.blob.hash)) {
        phase = 'native-jpeg-decode-' + (index + 1);
        const path = '/dev/fd/' + opened.file.fd, metadata = await sharp(path, facts.decodeRecipe.options).metadata();
        assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 5000); assert.equal(metadata.height, 5000); assert.equal(metadata.channels, 3); assert.equal(metadata.depth, 'uchar'); assert.equal(metadata.hasAlpha, false);
        assert.equal(metadata.isProgressive, false); assert.equal(metadata.chromaSubsampling, '4:4:4'); assert(metadata.orientation === undefined || metadata.orientation === 1);
        assert(metadata.icc, 'Export is missing its pinned sRGB ICC'); assert.deepEqual({ bytes: metadata.icc.length, hash: digest(metadata.icc) }, codecsBefore.profiles.srgb);
        const decoded = await sharp(path, facts.decodeRecipe.options).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
        assert.equal(decoded.info.width, 5000); assert.equal(decoded.info.height, 5000); assert.equal(decoded.info.channels, 4); assert.equal(decoded.data.length, expectedRawBytes);
        const rgbaHash = digest(decoded.data); assert.equal(rgbaHash, expectedHash, 'Actual encoded JPEG does not decode to the independent white oracle');
        const decodedRecord = { blob: asset.blob, width: 5000, height: 5000, channels: 4, rawBytes: decoded.data.length, rgbaHash, whiteOracle: 'passed', metadata: { format: metadata.format, depth: metadata.depth, channels: metadata.channels, hasAlpha: metadata.hasAlpha, isProgressive: metadata.isProgressive, chromaSubsampling: metadata.chromaSubsampling, icc: { bytes: metadata.icc.length, hash: digest(metadata.icc) } } };
        facts.decodedObjects.push(decodedRecord); rememberedObjects.set(asset.blob.hash, decodedRecord);
      }
      await unchangedObject(opened); const after = await hashHandle(opened.file, opened.size); assert.deepEqual(after, encoded); await unchangedObject(opened);
      record.encodedSealAfter = after; record.stampAfter = stamp(await opened.file.stat({ bigint: true })); record.decodedObjectHash = rememberedObjects.get(asset.blob.hash).blob.hash; record.status = 'passed';
    } finally { await opened.file.close(); }
    await checkpoint();
  }
  facts.status = 'passed';
} catch (error) { noteFailure(phase, error); }
finally {
  if (measurementSeal) await attempt('measurement-receipt-unchanged', async () => { facts.measurementSealAfter = await identity(measurementPath); assert.deepEqual(facts.measurementSealAfter, measurementSeal); });
  if (measurement) await attempt('measurement-driver-unchanged', async () => { assert.equal((await identity(join(repository, 'tooling/raster/measure-jpeg-export.mjs'))).hash, measurement.sourceHash); });
  if (facts.fixture) await attempt('fixture-unchanged', async () => {
    assert.deepEqual(await identity(join(repository, facts.fixture.declaration.file)), facts.fixture.seal);
    assert.deepEqual(await identity(join(repository, 'tests/raster/fixtures/resource-inputs.json')), facts.fixture.manifestSeal);
  });
  if (codecsBefore) await attempt('codec-seal-unchanged', async () => { facts.codecAfter = await codecSeal(); assert.deepEqual(facts.codecAfter, codecsBefore); });
  if (diagnosticIdentity) await attempt('compile-identity-unchanged', async () => { facts.measuredSourcesAfter = await diagnosticIdentity(); assert.deepEqual(facts.measuredSourcesAfter, sourcesBefore); });
  if (scriptBefore) await attempt('verifier-source-unchanged', async () => { facts.scriptAfter = await identity(scriptPath); assert.deepEqual(facts.scriptAfter, scriptBefore); });
  if (network) await attempt('network-guard', async () => { facts.networkGuardAfter = await network.finishDiagnosticNetwork(networkBefore); assert.equal(facts.networkGuardAfter.status, 'passed'); });
  facts.process = { pid: process.pid, versions: process.versions, platform: process.platform, arch: process.arch, oracleProcessMaxRSSBytes: process.resourceUsage().maxRSS * 1024 };
  facts.finishedAt = new Date().toISOString();
  try { await checkpoint(); } finally { await output.close(); }
  console.log(JSON.stringify({ status: facts.status, errors: facts.errors, verifiedExports: facts.exports.filter(item => item.status === 'passed').length, distinctDecodedJPEGs: facts.decodedObjects.length, receipt: outputPath, qualification: false, writerRSSMeasuredHere: false }));
}
