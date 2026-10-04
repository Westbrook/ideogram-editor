import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {rootFor,command,pair,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {importRaster,operate,terminal} from '../raster/helpers.mjs';
import {upload,copy,preview as previewCopy,workspace} from '../portable/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {newDraft,bindRequestMask,confirmRequestMask} from '../../dist/local/src/request/core.js';
import {canonical} from '../../dist/local/src/protocol/json.js';

const document=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id)).json.projection.value;
const image=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id+'/image')).json;
async function retained(f,ref){
  const bytes=await readFile(join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7)));
  assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),ref.hash);
  assert.equal(String(bytes.length),ref.byteLength);return bytes;
}
async function pixels(f,id){return retained(f,(await f.read('/api/v1/assets/'+id)).json.projection.value.raster.pixels);}
// HTTP deliberately has no complete asset inventory. Read-only storage snapshots
// catch eager Q, wrapper and composite registration, including invisible assets.
function inventory(f){
  const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});
  try{return {
    assets:db.prepare('SELECT id,json FROM assets ORDER BY id').all(),
    previews:db.prepare('SELECT id,json FROM image_previews ORDER BY id').all(),
    history:db.prepare('SELECT id,json FROM history ORDER BY id').all(),
    rasterRoots:db.prepare("SELECT DISTINCT hash,media_type FROM roots WHERE media_type IN ('application/x-ideogram-rgba8','image/png','image/jpeg') ORDER BY hash,media_type").all(),
  };}finally{db.close();}
}
async function events(f,receipt){
  const response=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));
  assert.equal(response.status,200,response.text);const batch=response.json.batches[0];
  if(batch.kind==='inline')return batch.events;
  const content=await f.read(batch.content.url);assert.equal(content.status,200,content.text);
  assert.equal('sha256:'+createHash('sha256').update(content.text).digest('hex'),batch.content.blob.hash);
  return content.text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
