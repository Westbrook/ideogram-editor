import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from '../protocol/helpers.mjs';
import { importRaster, terminal } from '../raster/helpers.mjs';
import { command, encode } from '../store/helpers.mjs';
import { openWriter } from '../../dist/local/server/storage/writer.js';

const pathFor=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const placement=()=>({type:'ReviewCandidatePlacement',candidateId:'missing_candidate',mode:'safe-region',placement:'current-document',newDocumentId:null,actualOutput:null,newLayerId:'review_output',name:'Pending encoded candidate',preparation:'encoded-rebuild'});
const make=(f,id,body=placement())=>command(f.ref,{commandId:id,clientId:f.auth.clientId,expectedDocumentRevision:f.document.revision,body});
function own(t){
 const cleanup=[];
 t.after(async()=>{
  const failures=[];
  for(const close of cleanup.reverse())try{await close();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Candidate-review cancellation cleanup failed');
 });
 return {after:close=>cleanup.push(close)};
}
async function writer(f){
 const w=await openWriter({root:f.root});
 // Closing the writer also releases asset readers, including partial setup.
 f.owner.after(()=>w.close());
 await w.protocolDefaults();return w;
}
async function seed(t){
 const owner=own(t),f=await setup(owner),created=f.command({}, {width:3,height:2});
 assert.equal((await terminal(f,created)).json.receipt.status,'accepted');
 const imported=await importRaster(f,'hidden-alpha.png');
 const edit=f.command({expectedDocumentRevision:'1',body:{type:'ImportAsset',assetId:imported.asset.id,layerId:'picture',name:'Original picture',draft:null}});
 assert.equal((await terminal(f,edit)).json.receipt.status,'accepted');
 const document=(await f.read('/api/v1/documents/document_1')).json.projection.value;
 const image=(await f.read('/api/v1/documents/document_1/image')).json;
 const sourceBytes=await readFile(pathFor(f.root,imported.input.blob));
 const sourcePixels=await readFile(pathFor(f.root,imported.asset.raster.pixels));
 const now=Date.now(),auth={clientId:f.paired.json.clientId,sessionHash:'c'.repeat(64),now,expires:now+1800000};
 await f.server.close();
 return {...f,owner,imported,document,image,sourceBytes,sourcePixels,auth};
}
async function holdReaders(f,w){
 const first=await w.assetVerify(f.imported.asset.id),second=await w.assetVerify(f.imported.asset.id);
 {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.assets.activeTransfers,2);}finally{diagnosticRead.release();}}
 return [first,second];
}
async function unchanged(f,w,events){
 assert.deepEqual(await w.document('document_1'),f.document);
 assert.deepEqual(await w.imageState('document_1'),f.image);
 assert.deepEqual(await w.events('0',100),events);
 assert.deepEqual(await readFile(pathFor(f.root,f.imported.input.blob)),f.sourceBytes);
 assert.deepEqual(await readFile(pathFor(f.root,f.imported.asset.raster.pixels)),f.sourcePixels);
}
async function terminalCancellation(f,w,c,result){
 assert.deepEqual(result,{protocolVersion:1,commandId:c.command.commandId,status:'canceled'});
 const record=await w.lookup(c.command.commandId);
 assert.ok(record);assert.deepEqual(record.command,c.command);
 assert.equal(record.receipt.status,'rejected');assert.equal(record.receipt.code,'INVALID_INPUT');
 const details=JSON.parse(await readFile(pathFor(f.root,record.receipt.details),'utf8'));
 assert.deepEqual(details,{kind:'fields',issues:[{path:'command.body',code:'ENCODED_REBUILD_REVIEW_CANCELED'}]});
 assert.deepEqual(await w.commandState(c.command.commandId),{record,pending:null});
 return record.receipt;
}

