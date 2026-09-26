import { openSync, closeSync, readSync, writeSync, fsyncSync, fstatSync, constants, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { CODECS, CODEC_ID } from './identity.js';
import { encodePNG } from './png.js';
import { inspectContainer } from './container.js';
import { extent, contribution, fold, finish, maskCoverage, footprint, PIXEL_PIPELINE } from '../../src/raster/core.js';
import type { Pixels, Rect } from '../../src/raster/core.js';
import type { BlobRef } from '../../src/protocol/store.js';
import type { RasterLayer, RasterManifest, RasterInfo } from '../../src/protocol/raster.js';
import { canonical } from '../../src/protocol/json.js';
import { assertComponents, assertPrivate, sameFile } from '../storage/files.js';

const MiB = 1024 * 1024;
export const PIPELINE = PIXEL_PIPELINE + '/' + CODEC_ID;
export const hash = (bytes: Uint8Array | string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export type InputRaster = { id: string; info: RasterInfo; path: string };
export type RasterJob = { directory: string } & (
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
  if(job.type==='decode'){
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
    ({width,height}=job);plan=resourcePlan(width,height);await admit(plan);dependencies=job.dependencies;sourceAssetIds=job.inputs.map(i=>i.id);
    if(job.layers.length>100)throw new Error('RASTER_LAYERS');
    description={kind:'cp1-composition',layers:job.layers,maskMapping:'document-luminance-alpha-v1',precision:'binary64',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',footprints:job.layers.map(l=>footprint({x:0,y:0,width,height},l.transform))};
    const fd=openSync(raw,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);const computeStart=performance.now();
    try{for(let y=0;y<height;y+=128)for(let x=0;x<width;x+=128){check();const rect={x,y,width:Math.min(128,width-x),height:Math.min(128,height-y)},length=rect.width*rect.height*4;let singleton:Uint8Array|undefined;const accumulator=job.layers.length===1?null:new Float64Array(length);
      for(const layer of job.layers){check();const input=job.inputs.find(i=>i.id===layer.assetId);if(!input)throw new Error('RASTER_INPUT');
        const source=new FilePixels(input.info.width,input.info.height,input.path);let mask:FilePixels|undefined;
        try{if(layer.mask){const m=job.inputs.find(i=>i.id===layer.mask!.assetId);if(!m||m.info.width!==width||m.info.height!==height)throw new Error('RASTER_MASK');mask=new FilePixels(width,height,m.path);}
          const p=new Float64Array(4),coverage=mask?{width,height,get:(mx:number,my:number)=>{mask!.get(mx,my,p);const value=maskCoverage(p);return layer.mask!.inverted?65535-value:value;}}:undefined;
          const k=contribution(source,rect,layer.transform,layer.opacity,coverage);if(accumulator)fold(accumulator,k);else singleton=k;
        }finally{source.close();mask?.close();}
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
  const manifest:RasterManifest={schemaVersion:1,pipeline,width,height,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:tileList,dependencies,plan:description};
  const manifestBytes=Buffer.from(canonical(manifest));if(manifestBytes.length>65536)throw new Error('RASTER_RESOURCES');
  const manifestPath=join(job.directory,'manifest.json');writeFileSync(manifestPath,manifestBytes,{flag:'wx',mode:0o600});
  const manifestRef=fileRef(manifestPath,'application/json',check),encodeStart=performance.now();await encodePNG(raw,png,width,height,check);const encodeMs=performance.now()-encodeStart;
  const pngRef=fileRef(png,'image/png',check);
  const info:RasterInfo={schemaVersion:1,pipeline,width,height,manifest:manifestRef,pixels,pixelIdentity,role:job.type==='decode'?'native':job.type==='compose'?'composite':'export',sourceAssetIds,conversion};
  return {files:[{name:'pixels.rgba',ref:pixels},{name:'manifest.json',ref:manifestRef},{name:'output.png',ref:pngRef},...extra],png:pngRef,info,manifest,plan,metrics:{elapsedMs:performance.now()-started,decodeMs,computeMs,encodeMs,rss:process.memoryUsage().rss,maxRSS:process.resourceUsage().maxRSS*1024}};
}
