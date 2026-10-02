import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rootFor } from '../store/helpers.mjs';
import { runRaster, resourcePlan, hash, PIPELINE } from '../../dist/local/server/raster/engine.js';
import { RasterWorkerOwner } from '../../dist/local/server/raster/worker-owner.js';
import { Assets, AssetRejection } from '../../dist/local/server/storage/assets.js';
import { Objects } from '../../dist/local/server/storage/objects.js';
import { Rasters } from '../../dist/local/server/storage/raster.js';
import { encodePNG } from '../../dist/local/server/raster/png.js';
import { encodeR16, R16_ENCODED_CODEC, R16_ENCODED_MEDIA_TYPE } from '../../dist/local/server/raster/r16-encoded.js';
import { canonical } from '../../dist/local/src/protocol/json.js';
import { rasterManifest } from '../../dist/local/src/protocol/validate.js';
import { createIdentityRequestPlan, preserveRequestRow } from '../../dist/local/src/request/raster-plan.js';

const rgbaType = 'application/x-ideogram-rgba8', r16Type = 'application/x-ideogram-r16le';
const check = () => {};
const ref = (bytes, mediaType) => ({ hash: hash(bytes), byteLength: String(bytes.length), mediaType });
const privateWrite = (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
const absent = path => assert.rejects(stat(path), { code: 'ENOENT' });
const r16 = values => {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes;
};

// Frozen metadata is constructed from literal fixture bytes. It contains no
// canonical filesystem capability and does not depend on a preliminary decode.
function rasterInfo(id, width, height, raw, role = 'composite') {
  const pixels = ref(raw, rgbaType), tiles = [{ x: 0, y: 0, width, height, hash: pixels.hash }];
  return {
    schemaVersion: role === 'mask' ? 2 : 1, pipeline: PIPELINE, width, height,
    manifest: ref(Buffer.from(canonical({ fixture: id, width, height, pixels })), 'application/json'),
    pixels, pixelIdentity: hash(canonical({ pipeline: PIPELINE, width, height, tiles })),
    role, sourceAssetIds: [], conversion: null,
  };
}

async function fixture(t) {
  const root = await rootFor(t), width = 8, height = 3, rawPaths = [];
  const middle = [
    [17, 99, 231, 0], [20, 30, 40, 128], [23, 41, 91, 0], [255, 255, 255, 128],
    [90, 90, 90, 255], [11, 22, 33, 255], [44, 55, 66, 0], [77, 88, 99, 128],
  ];
  const sourceBytes = Buffer.from([
    ...Array.from({ length: width }, (_, x) => [31 + x, 91, 171, x % 2 ? 128 : 0]),
    ...middle,
    ...Array.from({ length: width }, (_, x) => [151 + x, 81, 41, x % 2 ? 255 : 0]),
  ].flat());
  const candidateBytes = Buffer.from([[71, 29, 13, 255], [0, 0, 0, 128], [0, 0, 0, 255], [9, 19, 29, 255]].flat());
  const effectiveValues = [...Array(8).fill(0), 0, 0, 0, 32768, 65535, 0, 0, 0, ...Array(8).fill(0)];
  const authoredValues = effectiveValues.map(value => value ? 65535 : 0);
  const coverage = { width, height, get: (x, y) => effectiveValues[y * width + x] ?? 0 };

  const image = async (id, w, h, raw, encoding) => {
    const path = join(root, id + '.rgba'), encodedPath = join(root, id + '.png');
    rawPaths.push(path); await privateWrite(path, raw); await encodePNG(path, encodedPath, w, h, check);
    const info = rasterInfo(id, w, h, raw);
    if(encoding==='candidate-original'){
      info.role='native';info.sourceAssetIds=[id+'_encoded'];
      info.conversion={encodedWidth:w,encodedHeight:h,orientation:1,profile:'untagged-srgb',profileHash:null,colorChanged:false,orientationChanged:false,resized:false};
    }
    return { encodedPath, identity: {
      assetId: id, assetVersion: '1', assetHash: hash(canonical({ id, info })), info,
      encoding, encoded: ref(await readFile(encodedPath), 'image/png'), encodedAssetId: id + '_encoded',
    } };
  };
  const maskFile = async (id, values) => {
    const raw = r16(values), path = join(root, id + '.r16'), encodedPath = join(root, id + '.encoded-r16');
    rawPaths.push(path); await privateWrite(path, raw); await encodeR16(path, encodedPath, width, height, check);
    return { encodedPath, identity: {
      width, height, pixels: ref(raw, r16Type), encoded: ref(await readFile(encodedPath), R16_ENCODED_MEDIA_TYPE), codec: R16_ENCODED_CODEC,
    } };
  };
  const source = await image('source_fixture', width, height, sourceBytes, 'canonical-png');
  const candidate = await image('candidate_fixture', 4, 1, candidateBytes, 'candidate-original');
  const authored = await maskFile('authored', authoredValues);
  const effective = await maskFile('effective', effectiveValues);
  // A distinct encoded file proves that the approved capability is decoded too,
  // even though an unchanged identity mapping has the same effective raw hash.
  const approved = await maskFile('approved', effectiveValues);
  const preview = Buffer.from(effectiveValues.flatMap(value => [Math.round(value / 257), Math.round(value / 257), Math.round(value / 257), 255]));
  const mask = { id: 'mask_fixture', info: rasterInfo('mask_fixture', width, height, preview, 'mask'), authored, effective, approved };
  const plan = createIdentityRequestPlan({
    document: { width, height }, domain: { x: 2, y: 1, width: 4, height: 1 },
    sourcePixels: source.identity.info.pixels, authoredMask: authored.identity.pixels, effectiveMask: effective.identity.pixels,
    dependenciesHash: hash('encoded-input-preservation-fixture'), resolution: 'already-contained', approvalId: 'encoded_fixture_approval',
  });
  const dependencies = [source.identity.info.manifest, candidate.identity.info.manifest, mask.info.manifest, plan.sourcePixels, plan.authoredMask, plan.effectiveMask];
  const job = { type: 'encoded-preserve', source, candidate, mask, plan, dependencies };
  const expectedBytes = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.from(preserveRequestRow(
    plan, sourceBytes.subarray(y * width * 4, (y + 1) * width * 4), y === 1 ? candidateBytes : null, coverage, y,
  ))));
  // Only PNG and lossless R16 encoded files remain on disk before runRaster.
  for (const path of rawPaths) await unlink(path);
  for (const path of rawPaths) { await absent(path); assert.equal(JSON.stringify(job).includes(path), false); }
  const ordered = [source, candidate, authored, effective, approved];
  assert.deepEqual((await readdir(root)).sort(), ordered.map(input => input.encodedPath.slice(root.length + 1)).sort());
  return { root, width, height, sourceBytes, candidateBytes, effectiveValues, expectedBytes, rawPaths, ordered, job };
}

