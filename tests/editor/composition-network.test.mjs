import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedDisplayBusy,expectedCompositionCancellation as classify,validOriginalReadBijection,validUntimedOriginalReadBijection,queueBodyObserverDisposition} from './composition-network.mjs';
const origin='http://127.0.0.1:54321',url=origin+'/api/v1/documents/doc/composition?revision=2&raw=0&download=1';
const event={channel:'requestfailed',requestId:9,url,method:'GET',resourceType:'fetch',failure:{errorText:'net::ERR_ABORTED'},response:{requestId:9,url,method:'GET',status:200,contentType:'application/octet-stream',contentLength:'64',etag:'"sha256:'+'a'.repeat(64)+'"'}};
const proof={requestId:9,url,oneOwnedRequestInExplicitExportWindow:true,destinationComplete:true,downloadName:'caption-original.bin',downloadURL:'blob:'+origin+'/actual',bytes:64,sha256:'a'.repeat(64)};
test('original export cancellation needs exact request identity and completed same-window destination',()=>{
 assert.equal(classify(event,origin,'chromium',[proof]),'exact-request-completed-download');assert.equal(classify(event,origin,'chromium'),false);
 for(const change of [p=>p.requestId++,p=>p.url+='&other=1',p=>p.oneOwnedRequestInExplicitExportWindow=false,p=>p.destinationComplete=false,p=>p.downloadName='other',p=>p.downloadURL='blob:http://other/a',p=>p.bytes--,p=>p.sha256='b'.repeat(64)]){const p=structuredClone(proof);change(p);assert.equal(classify(event,origin,'chromium',[p]),false);}
 for(const change of [e=>e.response.requestId++,e=>e.response.url+='x',e=>e.response.method='POST',e=>e.method='POST',e=>e.resourceType='image',e=>e.response.status=500,e=>e.response.contentType='text/plain',e=>e.failure.errorText='net::ERR_FAILED',e=>{e.url=origin+'/static/raw';e.response.url=e.url;}]){const e=structuredClone(event);change(e);assert.equal(classify(e,origin,'chromium',[proof]),false);}
 assert.equal(classify(event,origin+'0','chromium',[proof]),false);assert.equal(classify(event,origin,'firefox',[proof]),false);
});
test('each stock engine SSE literal is confined to its exact successful owned stream response',()=>{
 for(const [engine,errorText] of Object.entries({chromium:'net::ERR_ABORTED',firefox:'NS_BINDING_ABORTED',webkit:'cancelled'})){
  const e=structuredClone(event);e.url=origin+'/api/v1/events/stream';Object.assign(e.response,{url:e.url,contentType:'text/event-stream'});e.failure.errorText=errorText;assert(classify(e,origin,engine));
  for(const change of [x=>x.response.requestId++,x=>x.response.url+='?other',x=>x.response.status=503,x=>x.response.contentType='application/octet-stream',x=>x.method='POST',x=>x.url=origin+'/api/v1/events']){const bad=structuredClone(e);change(bad);assert.equal(classify(bad,origin,engine),false);}
 }
});

test('display cancellation requires the exact observed fetch signal, never URL alone',()=>{
 const e=structuredClone(event);e.url=origin+'/api/v1/assets/asset/display-tile?basis=pixels&lod=0&x=0&y=0';Object.assign(e.response,{url:e.url,contentType:'application/x-ideogram-rgba8'});
 const p={requestId:e.requestId,url:e.url,signalAborted:true,exactOccurrence:true};
 assert.equal(classify(e,origin,'chromium',[],[p]),'exact-request-observed-display-terminal');assert.equal(classify(e,origin,'chromium'),false);
 for(const change of [p=>p.requestId++,p=>p.url+='&other=1',p=>p.signalAborted=false,p=>p.exactOccurrence=false]){const bad=structuredClone(p);change(bad);assert.equal(classify(e,origin,'chromium',[],[bad]),false);}
 for(const change of [e=>e.response.status=500,e=>e.response.contentType='text/plain',e=>e.failure.errorText='net::ERR_FAILED',e=>e.response.contentLength='-1',e=>e.response.etag='unverified']){const bad=structuredClone(e);change(bad);assert.equal(classify(bad,origin,'chromium',[],[p]),false);}
});

test('completed display response needs exact observed EOF byte count',()=>{
 const e=structuredClone(event);e.url=origin+'/api/v1/assets/asset/display-tile';Object.assign(e.response,{url:e.url,contentType:'application/x-ideogram-rgba8'});
 const p={requestId:e.requestId,url:e.url,bodyComplete:true,bytes:64,exactOccurrence:true};
 assert.equal(classify(e,origin,'chromium',[],[p]),'exact-request-observed-display-terminal');
 for(const change of [p=>p.bytes--,p=>p.bodyComplete=false,p=>p.requestId++,p=>p.exactOccurrence=false]){const bad=structuredClone(p);change(bad);assert.equal(classify(e,origin,'chromium',[],[bad]),false);}
});

test('pre-header abort needs an observed signal for that exact tile request',()=>{
 const e={...event,url:origin+'/api/v1/assets/asset/display-tile',response:null};const p={requestId:e.requestId,url:e.url,signalAborted:true,exactOccurrence:true};
 assert.equal(classify(e,origin,'chromium',[],[p]),'exact-request-observed-display-abort-before-headers');assert.equal(classify(e,origin,'chromium'),false);
 assert.equal(classify({...e,failure:{errorText:'net::ERR_FAILED'}},origin,'chromium',[],[p]),false);
});
test('busy display replies need exact drained control bytes and a completed retry or canceled owner',()=>{
 const e={status:429,url:origin+'/api/v1/assets/asset/display-tile',requestId:7,body:JSON.stringify({protocolVersion:1,error:{code:'LOCAL_BUSY',retry:'read-or-transfer'}})};
 const p={url:e.url,requestId:7,exactOccurrence:true,bodyComplete:true,bytes:new TextEncoder().encode(e.body).length,status:429};const retry={url:e.url,requestId:8,exactOccurrence:true,bodyComplete:true,status:200};
 assert(expectedDisplayBusy(e,origin,[p,retry]));assert(expectedDisplayBusy(e,origin,[{...p,signalAborted:true}]));assert(!expectedDisplayBusy(e,origin,[p]));
 for(const bad of [{...p,bytes:0},{...p,requestId:8},{...p,bodyComplete:false},{...p,exactOccurrence:false}])assert(!expectedDisplayBusy(e,origin,[bad,retry]));
 assert(!expectedDisplayBusy({...e,body:e.body.replace('LOCAL_BUSY','AUTHORIZATION_REQUIRED')},origin,[p,retry]));
});

test('composition JSON terminal proof cannot come from another request or a partial body',()=>{
 const e=structuredClone(event);e.url=origin+'/api/v1/documents/doc/composition?revision=3';Object.assign(e.response,{url:e.url,contentType:'application/json; charset=utf-8'});
 const p={requestId:e.requestId,url:e.url,bodyComplete:true,bytes:64,exactOccurrence:true};
 assert.equal(classify(e,origin,'chromium',[],[p]),'exact-request-observed-composition-terminal');
 for(const change of [p=>p.bytes--,p=>p.requestId++,p=>p.bodyComplete=false]){const bad=structuredClone(p);change(bad);assert.equal(classify(e,origin,'chromium',[],[bad]),false);}
});

test('stale composition cancellation requires successful cancellation of the exact owned body',()=>{
 const e=structuredClone(event);e.url=origin+'/api/v1/documents/doc/composition?revision=3';Object.assign(e.response,{url:e.url,contentType:'application/json'});
 const p={requestId:e.requestId,url:e.url,bodyCanceled:true,exactOccurrence:true};
 assert(classify(e,origin,'chromium',[],[p]));
 for(const bad of [{...p,bodyCanceled:false},{...p,requestId:8},{...p,exactOccurrence:false}])assert.equal(classify(e,origin,'chromium',[],[bad]),false);
});
test('original inspection EOF requires exact response length and immutable identity',()=>{
 const p={requestId:event.requestId,url:event.url,bodyComplete:true,bytes:64,exactOccurrence:true};
 assert.equal(classify(event,origin,'chromium',[],[p]),'exact-request-observed-original-eof');
 for(const bad of [{...p,bytes:63},{...p,bodyComplete:false},{...p,requestId:8}])assert.equal(classify(event,origin,'chromium',[],[bad]),false);
 assert.equal(classify({...event,response:{...event.response,etag:undefined}},origin,'chromium',[],[p]),false);
});

test('pre-header SSE cancellation requires the exact observed owned abort in every engine',()=>{
 for(const [engine,errorText] of Object.entries({chromium:'net::ERR_ABORTED',firefox:'NS_BINDING_ABORTED',webkit:'cancelled'})){
  const e={...event,url:origin+'/api/v1/events/stream?after=3',response:null,failure:{errorText}},p={requestId:e.requestId,url:e.url,signalAborted:true,exactOccurrence:true};
  assert.equal(classify(e,origin,engine,[],[p]),'exact-request-observed-event-stream-abort-before-headers');
  for(const bad of [{...p,requestId:8},{...p,url:p.url+'0'},{...p,signalAborted:false},{...p,exactOccurrence:false}])assert.equal(classify(e,origin,engine,[],[bad]),false);
  for(const bad of [{...e,method:'POST'},{...e,resourceType:'image'},{...e,failure:{errorText:'unrelated failure'}}])assert.equal(classify(bad,origin,engine,[],[p]),false);
  assert.equal(classify(e,origin,engine),false);assert.equal(classify(e,origin+'0',engine,[],[p]),false);
 }
});

