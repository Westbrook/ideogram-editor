import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup, pair, call, cookieFrom, readHeaders, mutationHeaders } from './helpers.mjs';
import { startLocalServer } from '../../dist/local/server/http.js';
import { canonical } from '../../dist/local/server/storage/canonical.js';
import { exchange } from '../session/helpers.mjs';
import { SHA256 } from '../../dist/local/src/protocol/sha256.js';

test('PROTO01 strict commands, five-code receipts, lost delivery, renewal ownership and projection',async t=>{
  const f=await setup(t);const c=f.command();const first=await f.post('/api/v1/commands',c);
  assert.equal(first.status,200);assert.equal(first.json.receipt.status,'accepted');
  const retry=await call(f.server.origin,'/api/v1/commands',{method:'POST',headers:mutationHeaders(f.server,f.paired),raw:Buffer.from(JSON.stringify(c,null,3))});
  assert.deepEqual(retry.json,first.json);
  const doc=await f.read('/api/v1/documents/document_1');assert.equal(doc.json.entityVersion,'1');assert.equal(doc.json.highWater,'1');
  const renewal=await f.post('/api/v1/session/renew',{protocolVersion:1});assert.equal(renewal.status,200);f.paired=renewal;
  assert.deepEqual((await f.post('/api/v1/commands',c)).json,first.json);
  assert.equal((await f.post('/api/v1/commands',{...c,command:{...c.command,sessionId:'changed'}})).json.error.code,'COMMAND_ID_REUSE');
  const other=await pair(f.server);assert.equal((await call(f.server.origin,'/api/v1/commands/'+c.command.commandId,{headers:readHeaders(cookieFrom(other))})).status,403);
  assert.equal((await call(f.server.origin,'/api/v1/commands',{method:'POST',headers:mutationHeaders(f.server,other),body:c})).status,403);
  const unknown=await f.read('/api/v1/commands/unknown');assert.equal(unknown.status,404);assert.deepEqual(unknown.json,{protocolVersion:1,kind:'unknown',commandId:'unknown'});
  for(const [patch,body,code] of [
    [{expectedDocumentRevision:'0'},{type:'SaveCheckpoint',name:'stale'},'STALE_REVISION'],
    [{documentId:'invalid'}, {width:0},'INVALID_INPUT'],
    [{documentId:'large'}, {width:8193},'CAPACITY'],
    [{documentId:'color'}, {color:'other'},'INCOMPATIBLE'],
    [{documentId:'missing',expectedEntityVersions:{...f.ref,hash:'sha256:'+'f'.repeat(64)}},{},'MISSING_ASSET']
  ]){const result=await f.post('/api/v1/commands',f.command(body.type ? {...patch,body} : patch,body.type ? {} : body));assert.equal(result.status,200);assert.equal(result.json.receipt.code,code);const bytes=Buffer.from(canonical(result.json.rejectionDetails.value));assert.equal(result.json.receipt.details.hash,'sha256:'+createHash('sha256').update(bytes).digest('hex'));}
  for(const [raw,code] of [[JSON.stringify(c).replace('"protocolVersion":1','"protocolVersion":1,"protocolVersion":1'),'MALFORMED_REQUEST'],[JSON.stringify({...c,protocolVersion:2}),'PROTOCOL_VERSION'],[JSON.stringify({...c,extra:1}),'MALFORMED_REQUEST'],[' '.repeat(65537),'PAYLOAD_TOO_LARGE']]){
    const result=await call(f.server.origin,'/api/v1/commands',{method:'POST',headers:mutationHeaders(f.server,f.paired),raw:Buffer.from(raw)});assert.equal(result.json.error.code,code);
  }
  for(const path of ['/api/v1/events','/api/v1/events?after=01','/api/v1/events?after=0&after=0','/api/v1/events?after=0&x=1','/api/v1/documents/document_1?x=1'])assert.equal((await f.read(path)).status,400);
  assert.equal((await f.read('/api/v1/protocol-content/nope',{'X-App-Client':''})).status,403);
  const methods=await call(f.server.origin,'/api/v1/events?after=0',{method:'HEAD',headers:readHeaders(cookieFrom(f.paired))});assert.equal(methods.status,405);assert.equal(methods.headers.allow,'GET');
  const lost=f.command({documentId:'lost'});const wire=exchange(f.server.origin,'/api/v1/commands',{method:'POST',body:lost,headers:mutationHeaders(f.server,f.paired)});
  wire.request.on('response',incoming=>incoming.destroy());await wire.response.catch(()=>{});
  const receipt=await f.read('/api/v1/commands/'+lost.command.commandId);assert.equal(receipt.json.receipt.status,'accepted');assert.deepEqual((await f.post('/api/v1/commands',lost)).json,receipt.json);
  assert.equal((await f.read('/api/v1/capabilities')).json.storageState,'ready');
});

