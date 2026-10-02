import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {uiModule,modelMemoryURL,allocationsURL,promptMemoryURL} from '../ui-model-module.mjs';
import {setup,readHeaders,cookieFrom,pair,call} from './helpers.mjs';
import {terminal} from '../raster/helpers.mjs';
import {copy,preview,workspace} from '../portable/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {projectionEntity,projectionEvent} from '../../dist/local/src/protocol/projection-schema.js';

function firstBatch(server,paired){return new Promise((resolve,reject)=>{
 const url=new URL(server.origin);let pending='',settled=false;const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);req.destroy();error?reject(error):resolve(value);};
 const req=request({hostname:'127.0.0.1',port:url.port,path:'/api/v1/events/stream?after=0',headers:readHeaders(cookieFrom(paired))},res=>{if(res.statusCode!==200)return done(Error('Unexpected SSE status '+res.statusCode));res.setEncoding('utf8');res.on('error',error=>done(error));res.on('data',part=>{pending+=part;for(let end;(end=pending.indexOf('\n\n'))!==-1;){const frame=pending.slice(0,end);pending=pending.slice(end+2);try{const line=frame.split('\n').find(line=>line.startsWith('data: '));if(!line)continue;const body=JSON.parse(line.slice(6));if(body.kind==='batch-part')return done(null,body);}catch(error){return done(error);}}});});
 const timer=setTimeout(()=>done(Error('SSE batch timeout')),5000);req.on('error',error=>done(error));req.end();
});}

test('LP9 real writer synchronizes capabilities, document, command result, SSE, snapshot and tail; metadata survives restart',async t=>{
 const f=await setup(t),name='Café 東京',command=f.command({expectedDocumentRevision:null,body:{type:'CreateDocument',name,width:3,height:2,background:{kind:'transparent'}}}),created=await terminal(f,command);assert.equal(created.json.receipt.status,'accepted',created.text);
 const metadata={schemaVersion:1,name,creationBackground:{kind:'transparent'}};
 assert.equal((await f.read('/api/v1/capabilities')).json.projectionSchema,9);
 const document=(await f.read('/api/v1/documents/document_1')).json;assert.equal(document.projectionSchema,9);assert.deepEqual(document.projection.value.metadata,metadata);assert.equal(projectionEntity(9,'document',document.projection.value),'1');
 const commandResult=(await f.read('/api/v1/commands/'+command.command.commandId+'/result')).json;assert.equal(commandResult.recovery.projectionSchema,9);assert.equal(commandResult.batches[0].kind,'inline');assert.deepEqual(commandResult.batches[0].events[0].payload.document.metadata,metadata);
 const sse=await firstBatch(f.server,f.paired);assert.equal(sse.projectionSchema,9);assert.equal(sse.partIndex,0);assert.equal(sse.partCount,1);projectionEvent(9,sse.events[0]);assert.deepEqual(sse.events[0].payload.document.metadata,metadata);
 for(let revision=1;revision<251;revision++){const r=await terminal(f,f.command({expectedDocumentRevision:String(revision),body:{type:'SaveCheckpoint',name:'LP9 '+revision}}));assert.equal(r.json.receipt.status,'accepted',r.text);}
 const gap=await f.read('/api/v1/events?after=0');assert.equal(gap.status,410);const descriptor=gap.json.error.details.value.snapshot;assert.equal(descriptor.snapshotSeq,'250');assert.equal(descriptor.recovery.projectionSchema,9);assert.equal(descriptor.recovery.highWater,'251');
 const content=await f.read(descriptor.content.url);assert.equal(content.status,200);const rows=content.text.trimEnd().split('\n').map(JSON.parse);assert.equal(rows[0].projectionSchema,9);
 const documentRows=rows.filter(row=>row.entityType==='document'),restored=JSON.parse(Buffer.concat(documentRows.map(row=>Buffer.from(row.utf8Base64,'base64'))).toString());assert.deepEqual(restored.metadata,metadata);assert.equal(restored.revision,'250');
 const tail=(await f.read('/api/v1/events?after=250&recoveryId='+descriptor.recovery.recoveryId)).json;assert.equal(tail.recovery.projectionSchema,9);assert.equal(tail.nextCursor,'251');assert.equal(tail.batches.length,1);for(const event of tail.batches[0].events)projectionEvent(9,event);
 await f.server.close();const restarted=await startLocalServer({root:f.root});t.after(()=>restarted.close());const paired=await pair(restarted),read=path=>call(restarted.origin,path,{headers:readHeaders(cookieFrom(paired))});
 const actual=(await read('/api/v1/documents/document_1')).json;assert.equal(actual.projectionSchema,9);assert.deepEqual(actual.projection.value.metadata,metadata);assert.equal(actual.projection.value.revision,'251');
 const fresh=(await read('/api/v1/events?after=0')).json.error.details.value.snapshot;assert.equal(fresh.recovery.projectionSchema,9);assert.equal(JSON.parse((await read(fresh.content.url)).text.split('\n')[0]).projectionSchema,9);
});

