import {ACTIVE_COMPUTE_RESERVATION_BYTES} from './active-compute.js';
import type {ImportTelemetry} from './import-telemetry.js';
import {closeSync,constants,fstatSync,fsyncSync,ftruncateSync,lstatSync,openSync,readSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createInflate,inflateSync} from 'node:zlib';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {inspectPNG} from './png-input.js';
import {encodePNG} from './png.js';
import {CODECS} from './codec-platform.js';
import {openWebPColorConverter} from './webp-color.js';
import {webpExifOrientation} from './webp-metadata.js';
import {encodedExtent,importOperation,type RasterImportOperation} from '../../src/protocol/raster-import.js';
import {extent} from '../../src/raster/core.js';
import {originalRawBytes,orientedDimensions,transformImportFile,writeExact,IMPORT_PAGE_BYTES,IMPORT_PAGE_COUNT} from './import-file-transform.js';

const MiB=1048576,MAX_ROW_SCRATCH=16*MiB;
export const PNG_IMPORT_PROFILE='png-scanline-file-cp1-v1';
type Admission={width:number;height:number;rawBytes:number;cpuBytes:number;diskBytes:number;allocations:Record<string,number>};
function stamp(value:ReturnType<typeof fstatSync>){return [value.dev,value.ino,value.size,value.mtimeMs,value.ctimeMs].join(':');}
const hash=(bytes:Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex');

/** All outputs remain private working files until full decode + source proof. */
export async function preparePNGImport(input:string,directory:string,operation:RasterImportOperation,admit:(plan:Admission)=>Promise<void>,check:()=>void,canonicalNames=false,telemetry?:ImportTelemetry){
 const inputFD=openSync(input,constants.O_RDONLY|constants.O_NOFOLLOW),before=fstatSync(inputFD);
 const read=(at:number,n:number)=>{check();if(!Number.isSafeInteger(at)||!Number.isSafeInteger(n)||at<0||n<0||n>4*MiB||at+n>before.size)throw Error('RASTER_TRUNCATED');const b=Buffer.alloc(n);if(readSync(inputFD,b,0,n,at)!==n){stable();throw Error('RASTER_TRUNCATED');}return b;};
 const stable=()=>{check();if(stamp(before)!==stamp(fstatSync(inputFD))||stamp(before)!==stamp(lstatSync(input)))throw Error('RASTER_INPUT_CHANGED');};
 const originalRaw=join(directory,'.original-'+randomUUID()+'.rgba'),raw=join(directory,canonicalNames?'pixels.rgba':'pixels-'+randomUUID()+'.rgba'),png=join(directory,canonicalNames?'output.png':'preview-'+randomUUID()+'.png');
 const owned=new Map<string,{dev:number;ino:number}>();let sourceFD:number|undefined,outputFD:number|undefined,complete=false;
 let converter:Awaited<ReturnType<typeof openWebPColorConverter>>=null;
 const openOwned=(path:string)=>{const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600),s=fstatSync(fd);owned.set(path,{dev:s.dev,ino:s.ino});return fd;};
 const removeOwned=(path:string)=>{const expected=owned.get(path);if(!expected)return;try{const now=lstatSync(path);if(now.dev!==expected.dev||now.ino!==expected.ino)throw Error('RASTER_INPUT_CHANGED');unlinkSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}};
 try{
  if(!before.isFile())throw Error('RASTER_FORMAT');
  // One worker admission only. Read the fixed IHDR prefix to conservatively
  // reserve before ICC inflation, scanline buffers, native color or disk writes.
  // Complete container/CRC validation follows; these bytes confer no validity.
  const header=read(0,24);if(header.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||header.readUInt32BE(8)!==13||header.toString('latin1',12,16)!=='IHDR')throw Error('RASTER_FORMAT');
  const encodedWidth=header.readUInt32BE(16),encodedHeight=header.readUInt32BE(20);encodedExtent(encodedWidth,encodedHeight);extent(operation.width,operation.height);
  const sourceBytes=originalRawBytes(encodedWidth,encodedHeight),rowScratch=encodedWidth*12,targetBytes=operation.width*operation.height*4;
  if(rowScratch>MAX_ROW_SCRATCH)throw Error('RASTER_RESOURCES');
  const allocations={activeKernelTelemetry:ACTIVE_COMPUTE_RESERVATION_BYTES,workerAndBackend:96*MiB,metadataAndInflater:16*MiB,pngRows:rowScratch,sourcePages:IMPORT_PAGE_BYTES*IMPORT_PAGE_COUNT,resampleRow:operation.width*4,pinnedColor:32*MiB,encoderAndIO:4*MiB};
  const plan={width:operation.width,height:operation.height,rawBytes:targetBytes,cpuBytes:Object.values(allocations).reduce((a,b)=>a+b,0),diskBytes:sourceBytes+3*targetBytes+16*MiB,allocations};
  if(!Number.isSafeInteger(plan.diskBytes))throw Error('RASTER_RESOURCES');await admit(plan);stable();
  const decodePhase=telemetry?.start('decode',{sourceWidth:encodedWidth,sourceHeight:encodedHeight});let metadataBytes=0;const descriptor=await inspectPNG(read,before.size,n=>{metadataBytes+=n;if(metadataBytes>4*MiB)throw Error('RASTER_RESOURCES');},stable,true);
  let palette:Buffer|undefined,transparency:Buffer|undefined,icc:Buffer|undefined,exif:Buffer|undefined;
  for(let at=8;at<before.size;){const h=read(at,8),n=h.readUInt32BE(),type=h.toString('latin1',4);if(type==='PLTE')palette=read(at+8,n);if(type==='tRNS')transparency=read(at+8,n);if(type==='eXIf')exif=read(at+8,n);if(type==='iCCP'){const encoded=read(at+8,n),start=encoded.indexOf(0)+2;icc=inflateSync(encoded.subarray(start),{maxOutputLength:4*MiB});}at+=n+12;}
  if((icc?hash(icc):null)!==descriptor.iccHash||(exif?hash(exif):null)!==descriptor.exifHash)throw Error('RASTER_METADATA');
  const orientation=exif?webpExifOrientation(exif):1,oriented=orientedDimensions(descriptor.width,descriptor.height,orientation);importOperation(operation,oriented.width,oriented.height);
  const {width,height,depth,color,interlace}=descriptor,channels=color===0||color===3?1:color===4?2:color===2?3:4,rowBytes=Math.ceil(width*channels*depth/8);
  if(width!==encodedWidth||height!==encodedHeight)throw Error('RASTER_INPUT_CHANGED');
  const profile=icc?(hash(icc)===CODECS.profiles.p3.hash?'p3':'srgb'):'untagged-srgb';
  if(profile==='p3'){converter=await openWebPColorConverter();if(!converter)throw Error('RASTER_CODEC_UNQUALIFIED');}
  sourceFD=openOwned(originalRaw);ftruncateSync(sourceFD,sourceBytes);
  const geometry=interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
  const passes=geometry.map(([x,y,dx,dy])=>({x,y,dx,dy,width:Math.max(0,Math.ceil((width-x)/dx)),height:Math.max(0,Math.ceil((height-y)/dy))})).filter(p=>p.width&&p.height);
  let pass=0,row=0,offset=-1,filter=0,previous=Buffer.alloc(rowBytes),current=Buffer.alloc(rowBytes);const rgba=Buffer.alloc(width*4),bpp=Math.max(1,Math.ceil(channels*depth/8));
  const finishRow=async()=>{
   stable();const p=passes[pass],sample=(index:number)=>depth===8?current[index]:(current[Math.floor(index*depth/8)]>>>(8-depth-(index*depth)%8))&((1<<depth)-1);
   for(let x=0;x<p.width;x++){
    if(x&&x%4096===0){stable();await new Promise<void>(resolve=>setImmediate(resolve));stable();}
    const at=x*4;if(color===3){const index=sample(x);if(!palette||index*3+2>=palette.length)throw Error('RASTER_PALETTE');rgba[at]=palette[index*3];rgba[at+1]=palette[index*3+1];rgba[at+2]=palette[index*3+2];rgba[at+3]=transparency?.[index]??255;}
    else if(color===0){const gray=sample(x);rgba[at]=rgba[at+1]=rgba[at+2]=gray*255/((1<<depth)-1);rgba[at+3]=transparency&&gray===transparency.readUInt16BE()?0:255;}
    else if(color===2){rgba[at]=current[x*3];rgba[at+1]=current[x*3+1];rgba[at+2]=current[x*3+2];rgba[at+3]=transparency&&rgba[at]===transparency.readUInt16BE()&&rgba[at+1]===transparency.readUInt16BE(2)&&rgba[at+2]===transparency.readUInt16BE(4)?0:255;}
    else if(color===4){rgba[at]=rgba[at+1]=rgba[at+2]=current[x*2];rgba[at+3]=current[x*2+1];}
    else current.copy(rgba,at,x*4,x*4+4);
   }
   const samples=rgba.subarray(0,p.width*4);if(converter)await converter.convertInPlace(samples,icc!,stable);
   const y=p.y+row*p.dy;if(p.dx===1)writeExact(sourceFD!,samples,(y*width+p.x)*4);else for(let x=0;x<p.width;x++){if(x&&x%4096===0){stable();await new Promise<void>(resolve=>setImmediate(resolve));stable();}writeExact(sourceFD!,samples.subarray(x*4,x*4+4),(y*width+p.x+x*p.dx)*4);}
   [current,previous]=[previous,current];offset=-1;row++;if(row===p.height){row=0;pass++;previous.fill(0);}
  };
  async function* compressed(){for(let at=descriptor.firstIDAT;at<descriptor.lastIDAT;){const n=read(at,4).readUInt32BE();for(let p=0;p<n;p+=65536)yield read(at+8+p,Math.min(65536,n-p));at+=n+12;}}
  const inflater=createInflate({chunkSize:65536}),producing=pipeline(Readable.from(compressed()),inflater);void producing.catch(()=>{});
  try{for await(const bytes of inflater){const data=bytes as Buffer;for(let i=0;i<data.length;){stable();if(pass>=passes.length)throw Error('RASTER_LENGTH');const p=passes[pass],count=Math.ceil(p.width*channels*depth/8);
    if(offset===-1){filter=data[i++];if(filter>4)throw Error('RASTER_FILTER');offset=0;}
    const n=Math.min(count-offset,data.length-i);for(let j=0;j<n;j++){const x=offset+j,left=x>=bpp?current[x-bpp]:0,up=previous[x],corner=x>=bpp?previous[x-bpp]:0,predictor=left+up-corner,pa=Math.abs(predictor-left),pb=Math.abs(predictor-up),pc=Math.abs(predictor-corner),value=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):pa<=pb&&pa<=pc?left:pb<=pc?up:corner;current[x]=(data[i+j]+value)&255;}offset+=n;i+=n;if(offset===count)await finishRow();
   }}await producing;if(pass!==passes.length||offset!==-1)throw Error('RASTER_LENGTH');}
  catch(error){inflater.destroy();await Promise.allSettled([producing]);throw error;}
  stable();fsyncSync(sourceFD);closeSync(sourceFD);sourceFD=undefined;decodePhase?.end();
  const resamplePhase=telemetry?.start('resample',{width:operation.width,height:operation.height,sourceWidth:width,sourceHeight:height});outputFD=openOwned(raw);await transformImportFile(originalRaw,outputFD,width,height,orientation,operation,stable,telemetry?.active);closeSync(outputFD);outputFD=undefined;resamplePhase?.end();
  const encodePhase=telemetry?.start('encode',{width:operation.width,height:operation.height});await encodePNG(raw,png,operation.width,operation.height,stable,fd=>{const s=fstatSync(fd);owned.set(png,{dev:s.dev,ino:s.ino});});stable();encodePhase?.end();complete=true;
  return {raw,png,width:operation.width,height:operation.height,plan,inspection:{encoded:{width,height},orientation,profile,profileHash:descriptor.iccHash},derivation:{kind:'decoded-derived-v1',operation,kernel:'triangle-area-source-axis-row-norm-v1',decodeTransport:PNG_IMPORT_PROFILE}};
 }finally{
  const failures:unknown[]=[];const cleanup=[()=>{if(sourceFD!==undefined)closeSync(sourceFD);},()=>{if(outputFD!==undefined)closeSync(outputFD);},()=>closeSync(inputFD),()=>converter?.close(),()=>removeOwned(originalRaw),()=>{if(!complete)removeOwned(raw);},()=>{if(!complete)removeOwned(png);}];
  for(const finish of cleanup)try{finish();}catch(error){failures.push(error);}
  // A failed cleanup turns even a complete computation into a failed prepare;
  // no caller receives output paths, so keep attempting both output removals.
  if(failures.length&&complete)for(const path of [raw,png])try{removeOwned(path);}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Raster import cleanup failed');
 }
}