async function submit(f,body,id,revision){
  const request=f.command({documentId:id,expectedDocumentRevision:revision,body}),result=await terminal(f,request);
  return {request,result,receipt:result.json.receipt};
}
async function run(f,body,id='document_1'){
  const value=await submit(f,body,id,(await document(f,id)).revision);
  assert.equal(value.receipt.status,'accepted',value.result.text);
  return {...value,events:await events(f,value.receipt),document:await document(f,id)};
}
async function layer(f,id,fixture){
  const {asset}=await importRaster(f,fixture);
  await run(f,{type:'ImportAsset',assetId:asset.id,layerId:id,name:id,draft:null});
}
async function properties(f,id,value){
  const current=(await image(f)).layers.find(layer=>layer.id===id);
  return run(f,{type:'SetLayerProperties',layerId:id,layerVersion:current.version,properties:value,draft:null});
}
async function source(f){
  const before=await document(f),captured=await run(f,{type:'PrepareRequestSource',scope:'single-layer',layerIds:['picture']}),asset=captured.events[0].payload.asset;
  assert.deepEqual(await document(f),before);
  return {assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:512,height:512,scope:'single-layer',documentRevision:before.revision,capture:asset.raster.manifest};
}
// Only the provider boundary is substituted. Commands, retained raster inputs,
// queue admission, result decoding, review and history all use the real server.
async function fixture(t,mode='inpaint'){
  // Provider teardown records its final resource state inside this root.
  let server;t.after(()=>server?.close());
  const root=await rootFor(t),module=mode==='inpaint'?'../request-edits/observer-fixture.mjs':'../candidates/observer-fixture.mjs';
  server=await startLocalServer({root},{writer:{setupModule:new URL(module,import.meta.url).href}});
  const paired=await pair(server);assert.equal(paired.status,200,paired.text);
  const f={root,server,paired,
    read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),
    post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),
    command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body),
    effects:async()=>{const value=JSON.parse(await readFile(join(root,mode==='inpaint'?'request-edits-fixture.json':'candidate-fixture.json'),'utf8'));assert.deepEqual(value.errors,[]);return value.effects;},
  };
  assert.equal((await terminal(f,f.command({}, {width:512,height:512}))).json.receipt.status,'accepted');return f;
}
async function caption(f,text){
  const staged=await upload(f,Buffer.from(text),'caption','text/plain');
  return (await operate(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;
}
async function ui(f,body){
  const sessionId='deferred_adoption',current=(await f.read('/api/v1/ui/'+sessionId)).json;
  const request={protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:current.uiSeq,body};
  const result=await f.post('/api/v1/ui/'+sessionId,request);assert.equal(result.json.status,'accepted',result.text);
  return {request,value:result.json};
}
async function candidate(f,captured=null){
  const prompt=await caption(f,'Cold deferred placement fixture'),draft=newDraft(prompt.blob);
  Object.assign(draft.fields,{width:'512',height:'512'});
  if(captured){
    const asset=(await operate(f,{type:'PrepareRequestMask',sourceAssetId:captured.assetId,plan:{width:512,height:512,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:1,y:1,width:1,height:1},mode:'replace'}]},clip:null})).event.payload.asset;
    const manifest=(await f.read('/api/v1/assets/'+asset.id+'/raster')).json;
    const mask={assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:512,height:512,sourceHash:captured.pixels.hash,polarity:'white-edit',fullAcknowledged:false,empty:false,full:false,plan:asset.raster.manifest,binding:bindRequestMask(captured)};
    mask.requestPlan=confirmRequestMask(captured,mask,manifest.plan.hard,manifest.plan.effective,randomUUID());
    draft.operation='inpaint';draft.fields.size='auto';draft.fields.strength='1';draft.source=captured;draft.mask=mask;
  }
  const draftBytes=JSON.stringify(draft);assert.notEqual(draftBytes,canonical(draft),'Saved authored JSON deliberately uses noncanonical key order');
  const saved=await caption(f,draftBytes);
  await ui(f,{type:'SaveDraft',draft:{id:'request',generation:'1',kind:'request',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:(await document(f)).revision,assetId:saved.id,composing:false}});
  const reviewed=await ui(f,{type:'PrepareRequestReview',draftId:'request',generation:'1'}),review=reviewed.value.review;
  const accepted=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});
  const queued=await operate(f,{type:'QueueInference',reviewId:review.id,token:review.token,acceptanceId:accepted.request.requestId}),jobId=queued.event.payload.id;
  let value;const deadline=Date.now()+20000;
  do{
    const response=await f.read('/api/v1/jobs/'+jobId+'/candidates');if(response.status===200)value=response.json.items[0];
    if(value?.state==='prepared')break;await new Promise(resolve=>setTimeout(resolve,25));
  }while(Date.now()<deadline);
  assert.equal(value?.state,'prepared',JSON.stringify(value));return {value,draft,saved,draftBytes};
}
const placement=(candidate,patch={})=>({type:'ReviewCandidatePlacement',candidateId:candidate.id,mode:'safe-region',placement:'current-document',newDocumentId:null,actualOutput:null,newLayerId:randomUUID(),name:'Deferred candidate',...patch});
const adoption=review=>({type:'AdoptReviewedCandidate',reviewId:review.reviewId,reviewHash:review.reviewHash,draft:null});
async function review(f,body){
  const before=await document(f),beforeImage=await image(f),cold=inventory(f);
  const result=await run(f,body);assert.deepEqual(result.events.map(event=>event.type),['CandidatePlacementReviewPrepared']);
  assert.equal(result.receipt.documentRevision,before.revision);assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeImage);
  assert.deepEqual(inventory(f),cold,'Review must not create Q, a wrapper, a composite, a preview or history');
  const identity=result.events[0].payload,response=await f.read('/api/v1/image-edit-reviews/'+identity.reviewId);
  assert.equal(response.status,200,response.text);const value=response.json,{type,...expectedPlacement}=body;
  assert.equal(value.kind,'candidate-placement-review-1');assert.equal(value.protocolVersion,1);
  assert.equal(value.reviewId,identity.reviewId);assert.equal(value.reviewHash,identity.reviewHash);
  assert.equal(value.targetClientId,f.paired.json.clientId);assert.equal(value.documentId,before.id);assert.equal(value.documentRevision,before.revision);
  assert.deepEqual(value.placement,expectedPlacement);assert.equal(value.width,512);assert.equal(value.height,512);
  assert.equal(value.inputs.kind,'candidate-adoption-inputs-1');assert.equal(value.inputs.mode,body.mode);
  assert.equal(value.inputs.identity.candidateId,body.candidateId);assert.equal('preview' in value,false);
  if(before.image)assert.deepEqual(value.source,before.image);
  else {assert.equal(value.source.compositeAssetId,null);assert.deepEqual(JSON.parse(await retained(f,value.source.state)),beforeImage);}
  return value;
}
async function accept(f,review){
  const id=review.placement.placement==='new-document'?review.placement.newDocumentId:review.documentId;
  const revision=review.placement.placement==='new-document'?null:(await document(f,id)).revision;
  const value=await submit(f,adoption(review),id,revision);assert.equal(value.receipt.status,'accepted',value.result.text);
  const committed=await events(f,value.receipt),finalType=review.placement.placement==='new-document'?'DocumentCreated':'ImageEdited';
  assert.equal(committed.at(-1).type,finalType);assert(committed.length>=3,'Prepared assets and the placement commit share one transaction');
  for(const event of committed)assert.equal(event.transactionId,value.request.command.transactionId);
  assert(committed.slice(0,-1).every(event=>event.type==='AssetRegistered'));
  assert(committed.slice(0,-1).every(event=>event.documentId===null));assert.equal(committed.at(-1).documentId,id);
  return {...value,events:committed,document:await document(f,id)};
}
async function rejected(f,body,code,id='document_1',revision=undefined){
  const before=await document(f),cold=inventory(f),targetBefore=await f.read('/api/v1/documents/'+id);
  const expected=revision===undefined?targetBefore.json.projection.value.revision:revision;
  const value=await submit(f,body,id,expected);assert.equal(value.receipt.status,'rejected',value.result.text);assert.equal(value.receipt.code,code,value.result.text);
  assert.deepEqual(await document(f),before);assert.deepEqual(inventory(f),cold);
  const targetAfter=await f.read('/api/v1/documents/'+id);assert.equal(targetAfter.status,targetBefore.status);
  if(targetBefore.status===200)assert.deepEqual(targetAfter.json.projection.value,targetBefore.json.projection.value);
  return value.receipt;
}

