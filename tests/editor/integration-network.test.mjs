import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {integrationCancellation as classify,originalAssetBodyEOF,originalRejectedAssetCancellation} from './integration-network.mjs';
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


const rejectionReason='own-rejected-asset-original-reader-cancellation';
const missingFontFault={url,status:404,reason:'Own exact font object removed; retained canonical pixels remain present.'};
function rejectedAsset(engine='chromium',lateAbort=true){
 const x=workflowRead('GET','/api/v1/assets/00000000-0000-0000-0000-000000000001/content',404,engine);
 x.rows[0].hasSignal=lateAbort;
 x.rows.splice(3,1,{...x.rows[2],kind:'asset-cancel-call',at:112,originalReader:true,readCalls:0,bytes:0},{...x.rows[2],kind:'cancel',at:120,originalReader:true,readCalls:0,bytes:0});
 if(lateAbort)x.rows.push({...x.rows[0],kind:'abort',at:130,aborted:true});
 Object.assign(x.event.response,{contentLength:'163'});return x;
}
const withRejection=(x,proofs=displayReadProofs(x.rows,[x.native]),faults=[missingFontFault],engine='chromium')=>classify(x.event,origin,engine,[],faults,[],[],{proofs:[],sse:[]},proofs);
test('own declared font404 rejection accepts only observed fulfilled original-reader cancellation, retaining native failure',()=>{
 for(const engine of ['chromium','firefox','webkit'])for(const lateAbort of [false,true]){
  const x=rejectedAsset(engine,lateAbort),before=structuredClone(x),proofs=displayReadProofs(x.rows,[x.native]);assert.equal(proofs.length,1);
  assert.deepEqual(proofs[0].assetRejectionCancellation,{kind:'original-asset-rejection-cancel-1',frameId:1,document:x.rows[0].document,operation:1,url:x.event.url,method:'GET',start:100,responseAt:110,readerAt:111,cancelCalledAt:112,cancelFulfilledAt:120,signalAbortAt:lateAbort?130:null,reader:1,originalReader:true,readCalls:0,bytes:0,observedRows:lateAbort?6:5});
  assert.equal(withRejection(x,proofs,[missingFontFault],engine),rejectionReason);assert.equal(proofs[0].bodyComplete,false);assert.equal(proofs[0].bodyCanceled,true);assert.equal(Object.hasOwn(proofs[0],'bytes'),false);assert.equal(Object.hasOwn(proofs[0],'assetBodyEOF'),false);assert.deepEqual(x,before);
 }
 // The observer row order is strict even when the native clock has equal values;
 // no unobserved elapsed interval or abort-cause claim is manufactured.
 const equal=rejectedAsset();equal.rows[5].at=equal.rows[4].at;assert.equal(withRejection(equal),rejectionReason);
 const old=rejectedAsset();old.rows.splice(3,1);delete old.rows[3].originalReader;delete old.rows[3].readCalls;delete old.rows[3].bytes;
 assert.equal(displayReadProofs(old.rows,[old.native])[0].bodyCanceled,true);assert.equal(withRejection(old),false,'run106-style scalar cancellation is not the new original-call witness');
});
test('rejected asset disposition requires its exact declared missing-font fault and public404 response',()=>{
 const x=rejectedAsset(),proofs=displayReadProofs(x.rows,[x.native]);
 for(const faults of [[],[fault],[{...missingFontFault,url:url+'?other'}],[{...missingFontFault,status:503}],[{...missingFontFault,reason:''}],[missingFontFault,{...missingFontFault}],null,{},[null]])assert.equal(originalRejectedAssetCancellation(x.event,origin,faults,proofs),false);
 const edits=[e=>e.channel='response',e=>e.resourceType='other',e=>e.failure.errorText='net::ERR_FAILED',e=>e.method=e.response.method='POST',e=>e.response.requestId++,e=>e.response.url+='?other',e=>e.response.method='HEAD',e=>e.response.status=200,e=>e.response.status=503,e=>e.response.contentType='application/octet-stream',e=>delete e.response.contentLength,e=>e.response.contentLength='0163',e=>e.response.contentLength='0',e=>e.response.contentLength=163,e=>e.response.contentLength=String(Number.MAX_SAFE_INTEGER+1)];
 for(const [i,edit]of edits.entries()){const bad=structuredClone(x);edit(bad.event);assert.equal(withRejection(bad,proofs),false,'public framing '+i);}
 for(const target of [url+'?extra=1',url+'#fragment',url.replace(origin,'http://127.0.0.1:54322'),origin+'/api/v1/assets/not-an-id/content',origin+'/assets/font.ttf']){
  const y=rejectedAsset();y.event.url=y.event.response.url=y.native.url=y.native.response.url=target;for(const row of y.rows){row.url=target;if(row.responseURL)row.responseURL=target;}
  assert.equal(withRejection(y,undefined,[{...missingFontFault,url:target}]),false,target);
 }
});
test('rejected asset witness refuses any read call, duplicate cancellation, incomplete collection or non-original receiver',()=>{
 const mutations=[x=>x.rows.splice(0,1),x=>x.rows.splice(1,1),x=>x.rows.splice(2,1),x=>x.rows.splice(3,1),x=>x.rows.splice(4,1),x=>x.rows[3].originalReader=false,x=>delete x.rows[4].originalReader,x=>delete x.rows[3].readCalls,x=>x.rows[4].readCalls=1,x=>x.rows[3].bytes=1,x=>x.rows[4].reader=0,x=>x.rows.splice(3,0,{...x.rows[2],reader:2}),x=>x.rows.push({...x.rows[3],at:140}),x=>x.rows.push({...x.rows[4],at:140}),x=>x.rows.splice(3,0,{...x.rows[2],kind:'asset-read-call',at:111,readCalls:1}),x=>x.rows.push({...x.rows[2],kind:'asset-read-call',at:140,readCalls:1}),...['clone','tee','observer-error','read-rejected','cancel-rejected','rejected','complete','unknown-observation'].map(kind=>x=>x.rows.splice(4,0,{...x.rows[3],kind,at:115,errorName:'AbortError'})),x=>x.rows[5].at=119,x=>x.rows[5].aborted=false,x=>x.rows[0].hasSignal=false,x=>x.rows[3].at=110,x=>x.rows[4].at=111,x=>x.rows[4].at=NaN,x=>[x.rows[4],x.rows[5]]=[x.rows[5],x.rows[4]]];
 for(const [i,mutate]of mutations.entries()){const x=rejectedAsset();mutate(x);assert.equal(withRejection(x),false,'raw refusal '+i);}
 const x=rejectedAsset();assert.equal(withRejection(x,displayReadProofs(x.rows,[x.native],['lost binding'])),false);
 assert.deepEqual(displayReadProofs(Array.from({length:DISPLAY_OBSERVATION_LIMIT},()=>x.rows[0]),[x.native]),[]);
 assert.deepEqual(displayReadProofs(x.rows,Array.from({length:DISPLAY_REQUEST_LIMIT},()=>x.native)),[]);
});
test('rejected asset witness requires unique native timing and refuses fallback or substituted identity',()=>{
 for(const [i,mutate]of [n=>n.frameId++,n=>n.startTime=0,n=>delete n.startTime,n=>n.startTime=NaN,n=>n.startTime=113,n=>n.method='POST',n=>n.resourceType='other',n=>n.redirected=true,n=>delete n.redirected,n=>delete n.response,n=>n.response.url+='?other',n=>n.response.status=503,n=>n.response.fromServiceWorker=true,n=>delete n.response.fromServiceWorker].entries()){
  const x=rejectedAsset();mutate(x.native);assert.equal(withRejection(x),false,'native '+i);
 }
 const x=rejectedAsset();for(const native of [[],[x.native,{...x.native,requestId:20}],[x.native,{...x.native,frameId:2,url:origin+'/api/v1/queue'}]])assert.equal(withRejection(x,displayReadProofs(x.rows,native)),false);
 const other=x.rows.map(row=>({...row,operation:2}));assert.equal(withRejection(x,displayReadProofs([...x.rows,...other],[x.native,{...x.native,requestId:20}])),false);
});
test('rejected asset disposition refuses altered, duplicated, historical and inferred proof envelopes',()=>{
 const x=rejectedAsset(),[proof]=displayReadProofs(x.rows,[x.native]);
 const edits=[p=>delete p.assetRejectionCancellation,p=>p.requestId++,p=>p.frameId++,p=>p.requestFrame++,p=>p.document='other',p=>p.operation++,p=>p.url+='?other',p=>p.method='POST',p=>p.status=200,p=>p.bodyComplete=true,p=>p.bodyCanceled=false,p=>p.signalAborted=false,p=>p.bytes=0,p=>p.assetBodyEOF={},p=>p.exactOccurrence=false,p=>p.eligibleRequests.push(20),p=>p.concurrentOperations.push(2),p=>p.association='unique-frame-time-bijection',p=>p.bijection={},p=>p.inferredAssociation=false,p=>p.requestTiming='observed',p=>p.requestStartRaw=101,p=>p.requestStart=0,p=>p.requestStart=113,p=>p.end++,p=>p.assetRejectionCancellation.kind='body-count',p=>p.assetRejectionCancellation.frameId++,p=>p.assetRejectionCancellation.document='other',p=>p.assetRejectionCancellation.operation++,p=>p.assetRejectionCancellation.url+='?other',p=>p.assetRejectionCancellation.method='POST',p=>p.assetRejectionCancellation.start++,p=>p.assetRejectionCancellation.reader=0,p=>p.assetRejectionCancellation.originalReader=false,p=>p.assetRejectionCancellation.readCalls=1,p=>p.assetRejectionCancellation.bytes=1,p=>p.assetRejectionCancellation.cancelFulfilledAt++,p=>p.assetRejectionCancellation.responseAt=99,p=>p.assetRejectionCancellation.readerAt=113,p=>p.assetRejectionCancellation.cancelCalledAt=121,p=>p.assetRejectionCancellation.signalAbortAt=119,p=>p.assetRejectionCancellation.signalAbortAt=null,p=>p.assetRejectionCancellation.observedRows=5];
 for(const [i,edit]of edits.entries()){const p=structuredClone(proof);edit(p);assert.equal(withRejection(x,[p]),false,'proof '+i);}
 assert.equal(withRejection(x,[proof,structuredClone(proof)]),false);
 for(const malformed of [null,undefined,{},[null],[proof,null]])assert.equal(originalRejectedAssetCancellation(x.event,origin,[missingFontFault],malformed),false);
});
async function rejectionObserverVM({cancel=()=>Promise.resolve(),read=()=>Promise.resolve({done:false,value:new Uint8Array(0)}),bodyCancel=()=>{throw Error('No observer body cancel');}}={}){
 const observed=[],calls=[];
 const reader={read:function(...args){calls.push({kind:'read',receiver:this,args});return Reflect.apply(read,this,args);},cancel:function(...args){calls.push({kind:'cancel',receiver:this,args});return Reflect.apply(cancel,this,args);}};
 const body={getReader:function(...args){calls.push({kind:'getReader',receiver:this,args});return reader;},cancel:function(...args){calls.push({kind:'body-cancel',receiver:this,args});return Reflect.apply(bodyCancel,this,args);},tee(){throw Error('No observer tee');}};
 const response={body,status:404,url,redirected:false,clone(){throw Error('No observer clone');}},fetchPromise=Promise.resolve(response);
 const realm=createContext({URL,Request,Promise,performance,crypto:webcrypto,location:{protocol:'http:',origin,href:origin+'/'}});realm.window=realm;realm.fetch=function(...args){calls.push({kind:'fetch',receiver:this,args});return fetchPromise;};realm.__validationDisplayAbort=event=>{observed.push(event);return Promise.resolve();};
 runInContext('('+installDisplayReadObserver.toString()+')()',realm);
 const fetchThis={},init={};assert.equal(realm.fetch.call(fetchThis,url,init),fetchPromise);assert.equal(await fetchPromise,response);
 const verdict=()=>{const rows=observed.map(e=>({...e,frameId:1})),native={requestId:19,frameId:1,url,method:'GET',resourceType:'fetch',startTime:rows[0].start,redirected:false,response:{url,status:404,fromServiceWorker:false}};return withRejection(rejectedAsset(),displayReadProofs(rows,[native]));};
 return {realm,reader,body,response,observed,calls,verdict,fetchThis,init};
}
test('actual observer preserves original cancel receiver arguments Promise and settlement before own404 disposition',async()=>{
 let resolveCancel;const result={cancelled:'opaque-native-result'},promise=new Promise(resolve=>{resolveCancel=resolve;});const f=await rejectionObserverVM({cancel:()=>promise});
 assert.equal(f.body.getReader('option'),f.reader);const argument={reason:'owned rejection'};assert.equal(f.reader.cancel(argument),promise);
 await f.realm.__validationDisplayObserver.flush();assert.equal(f.verdict(),false);assert.deepEqual(f.observed.map(e=>e.kind),['start','response','reader','asset-cancel-call']);
 resolveCancel(result);assert.equal(await promise,result);await f.realm.__validationDisplayObserver.flush();assert.equal(f.verdict(),rejectionReason);
 assert.deepEqual(f.observed.map(e=>e.kind),['start','response','reader','asset-cancel-call','cancel']);assert.equal(f.observed.at(-1).readCalls,0);assert.equal(f.observed.at(-1).bytes,0);assert.equal(f.observed.at(-1).originalReader,true);
 assert.deepEqual(f.calls.map(c=>c.kind),['fetch','getReader','cancel']);assert.equal(f.calls[0].receiver,f.fetchThis);assert.equal(f.calls[0].args[1],f.init);assert.equal(f.calls[1].receiver,f.body);assert.deepEqual(f.calls[1].args,['option']);assert.equal(f.calls[2].receiver,f.reader);assert.equal(f.calls[2].args[0],argument);
});
test('actual observer refuses borrowed receivers and all reads including zero-byte pending or post-cancel calls',async()=>{
 for(const mode of ['body','cancel','zero-read','pending-read','late-read']){
  const never=new Promise(()=>{}),f=await rejectionObserverVM(mode==='pending-read'?{read:()=>never}:{}),foreign={};
  assert.equal(f.body.getReader.call(mode==='body'?foreign:f.body),f.reader);
  if(mode==='zero-read')await f.reader.read();if(mode==='pending-read')assert.equal(f.reader.read(),never);
  await f.reader.cancel.call(mode==='cancel'?foreign:f.reader);
  if(mode==='late-read'){await f.realm.__validationDisplayObserver.flush();assert.equal(f.verdict(),rejectionReason);await f.reader.read();}
  await f.realm.__validationDisplayObserver.flush();assert.equal(f.verdict(),false,mode);
  assert.equal(f.calls.filter(c=>c.kind==='read').length,mode.includes('read')?1:0);
 }
});
test('actual observer keeps native cancel rejection or synchronous throw and cannot hide a second pending cancel',async()=>{
 for(const mode of ['reject','throw']){
  const reason=Error('original '+mode);let returned;
  const f=await rejectionObserverVM({cancel:()=>{if(mode==='throw')throw reason;return returned=Promise.reject(reason);}});f.body.getReader();
  if(mode==='throw')assert.throws(()=>f.reader.cancel(),e=>e===reason);else{const p=f.reader.cancel();assert.equal(p,returned);await assert.rejects(p,e=>e===reason);}
  await f.realm.__validationDisplayObserver.flush();assert.equal(f.verdict(),false);assert.equal(f.calls.filter(c=>c.kind==='cancel').length,1);assert.equal(f.observed.some(e=>e.kind==='asset-cancel-call'),true);assert.equal(f.observed.some(e=>e.kind==='cancel'),false);
 }
 let cancels=0;const never=new Promise(()=>{}),f=await rejectionObserverVM({cancel:()=>++cancels===1?Promise.resolve():never});f.body.getReader();await f.reader.cancel();await f.realm.__validationDisplayObserver.flush();assert.equal(f.verdict(),rejectionReason);assert.equal(f.reader.cancel(),never);await f.realm.__validationDisplayObserver.flush();assert.equal(f.verdict(),false);assert.equal(cancels,2);
});

