import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { storage } from './support.mjs';
import { emulator, fixtureProfile, SENTINEL_KEY } from './emulator.mjs';
import { egressAttempts } from './no-egress.mjs';
import { providerBoundary } from '../../dist/local/server/provider/client.js';
import { IO_CHUNK } from '../../dist/local/server/provider/contracts.js';

const emptyDigest=createHash('sha256').digest('hex');
const reply=Buffer.from('stored');

// The receiver retains only counters, headers, and a rolling hash, even for the
// large upload. It never captures or joins request-body chunks.
async function receiver(t,{onData}={}) {
  const requests=[],sockets=new Set(),firstData=Promise.withResolvers();
  const server=http.createServer((req,res)=>{
    const hash=createHash('sha256');
    const record={method:req.method,url:req.url,headers:req.headers,bytes:0n,chunks:0,maxChunk:0,sha256:null,complete:false};
    requests.push(record);
    const snapshot=()=>{record.sha256=hash.copy().digest('hex');};
    req.on('data',chunk=>{
      record.bytes+=BigInt(chunk.byteLength);record.chunks++;record.maxChunk=Math.max(record.maxChunk,chunk.byteLength);hash.update(chunk);
      firstData.resolve();onData?.(req,res,record);
    });
    req.on('error',snapshot);
    req.on('close',snapshot);
    req.on('end',()=>{
      record.complete=true;snapshot();
      if(!res.destroyed){res.writeHead(200,{'Content-Length':reply.byteLength,'Content-Type':'application/octet-stream'});res.end(reply);}
    });
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{
    const closed=new Promise(resolve=>server.close(resolve));
    const socketClosures=[...sockets].map(socket=>new Promise(resolve=>socket.once('close',resolve)));
    for(const socket of sockets)socket.destroy();
    await Promise.all([closed,...socketClosures]);
    assert.equal(server.listening,false);assert.equal(sockets.size,0);
    assert.deepEqual(egressAttempts(),[]);
  });
  return {origin:`http://127.0.0.1:${server.address().port}`,requests,firstData:firstData.promise};
}
function provider(f,options={}) { return emulator({queueOrigin:f.origin,mediaOrigin:f.origin,uploadOrigin:f.origin,...options}); }
function attempt(s) { return {attemptId:s.attemptId,identity:{endpoint:'ideogram/v4'},profileId:'local-fixture-v1'}; }
function captured(s,byteLength,chunks) {
  const reservation=s.reservation('provider-request');
  const sink=s.store.begin(s.attemptId,'request',reservation,s.policy);
  const stats={appends:0,maxChunk:0,prepared:[],finishes:[],record:null};
  const evidence={
    get owner(){return sink.owner;},get bytes(){return sink.bytes;},get identity(){return sink.identity;},
    bindIdentity:value=>sink.bindIdentity(value),recordHeaders:headers=>sink.recordHeaders(headers),bindPolicy:value=>sink.bindPolicy(value),
    prepare(total){stats.prepared.push(total);sink.prepare(total);},
    append(bytes){stats.appends++;stats.maxChunk=Math.max(stats.maxChunk,bytes.byteLength);sink.append(bytes);},
    digest:()=>sink.digest(),
    finish(complete,observed){stats.finishes.push(complete);return stats.record=sink.finish(complete,observed);}
  };
  return {request:{byteLength,chunks,evidence},stats,reservation};
}
function assertEvidence(s,c,{complete,bytes,hash}) {
  assert.ok(c.stats.record,'request evidence was finalized');
  const saved=s.store.inspect(c.stats.record.recordId);
  assert.equal(saved.direction,'request');assert.equal(saved.attemptId,s.attemptId);
  assert.equal(saved.completeness,complete?'complete':'partial');
  if(bytes!==undefined)assert.equal(saved.retainedBytes,String(bytes));
  if(hash!==undefined)assert.equal(saved.sha256,hash);
  const retainedHash=createHash('sha256');let retainedBytes=0n;
  for(const chunk of s.store.read(saved.recordId)){
    assert.ok(chunk.byteLength<=IO_CHUNK);retainedHash.update(chunk);retainedBytes+=BigInt(chunk.byteLength);
  }
  assert.equal(retainedBytes,BigInt(saved.retainedBytes));assert.equal(retainedHash.digest('hex'),saved.sha256);
  assert.equal(c.reservation.state().released,true,'request reservation released');
  assert.ok(c.stats.maxChunk<=IO_CHUNK,'evidence writes stay bounded');
  return saved;
}
function assertInterrupted(result,code) {
  assert.equal(result.outcome,'interrupted');assert.equal(result.failure,code);
  assert.equal(result.evidence.completeness,'partial');assert.equal(result.providerCancelled,false);
}

test('a generated upload above 100 MiB streams once with fixed length and exact retained evidence',async t=>{
  const f=await receiver(t),s=storage(t),p=provider(f);
  const chunk=Buffer.alloc(IO_CHUNK,0x6d),count=101,total=BigInt(chunk.byteLength)*BigInt(count);
  let opened=0,yielded=0,closed=0;
  const expected=createHash('sha256');for(let i=0;i<count;i++)expected.update(chunk);
  const digest=expected.digest('hex');
  const c=captured(s,total,function*(){opened++;try{for(let i=0;i<count;i++){yielded++;yield chunk;}}finally{closed++;}});
  const result=await p.upload(f.origin+'/upload',attempt(s),c.request,s.sink());
  assert.equal(result.outcome,'complete');assert.equal(result.failure,null);
  assert.equal(opened,1);assert.equal(yielded,count);assert.equal(closed,1);
  assert.equal(c.stats.appends,count);assert.equal(c.stats.maxChunk,IO_CHUNK);assert.deepEqual(c.stats.prepared,[total]);
  assert.equal(c.reservation.state().reserved,total);assert.equal(c.reservation.state().committed,total);
  const saved=assertEvidence(s,c,{complete:true,bytes:total,hash:digest});
  assert.equal(saved.receivedBytes,String(total));assert.equal(saved.headers['content-length'],String(total));
  assert.equal(saved.headers['content-type'],'application/octet-stream');
  assert.equal(f.requests.length,1,'one request, with no retry');
  const received=f.requests[0];
  assert.equal(received.method,'POST');assert.equal(received.url,'/upload');assert.equal(received.complete,true);
  assert.equal(received.bytes,total);assert.equal(received.sha256,digest);
  assert.equal(received.headers['content-length'],String(total));assert.equal(received.headers['transfer-encoding'],undefined);
  assert.equal(received.headers.authorization,'Key '+SENTINEL_KEY);assert.ok(received.chunks>=count);
});

test('asynchronous upload source captures independent snapshots of its reused buffer',async t=>{
  const f=await receiver(t),s=storage(t),chunk=Buffer.alloc(8192),expected=createHash('sha256');let opened=0,yielded=0;
  for(let i=0;i<4;i++){chunk.fill(i);expected.update(chunk);}
  const digest=expected.digest('hex'),total=4n*BigInt(chunk.byteLength);
  const c=captured(s,total,async function*(){opened++;for(let i=0;i<4;i++){await nextTurn();chunk.fill(i);yielded++;yield chunk;}});
  const result=await provider(f).upload(f.origin+'/upload',attempt(s),c.request,s.sink());
  assert.equal(result.outcome,'complete');assert.equal(opened,1);assert.equal(yielded,4);
  assertEvidence(s,c,{complete:true,bytes:total,hash:digest});
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].bytes,total);assert.equal(f.requests[0].sha256,digest);
  assert.equal(f.requests[0].headers['transfer-encoding'],undefined);
});