test('cold placement review preserves inputs until one atomic safe adoption with lineage, stack slot and Undo/Redo',async t=>{
  const f=await fixture(t);await layer(f,'picture','hidden-alpha.png');await properties(f,'picture',{opacity:0.5});await layer(f,'overlay','white.png');
  const before=await document(f),beforeImage=await image(f),original=await pixels(f,before.image.compositeAssetId),captured=await source(f);
  const {value:c,draft,saved,draftBytes}=await candidate(f,captured),effects=await f.effects();
  assert.deepEqual(inventory(f).previews,[],'No eager image preview warms this path');
  const approved=await review(f,placement(c,{newLayerId:'replacement'}));
  assert.deepEqual(approved.inputs.plan,draft.mask.requestPlan);assert.equal(approved.inputs.sourceCapture.scope,'single-layer');
  assert.deepEqual(approved.inputs.sourceCapture.layerIds,['picture']);assert.deepEqual(await f.effects(),effects);
  const renewed=await review(f,placement(c,{newLayerId:'replacement'}));assert.notEqual(renewed.reviewId,approved.reviewId,'Metadata review alone does not reserve a layer identity');
  const committed=await accept(f,approved),next=await image(f),history=committed.events.at(-1).payload.history;
  assert.equal(history.operation,'AdoptReviewedCandidate');assert.deepEqual(history.before,before.image);assert.deepEqual(history.after,committed.document.image);
  assert.deepEqual(next.layers.map(layer=>[layer.id,layer.visible]),[['picture',false],['replacement',true],['overlay',true]]);
  assert.deepEqual(next.layers[0],{...beforeImage.layers[0],version:'3',visible:false});assert.deepEqual(next.layers[2],beforeImage.layers[1]);
  assert.deepEqual(next.layers[1].layerToDocument,[1,0,0,1,0,0]);assert.equal(next.layers[1].opacity,1);assert.equal(next.layers[1].mask,null);
  const result=await pixels(f,committed.document.image.compositeAssetId),coverage=await retained(f,draft.mask.requestPlan.effectiveMask);
  for(let at=0;at<coverage.length;at+=2)if(coverage.readUInt16LE(at)===0)assert.deepEqual(result.subarray(at*2,at*2+4),original.subarray(at*2,at*2+4));
  assert.deepEqual([...result.subarray((512+1)*4,(512+2)*4)],[36,104,172,255]);
  const lineage=JSON.parse(await retained(f,history.adoptedLineage));assert.equal(lineage.kind,'adopted-candidate-lineage-1');assert.equal(lineage.inert,true);assert.deepEqual(lineage.candidate,c);
  assert.deepEqual(lineage.result.request.specification.mask.requestPlan,draft.mask.requestPlan);
  assert(history.roots.some(ref=>ref.hash===history.adoptedLineage.hash));
  const closure=(await f.read('/api/v1/documents/document_1/closure')).json.items;
  for(const ref of [history.adoptedLineage,draft.mask.requestPlan.sourcePixels,draft.mask.requestPlan.authoredMask,draft.mask.requestPlan.effectiveMask])assert(closure.some(item=>item.hash===ref.hash),ref.hash);
  const afterCommit=inventory(f);assert.deepEqual((await terminal(f,committed.request)).json.receipt,committed.receipt);assert.deepEqual(inventory(f),afterCommit);
  const undone=await run(f,{type:'Undo',historyHead:committed.document.historyHead});assert.deepEqual(await image(f),beforeImage);assert.deepEqual(await pixels(f,undone.document.image.compositeAssetId),original);
  const reused=await rejected(f,placement(c,{newLayerId:'replacement'}),'CAPACITY');assert.equal(JSON.parse(await retained(f,reused.details)).issues[0].code,'NEW_LAYER_UNAVAILABLE');
  const redone=await run(f,{type:'Redo',historyNode:committed.document.historyHead});assert.deepEqual(await image(f),next);assert.equal(redone.document.image.compositeAssetId,committed.document.image.compositeAssetId);
  await rejected(f,adoption(approved),'STALE_REVISION');
  const archive=await copy(f,'document_1'),portable=(await previewCopy(f,archive.bytes)).review;assert.equal(portable.editable,true,JSON.stringify(portable));
  await workspace(f,{type:'ImportBundle',reviewId:portable.reviewId,reviewHash:portable.reviewHash});
  const imported=await document(f,portable.documentId);assert.deepEqual(await pixels(f,imported.image.compositeAssetId),result);
  const importedHistory=(await f.read('/api/v1/documents/'+portable.documentId+'/history')).json.items;
  const importedAdoption=importedHistory.find(node=>node.operation==='AdoptReviewedCandidate');assert(importedAdoption?.adoptedLineage);
  const importedLineage=JSON.parse(await retained(f,importedAdoption.adoptedLineage));assert.equal(importedLineage.inert,true);assert.equal(importedLineage.candidate.id,c.id);
  const importedUI=(await f.read('/api/v1/ui/'+portable.uiSessionIds[0])).json,importedDraft=importedUI.drafts.find(value=>value.kind==='request');assert(importedDraft);
  const importedDraftAsset=(await f.read('/api/v1/assets/'+importedDraft.assetId)).json.projection.value,mappedDraft=JSON.parse(await retained(f,importedDraftAsset.blob));
  assert.notEqual(mappedDraft.source.assetId,draft.source.assetId);assert.notEqual(mappedDraft.mask.assetId,draft.mask.assetId);assert.deepEqual(mappedDraft.mask.requestPlan,draft.mask.requestPlan);
  assert.deepEqual(await retained(f,saved.blob),Buffer.from(draftBytes),'Original authored draft bytes survive namespace mapping');
  await copy(f,portable.documentId);
  assert.deepEqual(await f.effects(),effects);
});

