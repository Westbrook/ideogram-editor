import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootFor, command, encode, expectedBytes, refFor } from '../store/helpers.mjs';
import { runRaster, hash } from '../../dist/local/server/raster/engine.js';
import { CURRENT_RASTER_PROFILE, RASTER_PROFILES, resolveRasterProfile } from '../../dist/local/server/raster/profile-registry.js';
import { canonical } from '../../dist/local/src/protocol/json.js';
import { rasterManifest, contributionStack } from '../../dist/local/src/protocol/validate.js';
import { parseCommand } from '../../dist/local/server/storage/canonical.js';

// These tests exercise retained metadata replay on the current host. They do
// not establish native encoder or decoder byte parity between architectures.
const local = CURRENT_RASTER_PROFILE;
const foreign = RASTER_PROFILES.find(profile => !profile.legacy && profile.codecId !== local.codecId);
assert.ok(foreign, 'a known profile from another codec platform');
const unknown = 'cp1-f64-triangle-area-v1/sha256:' + 'f'.repeat(64);
const identity = [1, 0, 0, 1, 0, 0];
const ref = (bytes, mediaType) => ({ hash: hash(bytes), byteLength: String(bytes.length), mediaType });
const metadataRef = value => ref(Buffer.from(canonical(value)), 'application/json');
const pixelIdentity = (pipeline, width, height, tiles) => hash(canonical({ pipeline, width, height, tiles }));
const layer = (input, opacity = 1) => ({ assetId: input.id, transform: identity, opacity, mask: null });

async function input(root, id, width, height, values) {
  const directory = await mkdtemp(join(root, id + '-')), path = join(directory, 'pixels.rgba'), bytes = Buffer.from(values);
  assert.equal(bytes.length, width * height * 4);
  await writeFile(path, bytes, { mode: 0o600 });
  const pixels = ref(bytes, 'application/x-ideogram-rgba8');
  return { id, path, info: { schemaVersion: 1, pipeline: local.pipeline, width, height, pixels,
    manifest: metadataRef({ id, width, height, pixels }), pixelIdentity: hash(bytes), role: 'composite', sourceAssetIds: [], conversion: null } };
}

async function composition(root, width, height, layers, inputs, { capture = true, replay } = {}) {
  const directory = await mkdtemp(join(root, 'compose-'));
  const state = metadataRef({ captured: 'state' });
  const requestSource = { schemaVersion: 1, documentId: 'document_capture', documentRevision: '7',
    image: { state, semanticDigest: 'sha256:' + 'b'.repeat(64), compositeAssetId: null },
    scope: layers.length === 1 ? 'single-layer' : 'selected-layers', layerIds: layers.map((_, index) => 'layer_' + index) };
  const result = await runRaster({ type: 'compose', directory, width, height, layers, inputs,
    dependencies: [...inputs.map(value => value.info.manifest), ...(capture ? [state] : [])],
    ...(capture ? { requestSource } : {}), ...(replay ? { replay } : {}) }, async () => {}, () => {});
  rasterManifest(result.manifest);
  const paths = new Map(result.files.map(file => [file.ref.hash, join(directory, file.name)]));
  for (const value of inputs) paths.set(value.info.pixels.hash, value.path);
  const read = async value => {
    assert.ok(paths.has(value.hash), 'retained file for ' + value.hash);
    const bytes = await readFile(paths.get(value.hash));
    assert.deepEqual(ref(bytes, value.mediaType), value);
    return bytes;
  };
  const stack = capture ? JSON.parse((await read(result.manifest.plan.contributions)).toString()) : null;
  const children = [];
  if (stack) {
    contributionStack(stack);
    for (const entry of stack.contributions) {
      const manifest = JSON.parse((await read(entry.manifest)).toString());
      rasterManifest(manifest);
      assert.equal(entry.pixelIdentity, pixelIdentity(manifest.pipeline, width, height, manifest.tiles));
      assert.deepEqual(entry.pixels, manifest.pixels);
      children.push({ entry, manifest, bytes: await read(entry.pixels) });
    }
  }
  return { directory, result, stack, children, bytes: await read(result.info.pixels),
    input: { id: 'composite_source', path: join(directory, 'pixels.rgba'), info: result.info } };
}

