import type {DocumentCreationBackground,DocumentCreationMetadata} from './store.js';

export const DOCUMENT_NAME_BYTES=256;
const exact=(value:unknown,fields:readonly string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
function require(value:unknown):asserts value {if(!value)throw Error('Invalid document creation');}
export function validDocumentName(value:unknown):value is string {
  return typeof value==='string'&&value.length>0&&value.length<=DOCUMENT_NAME_BYTES&&value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value)&&new TextEncoder().encode(value).byteLength<=DOCUMENT_NAME_BYTES;
}
export function documentCreationBackground(value:any):asserts value is DocumentCreationBackground {
  require(exact(value,value?.kind==='transparent'?['kind']:['kind','color']));
  require(value.kind==='transparent'||value.kind==='solid'&&Array.isArray(value.color)&&value.color.length===4&&value.color.every((channel:unknown)=>Number.isInteger(channel)&&Number(channel)>=0&&Number(channel)<=255)&&value.color[3]===255);
}
export function documentCreationMetadata(value:any):asserts value is DocumentCreationMetadata {
  require(exact(value,['schemaVersion','name','creationBackground'])&&value.schemaVersion===1&&validDocumentName(value.name));
  const background=value.creationBackground;
  if(background?.kind==='solid'){
    require(exact(background,['kind','color','layerId'])&&typeof background.layerId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(background.layerId));
    documentCreationBackground({kind:background.kind,color:background.color});
  }else documentCreationBackground(background);
}
/** Shape validation is separate from semantic rejection so a well-formed bad
 * name/dimension receives a durable original-command receipt. */
export function documentCreationBody(value:any){
  require(exact(value,['type','name','width','height','background'])&&value.type==='CreateDocument'&&typeof value.name==='string'&&Number.isSafeInteger(value.width)&&Number.isSafeInteger(value.height));
  documentCreationBackground(value.background);
}
