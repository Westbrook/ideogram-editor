import {bindingMap,bindingValue,bytes,CompositionError,emptyComposition,serialize,validateComposition} from './core.js';
import type {Composition,LayerValue,ProjectionReview,ProjectedBox} from './core.js';
import type {BlobRef} from '../protocol/store.js';
import {canonical} from '../protocol/json.js';
import {SHA256} from '../protocol/sha256.js';

/** An app-owned prose export. This identifies no provider caption schema and
 * grants no dispatch, safety, text fidelity or pixel-placement authority. */
export type CompositionTextReview={serializer:'composition-text-1';sourceId:string;sourceProjection:ProjectionReview;prompt:BlobRef};
export type CompositionTextExport={prompt:string;review:CompositionTextReview};
export const COMPOSITION_TEXT_LIMIT=10000;
function fail(path:string,code:string):never{throw new CompositionError([{path,code,message:code}]);}
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const sequence=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v);
function exact(value:unknown,keys:readonly string[],path:string):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key)))return fail(path,'COMPOSITION_TEXT_REVIEW');
 return value as Record<string,unknown>;
}
function promptRef(value:unknown,maximum:number):asserts value is BlobRef{
 const ref=exact(value,['hash','byteLength','mediaType'],'prompt');
 if(typeof ref.hash!=='string'||!/^sha256:[a-f0-9]{64}$/.test(ref.hash)||!sequence(ref.byteLength)||ref.byteLength.length>6||BigInt(ref.byteLength)<1n||BigInt(ref.byteLength)>BigInt(maximum)||ref.mediaType!=='text/plain')fail('prompt','COMPOSITION_TEXT_REVIEW');
}
function refFor(text:string):BlobRef{return {hash:new SHA256().update(new TextEncoder().encode(text)).digest(),byteLength:String(bytes(text)),mediaType:'text/plain'};}
function finiteTuple(value:unknown,length:number):value is number[]{return Array.isArray(value)&&value.length===length&&value.every(v=>typeof v==='number'&&Number.isFinite(v));}
function projectionShape(value:unknown):void{
 const p=exact(value,['corners','unclipped','clipped','normalized','quantized','approximation','policy'],'projection');
 if(!Array.isArray(p.corners)||p.corners.length!==4||!p.corners.every(v=>finiteTuple(v,2))||!['unclipped','clipped','normalized','quantized'].every(key=>finiteTuple(p[key],4))||typeof p.approximation!=='boolean'||typeof p.policy!=='string'||!['inside','clip','omit'].includes(p.policy))fail('projection','COMPOSITION_TEXT_REVIEW');
 const q=p.quantized as number[];
 if(q.some(n=>!Number.isInteger(n)||n<0||n>1000)||q[0]! >= q[2]!||q[1]! >= q[3]!)fail('projection','COMPOSITION_TEXT_REVIEW');
}
/** Shape only. Source and exact prompt authority require one of the assertions
 * below; an arbitrary well-shaped record is never an approved export. */