async function exported(root, source, options, replay) {
  const directory = await mkdtemp(join(root, 'export-'));
  const result = await runRaster({ type: 'export', directory, input: source, dependencies: [source.info.manifest], options,
    ...(replay ? { replay } : {}) }, async () => {}, () => {});
  rasterManifest(result.manifest);
  return { directory, result, bytes: await readFile(join(directory, 'pixels.rgba')) };
}

test('foreign capture replay rebinds the complete retained contribution graph without changing CP1 pixels', async t => {
  const root = await rootFor(t), width = 513, height = 1;
  const black = await input(root, 'black', width, height, Array(width).fill([0, 0, 0, 255]).flat());
  const white = await input(root, 'white', width, height, Array(width).fill([255, 255, 255, 255]).flat());
  const layers = [layer(black), layer(white, 0.1)], inputs = [black, white];
  const ordinary = await composition(root, width, height, layers, inputs, { capture: false });
  const captured = await composition(root, width, height, layers, inputs);
  const replayed = await composition(root, width, height, layers, inputs, { replay: { pipeline: foreign.pipeline } });
  const repeated = await composition(root, width, height, layers, inputs, { replay: { pipeline: foreign.pipeline } });
  const expectedPixels = Buffer.from(Array(width).fill([90, 90, 90, 255]).flat());
  for (const output of [ordinary, captured, replayed, repeated]) assert.deepEqual(output.bytes, expectedPixels);
  assert.equal(replayed.result.manifest.tiles.length, 2, 'retained identities include both tile views');
  assert.notEqual(replayed.result.info.pixelIdentity, captured.result.info.pixelIdentity);
  assert.deepEqual(replayed.result.png, captured.result.png, 'the same host encodes unchanged canonical pixels');

  const expectedEntries = captured.children.map((child, index) => {
    const manifest = { ...child.manifest, pipeline: foreign.pipeline };
    assert.deepEqual(replayed.children[index].manifest, manifest);
    assert.deepEqual(replayed.children[index].bytes, child.bytes);
    assert.deepEqual(replayed.children[index].manifest.dependencies, child.manifest.dependencies);
    return { ...child.entry, manifest: metadataRef(manifest),
      pixelIdentity: pixelIdentity(foreign.pipeline, width, height, manifest.tiles) };
  });
  const expectedStack = { ...captured.stack, pipeline: foreign.pipeline, contributions: expectedEntries };
  const expectedStackRef = metadataRef(expectedStack);
  assert.deepEqual(replayed.stack, expectedStack);
  assert.deepEqual(replayed.result.manifest.plan.contributions, expectedStackRef);
  const expectedManifest = { ...captured.result.manifest, pipeline: foreign.pipeline,
    dependencies: [expectedStackRef, captured.result.manifest.plan.capture.image.state],
    plan: { ...captured.result.manifest.plan, contributions: expectedStackRef } };
  assert.deepEqual(replayed.result.manifest, expectedManifest);
  assert.deepEqual(replayed.result.info.manifest, metadataRef(expectedManifest));
  assert.equal(replayed.result.info.pipeline, foreign.pipeline);
  assert.equal(replayed.result.info.pixelIdentity, pixelIdentity(foreign.pipeline, width, height, expectedManifest.tiles));
  assert.deepEqual(repeated.result.info, replayed.result.info);
  assert.deepEqual(repeated.result.manifest, replayed.result.manifest);
  assert.deepEqual(repeated.stack, replayed.stack);
  assert.deepEqual(repeated.children.map(child => child.entry), replayed.children.map(child => child.entry));
});

test('processed JPEG replay retains the foreign encoder identity and canonical source pixels', async t => {
  const root = await rootFor(t);
  const source = await input(root, 'rgba', 2, 2, [17, 99, 231, 0, 255, 255, 255, 255, 17, 99, 231, 0, 255, 255, 255, 255]);
  const composed = await composition(root, 2, 2, [layer(source)], [source], { capture: false });
  const options = { format: 'jpeg', resize: { width: 1, height: 1 }, matte: '#000000', quality: 0.9 };
  const ordinary = await exported(root, composed.input, options);
  const replayed = await exported(root, composed.input, options, { pipeline: foreign.pipeline, encoder: foreign.codecId });
  assert.deepEqual([...replayed.bytes], [167, 167, 167, 255]);
  assert.deepEqual(replayed.bytes, ordinary.bytes);
  assert.deepEqual(replayed.result.info.pixels, ordinary.result.info.pixels);
  assert.deepEqual(replayed.result.png, ordinary.result.png, 'both replays used the current native encoder');
  assert.equal(replayed.result.png.mediaType, 'image/jpeg');
  const expectedManifest = { ...ordinary.result.manifest, pipeline: foreign.pipeline,
    plan: { ...ordinary.result.manifest.plan, encoder: foreign.codecId } };
  assert.deepEqual(replayed.result.manifest, expectedManifest);
  assert.deepEqual(replayed.result.info.manifest, metadataRef(expectedManifest));
  assert.equal(replayed.result.info.pipeline, foreign.pipeline);
  assert.equal(replayed.result.info.pixelIdentity, pixelIdentity(foreign.pipeline, 1, 1, expectedManifest.tiles));
  assert.equal(resolveRasterProfile(foreign.pipeline, expectedManifest.plan), foreign);
  assert.equal(expectedManifest.plan.encoderTransport, 'jpeg-file-baseline-v1');
  assert.deepEqual(await readFile(composed.input.path), composed.bytes);
});

