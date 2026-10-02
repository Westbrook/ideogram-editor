// Actual Dispatcher + ProviderBoundary + wire transport, using only loopback
// GET/PUT. Queue authority/evidence are bounded in-memory contract fixtures;
// these cases do not qualify real QueueStore admission, replay or production.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {QueueDispatcher} from '../../dist/local/server/provider/dispatcher.js';
import {providerBoundary} from '../../dist/local/server/provider/client.js';
import {StoreError} from '../../dist/local/server/storage/errors.js';
import {fixtureProfile,SENTINEL_KEY} from './emulator.mjs';
import {egressAttempts} from './no-egress.mjs';

const MAX_EVIDENCE=65536,MAX_RECORDS=24,JOB='job_1',ATTEMPT='attempt_1',REQUEST='owned_request';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function evidenceBank(){
 const records=new Map(),active=new Set(),reads=[];let next=0;
 const create=(attemptId=ATTEMPT,direction='response')=>{
  assert(records.size+active.size<MAX_RECORDS,'bounded fixture record count');
  const id='control_record_'+(++next),chunks=[];let size=0,identity=null,policy=null,headers={},record=null;
  active.add(id);
  const sink={owner:Object.freeze({attemptId,direction}),get bytes(){return BigInt(size);},get identity(){return identity;},
   bindIdentity(value){assert.equal(record,null);identity=structuredClone(value);},
   bindPolicy(value){assert.equal(record,null);policy=structuredClone(value);},
   recordHeaders(value){assert.equal(record,null);headers=structuredClone(value);},
   prepare(total){assert(total>=0n&&total<=BigInt(MAX_EVIDENCE),'bounded fixture evidence');},
   append(bytes){assert.equal(record,null);assert(bytes instanceof Uint8Array);sink.prepare(BigInt(size+bytes.byteLength));chunks.push(Buffer.from(bytes));size+=bytes.byteLength;},
   digest(){return digest(Buffer.concat(chunks));},
   finish(complete,observed=BigInt(size)){
    if(record)return record;
    record=Object.freeze({class:'backend-transport',recordId:id,attemptId,direction,sha256:sink.digest(),receivedBytes:String(observed),completeness:complete?'complete':'partial',access:'backend-only',export:'never'});
    records.set(id,{body:Buffer.concat(chunks),metadata:{...record,retainedBytes:String(size),headers},policy});active.delete(id);return record;
   }
  };return sink;
 };
 return {active,reads,records,create,
  capture(raw,{complete=true}={}){const sink=create();sink.recordHeaders({'content-type':'application/json'});sink.append(Buffer.from(raw));return sink.finish(complete);},
  evidence:{
   records(attemptId){return [...records.values()].filter(value=>value.metadata.attemptId===attemptId&&value.metadata.direction==='response').map(value=>value.metadata.recordId);},
   inspect(id){assert(records.has(id));return structuredClone(records.get(id).metadata);},
   *read(id){assert(records.has(id));reads.push(id);yield Buffer.from(records.get(id).body);}
  }
 };
}

