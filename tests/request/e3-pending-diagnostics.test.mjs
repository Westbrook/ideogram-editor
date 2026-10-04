// Pure fixture-diagnostic controls; no app import, backend, browser or qualification claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DIAGNOSTIC_LIMIT,readBoundedJSON,redactOwnedDiagnostics,writerFailureDiagnostic,shutdownDiagnostic,pendingDiagnosticObserver,capturePendingDiagnostic} from '../request-edits/pending-diagnostics.mjs';
const commandId='11111111-1111-4111-8111-111111111111',otherId='22222222-2222-4222-8222-222222222222',operation='AdoptReviewedCandidate';
const command={commandId,body:{type:operation}},request={commandId,operation};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'e3-pending-diagnostic-unit-')),db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE history_preparations(id TEXT PRIMARY KEY,canonical TEXT,phase TEXT); CREATE TABLE commands(id TEXT PRIMARY KEY,original BLOB,receipt TEXT)');
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 const store={root,db,histories:{resourceOwnership:()=>({running:true,paused:0,authorities:1})}};
 return {root,store,trigger:()=>writeFileSync(join(root,'e3-pending-request.json'),JSON.stringify(request)),
  pending:(phase='preparing',value=command)=>db.prepare('INSERT INTO history_preparations VALUES(?,?,?)').run(commandId,JSON.stringify({command:value}),phase),
  terminal:(status='accepted')=>db.prepare('INSERT INTO commands VALUES(?,?,?)').run(commandId,Buffer.from(JSON.stringify({command})),JSON.stringify({commandId,status})),
  output:join(root,'e3-pending-'+commandId+'.json')};
}
const raw=()=>Buffer.from(JSON.stringify({kind:'j19-owned-diagnostics-1',commandId,process:{rss:1234},history:[{operation,error:'CAPACITY'}],text:{reservedCPU:0},raster:{activeWorkers:1}}));

test('bounded JSON preserves actual complete UTF-8 bytes',t=>{const f=fixture(t),p=join(f.root,'input');writeFileSync(p,JSON.stringify({value:'é'}));assert.deepEqual(readBoundedJSON(p,32),{value:'é'});});
for(const [name,body]of [['oversized',' '.repeat(DIAGNOSTIC_LIMIT+1)],['empty',''],['malformed','{']])test('bounded JSON refuses '+name,t=>{const f=fixture(t),p=join(f.root,'input');writeFileSync(p,body);assert.throws(()=>readBoundedJSON(p));});
test('bounded JSON refuses symlink input',t=>{const f=fixture(t),p=join(f.root,'input');writeFileSync(p,'{}');symlinkSync(p,p+'.link');assert.throws(()=>readBoundedJSON(p+'.link'));});
test('bounded JSON rejects invalid read ceilings before opening',()=>{for(const limit of [0,-1,Infinity,DIAGNOSTIC_LIMIT+1])assert.throws(()=>readBoundedJSON('/unopened',limit),/E3_DIAGNOSTIC_LIMIT/);});
test('owned projection preserves numeric capacity and known state, redacts arbitrary strings and sensitive fields',()=>{
 const input={phase:'waiting-for-resources',error:'CAPACITY',processRSS:536870913,admitted:false,missing:null,message:'secret-message',stack:'secret-stack',token:'secret-token',prompt:'secret-prompt',nested:{unknown:'secret-value'}};
 const before=JSON.stringify(input),result=redactOwnedDiagnostics(input);
 assert.equal(result.value.processRSS,536870913);assert.equal(result.value.phase,'waiting-for-resources');assert.equal(result.value.error,'CAPACITY');assert.equal(result.value.admitted,false);assert.equal(result.value.missing,null);
 assert.equal(result.value.nested.unknown,'[redacted]');assert.equal(result.redacted,5);assert(!JSON.stringify(result).includes('secret'));assert.equal(JSON.stringify(input),before);
});
test('owned projection refuses excessive depth and array cardinality',()=>{assert.throws(()=>redactOwnedDiagnostics(Array(257).fill(0)),/E3_DIAGNOSTIC_STRUCTURE/);let nested=0;for(let i=0;i<18;i++)nested={nested};assert.throws(()=>redactOwnedDiagnostics(nested),/E3_DIAGNOSTIC_STRUCTURE/);});
test('shutdown projection retains actual known errors and static locations without raw stderr or credentials',()=>{
 const shutdown={exit:{code:1,signal:null},stderr:'AssertionError [ERR_ASSERTION]: private-prompt\n at file:///private/owner/tests/request-edits/observer-fixture.mjs:173:9\nTOKEN=private-grant\nhttps://secret.example/?credential=private-key\n at tests/private-secret.mjs:2:3\n'};
 const before=JSON.stringify(shutdown),result=shutdownDiagnostic(shutdown);
 assert.deepEqual(result.exit,{code:1,signal:null});assert.deepEqual(result.stderr.names,['AssertionError']);assert.deepEqual(result.stderr.codes,['ERR_ASSERTION']);assert.deepEqual(result.stderr.frames,[{path:'tests/request-edits/observer-fixture.mjs',line:173,column:9}]);
 assert(!JSON.stringify(result).includes('private-'));assert(!JSON.stringify(result).includes('secret.example'));assert.equal(JSON.stringify(shutdown),before);assert.equal(shutdownDiagnostic(undefined),null);
});
test('shutdown projection scans only its fixed prefix and bounds retained frames',()=>{
 const result=shutdownDiagnostic({stderr:(' at tests/request-edits/observer-fixture.mjs:1:2\n').repeat(400)+'\nCAPACITY'});
 assert.equal(result.stderr.scannedCharacters,16384);assert.equal(result.stderr.truncated,true);assert.equal(result.stderr.frames.length,32);assert.deepEqual(result.stderr.codes,[]);
});
for(const phase of ['preparing','waiting-for-resources'])test('captures exact original pending '+phase+' row once without modifying it',t=>{
 const f=fixture(t);f.pending(phase);f.trigger();let captures=0;const bytes=raw(),original=Buffer.from(bytes),observe=pendingDiagnosticObserver(f.store,(store,id)=>{assert.equal(store,f.store);assert.equal(id,commandId);captures++;return bytes;});
 observe();observe();const result=readBoundedJSON(f.output);assert.equal(result.kind,'e3-pending-diagnostic-1');assert.equal(result.commandId,commandId);assert.equal(result.phase,phase);assert.equal(result.terminalStatus,null);assert.equal(result.owned.value.history[0].error,'CAPACITY');assert.equal(result.owned.value.raster.activeWorkers,1);assert.equal(captures,1);assert.deepEqual(bytes,original);
 assert.equal(f.store.db.prepare('SELECT phase FROM history_preparations WHERE id=?').get(commandId).phase,phase);
});
for(const status of ['accepted','rejected'])test('distinguishes genuine terminal '+status+' row from pending phase',t=>{const f=fixture(t);f.terminal(status);f.trigger();pendingDiagnosticObserver(f.store,raw)();const result=readBoundedJSON(f.output);assert.equal(result.kind,'e3-pending-diagnostic-1');assert.equal(result.phase,null);assert.equal(result.terminalStatus,status);});
for(const [name,value]of [['different-command',{...command,commandId:otherId}],['different-operation',{commandId,body:{type:'CreateDocument'}}]])test('refuses '+name+' durable identity before taking resource diagnostics',t=>{
 const f=fixture(t);f.pending('preparing',value);f.trigger();let captures=0;pendingDiagnosticObserver(f.store,()=>{captures++;return raw();})();assert.equal(readBoundedJSON(f.output).reason,'capture-refused');assert.equal(captures,0);
});
test('does not fabricate a pending row when operation is absent',t=>{const f=fixture(t);f.trigger();pendingDiagnosticObserver(f.store,raw)();assert.equal(readBoundedJSON(f.output).reason,'capture-refused');});
for(const [name,capture]of [['oversized',()=>Buffer.alloc(262145)],['wrong-identity',()=>Buffer.from(JSON.stringify({kind:'j19-owned-diagnostics-1',commandId:otherId}))],['throws',()=>{throw Error('secret');}]])test('retains explicit unavailable snapshot when original owned capture '+name,t=>{const f=fixture(t);f.pending();f.trigger();pendingDiagnosticObserver(f.store,capture)();const result=readBoundedJSON(f.output);assert.equal(result.kind,'e3-pending-diagnostic-unavailable-1');assert.equal(result.commandId,commandId);assert(!JSON.stringify(result).includes('secret'));});
test('unavailable original owned capture remains unavailable, never a fabricated resource zero',t=>{const f=fixture(t);f.pending();f.trigger();pendingDiagnosticObserver(f.store,()=>Buffer.from(JSON.stringify({kind:'j19-diagnostic-unavailable-1',commandId,reason:'unavailable'})))();const result=readBoundedJSON(f.output);assert.equal(result.owned.value.kind,'j19-diagnostic-unavailable-1');assert.equal(result.owned.value.process,undefined);});
test('diagnostic publication refuses collision and preserves the original output and failed temporary bytes',t=>{const f=fixture(t);f.pending();f.trigger();writeFileSync(f.output,'{"prior":true}');assert.throws(()=>pendingDiagnosticObserver(f.store,raw)(),{code:'EEXIST'});assert.equal(readFileSync(f.output,'utf8'),'{"prior":true}');assert(existsSync(f.output+'.tmp'));});
test('malformed or oversized trigger never admits a capture',t=>{const f=fixture(t);f.pending();writeFileSync(join(f.root,'e3-pending-request.json'),' '.repeat(129));let calls=0;pendingDiagnosticObserver(f.store,()=>{calls++;return raw();})();assert.equal(calls,0);assert.equal(existsSync(f.output),false);});
test('parent capture uses the exact posted ID and original observer without another command or HTTP request',async t=>{
 const f=fixture(t);f.pending('waiting-for-resources');const capture=capturePendingDiagnostic(f.root,command);pendingDiagnosticObserver(f.store,raw)();const result=await capture;assert.equal(result.commandId,commandId);assert.equal(result.phase,'waiting-for-resources');assert.deepEqual(readBoundedJSON(join(f.root,'e3-pending-request.json'),128),request);
});
test('parent capture refuses unmatched completed output instead of accepting its body',async t=>{const f=fixture(t);writeFileSync(f.output,JSON.stringify({kind:'e3-pending-diagnostic-1',commandId:otherId,operation}));assert.equal((await capturePendingDiagnostic(f.root,command)).reason,'capture-refused');});
test('parent capture refuses a missing posted adoption without creating a trigger',async t=>{const f=fixture(t);assert.equal((await capturePendingDiagnostic(f.root,{commandId,body:{type:'CreateDocument'}})).reason,'no-matching-posted-adoption');assert.equal(existsSync(join(f.root,'e3-pending-request.json')),false);});
test('parent capture preserves prior trigger on collision and does not overwrite evidence',async t=>{const f=fixture(t);f.trigger();const before=readFileSync(join(f.root,'e3-pending-request.json'));assert.equal((await capturePendingDiagnostic(f.root,command)).reason,'capture-refused');assert.deepEqual(readFileSync(join(f.root,'e3-pending-request.json')),before);});

