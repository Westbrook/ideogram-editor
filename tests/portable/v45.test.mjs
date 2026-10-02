// Staged source only. Run after the complete V45 integration is installed and
// the root-owned typecheck/build gates pass; this file performs no live calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import * as v4 from '../../dist/local/src/request/core.js';
import * as family from '../../dist/local/src/request/family.js';
import {providerReviewV45,verifyRequestReviewV45,validateRequestReviewV45Identity} from '../../dist/local/src/request/review.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {frozenRequest,portableRequestRecord,resultRecord,requestAssetIds,requiresV45Format,v45ProvenanceRecord} from '../../dist/local/server/portable/candidates.js';
import {lineageRecord} from '../../dist/local/server/portable/lineage.js';
import {decodeRecords} from '../../dist/local/server/portable/format.js';
import {ZipIndex,spool} from '../../dist/local/server/portable/zip.js';
import {setup,copy,preview,workspace,terminal,upload,doc,edit} from './helpers.mjs';
import {importRaster} from '../raster/helpers.mjs';
import {unpack,pack,records,addObject,addEntity,changeEntity,encoded} from './archive-fixture.mjs';

const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const blob=(text,mediaType='text/plain')=>({hash:digest(text),byteLength:String(Buffer.byteLength(text)),mediaType});
const prompt='Exact Café 東京 🦋',decimal='-184467440737095516151234567890';
function generation(fields={},mode='raw',text=prompt){
 const draft=family.newV45Draft(blob(text),mode);Object.assign(draft.fields,{quality:'high',promptExpansion:'disabled',count:'4',seed:decimal,...fields});draft.guidanceAcknowledged=true;draft.rewriteAcknowledged=true;
 return {draft,request:family.resolve(draft,text)};
}
function observation(specification,text=prompt){
 const request={endpoint:family.routes[specification.kind].endpoint,prompt:specification.settings.prompt.text,seed:specification.settings.seed.kind==='integer'?specification.settings.seed.decimal:null,specification,assetBindings:{}};
 if(specification.kind==='generate-v45'){request.template=blob(family.bodyTemplate(specification,text),'application/json');request.providerReview=providerReviewV45(specification);}
 return request;
}
const result=request=>({id:'retained_attempt',jobId:'retained_job',documentId:'document_1',requestedCount:request.specification.settings.count,actualCount:null,phase:'queued',provenance:null,inert:true,request});
const candidate=(safety='unknown')=>({id:'retained_candidate',version:'1',documentId:'document_1',jobId:'retained_job',attemptId:'retained_attempt',requestId:'retained_provider_request',outputIndex:0,outputIdentity:digest('retained-output'),safety,state:safety==='safe'?'prepared':'withheld',hidden:false,encodedAssetId:'encoded_candidate',preparedAssetId:safety==='safe'?'prepared_candidate':null,warning:null});
const privacy={profileId:'privacy_verified',profileVersion:1,evidenceDigest:digest('local fixture evidence'),requestedStoreIO:'0',requestedAccess:'most-private-compatible',appliedLifecycleSeconds:null,appliedACL:'private',enforcement:'unknown',fallbackAcknowledgementId:null};
function provenance(request,valid=true){return {
 requestedPrompt:request.prompt,submittedPrompt:request.prompt,returnedPrompt:null,returnedBytes:'0',complete:false,quarantined:!valid,inspection:'unavailable',warning:valid?'provider-metadata-unavailable':'malformed-envelope',requestedSeed:request.seed,returnedSeed:valid?decimal:null,timings:null,timingUnits:null,sourceBodyHash:digest('original response kept outside portable closure'),privacyPolicy:blob(canonical(privacy),'application/json'),schemaVersion:2,responseProfile:'ideogram-v45-result-1',
 availability:{returnedPrompt:'unavailable-by-contract',timings:'unavailable-by-contract',safety:'unavailable-by-contract',providerDimensions:'unavailable-by-contract',measuredImageMetadata:'unavailable-while-withheld',provenance:'partial-metadata-unavailable',resultContract:valid?'valid':'invalid'}
};}

test('V4 request bytes, schema identity and compact portable shape stay unchanged',()=>{
 const draft=v4.newDraft(blob(prompt));draft.fields.count='2';draft.fields.seed=decimal;const direct=v4.resolve(draft,prompt),request=family.resolve(draft,prompt),before=canonical(draft);
 assert.deepEqual(request,direct);assert.equal(family.routes.generate.schemaHash,'sha256:d83cf73ad6afecb49c2c1c094e8876674d0b844d0c1bda93b8ec804026653806');
 const wire='{"prompt":"Exact Café 東京 🦋","expansion_model":"Medium","image_size":{"width":1024,"height":1024},"rendering_speed":"BALANCED","acceleration":"none","num_images":2,"output_format":"png","sync_mode":false,"enable_safety_checker":true,"seed":'+decimal+'}';
 assert.equal(family.bodyTemplate(request,prompt),wire);assert.equal(v4.bodyTemplate(direct,prompt),wire);assert.equal(canonical(draft),before);
 const full=observation(request),compact={endpoint:'ideogram/v4',prompt:blob(prompt),seed:decimal};frozenRequest(request);portableRequestRecord(full);portableRequestRecord(compact);
 assert.deepEqual(Object.keys(full).sort(),['assetBindings','endpoint','prompt','seed','specification']);assert.equal(requiresV45Format(full),false);
});

