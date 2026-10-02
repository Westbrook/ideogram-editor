import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { rootFor } from '../store/helpers.mjs';
import { runRaster, hash } from '../../dist/local/server/raster/engine.js';
import { CURRENT_RASTER_PROFILE, RASTER_PROFILES } from '../../dist/local/server/raster/profile-registry.js';
import { assertExportRecomputation, UnsupportedRaster } from '../../dist/local/server/portable/raster-replay.js';

const foreign = RASTER_PROFILES.find(profile => !profile.legacy && profile.codecId !== CURRENT_RASTER_PROFILE.codecId);
const ref = (bytes, mediaType) => ({ hash: hash(bytes), byteLength: String(bytes.length), mediaType });
async function fixture(t) {
  const root = await rootFor(t), sourceDirectory = await mkdtemp(join(root, 'source-')), path = join(sourceDirectory, 'source.png');
  const bytes = await sharp({ create: { width: 7, height: 3, channels: 4, background: { r: 39, g: 82, b: 127, alpha: 0.6 } } }).png().toBuffer();
  await writeFile(path, bytes, { mode: 0o600 });
  const source = await runRaster({ type: 'decode', directory: sourceDirectory, path, mediaType: 'image/png', original: ref(bytes, 'image/png'), sourceAssetId: 'original' }, async () => {}, () => {});
  const directory = await mkdtemp(join(root, 'export-'));
  const computed = await runRaster({ type: 'export', directory, input: { id: 'source', info: source.info, path: join(sourceDirectory, 'pixels.rgba') }, dependencies: [source.info.manifest], options: { format: 'jpeg', resize: null, matte: '#ffffff', quality: 0.9 }, replay: { pipeline: foreign.pipeline, encoder: foreign.codecId } }, async () => {}, () => {});
  const encoded = await readFile(join(directory, 'output.jpeg'));
  return { root, directory, computed, encoded, retained: { manifest: computed.manifest, info: computed.info, blob: computed.png } };
}
async function changed(f, bytes) {
  const path = join(f.root, 'retained.jpeg'); await writeFile(path, bytes, { mode: 0o600 });
  const blob = ref(bytes, 'image/jpeg'), decoded = [];
  return { retained: { ...f.retained, blob }, decoded, decode: async which => {
    decoded.push(which); const reference = which === 'retained' ? blob : f.computed.png;
    const directory = await mkdtemp(join(f.root, 'decode-'));
    return (await runRaster({ type: 'decode', directory, path: which === 'retained' ? path : join(f.directory, 'output.jpeg'), mediaType: reference.mediaType, original: reference, sourceAssetId: 'portable-validation' }, async () => {}, () => {})).info;
  } };
}

test('exact known foreign export replay succeeds without relaxing any retained descriptor', async t => {
  const f = await fixture(t);
  await assertExportRecomputation(f.retained, f.computed, CURRENT_RASTER_PROFILE.codecId, () => assert.fail('equal encoded bytes need no second decode'));
  for (const edit of [value => { value.info.pixels.hash = 'sha256:' + '1'.repeat(64); }, value => { value.manifest.plan.pixelIdentity = 'sha256:' + '2'.repeat(64); }, value => { value.manifest.pipeline = 'cp1-f64-triangle-area-v1/sha256:' + '3'.repeat(64); }]) {
    const retained = structuredClone(f.retained); edit(retained);
    await assert.rejects(assertExportRecomputation(retained, f.computed, CURRENT_RASTER_PROFILE.codecId, () => assert.fail('descriptor mismatch must fail before decode')), error => !(error instanceof UnsupportedRaster));
  }
});

test('a valid foreign JPEG comment changes encoded bytes but permits inspection after exact decoded-content comparison', async t => {
  const f = await fixture(t), comment = Buffer.from('retained foreign encoder'), segment = Buffer.alloc(comment.length + 4);
  segment.writeUInt16BE(0xfffe, 0); segment.writeUInt16BE(comment.length + 2, 2); segment.set(comment, 4);
  const altered = await changed(f, Buffer.concat([f.encoded.subarray(0, 2), segment, f.encoded.subarray(2)]));
  await assert.rejects(assertExportRecomputation(altered.retained, f.computed, CURRENT_RASTER_PROFILE.codecId, altered.decode), error => error instanceof UnsupportedRaster && error.message === 'RASTER_ENCODER_REPLAY_UNAVAILABLE');
  assert.deepEqual(altered.decoded, ['retained', 'computed']);
  await assert.rejects(assertExportRecomputation(altered.retained, f.computed, foreign.codecId, () => assert.fail('same encoder byte mismatch is invalid')), error => !(error instanceof UnsupportedRaster));
});

