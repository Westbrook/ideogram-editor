import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {newDraft} from '../../dist/local/src/request/core.js';
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

function retainedUI(f,owner){
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{return {
  roots:db.prepare('SELECT hash,media_type FROM roots WHERE owner=? ORDER BY hash').all(owner),
  events:db.prepare('SELECT seq,json FROM ui_events WHERE client_id=? AND session_id=? ORDER BY length(seq),seq').all(f.paired.json.clientId,'editor'),
  receipts:db.prepare('SELECT id,json FROM ui_receipts WHERE client_id=? ORDER BY id').all(f.paired.json.clientId),
 };}finally{db.close();}
}
const draftOwner=(f,id)=>'ui:'+f.paired.json.clientId+':editor:'+id+':1';
async function clear(f,id){const result=await persist(f,{type:'ClearDraft',draftId:id,generation:'1'});assert.equal(result.response.json.status,'accepted',result.response.text);assert.deepEqual((await ui(f)).drafts,[]);}
async function exactUIRetry(f,saved,owner){
 const before=retainedUI(f,owner),checkpoint=await ui(f);assert.deepEqual((await f.post('/api/v1/ui/editor',saved.request)).json,saved.response.json);
 assert.deepEqual(await ui(f),checkpoint);assert.deepEqual(retainedUI(f,owner),before,'Exact retry adds no UI event, receipt or root');
}
test('cleared request id and generation can retain shared and new dependencies without replacing prior roots',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const prompt=await caption(f,'Shared exact prompt 🦋'),value=newDraft(prompt.blob),first=await caption(f,JSON.stringify(value));
 const draft={id:'reused_request',generation:'1',kind:'request',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:'1',assetId:first.id,composing:false},owner=draftOwner(f,draft.id);
 assert.equal((await persist(f,{type:'SaveDraft',draft})).response.json.status,'accepted');const original=retainedUI(f,owner).roots;assert.equal(original.length,2);
 await clear(f,draft.id);assert.deepEqual(retainedUI(f,owner).roots,original);
 value.fields.seed='42';const second=await caption(f,JSON.stringify(value)),saved=await persist(f,{type:'SaveDraft',draft:{...draft,assetId:second.id}});assert.equal(saved.response.json.status,'accepted',saved.response.text);
 assert.equal((await ui(f)).drafts[0].assetId,second.id);assert.deepEqual(retainedUI(f,owner).roots.map(r=>r.hash).sort(),[prompt.blob.hash,first.blob.hash,second.blob.hash].sort());await exactUIRetry(f,saved,owner);
 const active=await persist(f,{type:'SaveDraft',draft:{...draft,assetId:first.id}});assert.equal(active.response.json.reason,'STALE_DRAFT_GENERATION');assert.equal((await ui(f)).drafts[0].assetId,second.id);
 await clear(f,draft.id);const nextPrompt=await caption(f,'New dependency after clear'),third=await caption(f,JSON.stringify(newDraft(nextPrompt.blob))),next=await persist(f,{type:'SaveDraft',draft:{...draft,assetId:third.id}});assert.equal(next.response.json.status,'accepted',next.response.text);
 const hashes=[prompt.blob.hash,first.blob.hash,second.blob.hash,nextPrompt.blob.hash,third.blob.hash].sort();assert.deepEqual(retainedUI(f,owner).roots.map(r=>r.hash).sort(),hashes);await exactUIRetry(f,next,owner);
 const closure=(await f.read('/api/v1/documents/document_1/closure')).json;for(const hash of hashes)assert(closure.items.some(ref=>ref.hash===hash),'Existing five-part UI ownership remains visible to closure');assert.equal((await doc(f)).revision,'1');
});
test('stable inspector draft can be reset and saved with identical bytes and generation',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const asset=await caption(f,'Exact inspector values'),draft={id:'inspector_document_1_layer_1',generation:'1',kind:'inspector',documentId:'document_1',targetLayerId:'layer_1',expectedDocumentRevision:'1',assetId:asset.id,composing:false},owner=draftOwner(f,draft.id);
 assert.equal((await persist(f,{type:'SaveDraft',draft})).response.json.status,'accepted');const original=retainedUI(f,owner).roots;await clear(f,draft.id);
 const saved=await persist(f,{type:'SaveDraft',draft});assert.equal(saved.response.json.status,'accepted',saved.response.text);assert.deepEqual(retainedUI(f,owner).roots,original);await exactUIRetry(f,saved,owner);
});
for(const fault of ['media-type','declared-length','object-bytes'])test('reused UI root refuses '+fault+' corruption before publication and original request remains retryable',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const asset=await caption(f,'Immutable draft bytes'),draft={id:'corrupt_reuse',generation:'1',kind:'prompt',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:'1',assetId:asset.id,composing:false},owner=draftOwner(f,draft.id);
 assert.equal((await persist(f,{type:'SaveDraft',draft})).response.json.status,'accepted');await clear(f,draft.id);const checkpoint=await ui(f),original=retainedUI(f,owner),path=join(f.root,'objects','sha256',asset.blob.hash.slice(7,9),asset.blob.hash.slice(7)),bytes=await readFile(path);
 const mutate=(value)=>{const db=new DatabaseSync(join(f.root,'metadata.sqlite'));try{if(fault==='media-type')db.prepare('UPDATE roots SET media_type=? WHERE owner=? AND hash=?').run(value,owner,asset.blob.hash);else db.prepare('UPDATE objects SET byte_length=? WHERE hash=?').run(value,asset.blob.hash);}finally{db.close();}};
 let failed;
 try{
  if(fault==='object-bytes'){const corrupt=Buffer.from(bytes);corrupt[0]^=1;await writeFile(path,corrupt);}else mutate(fault==='media-type'?'application/json':String(BigInt(asset.blob.byteLength)+1n));
  const before=retainedUI(f,owner);failed=await persist(f,{type:'SaveDraft',draft});assert.equal(failed.response.status,503,failed.response.text);assert.equal(failed.response.json.error.code,'RECOVERY_UNAVAILABLE');
  assert.deepEqual(await ui(f),checkpoint);assert.deepEqual(retainedUI(f,owner),before,'A refused proof/binding cannot publish roots, UI state, events or a receipt');
 }finally{if(fault==='object-bytes')await writeFile(path,bytes);else mutate(fault==='media-type'?asset.blob.mediaType:asset.blob.byteLength);}
 assert.deepEqual(retainedUI(f,owner),original);const recovered={request:failed.request,response:await f.post('/api/v1/ui/editor',failed.request)};assert.equal(recovered.response.json.status,'accepted',recovered.response.text);assert.deepEqual(retainedUI(f,owner).roots,original.roots);await exactUIRetry(f,recovered,owner);
});
