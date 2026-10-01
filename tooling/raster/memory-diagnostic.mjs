// Exploratory native sink comparison. This bypasses product admission deliberately
// and is not a release/performance qualification or a production decode path.
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {open, mkdtemp, readFile, writeFile, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const [input, mode, output]=process.argv.slice(2);
if(!input||!['native-file','raw-buffer','incremental-webp'].includes(mode)||!output)throw Error('input mode output required');
sharp.cache(false);sharp.concurrency(1);
const directory=await mkdtemp(join(await realpath(tmpdir()),'raster-native-sink-'));
const before=process.memoryUsage(),start=performance.now(),samples=[];
const timer=setInterval(()=>samples.push({ms:performance.now()-start,rss:process.memoryUsage().rss}),5);
const facts={kind:'exploratory-native-sink-1',at:new Date().toISOString(),input,mode,directory,limits:'Single decoder process only; production admission intentionally absent. No P3, memory-envelope or timing qualification.',before,node:process.version,platform:process.platform,arch:process.arch,versions:sharp.versions};
try{
 const encoded=await readFile(input);facts.encoded={bytes:encoded.length,hash:'sha256:'+createHash('sha256').update(encoded).digest('hex')};
 const options={failOn:'warning',limitInputPixels:25000000,sequentialRead:true,ignoreIcc:true};
 facts.metadata=await sharp(input,options).metadata();
 const decoder=sharp(input,options).toColourspace('srgb').ensureAlpha();
 if(mode==='incremental-webp'){
  const {DynamicLibrary}=await import('node:ffi');
  const lib=new DynamicLibrary(new URL('../../node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.6.dylib',import.meta.url).pathname);
  const fn=lib.getFunctions({
   WebPGetDecoderVersion:{arguments:[],return:'int32'},
   WebPINewRGB:{arguments:['int32','pointer','uint64','int32'],return:'pointer'},
   WebPIAppend:{arguments:['pointer','pointer','uint64'],return:'int32'},
   WebPIDecGetRGB:{arguments:['pointer','pointer','pointer','pointer','pointer'],return:'pointer'},
   WebPIDelete:{arguments:['pointer'],return:'void'}
  });
  facts.decoderVersion=fn.WebPGetDecoderVersion();
  const rgba=Buffer.alloc(facts.metadata.width*facts.metadata.height*4),decoder=fn.WebPINewRGB(1,rgba,BigInt(rgba.length),facts.metadata.width*4);
  if(!decoder)throw Error('decoder unavailable');
  try{
   let status;for(let at=0;at<encoded.length;at+=65536){status=fn.WebPIAppend(decoder,encoded.subarray(at,at+65536),BigInt(Math.min(65536,encoded.length-at)));if(status!==0&&status!==5)throw Error('decoder status '+status);samples.push({ms:performance.now()-start,rss:process.memoryUsage().rss});}
   if(status!==0)throw Error('decoder incomplete '+status);
   const y=Buffer.alloc(4),width=Buffer.alloc(4),height=Buffer.alloc(4),stride=Buffer.alloc(4),ptr=fn.WebPIDecGetRGB(decoder,y,width,height,stride);
   facts.decoded={pointerPresent:ptr!==0n,lastY:y.readInt32LE(),width:width.readInt32LE(),height:height.readInt32LE(),stride:stride.readInt32LE()};
   facts.raw={bytes:rgba.length,hash:'sha256:'+createHash('sha256').update(rgba).digest('hex')};
  }finally{fn.WebPIDelete(decoder);lib.close();}
 }else if(mode==='raw-buffer'){
  const result=await decoder.raw({depth:'uchar'}).toBuffer({resolveWithObject:true});facts.info=result.info;facts.raw={bytes:result.data.length,hash:'sha256:'+createHash('sha256').update(result.data).digest('hex')};
 }else{
  const path=join(directory,'native.v');facts.info=await decoder.toFile(path);
  const fd=await open(path,'r');try{
   const header=Buffer.alloc(64);await fd.read(header,0,64,0);facts.headerHex=header.toString('hex');
   const pixelBytes=facts.metadata.width*facts.metadata.height*4,buffer=Buffer.alloc(1024*1024),hash=createHash('sha256');let at=0;
   while(at<pixelBytes){const wanted=Math.min(buffer.length,pixelBytes-at),r=await fd.read(buffer,0,wanted,64+at);if(r.bytesRead!==wanted)throw Error('short native pixel payload');hash.update(buffer.subarray(0,wanted));at+=wanted;}
   facts.raw={bytes:pixelBytes,hash:'sha256:'+hash.digest('hex')};facts.fileBytes=(await fd.stat()).size;
  }finally{await fd.close();}
 }
 const expected=createHash('sha256'),white=Buffer.alloc(1024*1024,255);let left=facts.metadata.width*facts.metadata.height*4;while(left){const n=Math.min(left,white.length);expected.update(white.subarray(0,n));left-=n;}
 facts.expectedRawHash='sha256:'+expected.digest('hex');facts.uniformWhiteExact=facts.expectedRawHash===facts.raw.hash;facts.status=facts.uniformWhiteExact?'pass':'fail';
}catch(error){facts.status='fail';facts.error=String(error);process.exitCode=1;}
finally{clearInterval(timer);facts.elapsedMs=performance.now()-start;facts.after=process.memoryUsage();facts.peakRSS=process.resourceUsage().maxRSS*1024;facts.samples=samples;facts.scriptHash='sha256:'+createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');await writeFile(output,JSON.stringify(facts,null,2)+'\n');console.log(JSON.stringify({input,mode,status:facts.status,uniformWhiteExact:facts.uniformWhiteExact,peakRSS:facts.peakRSS,elapsedMs:facts.elapsedMs,output}));}