test('V45 frozen request retains exact count, seed, raw mode and immutable prompt after clone and serialization',()=>{
 const {draft,request}=generation(),before=canonical(request),record=observation(request),roundtrip=JSON.parse(canonical(record));
 draft.fields.count='1';draft.fields.seed='1';draft.prompt.mode='plain';draft.prompt.text.hash=digest('changed');
 frozenRequest(request);portableRequestRecord(roundtrip);assert.equal(canonical(request),before);assert.equal(canonical(roundtrip),canonical(record));
 assert.equal(roundtrip.specification.settings.count,4);assert.deepEqual(roundtrip.specification.settings.seed,{kind:'integer',decimal});assert.equal(roundtrip.specification.settings.prompt.mode,'raw');
 assert(!Object.hasOwn(roundtrip.specification.modelRequest.body,'prompt'));assert(!Object.hasOwn(roundtrip.specification.modelRequest,'seed'));assert.equal(roundtrip.specification.modelRequest.body.num_images,4);assert.equal(roundtrip.specification.modelRequest.promptMode,'raw');assert.deepEqual(requestAssetIds(request),[]);
 assert(family.bodyTemplate(roundtrip.specification,prompt).includes('"seed":'+decimal));assert.equal(roundtrip.specification.modelRequest.safetyAdmission,'blocked-unavailable-evidence');
});

test('V45 portable parser requires full typed specification and exact generation endpoint',()=>{
 const full=observation(generation().request);portableRequestRecord(full);
 for(const endpoint of ['ideogram/v4.5','ideogram/v4.5/fast','ideogram/v4.50','ideogram/v4.5/inpaint','ideogram/v4.5?mode=x'])assert.throws(()=>portableRequestRecord({endpoint,prompt:full.prompt,seed:full.seed}));
 for(const endpoint of ['ideogram/v4','ideogram/v4/fast','ideogram/v4.5/fast','ideogram/v4.50'])assert.throws(()=>portableRequestRecord({...full,endpoint}));
 for(const specification of [{kind:'generate-v45'}, {...generation().request,kind:'transform-v45'}])assert.throws(()=>portableRequestRecord({...full,specification}));
 assert.throws(()=>portableRequestRecord({...full,assetBindings:{invented:'foreign_asset'}}));
});

test('V45 parser rejects mismatched derived fields and legacy controls without mutating supplied evidence',()=>{
 for(const mutate of [r=>r.settings.count=1,r=>r.settings.prompt.mode='plain',r=>r.modelRequest.estimate.cents=0,r=>r.modelRequest.body.enable_safety_checker=true,r=>r.modelRequest.safetyAdmission='safe',r=>r.source=null,r=>r.modelRequest.body.prompt='changed',r=>r.modelRequest.seed={kind:'integer',decimal}]){
  const request=generation().request;mutate(request);const before=canonical(request);assert.throws(()=>frozenRequest(request));assert.equal(canonical(request),before);
 }
});

test('frozen V45 requests have one seed owner and retain the editor seed limit',()=>{
 const request=generation({seed:'1'.repeat(16384)}).request;frozenRequest(request);
 assert(!Object.hasOwn(request.modelRequest,'seed'));assert(!Object.hasOwn(request.modelRequest.body,'seed'));
 request.settings.seed.decimal+='1';assert.throws(()=>frozenRequest(request));
});

test('structural V45 validation does not claim to prove retained prompt or template bytes',()=>{
 const request=generation().request,record=observation(request),changed=structuredClone(request);
 changed.settings.prompt.text=blob('different retained prompt');frozenRequest(changed);
 assert.throws(()=>family.hydrateV45Request(changed,prompt));
 const changedSeed=structuredClone(request);changedSeed.settings.seed={kind:'integer',decimal:'1'};frozenRequest(changedSeed);
 assert.notEqual(family.bodyTemplate(changedSeed,prompt),family.bodyTemplate(request,prompt));
 record.template=blob('{}','application/json');portableRequestRecord(record);
 assert(!Object.hasOwn(record.specification.modelRequest.body,'prompt'));assert(!Object.hasOwn(record.specification.modelRequest,'seed'));
});

