import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {verificationBudget} from '../../dist/local/src/protocol/text-budget.js';
import {importRaster} from '../raster/helpers.mjs';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {footprint} from '../../dist/local/src/raster/core.js';
import {emptyComposition,emptyElement,serialize,bindingValue,linkField} from '../../dist/local/src/composition/core.js';
import {replayCompositionText,exportCompositionText} from '../../dist/local/src/composition/text-export.js';
import {createIdentityRequestPlan} from '../../dist/local/src/request/raster-plan.js';
import {planTextTreatment,bindTextTreatmentEnvelope} from '../../dist/local/src/request/text-treatment.js';
import {baseRequestReview,bindRequestTextTreatment,reviewFamily,providerReviewV45} from '../../dist/local/src/request/review.js';
import {newDraft,newV45Draft,resolve,bodyTemplate,estimate,routes} from '../../dist/local/src/request/family.js';
import {validateTextTreatmentObservation} from '../../dist/local/server/portable/text-treatment.js';
import {verifyPortableRequest} from '../../dist/local/server/portable/candidates.js';
import {dependencyIdentity,profile,profileBytes,profileRef} from '../../dist/local/server/text/validation.js';
import {setup,terminal,upload,workspace,edit,doc,copy,preview} from '../portable/helpers.mjs';

const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const ref=(bytes,mediaType)=>({hash:hash(bytes),byteLength:String(bytes.length),mediaType});
const pipeline='cp1-f64-triangle-area-v1/sha256:'+'1'.repeat(64),transform=[1,0,0,1,0,0];
const pixelIdentity=m=>hash(canonical({pipeline:m.pipeline,width:m.width,height:m.height,tiles:m.tiles}));
const identify=body=>({...body,id:hash(canonical(body))});
const semanticDigest=state=>hash(canonical({...state,layers:state.layers.map(({version,...layer})=>layer)}));
const inputOf=plan=>Object.fromEntries(['id','inventory','choice','beforeSource','afterSource','prompt','edit'].map(key=>[key,structuredClone(plan[key])]));

