import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {integrationCancellation as classify,originalAssetBodyEOF} from './integration-network.mjs';
const origin='http://127.0.0.1:54321',url=origin+'/api/v1/assets/00000000-0000-0000-0000-000000000001/content';
const head={channel:'requestfailed',requestId:7,url,method:'HEAD',resourceType:'fetch',failure:{errorText:'net::ERR_ABORTED'},response:{requestId:7,url,method:'HEAD',status:404,contentType:'application/json; charset=utf-8'}};
const fault={url,status:404,reason:'Fixture removed the actual exact font object'};
test('only the own injected missing-font HEAD is bodyless; static font and failed GET remain failures',()=>{
 assert.equal(classify(head,origin,'chromium',[],[fault]),'own-missing-font-bodyless-head');assert.equal(classify(head,origin,'chromium'),false);
 for(const edit of [e=>e.method=e.response.method='GET',e=>e.response.requestId++,e=>e.response.url+='x',e=>e.response.status=500,e=>e.url=e.response.url=origin+'/assets/font.ttf',e=>e.failure.errorText='net::ERR_FAILED',e=>e.resourceType='other']){const e=structuredClone(head);edit(e);assert.equal(classify(e,origin,'chromium',[],[fault]),false);}
 for(const f of [{...fault,url:url+'x'},{...fault,status:500},{...fault,reason:''}])assert.equal(classify(head,origin,'chromium',[],[f]),false);
 assert.equal(classify(head,origin,'firefox',[],[fault]),false);
});
test('a destination read requires its original request and saved bytes, never another request or a static response',()=>{
 const e=structuredClone(head);e.method=e.response.method='GET';Object.assign(e.response,{status:200,contentType:'image/png',contentLength:'31',etag:'"sha256:'+'a'.repeat(64)+'"'});
 const p={requestId:7,url,oneOwnedRequestInExplicitExportWindow:true,destinationComplete:true,downloadURL:'blob:'+origin+'/own',bytes:31,sha256:'a'.repeat(64)};
 assert.equal(classify(e,origin,'chromium',[p]),'exact-original-completed-destination');assert.equal(classify(e,origin,'chromium'),false);
 for(const edit of [x=>x.requestId++,x=>x.url+='x',x=>x.oneOwnedRequestInExplicitExportWindow=false,x=>x.destinationComplete=false,x=>x.downloadURL='blob:http://other/own',x=>x.bytes--,x=>x.sha256='b'.repeat(64)]){const x=structuredClone(p);edit(x);assert.equal(classify(e,origin,'chromium',[x]),false);}
 for(const edit of [x=>x.response.requestId++,x=>x.response.status=500,x=>x.response.method='HEAD',x=>x.response.url+='x',x=>x.url=x.response.url=origin+'/assets/font.ttf']){const x=structuredClone(e);edit(x);assert.equal(classify(x,origin,'chromium',[p]),false);}
});

test('portable namespace HEAD is bodyless only for the exact imported identity and version',()=>{
 const importedId='p_'+createHash('sha256').update(JSON.stringify(['own-import','document','original'])).digest('hex');
 const e=structuredClone(head);e.url=e.response.url=origin+'/api/v1/documents/'+importedId;e.response.status=200;e.response.entityVersion='13';delete e.response.contentType;
 const proof={requestId:e.requestId,url:e.url,origin,namespace:'own-import',sourceId:'original',localId:importedId,computedId:importedId,documentId:importedId,revision:'13',redirectedFrom:null,fromServiceWorker:false,ownerPage:true};
 assert.equal(classify(e,origin,'chromium',[],[],[],[proof]),'imported-document-bodyless-head');assert.equal(classify(e,origin,'chromium'),false);
 for(const mutate of [p=>p.namespace='',p=>p.namespace='different-namespace',p=>p.sourceId='different-source',p=>p.documentId='other',p=>p.computedId='other',p=>p.revision='12',p=>p.redirectedFrom=e.url,p=>p.fromServiceWorker=true,p=>p.ownerPage=false]){const p=structuredClone(proof);mutate(p);assert.equal(classify(e,origin,'chromium',[],[],[],[p]),false);}
 for(const edit of [x=>x.method=x.response.method='GET',x=>x.url=x.response.url=x.url+'?extra=1',x=>x.response.entityVersion='01',x=>x.response.entityVersion='',x=>x.response.status=404,x=>x.response.requestId++,x=>x.url=x.response.url=x.url.slice(0,-1)]){const x=structuredClone(e);edit(x);assert.equal(classify(x,origin,'chromium',[],[],[],[proof]),false);}
});