test('portable V45 template and admission evidence cannot be omitted, substituted or upgraded into authority',()=>{
 for(const mutate of [r=>delete r.template,r=>delete r.providerReview,r=>r.template=blob('{}','text/plain'),r=>r.providerReview.dispatch=true,r=>r.providerReview.admission.adoption=true,r=>r.providerReview.schemaHash=digest('wrong-schema'),r=>r.providerReview.owner='browser',r=>r.seed='1',r=>r.prompt=blob('different prompt')]){
  const request=observation(generation().request);mutate(request);assert.throws(()=>portableRequestRecord(request));
 }
});

test('format10 detection uses typed boundaries and does not reinterpret authored text as V45 authority',()=>{
 const {draft,request}=generation(),record=result(observation(request));
 for(const value of [draft,request,record,{kind:'request-review-v45-1'},{kind:'adopted-candidate-lineage-1',result:record}])assert.equal(requiresV45Format(value),true);
 for(const value of [{prompt:'generate-v45'},{text:canonical(request)},{raw:{kind:'generate-v45'}},{kind:'composition-version-1',scene:'ideogram/v4.5'}])assert.equal(requiresV45Format(value),false);
});

test('V45 result counts remain bound to their frozen generation request',()=>{
 const value=result(observation(generation().request));resultRecord(value);assert.throws(()=>resultRecord({...value,requestedCount:1}));
});

test('V45 schema2 provenance preserves unavailable metadata without inventing completeness or measured output',()=>{
 const request=observation(generation().request);
 for(const valid of [true,false]){
  const value={...result(request),actualCount:valid?0:null,phase:valid?'completed':'quarantined',provenance:provenance(request,valid)},before=canonical(value);
  v45ProvenanceRecord(value.provenance);resultRecord(value);assert.equal(canonical(value),before);assert.equal(requiresV45Format(value.provenance),true);
  assert.equal(value.provenance.complete,false);assert.equal(value.provenance.returnedPrompt,null);assert.equal(value.provenance.timings,null);assert.equal(value.provenance.timingUnits,null);assert.equal(value.provenance.availability.measuredImageMetadata,'unavailable-while-withheld');
 }
});

test('V45 provenance rejects substituted request identity, promoted metadata and impossible unobserved states',()=>{
 const request=observation(generation().request);
 for(const mutate of [p=>p.complete=true,p=>p.returnedPrompt=request.prompt,p=>p.returnedBytes='1',p=>p.timings={},p=>p.timingUnits='unknown',p=>p.inspection='supported',p=>p.availability.safety='safe',p=>p.availability.measuredImageMetadata='available',p=>p.quarantined=true,p=>p.warning=null,p=>p.responseProfile='ideogram-v4-result-1',p=>p.headers={Authorization:'forbidden'},p=>p.requestedPrompt=blob('different request'),p=>p.submittedPrompt=blob('different wire prompt'),p=>p.requestedSeed='1']){
  const value={...result(request),actualCount:0,phase:'completed',provenance:provenance(request)};mutate(value.provenance);assert.throws(()=>resultRecord(value));
 }
 const completed={...result(request),actualCount:0,phase:'completed',provenance:provenance(request)};
 assert.throws(()=>resultRecord({...completed,actualCount:null}));assert.throws(()=>resultRecord({...completed,phase:'running'}));assert.throws(()=>resultRecord({...completed,provenance:{...completed.provenance,returnedSeed:null}}));
 assert.throws(()=>resultRecord({...result(request),phase:'completed'}));assert.throws(()=>resultRecord({...result(request),actualCount:0}));
});

test('blocked V45 results cannot manufacture an admissible adopted lineage',()=>{
 const value={kind:'adopted-candidate-lineage-1',inert:true,candidate:candidate('safe'),result:result(observation(generation().request)),assetBindings:{encoded_candidate:'encoded_candidate',prepared_candidate:'prepared_candidate'}};
 assert.throws(()=>lineageRecord(value));
});

async function archive(t,{draft=false,v4Only=false,withRaster=false}={}){
 const f=await setup(t);await terminal(f,f.command({},withRaster?{width:3,height:2}:{width:1,height:1}));let raster=null;if(withRaster){raster=(await importRaster(f,'hidden-alpha.png')).asset;await edit(f,{type:'ImportAsset',assetId:raster.id,layerId:'owned_picture',name:'Owned original',draft:null});}const saved=await copy(f),entries=await unpack(f.root,saved.bytes),generated=generation();
 let specification=generated.request;if(v4Only)specification=v4.resolve(v4.newDraft(blob(prompt)),prompt);
 const request=observation(specification),job=result(request);addObject(entries,Buffer.from(prompt),'text/plain');if(request.template)addObject(entries,Buffer.from(family.bodyTemplate(specification,prompt)),'application/json');
 if(draft){
  const value=generated.draft,ref=addObject(entries,encoded(value),'text/plain');
  addEntity(entries,'asset','retained_request_draft',{id:'retained_request_draft',version:'1',purpose:'caption',blob:ref,dependencies:[],safety:'safe',availability:'available',qualification:'opaque-text',measuredMediaType:'text/plain'});
  addEntity(entries,'draft','retained_ui',{sessionId:'retained_ui',uiSeq:'1',preferences:null,drafts:[{id:'retained_draft',generation:'1',kind:'request',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:'1',assetId:'retained_request_draft',composing:false,status:'saved-unapplied'}],reconciledLayerIds:[]});
 }else addEntity(entries,'job-result',job.id,job);
 const manifest=JSON.parse(entries.get('manifest.json'));manifest.formatVersion=manifest.documentSchema=v4Only?9:10;entries.set('manifest.json',encoded(manifest));return {f,entries,job,request,draft:generated.draft,raster};
}
async function rejectPreview(f,entries){
 const before=await doc(f),bytes=await pack(f.root,entries),stage=await upload(f,bytes),command=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'PreviewBundleImport',stagingId:stage.stagingId,expectedSha256:stage.sha256}}),response=await terminal(f,command);
 assert.equal(response.json.receipt.status,'rejected',response.text);assert.deepEqual(await doc(f),before);
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM portable_namespaces').get().n,0);}finally{db.close();}
}