async function run(f, job = f.job, cancel = check) {
  const directory = await mkdtemp(join(f.root, 'rebuild-')), admissions = [];
  const result = await runRaster({ ...job, directory }, async plan => { admissions.push(structuredClone(plan)); }, cancel);
  return { result, directory, admissions };
}

async function assertEvidence(f, rebuilt) {
  const { result, directory, admissions } = rebuilt;
  assert.equal(admissions.length, 1, 'one external reservation spans all decodes and preservation');
  assert.deepEqual(result.plan, admissions[0]);
  assert.deepEqual(result.encodedRebuild, {
    kind: 'encoded-input-rebuild-1', canonicalInputPaths: 0, reusedPreparedProducts: 0,
    inputs: f.ordered.map((input, index) => {
      const expected = index < 2 ? input.identity.info.pixels : input.identity.pixels;
      return { encoded: input.identity.encoded, expected, actual: expected, kind: index < 2 ? 'rgba8' : 'r16le' };
    }),
    scratchRemoved: true, decodeCount: 5,
  });
  assert.equal(result.metrics.encodedInputCount, 5);
  assert.equal(result.metrics.encodedInputBytes, f.ordered.reduce((n, input) => n + Number(input.identity.encoded.byteLength), 0));
  assert.equal(result.metrics.decodedVerifiedBytes, f.sourceBytes.length + f.candidateBytes.length + f.width * f.height * 2 * 3);
  assert.equal(result.metrics.encodedScratchRemoved, 1);
  await absent(join(directory, 'encoded-inputs'));
  for (const path of f.rawPaths) await absent(path);
}

test('encoded preservation uses five genuine decodes, keeps zero-mask bytes exactly, and rebuilds deterministically', async t => {
  const f = await fixture(t), before = structuredClone(f.job), first = await run(f);
  await assertEvidence(f, first);
  const pixels = await readFile(join(first.directory, 'pixels.rgba'));
  assert.deepEqual(pixels, f.expectedBytes);
  assert.deepEqual(first.result.info.pixels, ref(f.expectedBytes, rgbaType));
  // Explicit samples supplement the independent row oracle: half-coverage CP1
  // blending is 188, and every zero-mask byte includes the original hidden RGB.
  assert.deepEqual([...pixels.subarray((f.width + 3) * 4, (f.width + 5) * 4)], [188, 188, 188, 128, 0, 0, 0, 255]);
  for (let i = 0; i < f.effectiveValues.length; i++) if (f.effectiveValues[i] === 0) {
    assert.deepEqual(pixels.subarray(i * 4, i * 4 + 4), f.sourceBytes.subarray(i * 4, i * 4 + 4), 'zero mask at pixel ' + i);
  }
  const second = await run(f);
  await assertEvidence(f, second);
  assert.notEqual(first.directory, second.directory);
  assert.deepEqual(await readFile(join(second.directory, 'pixels.rgba')), f.expectedBytes);
  assert.deepEqual(second.result.info.pixels, first.result.info.pixels);
  assert.equal(second.result.info.pixelIdentity, first.result.info.pixelIdentity);
  assert.deepEqual(second.result.png, first.result.png);
  assert.deepEqual(second.result.encodedRebuild, first.result.encodedRebuild);
  assert.notStrictEqual(second.result.encodedRebuild, first.result.encodedRebuild);
  assert.notStrictEqual(second.result.encodedRebuild.inputs, first.result.encodedRebuild.inputs);
  assert.deepEqual(f.job, before);
});

test('changed frozen canonical identities reject even when their request-plan bindings agree', async t => {
  const f = await fixture(t);
  for (const kind of ['rgba8', 'r16le']) await t.test(kind, async () => {
    const job = structuredClone(f.job), wrongHash = 'sha256:' + '0'.repeat(64);
    if (kind === 'rgba8') {
      job.source.identity.info.pixels.hash = wrongHash;
      job.plan.sourcePixels = structuredClone(job.source.identity.info.pixels);
    } else {
      job.mask.authored.identity.pixels.hash = wrongHash;
      job.plan.authoredMask = structuredClone(job.mask.authored.identity.pixels);
    }
    const directory = await mkdtemp(join(f.root, 'wrong-raw-')); let admissions = 0;
    await assert.rejects(runRaster({ ...job, directory }, async () => { admissions++; }, check), kind === 'rgba8' ? /RASTER_ENCODED_IDENTITY/ : /R16_HASH/);
    assert.equal(admissions, 1);
    await absent(join(directory, 'encoded-inputs'));
    assert.deepEqual(await readdir(directory), []);
    for (const path of f.rawPaths) await absent(path);
  });
});

