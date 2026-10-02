import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {QueueStore} from '../../dist/local/server/storage/queue.js';
import {Candidates} from '../../dist/local/server/storage/candidates.js';
import {StoreError} from '../../dist/local/server/storage/errors.js';
import {canonical,hashBytes} from '../../dist/local/server/storage/canonical.js';
import {ProviderError,validateWireExecution} from '../../dist/local/server/provider/contracts.js';

// The journal and transactions below are real SQLite. Transport metadata is an
// explicitly injected loopback fixture, not an executed exchange or production
// proof. Wire-mint authority, filesystem body stamps and real transport are
// covered at their boundary; this fixture isolates journal ownership rules.
const origin='http://127.0.0.1:4567',endpoint='ideogram/v4/lora',requestId='request_1';
const urls={status:`${origin}/${endpoint}/requests/${requestId}/status`,result:`${origin}/${endpoint}/requests/${requestId}`,cancel:`${origin}/${endpoint}/requests/${requestId}/cancel`};
const policy={profileId:'injected-journal-fixture',profileVersion:1,evidenceDigest:'a'.repeat(64),requestedStoreIO:'0',requestedAccess:'most-private-compatible',appliedLifecycleSeconds:null,appliedACL:null,enforcement:'unknown',fallbackAcknowledgementId:null};
const failure=code=>error=>error?.code===code;

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE queue_jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE spend_sessions(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE queue_journal(seq INTEGER PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE queue_outbox(attempt_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,json TEXT NOT NULL);
 CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE candidate_jobs(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE candidates(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,job_id TEXT NOT NULL,json TEXT NOT NULL);
 CREATE TABLE candidate_private(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE candidate_journal(seq INTEGER PRIMARY KEY,family TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL);
 CREATE TABLE candidate_document_tombstones(document_id TEXT PRIMARY KEY,generation TEXT NOT NULL);
 CREATE TABLE documents(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE portable_rows(namespace TEXT,kind TEXT,id TEXT,json TEXT);`);
 const attemptId=randomUUID(),content=new Map(),records=new Map(),active=new Set();
 const bytesOf=value=>Buffer.isBuffer(value)?Buffer.from(value):Buffer.from(typeof value==='string'?value:canonical(value));
 const put=(value,mediaType='application/json')=>{const bytes=bytesOf(value),ref={hash:hashBytes(bytes),byteLength:String(bytes.length),mediaType};content.set(ref.hash,bytes);return ref;};
 const verify=ref=>{const bytes=content.get(ref.hash);if(!bytes||hashBytes(bytes)!==ref.hash||String(bytes.length)!==ref.byteLength)throw new StoreError('CORRUPT_OBJECT');return bytes;};
 const objects={verify,readRange:(ref,offset,length)=>verify(ref).subarray(Number(offset),Number(offset)+length),putMetadata:put,
  acquire:id=>active.add(id),release:id=>active.delete(id),reserve:()=>{},unreserve:()=>{},capacity:()=>{}};
 const add=(value,{role='result',direction='response',wire=true,url=role==='upload'?origin+'/upload':role==='submit'?origin+'/'+endpoint:urls[role]??origin+'/media',request=null,complete=true,owner=attemptId,status=200}={})=>{
  const bytes=bytesOf(value),recordId=randomUUID(),meta={class:'backend-transport',recordId,attemptId:owner,direction,sha256:hashBytes(bytes).slice(7),receivedBytes:String(bytes.length),retainedBytes:String(bytes.length),completeness:complete?'complete':'partial',access:'backend-only',export:'never',identity:null,headers:{'content-type':'application/json'},policy:structuredClone(policy)};
  if(wire){const target=new URL(url);meta.wireExecution={kind:'provider-wire-provenance-1',boundary:'loopback-fixture-1',role,method:role==='cancel'?'PUT':['upload','submit'].includes(role)?'POST':'GET',origin:target.origin,pathname:target.pathname,urlHash:hashBytes(url),httpStatus:status,attemptId:owner,direction,recordId,completed:true,requestRecordId:direction==='request'?recordId:request?.recordId??null,requestSha256:direction==='request'?hashBytes(bytes):request?'sha256:'+request.sha256:null};}
  records.set(recordId,{meta,bytes});return structuredClone(meta);
 };
 const evidence={
  inspect(id){const row=records.get(id);if(!row)throw new StoreError('MISSING_OBJECT');if(Object.hasOwn(row.meta,'wireExecution')){validateWireExecution(row.meta.wireExecution,row.meta);if(row.meta.receivedBytes!==row.meta.retainedBytes)throw new ProviderError('PROVENANCE');}return structuredClone(row.meta);},
  *read(id){const meta=this.inspect(id),bytes=records.get(id).bytes;yield Buffer.from(bytes);if(meta.sha256!==hashBytes(bytes).slice(7)||meta.retainedBytes!==String(bytes.length))throw new StoreError('CORRUPT_OBJECT');},
  begin(owner,direction,reservation){const chunks=[];return {owner:{attemptId:owner,direction},append:chunk=>chunks.push(Buffer.from(chunk)),finish(complete){reservation.release();return add(Buffer.concat(chunks),{owner,direction,wire:false,complete});}}}
 };
 const stages=Array.from({length:3},(_,index)=>{const ref=put('adapter bytes '+index,'application/octet-stream');return {role:`adapter:${index}`,versionId:'adapter_version_'+index,original:ref,transport:ref};});
 const prompt=put('A local journal fixture','text/plain'),request={kind:'generate-adapters',settings:{count:1,seed:{kind:'integer',decimal:'900719925474099312345'}},adapters:stages.map((stage,index)=>({version:stage.versionId,hash:stage.original.hash,scale:String(index)}))};
 const template=put('{"prompt":"A local journal fixture","seed":900719925474099312345,"loras":'+JSON.stringify(request.adapters.map(a=>({path:'asset:'+a.hash,scale:Number(a.scale)})))+'}');
 const attempt={id:attemptId,previousAttemptId:null,version:'1',state:'not-started',hold:true,override:false,spendSessionId:'session_1',count:'reserved',writerEpoch:'epoch_1',payloadHash:null,requestId:null,terminal:null,uncertainReason:null,actualCharge:null,estimate:null};
 const job={id:'job_1',version:'1',documentId:'document_1',order:{position:'1',insertionOrdinal:'1',origin:'accepted-event'},ownerClientId:'client_1',review:{kind:'request-review-1',endpoint,prompt,template,request,estimate:null,token:hashBytes('journal fixture review')},stagePlan:stages,local:'ready-to-dispatch',resultImport:'none',disposition:'eligible',attempts:[attempt]};
 const queue=Object.assign(Object.create(QueueStore.prototype),{db,objects,evidence,epoch:'epoch_1',check:()=>{},barrier:()=>{}});
 queue.record('job',job,'FixtureInitialized');queue.record('session',{id:'session_1',version:'1',cap:null,createdAt:'2026-10-01T00:00:00.000Z',previousSessionId:null},'FixtureInitialized');queue.initialOutbox(attempt,job);
 db.prepare('INSERT INTO documents VALUES (?,?)').run(job.documentId,canonical({id:job.documentId,revision:'1'}));
 const current=()=>JSON.parse(db.prepare('SELECT json FROM queue_jobs WHERE id=?').get(job.id).json);
 const update=change=>{const value=current();change(value,value.attempts[0]);queue.record('job',value,'FixtureChanged');};
 const outbox=()=>queue.recovery(job.id,attemptId).outbox;
 const ref=meta=>({recordId:meta.recordId,bodyHash:'sha256:'+meta.sha256,metadataHash:hashBytes(canonical(meta))});
 const upload=(stage=stages[0],url=origin+'/file/'+stage.role)=>{const request=add(verify(stage.transport),{role:'upload',direction:'request'}),response=add({url},{role:'upload',request});return {stage,url,request,response};};
 const recordUpload=upload=>queue.recordUpload(job.id,attemptId,upload.stage,upload.url,upload.response.recordId);
 const dispatch=()=>{const mapping={};for(const stage of stages){const pair=upload(stage);assert.equal(recordUpload(pair),true);mapping[stage.role]=pair.url;}return queue.dispatch(job.id,attemptId,mapping,policy);};
 const acknowledgement=(dispatch,{wire=true}={})=>{const body=add(Buffer.from(dispatch.bytes),{role:'submit',direction:'request',wire}),response=add({request_id:requestId,status_url:urls.status,response_url:urls.result,cancel_url:urls.cancel},{role:'submit',request:body,wire});return {body,response};};
 const acknowledge=response=>queue.outcome(job.id,attemptId,'epoch_1',{kind:'ack',requestId,urls,responseRecord:response.recordId});
 const assets={asset:()=>null},reopen=()=>{db.exec('DELETE FROM candidate_jobs; DELETE FROM candidates; DELETE FROM assets;');return new Candidates(db,objects,assets,{},queue,()=>{},()=>{});};
 const ready=()=>{update((j,a)=>{a.state='acknowledged';a.requestId=requestId;a.count='dispatched';});const out=outbox();Object.assign(out,{state:'acknowledged',epoch:'epoch_1',requestId,urls});queue.writeOutbox(attemptId,job.id,out);return reopen();};
 const fence=()=>queue.resultFence(job.id,attemptId);
 const retained=()=>{const row=db.prepare('SELECT json FROM candidate_jobs WHERE job_id=?').get(attemptId);return row?JSON.parse(row.json):null;};
 return {db,queue,records,add,ref,job,stages,attemptId,objects,active,current,update,outbox,upload,recordUpload,dispatch,acknowledgement,acknowledge,ready,reopen,fence,retained};
}

test('wire refs require the exact complete successful operation and URL; semantic snapshots remain unverified',t=>{
 const f=fixture(t),complete=f.add({request_id:requestId,status:'COMPLETED'},{role:'status'});
 assert.deepEqual(f.queue.runtimeWireRef(complete.recordId,f.attemptId,'response','status',urls.status),f.ref(complete));
 for(const args of [[randomUUID(),'response','status'],[f.attemptId,'request','status'],[f.attemptId,'response','result'],[f.attemptId,'response','status',urls.status+'?other=1']])assert.equal(f.queue.runtimeWireRef(complete.recordId,...args),null);
 for(const options of [{wire:false},{wire:false,complete:false},{status:503}]){const body=f.add({status:'COMPLETED'},{role:'status',...options});assert.equal(f.queue.runtimeWireRef(body.recordId,f.attemptId,'response','status'),null);}
 const body=f.add('prefix',{role:'status'});f.records.get(body.recordId).meta.receivedBytes='99';assert.throws(()=>f.queue.runtimeWireRef(body.recordId,f.attemptId,'response','status'),failure('PROVENANCE'));
});

test('upload journal binds retained bytes and one exact exchange, and preserves the first positional proof',t=>{
 const f=fixture(t),first=f.upload();assert.equal(f.recordUpload(first),true);
 const expected={stage:first.stage,url:first.url,request:f.ref(first.request),response:f.ref(first.response)};
 assert.deepEqual(f.outbox().wireEvidence.uploads,[expected]);assert.equal(f.recordUpload(first),true);assert.equal(f.outbox().wireEvidence.conflicted,false);
 const duplicate=f.upload(first.stage,first.url);assert.notEqual(duplicate.request.recordId,first.request.recordId);assert.equal(duplicate.request.sha256,first.request.sha256);
 assert.equal(f.recordUpload(duplicate),true);assert.deepEqual(f.outbox().wireEvidence.uploads,[expected]);assert.equal(f.outbox().wireEvidence.conflicted,true);
 assert.equal(f.recordUpload(first),true);assert.equal(f.outbox().wireEvidence.conflicted,true);
});

test('semantic-only uploads stay absent and mismatched upload request, response or stage fails atomically',t=>{
 const f=fixture(t),u=f.upload(),semantic=f.add({url:u.url},{role:'upload',wire:false});
 assert.equal(f.queue.recordUpload(f.job.id,f.attemptId,u.stage,u.url,semantic.recordId),false);assert.equal(f.outbox().wireEvidence?.uploads.length??0,0);
 const before=f.outbox();
 for(const boundary of ['request-hash','request-owner','request-url','response-url','stage']){
  const pair=f.upload();
  if(boundary==='request-hash')f.records.get(pair.response.recordId).meta.wireExecution.requestSha256=hashBytes('different request');
  if(boundary==='request-owner'){const row=f.records.get(pair.request.recordId);row.meta.attemptId=randomUUID();row.meta.wireExecution.attemptId=row.meta.attemptId;}
  if(boundary==='request-url')f.records.get(pair.request.recordId).meta.wireExecution.urlHash=hashBytes(origin+'/another-upload');
  if(boundary==='response-url')pair.url=origin+'/not-the-returned-url';
  if(boundary==='stage')pair.stage={...pair.stage,versionId:'other_version'};
  assert.throws(()=>f.recordUpload(pair),failure('CORRUPT_OBJECT'),boundary);assert.deepEqual(f.outbox(),before);
 }
});

for(const boundary of ['state','reservation','hold','epoch','deleted'])test('upload journal refuses a lost '+boundary+' fence',t=>{
 const f=fixture(t),pair=f.upload(),before=f.outbox();
 if(boundary==='deleted')f.db.prepare('INSERT INTO candidate_document_tombstones VALUES (?,?)').run(f.job.documentId,'1');
 else f.update((j,a)=>{if(boundary==='state')a.state='dispatching';if(boundary==='reservation')a.count='released';if(boundary==='hold')a.hold=false;if(boundary==='epoch')a.writerEpoch='other_epoch';});
 assert.throws(()=>f.recordUpload(pair),failure('STALE_EPOCH'));assert.deepEqual(f.outbox(),before);
});

test('upload evidence is bounded to the five source, mask and adapter slots',t=>{
 const f=fixture(t),extra=f.stages.slice(0,2).map((stage,index)=>({role:index?'mask':'source',original:stage.original,transport:stage.transport,width:1,height:1,conversion:null}));
 f.update(j=>j.stagePlan.push(...extra));for(const stage of [...f.stages,...extra])assert.equal(f.recordUpload(f.upload(stage)),true);
 assert.equal(f.outbox().wireEvidence.uploads.length,5);const before=f.outbox(),sixth={...f.stages[0],role:'adapter:3'};f.update(j=>j.stagePlan.push(sixth));
 assert.throws(()=>f.recordUpload(f.upload(sixth)),failure('CORRUPT_OBJECT'));assert.deepEqual(f.outbox(),before);
});

test('dispatch binds exact stage plan, mapping and large-integer bytes; acknowledgement retains the actual wire pair',t=>{
 const f=fixture(t),dispatch=f.dispatch(),before=f.outbox(),pair=f.acknowledgement(dispatch);
 assert.match(dispatch.bytes.toString(),/"seed":900719925474099312345/);assert.equal(f.active.size,0);
 assert.deepEqual(before.wireEvidence.dispatch,{reviewToken:f.current().review.token,stagePlanHash:hashBytes(canonical(f.current().stagePlan)),mappingHash:hashBytes(canonical(before.mapping)),payloadHash:hashBytes(dispatch.bytes)});
 assert.equal(before.wireEvidence.conflicted,false);assert.equal(before.wireEvidence.submission,null);
 assert.equal(f.queue.runtimeWireRef(dispatch.bodyRecord,f.attemptId,'request','submit'),null);
 f.acknowledge(pair.response);const first=f.outbox().wireEvidence.submission;
 assert.deepEqual(first,{...before.wireEvidence.dispatch,body:f.ref(pair.body),response:f.ref(pair.response)});assert.notEqual(first.body.recordId,dispatch.bodyRecord);
 const duplicate=f.acknowledgement(dispatch);f.acknowledge(duplicate.response);assert.deepEqual(f.outbox().wireEvidence.submission,first);assert.equal(f.outbox().wireEvidence.conflicted,true);
});

for(const first of ['semantic','uncertain'])test('a later acknowledgement cannot upgrade a '+first+' submission to runtime evidence',t=>{
 const f=fixture(t),dispatch=f.dispatch();
 if(first==='semantic')f.acknowledge(f.acknowledgement(dispatch,{wire:false}).response);
 else f.queue.outcome(f.job.id,f.attemptId,'epoch_1',{kind:'uncertain',reason:'Fixture interrupted before first acknowledgement'});
 const later=f.acknowledgement(dispatch);f.acknowledge(later.response);assert.equal(f.current().attempts[0].requestId,requestId);assert.equal(f.outbox().wireEvidence.submission,null);
});

test('a live acknowledgement with a different transmitted payload cannot commit runtime evidence or semantic success',t=>{
 const f=fixture(t),dispatch=f.dispatch(),before=f.outbox(),jobBefore=f.current(),pair=f.acknowledgement({...dispatch,bytes:Buffer.from('{"seed":900719925474099312346}')});
 assert.throws(()=>f.acknowledge(pair.response),failure('CORRUPT_OBJECT'));assert.deepEqual(f.outbox(),before);assert.deepEqual(f.current(),jobBefore);
});

test('a live acknowledgement cannot bind to a changed immutable review token',t=>{
 const f=fixture(t),dispatch=f.dispatch(),pair=f.acknowledgement(dispatch);f.update(j=>j.review.token=hashBytes('different review'));
 const before=f.outbox(),jobBefore=f.current();assert.throws(()=>f.acknowledge(pair.response),failure('CORRUPT_OBJECT'));assert.deepEqual(f.outbox(),before);assert.deepEqual(f.current(),jobBefore);
});

const status=(f,value='COMPLETED',options={})=>f.add({request_id:requestId,status:value},{role:'status',...options});
const result=(f,seed=1,options={})=>f.add({images:[],has_nsfw_concepts:[],seed,timings:{}},{role:'result',...options});

test('first completed status and result refs survive identical later records and candidate journal replay',t=>{
 const f=fixture(t),c=f.ready(),s=status(f);c.observe(f.fence(),s,1000);const r=result(f);c.receive(f.fence(),r,policy,[]);
 const retained=f.retained();assert.deepEqual(retained.wireEvidence.status,f.ref(s));assert.deepEqual(retained.wireEvidence.result,f.ref(r));assert.deepEqual(retained.wireEvidence.contradictions,[]);
 c.observe(f.fence(),status(f),2000);c.receive(f.fence(),result(f),policy,[]);assert.deepEqual(f.retained().wireEvidence,retained.wireEvidence);
 f.reopen();assert.deepEqual(f.retained().wireEvidence,retained.wireEvidence);assert.equal(Object.hasOwn(c.view(f.job.id),'wireEvidence'),false);
});

for(const legacy of ['status','result'])test('a legacy semantic-only '+legacy+' cannot gain evidence from a later identical wire observation',t=>{
 const f=fixture(t),c=f.ready();
 if(legacy==='status'){c.observe(f.fence(),status(f,'COMPLETED',{wire:false}),1000);const old=f.retained();delete old.wireEvidence;c.save('job',f.attemptId,old);f.reopen().observe(f.fence(),status(f),2000);assert.equal(f.retained().wireEvidence?.status??null,null);}
 else{c.receive(f.fence(),result(f,1,{wire:false}),policy,[]);const old=f.retained();delete old.wireEvidence;c.save('job',f.attemptId,old);const reopened=f.reopen();reopened.receive(f.fence(),result(f),policy,[]);reopened.observe(f.fence(),status(f),2000);assert.equal(f.retained().wireEvidence?.result??null,null);assert.equal(f.retained().wireEvidence?.status??null,null);}
});

test('contradictory status remains recorded after a later completion and first valid result',t=>{
 const f=fixture(t),c=f.ready(),first=status(f);c.observe(f.fence(),first,1000);const contradiction=status(f,'CANCELLED');c.observe(f.fence(),contradiction,2000);
 const retained=f.retained();assert.equal(retained.observation.phase,'quarantined');assert.deepEqual(retained.wireEvidence.status,f.ref(first));assert(retained.wireEvidence.contradictions.some(value=>value.recordId===contradiction.recordId));
 c.observe(f.fence(),status(f),3000);
 const image={url:origin+'/retained-image',width:512,height:512,content_type:'image/png'},output=f.add({images:[image],has_nsfw_concepts:[false],seed:1,timings:{}},{role:'result'});c.receive(f.fence(),output,policy,[]);
 assert.equal(f.retained().observation.phase,'quarantined');assert.deepEqual(f.retained().wireEvidence.status,f.ref(first));assert(f.retained().wireEvidence.contradictions.some(value=>value.recordId===contradiction.recordId));
 assert.equal(c.view(f.job.id).items[0].safety,'unknown');assert.equal(c.view(f.job.id).items[0].state,'withheld');
 assert.deepEqual(privateOutput(f,c.view(f.job.id).items[0].id),{kind:'candidate-output-wire-1',result:f.ref(output),index:0,image,safe:false});
 const after=f.retained().wireEvidence;f.reopen();assert.equal(f.retained().observation.phase,'quarantined');assert.deepEqual(f.retained().wireEvidence,after);assert.deepEqual(c.due(100000),[]);
});

test('malformed or partial status keeps a private contradiction without claiming completed wire evidence',t=>{
 const f=fixture(t),c=f.ready(),partial=f.add('{',{role:'status',wire:false,complete:false});c.observe(f.fence(),partial,1000);
 assert.equal(f.retained().observation.phase,'quarantined');assert.equal(f.retained().wireEvidence.status,null);assert.equal(f.retained().wireEvidence.result,null);assert.deepEqual(f.retained().wireEvidence.contradictions,[f.ref(partial)]);
 const first=f.retained().wireEvidence;c.observe(f.fence(),partial,2000);assert.deepEqual(f.retained().wireEvidence,first);f.reopen();assert.deepEqual(f.retained().wireEvidence,first);
});

test('contradictory results preserve the first result and bounded contradiction set through replay',t=>{
 const f=fixture(t),c=f.ready(),first=result(f);c.observe(f.fence(),status(f),1000);c.receive(f.fence(),first,policy,[]);const original=f.retained(),contradictions=[];
 for(let seed=2;seed<=19;seed++){const body=result(f,seed);contradictions.push(body);c.receive(f.fence(),body,policy,[]);}
 const retained=f.retained();assert.equal(retained.observation.phase,'quarantined');assert.equal(retained.observation.resultDigest,original.observation.resultDigest);assert.deepEqual(retained.provenance,original.provenance);assert.deepEqual(retained.wireEvidence.result,f.ref(first));
 assert.deepEqual(retained.wireEvidence.contradictions,contradictions.slice(0,16).map(f.ref));assert.equal(retained.wireEvidence.overflow,true);
 c.receive(f.fence(),first,policy,[]);c.observe(f.fence(),status(f),2000);assert.equal(f.retained().wireEvidence.overflow,true);assert.deepEqual(f.retained().wireEvidence.result,f.ref(first));
 f.reopen();assert.deepEqual(f.retained().wireEvidence,retained.wireEvidence);assert.equal(f.retained().observation.phase,'quarantined');
});

function privateOutput(f,id){return JSON.parse(f.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(id).json).outputEvidence;}
const outputImage=index=>({url:origin+'/output-'+index,width:512+index,height:512,content_type:'image/png',file_size:128+index});
const outputEnvelope=(images,flags=images.map(()=>false))=>({images,has_nsfw_concepts:flags,seed:1,timings:{inference:0.25}});

for(const priorPhase of ['failed','cancelled','quarantined'])test('V4 first valid result cannot relax an observed provider '+priorPhase+' state',t=>{
 const f=fixture(t),c=f.ready(),priorValue=priorPhase==='failed'?{request_id:requestId,status:'COMPLETED',error:'Fixture provider failure'}:priorPhase==='cancelled'?{request_id:requestId,status:'CANCELLED'}:{request_id:'unrelated_request',status:'COMPLETED'};
 const prior=f.add(priorValue,{role:'status'}),observed=c.observe(f.fence(),prior,1000);assert.equal(observed.view.observation.phase,priorPhase);assert.equal(observed.view.observation.resultDigest,null);assert.equal(observed.view.actualCount,null);
 const value=outputEnvelope([outputImage(0)]),source=f.add(value,{role:'result'}),view=c.receive(observed.fence,source,policy,[]);
 assert.equal(view.observation.phase,'quarantined');assert.equal(view.observation.resultDigest,source.sha256);assert.equal(view.actualCount,1);assert.equal(view.provenance.sourceBodyHash,'sha256:'+source.sha256);assert.equal(view.provenance.returnedSeed,'1');assert.deepEqual(view.provenance.timings,{inference:0.25});
 assert.equal(view.items.length,1);const candidate=view.items[0],proof=privateOutput(f,candidate.id);assert.equal(candidate.safety,'unknown');assert.equal(candidate.state,'withheld');assert.equal(candidate.encodedAssetId,null);assert.equal(candidate.preparedAssetId,null);assert.notEqual(proof?.safe,true);
 assert.deepEqual(f.retained().wireEvidence.result,f.ref(source));assert(f.retained().wireEvidence.contradictions.length>0);assert(!JSON.stringify(view).includes(value.images[0].url));
 const before=canonical(view),retained=canonical(f.retained()),privateBefore=canonical(proof??null),terminal=f.current().attempts[0].terminal;
 assert.equal(terminal,priorPhase==='quarantined'?null:priorPhase);assert.equal(canonical(c.receive(f.fence(),source,policy,[])),before);
 const reopened=f.reopen();assert.equal(canonical(reopened.view(f.job.id)),before);assert.equal(canonical(reopened.receive(f.fence(),source,policy,[])),before);assert.equal(canonical(f.retained()),retained);assert.equal(canonical(privateOutput(f,candidate.id)??null),privateBefore);assert.equal(f.current().attempts[0].terminal,terminal);
 assert.equal(Buffer.concat([...f.queue.evidence.read(prior.recordId)]).toString(),canonical(priorValue));assert.equal(Buffer.concat([...f.queue.evidence.read(source.recordId)]).toString(),canonical(value));assert.equal(f.active.size,0);
});

for(const cancellation of ['requested','acknowledged'])test('V4 local cancellation '+cancellation+' still permits observed provider completion and its first valid result',t=>{
 const f=fixture(t),c=f.ready();f.update((job,attempt)=>{job.disposition='cancel-requested';attempt.cancel='requested';});
 if(cancellation==='acknowledged'){const response=f.add({request_id:requestId,status:'CANCELLATION_REQUESTED'},{role:'cancel',status:202});f.queue.cancelObserved(f.queue.controlFence(f.job.id,f.attemptId,'cancel'),response.recordId,true);}
 assert.equal(f.current().attempts[0].cancel,cancellation);assert.equal(f.current().attempts[0].terminal,null);
 const observed=c.observe(f.fence(),status(f),1000);assert.equal(observed.view.observation.phase,'completed');assert.equal(observed.view.observation.resultDigest,null);
 const source=f.add(outputEnvelope([outputImage(0)]),{role:'result'}),view=c.receive(observed.fence,source,policy,[]),candidate=view.items[0],proof=privateOutput(f,candidate.id);
 assert.equal(view.observation.phase,'completed');assert.equal(candidate.safety,'safe');assert.equal(candidate.state,'received');assert.equal(proof.safe,true);assert.deepEqual(proof.result,f.ref(source));assert.deepEqual(f.retained().wireEvidence.contradictions,[]);assert.equal(f.retained().wireEvidence.overflow,false);
 assert.equal(f.current().disposition,'cancel-requested');assert.equal(f.current().attempts[0].cancel,cancellation);assert.equal(f.current().attempts[0].terminal,'completed');assert.equal(view.provenance.sourceBodyHash,'sha256:'+source.sha256);
 const reopened=f.reopen(),after=reopened.receive(f.fence(),source,policy,[]);assert.equal(after.observation.phase,'completed');assert.equal(after.items[0].id,candidate.id);assert.equal(after.items[0].safety,'safe');assert.deepEqual(privateOutput(f,candidate.id),proof);
});

test('each of four retained outputs binds its exact first result, image, index and safety to its candidate identity',t=>{
 const f=fixture(t),c=f.ready(),images=Array.from({length:4},(_,index)=>outputImage(index)),flags=[false,true,false,false],body=f.add(outputEnvelope(images,flags),{role:'result'});
 c.receive(f.fence(),body,policy,[]);const view=c.view(f.job.id),before=new Map();assert.equal(view.actualCount,4);assert.equal(view.items.length,4);
 for(const candidate of view.items){
  const index=candidate.outputIndex,image=images[index],identity=hashBytes(canonical([requestId,index,image])),id='c_'+hashBytes(canonical([f.attemptId,index,identity])).slice(7);
  assert.equal(candidate.outputIdentity,identity);assert.equal(candidate.id,id);
  const proof={kind:'candidate-output-wire-1',result:f.ref(body),index,image,safe:flags[index]===false};
  assert.deepEqual(privateOutput(f,id),proof);assert.equal(candidate.safety,flags[index]?'withheld':'safe');assert.equal(Object.hasOwn(candidate,'outputEvidence'),false);before.set(id,proof);
 }
 assert(!JSON.stringify(view).includes(images[0].url));f.reopen();for(const [id,proof] of before)assert.deepEqual(privateOutput(f,id),proof);
});

for(const count of [0,5])test('actual output count '+count+' retains its normal projection without per-output wire proof',t=>{
 const f=fixture(t),c=f.ready(),images=Array.from({length:count},(_,index)=>outputImage(index)),body=f.add(outputEnvelope(images),{role:'result'});
 c.receive(f.fence(),body,policy,[]);const view=c.view(f.job.id);assert.equal(view.actualCount,count);assert.equal(view.items.length,Math.max(1,count));assert.deepEqual(f.retained().wireEvidence.result,f.ref(body));
 for(const candidate of view.items){assert.equal(privateOutput(f,candidate.id),undefined);assert.equal(candidate.state,count?'received':'missing');}
});

test('missing output cannot borrow the present output wire proof',t=>{
 const f=fixture(t),c=f.ready(),image=outputImage(0),body=f.add(outputEnvelope([image,{}]),{role:'result'});c.receive(f.fence(),body,policy,[]);
 const items=c.view(f.job.id).items,present=items.find(candidate=>candidate.outputIndex===0),missing=items.find(candidate=>candidate.outputIndex===1);
 assert.deepEqual(privateOutput(f,present.id),{kind:'candidate-output-wire-1',result:f.ref(body),index:0,image,safe:true});assert.equal(missing.state,'missing');assert.equal(privateOutput(f,missing.id),undefined);
});

test('unmatched safety flags produce unsafe output proofs even when the result and image identities are valid',t=>{
 const f=fixture(t),c=f.ready(),images=[outputImage(0),outputImage(1)],body=f.add(outputEnvelope(images,[false]),{role:'result'});c.receive(f.fence(),body,policy,[]);
 for(const candidate of c.view(f.job.id).items){assert.deepEqual(privateOutput(f,candidate.id),{kind:'candidate-output-wire-1',result:f.ref(body),index:candidate.outputIndex,image:images[candidate.outputIndex],safe:false});assert.equal(candidate.safety,'unknown');assert.equal(candidate.state,'withheld');}
});

for(const first of ['semantic','legacy'])test('a '+first+' output cannot gain a proof from a later identical actual-wire result',t=>{
 const f=fixture(t),c=f.ready(),value=outputEnvelope([outputImage(0)]),body=f.add(value,{role:'result',wire:first!=='semantic'});c.receive(f.fence(),body,policy,[]);const candidate=c.view(f.job.id).items[0];
 if(first==='legacy'){
  const retained=f.retained();delete retained.wireEvidence;c.save('job',f.attemptId,retained);
  const slot=JSON.parse(f.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(candidate.id).json);delete slot.outputEvidence;f.db.prepare('UPDATE candidate_private SET json=? WHERE id=?').run(canonical(slot),candidate.id);
 }
 assert.equal(privateOutput(f,candidate.id),undefined);const reopened=f.reopen();reopened.receive(f.fence(),f.add(value,{role:'result'}),policy,[]);assert.equal(privateOutput(f,candidate.id),undefined);assert.equal(f.retained().wireEvidence?.result??null,null);
});

test('duplicate and contradictory results preserve the first output proof and candidate identity',t=>{
 const f=fixture(t),c=f.ready(),images=[outputImage(0),outputImage(1)],value=outputEnvelope(images),first=f.add(value,{role:'result'});c.receive(f.fence(),first,policy,[]);
 const before=c.view(f.job.id).items.map(candidate=>({id:candidate.id,index:candidate.outputIndex,identity:candidate.outputIdentity,proof:privateOutput(f,candidate.id)}));
 c.receive(f.fence(),f.add(value,{role:'result'}),policy,[]);for(const candidate of before)assert.deepEqual(privateOutput(f,candidate.id),candidate.proof);
 const other=f.add(outputEnvelope([...images].reverse()),{role:'result'});c.receive(f.fence(),other,policy,[]);const view=c.view(f.job.id);assert.equal(view.observation.phase,'quarantined');assert(f.retained().wireEvidence.contradictions.some(ref=>ref.recordId===other.recordId));
 for(const original of before){const candidate=view.items.find(value=>value.id===original.id);assert.equal(candidate.outputIndex,original.index);assert.equal(candidate.outputIdentity,original.identity);assert.equal(candidate.safety,'unknown');assert.deepEqual(privateOutput(f,candidate.id),original.proof);assert.equal(original.proof.result.recordId,first.recordId);}
 f.reopen();for(const original of before)assert.deepEqual(privateOutput(f,original.id),original.proof);
});

test('a changed result fence cannot publish output proofs after scanning a first result',t=>{
 const f=fixture(t),c=f.ready(),fence=f.fence(),body=f.add(outputEnvelope([outputImage(0)]),{role:'result'}),put=f.objects.putMetadata;
 f.objects.putMetadata=value=>{const ref=put(value);f.update(job=>job.version=String(BigInt(job.version)+1n));return ref;};
 assert.throws(()=>c.receive(fence,body,policy,[]),failure('STALE_EPOCH'));assert.equal(f.retained(),null);assert.equal(f.db.prepare('SELECT count(*) n FROM candidate_private').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM candidates').get().n,0);assert.equal(f.active.size,0);
});

function mediaCandidate(f){
 const candidates=f.ready(),url=origin+'/candidate-media';
 candidates.receive(f.fence(),f.add({images:[{url,width:512,height:512,content_type:'image/png'}],has_nsfw_concepts:[false],seed:1,timings:{}},{role:'result'}),policy,[]);
 const candidate=candidates.view(f.job.id).items[0];
 const slot=()=>JSON.parse(f.db.prepare('SELECT json FROM candidate_private WHERE id=?').get(candidate.id).json);
 const saveSlot=value=>f.db.prepare('UPDATE candidate_private SET json=? WHERE id=?').run(canonical(value),candidate.id);
 const stopped=new Error('Journal fixture stops before content copy or decoding');f.objects.begin=()=>{throw stopped;};
 return {candidates,candidate,url,slot,saveSlot,stopped};
}

for(const observation of ['wire','semantic','different-url','http-failure','interrupted'])test('candidate media journal records '+observation+' identity without inventing qualification',async t=>{
 const f=fixture(t),m=mediaCandidate(f),successful=!['http-failure','interrupted'].includes(observation);
 const body=f.add(Buffer.from('Injected media bytes; never decoded'),{role:'media',url:observation==='different-url'?m.url+'/other':m.url,wire:!['semantic','interrupted'].includes(observation),status:observation==='http-failure'?503:200,complete:observation!=='interrupted'});
 f.records.get(body.recordId).meta.headers={'content-type':'image/png'};const retained=f.records.get(body.recordId).meta;
 let calls=0;const provider={async media(url,sink){calls++;assert.equal(url,m.url);sink.finish(false);return {outcome:observation==='interrupted'?'interrupted':'complete',status:observation==='http-failure'?503:200,evidence:structuredClone(retained)};}};
 const work=m.candidates.transferOwned(f.fence(),m.candidate.id,provider,policy,new AbortController().signal);
 if(successful)await assert.rejects(work,error=>error===m.stopped);else await work;
 assert.equal(calls,1);assert.equal(f.active.size,0);assert.equal(m.slot().mediaRecord,body.recordId);
 if(observation==='wire')assert.deepEqual(m.slot().mediaEvidence,f.ref(retained));else assert.equal(Object.hasOwn(m.slot(),'mediaEvidence'),false);
 const before=m.slot();f.reopen();assert.deepEqual(m.slot(),before);
});

test('a completed media response cannot publish evidence through a stale result fence',async t=>{
 const f=fixture(t),m=mediaCandidate(f),before=m.slot(),body=f.add('retained bytes',{role:'media',url:m.url}),fence=f.fence();
 const provider={async media(url,sink){assert.equal(url,m.url);sink.finish(false);f.update(j=>j.version=String(BigInt(j.version)+1n));return {outcome:'complete',status:200,evidence:body};}};
 await assert.rejects(m.candidates.transferOwned(fence,m.candidate.id,provider,policy,new AbortController().signal),failure('STALE_EPOCH'));
 assert.deepEqual(m.slot(),before);assert.equal(f.active.size,0);
});

test('a retained legacy media record is not backfilled when an encoded candidate needs no transfer',async t=>{
 const f=fixture(t),m=mediaCandidate(f),legacy=f.add('already retained media',{role:'media',url:m.url});
 m.saveSlot({...m.slot(),mediaRecord:legacy.recordId});m.candidates.save('candidate',m.candidate.id,{...m.candidate,encodedAssetId:'legacy_encoded_asset',safety:'unknown',state:'withheld'});
 const before=m.slot(),provider={async media(){assert.fail('retained encoded candidate must not fetch again');}};
 await m.candidates.transferOwned(f.fence(),m.candidate.id,provider,policy,new AbortController().signal);assert.deepEqual(m.slot(),before);assert.equal(Object.hasOwn(m.slot(),'mediaEvidence'),false);
});