// These metadata fixtures deliberately do not qualify a font or recompute CP1.
// Native/raster qualification stays in the existing worker and portable gates.
function fixture(){
 const objects=new Map(),reads=[],leaves=[];
 const put=(value,mediaType='application/json')=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(mediaType==='application/json'?canonical(value):value),r=ref(bytes,mediaType);objects.set(r.hash,bytes);return r;};
 const leaf=(value,mediaType)=>{const r=put(value,mediaType);leaves.push(r);return r;};
 const read=async r=>{reads.push(r.hash);const bytes=objects.get(r.hash);assert.ok(bytes,'missing immutable object '+r.hash);return bytes;};
 const font=identify({schemaVersion:1,bytes:leaf(Buffer.from('font-fixture-bytes'),'application/octet-stream'),faceIndex:0,format:'static-ttf',parserProfile:'sfnt-static-1-freetype-canvaskit040',fsType:0,licenseRecord:leaf('Local fixture licence','text/plain'),origin:'local-file',embedding:'permitted'});
 const text=identify({schemaVersion:1,textUtf8:put('Café\n東京','text/plain'),style:{primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:1,lineHeightMultiplier:1,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:1,height:1},layoutPolicy:'text-layout-1',fonts:[font]});
 objects.set(profileRef.hash,profileBytes);leaves.push(profileRef);
 let native={schemaVersion:1,text,render:{schemaVersion:1,textVersion:text.id,rendererProfile:{schemaVersion:1,id:profile.id,manifest:profileRef},layout:leaf({opaque:'native layout'},'application/json'),pixels:leaf(Buffer.from([0,0,0,14]),'application/x-ideogram-rgba8'),width:1,height:1,overflow:false,resolvedFonts:[font.id]}};
 native.render=identify({...native.render,dependencyHash:dependencyIdentity(native)});const nativeRef=put(native);
 const base=pixels=>({schemaVersion:1,pipeline,width:1,height:1,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:[{x:0,y:0,width:1,height:1,hash:pixels.hash}]});
 const encoded=leaf(Buffer.from('opaque encoded original'),'image/png'),backgroundPixels=leaf(Buffer.from([90,110,130,255]),'application/x-ideogram-rgba8');
 const background={...base(backgroundPixels),dependencies:[encoded],plan:{kind:'frozen-png-export',sourceAssetId:'original_encoded',pixelIdentity:hash('prior-pixels'),encoder:hash('encoder')}};
 const originals=[put(background),put({...base(native.render.pixels),dependencies:[nativeRef],plan:{kind:'retained-text',source:nativeRef}})];
 const layers=['background','native'].map((id,index)=>({id,version:'7',kind:index?'text':'image',name:id,assetId:id+'_asset',layerToDocument:transform,opacity:1,visible:true,locked:false,blend:'normal',mask:null,...(index?{source:nativeRef}:{})}));
 const c=emptyComposition(1,1,'composition'),linked=emptyElement('text','linked'),unlinked=emptyElement('text','unlinked');
 linked.text={mode:'layer',property:'text-content',layerId:'authored_native',lastReviewedLayerVersion:'7',lastReviewedValue:'Café\n東京'};linked.desc.value='Excluded semantic description';linked.bounds={mode:'literal',value:{rect:[0,0,1,1],transform}};linked.excluded=true;
 unlinked.text.value='Unlinked text still sent';unlinked.desc.value='Blue letters';c.elements=[linked,unlinked];
 const raw=leaf(Buffer.from('{"unknown":true,"unknown":false}\n'),'application/json');c.raw=[raw];
 const projected=serialize(c,[],{authored_native:'native'},true),prompt=put(projected.prompt,'text/plain');c.review={serializer:'caption-json-1',sourceId:c.id,frame:c.frame,request:c.request,dependencies:projected.dependencies,boxes:projected.boxes,prompt};
 const composition={id:c.id,value:put(c),bindings:{authored_native:'native'}},state={schemaVersion:5,width:1,height:1,layers,composition},stateRef=put(state);
 const entries=layers.map((layer,index)=>{
  const pixels=index?native.render.pixels:backgroundPixels,source=originals[index],m={...base(pixels),dependencies:[source],plan:{kind:'cp1-layer-contribution-v1',layer:{assetId:layer.assetId,transform:layer.layerToDocument,opacity:layer.opacity,mask:layer.mask},source,mask:null,maskMapping:'document-luminance-alpha-v1',precision:'binary64',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',footprint:footprint({x:0,y:0,width:1,height:1},transform)}};
  return {manifest:put(m),pixels,pixelIdentity:pixelIdentity(m)};
 });
 const scalar=(value)=>put(bindingValue(value),'text/plain');
 const semanticText=c.elements.map(e=>{const literal=scalar(e.text),description=scalar(e.desc),bounds=e.bounds?put(bindingValue(e.bounds)):null;return {id:e.id,literal,description,bounds,bindings:e.text.mode==='layer'?[{field:'text',bindingLayerId:e.text.layerId,layerId:'native',reviewedLayerVersion:e.text.lastReviewedLayerVersion,reviewedValue:literal}]:[]};});
 const inventory={schemaVersion:1,kind:'text-treatment-inventory-1',documentId:'original_document',documentRevision:'9',grid:{width:1,height:1},imageState:stateRef,layers:layers.map((layer,index)=>({id:layer.id,version:layer.version,kind:layer.kind,visible:layer.visible,locked:layer.locked,stateHash:hash(canonical(layer)),contribution:entries[index],native:index?{source:nativeRef,literal:text.textUtf8,textVersion:text.id,renderVersion:native.render.id,dependencyHash:native.render.dependencyHash}:null})),composition:{id:c.id,value:composition.value,bindingsHash:hash(canonical(composition.bindings)),frameHash:hash(canonical(c.frame))},semanticText};
 const capture=(ids,scope)=>{
  const selected=ids.map(id=>layers.findIndex(l=>l.id===id)),stack=put({schemaVersion:1,kind:'cp1-contribution-stack-v1',pipeline,width:1,height:1,contributions:selected.map(i=>entries[i])}),capture={schemaVersion:1,documentId:inventory.documentId,documentRevision:inventory.documentRevision,image:{state:stateRef,semanticDigest:semanticDigest(state),compositeAssetId:'original_composite'},scope,layerIds:ids};
  const pixels=selected.length===1?entries[selected[0]].pixels:leaf(Buffer.from([85,104,123,255]),'application/x-ideogram-rgba8');
  const manifest=put({...base(pixels),dependencies:[...selected.map(i=>originals[i]),stateRef,stack],plan:{kind:'request-source-capture-v1',capture,layers:selected.map(i=>({assetId:layers[i].assetId,transform,opacity:1,mask:null})),maskMapping:'document-luminance-alpha-v1',precision:'binary64',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',footprints:selected.map(()=>footprint({x:0,y:0,width:1,height:1},transform)),contributions:stack}});
  return {source:{capture:manifest,assetId:'capture_'+ids.join('_'),version:'1',blob:leaf(Buffer.from('encoded '+ids.join('_')),'image/png'),pixels,width:1,height:1,scope,documentRevision:inventory.documentRevision},capture};
 };
 const beforeSource=capture(['background','native'],'visible-document'),afterSource=capture(['background'],'single-layer'),authoredMask=leaf(Buffer.from([255,255]),'application/x-ideogram-r16le'),effectiveMask=leaf(Buffer.from([0,128]),'application/x-ideogram-r16le');
 const requestPlan=createIdentityRequestPlan({document:{width:1,height:1},domain:{x:0,y:0,width:1,height:1},sourcePixels:afterSource.source.pixels,authoredMask,effectiveMask,dependenciesHash:hash('reviewed-mask-dependencies'),resolution:'already-contained',approvalId:'mask_approval'});
 const input={id:'treatment',inventory,choice:{kind:'native-overlay',retainedNativeIds:['native'],placement:'current-document',excludedSemanticIds:['linked'],approvalId:'treatment_approval'},beforeSource,afterSource,prompt:{mode:'composition',bytes:prompt,projection:put(c.review)},edit:{effectiveMask,requestPlan:put(requestPlan)}};
 const make=(value=input)=>{const plan=planTextTreatment(value);return {plan,envelope:bindTextTreatmentEnvelope(plan,put(plan))};};
 return {objects,reads,leaves,put,read,native,nativeRef,originals,layers,c,state,entries,input,make,...make(),raw,requestPlan};
}

test('portable treatment proves complete original inventory, exact projection and deep leaves without reading opaque values',async()=>{
 const f=fixture(),before=new Map([...f.objects].map(([id,bytes])=>[id,Buffer.from(bytes)])),refs=await validateTextTreatmentObservation(f.envelope,f.read),has=r=>refs.some(x=>canonical(x)===canonical(r));
 for(const r of [...f.leaves,...f.originals,f.nativeRef,f.input.inventory.imageState,f.input.inventory.composition.value,f.envelope.plan,f.input.edit.requestPlan])assert(has(r),canonical(r));
 assert.equal(new Set(refs.map(canonical)).size,refs.length);
 for(const r of f.leaves)assert(!f.reads.includes(r.hash),'opaque leaf was read '+r.mediaType);
 for(const [id,bytes]of before)assert.deepEqual(f.objects.get(id),bytes);
 assert.deepEqual(f.plan.includedSemanticIds,['unlinked']);assert.deepEqual(f.plan.excludedSemanticIds,['linked']);
});

function compositionTextFixture(){
 const f=fixture(),exported=replayCompositionText(f.c),input=inputOf(f.plan);
 input.prompt={mode:'composition-text',bytes:f.put(exported.prompt,'text/plain'),projection:f.put(exported.review)};
 return {...f,exported,input,...f.make(input)};
}
test('portable reviewed prose verifies its exact Composition origin, original caption bytes and semantic exclusions',async()=>{
 const f=compositionTextFixture(),before=new Map([...f.objects].map(([id,bytes])=>[id,Buffer.from(bytes)])),refs=await validateTextTreatmentObservation(f.envelope,f.read),has=r=>refs.some(x=>canonical(x)===canonical(r));
 for(const r of [f.input.prompt.bytes,f.input.prompt.projection,f.exported.review.sourceProjection.prompt,f.input.inventory.composition.value,f.raw,f.nativeRef])assert(has(r),canonical(r));
 assert(f.reads.includes(f.exported.review.sourceProjection.prompt.hash));assert(f.reads.includes(f.input.prompt.bytes.hash));
 assert.deepEqual(f.plan.includedSemanticIds,['unlinked']);assert.deepEqual(f.plan.excludedSemanticIds,['linked']);assert.equal(f.plan.prompt.mode,'composition-text');
 assert(!f.exported.prompt.includes('Café\\n東京'));assert(f.exported.prompt.includes('Unlinked text still sent'));
 for(const [id,bytes]of before)assert.deepEqual(f.objects.get(id),bytes);
});
test('portable reviewed prose rejects self-consistent forged exported bytes even with new plan and review hashes',async()=>{
 const f=compositionTextFixture(),input=inputOf(f.plan),review=structuredClone(f.exported.review);input.prompt.bytes=f.put('Different prose with valid immutable bytes','text/plain');review.prompt=input.prompt.bytes;input.prompt.projection=f.put(review);
 await assert.rejects(validateTextTreatmentObservation(f.make(input).envelope,f.read));
});
for(const change of [
 (f,input)=>{input.prompt.projection=f.put(f.c.review);},
 (f,input)=>{input.prompt.mode='composition';},
 (f,input)=>{const review=structuredClone(f.exported.review);review.sourceId='another';input.prompt.projection=f.put(review);},
 (f,input)=>{const review=structuredClone(f.exported.review);review.sourceProjection.prompt=f.put('Changed source caption','text/plain');input.prompt.projection=f.put(review);},
 (f,input)=>{input.choice.excludedSemanticIds=['linked','unlinked'];},
])test('portable reviewed prose does not accept caption/prose relabeling, changed source or changed exclusions',async()=>{
 const f=compositionTextFixture(),input=inputOf(f.plan);change(f,input);await assert.rejects(validateTextTreatmentObservation(f.make(input).envelope,f.read));
});
test('portable reviewed prose requires the retained original caption object rather than trusting its hash in review metadata',async()=>{
 const f=compositionTextFixture();f.objects.delete(f.exported.review.sourceProjection.prompt.hash);await assert.rejects(validateTextTreatmentObservation(f.envelope,f.read),/missing immutable object/);
});

test('portable treatment rejects exact-length wrong bytes, noncanonical plan and oversized ref before reading',async()=>{
 const f=fixture(),original=f.objects.get(f.envelope.plan.hash),wrong=Buffer.from(original);wrong[wrong.length-2]^=1;
 await assert.rejects(validateTextTreatmentObservation(f.envelope,async r=>r.hash===f.envelope.plan.hash?wrong:f.read(r)));
 const noncanonical=f.put(Buffer.from(JSON.stringify(f.plan,null,2)));await assert.rejects(validateTextTreatmentObservation({...f.envelope,plan:noncanonical},f.read));
 await assert.rejects(validateTextTreatmentObservation({...f.envelope,plan:{...f.envelope.plan,byteLength:'524289'}},()=>assert.fail('oversized plan read')));
});

for(const field of ['literal','description','bounds','bindings'])test('portable treatment rejects self-consistent forged excluded semantic '+field,async()=>{
 const f=fixture(),input=inputOf(f.plan),row=input.inventory.semanticText[0];
 if(field==='bindings')row.bindings[0].reviewedLayerVersion='6';
 else row[field]=field==='bounds'?f.put({rect:[0,0,0.5,1],transform}):f.put('Forged retained '+field,'text/plain');
 if(field==='literal')row.bindings[0].reviewedValue=row.literal;
 const forged=f.make(input);await assert.rejects(validateTextTreatmentObservation(forged.envelope,f.read));
});

test('portable treatment rejects native source substitution and a changed original layer even with a rebuilt plan hash',async()=>{
 const f=fixture(),input=inputOf(f.plan);input.inventory.layers[1].native.renderVersion=hash('forged-render');
 await assert.rejects(validateTextTreatmentObservation(f.make(input).envelope,f.read));
 const changed=inputOf(f.plan);changed.inventory.layers[0].stateHash=hash('forged-transform');await assert.rejects(validateTextTreatmentObservation(f.make(changed).envelope,f.read));
});

test('portable treatment rejects capture image digest forgery and K order forgery with valid object hashes',async()=>{
 for(const kind of ['digest','order']){
  const f=fixture(),input=inputOf(f.plan),m=JSON.parse(f.objects.get(input.beforeSource.source.capture.hash));
  if(kind==='digest'){m.plan.capture.image.semanticDigest=hash('forged-state');input.beforeSource.capture=m.plan.capture;}
  else{const stack=JSON.parse(f.objects.get(m.plan.contributions.hash)),old=m.plan.contributions;m.plan.contributions=f.put({...stack,contributions:[...stack.contributions].reverse()});m.dependencies=m.dependencies.map(r=>r.hash===old.hash?m.plan.contributions:r);}
  input.beforeSource.source.capture=f.put(m);await assert.rejects(validateTextTreatmentObservation(f.make(input).envelope,f.read));
 }
});

test('portable treatment rejects a self-consistent request-plan reference with another source or mask',async()=>{
 for(const field of ['sourcePixels','effectiveMask']){
  const f=fixture(),input=inputOf(f.plan),requestPlan=structuredClone(f.requestPlan);requestPlan[field]=f.put(Buffer.alloc(field==='sourcePixels'?4:2,3),field==='sourcePixels'?'application/x-ideogram-rgba8':'application/x-ideogram-r16le');input.edit.requestPlan=f.put(requestPlan);
  await assert.rejects(validateTextTreatmentObservation(f.make(input).envelope,f.read));
 }
});

test('portable original observations have no current-namespace or live-review lookup and cannot repair missing metadata',async()=>{
 const f=fixture();await validateTextTreatmentObservation(f.envelope,f.read);
 f.objects.delete(f.originals[0].hash);await assert.rejects(validateTextTreatmentObservation(f.envelope,f.read),/missing immutable object/);
});

function baseReview(f,family){
 const prompt=f.put('Exact request bytes','text/plain'),draft=family==='v45'?newV45Draft(prompt):newDraft(prompt),request=resolve(draft,'Exact request bytes'),route=routes[draft.operation];
 const value={kind:family==='v45'?'request-review-v45-1':'request-review-1',id:'review',owner:hash('owner'),draft:{sessionId:'session',draftId:'draft',generation:'1'},draftAsset:'draft_asset',documentId:'original_document',documentRevision:'9',request,endpoint:route.endpoint,schemaHash:route.schemaHash,routeHash:hash(canonical(route)),dependencyHash:hash('dependencies'),template:f.put(Buffer.from(bodyTemplate(request,'Exact request bytes'))),prompt,conversion:null,inactive:{},destination:'retained-candidates',privacy:'minimum-retention-unqualified',estimate:estimate(request),dispatch:false,...(family==='v45'?{providerReview:providerReviewV45(request)}:{})};
 return {draft,review:{...value,token:hash(canonical(value))}};
}
for(const family of ['v4','v45'])test(family+' review adjunct retains exact base bytes, family and provider template',()=>{
 const f=fixture(),{draft,review}=baseReview(f,family),draftBytes=canonical(draft),baseBytes=canonical(review),outer=bindRequestTextTreatment(review,f.envelope);
 assert.equal(canonical(draft),draftBytes);assert.equal(canonical(baseRequestReview(outer)),baseBytes);assert.equal(reviewFamily(outer),family);assert.deepEqual(outer.template,review.template);assert.deepEqual(outer.request,review.request);assert.equal(outer.baseToken,review.token);assert.notEqual(outer.token,review.token);
 const changed=structuredClone(outer);changed.textTreatment.planHash=hash('forged-plan');assert.throws(()=>baseRequestReview(changed));
 const changedBase=structuredClone(outer);changedBase.draft.generation='2';const {token,...body}=changedBase;changedBase.token=hash(canonical(body));assert.throws(()=>baseRequestReview(changedBase));
});

async function stage(f,value,mediaType='application/json'){
 const bytes=Buffer.from(typeof value==='string'?value:canonical(value)),s=await upload(f,bytes,'caption','text/plain'),asset=(await workspace(f,{type:'FinalizeStaging',stagingId:s.stagingId,expectedSha256:s.sha256})).event.payload.asset;
 return {asset,ref:{...asset.blob,mediaType},bytes};
}
async function ui(f,body,session='treatment_session'){
 const state=(await f.read('/api/v1/ui/'+session)).json,request={protocolVersion:1,requestId:randomUUID(),sessionId:session,expectedUISeq:state.uiSeq,body};return {request,result:await f.post('/api/v1/ui/'+session,request)};
}
const objectBytes=(f,r)=>readFile(join(f.root,'objects','sha256',r.hash.slice(7,9),r.hash.slice(7)));
async function writerFixture(t){
 const f=await setup(t);await terminal(f,f.command({},{width:1024,height:1024}));
 const c=emptyComposition(1024,1024,randomUUID()),element=emptyElement('text','semantic_lettering');element.text.value='Unlinked Café 東京';element.desc.value='Explicitly included lettering';c.elements=[element];
 const projection=serialize(c,[],{}),prompt=(await stage(f,projection.prompt,'text/plain')).ref;c.review={serializer:'caption-json-1',sourceId:c.id,frame:c.frame,request:c.request,dependencies:projection.dependencies,boxes:projection.boxes,prompt};
 const composition={id:c.id,value:(await stage(f,c)).ref,bindings:{}};await edit(f,{type:'ApprovePromptProjection',composition,draft:null});
 const draft=newDraft(prompt);draft.prompt={mode:'composition',text:prompt,projection:c.review,composition};draft.fields.expansion=c.request.expansion;draft.rewriteAcknowledged=c.request.rewriteAcknowledged;
 const saved=await stage(f,JSON.stringify(draft,null,2)),document=await doc(f),savedResult=await ui(f,{type:'SaveDraft',draft:{id:'request_draft',generation:'1',kind:'request',documentId:document.id,targetLayerId:null,expectedDocumentRevision:document.revision,assetId:saved.asset.id,composing:false}});assert.equal(savedResult.result.json.status,'accepted',savedResult.result.text);
 const intent={kind:'text-treatment-review-intent-1',choice:{kind:'no-native-text',excludedSemanticIds:[],approvalId:'explicit_treatment'},baseline:null,beforeSource:null};
 return {f,c,draft,saved,document,intent,projection};
}

test('real writer freezes typed treatment from retained Composition and preserves exact legacy draft/template bytes',async t=>{
 const {f,draft,saved,document,intent,projection}=await writerFixture(t),before=await doc(f);
 const ordinary=await ui(f,{type:'PrepareRequestReview',draftId:'request_draft',generation:'1'});assert.equal(ordinary.result.json.status,'accepted',ordinary.result.text);
 const prepared=await ui(f,{type:'PrepareRequestReview',draftId:'request_draft',generation:'1',textTreatment:intent});assert.equal(prepared.result.json.status,'accepted',prepared.result.text);
 const review=prepared.result.json.review,base=baseRequestReview(review);assert.equal(review.kind,'request-review-text-1');assert.equal(base.kind,'request-review-1');assert.equal(review.dispatch,false);assert.deepEqual(base.request,ordinary.result.json.review.request);assert.deepEqual(base.template,ordinary.result.json.review.template);
 const plan=JSON.parse(await objectBytes(f,review.textTreatment.plan));assert.deepEqual(plan.includedSemanticIds,['semantic_lettering']);assert.deepEqual(plan.rasterIncludedNativeIds,[]);assert.equal(plan.inventory.documentId,document.id);assert.equal(plan.inventory.documentRevision,document.revision);assert.equal(plan.afterSource,null);
 const closure=await validateTextTreatmentObservation(review.textTreatment,r=>objectBytes(f,r));assert(closure.some(r=>r.hash===plan.inventory.semanticText[0].literal.hash));
 assert.deepEqual(await objectBytes(f,saved.ref),saved.bytes);assert.equal(canonical((await f.read('/api/v1/ui/treatment_session/request?draftId=request_draft&generation=1')).json.value),canonical(draft));assert.equal(JSON.parse(await objectBytes(f,review.template)).prompt,projection.prompt);
 const accepted=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});assert.equal(accepted.result.json.status,'accepted',accepted.result.text);assert.equal(accepted.result.json.acceptedReview,review.id);assert.deepEqual(await doc(f),before);assert.deepEqual((await f.post('/api/v1/ui/treatment_session',prepared.request)).json,prepared.result.json);
 const archive=await copy(f),importReview=(await preview(f,archive.bytes)).review;assert.equal(importReview.editable,true,JSON.stringify(importReview));await workspace(f,{type:'ImportBundle',reviewId:importReview.reviewId,reviewHash:importReview.reviewHash});
 for(const session of importReview.uiSessionIds){const imported=(await f.read('/api/v1/ui/'+session)).json;assert.equal(imported.acceptedReview??null,null);}
 assert.deepEqual(await objectBytes(f,review.textTreatment.plan),Buffer.from(canonical(plan)));
});

test('real writer rejects invented exclusions and stale treatment acceptance while retaining the exact saved request',async t=>{
 const {f,saved,intent}=await writerFixture(t);
 const forged=structuredClone(intent);forged.choice.excludedSemanticIds=['semantic_lettering'];const rejected=await ui(f,{type:'PrepareRequestReview',draftId:'request_draft',generation:'1',textTreatment:forged});assert.equal(rejected.result.json.status,'rejected',rejected.result.text);assert.match(rejected.result.json.reason,/TEXT_TREATMENT_EXCLUSIONS_CHANGED/);
 const prepared=await ui(f,{type:'PrepareRequestReview',draftId:'request_draft',generation:'1',textTreatment:intent});assert.equal(prepared.result.json.status,'accepted',prepared.result.text);const review=prepared.result.json.review;
 await edit(f,{type:'ResizeCanvas',width:1000,height:1024,offsetX:0,offsetY:0,draft:null});const stale=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});assert.equal(stale.result.json.status,'rejected',stale.result.text);assert.match(stale.result.json.reason,/STALE_REVISION|TEXT_TREATMENT_/);assert.deepEqual(await objectBytes(f,saved.ref),saved.bytes);
});

