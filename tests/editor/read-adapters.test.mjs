import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setup,pair,call,cookieFrom,readHeaders,mutationHeaders,rootFor,command} from '../protocol/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {largeTransaction} from '../protocol/fixtures.mjs';
const bootstrap=async(server,cookie)=>call(server.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:server.origin,Cookie:cookie},body:{protocolVersion:1,pairingToken:new URL(server.issuePairingURL()).hash.slice(9)}});

test('text-content cleanup rejection releases its stream slot without suppressing the error or relaxing the cap', {timeout:10000,concurrency:false}, async()=>{
 const {EventEmitter}=await import('node:events');
 const {ProtocolRoutes}=await import('../../dist/local/server/protocol.js');
 const {ProtocolError}=await import('../../dist/local/server/errors.js');
 const {newDraft}=await import('../../dist/local/src/request/family.js');
 const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
 // Exercise the actual route, typed draft reader and stream ownership with a
 // controlled writer rejection. This does not simulate worker queue pressure.
 const bytes=Buffer.from('Exact retained text'),ref={hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.length),mediaType:'text/plain'};
 const draftBytes=Buffer.from(JSON.stringify(newDraft(ref))),blob={hash:'sha256:'+createHash('sha256').update(draftBytes).digest('hex'),byteLength:String(draftBytes.length),mediaType:'application/json'};
 const draft={id:'request_cleanup',kind:'request',generation:'1',assetId:'draft_asset'};
 const drops=[],pending=[];let notifyDrop,opened=0;
 const writer={
  uiRead:async()=>({drafts:[draft]}),
  assetProjection:async id=>{assert.equal(id,draft.assetId);return {asset:{blob}};},
  consumeMetadata:async(value,consume)=>{assert.deepEqual(value,blob);return consume(draftBytes);},
  openTextContent:async value=>{assert.deepEqual(value,ref);return 'text_'+(++opened);},
  content:async(_handle,offset,length)=>bytes.subarray(Number(offset),Number(offset)+length),
  releaseResourceBytes(){},
  dropContent(handle){const gate=defer(),notify=notifyDrop;notifyDrop=undefined;const drop={handle,...gate};drops.push(drop);assert.equal(typeof notify,'function','unexpected content cleanup');notify(drop);return gate.promise;},
 };
 const now=Date.now(),session={clientId:'client_1',cookieHash:'a'.repeat(64),expires:now+3600000,idle:now+3600000};
 const routes=new ProtocolRoutes(writer,()=>now),path='/api/v1/ui/session_1/request',route=routes.match(path);
 assert.equal(route.kind,'request-draft-view');
 const params=new URLSearchParams({draftId:draft.id,generation:draft.generation,content:'1'});
 const invoke=()=>{
  const response=Object.assign(new EventEmitter(),{
   destroyed:false,closed:false,writableFinished:false,chunks:[],
   writeHead(status,headers){this.status=status;this.headers=headers;},
   write(chunk,callback){this.chunks.push(Buffer.from(chunk));callback();return true;},
   end(){this.writableFinished=true;this.emit('finish');},
  });
  const settled=routes.handle({method:'GET',url:path},response,route,params,()=>session,async()=>{}).then(()=>null,error=>error);
  pending.push(settled);return {response,settled};
 };
 const hold=async()=>{
  assert.equal(notifyDrop,undefined);const entered=defer();notifyDrop=entered.resolve;const request=invoke();
  const drop=await Promise.race([entered.promise,request.settled.then(error=>{throw error??Error('Route returned before content cleanup');})]);
  assert.equal(request.response.status,200);assert.equal(request.response.writableFinished,true);
  assert.deepEqual(Buffer.concat(request.response.chunks),bytes);assert.equal(request.response.headers.ETag,'"'+ref.hash+'"');
  return {...request,drop};
 };
 try{
  const held=[];for(let i=0;i<16;i++)held.push(await hold());
  assert.equal(opened,16);assert.equal(routes.streams,16,'unfinished cleanup still owns all sixteen slots');
  const blocked=invoke(),busy=await blocked.settled;
  assert.equal(busy.code,'LOCAL_BUSY');assert.equal(busy.status,429);assert.equal(busy.retry,'read-or-transfer');
  assert.equal(blocked.response.status,undefined);assert.equal(opened,16);assert.equal(drops.length,16);
  const cleanupError=new ProtocolError('SERVER_UNAVAILABLE',undefined,'read-or-transfer');
  held[0].drop.reject(cleanupError);assert.equal(await held[0].settled,cleanupError,'the exact cleanup rejection survives route handling');
  assert.equal(routes.streams,15,'a rejected cleanup must release exactly its own HTTP slot');
  const replacement=await hold();assert.equal(routes.streams,16);assert.equal(opened,17);
  replacement.drop.resolve();assert.equal(await replacement.settled,null);assert.equal(routes.streams,15);
  for(const request of held.slice(1)){request.drop.reject(cleanupError);assert.equal(await request.settled,cleanupError);}
  assert.equal(routes.streams,0);
  const healthy=await hold();assert.equal(routes.streams,1);healthy.drop.resolve();assert.equal(await healthy.settled,null);assert.equal(routes.streams,0);
  assert.equal(opened,18);assert.equal(drops.length,18);assert.equal(new Set(drops.map(drop=>drop.handle)).size,18,'each opened handle is dropped exactly once');
 }finally{for(const drop of drops)drop.resolve();await Promise.all(pending);}
});

