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
