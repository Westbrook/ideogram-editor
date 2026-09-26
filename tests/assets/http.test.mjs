import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { writeFile,readFile,symlink,unlink,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup,pair,call,cookieFrom,readHeaders,mutationHeaders } from '../protocol/helpers.mjs';
import { exchange } from '../session/helpers.mjs';
import { startLocalServer } from '../../dist/local/server/http.js';
import { canonical } from '../../dist/local/server/storage/canonical.js';
const digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const stage=(bytes,extra={})=>({protocolVersion:1,stagingId:randomUUID(),purpose:'caption',expectedBytes:String(bytes.length),sha256:digest(bytes),mediaType:'text/plain',...extra});
const command=(f,body)=>f.command({documentId:null,expectedDocumentRevision:null,body});
const put=(f,s,bytes,offset='0',paired=f.paired)=>call(f.server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',raw:bytes,headers:{...mutationHeaders(f.server,paired),'Content-Type':'application/octet-stream','Upload-Offset':offset}});
async function finish(f,s){const c=command(f,{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256});let result=await f.post('/api/v1/assets/staging/'+s.stagingId+'/finalize',c);assert.ok([200,202].includes(result.status),result.text);const pending=result.json;
  for(let i=0;result.json.kind==='pending'&&i<200;i++){await new Promise(r=>setTimeout(r,5));result=await f.read('/api/v1/commands/'+c.command.commandId);}assert.equal(result.json.kind,'receipt',result.text);return {c,result,pending};}
async function assetFor(f,receipt){const page=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));return page.json.batches[0].events[0].payload.asset;}

test('LP-1 resumable offsets, immutable logical identity, safe original receipt and inert text ranges',async t=>{
  const f=await setup(t);const bytes=Buffer.from('<svg onload="alert(1)">東京</svg>');const s=stage(bytes);
  assert.equal((await f.post('/api/v1/assets/staging',s)).status,201);assert.equal((await f.post('/api/v1/assets/staging',s)).status,200);
  assert.equal((await f.post('/api/v1/assets/staging',{...s,expectedBytes:'99'})).json.error.code,'STAGING_ID_REUSE');
  const part=await put(f,s,bytes.subarray(0,7));assert.equal(part.json.committedOffset,'7');assert.equal(part.json.version,'2');
  const mismatch=await put(f,s,bytes.subarray(7));assert.equal(mismatch.status,409);assert.deepEqual(mismatch.json.error.details.value,{kind:'offset',committedOffset:'7',stagingVersion:'2'});
  assert.equal((await put(f,s,bytes.subarray(7),'7')).json.state,'complete');
  const {c,result,pending}=await finish(f,s);assert.equal(result.json.receipt.status,'accepted');assert.deepEqual((await f.post('/api/v1/commands',c)).json,result.json);
  assert.equal((await f.post('/api/v1/commands',{...c,command:{...c.command,sessionId:'changed'}})).json.error.code,'COMMAND_ID_REUSE');
  const asset=await assetFor(f,result.json.receipt);assert.equal(asset.id,pending.operationId??asset.id);assert.equal(asset.qualification,'opaque-text');
  const path='/api/v1/assets/'+asset.id+'/content';const full=await f.read(path);assert.equal(full.text,bytes.toString());assert.equal(full.headers['content-type'],'text/plain');assert.match(full.headers['content-disposition'],/^attachment/);assert.equal(full.headers['x-content-type-options'],'nosniff');
  const ranged=await f.read(path,{Range:'bytes=2-9'});assert.equal(ranged.status,206);assert.equal(ranged.text,bytes.subarray(2,10).toString());
  assert.equal((await f.read(path,{Range:'bytes=-6'})).text,bytes.subarray(-6).toString());
  assert.equal((await f.read(path,{Range:'bytes=1-2','If-Range':'"different"'})).text,full.text);
  for(const Range of ['bytes=0-1,3-4','bytes=99999-','bytes=-0','garbage'])assert.equal((await f.read(path,{Range})).status,416);
  const head=await call(f.server.origin,path,{method:'HEAD',headers:{...readHeaders(cookieFrom(f.paired)),Range:'bytes=0-2'}});assert.equal(head.status,206);assert.equal(head.text,'');assert.equal(head.headers['content-length'],'3');
  for(const method of ['GET','HEAD'])for(const headers of [{},{Range:'bytes=1-3'},{Range:'bytes=-3'},{Range:'bytes=1-3','If-Range':'"different"'}]){
    const response=await call(f.server.origin,path,{method,headers:{...readHeaders(cookieFrom(f.paired)),...headers}});
    assert.ok([200,206].includes(response.status));assert.match(response.headers['content-security-policy'],/(?:^|;)\s*sandbox(?:;|$)/);
    assert.equal(response.headers['content-type'],'text/plain');assert.equal(response.headers['x-content-type-options'],'nosniff');assert.match(response.headers['content-disposition'],/^attachment/);
  }
  assert.equal((await f.read(path,{'X-App-Client':''})).status,403);
  assert.equal((await f.read('/api/v1/assets/'+asset.blob.hash.slice(7)+'/content')).status,404);
  const s2=stage(bytes);await f.post('/api/v1/assets/staging',s2);await put(f,s2,bytes);const second=await finish(f,s2);const a2=await assetFor(f,second.result.json.receipt);assert.notEqual(asset.id,a2.id);assert.deepEqual(asset.blob,a2.blob);
  const inventory=(await f.read('/api/v1/assets/staging/recovery')).json;assert.deepEqual(inventory.items,[]);
  const renewed=await f.post('/api/v1/session/renew',{protocolVersion:1});f.paired=renewed;assert.deepEqual((await f.post('/api/v1/commands',c)).json,result.json);
  const file=join(f.root,'objects','sha256',asset.blob.hash.slice(7,9),asset.blob.hash.slice(7));await writeFile(file,Buffer.alloc(bytes.length,120));assert.equal((await f.read(path,{Range:'bytes=0-2'})).status,404);
});

