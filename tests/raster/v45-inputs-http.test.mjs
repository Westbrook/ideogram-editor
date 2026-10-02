import {emptyComposition,emptyElement} from '../../dist/local/src/composition/core.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
// Additive staged tests; run only after the coordinated overlay is promoted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {setup} from '../protocol/helpers.mjs';
import {encode} from '../store/helpers.mjs';
import {importRaster,operate,terminal} from './helpers.mjs';
import {doc,edit,copy,preview,workspace,upload} from '../portable/helpers.mjs';
import {bindRequestMask,confirmRequestMask} from '../../dist/local/src/request/core.js';
import {newV45EditDraft} from '../../dist/local/src/request/family.js';
import {openWriter} from '../../dist/local/server/storage/writer.js';

const objectPath=(f,ref)=>join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const bytes=(f,ref)=>readFile(objectPath(f,ref));
function rows(f,sql,...params){const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{return db.prepare(sql).all(...params);}finally{db.close();}}
async function fixture(t,full=false){
 const f=await setup(t);assert.equal((await terminal(f,f.command({}, {width:4,height:1}))).json.receipt.status,'accepted');
 const native=await importRaster(f,'white.png');await edit(f,{type:'ImportAsset',assetId:native.asset.id,layerId:'picture',name:'Captured source',draft:null});
 const captured=(await edit(f,{type:'PrepareRequestSource',scope:'single-layer',layerIds:['picture']})).event.payload.asset;
 const sourceManifest=(await f.read('/api/v1/assets/'+captured.id+'/raster')).json,c=sourceManifest.plan.capture;
 const source={assetId:captured.id,version:captured.version,blob:captured.blob,pixels:captured.raster.pixels,width:4,height:1,scope:c.scope,documentRevision:c.documentRevision,capture:captured.raster.manifest};
 const maskAsset=(await operate(f,{type:'PrepareRequestMask',sourceAssetId:captured.id,plan:{width:4,height:1,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:0,y:0,width:full?4:1,height:1},mode:'replace'}]},clip:null})).event.payload.asset;
 const maskManifest=(await f.read('/api/v1/assets/'+maskAsset.id+'/raster')).json,mask={assetId:maskAsset.id,version:maskAsset.version,blob:maskAsset.blob,pixels:maskAsset.raster.pixels,width:4,height:1,sourceHash:source.pixels.hash,polarity:'white-edit',empty:false,full,fullAcknowledged:full,plan:maskAsset.raster.manifest,binding:bindRequestMask(source)};
 mask.requestPlan=confirmRequestMask(source,mask,maskManifest.plan.hard,maskManifest.plan.effective,'v45_mask_approval');
 return {f,native,captured,source,mask,maskAsset,maskManifest};
}
async function settled(writer,command){for(let i=0;i<1500;i++){const result=await writer.commandState(command.command.commandId);if(result.record)return result.record;await new Promise(r=>setTimeout(r,5));}assert.fail('V45 preparation did not settle');}