test('real writer explicitly reviews no-source treatment in a blank document for both request families',async t=>{
 const f=await setup(t);await terminal(f,f.command({},{width:1024,height:1024}));const original=await doc(f);assert.equal(original.image,undefined);
 for(const family of ['v4','v45']){
  const prompt=(await stage(f,'Exact '+family+' generation prompt','text/plain')).ref,draft=family==='v45'?newV45Draft(prompt):newDraft(prompt),saved=await stage(f,JSON.stringify(draft,null,2)),draftId='blank_'+family;
  const save=await ui(f,{type:'SaveDraft',draft:{id:draftId,generation:'1',kind:'request',documentId:original.id,targetLayerId:null,expectedDocumentRevision:original.revision,assetId:saved.asset.id,composing:false}});assert.equal(save.result.json.status,'accepted',save.result.text);
  const prepared=await ui(f,{type:'PrepareRequestReview',draftId,generation:'1',textTreatment:{kind:'text-treatment-review-intent-1',choice:{kind:'no-native-text',excludedSemanticIds:[],approvalId:'blank_'+family},baseline:null,beforeSource:null}});assert.equal(prepared.result.json.status,'accepted',prepared.result.text);
  const review=prepared.result.json.review,plan=JSON.parse(await objectBytes(f,review.textTreatment.plan));assert.equal(reviewFamily(review),family);assert.equal(plan.beforeSource,null);assert.equal(plan.afterSource,null);assert.deepEqual(plan.inventory.layers,[]);assert.deepEqual(plan.inventory.semanticText,[]);await validateTextTreatmentObservation(review.textTreatment,r=>objectBytes(f,r));
  if(family==='v45')assert.deepEqual(review.providerReview.admission,{policy:'unknown-withheld-1',state:'blocked',reason:'provider-safety-evidence-unavailable',ordinaryDisplay:false,adoption:false,export:false});
  const accepted=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});assert.equal(accepted.result.json.status,'accepted',accepted.result.text);assert.deepEqual(await objectBytes(f,saved.ref),saved.bytes);
 }
 assert.deepEqual(await doc(f),original);
});


