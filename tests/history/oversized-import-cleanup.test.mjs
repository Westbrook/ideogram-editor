import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,mkdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setup} from '../protocol/helpers.mjs';
import {original,envelope} from '../raster/helpers.mjs';
import {encode} from '../store/helpers.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';
const fixture=new URL('./oversized-import-cleanup-fixture.mjs',import.meta.url).href;
function owner(t){const work=[];t.after(async()=>{const failures=[];for(const close of work.reverse())try{await close();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'Import cleanup fixture teardown');});return {after:close=>work.push(close)};}
const pathFor=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
async function reached(root,index){for(let i=0;i<3000;i++){try{return JSON.parse(await readFile(join(root,'import-cleanup-'+index+'.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Real import cleanup boundary not reached');}
function saved(root,id){const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return {receipt:JSON.parse(db.prepare('SELECT receipt FROM commands WHERE id=?').get(id).receipt),events:db.prepare('SELECT json FROM events_v2 WHERE command_id=? ORDER BY length(seq),seq').all(id).map(row=>JSON.parse(row.json))};}finally{db.close();}}
for(const phase of ['mode','fsync'])for(const outcome of ['accepted','rejected'])test('import '+outcome+' cleanup '+phase+' failure retains its slot until exact terminal retry finishes durable cleanup',async t=>{
 const own=owner(t),f=await setup(own),input=await original(f,'hidden-alpha.png'),source=await readFile(pathFor(f.root,input.blob));await f.server.close();
 const body={type:'PrepareRaster',assetId:input.id,...(outcome==='rejected'?{importPlan:{inspectionId:'missing-inspection',inspectionHash:'sha256:'+'a'.repeat(64),operation:{kind:'crop',x:0,y:0,width:1,height:1}}}:{})},command=envelope(f,body),id=command.command.commandId;
 await writeFile(join(f.root,'import-cleanup-control.json'),JSON.stringify({phase,commandId:id}),{mode:0o600});
 const w=await openWriter({root:f.root},{setupModule:fixture});own.after(()=>w.close());await w.protocolDefaults();
 const auth={clientId:f.paired.json.clientId,sessionHash:'c'.repeat(64),now:Date.now(),expires:Date.now()+1800000};await w.rememberClient(auth.sessionHash,auth.clientId,auth.expires);
 const neighbor=join(f.root,'raster-work','unrelated-import');await mkdir(neighbor,{mode:0o700});await writeFile(join(neighbor,'keep'),'untouched',{mode:0o600});
 assert.equal(await w.rasterCommand(encode(command),auth),null);const held=await reached(f.root,1),before=saved(f.root,id);assert.equal(before.receipt.status,outcome);assert.equal(held.retained,true);assert.equal(held.inventory.activeTransfers,1);if(outcome==='accepted')assert.ok(BigInt(held.inventory.reservedBytes)>0n);assert.equal(held.rows.length,1);assert.equal(held.auth,false);assert.equal(held.paused,false);
 if(phase==='mode'){assert.equal(held.error,'ROOT_UNSAFE');await chmod(held.rows[0].path,0o700);}else{assert.equal(held.error,'EIO');assert.equal(held.attempts,1);await assert.rejects(stat(held.rows[0].path),{code:'ENOENT'});}
 const exported=before.events.find(event=>event.type==='AssetRegistered')?.payload.asset,output=exported?await readFile(pathFor(f.root,exported.blob)):null;
 assert.deepEqual(await w.rasterCommand(encode(command),auth),before.receipt);const clean=await reached(f.root,2);assert.equal(clean.error,null);assert.deepEqual(clean.rows,[]);assert.equal(clean.retained,false);assert.deepEqual(clean.inventory,{reservedBytes:'0',activeTransfers:0});assert.equal(clean.auth,false);assert.equal(clean.paused,false);if(phase==='fsync')assert.equal(clean.attempts,2);
 assert.deepEqual(saved(f.root,id),before);assert.equal((await w.commandState(id)).pending,null);assert.deepEqual(await readFile(pathFor(f.root,input.blob)),source);if(exported)assert.deepEqual(await readFile(pathFor(f.root,exported.blob)),output);assert.equal(await readFile(join(neighbor,'keep'),'utf8'),'untouched');assert.deepEqual(await w.rasterCommand(encode(command),auth),before.receipt);
});
