import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
import {isolatedDiagnosticModules,allocationDeltaSnapshot} from '../owned-preview-module.mjs';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {reduceDocument} from '../../dist/local/src/state/projection.js';
import {fixture,snapshot,context,digest,ref} from '../protocol/projection9-fixtures.mjs';
const root=process.env.IE_DISPLAY_SOURCE_ROOT?process.env.IE_DISPLAY_SOURCE_ROOT.replace(/\/$/,'')+'/':'',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');let serial=0;
async function module(path,replacements={},identity=''){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code+'\n// '+identity);}
// Capture the fixed diagnostic baseline once before recovery work; admission
// continues to use the unchanged actual ledger and its absolute limits.
async function runtime(){const id=String(++serial),{allocationsURL:allocations}=await isolatedDiagnosticModules(),memory=await module(root+'src/observability/recovery-memory.ts',{'./allocations.js':allocations},id),imports={'../observability/recovery-memory.js':memory,'./recovery-cache.js':data('export class RecoveryCache {}')};for(const name of ['json','sha256','validate','projection-schema'])imports['../protocol/'+name+'.js']=pathToFileURL(resolve('dist/local/src/protocol/'+name+'.js')).href;const ledger=await import(allocations);return {...ledger,...await import(await module(root+'src/state/recovery-client.ts',imports,id)),snapshot:allocationDeltaSnapshot(ledger.allocationLedger)};}
function cache(initialCursor='0'){
 let published={generation:'old',cursor:initialCursor,epoch:'1'};const generations=new Map([['old',new Map()]]),calls=[],rows=g=>{if(!generations.has(g))generations.set(g,new Map());return generations.get(g);};
 return {calls,generations,async published(){return {...published};},async clone(from,to){calls.push(['clone',from,to]);generations.set(to,structuredClone(rows(from)));},async put(g,type,id,value){calls.push(['put',g,type,id]);rows(g).set(type+':'+id,structuredClone(value));},async value(g,type,id){return rows(g).get(type+':'+id);},async *rows(g,type){for(const [key,value]of rows(g))if(key.startsWith(type+':'))yield {id:key.slice(type.length+1),value};},async discard(g){calls.push(['discard',g]);generations.delete(g);},async apply(g,event){if(['DocumentCreated','CheckpointSaved','ImageEdited','HistoryNavigated','BundleImported'].includes(event.type)){const next=reduceDocument(await this.value(g,'document',event.documentId)??null,event);await this.put(g,'document',next.id,next);if(event.type==='DocumentCreated'||event.type==='ImageEdited')await this.put(g,'history',event.payload.history.id,event.payload.history);if(event.type==='CheckpointSaved')await this.put(g,'checkpoint',event.payload.checkpoint.id,event.payload.checkpoint);}await this.put(g,'event',event.eventId,event.workspaceSeq);},async applyEvents(g,stage,count){for(let i=0n;i<count;i++)await this.apply(g,await this.value(stage,'staged',String(i)));},async publish(next,old){assert.deepEqual(old,published);calls.push(['publish',next]);published={...next};}};
}
const page=(recovery,batches=[],cursor=recovery.highWater)=>({protocolVersion:1,kind:'batches',recovery,batches,nextCursor:cursor,more:cursor!==recovery.highWater});
const inline=(events)=>({kind:'inline',transactionId:events[0].transactionId,fromSeq:events[0].workspaceSeq,toSeq:events.at(-1).workspaceSeq,events});
const bytesResponse=(bytes,blob)=>new Response(bytes,{headers:{etag:'"'+blob.hash+'"','content-length':blob.byteLength,'content-type':'application/x-ndjson'}});
function snapshotTransport(s,tail=s.checkpoint){
 s.descriptor.metadataUrl='/api/v1/snapshots/snapshot?recoveryId=recovery';const recovery=s.descriptor.recovery;
 return async path=>{
  if(path==='/api/v1/events?after=0')return Response.json({error:{code:'CURSOR_GAP',details:{kind:'inline',value:{kind:'cursor-gap',requestedAfter:'0',earliestAvailable:'1',snapshot:s.descriptor}}}},{status:410});
  if(path===s.descriptor.metadataUrl)return Response.json(s.descriptor);
  if(path===s.descriptor.content.url)return bytesResponse(s.bytes,s.descriptor.content.blob);
  if(path==='/api/v1/events?after=1&recoveryId=recovery')return Response.json(page(recovery,[inline([tail])]));
  if(path==='/api/v1/events?after=2&recoveryId=recovery')return Response.json(page(recovery));
  throw Error('Unexpected recovery path '+path);
 };
}
function unchanged(c){assert.deepEqual(c.calls.filter(x=>x[0]==='publish'),[]);assert.deepEqual(c.generations.get('old'),new Map());assert.equal(c.generations.size,1);}
for(const schema of [2,3,4,5,6,7,8,9])test('real consumer restores snapshot'+schema+' under live9 and publishes exact snapshot plus tail',async()=>{
 const r=await runtime(),c=cache(),s=snapshot(schema,schema===9),client=new r.RecoveryConsumer(c,snapshotTransport(s));assert.equal(await client.recover(),'2');const published=await c.published();assert.deepEqual(await c.value(published.generation,'document',s.document.id),{...s.document,revision:'2',checkpoint:'checkpoint'});assert.deepEqual(await c.value(published.generation,'history','history'),s.history);assert.equal(c.calls.filter(x=>x[0]==='publish').length,1);assert.equal(r.snapshot().activeRecords,0);
});
for(const schema of [2,3,4,5,6,7,8,10])test('real consumer rejects snapshot'+schema+' containing LP9 document metadata before publication',async()=>{
 const r=await runtime(),c=cache(),client=new r.RecoveryConsumer(c,snapshotTransport(snapshot(schema,true)));await assert.rejects(client.recover());unchanged(c);assert.equal(r.snapshot().activeRecords,0);
});
for(const schema of [2,3,4,5,6,7,8,9])test('real consumer validates inline tail with context'+schema,async()=>{
 const r=await runtime(),c=cache(),f=fixture(schema===9),recovery=context(schema,'1'),client=new r.RecoveryConsumer(c,async path=>Response.json(page(recovery,path==='/api/v1/events?after=0'?[inline([f.created])]:[])));await client.recover();assert.deepEqual(await c.value((await c.published()).generation,'document',f.document.id),f.document);assert.equal(r.snapshot().activeRecords,0);
});
for(const schema of [8,10])test('real consumer refuses incompatible tail context'+schema+' without publishing',async()=>{
 const r=await runtime(),c=cache(),recovery=context(schema,'1'),client=new r.RecoveryConsumer(c,async()=>Response.json(page(recovery,[inline([fixture(true).created])])));await assert.rejects(client.recover());unchanged(c);assert.equal(r.snapshot().activeRecords,0);
});
const part=(events,schema,partIndex=0,partCount=1)=>({protocolVersion:1,kind:'batch-part',...schema===undefined?{}:{projectionSchema:schema},transactionId:'transaction',fromSeq:'1',toSeq:'2',partIndex,partCount,events});
const frame=(body,offered)=>`${offered===undefined?'':'id: '+offered+'\n'}data: ${canonical(body)}\n\n`;
async function streamCase(frames,initialCursor='0'){
 const r=await runtime(),c=cache(initialCursor),client=new r.RecoveryConsumer(c,async()=>new Response(frames,{headers:{'content-type':'text/event-stream'}}));return {r,c,client};
}
for(const schema of [undefined,2,3,4,5,6,7,8,9])test('inline SSE '+String(schema)+' preserves accepted old framing and exact new9 document values',async()=>{
 const f=fixture(schema===9),x=await streamCase(frame(part([f.created,f.checkpoint],schema),'2'));await x.client.consumeStream();assert.equal((await x.c.published()).cursor,'2');assert.deepEqual(await x.c.value((await x.c.published()).generation,'document',f.document.id),{...f.document,revision:'2',checkpoint:'checkpoint'});assert.equal(x.r.snapshot().activeRecords,0);
});
for(const schema of [undefined,8,10])test('inline SSE '+String(schema)+' rejects new payload/future version before cloning or publication',async()=>{
 const f=fixture(true),x=await streamCase(frame(part([f.created,f.checkpoint],schema),'2'));await assert.rejects(x.client.consumeStream());unchanged(x.c);assert.equal(x.c.calls.some(call=>call[0]==='clone'||call[0]==='put'),false);assert.equal(x.r.snapshot().activeRecords,0);
});
for(const versions of [[8,9],[9,8],[undefined,9],[9,undefined],[9,10]])test('multipart SSE forbids transaction version switch '+versions.join(' to '),async()=>{
 const f=fixture(),x=await streamCase(frame(part([f.created],versions[0],0,2))+frame(part([f.checkpoint],versions[1],1,2),'2'));await assert.rejects(x.client.consumeStream());unchanged(x.c);assert.equal(x.r.snapshot().activeRecords,0);
});
test('duplicate-cursor SSE cannot bypass future or legacy payload version validation',async()=>{
 for(const schema of [8,10]){const f=fixture(true),x=await streamCase(frame(part([f.created,f.checkpoint],schema),'2'),'2');await assert.rejects(x.client.consumeStream());assert.deepEqual(await x.c.published(),{generation:'old',cursor:'2',epoch:'1'});unchanged(x.c);assert.equal(x.c.calls.length,0);assert.equal(x.r.snapshot().activeRecords,0);}
});
test('namespace rows use the lease schema exactly and preserve metadata before import publication',async()=>{
 for(const headerSchema of [8,9,10]){
  const r=await runtime(),c=cache(),f=fixture(true),recovery=context(9,'1'),event={...f.created,type:'BundleImported',payload:{namespaceId:'namespace',namespaceHash:digest('namespace'),source:ref('application/x-ideogram-project'),document:f.document}},s=snapshot(9,true),rows=[{kind:'header',namespaceId:'namespace',namespaceHash:event.payload.namespaceHash,eventId:event.eventId,workspaceSeq:'1',projectionSchema:headerSchema,entityCount:'2'},...s.rows.slice(1)],bytes=Buffer.from(rows.map(canonical).join('\n')+'\n'),content={...s.descriptor.content,encoding:'lp1-namespace-jsonl',blob:{hash:digest(bytes),byteLength:String(bytes.length),mediaType:'application/x-ndjson'}};
  const client=new r.RecoveryConsumer(c,async path=>{if(path.startsWith('/api/v1/events?'))return Response.json(page(recovery,path==='/api/v1/events?after=0'?[inline([event])]:[]));if(path.startsWith('/api/v1/namespace-events/'))return Response.json({protocolVersion:1,eventId:event.eventId,namespaceId:'namespace',namespaceHash:event.payload.namespaceHash,workspaceSeq:'1',content,recovery});if(path===content.url)return bytesResponse(bytes,content.blob);throw Error(path);});
  if(headerSchema===9){await client.recover();assert.deepEqual(await c.value((await c.published()).generation,'document',f.document.id),f.document);}else{await assert.rejects(client.recover());unchanged(c);}assert.equal(r.snapshot().activeRecords,0);
 }
});


test('snapshot9 cannot introduce new semantics through a legacy8 recovery lease',async()=>{
 const r=await runtime(),c=cache(),s=snapshot(9,true);s.descriptor.recovery.projectionSchema=8;const client=new r.RecoveryConsumer(c,snapshotTransport(s));await assert.rejects(client.recover());unchanged(c);assert.equal(c.calls.some(call=>call[0]==='put'),false);assert.equal(r.snapshot().activeRecords,0);
});


test('previously accepted snapshot8 under legacy2 lease keeps its exact old payload semantics',async()=>{
 const r=await runtime(),c=cache(),s=snapshot(8,false);s.descriptor.recovery.projectionSchema=2;const client=new r.RecoveryConsumer(c,snapshotTransport(s));assert.equal(await client.recover(),'2');assert.deepEqual(await c.value((await c.published()).generation,'document',s.document.id),{...s.document,revision:'2',checkpoint:'checkpoint'});assert.equal(r.snapshot().activeRecords,0);
});
