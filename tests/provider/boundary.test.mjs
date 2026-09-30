import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { storage,assertCode } from './support.mjs';
import { emulator,SENTINEL_KEY,SENTINEL_COOKIE,fixtureProfile } from './emulator.mjs';
import { connectBound,createWireTransport } from '../../dist/local/server/provider/transport.js';
import { egressAttempts } from './no-egress.mjs';
const ca=readFileSync(new URL('./fixtures/localhost-cert.pem',import.meta.url),'utf8');
const key=readFileSync(new URL('./fixtures/localhost-key.pem',import.meta.url),'utf8');
const payload=Buffer.from('fixture-media-exact');
const digest=createHash('sha256').update(payload).digest('hex');
async function fixture(t,{secure=false,handler}={}){
 const requests=[],sockets=new Set(),timers=new Set();
 const server=(secure?https.createServer.bind(https,{key,cert:ca}):http.createServer.bind(http))((req,res)=>{
  const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
   requests.push({url:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString()});
   if(handler){handler(req,res,timers);return;}
   if(req.url==='/redirect'){res.writeHead(302,{Location:'http://169.254.169.254/latest/meta-data'});res.end();}
   else if(req.url==='/short'){res.writeHead(200,{'Content-Length':100});res.flushHeaders();res.write('abc');const timer=setTimeout(()=>res.destroy(),20);timers.add(timer);}
   else if(req.url==='/stall'){res.writeHead(200,{'Content-Length':100});res.flushHeaders();res.write('abc');}
   else if(req.url==='/expired'){res.writeHead(410);res.end('expired');}
   else if(req.url==='/range'){
    if(req.headers.range){res.writeHead(206,{'Content-Length':payload.length-3,'Content-Range':`bytes 3-${payload.length-1}/${payload.length}`,ETag:'"fixture-v1"'});res.end(payload.subarray(3));}
    else {res.writeHead(200,{'Content-Length':payload.length,ETag:'"fixture-v1"'});res.write(payload.subarray(0,3));const timer=setTimeout(()=>res.destroy(),20);timers.add(timer);}
   }else if(req.url==='/changed'){res.writeHead(206,{'Content-Length':payload.length-3,'Content-Range':`bytes 3-${payload.length-1}/${payload.length}`,ETag:'"fixture-v2"'});res.end(payload.subarray(3));}
   else if(req.url?.startsWith('/ideogram/v4')){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"request_id":"local-request"}');}
   else if(req.url==='/chunked'){res.writeHead(200);res.write(payload.subarray(0,3));res.end(payload.subarray(3));}
   else {res.writeHead(200,{'Content-Length':payload.length,ETag:'"fixture-v1"'});res.end(payload);}
  });
 });
 server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
 server.on('tlsClientError',()=>{});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const origin=`${secure?'https':'http'}://${secure?'localhost':'127.0.0.1'}:${server.address().port}`;
 t.after(async()=>{for(const timer of timers)clearTimeout(timer);const socketClosures=[...sockets].map(socket=>new Promise(resolve=>socket.once('close',resolve)));const closed=new Promise(resolve=>server.close(resolve));for(const socket of sockets)socket.destroy();await Promise.all([closed,...socketClosures]);assert.equal(server.listening,false);assert.equal(sockets.size,0,'all owned sockets closed');});
 return {origin,requests,server,sockets};
}
function attempt(s){return {attemptId:s.attemptId,identity:{endpoint:'ideogram/v4'},profileId:'local-fixture-v1'};}
function provider(f,options={}){return emulator({queueOrigin:f.origin,mediaOrigin:f.origin,uploadOrigin:f.origin,ca,...options});}
test('HTTP queue and upload receive sentinel credentials; media receives none or ambient proxy state',async t=>{
 const f=await fixture(t),s=storage(t),p=provider(f),a=attempt(s);
 const old={};for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy']){old[name]=process.env[name];process.env[name]='http://127.0.0.1:1';}
 try{
  const submit=await p.queue(a,'submit',s.sink(),s.request('{"prompt":"fixture"}'));assert.equal(submit.outcome,'complete');
  const upload=await p.upload(f.origin+'/upload',a,s.request('owned source'),s.sink());assert.equal(upload.outcome,'complete');
  const media=await p.media(f.origin+'/ok?sig=fixture-signed-query',s.sink(),{expectedHash:digest,expectedBytes:BigInt(payload.length)});assert.equal(media.outcome,'complete');
 }finally{for(const [name,value]of Object.entries(old)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
 assert.equal(f.requests.length,3);
 for(const r of f.requests.slice(0,2)){assert.equal(r.headers.authorization,'Key '+SENTINEL_KEY);assert.equal(r.headers['x-fal-store-io'],'0');assert.equal(r.headers['x-fal-object-lifecycle-preference'],'{"expiration_duration_seconds":60,"initial_acl":"fixture-private"}');}
 const media=f.requests[2];for(const header of ['authorization','cookie','proxy-authorization','x-fal-store-io'])assert.equal(media.headers[header],undefined);
 assert.equal(media.headers['accept-encoding'],'identity');assert.deepEqual(egressAttempts(),[]);
});
test('real local TLS verifies fixture CA and original host before sending credentials',async t=>{
 const f=await fixture(t,{secure:true}),s=storage(t),p=provider(f);
 const r=await p.queue(attempt(s),'submit',s.sink(),s.request('{}'));assert.equal(r.outcome,'complete');assert.equal(f.requests.length,1);assert.equal(f.requests[0].headers.authorization,'Key '+SENTINEL_KEY);
});
test('TLS wrong hostname and untrusted certificate send no request or credential',async t=>{
 const f=await fixture(t,{secure:true}),s=storage(t);
 const ipOrigin=f.origin.replace('localhost','127.0.0.1');
 for(const [origin,trust]of [[ipOrigin,ca],[f.origin,undefined]]){
  const p=emulator({queueOrigin:origin,mediaOrigin:origin,ca:trust});const r=await p.queue(attempt(s),'submit',s.sink(),s.request('{}'));
  assert.equal(r.outcome,'interrupted');assert.equal(r.failure,'TLS');assert.equal(r.storedBytes,'0');
 }
 assert.equal(f.requests.length,0);
});
test('queue-returned cross-origin, wrong identity and media userinfo are denied before socket',async t=>{
 const f=await fixture(t),s=storage(t),p=provider(f),a={...attempt(s),identity:{endpoint:'ideogram/v4',requestId:'r1'}};
 for(const raw of ['https://queue.fal.run/ideogram/v4/requests/r1',f.origin+'/ideogram/v4/requests/r2',f.origin+'/ideogram/v4/requests/r1?token=x']){
  const sink=s.sink();assertCode(()=>p.queue(a,'result',sink,undefined,raw),'IDENTITY');sink.finish(false);
 }
 const sink=s.sink();assertCode(()=>p.media(f.origin.replace('://','://user:pass@')+'/ok',sink),'IDENTITY');sink.finish(false);assert.equal(f.requests.length,0);
});
test('redirects are zero-hop for both credential-bearing and credential-free traffic',async t=>{
 const f=await fixture(t,{handler:(_req,res)=>{res.writeHead(307,{Location:'http://169.254.169.254/private'});res.end('redirect body');}}),s=storage(t),p=provider(f);
 for(const r of [await p.queue(attempt(s),'submit',s.sink(),s.request('{}')),await p.media(f.origin+'/redirect',s.sink())]){
  assert.equal(r.failure,'REDIRECT');assert.equal(r.outcome,'interrupted');assert.equal(r.storedBytes,'0');assert.equal(r.providerCancelled,false);
 }
 assert.equal(f.requests.length,2);assert.deepEqual(egressAttempts(),[]);
});
test('production DNS mixed answer rejects before TCP; DNS change is revalidated per connection',async t=>{
 const f=await fixture(t),s=storage(t);let calls=0;
 await assert.rejects(connectBound(new URL('https://queue.fal.run/'),{mode:'production',resolve:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]},new AbortController().signal),e=>e.code==='ADDRESS');
 const p=provider(f,{resolve:async()=>[{address:++calls===1?'127.0.0.1':'127.0.0.2',family:4}]});
 assert.equal((await p.media(f.origin+'/ok',s.sink())).outcome,'complete');assert.equal((await p.media(f.origin+'/ok',s.sink())).failure,'ADDRESS');assert.equal(calls,2);assert.equal(f.requests.length,1);
});
test('actual connection uses numerical pinned address with one resolution',async t=>{
 const f=await fixture(t,{secure:true}),s=storage(t);let calls=0;
 const p=provider(f,{resolve:async host=>{assert.equal(host,'localhost');calls++;return [{address:'127.0.0.1',family:4}];}});
 assert.equal((await p.media(f.origin+'/ok',s.sink())).outcome,'complete');assert.equal(calls,1);assert.deepEqual(egressAttempts(),[]);
});
test('peer-check fault on a real socket refuses before HTTP headers',async t=>{
 const f=await fixture(t),s=storage(t),original=net.connect;
 net.connect=function(...args){const socket=original.apply(this,args);Object.defineProperty(socket,'remoteAddress',{get:()=> '127.0.0.2'});return socket;};
 try{const r=await provider(f).queue(attempt(s),'submit',s.sink(),s.request('{}'));assert.equal(r.failure,'PEER');}finally{net.connect=original;}
 assert.equal(f.requests.length,0);
});
test('unknown-length stream counts actual bytes and retains exact hash',async t=>{
 const f=await fixture(t),s=storage(t),r=await provider(f).media(f.origin+'/chunked',s.sink());
 assert.equal(r.outcome,'complete');assert.equal(r.declaredBytes,null);assert.equal(r.receivedBytes,String(payload.length));assert.equal(r.sha256,digest);
});
test('declared oversize refuses reservation before storing; unknown size retains honest prefix',async t=>{
 const f=await fixture(t),s=storage(t),p=provider(f);
 const known=await p.media(f.origin+'/ok',s.sink(3n));assert.equal(known.failure,'CAPACITY');assert.equal(known.storedBytes,'0');
 const unknown=await p.media(f.origin+'/chunked',s.sink(3n));assert.equal(unknown.failure,'CAPACITY');assert.ok(BigInt(unknown.receivedBytes)>3n);assert.ok(BigInt(unknown.storedBytes)<=3n);assert.equal(unknown.evidence.completeness,'partial');
});
test('truncated length and wrong hash remain partial and never imply provider cancellation',async t=>{
 const f=await fixture(t),s=storage(t),p=provider(f);
 const short=await p.media(f.origin+'/short',s.sink());assert.equal(short.outcome,'interrupted');assert.equal(short.storedBytes,'3');assert.equal(short.declaredBytes,'100');assert.equal(short.evidence.completeness,'partial');
 const bad=await p.media(f.origin+'/ok',s.sink(),{expectedHash:'f'.repeat(64)});assert.equal(bad.failure,'HASH');assert.equal(bad.evidence.completeness,'partial');assert.equal(bad.providerCancelled,false);
});
test('no-progress deadline retains prefix, releases reservation and closes only local connection',async t=>{
 const f=await fixture(t),s=storage(t),r=await provider(f,{readMs:80}).media(f.origin+'/stall',s.sink());
 assert.equal(r.failure,'READ_TIMEOUT');assert.equal(r.storedBytes,'3');assert.equal(r.evidence.completeness,'partial');assert.equal(r.providerCancelled,false);assert.equal(f.requests.length,1);
});
test('connection deadline includes unresolved DNS, with late resolution unable to connect',async t=>{
 const f=await fixture(t),s=storage(t);let resolveDNS;
 const p=provider(f,{connectMs:30,resolve:()=>new Promise(resolve=>{resolveDNS=resolve;})});
 const r=await p.media(f.origin+'/ok',s.sink());assert.equal(r.failure,'CONNECT_TIMEOUT');
 resolveDNS([{address:'127.0.0.1',family:4}]);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.requests.length,0);
});
test('resume requires exact strong ETag, range and total, and hashes complete retained object',async t=>{
 const f=await fixture(t),s=storage(t),p=provider(f);const first=await p.media(f.origin+'/range',s.sink());assert.equal(first.outcome,'interrupted');assert.equal(first.storedBytes,'3');
 const resumed=s.store.resume(first.evidence.recordId,s.reservation());
 const result=await p.media(f.origin+'/range',resumed,{resume:{offset:3n,etag:'"fixture-v1"',total:BigInt(payload.length)},expectedHash:digest});
 assert.equal(result.outcome,'complete');assert.equal(result.sha256,digest);assert.equal(Buffer.concat([...s.store.read(first.evidence.recordId)]).toString(),payload.toString());
 assert.equal(f.requests[1].headers.range,'bytes=3-');assert.equal(f.requests[1].headers['if-range'],'"fixture-v1"');
});
test('changed resume identity never appends or resubmits provider work',async t=>{
 let count=0;const f=await fixture(t,{handler:(_req,res,timers)=>{if(++count===1){res.writeHead(200,{'Content-Length':payload.length,ETag:'"fixture-v1"'});res.write(payload.subarray(0,3));timers.add(setTimeout(()=>res.destroy(),20));}else{res.writeHead(206,{'Content-Length':payload.length-3,'Content-Range':`bytes 3-${payload.length-1}/${payload.length}`,ETag:'"fixture-v2"'});res.end(payload.subarray(3));}}}),s=storage(t),p=provider(f);const first=await p.media(f.origin+'/range',s.sink());
 const resumed=s.store.resume(first.evidence.recordId,s.reservation());const r=await p.media(f.origin+'/range',resumed,{resume:{offset:3n,etag:'"fixture-v1"',total:BigInt(payload.length)}});
 assert.equal(r.failure,'IDENTITY');assert.equal(r.storedBytes,'0');assert.equal(Buffer.concat([...s.store.read(first.evidence.recordId)]).toString(),payload.subarray(0,3).toString());assert.equal(f.requests.length,2);assert.ok(f.requests.every(r=>r.method==='GET'));
});
test('unsupported privacy blocks before any wire request',async t=>{
 const f=await fixture(t),s=storage(t),p=provider(f,{profiles:[fixtureProfile({deferredFetch:'unknown'})]});const sink=s.sink();
 const request=s.request('{}');assertCode(()=>p.queue(attempt(s),'submit',sink,request),'POLICY');request.evidence.finish(false);sink.finish(false);assert.equal(f.requests.length,0);
});
test('expiry is a retained HTTP observation, not erasure or successful media recovery',async t=>{
 const f=await fixture(t),s=storage(t),r=await provider(f).media(f.origin+'/expired',s.sink());
 assert.equal(r.status,410);assert.equal(r.evidence.completeness,'complete');assert.equal(r.providerCancelled,false);
 assert.equal(Buffer.concat([...s.store.read(r.evidence.recordId)]).toString(),'expired');
});
test('request evidence is captured before dispatch and matches bytes despite caller mutation',async t=>{
 const f=await fixture(t),s=storage(t),a=attempt(s),request=s.request('{"prompt":"original"}'),sink=s.sink();let release;
 const p=provider(f,{resolve:()=>new Promise(resolve=>{release=resolve;})});const pending=p.queue(a,'submit',sink,request);
 const requestRecord=request.evidence.finish(true);request.bytes.fill(120);release([{address:'127.0.0.1',family:4}]);
 const receipt=await pending;assert.equal(receipt.outcome,'complete');assert.equal(f.requests[0].body,'{"prompt":"original"}');
 assert.equal(Buffer.concat([...s.store.read(requestRecord.recordId)]).toString(),f.requests[0].body);assert.equal(requestRecord.attemptId,a.attemptId);
});
test('applied fallback policy is persisted exactly with the outgoing wire headers',async t=>{
 const f=await fixture(t),s=storage(t),profile=fixtureProfile({deferredFetch:'unknown',fallback:{id:'fallback1',disclosureDigest:'b'.repeat(64),lifecycleSeconds:120,acl:'fixture-public'}}),a=attempt(s);
 a.acknowledgement={id:'ack1',attemptId:a.attemptId,profileId:profile.id,profileVersion:1,evidenceDigest:profile.evidenceDigest,fallbackId:'fallback1',disclosureDigest:'b'.repeat(64)};
 const result=await provider(f,{profiles:[profile]}).queue(a,'submit',s.sink(),s.request('{}'));
 assert.equal(result.outcome,'complete');const saved=s.store.inspect(result.evidence.recordId).policy;
 assert.equal(saved.appliedLifecycleSeconds,120);assert.equal(saved.appliedACL,'fixture-public');assert.equal(saved.fallbackAcknowledgementId,'ack1');
 assert.deepEqual(JSON.parse(f.requests[0].headers['x-fal-object-lifecycle-preference']),{expiration_duration_seconds:saved.appliedLifecycleSeconds,initial_acl:saved.appliedACL});
});
test('real response secrets remain only in protected body; prompt quarantine blocks complete copy',async t=>{
 const raw=JSON.stringify({prompt:'escaped\n'+SENTINEL_KEY,seed:5,images:[{url:'https://unsupported.test/file?sig=fixture-signature'}],error:SENTINEL_COOKIE});
 const f=await fixture(t,{handler:(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':SENTINEL_COOKIE,'X-Error':SENTINEL_KEY});res.end(raw);}}),s=storage(t);
 const result=await provider(f).queue(attempt(s),'submit',s.sink(),s.request('{}'));assert.equal(result.outcome,'complete');
 const {deriveProvenance,portableCopyRecord,redactedRecoveryRecord}=await import('../../dist/local/server/provider/provenance.js');
 const derived=deriveProvenance({store:s.store,source:result.evidence,promptSink:s.sink(),endpoint:'ideogram/v4',requestId:'r',status:'completed',policy:s.policy,knownTransportSecrets:[SENTINEL_KEY,SENTINEL_COOKIE]});
 assert.equal(derived.quarantined,true);assertCode(()=>portableCopyRecord(derived),'PROVENANCE');
 assert.equal(Buffer.concat([...s.store.read(result.evidence.recordId)]).toString(),raw);assert.deepEqual(s.store.inspect(result.evidence.recordId).headers,{'content-type':'application/json'});
 assert.equal(JSON.stringify(redactedRecoveryRecord(derived,'ack')).includes(SENTINEL_KEY),false);
});
test('response with falsely short HTTP length is not accepted as a complete body',async t=>{
 const f=await fixture(t,{handler:(req,res)=>{req.socket.end('HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabcdef');}}),s=storage(t);
 const r=await provider(f).media(f.origin+'/false-short',s.sink());assert.equal(r.outcome,'interrupted');assert.equal(r.evidence.completeness,'partial');
});
