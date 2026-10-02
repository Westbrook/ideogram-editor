import type {Draft} from '../request/family.js';
import {createOwnedModel,modelPayloadBytes,type OwnedModel} from '../observability/model-memory.js';
import {reservePromptJSON} from '../observability/prompt-memory.js';

export type RequestEntry={draft:Draft;text:string;id:string;revision:string;generation:number};
export const REQUEST_ENTRY_BYTES=16*1024**2;
export const REQUEST_ENTRY_COUNT=32;
const bounded=(value:unknown)=>{const bytes=modelPayloadBytes(value);if(bytes>REQUEST_ENTRY_BYTES)throw Error('Request draft exceeds the local editing allowance. The previous draft is retained.');return bytes;};
/** All strings, scalar payloads and keys in the complete family union count.
 * Engine/object headers remain unknown. The reservation precedes the clone. */
export function ownRequestEntry(value:RequestEntry):OwnedModel<RequestEntry>{return createOwnedModel('request-entry',bounded(value),()=>structuredClone(value),'prompt');}
export function createRequestEntry(allowance:number,create:()=>RequestEntry):OwnedModel<RequestEntry>{
 if(!Number.isSafeInteger(allowance)||allowance<0||allowance>REQUEST_ENTRY_BYTES*2+4096)throw Error('Request draft exceeds the local editing allowance. The previous draft is retained.');
 return createOwnedModel('request-entry',allowance,()=>{const next=create();bounded(next);return next;},'prompt');
}
/** Callers supply the actual incoming strings/metadata before creating copies.
 * Mutations touch only a newly admitted clone; a failed later save can discard
 * it without changing the visible Entry or its operation/mode selection. */
export function changeRequestEntry(prior:RequestEntry,growth:unknown,change:(next:RequestEntry)=>void){
 const allowance=bounded(prior)+bounded(growth)+4096;
 return createRequestEntry(allowance,()=>{const next=structuredClone(prior);change(next);return next;});
}
export function serializeRequestEntry(entry:RequestEntry){
 const value={draft:entry.draft,text:entry.text},lease=reservePromptJSON('request-entry-serialize',value);
 try{return {wire:JSON.stringify(value),release:()=>lease.release()};}catch(error){lease.release();throw error;}
}
