import type {BlobRef} from '../protocol/store.js';
import type {TextSource,TextStyle,FontVersion,TextPlacement} from '../protocol/text.js';
import {parseCaption,LIMITS} from '../composition/core.js';
import {canonical} from '../protocol/json.js';
import {SHA256} from '../protocol/sha256.js';
import {blob,id,keys,seq,requireValue as ok} from '../protocol/validate.js';

export type ReturnedTextElement={index:number;elementHash:string;literal:string;description:string;box:readonly [number,number,number,number]|null};
export type ReturnedDescriptionInspection={state:'available';elements:ReturnedTextElement[]}|{state:'unavailable';reason:string};
export type ReturnedDescriptionReview={
 kind:'returned-description-review-1';id:string;jobId:string;attemptId:string;returnedPrompt:BlobRef;
 elementIndex:number;elementHash:string;documentId:string;documentRevision:string;literal:BlobRef;
 frame:{width:number;height:number};placement:TextPlacement;styleHash:string;fontsHash:string;
 placementChoice:'keep-both'|'separate-placement';duplicationAcknowledged:true;hash:string;
};
export type ReturnedDescriptionSelection=Pick<ReturnedDescriptionReview,'jobId'|'attemptId'|'returnedPrompt'|'elementIndex'|'elementHash'|'placementChoice'|'duplicationAcknowledged'>&{kind:'returned-description-selection-1'};
export type ReturnedTextProposal={selection:ReturnedDescriptionSelection;literal:string;frame:{width:number;height:number};placement:TextPlacement};
export type ReturnedTextOrigin={schemaVersion:1;kind:'created-text-description-1';review:ReturnedDescriptionReview;createdLayerId:string;createdSource:BlobRef};
const hash=(value:string)=>new SHA256().update(new TextEncoder().encode(value)).digest();
const digest=(v:unknown)=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

/** Parsing is an explicit local action. It never creates layers or repairs input. */
export function inspectReturnedDescription(bytes:Uint8Array):ReturnedDescriptionInspection {
 const parsed=parseCaption(bytes);
 if(parsed.state!=='supported'||!parsed.value)return {state:'unavailable',reason:parsed.state==='over-limit'?'The retained description exceeds the supported parser limit. Its original bytes remain available.':'This returned description is not a supported caption. Inspect the exact original bytes or review a separate conversion.'};
 const elements=parsed.value.compositional_deconstruction.elements.flatMap((element,index)=>element.type==='text'?[{index,elementHash:hash(canonical(element)),literal:element.text as string,description:element.desc as string,box:element.bbox?element.bbox as [number,number,number,number]:null}]:[]);
 return elements.length?{state:'available',elements}:{state:'unavailable',reason:'This supported caption contains no text elements.'};
}
export function validateReturnedDescriptionReview(v:any):asserts v is ReturnedDescriptionReview {
 keys(v,['kind','id','jobId','attemptId','returnedPrompt','elementIndex','elementHash','documentId','documentRevision','literal','frame','placement','styleHash','fontsHash','placementChoice','duplicationAcknowledged','hash']);
 ok(v.kind==='returned-description-review-1'&&[v.id,v.jobId,v.attemptId,v.documentId].every(id)&&seq(v.documentRevision));
 blob(v.returnedPrompt);blob(v.literal);ok(['text/plain','text/plain;charset=utf-8'].includes(v.returnedPrompt.mediaType)&&BigInt(v.returnedPrompt.byteLength)<=BigInt(LIMITS.bytes)&&['text/plain','text/plain;charset=utf-8'].includes(v.literal.mediaType)&&BigInt(v.literal.byteLength)>0n&&BigInt(v.literal.byteLength)<=16384n);
 ok(Number.isSafeInteger(v.elementIndex)&&v.elementIndex>=0&&v.elementIndex<LIMITS.elements&&[v.elementHash,v.styleHash,v.fontsHash,v.hash].every(digest));
 keys(v.frame,['width','height']);ok([v.frame.width,v.frame.height].every(n=>Number.isFinite(n)&&n>0&&n<=8192)&&Math.ceil(v.frame.width)*Math.ceil(v.frame.height)<=25000000);
 keys(v.placement,['x','y']);ok(Number.isFinite(v.placement.x)&&Number.isFinite(v.placement.y));
 ok(['keep-both','separate-placement'].includes(v.placementChoice)&&v.duplicationAcknowledged===true);
 const {hash:token,...binding}=v;ok(token===hash(canonical(binding)));
}
export function makeReturnedDescriptionReview(input:Omit<ReturnedDescriptionReview,'kind'|'hash'|'styleHash'|'fontsHash'>&{style:TextStyle;fonts:FontVersion[]}):ReturnedDescriptionReview {
 const {style,fonts,...fields}=input,binding={kind:'returned-description-review-1' as const,...structuredClone(fields),styleHash:hash(canonical(style)),fontsHash:hash(canonical(fonts))};
 const review={...binding,hash:hash(canonical(binding))};validateReturnedDescriptionReview(review);return review;
}
/** Exact owned bytes and a prepared local source are required at the writer. */
export function verifyReturnedDescriptionReview(review:ReturnedDescriptionReview,bytes:Uint8Array,source:TextSource):ReturnedTextElement {
 validateReturnedDescriptionReview(review);ok(String(bytes.byteLength)===review.returnedPrompt.byteLength&&new SHA256().update(bytes).digest()===review.returnedPrompt.hash);
 const inspection=inspectReturnedDescription(bytes);ok(inspection.state==='available');
 if(inspection.state!=='available')throw Error('RETURNED_DESCRIPTION_UNAVAILABLE');
 const selected=inspection.elements.find(element=>element.index===review.elementIndex);ok(!!selected&&selected.elementHash===review.elementHash);
 ok(same(source.text.textUtf8,review.literal)&&same(source.text.frame,review.frame)&&hash(canonical(source.text.style))===review.styleHash&&hash(canonical(source.text.fonts))===review.fontsHash);
 return selected!;
}
export function validateReturnedTextOrigin(v:any):asserts v is ReturnedTextOrigin {
 keys(v,['schemaVersion','kind','review','createdLayerId','createdSource']);ok(v.schemaVersion===1&&v.kind==='created-text-description-1'&&id(v.createdLayerId));validateReturnedDescriptionReview(v.review);blob(v.createdSource);ok(v.createdSource.mediaType==='application/json'&&BigInt(v.createdSource.byteLength)<=65536n);
}
export function returnedTextOriginRefs(v:ReturnedTextOrigin):BlobRef[]{validateReturnedTextOrigin(v);return [v.review.returnedPrompt,v.review.literal,v.createdSource];}

