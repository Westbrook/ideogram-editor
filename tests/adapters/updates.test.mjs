import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rootFor, command, encode } from '../store/helpers.mjs';
import { call, pair, cookieFrom, readHeaders, mutationHeaders } from '../session/helpers.mjs';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { startLocalServer } from '../../dist/local/server/http.js';
import { Adapters } from '../../dist/local/server/storage/adapters.js';
import { EMPTY_EXPECTED_VERSIONS } from '../../dist/local/src/protocol/store.js';
import { adapterDependencies } from '../../dist/local/src/protocol/adapters.js';
import { canonical } from '../../dist/local/src/protocol/json.js';

const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const objectPath=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const authority=()=>({clientId:'client_1',sessionHash:'a'.repeat(64),now:Date.now(),expires:Date.now()+3600000});
const envelope=body=>command(EMPTY_EXPECTED_VERSIONS,{documentId:null,body});
function owned(t){const cleanup=[];t.after(async()=>{const errors=[];for(const close of cleanup.reverse())try{await close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Adapter updates fixture cleanup failed');});return {after:close=>cleanup.push(close)};}
async function fixture(t){const owner=owned(t),root=await rootFor(owner),auth=authority();let w;const reopen=async()=>{if(w)await w.close();w=await openWriter({root});const current=w;owner.after(()=>current.close());await current.protocolDefaults();return current;};await reopen();await w.rememberClient(auth.sessionHash,auth.clientId,auth.expires);return {owner,root,auth,get w(){return w;},reopen};}
function weights(count=4){const header=Buffer.from(JSON.stringify({tensor:{dtype:'F32',shape:[count],data_offsets:[0,count*4]}})),prefix=Buffer.alloc(8);prefix.writeBigUInt64LE(BigInt(header.length));return Buffer.concat([prefix,header,Buffer.alloc(count*4,7)]);}
async function original(f,bytes=weights(),purpose='adapter'){
 const stagingId=randomUUID(),hash=sha(bytes);await f.w.assetCreate({protocolVersion:1,stagingId,purpose,expectedBytes:String(bytes.length),sha256:hash,mediaType:purpose==='adapter'?'application/octet-stream':'text/plain'},f.auth);
 if(bytes.length){const token=await f.w.assetBeginChunk(stagingId,'0',bytes.length,f.auth);await f.w.assetChunk(token,bytes,f.auth);}
 const c=envelope({type:'FinalizeStaging',stagingId,expectedSha256:hash});await f.w.assetCommand(encode(c),f.auth);
 for(let n=0;n<1000;n++){const record=await f.w.lookup(c.command.commandId);if(record){assert.equal(record.receipt.status,'accepted',JSON.stringify(record.receipt));return (await f.w.events(String(BigInt(record.receipt.fromSeq)-1n))).events[0].payload.asset;}await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Original import did not settle');
}
async function register(f,source,previous=null,extra={}){
 const c=envelope({type:'RegisterAdapterVersion',adapterId:previous?.adapter.adapterId??null,previousVersionId:previous?.id??null,weightsAssetId:source.id,configAssetId:null,provenanceAssetId:null,name:'Update fixture',declaredFamily:'ideogram-v4',declaredFormat:'fal',provenanceText:'Generic test structure; no provider eligibility claim.',...extra}),receipt=await f.w.adapterCommand(encode(c),f.auth);
 assert.equal(receipt.status,'accepted',JSON.stringify(receipt));return (await f.w.events(String(BigInt(receipt.fromSeq)-1n))).events[0].payload.asset;
}
function snapshot(root){const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return Object.fromEntries(['assets','commands','events_v2','roots','queue_jobs','ui_checkpoints'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all()]));}finally{db.close();}}

test('updates reports the newest exact logical successor with only two metadata entries and leaves retained identities unchanged',async t=>{
 const f=await fixture(t),source=await original(f),first=await register(f,source),current=await f.w.adapterView(first.id);
 assert.deepEqual(await f.w.adapterUpdates(first.id),{protocolVersion:1,current,latest:null});
 const second=await register(f,source,first,{name:'Second version'}),third=await register(f,source,second,{name:'Third version'}),unrelated=await register(f,source,null,{name:'Third version'});
 const before=snapshot(f.root),updates=await f.w.adapterUpdates(first.id);assert.deepEqual(Object.keys(updates).sort(),['current','latest','protocolVersion']);assert.deepEqual(updates.current,current);assert.deepEqual(updates.latest,await f.w.adapterView(third.id));assert.notEqual(updates.latest.adapterId,unrelated.adapter.adapterId);assert.equal(updates.latest.version,'3');assert.equal(updates.latest.locallyEligible,false);assert.equal(updates.latest.runtimeVerified,false);
 assert.deepEqual(await f.w.adapterUpdates(third.id),{protocolVersion:1,current:updates.latest,latest:null});assert.equal((await f.w.adapterUpdates(unrelated.id)).latest,null);assert.deepEqual((await f.w.assetProjection(first.id)).asset,first);assert.deepEqual(snapshot(f.root),before);
 assert.ok(Buffer.byteLength(canonical(updates))<8192);assert.equal(JSON.stringify(updates).includes('tensorSignature'),false);assert.equal(JSON.stringify(updates).includes('data_offsets'),false);
 await f.reopen();assert.deepEqual(await f.w.adapterUpdates(first.id),updates);assert.deepEqual((await f.w.assetProjection(first.id)).asset,first);
});

test('unavailable, incompatible and deleted newest versions remain disclosed without falling back or granting eligibility',async t=>{
 const f=await fixture(t),first=await register(f,await original(f)),second=await register(f,await original(f,weights(5)),first),invalidSource=await original(f,Buffer.from('retained incompatible weights')),config=await original(f,Buffer.from('{}'),'caption'),provenance=await original(f,Buffer.from('Exact retained original provenance'),'caption'),third=await register(f,invalidSource,second,{name:'Incompatible latest',configAssetId:config.id,provenanceAssetId:provenance.id}),current=await f.w.adapterView(first.id);
 let result=await f.w.adapterUpdates(first.id);assert.equal(result.latest.versionId,third.id);assert.equal(result.latest.qualification,'incompatible');assert.equal(result.latest.available,true);assert.equal(result.latest.locallyEligible,false);assert.equal(result.latest.runtimeVerified,false);
 const currentPath=objectPath(f.root,first.blob),currentBytes=await readFile(currentPath);await unlink(currentPath);try{result=await f.w.adapterUpdates(first.id);assert.equal(result.current.versionId,first.id);assert.equal(result.current.available,false);assert.equal(result.current.locallyEligible,false);assert.equal(result.latest.versionId,third.id);assert.equal(result.latest.available,true);}finally{await writeFile(currentPath,currentBytes,{mode:0o600});}
 for(const ref of [third.blob,third.adapter.config,third.adapter.validation.report,third.adapter.origin.provenance,third.adapter.origin.original]){const path=objectPath(f.root,ref),bytes=await readFile(path);await unlink(path);try{result=await f.w.adapterUpdates(first.id);assert.deepEqual(result.current,current);assert.equal(result.latest.versionId,third.id);assert.equal(result.latest.available,false);assert.equal(result.latest.locallyEligible,false);}finally{await writeFile(path,bytes,{mode:0o600});}}
 const prepared=await f.w.adapterCommand(encode(envelope({type:'PreviewAdapterDeletion',versionId:third.id})),f.auth);assert.equal(prepared.status,'accepted');const control=(await f.w.events(String(BigInt(prepared.fromSeq)-1n))).events[0].payload.asset,plan=await f.w.adapterDeletionReview(control.id,f.auth);assert.equal(plan.canDelete,true);
 const deleted=await f.w.adapterCommand(encode(envelope({type:'DeleteAdapterVersion',versionId:third.id,planId:plan.id,token:plan.token})),f.auth);assert.equal(deleted.status,'accepted');
 result=await f.w.adapterUpdates(first.id);assert.deepEqual(result.current,current);assert.equal(result.latest.versionId,third.id);assert.equal(result.latest.available,false);assert.equal(result.latest.locallyEligible,false);assert.match(result.latest.reason,/Deleted/);assert.equal((await f.w.adapterList()).items.some(entry=>entry.versionId===third.id),false);assert.deepEqual((await f.w.assetProjection(third.id)).asset,third);assert.equal((await f.w.adapterUpdates(third.id)).latest,null);
});

test('decimal version ordering is exact beyond 64-bit integers and update reads cannot rewrite retained job or asset rows',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT); CREATE TABLE queue_jobs(id TEXT PRIMARY KEY,json TEXT);');
 const ref={hash:sha('weights'),byteLength:'7',mediaType:'application/octet-stream'},metadata={hash:sha('{}'),byteLength:'2',mediaType:'application/json'};
 const version=(id,number,adapterId='family_1')=>{const adapter={schemaVersion:1,id,adapterId,version:number,name:'Same visible name',weights:ref,config:null,origin:{kind:'import',provenance:metadata,original:null},sources:{weightsAssetId:'original_weights',configAssetId:null,provenanceAssetId:null},declaredFamily:'ideogram-v4',declaredFormat:'fal',qualification:'unverified',validation:{report:metadata,inspector:'safetensors-inspection-1',reason:'Unverified retained fixture',profileId:null,locallyEligible:false,runtimeVerified:false,structure:null}};return {id,version:'1',purpose:'adapter',blob:ref,dependencies:adapterDependencies(adapter),safety:'unknown',availability:'available',qualification:'adapter-version',measuredMediaType:'application/octet-stream',adapter};};
 const insert=asset=>db.prepare('INSERT INTO assets VALUES (?,?)').run(asset.id,canonical(asset));insert(version('z_version_nine','9'));insert(version('a_version_ten','10'));insert(version('unrelated','999999999999999999999999','family_10'));
 const assets={asset:id=>{const row=db.prepare('SELECT json FROM assets WHERE id=?').get(id);return row?JSON.parse(row.json):null;},adapterDeleted:()=>false},noWrite=()=>{throw Error('Update lookup attempted a mutation');},adapters=new Adapters(db,{readRange:()=>Buffer.alloc(0)},assets,()=>{},noWrite,noWrite);
 assert.equal(adapters.updates('z_version_nine').latest.versionId,'a_version_ten');insert(version('z_big_previous','9223372036854775808'));insert(version('a_big_latest','9223372036854775809'));
 const job={id:'retained_job',review:{request:{adapters:[{version:'z_version_nine',hash:ref.hash,scale:'1',runtimeAcknowledged:true}]}},stagePlan:[{role:'adapter:0',versionId:'z_version_nine',original:ref,transport:ref}],attempts:[]};db.prepare('INSERT INTO queue_jobs VALUES (?,?)').run(job.id,canonical(job));
 const beforeAssets=db.prepare('SELECT * FROM assets ORDER BY id').all(),beforeJob=db.prepare('SELECT * FROM queue_jobs').all();assert.equal(adapters.updates('z_version_nine').latest.versionId,'a_big_latest');assert.equal(adapters.updates('z_big_previous').latest.versionId,'a_big_latest');assert.equal(adapters.updates('a_big_latest').latest,null);assert.deepEqual(db.prepare('SELECT * FROM assets ORDER BY id').all(),beforeAssets);assert.deepEqual(db.prepare('SELECT * FROM queue_jobs').all(),beforeJob);
 assert.throws(()=>adapters.updates('../outside'),{code:'MALFORMED_REQUEST'});assert.throws(()=>adapters.updates('unknown'),{code:'NOT_FOUND'});
});

test('public updates route is authenticated, read-only, strict about query parameters and rejects raw original IDs',async t=>{
 const f=await fixture(t),source=await original(f),first=await register(f,source),second=await register(f,source,first),expected=await f.w.adapterUpdates(first.id);await f.w.close();
 const server=await startLocalServer({root:f.root});f.owner.after(()=>server.close());const paired=await pair(server),headers=readHeaders(cookieFrom(paired)),path='/api/v1/adapters/'+first.id+'/updates';
 const before=snapshot(f.root),response=await call(server.origin,path,{headers});assert.equal(response.status,200,response.text);assert.deepEqual(response.json,expected);assert.equal(response.json.latest.versionId,second.id);
 assert.equal((await call(server.origin,path,{headers:readHeaders('')})).status,401);assert.equal((await call(server.origin,path+'?after=cursor',{headers})).status,400);assert.equal((await call(server.origin,path,{method:'POST',headers:mutationHeaders(server,paired),body:{protocolVersion:1}})).status,405);assert.equal((await call(server.origin,'/api/v1/adapters/unknown/updates',{headers})).status,404);assert.equal((await call(server.origin,'/api/v1/adapters/'+source.id+'/updates',{headers})).status,404);assert.equal((await call(server.origin,'/api/v1/adapters/invalid.id/updates',{headers})).status,400);
 assert.deepEqual(snapshot(f.root),before);
});
