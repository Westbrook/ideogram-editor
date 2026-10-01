import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { rootFor } from '../store/helpers.mjs';
import { runRaster, hash } from '../../dist/local/server/raster/engine.js';
import { exportOptions } from '../../dist/local/src/protocol/export.js';
import { rasterManifest } from '../../dist/local/src/protocol/validate.js';

const pngOptions=(resize=null)=>({format:'png',resize,matte:null,quality:null});
const jpegOptions=(matte='#000000',resize=null,quality=0.9)=>({format:'jpeg',resize,matte,quality});
const original=Buffer.from([17,99,231,0,255,255,255,255,17,99,231,0,255,255,255,255]);
async function seed(t,rgba=original,width=2,height=2){
 const root=await rootFor(t),directory=await mkdtemp(join(root,'source-')),path=join(directory,'original.png');
 const bytes=await sharp(rgba,{raw:{width,height,channels:4}}).png().toBuffer();await writeFile(path,bytes,{mode:0o600});
 const result=await runRaster({type:'decode',directory,path,mediaType:'image/png',sourceAssetId:'original',original:{hash:hash(bytes),byteLength:String(bytes.length),mediaType:'image/png'}},async()=>{},()=>{});
 return {root,directory,result,input:{id:'canonical',path:join(directory,'pixels.rgba'),info:result.info}};
}
async function exported(f,options,admit=async()=>{},check=()=>{}){
 const directory=await mkdtemp(join(f.root,'export-'));
 const result=await runRaster({type:'export',directory,input:f.input,dependencies:[f.result.info.manifest],...(options===undefined?{}:{options})},admit,check);
 return {directory,result,pixels:await readFile(join(directory,'pixels.rgba')),bytes:await readFile(join(directory,result.png.mediaType==='image/jpeg'?'output.jpeg':'output.png'))};
}
function luminanceQuantization(bytes){
 assert.deepEqual([...bytes.subarray(0,2)],[255,216]);
 for(let at=2;at+3<bytes.length;){assert.equal(bytes[at++],255);while(bytes[at]===255)at++;const marker=bytes[at++];if(marker===217||marker===218)break;if(marker===1||marker>=208&&marker<=215)continue;const length=bytes.readUInt16BE(at);assert.ok(length>=2&&at+length<=bytes.length);if(marker===219){for(let p=at+2;p<at+length;){const selector=bytes[p++],count=(selector>>4)?128:64;if((selector&15)===0){assert.equal(selector>>4,0);return [...bytes.subarray(p,p+64)];}p+=count;}}at+=length;}
 throw Error('No luminance quantization table');
}

test('explicit native PNG and legacy export preserve exact hidden RGB, pixel identity and encoded bytes',async t=>{
 const f=await seed(t),implicit=await exported(f),explicit=await exported(f,pngOptions()),sameSize=await exported(f,pngOptions({width:2,height:2}));
 for(const out of [implicit,explicit,sameSize]){assert.deepEqual(out.pixels,original);assert.equal(out.result.info.pixelIdentity,f.result.info.pixelIdentity);assert.equal(out.result.info.pipeline,f.result.info.pipeline);assert.equal(out.result.manifest.plan.kind,'frozen-png-export');assert.deepEqual(out.bytes,await readFile(join(f.directory,'output.png')));assert.deepEqual(await sharp(out.bytes).ensureAlpha().raw().toBuffer(),original);rasterManifest(out.result.manifest);}
 assert.deepEqual(await readFile(f.input.path),original);
});

test('resized PNG uses exact declared output bounds and preserves transparent coverage independently of display',async t=>{
 const f=await seed(t),out=await exported(f,pngOptions({width:1,height:1}));
 // Integrating each source-axis triangle over this 2:1 footprint gives 7/16
 // per sample. Two opaque samples therefore have coverage 2*(7/16)^2,
 // quantized to 98. Outside-source coverage stays zero; hidden RGB contributes none.
 assert.deepEqual(out.pixels,Buffer.from([255,255,255,98]));assert.deepEqual(await sharp(out.bytes).ensureAlpha().raw().toBuffer(),out.pixels);
 assert.deepEqual([out.result.info.width,out.result.info.height],[1,1]);assert.notEqual(out.result.info.pixelIdentity,f.result.info.pixelIdentity);
 assert.equal(out.result.manifest.plan.kind,'frozen-image-export-v1');assert.deepEqual(out.result.manifest.plan.options,pngOptions({width:1,height:1}));assert.deepEqual(out.result.manifest.dependencies,[f.result.info.manifest]);rasterManifest(out.result.manifest);
 assert.deepEqual(await readFile(f.input.path),original);
});

