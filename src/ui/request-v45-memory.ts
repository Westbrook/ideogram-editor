import {createOwnedModel,modelPayloadBytes,type OwnedModel} from '../observability/model-memory.js';
import {jsonPayloadUnits,reservePromptPayload} from '../observability/prompt-memory.js';

export const V45_INPUT_MODEL_BYTES=1024**2;
export function v45InputBytes(value:unknown){const bytes=modelPayloadBytes(value);if(bytes>V45_INPUT_MODEL_BYTES)throw Error('Prepared input metadata exceeds its local allowance.');return bytes;}
/** Covers canonical intermediate/output strings, sorted-key scalar arrays and
 * UTF-8/hash work. Native engine/header residency is not a heap measurement. */
export function v45InputCalculation<T>(value:unknown,calculate:()=>T):T{const bytes=v45InputBytes(value),lease=reservePromptPayload('request-v45-calculation',jsonPayloadUnits(value)*48+bytes*4+4096,4);try{return calculate();}finally{lease.release();}}
export function ownV45Input<T>(value:T):OwnedModel<T>{return createOwnedModel('request-v45-model',v45InputBytes(value),()=>structuredClone(value),'prompt');}
function spacing(value:unknown,depth=0):number{if(depth>64)throw Error('V45_INPUT_DEPTH');if(!value||typeof value!=='object')return 0;let fields=0,nested=0;if(Array.isArray(value)){fields=value.length;for(const child of value)nested+=spacing(child,depth+1);}else for(const key in value)if(Object.hasOwn(value,key)&&(value as Record<string,unknown>)[key]!==undefined){fields++;nested+=1+spacing((value as Record<string,unknown>)[key],depth+1);}return nested+(fields?fields*(1+2*(depth+1))+1+2*depth:0);}
export function formatV45Input(value:unknown):OwnedModel<string>{v45InputBytes(value);const bytes=(jsonPayloadUnits(value)+spacing(value))*2;if(bytes>V45_INPUT_MODEL_BYTES)throw Error('Prepared input review exceeds its local allowance.');return createOwnedModel('request-v45-json',bytes,()=>JSON.stringify(value,null,2),'prompt');}
/** One slot owns all its components and borrowed Entry through final async/Lit
 * pins. Dropping the base reference cannot release an Entry still in use. */
export function joinV45Input<T>(value:T,models:OwnedModel<unknown>[],releaseBorrow:()=>void):OwnedModel<T>{
 let refs=1,base=true,borrowReleased=false;const released=new Set<number>();
 const cleanup=()=>{const errors:unknown[]=[];for(let i=0;i<models.length;i++)if(!released.has(i))try{models[i].release();released.add(i);}catch(error){errors.push(error);}if(!borrowReleased)try{releaseBorrow();borrowReleased=true;}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'V45_INPUT_RELEASE_INCOMPLETE');};
 const drop=()=>{if(--refs===0)cleanup();};return {value,release(){if(base){base=false;drop();}else if(!refs)cleanup();},pin(){if(!refs)throw Error('V45_INPUT_RELEASED');refs++;let live=true;return ()=>{if(live){live=false;drop();}};}};
}

export type V45InputFingerprint={key:string;matches(value:unknown):boolean};
/** A retained guard owns its key and bounded comparison workspace. Liveness
 * checks never need new budget while cancellation/late receipts are draining. */
export function ownV45Fingerprint(value:unknown,encode:(value:unknown)=>string,digest:(text:string)=>string):OwnedModel<V45InputFingerprint>{
 const bytes=v45InputBytes(value),units=jsonPayloadUnits(value),workspace=reservePromptPayload('request-v45-fingerprint-work',units*48+bytes*4+4096,4);let key:OwnedModel<string>|undefined,live=true;
 try{key=createOwnedModel('request-v45-fingerprint',142,()=>digest(encode(value)),'prompt');const expected=key.value,guard={key:expected,matches(candidate:unknown){if(!live)return false;try{if(v45InputBytes(candidate)>bytes||jsonPayloadUnits(candidate)>units)return false;return digest(encode(candidate))===expected;}catch{return false;}}};return joinV45Input(guard,[key],()=>{live=false;workspace.release();});}catch(error){key?.release();workspace.release();throw error;}
}
