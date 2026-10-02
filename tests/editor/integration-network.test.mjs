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

// Use the actual shared observer's pure association logic; these fabricated
// rows test the integration join and confer no browser/runtime qualification.
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const {displayReadProofs}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(readFileSync(new URL('./display-aborts.ts',import.meta.url),'utf8'),{mode:'strip'})).toString('base64'));
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
