import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash,randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { canonical } from '../../dist/local/server/storage/canonical.js';
import { startLocalServer } from '../../dist/local/server/http.js';
import { rootFor,command,zeroEffects } from '../store/helpers.mjs';
import { EMPTY_EXPECTED_VERSIONS } from '../../dist/local/src/protocol/store.js';
import { pair,call,exchange,cookieFrom,readHeaders,mutationHeaders } from '../session/helpers.mjs';
async function child(t,root,phase=''){
  const p=fork(fileURLToPath(new URL('../protocol/process-fixture.mjs',import.meta.url)),[root,phase],{execArgv:['--import',fileURLToPath(new URL('../protocol/no-effects.mjs',import.meta.url))],env:{PATH:process.env.PATH},stdio:['ignore','ignore','pipe','ipc']});
  const waiting=new Map(),queued=new Map();let errors='';p.stderr.on('data',b=>errors+=b);p.on('message',m=>{const w=waiting.get(m.type);if(w){waiting.delete(m.type);w(m);}else queued.set(m.type,m);});
  const wait=type=>{if(queued.has(type)){const value=queued.get(type);queued.delete(type);return Promise.resolve(value);}return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(errors||'Process timeout '+type)),10000);waiting.set(type,m=>{clearTimeout(timer);resolve(m);});});};
  const exited=once(p,'exit');t.after(async()=>{if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await exited;}});const {origin}=await wait('ready');
  return {p,origin,wait,async kill(){p.kill('SIGKILL');await exited;},async pair(oldCookie){p.send('pair');const {url}=await wait('pair');return call(origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:origin,...oldCookie?{Cookie:oldCookie}:{}},body:{protocolVersion:1,pairingToken:new URL(url).hash.slice(9)}});}};
}
const bytes=Buffer.from('durable original asset bytes');
const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
async function seeded(t,complete=false){const root=await rootFor(t);const server=await startLocalServer({root});const paired=await pair(server);const stage={protocolVersion:1,stagingId:randomUUID(),purpose:'caption',expectedBytes:String(bytes.length),sha256:digest,mediaType:'text/plain'};
  assert.equal((await call(server.origin,'/api/v1/assets/staging',{method:'POST',body:stage,headers:mutationHeaders(server,paired)})).status,201);
  const part=complete?bytes:bytes.subarray(0,4);assert.equal((await call(server.origin,'/api/v1/assets/staging/'+stage.stagingId,{method:'PUT',raw:part,headers:{...mutationHeaders(server,paired),'Content-Type':'application/octet-stream','Upload-Offset':'0'}})).status,200);await server.close();return {root,stage,paired};}
