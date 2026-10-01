import nodeTest,{afterEach} from 'node:test';
const test=(name,run)=>nodeTest(name,{timeout:5000},run);
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';

// Real EditorClient command, delivery, and cancellation methods. The journal
// commit, authenticated transport, and projection are isolated boundary doubles.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const source=(await transformWithOxc(await readFile('src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const resources=data((await transformWithOxc(await readFile('src/state/document-lifecycle.ts','utf8'),'document-lifecycle.ts')).code);
const allocations=data((await transformWithOxc(await readFile('src/observability/allocations.ts','utf8'),'allocations.ts')).code);
const control=data((await transformWithOxc(await readFile('src/state/control-memory.ts','utf8'),'control-memory.ts')).code.replace("'../observability/allocations.js'",JSON.stringify(allocations)).replace('"../observability/allocations.js"',JSON.stringify(allocations)));
const stub=`import {reserveCommandWire} from ${JSON.stringify(control)};
import {allocationLedger} from ${JSON.stringify(allocations)};
import {DocumentResources} from ${JSON.stringify(resources)};
const createValueModel=initial=>{let value=initial;return {value:{get:()=>value},set:next=>{value=next;}};};
const EMPTY_EXPECTED_VERSIONS={hash:'sha256:'+'0'.repeat(64),byteLength:'0',mediaType:'application/json'};
const browserPhases={recorder:{start:()=>({end(){}})},reset(){},adoptionFailed(){}};`;
const {EditorClient}=await import(data(stub+source));
const clients=[];
afterEach(()=>{for(const client of clients.splice(0))client.pendingMetadata?.release();});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};
const observe=promise=>promise.then(value=>({value}),error=>({error}));
// Expose failures before the boundary instead of waiting for a signal that can no longer arrive.
const before=(signal,work)=>Promise.race([signal,work.outcome.then(result=>{throw result.error??Error('Export completed before the expected boundary');})]);
const response=value=>({ok:true,status:200,json:async()=>value});
const rejected=id=>({status:'rejected',commandId:id,code:'INVALID_INPUT',currentRevision:'3',details:{hash:'sha256:'+'1'.repeat(64),byteLength:'2',mediaType:'application/json'}});
const accepted=id=>({status:'accepted',commandId:id,fromSeq:'1',toSeq:'1',documentRevision:'3',transactionId:'transaction'});
function fixture(){
 const requests=[],rows=new Map(),callbacks=[],journalGate=deferred(),postGate=deferred(),drain=deferred(),terminal=deferred(),submitted=deferred(),cancelEntered=deferred();
 let identity='original-owner',firstPut=true,requestId,customCancel;
 const session={identity:()=>identity,transport:async(path,init={})=>{
  requests.push({path,init,identity});
  if(path==='/api/v1/commands'&&init.method==='POST'){
   requestId=JSON.parse(init.body).command.commandId;submitted.resolve(requestId);return await postGate.promise;
  }
  if(path.endsWith('/cancel-export')){
   cancelEntered.resolve();if(customCancel)return customCancel(path,init);
   await drain.promise;const receipt=rejected(requestId);terminal.resolve({kind:'receipt',receipt,rejectionDetails:{kind:'inline',value:{code:'EXPORT_CANCELED'}}});
   return response({protocolVersion:1,commandId:requestId,status:'canceled',receipt});
  }
  if(path==='/api/v1/commands/'+requestId)return response(await terminal.promise);
  throw Error('Unexpected transport '+path);
 }};
 const client=new EditorClient(session);clients.push(client);client.owner='original-owner';client.ui={sessionId:'original-session'};
 client.journal={async put(key,value){if(firstPut){firstPut=false;await journalGate.promise;}rows.set(key,structuredClone(value));},async scan(prefix,visit){for(const [key,value] of rows)if(key.startsWith(prefix)&&visit(structuredClone(value))===false)break;}};
 const document={id:'frozen-document',revision:'3',historyHead:'history-3'},options={format:'png',resize:null,matte:null,quality:null,scope:{kind:'visible-document'}};
 client.patch({ready:true,document,download:{path:'previous-download'}});
 return {client,session,requests,rows,callbacks,journalGate,postGate,drain,terminal,submitted,cancelEntered,document,options,
  owner:()=>({session,identity:'original-owner'}),identity(value){identity=value;},cancel(value){customCancel=value;},
  start(callback){const promise=client.prepareExport(options,document,id=>{callbacks.push(id);callback?.(id);});return {promise,outcome:observe(promise)};},
  admit(){postGate.resolve(response({kind:'pending',phase:'working'}));},
 };
}