test('queued V45 provenance imports and re-copies as format10 with its frozen request and wire bytes intact',async t=>{
 const x=await archive(t),review=await preview(x.f,await pack(x.f.root,x.entries));assert.equal(review.review.editable,true);assert.equal(review.review.formatVersion,10);
 await workspace(x.f,{type:'ImportBundle',reviewId:review.review.reviewId,reviewHash:review.review.reviewHash});const copied=await copy(x.f,review.review.documentId),entries=await unpack(x.f.root,copied.bytes),manifest=JSON.parse(entries.get('manifest.json'));
 assert.equal(manifest.formatVersion,10);assert.equal(manifest.documentSchema,10);const row=records(entries).values.find(row=>row.kind==='entity'&&row.entityType==='job-result'),job=JSON.parse(entries.get('objects/'+row.payloadRef.hash.slice(7)));
 assert.deepEqual(job.request,x.request);assert.equal(job.requestedCount,4);assert.equal(job.inert,true);assert.equal(job.provenance,null);assert.notEqual(job.id,x.job.id);assert.notEqual(job.jobId,x.job.jobId);
 assert.equal(entries.get('objects/'+x.request.template.hash.slice(7)).toString(),family.bodyTemplate(x.request.specification,prompt));assert.equal(entries.get('objects/'+x.request.prompt.hash.slice(7)).toString(),prompt);
});

test('ref-only V45 control records remain below 64 KiB while exact prompt and template objects round-trip separately',async t=>{
 const x=await archive(t),text='A'+'\u0001'.repeat(9999),seed='1'.repeat(16384),request=observation(generation({seed},'raw',text).request,text),wire=family.bodyTemplate(request.specification,text),route=family.routes['generate-v45'];
 const binding={kind:'request-review-v45-1',id:'retained_review',owner:digest('fixture owner'),draft:{sessionId:'retained_ui',draftId:'retained_draft',generation:'1'},draftAsset:'retained_request_draft',documentId:'document_1',documentRevision:'1',request:request.specification,endpoint:request.endpoint,schemaHash:route.schemaHash,routeHash:digest(canonical(route)),dependencyHash:digest('fixture dependencies'),template:request.template,prompt:request.prompt,conversion:null,inactive:{},destination:'retained-candidates',privacy:'minimum-retention-unqualified',estimate:request.specification.modelRequest.estimate,dispatch:false,providerReview:request.providerReview};
 const frozenReview={...binding,token:digest(canonical(binding))};validateRequestReviewV45Identity(frozenReview);verifyRequestReviewV45(frozenReview,text);assert(encoded(frozenReview).length<=60000);
 addObject(x.entries,Buffer.from(text),'text/plain');addObject(x.entries,Buffer.from(wire),'application/json');const value=changeEntity(x.entries,'job-result',job=>Object.assign(job,result(request)));
 resultRecord(value);assert(encoded(value).length<=65536);assert(Buffer.byteLength(wire)>65536);assert.equal(request.seed.length,16384);
 assert(!Object.hasOwn(request.specification.modelRequest.body,'prompt'));assert(!Object.hasOwn(request.specification.modelRequest,'seed'));
 const review=await preview(x.f,await pack(x.f.root,x.entries));assert.equal(review.review.editable,true);assert.equal(review.review.formatVersion,10);await workspace(x.f,{type:'ImportBundle',reviewId:review.review.reviewId,reviewHash:review.review.reviewHash});
 const entries=await unpack(x.f.root,(await copy(x.f,review.review.documentId)).bytes),copiedManifest=JSON.parse(entries.get('manifest.json')),row=records(entries).values.find(row=>row.kind==='entity'&&row.entityType==='job-result'),payload=entries.get('objects/'+row.payloadRef.hash.slice(7)),copied=JSON.parse(payload);
 assert.equal(copiedManifest.formatVersion,10);assert.equal(copiedManifest.documentSchema,10);assert(payload.length<=65536);assert.deepEqual(copied.request,request);
 assert(!Object.hasOwn(copied.request.specification.modelRequest.body,'prompt'));assert(!Object.hasOwn(copied.request.specification.modelRequest,'seed'));
 assert.deepEqual(entries.get('objects/'+request.prompt.hash.slice(7)),Buffer.from(text));assert.deepEqual(entries.get('objects/'+request.template.hash.slice(7)),Buffer.from(wire));
});