test('exact accepted result remains readable after snapshot advancement, restart and renewal; read leases never extend authority',async t=>{
 let now=Date.now();const f=await setup(t,{now:()=>now}),c=f.command();const before=await f.post('/api/v1/commands',c);assert.equal(before.json.receipt.status,'accepted');
 for(let i=1;i<251;i++)assert.equal((await f.post('/api/v1/commands',f.command({expectedDocumentRevision:String(i),body:{type:'SaveCheckpoint',name:'snapshot '+i}}))).status,200);
 // Retained fail-before oracle: the former result recovery path cannot read this old receipt.
 assert.equal((await f.read('/api/v1/events?after=0')).json.error.code,'CURSOR_GAP');
 const page=(await f.read('/api/v1/commands/'+c.command.commandId+'/result')).json;assert.equal(page.batches[0].events[0].commandId,c.command.commandId);assert.equal(page.recovery.highWater,'1');assert.equal(page.nextCursor,'1');
 const original=await f.read('/api/v1/commands/'+c.command.commandId+'/original');assert.equal(original.text,JSON.stringify(c));
 const unknown=await f.read('/api/v1/commands/unadmitted/result');assert.equal(unknown.status,404);assert.equal(unknown.json.kind,'unknown');
 const bad=f.command({expectedDocumentRevision:'0',body:{type:'SaveCheckpoint',name:'stale'}});const rejected=await f.post('/api/v1/commands',bad);assert.equal(rejected.json.receipt.status,'rejected');assert.deepEqual((await f.read('/api/v1/commands/'+bad.command.commandId+'/result')).json,rejected.json);
 const other=await pair(f.server);for(const suffix of ['result','original'])assert.equal((await call(f.server.origin,'/api/v1/commands/'+c.command.commandId+'/'+suffix,{headers:readHeaders(cookieFrom(other))})).status,403);
 f.paired=await f.post('/api/v1/session/renew',{protocolVersion:1});assert.equal((await f.read('/api/v1/events?after=1&recoveryId='+page.recovery.recoveryId)).status,410);
 const fresh=(await f.read('/api/v1/commands/'+c.command.commandId+'/result')).json;now+=29*60*1000;await f.read('/api/v1/session');now+=2*60*1000;assert.equal((await f.read('/api/v1/events?after=1&recoveryId='+fresh.recovery.recoveryId)).status,410);
 const cookie=cookieFrom(f.paired);await f.server.close();const server=await startLocalServer({root:f.root});t.after(()=>server.close());const bound=await bootstrap(server,cookie);assert.equal(bound.json.clientId,c.command.clientId);
 const read=p=>call(server.origin,p,{headers:readHeaders(cookieFrom(bound))});assert.deepEqual((await read('/api/v1/commands/'+c.command.commandId)).json,before.json);assert.equal((await read('/api/v1/commands/'+c.command.commandId+'/result')).json.batches[0].events[0].commandId,c.command.commandId);
 assert.equal((await read('/api/v1/documents/document_1')).json.highWater,'251');
});