async function receipt(c,paired,id){let r;for(let i=0;i<200;i++){r=await call(c.origin,'/api/v1/commands/'+id,{headers:readHeaders(cookieFrom(paired))});if(r.status!==202)return r;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Preparation stalled '+r.text);}

for(const phase of ['upload-before-write','upload-before-flush','upload-after-flush','upload-before-offset-commit','upload-after-offset-commit'])test('SIGKILL '+phase+' preserves only the journaled offset and missing suffix',async t=>{
  const f=await seeded(t);const first=await child(t,f.root,phase);const paired=await first.pair(cookieFrom(f.paired));const cookie=cookieFrom(paired);
  const sent=exchange(first.origin,'/api/v1/assets/staging/'+f.stage.stagingId,{method:'PUT',raw:bytes.subarray(4),headers:{...mutationHeaders(first,paired),'Content-Type':'application/octet-stream','Upload-Offset':'4'}});const delivered=sent.response.catch(()=>null);
  await first.wait('barrier');first.p.send('effects');assert.deepEqual((await first.wait('effects')).value,zeroEffects);await first.kill();await delivered;
  const next=await child(t,f.root);const renewed=await next.pair(cookie);const stage=await call(next.origin,'/api/v1/assets/staging/'+f.stage.stagingId,{headers:readHeaders(cookieFrom(renewed))});
  const after=phase==='upload-after-offset-commit';assert.equal(stage.json.committedOffset,after?String(bytes.length):'4');assert.equal(stage.json.version,after?'3':'2');
  if(!after)assert.equal((await call(next.origin,'/api/v1/assets/staging/'+f.stage.stagingId,{method:'PUT',raw:bytes.subarray(4),headers:{...mutationHeaders(next,renewed),'Content-Type':'application/octet-stream','Upload-Offset':'4'}})).status,200);
  next.p.send('effects');assert.deepEqual((await next.wait('effects')).value,zeroEffects);
});

for(const phase of ['preparation-before-commit','preparation-after-commit','finalize-before-flush','finalize-after-flush','finalize-before-rename','finalize-after-rename','finalize-after-directory-sync','finalize-before-register','asset-before-commit','asset-after-commit'])test('SIGKILL '+phase+' resolves the original finalize identity once',async t=>{
  const f=await seeded(t,true);const first=await child(t,f.root,phase);const paired=await first.pair(cookieFrom(f.paired));const cookie=cookieFrom(paired);
  const c=command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,documentId:null,body:{type:'FinalizeStaging',stagingId:f.stage.stagingId,expectedSha256:digest}});
  const wire=exchange(first.origin,'/api/v1/assets/staging/'+f.stage.stagingId+'/finalize',{method:'POST',body:c,headers:mutationHeaders(first,paired)});const delivered=wire.response.catch(()=>null);
  await first.wait('barrier');first.p.send('effects');assert.deepEqual((await first.wait('effects')).value,zeroEffects);await first.kill();await delivered;
  const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});const preparation=db.prepare('SELECT * FROM asset_preparations WHERE id=?').get(c.command.commandId);const saved=db.prepare('SELECT * FROM commands WHERE id=?').get(c.command.commandId);
  if(phase==='preparation-before-commit'){assert.equal(preparation,undefined);assert.equal(saved,undefined);}else{assert.ok(preparation||saved);if(preparation){assert.equal(preparation.original,JSON.stringify(c));assert.equal(JSON.parse(preparation.canonical).command.clientId,c.command.clientId);}}
  assert.ok(db.prepare('SELECT count(*) AS n FROM assets').get().n<=1);db.close();
  const next=await child(t,f.root);const renewed=await next.pair(cookie);assert.equal((await call(next.origin,'/api/v1/session',{headers:readHeaders(cookie)})).status,401);
  const retried=await call(next.origin,'/api/v1/commands',{method:'POST',body:c,headers:mutationHeaders(next,renewed)});assert.ok([200,202].includes(retried.status),retried.text);
  const result=await receipt(next,renewed,c.command.commandId);assert.equal(result.json.receipt.status,'accepted');assert.equal(result.json.receipt.fromSeq,'1');
  assert.deepEqual((await call(next.origin,'/api/v1/commands',{method:'POST',body:c,headers:mutationHeaders(next,renewed)})).json,result.json);
  const projection=(await call(next.origin,'/api/v1/events?after=0',{headers:readHeaders(cookieFrom(renewed))})).json;const asset=projection.batches[0].events[0].payload.asset;if(preparation)assert.equal(asset.id,preparation.operation_id);
  assert.equal((await call(next.origin,'/api/v1/assets/'+asset.id+'/content',{headers:readHeaders(cookieFrom(renewed))})).text,bytes.toString());next.p.send('effects');assert.deepEqual((await next.wait('effects')).value,zeroEffects);
});

for(const phase of ['transfer-before-commit','transfer-after-commit'])test('SIGKILL '+phase+' keeps original owner or transfers exactly once',async t=>{
  const f=await seeded(t);const first=await child(t,f.root,phase);const paired=await first.pair();
  const preview=command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,documentId:null,body:{type:'PreviewStagingOwnershipTransfer',stagingId:f.stage.stagingId}});
  const post=body=>call(first.origin,'/api/v1/commands',{method:'POST',body,headers:mutationHeaders(first,paired)});const pr=await post(preview);assert.equal(pr.json.receipt.status,'accepted');const page=await call(first.origin,'/api/v1/events?after=0',{headers:readHeaders(cookieFrom(paired))});const review=page.json.batches[0].events[0].payload;
  const c=command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,documentId:null,body:{type:'TransferStagingOwnership',stagingId:f.stage.stagingId,expectedOwnerClientId:f.paired.json.clientId,expectedVersion:'2',reviewId:review.reviewId,reviewHash:review.reviewHash}});
  const pending=post(c).catch(()=>null);await first.wait('barrier');await first.kill();await pending;
  const next=await child(t,f.root);const fresh=await next.pair(cookieFrom(paired));const lookup=await call(next.origin,'/api/v1/commands/'+c.command.commandId,{headers:readHeaders(cookieFrom(fresh))});
  if(phase==='transfer-before-commit'){
    assert.equal(lookup.status,404);const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});const stage=JSON.parse(db.prepare('SELECT json FROM staged_assets WHERE id=?').get(f.stage.stagingId).json);db.close();assert.equal(stage.ownerClientId,f.paired.json.clientId);assert.equal(stage.version,'2');
    const retry=await call(next.origin,'/api/v1/commands',{method:'POST',body:c,headers:mutationHeaders(next,fresh)});assert.equal(retry.json.receipt.code,'INVALID_INPUT');
  }else{assert.equal(lookup.json.receipt.status,'accepted');const retry=await call(next.origin,'/api/v1/commands',{method:'POST',body:c,headers:mutationHeaders(next,fresh)});assert.deepEqual(retry.json,lookup.json);const stage=await call(next.origin,'/api/v1/assets/staging/'+f.stage.stagingId,{headers:readHeaders(cookieFrom(fresh))});assert.equal(stage.json.ownerClientId,fresh.json.clientId);assert.equal(stage.json.version,'3');assert.equal(stage.json.committedOffset,'4');}
});

