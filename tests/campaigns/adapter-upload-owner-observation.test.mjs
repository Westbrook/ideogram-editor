import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {adapterUploadURL,adapterUploadHookURL,browserPhasesURL,phasesURL,allocationsURL,diagnosticMemoryURL} from '../owned-preview-module.mjs';

// All URLs resolve actual product source through Oxc. In particular, the SHA,
// control/response ownership and registry are shared real modules, not doubles.
const {AdapterUploadObservations,ensureAdapterUploads}=await import(adapterUploadURL);
const {DiagnosticMemory}=await import(diagnosticMemoryURL);
const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const owner=Object.freeze({sessionId:'private-session-original',draftSessionId:'private-draft-original',documentId:'private-document-original',documentEpoch:7,editorEpoch:11,clientId:'private-client-original'});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const waitForPut=(entered,pending)=>Promise.race([entered.promise,pending.then(()=>{throw Error('Upload finished before reaching the held PUT');})]);
const payload=length=>Buffer.from(Array.from({length},(_,index)=>(index*29+17)%251));
function observation(t,capacity=4){const value=new AdapterUploadObservations(capacity,new DiagnosticMemory());t.after(()=>value.dispose());return value;}
function snapshot(observations){const read=observations.readSnapshot();try{return structuredClone(read.value);}finally{read.release();}}
function upload(observations,file,transport,{role='adapter-weights',purpose=role==='adapter-weights'?'adapter':'caption',controller=new AbortController(),...rest}={}){
 return observations.bind(file,role)({file,purpose,mediaType:file.type||'application/octet-stream',transport,owner,signal:controller.signal,check:()=>controller.signal.throwIfAborted(),tick:()=>Promise.resolve(),...rest});
}
function json(response,status,value){const body=Buffer.from(JSON.stringify(value));response.writeHead(status,{'Content-Type':'application/json','Content-Length':String(body.length)});response.end(body);}

/** A literal-loopback HTTP staging authority. Only its responses are perturbed
 * in negative cases; observations always come from the actual upload producer. */
async function staging(t,{beforeAck,failPut=false,jumpAck=false,ackPatch}={}){
 const requests=[],records=new Map(),errors=[],tasks=new Set();let putCount=0;
 const server=createServer((request,response)=>{
  const task=(async()=>{
   const chunks=[];let received=0;
   for await(const chunk of request){received+=chunk.length;assert.ok(received<=1048576);chunks.push(chunk);}
   const entry={method:request.method,path:request.url,offset:request.headers['upload-offset']??null,bytes:Buffer.concat(chunks)};requests.push(entry);
   if(entry.method==='POST'&&entry.path==='/api/v1/assets/staging'){
    const create=JSON.parse(entry.bytes.toString('utf8'));
    assert.equal(create.protocolVersion,1);assert.match(create.sha256,/^sha256:[a-f0-9]{64}$/);assert.match(create.expectedBytes,/^[1-9][0-9]*$/);assert.equal(records.has(create.stagingId),false);
    const record={...create,ownerClientId:owner.clientId,version:'1',committedOffset:'0',state:'receiving'};records.set(create.stagingId,record);json(response,201,record);return;
   }
   const match=/^\/api\/v1\/assets\/staging\/([A-Za-z0-9_-]+)$/.exec(entry.path??'');assert.ok(match,'only exact staging routes are requested');
   const record=records.get(match[1]);assert.ok(record,'stage was created through actual POST');
   if(entry.method==='GET'){assert.equal(entry.bytes.length,0);json(response,200,record);return;}
   assert.equal(entry.method,'PUT');assert.equal(entry.offset,record.committedOffset);assert.ok(entry.bytes.length>0);
   const ordinal=++putCount;await beforeAck?.({entry,record,ordinal});
   if(response.destroyed)return;
   if(failPut){json(response,503,{error:{code:'FIXTURE_TRANSFER_FAILED'}});return;}
   const offset=jumpAck?Number(record.expectedBytes):Number(record.committedOffset)+entry.bytes.length;
   assert.ok(offset<=Number(record.expectedBytes));record.committedOffset=String(offset);record.version=String(Number(record.version)+1);record.state=record.committedOffset===record.expectedBytes?'complete':'receiving';
   json(response,200,{...record,...ackPatch?.(record)});
  })().catch(error=>{errors.push(error);if(!response.destroyed){if(response.headersSent)response.destroy();else json(response,500,{error:{code:'FIXTURE_ERROR'}});}});
  tasks.add(task);void task.finally(()=>tasks.delete(task));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 const address=server.address();assert.equal(address.address,'127.0.0.1');const origin='http://127.0.0.1:'+address.port;
 t.after(async()=>{await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});await Promise.all(tasks);assert.deepEqual(errors,[]);});
 return {requests,records,transport:(path,init)=>{assert.match(path,/^\/api\/v1\/assets\/staging(?:\/[A-Za-z0-9_-]+)?$/);return fetch(origin+path,{...init,signal:AbortSignal.any(init?.signal?[init.signal,t.signal]:[t.signal]),redirect:'error'});}};
}
function assertComplete(row,bytes){
 assert.equal(row.outcome,'complete');assert.equal(row.settled,true);assert.equal(row.liveReads,0);assert.deepEqual(row.missing,[]);
 for(const lane of ['hash','transfer']){assert.equal(row[lane].from,0);assert.equal(row[lane].to,bytes.length);assert.equal(row[lane].byteLength,bytes.length);assert.equal(row[lane].contiguous,true);}
 assert.equal(row.hash.sha256,digest(bytes));assert.equal(row.transfer.initialCommittedOffset,'0');assert.equal(row.transfer.lastCommittedOffset,String(bytes.length));assert.equal(row.transfer.lastState,'complete');assert.equal(row.transfer.acks,row.transfer.chunks);
}