test('changed encoded PNG and R16 bytes reject their frozen encoded identities', async t => {
  const f = await fixture(t);
  for (const kind of ['png', 'r16']) await t.test(kind, async () => {
    const job = structuredClone(f.job), input = kind === 'png' ? job.candidate : job.mask.effective;
    const changed = Buffer.concat([await readFile(input.encodedPath), Buffer.from([0])]);
    input.encodedPath = join(f.root, 'tampered-' + kind); await privateWrite(input.encodedPath, changed);
    const directory = await mkdtemp(join(f.root, 'wrong-encoded-')); let admissions = 0;
    await assert.rejects(runRaster({ ...job, directory }, async () => { admissions++; }, check), /RASTER_ENCODED_IDENTITY/);
    assert.equal(admissions, kind === 'png' ? 0 : 1);
    await absent(join(directory, 'encoded-inputs'));
    assert.deepEqual(await readdir(directory), []);
    for (const path of f.rawPaths) await absent(path);
  });
});

test('candidate original cannot silently change its retained decoder pipeline or conversion decisions', async t => {
  const f=await fixture(t);
  for(const kind of ['pipeline','conversion']){
    const job=structuredClone(f.job),directory=await mkdtemp(join(f.root,'conversion-'));
    if(kind==='pipeline')job.candidate.identity.info.pipeline='cp1-f64-triangle-area-v1/sha256:'+'0'.repeat(64);
    else Object.assign(job.candidate.identity.info.conversion,{orientation:2,orientationChanged:true});
    await assert.rejects(runRaster({...job,directory},async()=>{},check),/RASTER_ENCODED_IDENTITY/);
    await absent(join(directory,'encoded-inputs'));
  }
});

// Native text has already been shaped by its owning producer. Exercise its real
// retained-text raster boundary here with literal glyph coverage; these are not
// font shaping tests. The ordinary composition/export path is the pixel oracle.
async function compositionFixture(t, width = 6, height = 3, black = false) {
  const root = await rootFor(t), rawPaths = [], temporary = [], canonicalInputs = new Map();
  const image = async (id, w, h, raw, kind = 'canonical-png') => {
    const path = join(root, id + '.rgba'); rawPaths.push(path); await privateWrite(path, raw);
    let info = rasterInfo(id, w, h, raw), encodedPath = join(root, id + '.png');
    if (kind === 'text') {
      const directory = await mkdtemp(join(root, 'native-text-'));
      const source = ref(Buffer.from(canonical({ fixture: 'native-glyph-coverage', id })), 'application/json');
      const retained = await runRaster({ type: 'text', directory, path, width: w, height: h, source, dependencies: [source] }, async () => {}, check);
      assert.equal(retained.manifest.plan.kind, 'retained-text');
      assert.deepEqual(await readFile(join(directory, 'pixels.rgba')), raw);
      info = retained.info; encodedPath = join(directory, 'output.png'); rawPaths.push(join(directory, 'pixels.rgba'));
    } else await encodePNG(path, encodedPath, w, h, check);
    canonicalInputs.set(id, { id, info, path });
    return { encodedPath, identity: { assetId: id, assetVersion: '1', assetHash: hash(canonical({ id, info })), info,
      encoding: 'canonical-png', encoded: ref(await readFile(encodedPath), 'image/png'), encodedAssetId: id } };
  };
  const base = await image('native_base', width, height, Buffer.from(Array(width * height).fill(black ? [0, 0, 0, 255] : [17, 33, 49, 255]).flat()));
  const candidateBytes = Buffer.from(Array(4).fill(black ? [0, 0, 0, 255] : [36, 104, 172, 255]).flat());
  if (!black) candidateBytes.set([17, 99, 231, 0], 3 * 4);
  const candidate = await image('native_candidate', 2, 2, candidateBytes);
  const native = await image('native_lettering', 2, 1, Buffer.from([255, 255, 255, 255, 255, 255, 255, 255]), 'text');
  const alpha = Buffer.from(Array(width * height).fill([255, 255, 255, 255]).flat()); alpha.set([0, 0, 0, 255], 2 * 4);
  const imageMask = await image('native_image_mask', width, height, alpha);
  const values = Array(width * height).fill(0); values[width + 1] = 65535; values[width + 2] = 32768;
  const coverage = r16(values), coveragePath = join(root, 'native_coverage.r16'), encodedPath = join(root, 'native_coverage.encoded-r16');
  rawPaths.push(coveragePath); await privateWrite(coveragePath, coverage); await encodeR16(coveragePath, encodedPath, width, height, check);
  const preview = Buffer.from(values.flatMap(value => [Math.round(value / 257), Math.round(value / 257), Math.round(value / 257), 255]));
  const info = rasterInfo('native_coverage', width, height, preview, 'mask');
  const mask = { encodedPath, identity: { assetId: 'native_coverage', assetVersion: '1', assetHash: hash(canonical({ info })), info,
    coverage: { width, height, pixels: ref(coverage, r16Type), encoded: ref(await readFile(encodedPath), R16_ENCODED_MEDIA_TYPE), codec: R16_ENCODED_CODEC } } };
  canonicalInputs.set(mask.identity.assetId, { id: mask.identity.assetId, info, path: '', coveragePath });
  const layer = (input, extra = {}) => ({ assetId: input.identity.assetId, transform: [1, 0, 0, 1, 0, 0], opacity: 1, mask: null, ...extra });
  const candidateLayer = layer(candidate, { transform: [1, 0, 0, 1, 1, 0], mask: { assetId: imageMask.identity.assetId, mapping: 'document-luminance-alpha-v1', inverted: false } });
  const nativeLayer = layer(native, { transform: [1, 0, 0, 1, 1, 1], mask: { assetId: mask.identity.assetId, mapping: 'document-r16-v1', inverted: false } });
  const job = (layers, inputs, masks = [], comparison) => ({ type: 'encoded-compose', width, height, layers, inputs, masks,
    dependencies: [...inputs, ...masks].map(input => input.identity.info.manifest), ...(comparison ? { comparison } : {}) });
  const jobs = {
    'candidate-alone': job([layer(candidate, { transform: [1, 0, 0, 1, 1, 0] })], [candidate], [], 'candidate-alone'),
    'native-off': job([layer(base), candidateLayer], [base, candidate, imageMask], [], 'native-off'),
    'native-on': job([layer(base), candidateLayer, nativeLayer], [base, candidate, imageMask, native], [mask], 'native-on'),
  };
  const composition = { ...jobs['native-on'] }; delete composition.comparison;
  const expected = new Map();
  for (const [name, input] of [...Object.entries(jobs), ['composition', composition]]) {
    const directory = await mkdtemp(join(root, 'raw-oracle-')); temporary.push(directory);
    const inputs = [...input.inputs, ...input.masks].map(value => canonicalInputs.get(value.identity.assetId));
    let result = await runRaster({ type: 'compose', directory, width, height, layers: input.layers, inputs, dependencies: input.dependencies }, async () => {}, check);
    let pixelsPath = join(directory, 'pixels.rgba');
    if (input.comparison) {
      const output = await mkdtemp(join(root, 'export-oracle-')); temporary.push(output);
      const scale = Math.min(1, 1024 / width, 1024 / height), resize = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
      result = await runRaster({ type: 'export', directory: output, input: { id: 'oracle', info: result.info, path: pixelsPath }, dependencies: input.dependencies,
        options: { format: 'png', resize, matte: null, quality: null } }, async () => {}, check);
      pixelsPath = join(output, 'pixels.rgba');
    }
    expected.set(name, { bytes: await readFile(pixelsPath), pixels: result.info.pixels, pixelIdentity: result.info.pixelIdentity, png: result.png });
  }
  for (const path of rawPaths) await unlink(path);
  for (const directory of temporary) await rm(directory, { recursive: true });
  for (const path of [...rawPaths, ...temporary]) await absent(path);
  for (const path of rawPaths) assert.equal(JSON.stringify(composition).includes(path), false, 'encoded job exposes no canonical path');
  return { root, width, height, rawPaths, temporary, jobs, composition, expected, base, candidate, native, imageMask, mask };
}

