import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setup,terminal,upload,workspace,edit,doc,copy,preview,binary,digest} from '../portable/helpers.mjs';
import {reopen} from '../text-state/prior-writer.mjs';
import {call,cookieFrom,pair,readHeaders} from '../session/helpers.mjs';
import {importRaster} from '../raster/helpers.mjs';
import {emptyComposition,emptyElement,linkField,serialize,detach} from '../../dist/local/src/composition/core.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
const state=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id+'/image')).json;
async function ref(f,bytes,mediaType='application/json'){const stage=await upload(f,Buffer.from(bytes),'text','application/octet-stream'),a=(await workspace(f,{type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256})).event.payload.asset;return {...a.blob,mediaType};}
async function commit(f,c,bindings={},id='document_1',type='CommitCompositionVersion',draft=null){const value=await ref(f,canonical(c));return edit(f,{type,composition:{id:c.id,value,bindings},draft},id);}
const view=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id+'/composition?revision='+(await doc(f,id)).revision)).json;
test('semantic history is independent; raw, projection and exact bytes survive two copies and undo',async t=>{
 const f=await setup(t);await terminal(f,f.command({},{width:3,height:2}));const original=Buffer.from('{"unknown":true,"unknown":false}\n'),raw=await ref(f,original,'application/octet-stream');let c=emptyComposition(3,2,randomUUID());const a=emptyElement('text',randomUUID()),b=emptyElement('obj',randomUUID());a.text.value='Café\n東京';c.scene='Scene';c.elements=[a,b];c.raw=[raw];await commit(f,c);
 let d=await doc(f);assert.deepEqual(d.orderedLayerIds,[]);assert.equal(d.compositionVersion,c.id);assert.deepEqual((await state(f)).layers,[]);
 c=structuredClone(c);c.id=randomUUID();c.elements.reverse();await commit(f,c,{},'document_1','ReorderSemanticElement');const reordered=await doc(f);await edit(f,{type:'Undo',historyHead:reordered.historyHead});assert.equal((await view(f)).composition.elements[0].id,a.id);await edit(f,{type:'Redo',historyNode:reordered.historyHead});
 c.id=randomUUID();const p=serialize(c,[],{}),prompt=await ref(f,p.prompt,'text/plain');c.review={serializer:'caption-json-1',sourceId:c.id,frame:c.frame,request:c.request,dependencies:p.dependencies,boxes:p.boxes,prompt};await commit(f,c,{},'document_1','ApprovePromptProjection');
 let id='document_1';for(let i=0;i<2;i++){const archive=await copy(f,id),r=(await preview(f,archive.bytes)).review;assert.equal(r.editable,true,JSON.stringify(r));assert.equal(r.formatVersion,7);await workspace(f,{type:'ImportBundle',reviewId:r.reviewId,reviewHash:r.reviewHash});id=r.documentId;const v=await view(f,id);assert.deepEqual(v.composition,c);const bytes=await binary(f,'/api/v1/documents/'+id+'/composition?revision='+(await doc(f,id)).revision+'&raw=0&download=1');assert.deepEqual(bytes.bytes,original);assert.equal((await state(f,id)).layers.length,0);}
});
test('binding source authority, stale review, deletion, detach and remapped copy closure',async t=>{
 const f=await setup(t);await terminal(f,f.command({},{width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Native',draft:null});await edit(f,{type:'SetLayerAppearance',layerId:'picture',layerVersion:'1',description:'Explicit appearance',draft:null});
 let v=await view(f),c=emptyComposition(3,2,randomUUID()),e=emptyElement('obj',randomUUID());e.desc=linkField('appearance-description',v.layers[0]);e.bounds=linkField('frame-bounds',v.layers[0]);c.elements=[e];await commit(f,c,{picture:'picture'});const before=await state(f);await edit(f,{type:'DuplicateLayer',layerId:'picture',layerVersion:'2',newLayerId:'other',name:'Copy',draft:null});assert.equal((await view(f)).composition.elements.length,1);assert.deepEqual((await view(f)).bindings,{picture:'picture'});
 await edit(f,{type:'ApplyTransform',layerId:'picture',layerVersion:'2',transform:[1,0,0,1,1,0],draft:null});v=await view(f);assert.throws(()=>serialize(v.composition,v.layers,v.bindings),/STALE_LINK/);
 const forged=structuredClone(c);forged.id=randomUUID();forged.elements[0].desc.lastReviewedLayerVersion='3';forged.elements[0].desc.lastReviewedValue='Invented';const value=await ref(f,canonical(forged)),rejected=await terminal(f,f.command({expectedDocumentRevision:(await doc(f)).revision,body:{type:'CommitCompositionVersion',composition:{id:forged.id,value,bindings:{picture:'picture'}},draft:null}}));assert.equal(rejected.json.receipt.status,'rejected');
 const bundle=await copy(f),r=(await preview(f,bundle.bytes)).review;assert.equal(r.editable,true,JSON.stringify(r));await workspace(f,{type:'ImportBundle',reviewId:r.reviewId,reviewHash:r.reviewHash});const imported=await view(f,r.documentId);assert.notEqual(imported.bindings.picture,'picture');assert(imported.layers.some(l=>l.id===imported.bindings.picture));
 await edit(f,{type:'DeleteLayer',layerId:'picture',layerVersion:'3',draft:null});v=await view(f);assert.throws(()=>serialize(v.composition,v.layers,v.bindings),/MISSING_LINK/);c=structuredClone(v.composition);c.id=randomUUID();c.elements[0].desc=detach(c.elements[0].desc);c.elements[0].bounds=detach(c.elements[0].bounds);await commit(f,c,{},'document_1','DetachSemanticBinding');assert.equal((await view(f)).composition.elements[0].desc.value,'Explicit appearance');assert.equal(before.layers[0].layerToDocument[4],0);
});
test('unapplied invalid draft and original raw closure retain exact graph bytes and nested binding maps',async t=>{
 const f=await setup(t);await terminal(f,f.command({},{width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'source',name:'Native',draft:null});const v=await view(f),c=emptyComposition(3,2,randomUUID()),e=emptyElement('obj','unfinished');e.desc=linkField('appearance-description',v.layers[0]);c.elements=[e];const raw=await ref(f,Buffer.from([0xff,0,10]),'application/octet-stream');c.raw=[raw];const graphBytes=canonical({composition:c,bindings:{source:'source'},numbers:{width:'not a number'},selected:e.id}),graph=await ref(f,graphBytes),envelope={schemaVersion:1,kind:'composition-draft-1',graph,raw:[raw],bindings:{source:'source'}},stage=await upload(f,Buffer.from(canonical(envelope)),'caption','text/plain'),caption=(await workspace(f,{type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256})).event.payload.asset;
 const d=await doc(f),saved=await f.post('/api/v1/ui/semantic',{protocolVersion:1,requestId:randomUUID(),sessionId:'semantic',expectedUISeq:'0',body:{type:'SaveDraft',draft:{id:'unfinished-draft',generation:'1',kind:'composition',documentId:d.id,targetLayerId:null,expectedDocumentRevision:d.revision,assetId:caption.id,composing:false}}});assert.equal(saved.json.status,'accepted',saved.text);
 let id=d.id;for(let i=0;i<2;i++){const b=await copy(f,id),r=(await preview(f,b.bytes)).review;assert.equal(r.editable,true,JSON.stringify(r));await workspace(f,{type:'ImportBundle',reviewId:r.reviewId,reviewHash:r.reviewHash});id=r.documentId;const ui=(await f.read('/api/v1/ui/'+r.uiSessionIds[0])).json,draft=ui.drafts[0];assert.notEqual(draft.compositionBindings.source,'source');const data=(await f.read('/api/v1/ui/'+r.uiSessionIds[0]+'/composition?draftId='+draft.id+'&generation='+draft.generation)).json;assert.equal(canonical(data.graph),graphBytes);assert.equal(data.graph.numbers.width,'not a number');}
});

test('opaque original beyond the inspection bound streams completely with bounded pages and no execution',async t=>{
 const f=await setup(t);await terminal(f,f.command({},{width:1,height:1}));const rawBytes=Buffer.alloc(17*1024*1024,65);rawBytes[32767]=0xff;rawBytes[rawBytes.length-1]=0;const raw=await ref(f,rawBytes,'application/octet-stream'),c=emptyComposition(1,1,randomUUID());c.raw=[raw];await commit(f,c);const path='/api/v1/documents/document_1/composition?revision='+(await doc(f)).revision+'&raw=0';const page=await binary(f,path+'&offset=32768');assert.equal(page.bytes.length,32768);assert.deepEqual(page.bytes,rawBytes.subarray(32768,65536));assert.deepEqual((await binary(f,path+'&download=1')).bytes,rawBytes);const bundle=await copy(f),r=(await preview(f,bundle.bytes)).review;assert.equal(r.editable,true);await workspace(f,{type:'ImportBundle',reviewId:r.reviewId,reviewHash:r.reviewHash});assert.deepEqual((await binary(f,'/api/v1/documents/'+r.documentId+'/composition?revision='+(await doc(f,r.documentId)).revision+'&raw=0&download=1')).bytes,rawBytes);t.diagnostic(JSON.stringify({raw,parsed:false,pageBytes:page.bytes.length,retainedBeyondInspectionBound:true}));
});

test('semantic versions cannot be recycled through undo or copies; specialized commands cannot edit unrelated fields',async t=>{
 const f=await setup(t);await terminal(f,f.command({},{width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'source',name:'Native',draft:null});let c=emptyComposition(3,2,randomUUID());c.elements=[emptyElement('obj','semantic')];await commit(f,c);const first=c.id;
 const reject=async(next,type='CommitCompositionVersion',bindings={},documentId='document_1')=>{const value=await ref(f,canonical(next)),r=await terminal(f,f.command({documentId,expectedDocumentRevision:(await doc(f,documentId)).revision,body:{type,composition:{id:next.id,value,bindings},draft:null}}));assert.equal(r.json.receipt.status,'rejected',JSON.stringify(r.json));};
 c=structuredClone(c);c.id=randomUUID();c.elements[0].desc=linkField('appearance-description',(await view(f)).layers[0]);await commit(f,c,{source:'source'},'document_1','SetSemanticBinding');
 const wrong=structuredClone(c);wrong.id=randomUUID();wrong.elements[0].desc={mode:'literal',value:'Invented detach'};await reject(wrong,'DetachSemanticBinding');
 const unrelated=structuredClone(c);unrelated.id=randomUUID();unrelated.scene='Unrelated edit';unrelated.elements[0].desc=detach(unrelated.elements[0].desc);await reject(unrelated,'DetachSemanticBinding');
 const detached=structuredClone(c);detached.id=randomUUID();detached.elements[0].desc=detach(detached.elements[0].desc);await commit(f,detached,{},'document_1','DetachSemanticBinding');
 const reused=structuredClone(detached);reused.id=first;await reject(reused);const d=await doc(f);await edit(f,{type:'Undo',historyHead:d.historyHead});await reject(detached);
 const bundle=await copy(f),r=(await preview(f,bundle.bytes)).review;assert.equal(r.editable,true);await workspace(f,{type:'ImportBundle',reviewId:r.reviewId,reviewHash:r.reviewHash});await reject(reused,'CommitCompositionVersion',{},r.documentId);
 const add=structuredClone((await view(f)).composition);add.id=randomUUID();add.elements[0].desc={mode:'literal',value:'Unrelated change'};add.elements.push(emptyElement('obj','new'));await reject(add,'AddSemanticElement');
});

test('a saved large Composition draft reopens exactly and retains owner, proof and commit-fence boundaries',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));
 const sessionId='large_semantic',draftId='large_composition',initialDocument=await doc(f);
 const composition=emptyComposition(3,2,randomUUID()),element=emptyElement('text','lettering');
 element.text.value='Café / 東京 / e\u0301';composition.elements=[element];
 for(let index=0;index<40;index++){const retained=emptyElement('obj','retained_'+index);retained.excluded=true;retained.desc.value='x'.repeat(2048);composition.elements.push(retained);}
 const compositionBytes=canonical(composition);assert(Buffer.byteLength(compositionBytes)>65536&&Buffer.byteLength(compositionBytes)<=1048576);
 const graphValue={composition,bindings:{},numbers:{width:'3',height:'2'},selected:element.id,rawText:'{unfinished original text}\n'+'x'.repeat(70000)+'\nCafé 東京 e\u0301'};
 const graphBytes=canonical(graphValue);assert(Buffer.byteLength(graphBytes)>65536&&Buffer.byteLength(graphBytes)<8388608);
 const graph=await ref(f,graphBytes),envelope={schemaVersion:1,kind:'composition-draft-1',graph,raw:[],bindings:{}};
 assert.equal(graph.hash,digest(Buffer.from(graphBytes)));assert.equal(graph.byteLength,String(Buffer.byteLength(graphBytes)));
 const stageEnvelope=async(client,value)=>{const staged=await upload(client,Buffer.from(canonical(value)),'caption','text/plain');return (await workspace(client,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;};
 const save=async(client,assetId,generation,revision)=>{
  const checkpoint=(await client.read('/api/v1/ui/'+sessionId)).json;
  return client.post('/api/v1/ui/'+sessionId,{protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:checkpoint.uiSeq,body:{type:'SaveDraft',draft:{id:draftId,generation,kind:'composition',documentId:initialDocument.id,targetLayerId:null,expectedDocumentRevision:revision,assetId,composing:false}}});
 };
 const draftPath=generation=>'/api/v1/ui/'+sessionId+'/composition?draftId='+draftId+'&generation='+generation;
 const exactDraft=async(client,generation,expectedBytes,expectedAsset,status)=>{
  const response=await client.read(draftPath(generation));assert.equal(response.status,200,response.text);
  assert(Buffer.byteLength(response.text)>65536,'The public draft view must carry the complete large graph');
  assert.equal(canonical(response.json.graph),expectedBytes);assert.equal(digest(Buffer.from(canonical(response.json.graph))),digest(Buffer.from(expectedBytes)));
  assert.deepEqual(response.json.bindings,{});assert.equal(response.json.draft.id,draftId);assert.equal(response.json.draft.generation,generation);assert.equal(response.json.draft.assetId,expectedAsset);assert.equal(response.json.draft.status,status);
  return response.json;
 };
 const exactAccepted=async(client,expected)=>{
  const document=await doc(client),response=await client.read('/api/v1/documents/'+document.id+'/composition?revision='+document.revision);
  assert.equal(response.status,200,response.text);assert(Buffer.byteLength(response.text)>65536,'The public accepted view must carry the complete large Composition');
  assert.equal(response.json.revision,document.revision);assert.equal(canonical(response.json.composition),canonical(expected));
  assert.equal(response.json.compositionRef.value.hash,digest(Buffer.from(canonical(expected))));assert.equal(response.json.compositionRef.value.byteLength,String(Buffer.byteLength(canonical(expected))));
 };
 const caption=await stageEnvelope(f,envelope),saved=await save(f,caption.id,'1',initialDocument.revision);
 assert.equal(saved.status,200,saved.text);assert.equal(saved.json.status,'accepted',saved.text);
 const first=await exactDraft(f,'1',graphBytes,caption.id,'saved-unapplied');assert.deepEqual(await doc(f),initialDocument);
 const checkpoint=(await f.read('/api/v1/ui/'+sessionId)).json;

 // A fresh local client may not read another client's retained draft.
 const other=await pair(f.server);assert.equal(other.status,200);assert.notEqual(other.json.clientId,f.paired.json.clientId);
 const denied=await call(f.server.origin,draftPath('1'),{headers:readHeaders(cookieFrom(other))});
 assert.equal(denied.status,410,denied.text);assert.equal(denied.json.error.code,'READ_CONTEXT_EXPIRED');assert.equal(denied.text.includes('x'.repeat(128)),false);

 await f.server.close();const reopened=await reopen(t,f.root,cookieFrom(f.paired));
 assert.equal(reopened.paired.status,200);assert.equal(reopened.paired.json.clientId,f.paired.json.clientId);
 assert.deepEqual((await reopened.read('/api/v1/ui/'+sessionId)).json,checkpoint);
 assert.deepEqual(await exactDraft(reopened,'1',graphBytes,caption.id,'saved-unapplied'),first);
 assert.deepEqual(await doc(reopened),initialDocument);

 // Valid envelope shapes cannot replace a saved graph with missing or
 // incorrectly sized content, even when the proposed generation is newer.
 for(const changedGraph of [{...graph,hash:'sha256:'+'0'.repeat(64)},{...graph,byteLength:String(BigInt(graph.byteLength)+1n)}]){
  const bad=await stageEnvelope(reopened,{...envelope,graph:changedGraph}),failure=await save(reopened,bad.id,'2',initialDocument.revision);
  assert.equal(failure.status,503,failure.text);assert.equal(failure.json.error.code,'RECOVERY_UNAVAILABLE');
  assert.deepEqual((await reopened.read('/api/v1/ui/'+sessionId)).json,checkpoint);
  await exactDraft(reopened,'1',graphBytes,caption.id,'saved-unapplied');assert.deepEqual(await doc(reopened),initialDocument);
 }
 const fence={sessionId,draftId,generation:'1'};
 const rejectedCommit=async(next,draft,reason,revision)=>{
  const before=await doc(reopened),ui=(await reopened.read('/api/v1/ui/'+sessionId)).json,value=await ref(reopened,canonical(next));
  const result=await terminal(reopened,reopened.command({documentId:before.id,expectedDocumentRevision:revision??before.revision,body:{type:'CommitCompositionVersion',composition:{id:next.id,value,bindings:{}},draft}}));
  assert.equal(result.json.receipt.status,'rejected',result.text);assert.equal(result.json.receipt.code,'STALE_REVISION');assert.equal(result.json.rejectionDetails.kind,'inline');assert.equal(result.json.rejectionDetails.value.issues[0].code,reason);
  assert.deepEqual(await doc(reopened),before);assert.deepEqual((await reopened.read('/api/v1/ui/'+sessionId)).json,ui);
  return result;
 };
 const mismatch=structuredClone(composition);mismatch.id=randomUUID();mismatch.scene='Not the saved Composition';
 await rejectedCommit(mismatch,fence,'COMPOSITION_DRAFT_CHANGED');await rejectedCommit(composition,{...fence,generation:'0'},'DRAFT_GENERATION_CHANGED');
 await exactDraft(reopened,'1',graphBytes,caption.id,'saved-unapplied');
 const applied=await commit(reopened,composition,{},initialDocument.id,'CommitCompositionVersion',fence);
 assert.equal(applied.document.revision,String(BigInt(initialDocument.revision)+1n));await exactAccepted(reopened,composition);
 await exactDraft(reopened,'1',graphBytes,caption.id,'applied');

 const successor=structuredClone(graphValue);successor.composition.id=randomUUID();successor.composition.scene='Explicit successor';successor.rawText+='\nSuccessor bytes';
 const nextBytes=canonical(successor),nextGraph=await ref(reopened,nextBytes),nextCaption=await stageEnvelope(reopened,{...envelope,graph:nextGraph});
 const nextSaved=await save(reopened,nextCaption.id,'2',applied.document.revision);assert.equal(nextSaved.status,200,nextSaved.text);assert.equal(nextSaved.json.status,'accepted',nextSaved.text);
 const staleView=await reopened.read(draftPath('1'));assert.equal(staleView.status,410,staleView.text);assert.equal(staleView.json.error.code,'READ_CONTEXT_EXPIRED');
 await rejectedCommit(successor.composition,fence,'DRAFT_GENERATION_CHANGED');
 await rejectedCommit(successor.composition,{...fence,generation:'2'},'REVISION_CHANGED',initialDocument.revision);
 await exactDraft(reopened,'2',nextBytes,nextCaption.id,'saved-unapplied');
 await commit(reopened,successor.composition,{},initialDocument.id,'CommitCompositionVersion',{...fence,generation:'2'});
 await exactAccepted(reopened,successor.composition);await exactDraft(reopened,'2',nextBytes,nextCaption.id,'applied');
});