function compositionTextRequestFixture(){
 const f=compositionTextFixture(),input=inputOf(f.plan);
 input.beforeSource=null;input.afterSource=null;input.edit=null;input.choice.placement='new-document';
 const treatment=f.make(input),draft=newV45Draft(input.prompt.bytes);
 draft.prompt={mode:'plain',text:input.prompt.bytes,projection:structuredClone(f.exported.review),composition:structuredClone(f.state.composition)};
 const record=(configured=draft,envelope=treatment.envelope)=>{
  const specification=resolve(configured,f.exported.prompt);
  return {endpoint:specification.modelRequest.endpoint,prompt:configured.prompt.text,seed:null,specification,assetBindings:{},template:f.put(Buffer.from(bodyTemplate(specification,f.exported.prompt))),providerReview:providerReviewV45(specification),textTreatment:envelope};
 };
 return {...f,input,draft,treatment,record};
}
test('portable request binds its reviewed prose to the same treatment source, review and bindings',async()=>{
 const f=compositionTextRequestFixture(),refs=await verifyPortableRequest(f.record(),f.read);
 for(const ref of [f.raw,f.draft.prompt.text,f.draft.prompt.composition.value,f.exported.review.sourceProjection.prompt,f.treatment.envelope.plan])assert(refs.some(value=>canonical(value)===canonical(ref)));
});
test('portable request cannot drop Composition origin while retaining a composition-text treatment claim',async()=>{
 const f=compositionTextRequestFixture();f.draft.prompt={mode:'plain',text:f.draft.prompt.text,projection:null,composition:null};
 await assert.rejects(verifyPortableRequest(f.record(),f.read));
});
test('portable request cannot attach an ordinary plain treatment to reviewed Composition prose',async()=>{
 const f=compositionTextRequestFixture(),input=structuredClone(f.input);input.prompt={mode:'plain',bytes:input.prompt.bytes,projection:null};input.choice.excludedSemanticIds=['linked','unlinked'];
 const treatment=f.make(input);await validateTextTreatmentObservation(treatment.envelope,f.read);
 await assert.rejects(verifyPortableRequest(f.record(f.draft,treatment.envelope),f.read));
});
for(const mismatch of ['source-graph','bindings'])test('portable request rejects a valid but different Composition '+mismatch+' beside its retained treatment',async()=>{
 const f=compositionTextRequestFixture();
 if(mismatch==='source-graph'){const source=structuredClone(f.c);source.raw.push(f.put('Another retained origin leaf','text/plain'));f.draft.prompt.composition.value=f.put(source);}
 else f.draft.prompt.composition.bindings.authored_native='different_original_layer';
 // Both requests remain ordinary exact prose; the mismatch is retained origin
 // identity, not an invented provider composition capability.
 await assert.rejects(verifyPortableRequest(f.record(),f.read));
});


