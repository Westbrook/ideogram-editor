import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedDisplayBusy,expectedCompositionCancellation as classify} from './composition-network.mjs';
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