test('competing HTTP command identities stay exclusive through pending responses and SIGKILL restart',async t=>{
  const f=await seeded(t,true);const first=await child(t,f.root);const paired=await first.pair(cookieFrom(f.paired));
  const post=(path,body)=>call(first.origin,path,{method:'POST',body,headers:mutationHeaders(first,paired)});
  const holds=[];
  for(let i=0;i<2;i++){
    const s={...f.stage,stagingId:randomUUID()};assert.equal((await post('/api/v1/assets/staging',s)).status,201);
    const wire=exchange(first.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',defer:true,headers:{...mutationHeaders(first,paired),'Content-Type':'application/octet-stream','Content-Length':bytes.length,'Upload-Offset':'0'}});
    wire.response.catch(()=>{});wire.request.flushHeaders();wire.request.write(bytes.subarray(0,1));holds.push(wire);
  }
  t.after(()=>holds.forEach(h=>h.request.destroy()));await new Promise(r=>setTimeout(r,30));
  const attempts=[];
  const checkPending=r=>{assert.equal(r.status,202,r.text);assert.equal(r.headers.location,r.json.receiptUrl);return r.json;};
  for(let i=0;i<42;i++){
    const s={...f.stage,stagingId:randomUUID(),expectedBytes:'0',sha256:'sha256:'+createHash('sha256').update('').digest('hex')};assert.equal((await post('/api/v1/assets/staging',s)).status,201);
    const asset=command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,documentId:null,body:{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256}});
    const normal={...asset,command:{...asset.command,documentId:randomUUID(),body:{type:'NewDocument',width:1,height:1,color:'sRGB',depth:8}}};
    let nr,ar;
    if(i===0){ar=await post('/api/v1/commands',asset);nr=await post('/api/v1/commands',normal);}
    else if(i===1){nr=await post('/api/v1/commands',normal);ar=await post('/api/v1/commands',asset);}
    else if(i%2)[ar,nr]=await Promise.all([post('/api/v1/commands',asset),post('/api/v1/commands',normal)]);
    else [nr,ar]=await Promise.all([post('/api/v1/commands',normal),post('/api/v1/commands',asset)]);
    const assetWon=ar.status===202;const winner=assetWon?asset:normal;const loser=assetWon?normal:asset;
    assert.equal((assetWon?nr:ar).status,409);assert.equal((assetWon?nr:ar).json.error.code,'COMMAND_ID_REUSE');
    const result=assetWon?checkPending(ar):nr.json;if(!assetWon)assert.equal(nr.json.receipt.status,'accepted');
    if(assetWon){
      for(const path of ['/api/v1/commands','/api/v1/assets/staging/'+s.stagingId+'/finalize'])assert.deepEqual(checkPending(await post(path,asset)),result);
      assert.deepEqual(checkPending(await call(first.origin,'/api/v1/commands/'+asset.command.commandId,{headers:readHeaders(cookieFrom(paired))})),result);
    }
    const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});
    const rows=db.prepare('SELECT hash FROM commands WHERE id=? UNION ALL SELECT hash FROM asset_preparations WHERE id=?').all(asset.command.commandId,asset.command.commandId);db.close();
    assert.equal(rows.length,1,'one persisted pending or terminal identity');assert.equal(rows[0].hash,'sha256:'+createHash('sha256').update(canonical(winner)).digest('hex'));
    attempts.push({winner,loser,result,assetWon});
  }
  first.p.send('effects');assert.deepEqual((await first.wait('effects')).value,zeroEffects);await first.kill();
  const next=await child(t,f.root);const renewed=await next.pair(cookieFrom(paired));assert.equal(renewed.json.clientId,paired.json.clientId);
  for(const {winner,loser,result,assetWon} of attempts){
    const saved=await receipt(next,renewed,winner.command.commandId);assert.equal(saved.json.receipt.status,'accepted');
    assert.deepEqual((await call(next.origin,'/api/v1/commands',{method:'POST',body:winner,headers:mutationHeaders(next,renewed)})).json,saved.json);
    assert.equal((await call(next.origin,'/api/v1/commands',{method:'POST',body:loser,headers:mutationHeaders(next,renewed)})).status,409);
    const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM asset_preparations WHERE id=?').get(winner.command.commandId).n,0);
    const record=db.prepare('SELECT * FROM commands WHERE id=?').get(winner.command.commandId);assert.equal(record.original,JSON.stringify(winner));assert.equal(record.hash,'sha256:'+createHash('sha256').update(canonical(winner)).digest('hex'));
    const event=JSON.parse(db.prepare('SELECT json FROM events_v2 WHERE command_id=?').get(winner.command.commandId).json);db.close();
    if(assetWon){assert.equal(event.payload.asset.id,result.operationId);assert.equal((await call(next.origin,'/api/v1/documents/'+loser.command.documentId,{headers:readHeaders(cookieFrom(renewed))})).status,404);}else assert.deepEqual(saved.json,result);
  }
  next.p.send('effects');assert.deepEqual((await next.wait('effects')).value,zeroEffects);
});