test('journaled ID is exposed only after persistence, and cancellation follows admission but precedes encoder completion',async()=>{
 const f=fixture();let cancellation,settled=false;const exportWork=f.start(id=>{assert(f.rows.has('command:'+id));cancellation=f.client.cancelExport(id,f.owner()).then(value=>{settled=true;return value;});});
 await flush();assert.deepEqual(f.callbacks,[]);assert.deepEqual(f.requests,[]);
 f.journalGate.resolve();const id=await before(f.submitted.promise,exportWork);await flush();assert.deepEqual(f.callbacks,[id]);assert.equal(f.requests.length,1);assert.equal(settled,false);
 const command=JSON.parse(f.requests[0].init.body).command;assert.equal(command.documentId,f.document.id);assert.equal(command.expectedDocumentRevision,'3');assert.deepEqual(command.body,{type:'ExportDocument',historyHead:'history-3',options:f.options});
 f.admit();await before(f.cancelEntered.promise,exportWork);await flush();assert.equal(settled,false);assert.equal(f.requests.filter(row=>row.path.endsWith('/cancel-export')).length,1);
 f.drain.resolve();const result=await cancellation,original=await exportWork.outcome;
 assert.equal(result.status,'canceled');assert.equal(result.commandId,id);assert.match(original.error?.message??'',/INVALID_INPUT.*EXPORT_CANCELED/);
 assert.equal(f.rows.get('command:'+id).result.receipt.commandId,id);assert.equal(f.rows.get('command:'+id).result.receipt.status,'rejected');assert.equal(f.client.exportAdmissions.size,0);
 assert.equal(f.requests.filter(row=>row.path==='/api/v1/commands').length,1);assert.equal(f.client.view.download.path,'previous-download');
});

test('journal failure exposes no cancellable ID and sends no original command',async()=>{
 const f=fixture(),work=f.start();f.journalGate.reject(Error('JOURNAL_QUOTA'));assert.match((await work.outcome).error?.message??'',/JOURNAL_QUOTA/);assert.deepEqual(f.callbacks,[]);assert.deepEqual(f.requests,[]);assert.equal(f.client.exportAdmissions.size,0);
});

test('an uncertain original transport keeps cancellation uncertain if the exact ID is not admitted',async()=>{
 const f=fixture();let cancellation;f.cancel(async()=>({ok:false,status:404,json:async()=>({error:{code:'NOT_FOUND'}})}));
 const work=f.start(id=>{cancellation=observe(f.client.cancelExport(id,f.owner()));});f.journalGate.resolve();const id=await before(f.submitted.promise,work);assert.equal(f.requests.length,1);
 f.postGate.reject(Error('Failed to fetch'));assert.match((await work.outcome).error?.message??'',/Failed to fetch/);assert.match((await cancellation).error?.message??'',/NOT_FOUND/);
 assert.equal(f.requests.filter(row=>row.path.endsWith('/cancel-export')).length,1);assert(f.rows.has('command:'+id));assert.equal(f.rows.get('command:'+id).result,undefined);assert.equal(f.client.exportAdmissions.size,0);
});

