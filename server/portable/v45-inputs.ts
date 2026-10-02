import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import type {BlobRef} from '../../src/protocol/store.js';
import type {Asset} from '../../src/protocol/assets.js';
import type {RasterManifest} from '../../src/protocol/raster.js';
import type {Source,Mask} from '../../src/request/core.js';
import type {V45EditInputsPlan,V45PreparedRaster} from '../../src/protocol/v45-inputs.js';
import {v45EditInputsPlan,v45EditInputsReferences} from '../../src/protocol/v45-inputs.js';
import {blob,rasterManifest} from '../../src/protocol/validate.js';
import {parseControlJSON} from '../../src/protocol/json.js';
import type {InputRaster,RasterResult,RasterReplayIdentity} from '../raster/engine.js';
import type {Rasters} from '../storage/raster.js';
import {canonical,hashBytes} from '../storage/canonical.js';
import {privateDirectory} from '../storage/files.js';
import {invalid} from './zip.js';

type ReadBytes=(ref:BlobRef)=>Promise<Uint8Array>;
type Lookup=(id:string)=>Asset|null|undefined;
type ReferenceClosure={original:Source;prepared:V45PreparedRaster;capture:RasterManifest;worker:RasterManifest};
export type V45InputsClosure={
  manifest:RasterManifest;plan:V45EditInputsPlan;workerInput:RasterManifest;
  originalSource:RasterManifest;originalMask:RasterManifest|null;blackMask:RasterManifest|null;
  references:readonly ReferenceClosure[];
  /** Retained originals need the owner's usual typed metadata traversal too. */
  metadata:readonly BlobRef[];
};
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const planOf=(manifest:RasterManifest):any=>manifest.plan;
const identity=(manifest:RasterManifest)=>hashBytes(canonical({pipeline:manifest.pipeline,width:manifest.width,height:manifest.height,tiles:manifest.tiles}));
function metadataRef(ref:BlobRef){blob(ref);if(ref.mediaType!=='application/json'||BigInt(ref.byteLength)>65536n)invalid();}
function samePixels(a:RasterManifest,b:RasterManifest){
  if(a.width!==b.width||a.height!==b.height||a.pipeline!==b.pipeline||!same(a.pixels,b.pixels)||!same(a.tiles,b.tiles))invalid();
}
function descriptor(manifest:RasterManifest,value:V45PreparedRaster){
  if(manifest.width!==value.width||manifest.height!==value.height||!same(manifest.pixels,value.pixels)||identity(manifest)!==value.pixelIdentity)invalid();
}

/** Only these explicit local bindings are asset edges. All IDs inside original
 * descriptors and worker metadata remain observations of their old namespace. */
export function v45InputsAssetIds(plan:V45EditInputsPlan):string[]{
  v45EditInputsPlan(plan);const bindings=plan.assetBindings;
  return [...new Set([bindings.source,...(bindings.mask===null?[]:[bindings.mask]),...bindings.references])];
}

/** Validate typed closure without reconstructing pixels or granting a request,
 * review, provider, or safety authority. Raw objects are checked by the owner's
 * streamed archive verifier; every consulted JSON object is bounded and exact. */