test('PROTO02 restart requires fresh pairing; prior cookie restores original ownership without authenticating itself',async t=>{
  const f=await setup(t);const c=f.command();const accepted=await f.post('/api/v1/commands',c);const oldCookie=cookieFrom(f.paired);const oldCsrf=f.paired.json.csrfToken;
  const page=(await f.read('/api/v1/events?after=0')).json;await f.server.close();
  const next=await startLocalServer({root:f.root});t.after(()=>next.close());
  assert.equal((await call(next.origin,'/api/v1/commands/'+c.command.commandId,{headers:readHeaders(oldCookie)})).status,401);
  const paired=await call(next.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:next.origin,Cookie:oldCookie},body:{protocolVersion:1,pairingToken:new URL(next.issuePairingURL()).hash.slice(9)}});
  assert.equal(paired.json.clientId,c.command.clientId);assert.notEqual(paired.json.csrfToken,oldCsrf);
  const read=path=>call(next.origin,path,{headers:readHeaders(cookieFrom(paired))});
  assert.deepEqual((await read('/api/v1/commands/'+c.command.commandId)).json,accepted.json);
  assert.equal((await read('/api/v1/events?after=0&recoveryId='+page.recovery.recoveryId)).json.error.code,'READ_CONTEXT_EXPIRED');
  assert.deepEqual((await call(next.origin,'/api/v1/commands',{method:'POST',headers:mutationHeaders(next,paired),body:c})).json,accepted.json);
  await call(next.origin,'/api/v1/session/revoke',{method:'POST',headers:mutationHeaders(next,paired),body:{protocolVersion:1}});
  const revokedCookie=cookieFrom(paired);await next.close();const third=await startLocalServer({root:f.root});t.after(()=>third.close());
  const fresh=await call(third.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:third.origin,Cookie:revokedCookie},body:{protocolVersion:1,pairingToken:new URL(third.issuePairingURL()).hash.slice(9)}});
  assert.notEqual(fresh.json.clientId,c.command.clientId);
});

test('PROTO04 pinned snapshot B plus tail H, exact content ranges, ownership, idle expiry and retained full history',async t=>{
  let now=Date.now();const f=await setup(t,{now:()=>now});await f.post('/api/v1/commands',f.command());
  for(let revision=1;revision<255;revision++){const r=await f.post('/api/v1/commands',f.command({expectedDocumentRevision:String(revision),body:{type:'SaveCheckpoint',name:'東京 '+revision}}));assert.equal(r.json.receipt.status,'accepted');}
  const gap=await f.read('/api/v1/events?after=0');assert.equal(gap.status,410);const descriptor=gap.json.error.details.value.snapshot;
  assert.equal(descriptor.snapshotSeq,'250');assert.equal(descriptor.recovery.highWater,'255');
  const meta=await f.read(descriptor.metadataUrl);assert.deepEqual(meta.json,descriptor);
  const bytes=await f.read(descriptor.content.url);assert.equal(bytes.status,200);assert.equal(Buffer.byteLength(bytes.text),Number(descriptor.content.blob.byteLength));
  assert.equal('sha256:'+createHash('sha256').update(bytes.text).digest('hex'),descriptor.content.blob.hash);
  const lines=bytes.text.trimEnd().split('\n');assert.equal(String(lines.length),descriptor.content.recordCount);assert.ok(lines.every(line=>Buffer.byteLength(line)+1<=16384));
  const range=await f.read(descriptor.content.url,{Range:'bytes=3-17'});assert.equal(range.status,206);assert.equal(range.text,bytes.text.slice(3,18));assert.equal(range.headers['content-range'],`bytes 3-17/${descriptor.content.blob.byteLength}`);
  for(const range of ['bytes=0-1,4-8','bytes=999999999-','bytes=-0','garbage']){const invalid=await f.read(descriptor.content.url,{Range:range});assert.equal(invalid.status,416);assert.equal(invalid.json.error.details.value.kind,'range');}
  const mismatch=await f.read(descriptor.content.url,{Range:'bytes=3-17','If-Range':'"other"'});assert.equal(mismatch.status,200);assert.equal(mismatch.text,bytes.text);
  const head=await call(f.server.origin,descriptor.content.url,{method:'HEAD',headers:{...readHeaders(cookieFrom(f.paired)),Range:'bytes=0-10'}});assert.equal(head.status,206);assert.equal(head.text,'');assert.equal(head.headers['content-length'],'11');
  assert.equal((await f.read(descriptor.content.url,{'X-App-Client':''})).status,403);
  const other=await pair(f.server);assert.equal((await call(f.server.origin,descriptor.content.url,{headers:readHeaders(cookieFrom(other))})).status,403);
  const newer=await f.post('/api/v1/commands',f.command({expectedDocumentRevision:'255',body:{type:'SaveCheckpoint',name:'after H'}}));assert.equal(newer.json.receipt.toSeq,'256');
  let cursor='250';for(;;){const page=await f.read('/api/v1/events?after='+cursor+'&recoveryId='+descriptor.recovery.recoveryId);assert.equal(page.status,200);assert.equal(page.json.recovery.highWater,'255');cursor=page.json.nextCursor;if(!page.json.more)break;}assert.equal(cursor,'255');
  now+=29*60*1000;await f.read('/api/v1/session');now+=2*60*1000;
  assert.equal((await f.read(descriptor.content.url)).json.error.code,'READ_CONTEXT_EXPIRED');
  const newGap=await f.read('/api/v1/events?after=0');const rid=newGap.json.error.details.value.snapshot.recovery.recoveryId;
  assert.equal((await f.post('/api/v1/recovery/'+rid+'/release',{protocolVersion:1})).status,204);
  assert.equal((await f.post('/api/v1/recovery/'+rid+'/release',{protocolVersion:1})).status,204);
  assert.equal((await f.read('/api/v1/events?after=250&recoveryId='+rid)).status,410);
  await f.server.close();const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM events_v2').get().n,256);db.close();
});

