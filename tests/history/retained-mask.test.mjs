import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {setup,terminal,doc,edit,copy,preview,workspace,upload,binary} from '../portable/helpers.mjs';
import {importRaster,operate} from '../raster/helpers.mjs';
import {reopen} from '../text-state/prior-writer.mjs';
import {cookieFrom} from '../protocol/helpers.mjs';
const state=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id+'/image')).json;
const rgba=async(f,id)=>[...await sharp((await binary(f,'/api/v1/assets/'+id+'/content')).bytes).ensureAlpha().raw().toBuffer()];
const objectPath=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const Z=[0,0,0,0],R=[255,0,0,128],G=[0,255,0,255],B=[0,0,255,64],W=[255,255,255,255],K=[0,0,0,255];
async function seed(t,legacy=false,inverted=false){const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const image=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:image.asset.id,layerId:'picture',name:'Original',draft:null});
 const plan={width:3,height:2,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:1,y:0,width:1,height:2},mode:'replace'}]};
 const mask=legacy?(await importRaster(f,'mask.png')).asset:(await operate(f,{type:'PrepareMask',plan})).event.payload.asset;
 await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{mask:{assetId:mask.id,mapping:legacy?'document-luminance-alpha-v1':'document-r16-v1',inverted}},draft:null});
 const manifest=(await f.read('/api/v1/assets/'+mask.id+'/raster')).json;return {f,image,mask,manifest};}