test('WebKit bodyless release cancellation needs the exact successful 204 response',()=>{
 const url=origin+'/api/v1/recovery/26cbeaab-17dd-4dca-a48a-99b544518a13/release';
 const e={channel:'requestfailed',requestId:25,url,method:'POST',resourceType:'fetch',failure:{errorText:'cancelled'},response:{requestId:25,url,method:'POST',status:204}};
 assert.equal(classify(e,origin,'webkit'),'exact-bodyless-recovery-release-response');
 for(const change of [x=>x.response.requestId++,x=>x.response.url+='?other',x=>x.response.method='GET',x=>x.response.status=200,x=>x.response.status=500,x=>x.response.contentLength='1',x=>x.response.contentType='text/plain',x=>x.response=null,x=>x.method='GET',x=>x.resourceType='document',x=>x.failure.errorText='failed',x=>{x.url=origin+'/api/v1/commands';x.response.url=x.url;}]){const bad=structuredClone(e);change(bad);assert.equal(classify(bad,origin,'webkit'),false);}
 assert.equal(classify(e,origin+'0','webkit'),false);assert.equal(classify(e,origin,'firefox'),false);assert.equal(classify(e,origin,'chromium'),false);
});

// These are original-observer proofs, not successful-header allowances.
test('superseded document refresh and UI checkpoint snapshots need the exact original cancellation or complete JSON body',()=>{
 const joined={association:'unique-frame-time-window',frameId:1,requestFrame:1,eligibleRequests:[event.requestId],concurrentOperations:[]};
 for(const path of ['/api/v1/documents/doc/image','/api/v1/documents/doc/history','/api/v1/documents/doc/checkpoints','/api/v1/documents/doc/save-status?sessionId=ui_10000000-0000-4000-8000-000000000001','/api/v1/ui/ui_10000000-0000-4000-8000-000000000001','/api/v1/queue']){
  for(const [engine,errorText] of Object.entries({chromium:'net::ERR_ABORTED',firefox:'NS_BINDING_ABORTED',webkit:'cancelled'})){
   const url=origin+path,e={...structuredClone(event),url,failure:{errorText},response:{...structuredClone(event.response),url,contentType:'application/json; charset=utf-8'}};
   const eof={...joined,requestId:e.requestId,url,exactOccurrence:true,bodyComplete:true,bytes:64,status:200};
   for(const proof of [eof,{...joined,requestId:e.requestId,url,exactOccurrence:true,signalAborted:true},{...joined,requestId:e.requestId,url,exactOccurrence:true,bodyCanceled:true}])assert.equal(classify(e,origin,engine,[],[proof]),'exact-request-observed-snapshot-terminal');
   assert.equal(classify(e,origin,engine),false);
   for(const mutate of [p=>p.requestId++,p=>p.url+='?other=1',p=>p.exactOccurrence=false,p=>p.bodyComplete=false,p=>p.bytes--,p=>p.status=500,p=>p.association='fifo',p=>p.frameId=0,p=>p.requestFrame=2,p=>p.eligibleRequests=[8],p=>p.eligibleRequests.push(10),p=>p.concurrentOperations.push(2)]){const bad=structuredClone(eof);mutate(bad);assert.equal(classify(e,origin,engine,[],[bad]),false);}
   for(const mutate of [x=>x.response.requestId++,x=>x.response.url+='x',x=>x.response.method='POST',x=>x.method='POST',x=>x.resourceType='image',x=>x.response.status=500,x=>x.response.contentType='application/json',x=>x.response.contentType='text/plain',x=>x.response.contentLength='0',x=>x.response.contentLength='064',x=>x.response.contentLength='-1',x=>x.response.contentLength=undefined,x=>x.failure.errorText='unrelated failure',x=>{x.url+='?unreviewed=1';x.response.url=x.url;}]){const bad=structuredClone(e);mutate(bad);assert.equal(classify(bad,origin,engine,[],[{...eof,url:bad.url}]),false);}
   assert.equal(classify(e,origin+'0',engine,[],[eof]),false);assert.equal(classify(e,origin,engine==='chromium'?'firefox':'chromium',[],[eof]),false);
  }
 }
 for(const path of ['/api/v1/documents/doc/closure','/api/v1/documents/doc/image/extra','/api/v1/ui/session/history','/api/v1/ui','/api/v1/queue/extra','/api/v1/provider','/api/v1/documents/doc/save-status','/api/v1/documents/doc/save-status?sessionId=','/api/v1/documents/doc/save-status?sessionId=ui_first&sessionId=ui_second','/api/v1/documents/doc/save-status?sessionId=ui_session&after=1','/api/v1/documents/doc/save-status?other=ui_session','/api/v1/documents/doc/save-status?sessionId='+ 'x'.repeat(129),'/api/v1/documents/doc/save-status?sessionId=ui%2Fother','/api/v1/documents/doc/checkpoints?cursor=next','/api/v1/ui/ui_session?draftId=other']){
  const url=origin+path,e={...structuredClone(event),url,response:{...structuredClone(event.response),url,contentType:'application/json; charset=utf-8'}},p={...joined,requestId:e.requestId,url,exactOccurrence:true,bodyComplete:true,bytes:64,status:200};
  assert.equal(classify(e,origin,'chromium',[],[p]),false);
 }
});