test('foreign JPEG content substitution and malformed bytes remain invalid, never inspection-only', async t => {
  for (const malformed of [false, true]) {
    const f = await fixture(t);
    const bytes = malformed ? f.encoded.subarray(0, f.encoded.length - 2) : await sharp({ create: { width: 7, height: 3, channels: 3, background: { r: 220, g: 15, b: 30 } } }).jpeg({ quality: 90 }).toBuffer();
    const altered = await changed(f, bytes);
    await assert.rejects(assertExportRecomputation(altered.retained, f.computed, CURRENT_RASTER_PROFILE.codecId, altered.decode), error => !(error instanceof UnsupportedRaster));
    assert.equal(altered.decoded[0], 'retained');
  }
});

async function comparisonFixture(t){
 const f=await fixture(t),directory=await mkdtemp(join(f.root,'comparison-')),pixels=f.computed.info.pixels;
 const computed=await runRaster({type:'export',directory,input:{id:'original_composition',info:f.computed.info,path:join(f.directory,'pixels.rgba')},dependencies:f.computed.manifest.dependencies,options:{format:'png',resize:{width:7,height:3},matte:null,quality:null},replay:{pipeline:foreign.pipeline,encoder:foreign.codecId}},async()=>{},()=>{});
 computed.manifest.plan={kind:'candidate-lettering-comparison-v1',sourceWidth:7,sourceHeight:3,layers:[{assetId:'original_composition',transform:[1,0,0,1,0,0],opacity:1,mask:null}],comparison:'candidate-alone',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',preservation:'not-applied'};
 assert.deepEqual(computed.info.pixels,pixels);return {...f,directory,computed,retained:{manifest:computed.manifest,info:computed.info,blob:computed.png}};
}

test('comparison PNG replay requires exact descriptors and pixels and never accepts authority fields',async t=>{
 const f=await comparisonFixture(t);await assertExportRecomputation(f.retained,f.computed,CURRENT_RASTER_PROFILE.codecId,()=>assert.fail('exact bytes need no second decode'));
 for(const change of [v=>v.manifest.plan.layers[0].opacity=0.25,v=>v.manifest.plan.preservation='applied',v=>v.info.pixels.hash=hash('changed pixels'),v=>v.manifest.pipeline='cp1-f64-triangle-area-v1/'+hash('unknown'),v=>v.info.role='composite',v=>v.blob.mediaType='image/jpeg']){
  const retained=structuredClone(f.retained);change(retained);await assert.rejects(assertExportRecomputation(retained,f.computed,CURRENT_RASTER_PROFILE.codecId,()=>assert.fail('invalid descriptor must not fall back')),error=>!(error instanceof UnsupportedRaster));
 }
});

test('comparison foreign encoded variation is inspection-only only after independent equal-content decode',async t=>{
 const f=await comparisonFixture(t),retained={...f.retained,blob:{...f.retained.blob,hash:hash('different encoded observation')}},seen=[];
 await assert.rejects(assertExportRecomputation(retained,f.computed,CURRENT_RASTER_PROFILE.codecId,async which=>{seen.push(which);return f.computed.info;}),error=>error instanceof UnsupportedRaster);assert.deepEqual(seen,['retained','computed']);
 await assert.rejects(assertExportRecomputation(retained,f.computed,foreign.codecId,()=>assert.fail('same producer mismatch is invalid')),error=>!(error instanceof UnsupportedRaster));
 await assert.rejects(assertExportRecomputation(retained,f.computed,CURRENT_RASTER_PROFILE.codecId,async which=>which==='retained'?{...f.computed.info,pixels:{...f.computed.info.pixels,hash:hash('substituted content')}}:f.computed.info),error=>!(error instanceof UnsupportedRaster));
});