test('real Blob hashing and HTTP staging cross both chunk bounds without retaining payload or raw owner identities',{timeout:15000},async t=>{
 const observed=observation(t),http=await staging(t),bytes=payload(1048576+131),marker='PRIVATE_PAYLOAD_NOT_DIAGNOSTICS';bytes.write(marker);
 const file=new File([bytes],'private-original-weights.safetensors',{type:'application/x-private-original-weights'}),request=await upload(observed,file,http.transport);
 try{
  const value=snapshot(observed),row=value.operations[0];assert.equal(value.active,0);assert.equal(value.sequence,1);assert.equal(value.dropped,0);assert.equal(value.invalid,0);assert.equal(value.globalCoverageComplete,false);assert.equal(value.scope,'ownedUpload-opaque-hash-and-transfer');assertComplete(row,bytes);
  assert.equal(row.hash.chunks,17);assert.equal(row.hash.maxChunk,65536);assert.equal(row.transfer.chunks,2);assert.equal(row.transfer.maxChunk,1048576);assert.equal(value.observerMetadata.runCapacity,8);assert.ok(row.hash.runs.length<=8);assert.ok(row.transfer.runs.length<=8);assert.ok(row.transfer.ackRuns.length<=8);
  assert.equal(request.value.sha256,digest(bytes));assert.equal(request.value.stagingId,row.stagingId);assert.equal(request.value.expectedBytes,String(bytes.length));
  assert.deepEqual(http.requests.map(entry=>entry.method),['POST','GET','PUT','PUT']);const puts=http.requests.filter(entry=>entry.method==='PUT');assert.deepEqual(puts.map(entry=>entry.offset),['0','1048576']);assert.deepEqual(Buffer.concat(puts.map(entry=>entry.bytes)),bytes);
  assert.equal(row.owner.sessionHash,digest(owner.sessionId));assert.equal(row.owner.draftSessionHash,digest(owner.draftSessionId));assert.equal(row.owner.documentHash,digest(owner.documentId));assert.equal(row.owner.clientHash,digest(owner.clientId));
  const serialized=JSON.stringify(value);for(const secret of [marker,file.name,file.type,...Object.values(owner).filter(value=>typeof value==='string')])assert.equal(serialized.includes(secret),false);
  const inspect=value=>{assert.equal(value instanceof Blob||value instanceof ArrayBuffer||ArrayBuffer.isView(value),false);if(value&&typeof value==='object')for(const child of Object.values(value))inspect(child);};inspect(value);
 }finally{request.release();}
});