// Actual helper source is loaded without importing the application or a browser.
// The fake realm supplies original promises and request/frame observations;
// these are contract regressions, never browser completion evidence.
import {readFileSync as readDisplaySource} from 'node:fs';
import {stripTypeScriptTypes as stripDisplayTypes} from 'node:module';
import {createContext as displayRealm,runInContext as runDisplayRealm} from 'node:vm';
import {webcrypto as displayCrypto} from 'node:crypto';
const displayModule=await import('data:text/javascript;base64,'+Buffer.from(stripDisplayTypes(readDisplaySource(new URL('./display-aborts.ts',import.meta.url),'utf8'),{mode:'strip'})).toString('base64'));
const {displayReadProofs,displayReadPath,displayObservationPath,installDisplayReadObserver,observeDisplayAborts,DISPLAY_OBSERVATION_LIMIT,DISPLAY_REQUEST_LIMIT}=displayModule;
function displaySample(path='/api/v1/documents/doc/image',options={}){
 const url=origin+path,base={frameId:1,document:'10000000-0000-4000-8000-000000000001',operation:1,url,method:'GET',start:100, ...options};
 const rows=[{...base,kind:'start',at:base.start,hasSignal:false},{...base,kind:'response',at:base.start+10,status:200,responseURL:url,redirected:false},{...base,kind:'reader',at:base.start+11,reader:1},{...base,kind:'complete',at:base.start+20,reader:1,bytes:64}];
 const q={requestId:9,frameId:base.frameId,url,method:base.method,resourceType:'fetch',startTime:base.start+1,redirected:false,response:{url,status:200,fromServiceWorker:false}};
 return {rows,q};
}
test('original read catalog stays finite while API observations retain exact native response identity',()=>{
 for(const path of ['/api/v1/documents/doc/image','/api/v1/documents/doc/history','/api/v1/documents/doc/checkpoints','/api/v1/documents/doc/save-status?sessionId=ui_session','/api/v1/ui/ui_session','/api/v1/queue','/api/v1/assets/asset/display-tile','/api/v1/documents/doc/composition','/api/v1/ui/session/composition','/api/v1/assets/asset','/api/v1/events/stream']){
  const {rows,q}=displaySample(path),proofs=displayReadProofs(rows,[q]);assert.equal(proofs.length,1,path);assert.equal(proofs[0].association,'unique-frame-time-window');assert.equal(proofs[0].frameId,proofs[0].requestFrame);assert.deepEqual(proofs[0].eligibleRequests,[q.requestId]);assert.equal(proofs[0].bodyComplete,true);assert.equal(proofs[0].bytes,64);
 }
 for(const path of ['/api/v1/documents/doc/queue','/api/v1/provider','/api/v1/queue/other','/api/v1/documents/doc/checkpoints/extra','/api/v1/documents/doc/save-status/extra','/api/v1/ui','/api/v1/ui/session/extra','/static/image']){const {rows,q}=displaySample(path);assert.equal(displayReadPath(q.url),false);const observed=path.startsWith('/api/v1/');assert.equal(displayObservationPath(q.url),observed);assert.equal(displayReadProofs(rows,[q]).length,observed?1:0);}
});
test('original read association refuses wrong frame, unavailable timing, duplicate candidates and ambiguous overlapping same-URL operations',()=>{
 for(const mutate of [x=>x.q.frameId=2,x=>x.q.startTime=-1,x=>x.q.startTime=97,x=>x.q.startTime=113,x=>x.q.redirected=true,x=>x.q.response.fromServiceWorker=true,x=>x.q.response.url+='?other',x=>x.q.response.status=500,x=>x.rows[1].responseURL+='?other',x=>x.rows[1].redirected=true]){const x=displaySample();mutate(x);assert.deepEqual(displayReadProofs(x.rows,[x.q]),[]);}
 const x=displaySample();assert.deepEqual(displayReadProofs(x.rows,[]),[]);assert.deepEqual(displayReadProofs(x.rows.slice(1),[x.q]),[]);assert.deepEqual(displayReadProofs(x.rows,[x.q,{...x.q,requestId:10}]),[]);
 const overlap=displaySample(undefined,{operation:2,start:100});assert.deepEqual(displayReadProofs([...x.rows,...overlap.rows],[x.q,{...overlap.q,requestId:10}]),[]);
 const duplicateStart=structuredClone(x.rows);duplicateStart.push({...x.rows[0]});assert.deepEqual(displayReadProofs(duplicateStart,[x.q]),[]);
});
test('same-URL sequential reads and separate frames keep their own original Request; no request can be borrowed twice',()=>{
 const a=displaySample(),b=displaySample(undefined,{operation:2,start:140});b.q.requestId=10;const p=displayReadProofs([...a.rows,...b.rows],[a.q,b.q]);assert.deepEqual(p.map(x=>x.requestId),[9,10]);
 const other=displaySample(undefined,{frameId:2});other.q.requestId=11;assert.equal(displayReadProofs([...a.rows,...other.rows],[a.q,other.q]).length,2);
 const near=displaySample(undefined,{operation:2,start:101,document:'20000000-0000-4000-8000-000000000002'});assert.deepEqual(displayReadProofs([...a.rows,...near.rows],[a.q]),[]);
});
test('terminal proof requires actual EOF, fulfilled body cancellation or the original supplied abort signal',()=>{
 const x=displaySample(),partial=x.rows.slice(0,-1);assert.deepEqual(displayReadProofs(partial,[x.q]),[]);
 const cancel={...x.rows.at(-1),kind:'cancel',bytes:undefined};assert.equal(displayReadProofs([...partial,cancel],[x.q])[0].bodyCanceled,true);
 assert.deepEqual(displayReadProofs([...partial,{...cancel,kind:'cancel-rejected'}],[x.q]),[]);
 const abort={...x.rows.at(-1),kind:'abort',aborted:true};assert.deepEqual(displayReadProofs([...partial,abort],[x.q]),[]);
 partial[0]={...partial[0],hasSignal:true};const proof=displayReadProofs([...partial,abort],[x.q])[0];assert.equal(proof.signalAborted,true);assert.equal(proof.bodyComplete,false);assert.equal(proof.bodyCanceled,false);
 for(const kind of ['clone','tee','observer-error','cancel-rejected'])assert.deepEqual(displayReadProofs([...x.rows,{...x.rows.at(-1),kind}],[x.q]),[]);
 assert.deepEqual(displayReadProofs([...x.rows,{...x.rows[2],reader:2}],[x.q]),[]);
 assert.deepEqual(displayReadProofs([...x.rows,{...x.rows.at(-1),kind:'read-rejected',errorName:'NetworkError'}],[x.q]),[]);
 assert.deepEqual(displayReadProofs(x.rows,[x.q],['lost binding write']),[]);
 const paddedRows=[...x.rows,...Array.from({length:DISPLAY_OBSERVATION_LIMIT-x.rows.length-1},(_,i)=>({...x.rows[0],operation:i+2,url:origin+'/api/v1/documents/orphan'+i+'/image'}))];
 assert.equal(displayReadProofs(paddedRows,[x.q]).length,1);paddedRows.push({...x.rows[0],operation:DISPLAY_OBSERVATION_LIMIT,url:origin+'/api/v1/queue'});assert.deepEqual(displayReadProofs(paddedRows,[x.q]),[]);
 const paddedRequests=[x.q,...Array.from({length:DISPLAY_REQUEST_LIMIT-2},(_,i)=>({...x.q,requestId:i+10,frameId:2,url:origin+'/api/v1/documents/orphan'+i+'/image'}))];
 assert.equal(displayReadProofs(x.rows,paddedRequests).length,1);paddedRequests.push({...x.q,requestId:DISPLAY_REQUEST_LIMIT+10,frameId:2});assert.deepEqual(displayReadProofs(x.rows,paddedRequests),[]);
});
function displayInstall(nativeFetch){
 const observations=[],realm=displayRealm({URL,Request,Promise,performance,crypto:displayCrypto,location:{protocol:'http:',origin,href:origin+'/'}});realm.window=realm;realm.fetch=nativeFetch;realm.__validationDisplayAbort=event=>{observations.push(event);return Promise.resolve();};
 runDisplayRealm('('+installDisplayReadObserver.toString()+')()',realm);return {realm,observations};
}
test('actual observer preserves original fetch/read/cancel promises, arguments, receivers and reader values',async()=>{
 const calls=[],fetchThis={},readThis={},cancelThis={},chunk={done:false,value:new Uint8Array(64)},chunkPromise=Promise.resolve(chunk),eofPromise=Promise.resolve({done:true,value:undefined}),cancelPromise=Promise.resolve('cancelled');let reads=0;
 const reader={read:function(...args){calls.push(['read',this,args]);return ++reads===1?chunkPromise:eofPromise;},cancel:function(...args){calls.push(['cancel',this,args]);return cancelPromise;}};
 const body={getReader:function(...args){calls.push(['getReader',this,args]);return reader;},cancel:()=>Promise.resolve(),tee(){throw Error('No extra tee');}};
 const response={body,status:200,url:origin+'/api/v1/documents/doc/image',redirected:false,clone(){throw Error('No extra clone');}},fetchPromise=Promise.resolve(response),h=displayInstall(function(...args){calls.push(['fetch',this,args]);return fetchPromise;});
 const init={headers:{original:'unchanged'}},p=h.realm.fetch.call(fetchThis,response.url,init);assert.equal(p,fetchPromise);assert.equal(await p,response);
 assert.equal(body.getReader('original-option'),reader);assert.equal(reader.read.call(readThis,'first'),chunkPromise);assert.equal(await chunkPromise,chunk);assert.equal(reader.read.call(readThis,'last'),eofPromise);await eofPromise;
 assert.equal(reader.cancel.call(cancelThis,'original-reason'),cancelPromise);await h.realm.__validationDisplayObserver.flush();
 assert.equal(calls.length,5);assert.equal(calls[0][1],fetchThis);assert.equal(calls[0][2][1],init);assert.equal(calls[1][1],body);assert.deepEqual(calls[1][2],['original-option']);assert.equal(calls[2][1],readThis);assert.deepEqual(calls[2][2],['first']);assert.equal(calls[4][1],cancelThis);assert.deepEqual(calls[4][2],['original-reason']);
 assert.equal(h.observations.filter(e=>e.kind==='complete').length,1);assert.equal(h.observations.find(e=>e.kind==='complete').bytes,64);assert.equal(h.observations.filter(e=>e.kind==='cancel').length,1);assert(!h.observations.some(e=>['clone','tee'].includes(e.kind)));
});
test('actual observer never labels a pending/rejected cancel fulfilled and propagates original fetch rejection',async()=>{
 let rejectCancel;const cancellation=new Promise((_,reject)=>rejectCancel=reject),body={getReader(){throw Error('No extra reader');},cancel(){return cancellation;},tee(){throw Error('No extra tee');}},response={body,status:200,url:origin+'/api/v1/queue',redirected:false,clone(){throw Error('No extra clone');}},h=displayInstall(()=>Promise.resolve(response));
 await h.realm.fetch(response.url);assert.equal(body.cancel('original-reason'),cancellation);assert(!h.observations.some(e=>e.kind==='cancel'));const error=Error('native cancellation failed');rejectCancel(error);await assert.rejects(cancellation,e=>e===error);await h.realm.__validationDisplayObserver.flush();assert(!h.observations.some(e=>e.kind==='cancel'));assert(h.observations.some(e=>e.kind==='cancel-rejected'));
 const rejected=Promise.reject(new DOMException('Original rejection','AbortError')),f=displayInstall(()=>rejected);const p=f.realm.fetch(origin+'/api/v1/documents/doc/history');assert.equal(p,rejected);await assert.rejects(p,/Original rejection/);await f.realm.__validationDisplayObserver.flush();assert(f.observations.some(e=>e.kind==='rejected'));
});
test('context observer binds exposed events to their actual source Frame rather than caller fields or URL order',async()=>{
 const handlers={},scripts=[];let binding;const frame={},otherFrame={},context={on:(event,fn)=>handlers[event]=fn,exposeBinding:async(name,fn)=>binding=fn,addInitScript:async fn=>scripts.push(fn)};
 const observe=await observeDisplayAborts(context,request=>request.id),x=displaySample(),request={id:9,method:()=>x.q.method,resourceType:()=>x.q.resourceType,url:()=>x.q.url,frame:()=>frame,timing:()=>({startTime:x.q.startTime}),redirectedFrom:()=>null,redirectedTo:()=>null};
 handlers.request(request);handlers.response({request:()=>request,url:()=>x.q.url,status:()=>200,fromServiceWorker:()=>false});
 for(const e of x.rows)await binding({frame:otherFrame},{...e,frameId:1});assert.deepEqual(observe(),[]);assert.equal(observe.observations().events[0].frameId,2);
 assert.equal(scripts.length,1);assert.equal(scripts[0],installDisplayReadObserver);
});

test('observer installation errors are reported to the controller before a live-page flush',async()=>{
 const response=Object.freeze({body:null,status:200,url:origin+'/api/v1/queue',redirected:false,clone(){throw Error('No clone');}}),h=displayInstall(()=>Promise.resolve(response));
 await h.realm.fetch(response.url);assert.equal(h.observations.filter(e=>e.kind==='collector-error').length,1);await assert.rejects(h.realm.__validationDisplayObserver.flush());
 const handlers={};let binding;const frame={},context={on:(event,fn)=>handlers[event]=fn,exposeBinding:async(name,fn)=>binding=fn,addInitScript:async()=>{}},observe=await observeDisplayAborts(context,q=>q.id),x=displaySample(),q={id:9,method:()=>x.q.method,resourceType:()=>x.q.resourceType,url:()=>x.q.url,frame:()=>frame,timing:()=>({startTime:x.q.startTime}),redirectedFrom:()=>null,redirectedTo:()=>null};
 handlers.request(q);handlers.response({request:()=>q,url:()=>x.q.url,status:()=>200,fromServiceWorker:()=>false});for(const row of x.rows)await binding({frame},row);assert.equal(observe().length,1);
 await binding({frame},{kind:'collector-error'});assert.deepEqual(observe(),[]);assert.equal(observe.observations().errors.length,1);
});

test('observer wrapper refusal preserves the native reader result instead of throwing into the application',async()=>{
 const reader=Object.freeze({read:()=>Promise.resolve({done:true,value:undefined}),cancel:()=>Promise.resolve()}),body={getReader:()=>reader,cancel:()=>Promise.resolve(),tee(){throw Error('No tee');}},response={body,status:200,url:origin+'/api/v1/queue',redirected:false,clone(){throw Error('No clone');}},h=displayInstall(()=>Promise.resolve(response));
 await h.realm.fetch(response.url);assert.equal(body.getReader(),reader);assert.equal(h.observations.filter(e=>e.kind==='collector-error').length,1);await assert.rejects(h.realm.__validationDisplayObserver.flush());
});

