import {maskGrid,retainedMask,r16Mask} from '../../src/raster/mapping.js';
import { authoredCoverage, featherRows, validateMaskPlan, type MaskPlan } from '../../src/raster/mask.js';
import { openSync, closeSync, readSync, writeSync, fsyncSync, fstatSync, constants, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { CODECS, CODEC_ID } from './codec-platform.js';
import { encodePNG } from './png.js';
import { inspectContainer } from './container.js';
import { extent, contribution, fold, finish, maskCoverage, footprint, PIXEL_PIPELINE, coefficient } from '../../src/raster/core.js';
import type { Pixels, Rect } from '../../src/raster/core.js';
import type { BlobRef } from '../../src/protocol/store.js';
import type { RasterLayer, RasterManifest, RasterInfo } from '../../src/protocol/raster.js';
import { canonical } from '../../src/protocol/json.js';
import { assertComponents, assertPrivate, sameFile } from '../storage/files.js';

const MiB = 1024 * 1024;
export const PIPELINE = PIXEL_PIPELINE + '/' + CODEC_ID;
export const hash = (bytes: Uint8Array | string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export type InputRaster = { id: string; info: RasterInfo; path: string; coveragePath?:string;hardPath?:string };
export type RasterJob = { directory: string } & (
  | { type:'mask'; plan:MaskPlan; inputs:readonly InputRaster[]; dependencies:readonly BlobRef[] }
  | { type:'request-mask'; input:InputRaster; width:number; height:number; dependencies:readonly BlobRef[] }
  | { type:'text'; path:string; width:number;height:number; source:BlobRef;dependencies:readonly BlobRef[] }
  | { type: 'decode'; path: string; mediaType: string; original: BlobRef; sourceAssetId: string }
  | { type: 'compose'; width: number; height: number; layers: readonly RasterLayer[]; inputs: readonly InputRaster[]; dependencies: readonly BlobRef[] }
  | { type: 'export'; input: InputRaster; dependencies: readonly BlobRef[] }
);
export type ResourcePlan = { width: number; height: number; rawBytes: number; allocations: Record<string, number>; cpuBytes: number; diskBytes: number };
export type RasterResult = { files: readonly { name: string; ref: BlobRef }[]; png: BlobRef; info: RasterInfo; manifest: RasterManifest; plan: ResourcePlan; metrics: Record<string, number> };
export function verifyCodecs(): void {
  if (process.versions.node !== CODECS.node || process.versions.zlib !== CODECS.zlib || process.platform !== CODECS.platform || process.arch !== CODECS.arch || canonical(sharp.versions) !== canonical(CODECS.versions)) throw new Error('RASTER_CODEC_UNQUALIFIED');
  const require = createRequire(import.meta.url);
  const root = dirname(dirname(dirname(require.resolve('sharp'))));
  const buffer=Buffer.alloc(MiB);
  for (const file of CODECS.files) { const fd=openSync(join(root,file.path.replace(/^node_modules\//,'')),constants.O_RDONLY);try{const h=createHash('sha256');let n,total=0;while((n=readSync(fd,buffer))){h.update(buffer.subarray(0,n));total+=n;}if(total!==file.bytes||'sha256:'+h.digest('hex')!==file.hash)throw new Error('RASTER_CODEC_UNQUALIFIED');}finally{closeSync(fd);} }
}
export function resourcePlan(width: number, height: number, decode = false, metadataBytes = 0, format = 'png'): ResourcePlan {
  extent(width, height); const rawBytes = width * height * 4;
  const allocations = decode ? { nativeDecoderAndColor: rawBytes * (format==='webp'?5:2) + 32 * MiB, rawOutput: rawBytes, orientationRowsAndTiles: 2 * MiB, metadataAndProfileCopies: metadataBytes * 4 + 4 * MiB, pngAndHashIO: 4 * MiB, workerHeapAndRuntime: 80 * MiB, concurrentBackendHeadroom: 16 * MiB } :
    { nativeDecoderAndColor: 0, rawOutput: 0, orientationRowsAndTiles: 8 * MiB, metadataAndProfileCopies: 4 * MiB, pngAndHashIO: 4 * MiB, workerHeapAndRuntime: 80 * MiB, concurrentBackendHeadroom: 16 * MiB };
  // Every task shares the existing backend512MiB ceiling. This is a conservative
  // allocation plan, correlated with whole-process RSS by the supervising worker.
  return { width, height, rawBytes, allocations, cpuBytes: Object.values(allocations).reduce((a,b)=>a+b,0), diskBytes: rawBytes * 3 + metadataBytes + 2 * MiB };
}
function inputFD(path: string) {
  assertComponents(dirname(path)); const before=assertPrivate(path,false), fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  if(!sameFile(before,fstatSync(fd))){closeSync(fd);throw new Error('RASTER_INPUT_CHANGED');}return fd;
}
class FilePixels implements Pixels {
  private fd: number; private rows = new Map<number, Buffer>();
  constructor(readonly width: number, readonly height: number, path: string) { this.fd=inputFD(path); if(fstatSync(this.fd).size!==width*height*4){closeSync(this.fd);throw new Error('RASTER_LENGTH');} }
  get(x: number, y: number, into: Float64Array) {
    if (x<0||y<0||x>=this.width||y>=this.height) { into.fill(0); return; }
    let row=this.rows.get(y); if(!row){if(this.rows.size>=32)this.rows.delete(this.rows.keys().next().value!);row=Buffer.alloc(this.width*4);if(readSync(this.fd,row,0,row.length,y*row.length)!==row.length)throw new Error('RASTER_LENGTH');this.rows.set(y,row);}
    for(let c=0;c<4;c++)into[c]=row[x*4+c];
  }
  close(){closeSync(this.fd);this.rows.clear();}
}
class FileCoverage {
  private fd:number;private rows=new Map<number,Buffer>();
  constructor(readonly width:number,readonly height:number,path:string){this.fd=inputFD(path);if(fstatSync(this.fd).size!==width*height*2){closeSync(this.fd);throw Error('RASTER_LENGTH');}}
  get(x:number,y:number){if(x<0||y<0||x>=this.width||y>=this.height)return 0;let row=this.rows.get(y);if(!row){if(this.rows.size>=128)this.rows.delete(this.rows.keys().next().value!);row=Buffer.alloc(this.width*2);if(readSync(this.fd,row,0,row.length,y*row.length)!==row.length)throw Error('RASTER_LENGTH');this.rows.set(y,row);}return row.readUInt16LE(x*2);}
  close(){closeSync(this.fd);this.rows.clear();}
}
function writeAll(fd: number, bytes: Uint8Array, position: number) { for(let at=0;at<bytes.length;){const n=writeSync(fd,bytes,at,bytes.length-at,position+at);if(!n)throw new Error('RASTER_WRITE');at+=n;} }
function writeTile(fd: number, width: number, rect: Rect, bytes: Uint8Array) { for(let y=0;y<rect.height;y++)writeAll(fd,bytes.subarray(y*rect.width*4,(y+1)*rect.width*4),((rect.y+y)*width+rect.x)*4); }
export function fileRef(path: string, mediaType: string, check:()=>void): BlobRef {
  const fd=inputFD(path);try{const h=createHash('sha256'),b=Buffer.alloc(MiB);let n,total=0;while((n=readSync(fd,b))){check();h.update(b.subarray(0,n));total+=n;}return {hash:'sha256:'+h.digest('hex'),byteLength:String(total),mediaType};}finally{closeSync(fd);}
}
async function tiles(path: string, width: number, height: number, check:()=>void) {
  const fd=inputFD(path), result=[];try{for(let y=0;y<height;y+=512)for(let x=0;x<width;x+=512){check();const w=Math.min(512,width-x),h=Math.min(512,height-y),b=Buffer.alloc(w*h*4);for(let j=0;j<h;j++)if(readSync(fd,b,j*w*4,w*4,((y+j)*width+x)*4)!==w*4)throw new Error('RASTER_LENGTH');result.push({x,y,width:w,height:h,hash:hash(b)});await new Promise<void>(r=>setImmediate(r));}return result;}finally{closeSync(fd);}
}
function orient(x:number,y:number,w:number,h:number,o:number):[number,number] {
  switch(o){case 2:return [w-1-x,y];case 3:return [w-1-x,h-1-y];case 4:return [x,h-1-y];case 5:return [y,x];case 6:return [y,h-1-x];case 7:return [w-1-y,h-1-x];case 8:return [w-1-y,x];default:return [x,y];}
}
export async function runRaster(job: RasterJob, admit:(plan:ResourcePlan)=>Promise<void>, check:()=>void): Promise<RasterResult> {
  const started=performance.now();verifyCodecs();sharp.cache(false);sharp.concurrency(1);
  const raw=join(job.directory,'pixels.rgba'),png=join(job.directory,'output.png');
  let width:number,height:number,plan:ResourcePlan,conversion:RasterInfo['conversion']=null,sourceAssetIds:string[],dependencies:readonly BlobRef[],description:unknown;
  let decodeMs=0,computeMs=0;const extra:{name:string;ref:BlobRef}[]=[];
  if(job.type==='mask'){
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
    let hardPixels=0,effectivePixels=0,left=width,top=height,right=0,bottom=0;
    try{for(let y=0;y<height;y++){
      check();const values=effective(y);
      for(let x=0;x<width;x++){const h=hard.get(x,y),e=values[x];hrow.writeUInt16LE(h,x*2);erow.writeUInt16LE(e,x*2);row[x*4]=row[x*4+1]=row[x*4+2]=Math.round(e/257);row[x*4+3]=255;if(h)hardPixels++;if(e){effectivePixels++;left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}}
      writeAll(rawFD,row,y*row.length);writeAll(hardFD,hrow,y*hrow.length);writeAll(effectiveFD,erow,y*erow.length);
      if(y%32===0)await new Promise<void>(r=>setImmediate(r));
    }for(const fd of [rawFD,hardFD,effectiveFD])fsyncSync(fd);}finally{for(const fd of [rawFD,hardFD,effectiveFD])closeSync(fd);for(const f of imported.values())f.close();for(const f of retained.values())f.close();}
    const hardRef=fileRef(hardPath,'application/x-ideogram-r16le',check),effectiveRef=fileRef(effectivePath,'application/x-ideogram-r16le',check);
    extra.push({name:'hard.r16',ref:hardRef},{name:'effective.r16',ref:effectiveRef});dependencies=[...job.dependencies,hardRef,effectiveRef];
    description={kind:job.plan.schemaVersion===2?'authored-mask-v2':'authored-mask-v1',authoring:job.plan,hard:hardRef,effective:effectiveRef,statistics:{hardPixels,effectivePixels,support:effectivePixels?{x:left,y:top,width:right-left,height:bottom-top}:null}};
  }else if(job.type==='request-mask'){
    ({width,height}=job);extent(width,height);const input=job.input;if(input.info.role!=='mask'||!input.coveragePath)throw Error('RASTER_MASK_MAPPING');
    plan=resourcePlan(width,height);plan.allocations.coverageRows=input.info.width*Math.min(128,input.info.height)*2;plan.allocations.outputRow=width*4;plan.cpuBytes=Object.values(plan.allocations).reduce((a,b)=>a+b,0);await admit(plan);
    dependencies=job.dependencies;sourceAssetIds=[input.id];description={kind:'request-mask-resize',source:input.info.manifest,from:{width:input.info.width,height:input.info.height},mapping:'stretch',kernel:'triangle-area-r16-linear-v1'};
    const source=new FileCoverage(input.info.width,input.info.height,input.coveragePath),fd=openSync(raw,'wx',0o600),row=Buffer.alloc(width*4),sx=input.info.width/width,sy=input.info.height/height,spanX=Math.max(1,sx),spanY=Math.max(1,sy),supportX=sx>1?sx/2+1:1,supportY=sy>1?sy/2+1:1;
    try{for(let y=0;y<height;y++){check();const cy=(y+.5)*sy;for(let x=0;x<width;x++){const cx=(x+.5)*sx;let value=0;for(let iy=Math.floor(cy-supportY-.5);iy<=Math.ceil(cy+supportY-.5);iy++)for(let ix=Math.floor(cx-supportX-.5);ix<=Math.ceil(cx+supportX-.5);ix++)value+=source.get(ix,iy)*coefficient(cx,ix,spanX)*coefficient(cy,iy,spanY);const v=Math.max(0,Math.min(255,Math.round(value/257)));row[x*4]=row[x*4+1]=row[x*4+2]=v;row[x*4+3]=255;}writeAll(fd,row,y*row.length);if(y%32===0)await new Promise<void>(r=>setImmediate(r));}fsyncSync(fd);}finally{source.close();closeSync(fd);}
  }else if(job.type==='text'){
    ({width,height}=job);plan=resourcePlan(width,height);await admit(plan);dependencies=job.dependencies;sourceAssetIds=[];description={kind:'retained-text',source:job.source};
    const source=inputFD(job.path),target=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);try{const b=Buffer.alloc(MiB);let at=0,n;while((n=readSync(source,b))){check();for(let i=0;i<n;i+=4)if(b[i+3]===0&&(b[i]||b[i+1]||b[i+2]))throw new Error('TEXT_TRANSPARENT_RGB');writeAll(target,b.subarray(0,n),at);at+=n;}if(at!==width*height*4)throw new Error('TEXT_PIXEL_LENGTH');fsyncSync(target);}finally{closeSync(source);closeSync(target);}
  }else if(job.type==='decode'){
    const container=await inspectContainer(job.path,job.mediaType,check);check();
    plan=resourcePlan(container.width,container.height,true,container.metadataBytes,job.mediaType.slice(6));await admit(plan);check();
    const options={failOn:'warning' as const,limitInputPixels:25000000,sequentialRead:true,ignoreIcc:true};
    const metadata=await sharp(job.path,options).metadata();
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
    const decodeStart=performance.now();
    let decoder=sharp(job.path,{...options,ignoreIcc:profile!=='p3'});
    if(profile==='p3')decoder=decoder.withIccProfile('srgb',{attach:false});
    const decoded=await decoder.toColourspace('srgb').ensureAlpha().raw({depth:'uchar'}).toBuffer({resolveWithObject:true});check();decodeMs=performance.now()-decodeStart;
    if(decoded.info.width!==metadata.width||decoded.info.height!==metadata.height||decoded.info.channels!==4||decoded.data.length!==width*height*4)throw new Error('RASTER_LENGTH');
    const fd=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
    try{if(orientation===1){for(let at=0;at<decoded.data.length;at+=MiB){check();writeAll(fd,decoded.data.subarray(at,at+MiB),at);}}
      else{const row=Buffer.alloc(width*4);for(let y=0;y<height;y++){check();for(let x=0;x<width;x++){const [sx,sy]=orient(x,y,metadata.width,metadata.height,orientation);row.set(decoded.data.subarray((sy*metadata.width+sx)*4,(sy*metadata.width+sx)*4+4),x*4);}writeAll(fd,row,y*row.length);}}fsyncSync(fd);
    }finally{closeSync(fd);}
    if(metadata.icc){const path=join(job.directory,'profile.icc');writeFileSync(path,metadata.icc,{flag:'wx',mode:0o600});extra.push({name:'profile.icc',ref:fileRef(path,'application/vnd.iccprofile',check)});}
    if(metadata.exif){const path=join(job.directory,'original.exif');writeFileSync(path,metadata.exif,{flag:'wx',mode:0o600});extra.push({name:'original.exif',ref:fileRef(path,'application/octet-stream',check)});}
    conversion={encodedWidth:metadata.width,encodedHeight:metadata.height,orientation,profile,profileHash,colorChanged:profile==='p3',orientationChanged:orientation!==1,resized:false};
    sourceAssetIds=[job.sourceAssetId];dependencies=[job.original,...extra.map(f=>f.ref)];description={kind:'decoded-native',sourceAssetId:job.sourceAssetId,conversion,codec:CODEC_ID};
  }else if(job.type==='compose'){
    ({width,height}=job);plan=resourcePlan(width,height);
    plan.allocations.retainedInputRows=Math.max(0,...job.layers.map(l=>{const source=job.inputs.find(i=>i.id===l.assetId),mask=job.inputs.find(i=>i.id===l.mask?.assetId);return (source?source.info.width*Math.min(32,source.info.height)*4:0)+(mask?mask.info.width*Math.min(mask.info.role==='mask'?128:32,mask.info.height)*(mask.info.role==='mask'?2:4):0);}));
    plan.cpuBytes=Object.values(plan.allocations).reduce((a,b)=>a+b,0);await admit(plan);dependencies=job.dependencies;sourceAssetIds=job.inputs.map(i=>i.id);
    if(job.layers.length>100)throw new Error('RASTER_LAYERS');
    description={kind:'cp1-composition',layers:job.layers,maskMapping:job.layers.some(l=>l.mask&&retainedMask(l.mask))?'explicit-retained-domain-zero-v1':'document-luminance-alpha-v1',precision:'binary64',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',footprints:job.layers.map(l=>footprint({x:0,y:0,width,height},l.transform))};
    const fd=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);const computeStart=performance.now();
    try{for(let y=0;y<height;y+=128)for(let x=0;x<width;x+=128){check();const rect={x,y,width:Math.min(128,width-x),height:Math.min(128,height-y)},length=rect.width*rect.height*4;let singleton:Uint8Array|undefined;const accumulator=job.layers.length===1?null:new Float64Array(length);
      for(const layer of job.layers){check();const input=job.inputs.find(i=>i.id===layer.assetId);if(!input)throw new Error('RASTER_INPUT');
        if(input.info.role==='mask')throw Error('RASTER_MASK_AS_IMAGE');
        const source=new FilePixels(input.info.width,input.info.height,input.path);let mask:FilePixels|undefined,maskR16:FileCoverage|undefined;
        try{if(layer.mask){const m=job.inputs.find(i=>i.id===layer.mask!.assetId),g=maskGrid(layer.mask,width,height);if(!m||m.info.width!==g.width||m.info.height!==g.height)throw new Error('RASTER_MASK');if(r16Mask(layer.mask)){if(m.info.role!=='mask'||!m.coveragePath)throw Error('RASTER_MASK_MAPPING');maskR16=new FileCoverage(g.width,g.height,m.coveragePath);}else{if(m.info.role==='mask')throw Error('RASTER_MASK_MAPPING');mask=new FilePixels(g.width,g.height,m.path);}}
          const p=new Float64Array(4),coverage=(mask||maskR16!==undefined)?{width,height,get:(mx:number,my:number)=>{const m=layer.mask!,g=maskGrid(m,width,height),x=mx-g.x,y=my-g.y;if(retainedMask(m)&&(x<0||y<0||x>=g.width||y>=g.height))return 0;let value:number;if(maskR16!==undefined){value=maskR16.get(x,y);}else{mask!.get(x,y,p);value=maskCoverage(p);}return m.inverted?65535-value:value;}}:undefined;
          const k=contribution(source,rect,layer.transform,layer.opacity,coverage);if(accumulator)fold(accumulator,k);else singleton=k;
        }finally{source.close();mask?.close();maskR16?.close();}
      }writeTile(fd,width,rect,singleton??finish(accumulator!));await new Promise<void>(r=>setImmediate(r));
    }fsyncSync(fd);}finally{closeSync(fd);}computeMs=performance.now()-computeStart;
  }else{
    ({width,height}=job.input.info);plan=resourcePlan(width,height);await admit(plan);dependencies=job.dependencies;sourceAssetIds=[job.input.id];description={kind:'frozen-png-export',sourceAssetId:job.input.id,pixelIdentity:job.input.info.pixelIdentity,encoder:CODEC_ID};
    const source=inputFD(job.input.path),target=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);try{const b=Buffer.alloc(MiB);let at=0,n;while((n=readSync(source,b))){check();writeAll(target,b.subarray(0,n),at);at+=n;}if(at!==width*height*4)throw new Error('RASTER_LENGTH');fsyncSync(target);}finally{closeSync(source);closeSync(target);}
  }
  const pixels=fileRef(raw,'application/x-ideogram-rgba8',check),tileList=await tiles(raw,width,height,check);
  const pipeline=job.type==='export'?job.input.info.pipeline:PIPELINE;
  const pixelIdentity=hash(canonical({pipeline,width,height,tiles:tileList}));
  if(job.type==='export'&&pixelIdentity!==job.input.info.pixelIdentity)throw new Error('RASTER_IDENTITY');
  const manifest:RasterManifest={schemaVersion:job.type==='mask'&&job.plan.schemaVersion===2||job.type==='compose'&&job.layers.some(l=>l.mask&&retainedMask(l.mask))?3:job.type==='mask'||job.type==='compose'&&job.layers.some(l=>l.mask?.mapping==='document-r16-v1')?2:1,pipeline,width,height,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:tileList,dependencies,plan:description};
  const manifestBytes=Buffer.from(canonical(manifest));if(manifestBytes.length>65536)throw new Error('RASTER_RESOURCES');
  const manifestPath=join(job.directory,'manifest.json');writeFileSync(manifestPath,manifestBytes,{flag:'wx',mode:0o600});
  const manifestRef=fileRef(manifestPath,'application/json',check),encodeStart=performance.now();await encodePNG(raw,png,width,height,check);const encodeMs=performance.now()-encodeStart;
  const pngRef=fileRef(png,'image/png',check);
  const info:RasterInfo={schemaVersion:job.type==='mask'?(job.plan.schemaVersion===2?3:2):1,pipeline,width,height,manifest:manifestRef,pixels,pixelIdentity,role:job.type==='mask'?'mask':job.type==='decode'?'native':job.type==='compose'||job.type==='text'||job.type==='request-mask'?'composite':'export',sourceAssetIds,conversion};
  return {files:[{name:'pixels.rgba',ref:pixels},{name:'manifest.json',ref:manifestRef},{name:'output.png',ref:pngRef},...extra],png:pngRef,info,manifest,plan,metrics:{elapsedMs:performance.now()-started,decodeMs,computeMs,encodeMs,rss:process.memoryUsage().rss,maxRSS:process.resourceUsage().maxRSS*1024}};
}
