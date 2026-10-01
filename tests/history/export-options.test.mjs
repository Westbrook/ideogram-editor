import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { setup } from '../protocol/helpers.mjs';
import { importRaster, terminal, binary } from '../raster/helpers.mjs';
import { command, encode } from '../store/helpers.mjs';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { copy, preview, workspace, doc as portableDoc } from '../portable/helpers.mjs';

const scope=(layerIds,includeHidden=false)=>({kind:'selected-layers',layerIds,includeHidden});
const options=(selected={kind:'visible-document'},extra={})=>({format:'png',resize:null,matte:null,quality:null,scope:selected,...extra});
const doc=async f=>(await f.read('/api/v1/documents/document_1')).json.projection.value;
const state=async f=>(await f.read('/api/v1/documents/document_1/image')).json;
const objectPath=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const rgba=async(f,id)=>{const response=await binary(f,id);assert.equal(response.status,200);return sharp(response.bytes,{ignoreIcc:true}).ensureAlpha().raw().toBuffer();};
async function events(f,receipt){const response=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));assert.equal(response.status,200,response.text);const batch=response.json.batches[0];if(batch.kind==='inline')return batch.events;const text=await f.read(batch.content.url);return text.text.trim().split('\n').map(line=>JSON.parse(line));}
async function run(f,body,patch={}){const before=await doc(f),c=f.command({expectedDocumentRevision:before.revision,body,...patch}),response=await terminal(f,c);return {command:c,receipt:response.json.receipt,events:response.json.receipt.status==='accepted'?await events(f,response.json.receipt):[]};}
async function edit(f,body){const result=await run(f,body);assert.equal(result.receipt.status,'accepted',JSON.stringify(result.receipt));return result;}
async function set(f,id,properties){const layer=(await state(f)).layers.find(x=>x.id===id);return edit(f,{type:'SetLayerProperties',layerId:id,layerVersion:layer.version,properties,draft:null});}
async function scene(t){
 const cleanup=[];t.after(async()=>{const errors=[];for(const close of cleanup.reverse())try{await close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Export fixture cleanup failed');});
 const f=await setup(t);cleanup.push(()=>f.server.close());assert.equal((await terminal(f,f.command({}, {width:3,height:2}))).json.receipt.status,'accepted');
 const black=(await importRaster(f,'black.png')).asset,white=(await importRaster(f,'white.png')).asset;
 for(const [id,asset,x,y] of [['bottom',black,1,1],['top',white,1,1],['hidden',white,2,0]]){
  await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:id,name:id,draft:null});await edit(f,{type:'ApplyTransform',layerId:id,layerVersion:'1',transform:[1,0,0,1,x,y],draft:null});
 }
 await set(f,'top',{opacity:0.1});await set(f,'hidden',{visible:false,locked:true});
 return {...f,black,white,cleanup:close=>cleanup.push(close)};
}
async function retainedImageContent(f,image){
 const {layers,...document}=image,result=[];
 for(const {id,assetId,...layer} of layers){const response=await f.read('/api/v1/assets/'+assetId);assert.equal(response.status,200,response.text);const asset=response.json.projection.value;
  result.push({...layer,asset:{qualification:asset.qualification,blob:asset.blob,width:asset.raster.width,height:asset.raster.height,pixels:asset.raster.pixels,pixelIdentity:asset.raster.pixelIdentity}});
 }
 return {...document,layers:result};
}
function expected(...entries){const bytes=Buffer.alloc(24);for(const [x,y,pixel]of entries)bytes.set(pixel,(y*3+x)*4);return bytes;}
function lastAsset(result){const event=result.events.at(-1);assert.equal(event.type,'AssetRegistered');return event.payload.asset;}
async function done(w,id){for(let n=0;n<1500;n++){const value=await w.commandState(id);if(value.record)return value.record.receipt;await new Promise(r=>setTimeout(r,5));}throw Error('No terminal receipt for '+id);}
async function writerExport(w,ref,auth,document,opts,commandId){const c=command(ref,{clientId:auth.clientId,expectedDocumentRevision:document.revision,...(commandId?{commandId}:{}),body:{type:'ExportDocument',historyHead:document.historyHead,...(opts===undefined?{}:{options:opts})}});await w.historyCommand(encode(c),auth);const receipt=await done(w,c.command.commandId);return {command:c,receipt,events:receipt.status==='accepted'?(await w.events(String(BigInt(receipt.fromSeq)-1n))).events:[]};}

test('selected exports retain document bounds/order, omit hidden layers by default and include locked hidden layers only explicitly',async t=>{
  const f=await scene(t),before=await doc(f),beforeState=await state(f),beforeHistory=(await f.read('/api/v1/documents/document_1/history')).json;
  // User selection order is reversed. Canonical document stack order still
  // places white alpha26 over black, whose independent CP1 golden is90.
  const selected=await edit(f,{type:'ExportDocument',historyHead:before.historyHead,options:options(scope(['top','bottom','hidden']))}),asset=lastAsset(selected);
  assert.deepEqual([asset.raster.width,asset.raster.height],[3,2]);assert.deepEqual(await rgba(f,asset.id),expected([1,1,[90,90,90,255]]));
  const included=lastAsset(await edit(f,{type:'ExportDocument',historyHead:before.historyHead,options:options(scope(['hidden','top','bottom'],true))}));
  assert.deepEqual(await rgba(f,included.id),expected([1,1,[90,90,90,255]],[2,0,[255,255,255,255]]));
  const one=lastAsset(await edit(f,{type:'ExportDocument',historyHead:before.historyHead,options:options(scope(['top']))}));assert.deepEqual(await rgba(f,one.id),expected([1,1,[255,255,255,26]]));
  assert.ok(selected.events.every(event=>event.type==='AssetRegistered'));
  assert.deepEqual(await doc(f),before);assert.deepEqual(await state(f),beforeState);assert.deepEqual((await f.read('/api/v1/documents/document_1/history')).json,beforeHistory);
 });

test('export formats and preview sizes leave checkpoint, document, native layer identities and undo branch unchanged',async t=>{
  const f=await scene(t);await edit(f,{type:'SaveCheckpoint',name:'Export baseline'});const before=await doc(f),beforeState=await state(f),history=(await f.read('/api/v1/documents/document_1/history')).json,checkpoints=(await f.read('/api/v1/documents/document_1/checkpoints')).json;
  const legacy=lastAsset(await edit(f,{type:'ExportDocument',historyHead:before.historyHead})),explicit=lastAsset(await edit(f,{type:'ExportDocument',historyHead:before.historyHead,options:options()}));
  assert.equal(legacy.blob.hash,explicit.blob.hash);assert.equal(legacy.raster.pixelIdentity,explicit.raster.pixelIdentity);assert.equal(legacy.raster.pixelIdentity,(await f.read('/api/v1/assets/'+before.image.compositeAssetId)).json.projection.value.raster.pixelIdentity);
  const jpeg=lastAsset(await edit(f,{type:'ExportDocument',historyHead:before.historyHead,options:options(scope(['top','bottom']),{format:'jpeg',matte:'#ff0000',quality:0.9,resize:{width:6,height:4}})}));assert.equal(jpeg.qualification,'canonical-jpeg');assert.equal(jpeg.blob.mediaType,'image/jpeg');assert.deepEqual([jpeg.raster.width,jpeg.raster.height],[6,4]);
  const content=await binary(f,jpeg.id),metadata=await sharp(content.bytes,{ignoreIcc:true}).metadata();assert.equal(content.status,200);assert.equal(content.headers['content-type'],'image/jpeg');assert.deepEqual([metadata.width,metadata.height],[6,4]);assert.equal(metadata.hasAlpha,false);
  const manifest=(await f.read('/api/v1/assets/'+jpeg.id+'/raster')).json;assert.deepEqual(manifest.plan.options,{format:'jpeg',resize:{width:6,height:4},matte:'#ff0000',quality:0.9});
  assert.deepEqual(await doc(f),before);assert.deepEqual(await state(f),beforeState);assert.deepEqual((await f.read('/api/v1/documents/document_1/history')).json,history);assert.deepEqual((await f.read('/api/v1/documents/document_1/checkpoints')).json,checkpoints);assert.equal((await f.read('/api/v1/documents/document_1/save-status?sessionId=export_test')).json.documentChangedSinceCheckpoint,false);
  await edit(f,{type:'Undo',historyHead:before.historyHead});const undone=await state(f);assert.equal(undone.layers.find(l=>l.id==='hidden').visible,true);assert.equal(undone.layers.find(l=>l.id==='hidden').locked,false);
 });

test('invalid/missing scope, forbidden encoder defaults and stale history reject without export artifacts or document mutation',async t=>{
  const f=await scene(t),before=await doc(f);
  for(const selected of [scope(['missing']),scope(['hidden'])]){const result=await run(f,{type:'ExportDocument',historyHead:before.historyHead,options:options(selected)});assert.equal(result.receipt.status,'rejected');assert.equal(result.receipt.code,'INVALID_INPUT');assert.deepEqual(await doc(f),before);}
  const stale=await run(f,{type:'ExportDocument',historyHead:'not_current',options:options(scope(['top']))});assert.equal(stale.receipt.status,'rejected');assert.equal(stale.receipt.code,'STALE_REVISION');
  for(const bad of [{...options(),format:'jpeg'},options(scope([])),options(scope(['top','top'])),options({kind:'visible-document',includeHidden:true}),options(scope(['top']),{resize:{width:0,height:2}}),options(scope(['top']),{format:'jpeg',matte:'#ffffff',quality:2})]){
   const c=f.command({expectedDocumentRevision:before.revision,body:{type:'ExportDocument',historyHead:before.historyHead,options:bad}}),response=await f.post('/api/v1/commands',c);assert.equal(response.status,400,response.text);assert.equal((await f.read('/api/v1/commands/'+c.command.commandId)).status,404);
  }
  assert.deepEqual(await doc(f),before);
 });

test('selected export can recover complete selected bytes while excluded hidden pixels are missing',async t=>{
  const f=await scene(t);await set(f,'bottom',{visible:false});const before=await doc(f),missing=objectPath(f.root,f.black.raster.pixels),retained=await readFile(missing);await unlink(missing);
  try{const result=await edit(f,{type:'ExportDocument',historyHead:before.historyHead,options:options(scope(['top']))});assert.deepEqual(await rgba(f,lastAsset(result).id),expected([1,1,[255,255,255,26]]));assert.deepEqual(await doc(f),before);}finally{await writeFile(missing,retained,{mode:0o600});}
 });

test('selected export freezes exact layer set and source revision while an earlier queued delete commits, then replay retains bytes',async t=>{
  const f=await scene(t),frozen=await doc(f),frozenState=await state(f),top=frozenState.layers.find(l=>l.id==='top');await f.server.close();let w=await openWriter({root:f.root});f.cleanup(()=>w.close());
  const auth={clientId:f.paired.json.clientId,sessionHash:'e'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
  const one=await w.assetVerify(f.white.id),two=await w.assetVerify(f.black.id);
  const deletion=command(f.ref,{commandId:'a_delete_before_export',clientId:auth.clientId,expectedDocumentRevision:frozen.revision,body:{type:'DeleteLayer',layerId:top.id,layerVersion:top.version,draft:null}});
  const exp=command(f.ref,{commandId:'z_frozen_selected_export',clientId:auth.clientId,expectedDocumentRevision:frozen.revision,body:{type:'ExportDocument',historyHead:frozen.historyHead,options:options(scope(['top','bottom']))}});
  await w.historyCommand(encode(deletion),auth);await w.historyCommand(encode(exp),auth);await w.assetRelease(one.handle);await w.assetRelease(two.handle);
  assert.equal((await done(w,deletion.command.commandId)).status,'accepted');const receipt=await done(w,exp.command.commandId);assert.equal(receipt.status,'accepted');assert.equal(receipt.documentRevision,frozen.revision);
  const output=(await w.events(String(BigInt(receipt.fromSeq)-1n))).events.at(-1).payload.asset;assert.deepEqual(await readFile(objectPath(f.root,output.raster.pixels)),expected([1,1,[90,90,90,255]]));const current=await w.document('document_1');assert.equal(current.revision,String(BigInt(frozen.revision)+1n));assert.equal((await w.imageState('document_1')).layers.some(l=>l.id==='top'),false);
  assert.deepEqual(await w.historyCommand(encode(exp),auth),receipt);await w.close();w=await openWriter({root:f.root});assert.deepEqual((await w.lookup(exp.command.commandId)).receipt,receipt);assert.deepEqual(await w.document('document_1'),current);assert.deepEqual((await w.assetProjection(output.id)).asset,output);
  const undo=command(f.ref,{clientId:auth.clientId,expectedDocumentRevision:current.revision,body:{type:'Undo',historyHead:current.historyHead}});await w.historyCommand(encode(undo),auth);assert.equal((await done(w,undo.command.commandId)).status,'accepted');assert.deepEqual(await w.imageState('document_1'),frozenState);
 });

test('source loss after export preparation cannot publish a complete JPEG and exact retry retains its rejection',async t=>{
  const f=await scene(t),before=await doc(f),beforeState=await state(f);await f.server.close();const gate=new SharedArrayBuffer(4);let hit;const barrier=new Promise(resolve=>hit=resolve),w=await openWriter({root:f.root},{phase:'history-after-proofs',gate,onBarrier:hit});f.cleanup(()=>w.close());f.cleanup(()=>{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);});
  const auth={clientId:f.paired.json.clientId,sessionHash:'f'.repeat(64),now:Date.now(),expires:Date.now()+1800000},highWater=(await w.capture()).highWater;
  const c=command(f.ref,{clientId:auth.clientId,expectedDocumentRevision:before.revision,body:{type:'ExportDocument',historyHead:before.historyHead,options:options(scope(['top']),{format:'jpeg',matte:'#ffffff',quality:0.9,resize:{width:6,height:4}})}});await w.historyCommand(encode(c),auth);await barrier;
  const path=objectPath(f.root,f.white.raster.pixels);let bytes;try{bytes=await readFile(path);await unlink(path);}finally{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);}
  const receipt=await done(w,c.command.commandId);assert.equal(receipt.status,'rejected');assert.equal(receipt.code,'MISSING_ASSET');assert.deepEqual(await w.document('document_1'),before);assert.deepEqual(await w.imageState('document_1'),beforeState);assert.equal((await w.events(highWater)).events.length,0);
  await writeFile(path,bytes,{mode:0o600});assert.deepEqual(await w.historyCommand(encode(c),auth),receipt);const fresh=await writerExport(w,f.ref,auth,before,c.command.body.options);assert.equal(fresh.receipt.status,'accepted');assert.equal(lastAsset(fresh).qualification,'canonical-jpeg');assert.deepEqual(await w.document('document_1'),before);
 });

