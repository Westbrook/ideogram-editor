import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setup} from '../protocol/helpers.mjs';
import {encode} from '../store/helpers.mjs';
import {importRaster,operate,terminal,layer} from './helpers.mjs';
import {doc,edit,upload,workspace} from '../portable/helpers.mjs';
import {openWriter} from '../../dist/local/server/storage/writer.js';

async function settled(w,c){
 for(let i=0;i<1500;i++){const result=await w.commandState(c.command.commandId);if(result.record)return result.record;await new Promise(r=>setTimeout(r,5));}
 const diagnosticRead=await w.readDiagnostics();try{assert.fail('Preparation did not settle: '+JSON.stringify(diagnosticRead.value));}finally{diagnosticRead.release();}
}
for(const mode of ['baseline-matching','baseline-record','decode-original','import-image','import-original','compose-image','compose-mask','export-input','approval-preview','approval-original'])test('final raster acceptance binds consulted input records: '+mode,async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));
 const image=await importRaster(f,'hidden-alpha.png'),other=await importRaster(f,'mask.png');
 await edit(f,{type:'ImportAsset',assetId:image.asset.id,layerId:'picture',name:'Original',draft:null});
 const a=(await operate(f,{type:'PrepareMask',plan:{width:3,height:2,feather:2,operations:[{kind:'fill'}]}})).event.payload.asset;
 const b=(await operate(f,{type:'PrepareMask',plan:{width:3,height:2,feather:2,operations:[{kind:'clear'}]}})).event.payload.asset;
 const manifest=(await f.read('/api/v1/assets/'+a.id+'/raster')).json;
 await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{mask:{assetId:a.id,mapping:'document-r16-v1',inverted:false}},draft:null});
 await edit(f,{type:'CropDocument',x:1,y:0,width:2,height:2,draft:null});
 const state=(await f.read('/api/v1/documents/document_1/image')).json,plan={schemaVersion:2,width:2,height:2,feather:0,operations:[{kind:'retained-hard-v1',mask:state.layers[0].mask,hard:manifest.plan.hard}]};
 const raw=Buffer.from(JSON.stringify({schema:'local-mask-2',layerVersion:state.layers[0].version,radius:'0',plan})),st=await upload(f,raw,'caption','text/plain');
 const caption=(await workspace(f,{type:'FinalizeStaging',stagingId:st.stagingId,expectedSha256:st.sha256})).event.payload.asset,before=await doc(f);
 const saved=await f.post('/api/v1/ui/authority',{protocolVersion:1,requestId:randomUUID(),sessionId:'authority',expectedUISeq:'0',body:{type:'SaveDraft',draft:{id:'mask',generation:'1',kind:'mask',documentId:'document_1',targetLayerId:'picture',expectedDocumentRevision:before.revision,assetId:caption.id,composing:false}}});assert.equal(saved.json.status,'accepted');
 const ui=(await f.read('/api/v1/ui/authority')).json;
 let body={type:'PrepareMask',plan},original=a,replacement=b;
 if(mode==='decode-original'){body={type:'PrepareRaster',assetId:image.input.id};original=image.input;replacement=other.input;}
 if(mode.startsWith('import-')){body={type:'PrepareMask',plan:{width:3,height:2,feather:0,operations:[{kind:'import',assetId:image.asset.id,x:0,y:0,width:3,height:2,inverted:false}]}};original=mode==='import-image'?image.asset:image.input;replacement=mode==='import-image'?other.asset:other.input;}
 if(mode.startsWith('compose-')){body={type:'ComposeRaster',width:3,height:2,layers:[layer(image.asset.id,{mask:{assetId:a.id,mapping:'document-r16-v1',inverted:false}})]};if(mode==='compose-image'){original=image.asset;replacement=other.asset;}}
 if(mode==='export-input'){body={type:'ExportRaster',assetId:image.asset.id};original=image.asset;replacement=other.asset;}
 await f.server.close();const gate=new SharedArrayBuffer(4);let hit;
 const reached=new Promise(r=>hit=r),approval=mode.startsWith('approval-'),phase=approval?'raster-approval-after-proofs':'raster-before-register';
 const w=await openWriter({root:f.root},{phase,gate,onBarrier:hit}),release=()=>{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);};
 try{
  const auth={clientId:f.paired.json.clientId,sessionHash:'f'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
  if(approval){await w.rememberClient(auth.sessionHash,auth.clientId,auth.expires);const reviewCommand=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'ReviewRaster',assetId:image.preview.id}}),r=await w.rasterCommand(encode(reviewCommand),auth),rv=(await w.events(String(BigInt(r.fromSeq)-1n))).events[0].payload;body={type:'ApproveRaster',assetId:image.preview.id,reviewId:rv.reviewId,reviewHash:rv.reviewHash};original=mode==='approval-preview'?image.preview:image.input;replacement=mode==='approval-preview'?{...image.preview,version:'2'}:other.input;}
  const c=f.command({documentId:null,expectedDocumentRevision:null,body});assert.equal(await w.rasterCommand(encode(c),auth),null);
  let timer;try{await Promise.race([reached,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Final boundary not reached')),15000);})]);}finally{clearTimeout(timer);}
  const db=new DatabaseSync(join(f.root,'metadata.sqlite'));let operationId;
  try{const pending=db.prepare('SELECT * FROM raster_preparations WHERE id=?').get(c.command.commandId);operationId=pending.operation_id;assert.deepEqual(JSON.parse(pending.original),c);if(mode!=='baseline-matching')db.prepare('UPDATE assets SET json=? WHERE id=?').run(JSON.stringify({...replacement,id:original.id}),original.id);}finally{db.close();release();}
  const record=await settled(w,c),matching=mode==='baseline-matching';assert.equal(record.receipt.status,matching?'accepted':'rejected');if(!matching)assert.equal(record.receipt.code,'STALE_REVISION');assert.deepEqual(record.command,c.command);
  assert.deepEqual(await w.document('document_1'),before);assert.deepEqual(await w.uiRead('authority',auth),ui);
  assert.deepEqual(await readFile(join(f.root,'objects','sha256',caption.blob.hash.slice(7,9),caption.blob.hash.slice(7))),raw);
  const inspect=new DatabaseSync(join(f.root,'metadata.sqlite'));
  try{
   assert.equal(Number(inspect.prepare('SELECT count(*) AS n FROM assets WHERE id=?').get(operationId).n),matching?1:0);
   assert.equal(Number(inspect.prepare('SELECT count(*) AS n FROM roots WHERE owner=?').get('asset:'+operationId).n)>0,matching);
   assert.equal(Number(inspect.prepare('SELECT count(*) AS n FROM raster_preparations WHERE id=?').get(c.command.commandId).n),0);
   const events=inspect.prepare('SELECT json FROM events_v2 WHERE command_id=?').all(c.command.commandId).map(x=>JSON.parse(x.json));assert.equal(events.filter(e=>e.type==='AssetRegistered').length,matching?1:0);
   if(!matching)inspect.prepare('UPDATE assets SET json=? WHERE id=?').run(JSON.stringify(original),original.id);
  }finally{inspect.close();}
  assert.deepEqual(await w.rasterCommand(encode(c),auth),record.receipt);
  await assert.rejects(w.rasterCommand(encode(c),{...auth,clientId:'other-client'}),{code:'OWNER_REQUIRED'});
  const next=f.command({documentId:null,expectedDocumentRevision:null,body});await w.rasterCommand(encode(next),auth);assert.equal((await settled(w,next)).receipt.status,'accepted');
  assert.deepEqual(await w.document('document_1'),before);assert.deepEqual(await w.uiRead('authority',auth),ui);
  t.diagnostic(JSON.stringify({mode,phase,commandId:c.command.commandId,operationId,status:record.receipt.status,subsequent:'accepted',documentUnchanged:true,draftUnchanged:true}));
 }finally{release();await w.close();}
});