// Use the actual shared observer's pure association logic; these fabricated
// rows test the integration join and confer no browser/runtime qualification.
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const {displayReadProofs,installDisplayReadObserver,DISPLAY_OBSERVATION_LIMIT,DISPLAY_REQUEST_LIMIT}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(readFileSync(new URL('./display-aborts.ts',import.meta.url),'utf8'),{mode:'strip'})).toString('base64'));
function workflowRead(method,path,status,engine='chromium'){
 const url=origin+path,base={frameId:1,document:'10000000-0000-4000-8000-000000000001',operation:1,url,method,start:100};
 const rows=[{...base,kind:'start',at:100,hasSignal:false},{...base,kind:'response',at:110,status,responseURL:url,redirected:false},{...base,kind:'reader',at:111,reader:1},{...base,kind:'complete',at:120,reader:1,bytes:64}];
 const native={requestId:19,frameId:1,url,method,resourceType:'fetch',startTime:101,redirected:false,response:{url,status,fromServiceWorker:false}};
 const event={channel:'requestfailed',requestId:19,url,method,resourceType:'fetch',failure:{errorText:{chromium:'net::ERR_ABORTED',firefox:'NS_BINDING_ABORTED',webkit:'cancelled'}[engine]},response:{requestId:19,url,method,status,contentType:'application/json; charset=utf-8',contentLength:'64'}};
 return {rows,native,event};
}
const withWorkflow=(event,engine,proofs)=>classify(event,origin,engine,[],[],[],[],{proofs:[],sse:[]},proofs);
test('integration forwards exact original JSON workflow EOF proofs for each engine without converting them to domain success',()=>{
 for(const engine of ['chromium','firefox','webkit'])for(const [method,path,status] of [['GET','/api/v1/commands/command',202],['POST','/api/v1/commands',201],['PUT','/api/v1/staging/stage',200]]){
  const x=workflowRead(method,path,status,engine),proofs=displayReadProofs(x.rows,[x.native]);assert.equal(proofs.length,1);
  assert.equal(withWorkflow(x.event,engine,proofs),'exact-original-json-response-eof');assert.equal(classify(x.event,origin,engine),false);assert.equal(withWorkflow(x.event,engine,[]),false);
  // A recovery receipt cannot stand in for this separately observed response.
  assert.equal(classify(x.event,origin,engine,[],[],[],[],{proofs,sse:[]}),false);
 }
});
test('integration workflow evidence never substitutes another request method status body or ambiguous association',()=>{
 const x=workflowRead('PUT','/api/v1/staging/stage',200),[proof]=displayReadProofs(x.rows,[x.native]);
 for(const mutate of [p=>p.requestId++,p=>p.url+='?other',p=>p.method='GET',p=>p.status=201,p=>p.bodyComplete=false,p=>{p.bodyComplete=false;p.bodyCanceled=true;p.signalAborted=true;},p=>p.bytes--,p=>p.exactOccurrence=false,p=>p.association='url-only',p=>p.requestFrame++,p=>p.eligibleRequests.push(20),p=>p.concurrentOperations.push(20)]){const p=structuredClone(proof);mutate(p);assert.equal(withWorkflow(x.event,'chromium',[p]),false);}
 for(const mutate of [e=>e.response.contentLength='064',e=>e.response.contentType='text/plain',e=>e.response.status=500,e=>e.response.method='POST',e=>e.response.requestId++,e=>e.failure.errorText='net::ERR_FAILED',e=>e.url=e.response.url=origin+'/static/result.json']){const e=structuredClone(x.event);mutate(e);assert.equal(withWorkflow(e,'chromium',[proof]),false);}
 for(const rows of [x.rows.slice(0,-1),[...x.rows,{...x.rows.at(-1),kind:'clone'}]])assert.equal(withWorkflow(x.event,'chromium',displayReadProofs(rows,[x.native])),false);
 assert.equal(withWorkflow(x.event,'chromium',displayReadProofs(x.rows,[x.native],['lost original binding'])),false);
});
test('integration retains only the original readonly signal when native read and cancel reject after that abort',()=>{
 const x=workflowRead('GET','/api/v1/assets/asset/display-tile',200);x.rows[0].hasSignal=true;x.rows.splice(3,1,{...x.rows[2],kind:'abort',at:115,aborted:true},{...x.rows[2],kind:'read-rejected',at:116,errorName:'AbortError'},{...x.rows[2],kind:'cancel-rejected',at:117,errorName:'AbortError'});Object.assign(x.event.response,{contentType:'application/x-ideogram-rgba8',etag:'"sha256:'+'a'.repeat(64)+'"'});
 const proofs=displayReadProofs(x.rows,[x.native]);assert.equal(proofs.length,1);assert.equal(proofs[0].signalAborted,true);assert.equal(proofs[0].bodyCanceled,false);assert.equal(proofs[0].bodyComplete,false);assert.equal('bytes' in proofs[0],false);assert.equal(withWorkflow(x.event,'chromium',proofs),'exact-request-observed-display-terminal');assert.equal(withWorkflow(x.event,'chromium',[]),false);
 for(const mutate of [rows=>rows[0].hasSignal=false,rows=>rows[3].aborted=false,rows=>rows[4].errorName='NetworkError',rows=>rows[5].reader=2,rows=>rows[5].errorName='NetworkError']){const rows=structuredClone(x.rows);mutate(rows);assert.equal(withWorkflow(x.event,'chromium',displayReadProofs(rows,[x.native])),false);}
 const pending=workflowRead('GET','/api/v1/commands/command',202);pending.rows[0].hasSignal=true;pending.rows.splice(3,1,{...pending.rows[2],kind:'abort',at:115,aborted:true},{...pending.rows[2],kind:'read-rejected',at:116,errorName:'AbortError'},{...pending.rows[2],kind:'cancel-rejected',at:117,errorName:'AbortError'});assert.equal(withWorkflow(pending.event,'chromium',displayReadProofs(pending.rows,[pending.native])),false);
});