async function fixture(t,{endpoint='ideogram/v4.5',prefix=endpoint,resultSuffix=''}={}){
 const bank=evidenceBank(),requests=[],errors=[],sockets=new Set();let dispatcher,credentialReads=0,connections=0,origin='';
 const server=createServer((req,res)=>{void (async()=>{
  let length=0;for await(const chunk of req){length+=chunk.length;if(length>MAX_EVIDENCE)throw Error('Fixture request body exceeds bound');}
  const row={method:req.method,path:req.url,headers:req.headers,bytes:length};requests.push(row);
  if(req.method==='POST'||!['GET','PUT'].includes(req.method)){errors.push('Unexpected method '+req.method);res.writeHead(405);res.end();return;}
  if(length!==0){errors.push('Unexpected control request body');res.writeHead(400);res.end();return;}
  let value,status=200;
  if(req.method==='PUT'&&req.url===base+'/cancel'){status=202;value={status:'CANCELLATION_REQUESTED'};}
  else if(req.method==='GET'&&req.url===base+'/status')value={request_id:REQUEST,status:'IN_QUEUE'};
  else if(req.method==='GET'&&req.url===base+resultSuffix)value={images:[],seed:1};
  else {errors.push('Unexpected route '+req.method+' '+req.url);res.writeHead(404);res.end();return;}
  const bytes=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json','Content-Length':bytes.length});res.end(bytes);
 })().catch(error=>{errors.push(error.message);req.destroy();res.destroy();});});
 const base='/'+prefix+'/requests/'+REQUEST;
 server.on('connection',socket=>{connections++;sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 t.after(async()=>{
  dispatcher?.close();
  const socketClosures=[...sockets].map(socket=>new Promise(resolve=>socket.once('close',resolve)));
  const closed=server.listening?new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())):Promise.resolve();
  for(const socket of sockets)socket.destroy();await Promise.all([closed,...socketClosures]);
  assert.equal(server.listening,false);assert.equal(sockets.size,0);assert.equal(connections,requests.length,'no connection without an explicit control request');assert.equal(bank.active.size,0);assert.deepEqual(errors,[]);assert.equal(requests.filter(row=>row.method==='POST').length,0);assert.deepEqual(egressAttempts(),[]);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;
 const urls={status:origin+base+'/status',result:origin+base+resultSuffix,cancel:origin+base+'/cancel'};
 const state={epoch:'epoch_1',writerCurrent:true,endpoint,attempt:{id:ATTEMPT,state:'acknowledged',requestId:REQUEST,recoveryRequired:false,recoveryRequested:false,cancel:null,hold:true,count:'dispatched'},outbox:{urls:structuredClone(urls)}};
 const outcomes=[],inspections=[],fences=[];
 const check=(jobId,attemptId)=>{if(!state.writerCurrent||jobId!==JOB||attemptId!==ATTEMPT)throw new StoreError('STALE_EPOCH');};
 const queue={evidence:bank.evidence,
  controlFence(jobId,attemptId,action){check(jobId,attemptId);fences.push(action);const a=state.attempt;if(!a.requestId||a.recoveryRequired||(action==='cancel'&&a.cancel!=='requested'))throw new StoreError('STALE_EPOCH');return {jobId,attemptId,requestId:a.requestId,epoch:state.epoch,jobVersion:'1'};},
  recovery(jobId,attemptId){check(jobId,attemptId);return {jobId,documentId:'document_1',endpoint:state.endpoint,epoch:state.epoch,attempt:structuredClone(state.attempt),outbox:structuredClone(state.outbox)};},
  sink(attemptId,direction,policy){assert.equal(attemptId,ATTEMPT);assert.equal(direction,'response');const sink=bank.create(attemptId,direction);sink.bindPolicy(policy);return sink;},
  outcome(jobId,attemptId,epoch,value){check(jobId,attemptId);assert.equal(epoch,state.epoch);assert.equal(value.kind,'ack');outcomes.push(structuredClone(value));Object.assign(state.attempt,{state:'acknowledged',requestId:value.requestId});state.outbox.urls=structuredClone(value.urls);return structuredClone(state);},
  recoveryInspected(jobId,attemptId,message){check(jobId,attemptId);inspections.push(message);state.attempt.recoveryRequested=false;},
  view(){assert.fail('Control-only fixture cannot schedule jobs');},reserve(){assert.fail('No reservation is permitted');},dispatch(){assert.fail('No inference dispatch is permitted');}
 };
 const profile=fixtureProfile({endpoint}),provider=providerBoundary({mode:'fixture',queueOrigin:origin,mediaOrigins:[],profiles:[profile],allowResultResponseSuffix:true,
  credential:{queueKey(){credentialReads++;return SENTINEL_KEY;}},connection:{mode:'fixture',fixtureOrigins:[origin],resolve:async host=>{assert.equal(host,'127.0.0.1');return [{address:'127.0.0.1',family:4}];}}});
 dispatcher=new QueueDispatcher(queue,provider,{profileId:profile.id,queueOrigin:origin,allowResultResponseSuffix:true});
 const ack=(requestId=REQUEST,route=prefix)=>{const returned=origin+'/'+route+'/requests/'+requestId;return {request_id:requestId,status_url:returned+'/status',response_url:returned+resultSuffix,cancel_url:returned+'/cancel'};};
 return {state,bank,requests,outcomes,inspections,fences,origin,urls,dispatcher,profile,ack,get credentialReads(){return credentialReads;},get connections(){return connections;},
  requireRecovery(){state.attempt.recoveryRequired=true;},
  recover(){state.attempt.recoveryRequired=false;state.attempt.recoveryRequested=true;},
  requestCancel(){state.attempt.cancel='requested';},
  makeUncertain(){Object.assign(state.attempt,{state:'submission-uncertain',requestId:null,recoveryRequired:false,recoveryRequested:false});state.outbox.urls=null;}
 };
}

const routes=[['generation','ideogram/v4.5','ideogram/v4.5'],['edit schema path','ideogram/v4.5/edit','ideogram/v4.5/edit'],['edit root alias','ideogram/v4.5/edit','ideogram/v4.5']];
for(const [name,endpoint,prefix]of routes)for(const resultSuffix of ['', '/response'])test(name+' uses exact retained GET/PUT controls'+resultSuffix+' without inference submission',async t=>{
 const x=await fixture(t,{endpoint,prefix,resultSuffix});
 const status=await x.dispatcher.readKnown(JOB,ATTEMPT,'status'),result=await x.dispatcher.readKnown(JOB,ATTEMPT,'result');
 assert.equal(status.outcome,'complete');assert.equal(status.status,200);assert.equal(x.dispatcher.readControl(status.evidence.recordId).request_id,REQUEST);
 assert.equal(result.outcome,'complete');assert.deepEqual(x.dispatcher.readControl(result.evidence.recordId),{images:[],seed:1});
 await assert.rejects(x.dispatcher.readKnown(JOB,ATTEMPT,'cancel'),{code:'STALE_EPOCH'});assert.equal(x.requests.length,2);
 x.requestCancel();const before=structuredClone(x.state),cancel=await x.dispatcher.readKnown(JOB,ATTEMPT,'cancel');
 assert.equal(cancel.outcome,'complete');assert.equal(cancel.status,202);assert.equal(cancel.providerCancelled,false);assert.deepEqual(x.state,before,'transport does not publish terminal cancellation or release a hold');
 assert.deepEqual(x.requests.map(row=>[row.method,x.origin+row.path]),[['GET',x.urls.status],['GET',x.urls.result],['PUT',x.urls.cancel]]);assert.equal(x.credentialReads,3);
 for(const row of x.requests){assert.equal(row.bytes,0);assert.equal(row.headers.authorization,'Key '+SENTINEL_KEY);assert.equal(row.headers['x-fal-store-io'],'0');assert.equal(row.headers['x-fal-no-retry'],'1');assert.equal(row.headers['x-app-fal-disable-fallback'],'true');assert.equal(row.headers.cookie,undefined);}
 for(const receipt of [status,result,cancel]){const record=x.bank.records.get(receipt.evidence.recordId);assert.equal(record.metadata.retainedBytes,receipt.storedBytes);assert.equal(record.metadata.sha256,digest(record.body));assert.equal(record.policy.profileId,x.profile.id);assert.equal(record.metadata.attemptId,ATTEMPT);assert.equal(record.metadata.direction,'response');}
 assert.deepEqual(x.outcomes,[]);assert.deepEqual(x.inspections,[]);
});

test('writer/recovery/cancel control fences refuse before a sink, credential or socket is acquired',async t=>{
 const x=await fixture(t,{endpoint:'ideogram/v4.5/edit',prefix:'ideogram/v4.5'});
 x.state.writerCurrent=false;for(const action of ['status','result','cancel'])await assert.rejects(x.dispatcher.readKnown(JOB,ATTEMPT,action),{code:'STALE_EPOCH'});
 x.state.writerCurrent=true;x.requireRecovery();x.requestCancel();for(const action of ['status','result','cancel'])await assert.rejects(x.dispatcher.readKnown(JOB,ATTEMPT,action),{code:'STALE_EPOCH'});
 x.recover();for(const [jobId,attemptId]of [['other_job',ATTEMPT],[JOB,'other_attempt']])await assert.rejects(x.dispatcher.readKnown(jobId,attemptId,'status'),{code:'STALE_EPOCH'});
 x.state.attempt.cancel=null;await assert.rejects(x.dispatcher.readKnown(JOB,ATTEMPT,'cancel'),{code:'STALE_EPOCH'});
 assert.equal(x.bank.records.size,0);assert.equal(x.credentialReads,0);assert.equal(x.connections,0);assert.deepEqual(x.requests,[]);
 const status=await x.dispatcher.readKnown(JOB,ATTEMPT,'status');assert.equal(status.outcome,'complete');assert.equal(x.requests.length,1);assert.equal(x.requests[0].method,'GET');assert.equal(x.state.attempt.hold,true);
});

test('retained endpoint/request/origin mismatches refuse before credentials and cannot reroute V45 controls',async t=>{
 const x=await fixture(t,{endpoint:'ideogram/v4.5/edit',prefix:'ideogram/v4.5'}),base=x.origin+'/ideogram/v4.5/requests/';
 for(const url of [x.origin+'/ideogram/v4/requests/'+REQUEST+'/status',base+'other_request/status',base+REQUEST+'/cancel',base+REQUEST+'/status?token=fixture',base+REQUEST+'/status#fragment','https://queue.fal.run/ideogram/v4.5/requests/'+REQUEST+'/status',x.origin.replace('://','://user:pass@')+'/ideogram/v4.5/requests/'+REQUEST+'/status']){
  x.state.outbox.urls.status=url;await assert.rejects(x.dispatcher.readKnown(JOB,ATTEMPT,'status'),{code:'IDENTITY'},url);assert.equal(x.bank.active.size,0);
 }
 x.state.outbox.urls.status=x.urls.status;x.state.endpoint='ideogram/v4';await assert.rejects(x.dispatcher.readKnown(JOB,ATTEMPT,'status'),{code:'POLICY'});
 assert.equal(x.credentialReads,0);assert.equal(x.connections,0);assert.deepEqual(x.requests,[]);assert.deepEqual(x.outcomes,[]);
});

for(const [name,endpoint,prefix]of routes)test(name+' explicit retained-ACK recovery preserves identity without submission or implicit reads',async t=>{
 const x=await fixture(t,{endpoint,prefix});x.makeUncertain();const ack=x.ack(),retained=x.bank.capture(JSON.stringify(ack));x.bank.capture(JSON.stringify(ack));
 x.dispatcher.recoverRetained(JOB,ATTEMPT);assert.deepEqual(x.outcomes,[]);assert.deepEqual(x.bank.reads,[]);
 x.requireRecovery();x.state.attempt.recoveryRequested=true;x.dispatcher.recoverRetained(JOB,ATTEMPT);assert.deepEqual(x.outcomes,[]);assert.deepEqual(x.bank.reads,[]);
 x.recover();x.dispatcher.recoverRetained(JOB,ATTEMPT);assert.equal(x.outcomes.length,1);assert.deepEqual(x.outcomes[0],{kind:'ack',requestId:REQUEST,urls:x.urls,responseRecord:retained.recordId});
 assert.equal(x.state.attempt.requestId,REQUEST);assert.equal(x.state.attempt.state,'acknowledged');assert.equal(x.state.attempt.hold,true);assert.equal(x.state.attempt.count,'dispatched');assert.deepEqual(x.requests,[]);assert.equal(x.credentialReads,0);
 const reads=x.bank.reads.length;x.dispatcher.recoverRetained(JOB,ATTEMPT);assert.equal(x.bank.reads.length,reads);assert.equal(x.outcomes.length,1);
 const status=await x.dispatcher.readKnown(JOB,ATTEMPT,'status');assert.equal(status.outcome,'complete');assert.deepEqual(x.requests.map(row=>[row.method,x.origin+row.path]),[['GET',x.urls.status]]);
});

for(const conflict of ['different request IDs','different retained alias URLs'])test('conflicting V45 edit acknowledgments retain uncertainty: '+conflict,async t=>{
 const x=await fixture(t,{endpoint:'ideogram/v4.5/edit',prefix:'ideogram/v4.5'});x.makeUncertain();x.bank.capture(JSON.stringify(x.ack()));x.bank.capture(JSON.stringify(conflict==='different request IDs'?x.ack('another_request'):x.ack(REQUEST,'ideogram/v4.5/edit')));
 x.recover();x.dispatcher.recoverRetained(JOB,ATTEMPT);assert.deepEqual(x.outcomes,[]);assert.equal(x.inspections.length,1);assert.match(x.inspections[0],/Conflicting retained acknowledgements/);assert.equal(x.state.attempt.requestId,null);assert.equal(x.state.attempt.state,'submission-uncertain');assert.equal(x.state.attempt.hold,true);assert.equal(x.state.attempt.count,'dispatched');
 const reads=x.bank.reads.length;x.dispatcher.recoverRetained(JOB,ATTEMPT);assert.equal(x.bank.reads.length,reads);assert.equal(x.inspections.length,1);assert.deepEqual(x.requests,[]);assert.equal(x.credentialReads,0);
});

test('partial, oversized and wrong-identity retained evidence cannot select a V45 request',async t=>{
 const x=await fixture(t,{endpoint:'ideogram/v4.5/edit',prefix:'ideogram/v4.5'});x.makeUncertain();
 x.bank.capture(JSON.stringify(x.ack()),{complete:false});
 const oversized=x.bank.capture(JSON.stringify(x.ack()));x.bank.records.get(oversized.recordId).metadata.retainedBytes=String(MAX_EVIDENCE+1); // Inspection fault, not an oversized body allocation.
 const wrongEndpoint=x.ack(REQUEST,'ideogram/v4');x.bank.capture(JSON.stringify(wrongEndpoint));
 const wrongRequest=x.ack();wrongRequest.cancel_url=x.ack('another_request').cancel_url;x.bank.capture(JSON.stringify(wrongRequest));
 x.recover();x.dispatcher.recoverRetained(JOB,ATTEMPT);assert.deepEqual(x.outcomes,[]);assert.equal(x.inspections.length,1);assert.match(x.inspections[0],/No validated acknowledgement/);assert.equal(x.bank.reads.includes(oversized.recordId),false);assert.equal(x.bank.reads.length,2);assert.equal(x.state.attempt.requestId,null);assert.equal(x.state.attempt.hold,true);assert.deepEqual(x.requests,[]);assert.equal(x.credentialReads,0);
});

test('maximum bounded complete retained ACK is inspected exactly and recovered once',async t=>{
 const x=await fixture(t),raw=JSON.stringify(x.ack());x.makeUncertain();const record=x.bank.capture(raw+' '.repeat(MAX_EVIDENCE-Buffer.byteLength(raw)));
 assert.equal(x.bank.evidence.inspect(record.recordId).retainedBytes,String(MAX_EVIDENCE));assert.equal(x.bank.records.get(record.recordId).body.length,MAX_EVIDENCE);assert.equal(x.bank.evidence.inspect(record.recordId).sha256,digest(x.bank.records.get(record.recordId).body));
 x.recover();x.dispatcher.recoverRetained(JOB,ATTEMPT);x.dispatcher.recoverRetained(JOB,ATTEMPT);assert.equal(x.outcomes.length,1);assert.deepEqual(x.bank.reads,[record.recordId]);assert.deepEqual(x.requests,[]);assert.equal(x.credentialReads,0);assert.equal(x.state.attempt.hold,true);
});
