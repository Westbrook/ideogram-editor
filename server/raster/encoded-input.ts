import {join} from 'node:path';
import {rmSync,writeFileSync} from 'node:fs';
import type {BlobRef} from '../../src/protocol/store.js';
import type {RasterInfo,RasterLayer} from '../../src/protocol/raster.js';
import {validateEncodedCompositionLayers,type EncodedRasterIdentity,type EncodedR16Identity,type EncodedCompositionMaskIdentity} from '../../src/protocol/encoded-rebuild.js';
import {rasterInfo,blob as validateBlob} from '../../src/protocol/validate.js';
import {maskGrid,r16Mask} from '../../src/raster/mapping.js';
import type {RequestRasterPlan,RequestOutputMapping} from '../../src/request/raster-plan.js';
import type {PhaseContext,PhaseRecorder} from '../../src/observability/phases.js';
import {canonical} from '../../src/protocol/json.js';
import {privateDirectory} from '../storage/files.js';
import {runRaster,fileRef,resourcePlan,type RasterJob,type RasterResult,type ResourcePlan,type InputRaster} from './engine.js';
import {inspectContainer} from './container.js';
import {decodeR16,R16_ENCODED_ALLOCATION_BYTES,R16_ENCODED_CODEC,R16_ENCODED_MEDIA_TYPE} from './r16-encoded.js';
import {ActiveCompute} from './active-compute.js';

/** Only encoded file capabilities are admitted. Canonical file paths cannot be supplied. */
export type EncodedRasterFile={identity:EncodedRasterIdentity;encodedPath:string};
export type EncodedR16File={identity:EncodedR16Identity;encodedPath:string};
export type EncodedCompositionMaskFile={identity:EncodedCompositionMaskIdentity;encodedPath:string};
export type LetteringComparison='candidate-alone'|'native-off'|'native-on';
export type EncodedRasterJob={directory:string;telemetry?:PhaseContext}&(
  | {type:'encoded-preserve';source:EncodedRasterFile;candidate:EncodedRasterFile;mask:{id:string;info:RasterInfo;authored:EncodedR16File;effective:EncodedR16File;approved:EncodedR16File};plan:RequestRasterPlan;outputMapping?:RequestOutputMapping;dependencies:readonly BlobRef[]}
  | {type:'encoded-compose';width:number;height:number;layers:readonly RasterLayer[];inputs:readonly EncodedRasterFile[];masks?:readonly EncodedCompositionMaskFile[];dependencies:readonly BlobRef[];comparison?:LetteringComparison}
);
export type EncodedRebuildEvidence={
  kind:'encoded-input-rebuild-1';canonicalInputPaths:0;reusedPreparedProducts:0;
  inputs:{encoded:BlobRef;expected:BlobRef;actual:BlobRef;kind:'rgba8'|'r16le'}[];
  scratchRemoved:boolean;decodeCount:number;
};
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const bytes=(ref:BlobRef)=>Number(ref.byteLength);

/** One admitted reservation spans serial decodes, preservation/composition and
 * output encoding. All inputs are decoded into this invocation's private tree;
 * neither Q lookup nor object-store canonical pixel paths are reachable here. */