test('pending encoded candidate review requires original client, saved session and live authority; cancellation and exact replay survive restart',async t=>{
 const f=await seed(t);let w=await writer(f);
 await w.rememberClient(f.auth.sessionHash,f.auth.clientId,f.auth.expires);
 const readers=await holdReaders(f,w),events=await w.events('0',100),c=make(f,'cancel_pending_encoded_candidate');
 // Both real transfer permits remain held throughout admission and cancellation.
 // No provider fixture is needed: the valid missing candidate cannot be read yet.
 assert.equal(await w.historyCommand(encode(c),f.auth),null);
 const pending=await w.commandState(c.command.commandId);
 assert.equal(pending.record,null);assert.equal(pending.pending.phase,'preparing');assert.deepEqual(pending.pending.command,c.command);
 {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.rasters.activeWorkers,0);}finally{diagnosticRead.release();}}
 const denied=async auth=>{
  await assert.rejects(w.cancelCandidateReview(c.command.commandId,auth),{code:'OWNER_REQUIRED'});
  assert.deepEqual(await w.commandState(c.command.commandId),pending);
  assert.equal(await w.lookup(c.command.commandId),null);
  {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.assets.activeTransfers,2);}finally{diagnosticRead.release();}}
  await unchanged(f,w,events);
 };
 const foreign={...f.auth,clientId:'foreign_client',sessionHash:'d'.repeat(64)};
 await w.rememberClient(foreign.sessionHash,foreign.clientId,foreign.expires);await denied(foreign);
 const otherSession={...f.auth,sessionHash:'e'.repeat(64)};
 await w.rememberClient(otherSession.sessionHash,otherSession.clientId,otherSession.expires);await denied(otherSession);
 await denied({...f.auth,expires:f.auth.now});
 await w.forgetClient(f.auth.sessionHash);await denied(f.auth);
 await w.rememberClient(f.auth.sessionHash,f.auth.clientId,f.auth.now);await denied(f.auth);
 await w.rememberClient(f.auth.sessionHash,'foreign_client',f.auth.expires,f.auth.sessionHash);await denied(f.auth);
 await w.rememberClient(f.auth.sessionHash,f.auth.clientId,f.auth.expires,f.auth.sessionHash);
 const result=await w.cancelCandidateReview(c.command.commandId,f.auth),receipt=await terminalCancellation(f,w,c,result);
 assert.deepEqual(await w.cancelCandidateReview(c.command.commandId,f.auth),result);
 assert.deepEqual(await w.historyCommand(encode(c),f.auth),receipt);
 const changed={...c,command:{...c.command,body:{...c.command.body,name:'Changed review identity'}}};
 await assert.rejects(w.historyCommand(encode(changed),f.auth),{code:'COMMAND_ID_REUSE'});
 {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.assets.activeTransfers,2);}finally{diagnosticRead.release();}}
 const encoded=await readFile(pathFor(f.root,f.imported.asset.blob));
 for(const reader of readers)assert.deepEqual(Buffer.from(await w.assetContent(f.imported.asset.id,reader.handle,'0',8)),encoded.subarray(0,8));
 await unchanged(f,w,events);
 for(const reader of readers)await w.assetRelease(reader.handle);
 {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.assets.activeTransfers,0);}finally{diagnosticRead.release();}}
 const previousEpoch=w.epoch;await w.close();w=await writer(f);assert.notEqual(w.epoch,previousEpoch);
 assert.equal(await w.recoverClient(f.auth.sessionHash,f.auth.now),f.auth.clientId);
 assert.deepEqual(await w.cancelCandidateReview(c.command.commandId,f.auth),result);
 assert.deepEqual(await w.historyCommand(encode(c),f.auth),receipt);
 assert.deepEqual(await terminalCancellation(f,w,c,result),receipt);
 {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.rasters.activeWorkers,0);}finally{diagnosticRead.release();}}
 {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.assets.activeTransfers,0);}finally{diagnosticRead.release();}}
 await unchanged(f,w,events);
});

test('candidate-review cancellation rejects ordinary reviews and other history commands without altering pending work',async t=>{
 const f=await seed(t),w=await writer(f);await w.rememberClient(f.auth.sessionHash,f.auth.clientId,f.auth.expires);
 await holdReaders(f,w);const events=await w.events('0',100);
 const {preparation,...ordinary}=placement();
 const commands=[make(f,'ordinary_candidate_review',ordinary),make(f,'ordinary_checkpoint',{type:'SaveCheckpoint',name:'Pending checkpoint'})];
 for(const c of commands)assert.equal(await w.historyCommand(encode(c),f.auth),null);
 const before=await Promise.all(commands.map(c=>w.commandState(c.command.commandId)));
 for(const state of before){assert.equal(state.record,null);assert.equal(state.pending.phase,'preparing');}
 for(const c of commands){
  await assert.rejects(w.cancelCandidateReview(c.command.commandId,f.auth),{code:'MALFORMED_REQUEST'});
  assert.deepEqual(await Promise.all(commands.map(item=>w.commandState(item.command.commandId))),before);
  {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.assets.activeTransfers,2);}finally{diagnosticRead.release();}}
  {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.rasters.activeWorkers,0);}finally{diagnosticRead.release();}}
  await unchanged(f,w,events);
 }
 // Close while readers remain held so these deliberately missing-candidate
 // preparations are never admitted during successful test cleanup.
 await w.close();
});


test('pending cancellation ignores stale or missing source-document preconditions while both IO permits are held',async t=>{
 const f=await seed(t),w=await writer(f);await w.rememberClient(f.auth.sessionHash,f.auth.clientId,f.auth.expires);
 await holdReaders(f,w);const events=await w.events('0',100);
 const stale=make(f,'cancel_stale_candidate_review');stale.command.expectedDocumentRevision='0';
 const missing=make(f,'cancel_missing_document_review');missing.command.documentId='missing_document';missing.command.expectedDocumentRevision='1';
 for(const c of [stale,missing]){
  assert.equal(await w.historyCommand(encode(c),f.auth),null);
  assert.equal((await w.commandState(c.command.commandId)).pending.phase,'preparing');
  const result=await w.cancelCandidateReview(c.command.commandId,f.auth);
  await terminalCancellation(f,w,c,result);
  {const diagnosticRead=await w.readDiagnostics();try{assert.equal(diagnosticRead.value.assets.activeTransfers,2,'cancellation cannot borrow a third IO permit');}finally{diagnosticRead.release();}}
 }
 await unchanged(f,w,events);
});