async function compositionEvidence(f, job, built) {
  const { result, directory, admissions } = built, images = job.inputs, masks = job.masks ?? [];
  const evidence = [
    ...images.map(input => ({ encoded: input.identity.encoded, expected: input.identity.info.pixels, actual: input.identity.info.pixels, kind: 'rgba8' })),
    ...masks.map(input => ({ encoded: input.identity.coverage.encoded, expected: input.identity.coverage.pixels, actual: input.identity.coverage.pixels, kind: 'r16le' })),
  ];
  assert.equal(admissions.length, 1, 'one reservation covers every fresh decode, composition and optional export');
  assert.deepEqual(result.plan, admissions[0]);
  assert.deepEqual(result.encodedRebuild, { kind: 'encoded-input-rebuild-1', canonicalInputPaths: 0, reusedPreparedProducts: 0, inputs: evidence, scratchRemoved: true, decodeCount: evidence.length });
  assert.equal(result.metrics.encodedInputCount, evidence.length);
  assert.equal(result.metrics.encodedInputBytes, evidence.reduce((sum, input) => sum + Number(input.encoded.byteLength), 0));
  assert.equal(result.metrics.decodedVerifiedBytes, evidence.reduce((sum, input) => sum + Number(input.actual.byteLength), 0));
  assert.equal(result.metrics.encodedScratchRemoved, 1);
  const minimumDisk = resourcePlan(job.width, job.height).diskBytes + images.reduce((sum, input) => sum + resourcePlan(input.identity.info.width, input.identity.info.height, true).diskBytes, 0) + masks.reduce((sum, input) => sum + Number(input.identity.coverage.pixels.byteLength), 0) + (job.comparison ? resourcePlan(result.info.width, result.info.height).diskBytes : 0) + 1024 * 1024;
  assert.ok(result.plan.diskBytes >= minimumDisk, 'all decoded scratch inputs remain covered while composing');
  assert.equal(result.plan.cpuBytes, Object.values(result.plan.allocations).reduce((sum, value) => sum + value, 0));
  assert.ok(result.plan.cpuBytes > 0 && result.plan.cpuBytes < 512 * 1024 ** 2);
  for (const path of [join(directory, 'encoded-inputs'), ...f.rawPaths, ...f.temporary]) await absent(path);
  for (const input of [...images, ...masks]) {
    const encoded = input.identity.encoded ?? input.identity.coverage.encoded;
    assert.deepEqual(ref(await readFile(input.encodedPath), encoded.mediaType), encoded, 'retained encoded inputs stay immutable');
  }
  rasterManifest(result.manifest);
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  assert.deepEqual(JSON.parse(manifestBytes), result.manifest);
  assert.deepEqual(ref(manifestBytes, 'application/json'), result.info.manifest);
  assert.deepEqual(result.files.find(file => file.name === 'manifest.json').ref, result.info.manifest);
}

test('encoded native/candidate composition freshly decodes both mask forms and exactly matches ordinary composition', async t => {
  const f = await compositionFixture(t), before = structuredClone(f.composition), first = await run(f, f.composition);
  await compositionEvidence(f, f.composition, first);
  const actual = await readFile(join(first.directory, 'pixels.rgba')), expected = f.expected.get('composition');
  assert.deepEqual(actual, expected.bytes); assert.deepEqual(first.result.info.pixels, expected.pixels);
  assert.equal(first.result.info.pixelIdentity, expected.pixelIdentity); assert.deepEqual(first.result.png, expected.png);
  const sample = (x, y) => [...actual.subarray((y * f.width + x) * 4, (y * f.width + x + 1) * 4)];
  assert.deepEqual(sample(1, 0), [36, 104, 172, 255]);
  assert.deepEqual(sample(2, 0), [17, 33, 49, 255], 'RGBA mask removes this candidate pixel');
  assert.deepEqual(sample(1, 1), [255, 255, 255, 255], 'R16 mask retains the native glyph');
  assert.notDeepEqual(sample(2, 1), [36, 104, 172, 255], 'half R16 coverage contributes native lettering');
  const second = await run(f, f.composition); await compositionEvidence(f, f.composition, second);
  assert.deepEqual(await readFile(join(second.directory, 'pixels.rgba')), actual);
  assert.deepEqual(second.result.png, first.result.png); assert.deepEqual(f.composition, before);
});

