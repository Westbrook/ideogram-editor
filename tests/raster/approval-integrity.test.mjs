import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink,rename,symlink,link} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setup,rootFor,pair,call,cookieFrom,readHeaders,mutationHeaders,command} from '../protocol/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {original,operate,envelope,terminal,binary,digest} from './helpers.mjs';

const objectPath=(f,ref)=>join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
async function review(f,name='orientation-6.png'){
 const input=await original(f,name),prepared=await operate(f,{type:'PrepareRaster',assetId:input.id}),preview=prepared.event.payload.asset;
 const r=await operate(f,{type:'ReviewRaster',assetId:preview.id}),value=(await f.read('/api/v1/assets/raster-reviews/'+r.event.payload.reviewId)).json;
 const body={type:'ApproveRaster',assetId:preview.id,reviewId:value.reviewId,reviewHash:value.reviewHash};
 return {input,preview,body};
}

async function atProofs(t){
 const root=await rootFor(t),gate=new SharedArrayBuffer(4);let reached;
 const barrier=new Promise(resolve=>{reached=resolve;});
 const server=await startLocalServer({root},{writer:{phase:'raster-approval-after-proofs',gate,onBarrier:()=>reached()}});
 const release=()=>{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);};
 t.after(async()=>{release();await server.close();});
 const f={root,server,paired:await pair(server),read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(f.paired))}),post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,f.paired)}),command:patch=>command(EMPTY_EXPECTED_VERSIONS,{clientId:f.paired.json.clientId,...patch})};
 return {f,barrier,release};
}
for(const mutation of ['missing','corrupt','same-bytes-replacement','symlink','hardlink'])test('approval rechecks file identity after proofs: '+mutation,async t=>{
 const {f,barrier,release}=await atProofs(t),image=await review(f),c=envelope(f,image.body),first=f.post('/api/v1/commands',c);
 await barrier;const path=objectPath(f,image.preview.raster.pixels),saved=await readFile(path);
 try{
  if(mutation==='missing')await unlink(path);
  else if(mutation==='corrupt'){const changed=Buffer.from(saved);changed[0]^=1;await writeFile(path,changed);}
  else if(mutation==='same-bytes-replacement'){await writeFile(path+'.new',saved,{mode:0o600});await rename(path+'.new',path);}
  else{await rename(path,path+'.original');if(mutation==='symlink')await symlink(path+'.original',path);else await link(path+'.original',path);}
 }finally{release();}
 await first;const r=await terminal(f,c);assert.equal(r.json.receipt.status,'rejected');assert.equal(r.json.receipt.code,'MISSING_ASSET');
 assert.match(r.json.rejectionDetails.value.issues[0].code,/RASTER_DEPENDENCY_/);
 if(mutation==='symlink'||mutation==='hardlink'){await unlink(path);await rename(path+'.original',path);}else await writeFile(path,saved,{mode:0o600});
 assert.deepEqual((await f.post('/api/v1/commands',c)).json,r.json);
});
test('approval rechecks live session binding after proofs and keeps the original rejected identity',async t=>{
 const {f,barrier,release}=await atProofs(t),image=await review(f),c=envelope(f,image.body),first=f.post('/api/v1/commands',c);
 await barrier;
 // Renewal revokes the old session in the HTTP process and queues its writer
 // binding update while the test barrier holds the storage thread.
 const renewing=f.post('/api/v1/session/renew',{protocolVersion:1});
 await new Promise(r=>setTimeout(r,20));release();f.paired=await renewing;assert.equal(f.paired.status,200);
 await first;const r=await terminal(f,c);assert.equal(r.json.receipt.status,'rejected',r.text);assert.equal(r.json.rejectionDetails.value.issues[0].code,'RASTER_REVIEW_EXPIRED');
 assert.deepEqual((await f.post('/api/v1/commands',c)).json,r.json);
});
test('queued approval authorities are bounded and released when a retry rejects an expired review',async t=>{
 const f=await setup(t),image=await review(f);await f.server.close();const w=await openWriter({root:f.root});t.after(()=>w.close());
 const auth={clientId:f.paired.json.clientId,sessionHash:'b'.repeat(64),now:Date.now(),expires:Date.now()+1800000};await w.rememberClient(auth.sessionHash,auth.clientId,auth.expires);
 const make=body=>command(EMPTY_EXPECTED_VERSIONS,{clientId:auth.clientId,documentId:null,body});
 const r=await w.rasterCommand(Buffer.from(JSON.stringify(make({type:'ReviewRaster',assetId:image.preview.id}))),auth);
 const value=(await w.events(String(BigInt(r.fromSeq)-1n))).events[0].payload,holds=[];
 for(let i=0;i<2;i++){const id=randomUUID();await w.assetCreate({protocolVersion:1,stagingId:id,purpose:'caption',expectedBytes:'1',sha256:digest('x'),mediaType:'text/plain'},auth);holds.push(await w.assetBeginChunk(id,'0',1,auth));}
 const queued=[];for(let i=0;i<8;i++){const c=make({type:'ApproveRaster',assetId:image.preview.id,reviewId:value.reviewId,reviewHash:value.reviewHash});assert.equal(await w.rasterCommand(Buffer.from(JSON.stringify(c)),auth),null);queued.push(c);}
 {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.rasters.approvalAuthorities,8);}finally{diagnosticRead.release();}}
 // Both shared IO slots also block diagnostic-object publication. The invalid
 // session must release its live authority even if its receipt cannot commit yet.
 for(const c of queued)await assert.rejects(w.rasterCommand(Buffer.from(JSON.stringify(c)),{...auth,sessionHash:'c'.repeat(64)}),{code:'CAPACITY'});
 {const diagnosticRead=await w.readDiagnostics();try{const d=diagnosticRead.value.rasters;assert.equal(d.preparations,8);assert.equal(d.approvalAuthorities,0);assert.equal(d.activeWorkers,0);}finally{diagnosticRead.release();}}
 for(const hold of holds)await w.assetAbortChunk(hold);
 for(const c of queued){const receipt=await w.rasterCommand(Buffer.from(JSON.stringify(c)),{...auth,sessionHash:'c'.repeat(64)});assert.equal(receipt.status,'rejected');assert.equal(receipt.code,'INVALID_INPUT');}
 {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.rasters.approvalAuthorities,0);}finally{diagnosticRead.release();}}
});
for(const target of ['pixels','manifest','png','original','exif','icc'])for(const mutation of ['missing','corrupt','substituted']){
 test(`approval rejects ${mutation} ${target} dependency without a usable canonical asset`,async t=>{
  const f=await setup(t),image=await review(f,target==='icc'?'p3.png':'orientation-6.png');
  const ref=target==='pixels'?image.preview.raster.pixels:target==='manifest'?image.preview.raster.manifest:target==='png'?image.preview.blob:target==='original'?image.input.blob:image.preview.dependencies.find(r=>r.mediaType===(target==='icc'?'application/vnd.iccprofile':'application/octet-stream'));
  assert.ok(ref);const path=objectPath(f,ref),saved=await readFile(path),changed=Buffer.from(saved);changed[0]^=1;
  if(mutation==='missing')await unlink(path);
  else if(mutation==='corrupt')await writeFile(path,changed,{mode:0o600});
  else{await writeFile(path+'.replacement',changed,{mode:0o600});await rename(path+'.replacement',path);}
  const c=envelope(f,image.body),r=await terminal(f,c);
  assert.equal(r.json.receipt.status,'rejected',r.text);assert.equal(r.json.receipt.code,'MISSING_ASSET');
  assert.match(r.json.rejectionDetails.value.issues[0].code,/^RASTER_DEPENDENCY_(MISSING|CORRUPT)$/);
  assert.deepEqual((await f.post('/api/v1/commands',c)).json,r.json);
  const events=(await f.read('/api/v1/events?after=0')).json.batches.flatMap(b=>b.events);
  assert.equal(events.some(e=>e.type==='AssetRegistered'&&e.payload.asset.qualification==='canonical-raster'),false);
  await writeFile(path,saved,{mode:0o600}); // Repair does not overwrite a terminal rejection.
  assert.deepEqual((await f.post('/api/v1/commands',c)).json,r.json);
  const accepted=await operate(f,image.body),asset=accepted.event.payload.asset;
  assert.equal(asset.qualification,'canonical-raster');assert.deepEqual(asset.raster,image.preview.raster);
  assert.deepEqual((await binary(f,asset.id)).bytes,(await binary(f,image.preview.id)).bytes);
 });
}
