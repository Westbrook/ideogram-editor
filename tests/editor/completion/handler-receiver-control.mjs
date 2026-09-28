// Plain-Node, non-browser receiver control. The captured source comes from another process.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {privateHostReceiver} from './host-final-receiver.mjs';
import {hostFixture} from './host-final-fixtures.mjs';
import {HOST_HANDLER_SOURCE} from './host-handler-artifact.mjs';
const capture=JSON.parse(readFileSync(process.argv[2])),out=process.argv[3],results=[];
assert.equal(capture.handler,HOST_HANDLER_SOURCE);
for(const [name,mutate]of Object.entries({
 exact:()=>{},missingSource:x=>delete x.inspection.source,tail:x=>x.inspection.source+='\nreturn false;',code:x=>x.inspection.source=x.inspection.source.replace("write('entered')","write('foreign')"),foreignSource:x=>x.inspection.source='function foreign(){}',context:x=>x.inspection.context.uniqueId='foreign',error:x=>x.inspection.errors.push('error'),released:x=>x.inspection.released=false,native:x=>x.nativeMethod.original=false,nativeText:x=>x.nativeMethod.source='function sendBeacon(){}',epoch:x=>x.nativeClosed.epoch='foreign',row:x=>x.nativeClosed.rows=[{epoch:'epoch',sequence:2}],budget:x=>x.budget.priorCharged=65536
})){
 const x=hostFixture(),receiver=privateHostReceiver({run:'run',origin:x.e.origin,pid:x.e.pid,instance:'instance'}),r=receiver.allocate({epoch:x.e.epoch,context:x.registration.context,url:x.e.origin+'/',namespace:'own:'});
 const value={phase:'terminal',nativeClosed:x.e.nativeClosed,inspection:{...x.registration.inspection,source:capture.handler},nativeMethod:x.registration.nativeMethod,budget:{maximum:32768,limit:65536,priorCharged:0,priorReserved:0}};mutate(value);
 if(name==='exact'){assert.equal(receiver.arm(r.nonce,value).armed,true);}else assert.throws(()=>receiver.arm(r.nonce,value));
 results.push({name,expected:name==='exact'?'accepted':'refused',passed:true});
}
writeFileSync(out,JSON.stringify({pid:process.pid,node:process.version,scope:'Actual plain-Node receiver arm with injected normal ownership prerequisites; no HTTP or live native beacon claim',handler:HOST_HANDLER_SOURCE,results},null,2));