test('parent capture reports its finite deadline when the original observer never supplies evidence',async t=>{const f=fixture(t),before=JSON.stringify(command);const result=await capturePendingDiagnostic(f.root,command);assert.equal(result.reason,'capture-deadline');assert.equal(result.commandId,commandId);assert.equal(existsSync(f.output),false);assert.equal(JSON.stringify(command),before);});

test('writer failure projection keeps actual allowlisted code and integer SQLite code only',()=>{const input={code:'ERR_ASSERTION',sqliteCode:13,message:'private',stack:'private'};assert.deepEqual(writerFailureDiagnostic(input),{code:'ERR_ASSERTION',sqliteCode:13});assert.deepEqual(writerFailureDiagnostic({code:'SECRET_TOKEN',sqliteCode:Infinity}),{code:null,sqliteCode:null});assert.equal(input.message,'private');});


import {pendingRasterOwner} from '../request-edits/pending-diagnostics.mjs';
const pendingOwner=(slot='history:'+commandId)=>({kind:'j19-owned-diagnostics-1',raster:{activeWorkers:1,workerService:{activeJobs:1,retainedJobReferences:1,slot}}});
test('pending raster projection binds the selected history command without retaining its identifier or altering the capture',()=>{
 const input=pendingOwner(),before=JSON.stringify(input),result=pendingRasterOwner(input,commandId);
 assert.deepEqual(result,{kind:'e3-raster-pending-owner-1',pending:true,family:'history',selectedHistoryCommand:true});assert.equal(JSON.stringify(input),before);assert(!JSON.stringify(result).includes(commandId));
});
for(const family of ['history','raster','display','candidate-prepare','queue','portable'])test('pending raster projection distinguishes other '+family+' ownership from selected history authority',()=>{
 const result=pendingRasterOwner(pendingOwner(family+':'+otherId),commandId);
 assert.deepEqual(result,{kind:'e3-raster-pending-owner-1',pending:true,family,selectedHistoryCommand:false});assert(!JSON.stringify(result).includes(otherId));
});
test('matching identifier in another raster family never grants selected history ownership',()=>{assert.equal(pendingRasterOwner(pendingOwner('display:'+commandId),commandId).selectedHistoryCommand,false);});
test('an actual empty raster owner is distinct from unavailable diagnostics',()=>{
 assert.deepEqual(pendingRasterOwner({kind:'j19-owned-diagnostics-1',raster:{activeWorkers:0,workerService:{activeJobs:0,retainedJobReferences:0,slot:null}}},commandId),{kind:'e3-raster-pending-owner-1',pending:false,family:null,selectedHistoryCommand:false});
});
for(const [name,change]of [
 ['missing worker',value=>delete value.raster.workerService],['invalid active count',value=>value.raster.workerService.activeJobs=2],
 ['mismatched worker count',value=>value.raster.activeWorkers=0],['mismatched retained references',value=>value.raster.workerService.retainedJobReferences=0],
 ['missing slot',value=>delete value.raster.workerService.slot],['unknown family',value=>value.raster.workerService.slot='secret:'+commandId],
 ['path-like slot',value=>value.raster.workerService.slot='history:/private/grant'],['oversized identity',value=>value.raster.workerService.slot='history:'+'a'.repeat(129)],
 ['unavailable capture',value=>value.kind='j19-diagnostic-unavailable-1'],
])test('pending raster projection keeps '+name+' explicitly unavailable',()=>{const input=pendingOwner();change(input);assert.deepEqual(pendingRasterOwner(input,commandId),{kind:'e3-raster-pending-owner-unavailable-1'});});
test('inconsistent empty raster slot and invalid selected identity cannot manufacture attribution',()=>{
 const value=pendingOwner();value.raster.activeWorkers=0;value.raster.workerService.activeJobs=0;value.raster.workerService.retainedJobReferences=0;
 assert.deepEqual(pendingRasterOwner(value,commandId),{kind:'e3-raster-pending-owner-unavailable-1'});assert.deepEqual(pendingRasterOwner(pendingOwner(),'private-grant'),{kind:'e3-raster-pending-owner-unavailable-1'});
});
test('actual pending observer projects the captured original owner only after its exact durable command join',t=>{
 const f=fixture(t);f.pending();f.trigger();const original=pendingOwner();original.commandId=commandId;
 pendingDiagnosticObserver(f.store,()=>Buffer.from(JSON.stringify(original)))();const result=readBoundedJSON(f.output);
 assert.equal(result.commandId,commandId);assert.equal(result.phase,'preparing');assert.deepEqual(result.rasterOwner,{kind:'e3-raster-pending-owner-1',pending:true,family:'history',selectedHistoryCommand:true});
 assert.equal(result.owned.value.raster.workerService.slot,'[redacted]');assert(readFileSync(f.output).byteLength<=DIAGNOSTIC_LIMIT);
});

// Additive passive-operation observer controls. Deferreds below belong to this
// test fixture: no product work, diagnostic timer, sleep or collector is run.
import {installPendingOperationObserver,OPERATION_LIMITS} from '../request-edits/pending-operation-observer.mjs';
const opMethods=[
 ['history.prepare','histories','prepare'],
 ['history.prepareCandidatePreview','histories','prepareCandidatePreview'],
 ['candidates.reviewAdoptionOwned','candidates','reviewAdoptionOwned'],
 ['candidates.prepareReviewedAdoption','candidates','prepareReviewedAdoption'],
 ['candidates.prepareReviewedEncodedAdoption','candidates','prepareReviewedEncodedAdoption'],
 ['rasters.retainCandidate','rasters','retainCandidate'],
 ['rasters.prepareDocument','rasters','prepareDocument'],
 ['rasters.prepareEncodedComposition','rasters','prepareEncodedComposition'],
 ['objects.prove','objects','prove'],
 ['objects.adoptFile','objects','adoptFile'],
 ['objects.putMetadataInSlot','objects','putMetadataInSlot'],
 ['history.approvedPlacement','histories','approvedPlacement'],
];
const opDeferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function opFixture(t){
 const f=fixture(t),bodies=new Map(),calls=[],originals=new Map();
 const store=f.store;store.candidates={};store.rasters={};store.objects={};
 for(const [method,owner,key]of opMethods){
  const original=function(...args){calls.push({method,receiver:this,args});const body=bodies.get(method);return body?Reflect.apply(body,this,args):Promise.resolve(undefined);};
  store[owner][key]=original;originals.set(method,original);
 }
 const objectState={stages:1,slots:1,proofReservations:4,retainedProofs:1,proofReaders:2,proofWaiters:1,proofWaitTimer:true,repairReads:0,repairs:0};
 const proofState={pending:3,retained:1,activeReaders:2,metadataBytes:8192};
 const compositionState={loans:1,loanBytes:32,borrowers:1,borrowedBytes:16,contentReaders:1};
 const rasterState={running:false,documentBusy:true,activeWorkers:1,bookedCPUBytes:4096,workerService:{activeJobs:1},compositionMemory:compositionState};
 let resourceReads=0;
 store.objects.resourceOwnership=()=>{resourceReads++;return objectState;};
 store.objects.proofInventory=()=>{resourceReads++;return proofState;};
 store.rasters.resourceOwnership=()=>{resourceReads++;return rasterState;};
 const seed=(id=commandId,type=operation)=>store.db.prepare('INSERT INTO history_preparations VALUES(?,?,?)').run(id,JSON.stringify({command:{commandId:id,body:{type}}}),'preparing');
 seed();
 return {...f,store,bodies,calls,originals,seed,objectState,proofState,rasterState,compositionState,resourceReads:()=>resourceReads,
  invoke:(method,...args)=>{const row=opMethods.find(x=>x[0]===method);return Reflect.apply(store[row[1]][row[2]],store[row[1]],args);},
  start:(id=commandId,slot='history:'+id)=>store.histories.prepare(id,slot)};
}
const opAggregate=(snapshot,method)=>snapshot.aggregate.find(row=>row.method===method);