test('a held real PUT acknowledgement remains active until its response arrives',{timeout:15000},async t=>{
 const observed=observation(t),entered=deferred(),ack=deferred(),http=await staging(t,{beforeAck:async({ordinal})=>{if(ordinal===1){entered.resolve();await ack.promise;}}}),bytes=payload(1048576+5),file=new Blob([bytes]);
 const pending=upload(observed,file,http.transport);void pending.catch(()=>{});
 try{
  await waitForPut(entered,pending);const before=snapshot(observed),row=before.operations[0];assert.equal(before.active,1);assert.equal(row.outcome,'active');assert.equal(row.settled,false);assert.equal(row.liveReads,0);assert.equal(row.hash.sha256,digest(bytes));assert.equal(row.transfer.byteLength,1048576);assert.equal(row.transfer.acks,0);assert.equal(row.transfer.lastCommittedOffset,'0');assert.throws(()=>observed.dispose(),/ADAPTER_UPLOAD_OBSERVER_ACTIVE/);
  ack.resolve();const request=await pending;request.release();const after=snapshot(observed);assert.equal(after.active,0);assertComplete(after.operations[0],bytes);assert.equal(before.active,1);assert.equal(row.outcome,'active');assert.equal(row.transfer.acks,0);
 }finally{ack.resolve();await pending.then(value=>value.release(),()=>{});}
});

test('abort during real HTTP staging leaves an error receipt with incomplete transfer coverage',{timeout:15000},async t=>{
 const observed=observation(t),entered=deferred(),ack=deferred(),http=await staging(t,{beforeAck:async()=>{entered.resolve();await ack.promise;}}),controller=new AbortController(),bytes=payload(1048576+9),file=new Blob([bytes]);
 const pending=upload(observed,file,http.transport,{controller});void pending.catch(()=>{});
 try{
  await waitForPut(entered,pending);controller.abort();await assert.rejects(pending,error=>error?.name==='AbortError');const value=snapshot(observed),row=value.operations[0];assert.equal(value.active,0);assert.equal(row.outcome,'error');assert.equal(row.settled,true);assert.equal(row.liveReads,0);assert.ok(row.missing.includes('aborted'));assert.equal(row.hash.sha256,digest(bytes));assert.equal(row.transfer.acks,0);assert.ok(row.transfer.byteLength<bytes.length);assert.equal(row.transfer.lastCommittedOffset,'0');
 }finally{controller.abort();ack.resolve();await pending.then(value=>value.release(),()=>{});}
});

test('HTTP failure releases upload owners and preserves the original failed transport outcome',{timeout:15000},async t=>{
 const observed=observation(t),http=await staging(t,{failPut:true}),bytes=payload(65536+7),file=new Blob([bytes]),{allocationLedger}=await import(allocationsURL),before=allocationLedger.snapshot();
 await assert.rejects(upload(observed,file,http.transport),/FIXTURE_TRANSFER_FAILED/);const value=snapshot(observed),row=value.operations[0];assert.equal(value.active,0);assert.equal(row.outcome,'error');assert.equal(row.settled,true);assert.ok(row.missing.includes('upload-error'));assert.equal(row.hash.sha256,digest(bytes));assert.equal(row.transfer.acks,0);assert.equal(row.transfer.lastState,'receiving');
 const after=allocationLedger.snapshot();assert.equal(after.activeRecords,before.activeRecords);assert.equal(after.cpuBytes,before.cpuBytes);assert.equal(after.handles,before.handles);
});

test('an advancing acknowledgement that skips bytes cannot yield complete observation coverage',{timeout:15000},async t=>{
 const observed=observation(t),http=await staging(t,{jumpAck:true}),bytes=payload(1048576+31),request=await upload(observed,new Blob([bytes]),http.transport);
 try{const row=snapshot(observed).operations[0];assert.equal(row.outcome,'complete');assert.equal(row.settled,true);assert.ok(row.missing.includes('acknowledgement-discontinuity'));assert.ok(row.missing.includes('transfer-coverage-incomplete'));assert.equal(row.transfer.acks,1);assert.equal(row.transfer.byteLength,1048576);const transported=Buffer.concat(http.requests.filter(entry=>entry.method==='PUT').map(entry=>entry.bytes));assert.equal(transported.length,1048576);assert.notEqual(digest(transported),digest(bytes));}
 finally{request.release();}
});