test('deferred adoption rejects stale review, source and candidate before creating raster artifacts',async t=>{
  const f=await fixture(t);await layer(f,'picture','hidden-alpha.png');
  const captured=await source(f),{value:c}=await candidate(f,captured),approved=await review(f,placement(c)),effects=await f.effects();
  await rejected(f,{...adoption(approved),reviewHash:'sha256:'+'0'.repeat(64)},'STALE_REVISION');
  await rejected(f,{...adoption(approved),reviewId:randomUUID()},'INVALID_INPUT');
  await properties(f,'picture',{opacity:0.5});
  await rejected(f,adoption(approved),'STALE_REVISION');
  const fallback=await review(f,placement(c,{placement:'new-document',newDocumentId:'hidden_candidate',newLayerId:'output'}));
  await operate(f,{type:'HideCandidate',candidateId:c.id,expectedVersion:c.version});
  const hidden=(await f.read('/api/v1/jobs/'+c.jobId+'/candidates?attempt='+c.attemptId)).json.items.find(item=>item.id===c.id);
  assert.equal(hidden.hidden,true);assert.notEqual(hidden.version,c.version);
  await rejected(f,adoption(fallback),'STALE_REVISION','hidden_candidate',null);
  await rejected(f,placement(c,{placement:'new-document',newDocumentId:'still_hidden'}),'INCOMPATIBLE');
  assert.deepEqual(await f.effects(),effects);
});

