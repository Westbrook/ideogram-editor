import {ImportTelemetry} from './import-telemetry.js';
import type {PhaseRecorder,PhaseContext} from '../../src/observability/phases.js';
import type {BigIntStats} from 'node:fs';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,unlinkSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {BlobRef} from '../../src/protocol/store.js';
import type {RasterManifest,RasterInfo,RasterTile} from '../../src/protocol/raster.js';
import {decodedDerivedPlan,type DecodedDerivedPlan} from '../../src/protocol/raster-import.js';
import {canonical} from '../../src/protocol/json.js';
import type {ResourcePlan,RasterResult} from './engine.js';
import {ActiveCompute} from './active-compute.js';
import {preparePNGImport} from './png-import.js';
import {resolveImportProfile} from './import-profile.js';
import {writeExact} from './import-file-transform.js';

export type DerivedRasterJob={type:'derive-original';directory:string;path:string;pipeline:string;plan:DecodedDerivedPlan;cancellation?:SharedArrayBuffer;telemetry?:PhaseContext};
// Native adapters return the same fully transformed/encoded output contract as
// the PNG path. They must hold their one admitted cumulative lease through
// normalization+CP1+encoding and dispose source/tile scratch before returning.
export type NativeDerivedPreparation=Omit<Awaited<ReturnType<typeof preparePNGImport>>,'plan'> & {plan:ResourcePlan};
export type NativeDerivedPrepare=(job:DerivedRasterJob,admit:(plan:ResourcePlan)=>Promise<void>,check:()=>void,telemetry?:ImportTelemetry)=>Promise<NativeDerivedPreparation>;
const digest=(value:Uint8Array|string)=>'sha256:'+createHash('sha256').update(value).digest('hex');
function ref(path:string,mediaType:string,check:()=>void):BlobRef{
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),bytes=Buffer.alloc(65536),before=fstatSync(fd,{bigint:true});
 try{if(!before.isFile()||before.nlink!==1n)throw Error('RASTER_INPUT_CHANGED');const hash=createHash('sha256');let total=0,n;while((n=readSync(fd,bytes))){check();total+=n;hash.update(bytes.subarray(0,n));}const after=fstatSync(fd,{bigint:true});if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||BigInt(total)!==before.size)throw Error('RASTER_INPUT_CHANGED');return {hash:'sha256:'+hash.digest('hex'),byteLength:String(total),mediaType};}finally{closeSync(fd);}
}
async function tiles(path:string,width:number,height:number,check:()=>void):Promise<RasterTile[]>{
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(Math.min(512,width)*Math.min(512,height)*4),result:RasterTile[]=[];
 try{if(fstatSync(fd).size!==width*height*4)throw Error('RASTER_LENGTH');for(let y=0;y<height;y+=512)for(let x=0;x<width;x+=512){check();const w=Math.min(512,width-x),h=Math.min(512,height-y),bytes=buffer.subarray(0,w*h*4);for(let row=0;row<h;row++)if(readSync(fd,bytes,row*w*4,w*4,((y+row)*width+x)*4)!==w*4)throw Error('RASTER_LENGTH');result.push({x,y,width:w,height:h,hash:digest(bytes)});await new Promise<void>(resolve=>setImmediate(resolve));}return result;}finally{closeSync(fd);}
}
/** A dedicated early branch of runRaster; ordinary legacy jobs stay unchanged. */
export async function runDerivedRaster(job:DerivedRasterJob,admit:(plan:ResourcePlan)=>Promise<void>,check:()=>void,native?:NativeDerivedPrepare,active:ActiveCompute|undefined=undefined,recorder?:PhaseRecorder):Promise<RasterResult>{
 const owned=!active;active??=new ActiveCompute({context:job.telemetry});try{return await runDerivedOwned(job,admit,check,native,active,recorder);}finally{if(owned)active.dispose();}
}
async function runDerivedOwned(job:DerivedRasterJob,admit:(plan:ResourcePlan)=>Promise<void>,check:()=>void,native:NativeDerivedPrepare|undefined,active:ActiveCompute,recorder?:PhaseRecorder):Promise<RasterResult>{
 const outerCheck=check;check=()=>{outerCheck();if(job.cancellation&&Atomics.load(new Uint32Array(job.cancellation),0))throw Error('RASTER_CANCELED');};
 const telemetry=new ImportTelemetry(active,recorder,job.telemetry),owned=new Map<string,BigIntStats>();
 const started=performance.now(),plan=job.plan;try{decodedDerivedPlan(plan,plan.operation.width,plan.operation.height);
 if(!resolveImportProfile(job.pipeline,plan,{platform:process.platform,arch:process.arch}))throw Error('RASTER_CODEC_UNQUALIFIED');
 const prepared=plan.decodeTransport==='png-scanline-file-cp1-v1'?await preparePNGImport(job.path,job.directory,plan.operation,admit,check,true,telemetry):native?await native(job,admit,check,telemetry):(()=>{throw Error('RASTER_CODEC_UNQUALIFIED');})();
 if(prepared.raw!==join(job.directory,'pixels.rgba')||prepared.png!==join(job.directory,'output.png'))throw Error('RASTER_OUTPUT_PATH');
 for(const path of [prepared.raw,prepared.png])owned.set(path,lstatSync(path,{bigint:true}));
 // The writer holds the exact original proof before dispatch. Independently
 // bind the result after admitted decode, without unadmitted full-file hashing.
 if(canonical(ref(job.path,plan.original.mediaType,check))!==canonical(plan.original))throw Error('RASTER_INPUT_CHANGED');
 if(canonical(prepared.inspection)!==canonical({encoded:plan.encoded,orientation:plan.orientation,profile:plan.profile,profileHash:plan.profileHash}))throw Error('RASTER_INSPECTION_CHANGED');
 const width=plan.operation.width,height=plan.operation.height,pixels=ref(prepared.raw,'application/x-ideogram-rgba8',check),tileList=await tiles(prepared.raw,width,height,check),pipeline=job.pipeline;
 const pixelIdentity=digest(canonical({pipeline,width,height,tiles:tileList})),manifest:RasterManifest={schemaVersion:1,pipeline,width,height,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:tileList,dependencies:[plan.original],plan};
 const manifestBytes=Buffer.from(canonical(manifest));if(manifestBytes.length>65536)throw Error('RASTER_RESOURCES');const manifestPath=join(job.directory,'manifest.json'),fd=openSync(manifestPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);owned.set(manifestPath,fstatSync(fd,{bigint:true}));try{writeExact(fd,manifestBytes,0);fsyncSync(fd);}finally{closeSync(fd);}
 const manifestRef=ref(join(job.directory,'manifest.json'),'application/json',check),png=ref(prepared.png,'image/png',check),info:RasterInfo={schemaVersion:1,pipeline,width,height,manifest:manifestRef,pixels,pixelIdentity,role:'derived',sourceAssetIds:[plan.sourceAssetId],conversion:null};
 check();telemetry.complete();active.finish();return {files:[{name:'pixels.rgba',ref:pixels},{name:'manifest.json',ref:manifestRef},{name:'output.png',ref:png}],png,info,manifest,plan:prepared.plan,metrics:{...telemetry.metrics,elapsedMs:performance.now()-started,rss:process.memoryUsage().rss}};
 }catch(error){telemetry.fail(error);active.finish('failed');const errors:unknown[]=[error];for(const [path,before]of owned)try{const now=lstatSync(path,{bigint:true});if(now.dev===before.dev&&now.ino===before.ino)unlinkSync(path);}catch(cleanup){if((cleanup as NodeJS.ErrnoException).code!=='ENOENT')errors.push(cleanup);}if(errors.length>1)throw new AggregateError(errors,'Derived raster cleanup failed');throw error;}finally{telemetry.dispose();}
}