test('LP9 real imported namespace header matches its lease and retains exact document metadata',async t=>{
 const f=await setup(t),created=await terminal(f,f.command({expectedDocumentRevision:null,body:{type:'CreateDocument',name:'Namespace 東京',width:3,height:2,background:{kind:'transparent'}}}));assert.equal(created.json.receipt.status,'accepted',created.text);
 const saved=await copy(f),reviewed=await preview(f,saved.bytes),imported=await workspace(f,{type:'ImportBundle',reviewId:reviewed.review.reviewId,reviewHash:reviewed.review.reviewHash});
 const response=await f.read('/api/v1/events?after='+String(BigInt(imported.receipt.fromSeq)-1n));assert.equal(response.status,200);const page=response.json,batch=page.batches[0];assert.equal(page.recovery.projectionSchema,9);assert.equal(batch.kind,'transaction-ref');assert.equal(batch.recovery.projectionSchema,9);
 const events=(await f.read(batch.content.url)).text.trimEnd().split('\n').map(JSON.parse),event=events.find(v=>v.type==='BundleImported');assert(event);projectionEvent(9,event);
 const descriptor=(await f.read('/api/v1/namespace-events/'+event.eventId+'?recoveryId='+page.recovery.recoveryId)).json;assert.equal(descriptor.recovery.projectionSchema,9);const rows=(await f.read(descriptor.content.url)).text.trimEnd().split('\n').map(JSON.parse);assert.equal(rows[0].projectionSchema,9);
 const document=JSON.parse(Buffer.concat(rows.filter(row=>row.entityType==='document').map(row=>Buffer.from(row.utf8Base64,'base64'))).toString());assert.deepEqual(document,event.payload.document);assert.deepEqual(document.metadata,{schemaVersion:1,name:'Namespace 東京',creationBackground:{kind:'transparent'}});assert.equal(projectionEntity(9,'document',document),document.revision);
});