test('encoded native text applies transform, 16-bit mask and opacity once at the CP1 boundary', async t => {
  const f = await compositionFixture(t, 6, 3, true), job = structuredClone(f.composition);
  job.layers[2].opacity = 0.5;
  const built = await run(f, job); await compositionEvidence(f, job, built);
  const pixels = await readFile(join(built.directory, 'pixels.rgba'));
  const expected = Buffer.from(Array(f.width * f.height).fill([0, 0, 0, 255]).flat());
  expected.set([188, 188, 188, 255], (f.width + 1) * 4);
  expected.set([137, 137, 137, 255], (f.width + 2) * 4);
  assert.deepEqual(pixels, expected, 'one transform/mask/opacity contribution matches literal linear-light boundary probes');
});

test('encoded native composition retains R16 mask offsets, inversion and zero coverage outside the retained domain', async t => {
  const f = await compositionFixture(t, 6, 3, true);
  for (const offsetX of [1, 2]) {
    const job = structuredClone(f.composition);
    Object.assign(job.layers[2], { opacity: 0.5, mask: { assetId: f.mask.identity.assetId, mapping: 'retained-r16-v1', offsetX, offsetY: 0, width: f.width, height: f.height, outside: 'zero', inverted: true } });
    const built = await run(f, job); await compositionEvidence(f, job, built);
    const expected = Buffer.from(Array(f.width * f.height).fill([0, 0, 0, 255]).flat());
    expected.set([188, 188, 188, 255], (f.width + offsetX) * 4);
    assert.deepEqual(await readFile(join(built.directory, 'pixels.rgba')), expected);
    assert.equal(built.result.manifest.schemaVersion, 3);
  }
});

for (const [width, height] of [[6, 3], [1537, 11], [11, 1537]]) test(`three encoded lettering comparisons preserve actual layer sets and bound ${width}x${height}`, async t => {
  const f = await compositionFixture(t, width, height), scale = Math.min(1, 1024 / width, 1024 / height), hashes = new Set();
  for (const [comparison, job] of Object.entries(f.jobs)) {
    const built = await run(f, job), { result, directory } = built, expected = f.expected.get(comparison);
    await compositionEvidence(f, job, built);
    assert.equal(result.info.role, 'export'); assert.equal(result.info.width, Math.max(1, Math.round(width * scale))); assert.equal(result.info.height, Math.max(1, Math.round(height * scale)));
    assert.ok(result.info.width <= 1024 && result.info.height <= 1024);
    assert.deepEqual(await readFile(join(directory, 'pixels.rgba')), expected.bytes);
    if (width === 6 && comparison === 'candidate-alone') assert.deepEqual([...expected.bytes.subarray((width + 2) * 4, (width + 3) * 4)], [17, 99, 231, 0], 'no-upscale comparison retains hidden RGB in an exact translated candidate');
    assert.deepEqual(result.info.pixels, expected.pixels); assert.equal(result.info.pixelIdentity, expected.pixelIdentity); assert.deepEqual(result.png, expected.png);
    assert.deepEqual(result.manifest.plan, { kind: 'candidate-lettering-comparison-v1', sourceWidth: width, sourceHeight: height, layers: job.layers, comparison,
      kernel: 'triangle-area-source-axis-row-norm-v1', edge: 'transparent-zero-no-renormalization', preservation: 'not-applied' });
    assert.deepEqual(result.manifest.dependencies, job.dependencies, 'no deleted scratch-composition manifest grants durable authority');
    assert.deepEqual(result.info.sourceAssetIds, [...new Set(job.layers.flatMap(layer => [layer.assetId, ...(layer.mask ? [layer.mask.assetId] : [])]))]);
    assert.equal(result.metrics.comparisonSourceWidth, width); assert.equal(result.metrics.comparisonSourceHeight, height);
    const forged = structuredClone(result.manifest); forged.plan.preservation = 'applied'; assert.throws(() => rasterManifest(forged));
    hashes.add(result.info.pixels.hash);
  }
  if (width === 6) assert.equal(hashes.size, 3, 'candidate-alone, native-off and native-on are three different actual pixel outputs');
});

test('empty native-off comparison is transparent without invented decodes or sources', async t => {
  const root = await rootFor(t), f = { root, rawPaths: [], temporary: [] }, job = { type: 'encoded-compose', width: 3, height: 2, layers: [], inputs: [], masks: [], dependencies: [], comparison: 'native-off' };
  const built = await run(f, job); await compositionEvidence(f, job, built);
  assert.deepEqual(await readFile(join(built.directory, 'pixels.rgba')), Buffer.alloc(3 * 2 * 4));
  assert.deepEqual(built.result.info.sourceAssetIds, []); assert.equal(built.result.encodedRebuild.decodeCount, 0);
});