// Completed transport is separate from accepted command or pending-job outcome.
test('original JSON EOF classifies complete workflow responses without granting mutation success',()=>{
 const routes=[['GET','/api/v1/commands/command'],['GET','/api/v1/provider'],['POST','/api/v1/commands'],['POST','/api/v1/ui/ui_session'],['POST','/api/v1/assets/staging'],['PUT','/api/v1/assets/staging/stage']];
 for(const [engine,errorText] of Object.entries({chromium:'net::ERR_ABORTED',firefox:'NS_BINDING_ABORTED',webkit:'cancelled'}))for(const status of [200,201,202])for(const [method,path]of routes){
  const url=origin+path,e={channel:'requestfailed',requestId:9,url,method,resourceType:'fetch',failure:{errorText},response:{requestId:9,url,method,status,contentType:'application/json; charset=utf-8',contentLength:'64'}},proof={requestId:9,url,method,status,exactOccurrence:true,association:'unique-frame-time-window',frameId:1,requestFrame:1,eligibleRequests:[9],concurrentOperations:[],bodyComplete:true,bytes:64};
  assert.equal(classify(e,origin,engine,[],[proof]),'exact-original-json-response-eof');assert.equal(classify(e,origin,engine),false);
  // Neither a canceled owner nor fulfilled body cancellation completes a write
  // or a pending response; both still lack the observed original final byte.
  for(const flags of [{signalAborted:true},{bodyCanceled:true},{signalAborted:true,bodyCanceled:true}])assert.equal(classify(e,origin,engine,[],[{...proof,bodyComplete:false,...flags}]),false);
  for(const change of [p=>delete p.method,p=>p.method=method==='GET'?'POST':'GET',p=>p.status=status===200?202:200,p=>p.requestId++,p=>p.url+='&other=1',p=>p.bodyComplete=false,p=>p.bytes--,p=>p.bytes=0,p=>p.bytes='64',p=>p.exactOccurrence=false,p=>p.association='fifo',p=>p.frameId=0,p=>p.requestFrame=2,p=>p.eligibleRequests=[10],p=>p.eligibleRequests.push(10),p=>p.concurrentOperations.push(2)]){const bad=structuredClone(proof);change(bad);assert.equal(classify(e,origin,engine,[],[bad]),false);}
  for(const change of [x=>x.response.requestId++,x=>x.response.url+='?other',x=>x.response.method=method==='GET'?'PUT':'GET',x=>x.method='DELETE',x=>x.resourceType='xhr',x=>x.response.status=204,x=>x.response.status=206,x=>x.response.status=400,x=>x.response.status=500,x=>x.response.contentType='application/json',x=>x.response.contentType='text/plain',x=>x.response.contentLength='0',x=>x.response.contentLength='064',x=>x.response.contentLength='-1',x=>x.response.contentLength=undefined,x=>x.failure.errorText='unrelated failure',x=>x.channel='response']){const bad=structuredClone(e);change(bad);assert.equal(classify(bad,origin,engine,[],[proof]),false);}
  for(const path of ['/api/v10/commands','/api/v1','/assets/result.json']){const bad=structuredClone(e);bad.url=origin+path;bad.response.url=bad.url;assert.equal(classify(bad,origin,engine,[],[{...proof,url:bad.url}]),false);}
  assert.equal(classify(e,origin+'0',engine,[],[proof]),false);assert.equal(classify(e,origin,engine==='chromium'?'firefox':'chromium',[],[proof]),false);
 }
});

test('workflow response observations bind GET POST and PUT to the original method and status without widening the cancellation catalog',()=>{
 for(const [method,path,status] of [['GET','/api/v1/commands/command',202],['POST','/api/v1/documents/doc/commands',201],['PUT','/api/v1/staging/stage',200]]){
  const x=displaySample(path,{method});x.rows[1].status=status;x.q.response.status=status;
  assert.equal(displayReadPath(x.q.url),false);assert.equal(displayObservationPath(x.q.url),true);
  const [proof]=displayReadProofs(x.rows,[x.q]);assert(proof);assert.equal(proof.method,method);assert.equal(proof.status,status);assert.equal(proof.bodyComplete,true);assert.equal(proof.bytes,64);assert.equal(proof.bodyCanceled,false);assert.equal(proof.signalAborted,false);
 }
 for(const path of ['/api/v1','/api/v10/staging/stage','/api/v1x/staging/stage','/static/api/v1/staging/stage']){const x=displaySample(path,{method:'PUT'});assert.equal(displayObservationPath(x.q.url),false);assert.deepEqual(displayReadProofs(x.rows,[x.q]),[]);}
});
test('workflow proof refuses missing or conflicting methods and ambiguous same-method overlaps',()=>{
 for(const mutate of [x=>{delete x.rows[0].method;},x=>{for(const row of x.rows)delete row.method;},x=>{delete x.q.method;},x=>{x.q.method='GET';},x=>{x.rows[1].method='POST';},x=>{x.rows[2].method='GET';},x=>{x.rows[3].method='GET';},x=>{for(const row of x.rows)row.method='put';},x=>{for(const row of x.rows)row.method='PATCH';x.q.method='PATCH';}]){
  const x=displaySample('/api/v1/staging/stage',{method:'PUT'});mutate(x);assert.deepEqual(displayReadProofs(x.rows,[x.q]),[]);
 }
 const a=displaySample('/api/v1/workflow/item',{method:'GET'}),b=displaySample('/api/v1/workflow/item',{method:'POST',operation:2,start:105});b.q.requestId=10;
 const distinct=displayReadProofs([...a.rows,...b.rows],[a.q,b.q]);assert.deepEqual(distinct.map(p=>[p.requestId,p.method]),[[9,'GET'],[10,'POST']]);
 const same=displaySample('/api/v1/workflow/item',{method:'GET',operation:2,start:100});same.q.requestId=10;assert.deepEqual(displayReadProofs([...a.rows,...same.rows],[a.q,same.q]),[]);
 assert.deepEqual(displayReadProofs(a.rows,[{...a.q,method:'POST'}]),[]);assert.deepEqual(displayReadProofs(b.rows,[{...b.q,method:'GET'}]),[]);
});
test('actual workflow observer normalizes known methods while preserving Request and RequestInit identities and original reader promises',async()=>{
 for(const variant of ['string-put','request-post','override-get']){
  const url=origin+'/api/v1/workflow/item',input=variant==='string-put'?url:new Request(url,{method:'post'}),init=variant==='string-put'?{method:'pUt',headers:{original:'unchanged'}}:variant==='override-get'?{method:'get'}:undefined;
  const expected=variant==='string-put'?'PUT':variant==='request-post'?'POST':'GET',calls=[],part={done:false,value:new Uint8Array(7)},eof={done:true,value:undefined},partPromise=Promise.resolve(part),eofPromise=Promise.resolve(eof);let reads=0;
  const reader={read:function(...args){calls.push(['read',this,args]);return ++reads===1?partPromise:eofPromise;},cancel:()=>Promise.resolve()},body={getReader:function(...args){calls.push(['getReader',this,args]);return reader;},cancel:()=>Promise.resolve(),tee(){throw Error('No tee');}},response={body,status:201,url,redirected:false,clone(){throw Error('No clone');}},fetchPromise=Promise.resolve(response),fetchThis={},readThis={},h=displayInstall(function(...args){calls.push(['fetch',this,args]);return fetchPromise;});
  const args=init?[input,init]:[input],p=Reflect.apply(h.realm.fetch,fetchThis,args);assert.equal(p,fetchPromise);assert.equal(await p,response);assert.equal(body.getReader(),reader);assert.equal(reader.read.call(readThis,'part'),partPromise);assert.equal(await partPromise,part);assert.equal(reader.read.call(readThis,'eof'),eofPromise);assert.equal(await eofPromise,eof);await h.realm.__validationDisplayObserver.flush();
  assert.equal(calls.length,4);assert.equal(calls[0][1],fetchThis);assert.equal(calls[0][2].length,args.length);assert.equal(calls[0][2][0],input);if(init)assert.equal(calls[0][2][1],init);assert.equal(calls[1][1],body);assert.equal(calls[2][1],readThis);assert.deepEqual(calls[2][2],['part']);assert.deepEqual(calls[3][2],['eof']);
  assert.deepEqual(h.observations.map(row=>row.kind),['start','response','reader','complete']);assert(h.observations.every(row=>row.method===expected));assert.equal(h.observations.at(-1).bytes,7);
 }
});
test('actual workflow observer leaves foreign origins non-API routes and unsupported methods untouched',async()=>{
 for(const [url,method] of [['http://127.0.0.1:8124/api/v1/staging/stage','PUT'],[origin+'/api/v10/staging/stage','PUT'],[origin+'/api/v1','GET'],[origin+'/static/image','GET'],[origin+'/api/v1/staging/stage','PATCH'],[origin+'/api/v1/staging/stage','DELETE'],[origin+'/api/v1/staging/stage','HEAD'],[origin+'/api/v1/staging/stage','OPTIONS']]){
  assert(url!==origin+'/api/v1/staging/stage'||!['GET','POST','PUT'].includes(method));
  const response={body:null,status:200,url,redirected:false,clone(){throw Error('No clone');}},clone=response.clone,p=Promise.resolve(response),calls=[],h=displayInstall(function(...args){calls.push([this,args]);return p;}),receiver={},init={method};
  assert.equal(h.realm.fetch.call(receiver,url,init),p);assert.equal(await p,response);await h.realm.__validationDisplayObserver.flush();assert.deepEqual(h.observations,[]);assert.equal(response.clone,clone);assert.equal(calls.length,1);assert.equal(calls[0][0],receiver);assert.equal(calls[0][1][0],url);assert.equal(calls[0][1][1],init);
 }
});
test('context workflow observer records native supported methods and requires exact method-bound EOF association',async()=>{
 for(const method of ['GET','POST','PUT','PATCH']){
  const handlers={};let binding;const frame={},context={on:(event,fn)=>handlers[event]=fn,exposeBinding:async(name,fn)=>binding=fn,addInitScript:async()=>{}},observe=await observeDisplayAborts(context,q=>q.id),x=displaySample('/api/v1/workflow/item',{method}),q={id:9,method:()=>method,resourceType:()=>x.q.resourceType,url:()=>x.q.url,frame:()=>frame,timing:()=>({startTime:x.q.startTime}),redirectedFrom:()=>null,redirectedTo:()=>null};
  handlers.request(q);handlers.response({request:()=>q,url:()=>x.q.url,status:()=>200,fromServiceWorker:()=>false});for(const row of x.rows)await binding({frame},row);
  if(method==='PATCH'){assert.equal(observe.observations().requests.length,0);assert.deepEqual(observe(),[]);}else{assert.equal(observe.observations().requests[0].method,method);const [proof]=observe();assert.equal(proof.method,method);assert.equal(proof.bodyComplete,true);assert.equal(proof.bytes,64);}
 }
});