// Exercise the archive parser directly so an oversized result cannot pass merely
// because a later provenance-completeness check would independently reject it.
async function decodeArchive(f,entries){
 const path=join(f.root,'v45-boundary-'+randomUUID()+'.zip');await writeFile(path,await pack(f.root,entries),{mode:0o600});
 const db=spool(join(f.root,'v45-boundary-'+randomUUID()+'.sqlite')),zip=new ZipIndex(path,db);
 try{await zip.headers(()=>{});await zip.hashes(()=>{});return await decodeRecords(zip,db,()=>{});}finally{zip.close();db.close();}
}
test('format10 has no V45 exception for a structurally valid result payload above 64 KiB',async t=>{
 const x=await archive(t),seed='1'.repeat(16384),request=observation(generation({seed}).request),value={...result(request),actualCount:0,phase:'completed',provenance:provenance(request)};
 value.provenance.returnedSeed=seed;resultRecord(value);assert(encoded(value).length>65536);assert(encoded(value).length<131072);
 addObject(x.entries,Buffer.from(family.bodyTemplate(request.specification,prompt)),'application/json');addObject(x.entries,encoded(privacy));
 changeEntity(x.entries,'job-result',job=>Object.assign(job,value));
 await assert.rejects(()=>decodeArchive(x.f,x.entries));
});

for(const text of ['   \n','A'.repeat(10001)])test('portable authority hydrates and rejects an invalid retained prompt '+JSON.stringify(text.slice(0,12)),async t=>{
 const x=await archive(t),reference=addObject(x.entries,Buffer.from(text),'text/plain');
 const value=changeEntity(x.entries,'job-result',job=>{job.request.prompt=reference;job.request.specification.settings.prompt.text=reference;});
 // Ref-only structural identity is valid; authoritative prompt hydration is not.
 resultRecord(value);assert.throws(()=>family.hydrateV45Request(value.request.specification,text));
 await rejectPreview(x.f,x.entries);
});

test('portable authority rejects a changed retained prompt even when both prompt references agree',async t=>{
 const x=await archive(t),text=prompt.normalize('NFD'),reference=addObject(x.entries,Buffer.from(text),'text/plain');
 assert.notEqual(text,prompt);assert.equal(text.normalize('NFC'),prompt);
 const value=changeEntity(x.entries,'job-result',job=>{job.request.prompt=reference;job.request.specification.settings.prompt.text=reference;});
 resultRecord(value);assert.equal(family.hydrateV45Request(value.request.specification,text).body.prompt,text);
 assert.notEqual(family.bodyTemplate(value.request.specification,text),x.entries.get('objects/'+value.request.template.hash.slice(7)).toString());
 await rejectPreview(x.f,x.entries);
});

for(const [label,change] of [
 ['trailing whitespace',wire=>wire+'\n'],
 ['quoted exact seed',wire=>wire.replace('"seed":'+decimal,'"seed":'+JSON.stringify(decimal))],
 ['changed exact seed',wire=>wire.replace('"seed":'+decimal,'"seed":1')],
])test('portable authority rejects '+label+' in retained template bytes',async t=>{
 const x=await archive(t),wire=family.bodyTemplate(x.request.specification,prompt),substitute=change(wire);assert.notEqual(substitute,wire);
 const template=addObject(x.entries,Buffer.from(substitute),'application/json'),value=changeEntity(x.entries,'job-result',job=>{job.request.template=template;});
 resultRecord(value);assert.deepEqual(value.request.prompt,blob(prompt));assert.equal(value.request.specification.settings.seed.decimal,decimal);
 await rejectPreview(x.f,x.entries);
});

test('V45 saved draft imports and re-copies as format10 without losing mode, count or exact seed',async t=>{
 const x=await archive(t,{draft:true}),review=await preview(x.f,await pack(x.f.root,x.entries));assert.equal(review.review.editable,true);await workspace(x.f,{type:'ImportBundle',reviewId:review.review.reviewId,reviewHash:review.review.reviewHash});
 const ui=(await x.f.read('/api/v1/ui/'+review.review.uiSessionIds[0])).json,entry=ui.drafts[0];assert.equal(entry.kind,'request');
 const copied=await copy(x.f,review.review.documentId),entries=await unpack(x.f.root,copied.bytes);assert.equal(JSON.parse(entries.get('manifest.json')).formatVersion,10);
 const row=records(entries).values.find(row=>row.kind==='entity'&&row.entityType==='asset'&&JSON.parse(entries.get('objects/'+row.payloadRef.hash.slice(7))).id===entry.assetId),asset=JSON.parse(entries.get('objects/'+row.payloadRef.hash.slice(7))),draft=JSON.parse(entries.get('objects/'+asset.blob.hash.slice(7)));
 assert.deepEqual(draft,x.draft);assert.equal(draft.fields.count,'4');assert.equal(draft.fields.seed,decimal);assert.equal(draft.prompt.mode,'raw');assert.equal(draft.guidanceAcknowledged,true);assert.equal(draft.rewriteAcknowledged,true);
});