export async function runEncodedRaster(job:EncodedRasterJob,admit:(plan:ResourcePlan)=>Promise<void>,check:()=>void,recorder?:PhaseRecorder,active?:ActiveCompute):Promise<RasterResult>{
  const owned=!active;active??=new ActiveCompute({context:job.telemetry});try{return await runEncodedOwned(job,admit,check,recorder,active);}finally{if(owned)active.dispose();}
}
async function runEncodedOwned(job:EncodedRasterJob,admit:(plan:ResourcePlan)=>Promise<void>,check:()=>void,recorder:PhaseRecorder|undefined,active:ActiveCompute):Promise<RasterResult>{
  if(job.type==='encoded-compose'&&(!Array.isArray(job.inputs)||job.masks!==undefined&&!Array.isArray(job.masks)))throw Error('RASTER_ENCODED_INPUT');
  const started=performance.now(),images=job.type==='encoded-preserve'?[job.source,job.candidate]:[...job.inputs];
  const compositionMasks=job.type==='encoded-compose'?[...(job.masks??[])]:[];
  if(images.length>200||compositionMasks.length>100||job.type==='encoded-preserve'&&images.length!==2)throw Error('RASTER_ENCODED_INPUT');
  for(const image of images){rasterInfo(image.identity.info);if(image.identity.info.role==='mask'||job.type==='encoded-compose'&&(image.identity.encoding!=='canonical-png'||image.identity.encodedAssetId!==image.identity.assetId))throw Error('RASTER_ENCODED_INPUT');validateBlob(image.identity.encoded);}
  if(job.type==='encoded-compose'){
    validateEncodedCompositionLayers(job.width,job.height,job.layers);
    if(job.comparison!==undefined&&!['candidate-alone','native-off','native-on'].includes(job.comparison))throw Error('RASTER_ENCODED_INPUT');
    if(job.comparison==='candidate-alone'&&(job.layers.length!==1||job.layers[0].opacity!==1||job.layers[0].mask!==null))throw Error('RASTER_ENCODED_INPUT');
    const imageIds=new Set(images.map(input=>input.identity.assetId)),maskIds=new Set(compositionMasks.map(input=>input.identity.assetId));
    if(imageIds.size!==images.length||maskIds.size!==compositionMasks.length||[...imageIds].some(id=>maskIds.has(id))||imageIds.size+maskIds.size>200)throw Error('RASTER_ENCODED_INPUT');
    const usedImages=new Set<string>(),usedMasks=new Set<string>();
    for(const layer of job.layers){if(!imageIds.has(layer.assetId))throw Error('RASTER_ENCODED_INPUT');usedImages.add(layer.assetId);
      if(layer.mask){const grid=maskGrid(layer.mask,job.width,job.height),r16=r16Mask(layer.mask),input=r16?compositionMasks.find(row=>row.identity.assetId===layer.mask!.assetId):images.find(row=>row.identity.assetId===layer.mask!.assetId);
        if(!input||input.identity.info.width!==grid.width||input.identity.info.height!==grid.height)throw Error('RASTER_ENCODED_INPUT');(r16?usedMasks:usedImages).add(layer.mask.assetId);}
    }
    if(usedImages.size!==imageIds.size||usedMasks.size!==maskIds.size)throw Error('RASTER_ENCODED_INPUT');
  }
  const masks=job.type==='encoded-preserve'?[job.mask.authored,job.mask.effective,job.mask.approved]:compositionMasks.map(input=>({identity:input.identity.coverage,encodedPath:input.encodedPath}));
  for(const [index,input]of masks.entries()){const value=input.identity;validateBlob(value.encoded);validateBlob(value.pixels);
    if(value.codec!==R16_ENCODED_CODEC||value.encoded.mediaType!==R16_ENCODED_MEDIA_TYPE||value.pixels.mediaType!=='application/x-ideogram-r16le'||!Number.isSafeInteger(value.width)||!Number.isSafeInteger(value.height)||value.width<1||value.height<1||value.width>8192||value.height>8192||value.width*value.height>25000000||value.pixels.byteLength!==String(value.width*value.height*2))throw Error('RASTER_ENCODED_IDENTITY');
    if(job.type==='encoded-compose'){const info=compositionMasks[index].identity.info;rasterInfo(info);if(info.role!=='mask'||info.width!==value.width||info.height!==value.height)throw Error('RASTER_ENCODED_IDENTITY');}
    else if(value.width!==job.plan.document.width||value.height!==job.plan.document.height)throw Error('RASTER_ENCODED_IDENTITY');
  }
  const width=job.type==='encoded-preserve'?job.plan.document.width:job.width,height=job.type==='encoded-preserve'?job.plan.document.height:job.height;
  const finalPlan=resourcePlan(width,height),plans:ResourcePlan[]=[finalPlan];
  // Container inspection is bounded metadata/stream validation, before pixels.
  for(const input of images){check();const value=input.identity;
    if(!['canonical-png','candidate-original'].includes(value.encoding)||value.encoding==='canonical-png'&&value.encoded.mediaType!=='image/png'||!same(fileRef(input.encodedPath,value.encoded.mediaType,check),value.encoded))throw Error('RASTER_ENCODED_IDENTITY');
    const inspected=await inspectContainer(input.encodedPath,value.encoded.mediaType,check);
    // Conservative WebP reservation covers the ordinary fallback as well as the
    // bounded decoder; no late decoder choice can expand the admitted envelope.
    plans.push(resourcePlan(inspected.width,inspected.height,true,inspected.metadataBytes,value.encoded.mediaType.slice(6),inspected.encodedBytes));
  }
  finalPlan.allocations.encodedPreservationRows=job.type==='encoded-preserve'?width*Math.min(32,height)*4+job.candidate.identity.info.width*Math.min(32,job.candidate.identity.info.height)*4+width*Math.min(128,height)*2+width*36:Math.max(width*Math.min(32,height)*4,...job.layers.map(layer=>{
    const source=images.find(input=>input.identity.assetId===layer.assetId)!.identity.info,mask=layer.mask?(r16Mask(layer.mask)?compositionMasks.find(input=>input.identity.assetId===layer.mask!.assetId):images.find(input=>input.identity.assetId===layer.mask!.assetId))?.identity.info:undefined;
    return source.width*Math.min(32,source.height)*4+(mask?mask.width*Math.min(mask.role==='mask'?128:32,mask.height)*(mask.role==='mask'?2:4):0);
  }));
  finalPlan.cpuBytes=Object.values(finalPlan.allocations).reduce((a,b)=>a+b,0);
  const cpu=Math.max(...plans.map(p=>p.cpuBytes))+R16_ENCODED_ALLOCATION_BYTES;
  const comparisonSize=job.type==='encoded-compose'&&job.comparison?{width:Math.max(1,Math.round(width*Math.min(1,1024/width,1024/height))),height:Math.max(1,Math.round(height*Math.min(1,1024/width,1024/height)))}:null;
  const disk=plans.reduce((n,p)=>n+p.diskBytes,0)+masks.reduce((n,m)=>n+bytes(m.identity.pixels),0)+(comparisonSize?resourcePlan(comparisonSize.width,comparisonSize.height).diskBytes:0)+1024*1024;
  const reservation:ResourcePlan={...finalPlan,allocations:{serialRasterPeak:cpu-R16_ENCODED_ALLOCATION_BYTES,encodedR16:R16_ENCODED_ALLOCATION_BYTES},cpuBytes:cpu,diskBytes:disk};
  await admit(reservation);check();
  const bounded=async(plan:ResourcePlan)=>{check();if(plan.cpuBytes>reservation.cpuBytes||plan.diskBytes>reservation.diskBytes)throw Error('RASTER_RESOURCES');};
  const scratch=join(job.directory,'encoded-inputs');privateDirectory(scratch);
  const evidence:EncodedRebuildEvidence={kind:'encoded-input-rebuild-1',canonicalInputPaths:0,reusedPreparedProducts:0,inputs:[],scratchRemoved:false,decodeCount:0};
  let decodeMs=0,intermediateEncodeMs=0;
  try{
    const decoded:InputRaster[]=[];
    for(const [index,input] of images.entries()){
      check();const value=input.identity,directory=join(scratch,'image-'+index);privateDirectory(directory);
      const result=await runRaster({type:'decode',directory,path:input.encodedPath,mediaType:value.encoded.mediaType,original:value.encoded,sourceAssetId:value.encodedAssetId,telemetry:job.telemetry},bounded,check,recorder);
      if(result.info.width!==value.info.width||result.info.height!==value.info.height||!same(result.info.pixels,value.info.pixels))throw Error('RASTER_ENCODED_IDENTITY');
      if(value.encoding==='candidate-original'&&(result.info.pipeline!==value.info.pipeline||!same(result.info.conversion,value.info.conversion)))throw Error('RASTER_ENCODED_IDENTITY');
      const path=join(directory,'pixels.rgba'),actual=fileRef(path,value.info.pixels.mediaType,check);
      if(!same(actual,value.info.pixels)||!same(fileRef(input.encodedPath,value.encoded.mediaType,check),value.encoded))throw Error('RASTER_ENCODED_IDENTITY');
      evidence.inputs.push({encoded:value.encoded,expected:value.info.pixels,actual,kind:'rgba8'});evidence.decodeCount++;
      decodeMs+=result.metrics.decodeMs;intermediateEncodeMs+=result.metrics.encodeMs;decoded.push({id:value.assetId,info:value.info,path});
    }
    const maskPaths:string[]=[];
    for(const [index,input]of masks.entries()){
      check();const value=input.identity,path=join(scratch,'mask-'+index+'.r16');
      if(!same(fileRef(input.encodedPath,value.encoded.mediaType,check),value.encoded))throw Error('RASTER_ENCODED_IDENTITY');
      const began=performance.now();await decodeR16(input.encodedPath,path,value.width,value.height,value.pixels,check);decodeMs+=performance.now()-began;
      const actual=fileRef(path,value.pixels.mediaType,check);if(!same(actual,value.pixels)||!same(fileRef(input.encodedPath,value.encoded.mediaType,check),value.encoded))throw Error('RASTER_ENCODED_IDENTITY');
      evidence.inputs.push({encoded:value.encoded,expected:value.pixels,actual,kind:'r16le'});evidence.decodeCount++;maskPaths.push(path);
    }
    let finalJob:RasterJob;
    if(job.type==='encoded-preserve'){
      if(!same(job.source.identity.info.pixels,job.plan.sourcePixels)||!same(job.mask.authored.identity.pixels,job.plan.authoredMask)||!same(job.mask.effective.identity.pixels,job.plan.effectiveMask)||!same(job.mask.approved.identity.pixels,job.outputMapping?.effectiveMask??job.plan.effectiveMask))throw Error('RASTER_ENCODED_IDENTITY');
      if(masks.some(input=>input.identity.width!==width||input.identity.height!==height))throw Error('RASTER_ENCODED_IDENTITY');
      finalJob={type:'preserve-request',directory:job.directory,telemetry:job.telemetry,source:decoded[0],candidate:decoded[1],mask:{id:job.mask.id,info:job.mask.info,path:'',hardPath:maskPaths[0],coveragePath:maskPaths[2]},plan:job.plan,...(job.outputMapping?{outputMapping:job.outputMapping}:{}),dependencies:job.dependencies};
    }else{
      for(const [index,input]of compositionMasks.entries())decoded.push({id:input.identity.assetId,info:input.identity.info,path:'',coveragePath:maskPaths[index]});
      const directory=comparisonSize?join(scratch,'comparison-composition'):job.directory;if(comparisonSize)privateDirectory(directory);
      finalJob={type:'compose',directory,telemetry:job.telemetry,width:job.width,height:job.height,layers:job.layers,inputs:decoded,dependencies:job.dependencies};
    }
    let result=await runRaster(finalJob,bounded,check,recorder,comparisonSize?undefined:active);check();
    if(comparisonSize&&job.type==='encoded-compose'){
      const composed=result;
      result=await runRaster({type:'export',directory:job.directory,telemetry:job.telemetry,input:{id:'lettering-comparison-scratch',info:composed.info,path:join(finalJob.directory,'pixels.rgba')},dependencies:job.dependencies,options:{format:'png',resize:comparisonSize,matte:null,quality:null}},bounded,check,recorder,active);check();
      // This is review imagery, never a preservation or prepared-placement proof.
      // Its only durable dependencies are the exact original layer manifests.
      const manifest={...result.manifest,plan:{kind:'candidate-lettering-comparison-v1',sourceWidth:width,sourceHeight:height,layers:job.layers,comparison:job.comparison,kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',preservation:'not-applied'}};
      const manifestBytes=Buffer.from(canonical(manifest));if(manifestBytes.length>65536)throw Error('RASTER_RESOURCES');writeFileSync(join(job.directory,'manifest.json'),manifestBytes,{mode:0o600});
      const ref=fileRef(join(job.directory,'manifest.json'),'application/json',check);result={...result,manifest,info:{...result.info,manifest:ref,sourceAssetIds:[...new Set(job.layers.flatMap(layer=>[layer.assetId,...(layer.mask?[layer.mask.assetId]:[])]))]},files:result.files.map(file=>file.name==='manifest.json'?{...file,ref}:file),metrics:{...result.metrics,computeMs:composed.metrics.computeMs+result.metrics.computeMs,encodeMs:composed.metrics.encodeMs+result.metrics.encodeMs,comparisonSourceWidth:width,comparisonSourceHeight:height}};
    }
    rmSync(scratch,{recursive:true});evidence.scratchRemoved=true;
    return {...result,plan:reservation,encodedRebuild:evidence,metrics:{...result.metrics,elapsedMs:performance.now()-started,decodeMs:decodeMs+result.metrics.decodeMs,encodeMs:intermediateEncodeMs+result.metrics.encodeMs,encodedInputCount:evidence.inputs.length,encodedInputBytes:evidence.inputs.reduce((n,i)=>n+bytes(i.encoded),0),decodedVerifiedBytes:evidence.inputs.reduce((n,i)=>n+bytes(i.actual),0),encodedScratchRemoved:1}};
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