for(const legacy of [false,true])for(const inverted of [false,true])test(`retained-grid-v1 literal crop/resize/expansion, history and copies ${legacy?'legacy':'R16'} inverted=${inverted}`,async t=>{
 const {f,image,mask,manifest}=await seed(t,legacy,inverted),before=await doc(f),originals=new Map();
 for(const ref of [image.input.blob,mask.blob,mask.raster.manifest,...(legacy?[]:[manifest.plan.hard,manifest.plan.effective])])originals.set(ref.hash,await readFile(objectPath(f.root,ref)));
 // Literal expected contribution cells, including the legacy half-coverage pixel.
 const cells=inverted?(legacy?[Z,Z,[0,255,0,127],B,Z,K]:[Z,Z,G,B,Z,K]):(legacy?[Z,R,[0,255,0,128],Z,W,Z]:[Z,R,Z,Z,W,Z]);
 assert.deepEqual(await rgba(f,before.image.compositeAssetId),cells.flat());
 const crop=await edit(f,{type:'CropDocument',x:1,y:0,width:2,height:2,draft:null});assert.equal(BigInt(crop.document.revision),BigInt(before.revision)+1n);const batch=(await f.read('/api/v1/events?after='+String(BigInt(crop.receipt.fromSeq)-1n))).json.batches[0];assert.equal(batch.kind,'inline');assert.equal(new Set(batch.events.map(e=>e.transactionId)).size,1);assert.equal(batch.events.filter(e=>e.type==='ImageEdited').length,1);
 let s=await state(f);assert.equal(s.schemaVersion,4);assert.deepEqual(s.layers[0].mask,{assetId:mask.id,mapping:legacy?'retained-luminance-alpha-v1':'retained-r16-v1',inverted,offsetX:-1,offsetY:0,width:3,height:2,outside:'zero'});assert.deepEqual(await rgba(f,crop.document.image.compositeAssetId),[cells[1],cells[2],cells[4],cells[5]].flat());
 await edit(f,{type:'Undo',historyHead:crop.document.historyHead});assert.equal((await doc(f)).image.compositeAssetId,before.image.compositeAssetId);await edit(f,{type:'Redo',historyNode:crop.document.historyHead});
 const expanded=await edit(f,{type:'ResizeCanvas',width:4,height:3,offsetX:1,offsetY:1,draft:null});assert.deepEqual(await rgba(f,expanded.document.image.compositeAssetId),[Z,Z,Z,Z,...cells.slice(0,3),Z,...cells.slice(3),Z].flat());
 const shift=await edit(f,{type:'ResizeCanvas',width:4,height:3,offsetX:-1,offsetY:-1,draft:null});assert.deepEqual(await rgba(f,shift.document.image.compositeAssetId),[cells[1],cells[2],Z,Z,cells[4],cells[5],Z,Z,Z,Z,Z,Z].flat());
 await edit(f,{type:'ResizeCanvas',width:1,height:1,offsetX:0,offsetY:0,draft:null});const restored=await edit(f,{type:'ResizeCanvas',width:3,height:2,offsetX:1,offsetY:0,draft:null});assert.deepEqual(await rgba(f,restored.document.image.compositeAssetId),cells.flat());
 for(const [hash,bytes]of originals)assert.deepEqual(await readFile(objectPath(f.root,{hash})),bytes);
 let id='document_1';for(let n=0;n<2;n++){const saved=await copy(f,id),review=(await preview(f,saved.bytes)).review;assert.equal(review.formatVersion,n===0?7:9);assert.equal(review.editable,true,JSON.stringify(review));await workspace(f,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});id=review.documentId;const next=await state(f,id);assert.equal(next.layers[0].mask.offsetX,0);assert.equal(next.layers[0].mask.width,3);assert.deepEqual(await rgba(f,(await doc(f,id)).image.compositeAssetId),cells.flat());}
 const cookie=cookieFrom(f.paired);await f.server.close();const g=await reopen(t,f.root,cookie);assert.deepEqual(await rgba(g,(await doc(g,id)).image.compositeAssetId),cells.flat());
 t.diagnostic(JSON.stringify({oracle:'retained-grid-v1-literal-cells',legacy,inverted,originalMask:mask.id,retained: [...originals.keys()],copyNamespaces:2}));
});
async function save(f,value,kind='mask',id='mask-draft',documentId='document_1',layerId='picture',session='retained-draft'){
 const raw=Buffer.from(JSON.stringify(value)),stage=await upload(f,raw,'caption','text/plain'),caption=(await workspace(f,{type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256})).event.payload.asset,d=await doc(f,documentId),ui=(await f.read('/api/v1/ui/'+session)).json;
 const draft={id,generation:'1',kind,documentId,targetLayerId:layerId,expectedDocumentRevision:d.revision,assetId:caption.id,composing:false};const result=await f.post('/api/v1/ui/'+session,{protocolVersion:1,requestId:randomUUID(),sessionId:session,expectedUISeq:ui.uiSeq,body:{type:'SaveDraft',draft}});return {result,draft,raw,caption,fence:{sessionId:session,draftId:id,generation:'1'}};
}
test('versioned retained-hard baseline uses exact hard bytes and typed bindings after nested draft copies',async t=>{
 const {f,mask,manifest}=await seed(t);await edit(f,{type:'CropDocument',x:1,y:0,width:2,height:2,draft:null});const s=await state(f),attached=await doc(f);
 const plan={schemaVersion:2,width:2,height:2,feather:0,operations:[{kind:'retained-hard-v1',mask:s.layers[0].mask,hard:manifest.plan.hard},{kind:'shape',mode:'add',shape:{kind:'rectangle',x:1,y:1,width:1,height:1}}]},value={schema:'local-mask-2',layerVersion:s.layers[0].version,radius:'0',plan};
 const saved=await save(f,value);assert.equal(saved.result.json.status,'accepted',saved.result.text);assert.deepEqual(await doc(f),attached);
 let id='document_1',session='retained-draft';for(let n=0;n<2;n++){const review=(await preview(f,(await copy(f,id)).bytes)).review;assert.equal(review.editable,true,JSON.stringify(review));await workspace(f,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});id=review.documentId;session=review.uiSessionIds[0];}
 const draft=(await f.read('/api/v1/ui/'+session)).json.drafts[0],mapped=structuredClone(plan);mapped.operations[0].mask.assetId=draft.maskBindings[mask.id];assert.deepEqual((await binary(f,'/api/v1/assets/'+draft.assetId+'/content')).bytes,saved.raw);
 const result=(await operate(f,{type:'PrepareMask',plan:mapped})).event.payload.asset;assert.equal(result.raster.schemaVersion,3);const m=(await f.read('/api/v1/assets/'+result.id+'/raster')).json;assert.equal(m.schemaVersion,3);assert.equal(m.plan.kind,'authored-mask-v2');assert.deepEqual([...await readFile(objectPath(f.root,m.plan.hard))],[255,255,0,0,255,255,255,255]);
 const layer=(await state(f,id)).layers[0];await edit(f,{type:'SetLayerProperties',layerId:layer.id,layerVersion:layer.version,properties:{mask:{assetId:result.id,mapping:'document-r16-v1',inverted:false}},draft:{sessionId:session,draftId:draft.id,generation:draft.generation}},id);assert.deepEqual(await rgba(f,(await doc(f,id)).image.compositeAssetId),[R,Z,W,K].flat());
 const ready=(await preview(f,(await copy(f,id)).bytes)).review;assert.equal(ready.editable,true,JSON.stringify(ready));
 await edit(f,{type:'Undo',historyHead:(await doc(f,id)).historyHead},id);assert.equal((await state(f,id)).layers[0].mask.mapping,'retained-r16-v1');
 const bad=structuredClone(plan);bad.operations[0].hard=manifest.plan.effective;bad.operations[0].hard={...bad.operations[0].hard,hash:'sha256:'+'0'.repeat(64)};const wrong=await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PrepareMask',plan:bad}}));assert.equal(wrong.json.receipt.status,'rejected');
});
test('mask fence refuses a wrong draft kind without applying the draft',async t=>{
 const {f}=await seed(t),s=await state(f),value={schema:'local-mask-1',layerVersion:s.layers[0].version,radius:'0',plan:{width:3,height:2,feather:0,operations:[{kind:'clear'}]}};
 const saved=await save(f,value,'inspector'),mask=(await operate(f,{type:'PrepareMask',plan:value.plan})).event.payload.asset,before=await doc(f);assert.equal(saved.result.json.status,'accepted');
 const r=await terminal(f,f.command({expectedDocumentRevision:before.revision,body:{type:'SetLayerProperties',layerId:'picture',layerVersion:s.layers[0].version,properties:{mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false}},draft:saved.fence}}));assert.equal(r.json.receipt.status,'rejected');assert.deepEqual(await doc(f),before);assert.equal((await f.read('/api/v1/ui/retained-draft')).json.drafts[0].status,'saved-unapplied');
});
for(const legacy of [false,true])test('retained-domain zero and single inversion over a larger transformed source '+legacy,async t=>{
 const {f,mask,manifest}=await seed(t,legacy,true),white=(await importRaster(f,'white.jpg')).asset;
 const mapping={assetId:mask.id,mapping:legacy?'retained-luminance-alpha-v1':'retained-r16-v1',inverted:true,offsetX:1,offsetY:1,width:3,height:2,outside:'zero'};
 const prepared=(await operate(f,{type:'ComposeRaster',width:6,height:4,layers:[{assetId:white.id,transform:[1,0,0,1,-1,-1],opacity:1,mask:mapping}]})).event.payload.asset;
 const full=legacy?[[255,255,255,255],Z,[255,255,255,127],W,Z,W]:[W,Z,W,W,Z,W];
 assert.deepEqual(await rgba(f,prepared.id),[Z,Z,Z,Z,Z,Z,Z,...full.slice(0,3),Z,Z,Z,...full.slice(3),Z,Z,Z,Z,Z,Z,Z,Z].flat());
 const plan={schemaVersion:2,width:6,height:4,feather:0,operations:[{kind:'retained-hard-v1',mask:mapping,hard:legacy?null:manifest.plan.hard}]},baseline=(await operate(f,{type:'PrepareMask',plan})).event.payload.asset,m=(await f.read('/api/v1/assets/'+baseline.id+'/raster')).json;
 const hard=await readFile(objectPath(f.root,m.plan.hard)),expected=Array(24).fill(0);[7,9,13,15].forEach(i=>expected[i]=65535);if(legacy)expected[9]=32639;assert.deepEqual(Array.from({length:24},(_,i)=>hard.readUInt16LE(i*2)),expected);
 const s=await state(f);await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:s.layers[0].version,properties:{visible:false},draft:null});const hidden=await edit(f,{type:'ResizeCanvas',width:4,height:3,offsetX:1,offsetY:1,draft:null});assert((await rgba(f,hidden.document.image.compositeAssetId)).every(x=>x===0));const active=(await state(f)).layers[0];assert.equal(active.mask.offsetX,1);
 await edit(f,{type:'SetLayerProperties',layerId:active.id,layerVersion:active.version,properties:{locked:true},draft:null});const before=await doc(f),refused=await terminal(f,f.command({expectedDocumentRevision:before.revision,body:{type:'CropDocument',x:1,y:1,width:2,height:2,draft:null}}));assert.equal(refused.json.receipt.status,'rejected');assert.deepEqual(await doc(f),before);
});
for(const target of ['caption','hard','mask-record','baseline-hard'])test('mask Apply refuses late exact dependency replacement '+target,async t=>{
 const {openWriter}=await import('../../dist/local/server/storage/writer.js'),{DatabaseSync}=await import('node:sqlite'),{encode}=await import('../store/helpers.mjs');
 const seeded=await seed(t),{f}=seeded;if(target==='baseline-hard')await edit(f,{type:'CropDocument',x:1,y:1,width:2,height:1,draft:null});const s=await state(f),value={schema:target==='baseline-hard'?'local-mask-2':'local-mask-1',layerVersion:s.layers[0].version,radius:'0',plan:target==='baseline-hard'?{schemaVersion:2,width:2,height:1,feather:0,operations:[{kind:'retained-hard-v1',mask:s.layers[0].mask,hard:seeded.manifest.plan.hard}]}:{width:3,height:2,feather:0,operations:[{kind:'clear'}]}},saved=await save(f,value),mask=(await operate(f,{type:'PrepareMask',plan:value.plan})).event.payload.asset,m=(await f.read('/api/v1/assets/'+mask.id+'/raster')).json,before=await doc(f),ui=(await f.read('/api/v1/ui/retained-draft')).json;
 await f.server.close();const gate=new SharedArrayBuffer(4);let hit;const barrier=new Promise(r=>hit=r),w=await openWriter({root:f.root},{phase:'history-after-proofs',gate,onBarrier:hit});t.after(()=>w.close());const auth={clientId:f.paired.json.clientId,sessionHash:'c'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
 const c=f.command({expectedDocumentRevision:before.revision,body:{type:'SetLayerProperties',layerId:'picture',layerVersion:s.layers[0].version,properties:{mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false}},draft:saved.fence}});await w.historyCommand(encode(c),auth);await barrier;
 if(target==='mask-record'){const db=new DatabaseSync(join(f.root,'metadata.sqlite'));db.prepare('UPDATE assets SET json=? WHERE id=?').run(JSON.stringify({...mask,version:'2'}),mask.id);db.close();}else{const ref=target==='caption'?saved.caption.blob:target==='baseline-hard'?seeded.manifest.plan.hard:m.plan.hard,path=objectPath(f.root,ref),bytes=await readFile(path);await unlink(path);await writeFile(path,bytes,{mode:0o600});}
 Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);let result;for(let i=0;i<1500;i++){result=await w.commandState(c.command.commandId);if(result.record)break;await new Promise(r=>setTimeout(r,5));}assert.equal(result.record?.receipt.status,'rejected',JSON.stringify(await w.diagnostics()));assert.deepEqual(await w.document('document_1'),before);assert.deepEqual(await w.uiRead('retained-draft',auth),ui);
});
test('imported PNG draft applies after namespace binding and missing baseline save leaves prior raw draft',async t=>{
 const {f,image,mask,manifest}=await seed(t),s=await state(f),value={schema:'local-mask-1',layerVersion:s.layers[0].version,radius:'0',plan:{width:3,height:2,feather:0,operations:[{kind:'import',assetId:image.asset.id,x:0,y:0,width:3,height:2,inverted:false}]}},saved=await save(f,value);assert.equal(saved.result.json.status,'accepted');
 const copied=(await preview(f,(await copy(f)).bytes)).review;assert.equal(copied.editable,true);await workspace(f,{type:'ImportBundle',reviewId:copied.reviewId,reviewHash:copied.reviewHash});const session=copied.uiSessionIds[0],draft=(await f.read('/api/v1/ui/'+session)).json.drafts[0],plan=structuredClone(value.plan);plan.operations[0].assetId=draft.maskBindings[image.asset.id];assert.notEqual(plan.operations[0].assetId,image.asset.id);
 const prepared=(await operate(f,{type:'PrepareMask',plan})).event.payload.asset,layer=(await state(f,copied.documentId)).layers[0];await edit(f,{type:'SetLayerProperties',layerId:layer.id,layerVersion:layer.version,properties:{mask:{assetId:prepared.id,mapping:'document-r16-v1',inverted:false}},draft:{sessionId:session,draftId:draft.id,generation:draft.generation}},copied.documentId);
 assert.equal((await f.read('/api/v1/ui/'+session)).json.drafts[0].status,'applied');assert.deepEqual((await binary(f,'/api/v1/assets/'+draft.assetId+'/content')).bytes,saved.raw);
 const before=(await f.read('/api/v1/ui/retained-draft')).json,invalid={schema:'local-mask-2',layerVersion:s.layers[0].version,radius:'0',plan:{schemaVersion:2,width:3,height:2,feather:0,operations:[{kind:'retained-hard-v1',mask:{assetId:'missing-baseline',mapping:'retained-r16-v1',offsetX:0,offsetY:0,width:3,height:2,outside:'zero',inverted:false},hard:manifest.plan.hard}]}};
 const failed=await save(f,invalid);assert.notEqual(failed.result.status,200);assert.deepEqual((await f.read('/api/v1/ui/retained-draft')).json,before);assert.deepEqual((await binary(f,'/api/v1/assets/'+saved.caption.id+'/content')).bytes,saved.raw);
});