test('known referenced multi-event command is bounded, byte exact and session leased',async t=>{
 const root=await rootFor(t),fixture=await largeTransaction(root,80),cookie=randomBytes(32).toString('base64url'),w=await openWriter({root});await w.rememberClient(createHash('sha256').update(cookie).digest('hex'),'client_1',Date.now()+43200000);await w.close();
 const server=await startLocalServer({root});t.after(()=>server.close());const paired=await bootstrap(server,'ie_session='+cookie);const read=p=>call(server.origin,p,{headers:readHeaders(cookieFrom(paired))});
 // Bind via the fixture's private persisted client only; unrelated pairing is not authority.
 const result=await read('/api/v1/commands/'+fixture.commandId+'/result');assert.equal(result.status,200,result.text);const page=result.json,batch=page.batches[0];assert.equal(batch.kind,'transaction-ref');assert(Buffer.byteLength(result.text)<=65536);
 const bytes=await read(batch.content.url);assert.equal(bytes.status,200);assert.equal('sha256:'+createHash('sha256').update(bytes.text).digest('hex'),batch.content.blob.hash);const rows=bytes.text.trimEnd().split('\n').map(JSON.parse);assert.equal(rows.length,80);assert(rows.every(r=>r.commandId===fixture.commandId));assert.equal(rows[0].workspaceSeq,'2');assert.equal(rows.at(-1).workspaceSeq,'81');
});

test('UI metadata pages are owner scoped and never mutate checkpoint state; concurrent changes are visible by identity and sequence',async t=>{
 const f=await setup(t),body={documentId:null,tool:'select',viewport:{x:2,y:3,zoom:1.5},panels:{left:280,right:280,active:'layers'},selectedLayerIds:[]};
 for(let i=0;i<67;i++){const id='ui_'+String(i).padStart(3,'0');assert.equal((await f.post('/api/v1/ui/'+id,{protocolVersion:1,requestId:randomUUID(),sessionId:id,expectedUISeq:'0',body:{type:'SetPreferences',preferences:body}})).json.status,'accepted');}
 const a=await f.read('/api/v1/ui');assert.equal(a.json.items.length,64);assert(a.json.next);assert(Buffer.byteLength(a.text)<65536);assert(a.json.items.every(x=>Object.keys(x).sort().join(',')==='documentId,sessionId,uiSeq'));
 const other=await pair(f.server);assert.deepEqual((await call(f.server.origin,'/api/v1/ui',{headers:readHeaders(cookieFrom(other))})).json.items,[]);assert.equal((await call(f.server.origin,'/api/v1/ui?cursor='+a.json.next,{headers:readHeaders(cookieFrom(other))})).status,403);assert.equal((await call(f.server.origin,'/api/v1/ui',{headers:{'X-App-Client':'LP-1','Sec-Fetch-Site':'same-origin'}})).status,401);
 const b=(await f.read('/api/v1/ui?cursor='+a.json.next)).json;assert.equal(b.items.length,3);assert.equal(b.next,null);
 const id=a.json.items[0].sessionId;await f.post('/api/v1/ui/'+id,{protocolVersion:1,requestId:randomUUID(),sessionId:id,expectedUISeq:'1',body:{type:'SetPreferences',preferences:{...body,viewport:{...body.viewport,x:4}}}});assert.equal((await f.read('/api/v1/ui/'+id)).json.uiSeq,'2');assert.equal(a.json.items[0].uiSeq,'1');
 f.paired=await f.post('/api/v1/session/renew',{protocolVersion:1});assert.equal((await f.read('/api/v1/ui?cursor='+a.json.next)).status,410);
 assert.equal((await f.read('/api/v1/events?after=0')).json.recovery.highWater,'0');
});