test('HTTP preparation publishes one immutable source/mask/reference bundle without document or provider effects',async t=>{
 const {f,source,mask,maskManifest}=await fixture(t),before=await doc(f),body={type:'PrepareV45EditInputs',source,mask,references:[source,source]},original=structuredClone(body);
 const originals=[source.blob,source.pixels,source.capture,mask.blob,mask.pixels,mask.plan,maskManifest.plan.hard,maskManifest.plan.effective],saved=await Promise.all(originals.map(ref=>bytes(f,ref)));
 const accepted=await operate(f,body),asset=accepted.event.payload.asset,manifest=(await f.read('/api/v1/assets/'+asset.id+'/raster')).json,p=manifest.plan;
 assert.equal(p.kind,'v45-edit-inputs-1');assert.equal(asset.qualification,'canonical-raster');assert.equal(asset.raster.role,'composite');assert.equal(Object.hasOwn(asset,'retainedMetadata'),false);
 assert.deepEqual(p.original,{source,mask});assert.deepEqual(p.requestPlan,mask.requestPlan);assert.deepEqual(p.assetBindings,{source:source.assetId,mask:mask.assetId,references:[source.assetId,source.assetId]});
 assert.deepEqual(p.references.map(r=>r.original),[source,source]);assert.deepEqual(p.references[0].input,p.references[1].input);
 assert.deepEqual(await bytes(f,asset.raster.pixels),await bytes(f,source.pixels));assert.deepEqual(await bytes(f,p.mask.pixels),Buffer.from([0,0,0,255,255,255,255,255,255,255,255,255,255,255,255,255]));
 assert.deepEqual(await sharp(await bytes(f,p.mask.blob)).ensureAlpha().raw().toBuffer(),await bytes(f,p.mask.pixels));assert.deepEqual([p.mask.editPixels,p.mask.keepPixels],[1,3]);
 assert.deepEqual(await Promise.all(originals.map(ref=>bytes(f,ref))),saved);assert.deepEqual(body,original);assert.deepEqual(await doc(f),before);
 const owner='request-mask:document_1:'+asset.id,owned=new Set(rows(f,'SELECT hash FROM roots WHERE owner=?',owner).map(r=>r.hash));
 for(const ref of [asset.blob,asset.raster.manifest,asset.raster.pixels,p.input,p.mask.blob,p.mask.pixels,p.mask.manifest,...originals,...p.references.flatMap(r=>Object.values(r.input).filter(v=>v&&typeof v==='object'&&'hash'in v))])assert(owned.has(ref.hash),'Missing atomic ownership: '+ref.hash);
 const duplicate=await terminal(f,accepted.command);assert.deepEqual(duplicate.json.receipt,accepted.receipt);
 assert.equal(rows(f,"SELECT json FROM events_v2 WHERE command_id=? AND json_extract(json,'$.type')='AssetRegistered'",accepted.command.command.commandId).length,1);
 assert.deepEqual(rows(f,'SELECT id FROM raster_preparations'),[]);assert.deepEqual((await f.read('/api/v1/queue')).json.jobs,[]);assert.deepEqual(await readdir(join(f.root,'backend-transport')),[]);
});

test('source-only V45 preparation preserves source dimensions and has no mask or requested output-size conversion',async t=>{
 const {f,source}=await fixture(t),before=await doc(f),result=await operate(f,{type:'PrepareV45EditInputs',source,mask:null,references:[]}),asset=result.event.payload.asset,manifest=(await f.read('/api/v1/assets/'+asset.id+'/raster')).json;
 assert.deepEqual([asset.raster.width,asset.raster.height],[source.width,source.height]);assert.deepEqual(asset.raster.pixels,source.pixels);assert.equal(manifest.plan.mask,null);assert.equal(manifest.plan.requestPlan,null);assert.deepEqual(manifest.plan.references,[]);assert.deepEqual(await doc(f),before);
 const malformed=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PrepareV45EditInputs',source,mask:null,references:[],outputSize:{width:1024,height:1024}}});assert.equal((await f.post('/api/v1/commands',malformed)).status,400);
});

test('full V45 provider mask rejects durably without a partial registered asset',async t=>{
 const {f,source,mask}=await fixture(t,true),before=await doc(f),command=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PrepareV45EditInputs',source,mask,references:[]}}),result=await terminal(f,command);
 assert.equal(result.json.receipt.status,'rejected');assert.equal(result.json.receipt.code,'INVALID_INPUT');assert.match((await bytes(f,result.json.receipt.details)).toString('utf8'),/RASTER_V45_EDIT_MASK_HOMOGENEOUS/);
 assert.deepEqual(rows(f,'SELECT id FROM raster_preparations WHERE id=?',command.command.commandId),[]);assert.deepEqual(rows(f,"SELECT json FROM events_v2 WHERE command_id=? AND json_extract(json,'$.type')='AssetRegistered'",command.command.commandId),[]);assert.deepEqual(await doc(f),before);
 assert.deepEqual((await terminal(f,command)).json.receipt,result.json.receipt);assert.deepEqual((await f.read('/api/v1/queue')).json.jobs,[]);
});