const assetEOFReason='exact-original-asset-response-eof';
function assetRead(engine='chromium',lateAbort=true){
 const x=workflowRead('GET','/api/v1/assets/00000000-0000-0000-0000-000000000001/content',200,engine);
 x.rows[0].hasSignal=lateAbort;x.rows[3].originalReader=true;
 if(lateAbort)x.rows.push({...x.rows[0],kind:'abort',at:130,aborted:true});
 Object.assign(x.event.response,{contentType:'application/octet-stream',etag:'"sha256:'+'a'.repeat(64)+'"'});
 return x;
}
const assetClass=(x,requests=[x.native],errors=[])=>withWorkflow(x.event,'chromium',displayReadProofs(x.rows,requests,errors));
test('asset response EOF is an exact original-body disposition for each engine, never a font hash or native success',()=>{
 for(const engine of ['chromium','firefox','webkit'])for(const lateAbort of [false,true]){
  const x=assetRead(engine,lateAbort),before=structuredClone(x),proofs=displayReadProofs(x.rows,[x.native]);
  assert.equal(proofs.length,1);const w=proofs[0].assetBodyEOF;
  assert.deepEqual(w,{kind:'original-asset-body-eof-1',frameId:1,document:x.rows[0].document,operation:1,url:x.event.url,method:'GET',start:100,responseAt:110,readerAt:111,completedAt:120,signalAbortAt:lateAbort?130:null,reader:1,originalReader:true,bytes:64,observedRows:lateAbort?5:4});
  assert.equal(withWorkflow(x.event,engine,proofs),assetEOFReason);assert.equal(withWorkflow(x.event,engine,[]),false);
  assert.equal(classify(x.event,origin,engine,[],[],proofs),false); // Not a font proof.
  assert.deepEqual(x,before);assert.equal(Object.hasOwn(w,'sha256'),false);assert.equal(Object.hasOwn(w,'transportSuccess'),false);
 }
});
test('asset EOF refuses incomplete, failed, cloned, teed, canceled and non-original readers',()=>{
 const mutations=[
  x=>x.rows.splice(0,1),x=>x.rows.splice(1,1),x=>x.rows.splice(2,1),x=>x.rows.splice(3,1),
  x=>x.rows.splice(3,0,{...x.rows[2],reader:2}),x=>x.rows.splice(4,0,{...x.rows[3]}),
  x=>delete x.rows[3].originalReader,x=>x.rows[3].originalReader=false,x=>x.rows[2].reader=2,x=>x.rows[3].reader=2,
  x=>{for(const row of x.rows)row.document='-'.repeat(36);},x=>x.rows[3].bytes=0,x=>x.rows[3].bytes=63,x=>x.rows[3].bytes=Number.MAX_SAFE_INTEGER+1,
  ...['clone','tee','observer-error','read-rejected','cancel-rejected','rejected','cancel','unknown-observation'].map(kind=>x=>x.rows.splice(3,0,{...x.rows[2],kind,at:115,errorName:'AbortError'})),
  x=>x.rows.push({...x.rows[2],kind:'cancel',at:140}),x=>x.rows.push({...x.rows[2],kind:'read-rejected',at:140,errorName:'AbortError'})
 ];
 for(const [i,mutate]of mutations.entries()){const x=assetRead();mutate(x);assert.equal(assetClass(x),false,'mutation '+i);}
 const historical=assetRead();delete historical.rows[3].originalReader;
 assert.equal(displayReadProofs(historical.rows,[historical.native])[0].bodyComplete,true);assert.equal(assetClass(historical),false,'old byte counts do not supply the new receiver witness');
});
test('asset EOF requires ordered complete observations and never infers a later abort cause',()=>{
 const mutations=[x=>x.rows[4].at=119,x=>x.rows[4].at=120,x=>x.rows[4].aborted=false,x=>delete x.rows[4].aborted,x=>x.rows[0].hasSignal=false,x=>delete x.rows[0].hasSignal,x=>x.rows.push({...x.rows[4],at:140}),x=>x.rows[2].at=109,x=>x.rows[3].at=110,x=>x.rows[3].at=NaN,x=>[x.rows[2],x.rows[3]]=[x.rows[3],x.rows[2]]];
 for(const [i,mutate]of mutations.entries()){const x=assetRead();mutate(x);assert.equal(assetClass(x),false,'ordering '+i);}
 const x=assetRead();assert.equal(assetClass(x,[x.native],['lost original observation']),false);
 const rows=Array.from({length:DISPLAY_OBSERVATION_LIMIT},()=>x.rows[0]);assert.deepEqual(displayReadProofs(rows,[x.native]),[]);
 const requests=Array.from({length:DISPLAY_REQUEST_LIMIT},()=>x.native);assert.deepEqual(displayReadProofs(x.rows,requests),[]);
});
test('asset EOF requires a unique original Request with actual positive native timing and response provenance',()=>{
 for(const [i,mutate]of [n=>n.frameId++,n=>n.startTime=0,n=>delete n.startTime,n=>n.startTime=NaN,n=>n.startTime=113,n=>n.method='POST',n=>n.resourceType='other',n=>n.redirected=true,n=>delete n.redirected,n=>delete n.response,n=>n.response.url+='?other',n=>n.response.status=500,n=>n.response.fromServiceWorker=true,n=>delete n.response.fromServiceWorker].entries()){
  const x=assetRead();mutate(x.native);assert.equal(assetClass(x),false,'native '+i);
 }
 const x=assetRead();assert.equal(assetClass(x,[]),false);assert.equal(assetClass(x,[x.native,{...x.native,requestId:20}]),false);
 // A duplicate identity outside this URL/frame cannot be hidden by the local match.
 assert.equal(assetClass(x,[x.native,{...x.native,frameId:2,url:origin+'/api/v1/queue'}]),false);
 const other=x.rows.map(row=>({...row,operation:2}));assert.equal(assetClass({...x,rows:[...x.rows,...other]},[x.native,{...x.native,requestId:20}]),false);
});
test('asset EOF checks exact public response framing and only the canonical same-origin content route',()=>{
 const x=assetRead(),proofs=displayReadProofs(x.rows,[x.native]);
 const edits=[e=>e.channel='response',e=>e.resourceType='other',e=>e.failure.errorText='net::ERR_FAILED',e=>e.method=e.response.method='POST',e=>e.response.requestId++,e=>e.response.url+='?other',e=>e.response.method='HEAD',e=>e.response.status=206,e=>e.response.contentType='text/plain',e=>delete e.response.contentLength,e=>e.response.contentLength='064',e=>e.response.contentLength='0',e=>e.response.contentLength='63',e=>e.response.contentLength=64,e=>e.response.etag='sha256:'+'a'.repeat(64),e=>e.response.etag='W/"sha256:'+'a'.repeat(64)+'"',e=>e.response.etag='"sha256:'+'A'.repeat(64)+'"'];
 for(const [i,edit]of edits.entries()){const e=structuredClone(x.event);edit(e);assert.equal(withWorkflow(e,'chromium',proofs),false,'framing '+i);}
 for(const target of [x.event.url+'?extra=1',x.event.url+'#fragment',x.event.url.replace(origin,'http://127.0.0.1:54322'),origin+'/api/v1/assets/not-an-id/content',origin+'/api/v1/bundles/00000000-0000-0000-0000-000000000001/content',origin+'/assets/font.ttf']){
  const y=assetRead();y.event.url=y.event.response.url=y.native.url=y.native.response.url=target;for(const row of y.rows){row.url=target;if(row.responseURL)row.responseURL=target;}
  assert.equal(assetClass(y),false,target);
 }
});
test('asset EOF cannot be reconstituted from mismatched, duplicate or inferred workflow proof fields',()=>{
 const x=assetRead(),[proof]=displayReadProofs(x.rows,[x.native]);
 const edits=[p=>delete p.assetBodyEOF,p=>p.requestId++,p=>p.frameId++,p=>p.requestFrame++,p=>p.document='other',p=>p.document=p.assetBodyEOF.document='-'.repeat(36),p=>p.operation++,p=>p.url+='?other',p=>p.method='POST',p=>p.status=201,p=>p.bodyComplete=false,p=>p.bodyCanceled=true,p=>p.signalAborted=false,p=>p.bytes--,p=>p.exactOccurrence=false,p=>p.eligibleRequests.push(20),p=>p.concurrentOperations.push(2),p=>p.association='unique-frame-time-bijection',p=>p.bijection={},p=>p.inferredAssociation=false,p=>p.requestTiming='observed',p=>p.requestStartRaw=101,p=>p.requestStart=0,p=>p.requestStart=113,p=>p.end++,p=>p.assetBodyEOF.kind='body-count',p=>p.assetBodyEOF.frameId++,p=>p.assetBodyEOF.document='other',p=>p.assetBodyEOF.operation++,p=>p.assetBodyEOF.url+='?other',p=>p.assetBodyEOF.method='POST',p=>p.assetBodyEOF.start++,p=>p.assetBodyEOF.reader=2,p=>p.assetBodyEOF.originalReader=false,p=>p.assetBodyEOF.bytes--,p=>p.assetBodyEOF.completedAt++,p=>p.assetBodyEOF.responseAt=99,p=>p.assetBodyEOF.readerAt=121,p=>p.assetBodyEOF.signalAbortAt=120,p=>p.assetBodyEOF.signalAbortAt=null,p=>p.assetBodyEOF.observedRows=4];
 for(const [i,edit]of edits.entries()){const p=structuredClone(proof);edit(p);assert.equal(withWorkflow(x.event,'chromium',[p]),false,'proof '+i);}
 assert.equal(withWorkflow(x.event,'chromium',[proof,structuredClone(proof)]),false);
 for(const malformed of [null,undefined,{},[null],[proof,null]])assert.equal(originalAssetBodyEOF(x.event,origin,malformed),false);
});