test('actual observer retains direct-body cancel attempts even when pending or throwing around reader cancellation',async()=>{
 const never=new Promise(()=>{}),before=await rejectionObserverVM({bodyCancel:()=>never});
 const reason={owned:'body cancel'};assert.equal(before.body.cancel(reason),never);before.body.getReader();await before.reader.cancel();await before.realm.__validationDisplayObserver.flush();assert.equal(before.verdict(),false);
 assert.deepEqual(before.observed.map(e=>e.kind),['start','response','asset-cancel-call','reader','asset-cancel-call','cancel']);assert.equal(before.observed[2].reader,0);assert.equal(before.calls[1].receiver,before.body);assert.equal(before.calls[1].args[0],reason);
 for(const mode of ['pending','throw']){
  const failure=Error('original body failure'),after=await rejectionObserverVM({bodyCancel:()=>{if(mode==='throw')throw failure;return never;}}),foreign={};after.body.getReader();await after.reader.cancel();await after.realm.__validationDisplayObserver.flush();assert.equal(after.verdict(),rejectionReason);
  if(mode==='throw')assert.throws(()=>after.body.cancel.call(foreign,reason),e=>e===failure);else assert.equal(after.body.cancel.call(foreign,reason),never);
  await after.realm.__validationDisplayObserver.flush();assert.equal(after.verdict(),false);assert.equal(after.calls.at(-1).receiver,foreign);assert.equal(after.calls.at(-1).args[0],reason);assert.equal(after.observed.at(-1).kind,'asset-cancel-call');assert.equal(after.observed.at(-1).reader,0);
 }
});