test('source interruption retains an honest request prefix and never retries',async t=>{
  const f=await receiver(t),s=storage(t),chunk=Buffer.from('generated-prefix');let opened=0,closed=0;
  const c=captured(s,BigInt(chunk.byteLength*2),async function*(){opened++;try{yield chunk;await f.firstData;throw Error('fixture generator interrupted');}finally{closed++;}});
  const result=await provider(f).upload(f.origin+'/upload',attempt(s),c.request,s.sink());
  assertInterrupted(result,'INTERRUPTED');assert.equal(opened,1);assert.equal(closed,1);
  assertEvidence(s,c,{complete:false,bytes:BigInt(chunk.byteLength),hash:createHash('sha256').update(chunk).digest('hex')});
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].bytes,BigInt(chunk.byteLength));
});

for(const cause of ['network','cancellation'])test(`${cause} interruption stops a pending source and preserves partial request evidence`,async t=>{
  const controller=new AbortController(),resume=Promise.withResolvers(),chunk=Buffer.from('in-flight-prefix');
  const f=await receiver(t,{onData:req=>{if(cause==='network')req.destroy();else controller.abort();}}),s=storage(t);
  let opened=0,yielded=0,closed=0;
  const c=captured(s,BigInt(chunk.byteLength*2),async function*(){
    opened++;try{yielded++;yield chunk;await resume.promise;yielded++;yield chunk;}finally{closed++;}
  });
  let result;
  try{result=await provider(f,{readMs:500}).upload(f.origin+'/upload',attempt(s),c.request,s.sink(),controller.signal);}
  finally{resume.resolve();await nextTurn();}
  assertInterrupted(result,cause==='network'?'INTERRUPTED':'ABORTED');
  assert.equal(opened,1);assert.equal(closed,1);assert.ok(yielded<=2);assert.equal(c.stats.appends,1);
  assertEvidence(s,c,{complete:false,bytes:BigInt(chunk.byteLength),hash:createHash('sha256').update(chunk).digest('hex')});
  assert.equal(f.requests.length,1,'interruption does not resubmit');
});

