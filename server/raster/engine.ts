import {diagnosticMemory} from '../../src/observability/diagnostic-memory.js';
import {runDerivedRaster,type DerivedRasterJob} from './derive-original.js';
import {prepareNativeDerived} from './import-producers.js';
import {sanitizePhaseContext,type PhaseContext,type PhaseName,type PhaseRecorder,type PhaseSpan} from '../../src/observability/phases.js';
import {ActiveCompute,ACTIVE_COMPUTE_RESERVATION_BYTES} from './active-compute.js';
import {nonDecodeResourcePlan,retainedTextResourcePlan,compositionResourcePlan,type ResourcePlan} from './resource-plan.js';
export type {ResourcePlan} from './resource-plan.js';
import {maskGrid,retainedMask,r16Mask} from '../../src/raster/mapping.js';
import { authoredCoverage, featherRows, validateMaskPlan, type MaskPlan } from '../../src/raster/mask.js';
import { providerMaskRow, providerSourceRow, preserveMappedRequestRow, requestRasterGrid, requireRequestCoverage, validateRequestRasterPlan, type RequestRasterPlan, type RequestOutputMapping } from '../../src/request/raster-plan.js';
import type { RequestSourceCapture } from '../../src/protocol/request-edits.js';
import { openSync, closeSync, readSync, writeSync, fsyncSync, fstatSync, lstatSync, unlinkSync, constants, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { CODECS, CODEC_ID } from './codec-platform.js';
import { encodePNG } from './png.js';
import { encodeJPEG, jpegAllocationPlan, JPEG_FILE_TRANSPORT, type JPEGTransport } from './jpeg.js';
import { exportOptions, type RasterExportOptions } from '../../src/protocol/export.js';
import { inspectContainer } from './container.js';
import { readWebPMetadata, sameWebPSource } from './webp-metadata.js';
import { decodeWebPFrame, webpFrameBytes } from './webp-frame.js';
import { verifyBoundedWebP, BOUNDED_WEBP_NATIVE_BYTES, BOUNDED_WEBP_COLOR_BYTES } from './bounded-webp.js';
import { openWebPColorConverter, type WebPColorConverter } from './webp-color.js';
import { BOUNDED_WEBP } from './webp-platform.js';
import { openWebPFileDecoder, verifyWebPOutput } from './webp-output.js';
import { WEBP_OUTPUT } from './webp-output-platform.js';
import { forceWebPFileAlpha, orientWebPFile } from './webp-pixels.js';
import { verifyLinuxColor } from './linux-color.js';
import { extent, contribution, fold, finish, maskCoverage, footprint, linear, srgb, q8 } from '../../src/raster/core.js';
import { PIPELINE, RASTER_CODEC_ID, findRasterProfile, isKnownRasterEncoder } from './profile-registry.js';
import type { Pixels, Rect } from '../../src/raster/core.js';
import type { BlobRef } from '../../src/protocol/store.js';
import { documentCreationBackground } from '../../src/protocol/document-creation.js';
import type { RasterLayer, RasterManifest, RasterInfo } from '../../src/protocol/raster.js';
import { canonical } from '../../src/protocol/json.js';
import { assertComponents, assertPrivate, sameFile } from '../storage/files.js';
import {runEncodedRaster,type EncodedRasterJob,type EncodedRebuildEvidence} from './encoded-input.js';

const MiB = 1024 * 1024;
export const hash = (bytes: Uint8Array | string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export { PIPELINE, RASTER_CODEC_ID } from './profile-registry.js';
export type InputRaster = { id: string; info: RasterInfo; path: string; coveragePath?:string;hardPath?:string };
/** Only portable validation writes temporary outputs with retained identities. */
export type RasterReplayIdentity = { pipeline: string; encoder?: string };
export type RasterJob = (DerivedRasterJob&{telemetry?:PhaseContext}) | EncodedRasterJob | { directory: string; telemetry?:PhaseContext } & (
  | { type:'solid-background'; width:number; height:number; color:readonly [number,number,number,255] }
  | { type:'mask'; plan:MaskPlan; inputs:readonly InputRaster[]; dependencies:readonly BlobRef[];request?:{source:InputRaster;clip:Rect|null} }
  | { type:'request-mask'; input:InputRaster; plan:RequestRasterPlan; dependencies:readonly BlobRef[] }
  | { type:'v45-edit-mask'; input:InputRaster;source:BlobRef;sourceAssetId:string;sourcePixels:BlobRef;plan:RequestRasterPlan;dependencies:readonly BlobRef[];replay?:RasterReplayIdentity }
  | { type:'request-source'; input:InputRaster; plan:RequestRasterPlan; dependencies:readonly BlobRef[];replay?:RasterReplayIdentity }
  | { type:'preserve-request'; source:InputRaster;candidate:InputRaster;mask:InputRaster;plan:RequestRasterPlan;outputMapping?:RequestOutputMapping;dependencies:readonly BlobRef[] }
  | { type:'text'; path:string; width:number;height:number; source:BlobRef;dependencies:readonly BlobRef[] }
  | { type: 'decode'; path: string; mediaType: string; original: BlobRef; sourceAssetId: string }
  | { type: 'compose'; width: number; height: number; layers: readonly RasterLayer[]; inputs: readonly InputRaster[]; dependencies: readonly BlobRef[];requestSource?:RequestSourceCapture; replay?: RasterReplayIdentity }
  | { type: 'export'; input: InputRaster; dependencies: readonly BlobRef[]; options?: RasterExportOptions; encoderTransport?:JPEGTransport; replay?: RasterReplayIdentity }
);
export type RasterResult = { files: readonly { name: string; ref: BlobRef }[]; png: BlobRef; info: RasterInfo; manifest: RasterManifest; plan: ResourcePlan; metrics: Record<string, number>;encodedRebuild?:EncodedRebuildEvidence };
export function verifyCodecs(): void {
  if (process.versions.node !== CODECS.node || process.versions.zlib !== CODECS.zlib || process.platform !== CODECS.platform || process.arch !== CODECS.arch || canonical(sharp.versions) !== canonical(CODECS.versions)) throw new Error('RASTER_CODEC_UNQUALIFIED');
  const require = createRequire(import.meta.url);
  const root = dirname(dirname(dirname(require.resolve('sharp'))));
  const buffer=Buffer.alloc(MiB);
  for (const file of CODECS.files) { const fd=openSync(join(root,file.path.replace(/^node_modules\//,'')),constants.O_RDONLY);try{const h=createHash('sha256');let n,total=0;while((n=readSync(fd,buffer))){h.update(buffer.subarray(0,n));total+=n;}if(total!==file.bytes||'sha256:'+h.digest('hex')!==file.hash)throw new Error('RASTER_CODEC_UNQUALIFIED');}finally{closeSync(fd);} }
  verifyBoundedWebP();
  verifyLinuxColor();
  verifyWebPOutput();
}
export function resourcePlan(width: number, height: number, decode = false, metadataBytes = 0, format = 'png', encodedBytes = 0): ResourcePlan {
  if(!decode)return nonDecodeResourcePlan(width,height,metadataBytes);
  extent(width, height); const rawBytes = width * height * 4;
  const allocations = { nativeDecoderAndColor: format==='webp-bounded'?Math.max(BOUNDED_WEBP_NATIVE_BYTES,BOUNDED_WEBP_COLOR_BYTES):rawBytes * (format==='webp'?5:2) + 32 * MiB, nativeStackAndIO:format==='webp-bounded'?256*1024:0, encodedInput:format==='webp'?4*encodedBytes+MiB:0, rawOutput: rawBytes, orientationRowsAndTiles: 2 * MiB, metadataAndProfileCopies: metadataBytes * 4 + 4 * MiB, pngAndHashIO: 4 * MiB, workerHeapAndRuntime: 80 * MiB, concurrentBackendHeadroom: 16 * MiB };
  // Every task shares the existing backend512MiB ceiling. This is a conservative
  // allocation plan, correlated with whole-process RSS by the supervising worker.
  const reserved={...allocations,activeKernelTelemetry:ACTIVE_COMPUTE_RESERVATION_BYTES};
  return { width, height, rawBytes, allocations:reserved, cpuBytes: Object.values(reserved).reduce((a,b)=>a+b,0), diskBytes: rawBytes * 3 + metadataBytes + 2 * MiB };
}
function inputFD(path: string) {
  assertComponents(dirname(path)); const before=assertPrivate(path,false), fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  if(!sameFile(before,fstatSync(fd))){closeSync(fd);throw new Error('RASTER_INPUT_CHANGED');}return fd;
}
class FilePixels implements Pixels {
  private fd: number; private rows = new Map<number, Buffer>();
  constructor(readonly width: number, readonly height: number, path: string,private active?:ActiveCompute) { this.fd=inputFD(path); if(fstatSync(this.fd).size!==width*height*4){closeSync(this.fd);throw new Error('RASTER_LENGTH');} }
  get(x: number, y: number, into: Float64Array) {
    if (x<0||y<0||x>=this.width||y>=this.height) { into.fill(0); return; }
    let row=this.rows.get(y); if(!row){
      // Callers receive scalar copies, never a row view. Reuse the oldest row's
      // backing store after eviction rather than allocating for every tile miss.
      if(this.rows.size>=32){const oldest=this.rows.keys().next().value!;row=this.rows.get(oldest)!;this.rows.delete(oldest);}else row=Buffer.alloc(this.width*4);
      const target=row,read=()=>readSync(this.fd,target,0,target.length,y*target.length);if((this.active?this.active.exclude(read):read())!==row.length)throw new Error('RASTER_LENGTH');this.rows.set(y,row);
    }
    for(let c=0;c<4;c++)into[c]=row[x*4+c];
  }
  close(){closeSync(this.fd);this.rows.clear();}
}
class FileCoverage {
  private fd:number;private rows=new Map<number,Buffer>();
  constructor(readonly width:number,readonly height:number,path:string,private active?:ActiveCompute){this.fd=inputFD(path);if(fstatSync(this.fd).size!==width*height*2){closeSync(this.fd);throw Error('RASTER_LENGTH');}}
  get(x:number,y:number){if(x<0||y<0||x>=this.width||y>=this.height)return 0;let row=this.rows.get(y);if(!row){if(this.rows.size>=128)this.rows.delete(this.rows.keys().next().value!);row=Buffer.alloc(this.width*2);const target=row,read=()=>readSync(this.fd,target,0,target.length,y*target.length);if((this.active?this.active.exclude(read):read())!==row.length)throw Error('RASTER_LENGTH');this.rows.set(y,row);}return row.readUInt16LE(x*2);}
  close(){closeSync(this.fd);this.rows.clear();}
}
function writeAll(fd: number, bytes: Uint8Array, position: number) { for(let at=0;at<bytes.length;){const n=writeSync(fd,bytes,at,bytes.length-at,position+at);if(!n)throw new Error('RASTER_WRITE');at+=n;} }
function writeTile(fd: number, width: number, rect: Rect, bytes: Uint8Array) { for(let y=0;y<rect.height;y++)writeAll(fd,bytes.subarray(y*rect.width*4,(y+1)*rect.width*4),((rect.y+y)*width+rect.x)*4); }
export function fileRef(path: string, mediaType: string, check:()=>void): BlobRef {
  // Hash through EOF even if the opened file grows; an empty file still gets a nonzero read buffer.
  const fd=inputFD(path);try{const h=createHash('sha256'),b=Buffer.alloc(Math.max(1,Math.min(fstatSync(fd).size,MiB)));let n,total=0;while((n=readSync(fd,b))){check();h.update(b.subarray(0,n));total+=n;}return {hash:'sha256:'+h.digest('hex'),byteLength:String(total),mediaType};}finally{closeSync(fd);}
}
async function tiles(path: string, width: number, height: number, check:()=>void) {
  const fd=inputFD(path), result=[],tile=Buffer.alloc(Math.min(512,width)*Math.min(512,height)*4);try{for(let y=0;y<height;y+=512)for(let x=0;x<width;x+=512){check();const w=Math.min(512,width-x),h=Math.min(512,height-y),b=tile.subarray(0,w*h*4);for(let j=0;j<h;j++)if(readSync(fd,b,j*w*4,w*4,((y+j)*width+x)*4)!==w*4)throw new Error('RASTER_LENGTH');result.push({x,y,width:w,height:h,hash:hash(b)});await new Promise<void>(r=>setImmediate(r));}return result;}finally{closeSync(fd);}
}
function orient(x:number,y:number,w:number,h:number,o:number):[number,number] {
  switch(o){case 2:return [w-1-x,y];case 3:return [w-1-x,h-1-y];case 4:return [x,h-1-y];case 5:return [y,x];case 6:return [y,h-1-x];case 7:return [w-1-y,h-1-x];case 8:return [w-1-y,x];default:return [x,y];}
}
// Heap/external fields belong to this raster worker; RSS remains process-wide.
// These bounded diagnostic samples neither reserve memory nor prove release.
function workerMemory(prefix:'workerStart'|'workerBeforeEncode'|'workerAfterEncode'):Record<string,number>{
  const memory=process.memoryUsage();return {[prefix+'RSS']:memory.rss,[prefix+'HeapTotal']:memory.heapTotal,[prefix+'HeapUsed']:memory.heapUsed,[prefix+'External']:memory.external,[prefix+'ArrayBuffers']:memory.arrayBuffers};
}
export async function runRaster(job: RasterJob, admit:(plan:ResourcePlan)=>Promise<void>, check:()=>void,recorder?:PhaseRecorder,active?:ActiveCompute): Promise<RasterResult> {
  const owned=!active;active??=new ActiveCompute({context:job.telemetry});
  try{return await runRasterOwned(job,admit,check,recorder,active);}finally{if(owned)active.dispose();}
}
async function runRasterOwned(job:RasterJob,admit:(plan:ResourcePlan)=>Promise<void>,check:()=>void,recorder:PhaseRecorder|undefined,active:ActiveCompute):Promise<RasterResult>{
  if(job.type==='derive-original'){verifyCodecs();return runDerivedRaster(job,admit,check,prepareNativeDerived,active,recorder);}
  if(job.type==='encoded-preserve'||job.type==='encoded-compose')return runEncodedRaster(job,admit,check,recorder,active);
  const contextLease=diagnosticMemory.reserve('diagnostic-engine-context',65536);
  try{const traceContext=sanitizePhaseContext(job.telemetry??{}),activePhases:PhaseSpan[]=[];
  const phase=(name:PhaseName,details:PhaseContext={})=>{const span=recorder?.start(name,{...traceContext,...sanitizePhaseContext(details)});if(span)activePhases.push(span);return span;};
  try{
  const started=performance.now(),memoryMetrics=workerMemory('workerStart');verifyCodecs();sharp.cache(false);sharp.concurrency(1);
  const replay='replay' in job?job.replay:undefined,retainedProfile=replay?findRasterProfile(replay.pipeline):undefined;
  if(replay&&(!retainedProfile||!['compose','export','request-source','v45-edit-mask'].includes(job.type)||job.type!=='export'&&replay.encoder!==undefined||replay.encoder!==undefined&&!isKnownRasterEncoder(replay.encoder)))throw Error('RASTER_PROFILE');
  const outputPipeline=retainedProfile?.pipeline??PIPELINE;
  const raw=join(job.directory,'pixels.rgba'),png=join(job.directory,'output.png');
  let width:number,height:number,plan:ResourcePlan,conversion:RasterInfo['conversion']=null,sourceAssetIds:string[],dependencies:readonly BlobRef[],description:unknown;
  let decodeMs=0,computeMs=0;let nativeMetrics:Record<string,number>={};const extra:{name:string;ref:BlobRef}[]=[];
  if(job.type==='solid-background'){
    documentCreationBackground({kind:'solid',color:job.color});({width,height}=job);plan=resourcePlan(width,height);
    plan.allocations.solidBackgroundRow=width*4;plan.cpuBytes=Object.values(plan.allocations).reduce((a,b)=>a+b,0);await admit(plan);
    // One admitted scanline owns the fill. The document-sized raster remains on
    // private disk; neither the worker nor the browser allocates a full grid.
    const row=Buffer.alloc(width*4),fd=openSync(raw,'wx',0o600);
    try{for(let x=0;x<width;x++)for(let c=0;c<4;c++)row[x*4+c]=job.color[c];
      for(let y=0;y<height;y++){check();writeAll(fd,row,y*row.length);if(y%32===0)await new Promise<void>(resolve=>setImmediate(resolve));}fsyncSync(fd);
    }finally{closeSync(fd);}
    sourceAssetIds=[];dependencies=[];description={kind:'solid-background-v1',color:[...job.color]};
  }else if(job.type==='mask'){
    validateMaskPlan(job.plan);({width,height}=job.plan);plan=resourcePlan(width,height);
    plan.allocations.importedMaskRows=job.inputs.reduce((sum,input)=>sum+input.info.width*(Math.min(32,input.info.height)*4+(input.hardPath?Math.min(128,input.info.height)*2:0)),0);
    plan.allocations.maskRows=width*(Math.ceil(job.plan.feather)*2+3)*8+width*16;
    plan.cpuBytes=Object.values(plan.allocations).reduce((a,b)=>a+b,0);plan.diskBytes+=width*height*4;
    await admit(plan);sourceAssetIds=job.inputs.map(i=>i.id);
    const imported=new Map(job.inputs.map(i=>[i.id,new FilePixels(i.info.width,i.info.height,i.path)]));
    const retained=new Map(job.inputs.filter(i=>i.hardPath).map(i=>[i.id,new FileCoverage(i.info.width,i.info.height,i.hardPath!)]));
    const p=new Float64Array(4),hard=authoredCoverage(job.plan,(op,x,y)=>{
      if(op.kind==='retained-hard-v1'){
        const m=op.mask,g=maskGrid(m,0,0),input=imported.get(m.assetId);if(!input||input.width!==g.width||input.height!==g.height)throw Error('MASK_BASELINE_GRID');
        const sx=x-g.x,sy=y-g.y;if(sx<0||sy<0||sx>=g.width||sy>=g.height)return 0;
        let value:number;if(r16Mask(m)){const source=retained.get(m.assetId);if(!source)throw Error('MASK_HARD_MISSING');value=source.get(sx,sy);}else{input.get(sx,sy,p);value=maskCoverage(p);}
        return m.inverted?65535-value:value;
      }
      const input=imported.get(op.assetId);if(!input)throw Error('MASK_IMPORT_MISSING');
      if(x<op.x||y<op.y||x>=op.x+op.width||y>=op.y+op.height)return 0;
      if(input.width!==op.width||input.height!==op.height)throw Error('MASK_ALIGNMENT_RESAMPLE_REQUIRED');
      input.get(x-op.x,y-op.y,p);const value=maskCoverage(p);return op.inverted?65535-value:value;
    });
    const hardPath=join(job.directory,'hard.r16'),effectivePath=join(job.directory,'effective.r16');
    const rawFD=openSync(raw,'wx',0o600),hardFD=openSync(hardPath,'wx',0o600),effectiveFD=openSync(effectivePath,'wx',0o600);
    const row=Buffer.alloc(width*4),hrow=Buffer.alloc(width*2),erow=Buffer.alloc(width*2),effective=featherRows(hard,job.plan.feather);
    let hardPixels=0,effectivePixels=0,lostEffectivePixels=0,left=width,top=height,right=0,bottom=0;
    try{for(let y=0;y<height;y++){
      check();const values=effective(y);
      for(let x=0;x<width;x++){const h=hard.get(x,y),clip=job.request?.clip,clipped=clip&&(x<clip.x||x>=clip.x+clip.width||y<clip.y||y>=clip.y+clip.height),e=clipped?0:values[x];if(clipped&&values[x])lostEffectivePixels++;hrow.writeUInt16LE(h,x*2);erow.writeUInt16LE(e,x*2);row[x*4]=row[x*4+1]=row[x*4+2]=Math.round(e/257);row[x*4+3]=255;if(h)hardPixels++;if(e){effectivePixels++;left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}}
      writeAll(rawFD,row,y*row.length);writeAll(hardFD,hrow,y*hrow.length);writeAll(effectiveFD,erow,y*erow.length);
      if(y%32===0)await new Promise<void>(r=>setImmediate(r));
    }for(const fd of [rawFD,hardFD,effectiveFD])fsyncSync(fd);}finally{for(const fd of [rawFD,hardFD,effectiveFD])closeSync(fd);for(const f of imported.values())f.close();for(const f of retained.values())f.close();}
    const hardRef=fileRef(hardPath,'application/x-ideogram-r16le',check),effectiveRef=fileRef(effectivePath,'application/x-ideogram-r16le',check);
    extra.push({name:'hard.r16',ref:hardRef},{name:'effective.r16',ref:effectiveRef});dependencies=[...job.dependencies,hardRef,effectiveRef];
    description={kind:job.request?'authored-request-mask-v1':job.plan.schemaVersion===2?'authored-mask-v2':'authored-mask-v1',authoring:job.plan,hard:hardRef,effective:effectiveRef,statistics:{hardPixels,effectivePixels,support:effectivePixels?{x:left,y:top,width:right-left,height:bottom-top}:null},...(job.request?{sourceAssetId:job.request.source.id,source:job.request.source.info.manifest,sourcePixels:job.request.source.info.pixels,clip:job.request.clip,lostEffectivePixels}:{})};
  }else if(job.type==='request-mask'||job.type==='v45-edit-mask'){
    validateRequestRasterPlan(job.plan);({width,height}=requestRasterGrid(job.plan));const input=job.input;if(input.info.role!=='mask'||!input.coveragePath||input.info.width!==job.plan.document.width||input.info.height!==job.plan.document.height)throw Error('RASTER_MASK_MAPPING');
    plan=resourcePlan(width,height);plan.allocations.coverageRows=input.info.width*Math.min(128,input.info.height)*2;plan.allocations.outputRow=width*4;plan.cpuBytes=Object.values(plan.allocations).reduce((a,b)=>a+b,0);await admit(plan);
    dependencies=job.dependencies;sourceAssetIds=job.type==='v45-edit-mask'?[job.sourceAssetId,input.id]:[input.id];description={kind:'request-mask-binary-v1',source:input.info.manifest,requestPlan:job.plan};
    if(job.type==='v45-edit-mask'&&(job.sourcePixels.mediaType!=='application/x-ideogram-rgba8'||job.sourcePixels.byteLength!==String(width*height*4)))throw Error('RASTER_SOURCE_MAPPING');
    const source=new FileCoverage(input.info.width,input.info.height,input.coveragePath),fd=openSync(raw,'wx',0o600);let editPixels=0,keepPixels=0;
    try{try{requireRequestCoverage(job.plan,{width:source.width,height:source.height,get:(x,y)=>{if(x===0)check();return source.get(x,y);}});}catch(error){if(job.type==='v45-edit-mask'&&error instanceof Error&&error.message==='EMPTY_MASK')throw Error('RASTER_V45_EDIT_MASK_HOMOGENEOUS');throw error;}for(let y=0;y<height;y++){check();const row=providerMaskRow(job.plan,source,y);
      if(job.type==='v45-edit-mask')for(let x=0;x<width;x++){const at=x*4,value=row[at];if((value!==0&&value!==255)||row[at+1]!==value||row[at+2]!==value||row[at+3]!==255)throw Error('RASTER_V45_EDIT_MASK_BINARY');if(value===255)editPixels++;else keepPixels++;row[at]=row[at+1]=row[at+2]=255-value;}
      writeAll(fd,row,y*row.length);if(y%32===0)await new Promise<void>(r=>setImmediate(r));
    }if(job.type==='v45-edit-mask'&&(!editPixels||!keepPixels))throw Error('RASTER_V45_EDIT_MASK_HOMOGENEOUS');fsyncSync(fd);}finally{source.close();closeSync(fd);}
    if(job.type==='v45-edit-mask')description={kind:'v45-edit-mask-v1',endpoint:'ideogram/v4.5/edit',source:job.source,mask:input.info.manifest,sourcePixels:job.sourcePixels,requestPlan:job.plan,polarity:'black-edit',statistics:{editPixels,keepPixels}};
  }else if(job.type==='request-source'){
    validateRequestRasterPlan(job.plan);({width,height}=requestRasterGrid(job.plan));const input=job.input;if(input.info.role==='mask'||input.info.width!==job.plan.document.width||input.info.height!==job.plan.document.height||canonical(input.info.pixels)!==canonical(job.plan.sourcePixels))throw Error('RASTER_SOURCE_MAPPING');
    plan=resourcePlan(width,height);plan.allocations.sourceRows=input.info.width*Math.min(32,input.info.height)*4;plan.allocations.outputRow=width*4;plan.cpuBytes=Object.values(plan.allocations).reduce((a,b)=>a+b,0);await admit(plan);
    dependencies=job.dependencies;sourceAssetIds=[input.id];description={kind:'request-source-transport-v1',source:input.info.manifest,requestPlan:job.plan};
    const resamplePhase=phase('raster.resample',{assetId:input.id,assetHash:input.info.pixels.hash,width,height,sourceWidth:input.info.width,sourceHeight:input.info.height});
    const source=new FilePixels(input.info.width,input.info.height,input.path,active),fd=openSync(raw,'wx',0o600);try{for(let y=0;y<height;y++){check();const row=active.run('resample',()=>providerSourceRow(job.plan,source,y));writeAll(fd,row,y*row.length);if(y%32===0)await new Promise<void>(r=>setImmediate(r));}fsyncSync(fd);}finally{source.close();closeSync(fd);}
    resamplePhase?.end('ok',{boundary:'observed'});
  }else if(job.type==='preserve-request'){
    validateRequestRasterPlan(job.plan);({width,height}=job.plan.document);if(job.source.info.width!==width||job.source.info.height!==height||canonical(job.source.info.pixels)!==canonical(job.plan.sourcePixels)||job.mask.info.width!==width||job.mask.info.height!==height||!job.mask.coveragePath)throw Error('RASTER_SOURCE_MAPPING');
    plan=resourcePlan(width,height);plan.allocations.sourceRows=width*Math.min(32,height)*4;plan.allocations.candidateRows=job.candidate.info.width*Math.min(32,job.candidate.info.height)*4;plan.allocations.coverageRows=width*Math.min(128,height)*2;plan.allocations.preservationRows=width*36;plan.cpuBytes=Object.values(plan.allocations).reduce((a,b)=>a+b,0);await admit(plan);
    dependencies=job.dependencies;sourceAssetIds=[job.source.id,job.candidate.id,job.mask.id];description={kind:'request-preservation-v1',source:job.source.info.manifest,candidate:job.candidate.info.manifest,mask:job.mask.info.manifest,requestPlan:job.plan,outputMapping:job.outputMapping??null};
    const preservePhase=phase('raster.composite',{assetId:job.candidate.id,width,height});
    const source=inputFD(job.source.path),candidate=new FilePixels(job.candidate.info.width,job.candidate.info.height,job.candidate.path,active),coverage=new FileCoverage(width,height,job.mask.coveragePath,active),fd=openSync(raw,'wx',0o600),sourceRow=Buffer.alloc(width*4);
    try{requireRequestCoverage(job.plan,coverage,job.outputMapping,check);for(let y=0;y<height;y++){check();if(readSync(source,sourceRow,0,sourceRow.length,y*sourceRow.length)!==sourceRow.length)throw Error('RASTER_LENGTH');const row=active.run('preserve',()=>preserveMappedRequestRow(job.plan,sourceRow,candidate,coverage,y,job.outputMapping));writeAll(fd,row,y*row.length);if(y%32===0)await new Promise<void>(r=>setImmediate(r));}fsyncSync(fd);}finally{closeSync(source);candidate.close();coverage.close();closeSync(fd);}
    preservePhase?.end('ok',{boundary:'observed'});
  }else if(job.type==='text'){
    ({width,height}=job);plan=retainedTextResourcePlan(width,height);await admit(plan);dependencies=job.dependencies;sourceAssetIds=[];description={kind:'retained-text',source:job.source};
    const source=inputFD(job.path),target=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);try{const b=Buffer.alloc(Math.min(width*height*4,MiB));let at=0,n;while((n=readSync(source,b))){check();for(let i=0;i<n;i+=4)if(b[i+3]===0&&(b[i]||b[i+1]||b[i+2]))throw new Error('TEXT_TRANSPARENT_RGB');writeAll(target,b.subarray(0,n),at);at+=n;}if(at!==width*height*4)throw new Error('TEXT_PIXEL_LENGTH');fsyncSync(target);}finally{closeSync(source);closeSync(target);}
  }else if(job.type==='decode'){
    const container=await inspectContainer(job.path,job.mediaType,check);check();
    let direct=job.mediaType==='image/webp'?await openWebPFileDecoder():null;
    let color:WebPColorConverter|null=null;
    try{
    if(direct){color=await openWebPColorConverter();if(!color){direct.close();direct=null;}}
    const descriptor=container.webpMetadata;
    if(direct&&!descriptor)throw Error('RASTER_FORMAT');
    const normalizeFrame=Boolean(direct&&descriptor?.alpha&&(descriptor.flags===null||!(descriptor.flags&16)));
    plan=resourcePlan(container.width,container.height,true,container.metadataBytes,direct?'webp-bounded':job.mediaType.slice(6),container.encodedBytes);
    if(normalizeFrame)plan.diskBytes+=webpFrameBytes(descriptor!);
    await admit(plan);check();
    const options={failOn:'warning' as const,limitInputPixels:25000000,sequentialRead:true,ignoreIcc:true};
    const metadata:Pick<Metadata,'format'|'width'|'height'|'space'|'depth'|'orientation'|'icc'|'exif'|'hasAlpha'|'pages'|'delay'|'loop'>=direct?readWebPMetadata(job.path,descriptor!,check):await sharp(job.path,options).metadata();
    if(!['png','jpeg','webp'].includes(metadata.format)||`image/${metadata.format}`!==job.mediaType||metadata.pages&&metadata.pages!==1||metadata.delay||metadata.loop!==undefined)throw new Error('RASTER_ANIMATION');
    if(!['srgb','b-w'].includes(metadata.space)||metadata.depth!=='uchar')throw new Error('RASTER_PROFILE');
    extent(metadata.width,metadata.height);if(metadata.width!==container.width||metadata.height!==container.height)throw new Error('RASTER_EXTENT');
    const orientation=metadata.orientation??1;if(!Number.isInteger(orientation)||orientation<1||orientation>8)throw new Error('RASTER_ORIENTATION');
    const profileHash=metadata.icc?hash(metadata.icc):null;
    if(container.pngMetadata&&(container.pngMetadata.iccHash!==profileHash||container.pngMetadata.exifHash!==(metadata.exif?hash(metadata.exif):null)))throw new Error('RASTER_METADATA');
    let profile:'untagged-srgb'|'srgb'|'p3'='untagged-srgb';
    if(profileHash){if(profileHash===CODECS.profiles.srgb.hash)profile='srgb';else if(profileHash===CODECS.profiles.p3.hash)profile='p3';else throw new Error('RASTER_PROFILE');}
    width=orientation>=5?metadata.height:metadata.width;height=orientation>=5?metadata.width:metadata.height;
    plan={...plan,width,height};check();
    const decodeStart=performance.now(),decodePhase=phase('raster.decode',{assetId:job.sourceAssetId==='portable-validation'?undefined:job.sourceAssetId,assetHash:job.original.hash,width,height});
    if(direct){
      const decoder=direct,path=orientation===1?raw:join(job.directory,'.webp-pixels-'+randomUUID());
      const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600),owned=fstatSync(fd);
      const nativeCheck=()=>{check();if(!sameWebPSource(descriptor!.stamp,lstatSync(job.path,{bigint:true}))||!sameFile(owned,assertPrivate(path,false))||!sameFile(owned,fstatSync(fd)))throw Error('RASTER_INPUT_CHANGED');};
      try{
        const native=normalizeFrame?await decodeWebPFrame(job.path,descriptor!,job.directory,(frame,bytes,stamp)=>decoder.decode(frame,fd,metadata.width,metadata.height,bytes,nativeCheck,undefined,stamp),nativeCheck):decoder.decode(job.path,fd,metadata.width,metadata.height,container.encodedBytes,nativeCheck,undefined,descriptor!.stamp);
        nativeMetrics=native.metrics;
        // Frozen demux band flags can ignore an encoded alpha plane. The RGB
        // bitstream is untouched; bounded file passes preserve hidden RGB.
        if(!metadata.hasAlpha)forceWebPFileAlpha(fd,metadata.width*metadata.height*4,nativeCheck);
        if(profile==='p3'){const metric=await color!.convertFileInPlace(fd,metadata.width*metadata.height*4,metadata.icc!,nativeCheck);nativeMetrics={...nativeMetrics,colorOutputPeak:metric.outputPeak,colorOutputRemaining:metric.outputRemaining};}
        nativeCheck();fsyncSync(fd);
        if(orientation!==1){const target=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);try{const targetOwned=fstatSync(target),targetCheck=()=>{nativeCheck();if(!sameFile(targetOwned,assertPrivate(raw,false))||!sameFile(targetOwned,fstatSync(target)))throw Error('RASTER_INPUT_CHANGED');};orientWebPFile(fd,target,metadata.width,metadata.height,orientation,targetCheck);targetCheck();fsyncSync(target);}finally{closeSync(target);}}
      }finally{closeSync(fd);if(orientation!==1){try{if(sameFile(owned,lstatSync(path)))unlinkSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}}
    }else{
      let decoder=sharp(job.path,{...options,ignoreIcc:profile!=='p3'});
      if(profile==='p3')decoder=decoder.withIccProfile('srgb',{attach:false});
      const decoded=await decoder.toColourspace('srgb').ensureAlpha().raw({depth:'uchar'}).toBuffer({resolveWithObject:true});check();
      if(decoded.info.width!==metadata.width||decoded.info.height!==metadata.height||decoded.info.channels!==4||decoded.data.length!==width*height*4)throw new Error('RASTER_LENGTH');
      const fd=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
      try{if(orientation===1){for(let at=0;at<decoded.data.length;at+=MiB){check();writeAll(fd,decoded.data.subarray(at,at+MiB),at);}}
        else{const row=Buffer.alloc(width*4);for(let y=0;y<height;y++){check();for(let x=0;x<width;x++){const [sx,sy]=orient(x,y,metadata.width,metadata.height,orientation);row.set(decoded.data.subarray((sy*metadata.width+sx)*4,(sy*metadata.width+sx)*4+4),x*4);}writeAll(fd,row,y*row.length);}}fsyncSync(fd);
      }finally{closeSync(fd);}
    }check();decodeMs=performance.now()-decodeStart;
    decodePhase?.end('ok',{boundary:'decoded'});
    if(metadata.icc){const path=join(job.directory,'profile.icc');writeFileSync(path,metadata.icc,{flag:'wx',mode:0o600});extra.push({name:'profile.icc',ref:fileRef(path,'application/vnd.iccprofile',check)});}
    if(metadata.exif){const path=join(job.directory,'original.exif');writeFileSync(path,metadata.exif,{flag:'wx',mode:0o600});extra.push({name:'original.exif',ref:fileRef(path,'application/octet-stream',check)});}
    conversion={encodedWidth:metadata.width,encodedHeight:metadata.height,orientation,profile,profileHash,colorChanged:profile==='p3',orientationChanged:orientation!==1,resized:false};
    sourceAssetIds=[job.sourceAssetId];dependencies=[job.original,...extra.map(f=>f.ref)];description={kind:'decoded-native',sourceAssetId:job.sourceAssetId,conversion,codec:RASTER_CODEC_ID,...(direct?{decodeTransport:'webp-file-v1',decoderBuild:BOUNDED_WEBP.hash,outputBuild:WEBP_OUTPUT.hash}:{})};
    }finally{color?.close();direct?.close();}
  }else if(job.type==='compose'){
    ({width,height}=job);plan=compositionResourcePlan(width,height,job.layers,job.inputs,!!job.requestSource);
    const passthrough=(layer:RasterLayer)=>{const input=job.inputs.find(i=>i.id===layer.assetId);return input&&input.info.width===width&&input.info.height===height&&layer.opacity===1&&layer.mask===null&&layer.transform.every((n,i)=>n===[1,0,0,1,0,0][i])?input:undefined;};
    await admit(plan);dependencies=job.dependencies;sourceAssetIds=job.inputs.map(i=>i.id);
    const maskMapping=(layer:RasterLayer)=>layer.mask&&retainedMask(layer.mask)?'explicit-retained-domain-zero-v1':'document-luminance-alpha-v1';
    const contributionSchema=(layer:RasterLayer):1|2|3=>layer.mask&&retainedMask(layer.mask)?3:layer.mask?.mapping==='document-r16-v1'?2:1;
    const compositionDescription={kind:job.requestSource?'request-source-capture-v1':'cp1-composition',...(job.requestSource?{capture:job.requestSource}:{}),layers:job.layers,maskMapping:job.layers.some(l=>l.mask&&retainedMask(l.mask))?'explicit-retained-domain-zero-v1':'document-luminance-alpha-v1',precision:'binary64',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',footprints:job.layers.map(l=>footprint({x:0,y:0,width,height},l.transform))};
    description=compositionDescription;
    const fd=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);const computeStart=performance.now(),single=job.layers.length===1?job.layers[0]:undefined,computePhase=phase(single&&single.opacity===1&&single.mask===null&&!single.transform.every((n,i)=>n===[1,0,0,1,0,0][i])?'raster.resample':'raster.composite',{width,height,count:job.layers.length});let captureContributes=false;
    const retained:{path:string;name:string|null;fd:number|null}[]=[],retainedByLayer=new Map<string,{path:string;name:string|null;fd:number|null}>();
    try{
      if(job.requestSource)for(const [index,layer] of job.layers.entries()){
        const native=passthrough(layer),prior=retainedByLayer.get(canonical(layer));
        if(prior)retained.push({...prior,fd:null});
        else if(job.layers.length===1)retained.push({path:raw,name:null,fd:null});
        else if(native)retained.push({path:native.path,name:null,fd:null});
        else{const name='contribution-'+index+'.rgba',path=join(job.directory,name);retained.push({path,name,fd:openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600)});}
        if(!prior)retainedByLayer.set(canonical(layer),retained[index]);
      }
      for(let y=0;y<height;y+=128)for(let x=0;x<width;x+=128){check();const rect={x,y,width:Math.min(128,width-x),height:Math.min(128,height-y)},length=rect.width*rect.height*4;let singleton:Uint8Array|undefined;const accumulator=job.layers.length===1?null:active.run('accumulator',()=>new Float64Array(length));
        for(const [index,layer] of job.layers.entries()){check();const input=job.inputs.find(i=>i.id===layer.assetId);if(!input)throw new Error('RASTER_INPUT');
          if(input.info.role==='mask')throw Error('RASTER_MASK_AS_IMAGE');
          const source=new FilePixels(input.info.width,input.info.height,input.path,active);let mask:FilePixels|undefined,maskR16:FileCoverage|undefined;
          try{if(layer.mask){const m=job.inputs.find(i=>i.id===layer.mask!.assetId),g=maskGrid(layer.mask,width,height);if(!m||m.info.width!==g.width||m.info.height!==g.height)throw new Error('RASTER_MASK');if(r16Mask(layer.mask)){if(m.info.role!=='mask'||!m.coveragePath)throw Error('RASTER_MASK_MAPPING');maskR16=new FileCoverage(g.width,g.height,m.coveragePath,active);}else{if(m.info.role==='mask')throw Error('RASTER_MASK_MAPPING');mask=new FilePixels(g.width,g.height,m.path,active);}}
            const p=new Float64Array(4),coverage=(mask||maskR16!==undefined)?{width,height,get:(mx:number,my:number)=>{const m=layer.mask!,g=maskGrid(m,width,height),x=mx-g.x,y=my-g.y;if(retainedMask(m)&&(x<0||y<0||x>=g.width||y>=g.height))return 0;let value:number;if(maskR16!==undefined){value=maskR16.get(x,y);}else{mask!.get(x,y,p);value=maskCoverage(p);}return m.inverted?65535-value:value;}}:undefined;
            const k=active.run('contribution',()=>contribution(source,rect,layer.transform,layer.opacity,coverage)),target=retained[index];
            if(target?.fd!==null&&target?.fd!==undefined)writeTile(target.fd,width,rect,k);
            if(accumulator)active.run('fold',()=>fold(accumulator,k));else singleton=k;
          }finally{source.close();mask?.close();maskR16?.close();}
        }const output=singleton??active.run('finish',()=>finish(accumulator!));if(job.requestSource&&!captureContributes)active.run('coverage-scan',()=>{for(let i=3;i<output.length;i+=4)if(output[i]){captureContributes=true;break;}});writeTile(fd,width,rect,output);await new Promise<void>(r=>setImmediate(r));
      }
      if(job.requestSource&&!captureContributes)throw Error('RASTER_SOURCE_EMPTY');
      fsyncSync(fd);for(const target of retained)if(target.fd!==null)fsyncSync(target.fd);
    }finally{closeSync(fd);for(const target of retained)if(target.fd!==null)closeSync(target.fd);}
    if(job.requestSource){
      const contributions:{manifest:BlobRef;pixels:BlobRef;pixelIdentity:string}[]=[],retainedFiles=new Set<string>();
      const outputPixels=fileRef(raw,'application/x-ideogram-rgba8',check);
      const metadata=(name:string,value:unknown)=>{const bytes=Buffer.from(canonical(value));if(bytes.length>65536)throw Error('RASTER_RESOURCES');const ref={hash:hash(bytes),byteLength:String(bytes.length),mediaType:'application/json'};if(!retainedFiles.has(ref.hash)){writeFileSync(join(job.directory,name),bytes,{flag:'wx',mode:0o600});extra.push({name,ref});retainedFiles.add(ref.hash);}return ref;};
      for(const [index,layer] of job.layers.entries()){
        check();const target=retained[index],pixels=fileRef(target.path,'application/x-ideogram-rgba8',check),tileList=await tiles(target.path,width,height,check);
        if(target.name&&pixels.hash!==outputPixels.hash&&!retainedFiles.has(pixels.hash)){extra.push({name:target.name,ref:pixels});retainedFiles.add(pixels.hash);}
        const input=job.inputs.find(i=>i.id===layer.assetId)!,mask=layer.mask?job.inputs.find(i=>i.id===layer.mask!.assetId)!:null;
        const manifest:RasterManifest={schemaVersion:contributionSchema(layer),pipeline:outputPipeline,width,height,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:tileList,dependencies:[input.info.manifest,...(mask?[mask.info.manifest]:[])],plan:{kind:'cp1-layer-contribution-v1',layer,source:input.info.manifest,mask:mask?.info.manifest??null,maskMapping:maskMapping(layer),precision:'binary64',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',footprint:compositionDescription.footprints[index]}};
        const ref=metadata('contribution-'+index+'.json',manifest),pixelIdentity=hash(canonical({pipeline:outputPipeline,width,height,tiles:tileList}));
        contributions.push({manifest:ref,pixels,pixelIdentity});
      }
      const stack=metadata('contributions.json',{schemaVersion:1,kind:'cp1-contribution-stack-v1',pipeline:outputPipeline,width,height,contributions});
      description={...compositionDescription,contributions:stack};dependencies=[stack,job.requestSource.image.state];
    }
    computeMs=performance.now()-computeStart;computePhase?.end('ok',{boundary:'observed'});
  }else{
    if(job.options)exportOptions(job.options,false);
    const processed=job.options?.format==='jpeg'||job.options?.resize!==undefined&&job.options.resize!==null&&(job.options.resize.width!==job.input.info.width||job.options.resize.height!==job.input.info.height);
    if(replay&&(processed&&replay.encoder!==undefined&&replay.encoder!==retainedProfile!.codecId||!processed&&replay.pipeline!==job.input.info.pipeline))throw Error('RASTER_PROFILE');
    const encoder=replay?.encoder??retainedProfile?.codecId??CODEC_ID;
    ({width,height}=job.options?.resize??job.input.info);plan=resourcePlan(width,height);
    if(job.options?.format==='jpeg'){const jpegPlan=jpegAllocationPlan(width,height,job.encoderTransport);plan.allocations.jpegInputColorAndEncoder=jpegPlan.cpuBytes;plan.cpuBytes=Object.values(plan.allocations).reduce((a,b)=>a+b,0);plan.diskBytes=Math.max(plan.diskBytes,jpegPlan.diskBytes);}
    await admit(plan);dependencies=job.dependencies;sourceAssetIds=[job.input.id];
    description=processed?{kind:'frozen-image-export-v1',sourceAssetId:job.input.id,pixelIdentity:job.input.info.pixelIdentity,sourceWidth:job.input.info.width,sourceHeight:job.input.info.height,options:job.options,encoder,...(job.options?.format==='jpeg'&&job.encoderTransport!=='jpeg-raw-optimized-v1'?{encoderTransport:JPEG_FILE_TRANSPORT}:{}),kernel:'triangle-area-source-axis-row-norm-v1',matteComposition:'linear-srgb-source-over-opaque-v1'}:{kind:'frozen-png-export',sourceAssetId:job.input.id,pixelIdentity:job.input.info.pixelIdentity,encoder};
    if(!processed){const source=inputFD(job.input.path),target=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);try{const b=Buffer.alloc(MiB);let at=0,n;while((n=readSync(source,b))){check();writeAll(target,b.subarray(0,n),at);at+=n;}if(at!==width*height*4)throw new Error('RASTER_LENGTH');fsyncSync(target);}finally{closeSync(source);closeSync(target);}}
    else if(job.options?.format==='jpeg'&&width===job.input.info.width&&height===job.input.info.height){
      const source=inputFD(job.input.path),computeStart=performance.now(),exportPhase=phase('raster.composite',{assetId:job.input.id,width,height,sourceWidth:job.input.info.width,sourceHeight:job.input.info.height});let target:number|undefined;
      const matte=[1,3,5].map(i=>linear(parseInt(job.options!.matte!.slice(i,i+2),16)/255));
      try{
        if(fstatSync(source).size!==width*height*4)throw Error('RASTER_LENGTH');
        target=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);const row=Buffer.alloc(width*4);
        for(let y=0;y<height;y++){
          check();if(readSync(source,row,0,row.length,y*row.length)!==row.length)throw Error('RASTER_LENGTH');
          // Identity contribution copies the same four source channels. Apply
          // the retained matte arithmetic in the same order, then reuse this
          // owned row only after the synchronous write consumes it.
          active.run('matte',()=>{for(let i=0;i<row.length;i+=4){const alpha=row[i+3]/255;for(let c=0;c<3;c++)row[i+c]=q8(srgb(linear(row[i+c]/255)*alpha+matte[c]*(1-alpha)));row[i+3]=255;}});
          writeAll(target,row,y*row.length);await new Promise<void>(r=>setImmediate(r));
        }
        fsyncSync(target);
      }finally{closeSync(source);if(target!==undefined)closeSync(target);}computeMs=performance.now()-computeStart;exportPhase?.end('ok',{boundary:'observed'});
    }
    else{
      const source=new FilePixels(job.input.info.width,job.input.info.height,job.input.path,active),computeStart=performance.now(),exportPhase=phase(width!==job.input.info.width||height!==job.input.info.height?'raster.resample':'raster.composite',{assetId:job.input.id,width,height,sourceWidth:job.input.info.width,sourceHeight:job.input.info.height});let target:number|undefined;
      const transform=[width/source.width,0,0,height/source.height,0,0] as const,matte=job.options?.format==='jpeg'?[1,3,5].map(i=>linear(parseInt(job.options!.matte!.slice(i,i+2),16)/255)):null;
      try{target=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);for(let y=0;y<height;y+=128)for(let x=0;x<width;x+=128){check();const rect={x,y,width:Math.min(128,width-x),height:Math.min(128,height-y)},bytes=active.run('contribution',()=>contribution(source,rect,transform,1));
        if(matte)active.run('matte',()=>{for(let i=0;i<bytes.length;i+=4){const alpha=bytes[i+3]/255;for(let c=0;c<3;c++)bytes[i+c]=q8(srgb(linear(bytes[i+c]/255)*alpha+matte[c]*(1-alpha)));bytes[i+3]=255;}});
        writeTile(target,width,rect,bytes);await new Promise<void>(r=>setImmediate(r));}fsyncSync(target);
      }finally{source.close();if(target!==undefined)closeSync(target);}computeMs=performance.now()-computeStart;exportPhase?.end('ok',{boundary:'observed'});
    }
  }
  const pixels=fileRef(raw,'application/x-ideogram-rgba8',check),tileList=await tiles(raw,width,height,check);
  const unchangedExport=job.type==='export'&&job.options?.format!=='jpeg'&&width===job.input.info.width&&height===job.input.info.height;
  const pipeline=unchangedExport?job.input.info.pipeline:outputPipeline;
  const pixelIdentity=hash(canonical({pipeline,width,height,tiles:tileList}));
  if(unchangedExport&&pixelIdentity!==job.input.info.pixelIdentity)throw new Error('RASTER_IDENTITY');
  const manifest:RasterManifest={schemaVersion:job.type==='mask'&&job.plan.schemaVersion===2||job.type==='compose'&&job.layers.some(l=>l.mask&&retainedMask(l.mask))?3:job.type==='mask'||job.type==='compose'&&job.layers.some(l=>l.mask?.mapping==='document-r16-v1')?2:1,pipeline,width,height,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:tileList,dependencies,plan:description};
  const manifestBytes=Buffer.from(canonical(manifest));if(manifestBytes.length>65536)throw new Error('RASTER_RESOURCES');
  const manifestPath=join(job.directory,'manifest.json');writeFileSync(manifestPath,manifestBytes,{flag:'wx',mode:0o600});
  const jpeg=job.type==='export'&&job.options?.format==='jpeg',output=jpeg?join(job.directory,'output.jpeg'):png;
  const manifestRef=fileRef(manifestPath,'application/json',check),encodeStart=performance.now(),encodePhase=phase('raster.encode',{width,height});Object.assign(memoryMetrics,workerMemory('workerBeforeEncode'));if(jpeg)await encodeJPEG(raw,output,width,height,job.options!.quality!,check,job.encoderTransport);else await encodePNG(raw,output,width,height,check);const encodeMs=performance.now()-encodeStart;Object.assign(memoryMetrics,workerMemory('workerAfterEncode'));encodePhase?.end('ok',{boundary:'observed'});
  const pngRef=fileRef(output,jpeg?'image/jpeg':'image/png',check);
  const info:RasterInfo={schemaVersion:job.type==='mask'?(job.plan.schemaVersion===2?3:2):1,pipeline,width,height,manifest:manifestRef,pixels,pixelIdentity,role:job.type==='mask'?'mask':job.type==='decode'?'native':job.type==='export'?'export':'composite',sourceAssetIds,conversion};
  active.finish();return {files:[{name:'pixels.rgba',ref:pixels},{name:'manifest.json',ref:manifestRef},{name:jpeg?'output.jpeg':'output.png',ref:pngRef},...extra],png:pngRef,info,manifest,plan,metrics:{elapsedMs:performance.now()-started,decodeMs,computeMs,encodeMs,rss:process.memoryUsage().rss,maxRSS:process.resourceUsage().maxRSS*1024,...nativeMetrics,...memoryMetrics}};
  }catch(error){active.finish('failed');for(const span of activePhases)span.end('error');throw error;}
  }finally{contextLease.release();}
}
