import assert from 'node:assert/strict';
import {readFile,writeFile,cp,mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {setup,command} from '../source/tests/protocol/helpers.mjs';
import {original,operate,digest} from '../source/tests/raster/helpers.mjs';
import {openWriter} from '../source/dist/local/server/storage/writer.js';
import {openWriter as openOld} from '../../dfa383d-independent/source/dist/local/server/storage/writer.js';
import {EMPTY_EXPECTED_VERSIONS} from '../source/dist/local/src/protocol/store.js';
const base=resolve(import.meta.dirname,'..'),cleanup=[],f=await setup({after:fn=>cleanup.push(fn)}),out={newSourceIdentity:'sha256:26fe383985850a6bb54eb60b90db8a57f46badd264abefe52f31b16fff674391',oldCommit:'dfa383d56d21bc9c7bb40248db8a503fe33e6e46'};
const auth={clientId:f.paired.json.clientId,sessionHash:'d'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
const make=body=>command(EMPTY_EXPECTED_VERSIONS,{clientId:auth.clientId,documentId:null,body});
const enc=c=>Buffer.from(JSON.stringify(c));
const inspect=async(root,id)=>{const d=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return {version:d.prepare('PRAGMA user_version').get(),epoch:d.prepare("SELECT * FROM meta WHERE key='writerEpoch'").get(),pending:d.prepare('SELECT * FROM raster_preparations WHERE id=?').get(id),receipt:d.prepare('SELECT * FROM commands WHERE id=?').get(id),events:d.prepare('SELECT count(*) AS n FROM events_v2').get(),migrations:d.prepare('SELECT * FROM schema_migrations').all(),files:await readdir(root)};}finally{d.close();}};
let w;
try{
 const input=await original(f,'orientation-6.png'),preview=(await operate(f,{type:'PrepareRaster',assetId:input.id})).event.payload.asset;
 await f.server.close();w=await openWriter({root:f.root});await w.rememberClient(auth.sessionHash,auth.clientId,auth.expires);
 const r=await w.rasterCommand(enc(make({type:'ReviewRaster',assetId:preview.id})),auth),rv=(await w.events(String(BigInt(r.fromSeq)-1n))).events[0].payload;
 for(let i=0;i<2;i++){const id=randomUUID();await w.assetCreate({protocolVersion:1,stagingId:id,purpose:'caption',expectedBytes:'1',sha256:digest('x'),mediaType:'text/plain'},auth);await w.assetBeginChunk(id,'0',1,auth);}
 const c=make({type:'ApproveRaster',assetId:preview.id,reviewId:rv.reviewId,reviewHash:rv.reviewHash});out.originalCommand=c;assert.equal(await w.rasterCommand(enc(c),auth),null);out.beforeClose=await w.commandState(c.command.commandId);assert.ok(out.beforeClose.pending);await w.close();w=undefined;
 const root=join(base,'private-downgrade');await cp(f.root,root,{recursive:true});out.before=await inspect(root,c.command.commandId);assert.equal(out.before.pending.original,JSON.stringify(c));
 try{w=await openOld({root});out.oldWritableEpoch=w.epoch;const unrelated=command(EMPTY_EXPECTED_VERSIONS,{clientId:auth.clientId,documentId:'downgrade-new-document'});out.oldUnrelatedWrite=await w.submit(enc(unrelated),w.epoch);}catch(e){out.oldOpenError={code:e.code,message:e.message};}finally{if(w){await w.close();w=undefined;}}
 out.afterOld=await inspect(root,c.command.commandId);
 assert.equal(out.before.version.user_version,5);assert.deepEqual(out.oldOpenError,{code:'CORRUPT_STORE',message:'CORRUPT_STORE'});assert.equal(out.oldUnrelatedWrite,undefined);assert.deepEqual(out.afterOld,out.before);

 w=await openWriter({root});for(let i=0;i<1000;i++){out.newState=await w.commandState(c.command.commandId);if(out.newState.record)break;await new Promise(r=>setTimeout(r,5));}await w.close();w=undefined;
 out.afterNew=await inspect(root,c.command.commandId);assert.equal(out.newState.record.receipt.status,'rejected');assert.equal(out.newState.record.command.commandId,c.command.commandId);assert.equal(out.afterOld.pending.hash,out.before.pending.hash);assert.equal(out.afterOld.pending.operation_id,out.before.pending.operation_id);out.originalBytesRetained=digest(await readFile(join(root,'objects','sha256',input.blob.hash.slice(7,9),input.blob.hash.slice(7))))===input.blob.hash;
 out.conclusion='Actual dfa383d refuses schema5 before epoch/journal/domain writes; exact before/after state is unchanged. Corrected code retains original command/operation/source identities and rejects expired approval authority on reopening. Migration and verified rollback backups are separately tested in schema.test.mjs.';
} catch(e){out.error=e.stack;process.exitCode=1;}finally{if(w)await w.close();await writeFile(join(base,'downgrade-results.json'),JSON.stringify(out,null,2)+'\n');for(const fn of cleanup.reverse())await fn();}console.log(JSON.stringify(out,null,2));
