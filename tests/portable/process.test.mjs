import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setup,copy,preview,workspace,terminal,binary} from './helpers.mjs';
import {command} from '../store/helpers.mjs';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {call,cookieFrom,readHeaders,mutationHeaders} from '../session/helpers.mjs';
import {zeroEffects} from '../store/helpers.mjs';
import {writeFile,readFile,unlink} from 'node:fs/promises';

import {child} from './process-helpers.mjs';

for(const phase of ['portable-preparation-before-commit','portable-preparation-after-commit','portable-export-before-commit','portable-before-commit','portable-after-commit'])test('real SIGKILL '+phase+' preserves pinned copy identity and exact retry',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:2,height:1}));const cookie=cookieFrom(f.paired);await f.server.close();const first=await child(t,f.root,phase);await first.pair(cookie);const oldCookie=cookieFrom(first.paired),c=command(EMPTY_EXPECTED_VERSIONS,{clientId:first.paired.json.clientId,expectedDocumentRevision:'1',body:{type:'SaveCopy'}});
 const sent=first.post('/api/v1/commands',c).catch(()=>null);await first.wait('barrier');await first.effects();await first.kill();await sent;
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true}),pending=db.prepare('SELECT * FROM portable_preparations WHERE id=?').get(c.command.commandId),saved=db.prepare('SELECT * FROM commands WHERE id=?').get(c.command.commandId);db.close();
 if(phase==='portable-preparation-before-commit')assert.equal(pending,undefined);else assert(pending||saved);if(pending||saved)assert.equal((pending??saved).original,JSON.stringify(c));
 const next=await child(t,f.root);await next.pair(oldCookie);const result=await terminal(next,c);assert.equal(result.json.receipt.status,'accepted',result.text);assert.deepEqual((await terminal(next,c)).json.receipt,result.json.receipt);const e=(await next.read('/api/v1/events?after='+String(BigInt(result.json.receipt.fromSeq)-1n))).json.batches[0].events[0];assert.equal(e.type,'BundlePrepared');const released=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});assert.equal(released.prepare('SELECT count(*) n FROM portable_pins WHERE operation_id=?').get(e.payload.bundle.bundleId).n,0);released.close();assert.equal((await binary(next,'/api/v1/bundles/'+e.payload.bundle.bundleId+'/content')).status,200);await next.effects();
});
for(const phase of ['portable-import-after-proofs','portable-import-before-commit','portable-import-after-commit'])test('real SIGKILL '+phase+' publishes all fresh namespace or none',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:2,height:1}));const saved=await copy(f),cookie=cookieFrom(f.paired);await f.server.close();const first=await child(t,f.root,phase);await first.pair(cookie);first.command=(patch,body)=>command(EMPTY_EXPECTED_VERSIONS,{clientId:first.paired.json.clientId,...patch},body);const p=await preview(first,saved.bytes),oldCookie=cookieFrom(first.paired),c=first.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:p.review.reviewId,reviewHash:p.review.reviewHash}});
 const sent=first.post('/api/v1/commands',c).catch(()=>null);await first.wait('barrier');await first.effects();await first.kill();await sent;
 const next=await child(t,f.root);await next.pair(oldCookie);const result=await terminal(next,c);assert.equal(result.json.receipt.status,phase==='portable-import-after-commit'?'accepted':'rejected',result.text);assert.equal((await next.read('/api/v1/documents/'+p.review.documentId)).status,phase==='portable-import-after-commit'?200:404);assert.deepEqual((await terminal(next,c)).json.receipt,result.json.receipt);await next.effects();
});
for(const corruption of ['changed','replaced','missing'])test('source '+corruption+' after validation preserves namespace and existing shared bytes',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:2,height:1}));const saved=await copy(f),cookie=cookieFrom(f.paired);await f.server.close();const first=await child(t,f.root,'portable-import-after-proofs');await first.pair(cookie);first.command=(patch,body)=>command(EMPTY_EXPECTED_VERSIONS,{clientId:first.paired.json.clientId,...patch},body);const p=await preview(first,saved.bytes),c=first.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:p.review.reviewId,reviewHash:p.review.reviewHash}});
 const sent=first.post('/api/v1/commands',c);await first.wait('barrier');const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true}),filename=db.prepare('SELECT filename FROM staged_assets WHERE id=?').get(p.stage.stagingId).filename,roots=db.prepare('SELECT * FROM roots ORDER BY owner,hash').all();db.close();const path=join(f.root,'uploads',filename),original=await readFile(path);
 if(corruption==='missing')await unlink(path);else if(corruption==='changed')await writeFile(path,Buffer.alloc(original.length,91));else{await unlink(path);await writeFile(path,original,{mode:0o600});}first.p.send('release');await sent;const result=await terminal(first,c);assert.equal(result.json.receipt.status,'rejected');assert.equal((await first.read('/api/v1/documents/'+p.review.documentId)).status,404);assert.equal((await binary(first,'/api/v1/bundles/'+saved.bundle.bundleId+'/content')).status,200);const after=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});for(const r of roots)assert(after.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=?').get(r.owner,r.hash));after.close();await writeFile(path,original,{mode:0o600});await first.effects();
});