test('cold full-candidate reviews support new documents and empty current documents while fencing target identity',async t=>{
  const f=await fixture(t,'generate'),before=await document(f),{value:c}=await candidate(f),effects=await f.effects();
  const target='deferred_document',approved=await review(f,placement(c,{mode:'full-candidate',placement:'new-document',newDocumentId:target,newLayerId:'generated'}));
  assert.equal((await f.read('/api/v1/documents/'+target)).status,404);
  await rejected(f,adoption(approved),'INVALID_INPUT','unreviewed_target',null);
  const created=await accept(f,approved);assert.equal(created.receipt.documentRevision,'1');assert.deepEqual(await document(f),before);
  const root=created.events.at(-1).payload.history;assert.equal(root.parent,null);assert.deepEqual(root.forward.after,created.document);
  const output=await image(f,target);assert.deepEqual(output.layers.map(layer=>layer.id),['generated']);
  const wrapper=(await f.read('/api/v1/assets/'+output.layers[0].assetId+'/raster')).json;
  assert.equal(wrapper.plan.kind,'retained-candidate-v1');assert(root.roots.some(ref=>ref.hash===wrapper.plan.lineage.hash));
  assert.equal(JSON.parse(await retained(f,wrapper.plan.lineage)).candidate.id,c.id);
  assert.deepEqual(await pixels(f,created.document.image.compositeAssetId),await pixels(f,c.preparedAssetId));
  const acceptedInventory=inventory(f);assert.deepEqual((await terminal(f,created.request)).json.receipt,created.receipt);assert.deepEqual(inventory(f),acceptedInventory);
  const collision=await review(f,placement(c,{mode:'full-candidate',placement:'new-document',newDocumentId:'occupied_target'}));
  const occupied=await terminal(f,f.command({documentId:'occupied_target'}, {width:8,height:8}));assert.equal(occupied.json.receipt.status,'accepted',occupied.text);
  await rejected(f,adoption(collision),'STALE_REVISION','occupied_target',null);
  const additive=await review(f,placement(c,{mode:'full-candidate',newLayerId:'added_generated'})),added=await accept(f,additive);
  assert.deepEqual((await image(f)).layers.map(layer=>layer.id),['added_generated']);
  assert.deepEqual(await pixels(f,added.document.image.compositeAssetId),await pixels(f,c.preparedAssetId));
  await run(f,{type:'Undo',historyHead:added.document.historyHead});assert.deepEqual((await image(f)).layers,[]);assert.equal((await document(f)).image.compositeAssetId,null);
  const redone=await run(f,{type:'Redo',historyNode:added.document.historyHead});assert.equal(redone.document.image.compositeAssetId,added.document.image.compositeAssetId);
  assert.deepEqual(await f.effects(),effects);
});


// Observe real writer preparation/commit boundaries through its existing setup
// fixture. Only invocation 2 changes a live SQL session at the already existing
// history-after-proofs barrier; original guards, promises and commit work run.
import {writeFile as writeMemoFixture} from 'node:fs/promises';
import {pathToFileURL as memoFixtureURL} from 'node:url';