function abortedDisplayReader(){
 const x=displaySample('/api/v1/assets/tile/display-tile');x.rows=x.rows.slice(0,-1);x.rows[0].hasSignal=true;
 const base={...x.rows[0],reader:1};x.rows.push({...base,kind:'abort',at:115,aborted:true},{...base,kind:'read-rejected',at:116,errorName:'AbortError'},{...base,kind:'cancel-rejected',at:117,errorName:'AbortError'});return x;
}
test('an original readonly signal abort remains evidence when its reader then rejects read and cancel with AbortError',()=>{
 const x=abortedDisplayReader(),[proof]=displayReadProofs(x.rows,[x.q]);assert(proof);assert.equal(proof.signalAborted,true);assert.equal(proof.bodyComplete,false);assert.equal(proof.bodyCanceled,false);assert.equal(Object.hasOwn(proof,'bytes'),false);
 const e={...structuredClone(event),url:x.q.url,response:{...structuredClone(event.response),url:x.q.url,contentType:'application/x-ideogram-rgba8'}};
 assert.equal(classify(e,origin,'chromium',[],[proof]),'exact-request-observed-display-terminal');
});
test('signal-only aborted-reader evidence refuses missing or mismatched original signals, rejection facts and write outcomes',()=>{
 for(const change of [x=>x.rows[0].hasSignal=false,x=>x.rows.push({...x.rows[0],kind:'rejected',at:118,errorName:'NetworkError'}),x=>x.rows.splice(3,1),x=>x.rows.push({...x.rows[3]}),x=>x.rows[4].at=114,x=>x.rows[5].at=114,x=>{x.rows[4].at=115;[x.rows[3],x.rows[4]]=[x.rows[4],x.rows[3]];},x=>x.rows[4].errorName='NetworkError',x=>x.rows[5].errorName='TypeError',x=>x.rows[4].reader=2,x=>x.rows[5].reader=2,x=>x.rows.push({...x.rows[2],reader:2}),x=>x.rows.push({...x.rows[2],kind:'complete',at:118,bytes:64}),x=>x.rows.push({...x.rows[2],kind:'cancel',at:118}),x=>x.rows.push({...x.rows[5]}),x=>x.rows.splice(4,1),x=>{x.rows[1].status=202;x.q.response.status=202;},x=>{x.q.method='POST';for(const row of x.rows)row.method='POST';},x=>{x.q.url=origin+'/api/v1/commands/id';x.q.response.url=x.q.url;for(const row of x.rows){row.url=x.q.url;if(row.responseURL)row.responseURL=x.q.url;}}]){const x=abortedDisplayReader();change(x);assert.deepEqual(displayReadProofs(x.rows,[x.q]),[]);}
 for(const kind of ['clone','tee','observer-error']){const x=abortedDisplayReader();x.rows.push({...x.rows[0],kind,at:118});assert.deepEqual(displayReadProofs(x.rows,[x.q]),[]);}
 const x=abortedDisplayReader();assert.deepEqual(displayReadProofs(x.rows,[x.q],['collector failure']),[]);assert.deepEqual(displayReadProofs(x.rows,[{...x.q,frameId:2}]),[]);
 const other=abortedDisplayReader();for(const row of other.rows)row.operation=2;other.q.requestId=10;assert.deepEqual(displayReadProofs([...x.rows,...other.rows],[x.q,other.q]),[]);
 // The observed abort is not completed JSON transport for a mutation or202.
 const [proof]=displayReadProofs(x.rows,[x.q]);for(const [method,status]of [['PUT',200],['POST',200],['GET',202]]){const url=origin+'/api/v1/commands/id',e={...structuredClone(event),url,method,response:{...structuredClone(event.response),url,method,status,contentType:'application/json; charset=utf-8'}},p={...proof,url,method,status};assert.equal(classify(e,origin,'chromium',[],[p]),false);}
});
test('actual original signal and rejected reader promises produce only signal evidence without changing native failures',async()=>{
 const controller=new AbortController(),error=new DOMException('Native stored abort','AbortError');let rejectRead;const readPromise=new Promise((_,reject)=>rejectRead=reject),reader={read:()=>readPromise,cancel:()=>Promise.reject(error)},body={getReader:()=>reader,cancel:()=>Promise.reject(error),tee(){throw Error('No tee');}},response={body,status:200,url:origin+'/api/v1/assets/tile/display-tile',redirected:false,clone(){throw Error('No clone');}},fetchPromise=Promise.resolve(response),h=displayInstall(()=>fetchPromise);
 assert.equal(h.realm.fetch(response.url,{signal:controller.signal}),fetchPromise);await fetchPromise;assert.equal(body.getReader(),reader);assert.equal(reader.read(),readPromise);controller.abort();rejectRead(error);await assert.rejects(readPromise,e=>e===error);const canceled=reader.cancel();await assert.rejects(canceled,e=>e===error);await h.realm.__validationDisplayObserver.flush();
 const rows=h.observations.map(row=>({...row,frameId:1})),start=rows.find(row=>row.kind==='start'),q={requestId:9,frameId:1,url:response.url,method:'GET',resourceType:'fetch',startTime:start.start,redirected:false,response:{url:response.url,status:200,fromServiceWorker:false}},[proof]=displayReadProofs(rows,[q]);
 assert.deepEqual(rows.map(row=>row.kind),['start','response','reader','abort','read-rejected','cancel-rejected']);assert(proof);assert.equal(proof.signalAborted,true);assert.equal(proof.bodyCanceled,false);assert.equal(proof.bodyComplete,false);assert.equal(Object.hasOwn(proof,'bytes'),false);
});

function heldCompositionReads(){
 const path='/api/v1/documents/doc/composition?revision=4',held=displaySample(path,{operation:1,start:100}),fresh=displaySample(path,{operation:2,start:150});
 held.rows[1].at=200;held.rows[2].at=201;held.rows[3]={...held.rows[3],kind:'cancel',at:202,bytes:undefined};held.q.startTime=190;held.q.requestId=373;
 fresh.rows[1].at=160;fresh.rows[2].at=161;fresh.rows[3].at=162;fresh.q.startTime=151;fresh.q.requestId=374;
 return {rows:[...held.rows,...fresh.rows].sort((a,b)=>a.at-b.at),requests:[held.q,fresh.q],held,fresh};
}
test('held older and fresh same-URL reads require an honest full-bucket unique association certificate',()=>{
 // The prior105 overlap fixtures are uniquely forced; their negative twins now use100.
 for(const path of ['/api/v1/documents/doc/image','/api/v1/workflow/item']){const a=displaySample(path),b=displaySample(path,{operation:2,start:105});b.q.requestId=10;const exact=displayReadProofs([...a.rows,...b.rows],[a.q,b.q]);assert.deepEqual(exact.map(p=>[p.operation,p.requestId]),[[1,9],[2,10]]);assert(exact.every(p=>p.association==='unique-frame-time-bijection'&&validOriginalReadBijection(p)));}
 const x=heldCompositionReads(),proofs=displayReadProofs(x.rows,x.requests);assert.equal(proofs.length,2);
 const held=proofs.find(p=>p.requestId===373),fresh=proofs.find(p=>p.requestId===374);assert(held);assert(fresh);
 assert.equal(held.association,'unique-frame-time-bijection');assert.deepEqual(held.eligibleRequests,[373,374]);assert.deepEqual(held.concurrentOperations,[2]);assert.equal(held.bodyCanceled,true);assert.equal(held.bodyComplete,false);
 assert.deepEqual(fresh.eligibleRequests,[374]);assert.deepEqual(fresh.concurrentOperations,[1]);assert.equal(fresh.bodyComplete,true);assert.equal(fresh.bytes,64);
 assert.deepEqual(held.bijection.pairs,[{operation:2,requestId:374},{operation:1,requestId:373}]);assert(validOriginalReadBijection(held));assert(validOriginalReadBijection(fresh));
 for(const [p,contentType,expected]of [[held,'application/json','exact-request-observed-composition-terminal'],[fresh,'application/json; charset=utf-8','exact-original-json-response-eof']]){
  const e={...structuredClone(event),requestId:p.requestId,url:p.url,response:{...structuredClone(event.response),requestId:p.requestId,url:p.url,contentType}};
  assert.equal(classify(e,origin,'chromium',[],[p]),expected);
 }
});
test('classifiers reject false or incomplete bijection certificates even for readonly cancellation branches',()=>{
 const x=heldCompositionReads(),proof=displayReadProofs(x.rows,x.requests).find(p=>p.requestId===373);assert(proof);
 const e={...structuredClone(event),requestId:373,url:proof.url,response:{...structuredClone(event.response),requestId:373,url:proof.url,contentType:'application/json'}};
 const bads=[p=>p.association='unique-frame-time-window',p=>p.association='url-only',p=>delete p.bijection,p=>p.bijection.version=2,p=>p.exactOccurrence=false,p=>p.frameId++,p=>p.requestFrame++,p=>p.document='20000000-0000-4000-8000-000000000002',p=>p.bijection.document='20000000-0000-4000-8000-000000000002',p=>p.bijection.operations[0].document='20000000-0000-4000-8000-000000000002',p=>p.start++,p=>p.end++,p=>p.requestStart++,p=>p.operation=2,p=>p.status=202,p=>p.eligibleRequests=[373],p=>p.concurrentOperations=[],p=>p.bijection.operations.pop(),p=>p.bijection.requests.pop(),p=>p.bijection.pairs.pop(),p=>p.bijection.pairs.reverse(),p=>p.bijection.pairs[0].requestId=373,p=>p.bijection.pairs[0].operation=1,p=>p.bijection.operations[0].operation=2,p=>p.bijection.requests[0].requestId=374,p=>p.bijection.operations[0].eligibleRequests=[373],p=>p.bijection.operations[0].eligibleRequests.push(373),p=>p.bijection.operations[0].concurrentOperations=[],p=>p.bijection.operations[0].anchor=99,p=>p.bijection.operations[0].end=199,p=>p.bijection.requests[0].startTime=300,p=>p.bijection.requests[0].redirected=true,p=>p.bijection.requests[0].response.fromServiceWorker=true,p=>p.bijection.requests[0].method='POST',p=>p.bijection.requests[0].frameId=2,p=>p.bijection.requests[0].url+='&other',p=>p.bijection.requests[1].response.status=201,p=>p.bijection.operations[1].anchorStatus=201,p=>p.bijection.operations[1].anchorURL+='&other',p=>p.bijection.operations[1].anchorRedirected=true,p=>p.bijection.operations[1].anchorKind='rejected',p=>p.bijection.operations.push(...Array.from({length:31},()=>structuredClone(p.bijection.operations[0])))];
 for(const mutate of bads){const p=structuredClone(proof);mutate(p);assert.equal(validOriginalReadBijection(p),false);assert.equal(classify(e,origin,'chromium',[],[p]),false);}
 // Consistent graph metadata still cannot be applied to a different HTTP method.
 const p=structuredClone(proof);p.method=p.bijection.method='POST';for(const q of p.bijection.requests)q.method='POST';assert(validOriginalReadBijection(p));assert.equal(classify(e,origin,'chromium',[],[p]),false);
});


