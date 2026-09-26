import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {runRaster,hash,verifyCodecs} from '../../dist/local/server/raster/engine.js';
import {rootFor} from '../store/helpers.mjs';
const base=new URL('./fixtures/',import.meta.url);
const fixture=JSON.parse(await readFile(new URL('manifest.json',base)));
const mime=n=>n.endsWith('.jpg')?'image/jpeg':n.endsWith('.webp')?'image/webp':'image/png';
async function decode(t,name){const root=await rootFor(t),directory=await mkdtemp(join(root,'job-')),path=new URL(name,base).pathname;await chmod(path,0o600);const bytes=await readFile(path);return {root,directory,result:await runRaster({type:'decode',directory,path,mediaType:mime(name),sourceAssetId:'fixture',original:{hash:hash(bytes),byteLength:String(bytes.length),mediaType:mime(name)}},async()=>{},()=>{})};}
test('actual frozen PNG/JPEG/static WebP codec inputs; independently specified uniform and literal pixels',async t=>{
 verifyCodecs();for(const name of ['hidden-alpha.png','white.jpg','white-lossy.webp','alpha-lossless.webp','alpha-lossy.webp','srgb.png']){
  const {directory,result}=await decode(t,name);const rgba=await readFile(join(directory,'pixels.rgba')),expected=fixture.fixtures.find(f=>f.name===name).expected;
  if(expected?.rgba)assert.deepEqual([...rgba],expected.rgba);if(expected?.uniform)for(let i=0;i<rgba.length;i+=4)assert.deepEqual([...rgba.subarray(i,i+4)],expected.uniform);
  const roundtrip=await sharp(join(directory,'output.png'),{ignoreIcc:true}).ensureAlpha().raw().toBuffer();assert.deepEqual(roundtrip,rgba);assert.equal(result.info.conversion.resized,false);
 }
});
test('all eight EXIF orientations normalize once with exact alpha/hidden samples retained',async t=>{
 const input=fixture.fixtures.find(f=>f.name==='hidden-alpha.png').expected.rgba;
 // Expected order is manually enumerated for source matrix A B C / D E F.
 const orders={2:[2,1,0,5,4,3],3:[5,4,3,2,1,0],4:[3,4,5,0,1,2],5:[0,3,1,4,2,5],6:[3,0,4,1,5,2],7:[5,2,4,1,3,0],8:[2,5,1,4,0,3]};
 for(const [o,order]of Object.entries(orders)){const {directory,result}=await decode(t,'orientation-'+o+'.png');assert.deepEqual([...(await readFile(join(directory,'pixels.rgba')))],order.flatMap(i=>input.slice(i*4,i*4+4)));assert.equal(result.info.conversion.orientation,+o);assert.equal(result.info.width,+o>=5?2:3);}
});
test('supported P3 converts with review data and original profile identity retained',async t=>{
 const {directory,result}=await decode(t,'p3.png');assert.equal(result.info.conversion.colorChanged,true);assert.equal(result.info.conversion.profile,'p3');assert.ok(result.files.some(f=>f.name==='profile.icc'));assert.equal(result.info.conversion.resized,false);
 // P3 unit primaries clip to the same sRGB primaries; hidden color conversion is
 // separately retained in the original encoded input, never reconstructed.
 const rgba=await readFile(join(directory,'pixels.rgba'));assert.deepEqual([...rgba.subarray(4,8)],[255,0,0,128]);assert.deepEqual([...rgba.subarray(8,12)],[0,255,0,255]);
});
test('actual malformed/animated/profile/extent inputs cannot produce usable canonical output',async t=>{
 for(const name of ['bad-crc.png','truncated.png','truncated.jpg','truncated.webp','animated.webp','animated.png','metadata-bomb.png','animated-marker.png','unknown-profile.png','oversize.png'])await assert.rejects(()=>decode(t,name),/RASTER_/);
});

test('P3 nonprimary conversion matches independent public LittleCMS C oracle, retaining alpha',async t=>{
 const oracle=JSON.parse(await readFile(new URL('color-oracle.json',base)));const {directory}=await decode(t,'p3-color.png');const expected=oracle.expectedRGB.flatMap((_,i)=>i%3===0?[...oracle.expectedRGB.slice(i,i+3),[0,128,255,64][i/3]]:[]);assert.deepEqual([...(await readFile(join(directory,'pixels.rgba')))],expected);
});

test('lossy and lossless alpha WebP match independent public decoder diagnostic including exact alpha',async t=>{
 const oracle=JSON.parse(await readFile(new URL('webp-oracle.json',base)));for(const item of oracle.fixtures){const {directory}=await decode(t,item.name);assert.deepEqual([...(await readFile(join(directory,'pixels.rgba')))],item.expectedRGBA);}
});

test('WebP extent and native allocation plan are admitted before invoking its native metadata parser',async t=>{
 for(const name of ['max-webp-lossy.webp','max-webp-lossless.webp']){
  const root=await rootFor(t),directory=await mkdtemp(join(root,'job-')),path=new URL(name,base).pathname;await chmod(path,0o600);const bytes=await readFile(path);let plan;
  const before=process.memoryUsage().rss;
  await assert.rejects(runRaster({type:'decode',directory,path,mediaType:'image/webp',sourceAssetId:'fixture',original:{hash:hash(bytes),byteLength:String(bytes.length),mediaType:'image/webp'}},async p=>{plan=p;throw Error('DENIED_BEFORE_NATIVE');},()=>{}),/DENIED_BEFORE_NATIVE/);
  assert.equal(plan.width,5000);assert.equal(plan.height,5000);assert.ok(plan.cpuBytes>512*1024*1024);assert.ok(process.memoryUsage().rss-before<128*1024*1024);
 }
});

test('actual nonwhite JPEG pixels match independently installed Pillow/libjpeg-turbo golden diagnostic',async t=>{
 const oracle=JSON.parse(await readFile(new URL('jpeg-oracle.json',base)));const {directory}=await decode(t,oracle.file);assert.deepEqual([...(await readFile(join(directory,'pixels.rgba')))],oracle.expectedRGBA);
});


test('frozen export preserves historical pixel identity and records current encoder separately',async t=>{
 const {root,directory,result}=await decode(t,'hidden-alpha.png');const pipeline='cp1-f64-triangle-area-v1/sha256:'+ '1'.repeat(64);
 const pixelIdentity=hash(canonical({pipeline,width:result.info.width,height:result.info.height,tiles:result.manifest.tiles}));
 const output=await mkdtemp(join(root,'historical-export-'));const exported=await runRaster({type:'export',directory:output,input:{id:'historical',path:join(directory,'pixels.rgba'),info:{...result.info,pipeline,pixelIdentity}},dependencies:[result.info.manifest]},async()=>{},()=>{});
 assert.equal(exported.info.pipeline,pipeline);assert.equal(exported.info.pixelIdentity,pixelIdentity);assert.notEqual(exported.manifest.plan.encoder,pipeline.split('/')[1]);assert.deepEqual(await readFile(join(output,'pixels.rgba')),await readFile(join(directory,'pixels.rgba')));
});