export async function validateV45InputsClosure(
  manifest:RasterManifest,read:ReadBytes,needed:(ref:BlobRef)=>void,
  options:{asset?:Lookup;owner?:Asset;check?:()=>void}={},
):Promise<V45InputsClosure>{
  const check=options.check??(()=>{});check();rasterManifest(manifest);
  const plan=manifest.plan;v45EditInputsPlan(plan);
  const direct=v45EditInputsReferences(plan),ordered=(refs:readonly BlobRef[])=>refs.map(ref=>canonical(ref)).sort();
  if(!same(ordered(manifest.dependencies),ordered(direct)))invalid();
  const refs=new Map<string,BlobRef>(),metadata=new Map<string,BlobRef>(),cache=new Map<string,RasterManifest>();
  const need=(ref:BlobRef)=>{blob(ref);const prior=refs.get(ref.hash);if(prior&&!same(prior,ref))invalid();refs.set(ref.hash,ref);needed(ref);};
  const visit=async(ref:BlobRef):Promise<RasterManifest>=>{
    check();metadataRef(ref);need(ref);metadata.set(ref.hash,ref);
    const prior=cache.get(ref.hash);if(prior)return prior;
    const bytes=await read(ref);check();if(String(bytes.byteLength)!==ref.byteLength||hashBytes(bytes)!==ref.hash)invalid();
    const value=parseControlJSON(bytes) as unknown as RasterManifest;rasterManifest(value);
    if(canonical(value)!==Buffer.from(bytes).toString('utf8'))invalid();
    cache.set(ref.hash,value);need(value.pixels);for(const dependency of value.dependencies)need(dependency);return value;
  };
  for(const ref of [manifest.pixels,...manifest.dependencies,...direct])need(ref);
  const originalSource=await visit(plan.original.source.capture!);
  const sourceCapture=(source:Source,capture:RasterManifest)=>{
    const p=planOf(capture);
    if(p.kind!=='request-source-capture-v1'||capture.width!==source.width||capture.height!==source.height||
       !same(capture.pixels,source.pixels)||p.capture.scope!==source.scope||p.capture.documentRevision!==source.documentRevision)invalid();
  };
  sourceCapture(plan.original.source,originalSource);
  const bound=(original:Source|Mask,localId:string,isMask:boolean,retained:RasterManifest)=>{
    if(!options.asset)return;
    const value=options.asset(localId),raster=value?.raster;
    if(!value||value.id!==localId||!raster||value.availability!=='available'||value.qualification!=='canonical-raster'||
       value.version!==original.version||!same(value.blob,original.blob)||!same(raster.pixels,original.pixels)||
       raster.width!==original.width||raster.height!==original.height||raster.pipeline!==retained.pipeline||
       raster.pixelIdentity!==identity(retained)||(raster.role==='mask')!==isMask)invalid();
  };
  bound(plan.original.source,plan.assetBindings.source,false,originalSource);
  const workerInput=await visit(plan.input);samePixels(manifest,workerInput);
  if(manifest.schemaVersion!==workerInput.schemaVersion)invalid();
  const sourceWorker=(source:Source,capture:RasterManifest,worker:RasterManifest,masked:boolean)=>{
    const p=planOf(worker);
    if(masked){
      if(p.kind!=='request-source-transport-v1'||!same(p.source,source.capture)||!same(p.requestPlan,plan.requestPlan)||
         !same(worker.dependencies,[source.capture,plan.requestPlan!.sourcePixels,plan.requestPlan!.authoredMask,plan.requestPlan!.effectiveMask]))invalid();
    }else{
      if(p.kind!=='frozen-png-export'||p.sourceAssetId!==source.assetId||p.pixelIdentity!==identity(capture)||!same(worker.dependencies,[source.capture]))invalid();
      samePixels(capture,worker);
    }
  };
  sourceWorker(plan.original.source,originalSource,workerInput,plan.requestPlan!==null);
  let originalMask:RasterManifest|null=null,blackMask:RasterManifest|null=null;
  if(plan.original.mask&&plan.mask&&plan.requestPlan){
    const original=plan.original.mask;originalMask=await visit(original.plan);const p=planOf(originalMask);
    if(!['authored-mask-v1','authored-mask-v2','authored-request-mask-v1'].includes(p.kind)||
       originalMask.width!==original.width||originalMask.height!==original.height||!same(originalMask.pixels,original.pixels)||
       !same(p.hard,plan.requestPlan.authoredMask)||!same(p.effective,plan.requestPlan.effectiveMask))invalid();
    if(p.kind==='authored-request-mask-v1'&&(p.sourceAssetId!==plan.original.source.assetId||
       !same(p.source,plan.original.source.capture)||!same(p.sourcePixels,plan.original.source.pixels)))invalid();
    bound(original,plan.assetBindings.mask!,true,originalMask);
    if(options.asset){
      const current=await visit(options.asset(plan.assetBindings.mask!)!.raster!.manifest),coverage=planOf(current);
      // A displayed 8-bit mask cannot distinguish every retained R16 sample.
      // Copy changes metadata IDs, never these authoritative coverage objects.
      if(!['authored-mask-v1','authored-mask-v2','authored-request-mask-v1'].includes(coverage.kind)||
         !same(coverage.hard,p.hard)||!same(coverage.effective,p.effective))invalid();
    }
    blackMask=await visit(plan.mask.manifest);descriptor(blackMask,plan.mask);const black=planOf(blackMask);
    if(black.kind!=='v45-edit-mask-v1'||black.endpoint!==plan.endpoint||black.polarity!=='black-edit'||
       !same(black.source,plan.original.source.capture)||!same(black.mask,original.plan)||
       !same(black.sourcePixels,manifest.pixels)||!same(black.requestPlan,plan.requestPlan)||
       black.statistics.editPixels!==plan.mask.editPixels||black.statistics.keepPixels!==plan.mask.keepPixels||
       !same(blackMask.dependencies,[plan.original.source.capture,original.plan,manifest.pixels,plan.requestPlan.sourcePixels,plan.requestPlan.authoredMask,plan.requestPlan.effectiveMask]))invalid();
  }
  const references:ReferenceClosure[]=[];
  for(const [index,reference] of plan.references.entries()){
    const capture=await visit(reference.original.capture!),worker=await visit(reference.input.manifest);
    sourceCapture(reference.original,capture);sourceWorker(reference.original,capture,worker,false);descriptor(worker,reference.input);
    bound(reference.original,plan.assetBindings.references[index],false,capture);
    references.push({original:reference.original,prepared:reference.input,capture,worker});
  }
  if(options.owner){
    const owner=options.owner,encoded=canonical(manifest);if(!owner.raster||owner.raster.role==='mask'||!same(owner.raster.sourceAssetIds,v45InputsAssetIds(plan))||
      owner.raster.width!==manifest.width||owner.raster.height!==manifest.height||owner.raster.pipeline!==manifest.pipeline||
      !same(owner.raster.pixels,manifest.pixels)||owner.raster.pixelIdentity!==identity(manifest)||
      !same(owner.raster.manifest,{hash:hashBytes(encoded),byteLength:String(Buffer.byteLength(encoded)),mediaType:'application/json'}))invalid();
  }
  check();return {manifest,plan,workerInput,originalSource,originalMask,blackMask,references,metadata:[...metadata.values()]};
}