for(const kind of ['underflow','overflow'])test(`declared upload length ${kind} is rejected without completing request evidence`,async t=>{
  const f=await receiver(t),s=storage(t),prefix=Buffer.from('abc');let opened=0,closed=0;
  const c=captured(s,kind==='underflow'?4n:3n,function*(){opened++;try{yield prefix;if(kind==='overflow')yield Buffer.from('d');}finally{closed++;}});
  const result=await provider(f).upload(f.origin+'/upload',attempt(s),c.request,s.sink());
  assertInterrupted(result,'LENGTH');assert.equal(opened,1);assert.equal(closed,1);
  assertEvidence(s,c,{complete:false,bytes:3n,hash:createHash('sha256').update(prefix).digest('hex')});
  assert.equal(c.stats.appends,1);assert.ok(f.requests.length<=1,'length errors never retry');
});

test('an upload source chunk above 1 MiB is rejected before capture or transmission',async t=>{
  const f=await receiver(t),s=storage(t);let opened=0,closed=0;
  const c=captured(s,BigInt(IO_CHUNK+1),function*(){opened++;try{yield Buffer.alloc(IO_CHUNK+1);}finally{closed++;}});
  const result=await provider(f).upload(f.origin+'/upload',attempt(s),c.request,s.sink());
  assertInterrupted(result,'LENGTH');assert.equal(opened,1);assert.equal(closed,1);assert.equal(c.stats.appends,0);
  assertEvidence(s,c,{complete:false,bytes:0n,hash:emptyDigest});assert.equal(f.requests.length,0);
});

test('an empty yielded upload chunk is rejected without another source read or write',async t=>{
  const f=await receiver(t),s=storage(t);let opened=0,readsAfterEmpty=0,closed=0;
  const c=captured(s,1n,function*(){
    opened++;try{yield Buffer.alloc(0);readsAfterEmpty++;yield Buffer.from('x');}finally{closed++;}
  });
  const result=await provider(f).upload(f.origin+'/upload',attempt(s),c.request,s.sink());
  assertInterrupted(result,'LENGTH');assert.equal(opened,1);assert.equal(readsAfterEmpty,0);assert.equal(closed,1);
  assert.equal(c.stats.appends,0);assertEvidence(s,c,{complete:false,bytes:0n,hash:emptyDigest});
  assert.equal(f.requests.length,0);
});