test('role, exact Blob and existing purpose lineage are enforced before any network request',{timeout:15000},async t=>{
 const observed=observation(t),http=await staging(t),bytes=payload(73),file=new Blob([bytes]),controller=new AbortController(),input={file,purpose:'adapter',mediaType:'application/octet-stream',transport:http.transport,owner,signal:controller.signal,check:()=>controller.signal.throwIfAborted(),tick:()=>Promise.resolve()};
 assert.throws(()=>observed.bind(file,'unrecognized-role'),/ADAPTER_UPLOAD_ROLE/);const bound=observed.bind(file,'adapter-weights');assert.throws(()=>bound({...input,file:new Blob([bytes])}),/ADAPTER_UPLOAD_LINEAGE/);assert.throws(()=>bound({...input,purpose:'caption'}),/ADAPTER_UPLOAD_LINEAGE/);assert.equal(snapshot(observed).sequence,0);assert.equal(http.requests.length,0);
 const existing={protocolVersion:1,stagingId:'existing-original',purpose:'caption',expectedBytes:String(bytes.length),sha256:digest(bytes),mediaType:input.mediaType,ownerClientId:owner.clientId,version:'1',committedOffset:'0',state:'receiving'};
 await assert.rejects(bound({...input,existing}),/STAGING_CHANGED/);assert.equal(http.requests.length,0);const row=snapshot(observed).operations[0];assert.equal(row.outcome,'error');assert.equal(row.settled,true);assert.ok(row.missing.includes('upload-error'));
 for(const role of ['adapter-config','adapter-provenance']){const request=await upload(observed,file,http.transport,{role});request.release();const completed=snapshot(observed).operations.at(-1);assert.equal(completed.role,role);assert.equal(completed.purpose,'caption');assertComplete(completed,bytes);}
});

test('a real PUT response cannot substitute another purpose, media type or owner',{timeout:15000},async t=>{
 const observed=observation(t),file=new Blob([payload(89)]);
 for(const patch of [{purpose:'caption'},{mediaType:'application/x-changed'},{ownerClientId:'other-client'}]){
  const http=await staging(t,{ackPatch:()=>patch});await assert.rejects(upload(observed,file,http.transport),/STAGING_CHANGED/);const row=snapshot(observed).operations.at(-1);assert.equal(row.outcome,'error');assert.equal(row.settled,true);assert.ok(row.missing.includes('upload-error'));assert.equal(row.transfer.acks,0);assert.equal(row.transfer.lastCommittedOffset,'0');
 }
});

test('bounded retention records drops for both active overflow and settled eviction',{timeout:15000},async t=>{
 const observed=observation(t,1),entered=deferred(),ack=deferred(),http=await staging(t,{beforeAck:async({ordinal})=>{if(ordinal===1){entered.resolve();await ack.promise;}}}),file=new Blob([payload(67)]),first=upload(observed,file,http.transport);void first.catch(()=>{});
 try{
  await waitForPut(entered,first);const second=await upload(observed,file,http.transport);second.release();let value=snapshot(observed);assert.equal(value.sequence,2);assert.equal(value.dropped,1);assert.equal(value.active,1);assert.equal(value.operations.length,1);assert.equal(value.operations[0].sequence,1);assert.equal(value.operations[0].settled,false);
  ack.resolve();const completed=await first;completed.release();const third=await upload(observed,file,http.transport);third.release();value=snapshot(observed);assert.equal(value.sequence,3);assert.equal(value.dropped,2);assert.equal(value.active,0);assert.equal(value.operations.length,1);assert.equal(value.operations[0].sequence,3);assert.equal(value.globalCoverageComplete,false);
 }finally{ack.resolve();await first.then(value=>value.release(),()=>{});}
});

