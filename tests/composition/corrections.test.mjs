import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setup,terminal,upload,workspace,edit,doc,copy,preview} from '../portable/helpers.mjs';
import {importRaster} from '../raster/helpers.mjs';
import {emptyComposition,emptyElement,linkField,detach} from '../../dist/local/src/composition/core.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
const view=async f=>(await f.read('/api/v1/documents/document_1/composition?revision='+(await doc(f)).revision)).json;
async function body(f,c,bindings,type='CommitCompositionVersion'){
 const s=await upload(f,Buffer.from(canonical(c)),'text','application/octet-stream'),a=(await workspace(f,{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256})).event.payload.asset;
 return {type,composition:{id:c.id,value:{...a.blob,mediaType:'application/json'},bindings},draft:null};
}
const commit=async(f,c,bindings,type)=>edit(f,await body(f,c,bindings,type));
async function reject(f,c,bindings,type){const before=await doc(f),command=f.command({expectedDocumentRevision:before.revision,body:await body(f,c,bindings,type)}),result=await terminal(f,command);assert.equal(result.json.receipt.status,'rejected');assert.deepEqual(await doc(f),before);assert.deepEqual((await terminal(f,command)).json.receipt,result.json.receipt);}
test('unrelated semantic commands preserve every surviving target; explicit equal-value relink remains valid',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');
 for(const layerId of ['first','second'])await edit(f,{type:'ImportAsset',assetId:asset.id,layerId,name:layerId,draft:null});
 let c=emptyComposition(3,2,randomUUID()),e=emptyElement('obj','linked');e.desc=linkField('appearance-description',(await view(f)).layers[0]);e.bounds=linkField('frame-bounds',(await view(f)).layers[0]);c.elements=[e,emptyElement('obj','other')];await commit(f,c,{first:'first'});
 for(const type of ['AddSemanticElement','RemoveSemanticElement','ReorderSemanticElement','DetachSemanticBinding']){
  const next=structuredClone(c);next.id=randomUUID();if(type==='AddSemanticElement')next.elements.push(emptyElement('obj','new'));if(type==='RemoveSemanticElement')next.elements.pop();if(type==='ReorderSemanticElement')next.elements.reverse();if(type==='DetachSemanticBinding')next.elements[0].bounds=detach(next.elements[0].bounds);
  await reject(f,next,{first:'second'},type);next.id=randomUUID();await commit(f,next,{first:'first'},type);const current=await doc(f);await edit(f,{type:'Undo',historyHead:current.historyHead});
 }
 c=structuredClone(c);c.id=randomUUID();await commit(f,c,{first:'second'},'SetSemanticBinding');assert.deepEqual((await view(f)).bindings,{first:'second'});
 const invalid=structuredClone(c);invalid.id=randomUUID();invalid.elements[0].bounds=detach(invalid.elements[0].bounds);await reject(f,invalid,{first:'first'},'DetachSemanticBinding');
 const valid=structuredClone(c);valid.id=randomUUID();valid.elements[0].bounds=detach(valid.elements[0].bounds);await commit(f,valid,{first:'second'},'DetachSemanticBinding');
});
test('reviewed links retain their branch authority across alternate version numbers and nested copies',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Picture',draft:null});
 const a=await edit(f,{type:'SetLayerAppearance',layerId:'picture',layerVersion:'1',description:'Branch A',draft:null});let c=emptyComposition(3,2,randomUUID());c.elements=[emptyElement('obj','linked')];c.elements[0].desc=linkField('appearance-description',(await view(f)).layers[0]);const first=await commit(f,c,{picture:'picture'});
 await edit(f,{type:'Undo',historyHead:first.document.historyHead});await edit(f,{type:'Undo',historyHead:a.document.historyHead});await edit(f,{type:'SetLayerAppearance',layerId:'picture',layerVersion:'1',description:'Branch B',draft:null});
 const forged=structuredClone(c);forged.id=randomUUID();await reject(f,forged,{picture:'picture'});const b=structuredClone(c);b.id=randomUUID();b.elements[0].desc=linkField('appearance-description',(await view(f)).layers[0]);await commit(f,b,{picture:'picture'});
 await edit(f,{type:'SwitchBranch',branchId:first.document.branchId,historyNode:first.document.historyHead});let id='document_1';
 for(let i=0;i<2;i++){const bundle=await copy(f,id),review=(await preview(f,bundle.bytes)).review;assert.equal(review.editable,true,JSON.stringify(review));await workspace(f,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});id=review.documentId;const d=await doc(f,id),v=(await f.read('/api/v1/documents/'+id+'/composition?revision='+d.revision)).json;assert.equal(v.composition.elements[0].desc.lastReviewedValue,'Branch A');assert.equal(v.layers.find(l=>l.id===v.bindings.picture).appearance,'Branch A');}
});