test('LP-1-R1 minimal inventory, exact review hash, explicit takeover and old in-flight callback fence',async t=>{
  const f=await setup(t);const bytes=Buffer.from('complete original');const s=stage(bytes);await f.post('/api/v1/assets/staging',s);await put(f,s,bytes.subarray(0,4));
  const original=f.paired;const next=await pair(f.server);const read=path=>call(f.server.origin,path,{headers:readHeaders(cookieFrom(next))});
  assert.equal((await read('/api/v1/assets/staging/'+s.stagingId)).status,403);
  const inventory=(await read('/api/v1/assets/staging/recovery')).json;assert.equal(inventory.items[0].committedOffset,'4');assert.deepEqual(Object.keys(inventory.items[0]).sort(),['stagingId','ownerClientId','version','purpose','expectedBytes','committedOffset','createdAt','state'].sort());assert.ok(!JSON.stringify(inventory).includes(s.sha256));
  f.paired=next;const preview=command(f,{type:'PreviewStagingOwnershipTransfer',stagingId:s.stagingId});const accepted=await f.post('/api/v1/commands',preview);assert.equal(accepted.json.receipt.status,'accepted');
  const page=(await read('/api/v1/events?after='+String(BigInt(accepted.json.receipt.fromSeq)-1n))).json;const event=page.batches[0].events[0];assert.equal(event.type,'StagingTransferReviewPrepared');assert.deepEqual(Object.keys(event.payload).sort(),['reviewHash','reviewId']);
  const review=(await read('/api/v1/assets/staging/transfer-reviews/'+event.payload.reviewId)).json;
  assert.equal(review.reviewHash,digest(canonical({reviewId:review.reviewId,targetClientId:review.targetClientId,staging:review.staging,expiresAt:review.expiresAt})));
  assert.equal((await call(f.server.origin,'/api/v1/assets/staging/transfer-reviews/'+review.reviewId,{headers:readHeaders(cookieFrom(original))})).status,403);
  const upload=exchange(f.server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',defer:true,headers:{...mutationHeaders(f.server,original),'Content-Type':'application/octet-stream','Content-Length':bytes.length-4,'Upload-Offset':'4'}});upload.request.flushHeaders();upload.request.write(bytes.subarray(4,5));
  await new Promise(r=>setTimeout(r,20));
  const transfer=command(f,{type:'TransferStagingOwnership',stagingId:s.stagingId,expectedOwnerClientId:original.json.clientId,expectedVersion:review.staging.version,reviewId:review.reviewId,reviewHash:review.reviewHash});
  const moved=await f.post('/api/v1/commands',transfer);assert.equal(moved.json.receipt.status,'accepted',moved.text);upload.request.end(bytes.subarray(5));assert.equal((await upload.response).status,403);
  assert.deepEqual((await f.post('/api/v1/commands',transfer)).json,moved.json);
  assert.equal((await put(f,s,bytes.subarray(4),'4',original)).status,403);const current=(await read('/api/v1/assets/staging/'+s.stagingId)).json;assert.equal(current.committedOffset,'4');assert.equal(current.version,'3');
  assert.equal((await put(f,s,bytes.subarray(4),'4')).status,200);assert.equal((await finish(f,s)).result.json.receipt.status,'accepted');
});

test('stale and expired reviews reject durably; hostile declarations and raw images never become usable',async t=>{
  let now=Date.now();const f=await setup(t,{now:()=>now});const b=Buffer.from('test');const s=stage(b);await f.post('/api/v1/assets/staging',s);
  const preview=command(f,{type:'PreviewStagingOwnershipTransfer',stagingId:s.stagingId});const accepted=await f.post('/api/v1/commands',preview);const page=(await f.read('/api/v1/events?after='+String(BigInt(accepted.json.receipt.fromSeq)-1n))).json;const p=page.batches[0].events[0].payload;const review=(await f.read('/api/v1/assets/staging/transfer-reviews/'+p.reviewId)).json;
  await put(f,s,b.subarray(0,1));const transfer=command(f,{type:'TransferStagingOwnership',stagingId:s.stagingId,expectedOwnerClientId:f.paired.json.clientId,expectedVersion:'1',reviewId:p.reviewId,reviewHash:p.reviewHash});const rejected=await f.post('/api/v1/commands',transfer);assert.equal(rejected.json.receipt.code,'STALE_REVISION');assert.equal(rejected.json.receipt.currentRevision,'2');assert.deepEqual((await f.post('/api/v1/commands',transfer)).json,rejected.json);
  now+=29*60*1000;await f.read('/api/v1/session');now+=2*60*1000;assert.equal((await f.read('/api/v1/assets/staging/transfer-reviews/'+review.reviewId)).status,410);
  for(const extra of [{purpose:'image',mediaType:'image/svg+xml'},{purpose:'font',mediaType:'font/ttf'},{purpose:'adapter',mediaType:'application/octet-stream'},{purpose:'bundle',mediaType:'application/zip'},{purpose:'mask',mediaType:'image/jpeg'}])assert.equal((await f.post('/api/v1/assets/staging',stage(b,extra))).status,415);
  assert.equal((await f.post('/api/v1/assets/staging',{...stage(b),filename:'../../evil'})).status,400);
  assert.equal((await f.post('/api/v1/assets/staging',{...stage(b),expectedBytes:'04'})).status,400);
  const bad=stage(Buffer.from('<svg/>'),{purpose:'image',mediaType:'image/png'});await f.post('/api/v1/assets/staging',bad);await put(f,bad,Buffer.from('<svg/>'));const badResult=await finish(f,bad);assert.equal(badResult.result.json.receipt.code,'INVALID_INPUT');assert.equal((await f.read('/api/v1/assets/staging/'+bad.stagingId)).json.state,'failed');
  // Deliberately incomplete PNG header: signature is not a complete decoder.
  const image=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(image);image.write('IHDR',12);const img=stage(image,{purpose:'image',mediaType:'image/png'});await f.post('/api/v1/assets/staging',img);await put(f,img,image);const finalized=await finish(f,img);const asset=await assetFor(f,finalized.result.json.receipt);assert.equal(asset.safety,'unknown');assert.equal(asset.qualification,'pending-decoder');
  for(const method of ['GET','HEAD'])assert.equal((await call(f.server.origin,'/api/v1/assets/'+asset.id+'/content',{method,headers:{...readHeaders(cookieFrom(f.paired)),Range:'bytes=0-2'}})).status,403);
  const unknown=await f.read('/api/v1/assets/staging/recovery?cursor=madeup');assert.equal(unknown.status,400);
});

test('restart truncates unacknowledged tails, keeps staged offsets and original receipt ownership',async t=>{
  const f=await setup(t);const b=Buffer.from('0123456789');const s=stage(b);await f.post('/api/v1/assets/staging',s);await put(f,s,b.subarray(0,4));const cookie=cookieFrom(f.paired);await f.server.close();
  let db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});const filename=db.prepare('SELECT filename FROM staged_assets WHERE id=?').get(s.stagingId).filename;db.close();
  const path=join(f.root,'uploads',filename);await writeFile(path,b);const next=await startLocalServer({root:f.root});t.after(()=>next.close());
  assert.equal((await stat(path)).size,4);const paired=await call(next.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:next.origin,Cookie:cookie},body:{protocolVersion:1,pairingToken:new URL(next.issuePairingURL()).hash.slice(9)}});assert.equal(paired.json.clientId,f.paired.json.clientId);
  const g={...f,server:next,paired,read:path=>call(next.origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(next.origin,path,{method:'POST',body,headers:mutationHeaders(next,paired)}),command:(patch,body)=>f.command({...patch,clientId:paired.json.clientId},body)};
  assert.equal((await g.read('/api/v1/assets/staging/'+s.stagingId)).json.committedOffset,'4');await put(g,s,b.subarray(4),'4');const done=await finish(g,s);assert.equal(done.result.json.receipt.status,'accepted');
});