test('detached reads have bounded simultaneous ownership and explicit idempotent release',{timeout:15000},async t=>{
 const observed=observation(t),http=await staging(t),bytes=payload(97),request=await upload(observed,new Blob([bytes]),http.transport);request.release();const reads=[];
 try{
  for(let index=0;index<4;index++)reads.push(observed.readSnapshot());assert.throws(()=>observed.readSnapshot(),/DIAGNOSTIC_READ_LIMIT/);
  reads[0].value.operations[0].hash.sha256='mutated detached copy';reads[0].value.operations[0].owner.sessionHash='mutated detached owner';assert.equal(reads[1].value.operations[0].hash.sha256,digest(bytes));assert.equal(reads[1].value.operations[0].owner.sessionHash,digest(owner.sessionId));
  reads[0].release();reads[0].release();assert.throws(()=>reads[0].value,/DIAGNOSTIC_READ_RELEASED/);const replacement=observed.readSnapshot();reads.push(replacement);assert.equal(replacement.value.operations[0].hash.sha256,digest(bytes));
  observed.dispose();assert.throws(()=>observed.readSnapshot(),/ADAPTER_UPLOAD_OBSERVER_DISPOSED/);
 }finally{for(const read of reads)read.release();}
});

test('BrowserPhases borrows the real singleton upload reader through aggregate release',{timeout:15000},async t=>{
 const {BrowserPhases}=await import(browserPhasesURL),{PhaseRecorder}=await import(phasesURL),{readAdapterUploads}=await import(adapterUploadHookURL),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
 const recorder=new PhaseRecorder({lane:'upload-test',capacity:1,openSpans:1}),phases=new BrowserPhases(()=>performance.now(),recorder);t.after(()=>{phases.dispose();recorder.dispose();});
 assert.equal(readAdapterUploads(),null);const beforeAdmission=allocationLedger.snapshot(),pressure=allocationLedger.reserve({owner:'upload-admission-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-beforeAdmission.cpuBytes});
 try{await assert.rejects(phases.ensureAdapterUploads(),/ALLOCATION_BUDGET/);assert.equal(readAdapterUploads(),null);}finally{pressure.release();}
 const afterAdmission=allocationLedger.snapshot();assert.equal(afterAdmission.cpuBytes,beforeAdmission.cpuBytes);assert.equal(afterAdmission.activeRecords,beforeAdmission.activeRecords);
 await phases.ensureAdapterUploads();const adapterUploads=ensureAdapterUploads(),http=await staging(t),bytes=payload(101),request=await upload(adapterUploads,new Blob([bytes]),http.transport);request.release();const direct=[];let aggregate;
 try{
  for(let index=0;index<3;index++)direct.push(readAdapterUploads());const before=allocationLedger.snapshot();aggregate=phases.readSnapshot('adapter-aggregate');assert.equal(phases.readSnapshot('adapter-aggregate'),aggregate);assert.throws(()=>readAdapterUploads(),/DIAGNOSTIC_READ_LIMIT/);
  const row=aggregate.value.adapterUploads.operations.at(-1);assertComplete(row,bytes);row.hash.sha256='mutated aggregate copy';assert.equal(direct[0].value.operations.at(-1).hash.sha256,digest(bytes));
  aggregate.release();aggregate.release();assert.throws(()=>aggregate.value,/DIAGNOSTIC_READ_RELEASED/);const after=allocationLedger.snapshot();assert.equal(after.activeRecords,before.activeRecords);assert.equal(after.cpuBytes,before.cpuBytes);assert.equal(after.handles,before.handles);
  const returned=readAdapterUploads();direct.push(returned);assert.equal(returned.value.operations.at(-1).hash.sha256,digest(bytes));
  const full=allocationLedger.snapshot();assert.throws(()=>phases.readSnapshot('retry-after-upload-limit'),/DIAGNOSTIC_READ_LIMIT/);const rolledBack=allocationLedger.snapshot();assert.equal(rolledBack.activeRecords,full.activeRecords);assert.equal(rolledBack.cpuBytes,full.cpuBytes);assert.equal(rolledBack.handles,full.handles);
  direct.pop().release();aggregate=phases.readSnapshot('retry-after-upload-limit');assertComplete(aggregate.value.adapterUploads.operations.at(-1),bytes);
 }finally{aggregate?.release();for(const read of direct)read.release();}
});