test('a zero-byte upload completes when its source ends without yielding chunks',async t=>{
  const f=await receiver(t),s=storage(t);let opened=0;
  const c=captured(s,0n,function*(){opened++;});
  const result=await provider(f).upload(f.origin+'/upload',attempt(s),c.request,s.sink());
  assert.equal(result.outcome,'complete');assert.equal(result.failure,null);assert.equal(opened,1);assert.equal(c.stats.appends,0);
  assertEvidence(s,c,{complete:true,bytes:0n,hash:emptyDigest});assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].bytes,0n);assert.equal(f.requests[0].headers['content-length'],'0');
  assert.equal(f.requests[0].headers['transfer-encoding'],undefined);
});

for(const failure of ['DNS','credential','policy','capacity','pre-aborted'])test(`${failure} failure before upload closes evidence without opening the source`,async t=>{
  const f=await receiver(t),s=storage(t,failure==='capacity'?2n:1n<<40n);let opened=0,credentialCalls=0;
  const c=captured(s,3n,function*(){opened++;yield Buffer.from('abc');});
  let p;
  if(failure==='credential')p=providerBoundary({
    mode:'fixture',queueOrigin:f.origin,mediaOrigins:[f.origin],uploadOrigin:f.origin,profiles:[fixtureProfile()],
    credential:{queueKey(){credentialCalls++;return 'invalid\r\nkey';}},
    connection:{mode:'fixture',fixtureOrigins:[f.origin],resolve:async()=>[{address:'127.0.0.1',family:4}]}
  });
  else p=provider(f,failure==='DNS'?{resolve:async()=>[{address:'127.0.0.2',family:4}]}:{});
  const sink=s.sink(),controller=new AbortController();if(failure==='pre-aborted')controller.abort();
  if(failure==='policy'){
    assert.throws(()=>p.upload(f.origin+'/unapproved-upload',attempt(s),c.request,sink),error=>error.code==='POLICY');
  }else{
    const expected={DNS:'ADDRESS',credential:'POLICY',capacity:'CAPACITY','pre-aborted':'ABORTED'}[failure];
    assertInterrupted(await p.upload(f.origin+'/upload',attempt(s),c.request,sink,controller.signal),expected);
  }
  assert.equal(opened,0);assert.equal(c.stats.appends,0);assert.ok(c.stats.finishes.includes(false));assert.equal(c.stats.finishes.includes(true),false);
  assertEvidence(s,c,{complete:false,bytes:0n,hash:emptyDigest});assert.equal(f.requests.length,0);
  if(failure==='credential')assert.equal(credentialCalls,1);
});

test('streaming sources do not enable production uploads',async t=>{
  const f=await receiver(t),s=storage(t);let opened=0,credentialCalls=0;
  const c=captured(s,3n,function*(){opened++;yield Buffer.from('abc');});
  const p=providerBoundary({
    mode:'production',queueOrigin:f.origin,mediaOrigins:[f.origin],uploadOrigin:f.origin,
    profiles:[fixtureProfile({mode:'production',enforcement:'documented'})],
    credential:{queueKey(){credentialCalls++;return SENTINEL_KEY;}},connection:{mode:'production'}
  });
  assert.throws(()=>p.upload(f.origin+'/upload',attempt(s),c.request,s.sink()),error=>error.code==='POLICY');
  assert.equal(opened,0);assert.equal(credentialCalls,0);assert.equal(f.requests.length,0);
  assertEvidence(s,c,{complete:false,bytes:0n,hash:emptyDigest});
});

test('an unknown media origin closes the response reservation before DNS or transmission',async t=>{
  const f=await receiver(t),s=storage(t);let resolutions=0;
  const p=provider(f,{resolve:async()=>{resolutions++;return [{address:'127.0.0.1',family:4}];}});
  const reservation=s.reservation('provider-response');
  const sink=s.store.begin(s.attemptId,'response',reservation,s.policy);
  assert.throws(()=>p.media('https://unapproved.invalid/object',sink),error=>error.code==='POLICY');
  assert.equal(reservation.state().released,true);assert.equal(sink.bytes,0n);
  assert.equal(resolutions,0);assert.equal(f.requests.length,0);
});