function displayBucket(count=4){
 const operations=[],requests=[];
 for(let i=0;i<count;i++){
  const operation=count===4?[332,337,338,339][i]:i+1,start=100+i*100,x=displaySample('/api/v1/documents/doc/composition',{operation,start});
  x.q.requestId=count===4?[367,372,373,374][i]:i+100;
  if(i===count-2){x.rows[1].at+=100;x.rows[2].at+=100;x.rows[3].at+=100;}
  operations.push(x.rows);requests.push(x.q);
 }
 return {operations,requests,get rows(){return this.operations.flat();}};
}
test('whole original bucket proves the unique held/fresh four-operation bijection with honest ambiguity and concurrency',()=>{
 const x=displayBucket(),proofs=displayReadProofs(x.rows,x.requests);assert.equal(proofs.length,4);
 assert.deepEqual(proofs.map(p=>[p.operation,p.requestId]),[[332,367],[337,372],[338,373],[339,374]]);
 for(const p of proofs){assert.equal(p.association,'unique-frame-time-bijection');assert.equal(p.bodyComplete,true);assert.equal(p.bytes,64);assert.equal(p.bijection.operations.length,4);assert.equal(p.bijection.requests.length,4);assert.equal(p.bijection.pairs.length,4);assert(p.bijection.operations.every(o=>o.document===p.document&&o.anchorKind==='response'&&o.anchorStatus===200&&o.anchorURL===p.url&&o.anchorRedirected===false));}
 const held=proofs.find(p=>p.operation===338),fresh=proofs.find(p=>p.operation===339);
 assert.deepEqual(held.eligibleRequests,[373,374]);assert.deepEqual(held.concurrentOperations,[339]);assert.deepEqual(fresh.eligibleRequests,[374]);assert.deepEqual(fresh.concurrentOperations,[338]);
 assert.deepEqual(held.bijection.pairs,[{operation:332,requestId:367},{operation:337,requestId:372},{operation:339,requestId:374},{operation:338,requestId:373}]);
});
test('bucket matching is independent of operation/native list ordering and preserves ordinary singleton windows',()=>{
 const x=displayBucket(),proofs=displayReadProofs([x.operations[2],x.operations[0],x.operations[3],x.operations[1]].flat(),[...x.requests].reverse());
 assert.deepEqual(proofs.map(p=>[p.operation,p.requestId]).sort((a,b)=>a[0]-b[0]),[[332,367],[337,372],[338,373],[339,374]]);
 assert.deepEqual(proofs.find(p=>p.operation===338).eligibleRequests,[374,373]);
 const a=displaySample(),b=displaySample(undefined,{operation:2,start:140});b.q.requestId=10;
 for(const p of displayReadProofs([...a.rows,...b.rows],[a.q,b.q])){assert.equal(p.association,'unique-frame-time-window');assert.equal('bijection' in p,false);assert.deepEqual(p.eligibleRequests,[p.requestId]);assert.deepEqual(p.concurrentOperations,[]);}
});
test('bucket matching refuses alternative matchings unmatched vertices duplicate IDs and missing time edges',()=>{
 const cases=[
  x=>{for(const row of x.operations[3])row.start=300;x.operations[3][0].at=300;},
  x=>{x.requests.pop();},x=>{x.requests.push({...x.requests[0],requestId:999,startTime:9000});},
  x=>{x.requests[2].startTime=9000;},x=>{x.requests[2].requestId=x.requests[3].requestId;},
  x=>{x.requests.push(x.requests[0]);},x=>{x.requests[2].startTime=-1;},
 ];
 for(const mutate of cases){const x=displayBucket();mutate(x);assert.deepEqual(displayReadProofs(x.rows,x.requests),[]);}
});
test('fallback includes malformed startless anchorless and cross-document raw operations instead of filtering them away',()=>{
 for(const mutate of [
  x=>{const extra=displaySample('/api/v1/documents/doc/composition',{operation:999,start:9000});extra.q.requestId=999;x.operations.push(extra.rows.slice(1));x.requests.push(extra.q);},
  x=>{x.operations[0]=x.operations[0].filter(row=>row.kind!=='response');},
  x=>{x.operations[0].push({...x.operations[0][0]});},
  x=>{for(const row of x.operations[0])row.document='20000000-0000-4000-8000-000000000002';},
  x=>{delete x.operations[0][2].method;},x=>{x.operations[0][2].kind='unobserved-kind';},
  x=>{x.operations[0][2].start++;},x=>{x.operations[0][2].at=NaN;},
 ]){const x=displayBucket();mutate(x);assert.deepEqual(displayReadProofs(x.rows,x.requests),[]);}
 for(const mutate of [q=>{delete q.frameId;},q=>q.frameId=0,q=>{delete q.url;},q=>q.url='not a URL',q=>{delete q.method;},q=>q.method='PATCH',q=>{delete q.requestId;},q=>q.requestId=367]){
  const x=displayBucket(),extra={...x.requests[0],requestId:999,frameId:2,url:origin+'/api/v1/other'};mutate(extra);x.requests.push(extra);assert.deepEqual(displayReadProofs(x.rows,x.requests),[]);
 }
});
test('every assigned bucket member must preserve the original response reader terminal and collection guards',()=>{
 for(const mutate of [
  x=>{x.requests[0].redirected=true;},x=>{x.requests[0].response.fromServiceWorker=true;},
  x=>{x.requests[0].response.status=500;},x=>{x.requests[0].response.url+='?other';},
  x=>{x.operations[0][1].responseURL+='?other';},x=>{x.operations[0][1].redirected=true;},
  x=>{x.operations[0]=x.operations[0].slice(0,-1);},
  x=>{x.operations[0].push({...x.operations[0].at(-1),kind:'clone'});},
  x=>{x.operations[0][2].reader=2;},x=>{x.operations[0].at(-1).bytes=-1;},
  x=>{x.operations[0].push({...x.operations[0].at(-1),kind:'cancel-rejected',errorName:'AbortError'});},
 ]){const x=displayBucket();mutate(x);assert.deepEqual(displayReadProofs(x.rows,x.requests),[]);}
 const x=displayBucket();assert.deepEqual(displayReadProofs(x.rows,x.requests,['lost original observation']),[]);
});
test('full raw bucket cap is inclusive at32 and refuses33 without certifying a truncated subset',()=>{
 const within=displayBucket(32),proofs=displayReadProofs(within.rows,within.requests);assert.equal(proofs.length,32);assert(proofs.every(p=>p.association==='unique-frame-time-bijection'&&p.bijection.operations.length===32&&p.bijection.requests.length===32));
 const outside=displayBucket(33);assert.deepEqual(displayReadProofs(outside.rows,outside.requests),[]);
});