type V45PortableRasters=Pick<Rasters,'validateV45EditSourcePortable'|'validateV45EditMaskPortable'>;
export type V45InputComputation={
  rasters:V45PortableRasters;asset:Asset;input:(localId:string)=>Promise<InputRaster>;path:(ref:BlobRef)=>string;
  directory:string;slot:string;check?:()=>void;
};
function replay(manifest:RasterManifest):RasterReplayIdentity{
  const plan=planOf(manifest);return {pipeline:manifest.pipeline,...(plan.kind==='frozen-png-export'?{encoder:plan.encoder}:{})};
}
function recomputed(result:RasterResult,manifest:RasterManifest,ref:BlobRef,encoded:BlobRef){
  if(!same(result.manifest,manifest)||!same(result.info.manifest,ref)||!same(result.png,encoded)||
     !same(result.info.pixels,manifest.pixels)||result.info.pixelIdentity!==identity(manifest))invalid();
}

/** Reuse the real admitted worker with original immutable metadata identities
 * and locally bound raw paths. Generated files stay in the import's temporary
 * directory; this helper publishes no assets or request/provider authority. */
export async function verifyV45InputsComputation(closure:V45InputsClosure,context:V45InputComputation):Promise<void>{
  const {plan,manifest}=closure,check=context.check??(()=>{});check();
  const encoded=canonical(manifest);
  if(!context.asset.raster||!same(context.asset.raster.sourceAssetIds,v45InputsAssetIds(plan))||
     !same(context.asset.raster.pixels,manifest.pixels)||context.asset.raster.pixelIdentity!==identity(manifest)||
     !same(context.asset.raster.manifest,{hash:hashBytes(encoded),byteLength:String(Buffer.byteLength(encoded)),mediaType:'application/json'}))invalid();
  const work=(kind:string)=>{check();const path=join(context.directory,'v45-'+kind+'-'+randomUUID());privateDirectory(path);return path;};
  const originalInput=async(original:Source|Mask,localId:string,metadata:RasterManifest,ref:BlobRef,isMask:boolean):Promise<InputRaster>=>{
    const local=await context.input(localId);check();
    if(local.id!==localId||local.info.width!==original.width||local.info.height!==original.height||
       !same(local.info.pixels,original.pixels)||local.info.pipeline!==metadata.pipeline||
       local.info.pixelIdentity!==identity(metadata)||(local.info.role==='mask')!==isMask)invalid();
    return {...local,id:original.assetId,info:{...local.info,pipeline:metadata.pipeline,width:metadata.width,height:metadata.height,
      manifest:ref,pixels:metadata.pixels,pixelIdentity:identity(metadata)}};
  };
  const source=await originalInput(plan.original.source,plan.assetBindings.source,closure.originalSource,plan.original.source.capture!,false);
  const computed=await context.rasters.validateV45EditSourcePortable(source,plan.requestPlan,work('source'),context.slot,check,replay(closure.workerInput));
  recomputed(computed,closure.workerInput,plan.input,context.asset.blob);
  if(plan.mask&&plan.original.mask&&plan.requestPlan&&closure.originalMask&&closure.blackMask){
    const mask=await originalInput(plan.original.mask,plan.assetBindings.mask!,closure.originalMask,plan.original.mask.plan,true);
    const black=await context.rasters.validateV45EditMaskPortable(plan.requestPlan,plan.original.source.capture!,manifest.pixels,
      {...mask,coveragePath:context.path(plan.requestPlan.effectiveMask)},work('mask'),context.slot,check,replay(closure.blackMask));
    recomputed(black,closure.blackMask,plan.mask.manifest,plan.mask.blob);
  }
  for(const [index,reference] of closure.references.entries()){
    const input=await originalInput(reference.original,plan.assetBindings.references[index],reference.capture,reference.original.capture!,false);
    const computed=await context.rasters.validateV45EditSourcePortable(input,null,work('reference'),context.slot,check,replay(reference.worker));
    recomputed(computed,reference.worker,reference.prepared.manifest,reference.prepared.blob);
  }
  check();
}