/** Caption boxes are row-first normalized suggestions, never measured geometry. */
export function approximateReturnedTextBox(box:ReturnedTextElement['box'],width:number,height:number){
 ok(Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&width<=8192&&height<=8192&&width*height<=25000000);
 ok(box===null||Array.isArray(box)&&box.length===4&&box.every(value=>Number.isInteger(value)&&value>=0&&value<=1000)&&box[0]<box[2]&&box[1]<box[3]);
 return box?{placement:{x:box[1]*width/1000,y:box[0]*height/1000},frame:{width:(box[3]-box[1])*width/1000,height:(box[2]-box[0])*height/1000},approximate:true as const}:{placement:{x:0,y:0},frame:{width:Math.min(width,360),height:Math.min(height,180)},approximate:true as const};
}

/** Recoverable intent has no placement or writer authority until the final review. */
export function validateReturnedDescriptionSelection(v:any):asserts v is ReturnedDescriptionSelection {
 keys(v,['kind','jobId','attemptId','returnedPrompt','elementIndex','elementHash','placementChoice','duplicationAcknowledged']);
 ok(v.kind==='returned-description-selection-1'&&id(v.jobId)&&id(v.attemptId));blob(v.returnedPrompt);
 ok(['text/plain','text/plain;charset=utf-8'].includes(v.returnedPrompt.mediaType)&&BigInt(v.returnedPrompt.byteLength)<=BigInt(LIMITS.bytes)&&Number.isSafeInteger(v.elementIndex)&&v.elementIndex>=0&&v.elementIndex<LIMITS.elements&&digest(v.elementHash)&&['keep-both','separate-placement'].includes(v.placementChoice)&&v.duplicationAcknowledged===true);
}
export function returnedDescriptionSelection(review:ReturnedDescriptionReview):ReturnedDescriptionSelection {
 validateReturnedDescriptionReview(review);const {jobId,attemptId,returnedPrompt,elementIndex,elementHash,placementChoice,duplicationAcknowledged}=review;
 return {kind:'returned-description-selection-1',jobId,attemptId,returnedPrompt,elementIndex,elementHash,placementChoice,duplicationAcknowledged};
}