test('selected reference retains its full captured composite through origin deletion, GC and destination copy',async t=>{
 const {f,native}=await fixture(t),read=f.read.bind(f),leases=new Set();
 f.read=async(...args)=>{const result=await read(...args);if(result.json?.recovery?.recoveryId)leases.add(result.json.recovery.recoveryId);return result;};
 const release=async()=>{for(const id of leases)assert.equal((await f.post('/api/v1/recovery/'+id+'/release',{protocolVersion:1})).status,204);leases.clear();};
 const overlay=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:overlay.asset.id,layerId:'other_picture',name:'Outside selected reference',draft:null});
 // The selected reference owns a valid >64 KiB Composition and its opaque
 // authored leaf. V45 preparation must traverse that typed edge at 1 MiB.
 const stageCompositionBytes=async bytes=>{const input=await upload(f,bytes,'text','application/octet-stream');return (await operate(f,{type:'FinalizeStaging',stagingId:input.stagingId,expectedSha256:input.sha256})).event.payload.asset.blob;};
 const semantic=emptyComposition(4,1,randomUUID());
 for(let index=0;index<40;index++){const element=emptyElement('obj','retained_'+index);element.excluded=true;element.desc.value='x'.repeat(2048);semantic.elements.push(element);}
 semantic.raw=[await stageCompositionBytes(Buffer.from('{opaque, not JSON}\n'))];
 const semanticBytes=Buffer.from(canonical(semantic));assert(semanticBytes.length>65536&&semanticBytes.length<=1048576);
 const semanticRef={id:semantic.id,value:{...await stageCompositionBytes(semanticBytes),mediaType:'application/json'},bindings:{}};
 await edit(f,{type:'CommitCompositionVersion',composition:semanticRef,draft:null});
 const selected=(await edit(f,{type:'PrepareRequestSource',scope:'selected-layers',layerIds:['picture']})).event.payload.asset;
 const selectedManifest=(await f.read('/api/v1/assets/'+selected.id+'/raster')).json,capture=selectedManifest.plan.capture;
 const full=(await f.read('/api/v1/assets/'+capture.image.compositeAssetId)).json.projection.value;
 assert.notEqual(full.raster.pixels.hash,selected.raster.pixels.hash,'The unselected layer must change the full document composite');
 assert(!selected.raster.sourceAssetIds.includes(full.id),'The retained composite needs its own capture.image edge');
 const reference={assetId:selected.id,version:selected.version,blob:selected.blob,pixels:selected.raster.pixels,width:4,height:1,scope:capture.scope,documentRevision:capture.documentRevision,capture:selected.raster.manifest};
 const retained=[selected.blob,selected.raster.manifest,selected.raster.pixels,full.blob,full.raster.manifest,full.raster.pixels,capture.image.state,semanticRef.value,...semantic.raw],originalBytes=await Promise.all(retained.map(ref=>bytes(f,ref)));
 const destination='reference_destination';assert.equal((await terminal(f,f.command({documentId:destination},{width:4,height:1}))).json.receipt.status,'accepted');
 await edit(f,{type:'ImportAsset',assetId:native.asset.id,layerId:'destination_picture',name:'Destination source',draft:null},destination);
 const sourceAsset=(await edit(f,{type:'PrepareRequestSource',scope:'single-layer',layerIds:['destination_picture']},destination)).event.payload.asset;
 const sourceManifest=(await f.read('/api/v1/assets/'+sourceAsset.id+'/raster')).json,source={assetId:sourceAsset.id,version:sourceAsset.version,blob:sourceAsset.blob,pixels:sourceAsset.raster.pixels,width:4,height:1,scope:sourceManifest.plan.capture.scope,documentRevision:sourceManifest.plan.capture.documentRevision,capture:sourceAsset.raster.manifest};
 const prepared=(await operate(f,{type:'PrepareV45EditInputs',source,mask:null,references:[reference]})).event.payload.asset,manifest=(await f.read('/api/v1/assets/'+prepared.id+'/raster')).json;
 // Check the preparation owner before a saved draft can add another owner.
 const owner='request-mask:'+destination+':'+prepared.id,owned=new Set(rows(f,'SELECT hash FROM roots WHERE owner=?',owner).map(r=>r.hash));
 for(const ref of retained)assert(owned.has(ref.hash),'Prepared reference graph omitted '+ref.hash);
 const caption=async text=>{const staged=await upload(f,Buffer.from(text),'caption','text/plain');return (await operate(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;};
 const prompt=await caption('Retain the exact selected reference'),draft=newV45EditDraft(prompt.blob,'transform-v45');
 draft.source=source;draft.references=[reference];draft.preparedInputs={assetId:prepared.id,version:prepared.version,manifest:prepared.raster.manifest,source:{blob:prepared.blob,pixels:prepared.raster.pixels,manifest:prepared.raster.manifest,pixelIdentity:prepared.raster.pixelIdentity,width:4,height:1},mask:null,references:manifest.plan.references.map(r=>r.input)};
 const rawDraft=JSON.stringify(draft),draftAsset=await caption(rawDraft),session='v45_retention',ui=(await f.read('/api/v1/ui/'+session)).json;
 const saved=await f.post('/api/v1/ui/'+session,{protocolVersion:1,requestId:randomUUID(),sessionId:session,expectedUISeq:ui.uiSeq,body:{type:'SaveDraft',draft:{id:'reference_request',generation:'1',kind:'request',documentId:destination,targetLayerId:null,expectedDocumentRevision:(await doc(f,destination)).revision,assetId:draftAsset.id,composing:false}}});assert.equal(saved.json.status,'accepted',saved.text);
 const origin=await doc(f);await release();await operate(f,{type:'PreviewDocumentDeletion',documentId:origin.id,expectedRevision:origin.revision});
 const deletion=(await f.read('/api/v1/documents/'+origin.id+'/deletion')).json.plan;
 await operate(f,{type:'DeleteDocument',documentId:origin.id,planId:deletion.id,planHash:deletion.planHash,expectedRevision:deletion.documentRevision,rootGeneration:deletion.rootGeneration,acknowledgeRunningAndUncertain:true});await release();
 await operate(f,{type:'CollectDocumentGarbage',documentId:origin.id});const collected=(await f.read('/api/v1/documents/'+origin.id+'/deletion')).json.receipt;assert.equal(collected.status,'cleanup-complete');assert.equal(collected.pendingBytes,'0');
 assert.deepEqual(await Promise.all(retained.map(ref=>bytes(f,ref))),originalBytes);assert.equal((await bytes(f,draftAsset.blob)).toString(),rawDraft);
 const copied=await copy(f,destination),fresh=await setup(t),inspected=await preview(fresh,copied.bytes);assert.equal(inspected.review.editable,true,JSON.stringify(inspected.review));
 await workspace(fresh,{type:'ImportBundle',reviewId:inspected.review.reviewId,reviewHash:inspected.review.reviewHash});
 assert.deepEqual(await Promise.all(retained.map(ref=>bytes(fresh,ref))),originalBytes);assert.equal((await bytes(fresh,draftAsset.blob)).toString(),rawDraft);
 const recopied=await copy(fresh,inspected.review.documentId);assert(recopied.bytes.length>0);
 for(const state of [f,fresh]){assert.deepEqual((await state.read('/api/v1/queue')).json.jobs,[]);assert.deepEqual(await readdir(join(state.root,'backend-transport')),[]);}
});

