import type {BlobRef} from '../../src/protocol/store.js';
import {rasterManifest,contributionStack,blob,keys,requireValue as ok} from '../../src/protocol/validate.js';
import type {RasterInfo} from '../../src/protocol/raster.js';
import {hashBytes} from '../storage/canonical.js';
import {imageState} from '../../src/protocol/history-validation.js';
import {validateComposition,compositionRefs} from '../../src/composition/core.js';
import {validateSource,dependencies} from '../text/validation.js';
import {lineageRecord,lineageReferences} from './lineage.js';
import {references} from './format.js';
import {canonical} from '../../src/protocol/json.js';
export type RetainedReference={ref:BlobRef;inspect:boolean};
export type RetainedRasterMetadata={schemaVersion:1;kind:'retained-raster-metadata-1';manifest:BlobRef;previous:BlobRef|null};
function metadataRef(ref:BlobRef){blob(ref);ok(ref.mediaType==='application/json'&&BigInt(ref.byteLength)<=65536n);}
export function retainedRasterMetadata(value:any):asserts value is RetainedRasterMetadata{
 keys(value,['schemaVersion','kind','manifest','previous']);ok(value.schemaVersion===1&&value.kind==='retained-raster-metadata-1');metadataRef(value.manifest);if(value.previous!==null)metadataRef(value.previous);
}
/** Replace one provenance root on each import; prior namespace metadata stays
 * byte-identical without growing the asset's dependency list per generation. */
export function remapRasterRetention(asset:{raster:{manifest:BlobRef};dependencies:readonly BlobRef[];retainedMetadata?:BlobRef},manifest:BlobRef,write:(value:RetainedRasterMetadata)=>BlobRef):{dependencies:BlobRef[];retainedMetadata?:BlobRef}{
 metadataRef(manifest);metadataRef(asset.raster.manifest);if(asset.retainedMetadata)metadataRef(asset.retainedMetadata);
 if(canonical(manifest)===canonical(asset.raster.manifest))return {dependencies:[...asset.dependencies],...(asset.retainedMetadata?{retainedMetadata:asset.retainedMetadata}:{})};
 const retainedMetadata=write({schemaVersion:1,kind:'retained-raster-metadata-1',manifest:asset.raster.manifest,previous:asset.retainedMetadata??null});metadataRef(retainedMetadata);
 const dependencies=asset.dependencies.filter(ref=>canonical(ref)!==canonical(asset.raster.manifest)&&(!asset.retainedMetadata||canonical(ref)!==canonical(asset.retainedMetadata)));
 return {dependencies:[manifest,...dependencies,retainedMetadata],retainedMetadata};
}
/** Imported original manifests must describe the same retained pixels. Their
 * logical IDs are observations and are never resolved against local assets. */
export async function validateRetainedRasterMetadata(root:BlobRef,raster:RasterInfo,read:(ref:BlobRef)=>Promise<any>,check:()=>void=()=>{}):Promise<void>{
 const visited=new Set<string>();let ref:BlobRef|null=root;
 while(ref){check();metadataRef(ref);ok(visited.size<4096&&!visited.has(ref.hash));visited.add(ref.hash);
  const value=await read(ref);retainedRasterMetadata(value);const manifest=await read(value.manifest);rasterManifest(manifest);
  ok(manifest.pipeline===raster.pipeline&&manifest.width===raster.width&&manifest.height===raster.height&&canonical(manifest.pixels)===canonical(raster.pixels)&&hashBytes(canonical({pipeline:manifest.pipeline,width:manifest.width,height:manifest.height,tiles:manifest.tiles}))===raster.pixelIdentity);
  ref=value.previous;
 }
}
/** Walk original immutable metadata by its own references. Logical IDs here
 * belong to its old namespace and never resolve against the current asset DB.
 * Authored raw JSON, prompts, profiles and layouts remain opaque leaf bytes. */
export function retainedMetadataReferences(v:any):RetainedReference[]{
 const out=new Map<string,RetainedReference>(),lengths=new Map<string,string>();const add=(ref:BlobRef,inspect=false)=>{blob(ref);const length=lengths.get(ref.hash);ok(length===undefined||length===ref.byteLength);lengths.set(ref.hash,ref.byteLength);const key=ref.hash+':'+ref.mediaType,old=out.get(key);out.set(key,{ref,inspect:inspect||!!old?.inspect});};
 if(v?.kind==='retained-raster-metadata-1'){retainedRasterMetadata(v);add(v.manifest,true);if(v.previous)add(v.previous,true);}
 else if(v?.format==='straight-srgb-rgba8'&&v.plan){rasterManifest(v);references(v,r=>add(r,r.mediaType==='application/json'));}
 else if(v?.kind==='cp1-contribution-stack-v1'){contributionStack(v);for(const c of v.contributions){add(c.manifest,true);add(c.pixels);}}
 else if(v?.kind==='adopted-candidate-lineage-1'){lineageRecord(v);for(const ref of lineageReferences(v))add(ref);const r=v.result.request.specification,p=r.settings.prompt;if(p.composition)add(p.composition.value,true);if('source'in r&&r.source.capture)add(r.source.capture,true);if('mask'in r)add(r.mask.plan,true);}
 else if(v?.kind==='composition-version-1'){validateComposition(v);for(const ref of compositionRefs(v))add(ref);}
 else if(v?.text&&v.render){const source=validateSource(v);for(const ref of dependencies(source))add(ref);}
 else if(v?.schemaVersion&&Array.isArray(v.layers)&&Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)){imageState(v);if(v.composition)add(v.composition.value,true);for(const l of v.layers)if(l.kind==='text')add(l.source,true);}
 return [...out.values()];
}

/** Compare original immutable observations without granting current namespace
 * authority. Imported drafts may retain an intentionally stale request plan. */
export async function validateRetainedRequestMetadata(value:any,read:(ref:BlobRef)=>Promise<any>,frozen:boolean):Promise<void>{
 const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b),source=value.source,mask=value.mask;
 if(source?.capture){
  blob(source.capture);ok(source.capture.mediaType==='application/json'&&BigInt(source.capture.byteLength)<=65536n);
  const manifest=await read(source.capture);rasterManifest(manifest);const plan:any=manifest.plan;
  ok(plan.kind==='request-source-capture-v1'&&manifest.width===source.width&&manifest.height===source.height&&same(manifest.pixels,source.pixels)&&plan.capture.scope===source.scope&&plan.capture.documentRevision===source.documentRevision);
 }
 if(mask){
  blob(mask.plan);ok(mask.plan.mediaType==='application/json'&&BigInt(mask.plan.byteLength)<=65536n);
  const manifest=await read(mask.plan);rasterManifest(manifest);const plan:any=manifest.plan;
  ok(['authored-mask-v1','authored-mask-v2','authored-request-mask-v1'].includes(plan.kind)&&manifest.width===mask.width&&manifest.height===mask.height&&same(manifest.pixels,mask.pixels));
  if(frozen&&mask.requestPlan)ok(same(plan.hard,mask.requestPlan.authoredMask)&&same(plan.effective,mask.requestPlan.effectiveMask));
  if(frozen&&plan.kind==='authored-request-mask-v1')ok(!!source&&same(plan.sourcePixels,source.pixels)&&(!source.capture||same(plan.source,source.capture)));
 }
}