// Real command-result and projection readers share the actual HTTP response
// framing, event validators and local writer. The cache below only replaces
// IndexedDB persistence; its projection reducer is the production reducer.
async function commandProofReaders(){
 const control=await uiModule('src/state/control-memory.ts',{'../observability/allocations.js':allocationsURL});
 const protocol=name=>pathToFileURL(resolve('dist/local/src/protocol/'+name+'.js')).href;
 const resultURL=await uiModule('src/state/command-results.ts',{'../observability/allocations.js':allocationsURL,'../observability/model-memory.js':modelMemoryURL,'../observability/prompt-memory.js':promptMemoryURL,'./control-memory.js':control,'../protocol/json.js':protocol('json'),'../protocol/sha256.js':protocol('sha256'),'../protocol/validate.js':protocol('validate')});
 const recoveryMemory=await uiModule('src/observability/recovery-memory.ts',{'./allocations.js':allocationsURL}),cacheImport='data:text/javascript,'+encodeURIComponent('export class RecoveryCache {}');
 const recoveryURL=await uiModule('src/state/recovery-client.ts',{'../observability/recovery-memory.js':recoveryMemory,'./recovery-cache.js':cacheImport,'../protocol/json.js':protocol('json'),'../protocol/sha256.js':protocol('sha256'),'../protocol/validate.js':protocol('validate'),'../protocol/projection-schema.js':protocol('projection-schema')});
 return {...await import(resultURL),...await import(recoveryURL),...await import(allocationsURL)};
}
function commandProofCache(reduceDocument){
 let published={generation:'initial',cursor:'0',epoch:'0'};const generations=new Map([['initial',new Map()]]);
 const rows=g=>{if(!generations.has(g))generations.set(g,new Map());return generations.get(g);};
 return {async published(){return {...published};},async clone(from,to){generations.set(to,structuredClone(rows(from)));},async put(g,type,id,value){rows(g).set(type+':'+id,structuredClone(value));},async value(g,type,id){return rows(g).get(type+':'+id);},async discard(g){generations.delete(g);},
  async apply(g,event){assert.equal(event.type,'DocumentCreated');const document=reduceDocument(await this.value(g,'document',event.documentId)??null,event);await this.put(g,'document',document.id,document);await this.put(g,'history',event.payload.history.id,event.payload.history);},
  async publish(next,old){assert.deepEqual(old,published);published={...next};}};
}
test('real transparent CreateDocument receipt passes both owned event and projection proofs and releases both leases',async t=>{
 const f=await setup(t),api=await commandProofReaders(),{reduceDocument}=await import('../../dist/local/src/state/projection.js'),before=api.allocationLedger.snapshot();
 const command=f.command({expectedDocumentRevision:null,body:{type:'CreateDocument',name:'Untitled document',width:128,height:96,background:{kind:'transparent'}}}),created=await terminal(f,command);
 assert.equal(created.json.receipt.status,'accepted',created.text);const receipt=created.json.receipt,cache=commandProofCache(reduceDocument),released=[];
 const transport=async(path,init={})=>{
  const headers=new Headers({...readHeaders(cookieFrom(f.paired)),...init.headers});
  if(init.method&&init.method!=='GET'){headers.set('Origin',f.server.origin);headers.set('X-App-CSRF',f.paired.json.csrfToken);}
  const response=await fetch(f.server.origin+path,{...init,headers,redirect:'error'});
  if(/^\/api\/v1\/recovery\/[^/]+\/release$/.test(path)){assert.equal(response.status,204);released.push(path);}
  return response;
 };
 const recovery=new api.RecoveryConsumer(cache,transport,()=>f.paired.json.csrfToken);let events;
 try{
  const outcomes=await Promise.allSettled([api.readCommandEvents(transport,receipt),recovery.recover()]);
  if(outcomes[0].status==='fulfilled')events=outcomes[0].value;
  for(const [index,label]of [[0,'owned command event proof'],[1,'projection recovery proof']])if(outcomes[index].status==='rejected')throw new Error(label+' failed',{cause:outcomes[index].reason});
  assert.equal(events.value.length,1);const event=events.value[0];assert.equal(event.type,'DocumentCreated');assert.equal(event.commandId,receipt.commandId);assert.equal(event.transactionId,receipt.transactionId);assert.equal(event.workspaceSeq,receipt.toSeq);
  const published=await cache.published();assert.equal(published.cursor,receipt.toSeq);assert.deepEqual(await cache.value(published.generation,'document',command.command.documentId),event.payload.document);
  assert.deepEqual(event.payload.document.metadata,{schemaVersion:1,name:'Untitled document',creationBackground:{kind:'transparent'}});assert.deepEqual([event.payload.document.width,event.payload.document.height],[128,96]);
  assert.equal(released.length,2);assert.equal(new Set(released).size,2,'Each independent proof releases its own exact read lease');
 }finally{events?.release();await recovery.release();}
 const after=api.allocationLedger.snapshot();for(const key of ['cpuBytes','handles','activeRecords','unusedHandles'])assert.equal(after[key],before[key],key+' returns to its actual diagnostic baseline');
});
