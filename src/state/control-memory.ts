import {allocationLedger} from '../observability/allocations.js';

export const COMMAND_CONTROL_BYTES=65536;
export const JOURNAL_RECORD_BYTES=1024*1024;
export class ControlAdmissionError extends Error {
 constructor(readonly reason:'size'|'shape',readonly limit:number){super(reason==='size'?'This command or saved delivery is too large for the local editing allowance. Shorten the checkpoint name or other text, or reduce the selected items, then retry. The previous editor state and existing delivery are retained.':'This command contains unsupported control data. Keep the current input and prepare the operation again.');}
}
/** Exact JSON UTF-8 size without constructing a serialized/encoded payload.
 * Bounded plain JSON only: no accessors, toJSON hooks, cycles, sparse arrays or
 * nonfinite numbers. Logical payload excludes engine/object header estimates. */
export function measureControl(value:unknown,maxBytes=COMMAND_CONTROL_BYTES):{encodedBytes:number;logicalBytes:number}{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>JOURNAL_RECORD_BYTES)throw new ControlAdmissionError('size',maxBytes);
 let encodedBytes=0,logicalBytes=0,nodes=0;const ancestors=new Set<object>();
 const fail=():never=>{throw new ControlAdmissionError('shape',maxBytes);};
 const add=(encoded:number,logical=0)=>{encodedBytes+=encoded;logicalBytes+=logical;if(encodedBytes>maxBytes||logicalBytes>JOURNAL_RECORD_BYTES)throw new ControlAdmissionError('size',maxBytes);};
 const string=(text:string)=>{add(2,text.length*2);for(let i=0;i<text.length;i++){const point=text.charCodeAt(i);if(point===34||point===92||point===8||point===9||point===10||point===12||point===13)add(2);else if(point<32)add(6);else if(point<128)add(1);else if(point<2048)add(2);else if(point>=0xd800&&point<=0xdbff){const low=text.charCodeAt(++i);if(!(low>=0xdc00&&low<=0xdfff))fail();add(4);}else if(point>=0xdc00&&point<=0xdfff)fail();else add(3);}};
 const visit=(entry:unknown,depth:number):void=>{
  if(++nodes>maxBytes||depth>64)fail();
  if(entry===null){add(4);return;}if(typeof entry==='string'){string(entry);return;}
  if(typeof entry==='boolean'){add(entry?4:5,1);return;}if(typeof entry==='number'){if(!Number.isFinite(entry))fail();add(String(entry).length,8);return;}
  if(typeof entry!=='object'||entry===null)fail();const object=entry as object;
  if('toJSON'in object||ancestors.has(object))fail();ancestors.add(object);
  if(Array.isArray(entry)){add(2);for(let i=0;i<entry.length;i++){if(i)add(1);const descriptor=Object.getOwnPropertyDescriptor(entry,String(i));if(!descriptor||!('value'in descriptor))return fail();visit(descriptor.value,depth+1);}for(const key in entry)if(Object.hasOwn(entry,key)&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=entry.length))fail();}
  else{if(Object.getPrototypeOf(entry)!==Object.prototype&&Object.getPrototypeOf(entry)!==null)fail();let count=0;add(2);for(const key in entry)if(Object.hasOwn(entry,key)){const descriptor=Object.getOwnPropertyDescriptor(entry,key);if(!descriptor||!('value'in descriptor))return fail();if(descriptor.value===undefined){if(++nodes>maxBytes)fail();add(0,key.length*2);continue;}if(count++)add(1);string(key);add(1);visit(descriptor.value,depth+1);}}
  ancestors.delete(object);
 };visit(value,0);return {encodedBytes,logicalBytes};
}
export function journalRecordBytes(value:unknown){return measureControl(value,JOURNAL_RECORD_BYTES).logicalBytes;}
/** Admission precedes JSON.stringify, parse and the eventual transport copy.
 * The stable parsed envelope is the exact same one persisted and submitted. */
export function reserveCommandWire<T>(value:T){
 const measured=measureControl(value),lease=allocationLedger.reserve({owner:'command-envelope',kind:'control',cpuBytes:measured.logicalBytes*2+measured.encodedBytes*3,handles:3});
 try{const wire=JSON.stringify(value),request=JSON.parse(wire) as T;return {request,wire,release:()=>lease.release()};}catch(error){lease.release();throw error;}
}