test('pending owner pages preserve exact original bytes and operation identity across terminal races',async t=>{
 const {original}=await import('../raster/helpers.mjs'),{exchange}=await import('../session/helpers.mjs');
 const f=await setup(t),asset=await original(f,'white.png'),holds=[];t.after(()=>holds.forEach(h=>h.request.destroy()));
 for(let i=0;i<2;i++){
  const stage={protocolVersion:1,stagingId:randomUUID(),purpose:'caption',expectedBytes:'1',sha256:'sha256:'+createHash('sha256').update('x').digest('hex'),mediaType:'text/plain'};assert.equal((await f.post('/api/v1/assets/staging',stage)).status,201);
  const h=exchange(f.server.origin,'/api/v1/assets/staging/'+stage.stagingId,{method:'PUT',defer:true,headers:{...mutationHeaders(f.server,f.paired),'Content-Type':'application/octet-stream','Content-Length':'1','Upload-Offset':'0'}});h.response.catch(()=>{});h.request.flushHeaders();holds.push(h);
 }
 // This wait only lets the real HTTP transfer reserve its documented IO slot.
 await new Promise(r=>setTimeout(r,20));const requests=[];
 for(let i=0;i<33;i++){const c=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PrepareRaster',assetId:asset.id}}),wire=JSON.stringify(c,null,2);const result=await call(f.server.origin,'/api/v1/commands',{method:'POST',raw:Buffer.from(wire),headers:mutationHeaders(f.server,f.paired)});assert.equal(result.status,202);requests.push({c,wire,operationId:result.json.operationId});}
 const first=await f.read('/api/v1/commands/pending');assert.equal(first.json.items.length,32);assert(first.json.next);const second=await f.read('/api/v1/commands/pending?cursor='+first.json.next);assert.equal(second.json.items.length,1);assert.equal(second.json.next,null);const all=[...first.json.items,...second.json.items];
 for(const item of all){const expected=requests.find(x=>x.c.command.commandId===item.commandId);assert.equal(item.operationId,expected.operationId);assert.equal((await f.read('/api/v1/commands/'+item.commandId+'/original')).text,expected.wire);}
 const unrelated=await pair(f.server);assert.deepEqual((await call(f.server.origin,'/api/v1/commands/pending',{headers:readHeaders(cookieFrom(unrelated))})).json.items,[]);assert.equal((await call(f.server.origin,'/api/v1/commands/pending?cursor='+first.json.next,{headers:readHeaders(cookieFrom(unrelated))})).status,403);
 for(const h of holds)h.request.end('x');await Promise.all(holds.map(h=>h.response));const target=requests[0];let state;
 for(let i=0;i<1000;i++){state=await f.read('/api/v1/commands/'+target.c.command.commandId);if(state.status===200)break;await new Promise(r=>setTimeout(r,5));}assert.equal(state.json.receipt.status,'accepted');assert.equal((await f.read('/api/v1/commands/'+target.c.command.commandId+'/original')).text,target.wire);
 assert.deepEqual((await call(f.server.origin,'/api/v1/commands',{method:'POST',raw:Buffer.from(target.wire),headers:mutationHeaders(f.server,f.paired)})).json,state.json);
});

test('document HEAD exposes canonical revision without projection/content allocation and retains GET authorization',async t=>{
 const {ProtocolRoutes}=await import('../../dist/local/server/protocol.js');const originalHandle=ProtocolRoutes.prototype.handle;let counts;
 ProtocolRoutes.prototype.handle=async function(...args){try{return await originalHandle.apply(this,args);}finally{counts={content:this.content.size,leases:this.leases.size};}};t.after(()=>{ProtocolRoutes.prototype.handle=originalHandle;});
 let now=Date.now();const f=await setup(t,{now:()=>now});await f.post('/api/v1/commands',f.command());const db=new DatabaseSync(join(f.root,'metadata.sqlite'));const original=db.prepare("SELECT json FROM documents WHERE id='document_1'").get().json;
 // Disposable metadata stress fixture: isolate read behavior and >2^53 revision
 // parsing without pretending to create 9 quadrillion real editing operations.
 const large={...JSON.parse(original),revision:'9007199254740995',orderedLayerIds:Array.from({length:2000},()=>randomUUID())};db.prepare("UPDATE documents SET json=? WHERE id='document_1'").run(canonical(large));t.after(()=>{db.prepare("UPDATE documents SET json=? WHERE id='document_1'").run(original);db.close();});
 // This intentionally invalid full Document is only a scalar-read stress case.
 // Valid large GET behavior has its separate explicitly validated fixture.
 const first={...counts};assert.equal(first.content,0);
 const head=path=>call(f.server.origin,path,{method:'HEAD',headers:readHeaders(cookieFrom(f.paired))});
 for(let i=0;i<140;i++){const r=await head('/api/v1/documents/document_1');assert.equal(r.status,200);assert.equal(r.text,'');assert.equal(r.headers['x-app-entity-version'],large.revision);assert.equal(r.headers['cache-control'],'no-store');assert.deepEqual(counts,first);}
 db.prepare("UPDATE documents SET json=? WHERE id='document_1'").run(original);const get=await f.read('/api/v1/documents/document_1');assert.equal(get.status,200);assert.deepEqual(get.json.projection.value,JSON.parse(original));assert.deepEqual(counts,first);
 for(const [path,status] of [['/api/v1/documents/unknown',404],['/api/v1/documents/document_1?x=1',400]]){const r=await head(path);assert.equal(r.status,status);assert.equal(r.text,'');assert.equal(r.headers['x-app-entity-version'],undefined);}
 const anonymous=await call(f.server.origin,'/api/v1/documents/document_1',{method:'HEAD',headers:{'X-App-Client':'LP-1','Sec-Fetch-Site':'same-origin'}});assert.equal(anonymous.status,401);assert.equal(anonymous.text,'');
 const foreign=await call(f.server.origin,'/api/v1/documents/document_1',{method:'HEAD',headers:{...readHeaders(cookieFrom(f.paired)),Origin:'https://foreign.invalid'}});assert.equal(foreign.status,403);assert.equal(foreign.text,'');
 const method=await f.post('/api/v1/documents/document_1',{});assert.equal(method.status,405);assert.equal(method.headers.allow,'GET, HEAD');
 const other=await pair(f.server);const otherHeaders=readHeaders(cookieFrom(other));assert.equal((await call(f.server.origin,'/api/v1/documents/document_1',{method:'HEAD',headers:otherHeaders})).status,(await call(f.server.origin,'/api/v1/documents/document_1',{headers:otherHeaders})).status);
 now+=31*60*1000;const expired=await call(f.server.origin,'/api/v1/documents/document_1',{method:'HEAD',headers:otherHeaders});assert.equal(expired.status,401);assert.equal(expired.text,'');assert.equal(expired.headers['x-app-entity-version'],undefined);
 t.diagnostic(JSON.stringify({largeProjectionBytes:Buffer.byteLength(canonical(large)),revision:large.revision,headCount:140,first,lastAfterHEAD:first,afterOrdinaryGET:counts,fixture:'disposable invalid full metadata for scalar HEAD only; not domain closure/workload qualification. Original GET413 attempts48/51/52 retained.'}));
});