// Reuse the actual native rendering/verification recipe from the History
// treatment fixture. Alpha-zero glyphs keep the expected pixels deterministic;
// real nonempty layout and backend verification still run. This is an authority
// intersection regression, not a new visual/native qualification claim.
async function treatmentNativeLayout(request,fonts){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('../../dist/local/server/text/render-worker.mjs',import.meta.url),{workerData:{request,fonts},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});
  let result,error;const timer=setTimeout(()=>{error=Error('Native treatment fixture render deadline');void worker.terminate();},20000);
  worker.on('message',message=>{if(message.type==='ready')worker.postMessage({type:'admit'});else if(message.type==='result')result=message;else error=Error(JSON.stringify(message));});
  worker.on('error',value=>{error=value;});
  // The promise settles only once the actual worker has drained, also on failure.
  worker.on('exit',code=>{clearTimeout(timer);if(error)reject(error);else if(code||!result)reject(Error('Native treatment fixture did not render'));else resolve(result);});
 });
}
async function treatmentNative(f){
 const put=async(bytes,purpose='text',mediaType='application/octet-stream')=>{
  const staged=await upload(f,bytes,purpose,mediaType);
  return (await workspace(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;
 };
 const fontProfile=profile.fonts.find(font=>font.id==='NotoSans');assert(fontProfile);
 const original=await put(await readFile('vendor/text/'+fontProfile.file),'font'),license=await put(await readFile('vendor/text/'+fontProfile.licenseFile),'caption','text/plain');
 const font=(await edit(f,{type:'ImportFont',source:original.blob,license:license.blob,origin:'bundled',embeddingReviewed:true})).event.payload.asset.font;
 const document=await doc(f),frame={width:16,height:16},style={primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:8,lineHeightMultiplier:1.2,fill:[40,90,190,0],align:'start',direction:'auto'},textValue='A';
 const token={documentId:document.id,documentRevision:document.revision,layerId:'native_text',layerVersion:'0',sessionId:'treatment_session',generation:1};
 const rendered=await treatmentNativeLayout({text:textValue,style,frame,token},[{path:join(f.root,'objects','sha256',font.bytes.hash.slice(7,9),font.bytes.hash.slice(7)),length:Number(font.bytes.byteLength),hash:font.bytes.hash,origin:font.origin,licenseHash:font.licenseRecord.hash}]);
 const decoded=JSON.parse(rendered.layout);assert(decoded.paragraphs.some(paragraph=>paragraph.runs.some(run=>run.glyphs.length>0)),'fixture must contain genuinely shaped native text');
 const textUtf8=(await put(Buffer.from(textValue),'caption','text/plain')).blob,layout={...(await put(Buffer.from(rendered.layout))).blob,mediaType:'application/json'},pixels={...(await put(Buffer.alloc(frame.width*frame.height*4))).blob,mediaType:'application/x-ideogram-rgba8'};
 assert.equal(rendered.rasterHash,pixels.hash);assert.equal(rendered.layoutHash,layout.hash);assert.equal(rendered.textHash,textUtf8.hash);
 const manifest={...(await put(profileBytes)).blob,mediaType:'application/json'},text=identify({schemaVersion:1,textUtf8,style,frame,layoutPolicy:'text-layout-1',fonts:[font]});
 const dependencyHash=hash(JSON.stringify({rendererProfile:profile.id,textHash:textUtf8.hash,style,frame,fonts:[{hash:font.bytes.hash,licenseHash:font.licenseRecord.hash,faceIndex:0,format:font.format,parserProfile:font.parserProfile,fsType:font.fsType}]}));
 const render=identify({schemaVersion:1,textVersion:text.id,rendererProfile:{schemaVersion:1,id:profile.id,manifest},dependencyHash,layout,pixels,width:rendered.width,height:rendered.height,overflow:rendered.overflow,resolvedFonts:[font.id]});
 const candidate={...(await put(Buffer.from(canonical({schemaVersion:1,token,source:{schemaVersion:1,text,render}})))).blob,mediaType:'application/json'};
 const draft=await put(Buffer.from(canonical({schemaVersion:1,kind:'text-draft-1',textUtf8,style,frame,fonts:[font]})),'caption','text/plain');
 const saved=await ui(f,{type:'SaveDraft',draft:{id:'native',generation:'1',kind:'text',documentId:document.id,targetLayerId:null,expectedDocumentRevision:document.revision,assetId:draft.id,composing:false}});assert.equal(saved.result.json.status,'accepted',saved.result.text);
 const budget=verificationBudget(textValue,frame.width,frame.height,Number(font.bytes.byteLength),profile.engine.wasm.bytes),admissionId=randomUUID()+'_1_'+budget.bytes;
 const admitted=await f.post('/api/v1/text-admission/'+admissionId,{protocolVersion:1});assert.equal(admitted.status,200,admitted.text);
 try{
  const command=f.command({sessionId:'treatment_session',documentId:document.id,expectedDocumentRevision:document.revision,body:{type:'CreateTextLayer',layerId:token.layerId,name:'Authored native lettering',candidate,draft:{sessionId:'treatment_session',draftId:'native',generation:'1'},admissionId}});
  const created=await terminal(f,command);assert.equal(created.json.receipt.status,'accepted',created.text);
 }finally{const released=await f.post('/api/v1/text-admission/'+admissionId+'/release',{protocolVersion:1});assert.equal(released.status,200,released.text);}
 const layer=(await f.read('/api/v1/documents/'+document.id+'/image')).json.layers.find(layer=>layer.id===token.layerId);assert.equal(layer.kind,'text');
 return {layer,text,render,textValue};
}
async function treatmentBaseline(f){
 const before=await doc(f),capture=(await edit(f,{type:'PrepareRequestSource',scope:'visible-document',layerIds:[]})).event.payload.asset;
 assert.deepEqual(await doc(f),before);
 return {assetId:capture.id,version:capture.version,blob:capture.blob,pixels:capture.raster.pixels,width:before.width,height:before.height,scope:'visible-document',documentRevision:before.revision,capture:capture.raster.manifest};
}

test('real native layer and reviewed Composition prose survive treatment Prepare/Accept, then refuse a stale native source',async t=>{
 const f=await setup(t),created=await terminal(f,f.command({},{width:16,height:16}));assert.equal(created.json.receipt.status,'accepted',created.text);
 const background=(await importRaster(f,'black.png')).asset;await edit(f,{type:'ImportAsset',assetId:background.id,layerId:'background',name:'Opaque contribution',draft:null});
 const native=await treatmentNative(f),beforeComposition=await doc(f),response=await f.read('/api/v1/documents/'+beforeComposition.id+'/composition?revision='+beforeComposition.revision);assert.equal(response.status,200,response.text);
 const layers=response.json.layers,linked=layers.find(layer=>layer.id===native.layer.id);assert.equal(linked.text,native.textValue);
 const c=emptyComposition(16,16,randomUUID()),element=emptyElement('text','native_semantics'),bindings={[linked.id]:linked.id};
 element.text=linkField('text-content',linked);element.bounds=linkField('frame-bounds',linked);element.desc.value='Exact reviewed native A';c.elements=[element];
 const projection=serialize(c,layers,bindings),caption=(await stage(f,projection.prompt,'text/plain')).ref;
 c.review={serializer:'caption-json-1',sourceId:c.id,frame:structuredClone(c.frame),request:structuredClone(c.request),dependencies:projection.dependencies,boxes:projection.boxes,prompt:caption};
 const composition={id:c.id,value:(await stage(f,c)).ref,bindings};await edit(f,{type:'ApprovePromptProjection',composition,draft:null});
 const exported=exportCompositionText(c,layers,bindings),prose=(await stage(f,exported.prompt,'text/plain')).ref;assert.deepEqual(prose,exported.review.prompt);
 const draft=newV45Draft(prose);draft.prompt={mode:'plain',text:prose,projection:exported.review,composition};const saved=await stage(f,JSON.stringify(draft,null,2));
 const save=async generation=>{const document=await doc(f),result=await ui(f,{type:'SaveDraft',draft:{id:'native_prose',generation,kind:'request',documentId:document.id,targetLayerId:null,expectedDocumentRevision:document.revision,assetId:saved.asset.id,composing:false}});assert.equal(result.result.json.status,'accepted',result.result.text);};
 await save('1');
 const intent={kind:'text-treatment-review-intent-1',choice:{kind:'baked-lettering',allowedHideNativeIds:[native.layer.id],duplicationAcknowledgement:'reviewed_duplicates',excludedSemanticIds:[],approvalId:'native_prose_treatment'},baseline:await treatmentBaseline(f),beforeSource:null};
 const before=await doc(f),beforeImage=(await f.read('/api/v1/documents/'+before.id+'/image')).json;
 const prepared=await ui(f,{type:'PrepareRequestReview',draftId:'native_prose',generation:'1',textTreatment:intent});assert.equal(prepared.result.json.status,'accepted',prepared.result.text);
 const review=prepared.result.json.review,plan=JSON.parse(await objectBytes(f,review.textTreatment.plan));
 assert.equal(review.kind,'request-review-text-1');assert.equal(reviewFamily(review),'v45');assert.equal(plan.prompt.mode,'composition-text');assert.deepEqual(plan.prompt.bytes,prose);assert.deepEqual(JSON.parse(await objectBytes(f,plan.prompt.projection)),exported.review);
 assert.deepEqual(plan.inventory.composition.value,composition.value);assert.deepEqual(plan.inventory.imageState,before.image.state);assert.equal(plan.inventory.documentRevision,before.revision);assert.deepEqual(plan.includedSemanticIds,[element.id]);
 const retained=plan.inventory.layers.find(layer=>layer.id===native.layer.id);assert(retained.contribution);assert.deepEqual(retained.native,{source:native.layer.source,literal:native.text.textUtf8,textVersion:native.text.id,renderVersion:native.render.id,dependencyHash:native.render.dependencyHash});
 assert.equal((await objectBytes(f,retained.native.literal)).toString(),native.textValue);assert.deepEqual(plan.inventory.semanticText[0].bindings.map(binding=>binding.reviewedLayerVersion),[native.layer.version,native.layer.version]);
 assert.equal(JSON.parse(await objectBytes(f,review.template)).prompt,exported.prompt);assert.deepEqual(review.request.settings.prompt,draft.prompt);assert.equal(review.request.modelRequest.promptMode,'plain');assert.equal(review.providerReview.admission.state,'blocked');assert.equal(review.dispatch,false);
 const accepted=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});assert.equal(accepted.result.json.status,'accepted',accepted.result.text);assert.equal(accepted.result.json.acceptedReview,review.id);
 assert.deepEqual(await doc(f),before);assert.deepEqual((await f.read('/api/v1/documents/'+before.id+'/image')).json,beforeImage);assert.deepEqual(await objectBytes(f,saved.ref),saved.bytes);
 await validateTextTreatmentObservation(review.textTreatment,r=>objectBytes(f,r));

 // A real native-layer edit keeps the same frozen prose/Composition source.
 // Resave and recapture at the NEW revision so an older revision or capture
 // cannot mask the intended current Composition-source refusal.
 await edit(f,{type:'ApplyTransform',layerId:native.layer.id,layerVersion:native.layer.version,transform:[1,0,0,1,1,0],draft:null});
 const changed=await doc(f),changedImage=(await f.read('/api/v1/documents/'+changed.id+'/image')).json;
 const staleAcceptance=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});assert.equal(staleAcceptance.result.json.status,'rejected',staleAcceptance.result.text);assert.match(staleAcceptance.result.json.reason,/STALE_REVISION/);
 await save('2');const freshIntent={...intent,baseline:await treatmentBaseline(f)},uiBefore=(await f.read('/api/v1/ui/treatment_session')).json;
 const rejected=await ui(f,{type:'PrepareRequestReview',draftId:'native_prose',generation:'2',textTreatment:freshIntent});assert.equal(rejected.result.json.status,'rejected',rejected.result.text);assert.match(rejected.result.json.reason,/COMPOSITION_TEXT_CHANGED/);assert.equal(rejected.result.json.review,undefined);
 const uiAfter=(await f.read('/api/v1/ui/treatment_session')).json;assert.deepEqual(uiAfter,uiBefore,'refused preparation cannot advance the saved UI state');
 assert.deepEqual(await doc(f),changed);assert.deepEqual((await f.read('/api/v1/documents/'+changed.id+'/image')).json,changedImage);assert.deepEqual(await objectBytes(f,saved.ref),saved.bytes);
 const path='/api/v1/ui/treatment_session/request?draftId=native_prose&generation=2';assert.deepEqual((await f.read(path)).json.value,draft);assert.equal((await f.read(path+'&content=1')).text,exported.prompt);assert.deepEqual(await objectBytes(f,composition.value),Buffer.from(canonical(c)));
});