function memoLifecycleModule(){
  return `
import {setup as baseSetup} from ${JSON.stringify(new URL('../candidates/observer-fixture.mjs',import.meta.url).href)};
import {adapterResources} from ${JSON.stringify(new URL('../../dist/local/server/observability/adapter-resources.js',import.meta.url).href)};
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
export async function setup(store){
  const close=await baseSetup(store),history=store.histories,rows=[],restores=[];
  let active=null,serial=0,faults=0;
  const bytes=()=>adapterResources.snapshot().groups.filter(g=>g.owner==='history'&&g.kind==='placement-review-validation').reduce((n,g)=>n+g.reservedBytes,0);
  const write=closed=>{const text=JSON.stringify({rows,faults,closed,booked:bytes()});if(Buffer.byteLength(text)>8192)throw Error('MEMO_FIXTURE_BOUND');writeFileSync(join(store.root,'review-memo-lifecycle.json'),text,{mode:0o600});};
  function wrap(key,make){const original=history[key],wrapped=make(original);history[key]=wrapped;restores.push(()=>{if(history[key]===wrapped)history[key]=original;else faults++;});}
  wrap('validateReviewMetadata',original=>function(...args){if(active)active.row.pureCalls++;return Reflect.apply(original,this,args);});
  wrap('placementReviewValidation',original=>function(...args){
    const owner=Reflect.apply(original,this,args),scope=active;if(!scope)return owner;scope.row.factories++;
    return {read(...values){const result=Reflect.apply(owner.read,owner,values);scope.row.bookedPeak=Math.max(scope.row.bookedPeak,bytes()-scope.baseline);return result;},dispose(){scope.row.disposals++;return Reflect.apply(owner.dispose,owner,[]);}};
  });
  wrap('approvedPlacement',original=>function(...args){
    const scope=active;if(!scope)return Reflect.apply(original,this,args);
    const row=scope.row,memo=Boolean(args[2]),first=memo&&row.memoCalls===0,before=row.pureCalls;
    if(memo)row.memoCalls++;else row.fullCalls++;
    try{return Reflect.apply(original,this,args);}finally{const delta=row.pureCalls-before;if(first)row.initialPureDelta=delta;else if(memo){row.guardCalls++;row.guardPureCalls+=delta;}else row.fullPureCalls+=delta;}
  });
  wrap('barrier',original=>function(...args){
    const result=Reflect.apply(original,this,args);
    if(active&&args[0]==='history-after-proofs'){
      active.row.barriers++;
      if(active.row.ordinal===2){const changed=store.db.prepare('UPDATE image_edit_reviews SET session_hash=? WHERE id=?').run('b'.repeat(64),active.reviewId);if(Number(changed.changes)!==1)throw Error('MEMO_FIXTURE_REVIEW_JOIN');active.row.revoked=true;}
    }
    return result;
  });
  wrap('prepare',original=>function(...args){
    const pending=this.pending(args[0]);if(pending?.command.body.type!=='AdoptReviewedCandidate')return Reflect.apply(original,this,args);
    if(active||serial>=3)throw Error('MEMO_FIXTURE_INVOCATION_BOUND');
    const row={ordinal:++serial,factories:0,disposals:0,pureCalls:0,memoCalls:0,initialPureDelta:null,guardCalls:0,guardPureCalls:0,fullCalls:0,fullPureCalls:0,barriers:0,revoked:false,bookedPeak:0,finalBooked:null,settled:null};
    const scope={row,reviewId:pending.command.body.reviewId,baseline:bytes()};active=scope;
    const finish=settled=>{try{row.settled=settled;row.finalBooked=bytes()-scope.baseline;rows.push(row);if(active===scope)active=null;else faults++;write(false);}catch{faults++;}};
    let result;try{result=Reflect.apply(original,this,args);}catch(error){finish('threw');throw error;}
    // The side observation returns the exact original promise to the product.
    // Both branches are nonthrowing; it creates no replacement await or timer.
    result.then(()=>finish('fulfilled'),()=>finish('rejected'));return result;
  });
  write(false);
  return Object.assign(async()=>{await close();},{afterStoreDrain(){try{close.afterStoreDrain?.();}finally{for(const restore of restores.reverse())restore();write(true);}}});
}
`;
}

