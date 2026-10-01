// PERF-8+A3 immutable input preparation. Importing this module performs no IO.
// Heavy preparation is separate from, and never credited as, a measured sample.
import { createCipheriv, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createDeflate } from 'node:zlib';

export const FIXTURE_VERSION = 'perf-8-a3-corpus-2';
export const MiB = 1048576;
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SHA = /^sha256:[a-f0-9]{64}$/;
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
async function writeAll(file,bytes){let offset=0;while(offset<bytes.length){const result=await file.write(bytes,offset,bytes.length-offset,null);if(result.bytesWritten===0)throw Error('Fixture file write made no progress');offset+=result.bytesWritten;}}
const checkAbort = signal => { if (signal?.aborted) throw signal.reason ?? Error('Fixture preparation aborted'); };
const base = (width,height,imageLayers,textLayers,visibleImages,visibleText,events,tail,candidates,queued=0) => ({width,height,imageLayers,textLayers,layers:imageLayers+textLayers,visibleImages,visibleText,visibleLayers:visibleImages+visibleText,events,snapshotTail:tail,activeRequests:candidates?1:0,candidates,queued,training:0});
const deepFreeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;};
export const WORKLOADS = deepFreeze({
  W0: {...base(2048,2048,0,0,0,0,0,0,0), minimumFreeBytes:256*MiB},
  W1: {...base(2048,2048,20,0,5,0,10000,500,1,100), encodedLimit:8*MiB, maskEncodedLimit:4*MiB, minimumFreeBytes:4*1024*MiB},
  W2: {...base(5000,5000,100,0,10,0,100000,500,4), encodedLimit:32*MiB, maskEncodedLimit:8*MiB, minimumFreeBytes:32*1024*MiB},
  WQ: {...base(2048,2048,20,0,5,0,10000,500,0,1000), incompleteJobs:100, encodedLimit:8*MiB, maskEncodedLimit:4*MiB, minimumFreeBytes:4*1024*MiB},
  WXn: {...base(2048,2048,10,10,2,3,10000,500,1), textBytes:32768, frameTextLimit:8192, logicalLines:64, fontFaces:4, fontBytesLimit:16*MiB, encodedLimit:8*MiB, maskEncodedLimit:4*MiB, minimumFreeBytes:4*1024*MiB},
  WXs: {...base(5000,5000,25,75,5,5,100000,500,4), textBytes:MiB, frameTextLimit:16384, logicalLines:256, fontFaces:16, fontBytesLimit:64*MiB, encodedLimit:32*MiB, maskEncodedLimit:8*MiB, minimumFreeBytes:16*1024*MiB},
  WF: {inputSizes:[512,1024,2048],formats:['png','jpeg'],batches:[1,4],fastInputFiles:24,fastFamilies:6,training:0,minimumFreeBytes:256*MiB},
  WJ: {semanticElements:256, authoredBytesLimit:262144, fieldBytesLimit:16384, depth:16, tokens:50000, opaqueBytes:16*MiB, derivedBytes:512*1024, issuesBytes:64*1024, training:0, minimumFreeBytes:128*MiB},
  WA: {...base(2048,2048,20,0,5,0,10000,500,1,100), metadataEntries:100, weightsBytes:256*MiB, stressWeightsBytes:1024*MiB, configBytesLimit:MiB, selectedAdapters:3, encodedLimit:8*MiB, maskEncodedLimit:4*MiB, minimumFreeBytes:6*1024*MiB},
  WC512: {closureBytes:512*MiB,events:10000,assets:1000,captionVersions:null,manifestBytesLimit:128*MiB,training:0,minimumFreeBytes:4*1024*MiB},
  WC4G: {closureBytes:4*1024*MiB,events:100000,assets:10000,captionVersions:4096,manifestBytesLimit:128*MiB,training:0,minimumFreeBytes:24*1024*MiB},
  WNarrow: {...base(8192,3000,1,0,1,0,0,0,0),events:null,snapshotTail:null,encodedLimit:32*MiB,maskEncodedLimit:8*MiB,minimumFreeBytes:1024*MiB, qualification:'Separate 8192×3000 raster specimen; not W2 layer/history workload.'},
});
export function workloadDefinition(name, options={}) {
  if (name==='WC') name = options.closureBytes === 4*1024*MiB || options.closureBytes === String(4*1024*MiB) ? 'WC4G' : options.closureBytes===512*MiB || options.closureBytes===String(512*MiB) ? 'WC512' : (()=>{throw Error('WC requires exact 512MiB or 4GiB closureBytes');})();
  if (!Object.hasOwn(WORKLOADS,name)) throw Error('Unknown fixture workload: '+name);
  return {id:name,...WORKLOADS[name]};
}
export async function fileIdentity(path) {
  const info=await lstat(path); if(!info.isFile()||info.isSymbolicLink()) throw Error('Fixture must be an ordinary file: '+path);
  const digest=createHash('sha256');let bytes=0;for await(const part of createReadStream(path,{highWaterMark:MiB})){digest.update(part);bytes+=part.length;}
  if(bytes!==info.size)throw Error('Fixture changed while hashing: '+path);
  const end=await lstat(path);if(end.size!==info.size||end.mtimeMs!==info.mtimeMs||end.ctimeMs!==info.ctimeMs||end.dev!==info.dev||end.ino!==info.ino)throw Error('Fixture changed while hashing: '+path);
  return {sha256:'sha256:'+digest.digest('hex'),byteLength:String(bytes)};
}
const CRC_TABLE=Uint32Array.from({length:256},(_,n)=>{for(let bit=0;bit<8;bit++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const b of bytes)crc=CRC_TABLE[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function pngChunk(type,bytes){const tag=Buffer.from(type),out=Buffer.alloc(12+bytes.length);out.writeUInt32BE(bytes.length);tag.copy(out,4);bytes.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,8+bytes.length)),8+bytes.length);return out;}
export function rasterRow(width,y,index,{alpha=false,mask=false}={}) {
  if(!Number.isInteger(width)||width<1||width>8192||!Number.isInteger(y)||y<0||!Number.isInteger(index)||index<0)throw Error('Invalid deterministic raster row');
  const bytes=Buffer.alloc(1+width*(mask?1:4)); // zero PNG filter byte
  for(let x=0;x<width;x++) {
    if(mask)bytes[1+x]=((Math.floor(x/64)+Math.floor(y/64))%4)*85;
    else {const at=1+x*4;bytes[at]=(Math.floor(x/32)*7+index*17)%256;bytes[at+1]=(Math.floor(y/32)*11+index*23)%256;bytes[at+2]=(Math.floor((x+y)/64)*13+index*31)%256;bytes[at+3]=alpha?64+((Math.floor(x/64)+Math.floor(y/64)+index)%4)*63:255;}
  }return bytes;
}
export async function writeRasterPNG(path,{width,height,index=0,alpha=false,mask=false,signal}) {
  if(!Number.isInteger(height)||height<1||height>8192||width*height>25000000)throw Error('Invalid fixture dimensions');
  const file=await open(path,'wx',0o600);const head=Buffer.alloc(13);head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=mask?0:6;
  try {await writeAll(file,Buffer.from([137,80,78,71,13,10,26,10]));await writeAll(file,pngChunk('IHDR',head));
    const rows=Readable.from((async function*(){for(let y=0;y<height;y++){checkAbort(signal);yield rasterRow(width,y,index,{alpha,mask});}})());
    const compressed=createDeflate({level:9,chunkSize:65536});rows.on('error',error=>compressed.destroy(error));compressed.on('error',()=>rows.destroy());rows.pipe(compressed);
    try {for await(const part of compressed){checkAbort(signal);await writeAll(file,pngChunk('IDAT',part));}}finally{rows.destroy();compressed.destroy();}
    await writeAll(file,pngChunk('IEND',Buffer.alloc(0)));await file.sync();
  }finally{await file.close();}
  return fileIdentity(path);
}
export function* deterministicChunks(byteLength,{seed=1,chunkBytes=MiB}={}) {
  if(!Number.isSafeInteger(byteLength)||byteLength<0||!Number.isSafeInteger(chunkBytes)||chunkBytes<1||chunkBytes>MiB)throw Error('Invalid streamed fixture length');
  // Fixed AES-CTR stream is deterministic across consumer chunk sizes and keeps
  // allocation bounded. These are real bytes, never sparse-file size metadata.
  const key=createHash('sha256').update(`${FIXTURE_VERSION}/${seed}`).digest(),cipher=createCipheriv('aes-256-ctr',key,Buffer.alloc(16));
  for(let offset=0;offset<byteLength;offset+=chunkBytes)yield cipher.update(Buffer.alloc(Math.min(chunkBytes,byteLength-offset)));
  const tail=cipher.final();if(tail.length)yield tail;
}
export async function writeStreamedFixture(path,byteLength,options={}) {const f=await open(path,'wx',0o600);try{for(const chunk of deterministicChunks(byteLength,options)){checkAbort(options.signal);await writeAll(f,chunk);}await f.sync();}finally{await f.close();}return fileIdentity(path);}
export function textFrames(definition) {
  const def=typeof definition==='string'?workloadDefinition(definition):definition;
  if(!def.textLayers) return [];
  const phrases=['Cafe\u0301 A\u0300 Latin', 'العَرَبِيَّة اتجاه', 'देवनागरी हिन्दी', '中文 日本語', '✈ ☀ ★', 'unbroken'.repeat(20)];
  const frames=[];let remaining=def.textBytes;
  for(let i=0;i<def.textLayers;i++) {
    const target=Math.floor(remaining/(def.textLayers-i)),prefix=phrases[i%phrases.length]+'\n';
    let value=prefix;while(Buffer.byteLength(value+prefix)<=target-1&&value.split('\n').length<Math.min(def.logicalLines,64))value+=prefix;
    value+='x'.repeat(target-Buffer.byteLength(value));
    if(Buffer.byteLength(value)!==target||target>def.frameTextLimit||value.split('\n').length>def.logicalLines)throw Error('Invalid text corpus bounds');
    frames.push({id:'text-'+String(i+1).padStart(3,'0'),index:i,text:value,byteLength:target,logicalLines:value.split('\n').length,script:phrases[i%phrases.length]});remaining-=target;
  }
  if(remaining!==0)throw Error('Text corpus total mismatch');return frames;
}
export function brushCorpus(width=2048,height=2048) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<=128||height<=128)throw Error('Brush fixture needs complete document dimensions');
  return Array.from({length:100},(_,stroke)=>{const samples=Array.from({length:120},(_,i)=>({x:64+((stroke*113+i*9)%(width-128)),y:64+((stroke*67+Math.round(28*Math.sin(i/9)))%(height-128)),pressure:0.25+(i%4)*0.25,timeMs:i*1000/60}));
    // Native pointer-up is a sample at the current position. Keep its coordinates
    // equal to the final move for the same portable120-sample trace in all engines.
    samples[119].x=samples[118].x;samples[119].y=samples[118].y;
    return {id:'stroke-'+String(stroke+1).padStart(3,'0'),brushDiameter:64,sampleHz:60,samples};});
}
export async function sealTree(root) {const files=[];async function walk(directory){for(const entry of(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(directory,entry.name);if(entry.isSymbolicLink())throw Error('Unsealed fixture symlink: '+path);if(entry.isDirectory())await walk(path);else if(entry.isFile())files.push({path:relative(root,path).split(sep).join('/'),...await fileIdentity(path)});else throw Error('Unsupported fixture entry');}}await walk(root);return {root:await realpath(root),files,sha256:hash(json(files))};}
export async function verifyFixtureManifest(input, {seal}={}) {
  const manifestPath=typeof input==='string'?input:input?.manifestPath,expected=seal??(typeof input==='object'?input?.seal:null);
  if(typeof manifestPath!=='string'||!expected||expected.path!==manifestPath||!SHA.test(expected.sha256??''))throw Error('Qualification execution requires the separately retained exact fixture manifest seal');
  const before=await lstat(manifestPath);if(!before.isFile()||before.isSymbolicLink()||before.size>128*MiB)throw Error('Unsafe or excessive fixture manifest');const bytes=await readFile(manifestPath),after=await lstat(manifestPath);if(hash(bytes)!==expected.sha256||bytes.length!==before.size||before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('Fixture manifest changed after preparation');
  const manifest=JSON.parse(bytes.toString('utf8'));
  if(manifest.kind!=='sealed-performance-fixture'||manifest.version!==FIXTURE_VERSION||manifest.outcome!=='prepared')throw Error('Fixture is incomplete or unsupported');
  const def=workloadDefinition(manifest.workload);validateObserved(def,manifest.observed);
  for(const file of manifest.corpus.files){const actual=await fileIdentity(file.path);if(actual.sha256!==file.sha256||actual.byteLength!==String(file.byteLength))throw Error('Fixture content changed: '+file.id);}
  if(manifest.productReceipt){const actual=await fileIdentity(manifest.productReceipt.path);if(actual.sha256!==manifest.productReceipt.sha256||actual.byteLength!==manifest.productReceipt.byteLength)throw Error('Product preparation receipt changed');}
  if(manifest.root){const actual=await sealTree(manifest.root);if(actual.sha256!==manifest.store.sha256)throw Error('Product root changed after sealing');}
  return {...manifest,manifestPath,seal:expected};
}
export function validateObserved(definition, observed) {
  const def=typeof definition==='string'?workloadDefinition(definition):definition;
  if(!observed||observed.productionValidated!==true)throw Error('Product fixture was not validated by the real product');
  const fields=['width','height','activeRequests','layers','imageLayers','textLayers','visibleLayers','events','snapshotTail','queued','incompleteJobs','candidates','metadataEntries','assets','closureBytes','captionVersions','textBytes','fontFaces','fastInputFiles','fastFamilies'];
  for(const key of fields)if(def[key]!==undefined&&def[key]!==null&&String(observed[key])!==String(def[key]))throw Error(`Fixture ${def.id} ${key}: expected ${def[key]}, observed ${observed[key]}`);
  if(def.textLayers&&(!observed.allTextLayersLaidOut||!SHA.test(observed.rendererHash??'')||!SHA.test(observed.fontManifestHash??'')))throw Error('Missing exact native layout/renderer/font evidence');
  if(def.closureBytes&&(!observed.closureVerified||!observed.features||['original','candidate','rawCaption','derivedCaption','nativeText','font','layout','contribution','adapter'].some(key=>observed.features[key]!==true)))throw Error('Portable closure lacks real referenced feature assets');
  if(def.id==='WJ'&&observed.caseCount!==30)throw Error('WJ requires all 30 cases');
}
async function newOutput(path) {
  if(!isAbsolute(path))throw Error('Fixture output must be absolute');const output=resolve(path),artifacts=join(await realpath(REPO),'artifacts');
  if(!output.startsWith(artifacts+sep))throw Error('Fixture output must be a new artifact directory in this checkout');
  await mkdir(artifacts,{recursive:true});const artifactInfo=await lstat(artifacts);if(!artifactInfo.isDirectory()||artifactInfo.isSymbolicLink()||await realpath(artifacts)!==artifacts)throw Error('Unsafe artifact root');let current=artifacts;
  for(const component of relative(artifacts,dirname(output)).split(sep).filter(Boolean)){current=join(current,component);await mkdir(current,{recursive:true});const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(current)!==current)throw Error('Unsafe fixture parent');}
  await mkdir(output,{mode:0o700});return output;
}
export async function writeExactSizePNG(path,source,targetBytes,{signal}={}) {
  if(!Number.isSafeInteger(targetBytes)||targetBytes<24||targetBytes>32*MiB)throw Error('Exact PNG target exceeds its explicit bound');const info=await lstat(source);if(!info.isFile()||info.isSymbolicLink()||info.size>targetBytes-12)throw Error('Exact PNG source exceeds its target or is not an ordinary file');const encoded=await readFile(source);if(encoded.length!==info.size)throw Error('Exact PNG source changed while reading');if(!encoded.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||encoded.toString('ascii',encoded.length-8,encoded.length-4)!=='IEND')throw Error('Exact-size input must be a complete PNG');
  const padding=targetBytes-encoded.length-12;if(!Number.isSafeInteger(targetBytes)||padding<0||targetBytes>32*MiB)throw Error('Exact PNG target must fit its existing content and explicit32MiB bound');
  // PNG3 allows unused trailing compressed IDAT bytes, and the production parser
  // deliberately accepts them. This is a real complete 512px image with exact
  // transport bytes, not an opaque binary falsely labelled as an image.
  const file=await open(path,'wx',0o600);try{await writeAll(file,encoded.subarray(0,-12));const header=Buffer.alloc(8);header.writeUInt32BE(padding);header.write('IDAT',4);await writeAll(file,header);let state=0xffffffff;const feed=bytes=>{for(const b of bytes)state=CRC_TABLE[(state^b)&255]^(state>>>8);};feed(header.subarray(4));for(const bytes of deterministicChunks(padding,{seed:'wf-fault-idat-padding',chunkBytes:65536})){checkAbort(signal);feed(bytes);await writeAll(file,bytes);}const checksum=Buffer.alloc(4);checksum.writeUInt32BE((state^0xffffffff)>>>0);await writeAll(file,checksum);await writeAll(file,encoded.subarray(-12));await file.sync();}finally{await file.close();}const identity=await fileIdentity(path);if(Number(identity.byteLength)!==targetBytes)throw Error('Exact PNG byte count mismatch');return identity;
}
export async function prepareFastCorpus({output,allowHeavy=false,signal,onProgress=()=>{}}) {
  if(!allowHeavy)throw Error('Fast input generation requires explicit allowHeavy:true');
  const directory=join(output,'fast-corpus');await mkdir(directory,{mode:0o700});const files=[],sharp=(await import('sharp')).default;
  for(const width of [512,1024,2048])for(const format of ['png','jpeg'])for(let index=0;index<4;index++){
    checkAbort(signal);const id=`wf-${width}-${format}-${index}`,path=join(directory,id+(format==='jpeg'?'.jpg':'.png')),source=format==='jpeg'?path+'.source.png':path;
    await writeRasterPNG(source,{width,height:width,index:2000+index,alpha:false,signal});if(format==='jpeg'){await sharp(source,{limitInputPixels:25000000,sequentialRead:true}).jpeg({quality:90,chromaSubsampling:'4:4:4',progressive:false}).toFile(path);await rm(source);}
    const file={id,path,role:'fast-candidate',width,height:width,format,index,...await fileIdentity(path)};files.push(file);await onProgress({event:'fixture-file',file});
  }
  const faultPath=join(directory,'wf-fault-8MiB.png'),faultSource=files.find(file=>file.width===512&&file.format==='png'&&file.index===0);files.push({id:'wf-fault-8MiB',path:faultPath,role:'fast-fault-candidate',width:512,height:512,format:'png',index:0,...await writeExactSizePNG(faultPath,faultSource.path,8*MiB,{signal}),padding:'PNG3-permitted unused trailing compressed IDAT bytes; actual transport length8MiB'});const {fastManifest}=await import('./backend-queue.mjs');return {kind:'sealed-fast-input-corpus',preparationOnly:true,files,validFamilies:structuredClone(fastManifest),limits:['These are actual format/size/batch input bytes. Every sample must independently create its real job/attempt inside the named timer.','The separate 8 MiB fault image retains exact complete PNG pixels and transport bytes; it is never substituted for a different size/format.']};
}
export async function prepareCorpus({definition,output,fontCorpus,repo=REPO,signal,onProgress=()=>{}}) {
  const def=definition,files=[],directory=join(output,'corpus');await mkdir(directory,{mode:0o700});
  const add=async(id,path,role,extra={})=>{const value={id,path,role,...extra,...await fileIdentity(path)};files.push(value);await onProgress({event:'fixture-file',file:value});return value;};
  let fast; if(def.id==='WF'){fast=await prepareFastCorpus({output:directory,allowHeavy:true,signal,onProgress});files.push(...fast.files);}
  if(def.id==='WA'){const {prepareAdapterFixtures}=await import('./adapters.mjs');const prepared=await prepareAdapterFixtures(join(directory,'adapters'),{sizes:[256*MiB,1024*MiB],signal});for(const [index,weights]of prepared.weights.entries())files.push({id:index===0?'adapter-256MiB':'adapter-1GiB',path:weights.path,sha256:weights.hash,byteLength:String(weights.bytes),role:'adapter-weights'});files.push({id:'adapter-config',path:prepared.config.path,sha256:prepared.config.hash,byteLength:String(prepared.config.bytes),role:'adapter-config'});}
  if(def.imageLayers){let sharp;for(let i=0;i<def.imageLayers;i++) {checkAbort(signal);const id='original-'+String(i+1).padStart(3,'0'),jpeg=i%2===0&&def.id!=='WNarrow',path=join(directory,id+(jpeg?'.jpg':'.png')),temporary=jpeg?path+'.source.png':path;
      await writeRasterPNG(temporary,{width:def.width,height:def.height,index:i+1,alpha:!jpeg,signal});
      if(jpeg){sharp??=(await import('sharp')).default;await sharp(temporary,{limitInputPixels:25000000,sequentialRead:true}).jpeg({quality:90,chromaSubsampling:'4:4:4',progressive:false}).toFile(path);await rm(temporary);}
      const entry=await add(id,path,'raster-original',{index:i,format:jpeg?'jpeg':'png',width:def.width,height:def.height,alpha:!jpeg});if(Number(entry.byteLength)>def.encodedLimit)throw Error('Encoded original exceeds workload bound');
    }
    if(def.id==='WNarrow'){sharp??=(await import('sharp')).default;const original=files.find(file=>file.role==='raster-original'),path=join(directory,'narrow-jpeg.jpg');await sharp(original.path,{limitInputPixels:25000000,sequentialRead:true}).jpeg({quality:90,chromaSubsampling:'4:4:4',progressive:false}).toFile(path);const file=await add('narrow-jpeg',path,'raster-codec',{width:8192,height:3000,format:'jpeg'});if(Number(file.byteLength)>def.encodedLimit)throw Error('Narrow JPEG exceeds encoded bound');}
    if(def.id!=='WNarrow'){sharp??=(await import('sharp')).default;const alphaInput=files.find(file=>file.role==='raster-original'&&file.alpha);if(alphaInput)for(const codec of ['lossy','lossless']){checkAbort(signal);const path=join(directory,'webp-'+codec+'.webp');await sharp(alphaInput.path,{limitInputPixels:25000000,sequentialRead:true}).webp({quality:90,alphaQuality:100,lossless:codec==='lossless'}).toFile(path);const entry=await add('webp-'+codec,path,'raster-codec',{format:'webp',codec,width:def.width,height:def.height,alpha:true});if(Number(entry.byteLength)>def.encodedLimit)throw Error('WebP fixture exceeds encoded workload bound');}}
    const mask=join(directory,'mask.png');await writeRasterPNG(mask,{width:def.width,height:def.height,mask:true,signal});const m=await add('mask',mask,'mask',{width:def.width,height:def.height,format:'png',channel:'grayscale8'});if(Number(m.byteLength)>def.maskEncodedLimit)throw Error('Encoded mask exceeds workload bound');
    if(def.width===2048){const raw=join(directory,'mask-gray8.raw'),f=await open(raw,'wx',0o600);try{for(let y=0;y<def.height;y++){checkAbort(signal);await writeAll(f,rasterRow(def.width,y,0,{mask:true}).subarray(1));}await f.sync();}finally{await f.close();}await add('mask-gray8-4MiB',raw,'mask-raw',{width:2048,height:2048,format:'gray8'});}
    for(let i=0;i<def.candidates;i++){const path=join(directory,`candidate-${i+1}.png`);await writeRasterPNG(path,{width:def.width,height:def.height,index:1000+i,alpha:i%2===1,signal});const entry=await add('candidate-'+(i+1),path,'candidate',{index:i,width:def.width,height:def.height,format:'png'});if(Number(entry.byteLength)>def.encodedLimit)throw Error('Encoded candidate exceeds workload bound');}
    if(def.id==='WQ'){const original=files.find(file=>file.role==='raster-original'&&file.format==='png'),path=join(directory,'wq-result-8MiB.png');await writeExactSizePNG(path,original.path,8*MiB,{signal});await add('wq-result-8MiB',path,'candidate-result',{width:def.width,height:def.height,format:'png',index:0,padding:'PNG3-permitted trailing compressed IDAT bytes; actual8MiB result bytes'});}
    const strokes=join(directory,'brush-strokes.json');await writeFile(strokes,json(brushCorpus(def.width,def.height)),{flag:'wx',mode:0o600});await add('brush-strokes',strokes,'gestures',{strokes:100,samplesPerStroke:120,brushDiameter:64,hz:60});
  }
  for(const bytes of [8*MiB,32*MiB]) {const path=join(directory,`transfer-${bytes}.bin`);await writeStreamedFixture(path,bytes,{seed:bytes,signal});await add('transfer-'+bytes,path,'transfer',{contentType:'application/octet-stream',image:false});}
  if(def.id==='WJ'){const manifestPath=join(repo,'vendor/text/manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8')),font=manifest.fonts.find(face=>face.id==='NotoSans');if(!font)throw Error('WJ requires the sealed bundled NotoSans face');const path=resolve(repo,'vendor/text',font.file),licensePath=resolve(repo,'vendor/text',font.licenseFile),scope=resolve(repo,'vendor/text')+sep;if(!path.startsWith(scope)||!licensePath.startsWith(scope))throw Error('Font source paths escape sealed input root');const identity=await fileIdentity(path),license=await fileIdentity(licensePath);if(identity.sha256!=='sha256:'+font.sha256||identity.byteLength!==String(font.bytes)||license.sha256!==font.licenseHash)throw Error('WJ bundled font or license identity changed');files.push({...font,id:'font-NotoSans',fontId:'NotoSans',path,licensePath,role:'font',...identity},{id:'font-license-NotoSans',path:licensePath,role:'font-license',...license},{id:'font-corpus-manifest',path:manifestPath,role:'font-manifest',...await fileIdentity(manifestPath)});}
  if(def.textLayers){const {verifyFontCorpus}=await import('./fonts.mjs');const fonts=await verifyFontCorpus(fontCorpus,{workload:def.id});for(const font of fonts.faces)files.push({...font,id:'font-'+font.id,fontId:font.id,role:'font'});for(const [index,path]of [...new Set(fonts.faces.map(font=>font.licensePath))].entries())files.push({id:'font-license-'+(index+1),path,role:'font-license',...await fileIdentity(path)});for(const frame of textFrames(def)){const path=join(directory,frame.id+'.txt');await writeFile(path,frame.text,{flag:'wx',mode:0o600});const {text,...metadata}=frame;await add(frame.id,path,'text',metadata);}files.push({id:'font-corpus-manifest',role:'font-manifest',path:fonts.manifestPath,...await fileIdentity(fonts.manifestPath)});}
  return {version:FIXTURE_VERSION,files,...fast?{fast}: {}};
}
export async function setupFixture(options) {
  if(options?.allowHeavy!==true)throw Error('Explicit allowHeavy:true is required for fixture preparation; never prepare implicitly inside a scored sample');
  const repo=resolve(options.repo??REPO),def=workloadDefinition(options.workload,options),output=await newOutput(options.output),startedAt=new Date().toISOString(),manifestPath=join(output,'fixture.json');
  const manifest={kind:'sealed-performance-fixture',version:FIXTURE_VERSION,repo,workload:def.id,definition:def,outcome:'preparing',startedAt,preparationOutsideMeasurement:true,liveProviderAuthorized:false,providerPolicy:'disabled; only guarded local fixture processing is permitted',training:false};
  try{const disk=await statfs(output,{bigint:true});if(disk.bavail*disk.bsize<BigInt(def.minimumFreeBytes))throw Error('Insufficient free space for complete fixture preparation');checkAbort(options.signal);
    manifest.corpus=await prepareCorpus({...options,repo,definition:def,output});
    let built;const extensions={},seedCandidates=options.product?.seedCandidates??(def.candidates?(await import('./fixture-masked.mjs')).seedMaskedProductCandidates:undefined);
    const prepareAdditional=async context=>{if(def.id==='WA'){const {prepareAdapterLibrary}=await import('./adapters.mjs'),fixtureInputs={weights:manifest.corpus.files.filter(f=>f.role==='adapter-weights').map(f=>({path:f.path,hash:f.sha256,bytes:Number(f.byteLength),mediaType:'application/octet-stream'})),config:(()=>{const f=manifest.corpus.files.find(f=>f.role==='adapter-config');return {path:f.path,hash:f.sha256,bytes:Number(f.byteLength),mediaType:'text/plain'};})()};extensions.adapterLibrary=await prepareAdapterLibrary(context.writer,fixtureInputs,{repo,root:context.root,output,signal:options.signal,officialPath:options.officialAdapterPath});if(extensions.adapterLibrary.eligibleEntries.length!==3)throw Error('WA inference fixture requires three distinct eligible immutable versions from the sealed public example');}if(options.product?.prepareAdditional)await options.product.prepareAdditional(context);};
    if(def.id==='WJ'){
      const {makeCompositionFixture,compositionCaseIds,rawEnvelopeChunks}=await import('./backend-composition.mjs');for(const id of compositionCaseIds){const f=await makeCompositionFixture(id),path=join(output,'corpus',id+'.bin');await writeFile(path,f.bytes,{flag:'wx',mode:0o600});manifest.corpus.files.push({id,path,role:f.role,expected:f.expected,...await fileIdentity(path)});}for(const [id,bytes]of [['RAW16M',16*MiB],['RAW16M_PLUS1',16*MiB+1]]){const path=join(output,'corpus',id+'.json'),f=await open(path,'wx',0o600);try{for(const chunk of rawEnvelopeChunks(bytes)){checkAbort(options.signal);await writeAll(f,chunk);}await f.sync();}finally{await f.close();}manifest.corpus.files.push({id,path,role:'raw-provider-response',promptBytes:bytes,...await fileIdentity(path)});}const buildComposition=options.product?.compositionFixture??(await import('./backend-composition-fixture.mjs')).compositionFixture;built=await buildComposition({repo,root:join(output,'store'),definition:def,corpus:manifest.corpus,output,signal:options.signal,onProgress:options.onProgress});extensions.wjCaseCount=compositionCaseIds.length;
    }else if(def.closureBytes){const producer=options.product?.portableFixture;if(producer)built=await producer({repo,root:join(output,'store'),definition:def,corpus:manifest.corpus,output,signal:options.signal,onProgress:options.onProgress});else{if(!options.seed)throw Error('WC requires an actual mixed full-history seed; an arbitrary filled archive is not a fixture');const {buildPortableFixture}=await import('./fixture-portable.mjs');built=await buildPortableFixture({repo,output:join(output,'portable'),workload:def.id,seed:options.seed,allowHeavy:true,signal:options.signal,onProgress:options.onProgress});if(built.status!=='pass')throw Error('Portable fixture incomplete: '+JSON.stringify(built.missing??built.error??built.status));}}
    else if(def.id==='WNarrow'){const buildRaster=options.product?.rasterFixture??(await import('./fixture-narrow.mjs')).rasterFixture;built=await buildRaster({repo,root:join(output,'store'),definition:def,corpus:manifest.corpus,output,signal:options.signal,onProgress:options.onProgress});}
    else if(def.textLayers){const buildNative=options.product?.nativeFixture??(await import('./fixture-native.mjs')).nativeFixture;built=await buildNative({repo,root:join(output,'store'),definition:def,corpus:manifest.corpus,output,signal:options.signal,onProgress:options.onProgress,seedCandidates});}
    else {const {buildProductFixture}=await import('./fixture-product.mjs');built=await buildProductFixture({repo,root:join(output,'store'),workload:def.id==='WF'?'W0':def.id,definition:def,corpus:manifest.corpus,seedCandidates,prepareAdditional,allowHeavy:true,signal:options.signal,onProgress:options.onProgress});}
    const restricted=built.text?.recoveryCases?.['restricted-font'];if(restricted){const identity=await fileIdentity(restricted.path);if(identity.sha256!==restricted.sha256)throw Error('Native restricted-font specimen differs from the product receipt');manifest.corpus.files.push({id:'restricted-font-copy',role:'recovery-font',path:restricted.path,...identity});}
    const observed={...built.observed,...def.id==='WJ'?{caseCount:extensions.wjCaseCount}:{},...def.id==='WF'?{fastInputFiles:manifest.corpus.files.filter(f=>f.role==='fast-candidate').length,fastFamilies:manifest.corpus.fast.validFamilies.length}: {}};if(observed.activeRequests===undefined&&observed.active!==undefined)observed.activeRequests=observed.active;validateObserved(def,observed);const productReceiptPath=join(output,'product-receipt.json');await writeFile(productReceiptPath,json(built),{flag:'wx',mode:0o600});const {seal:productSeal,...productValues}=built;Object.assign(manifest,productValues,extensions,{kind:'sealed-performance-fixture',version:FIXTURE_VERSION,workload:def.id,definition:def,observed,productReceipt:{path:productReceiptPath,...await fileIdentity(productReceiptPath)}});if(manifest.root)manifest.store=await sealTree(manifest.root);manifest.outcome='prepared';manifest.completedAt=new Date().toISOString();
    const bytes=Buffer.from(json(manifest));await writeFile(manifestPath,bytes,{flag:'wx',mode:0o600});return {...manifest,manifestPath,seal:{path:manifestPath,sha256:hash(bytes)}};
  }catch(error){manifest.outcome='incomplete';manifest.failedAt=new Date().toISOString();manifest.error={name:error?.name??'Error',message:String(error?.message??error)};await writeFile(manifestPath,json(manifest),{flag:'wx',mode:0o600});throw Object.assign(error,{fixtureReceipt:manifestPath});}
}