test('unchanged PNG replay keeps foreign source identity with a different known exporting codec', async t => {
  const root = await rootFor(t), source = await input(root, 'hidden', 2, 1, [17, 99, 231, 0, 20, 40, 60, 128]);
  const composed = await composition(root, 2, 1, [layer(source)], [source], { capture: false, replay: { pipeline: foreign.pipeline } });
  const options = { format: 'png', resize: null, matte: null, quality: null };
  const ordinary = await exported(root, composed.input, options);
  const replayed = await exported(root, composed.input, options, { pipeline: foreign.pipeline, encoder: local.codecId });
  assert.deepEqual(replayed.bytes, Buffer.from([17, 99, 231, 0, 20, 40, 60, 128]));
  assert.equal(replayed.result.info.pipeline, foreign.pipeline);
  assert.equal(replayed.result.info.pixelIdentity, composed.result.info.pixelIdentity);
  assert.equal(replayed.result.manifest.plan.kind, 'frozen-png-export');
  assert.equal(replayed.result.manifest.plan.encoder, local.codecId);
  assert.equal(resolveRasterProfile(foreign.pipeline, replayed.result.manifest.plan), foreign);
  assert.deepEqual(replayed.result.info, ordinary.result.info);
  assert.deepEqual(replayed.result.manifest, ordinary.result.manifest);
  assert.deepEqual(replayed.result.png, composed.result.png);
});

test('unknown replay profiles and invalid export encoder bindings fail before admission or output', async t => {
  const root = await rootFor(t), source = await input(root, 'original', 1, 1, [10, 20, 30, 255]);
  const options = { format: 'jpeg', resize: null, matte: '#000000', quality: 0.9 };
  const compose = { type: 'compose', width: 1, height: 1, layers: [layer(source)], inputs: [source], dependencies: [source.info.manifest] };
  const exporting = { type: 'export', input: source, dependencies: [source.info.manifest], options };
  for (const job of [
    { ...compose, replay: { pipeline: unknown } },
    { ...exporting, replay: { pipeline: unknown, encoder: local.codecId } },
    { ...exporting, replay: { pipeline: foreign.pipeline, encoder: local.codecId } },
    { ...exporting, replay: { pipeline: foreign.pipeline, encoder: 'sha256:' + 'e'.repeat(64) } },
  ]) {
    const directory = await mkdtemp(join(root, 'refused-')); let admissions = 0;
    await assert.rejects(runRaster({ ...job, directory }, async () => { admissions++; }, () => {}));
    assert.equal(admissions, 0);
    assert.deepEqual(await readdir(directory), []);
  }
  assert.deepEqual(await readFile(source.path), Buffer.from([10, 20, 30, 255]));
});

test('retained replay identity cannot be supplied by public raster commands', () => {
  const replay = { pipeline: foreign.pipeline, encoder: foreign.codecId };
  for (const body of [
    { type: 'ComposeRaster', width: 1, height: 1, layers: [] },
    { type: 'ExportRaster', assetId: 'canonical_source' },
  ]) {
    const request = command(refFor(expectedBytes), { documentId: null, body });
    assert.doesNotThrow(() => parseCommand(encode(request)));
    assert.throws(() => parseCommand(encode({ ...request, command: { ...request.command, body: { ...body, replay } } })),
      error => error.code === 'MALFORMED_REQUEST');
    assert.throws(() => parseCommand(encode({ ...request, command: { ...request.command, replay } })),
      error => error.code === 'MALFORMED_REQUEST');
  }
});