async function memoLifecycleFixture(t){
  let server;t.after(()=>server?.close());const root=await rootFor(t),module=join(root,'review-memo-lifecycle-fixture.mjs');
  await writeMemoFixture(module,memoLifecycleModule(),{flag:'wx',mode:0o600});
  server=await startLocalServer({root},{writer:{setupModule:memoFixtureURL(module).href}});
  const paired=await pair(server);assert.equal(paired.status,200,paired.text);
  const f={root,server,paired,
    read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),
    post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),
    command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body),
    effects:async()=>{const value=JSON.parse(await readFile(join(root,'candidate-fixture.json'),'utf8'));assert.deepEqual(value.errors,[]);return value.effects;},
    async close(){if(server){const owned=server;server=undefined;await owned.close();}},
  };
  assert.equal((await terminal(f,f.command({}, {width:512,height:512}))).json.receipt.status,'accepted');return f;
}

test('real deferred preparation keeps cold and final full validation, rejects live post-proof revocation, and releases each invocation memo',async t=>{
  const f=await memoLifecycleFixture(t),sourceBefore=await document(f),{value:c}=await candidate(f),effects=await f.effects();
  const first=await review(f,placement(c,{mode:'full-candidate',placement:'new-document',newDocumentId:'memo_first_document',newLayerId:'memo_first_layer'}));
  const accepted=await accept(f,first);assert.equal(accepted.document.id,'memo_first_document');assert.deepEqual(await document(f),sourceBefore);
  assert.deepEqual(await pixels(f,accepted.document.image.compositeAssetId),await pixels(f,c.preparedAssetId));
  const denied=await review(f,placement(c,{mode:'full-candidate',placement:'new-document',newDocumentId:'memo_denied_document',newLayerId:'memo_denied_layer'}));
  const refusal=await rejected(f,adoption(denied),'INVALID_INPUT','memo_denied_document',null);
  assert.equal(JSON.parse(await retained(f,refusal.details)).issues[0].code,'IMAGE_REVIEW_EXPIRED');assert.equal((await f.read('/api/v1/documents/memo_denied_document')).status,404);
  const later=await review(f,placement(c,{mode:'full-candidate',placement:'new-document',newDocumentId:'memo_later_document',newLayerId:'memo_later_layer'}));
  const laterAccepted=await accept(f,later);assert.equal(laterAccepted.document.id,'memo_later_document');assert.deepEqual(await pixels(f,laterAccepted.document.image.compositeAssetId),await pixels(f,c.preparedAssetId));
  assert.deepEqual(await document(f),sourceBefore);assert.deepEqual(await f.effects(),effects,'Local acceptance never repeats the provider operation');
  await f.close();
  const raw=await readFile(join(f.root,'review-memo-lifecycle.json'));assert(raw.length<=8192);const observed=JSON.parse(raw);
  assert.equal(observed.closed,true);assert.equal(observed.faults,0);assert.equal(observed.booked,0);assert.equal(observed.rows.length,3);
  for(const [index,row]of observed.rows.entries()){
    assert.equal(row.ordinal,index+1);assert.equal(row.factories,1);assert.equal(row.disposals,1);assert.equal(row.settled,'fulfilled');
    assert.equal(row.initialPureDelta,1,'Every real preparation bootstraps with full validation');assert(row.guardCalls>0,'Actual asynchronous preparation reaches repeated live checks');assert.equal(row.guardPureCalls,0,'Only exact unchanged pure metadata work can be reused');
    assert.equal(row.barriers,1);assert(row.bookedPeak>0&&row.bookedPeak<=131328,'Conservative ownership is bounded; this is not an RSS measurement');assert.equal(row.finalBooked,0);
    assert.equal(row.revoked,index===1);assert.equal(row.fullCalls,index===1?0:1);assert.equal(row.fullPureCalls,index===1?0:1,'Successful commit always reruns full original validation');
  }
});