test('encoded composition rejects missing, duplicate, extra and unsupported frozen graph inputs before admission', async t => {
  const f = await compositionFixture(t);
  const changes = {
    'missing-image': job => { job.inputs.pop(); },
    'unused-image': job => { const input = structuredClone(job.inputs[0]); input.identity.assetId = 'unused_image'; job.inputs.push(input); },
    'duplicate-image': job => { job.inputs.push(structuredClone(job.inputs[0])); },
    'missing-r16-mask': job => { job.masks = []; },
    'unused-r16-mask': job => { const input = structuredClone(job.masks[0]); input.identity.assetId = 'unused_mask'; job.masks.push(input); },
    'duplicate-r16-mask': job => { job.masks.push(structuredClone(job.masks[0])); },
    'image-mask-id-collision': job => { job.masks[0].identity.assetId = job.inputs[0].identity.assetId; },
    'wrong-mask-grid': job => { job.layers[2].mask = { assetId: job.masks[0].identity.assetId, mapping: 'retained-r16-v1', width: 2, height: 1, offsetX: 0, offsetY: 0, outside: 'zero', inverted: false }; },
    'unsupported-mask-mapping': job => { job.layers[2].mask.mapping = 'unreviewed-mask'; },
    'unsupported-image-encoding': job => { job.inputs[0].identity.encoding = 'canonical-raw'; },
    'unprepared-candidate-original': job => { job.inputs[1].identity.encoding = 'candidate-original'; },
    'wrong-encoded-owner': job => { job.inputs[1].identity.encodedAssetId = 'unrelated_encoded_owner'; },
    'missing-png-file': job => { job.inputs[0].encodedPath = join(f.root, 'absent-png'); },
    'canonical-png-media-mismatch': job => { job.inputs[0].identity.encoded.mediaType = 'image/jpeg'; },
    'unsupported-r16-codec': job => { job.masks[0].identity.coverage.codec = 'unreviewed-r16'; },
    'too-many-layers': job => { job.layers = Array(101).fill(job.layers[0]); job.inputs = [job.inputs[0]]; job.masks = []; job.dependencies = [job.inputs[0].identity.info.manifest]; },
    'unsupported-comparison': job => { job.comparison = 'preserved-native'; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const job = structuredClone(f.composition); change(job);
    const directory = await mkdtemp(join(f.root, 'invalid-graph-')); let admissions = 0;
    await assert.rejects(runRaster({ ...job, directory }, async () => { admissions++; }, check));
    assert.equal(admissions, 0); assert.deepEqual(await readdir(directory), []); await absent(join(directory, 'encoded-inputs'));
  });
});

test('candidate-alone comparison rejects extra layers, opacity and masks before admission', async t => {
  const f = await compositionFixture(t);
  for (const kind of ['multiple-layers', 'opacity', 'mask']) await t.test(kind, async () => {
    const job = structuredClone(f.jobs['candidate-alone']);
    if (kind === 'multiple-layers') job.layers.push(structuredClone(job.layers[0]));
    else if (kind === 'opacity') job.layers[0].opacity = 0.5;
    else { job.layers[0].mask = { assetId: f.imageMask.identity.assetId, mapping: 'document-luminance-alpha-v1', inverted: false }; job.inputs.push(f.imageMask); job.dependencies.push(f.imageMask.identity.info.manifest); }
    const directory = await mkdtemp(join(f.root, 'invalid-alone-')); let admissions = 0;
    await assert.rejects(runRaster({ ...job, directory }, async () => { admissions++; }, check), /RASTER_ENCODED_INPUT/);
    assert.equal(admissions, 0); assert.deepEqual(await readdir(directory), []);
  });
});

test('encoded native composition binds exact decoded PNG and lossless R16 coverage, including failed decode cleanup', async t => {
  const f = await compositionFixture(t);
  for (const kind of ['native-pixels', 'r16-pixels', 'r16-encoded', 'missing-r16-file']) await t.test(kind, async () => {
    const job = structuredClone(f.composition), directory = await mkdtemp(join(f.root, 'invalid-content-')); let admissions = 0;
    if (kind === 'native-pixels') job.inputs[3].identity.info.pixels.hash = 'sha256:' + '0'.repeat(64);
    else if (kind === 'r16-pixels') job.masks[0].identity.coverage.pixels.hash = 'sha256:' + '0'.repeat(64);
    else if (kind === 'r16-encoded') {
      const input = job.masks[0]; input.encodedPath = join(f.root, 'wrong-r16-bytes');
      await privateWrite(input.encodedPath, Buffer.concat([await readFile(f.mask.encodedPath), Buffer.from([0])]));
    } else job.masks[0].encodedPath = join(f.root, 'absent-r16');
    await assert.rejects(runRaster({ ...job, directory }, async () => { admissions++; }, check), kind === 'r16-pixels' ? /R16_HASH/ : kind === 'missing-r16-file' ? { code: 'ENOENT' } : /RASTER_ENCODED_IDENTITY/);
    assert.equal(admissions, 1); await absent(join(directory, 'encoded-inputs')); assert.deepEqual(await readdir(directory), []);
  });
});

test('native composition admission refusal and cancellation remove scratch and leave retained encoded inputs reusable', async t => {
  const f = await compositionFixture(t), refused = await mkdtemp(join(f.root, 'refused-')), refusal = Error('native-reservation-refused'); let admissions = 0;
  await assert.rejects(runRaster({ ...f.composition, directory: refused }, async () => { admissions++; throw refusal; }, check), error => error === refusal);
  assert.equal(admissions, 1); assert.deepEqual(await readdir(refused), []);
  const directory = await mkdtemp(join(f.root, 'native-cancelled-')), scratch = join(directory, 'encoded-inputs'), maskPath = join(scratch, 'mask-0.r16'), cancellation = Error('native-composition-cancelled'); let observed = false;
  await assert.rejects(runRaster({ ...f.composition, directory }, async () => {}, () => {
    if (existsSync(maskPath) && statSync(maskPath).size > 0) { observed = true; throw cancellation; }
  }), error => error === cancellation);
  assert.equal(observed, true, 'cancellation happens after native PNGs and R16 scratch bytes are being decoded');
  await absent(scratch); assert.deepEqual(await readdir(directory), []);
  const retried = await run(f, f.composition); await compositionEvidence(f, f.composition, retried);
  assert.deepEqual(await readFile(join(retried.directory, 'pixels.rgba')), f.expected.get('composition').bytes);
  const comparisonDirectory = await mkdtemp(join(f.root, 'comparison-cancelled-')), comparisonScratch = join(comparisonDirectory, 'encoded-inputs');
  const fullSizePixels = join(comparisonScratch, 'comparison-composition', 'pixels.rgba'); let composed = false;
  await assert.rejects(runRaster({ ...f.jobs['native-on'], directory: comparisonDirectory }, async () => {}, () => {
    if (existsSync(fullSizePixels) && statSync(fullSizePixels).size > 0) { composed = true; throw cancellation; }
  }), error => error === cancellation);
  assert.equal(composed, true, 'cancellation observes real full-size comparison scratch after decoding all original inputs');
  await absent(comparisonScratch); assert.deepEqual(await readdir(comparisonDirectory), []);
  const compared = await run(f, f.jobs['native-on']); await compositionEvidence(f, f.jobs['native-on'], compared);
  assert.deepEqual(await readFile(join(compared.directory, 'pixels.rgba')), f.expected.get('native-on').bytes);
});

