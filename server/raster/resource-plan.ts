import {extent} from '../../src/raster/core.js';
import type {RasterLayer,RasterInfo} from '../../src/protocol/raster.js';

const MiB=1024*1024;
export const ACTIVE_COMPUTE_RESERVATION_BYTES=65536;
export type ResourcePlan={width:number;height:number;rawBytes:number;allocations:Record<string,number>;cpuBytes:number;diskBytes:number};

/** The existing complete non-decoding plan, shared without loading native codecs.
 * These are conservative reservations, not measured RSS or release evidence.
 * Keep all runtime/backend allowances even when the worker is already resident. */
export function nonDecodeResourcePlan(width:number,height:number,metadataBytes=0):ResourcePlan{
 extent(width,height);const rawBytes=width*height*4;
 const allocations={nativeDecoderAndColor:0,nativeStackAndIO:0,encodedInput:0,rawOutput:0,orientationRowsAndTiles:8*MiB,metadataAndProfileCopies:4*MiB,pngAndHashIO:4*MiB,workerHeapAndRuntime:80*MiB,concurrentBackendHeadroom:16*MiB,activeKernelTelemetry:ACTIVE_COMPUTE_RESERVATION_BYTES};
 return {width,height,rawBytes,allocations,cpuBytes:Object.values(allocations).reduce((a,b)=>a+b,0),diskBytes:rawBytes*3+metadataBytes+2*MiB};
}

/** RetainText copies already verified raw pixels without orientation, resampling
 * or compositing. Book its actual bounded copy and the common identity-tile
 * scan separately and add both; sequential scopes are not a GC/release claim.
 * All common codec, PNG/hash, metadata, runtime and backend allowances remain.
 * This complete job reservation is also usable before dispatch only when the
 * owner pins an already-ready worker; cold startup still requires 128 MiB. */
export function retainedTextResourcePlan(width:number,height:number):ResourcePlan{
 const plan=nonDecodeResourcePlan(width,height);
 const allocations={...plan.allocations,orientationRowsAndTiles:0,
  retainedTextCopy:Math.min(plan.rawBytes,MiB),
  retainedTextIdentityTile:Math.min(width,512)*Math.min(height,512)*4};
 return {...plan,allocations,cpuBytes:Object.values(allocations).reduce((a,b)=>a+b,0)};
}

/** The existing complete composition plan, shared before warm dispatch and at
 * worker admission. Preserve every source/mask-row and capture allowance; no
 * resident memory or previous job reservation is deducted. Cold startup still
 * requires its separate 128 MiB preflight and cannot use a ready-worker lease. */
export function compositionResourcePlan(width:number,height:number,layers:readonly RasterLayer[],inputs:readonly {id:string;info:Pick<RasterInfo,'width'|'height'|'role'>}[],requestSource=false):ResourcePlan{
 const plan=nonDecodeResourcePlan(width,height);
 if(layers.length>100)throw new Error('RASTER_LAYERS');
 const passthrough=(layer:RasterLayer)=>{const input=inputs.find(i=>i.id===layer.assetId);return input&&input.info.width===width&&input.info.height===height&&layer.opacity===1&&layer.mask===null&&layer.transform.every((n,i)=>n===[1,0,0,1,0,0][i])?input:undefined;};
 plan.allocations.retainedInputRows=Math.max(0,...layers.map(l=>{const source=inputs.find(i=>i.id===l.assetId),mask=inputs.find(i=>i.id===l.mask?.assetId);return (source?source.info.width*Math.min(32,source.info.height)*4:0)+(mask?mask.info.width*Math.min(mask.info.role==='mask'?128:32,mask.info.height)*(mask.info.role==='mask'?2:4):0);}));
 if(requestSource){
  plan.allocations.contributionMetadata=(layers.length+1)*65536;
  plan.diskBytes+=plan.rawBytes*(layers.length===1?0:layers.filter(l=>!passthrough(l)).length)+(layers.length+1)*65536;
 }
 plan.cpuBytes=Object.values(plan.allocations).reduce((a,b)=>a+b,0);return plan;
}