// Real local immutable objects exercise the small JSON owner separately from
// native rendering. All pre-existing public writer/treatment workflows remain.
import {mkdir as ownedTextMkdir,writeFile as ownedTextWrite,unlink as ownedTextUnlink} from 'node:fs/promises';
import {Objects as OwnedTextObjects} from '../../dist/local/server/storage/objects.js';
import {TextTreatments as OwnedTextTreatments} from '../../dist/local/server/storage/text-treatment.js';
import {adapterResources as ownedTextResources} from '../../dist/local/server/observability/adapter-resources.js';
import {rootFor as ownedTextRoot,refFor as ownedTextRef} from '../store/helpers.mjs';
const ownedTextSnapshot=()=>{const s=ownedTextResources.snapshot();return {backingBytes:s.backingBytes,reservedBytes:s.reservedBytes,activeLeases:s.activeLeases,returnedBuffers:s.returnedBuffers,unscopedReturnedBuffers:s.unscopedReturnedBuffers,droppedTransitions:s.droppedTransitions};};
async function ownedTextFixture(t){
 const root=await ownedTextRoot(t),objects=new OwnedTextObjects(root,()=>{},()=>{});t.after(()=>objects.close());
 const treatments=new OwnedTextTreatments(objects,{},()=>assert.fail('JSON/reference-only control cannot resolve live document state'),{}),rows=[];
 for(const method of ['verifyOwned','verify','readRange']){const original=objects[method];t.mock.method(objects,method,function(...args){const result=Reflect.apply(original,this,args);const row={method,bytes:Number(args[0].byteLength),releases:0};rows.push(row);if(method!=='verifyOwned')return result;return {bytes:result.bytes,release(){row.releases++;result.release();}};});}
 return {root,objects,treatments,rows,async put(bytes){const ref=ownedTextRef(bytes),path=objects.path(ref);await ownedTextMkdir(join(root,'objects','sha256',ref.hash.slice(7,9)),{recursive:true,mode:0o700});await ownedTextWrite(path,bytes,{mode:0o600});return {ref,path};}};
}