async function editDraftUI(f,sessionId,body){
 const ui=(await f.read('/api/v1/ui/'+sessionId)).json,response=await f.post('/api/v1/ui/'+sessionId,{protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:ui.uiSeq,body});
 assert.equal(response.status,200,response.text);return response.json;
}
async function editDraftCaption(f,text){
 const staged=await upload(f,Buffer.from(text),'caption','text/plain');return (await workspace(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;
}
async function editDraftCapture(f,scope,layerIds){
 const before=await doc(f),asset=(await edit(f,{type:'PrepareRequestSource',scope,layerIds})).event.payload.asset;
 assert.deepEqual(await doc(f),before);
 return {assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:asset.raster.width,height:asset.raster.height,scope,documentRevision:before.revision,capture:asset.raster.manifest};
}
function editDraftArchive(entries,assetId){
 const values=records(entries).values.filter(row=>row.kind==='entity'&&row.entityType==='asset').map(row=>JSON.parse(entries.get('objects/'+row.payloadRef.hash.slice(7)))),assets=new Map(values.map(asset=>[asset.id,asset]));
 const caption=assets.get(assetId);assert(caption,'copied request draft asset');const draft=JSON.parse(entries.get('objects/'+caption.blob.hash.slice(7)));family.draftShape(draft);
 assert(draft.preparedInputs,'copy retains stale prepared inputs');const owner=assets.get(draft.preparedInputs.assetId);assert(owner,'copied preparation owner');
 const manifest=JSON.parse(entries.get('objects/'+owner.raster.manifest.hash.slice(7)));assert.equal(manifest.plan.kind,'v45-edit-inputs-1');
 assert.deepEqual(draft.preparedInputs.manifest,owner.raster.manifest);assert.deepEqual(draft.preparedInputs.source.manifest,owner.raster.manifest);
 assert.deepEqual(manifest.plan.assetBindings,{source:draft.source.assetId,mask:draft.mask?.assetId??null,references:draft.references.map(source=>source.assetId)});
 assert.deepEqual(owner.raster.sourceAssetIds,[...new Set([draft.source.assetId,...(draft.mask?[draft.mask.assetId]:[]),...draft.references.map(source=>source.assetId)])]);
 for(const source of [draft.source,...draft.references])assert.deepEqual(source.capture,assets.get(source.assetId).raster.manifest);
 if(draft.mask)assert.deepEqual(draft.mask.plan,assets.get(draft.mask.assetId).raster.manifest);
 return {draft,owner,manifest};
}
function originalEditObjects(entries,plan){
 // Follow the frozen metadata graph, including captured image states and the
 // original R16 plan. Namespace remapping must retain every original byte.
 const originals=new Map();
 const visit=value=>{
  if(!value||typeof value!=='object')return;
  if(!Array.isArray(value)&&Object.keys(value).sort().join(',')==='byteLength,hash,mediaType'){
   if(originals.has(value.hash))return;const bytes=entries.get('objects/'+value.hash.slice(7));assert(bytes,'original edit object '+value.hash);assert.equal(digest(bytes),value.hash);assert.equal(String(bytes.length),value.byteLength);originals.set(value.hash,bytes);
   if(value.mediaType==='application/json')visit(JSON.parse(bytes));return;
  }
  for(const child of Object.values(value))visit(child);
 };
 visit(plan);return originals;
}
function assertNoEditQueue(f){
 const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});try{for(const table of ['queue_jobs','queue_outbox'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get().n,0,table);}finally{db.close();}
}
async function preparedEditCopy(t,operation){
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const raster=(await importRaster(f,'hidden-alpha.png')).asset;
 await edit(f,{type:'ImportAsset',assetId:raster.id,layerId:'edit_picture',name:'Edit source',draft:null});
 const source=await editDraftCapture(f,'single-layer',['edit_picture']),reference=await editDraftCapture(f,'visible-document',[]);let mask=null;
 if(operation==='inpaint-v45'){
  const asset=(await workspace(f,{type:'PrepareRequestMask',sourceAssetId:source.assetId,plan:{width:3,height:2,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:0,y:0,width:1,height:1},mode:'replace'}]},clip:null})).event.payload.asset,manifest=(await f.read('/api/v1/assets/'+asset.id+'/raster')).json;
  mask={assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:3,height:2,sourceHash:source.pixels.hash,polarity:'white-edit',fullAcknowledged:false,empty:false,full:false,plan:asset.raster.manifest,binding:v4.bindRequestMask(source)};
  mask.requestPlan=v4.confirmRequestMask(source,mask,manifest.plan.hard,manifest.plan.effective,randomUUID());
 }
 const references=[reference,source],owner=(await workspace(f,{type:'PrepareV45EditInputs',source,mask,references})).event.payload.asset,manifest=(await f.read('/api/v1/assets/'+owner.id+'/raster')).json;
 const promptAsset=await editDraftCaption(f,prompt),draft=family.newV45EditDraft(promptAsset.blob,operation,'raw');Object.assign(draft.fields,{count:'4',seed:decimal});Object.assign(draft,{source,mask,references,guidanceAcknowledged:true,rewriteAcknowledged:true,preparedInputs:{assetId:owner.id,version:owner.version,manifest:owner.raster.manifest,source:{blob:owner.blob,pixels:owner.raster.pixels,manifest:owner.raster.manifest,pixelIdentity:owner.raster.pixelIdentity,width:owner.raster.width,height:owner.raster.height},mask:manifest.plan.mask,references:manifest.plan.references.map(item=>item.input)}});
 const asset=await editDraftCaption(f,canonical(draft)),sessionId='portable_v45_edit',draftId='edit_draft';
 assert.equal((await editDraftUI(f,sessionId,{type:'SaveDraft',draft:{id:draftId,generation:'1',kind:'request',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:(await doc(f)).revision,assetId:asset.id,composing:false}})).status,'accepted');
 const reviewed=await editDraftUI(f,sessionId,{type:'PrepareRequestReview',draftId,generation:'1'});assert.equal(reviewed.status,'accepted',JSON.stringify(reviewed));assert.equal(reviewed.review.dispatch,false);
 const accepted=await editDraftUI(f,sessionId,{type:'AcceptRequestReview',reviewId:reviewed.review.id,token:reviewed.review.token});assert.equal(accepted.status,'accepted',JSON.stringify(accepted));assert.equal(accepted.acceptedReview,reviewed.review.id);assertNoEditQueue(f);
 const copied=await copy(f),entries=await unpack(f.root,copied.bytes),original=editDraftArchive(entries,asset.id),originals=originalEditObjects(entries,{plan:original.manifest.plan,preparedInputs:original.draft.preparedInputs});
 assert.deepEqual(original.draft,draft);assert.deepEqual(original.manifest.plan.original,{source,mask});assert.deepEqual(original.manifest.plan.requestPlan,mask?.requestPlan??null);
 await f.server.close();return {bytes:copied.bytes,original,originals,review:reviewed.review};
}