export function validateCompositionTextReview(value:unknown):asserts value is CompositionTextReview{
 const review=exact(value,['serializer','sourceId','sourceProjection','prompt'],'review');
 if(review.serializer!=='composition-text-1'||!identifier(review.sourceId))fail('review','COMPOSITION_TEXT_REVIEW');
 promptRef(review.prompt,COMPOSITION_TEXT_LIMIT*4);
 const source=exact(review.sourceProjection,['serializer','sourceId','frame','request','dependencies','boxes','prompt'],'sourceProjection');
 if(source.serializer!=='caption-json-1'||source.sourceId!==review.sourceId||!Array.isArray(source.dependencies)||source.dependencies.length>768||!Array.isArray(source.boxes)||source.boxes.length>256)fail('sourceProjection','COMPOSITION_TEXT_REVIEW');
 promptRef(source.prompt,262144);
 // Reuse the established frame, request and review shape rules without changing
 // the source graph or blessing this synthetic graph as provenance.
 const shape=emptyComposition(1,1,review.sourceId);shape.frame=source.frame as Composition['frame'];shape.request=source.request as Composition['request'];shape.review=source as unknown as ProjectionReview;
 validateComposition(shape);
 const dependencies=new Set<string>(),elements=new Set<string>();
 for(const value of source.dependencies){const d=exact(value,['elementId','field','layerId','version'],'dependency');
  if(!identifier(d.elementId)||typeof d.field!=='string'||!['desc','text','bounds'].includes(d.field)||!identifier(d.layerId)||!sequence(d.version))fail('dependency','COMPOSITION_TEXT_REVIEW');
  const key=d.elementId+':'+d.field;if(dependencies.has(key))fail('dependency','COMPOSITION_TEXT_REVIEW');dependencies.add(key);
 }
 for(const value of source.boxes){const b=exact(value,['elementId','projection'],'box');if(!identifier(b.elementId)||elements.has(b.elementId))fail('box','COMPOSITION_TEXT_REVIEW');elements.add(b.elementId);if(b.projection!==null)projectionShape(b.projection);}
}
function approved(c:Composition,layers:LayerValue[],bindings:Record<string,string>,retained:boolean){
 validateComposition(c);
 if(!c.review)fail('review','COMPOSITION_TEXT_APPROVAL_REQUIRED');
 if(!retained)bindingMap(c,bindings);
 const result=serialize(c,layers,bindings,retained),sourcePrompt=refFor(result.prompt);
 const expected:ProjectionReview={serializer:'caption-json-1',sourceId:c.id,frame:c.frame,request:c.request,dependencies:result.dependencies,boxes:result.boxes,prompt:sourcePrompt};
 if(canonical(c.review)!==canonical(expected))fail('review','COMPOSITION_TEXT_SOURCE_CHANGED');
 return expected;
}
function prose(c:Composition,sourceProjection:ProjectionReview):string{
 const lines:string[]=[];let scalars=0;
 const line=(value:string)=>{
  let count=lines.length?1:0;if(scalars+count>COMPOSITION_TEXT_LIMIT)fail('prompt','COMPOSITION_TEXT_LIMIT');
  for(const scalar of value){const point=scalar.codePointAt(0)!;if(point>=0xd800&&point<=0xdfff)fail('prompt','COMPOSITION_TEXT_UNICODE');if(scalars+(++count)>COMPOSITION_TEXT_LIMIT)fail('prompt','COMPOSITION_TEXT_LIMIT');}
  scalars+=count;lines.push(value);
 };
 const quote=(value:string)=>JSON.stringify(value);
 const palette=(value:string[]|null)=>value===null?'unspecified':JSON.stringify(value);
 line('Image description.');
 line('Scene: '+quote(c.scene));line('Background: '+quote(c.background));
 if(c.style){const s=c.style;line('Style: '+(s.kind==='photo'?'photographic':'art')+'.');line('Aesthetics: '+quote(s.aesthetics));line('Lighting: '+quote(s.lighting));line('Medium: '+quote(s.medium));line((s.kind==='photo'?'Photography: ':'Art style: ')+quote(s.kind==='photo'?s.photo:s.artStyle));line('Style palette: '+palette(s.palette));}
 else line('Style: unspecified.');
 line('Elements in reviewed order:');
 const included=c.elements.filter(e=>!e.excluded);
 if(!included.length)line('No elements are specified.');
 for(let i=0;i<included.length;i++){
  const e=included[i]!,box=sourceProjection.boxes[i]!;
  if(box.elementId!==e.id)fail('review','COMPOSITION_TEXT_SOURCE_CHANGED');
  line('Element '+(i+1)+': '+(e.type==='text'?'text':'object')+'.');
  line('Description: '+quote(bindingValue(e.desc)));
  if(e.type==='text')line('Requested visible text: '+quote(bindingValue(e.text)));
  line('Element palette: '+palette(e.palette));
  if(box.projection){const p:ProjectedBox=box.projection,[top,left,bottom,right]=p.quantized;
   line('Placement hint: left '+left+', top '+top+', right '+right+', bottom '+bottom+' on a normalized 0-1000 scale; 0 is the top/left edge and 1000 is the bottom/right edge of the reviewed frame. These are layout hints, not exact pixel positions.');
   if(p.unclipped.some((n,index)=>n!==p.clipped[index]))line('This placement was clipped to the reviewed frame.');
   if(p.approximation)line('This placement uses an axis-aligned approximation of transformed bounds.');
  }else line(e.bounds&&e.boundsPolicy==='omit'?'Placement: omitted by the reviewed choice.':'Placement: unspecified.');
 }
 return lines.join('\n');
}
function exportValue(c:Composition,layers:LayerValue[],bindings:Record<string,string>,retained:boolean):CompositionTextExport{
 const sourceProjection=approved(c,layers,bindings,retained),prompt=prose(c,sourceProjection);
 const review:CompositionTextReview={serializer:'composition-text-1',sourceId:c.id,sourceProjection:structuredClone(sourceProjection),prompt:refFor(prompt)};
 validateCompositionTextReview(review);
 return {prompt,review};
}
/** Current export: missing/stale links refuse. Exclusions, clip/omit choices and
 * dependencies remain inspectable in the separately retained CompositionRef and
 * this sourceProjection; excluded content is never transmitted in the prose. */
export function exportCompositionText(c:Composition,layers:LayerValue[],bindings:Record<string,string>):CompositionTextExport{return exportValue(c,layers,bindings,false);}
/** Historical replay only: validate immutable last-reviewed values, never claim
 * that retained dependencies are current or manufacture live request authority. */
export function replayCompositionText(c:Composition):CompositionTextExport{return exportValue(c,[],{},true);}
function sameExport(actual:CompositionTextExport,review:CompositionTextReview,prompt?:string):void{
 validateCompositionTextReview(review);
 if(canonical(actual.review)!==canonical(review)||prompt!==undefined&&actual.prompt!==prompt)fail('review','COMPOSITION_TEXT_REVIEW_CHANGED');
}
export function assertCompositionTextReview(c:Composition,layers:LayerValue[],bindings:Record<string,string>,review:CompositionTextReview,prompt:string):void{sameExport(exportCompositionText(c,layers,bindings),review,prompt);}
export function verifyCompositionTextReview(c:Composition,review:CompositionTextReview,prompt?:string):void{sameExport(replayCompositionText(c),review,prompt);}