test('real owned worker releases rejected native composition and then performs an exact encoded retry', async t => {
  const f = await compositionFixture(t), owner = new RasterWorkerOwner(); t.after(() => owner.close());
  const refusedDirectory = await mkdtemp(join(f.root, 'worker-refused-')), refusal = Error('native-worker-reservation-refused'); let admissions = 0;
  const hooks = { check, admit() { admissions++; throw refusal; }, failure(message) { return Error(message.code); }, telemetry() {} };
  await assert.rejects(owner.run({ ...f.composition, directory: refusedDirectory }, 'history:native_refused', hooks), error => error === refusal);
  assert.equal(admissions, 1); assert.equal(owner.snapshot.activeJobs, 0); assert.equal(owner.snapshot.retainedJobReferences, 0); assert.equal(owner.snapshot.workerCount, 0);
  assert.deepEqual(await readdir(refusedDirectory), []);
  const failedDirectory = await mkdtemp(join(f.root, 'worker-failed-')), invalid = structuredClone(f.composition); let failedAdmissions = 0;
  invalid.inputs[3].identity.info.pixels.hash = 'sha256:' + '0'.repeat(64);
  await assert.rejects(owner.run({ ...invalid, directory: failedDirectory }, 'history:native_failed', { ...hooks, admit() { failedAdmissions++; } }), /RASTER_ENCODED_IDENTITY/);
  assert.equal(failedAdmissions, 1); await absent(join(failedDirectory, 'encoded-inputs')); assert.deepEqual(await readdir(failedDirectory), []);
  assert.equal(owner.snapshot.activeJobs, 0); assert.equal(owner.snapshot.retainedJobReferences, 0); assert.equal(owner.snapshot.workerCount, 0); assert.equal(owner.snapshot.completedJobs, 0);
  const directory = await mkdtemp(join(f.root, 'worker-native-')), plans = [];
  const result = await owner.run({ ...f.composition, directory }, 'history:native_retry', { ...hooks, admit(plan) { plans.push(structuredClone(plan)); } });
  await compositionEvidence(f, f.composition, { result, directory, admissions: plans });
  assert.deepEqual(await readFile(join(directory, 'pixels.rgba')), f.expected.get('composition').bytes);
  assert.equal(owner.snapshot.activeJobs, 0); assert.equal(owner.snapshot.retainedJobReferences, 0); assert.equal(owner.snapshot.idleWorkers, 1); assert.equal(owner.snapshot.completedJobs, 1);
  await owner.close(); assert.equal(owner.snapshot.workerCount, 0);
});