test('small treatment JSON uses a fresh verified owner and releases it before returning each parsed graph',async t=>{
 const f=await ownedTextFixture(t),bytes=Buffer.from('{"nested":{"value":1}}'),{ref,path}=await f.put(bytes),before=ownedTextSnapshot();
 const one=f.treatments.json(ref);assert.deepEqual(one,{nested:{value:1}});assert.deepEqual(ownedTextSnapshot(),before);one.nested.value=99;
 const two=f.treatments.json(ref);assert.deepEqual(two,{nested:{value:1}});assert.notEqual(two,one);assert.notEqual(two.nested,one.nested);assert.equal(f.rows.filter(row=>row.method==='verifyOwned').length,2);assert(f.rows.every(row=>row.method==='verifyOwned'&&row.releases===1));
 await ownedTextWrite(path,Buffer.from('{"nested":{"value":2}}'),{mode:0o600});assert.throws(()=>f.treatments.json(ref),{code:'CORRUPT_OBJECT'});assert.deepEqual(ownedTextSnapshot(),before);
 await ownedTextWrite(path,bytes,{mode:0o600});assert.deepEqual(f.treatments.json(ref),{nested:{value:1}});assert.deepEqual(ownedTextSnapshot(),before);
});

for(const [name,bytes]of [['syntax',Buffer.from('{')],['duplicate',Buffer.from('{"a":1,"a":2}')],['invalid-utf8',Buffer.from([0xff])]])test('small treatment JSON '+name+' refusal releases actual verified backing',async t=>{
 const f=await ownedTextFixture(t),{ref}=await f.put(bytes),before=ownedTextSnapshot();assert.throws(()=>f.treatments.json(ref),{code:'MALFORMED_REQUEST'});assert.deepEqual(f.rows.map(row=>[row.method,row.releases]),[['verifyOwned',1]]);assert.deepEqual(ownedTextSnapshot(),before);
});

for(const name of ['max','rss'])test('treatment '+name+' admission still refuses before opening a small verified owner',async t=>{
 const f=await ownedTextFixture(t),{ref}=await f.put(Buffer.from('{"ok":true}')),before=ownedTextSnapshot();
 if(name==='rss')t.mock.method(process.memoryUsage,'rss',()=>536870912);
 assert.throws(()=>f.treatments.json(ref,name==='max'?Number(ref.byteLength)-1:65536),error=>error.issues?.[0]?.code===(name==='max'?'TEXT_TREATMENT_LIMIT':'TEXT_TREATMENT_CAPACITY'));
 assert.deepEqual(f.rows,[]);assert.deepEqual(ownedTextSnapshot(),before);
});

for(const size of [65536,65537])test('treatment JSON '+size+' byte boundary preserves the existing larger fallback and scope lifetime',async t=>{
 const f=await ownedTextFixture(t),value={value:'x'.repeat(size-Buffer.byteLength(canonical({value:''})))},bytes=Buffer.from(canonical(value));assert.equal(bytes.length,size);const {ref}=await f.put(bytes),before=ownedTextSnapshot();
 await ownedTextResources.scope('treatment-size-control',async()=>{
  const inside=ownedTextSnapshot();assert.deepEqual(f.treatments.json(ref,524288),value);
  if(size===65536){assert.deepEqual(f.rows.map(row=>[row.method,row.releases]),[['verifyOwned',1]]);assert.deepEqual(ownedTextSnapshot(),inside);}
  else{assert.deepEqual(f.rows.map(row=>row.method),['verify','readRange']);assert(ownedTextSnapshot().activeLeases>inside.activeLeases,'Original large readRange result remains retained until the producer scope ends');}
  await Promise.resolve();
 });assert.deepEqual(ownedTextSnapshot(),before);
});

test('ordinary treatment byte reads keep their prior verify and ranged-read path',async t=>{
 const f=await ownedTextFixture(t),bytes=Buffer.from('literal text remains opaque'),{ref}=await f.put(bytes),before=ownedTextSnapshot();
 await ownedTextResources.scope('treatment-literal-control',async()=>{assert.deepEqual(Buffer.from(f.treatments.read(ref)),bytes);assert.deepEqual(f.rows.map(row=>row.method),['verify','readRange']);});assert.deepEqual(ownedTextSnapshot(),before);
});