test('incremental digest matches platform SHA256 across padding and arbitrary chunk boundaries',()=>{
  for(const length of [0,1,55,56,63,64,65,16384,1048593]){const bytes=Buffer.alloc(length,0xab);const h=new SHA256();for(let at=0;at<length;at+=37)h.update(bytes.subarray(at,at+37));assert.equal(h.digest(),'sha256:'+createHash('sha256').update(bytes).digest('hex'));}
});

test('PROTO02 real journal capacity failure returns507 without a receipt; same original command succeeds after recovery',async t=>{
  const {openWriter}=await import('../../dist/local/server/storage/writer.js');
  const {rootFor,expectedBytes,refFor,command,encode}=await import('../store/helpers.mjs');
  const root=await rootFor(t);const w=await openWriter({root});const ref=await w.putObject([expectedBytes],refFor(expectedBytes),w.epoch);await w.submit(encode(command(ref)),w.epoch);const pages=(await w.diagnostics()).settings.page_count;await w.close();
  const full=await startLocalServer({root},{writer:{maxPageCount:pages+1}});t.after(()=>full.close());const paired=await pair(full);assert.equal(paired.status,200);
  const c=command(ref,{clientId:paired.json.clientId,expectedDocumentRevision:'1',body:{type:'SaveCheckpoint',name:'Retained user draft '.repeat(400)}});
  const response=await call(full.origin,'/api/v1/commands',{method:'POST',headers:mutationHeaders(full,paired),body:c});assert.equal(response.status,507);assert.equal(response.json.error.retry,'same-command');
  assert.equal((await call(full.origin,'/api/v1/commands/'+c.command.commandId,{headers:readHeaders(cookieFrom(paired))})).status,404);await full.close();
  const recovered=await startLocalServer({root});t.after(()=>recovered.close());const again=await call(recovered.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:recovered.origin,Cookie:cookieFrom(paired)},body:{protocolVersion:1,pairingToken:new URL(recovered.issuePairingURL()).hash.slice(9)}});
  const result=await call(recovered.origin,'/api/v1/commands',{method:'POST',headers:mutationHeaders(recovered,again),body:c});assert.equal(result.status,200);assert.equal(result.json.receipt.status,'accepted');assert.equal(result.json.receipt.toSeq,'2');
});

test('a fresh unseeded HTTP root accepts NewDocument with the public fixed empty precondition reference',async t=>{
  const {rootFor,command}=await import('../store/helpers.mjs');const {EMPTY_EXPECTED_VERSIONS}=await import('../../dist/local/src/protocol/store.js');
  const server=await startLocalServer({root:await rootFor(t)});t.after(()=>server.close());const paired=await pair(server);
  const c=command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId});const response=await call(server.origin,'/api/v1/commands',{method:'POST',headers:mutationHeaders(server,paired),body:c});
  assert.equal(response.status,200);assert.equal(response.json.receipt.status,'accepted');
});
