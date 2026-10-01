// External qualification only. This file is not an input to a sealed producer.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';

const {values} = parseArgs({options: {
  output: {type: 'string'},
  execution: {type: 'string'},
  'load-order': {type: 'string'},
  'image-id': {type: 'string'},
}});
assert(values.output, '--output must name a new receipt');
assert(['native', 'emulated'].includes(values.execution), '--execution native|emulated is required');
assert(['transport-first', 'vips-first'].includes(values['load-order']), '--load-order transport-first|vips-first is required');
if (values['image-id']) assert.match(values['image-id'], /^sha256:[a-f0-9]{64}$/);
const receiptPath = resolve(values.output), root = resolve(import.meta.dirname, '../..');
assert(!existsSync(receiptPath), 'Do not overwrite a retained receipt');
mkdirSync(dirname(receiptPath), {recursive: true});
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const checks = [], heldLibraries = [], cleanupErrors = [];
const receipt = {
  schemaVersion: 1, status: 'running', started: new Date().toISOString(),
  scope: 'Functional file transport, color pixels, alpha and returned mapping cleanup only. No process RSS, performance, hostile filesystem or Worker-termination qualification.',
  node: process.versions.node, platform: process.platform, arch: process.arch,
  execution: values.execution, executionSource: 'Explicit runner declaration; emulated runs establish functional evidence only.',
  imageId: values['image-id'] ?? null, loadOrder: values['load-order'],
  scriptHash: hash(readFileSync(import.meta.filename)), checks,
};
let converter, decoder, directory;
try {
  // Load the built public runtime and compare its identities with source. A stale
  // server build cannot silently qualify a different transport profile.
  const [{CODECS, CODEC_ID}, {BOUNDED_WEBP}, {LINUX_COLOR}, {WEBP_OUTPUT}, color, output, webp] = await Promise.all([
    import('../../dist/local/server/raster/codec-platform.js'),
    import('../../dist/local/server/raster/webp-platform.js'),
    import('../../dist/local/server/raster/linux-color-platform.js'),
    import('../../dist/local/server/raster/webp-output-platform.js'),
    import('../../dist/local/server/raster/webp-color.js'),
    import('../../dist/local/server/raster/webp-output.js'),
    import('../../dist/local/server/raster/webp.js'),
  ]);
  assert(['darwin-arm64', 'linux-arm64', 'linux-x64'].includes(`${process.platform}-${process.arch}`));
  const linux = process.platform === 'linux', archKey = process.arch.toUpperCase();
  const [sourceCodecs, sourceDecoderModule, sourceColorModule, sourceOutputModule] = await Promise.all([
    import(linux ? `../../server/raster/identities/linux-${process.arch}-v1.ts` : '../../server/raster/identity.ts'),
    import(linux ? `../../server/raster/webp-linux-${process.arch}-identity.ts` : '../../server/raster/webp-identity.ts'),
    linux ? import(`../../server/raster/linux-color-${process.arch}-identity.ts`) : Promise.resolve(undefined),
    import(`../../server/raster/webp-output-${process.platform}-${process.arch}-identity.ts`),
  ]);
  const sourceDecoder = linux ? sourceDecoderModule[`BOUNDED_WEBP_LINUX_${archKey}`] : sourceDecoderModule.BOUNDED_WEBP;
  const sourceColor = sourceColorModule?.[`LINUX_COLOR_${archKey}`];
  const sourceOutput = sourceOutputModule[`WEBP_OUTPUT_${process.platform.toUpperCase()}_${archKey}`];
  assert.deepEqual(CODECS, sourceCodecs.CODECS); assert.equal(CODEC_ID, sourceCodecs.CODEC_ID);
  assert.deepEqual(BOUNDED_WEBP, sourceDecoder);
  assert.deepEqual(LINUX_COLOR, sourceColor);
  assert.deepEqual(WEBP_OUTPUT, sourceOutput);
  assert.equal(CODECS.platform, process.platform); assert.equal(CODECS.arch, process.arch);
  assert.equal(CODECS.node, process.versions.node); assert.equal(CODECS.zlib, process.versions.zlib);
  assert.equal(hash(JSON.stringify(CODECS)), CODEC_ID);
  for (const file of [...CODECS.files, BOUNDED_WEBP, WEBP_OUTPUT, ...(LINUX_COLOR ? [LINUX_COLOR] : [])]) {
    const bytes = readFileSync(join(root, file.path));
    assert.equal(bytes.length, file.bytes, file.path); assert.equal(hash(bytes), file.hash, file.path);
  }
  const p3 = readFileSync(join(root, 'tooling/raster/p3.icc'));
  const srgb = readFileSync(join(root, 'tooling/raster/srgb.icc'));
  for (const [name, bytes] of [['p3', p3], ['srgb', srgb]]) {
    assert.equal(bytes.length, CODECS.profiles[name].bytes); assert.equal(hash(bytes), CODECS.profiles[name].hash);
  }
  const runtimeNames = ['webp-color', 'webp-output', 'bounded-webp', 'webp', 'linux-color', 'webp-metadata', 'codec-platform', 'webp-platform', 'linux-color-platform', 'webp-output-platform'];
  receipt.runtimeFiles = runtimeNames.map(name => {
    const path = `dist/local/server/raster/${name}.js`, bytes = readFileSync(join(root, path));
    return {path, bytes: bytes.length, hash: hash(bytes)};
  });
  receipt.identities = {codecId: CODEC_ID, decoder: BOUNDED_WEBP.hash, converter: LINUX_COLOR?.hash ?? BOUNDED_WEBP.hash, output: WEBP_OUTPUT.hash, p3: hash(p3), srgb: hash(srgb)};
  assert.equal(WEBP_OUTPUT.decoderHash, receipt.identities.decoder);
  assert.equal(WEBP_OUTPUT.converterHash, receipt.identities.converter);

  const libPath = webp.directWebPLibraryPath(); assert(libPath);
  const libIdentity = CODECS.files.find(file => libPath.endsWith(file.path.replace(/^node_modules\//, ''))); assert(libIdentity);
  const nativeColorPath = join(root, (LINUX_COLOR ?? BOUNDED_WEBP).path);
  const transportPath = join(root, WEBP_OUTPUT.path);
  const {DynamicLibrary} = await import('node:ffi');
  const load = path => {const lib = new DynamicLibrary(path); heldLibraries.push(lib); return lib;};
  let lib;
  if (values['load-order'] === 'transport-first') {load(transportPath); load(nativeColorPath); lib = load(libPath);}
  else {lib = load(libPath); load(nativeColorPath); load(transportPath);}
  const sharp = (await import('sharp')).default;
  assert.deepEqual(sharp.versions, CODECS.versions);
  sharp.cache(false); sharp.concurrency(1);
  const symbols = LINUX_COLOR
    ? ['vips_image_new_from_memory', 'vips_image_set_blob_copy', 'vips_icc_transform', 'vips_image_write_to_memory', 'g_object_unref', 'g_free', 'vips_error_clear', 'vips_cache_get_max', 'vips_concurrency_get', 'vips_version']
    : ['cmsGetEncodedCMMversion', 'cmsOpenProfileFromMem', 'cmsCreateTransform', 'cmsDoTransform', 'cmsDeleteTransform', 'cmsCloseProfile'];
  for (const name of symbols) assert.notEqual(lib.getSymbol(name), 0n, name);
  let nativeVersion;
  if (LINUX_COLOR) {
    const version = lib.getFunctions({vips_version: {arguments: ['int32'], return: 'int32'}}).vips_version;
    nativeVersion = [version(0), version(1), version(2)].join('.');
    assert.equal(nativeVersion, CODECS.versions.vips);
  } else {
    nativeVersion = lib.getFunctions({cmsGetEncodedCMMversion: {arguments: [], return: 'int32'}}).cmsGetEncodedCMMversion();
    assert.equal(nativeVersion, 2190);
  }
  receipt.colorLibrary = {path: libIdentity.path, hash: libIdentity.hash, bytes: libIdentity.bytes, symbols, nativeVersion, versions: {lcms: sharp.versions.lcms, vips: sharp.versions.vips}};
  converter = await color.openWebPColorConverter(); assert(converter, 'Actual platform color converter must open');
  decoder = await output.openWebPFileDecoder(); assert(decoder, 'Actual file decoder must open');
  directory = mkdtempSync(join(tmpdir(), 'ie-webp-output-color-'));
  let serial = 0;
  const createFile = bytes => {
    const file = join(directory, `pixels-${serial++}.rgba`);
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {if (bytes.length) writeFileSync(fd, bytes); return {file, fd};} catch (error) {closeSync(fd); throw error;}
  };
  const checkMetrics = (metrics, bytes) => {
    assert.equal(metrics.outputRemaining, 0); assert(metrics.outputPeak >= bytes); assert(metrics.outputPeak <= bytes + 65536);
  };
  const checkAlpha = (actual, before) => {
    for (let i = 3; i < actual.length; i += 4) assert.equal(actual[i], before[i], `alpha at pixel ${(i - 3) / 4}`);
  };
  const qualifyPixels = async (name, input, expected) => {
    const baseline = Buffer.from(input); await converter.convertInPlace(baseline, p3, () => {});
    assert.deepEqual(baseline, expected, `${name}: retained converter vs independent expectation`);
    const {file, fd} = createFile(input);
    try {
      const metrics = await converter.convertFileInPlace(fd, input.length, p3, () => {});
      checkMetrics(metrics, input.length);
      const actual = readFileSync(file); assert.deepEqual(actual, baseline); assert.deepEqual(actual, expected); checkAlpha(actual, input);
      checks.push({name, pixels: input.length / 4, sourceHash: hash(input), pixelHash: hash(actual), metrics, status: 'passed'});
    } finally {closeSync(fd);}
  };
  const oracleBytes = readFileSync(join(root, 'tests/raster/fixtures/color-oracle.json')), oracle = JSON.parse(oracleBytes);
  receipt.oracleHash = hash(oracleBytes);
  assert.equal('sha256:' + oracle.profileSHA256.p3, hash(p3)); assert.equal('sha256:' + oracle.profileSHA256.srgb, hash(srgb));
  const alpha = [0, 128, 255, 64];
  const literal = Buffer.from(oracle.sourceRGB.flatMap((_, i) => i % 3 === 0 ? [...oracle.sourceRGB.slice(i, i + 3), alpha[i / 3]] : []));
  const expectedLiteral = Buffer.from(oracle.expectedRGB.flatMap((_, i) => i % 3 === 0 ? [...oracle.expectedRGB.slice(i, i + 3), alpha[i / 3]] : []));
  for (const pixels of [1, 4, 16383, 16384, 16385, 32769]) {
    const input = Buffer.alloc(pixels * 4), expected = Buffer.alloc(pixels * 4);
    for (let i = 0; i < pixels; i++) {literal.copy(input, i * 4, i % 4 * 4, (i % 4 + 1) * 4); expectedLiteral.copy(expected, i * 4, i % 4 * 4, (i % 4 + 1) * 4);}
    await qualifyPixels('independent-color-oracle', input, expected);
  }
  const width = 257, height = 129, pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set([(i * 17 + Math.floor(i / 53)) % 256, (i * 29 + 7) % 256, (i * 43 + 31) % 256, alpha[i % 4]], i * 4);
  for (const lossless of [false, true]) {
    const encoded = await sharp(pixels, {raw: {width, height, channels: 4}}).withIccProfile('p3').webp({lossless, quality: 91}).toBuffer();
    assert.deepEqual((await sharp(encoded, {ignoreIcc: true}).metadata()).icc, p3);
    const expectedRaw = await sharp(encoded, {ignoreIcc: true}).toColourspace('srgb').ensureAlpha().raw({depth: 'uchar'}).toBuffer();
    const expected = await sharp(encoded).withIccProfile('srgb', {attach: false}).toColourspace('srgb').ensureAlpha().raw({depth: 'uchar'}).toBuffer();
    const source = join(directory, `input-${lossless}.webp`); writeFileSync(source, encoded, {flag: 'wx', mode: 0o600});
    const {file, fd} = createFile(Buffer.alloc(0));
    try {
      const decoded = decoder.decode(source, fd, width, height, encoded.length, () => {});
      checkMetrics(decoded.metrics, pixels.length); assert.equal(decoded.metrics.nativeRemaining, 0); assert.equal(decoded.metrics.nativeDenied, 0);
      assert.deepEqual(readFileSync(file), expectedRaw);
      const baseline = Buffer.from(expectedRaw); await converter.convertInPlace(baseline, p3, () => {}); assert.deepEqual(baseline, expected);
      const converted = await converter.convertFileInPlace(fd, pixels.length, p3, () => {});
      checkMetrics(converted, pixels.length);
      const actual = readFileSync(file); assert.deepEqual(actual, expected); assert.deepEqual(actual, baseline); checkAlpha(actual, expectedRaw);
      checks.push({name: lossless ? 'P3-lossless-alpha-file-decode-convert' : 'P3-lossy-alpha-file-decode-convert', width, height, encodedHash: hash(encoded), rawHash: hash(expectedRaw), pixelHash: hash(actual), decode: decoded.metrics, convert: converted, status: 'passed'});
    } finally {closeSync(fd);}
  }
  const retryFile = createFile(literal);
  try {
    const invalidProfile = Buffer.from(p3); invalidProfile[0] ^= 1;
    await assert.rejects(converter.convertFileInPlace(retryFile.fd, literal.length, invalidProfile, () => {}), /RASTER_PROFILE/);
    assert.deepEqual(readFileSync(retryFile.file), literal);
    const metrics = await converter.convertFileInPlace(retryFile.fd, literal.length, p3, () => {});
    checkMetrics(metrics, literal.length); assert.deepEqual(readFileSync(retryFile.file), expectedLiteral);
    checks.push({name: 'profile-refusal-and-retry', metrics, status: 'passed'});
  } finally {closeSync(retryFile.fd);}
  // Reopen the runtime helpers and perform another actual native call. No
  // fault-injected munmap failure is involved in this normal lifecycle check.
  decoder.close(); decoder = undefined; converter.close(); converter = undefined;
  converter = await color.openWebPColorConverter(); assert(converter);
  await qualifyPixels('close-reopen-retry', literal, expectedLiteral);
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed'; receipt.error = {name: error.name, message: error.message, stack: error.stack};
  process.exitCode = 1;
} finally {
  for (const object of [decoder, converter, ...heldLibraries.reverse()]) {
    try {object?.close();} catch (error) {cleanupErrors.push(error.message);}
  }
  if (directory) {
    try {rmSync(directory, {recursive: true, force: true});} catch (error) {cleanupErrors.push(error.message);}
  }
  if (cleanupErrors.length) {receipt.cleanupErrors = cleanupErrors; receipt.status = 'failed'; process.exitCode = 1;}
  receipt.finished = new Date().toISOString();
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({status: receipt.status, receipt: receiptPath, platform: receipt.platform, arch: receipt.arch, checks: checks.length}));
}
