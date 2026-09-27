import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedCompositionCancellation as classify} from './composition-network.mjs';
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
