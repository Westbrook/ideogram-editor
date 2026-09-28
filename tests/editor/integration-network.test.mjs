import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {integrationCancellation as classify} from './integration-network.mjs';
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
