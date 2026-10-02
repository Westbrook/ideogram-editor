import type {OwnedModel} from '../observability/model-memory.js';
import {reservePromptPayload} from '../observability/prompt-memory.js';
import {jsonPayloadUnits} from '../observability/prompt-memory.js';
import {allocationLedger,type AllocationLease} from '../observability/allocations.js';
import {canonical} from '../protocol/json.js';

export type FrozenPromptPage={bytes:string;byteLength:string;offset:string;nextOffset:string|null};
export type PromptPage={text:string;offset:string;next:string|null};
function retained<T>(value:T,lease:AllocationLease):OwnedModel<T>{
 let refs=1,baseLive=true;
 const drop=()=>{if(refs>0&&--refs===0)lease.release();};
 const release=()=>{if(baseLive){baseLive=false;drop();}};
 return {value,release,pin(){if(!baseLive)throw Error('PROVIDER_PAYLOAD_RELEASED');refs++;let live=true;return ()=>{if(live){live=false;drop();}};}};
}

export function decodeFrozenPromptPage(page:FrozenPromptPage,expectedBytes:string,offset:string):OwnedModel<PromptPage>{
 if(page.byteLength!==expectedBytes||page.offset!==offset||typeof page.bytes!=='string'||page.bytes.length>44000||page.bytes.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(page.bytes))throw Error('Frozen prompt page identity is unavailable. Refresh and review again.');
 const decimal=(value:unknown):value is string=>typeof value==='string'&&value.length<=32&&/^(0|[1-9][0-9]*)$/.test(value);
 if(!decimal(offset)||!decimal(page.byteLength)||page.nextOffset!==null&&!decimal(page.nextOffset))throw Error('Frozen prompt page identity is unavailable. Refresh and review again.');
 const decoded=page.bytes.length/4*3-(page.bytes.endsWith('==')?2:page.bytes.endsWith('=')?1:0);
 if(decoded>32768)throw Error('Frozen prompt page exceeds its byte bound.');
 const end=BigInt(offset)+BigInt(decoded),total=BigInt(page.byteLength);
 if(end>total||end<total&&decoded===0||page.nextOffset!==(end===total?null:String(end)))throw Error('Frozen prompt page is incomplete.');
 // The response model separately owns base64 input. Reserve the Latin-1 atob
 // result, explicit byte copy and retained UTF-16 string before decoding.
 const scratch=reservePromptPayload('provider-prompt-decode',decoded*3,2);let output:AllocationLease|undefined;
 try{
  output=reservePromptPayload('provider-prompt-page',decoded*2+(offset.length+(page.nextOffset?.length??0))*2,1);
  const binary=atob(page.bytes),bytes=new Uint8Array(decoded);for(let at=0;at<decoded;at++)bytes[at]=binary.charCodeAt(at);
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  output.resize({cpuBytes:(text.length+offset.length+(page.nextOffset?.length??0))*2});
  const owned=retained({text,offset,next:page.nextOffset},output);output=undefined;return owned;
 }finally{output?.release();scratch.release();}
}

function prettySpacingUnits(value:unknown,depth=0):number {
 if(depth>64)throw Error('PROVIDER_SETTINGS_DEPTH');
 if(!value||typeof value!=='object')return 0;
 let fields=0,nested=0;
 if(Array.isArray(value)){fields=value.length;for(const child of value)nested+=prettySpacingUnits(child,depth+1);}
 else for(const key in value)if(Object.hasOwn(value,key)&&(value as Record<string,unknown>)[key]!==undefined){fields++;nested+=1+prettySpacingUnits((value as Record<string,unknown>)[key],depth+1);}
 // One newline and child indentation per member, then newline/indent before
 // the closing bracket. Object members add one space following the colon.
 return nested+(fields?fields*(1+2*(depth+1))+1+2*depth:0);
}
export function frozenSettings(value:unknown):OwnedModel<string>{
 const units=jsonPayloadUnits(value)+prettySpacingUnits(value);
 const lease=allocationLedger.reserve({owner:'provider-frozen-settings',kind:'control',cpuBytes:units*2,handles:1});
 try{const text=JSON.stringify(value,null,2);lease.resize({cpuBytes:text.length*2});return retained(text,lease);}catch(error){lease.release();throw error;}
}
export function sameProviderValue(a:unknown,b:unknown){
 const units=jsonPayloadUnits(a)+jsonPayloadUnits(b),lease=allocationLedger.reserve({owner:'provider-identity-scratch',kind:'control',cpuBytes:units*12,handles:2});
 try{return canonical(a)===canonical(b);}finally{lease.release();}
}