test('public treatment reference walks use genuine fresh metadata owners and refuse later missing metadata',async t=>{
 const source=fixture(),f=await ownedTextFixture(t);for(const bytes of source.objects.values())await f.put(bytes);
 const before=ownedTextSnapshot(),roles=f.treatments.refsWithRoles(source.envelope),strict=f.treatments.refs(source.envelope);
 assert.deepEqual(roles.map(row=>row.ref),strict);for(const ref of [source.envelope.plan,source.nativeRef,source.input.inventory.imageState,source.input.inventory.composition.value,source.input.edit.requestPlan])assert(strict.some(value=>canonical(value)===canonical(ref)),canonical(ref));
 assert(f.rows.some(row=>row.method==='verifyOwned'));assert(f.rows.filter(row=>row.method==='verifyOwned').every(row=>row.releases===1));assert.deepEqual(ownedTextSnapshot(),before);
 await ownedTextUnlink(f.objects.path(source.nativeRef));assert.throws(()=>f.treatments.refsWithRoles(source.envelope),{code:'MISSING_OBJECT'});assert.deepEqual(ownedTextSnapshot(),before,'Successful earlier parses never supply stale authority for a missing object');
});


// Controlled samples exercise the unchanged admission formula, not physical RSS.
// The process API replacement exists only for these synchronous calls and restores
// the exact original descriptor before any async test teardown can run.
function withTreatmentRSSMethods({rss,full=()=>assert.fail('Small JSON admission must not collect the full memory report')},run){
 const descriptor=Object.getOwnPropertyDescriptor(process,'memoryUsage'),original=descriptor.value,rssDescriptor=Object.getOwnPropertyDescriptor(original,'rss');
 const replacement=function(...args){return Reflect.apply(full,this,args);};Object.defineProperty(replacement,'rss',{...rssDescriptor,value:function(...args){return Reflect.apply(rss,this,args);}});
 Object.defineProperty(process,'memoryUsage',{...descriptor,value:replacement});try{return run();}finally{Object.defineProperty(process,'memoryUsage',descriptor);assert.deepEqual(Object.getOwnPropertyDescriptor(process,'memoryUsage'),descriptor);assert.deepEqual(Object.getOwnPropertyDescriptor(original,'rss'),rssDescriptor);}
}

test('small treatment JSON resamples dedicated RSS at the exact ceiling and refuses the next byte before IO',async t=>{
 const f=await ownedTextFixture(t),bytes=Buffer.from('{"fresh":true}'),{ref}=await f.put(bytes),before=ownedTextSnapshot(),limit=536870912-bytes.length*6-16777216,events=[];let rss=limit,samples=0;
 const original=f.objects.verifyOwned;t.mock.method(f.objects,'verifyOwned',function(...args){events.push('read');const owner=Reflect.apply(original,this,args);return {bytes:owner.bytes,release(){events.push('release');owner.release();}};});
 withTreatmentRSSMethods({rss(){samples++;events.push('rss');return rss;}},()=>{
  assert.deepEqual(f.treatments.json(ref),{fresh:true});assert.deepEqual(events,['rss','read','release']);assert.deepEqual(ownedTextSnapshot(),before);
  rss=limit+1;events.length=0;assert.throws(()=>f.treatments.json(ref),error=>error.issues?.[0]?.code==='TEXT_TREATMENT_CAPACITY');assert.deepEqual(events,['rss']);assert.equal(f.rows.length,1);assert.deepEqual(ownedTextSnapshot(),before);
  rss=limit;events.length=0;assert.deepEqual(f.treatments.json(ref),{fresh:true});assert.deepEqual(events,['rss','read','release']);assert.equal(samples,3);assert.equal(f.rows.length,2);assert(f.rows.every(row=>row.releases===1));assert.deepEqual(ownedTextSnapshot(),before);
 });
});

test('small treatment maximum refusal precedes both memory sampling APIs and verified reads',async t=>{
 const f=await ownedTextFixture(t),{ref}=await f.put(Buffer.from('{"ok":true}')),before=ownedTextSnapshot();
 withTreatmentRSSMethods({rss:()=>assert.fail('RSS sampled before maximum refusal'),full:()=>assert.fail('Full memory sampled before maximum refusal')},()=>{
  assert.throws(()=>f.treatments.json(ref,Number(ref.byteLength)-1),error=>error.issues?.[0]?.code==='TEXT_TREATMENT_LIMIT');assert.deepEqual(f.rows,[]);assert.deepEqual(ownedTextSnapshot(),before);
 });
});

test('dedicated treatment RSS failure preserves its identity and acquires no byte owner',async t=>{
 const f=await ownedTextFixture(t),{ref}=await f.put(Buffer.from('{"ok":true}')),before=ownedTextSnapshot(),failure=Error('RSS sample failed');let samples=0;
 withTreatmentRSSMethods({rss(){samples++;throw failure;}},()=>{assert.throws(()=>f.treatments.json(ref),error=>error===failure);assert.equal(samples,1);assert.deepEqual(f.rows,[]);assert.deepEqual(ownedTextSnapshot(),before);});
});

test('small treatment parse failure still releases verified bytes after the admitted RSS sample',async t=>{
 const f=await ownedTextFixture(t),{ref}=await f.put(Buffer.from('{')),before=ownedTextSnapshot();let samples=0;
 withTreatmentRSSMethods({rss(){samples++;return 0;}},()=>{assert.throws(()=>f.treatments.json(ref),{code:'MALFORMED_REQUEST'});assert.equal(samples,1);assert.deepEqual(f.rows.map(row=>[row.method,row.releases]),[['verifyOwned',1]]);assert.deepEqual(ownedTextSnapshot(),before);});
});

for(const kind of ['binary','large-json'])test('treatment '+kind+' fallback keeps fresh full-report RSS admission and its original scope ownership',async t=>{
 const f=await ownedTextFixture(t),value={value:'x'.repeat(65537-Buffer.byteLength(canonical({value:''})))},bytes=kind==='binary'?Buffer.from('literal bytes'):Buffer.from(canonical(value)),{ref}=await f.put(bytes),before=ownedTextSnapshot(),limit=536870912-bytes.length*6-16777216;let rss=limit,samples=0;
 await ownedTextResources.scope('rss-fallback-control',()=>{
  const inside=ownedTextSnapshot();withTreatmentRSSMethods({rss:()=>assert.fail('Original fallback must keep the full-report route'),full(){samples++;return {rss};}},()=>{
   const read=()=>kind==='binary'?f.treatments.read(ref):f.treatments.json(ref,524288),first=read();assert.deepEqual(kind==='binary'?Buffer.from(first):first,kind==='binary'?bytes:value);assert.deepEqual(f.rows.map(row=>row.method),['verify','readRange']);assert(ownedTextSnapshot().activeLeases>inside.activeLeases);
   const held=ownedTextSnapshot();rss=limit+1;assert.throws(read,error=>error.issues?.[0]?.code==='TEXT_TREATMENT_CAPACITY');assert.deepEqual(f.rows.map(row=>row.method),['verify','readRange']);assert.deepEqual(ownedTextSnapshot(),held);
   rss=limit;const next=read();assert.deepEqual(kind==='binary'?Buffer.from(next):next,kind==='binary'?bytes:value);assert.equal(samples,3);assert.deepEqual(f.rows.map(row=>row.method),['verify','readRange','verify','readRange']);
  });
 });assert.deepEqual(ownedTextSnapshot(),before);
});
