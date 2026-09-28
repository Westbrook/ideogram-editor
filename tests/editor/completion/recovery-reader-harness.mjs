import {EventEmitter} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {originalRecoveryReader} from '../original-recovery-reader.ts';
import {recoveryFixture} from './recovery-fixture.mjs';
export async function recoveryReaderHarness(){
 const context=new EventEmitter(),bindings={},scripts=[],frame={};let count=0;
 context.exposeBinding=async(name,fn)=>bindings[name]=fn;context.addInitScript=async(fn,arg)=>scripts.push({fn,arg});context.pages=()=>[];
 const out=mkdtempSync(join(tmpdir(),'original-sse-controls-')),reader=await originalRecoveryReader(context,out,q=>q.testId);
 const send=(event,f=frame)=>bindings.p1c6RecoveryRead({frame:f},structuredClone(event));
 const origin='http://127.0.0.1:34567',document='00000000-0000-0000-0000-000000000001',owners=[{clientId:'client',sessionId:'session'}];
 function request(url,start,operation,type,length,etag){url=origin+url;const base={url,method:'GET',start,operation,document,owners:structuredClone(owners),timeOrigin:0,responseAt:start+1,status:200,responseURL:url,redirected:false,headers:{type,length,etag}};let response;
  const q={testId:++count,url:()=>url,method:()=> 'GET',frame:()=>frame,timing:()=>({startTime:start+.5}),redirectedFrom:()=>null,failure:()=>({errorText:'net::ERR_ABORTED'})};
  response={request:()=>q,status:()=>200,url:()=>url,headers:()=>({'content-type':type,'cache-control':'no-store'}),finished:async()=>null,fromServiceWorker:()=>false};context.emit('request',q);context.emit('response',response);
  send({...base,kind:'start'});send({...base,kind:'response'});send({...base,kind:'reader',readerNumber:1});return base;
 }
 async function scenario({mutate=()=>{},bodyFault,duplicateFrame=false,streamAbort=false}={}){
  const f=recoveryFixture(),stream=request('/api/v1/events/stream?after=0',1,1,'text/event-stream',null,null),bytes=duplicateFrame?Buffer.concat([f.frame,f.frame]):f.frame;
  send({...stream,kind:'chunk',at:5,reads:1,readerNumber:1,count:bytes.length,chunk:bytes.toString('base64')});
  if(streamAbort){send({...stream,kind:'signal-abort',at:6,aborted:true,reasonName:'AbortError'});send({...stream,kind:'read-error',at:45,error:'AbortError'});}
  const b=Buffer.from(f.bytes);if(bodyFault==='corrupt')b[10]^=1;const body=bodyFault==='truncated'?b.subarray(0,b.length-10):b;
  const content=request(f.reference.content.url,10,2,'application/x-ndjson',String(body.length),'"'+f.reference.content.blob.hash+'"');send({...content,kind:'chunk',at:15,reads:1,readerNumber:1,count:body.length,chunk:body.toString('base64')});send({...content,kind:'eof',end:20,reads:2,readerNumber:1,readers:1,count:body.length,overflow:false});
  const value=Buffer.from(JSON.stringify(f.final)),validation=request('/api/v1/events?after=2&recoveryId=recovery_fixture',21,3,'application/json',String(value.length),null);send({...validation,kind:'chunk',at:25,reads:1,readerNumber:1,count:value.length,chunk:value.toString('base64')});send({...validation,kind:'eof',end:30,reads:2,readerNumber:1,readers:1,count:value.length,overflow:false});
  for(let i=0;i<2;i++)send({document,kind:'publication-writes',db:'ie-projection-client',at:32+i,transaction:i+1,records:[{store:'rows',key:['generation','event',f.values[i].eventId],value:f.values[i].workspaceSeq},{store:'rows',key:['generation','document',f.doc.id],value:i?f.finalDocument:f.doc}]});
  send({document,kind:'publication-writes',db:'ie-projection-client',at:40,transaction:3,records:[{store:'meta',key:'published',value:{generation:'generation',cursor:'2',epoch:'1'},at:39}]});
  mutate(reader.events,send);return reader.seal();
 }
 return {context,bindings,scripts,send,reader,scenario,out,frame};
}