for(const operation of ['transform-v45','inpaint-v45'])test(operation+' draft preserves frozen preparation bytes across two fresh imports while remapping active owners and withholding review authority',async t=>{
 const fixture=await preparedEditCopy(t,operation);let bytes=fixture.bytes,previous=fixture.original;
 for(let generation=1;generation<=2;generation++){
  const f=await setup(t),review=await preview(f,bytes);assert.equal(review.review.editable,true);assert.equal(review.review.formatVersion,10);
  await workspace(f,{type:'ImportBundle',reviewId:review.review.reviewId,reviewHash:review.review.reviewHash});assert.equal(review.review.uiSessionIds.length,1);
  const sessionId=review.review.uiSessionIds[0],ui=(await f.read('/api/v1/ui/'+sessionId)).json,entry=ui.drafts[0];assert.equal(ui.drafts.length,1);assert.equal(entry.kind,'request');assert.equal(entry.status,'saved-unapplied');
  const staleAcceptance=await editDraftUI(f,sessionId,{type:'AcceptRequestReview',reviewId:fixture.review.id,token:fixture.review.token});assert.equal(staleAcceptance.status,'rejected');assert.match(staleAcceptance.reason,/STALE_REVIEW/);
  const staleReview=await editDraftUI(f,sessionId,{type:'PrepareRequestReview',draftId:entry.id,generation:entry.generation});assert.equal(staleReview.status,'rejected');assert.match(staleReview.reason,/V45_INPUTS_CHANGED/);assert(!staleReview.review);assertNoEditQueue(f);
  const copied=await copy(f,review.review.documentId),entries=await unpack(f.root,copied.bytes),mapped=editDraftArchive(entries,entry.assetId),manifest=JSON.parse(entries.get('manifest.json'));
  assert.equal(manifest.formatVersion,10);assert.equal(manifest.documentSchema,10);assert.equal(mapped.draft.operation,operation);assert.deepEqual(mapped.draft.fields,fixture.original.draft.fields);assert.deepEqual(mapped.draft.prompt,fixture.original.draft.prompt);
  assert.notEqual(mapped.draft.source.assetId,previous.draft.source.assetId);assert.notDeepEqual(mapped.draft.source.capture,previous.draft.source.capture);assert.notEqual(mapped.owner.id,previous.owner.id);assert.notDeepEqual(mapped.owner.raster.manifest,previous.owner.raster.manifest);
  assert.deepEqual(mapped.manifest.plan.original,fixture.original.manifest.plan.original);assert.deepEqual(mapped.manifest.plan.requestPlan,fixture.original.manifest.plan.requestPlan);assert.deepEqual(mapped.manifest.plan.references,fixture.original.manifest.plan.references);assert.deepEqual(mapped.manifest.plan.input,fixture.original.manifest.plan.input);assert.deepEqual(mapped.manifest.plan.mask,fixture.original.manifest.plan.mask);
  assert.notEqual(mapped.manifest.plan.assetBindings.source,mapped.manifest.plan.original.source.assetId);assert.deepEqual(mapped.draft.preparedInputs.source,{...fixture.original.draft.preparedInputs.source,manifest:mapped.owner.raster.manifest});assert.deepEqual(mapped.draft.preparedInputs.mask,fixture.original.draft.preparedInputs.mask);assert.deepEqual(mapped.draft.preparedInputs.references,fixture.original.draft.preparedInputs.references);
  for(const [index,source]of mapped.draft.references.entries()){assert.notEqual(source.assetId,previous.draft.references[index].assetId);assert.deepEqual(source.pixels,fixture.original.draft.references[index].pixels);assert.deepEqual(source.blob,fixture.original.draft.references[index].blob);assert.notEqual(mapped.manifest.plan.assetBindings.references[index],mapped.manifest.plan.references[index].original.assetId);}
  if(mapped.draft.mask){assert.notEqual(mapped.draft.mask.assetId,previous.draft.mask.assetId);assert.notDeepEqual(mapped.draft.mask.plan,previous.draft.mask.plan);assert.deepEqual(mapped.draft.mask.binding,fixture.original.draft.mask.binding);assert.deepEqual(mapped.draft.mask.requestPlan,fixture.original.draft.mask.requestPlan);assert.notEqual(mapped.manifest.plan.assetBindings.mask,mapped.manifest.plan.original.mask.assetId);}
  for(const [hash,original]of fixture.originals)assert.deepEqual(entries.get('objects/'+hash.slice(7)),original,'retained original bytes '+hash);
  for(const row of records(entries).values)assert(!['job-result','candidate-result'].includes(row.entityType),'saved inputs must not manufacture provider results');
  assertNoEditQueue(f);bytes=copied.bytes;previous=mapped;await f.server.close();
 }
});