test('operation observer is inert by default and never wraps or reads inventories',async t=>{
 const f=opFixture(t),before=opMethods.map(([,owner,key])=>Object.getOwnPropertyDescriptor(f.store[owner],key));
 const held=opDeferred();f.bodies.set('history.prepare',()=>held.promise);
 const observer=installPendingOperationObserver(f.store);
 assert.deepEqual(opMethods.map(([,owner,key])=>Object.getOwnPropertyDescriptor(f.store[owner],key)),before);
 assert.equal(f.start(),held.promise);assert.equal(observer.snapshot(commandId).available,false);assert.equal(observer.resources().available,false);assert.equal(f.resourceReads(),0);
 held.resolve();await held.promise;observer.dispose();
});

test('selected root retains the original receiver arguments and unresolved Promise identity',async t=>{
 const f=opFixture(t),held=opDeferred();f.bodies.set('history.prepare',function(id,slot){assert.equal(this,f.store.histories);assert.equal(id,commandId);assert.equal(slot,'history:'+commandId);return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 assert.equal(f.start(),held.promise);const pending=observer.snapshot(commandId);
 assert.equal(pending.available,true);assert.equal(pending.rootPending,true);assert.equal(pending.active.some(row=>row.method==='history.prepare'),true);assert.equal(f.calls.length,1);
 held.resolve();await held.promise;assert.equal(observer.snapshot(commandId).rootPending,false);assert.equal(opAggregate(observer.snapshot(commandId),'history.prepare').fulfilled,1);
});

for(const [method,owner]of opMethods.slice(1))test('passive '+method+' keeps exact arguments receiver and original return',async t=>{
 const f=opFixture(t),outer=opDeferred(),child=opDeferred(),value=Object.freeze({sentinel:method}),check=()=>{throw Error('observer must not invoke this callback');};
 const args=[Object.freeze({opaque:true}),check,Object.freeze({last:true})],sync=method==='objects.putMetadataInSlot'||method==='history.approvedPlacement';
 let returned;
 f.bodies.set(method,function(...received){assert.equal(this,f.store[owner]);assert.equal(received.length,args.length);received.forEach((arg,i)=>assert.equal(arg,args[i]));return sync?value:child.promise;});
 f.bodies.set('history.prepare',()=>{returned=f.invoke(method,...args);return outer.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 assert.equal(f.start(),outer.promise);assert.equal(returned,sync?value:child.promise);assert.equal(f.calls.filter(row=>row.method===method).length,1);
 child.resolve(value);await child.promise;outer.resolve();await outer.promise;
 const row=opAggregate(observer.snapshot(commandId),method);assert.equal(row.calls,1);assert.equal(row.fulfilled,1);assert.equal(row.rejected,0);assert(Number.isFinite(row.totalMs)&&row.totalMs>=0);assert(Number.isFinite(row.maxMs)&&row.maxMs>=0);
});

test('synchronous boundary errors are rethrown by identity without inspecting their private data',async t=>{
 const f=opFixture(t),error=Object.create(null);Object.defineProperty(error,'message',{get(){throw Error('private error inspected');}});
 f.bodies.set('objects.putMetadataInSlot',()=>{throw error;});
 f.bodies.set('history.prepare',()=>{assert.throws(()=>f.invoke('objects.putMetadataInSlot',new Uint8Array([1]),'private-slot'),value=>value===error);return Promise.resolve();});
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 await f.start();const row=opAggregate(observer.snapshot(commandId),'objects.putMetadataInSlot');assert.equal(row.calls,1);assert.equal(row.rejected,1);assert.equal(row.fulfilled,0);
});

test('asynchronous boundary rejection preserves the original Promise and error identity',async t=>{
 const f=opFixture(t),held=opDeferred(),error=Object.freeze({privateMessage:'do not export'});let returned;
 f.bodies.set('objects.prove',()=>held.promise);f.bodies.set('history.prepare',()=>{returned=f.invoke('objects.prove',{},()=>{});return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 const result=f.start();assert.equal(result,held.promise);assert.equal(returned,held.promise);
 held.reject(error);await assert.rejects(result,value=>value===error);
 const snapshot=observer.snapshot(commandId);assert.equal(opAggregate(snapshot,'objects.prove').rejected,1);assert.equal(opAggregate(snapshot,'history.prepare').rejected,1);assert(!JSON.stringify(snapshot).includes('do not export'));
});

for(const mode of ['missing-row','wrong-operation','wrong-slot'])test('operation cohort refuses '+mode+' without altering the original call',async t=>{
 const f=opFixture(t),held=opDeferred();f.bodies.set('history.prepare',()=>{f.invoke('objects.putMetadataInSlot',{},'ignored');return held.promise;});
 f.bodies.set('objects.putMetadataInSlot',()=>17);
 if(mode==='missing-row')f.store.db.prepare('DELETE FROM history_preparations').run();
 if(mode==='wrong-operation')f.store.db.prepare('UPDATE history_preparations SET canonical=?').run(JSON.stringify({command:{commandId,body:{type:'CreateDocument'}}}));
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 assert.equal(f.start(commandId,mode==='wrong-slot'?'raster:'+commandId:'history:'+commandId),held.promise);assert.equal(observer.snapshot(commandId).available,false);assert.equal(f.calls.length,2);
 held.resolve();await held.promise;
});

test('interleaved async preparations attribute nested calls to their own selected cohort',async t=>{
 const f=opFixture(t),a=opDeferred(),b=opDeferred();f.seed(otherId);f.bodies.set('objects.putMetadataInSlot',()=>1);
 f.bodies.set('history.prepare',id=>(id===commandId?a.promise:b.promise).then(()=>{f.invoke('objects.putMetadataInSlot',{privateId:id},'history:'+id);}));
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 const first=f.start(),second=f.start(otherId);b.resolve();await second;
 assert.equal(opAggregate(observer.snapshot(otherId),'objects.putMetadataInSlot').calls,1);
 assert.equal(opAggregate(observer.snapshot(commandId),'objects.putMetadataInSlot')?.calls??0,0);assert.equal(observer.snapshot(commandId).rootPending,true);
 a.resolve();await first;assert.equal(opAggregate(observer.snapshot(commandId),'objects.putMetadataInSlot').calls,1);assert.notEqual(observer.snapshot(commandId).cohort,observer.snapshot(otherId).cohort);
});

test('unrelated async work resumed during a selected root is not attributed to that root',async t=>{
 const f=opFixture(t),outside=opDeferred(),root=opDeferred();f.bodies.set('objects.putMetadataInSlot',()=>1);f.bodies.set('history.prepare',()=>root.promise);
 const unrelated=outside.promise.then(()=>f.invoke('objects.putMetadataInSlot',{},'history:'+commandId));
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 const pending=f.start();outside.resolve();await unrelated;
 assert.equal(opAggregate(observer.snapshot(commandId),'objects.putMetadataInSlot')?.calls??0,0);assert.equal(f.calls.filter(row=>row.method==='objects.putMetadataInSlot').length,1);
 root.resolve();await pending;
});

test('a held nested proof records its parent and pending interval without invoking release callbacks',async t=>{
 const f=opFixture(t),proof=opDeferred();let checks=0;
 f.bodies.set('objects.prove',()=>proof.promise);f.bodies.set('candidates.prepareReviewedAdoption',()=>f.invoke('objects.prove',{},()=>checks++));f.bodies.set('history.prepare',()=>f.invoke('candidates.prepareReviewedAdoption',{},commandId,'history:'+commandId,()=>checks++));
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 assert.equal(f.start(),proof.promise);const pending=observer.snapshot(commandId),root=pending.active.find(x=>x.method==='history.prepare'),candidate=pending.active.find(x=>x.method==='candidates.prepareReviewedAdoption'),child=pending.active.find(x=>x.method==='objects.prove');
 assert(root&&candidate&&child);assert.equal(candidate.parent,root.call);assert.equal(child.parent,candidate.call);assert.equal(checks,0);assert.equal(opAggregate(pending,'objects.prove').fulfilled,0);
 proof.resolve('private-proof-token');await proof.promise;const completed=observer.snapshot(commandId);assert.equal(opAggregate(completed,'objects.prove').fulfilled,1);assert.equal(completed.active.length,0);assert.equal(checks,0);assert(!JSON.stringify(completed).includes('private-proof-token'));
});

test('injected scalar clock records the held original interval without a diagnostic timer',async t=>{
 const f=opFixture(t),child=opDeferred(),root=opDeferred();let now=100;
 f.bodies.set('objects.prove',()=>child.promise);f.bodies.set('history.prepare',()=>{now=120;f.invoke('objects.prove',{},()=>{});return root.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,now:()=>now});t.after(()=>observer.dispose());assert.equal(f.start(),root.promise);
 now=170;child.resolve();await child.promise;const proof=opAggregate(observer.snapshot(commandId),'objects.prove');assert.equal(proof.totalMs,50);assert.equal(proof.maxMs,50);
 now=180;root.resolve();await root.promise;assert.equal(opAggregate(observer.snapshot(commandId),'history.prepare').totalMs,80);
});

test('same selected command prepared twice never yields an arbitrarily chosen cohort',async t=>{
 const f=opFixture(t),first=opDeferred(),second=opDeferred();let calls=0;f.bodies.set('history.prepare',()=>++calls===1?first.promise:second.promise);
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 assert.equal(f.start(),first.promise);assert.equal(f.start(),second.promise);assert.equal(observer.snapshot(commandId).available,false);
 first.resolve();second.resolve();await Promise.all([first.promise,second.promise]);assert.equal(observer.snapshot(commandId).available,false);assert.equal(calls,2);
});

test('diagnostic snapshots are detached and exclude opaque arguments results IDs and content',async t=>{
 const f=opFixture(t),held=opDeferred(),opaque=new Proxy({},{get(){throw Error('opaque argument read');},ownKeys(){throw Error('opaque argument enumerated');}});
 f.bodies.set('objects.putMetadataInSlot',()=>opaque);f.bodies.set('history.prepare',()=>{assert.equal(f.invoke('objects.putMetadataInSlot',opaque,'private-grant-path'),opaque);return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());f.start();
 const snapshot=observer.snapshot(commandId),saved=JSON.stringify(snapshot);for(const rows of [snapshot.active,snapshot.transitions,snapshot.aggregate])Reflect.set(rows,'length',0);
 assert.equal(JSON.stringify(observer.snapshot(commandId)),saved);assert(!saved.includes(commandId));assert(!saved.includes('private-grant-path'));assert(Buffer.byteLength(saved)<=OPERATION_LIMITS.serializedBytes);assert.equal(snapshot.backingBytes,10880);
 held.resolve();await held.promise;
});

test('resources report existing consistent scalar proof ownership without releasing held readers',t=>{
 const f=opFixture(t),observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 const observed=observer.resources();assert.equal(observed.available,true);
 assert.deepEqual(observed.objects,f.objectState);assert.deepEqual(observed.proofs,f.proofState);assert.deepEqual(observed.composition,f.compositionState);
 assert.deepEqual(observed.raster,{running:false,documentBusy:true,activeWorkers:1,bookedCPUBytes:4096});assert.equal(f.resourceReads(),3);
 Reflect.set(observed.objects,'proofReaders',99);Reflect.set(observed.proofs,'pending',99);Reflect.set(observed.composition,'loanBytes',99);
 assert.equal(Object.isExtensible(f.objectState),true);assert.equal(Object.isExtensible(f.proofState),true);assert.equal(Object.isExtensible(f.compositionState),true);
 assert.equal(f.objectState.proofReaders,2);assert.equal(f.proofState.pending,3);assert.equal(f.compositionState.loanBytes,32);
});

for(const [name,change]of [
 ['missing inventory',f=>delete f.store.objects.proofInventory],
 ['reader mismatch',f=>f.proofState.activeReaders=0],
 ['reservation mismatch',f=>f.proofState.pending=0],
 ['worker mismatch',f=>f.rasterState.workerService.activeJobs=0],
 ['negative scalar',f=>f.objectState.repairs=-1],
 ['unsafe integer',f=>f.compositionState.loanBytes=Number.MAX_SAFE_INTEGER+1],
 ['nonfinite scalar',f=>f.rasterState.bookedCPUBytes=Infinity],
 ['invalid boolean',f=>f.objectState.proofWaitTimer='private-boolean'],
])test('resource diagnostics keep '+name+' unavailable rather than inventing zero',t=>{
 const f=opFixture(t),observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());change(f);
 const value=observer.resources();assert.equal(value.available,false);assert.equal(value.objects,undefined);assert.equal(value.proofs,undefined);
});

test('transition saturation retains bounded recent chronology and preserves independent active and aggregate completeness',async t=>{
 const f=opFixture(t),held=opDeferred();let calls=0;f.bodies.set('objects.putMetadataInSlot',()=>++calls);
 f.bodies.set('history.prepare',()=>{for(let i=0;i<OPERATION_LIMITS.transitionRows+1;i++)f.invoke('objects.putMetadataInSlot',{},'private-slot');return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());f.start();
 const snapshot=observer.snapshot(commandId);assert.equal(calls,OPERATION_LIMITS.transitionRows+1);assert.equal(snapshot.transitions.length,OPERATION_LIMITS.transitionRows);assert.equal(snapshot.traceComplete,false);assert.equal(snapshot.incomplete,true);assert.equal(snapshot.activeComplete,true);assert.equal(snapshot.aggregateComplete,true);
 assert.equal(opAggregate(snapshot,'objects.putMetadataInSlot').calls,calls);assert(snapshot.transitions[0].sequence>0);assert(snapshot.transitions.every((row,i,all)=>!i||row.sequence>all[i-1].sequence));assert.equal(snapshot.backingBytes,OPERATION_LIMITS.backingBytes);assert(Buffer.byteLength(JSON.stringify(snapshot))<=OPERATION_LIMITS.serializedBytes);
 held.resolve();await held.promise;
});

test('active call saturation cannot suppress originals or masquerade as complete ownership',async t=>{
 const f=opFixture(t),held=Array.from({length:OPERATION_LIMITS.activeCalls+1},opDeferred);let calls=0;
 f.bodies.set('objects.prove',()=>held[calls++].promise);f.bodies.set('history.prepare',()=>Promise.all(held.map(()=>f.invoke('objects.prove',{},()=>{}))));
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());const result=f.start(),snapshot=observer.snapshot(commandId);
 assert.equal(calls,held.length);assert.equal(snapshot.activeComplete,false);assert.equal(snapshot.incomplete,true);assert(snapshot.active.length<=OPERATION_LIMITS.activeCalls);assert.equal(snapshot.backingBytes,OPERATION_LIMITS.backingBytes);
 held.forEach(x=>x.resolve());await result;assert.equal(observer.snapshot(commandId).incomplete,true);
});

test('cohort saturation preserves every original preparation and reports incomplete association',async t=>{
 const f=opFixture(t),ids=Array.from({length:OPERATION_LIMITS.cohorts+1},(_,i)=>String(i+3).padStart(8,'0')+'-1111-4111-8111-111111111111'),held=ids.map(opDeferred);ids.forEach(id=>f.seed(id));
 f.bodies.set('history.prepare',id=>held[ids.indexOf(id)].promise);
 const observer=installPendingOperationObserver(f.store,{enabled:true});const results=ids.map(id=>f.start(id));
 results.forEach((result,i)=>assert.equal(result,held[i].promise));assert.equal(f.calls.length,ids.length);assert.equal(observer.snapshot(ids.at(-1)).available,false);
 const final=observer.dispose();assert.equal(final.disposed,true);assert.equal(final.incomplete,true);held.forEach(x=>x.resolve());await Promise.all(results);
});

test('approved placement guard repetition is aggregate-only and retains original throws',async t=>{
 const f=opFixture(t),held=opDeferred(),error=Object.freeze({private:'guard'});let calls=0;f.bodies.set('history.approvedPlacement',()=>{if(++calls===3)throw error;return calls;});
 f.bodies.set('history.prepare',()=>{for(let i=0;i<OPERATION_LIMITS.transitionRows+1;i++){if(i===2)assert.throws(()=>f.invoke('history.approvedPlacement',{}),value=>value===error);else f.invoke('history.approvedPlacement',{});}return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());f.start();const snapshot=observer.snapshot(commandId),row=opAggregate(snapshot,'history.approvedPlacement');
 assert.equal(row.calls,OPERATION_LIMITS.transitionRows+1);assert.equal(row.rejected,1);assert.equal(row.fulfilled,row.calls-1);assert.equal(snapshot.transitions.some(x=>x.method==='history.approvedPlacement'),false);assert.equal(snapshot.traceComplete,true);assert(Number.isFinite(row.totalMs)&&row.totalMs>=row.maxMs);
 held.resolve();await held.promise;
});

test('dispose restores only owned wrappers before fixture drain and makes late settlement inert',async t=>{
 const f=opFixture(t),held=opDeferred();f.bodies.set('objects.prove',()=>held.promise);f.bodies.set('history.prepare',()=>f.invoke('objects.prove',{},()=>{}));
 const observer=installPendingOperationObserver(f.store,{enabled:true});const result=f.start(),summary=observer.dispose();
 assert.equal(summary.disposed,true);assert(summary.pendingCalls>=1);
 for(const [method,owner,key]of opMethods)assert.equal(f.store[owner][key],f.originals.get(method));
 const saved=JSON.stringify(summary),reads=f.resourceReads();assert.equal(observer.snapshot(commandId).available,false);assert.equal(observer.resources().available,false);assert.equal(f.resourceReads(),reads);
 held.resolve({private:'late-result'});await result;assert.equal(JSON.stringify(summary),saved);assert.equal(observer.snapshot(commandId).available,false);assert.equal(observer.dispose().disposed,true);
});

test('foreign replacement is preserved and cannot retain complete wrapper ownership',async t=>{
 const f=opFixture(t),held=opDeferred();f.bodies.set('history.prepare',()=>held.promise);
 const observer=installPendingOperationObserver(f.store,{enabled:true});f.start();const foreign=function(){return 9;};f.store.objects.prove=foreign;
 const summary=observer.dispose();assert.equal(f.store.objects.prove,foreign);assert.equal(summary.incomplete,true);
 for(const [method,owner,key]of opMethods)if(method!=='objects.prove')assert.equal(f.store[owner][key],f.originals.get(method));
 held.resolve();await held.promise;
});

test('whole owner replacement remains untouched and invalidates observational completeness',async t=>{
 const f=opFixture(t),held=opDeferred();f.bodies.set('history.prepare',()=>held.promise);
 const observer=installPendingOperationObserver(f.store,{enabled:true});f.start();const replacement={prove(){return 11;}};f.store.objects=replacement;
 const summary=observer.dispose();assert.equal(f.store.objects,replacement);assert.equal(summary.incomplete,true);held.resolve();await held.promise;
});

test('borrowed method receiver preserves the original call but cannot acquire selected operation ownership',async t=>{
 const f=opFixture(t),child=opDeferred(),root=opDeferred(),foreign=Object.freeze({foreign:true});let returned;
 f.bodies.set('objects.prove',function(ref,check){assert.equal(this,foreign);assert.equal(ref,foreign);assert.equal(check,foreign);return child.promise;});
 f.bodies.set('history.prepare',()=>{returned=Reflect.apply(f.store.objects.prove,foreign,[foreign,foreign]);return root.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 assert.equal(f.start(),root.promise);assert.equal(returned,child.promise);assert.equal(f.calls.find(row=>row.method==='objects.prove').receiver,foreign);
 const snapshot=observer.snapshot(commandId);assert(snapshot.available===false||(opAggregate(snapshot,'objects.prove')?.calls??0)===0);
 child.resolve();root.resolve();await Promise.all([child.promise,root.promise]);
});

test('late rejection after synchronous disposal preserves the original failure and cannot append diagnostics',async t=>{
 const f=opFixture(t),held=opDeferred(),error=Object.freeze({private:'late-error'});f.bodies.set('objects.prove',()=>held.promise);f.bodies.set('history.prepare',()=>f.invoke('objects.prove',{},()=>{}));
 const observer=installPendingOperationObserver(f.store,{enabled:true});const result=f.start();assert.equal(result,held.promise);
 const final=observer.dispose(),before=JSON.stringify(final);held.reject(error);await assert.rejects(result,value=>value===error);
 assert.equal(JSON.stringify(final),before);assert.equal(observer.snapshot(commandId).available,false);assert.equal(observer.resources().available,false);assert.equal(f.resourceReads(),0);
});

test('a throwing original resource inventory stays unavailable without exporting error payload',t=>{
 const f=opFixture(t);f.store.objects.proofInventory=()=>{throw Error('private-inventory-grant');};
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());const snapshot=observer.resources();
 assert.equal(snapshot.available,false);assert.equal(snapshot.proofs,undefined);assert(!JSON.stringify(snapshot).includes('private-inventory-grant'));
});

function opDiagnosticPacket(t,observer,{ownership,capture=raw,valid=true}={}){
 const f=fixture(t);f.pending('preparing',valid?command:{...command,commandId:otherId});f.trigger();
 if(ownership)f.store.histories.resourceOwnership=()=>ownership;
 pendingDiagnosticObserver(f.store,capture,observer)();
 return {bytes:readFileSync(f.output),value:readBoundedJSON(f.output)};
}
const opWithoutOptional=value=>{const copy={...value};delete copy.operationObservation;delete copy.resourceObservation;return copy;};

test('optional observation failures preserve the exact original owned diagnostics and ownership',t=>{
 const original=opDiagnosticPacket(t);let calls=0;
 const failed=opDiagnosticPacket(t,{snapshot(id){assert.equal(id,commandId);calls++;throw Error('private-observation-error');},resources(){calls++;throw Error('private-resource-error');}});
 assert.equal(calls,2);assert.deepEqual(opWithoutOptional(failed.value),original.value);
 assert.deepEqual(failed.value.operationObservation,{available:false,reason:'observation-unavailable'});assert.deepEqual(failed.value.resourceObservation,{available:false,reason:'observation-unavailable'});
 assert(!failed.bytes.includes(Buffer.from('private-')));assert(failed.bytes.byteLength<=DIAGNOSTIC_LIMIT);
});

test('oversized optional observation compacts only the additions and preserves the original capture',t=>{
 const original=opDiagnosticPacket(t),failed=opDiagnosticPacket(t,{snapshot(){return {available:true,oversized:'x'.repeat(DIAGNOSTIC_LIMIT)};},resources(){return {available:true};}});
 assert.deepEqual(opWithoutOptional(failed.value),original.value);
 assert.deepEqual(failed.value.operationObservation,{available:false,reason:'packet-bound'});assert.deepEqual(failed.value.resourceObservation,{available:false,reason:'packet-bound'});assert(failed.bytes.byteLength<=DIAGNOSTIC_LIMIT);
});

for(const mode of ['cycle','throwing-serialization'])test('optional '+mode+' cannot replace an otherwise valid original diagnostic packet',t=>{
 const original=opDiagnosticPacket(t),value={available:true};
 if(mode==='cycle')value.self=value;else value.toJSON=()=>{throw Error('private-serialization');};
 const failed=opDiagnosticPacket(t,{snapshot(){return value;},resources(){return {available:true};}});
 assert.deepEqual(failed.bytes,original.bytes);assert.deepEqual(failed.value,original.value);
});

test('an original packet near its unchanged ceiling survives when even optional refusal markers do not fit',t=>{
 const small=opDiagnosticPacket(t).value;
 const entries=Array.from({length:4096},(_,i)=>['K'+String(i).padStart(6,'0')+'x'.repeat(56),0]);
 const size=n=>Buffer.byteLength(JSON.stringify({...small,ownership:redactOwnedDiagnostics(Object.fromEntries(entries.slice(0,n)))}));
 let low=0,high=entries.length;
 while(low<high){const middle=Math.ceil((low+high)/2);if(size(middle)<=DIAGNOSTIC_LIMIT)low=middle;else high=middle-1;}
 const ownership=Object.fromEntries(entries.slice(0,low));assert(size(low)>DIAGNOSTIC_LIMIT-100);
 const original=opDiagnosticPacket(t,undefined,{ownership});
 const failed=opDiagnosticPacket(t,{snapshot(){return {oversized:'x'.repeat(DIAGNOSTIC_LIMIT)};},resources(){return {available:true};}},{ownership});
 assert.deepEqual(failed.bytes,original.bytes);assert.equal(failed.value.operationObservation,undefined);assert.equal(failed.value.resourceObservation,undefined);assert(failed.bytes.byteLength<=DIAGNOSTIC_LIMIT);
});

test('optional observations are never called when the original durable command join is refused',t=>{
 let captures=0,observations=0;const failed=opDiagnosticPacket(t,{snapshot(){observations++;throw Error('unreachable');},resources(){observations++;throw Error('unreachable');}},{valid:false,capture(){captures++;return raw();}});
 assert.equal(captures,0);assert.equal(observations,0);assert.equal(failed.value.kind,'e3-pending-diagnostic-unavailable-1');assert.equal(failed.value.reason,'capture-refused');assert.equal(failed.value.operationObservation,undefined);
});

// Integration controls for ownership loss after clean completion and bounded teardown.
test('foreign replacement after two clean cohorts is independently incomplete',async t=>{
 const f=opFixture(t);f.seed(otherId);f.bodies.set('history.prepare',()=>Promise.resolve());
 const observer=installPendingOperationObserver(f.store,{enabled:true});await f.start();await f.start(otherId);
 for(const id of [commandId,otherId]){const value=observer.snapshot(id);assert.equal(value.incomplete,false);assert.equal(value.active.length,0);}
 const foreign=()=>37;f.store.objects.prove=foreign;const final=observer.dispose();
 assert.equal(f.store.objects.prove,foreign);assert.equal(final.pendingCalls,0);assert.equal(final.incomplete,true);assert(final.faults>0);
});

test('partial installation restores acquired methods and never changes the original invocation',async t=>{
 const f=opFixture(t),held=opDeferred();f.bodies.set('history.prepare',()=>held.promise);
 Object.defineProperty(f.store.histories,'approvedPlacement',{value:f.originals.get('history.approvedPlacement'),writable:false,configurable:false});
 const before=opMethods.map(([,owner,key])=>Object.getOwnPropertyDescriptor(f.store[owner],key));
 const observer=installPendingOperationObserver(f.store,{enabled:true});
 assert.deepEqual(opMethods.map(([,owner,key])=>Object.getOwnPropertyDescriptor(f.store[owner],key)),before);
 assert.equal(f.start(),held.promise);assert.equal(observer.snapshot(commandId).available,false);
 const final=observer.dispose();assert.equal(final.incomplete,true);assert(final.faults>0);held.resolve();await held.promise;
});

test('a retired inherited context cannot create new method authority after root completion',async t=>{
 const f=opFixture(t),later=opDeferred();let detached;f.bodies.set('objects.putMetadataInSlot',()=>19);
 f.bodies.set('history.prepare',()=>{detached=later.promise.then(()=>f.invoke('objects.putMetadataInSlot',{},'private'));return Promise.resolve();});
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());await f.start();
 const before=JSON.stringify(observer.snapshot(commandId));later.resolve();assert.equal(await detached,19);
 assert.equal(JSON.stringify(observer.snapshot(commandId)),before);assert.equal(f.calls.filter(row=>row.method==='objects.putMetadataInSlot').length,1);
});

test('a failed diagnostic clock marks timing unavailable without replacing the original Promise',async t=>{
 const f=opFixture(t),held=opDeferred();f.bodies.set('history.prepare',()=>held.promise);
 const observer=installPendingOperationObserver(f.store,{enabled:true,now(){throw Error('private-clock-error');}});t.after(()=>observer.dispose());
 assert.equal(f.start(),held.promise);const pending=observer.snapshot(commandId);assert.equal(pending.available,true);assert.equal(pending.aggregateComplete,false);assert(pending.faults>0);assert(!JSON.stringify(pending).includes('private-clock-error'));
 held.resolve();await held.promise;assert.equal(observer.snapshot(commandId).rootPending,false);
});

test('a nested unselected preparation cannot borrow an outer selected cohort',async t=>{
 const f=opFixture(t),held=opDeferred();f.seed(otherId,'CreateDocument');f.bodies.set('objects.putMetadataInSlot',()=>23);
 f.bodies.set('history.prepare',id=>{if(id===otherId){f.invoke('objects.putMetadataInSlot',{},'private');return Promise.resolve();}f.start(otherId);f.invoke('objects.putMetadataInSlot',{},'private');return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());assert.equal(f.start(),held.promise);
 assert.equal(observer.snapshot(otherId).available,false);assert.equal(opAggregate(observer.snapshot(commandId),'objects.putMetadataInSlot').calls,1);assert.equal(f.calls.filter(row=>row.method==='objects.putMetadataInSlot').length,2);
 held.resolve();await held.promise;
});

// A prior audit must not let a later cohort forget persistent observation loss.
test('ownership loss audited before admission keeps the next selected cohort incomplete',async t=>{
 const f=opFixture(t),held=opDeferred(),opaque=Object.freeze({privateArgument:true});let foreignCalls=0;
 f.bodies.set('history.prepare',()=>f.invoke('objects.prove',opaque));
 const observer=installPendingOperationObserver(f.store,{enabled:true});t.after(()=>observer.dispose());
 const foreign=function(value){foreignCalls++;assert.equal(this,f.store.objects);assert.equal(value,opaque);return held.promise;};
 f.store.objects.prove=foreign;
 assert.equal(observer.snapshot(otherId).available,false); // Audit before any selected cohort exists.
 assert.equal(f.start(),held.promise);assert.equal(foreignCalls,1);
 assert.equal(f.calls.filter(row=>row.method==='history.prepare').length,1);
 assert.equal(f.calls.filter(row=>row.method==='objects.prove').length,0);
 const pending=observer.snapshot(commandId);
 assert.equal(pending.available,true);assert.equal(pending.rootPending,true);
 assert.equal(pending.activeComplete,false);assert.equal(pending.aggregateComplete,false);assert.equal(pending.incomplete,true);assert(pending.faults>0);
 assert.equal(opAggregate(pending,'objects.prove').calls,0); // Zero is explicitly incomplete, never complete absence.
 held.resolve(41);assert.equal(await held.promise,41);
 const complete=observer.snapshot(commandId);
 assert.equal(complete.rootPending,false);assert.equal(complete.activeComplete,false);assert.equal(complete.aggregateComplete,false);assert.equal(complete.incomplete,true);
 assert.equal(f.store.objects.prove,foreign);assert.equal(foreignCalls,1);
 const final=observer.dispose();assert.equal(final.incomplete,true);assert.equal(f.store.objects.prove,foreign);
});


// Optional placement cost observations. These controls retain the original
// operation-owner tests above and use only owned deferreds and a scalar clock.
import {PLACEMENT_COST_LIMITS} from '../request-edits/pending-operation-observer.mjs';
const placementCostMethods=[
 ['history.readReview','histories','readReview'],
 ['history.state','histories','state'],
 ['candidates.checkAdoption','candidates','checkAdoption'],
 ['history.reviewedPlacementState','histories','reviewedPlacementState'],
];
function placementCostFixture(t){
 const f=opFixture(t),costOriginals=new Map();let clock=0;
 for(const [method,owner,key]of placementCostMethods){
  const original=function(...args){f.calls.push({method,receiver:this,args});const body=f.bodies.get(method);return body?Reflect.apply(body,this,args):0;};
  f.store[owner][key]=original;costOriginals.set(method,original);
 }
 return {...f,costOriginals,now:()=>clock,tick:n=>{clock+=n;},setClock:n=>{clock=n;},
  costInvoke:(method,...args)=>{const row=placementCostMethods.find(x=>x[0]===method);return Reflect.apply(f.store[row[1]][row[2]],f.store[row[1]],args);}};
}
const costRow=(value,method)=>value.placementCosts.aggregate.find(row=>row.method===method);
function assertCostBounds(snapshot){
 assert.equal(snapshot.backingBytes,10880);assert.equal(snapshot.placementCosts.backingBytes,656);assert.equal(snapshot.placementCosts.scalarAllowanceBytes,1024);
 assert.equal(snapshot.placementCosts.aggregate.length,4);assert.equal(snapshot.placementCosts.qualification,false);
 assert(Buffer.byteLength(JSON.stringify(snapshot.placementCosts))<=2048);assert(Buffer.byteLength(JSON.stringify(snapshot))<=32768);
}

test('placement costs are absent by default and explicit false leaves child descriptors and original observation shape unchanged',async t=>{
 const values=[];
 for(const options of [{enabled:true},{enabled:true,placementCosts:false}]){
  const f=placementCostFixture(t),before=placementCostMethods.map(([,owner,key])=>Object.getOwnPropertyDescriptor(f.store[owner],key)),held=opDeferred();
  f.bodies.set('history.approvedPlacement',()=>f.costInvoke('history.state'));f.bodies.set('history.prepare',()=>{f.invoke('history.approvedPlacement');return held.promise;});
  const observer=installPendingOperationObserver(f.store,{...options,now:f.now});
  try{assert.deepEqual(placementCostMethods.map(([,owner,key])=>Object.getOwnPropertyDescriptor(f.store[owner],key)),before);assert.equal(f.start(),held.promise);held.resolve();await held.promise;const value=observer.snapshot(commandId);assert.equal(Object.hasOwn(value,'placementCosts'),false);values.push(value);assert.equal(f.resourceReads(),0);}finally{assert.equal(Object.hasOwn(observer.dispose(),'placementCosts'),false);}
 }
 assert.deepEqual(values[0],values[1]);
 const f=placementCostFixture(t),before=placementCostMethods.map(([,owner,key])=>Object.getOwnPropertyDescriptor(f.store[owner],key)),observer=installPendingOperationObserver(f.store,{placementCosts:true});
 assert.deepEqual(placementCostMethods.map(([,owner,key])=>Object.getOwnPropertyDescriptor(f.store[owner],key)),before);assert.equal(observer.snapshot(commandId).available,false);assert.equal(Object.hasOwn(observer.dispose(),'placementCosts'),false);
});

test('four direct child costs partition a controlled synchronous schedule without counting nested state twice',async t=>{
 const f=placementCostFixture(t),held=opDeferred(),values=placementCostMethods.map(([method])=>Object.freeze({method}));
 f.bodies.set('history.readReview',()=>{f.tick(2);return values[0];});
 let stateCalls=0;f.bodies.set('history.state',()=>{f.tick(++stateCalls===1?3:11);return values[1];});
 f.bodies.set('candidates.checkAdoption',()=>{f.tick(5);return values[2];});
 f.bodies.set('history.reviewedPlacementState',()=>{f.tick(7);assert.equal(f.costInvoke('history.state'),values[1]);f.tick(13);return values[3];});
 f.bodies.set('history.approvedPlacement',()=>{for(const [i,[method]]of placementCostMethods.entries())assert.equal(f.costInvoke(method),values[i]);return values[3];});
 f.bodies.set('history.prepare',()=>{assert.equal(f.invoke('history.approvedPlacement'),values[3]);return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());assert.equal(f.start(),held.promise);
 const snapshot=observer.snapshot(commandId);assert.equal(snapshot.placementCosts.complete,true);assert.equal(snapshot.placementCosts.faults,0);assertCostBounds(snapshot);
 for(const [index,[method]]of placementCostMethods.entries())assert.deepEqual(costRow(snapshot,method),{method,calls:1,returned:1,threw:0,totalMs:[2,3,5,31][index],maxMs:[2,3,5,31][index]});
 assert.equal(stateCalls,2);assert.equal(opAggregate(snapshot,'history.approvedPlacement').totalMs,41);assert.equal(snapshot.transitions.some(row=>placementCostMethods.some(([method])=>row.method===method)),false,'No child transition rows are introduced');
 held.resolve();await held.promise;
});

for(const [method,owner]of placementCostMethods)test('direct '+method+' preserves its exact receiver arguments and opaque return',async t=>{
 const f=placementCostFixture(t),held=opDeferred(),result=Object.create(null),argument=Object.create(null);let inspections=0,invocations=0;
 for(const value of [result,argument])Object.defineProperty(value,'secret',{get(){inspections++;throw Error('opaque field read');}});
 const check=()=>assert.fail('A passive observer cannot invoke a product check'),args=[argument,check,result];let returned;
 f.bodies.set(method,function(...received){invocations++;assert.equal(this,f.store[owner]);assert.equal(received.length,args.length);received.forEach((value,index)=>assert.equal(value,args[index]));f.tick(4);return result;});
 f.bodies.set('history.approvedPlacement',()=>{returned=f.costInvoke(method,...args);return 1;});f.bodies.set('history.prepare',()=>{f.invoke('history.approvedPlacement');return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());assert.equal(f.start(),held.promise);assert.equal(returned,result);assert.equal(invocations,1);assert.equal(inspections,0);
 const value=observer.snapshot(commandId);assert.equal(value.placementCosts.complete,true);assert.deepEqual(costRow(value,method),{method,calls:1,returned:1,threw:0,totalMs:4,maxMs:4});assert.equal(inspections,0);held.resolve();await held.promise;
});

for(const [method]of placementCostMethods)test('direct '+method+' preserves synchronous error identity and records one throw',async t=>{
 const f=placementCostFixture(t),held=opDeferred(),error=Object.create(null);let inspections=0;
 Object.defineProperty(error,'message',{get(){inspections++;throw Error('error payload read');}});
 f.bodies.set(method,()=>{f.tick(6);throw error;});f.bodies.set('history.approvedPlacement',()=>f.costInvoke(method));f.bodies.set('history.prepare',()=>{assert.throws(()=>f.invoke('history.approvedPlacement'),value=>value===error);return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());f.start();const value=observer.snapshot(commandId);
 assert.deepEqual(costRow(value,method),{method,calls:1,returned:0,threw:1,totalMs:6,maxMs:6});assert.equal(value.placementCosts.complete,true);assert.equal(inspections,0);assert.equal(opAggregate(value,'history.approvedPlacement').rejected,1);held.resolve();await held.promise;
});

for(const boundary of ['child','approval'])test('opaque Proxy return at '+boundary+' never invokes its prototype trap or replaces original return',async t=>{
 const f=placementCostFixture(t),held=opDeferred();let inspected=0,returned;
 const result=new Proxy(Object.create(null),{getPrototypeOf(){inspected++;throw Error('PRIVATE_RESULT_PROTOTYPE');},get(){inspected++;throw Error('PRIVATE_RESULT_PROPERTY');}});
 f.bodies.set('history.readReview',()=>result);f.bodies.set('history.approvedPlacement',()=>boundary==='child'?(returned=f.costInvoke('history.readReview'),1):result);
 f.bodies.set('history.prepare',()=>{const value=f.invoke('history.approvedPlacement');if(boundary==='approval')returned=value;return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());assert.equal(f.start(),held.promise);assert.equal(returned,result);assert.equal(inspected,0);
 const value=observer.snapshot(commandId);assert.equal(value.placementCosts.complete,true);assert.equal(inspected,0);held.resolve();await held.promise;
});

for(const boundary of ['child','approval'])for(const outcome of ['resolve','reject'])test('unexpected native Promise from '+boundary+' is unchanged, incomplete and gains no settlement subscription on '+outcome,async t=>{
 const f=placementCostFixture(t),held=opDeferred(),child=opDeferred(),error=Object.freeze({private:'failure'});let probes=0,returned;
 // Own the eventual rejection before installing the constructor probe. A native
 // then subscription would consult this constructor; brand classification must not.
 const caught=Promise.prototype.then.call(child.promise,value=>value,failure=>failure);
 Object.defineProperty(child.promise,'constructor',{get(){probes++;return Promise;},configurable:true});
 f.bodies.set('history.readReview',()=>child.promise);f.bodies.set('history.approvedPlacement',()=>boundary==='child'?(returned=f.costInvoke('history.readReview'),1):child.promise);
 f.bodies.set('history.prepare',()=>{const value=f.invoke('history.approvedPlacement');if(boundary==='approval')returned=value;return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());assert.equal(f.start(),held.promise);assert.equal(returned,child.promise);assert.equal(probes,0);
 const before=observer.snapshot(commandId).placementCosts;assert.equal(before.complete,false);assert(before.faults>0);
 if(outcome==='resolve')child.resolve(17);else child.reject(error);assert.equal(await caught,outcome==='resolve'?17:error);assert.equal(probes,0);
 assert.deepEqual(observer.snapshot(commandId).placementCosts,before,'Later native settlement supplies no fabricated child timing');held.resolve();await held.promise;
});

test('only direct children of selected approved placement count; other operation parents and nested unselected roots do not',async t=>{
 const f=placementCostFixture(t),held=opDeferred();f.seed(otherId,'CreateDocument');let calls=0;
 f.bodies.set('history.state',()=>++calls);f.bodies.set('history.prepareCandidatePreview',()=>{f.costInvoke('history.state');return Promise.resolve();});
 f.bodies.set('history.approvedPlacement',()=>{f.costInvoke('history.readReview');f.invoke('history.prepareCandidatePreview');f.start(otherId);return 8;});
 f.bodies.set('history.prepare',id=>{if(id===otherId){f.costInvoke('history.state');return Promise.resolve();}f.costInvoke('history.state');f.invoke('history.approvedPlacement');return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());f.start();const value=observer.snapshot(commandId);
 assert.equal(calls,3);assert.equal(costRow(value,'history.state').calls,0);assert.equal(costRow(value,'history.readReview').calls,1);assert.equal(value.placementCosts.complete,true);assert.equal(observer.snapshot(otherId).available,false);held.resolve();await held.promise;
});

test('interleaved selected roots retain separate direct-child timing and unrelated async work remains unselected',async t=>{
 const f=placementCostFixture(t),a=opDeferred(),b=opDeferred(),outside=opDeferred();f.seed(otherId);
 f.bodies.set('history.state',duration=>{f.tick(duration);return duration;});f.bodies.set('history.approvedPlacement',duration=>f.costInvoke('history.state',duration));
 const unrelated=outside.promise.then(()=>f.invoke('history.approvedPlacement',99));
 f.bodies.set('history.prepare',id=>(id===commandId?a.promise:b.promise).then(()=>f.invoke('history.approvedPlacement',id===commandId?3:7)));
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());const first=f.start(),second=f.start(otherId);outside.resolve();assert.equal(await unrelated,99);
 b.resolve();assert.equal(await second,7);assert.equal(costRow(observer.snapshot(otherId),'history.state').totalMs,7);assert.equal(costRow(observer.snapshot(commandId),'history.state').calls,0);
 a.resolve();assert.equal(await first,3);assert.equal(costRow(observer.snapshot(commandId),'history.state').totalMs,3);assert.equal(costRow(observer.snapshot(otherId),'history.state').calls,1);
});

test('in-progress direct child is explicitly incomplete until its original synchronous return',async t=>{
 const f=placementCostFixture(t),held=opDeferred();let observer,during;
 f.bodies.set('history.state',()=>{f.tick(4);during=observer.snapshot(commandId);f.tick(2);return 9;});f.bodies.set('history.approvedPlacement',()=>f.costInvoke('history.state'));f.bodies.set('history.prepare',()=>{assert.equal(f.invoke('history.approvedPlacement'),9);return held.promise;});
 observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());f.start();assert.equal(during.placementCosts.complete,false);assert.equal(costRow(during,'history.state').calls,1);assert.equal(costRow(during,'history.state').returned,0);
 const after=observer.snapshot(commandId);assert.equal(after.placementCosts.complete,true);assert.equal(costRow(after,'history.state').totalMs,6);assert.equal(costRow(during,'history.state').returned,0,'Snapshots remain detached');held.resolve();await held.promise;
});

for(const mode of ['throw','negative','nan','infinite','backward'])test('direct child '+mode+' clock observation is incomplete without changing the original work',async t=>{
 const f=placementCostFixture(t),held=opDeferred();let bad=false;
 const now=()=>{if(!bad)return f.now();bad=false;if(mode==='throw')throw Error('PRIVATE_COST_CLOCK');return mode==='negative'?-1:mode==='nan'?NaN:mode==='infinite'?Infinity:10;};
 f.setClock(20);f.bodies.set('history.state',()=>{if(mode==='backward')f.setClock(0);return 23;});f.bodies.set('history.approvedPlacement',()=>{bad=mode!=='backward';return f.costInvoke('history.state');});f.bodies.set('history.prepare',()=>{assert.equal(f.invoke('history.approvedPlacement'),23);return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now});t.after(()=>observer.dispose());f.start();const value=observer.snapshot(commandId);assert.equal(value.placementCosts.complete,false);assert(value.placementCosts.faults>0);assert.equal(costRow(value,'history.state').returned,1);assert(!JSON.stringify(value).includes('PRIVATE_COST_CLOCK'));held.resolve();await held.promise;
});

test('frequent guards preserve fixed cost backing and bounds independently of truncated operation chronology',async t=>{
 const f=placementCostFixture(t),held=opDeferred(),iterations=OPERATION_LIMITS.transitionRows+1;let called=0;
 f.bodies.set('history.state',()=>{f.tick(++called%2?3:5);return called;});f.bodies.set('objects.putMetadataInSlot',()=>0);f.bodies.set('history.approvedPlacement',()=>f.costInvoke('history.state'));
 f.bodies.set('history.prepare',()=>{for(let i=0;i<iterations;i++){f.invoke('history.approvedPlacement');f.invoke('objects.putMetadataInSlot');}return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());f.start();const value=observer.snapshot(commandId),row=costRow(value,'history.state');
 assert.equal(called,iterations);assert.equal(row.calls,iterations);assert.equal(row.returned,iterations);assert.equal(row.totalMs,Math.ceil(iterations/2)*3+Math.floor(iterations/2)*5);assert.equal(row.maxMs,5);assert.equal(value.traceComplete,false);assert.equal(value.activeComplete,true);assert.equal(value.aggregateComplete,true);assert.equal(value.placementCosts.complete,true);assertCostBounds(value);assert.equal(value.transitions.length,128);held.resolve();await held.promise;
});

test('actual active-table exhaustion cannot report complete zero direct-child costs for unobserved approved placement',async t=>{
 const f=placementCostFixture(t),held=opDeferred(),proofs=Array.from({length:OPERATION_LIMITS.activeCalls-1},opDeferred);let at=0,children=0;
 f.bodies.set('objects.prove',()=>proofs[at++].promise);f.bodies.set('history.state',()=>++children);f.bodies.set('history.approvedPlacement',()=>f.costInvoke('history.state'));
 f.bodies.set('history.prepare',()=>{for(const proof of proofs)f.invoke('objects.prove');assert.equal(f.invoke('history.approvedPlacement'),1);return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());assert.equal(f.start(),held.promise);const value=observer.snapshot(commandId);
 assert.equal(at,31);assert.equal(children,1);assert.equal(value.activeComplete,false);assert.equal(value.aggregateComplete,false);assert.equal(costRow(value,'history.state').calls,0);assert.equal(value.placementCosts.complete,false,'Incomplete zero is never absence of original work');assertCostBounds(value);proofs.forEach(proof=>proof.resolve());await Promise.all(proofs.map(proof=>proof.promise));held.resolve();await held.promise;
});

for(const lost of ['child-method','outer-approval'])test('pre-admission audited '+lost+' ownership loss remains incomplete in later cohorts and preserves foreign replacement',async t=>{
 const f=placementCostFixture(t),held=opDeferred();let calls=0;
 f.bodies.set('history.approvedPlacement',()=>f.costInvoke('history.readReview'));f.bodies.set('history.prepare',()=>{assert.equal(f.invoke('history.approvedPlacement'),37);return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});
 const owner=f.store.histories,key=lost==='child-method'?'readReview':'approvedPlacement',foreign=function(){calls++;assert.equal(this,owner);return 37;};owner[key]=foreign;
 assert.equal(observer.snapshot(otherId).available,false);assert.equal(f.start(),held.promise);assert.equal(calls,1);const value=observer.snapshot(commandId);assert.equal(value.placementCosts.complete,false);assert.equal(costRow(value,'history.readReview').calls,0);
 held.resolve();await held.promise;assert.equal(observer.snapshot(commandId).placementCosts.complete,false);const final=observer.dispose();assert.equal(final.placementCosts.incomplete,true);assert.equal(final.placementCosts.liveBackingBytes,0);assert.equal(owner[key],foreign);
});

test('borrowed direct-child receiver retains original call identity but has no timing authority',async t=>{
 const f=placementCostFixture(t),held=opDeferred(),foreignReceiver={private:true},value=Object.freeze({ok:true});let calls=0;
 f.bodies.set('history.state',function(arg){calls++;assert.equal(this,foreignReceiver);assert.equal(arg,value);return value;});f.bodies.set('history.approvedPlacement',()=>f.store.histories.state.call(foreignReceiver,value));f.bodies.set('history.prepare',()=>{assert.equal(f.invoke('history.approvedPlacement'),value);return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());f.start();const snapshot=observer.snapshot(commandId);assert.equal(calls,1);assert.equal(costRow(snapshot,'history.state').calls,0);assert.equal(snapshot.placementCosts.complete,false);assert(snapshot.placementCosts.faults>0);held.resolve();await held.promise;
});

test('partial cost installation restores acquired child descriptors while the existing operation observer keeps working',async t=>{
 const f=placementCostFixture(t),held=opDeferred();Object.defineProperty(f.store.histories,'reviewedPlacementState',{value:f.costOriginals.get('history.reviewedPlacementState'),configurable:false,writable:false});
 const before=placementCostMethods.map(([,owner,key])=>Object.getOwnPropertyDescriptor(f.store[owner],key));f.bodies.set('history.approvedPlacement',()=>f.costInvoke('history.state'));f.bodies.set('history.prepare',()=>{f.invoke('history.approvedPlacement');return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});assert.deepEqual(placementCostMethods.map(([,owner,key])=>Object.getOwnPropertyDescriptor(f.store[owner],key)),before);assert.equal(f.start(),held.promise);
 const value=observer.snapshot(commandId);assert.equal(value.available,true);assert.equal(opAggregate(value,'history.approvedPlacement').calls,1);assert.equal(value.placementCosts.available,false);assert.equal(value.placementCosts.reason,'cost-install-refused');held.resolve();await held.promise;const final=observer.dispose();assert.equal(final.placementCosts.incomplete,true);assert.equal(final.placementCosts.liveBackingBytes,0);
});

test('synchronous disposal inside a child preserves its result, clears backing and leaves all later work unobserved',async t=>{
 const f=placementCostFixture(t),held=opDeferred(),late=opDeferred();let observer,summary,detached;
 f.bodies.set('history.state',()=>{summary=observer.dispose();return 41;});f.bodies.set('history.approvedPlacement',()=>f.costInvoke('history.state'));
 f.bodies.set('history.prepare',()=>{detached=late.promise.then(()=>f.costInvoke('history.readReview'));assert.equal(f.invoke('history.approvedPlacement'),41);return held.promise;});
 observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});assert.equal(f.start(),held.promise);assert.equal(summary.placementCosts.incomplete,true);assert.equal(summary.placementCosts.liveBackingBytes,0);
 for(const [method,owner,key]of placementCostMethods)assert.equal(f.store[owner][key],f.costOriginals.get(method));
 const before=JSON.stringify(summary);held.resolve();await held.promise;late.resolve();assert.equal(await detached,0);assert.equal(JSON.stringify(summary),before);assert.equal(observer.dispose(),summary);assert.equal(observer.snapshot(commandId).available,false);assert.equal(f.resourceReads(),0);
});

test('retired async context cannot restart direct-child attribution after selected root settles',async t=>{
 const f=placementCostFixture(t),late=opDeferred();let detached;f.bodies.set('history.approvedPlacement',()=>f.costInvoke('history.state'));f.bodies.set('history.prepare',()=>{detached=late.promise.then(()=>f.invoke('history.approvedPlacement'));return Promise.resolve();});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());await f.start();const before=observer.snapshot(commandId);late.resolve();await detached;assert.deepEqual(observer.snapshot(commandId),before);assert.equal(f.calls.filter(row=>row.method==='history.state').length,1);
});

test('cost observations pass the original exact durable join without changing the retained owned packet or output ceiling',async t=>{
 const f=placementCostFixture(t),held=opDeferred();f.bodies.set('history.state',()=>{f.tick(3);return 8;});f.bodies.set('history.approvedPlacement',()=>f.costInvoke('history.state'));f.bodies.set('history.prepare',()=>{f.invoke('history.approvedPlacement');return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());f.start();const original=opDiagnosticPacket(t),captured=opDiagnosticPacket(t,observer);
 assert.deepEqual(opWithoutOptional(captured.value),original.value);assert.deepEqual(captured.value.operationObservation.placementCosts,observer.snapshot(commandId).placementCosts);assert(captured.bytes.byteLength<=DIAGNOSTIC_LIMIT);assert.equal(captured.value.operationObservation.placementCosts.qualification,false);
 let reads=0;const refused=opDiagnosticPacket(t,{snapshot(){reads++;return observer.snapshot(commandId);},resources(){reads++;return observer.resources();}},{valid:false});assert.equal(reads,0);assert.equal(refused.value.reason,'capture-refused');held.resolve();await held.promise;
});


test('four cost cohorts remain bounded and an unadmitted fifth root still executes without fabricated cost authority',async t=>{
 const f=placementCostFixture(t),ids=[commandId,otherId,'33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'],held=ids.map(opDeferred);let children=0;
 ids.slice(1).forEach(id=>f.seed(id));f.bodies.set('history.state',()=>++children);f.bodies.set('history.approvedPlacement',()=>f.costInvoke('history.state'));f.bodies.set('history.prepare',id=>{f.invoke('history.approvedPlacement');return held[ids.indexOf(id)].promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});t.after(()=>observer.dispose());
 for(let i=0;i<4;i++){assert.equal(f.start(ids[i]),held[i].promise);const value=observer.snapshot(ids[i]);assert.equal(value.placementCosts.complete,true);assert.equal(costRow(value,'history.state').calls,1);assertCostBounds(value);}
 assert.equal(f.start(ids[4]),held[4].promise);assert.equal(children,5);assert.equal(observer.snapshot(ids[4]).available,false);assert.equal(Object.hasOwn(observer.snapshot(ids[4]),'placementCosts'),false);
 for(const id of ids.slice(0,4))assert.equal(observer.snapshot(id).placementCosts.complete,false,'Outer cohort overflow invalidates the independent complete claim');held.forEach(value=>value.resolve());await Promise.all(held.map(value=>value.promise));
});

test('replacement of a cost owner stays untouched and cannot report complete missing child observations',async t=>{
 const f=placementCostFixture(t),held=opDeferred(),originalOwner=f.store.candidates;let calls=0;
 f.bodies.set('history.approvedPlacement',()=>f.costInvoke('candidates.checkAdoption'));f.bodies.set('history.prepare',()=>{assert.equal(f.invoke('history.approvedPlacement'),53);return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});
 const replacement={...originalOwner,checkAdoption(){calls++;assert.equal(this,replacement);return 53;}};f.store.candidates=replacement;
 assert.equal(observer.snapshot(otherId).available,false);assert.equal(f.start(),held.promise);assert.equal(calls,1);assert.equal(observer.snapshot(commandId).placementCosts.complete,false);
 held.resolve();await held.promise;const summary=observer.dispose();assert.equal(summary.placementCosts.incomplete,true);assert.equal(summary.placementCosts.liveBackingBytes,0);assert.equal(f.store.candidates,replacement);assert.equal(replacement.checkAdoption(),53);assert.equal(calls,2);
});

test('cost disposal restores inherited child methods by removing only its own shadow descriptor',async t=>{
 const f=placementCostFixture(t),held=opDeferred(),original=f.costOriginals.get('history.state'),prior=Object.getPrototypeOf(f.store.histories),prototype=Object.create(prior);
 Object.defineProperty(prototype,'state',{value:original,configurable:true,writable:true});delete f.store.histories.state;Object.setPrototypeOf(f.store.histories,prototype);
 f.bodies.set('history.state',()=>61);f.bodies.set('history.approvedPlacement',()=>f.costInvoke('history.state'));f.bodies.set('history.prepare',()=>{assert.equal(f.invoke('history.approvedPlacement'),61);return held.promise;});
 const observer=installPendingOperationObserver(f.store,{enabled:true,placementCosts:true,now:f.now});assert.equal(Object.hasOwn(f.store.histories,'state'),true);assert.equal(f.start(),held.promise);held.resolve();await held.promise;assert.equal(observer.snapshot(commandId).placementCosts.complete,true);
 const summary=observer.dispose();assert.equal(summary.placementCosts.incomplete,false);assert.equal(summary.placementCosts.liveBackingBytes,0);assert.equal(Object.hasOwn(f.store.histories,'state'),false);assert.equal(Object.getPrototypeOf(f.store.histories),prototype);assert.equal(f.store.histories.state,original);
});