for(const role of ['source','mask','native-original'])test('V45 final commit rejects a changed consulted '+role+' record atomically',async t=>{
 const {f,source,mask,captured,maskAsset,native}=await fixture(t),before=await doc(f),original=role==='source'?captured:role==='mask'?maskAsset:native.input;
 await f.server.close();const gate=new SharedArrayBuffer(4);let hit;const reached=new Promise(resolve=>hit=resolve),writer=await openWriter({root:f.root},{phase:'v45-edit-inputs-before-register',gate,onBarrier:hit});
 const release=()=>{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);};
 try{
  const auth={clientId:f.paired.json.clientId,sessionHash:'f'.repeat(64),now:Date.now(),expires:Date.now()+1800000},command=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PrepareV45EditInputs',source,mask,references:[]}});
  assert.equal(await writer.rasterCommand(encode(command),auth),null);let timer;try{await Promise.race([reached,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('V45 final boundary not reached')),15000);})]);}finally{clearTimeout(timer);}
  const db=new DatabaseSync(join(f.root,'metadata.sqlite'));let outputId;try{outputId=db.prepare('SELECT operation_id FROM raster_preparations WHERE id=?').get(command.command.commandId).operation_id;db.prepare('UPDATE assets SET json=? WHERE id=?').run(JSON.stringify({...original,version:String(BigInt(original.version)+1n)}),original.id);}finally{db.close();release();}
  const record=await settled(writer,command);assert.equal(record.receipt.status,'rejected');assert.equal(record.receipt.code,'STALE_REVISION');assert.deepEqual(await writer.document('document_1'),before);
  assert.deepEqual(rows(f,'SELECT id FROM assets WHERE id=?',outputId),[]);assert.deepEqual(rows(f,'SELECT hash FROM roots WHERE owner=?','request-mask:document_1:'+outputId),[]);assert.deepEqual(rows(f,'SELECT id FROM raster_preparations WHERE id=?',command.command.commandId),[]);
  assert.deepEqual(await writer.rasterCommand(encode(command),auth),record.receipt);
  const restore=new DatabaseSync(join(f.root,'metadata.sqlite'));try{restore.prepare('UPDATE assets SET json=? WHERE id=?').run(JSON.stringify(original),original.id);}finally{restore.close();}
 }finally{release();await writer.close();}
});
