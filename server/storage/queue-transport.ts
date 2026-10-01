import type {StageItem} from '../../src/protocol/queue.js';
import type {Request} from '../../src/request/core.js';
import {StoreError} from './errors.js';

/** Replace only the sealed serializer's exact attachment fields. The rest of
 * the body remains byte-for-byte unchanged, including integers above 2^53. */
export function materializeTransportTemplate(template:string,request:Request,stages:readonly StageItem[],mapping:Readonly<Record<string,string>>):string {
 const roles=new Set(stages.map(s=>s.role));
 if(roles.size!==stages.length||[...roles].some(role=>!['source','mask'].includes(role)&&!/^adapter:[0-2]$/.test(role))||Object.keys(mapping).length!==stages.length||Object.keys(mapping).some(k=>!roles.has(k as StageItem['role'])))throw new StoreError('MALFORMED_REQUEST');
 const url=(role:StageItem['role'])=>{const value=mapping[role];if(typeof value!=='string'||!value.length||value.length>8192)throw new StoreError('MALFORMED_REQUEST');return value;};
 const replace=(key:string,before:unknown,after:unknown)=>{const token=JSON.stringify(key)+':'+JSON.stringify(before);if(template.split(token).length!==2)throw new StoreError('CORRUPT_OBJECT');template=template.replace(token,JSON.stringify(key)+':'+JSON.stringify(after));};
 for(const stage of stages){
  if(stage.role==='source'||stage.role==='mask')replace(stage.role==='source'?'image_url':'mask_url','asset:'+stage.original.hash,url(stage.role));
 }
 const adapters=stages.filter((s):s is Extract<StageItem,{versionId:string}>=>s.role.startsWith('adapter:'));
 if(adapters.length){
  if(!('adapters' in request)||adapters.length!==request.adapters.length)throw new StoreError('CORRUPT_OBJECT');
  const before=request.adapters.map(a=>({path:'asset:'+a.hash,scale:Number(a.scale)}));
  const after=request.adapters.map((a,index)=>{const stage=adapters.find(s=>s.role===`adapter:${index}`);if(!stage||stage.versionId!==a.version||stage.original.hash!==a.hash||stage.transport.hash!==a.hash)throw new StoreError('CORRUPT_OBJECT');return {path:url(stage.role),scale:Number(a.scale)};});
  replace('loras',before,after);
 }else if('adapters' in request&&request.adapters.length)throw new StoreError('CORRUPT_OBJECT');
 return template;
}