test('cancellation after decoded R16 scratch bytes exist removes the entire invocation scratch tree', async t => {
  const f = await fixture(t), directory = await mkdtemp(join(f.root, 'cancelled-'));
  const scratch = join(directory, 'encoded-inputs'), maskPath = join(scratch, 'mask-0.r16');
  const cancelled = new Error('encoded-rebuild-cancelled'); let observedDecodedMask = false, admissions = 0;
  const cancel = () => {
    if (existsSync(maskPath) && statSync(maskPath).size > 0) { observedDecodedMask = true; throw cancelled; }
  };
  await assert.rejects(runRaster({ ...f.job, directory }, async () => { admissions++; }, cancel), error => error === cancelled);
  assert.equal(observedDecodedMask, true);
  assert.equal(admissions, 1);
  await absent(scratch);
  assert.deepEqual(await readdir(directory), []);
  await new Promise(resolve => setImmediate(resolve));
  await absent(scratch);
  for (const path of f.rawPaths) await absent(path);
  // The cancelled invocation did not mutate the five retained encoded inputs.
  for (const input of f.ordered) assert.deepEqual(ref(await readFile(input.encodedPath), input.identity.encoded.mediaType), input.identity.encoded);
});
test('writer rejects another valid same-grid R16 coverage under an unchanged frozen mask identity', async t => {
  const root = await rootFor(t), width = 8, height = 3, db = new DatabaseSync(':memory:');
  // A deliberately small metadata fixture exercises the real Assets lookup,
  // Objects verification, and Rasters asset/manifest methods. It does not mint
  // a history review, command receipt, or authorization capability.
  db.exec(`
    CREATE TABLE staged_assets (id TEXT PRIMARY KEY);
    CREATE TABLE assets (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE objects (hash TEXT PRIMARY KEY, byte_length TEXT NOT NULL);
    CREATE TABLE roots (hash TEXT PRIMARY KEY);
  `);
  const objects = new Objects(root, check, check);
  const forbiddenCommit = () => { assert.fail('isolated writer boundary must not commit'); };
  const assets = new Assets(db, objects, root, '1', check, check, forbiddenCommit, forbiddenCommit);
  t.after(async () => { await assets.close(); objects.close(); db.close(); });

  const retain = async (path, blob) => {
    const proof = await objects.adoptFile(path, blob, check);
    objects.releaseProof(proof);
    db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?)').run(blob.hash, blob.byteLength);
    db.prepare('INSERT OR IGNORE INTO roots VALUES (?)').run(blob.hash);
  };
  const makeMask = async (id, x) => {
    const directory = await mkdtemp(join(root, id + '-'));
    const result = await runRaster({
      type: 'mask', directory,
      plan: { width, height, feather: 0, operations: [
        { kind: 'shape', shape: { kind: 'rectangle', x, y: 1, width: 2, height: 1 }, mode: 'replace' },
      ] }, inputs: [], dependencies: [],
    }, async () => {}, check);
    rasterManifest(result.manifest);
    const encodedPath = join(directory, 'coverage.r16z');
    await encodeR16(join(directory, 'effective.r16'), encodedPath, width, height, check);
    const encoded = ref(await readFile(encodedPath), R16_ENCODED_MEDIA_TYPE);
    for (const file of result.files) await retain(join(directory, file.name), file.ref);
    await retain(encodedPath, encoded);
    const asset = {
      id, version: '1', purpose: 'image', blob: result.png,
      dependencies: [result.info.manifest, result.info.pixels],
      safety: 'safe', availability: 'available', qualification: 'canonical-raster',
      measuredMediaType: 'image/png', raster: result.info,
    };
    db.prepare('INSERT INTO assets VALUES (?,?)').run(id, canonical(asset));
    return { asset, manifest: result.manifest, coverage: {
      encoded, pixels: result.manifest.plan.effective,
      width, height, codec: R16_ENCODED_CODEC,
    } };
  };
  const original = await makeMask('writer_original_mask', 1);
  const other = await makeMask('writer_other_mask', 4);
  assert.notEqual(original.coverage.pixels.hash, other.coverage.pixels.hash);
  assert.notEqual(original.coverage.encoded.hash, other.coverage.encoded.hash);
  assert.equal(original.coverage.pixels.byteLength, other.coverage.pixels.byteLength);

  // No worker owner or scheduling lifecycle is needed for this pre-admission
  // boundary. The public entry point and both private identity readers remain
  // the actual Rasters implementations; only downstream execution is a sentinel.
  const rasters = Object.assign(Object.create(Rasters.prototype), { db, objects, assets });
  assert.deepEqual(rasters.manifest(original.asset.id), original.manifest);
  assert.deepEqual(rasters.manifest(other.asset.id), other.manifest);
  const preparedDirectory = await mkdtemp(join(root, 'fresh-composite-'));
  const preparedResult = await runRaster({ type: 'solid-background', directory: preparedDirectory, width, height, color: [11, 23, 47, 255] }, async () => {}, check);
  for (const file of preparedResult.files) await retain(join(preparedDirectory, file.name), file.ref);
  const prepared = {
    id: 'writer_fresh_composite', version: '1', purpose: 'image', blob: preparedResult.png,
    dependencies: [preparedResult.info.manifest, preparedResult.info.pixels],
    safety: 'safe', availability: 'available', qualification: 'canonical-raster',
    measuredMediaType: 'image/png', raster: preparedResult.info,
  };
  const layer = {
    assetId: 'reviewed_candidate', transform: [1, 0, 0, 1, 0, 0], opacity: 1,
    mask: { assetId: original.asset.id, mapping: 'document-r16-v1', inverted: false },
  };
  const frozen = {
    kind: 'encoded-composition-inputs-1', width, height,
    candidateAssetId: layer.assetId, layers: [layer], images: [], masks: [{
      assetId: original.asset.id, assetVersion: original.asset.version,
      assetHash: hash(canonical(original.asset)), info: structuredClone(original.asset.raster),
      coverage: structuredClone(original.coverage),
    }],
  };
  const body = { type: 'ComposeRaster', width, height,
    layers: [{ ...structuredClone(layer), assetId: prepared.id }] };
  const canonicalHashes = new Set([
    prepared.raster.pixels.hash, original.asset.raster.pixels.hash, other.asset.raster.pixels.hash,
    original.manifest.plan.hard.hash, original.coverage.pixels.hash,
    other.manifest.plan.hard.hash, other.coverage.pixels.hash,
  ]);
  const path = objects.path.bind(objects), reads = [], admitted = [];
  objects.path = blob => {
    assert.equal(canonicalHashes.has(blob.hash), false, 'writer must not resolve canonical pixel paths');
    reads.push(blob.hash); return path(blob);
  };
  const reachedAdmission = { boundary: 'encoded-job-admission' };
  rasters.prepareEncodedJob = async (job, refs, id, slot, checks) => {
    checks(); admitted.push(job); return reachedAdmission;
  };
  assert.strictEqual(await rasters.prepareEncodedComposition(body, 'writer_match', 'writer_match', check, prepared, undefined, frozen), reachedAdmission);
  assert.equal(admitted.length, 1, 'matching manifest coverage reaches downstream admission');
  assert.deepEqual(admitted[0].masks[0].identity, frozen.masks[0]);
  admitted.length = 0; reads.length = 0;

  const crossed = structuredClone(frozen);
  crossed.masks[0].coverage = structuredClone(other.coverage);
  assert.equal(crossed.masks[0].assetHash, hash(canonical(assets.asset(original.asset.id))));
  assert.deepEqual(crossed.masks[0].info, assets.asset(original.asset.id).raster);
  assert.deepEqual(crossed.masks[0].coverage, other.coverage);
  await assert.rejects(
    rasters.prepareEncodedComposition(body, 'writer_crossed', 'writer_crossed', check, prepared, undefined, crossed),
    error => error instanceof AssetRejection && error.code === 'STALE_REVISION' && error.reason === 'CANDIDATE_REVIEW_CHANGED',
  );
  assert.deepEqual(admitted, [], 'cross-linked coverage rejects before worker admission');
  assert.deepEqual([...new Set(reads)], [original.asset.raster.manifest.hash], 'only the current mask manifest was opened');
  assert.deepEqual(assets.asset(original.asset.id), original.asset, 'the current registered mask is unchanged');
});
