import type {BlobRef} from './store.js';
import type {Source,Mask} from '../request/core.js';
import {newDraft,draftShape,requireRequestMaskPlan} from '../request/core.js';
import type {RequestRasterPlan} from '../request/raster-plan.js';
import {requestRasterGrid,validateRequestRasterPlan} from '../request/raster-plan.js';
import {blob,keys,id,requireValue as ok} from './validate.js';
import {canonical} from './json.js';

export type V45PreparedRaster={blob:BlobRef;pixels:BlobRef;manifest:BlobRef;pixelIdentity:string;width:number;height:number};
export type V45PreparedBlack=V45PreparedRaster&{polarity:'black-edit';sourcePixels:BlobRef;editPixels:number;keepPixels:number};
export type V45PreparedReference={original:Source;input:V45PreparedRaster};
export type V45EditInputsPlan={kind:'v45-edit-inputs-1';endpoint:'ideogram/v4.5/edit';input:BlobRef;assetBindings:{source:string;mask:string|null;references:readonly string[]};original:{source:Source;mask:Mask|null};mask:V45PreparedBlack|null;requestPlan:RequestRasterPlan|null;references:readonly V45PreparedReference[]};
export type V45EditInputs={manifest:BlobRef;original:V45EditInputsPlan['original'];source:V45PreparedRaster&{assetId:string;version:string};mask:V45PreparedBlack|null;requestPlan:RequestRasterPlan|null;references:readonly V45PreparedReference[];refs:readonly BlobRef[]};
export type V45EditPreparation={type:'PrepareV45EditInputs';source:Source;mask:Mask|null;references:readonly Source[]};
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const metadata=(v:any)=>{blob(v);ok(v.mediaType==='application/json'&&BigInt(v.byteLength)<=65536n);};
function original(source:Source,mask:Mask|null){
 const draft=newDraft({hash:'sha256:'+'0'.repeat(64),byteLength:'0',mediaType:'text/plain'});draft.source=source;draft.mask=mask;draftShape(draft);
 ok(!!source&&!!source.capture&&source.pixels.mediaType==='application/x-ideogram-rgba8'&&source.pixels.byteLength===String(source.width*source.height*4)&&source.blob.mediaType==='image/png');
 metadata(source.capture);ok(source.width<=8192&&source.height<=8192&&source.width*source.height<=25000000);
 if(mask){ok(mask.width===source.width&&mask.height===source.height&&mask.sourceHash===source.pixels.hash&&mask.pixels.mediaType==='application/x-ideogram-rgba8'&&mask.pixels.byteLength===String(mask.width*mask.height*4));metadata(mask.plan);}
}
export function v45EditPreparation(v:any):asserts v is V45EditPreparation{
 keys(v,['type','source','mask','references']);ok(v.type==='PrepareV45EditInputs');original(v.source,v.mask);
 ok(Array.isArray(v.references)&&v.references.length<=(v.mask?3:4));for(const source of v.references)original(source,null);
 if(v.mask)requireRequestMaskPlan(v.source,v.mask);
}
function rasterFields(v:any){
 ok(Number.isSafeInteger(v.width)&&Number.isSafeInteger(v.height)&&v.width>0&&v.height>0&&v.width<=8192&&v.height<=8192&&v.width*v.height<=25000000&&/^sha256:[a-f0-9]{64}$/.test(v.pixelIdentity));
 blob(v.blob);blob(v.pixels);metadata(v.manifest);ok(v.blob.mediaType==='image/png'&&v.pixels.mediaType==='application/x-ideogram-rgba8'&&v.pixels.byteLength===String(v.width*v.height*4));
}
export function v45PreparedRaster(v:any):asserts v is V45PreparedRaster{keys(v,['blob','pixels','manifest','pixelIdentity','width','height']);rasterFields(v);}
export function v45PreparedBlack(v:any):asserts v is V45PreparedBlack{
 keys(v,['blob','pixels','manifest','pixelIdentity','width','height','polarity','sourcePixels','editPixels','keepPixels']);rasterFields(v);blob(v.sourcePixels);
 ok(v.polarity==='black-edit'&&v.sourcePixels.mediaType==='application/x-ideogram-rgba8'&&v.sourcePixels.byteLength===String(v.width*v.height*4)&&Number.isSafeInteger(v.editPixels)&&Number.isSafeInteger(v.keepPixels)&&v.editPixels>0&&v.keepPixels>0&&v.editPixels+v.keepPixels===v.width*v.height);
}
export function v45EditInputsPlan(v:any):asserts v is V45EditInputsPlan{
 keys(v,['kind','endpoint','input','assetBindings','original','mask','requestPlan','references']);ok(v.kind==='v45-edit-inputs-1'&&v.endpoint==='ideogram/v4.5/edit');metadata(v.input);keys(v.original,['source','mask']);original(v.original.source,v.original.mask);
 ok((v.original.mask===null)===(v.mask===null)&&(v.mask===null)===(v.requestPlan===null)&&Array.isArray(v.references)&&v.references.length<=(v.mask?3:4));
 keys(v.assetBindings,['source','mask','references']);ok(id(v.assetBindings.source)&&(v.original.mask?id(v.assetBindings.mask):v.assetBindings.mask===null)&&Array.isArray(v.assetBindings.references)&&v.assetBindings.references.length===v.references.length&&v.assetBindings.references.every(id));
 if(v.mask){v45PreparedBlack(v.mask);validateRequestRasterPlan(v.requestPlan);const grid=requestRasterGrid(v.requestPlan);ok(v.mask.width===grid.width&&v.mask.height===grid.height&&same(v.requestPlan,requireRequestMaskPlan(v.original.source,v.original.mask)));}
 for(const reference of v.references){keys(reference,['original','input']);original(reference.original,null);v45PreparedRaster(reference.input);ok(reference.input.width===reference.original.width&&reference.input.height===reference.original.height&&same(reference.input.pixels,reference.original.pixels));}
}
/** Direct typed edges; owners additionally traverse each retained metadata graph. */
export function v45EditInputsReferences(value:V45EditInputsPlan):BlobRef[]{
 v45EditInputsPlan(value);const refs=new Map<string,BlobRef>();
 const visit=(v:unknown):void=>{if(!v||typeof v!=='object')return;if(!Array.isArray(v)&&Object.keys(v).sort().join(',')==='byteLength,hash,mediaType'){blob(v);refs.set(canonical(v),v as BlobRef);return;}for(const child of Object.values(v))visit(child);};
 visit(value);return [...refs.values()];
}