import {createContext,runInContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
test('actual observer records original asset reader provenance without replacing native calls or promises',async()=>{
 for(const borrow of ['none','body','reader']){
  const observed=[],calls=[],part={done:false,value:new Uint8Array(64)},eof={done:true,value:undefined},partPromise=Promise.resolve(part),eofPromise=Promise.resolve(eof);let reads=0;
  const reader={read:function(...args){calls.push({kind:'read',receiver:this,args});return ++reads===1?partPromise:eofPromise;},cancel(){throw Error('No extra cancel');}};
  const body={getReader:function(...args){calls.push({kind:'getReader',receiver:this,args});return reader;},cancel(){throw Error('No extra cancel');},tee(){throw Error('No extra tee');}};
  const response={body,status:200,url,redirected:false,clone(){throw Error('No extra clone');}},fetchPromise=Promise.resolve(response);
  const realm=createContext({URL,Request,Promise,performance,crypto:webcrypto,location:{protocol:'http:',origin,href:origin+'/'}});realm.window=realm;realm.fetch=function(...args){calls.push({kind:'fetch',receiver:this,args});return fetchPromise;};realm.__validationDisplayAbort=event=>{observed.push(event);return Promise.resolve();};
  runInContext('('+installDisplayReadObserver.toString()+')()',realm);
  const fetchThis={},foreignBody={},foreignReader={},init={};assert.equal(realm.fetch.call(fetchThis,url,init),fetchPromise);assert.equal(await fetchPromise,response);
  assert.equal(body.getReader.call(borrow==='body'?foreignBody:body,'option'),reader);
  assert.equal(reader.read.call(borrow==='reader'?foreignReader:reader,'part'),partPromise);assert.equal(await partPromise,part);
  assert.equal(reader.read.call(reader,'eof'),eofPromise);assert.equal(await eofPromise,eof);await realm.__validationDisplayObserver.flush();
  assert.equal(calls.length,4);assert.equal(calls[0].receiver,fetchThis);assert.equal(calls[0].args[1],init);assert.equal(calls[1].receiver,borrow==='body'?foreignBody:body);assert.deepEqual(calls[1].args,['option']);assert.equal(calls[2].receiver,borrow==='reader'?foreignReader:reader);assert.deepEqual(calls[2].args,['part']);
  assert.deepEqual(observed.map(e=>e.kind),['start','response','reader','complete']);assert.equal(observed.at(-1).originalReader,borrow==='none');assert.equal(observed.at(-1).bytes,64);
  const rows=observed.map(e=>({...e,frameId:1})),native={requestId:7,frameId:1,url,method:'GET',resourceType:'fetch',startTime:rows[0].start,redirected:false,response:{url,status:200,fromServiceWorker:false}},event=assetRead().event;event.requestId=event.response.requestId=7;
  assert.equal(withWorkflow(event,'chromium',displayReadProofs(rows,[native])),borrow==='none'?assetEOFReason:false);
 }
});