test('lossy JPEG exports retain exact bytes through full-history copy, fresh import, re-copy and writer reopen',async t=>{
 const f=await scene(t);await edit(f,{type:'SaveCheckpoint',name:'Portable JPEG baseline'});
 const before=await doc(f),beforeState=await state(f),beforeHistory=(await f.read('/api/v1/documents/document_1/history')).json,beforeCheckpoints=(await f.read('/api/v1/documents/document_1/checkpoints')).json;
 const beforeContent=await retainedImageContent(f,beforeState),beforeComposite=(await f.read('/api/v1/assets/'+before.image.compositeAssetId)).json.projection.value;
 const jpeg=lastAsset(await edit(f,{type:'ExportDocument',historyHead:before.historyHead,options:options(scope(['top','bottom']),{format:'jpeg',matte:'#ff0000',quality:0.9,resize:{width:6,height:4}})})),encoded=(await binary(f,jpeg.id)).bytes,canonical=await readFile(objectPath(f.root,jpeg.raster.pixels));
 // Lossy decoding cannot be used as the identity proof for the retained
 // pre-encoder raster. This fixture must exercise that distinction.
 assert.notDeepEqual(await sharp(encoded,{ignoreIcc:true}).ensureAlpha().raw().toBuffer(),canonical);
 async function restore(bytes,sourceAssetId){
  const inspected=await preview(f,bytes);assert.equal(inspected.review.editable,true,JSON.stringify(inspected.review));
  let after='',mappedId;do{const response=await f.read('/api/v1/bundle-reviews/'+inspected.review.reviewId+'/mapping?kind=asset'+(after?'&after='+encodeURIComponent(after):''));assert.equal(response.status,200,response.text);mappedId??=response.json.items.find(item=>item.sourceId===sourceAssetId)?.localId;after=response.json.next;}while(after);
  assert.ok(mappedId,'review must map the retained JPEG export asset');
  await workspace(f,{type:'ImportBundle',reviewId:inspected.review.reviewId,reviewHash:inspected.review.reviewHash});
  const document=await portableDoc(f,inspected.review.documentId),asset=(await f.read('/api/v1/assets/'+mappedId)).json.projection.value;
  // Fresh namespaces remap layer/asset IDs, which intentionally changes the
  // semantic digest. Verify all authored properties and retained pixels instead.
  const importedState=(await f.read('/api/v1/documents/'+document.id+'/image')).json,composite=(await f.read('/api/v1/assets/'+document.image.compositeAssetId)).json.projection.value;
  assert.notEqual(document.id,before.id);assert.notEqual(mappedId,sourceAssetId);assert.deepEqual(await retainedImageContent(f,importedState),beforeContent);assert.deepEqual(composite.blob,beforeComposite.blob);assert.deepEqual(composite.raster.pixels,beforeComposite.raster.pixels);assert.equal(composite.raster.pixelIdentity,beforeComposite.raster.pixelIdentity);
  assert.equal(asset.qualification,'canonical-jpeg');assert.deepEqual(asset.blob,jpeg.blob);assert.equal(asset.raster.pixelIdentity,jpeg.raster.pixelIdentity);assert.deepEqual((await binary(f,mappedId)).bytes,encoded);assert.deepEqual(await readFile(objectPath(f.root,asset.raster.pixels)),canonical);
  assert.equal((await f.read('/api/v1/documents/'+document.id+'/history')).json.items.length,beforeHistory.items.length);assert.equal((await f.read('/api/v1/documents/'+document.id+'/checkpoints')).json.items.length,beforeCheckpoints.items.length);
  return {document,asset};
 }
 const saved=await copy(f),first=await restore(saved.bytes,jpeg.id),recopied=await copy(f,first.document.id),second=await restore(recopied.bytes,first.asset.id);
 assert.deepEqual(await doc(f),before);assert.deepEqual(await state(f),beforeState);assert.deepEqual((await f.read('/api/v1/documents/document_1/history')).json,beforeHistory);assert.deepEqual((await f.read('/api/v1/documents/document_1/checkpoints')).json,beforeCheckpoints);
 await f.server.close();const w=await openWriter({root:f.root});f.cleanup(()=>w.close());assert.deepEqual(await w.document('document_1'),before);
 for(const restored of [first,second]){assert.deepEqual(await w.document(restored.document.id),restored.document);assert.deepEqual((await w.assetProjection(restored.asset.id)).asset,restored.asset);assert.deepEqual(await readFile(objectPath(f.root,restored.asset.blob)),encoded);assert.deepEqual(await readFile(objectPath(f.root,restored.asset.raster.pixels)),canonical);}
});