function untimedDisplayReads(){
 const path='/api/v1/assets/tile/display-tile',old=displaySample(path,{operation:1}),current=displaySample(path,{operation:1,start:200,document:'20000000-0000-4000-8000-000000000002'});
 old.q.requestId=130;current.q.requestId=197;current.q.startTime=0;delete current.q.response;
 const start={...current.rows[0],hasSignal:true};current.rows=[start,{...start,kind:'abort',at:210,aborted:true},{...start,kind:'rejected',at:220,errorName:'AbortError'}];
 return {old,current,rows:[...old.rows,...current.rows],requests:[old.q,current.q]};
}
test('untimed preheader abort association preserves raw zero and compound generations without inventing native time',()=>{
 const x=untimedDisplayReads(),proofs=displayReadProofs(x.rows,x.requests);assert.equal(proofs.length,2);const p=proofs.find(p=>p.requestId===197),old=proofs.find(p=>p.requestId===130);assert(p);assert(old);
 assert.equal(p.association,'unique-frame-inferred-bijection');assert.equal(p.inferredAssociation,true);assert.equal(p.requestStartRaw,0);assert.equal(p.requestStart,null);assert.equal(p.requestTiming,'unavailable');assert.equal(p.signalAborted,true);assert.equal(p.bodyCanceled,false);assert.equal(p.bodyComplete,false);assert.equal(Object.hasOwn(p,'bytes'),false);assert.equal(Object.hasOwn(p,'status'),false);
 assert.equal(old.requestTiming,'observed');assert.equal(old.requestStart,101);assert.equal(old.requestStartRaw,101);assert.equal(old.bodyComplete,true);assert.equal(old.bytes,64);
 assert.deepEqual(old.eligibleRequests,[130,197]);assert.deepEqual(p.eligibleRequests,[197]);assert.deepEqual(p.bijection.pairs,[{document:x.current.rows[0].document,operation:1,requestId:197},{document:x.old.rows[0].document,operation:1,requestId:130}]);assert.deepEqual(p.concurrentOperations,[]);assert(validUntimedOriginalReadBijection(p));assert(validUntimedOriginalReadBijection(old));assert.equal(validOriginalReadBijection(p),false);
 const reversed=displayReadProofs([...x.current.rows,...x.old.rows],[...x.requests].reverse());assert.deepEqual(reversed.map(p=>[p.document,p.operation,p.requestId]).sort((a,b)=>a[2]-b[2]),proofs.map(p=>[p.document,p.operation,p.requestId]).sort((a,b)=>a[2]-b[2]));assert(reversed.every(validUntimedOriginalReadBijection));
 const overlap=untimedDisplayReads();overlap.old.rows[1].at=210;overlap.old.rows[2].at=211;overlap.old.rows[3].at=230;const overlapping=displayReadProofs(overlap.rows,overlap.requests);assert.equal(overlapping.length,2);assert(overlapping.every(validUntimedOriginalReadBijection));assert.deepEqual(overlapping.find(p=>p.requestId===197).concurrentOperations,[{document:overlap.old.rows[0].document,operation:1}]);
 const singleton=displayReadProofs(x.current.rows,[x.current.q]);assert.equal(singleton.length,1);assert.equal(singleton[0].bijection.operations.length,1);assert.equal(singleton[0].bijection.requests.length,1);assert(validUntimedOriginalReadBijection(singleton[0]));
 for(const [engine,errorText]of [['chromium','net::ERR_ABORTED'],['firefox','NS_BINDING_ABORTED'],['webkit','cancelled']]){const e={...structuredClone(event),requestId:197,url:p.url,response:null,failure:{errorText}};assert.equal(classify(e,origin,engine,[],[p]),'exact-request-observed-display-abort-before-headers');assert.equal(classify(e,origin,engine,[],singleton),'exact-request-observed-display-abort-before-headers');}
});
test('untimed certificates refuse invented clocks, row stitching, false terminal facts and timed retagging',()=>{
 const x=untimedDisplayReads(),proof=displayReadProofs(x.rows,x.requests).find(p=>p.requestId===197);assert(proof);const e={...structuredClone(event),requestId:197,url:proof.url,response:null};
 const bads=[p=>delete p.bijection,p=>p.association='unique-frame-time-window',p=>p.association='unique-frame-time-bijection',p=>p.association='url-only',p=>{delete p.bijection;p.association='unique-frame-time-window';},p=>p.bijection.version=1,p=>p.inferredAssociation=false,p=>p.requestTiming='observed',p=>p.requestStart=0,p=>p.requestStart=201,p=>p.requestStartRaw=201,p=>p.requestStartRaw=undefined,p=>p.signalAborted=false,p=>p.bodyComplete=true,p=>p.bodyCanceled=true,p=>p.bytes=0,p=>p.status=200,p=>p.method='POST',p=>p.document=x.old.rows[0].document,p=>p.operation=2,p=>p.frameId=2,p=>p.requestFrame=2,p=>p.bijection.document=p.document,p=>p.bijection.operations[1].document=x.old.rows[0].document,p=>p.bijection.pairs[0].document=x.old.rows[0].document,p=>p.bijection.operations[1].operation=2,p=>p.bijection.operations[1].untimedAbort=null,p=>p.bijection.operations[1].untimedAbort.hasSignal=false,p=>p.bijection.operations[1].untimedAbort.aborted=false,p=>p.bijection.operations[1].untimedAbort.kinds.reverse(),p=>p.bijection.operations[1].untimedAbort.kinds.push('reader'),p=>p.bijection.operations[1].untimedAbort.abortAt=221,p=>p.bijection.operations[1].untimedAbort.rejectionAt=219,p=>p.bijection.operations[1].untimedAbort.errorName='NetworkError',p=>p.bijection.requests[1].startTime=-1,p=>p.bijection.requests[1].startTime=NaN,p=>delete p.bijection.requests[1].startTime,p=>p.bijection.requests[1].response={url:p.url,status:200,fromServiceWorker:false},p=>p.bijection.requests[1].redirected=true,p=>p.bijection.operations[0].eligibleRequests=[130],p=>p.bijection.requests.pop(),p=>p.bijection.operations.pop(),p=>p.bijection.pairs.reverse(),p=>p.bijection.pairs[1].requestId=197,p=>p.bijection.operations.push(...Array.from({length:31},()=>structuredClone(p.bijection.operations[0])))];
 for(const mutate of bads){const p=structuredClone(proof);mutate(p);assert.equal(validUntimedOriginalReadBijection(p),false);assert.equal(classify(e,origin,'chromium',[],[p]),false);}
 const timed=displayReadProofs(x.old.rows,[x.old.q])[0];assert.equal(timed.association,'unique-frame-time-window');for(const fields of [{requestStart:null},{requestStartRaw:0},{requestTiming:'unavailable'},{inferredAssociation:true}]){const p={...timed,...fields},response={...structuredClone(event.response),requestId:130,url:timed.url,contentType:'application/x-ideogram-rgba8'};assert.equal(classify({...e,requestId:130,response},origin,'chromium',[],[p]),false);}
 // Unknown timing supplies no completed-response authority to an unlisted path.
 const other=untimedDisplayReads();for(const row of other.current.rows)row.url=origin+'/api/v1/commands/command';other.current.q.url=origin+'/api/v1/commands/command';const [q]=displayReadProofs(other.current.rows,[other.current.q]);assert(q);assert(validUntimedOriginalReadBijection(q));assert.equal(classify({...e,url:q.url},origin,'chromium',[],[q]),false);
});


function untimedHelperSample(options={}){
 const x=displaySample('/api/v1/assets/tile/display-tile',options),base={...x.rows[0],hasSignal:true};
 x.rows=[base,{...base,kind:'abort',at:base.start+10,aborted:true},{...base,kind:'rejected',at:base.start+11,errorName:'AbortError'}];
 x.q.startTime=0;delete x.q.response;return x;
}
function untimedHelperBucket(){
 const old=displaySample('/api/v1/assets/tile/display-tile',{operation:1,start:100}),fresh=untimedHelperSample({document:'20000000-0000-4000-8000-000000000002',operation:1,start:200});
 old.q.requestId=130;fresh.q.requestId=197;
 // Retain the old document's actual overlapping read without merging its rows
 // with the new document's operation having the same per-document ordinal.
 old.rows[1].at=210;old.rows[2].at=211;old.rows[3].at=220;
 return {operations:[old.rows,fresh.rows],requests:[old.q,fresh.q],get rows(){return this.operations.flat();}};
}
test('explicit native zero singleton proves only the exact original GET preheader abort sequence',()=>{
 const x=untimedHelperSample(),[p]=displayReadProofs(x.rows,[x.q]);assert(p);
 assert.equal(p.association,'unique-frame-inferred-bijection');assert.equal(p.inferredAssociation,true);assert.equal(p.requestStartRaw,0);assert.equal(p.requestStart,null);assert.equal(p.requestTiming,'unavailable');
 assert.equal(p.signalAborted,true);assert.equal(p.bodyCanceled,false);assert.equal(p.bodyComplete,false);assert.equal('bytes' in p,false);assert.equal('status' in p,false);
 assert.equal(p.bijection.version,2);assert.equal('document' in p.bijection,false);assert.equal(p.bijection.requests[0].startTime,0);assert.equal(p.bijection.requests[0].response,null);
 assert.deepEqual(p.bijection.operations[0].untimedAbort,{hasSignal:true,aborted:true,kinds:['start','abort','rejected'],abortAt:110,rejectionAt:111,errorName:'AbortError'});
 assert.deepEqual(p.bijection.pairs,[{document:x.rows[0].document,operation:1,requestId:9}]);
});
test('untimed full bucket binds compound document identities with honest wildcard candidates and overlap',()=>{
 const x=untimedHelperBucket(),proofs=displayReadProofs(x.rows,x.requests);assert.equal(proofs.length,2);
 const old=proofs.find(p=>p.requestId===130),fresh=proofs.find(p=>p.requestId===197);assert(old&&fresh);assert.equal(old.operation,fresh.operation);assert.notEqual(old.document,fresh.document);
 assert.equal(old.requestStartRaw,101);assert.equal(old.requestStart,101);assert.equal(old.requestTiming,'observed');assert.equal(old.bodyComplete,true);assert.equal(old.bytes,64);
 assert.deepEqual(old.eligibleRequests,[130,197]);assert.deepEqual(fresh.eligibleRequests,[197]);
 assert.deepEqual(old.concurrentOperations,[{document:fresh.document,operation:1}]);assert.deepEqual(fresh.concurrentOperations,[{document:old.document,operation:1}]);
 assert.deepEqual(old.bijection.pairs,[{document:fresh.document,operation:1,requestId:197},{document:old.document,operation:1,requestId:130}]);
 assert.equal(old.bijection.operations[0].untimedAbort,null);assert.equal(old.bijection.operations.length,2);assert.equal(old.bijection.requests.length,2);
 const reordered=displayReadProofs([...x.operations].reverse().flat(),[...x.requests].reverse());
 assert.deepEqual(reordered.map(p=>[p.document,p.operation,p.requestId]).sort(),proofs.map(p=>[p.document,p.operation,p.requestId]).sort());
 assert.deepEqual(reordered.find(p=>p.requestId===130).eligibleRequests,[197,130]);
});
test('untimed proof refuses missing negative nonfinite timing zero responses and non-GET assignments',()=>{
 for(const mutate of [
  x=>{delete x.q.startTime;},x=>x.q.startTime=-1,x=>x.q.startTime=NaN,x=>x.q.startTime=Infinity,
  x=>x.q.response={url:x.q.url,status:200,fromServiceWorker:false},x=>x.q.response=false,
  x=>{x.q.method='POST';for(const row of x.rows)row.method='POST';},x=>{x.q.method='PUT';for(const row of x.rows)row.method='PUT';},
  x=>x.q.resourceType='document',x=>x.q.redirected=true,x=>x.q.frameId=2,x=>x.q.url+='?other',
 ]){const x=untimedHelperSample();mutate(x);assert.deepEqual(displayReadProofs(x.rows,[x.q]),[]);}
});
test('untimed assignment requires exactly ordered start abort AbortError rejection with original signal',()=>{
 for(const mutate of [
  x=>x.rows[0].hasSignal=false,x=>x.rows[1].aborted=false,x=>x.rows[2].errorName='NetworkError',
  x=>x.rows.splice(1,1),x=>x.rows.push({...x.rows[1]}),x=>{[x.rows[1],x.rows[2]]=[x.rows[2],x.rows[1]];},
  x=>x.rows[1].at=99,x=>x.rows[1].at=112,x=>x.rows[2].at=109,
  x=>x.rows.push({...x.rows[2],kind:'reader',reader:1}),x=>x.rows.push({...x.rows[2],kind:'complete',reader:1,bytes:64}),
  x=>x.rows.push({...x.rows[2],kind:'cancel',reader:0}),x=>x.rows.push({...x.rows[2],kind:'read-rejected'}),
  x=>x.rows.push({...x.rows[2],kind:'clone'}),x=>x.rows.push({...x.rows[2],kind:'tee'}),x=>x.rows.push({...x.rows[2],kind:'observer-error'}),
  x=>x.rows[1].reader=1,x=>x.rows[2].bytes=0,x=>x.rows[2].status=200,
 ]){const x=untimedHelperSample();mutate(x);assert.deepEqual(displayReadProofs(x.rows,[x.q]),[]);}
 const x=untimedHelperSample();assert.deepEqual(displayReadProofs(x.rows,[x.q],['collector failure']),[]);
});
test('untimed wildcard choices cannot use response or abort outcomes to manufacture uniqueness',()=>{
 const ambiguous=untimedHelperBucket();for(const row of ambiguous.operations[1]){row.start=100;row.at-=100;}
 assert.deepEqual(displayReadProofs(ambiguous.rows,ambiguous.requests),[]);
 const twoZero=untimedHelperBucket();twoZero.requests[0].startTime=0;delete twoZero.requests[0].response;
 assert.deepEqual(displayReadProofs(twoZero.rows,twoZero.requests),[]);
 const eof=displaySample('/api/v1/assets/tile/display-tile');eof.q.startTime=0;delete eof.q.response;
 assert.deepEqual(displayReadProofs(eof.rows,[eof.q]),[]);
});
test('untimed fallback retains every raw vertex and refuses malformed or unmatched bucket members',()=>{
 for(const mutate of [
  x=>x.requests.pop(),x=>x.requests.push({...x.requests[0],requestId:999}),x=>x.requests[0].requestId=197,
  x=>x.requests[0].startTime=NaN,x=>x.requests[0].response.status=500,x=>x.requests[0].response.fromServiceWorker=true,
  x=>x.operations[0].splice(0,1),x=>x.operations[0].push({...x.operations[0][0]}),x=>x.operations[0].splice(1,1),
  x=>x.operations[0].push({...x.operations[0].at(-1),kind:'unobserved-kind'}),x=>x.operations[0][2].start++,
  x=>{delete x.operations[0][2].document;},x=>{delete x.requests[0].frameId;},x=>x.requests[0].method='PATCH',
 ]){const x=untimedHelperBucket();mutate(x);assert.deepEqual(displayReadProofs(x.rows,x.requests),[]);}
 const x=untimedHelperBucket();x.operations.push(x.operations[1].map(row=>({...row,operation:2})));x.requests.push({...x.requests[1],requestId:198});assert.deepEqual(displayReadProofs(x.rows,x.requests),[]);
});
test('untimed full raw bucket admits32 vertices but refuses33 without truncation',()=>{
 const make=count=>{const operations=[],requests=[];for(let i=0;i<count-1;i++){const x=displaySample('/api/v1/assets/tile/display-tile',{operation:i+1,start:100+i*100});x.q.requestId=i+1;operations.push(x.rows);requests.push(x.q);}const x=untimedHelperSample({document:'20000000-0000-4000-8000-000000000002',operation:1,start:10000});x.q.requestId=1000;operations.push(x.rows);requests.push(x.q);return {rows:operations.flat(),requests};};
 const within=make(32),proofs=displayReadProofs(within.rows,within.requests);assert.equal(proofs.length,32);assert(proofs.every(p=>p.bijection.version===2&&p.bijection.operations.length===32&&p.bijection.requests.length===32));
 assert.equal(proofs.find(p=>p.requestId===1000).requestStart,null);assert(proofs.filter(p=>p.requestId!==1000).every(p=>p.bodyComplete&&p.eligibleRequests.includes(1000)));
 const outside=make(33);assert.deepEqual(displayReadProofs(outside.rows,outside.requests),[]);
});


