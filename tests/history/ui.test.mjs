import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setup,call,mutationHeaders} from '../protocol/helpers.mjs';
import {importRaster,terminal,operate} from '../raster/helpers.mjs';
const doc=async f=>(await f.read('/api/v1/documents/document_1')).json.projection.value;
const ui=async f=>(await f.read('/api/v1/ui/editor')).json;
async function persist(f,body,expectedUISeq){const request={protocolVersion:1,requestId:randomUUID(),sessionId:'editor',expectedUISeq:expectedUISeq??(await ui(f)).uiSeq,body};const response=await f.post('/api/v1/ui/editor',request);return {request,response};}
async function caption(f,text){const bytes=Buffer.from(text),sha256='sha256:'+createHash('sha256').update(bytes).digest('hex'),id=randomUUID();
 assert.equal((await f.post('/api/v1/assets/staging',{protocolVersion:1,stagingId:id,purpose:'caption',expectedBytes:String(bytes.length),sha256,mediaType:'text/plain'})).status,201);
 assert.equal((await call(f.server.origin,'/api/v1/assets/staging/'+id,{method:'PUT',raw:bytes,headers:{...mutationHeaders(f.server,f.paired),'Content-Type':'application/octet-stream','Upload-Offset':'0'}})).status,200);
 return (await operate(f,{type:'FinalizeStaging',stagingId:id,expectedSha256:sha256})).event.payload.asset;
}
test('UI and full Unicode drafts persist independently, stale generations survive, applying fences composition',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');
 let d=await doc(f);await terminal(f,f.command({expectedDocumentRevision:d.revision,body:{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Picture',draft:null}}));d=await doc(f);
 const preferences={documentId:d.id,tool:'transform',viewport:{x:12,y:-18,zoom:2},panels:{left:301,right:299,active:'history'},selectedLayerIds:['picture','missing']};
 const selected=await persist(f,{type:'SetPreferences',preferences});assert.equal(selected.response.json.status,'accepted');assert.deepEqual((await ui(f)).reconciledLayerIds,['missing']);assert.deepEqual((await ui(f)).preferences.selectedLayerIds,['picture']);
 const a=await caption(f,'Inspector draft: 🦋 é שלום\n100% retained'),draft={id:'opacity',generation:'1',kind:'inspector',documentId:d.id,targetLayerId:'picture',expectedDocumentRevision:d.revision,assetId:a.id,composing:true};
 const saved=await persist(f,{type:'SaveDraft',draft});assert.equal(saved.response.json.status,'accepted');assert.deepEqual((await f.post('/api/v1/ui/editor',saved.request)).json,saved.response.json);
 const apply=()=>f.command({expectedDocumentRevision:d.revision,body:{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{opacity:0.5},draft:{sessionId:'editor',draftId:'opacity',generation:'1'}}});
 assert.equal((await terminal(f,apply())).json.receipt.code,'STALE_REVISION');assert.equal((await doc(f)).revision,d.revision);
 assert.equal((await persist(f,{type:'SaveDraft',draft:{...draft,generation:'2',composing:false}})).response.json.status,'accepted');
 const old=await persist(f,{type:'SaveDraft',draft:{...draft,generation:'1',composing:false}});assert.equal(old.response.json.reason,'STALE_DRAFT_GENERATION');assert.equal((await ui(f)).drafts[0].generation,'2');
 const stale=await terminal(f,apply());assert.equal(stale.json.receipt.code,'STALE_REVISION');assert.equal((await ui(f)).drafts[0].status,'saved-unapplied');
 const accepted=apply();accepted.command.body.draft.generation='2';assert.equal((await terminal(f,accepted)).json.receipt.status,'accepted');assert.equal((await ui(f)).drafts[0].status,'applied');
 const status=(await f.read('/api/v1/documents/document_1/save-status?sessionId=editor')).json;assert.equal(status.pendingCommandCount,0);assert.equal(status.draftDirty,false);
 const revision=(await doc(f)).revision;await persist(f,{type:'FocusRequested',target:'inspector',generation:'8'});assert.equal((await doc(f)).revision,revision);assert.equal('focus' in (await ui(f)),false);
 const before=await ui(f);assert.equal((await f.post('/api/v1/ui/editor',{protocolVersion:1,requestId:randomUUID(),sessionId:'editor',expectedUISeq:before.uiSeq,body:{type:'SetState',state:{}}})).status,400);
 const outOfDate=await persist(f,{type:'ClearDraft',draftId:'opacity',generation:'1'});assert.equal(outOfDate.response.json.status,'rejected');assert.equal((await ui(f)).drafts.length,1);
});
test('UI transcript compaction retains current draft and all domain events, selection reconciliation is visible',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const a=await caption(f,'Latest complete draft '.repeat(4000));
 let seq=(await ui(f)).uiSeq;
 const draft={id:'prompt',generation:'1',kind:'prompt',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:'1',assetId:a.id,composing:false};
 seq=(await persist(f,{type:'SaveDraft',draft},seq)).response.json.uiSeq;
 for(let i=0;i<1004;i++){const r=await persist(f,{type:'FocusRequested',target:'canvas',generation:String(i)},seq);assert.equal(r.response.json.status,'accepted');seq=r.response.json.uiSeq;}
 const after=await ui(f);assert.equal(after.drafts[0].assetId,a.id);assert.equal(after.uiSeq,'1005');assert.equal((await doc(f)).revision,'1');
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM ui_events').get().n,1000);assert.equal(db.prepare('SELECT count(*) AS n FROM ui_receipts').get().n,1005);assert.equal(db.prepare('SELECT count(*) AS n FROM events_v2').get().n,2);}finally{db.close();}
 const closure=(await f.read('/api/v1/documents/document_1/closure')).json;assert(closure.items.some(r=>r.hash===a.blob.hash));
});