for(const [matte,expected] of [['#000000',[167,167,167,255]],['#0000ff',[167,167,255,255]],['#ffffff',[255,255,255,255]]])test('JPEG flattens reviewed resized coverage onto '+matte+' in linear sRGB before encoding',async t=>{
 const f=await seed(t),out=await exported(f,jpegOptions(matte,{width:1,height:1}));
 assert.deepEqual([...out.pixels],expected);assert.equal(out.result.png.mediaType,'image/jpeg');assert.equal(out.result.info.role,'export');
 const metadata=await sharp(out.bytes,{ignoreIcc:true}).metadata();assert.equal(metadata.format,'jpeg');assert.deepEqual([metadata.width,metadata.height],[1,1]);assert.equal(metadata.hasAlpha,false);assert.ok(metadata.icc?.length>0);
 const decoded=await sharp(out.bytes,{ignoreIcc:true}).ensureAlpha().raw().toBuffer();for(let channel=0;channel<3;channel++)assert.ok(Math.abs(decoded[channel]-expected[channel])<=2,JSON.stringify({matte,decoded:[...decoded],expected}));assert.equal(decoded[3],255);
 // ISO/libjpeg standard luminance table scaled to quality90. This inspects the
 // actual JPEG stream, rather than trusting its retained requested options.
 assert.deepEqual(luminanceQuantization(out.bytes).slice(0,16),[3,2,2,3,2,2,3,3,3,3,4,3,3,4,5,8]);
 assert.deepEqual(out.result.manifest.plan.options,jpegOptions(matte,{width:1,height:1}));rasterManifest(out.result.manifest);assert.deepEqual(await readFile(f.input.path),original);
});

test('JPEG full opacity and fully transparent hidden colors resolve to source and explicit matte respectively',async t=>{
 const source=Buffer.from([17,99,231,0,255,255,255,255,0,0,0,255,250,30,70,0]),f=await seed(t,source),out=await exported(f,jpegOptions('#008000'));
 assert.deepEqual([...out.pixels],[0,128,0,255,255,255,255,255,0,0,0,255,0,128,0,255]);assert.deepEqual(await readFile(f.input.path),source);
});

test('invalid encoder choices fail before admission or producing output and denied admission preserves source',async t=>{
 const f=await seed(t);for(const options of [jpegOptions(null),jpegOptions('#000000',null,0),jpegOptions('#000000',null,1.1),jpegOptions('#000000',null,NaN),jpegOptions('#0000'),{...pngOptions(),matte:'#ffffff'},pngOptions({width:0,height:1}),pngOptions({width:5000,height:5001}),{...pngOptions(),ignored:true}]){
  const directory=await mkdtemp(join(f.root,'invalid-'));let admitted=0;
  await assert.rejects(runRaster({type:'export',directory,input:f.input,dependencies:[f.result.info.manifest],options},async()=>{admitted++;},()=>{}));assert.equal(admitted,0);assert.equal((await readdir(directory)).some(name=>/^output\./.test(name)),false);
 }
 const directory=await mkdtemp(join(f.root,'denied-'));await assert.rejects(runRaster({type:'export',directory,input:f.input,dependencies:[],options:jpegOptions()},async plan=>{assert.ok(plan.cpuBytes>plan.rawBytes);throw Error('EXPORT_ADMISSION_DENIED');},()=>{}),/EXPORT_ADMISSION_DENIED/);assert.deepEqual(await readdir(directory),[]);assert.deepEqual(await readFile(f.input.path),original);
 for(const scope of [{kind:'selected-layers',layerIds:[],includeHidden:false},{kind:'selected-layers',layerIds:['one','one'],includeHidden:true},{kind:'selected-layers',layerIds:['one'],includeHidden:'yes'},{kind:'visible-document',includeHidden:true}])assert.throws(()=>exportOptions({...pngOptions(),scope},true));
});

test('native JPEG matte combines exact alpha128 coverage in linear light without resizing',async t=>{
  const pixels=Buffer.from([255,255,255,128,255,255,255,128,255,255,255,128,255,255,255,128]),f=await seed(t,pixels),out=await exported(f,jpegOptions('#000000'));
  assert.deepEqual([...out.pixels],Array(4).fill([188,188,188,255]).flat());assert.deepEqual(await readFile(f.input.path),pixels);
 });