for(const boundary of ['identity','session'])test('replacement '+boundary+' while waiting for admission cannot send cancellation under new authority',async()=>{
 const f=fixture();let cancellation;const work=f.start(id=>{cancellation=observe(f.client.cancelExport(id,f.owner()));});f.journalGate.resolve();const id=await before(f.submitted.promise,work);
 if(boundary==='identity')f.identity('replacement-owner');else f.client.session={...f.session};
 f.admit();assert.match((await cancellation).error?.message??'',/EXPORT_CANCELLATION_OWNER_CHANGED/);assert.equal(f.requests.filter(row=>row.path.endsWith('/cancel-export')).length,0);
 f.terminal.resolve({kind:'receipt',receipt:rejected(id)});await work.outcome;assert.equal(f.client.exportAdmissions.size,0);
});

for(const boundary of ['null identity','different identity','different session'])test('already '+boundary+' refuses cancellation before transport',async()=>{
 const f=fixture();if(boundary==='null identity')f.identity(null);if(boundary==='different identity')f.identity('replacement');if(boundary==='different session')f.client.session={...f.session};
 await assert.rejects(f.client.cancelExport('known-command',f.owner()),/EXPORT_CANCELLATION_OWNER_CHANGED/);assert.deepEqual(f.requests,[]);
});

test('document release and readiness loss still allow cancellation by the original authenticated owner',async()=>{
 const f=fixture();let cancellation;const work=f.start(id=>{cancellation=observe(f.client.cancelExport(id,f.owner()));});f.journalGate.resolve();await before(f.submitted.promise,work);f.client.patch({ready:false,document:null});f.admit();await f.cancelEntered.promise;f.drain.resolve();assert.equal((await cancellation).value.status,'canceled');await work.outcome;
});

test('late cancellation returns the existing completed receipt without submitting another command',async()=>{
 const f=fixture(),id='retained-command',receipt=accepted(id);f.cancel(async()=>response({protocolVersion:1,commandId:id,status:'completed',receipt}));const result=await f.client.cancelExport(id,f.owner());
 assert.deepEqual(result,{protocolVersion:1,commandId:id,status:'completed',receipt});assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/api/v1/commands/'+id+'/cancel-export');assert.equal(f.requests[0].init.method,'POST');assert.deepEqual(JSON.parse(f.requests[0].init.body),{protocolVersion:1});assert.equal(f.client.view.download.path,'previous-download');
});

test('cancellation reply after an owner replacement cannot report success to the replacement UI',async()=>{
 const f=fixture(),reply=deferred(),id='retained-command';f.cancel(()=>reply.promise);const work=observe(f.client.cancelExport(id,f.owner()));await f.cancelEntered.promise;f.identity('replacement-owner');reply.resolve(response({protocolVersion:1,commandId:id,status:'completed',receipt:accepted(id)}));assert.match((await work).error?.message??'',/EXPORT_CANCELLATION_OWNER_CHANGED/);
});

for(const defect of ['version','command ID','receipt ID','status','missing receipt','accepted canceled','unrelated rejection'])test('malformed cancellation '+defect+' cannot claim a stopped export',async()=>{
 const f=fixture(),id='retained-command',value={protocolVersion:1,commandId:id,status:'canceled',receipt:rejected(id)};
 if(defect==='version')value.protocolVersion=2;if(defect==='command ID')value.commandId='other';if(defect==='receipt ID')value.receipt.commandId='other';if(defect==='status')value.status='unknown';if(defect==='missing receipt')delete value.receipt;if(defect==='accepted canceled')value.receipt=accepted(id);if(defect==='unrelated rejection')value.receipt.code='CAPACITY';
 f.cancel(async()=>response(value));await assert.rejects(f.client.cancelExport(id,f.owner()),/EXPORT_CANCELLATION_UNCONFIRMED/);
});

test('transport errors during cancellation are surfaced without manufacturing a success receipt or retry',async()=>{
 const f=fixture();f.cancel(async()=>{throw Error('Failed to fetch');});await assert.rejects(f.client.cancelExport('retained-command',f.owner()),/Failed to fetch/);assert.equal(f.requests.length,1);assert.equal(f.client.exportAdmissions.size,0);
});