function queueObserverSample(){
 const {rows,q}=displaySample('/api/v1/queue'),raw={events:rows,requests:[q],errors:[]};
 const snapshot={capturedAt:150,eventLimit:DISPLAY_OBSERVATION_LIMIT,requestLimit:DISPLAY_REQUEST_LIMIT,raw:structuredClone(raw),proofs:displayReadProofs(rows,[q])};
 const row={id:1,originalRequestId:9,epoch:2,method:'GET',origin,path:'/api/v1/queue',hasQuery:false,status:200,stage:'json',body:'failed',terminal:'failed',nativeFailure:'net::ERR_ABORTED',contentType:'application/json; charset=utf-8',contentLength:'64'};
 const later={...row,id:2,originalRequestId:10,stage:'complete',body:'complete',terminal:'finished',nativeFailure:null};
 const error=Error('response.json: Protocol error (Network.getResponseBody): No data found for resource with given identifier\nResponse body is not available for a response that was navigated away from. Read response.body() before triggering any navigation.');
 return {row,error,later,snapshot,current:structuredClone(raw)};
}
const queueDisposition=s=>queueBodyObserverDisposition(s.row,s.error,origin,s.engine??'chromium',[s.row,...(s.later?[s.later]:[])],s.snapshot,s.current);
test('queue observer loss requires exact original EOF and a later fully observed same-epoch public response',()=>{
 const sample=queueObserverSample();assert.deepEqual(queueDisposition(sample),{kind:'exact-original-queue-eof-observer-loss',requestId:9,frameId:1,document:'10000000-0000-4000-8000-000000000001',operation:1,bytes:64,laterObservationId:2});
 assert.equal(sample.row.body,'failed');assert.equal('value' in sample.row,false);
 for(const change of [s=>s.engine='firefox',s=>s.row.method='POST',s=>s.row.origin+='0',s=>s.row.path+='/extra',s=>s.row.hasQuery=true,s=>s.row.status=201,s=>s.row.stage='response',s=>s.row.body='pending',s=>s.row.terminal='finished',s=>s.row.nativeFailure='net::ERR_FAILED',s=>s.row.contentType='text/plain',s=>s.row.contentLength='063',s=>s.row.contentLength='0',s=>s.row.contentLength='65',s=>s.error=Error('net::ERR_ABORTED'),s=>s.error=Error(s.error.message+' extra')]){const s=queueObserverSample();change(s);assert.equal(queueDisposition(s),false);}
 for(const change of [s=>s.later=null,s=>s.later.id=1,s=>s.later.epoch++,s=>s.later.method='POST',s=>s.later.origin+='0',s=>s.later.hasQuery=true,s=>s.later.path+='/extra',s=>s.later.status=500,s=>s.later.body='failed',s=>s.later.stage='retain',s=>s.later.terminal='unknown',s=>s.later.nativeFailure='net::ERR_ABORTED']){const s=queueObserverSample();change(s);assert.equal(queueDisposition(s),false);}
});
test('queue observer loss refuses missing, duplicate, incomplete or canceled original proofs',()=>{
 for(const change of [s=>s.snapshot.proofs=[],s=>s.snapshot.proofs.push(structuredClone(s.snapshot.proofs[0])),s=>s.snapshot.proofs[0].requestId++,s=>s.snapshot.proofs[0].url+='?x=1',s=>s.snapshot.proofs[0].status=201,s=>s.snapshot.proofs[0].exactOccurrence=false,s=>s.snapshot.proofs[0].requestFrame++,s=>s.snapshot.proofs[0].eligibleRequests.push(10),s=>s.snapshot.proofs[0].bodyComplete=false,s=>s.snapshot.proofs[0].signalAborted=true,s=>s.snapshot.proofs[0].bodyCanceled=true,s=>s.snapshot.proofs[0].bytes--,s=>s.snapshot.raw.errors.push('collector error'),s=>s.current.errors.push('collector error'),s=>s.snapshot.eventLimit=s.snapshot.raw.events.length,s=>s.snapshot.requestLimit=s.snapshot.raw.requests.length]){const s=queueObserverSample();change(s);assert.equal(queueDisposition(s),false);}
});
test('queue snapshot retains every original bucket member and refuses unfinished or late pre-boundary evidence',()=>{
 const pending=displaySample('/api/v1/queue',{operation:2,start:125});pending.q.requestId=10;
 for(const part of ['rows','request','both']){const s=queueObserverSample();if(part!=='request'){s.snapshot.raw.events.push(pending.rows[0]);s.current.events.push(pending.rows[0]);}if(part!=='rows'){s.snapshot.raw.requests.push({...pending.q,response:undefined});s.current.requests.push({...pending.q,response:undefined});}s.snapshot.proofs=displayReadProofs(s.snapshot.raw.events,s.snapshot.raw.requests);assert.equal(queueDisposition(s),false,part);}
 for(const change of [s=>s.current.events.push({...s.current.events[0],kind:'abort',at:160,aborted:true}),s=>s.current.events.push({...s.current.events[0],kind:'clone',at:160}),s=>s.current.events.push({...pending.rows[0],start:149,at:149}),s=>s.current.requests.push({...pending.q,startTime:149}),s=>s.current.requests[0].response.status=201]){const s=queueObserverSample();change(s);assert.equal(queueDisposition(s),false);}
});
test('queue snapshot is immutable and only demonstrably later same-bucket traffic stays separate',()=>{
 const s=queueObserverSample(),next=displaySample('/api/v1/queue',{operation:2,start:200});next.q.requestId=10;
 s.current.events.push(...next.rows);s.current.requests.push(next.q);assert.ok(queueDisposition(s));assert.equal(s.snapshot.raw.events.length,4);assert.equal(s.snapshot.raw.requests.length,1);
 const unknown={...next.q,requestId:11,startTime:0,response:undefined};s.current.requests.push(unknown);
 assert.deepEqual(displayReadProofs(s.current.events,s.current.requests),[]);assert.equal(queueDisposition(s),false,'a later unavailable timestamp cannot silently validate the captured proof');assert.equal(s.snapshot.proofs.length,1);
});