for(const draft of [false,true])test('format9 refuses nested V45 '+(draft?'draft metadata':'frozen request')+' while preserving the existing namespace',async t=>{
 const x=await archive(t,{draft}),manifest=JSON.parse(x.entries.get('manifest.json'));manifest.formatVersion=manifest.documentSchema=9;x.entries.set('manifest.json',encoded(manifest));await rejectPreview(x.f,x.entries);
});

test('V4-only frozen requests remain format9 after import and re-copy',async t=>{
 const x=await archive(t,{v4Only:true}),review=await preview(x.f,await pack(x.f.root,x.entries));assert.equal(review.review.editable,true);assert.equal(review.review.formatVersion,9);await workspace(x.f,{type:'ImportBundle',reviewId:review.review.reviewId,reviewHash:review.review.reviewHash});
 const entries=await unpack(x.f.root,(await copy(x.f,review.review.documentId)).bytes);assert.equal(JSON.parse(entries.get('manifest.json')).formatVersion,9);const row=records(entries).values.find(row=>row.kind==='entity'&&row.entityType==='job-result');assert.deepEqual(JSON.parse(entries.get('objects/'+row.payloadRef.hash.slice(7))).request,x.request);
});

for(const safety of ['unknown','safe'])test('format10 cannot import a '+safety+' V45 candidate as a complete editable copy',async t=>{
 const x=await archive(t,{withRaster:true}),value={...candidate(safety),encodedAssetId:x.raster.raster.sourceAssetIds[0],preparedAssetId:safety==='safe'?x.raster.id:null};addEntity(x.entries,'candidate-result',value.id,value);await rejectPreview(x.f,x.entries);
});

test('format10 refuses an otherwise well-formed zero-image V45 result because provenance remains unavailable',async t=>{
 const x=await archive(t);addObject(x.entries,encoded(privacy));const value=changeEntity(x.entries,'job-result',job=>{job.actualCount=0;job.phase='completed';job.provenance=provenance(job.request);});
 resultRecord(value);assert.equal(value.provenance.complete,false);assert.equal(value.provenance.availability.resultContract,'valid');assert.equal(records(x.entries).values.some(row=>row.kind==='entity'&&row.entityType==='candidate-result'),false);assert.equal(x.entries.has('objects/'+value.provenance.sourceBodyHash.slice(7)),false);
 await rejectPreview(x.f,x.entries);
});
