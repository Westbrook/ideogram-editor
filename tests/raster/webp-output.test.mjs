import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,symlink} from 'node:fs/promises';
import {openSync,closeSync,writeSync,fstatSync,futimesSync} from 'node:fs';
import {join} from 'node:path';
import sharp from 'sharp';
import {rootFor} from '../store/helpers.mjs';
import {openWebPFileDecoder,verifyWebPOutput,outputMetrics} from '../../dist/local/server/raster/webp-output.js';
import {inspectContainer} from '../../dist/local/server/raster/container.js';
import {openWebPColorConverter} from '../../dist/local/server/raster/webp-color.js';
sharp.cache(false);sharp.concurrency(1);
async function fixture(t,name){const root=await rootFor(t),bytes=await readFile(new URL('./fixtures/'+name,import.meta.url)),path=join(root,'input');await writeFile(path,bytes,{mode:0o600});return{root,path,bytes,info:await inspectContainer(path,'image/webp')};}
test('file decode releases mapped output and matches sealed pixels after budget refusal and cancellation',async t=>{
 verifyWebPOutput();const decoder=await openWebPFileDecoder();assert.ok(decoder);
 try{for(const name of ['white-lossy.webp','alpha-lossy.webp','alpha-lossless.webp']){const f=await fixture(t,name);
  for(const failure of ['budget','cancel','cancel-after']){let checks=0;const fd=openSync(join(f.root,failure),'wx+',0o600);try{assert.throws(()=>decoder.decode(f.path,fd,f.info.width,f.info.height,f.bytes.length,()=>{checks++;if(failure==='cancel'||failure==='cancel-after'&&checks===2)throw Error('CANCEL');},failure==='budget'?1:undefined,f.info.webpMetadata.stamp),failure==='budget'?/RASTER_RESOURCES/:/CANCEL/);}finally{closeSync(fd);}}
  const path=join(f.root,'output'),fd=openSync(path,'wx+',0o600);let result;try{result=decoder.decode(f.path,fd,f.info.width,f.info.height,f.bytes.length,()=>{},undefined,f.info.webpMetadata.stamp);}finally{closeSync(fd);}
  assert.equal(result.metrics.outputRemaining,0);assert.equal(result.metrics.nativeRemaining,0);assert.equal(result.metrics.nativeDenied,0);assert.ok(result.metrics.outputPeak>=f.info.width*f.info.height*4);assert.deepEqual(await readFile(path),await sharp(f.bytes,{ignoreIcc:true}).ensureAlpha().raw().toBuffer());
 }}finally{decoder.close();}decoder.close();
});
test('file decoder refuses symlink sources, stale identity, occupied output and postdecode timestamp change',async t=>{
 const f=await fixture(t,'white-lossy.webp'),decoder=await openWebPFileDecoder();assert.ok(decoder);const link=join(f.root,'link');await symlink(f.path,link);
 try{for(const kind of ['symlink','stale','occupied','mutation']){const path=join(f.root,kind),fd=openSync(path,'wx+',0o600);let checks=0;try{if(kind==='occupied')writeSync(fd,Buffer.alloc(4));assert.throws(()=>decoder.decode(kind==='symlink'?link:f.path,fd,f.info.width,f.info.height,f.bytes.length,()=>{if(kind==='mutation'&&++checks===2){const prior=fstatSync(fd);writeSync(fd,Buffer.from([12]),0,1,0);futimesSync(fd,prior.atime,new Date(prior.mtimeMs+2000));}},undefined,kind==='stale'?{...f.info.webpMetadata.stamp,ino:0n}:f.info.webpMetadata.stamp),kind==='symlink'?/ELOOP/:/RASTER_INPUT_CHANGED/);}finally{closeSync(fd);}}}finally{decoder.close();}
});
test('file mapped P3 conversion matches existing exact converter across strip boundaries and releases output',async t=>{
 const converter=await openWebPColorConverter();assert.ok(converter);const root=await rootFor(t),width=257,height=129,bytes=Buffer.alloc(width*height*4);for(let i=0;i<bytes.length;i++)bytes[i]=(i*19)%256;
 const profile=await readFile(new URL('../../tooling/raster/p3.icc',import.meta.url)),expected=Buffer.from(bytes);await converter.convertInPlace(expected,profile,()=>{});const path=join(root,'pixels');await writeFile(path,bytes,{mode:0o600});const fd=openSync(path,'r+');try{const metrics=await converter.convertFileInPlace(fd,bytes.length,profile,()=>{});assert.equal(metrics.outputRemaining,0);assert.ok(metrics.outputPeak>=bytes.length);}finally{closeSync(fd);converter.close();}assert.deepEqual(await readFile(path),expected);
});

test('failed output release reports its retained allocation rather than a successful cleanup',()=>{
 const peak=Buffer.alloc(8),remaining=Buffer.alloc(8);peak.writeBigUInt64LE(16384n);remaining.writeBigUInt64LE(16384n);
 assert.throws(()=>outputMetrics(peak,remaining,4),error=>error.message==='RASTER_RESOURCES'&&error.rasterResourceFailure.outputPeak===16384&&error.rasterResourceFailure.outputRemaining===16384);
 remaining.writeBigUInt64LE(0n);assert.deepEqual(outputMetrics(peak,remaining,4),{outputPeak:16384,outputRemaining:0});
});
