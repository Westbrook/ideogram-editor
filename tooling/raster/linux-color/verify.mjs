import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,openSync,closeSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {verifyLinuxCodecsSeal} from '../linux-codecs/verify.mjs';
const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const root=resolve(import.meta.dirname,'../../..'), artifact=resolve(process.argv[2]), order=process.argv[3];
assert(['bridge-first','vips-first'].includes(order));
const codec=verifyLinuxCodecsSeal(), require=createRequire(import.meta.url);
const libPath=require.resolve(`@img/sharp-libvips-linux-${process.arch}/binary`);
const {DynamicLibrary}=await import('node:ffi');
let native,lib; if(order==='bridge-first'){native=new DynamicLibrary(artifact);lib=new DynamicLibrary(libPath);}else{lib=new DynamicLibrary(libPath);native=new DynamicLibrary(artifact);}
const sharp=(await import('sharp')).default;
sharp.cache(false);sharp.concurrency(1);
const names=['vips_image_new_from_memory','vips_image_set_blob_copy','vips_icc_transform','vips_image_write_to_memory','g_object_unref','g_free','vips_error_clear','vips_cache_get_max','vips_concurrency_get','vips_version'];
const addresses=Buffer.alloc(names.length*8);names.forEach((name,i)=>addresses.writeBigUInt64LE(lib.getSymbol(name),i*8));
const fn=native.getFunctions({IELinuxColorABIVersion:{arguments:[],return:'uint32'},IELinuxColorConvertRGBA:{arguments:['pointer','uint64','pointer','uint32','pointer','uint32'],return:'int32'}});
assert.equal(fn.IELinuxColorABIVersion(),1);
const p3=readFileSync(join(root,'tooling/raster/p3.icc'));
const convert=rgba=>assert.equal(fn.IELinuxColorConvertRGBA(rgba,BigInt(rgba.length),p3,p3.length,addresses,names.length),0);
const oracleBytes=readFileSync(join(root,'tests/raster/fixtures/color-oracle.json')),oracle=JSON.parse(oracleBytes),alpha=[0,128,255,64],checks=[];
const literal=Buffer.from(oracle.sourceRGB.flatMap((_,i)=>i%3===0?[...oracle.sourceRGB.slice(i,i+3),alpha[i/3]]:[]));
const expectedLiteral=Buffer.from(oracle.expectedRGB.flatMap((_,i)=>i%3===0?[...oracle.expectedRGB.slice(i,i+3),alpha[i/3]]:[]));
for(const count of [1,4,16383,16384,16385,32769]){
  const input=Buffer.alloc(count*4),expected=Buffer.alloc(count*4);
  for(let i=0;i<count;i++){literal.copy(input,i*4,(i%4)*4,(i%4+1)*4);expectedLiteral.copy(expected,i*4,(i%4)*4,(i%4+1)*4);}
  convert(input);assert.deepEqual(input,expected);checks.push({name:'independent-color-oracle',count,pixelHash:hash(input),status:'passed'});
}
const directory=mkdtempSync(join(tmpdir(),'ie-linux-color-'));
let decoder;
try{
  const identity=JSON.parse(readFileSync(join(root,`vendor/raster/bounded-webp/1.6.0-ideogram.2-linux/linux-${process.arch}/identity.json`)));
  const decoderPath=join(root,identity.path),decoderBytes=readFileSync(decoderPath);
  assert.equal(decoderBytes.length,identity.bytes);assert.equal(hash(decoderBytes),identity.hash);
  decoder=new DynamicLibrary(decoderPath);
  const decode=decoder.getFunctions({IEWebPDecodeRGBA:{arguments:['int32','uint64','pointer','uint64','int32','int32','uint64','pointer','pointer','pointer'],return:'int32'}}).IEWebPDecodeRGBA;
  const width=200,height=100,pixels=Buffer.alloc(width*height*4);
  for(let i=0;i<width*height;i++)pixels.set([(i*17+Math.floor(i/53))%256,(i*29+7)%256,(i*43+31)%256,alpha[i%4]],i*4);
  for(const lossless of [false,true]){
    const encoded=await sharp(pixels,{raw:{width,height,channels:4}}).withIccProfile('p3').webp({lossless,quality:91}).toBuffer();
    assert.deepEqual((await sharp(encoded,{ignoreIcc:true}).metadata()).icc,p3);
    const expectedRaw=await sharp(encoded,{ignoreIcc:true}).toColourspace('srgb').ensureAlpha().raw({depth:'uchar'}).toBuffer();
    const expected=await sharp(encoded).withIccProfile('srgb',{attach:false}).toColourspace('srgb').ensureAlpha().raw({depth:'uchar'}).toBuffer();
    const file=join(directory,'input.webp');writeFileSync(file,encoded);const fd=openSync(file,'r');
    const actual=Buffer.alloc(width*height*4),peak=Buffer.alloc(8),remaining=Buffer.alloc(8),denied=Buffer.alloc(8);
    try{assert.equal(decode(fd,BigInt(encoded.length),actual,BigInt(actual.length),width,height,128n*1024n*1024n,peak,remaining,denied),0);}finally{closeSync(fd);}
    assert.deepEqual(actual,expectedRaw);assert.equal(remaining.readBigUInt64LE(),0n);assert.equal(denied.readBigUInt64LE(),0n);
    convert(actual);assert.deepEqual(actual,expected);
    checks.push({name:lossless?'P3-lossless-alpha':'P3-lossy-alpha',width,height,encodedHash:hash(encoded),rawHash:hash(expectedRaw),colorHash:hash(actual),nativePeak:Number(peak.readBigUInt64LE()),nativeRemaining:0,nativeDenied:0,status:'passed'});
  }
  sharp.cache({items:1});assert.equal(fn.IELinuxColorConvertRGBA(Buffer.from(literal),16n,p3,p3.length,addresses,names.length),4);sharp.cache(false);
  sharp.concurrency(2);assert.equal(fn.IELinuxColorConvertRGBA(Buffer.from(literal),16n,p3,p3.length,addresses,names.length),4);sharp.concurrency(1);
  const retry=Buffer.from(literal);convert(retry);assert.deepEqual(retry,expectedLiteral);checks.push({name:'unsafe-cache-and-concurrency-refusal-retry',status:'passed'});
  console.log(JSON.stringify({status:'passed',scope:'Functional pixel/lifetime checks; not a memory or performance measurement.',node:process.versions.node,platform:process.platform,arch:process.arch,order,codec,artifactHash:hash(readFileSync(artifact)),scriptHash:hash(readFileSync(import.meta.filename)),oracleHash:hash(oracleBytes),symbols:names,checks}));
}finally{decoder?.close();native.close();lib.close();rmSync(directory,{recursive:true,force:true});}
