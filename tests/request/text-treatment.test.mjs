import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {newDraft,resolve,bodyTemplate} from '../../dist/local/src/request/core.js';
import {createRequestRasterPlan,createActualOutputMapping,clipRequestCoverage,inspectRequestCoverage} from '../../dist/local/src/request/raster-plan.js';
import {
 planTextTreatment,validateTextTreatmentInventory,validateTextTreatmentPlan,
 textTreatmentSourceSelection,textTreatmentPlacementEligibility,assertTextTreatmentFresh,
 textTreatmentProvenance,textTreatmentRefs,textTreatmentPlanRef,bindTextTreatmentEnvelope,
 assertTextTreatmentEnvelope,planTextTreatmentAdoption,validateTextTreatmentAdoptionDecision,planTextTreatmentPlacement,
 createTextTreatmentMaskSuccessor,planTextTreatmentSuccessorPlacement,planTextTreatmentSuccessorAdoption,validateTextTreatmentSuccessorAdoptionDecision,
} from '../../dist/local/src/request/text-treatment.js';

const hash=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
const ref=(s,mediaType='text/plain')=>({hash:hash(s),byteLength:String(Buffer.byteLength(s)),mediaType});
const json=value=>ref(canonical(value),'application/json');
const pixels=(label,width=2,height=2)=>({hash:hash(label),byteLength:String(width*height*4),mediaType:'application/x-ideogram-rgba8'});
const mask={hash:hash('effective-mask'),byteLength:'8',mediaType:'application/x-ideogram-r16le'};
function layer(id,kind='image'){
 const literal=ref('Café\n東京','text/plain;charset=utf-8');
 return {id,version:'7',kind,visible:true,locked:false,stateHash:hash(id+'-complete-layer-state'),contribution:{manifest:json({contribution:id}),pixels:pixels(id),pixelIdentity:hash(id+'-cp1')},native:kind==='text'?{source:json({completeTextSource:id}),literal,textVersion:hash(id+'text-version'),renderVersion:hash(id+'render-version'),dependencyHash:hash(id+'font-style-layout-profile')}:null};
}
function inventory(){
 const background=layer('background'),label=layer('label','text');
 const linked={id:'linked',literal:structuredClone(label.native.literal),description:ref('Lettering over the subject'),bounds:json({box:[0,0,1,1]}),bindings:[{field:'text',bindingLayerId:'authored-label',layerId:'label',reviewedLayerVersion:'7',reviewedValue:structuredClone(label.native.literal)}]};
 const unlinked={id:'unlinked',literal:ref('Still sent unlinked'),description:ref('Small lettering'),bounds:null,bindings:[]};
 return {schemaVersion:1,kind:'text-treatment-inventory-1',documentId:'doc',documentRevision:'11',grid:{width:2,height:2},imageState:json({completeImageState:'state-11'}),layers:[background,label],composition:{id:'composition-4',value:json({completeComposition:4}),bindingsHash:hash('complete-bindings'),frameHash:hash('request-frame')},semanticText:[linked,unlinked]};
}
function source(inv,ids,scope=ids.length===1?'single-layer':'selected-layers'){
 const capture={schemaVersion:1,documentId:inv.documentId,documentRevision:inv.documentRevision,image:{state:structuredClone(inv.imageState),semanticDigest:hash('state-digest'),compositeAssetId:'original-composite'},scope,layerIds:[...ids]};
 return {source:{capture:json({plan:{kind:'request-source-capture-v1',capture}}),assetId:'capture-'+ids.join('-'),version:'2',blob:ref('encoded-'+ids.join('-'),'image/png'),pixels:ids.length===1?structuredClone(inv.layers.find(l=>l.id===ids[0]).contribution.pixels):pixels('composite-'+ids.join('-')),width:2,height:2,scope,documentRevision:inv.documentRevision},capture};
}
function input(kind='native-overlay'){
 const inv=inventory(),before=source(inv,['background','label'],'visible-document');
 return {id:'plan-1',inventory:inv,choice:kind==='native-overlay'?{kind,retainedNativeIds:['label'],placement:'current-document',excludedSemanticIds:['linked'],approvalId:'review-treatment'}:kind==='baked-lettering'?{kind,allowedHideNativeIds:['label'],duplicationAcknowledgement:'ack-baked',excludedSemanticIds:[],approvalId:'review-treatment'}:{kind,excludedSemanticIds:[],approvalId:'review-treatment'},beforeSource:kind==='no-native-text'?source(inv,['background']):before,afterSource:kind==='native-overlay'||kind==='no-native-text'?source(inv,['background']):structuredClone(before),prompt:{mode:'composition',bytes:ref('{"actual":"reviewed caption"}'),projection:json({projection:'exact'})},edit:{effectiveMask:structuredClone(mask),requestPlan:json({requestPlan:'exact-mask-frame'})}};
}
const plan=(kind)=>planTextTreatment(input(kind));
function candidate(p,preparation='safe-region'){
 return {candidateId:'candidate',assetId:'prepared-raster',pixels:pixels('prepared-q'),grid:{width:2,height:2},preparation,preparationIdentity:json({immutablePreparation:preparation}),sourcePixels:preparation==='safe-region'?structuredClone(p.afterSource.source.pixels):null,effectiveMask:preparation==='safe-region'?structuredClone(mask):null};
}
function adoption(action='keep-native-overlay',preservation='single-original-contribution'){
 return {kind:'text-treatment-adoption-choice-1',action,approvalId:'review-adoption',duplicationAcknowledgement:null,newLayerId:'candidate-layer',hideNativeIds:[],nativeCopies:[],preservation};
}
function placementCandidate(p,preparation='safe-region'){
 return {candidateId:'candidate',grid:{width:2,height:2},preparation,sourcePixels:preparation==='safe-region'?structuredClone(p.afterSource.source.pixels):null,effectiveMask:preparation==='safe-region'?structuredClone(mask):null};
}
function placementGraph({kind,candidate,fingerprint,requestedPreservation,...graph}){return requestedPreservation===undefined?graph:{...graph,preservedExterior:requestedPreservation};}

test('overlay records exact alternate source, retained native versions, excluded semantic and unlinked sent lettering',()=>{
 const i=input(),before=structuredClone(i),p=planTextTreatment(i),provenance=textTreatmentProvenance(p);
 assert.deepEqual(i,before);assert.deepEqual(p.sourceSubset.includedLayerIds,['background']);assert.deepEqual(p.rasterExcludedNativeIds,['label']);assert.deepEqual(p.rasterIncludedNativeIds,[]);
 assert.deepEqual(provenance.retainedNative[0],{layerId:'label',layerVersion:'7',...i.inventory.layers[1].native});
 assert.deepEqual(provenance.includedSemantic,[i.inventory.semanticText[1]]);assert.deepEqual(provenance.excludedSemantic,[i.inventory.semanticText[0]]);assert.deepEqual(provenance.unlinkedIncludedSemanticIds,['unlinked']);
 assert.equal(provenance.limitations.metadataExclusionRemovesPixels,false);assert.equal(provenance.limitations.generatedLetteringGuaranteed,false);assert.equal(provenance.limitations.spellingGuaranteed,false);validateTextTreatmentPlan(p);
});
test('semantic exclusion alone leaves source pixels and raster-native contribution present',()=>{
 const i=input('baked-lettering');i.choice.excludedSemanticIds=['linked'];const p=planTextTreatment(i);
 assert.deepEqual(p.beforeSource,p.afterSource);assert.deepEqual(p.rasterIncludedNativeIds,['label']);assert.deepEqual(p.rasterExcludedNativeIds,[]);assert.deepEqual(p.includedSemanticIds,['unlinked']);
 assert.equal(textTreatmentProvenance(p).limitations.metadataExclusionRemovesPixels,false);
});
test('excluded native contribution does not implicitly exclude its linked semantic literal',()=>{
 const i=input();i.choice.excludedSemanticIds=[];const p=planTextTreatment(i);assert.deepEqual(p.includedSemanticIds,['linked','unlinked']);assert.deepEqual(p.rasterIncludedNativeIds,[]);assert.deepEqual(p.rasterExcludedNativeIds,['label']);
});
test('no-native-text still records semantic lettering independently',()=>{
 const p=plan('no-native-text');assert.deepEqual(p.rasterIncludedNativeIds,[]);assert.deepEqual(p.includedSemanticIds,['linked','unlinked']);assert.equal(p.placement.kind,'adoption-review-required');
 const i=input('no-native-text');i.beforeSource=source(i.inventory,['background','label']);i.afterSource=structuredClone(i.beforeSource);assert.throws(()=>planTextTreatment(i),/NATIVE_INPUT_PRESENT/);
});
for(const mode of ['plain','raw'])test(mode+' prompt cannot claim that app semantic elements were projected',()=>{
 const i=input('baked-lettering');i.prompt={mode,bytes:ref('unclassified words'),projection:null};assert.throws(()=>planTextTreatment(i),/SEMANTIC_PROJECTION_REQUIRED/);
 i.choice.excludedSemanticIds=['linked','unlinked'];const p=planTextTreatment(i);assert.equal(textTreatmentProvenance(p).limitations.opaquePromptMayDescribeText,true);assert.deepEqual(p.excludedSemanticIds,['linked','unlinked']);
});
test('reviewed Composition prose has a distinct treatment mode and preserves semantic partitions without provider guarantees',()=>{
 const i=input(),before=structuredClone(i);i.prompt={mode:'composition-text',bytes:ref('Image description.\nRequested visible text: "Still sent unlinked"'),projection:json({serializer:'composition-text-1',refOnlyFixture:true})};
 const original=structuredClone(i),p=planTextTreatment(i),provenance=textTreatmentProvenance(p);validateTextTreatmentPlan(p);
 assert.equal(p.prompt.mode,'composition-text');assert.deepEqual(p.includedSemanticIds,['unlinked']);assert.deepEqual(p.excludedSemanticIds,['linked']);assert.deepEqual(i,original);
 assert.deepEqual(provenance.includedSemantic,[before.inventory.semanticText[1]]);assert.deepEqual(provenance.excludedSemantic,[before.inventory.semanticText[0]]);
 assert.equal(provenance.limitations.opaquePromptMayDescribeText,false);assert.equal(provenance.limitations.generatedLetteringGuaranteed,false);assert.equal(provenance.limitations.spellingGuaranteed,false);
 const refs=textTreatmentRefs(p);assert(refs.some(r=>canonical(r)===canonical(i.prompt.projection)));assert(refs.some(r=>canonical(r)===canonical(i.inventory.composition.value)));
 const caption=planTextTreatment(before);assert.notEqual(caption.fingerprint,p.fingerprint);assert.equal(caption.prompt.mode,'composition');
});
for(const mutate of [i=>i.prompt.projection=null,i=>i.prompt.projection=ref('not JSON'),i=>i.prompt.projection.byteLength='524289',i=>i.prompt.mode='provider-composition-text',i=>{i.inventory.composition=null;i.inventory.semanticText=[];i.choice.excludedSemanticIds=[];}])test('Composition prose treatment refuses missing or invalid review/origin structure',()=>{
 const i=input();i.prompt.mode='composition-text';mutate(i);const original=structuredClone(i);assert.throws(()=>planTextTreatment(i));assert.deepEqual(i,original);
});
test('Composition prose treatment retains the same stale included-link and explicit exclusion safeguards',()=>{
 const i=input('baked-lettering');i.prompt.mode='composition-text';i.inventory.semanticText[0].bindings[0].reviewedLayerVersion='6';assert.throws(()=>planTextTreatment(i),/SEMANTIC_LINK_STALE/);
 i.choice.excludedSemanticIds=['linked'];const p=planTextTreatment(i);assert.equal(textTreatmentProvenance(p).excludedSemantic[0].bindings[0].reviewedLayerVersion,'6');
});
test('stale included semantic binding rejects; excluded value remains retained provenance',()=>{
 const i=input('baked-lettering');i.inventory.semanticText[0].bindings[0].reviewedLayerVersion='6';assert.throws(()=>planTextTreatment(i),/SEMANTIC_LINK_STALE/);
 i.choice.excludedSemanticIds=['linked'];const p=planTextTreatment(i);assert.equal(textTreatmentProvenance(p).excludedSemantic[0].bindings[0].reviewedLayerVersion,'6');
});
test('unresolved included link cannot become a literal through name matching',()=>{
 const i=input('baked-lettering');i.inventory.semanticText[0].bindings[0].layerId='deleted-label';assert.throws(()=>planTextTreatment(i),/SEMANTIC_LINK_STALE/);
});
test('alternate selection omits only explicit native overlays and never mutates pixels',()=>{
 const i=input(),before=structuredClone(i);assert.deepEqual(textTreatmentSourceSelection(i.inventory,i.beforeSource,i.choice),{includedLayerIds:['background'],excludedNativeIds:['label']});assert.deepEqual(i,before);
 i.afterSource=structuredClone(i.beforeSource);assert.throws(()=>planTextTreatment(i),/SOURCE_SUBSET/);
});
test('a single snapshot cannot masquerade as a different original canonical contribution',()=>{
 const i=input();i.afterSource.source.pixels=pixels('same-grid-wrong-original');assert.throws(()=>planTextTreatment(i),/ORIGINAL_CONTRIBUTION_REQUIRED/);
});
test('no exclusion cannot silently rebind or replace the selected source',()=>{
 const i=input('baked-lettering');i.afterSource.source.version='3';assert.throws(()=>planTextTreatment(i),/UNREVIEWED_SOURCE_CHANGE/);
});
test('source capture order, actual scope, document identity and exact image state are frozen',()=>{
 for(const mutate of [i=>i.afterSource.capture.layerIds.reverse(),i=>i.afterSource.capture.documentId='another',i=>i.afterSource.capture.image.state=json({different:true}),i=>i.afterSource.source.documentRevision='12']){
  const i=input('baked-lettering');mutate(i);assert.throws(()=>planTextTreatment(i));
 }
});
test('F04 multi-layer background cannot be collapsed beneath retained text in current document',()=>{
 const i=input();i.inventory.layers.unshift(layer('lower-background'));
 i.beforeSource=source(i.inventory,['lower-background','background','label'],'visible-document');i.afterSource=source(i.inventory,['lower-background','background']);
 assert.deepEqual(textTreatmentPlacementEligibility(i.inventory,i.afterSource,['label'],'current-document'),{eligible:true,kind:'new-document',reason:'multiple-original-contributions'});
 assert.throws(()=>planTextTreatment(i),/NEW_DOCUMENT_REQUIRED/);i.choice.placement='new-document';assert.equal(planTextTreatment(i).placement.kind,'new-document');
});
test('one-item selected-layers composite is not the single-layer original identity contract',()=>{
 const i=input();i.afterSource=source(i.inventory,['background'],'selected-layers');assert.throws(()=>planTextTreatment(i),/NEW_DOCUMENT_REQUIRED/);
});
test('generation with retained native copies requires explicit new-document choice',()=>{
 const i=input();i.beforeSource=null;i.afterSource=null;i.edit=null;assert.throws(()=>planTextTreatment(i),/NEW_DOCUMENT_REQUIRED/);
 i.choice.placement='new-document';const p=planTextTreatment(i);assert.equal(p.afterSource,null);assert.deepEqual(p.retainedNativeIds,['label']);
});
for(const property of ['visible','locked'])test('initial '+property+' safeguard rejects affected native targets',()=>{
 const i=input();i.inventory.layers[1][property]=property==='locked';assert.throws(()=>planTextTreatment(i),/NATIVE_HIDDEN_OR_LOCKED/);
});
test('locked source target cannot inherit single-slot adoption eligibility',()=>{
 const i=input();i.inventory.layers[0].locked=true;assert.throws(()=>planTextTreatment(i),/NEW_DOCUMENT_REQUIRED/);
});
test('every ordered stack, native, composition and document identity remains a stale fence',()=>{
 const p=plan();
 for(const mutate of [v=>v.documentRevision='12',v=>v.layers.reverse(),v=>v.layers[0].stateHash=hash('transform-opacity-mask-changed'),v=>v.layers[1].visible=false,v=>v.layers[1].locked=true,v=>v.layers[1].version='8',v=>v.layers[1].native.source=json({fontsChanged:true}),v=>v.layers[1].native.literal=ref('new literal'),v=>v.layers[1].native.renderVersion=hash('new render'),v=>v.layers[1].native.dependencyHash=hash('new layout'),v=>v.layers[0].contribution.manifest=json({newK:true}),v=>v.composition.bindingsHash=hash('relinked'),v=>v.composition.frameHash=hash('new frame'),v=>v.semanticText[1].literal=ref('new semantic'),v=>v.imageState=json({newState:true})]){
  const current=structuredClone(p.inventory);mutate(current);assert.throws(()=>assertTextTreatmentFresh(p,current),/TEXT_TREATMENT_/);
 }
 assertTextTreatmentFresh(p,structuredClone(p.inventory));
});
test('unknown fields, partition forgery, reordering and fingerprint forgery never repair a plan',()=>{
 const p=plan();for(const mutate of [v=>v.extra='future',v=>v.includedSemanticIds=[],v=>v.rasterExcludedNativeIds=[],v=>v.retainedNativeIds=[],v=>v.fingerprint=hash('forged')]){const forged=structuredClone(p);mutate(forged);assert.throws(()=>validateTextTreatmentPlan(forged));}
 const i=input();i.inventory.layers[1].native.extra=true;assert.throws(()=>validateTextTreatmentInventory(i.inventory));
});
test('reference-only envelope binds canonical stored plan bytes as well as typed fingerprint',()=>{
 const p=plan(),stored=textTreatmentPlanRef(p),e=bindTextTreatmentEnvelope(p,stored);assertTextTreatmentEnvelope(e,p);assert.equal(e.planHash,p.fingerprint);assert.equal(e.plan.hash,hash(canonical(p)));
 assert.throws(()=>bindTextTreatmentEnvelope(p,{...stored,byteLength:'1'}),/ENVELOPE_BYTES/);assert.throws(()=>assertTextTreatmentEnvelope({...e,planHash:hash('forged')},p),/ENVELOPE_IDENTITY/);
});
test('closure roots retain excluded semantic values and complete native sources for transitive traversal',()=>{
 const p=plan(),roots=textTreatmentRefs(p),has=r=>roots.some(x=>canonical(x)===canonical(r));
 for(const r of [p.inventory.imageState,p.inventory.composition.value,p.inventory.layers[1].native.source,p.inventory.layers[1].native.literal,p.inventory.semanticText[0].description,p.beforeSource.source.capture,p.afterSource.source.capture,p.prompt.bytes,p.prompt.projection,p.edit.effectiveMask,p.edit.requestPlan])assert(has(r));
 assert.equal(new Set(roots.map(canonical)).size,roots.length);
});
test('single-K adoption hides only the original and inserts identity result adjacent at its exact slot',()=>{
 const p=plan(),before=structuredClone(p),decision=planTextTreatmentAdoption(p,p.inventory,candidate(p),adoption());
 assert.deepEqual(decision.hiddenOriginalIds,['background']);assert.deepEqual(decision.beforeOrder,[{id:'background',version:'7',visible:true},{id:'label',version:'7',visible:true}]);
 assert.deepEqual(decision.afterOrder,[{id:'background',version:'8',visible:false},{id:'candidate-layer',version:'1',visible:true},{id:'label',version:'7',visible:true}]);assert.equal(decision.preservedExterior,'single-original-contribution');assert.deepEqual(p,before);validateTextTreatmentAdoptionDecision(decision,p,p.inventory);
});
test('stale native target rejects adoption while the original image target remains unchanged',()=>{
 const p=plan(),current=structuredClone(p.inventory);current.layers[1].native.textVersion=hash('edited-native');assert.throws(()=>planTextTreatmentAdoption(p,current,candidate(p),adoption()),/STALE/);
});
test('safe-region exterior claim requires exact source, mask and grid identities',()=>{
 const p=plan();for(const mutate of [c=>c.sourcePixels=pixels('other'),c=>c.effectiveMask={...mask,hash:hash('other-mask')},c=>{c.grid.width=3;c.pixels=pixels('larger',3,2);},c=>{c.preparation='full-candidate';c.sourcePixels=null;c.effectiveMask=null;}]){const c=candidate(p);mutate(c);assert.throws(()=>planTextTreatmentAdoption(p,p.inventory,c,adoption()),/PRESERVATION_PROOF_REQUIRED/);}
});
test('baked hide is an explicit visibility change without an exterior preservation claim',()=>{
 const p=plan('baked-lettering'),choice={...adoption('hide-native-originals','none'),hideNativeIds:['label']};
 const d=planTextTreatmentAdoption(p,p.inventory,candidate(p,'full-candidate'),choice);assert.deepEqual(d.hiddenOriginalIds,['label']);assert.equal(d.preservedExterior,'none');assert.deepEqual(d.afterOrder,[{id:'background',version:'7',visible:true},{id:'label',version:'8',visible:false},{id:'candidate-layer',version:'1',visible:true}]);
});
test('keep both needs a deliberate adoption acknowledgement and never hides native originals',()=>{
 const p=plan('baked-lettering'),choice=adoption('keep-both','none');assert.throws(()=>planTextTreatmentAdoption(p,p.inventory,candidate(p,'full-candidate'),choice),/DUPLICATION_ACK/);
 choice.duplicationAcknowledgement='accept-duplicates';const d=planTextTreatmentAdoption(p,p.inventory,candidate(p,'full-candidate'),choice);assert.deepEqual(d.hiddenOriginalIds,[]);assert(d.afterOrder.find(l=>l.id==='label').visible);
});
test('full visible root hides every captured original only with explicit native hide approval',()=>{
 const p=plan('baked-lettering'),choice={...adoption('hide-native-originals','full-visible-root'),hideNativeIds:['label']};
 const d=planTextTreatmentAdoption(p,p.inventory,candidate(p),choice);assert.deepEqual(d.hiddenOriginalIds,['background','label']);assert.deepEqual(d.afterOrder.filter(l=>l.visible).map(l=>l.id),['candidate-layer']);assert.equal(d.preservedExterior,'full-visible-root');
 const unreviewed=adoption('keep-native-overlay','full-visible-root');assert.throws(()=>planTextTreatmentAdoption(p,p.inventory,candidate(p),unreviewed),/HIDE_NOT_REVIEWED/);
});
test('retained overlay cannot borrow the full-root preservation route',()=>{
 const p=plan();assert.throws(()=>planTextTreatmentAdoption(p,p.inventory,candidate(p),adoption('keep-native-overlay','full-visible-root')),/NEW_DOCUMENT_REQUIRED/);
});
test('an extra native hide is refused under a single-contribution preservation claim',()=>{
 const i=input('baked-lettering');i.beforeSource=source(i.inventory,['background']);i.afterSource=structuredClone(i.beforeSource);const p=planTextTreatment(i),choice={...adoption('hide-native-originals'),hideNativeIds:['label']};
 assert.throws(()=>planTextTreatmentAdoption(p,p.inventory,candidate(p),choice),/EXTRA_HIDE_BREAKS_PRESERVATION/);
});
test('new document copies use explicit fresh IDs and transforms, preserve original native identity and claim no equality',()=>{
 const p=plan(),choice={...adoption('new-document','none'),nativeCopies:[{sourceLayerId:'label',newLayerId:'copied-label',transform:[1,0,0,1,4,8]}]};
 const d=planTextTreatmentAdoption(p,p.inventory,candidate(p,'full-candidate'),choice);assert.equal(d.sourceDocumentUnchanged,true);assert.deepEqual(d.hiddenOriginalIds,[]);assert.deepEqual(d.afterOrder.map(l=>l.id),['candidate-layer','copied-label']);assert.equal(d.copiedNative[0].textVersion,p.inventory.layers[1].native.textVersion);assert.equal(d.copiedNative[0].sourceStateHash,p.inventory.layers[1].stateHash);assert.deepEqual(d.copiedNative[0].transform,[1,0,0,1,4,8]);
 choice.preservation='single-original-contribution';assert.throws(()=>planTextTreatmentAdoption(p,p.inventory,candidate(p),choice),/NO_EQUALITY_CLAIM/);
});
test('new-document planning still requires the exact frozen inventory and never substitutes changed live native versions',()=>{
 const p=plan(),before=structuredClone(p),choice={...adoption('new-document','none'),nativeCopies:[{sourceLayerId:'label',newLayerId:'copied-label',transform:[1,0,0,1,4,8]}]};
 for(const mutate of [current=>{current.documentRevision='12';},current=>{current.layers[1].native.textVersion=hash('edited-text');},current=>{current.layers[1].locked=true;},current=>{current.layers.splice(1,1);}]){
  const current=structuredClone(p.inventory);mutate(current);assert.throws(()=>planTextTreatmentAdoption(p,current,candidate(p),choice),/TEXT_TREATMENT_STALE/);
 }
 const copied=planTextTreatmentAdoption(p,p.inventory,candidate(p),choice);assert.deepEqual(copied.copiedNative[0],{...choice.nativeCopies[0],sourceStateHash:p.inventory.layers[1].stateHash,...p.inventory.layers[1].native});
 const alone=planTextTreatmentAdoption(p,p.inventory,candidate(p),{...choice,nativeCopies:[]});assert.deepEqual(alone.copiedNative,[]);assert.deepEqual(alone.afterOrder,[{id:choice.newLayerId,version:'1',visible:true}]);assert.deepEqual(p,before);
});
test('adoption decisions cannot replay altered visibility/order/candidate records',()=>{
 const p=plan(),d=planTextTreatmentAdoption(p,p.inventory,candidate(p),adoption());d.afterOrder[2].visible=false;assert.throws(()=>validateTextTreatmentAdoptionDecision(d,p,p.inventory),/ADOPTION_IDENTITY/);
});
test('layer and semantic cardinalities and literal limits are independent and bounded',()=>{
 const inv=inventory();inv.layers=Array.from({length:101},(_,i)=>layer('layer-'+i));assert.throws(()=>validateTextTreatmentInventory(inv),/LAYER_LIMIT/);
 const sem=inventory();sem.semanticText=Array.from({length:257},(_,i)=>({...structuredClone(sem.semanticText[1]),id:'semantic-'+i}));assert.throws(()=>validateTextTreatmentInventory(sem),/SEMANTIC_LIMIT/);
 const text=inventory();text.layers[1].native.literal={...text.layers[1].native.literal,byteLength:'16385'};assert.throws(()=>validateTextTreatmentInventory(text),/TEXT_TREATMENT_REF/);
});
test('legacy draft, resolved request and body remain byte-identical when a separate treatment plan is created',()=>{
 const prompt='Ordinary image request',draft=newDraft(ref(prompt)),request=resolve(draft,prompt),before={draft:canonical(draft),request:canonical(request),wire:bodyTemplate(request,prompt)};
 const p=plan(),envelope=bindTextTreatmentEnvelope(p,textTreatmentPlanRef(p));assert.equal(envelope.kind,'request-text-treatment-1');
 assert.equal(canonical(draft),before.draft);assert.equal(canonical(resolve(draft,prompt)),before.request);assert.equal(bodyTemplate(request,prompt),before.wire);assert.equal(draft.textTreatment,'preserve-native');assert(!before.wire.includes('text-treatment'));
});

test('metadata-only placement plans the reviewed graph without inventing prepared raster proof',()=>{
 const p=plan(),current=structuredClone(p.inventory),descriptor=placementCandidate(p),choice=adoption(),before=structuredClone({p,current,descriptor,choice});
 const intent=planTextTreatmentPlacement(p,current,descriptor,choice),decision=planTextTreatmentAdoption(p,current,candidate(p),choice);
 assert.equal(intent.kind,'text-treatment-placement-intent-1');assert.deepEqual(intent.candidate,descriptor);
 for(const field of ['assetId','pixels','preparationIdentity'])assert.equal(Object.hasOwn(intent.candidate,field),false);
 assert.deepEqual(intent.hiddenOriginalIds,['background']);assert.deepEqual(intent.afterOrder,[{id:'background',version:'8',visible:false},{id:'candidate-layer',version:'1',visible:true},{id:'label',version:'7',visible:true}]);
 assert.equal(intent.requestedPreservation,'single-original-contribution');assert.equal(Object.hasOwn(intent,'preservedExterior'),false);assert.deepEqual(placementGraph(intent),placementGraph(decision));
 const {fingerprint,...body}=intent;assert.equal(fingerprint,hash(canonical(body)));assert.notEqual(intent.fingerprint,decision.fingerprint);
 assert.equal(decision.kind,'text-treatment-adoption-decision-1');validateTextTreatmentAdoptionDecision(decision,p,current);
 assert.throws(()=>planTextTreatmentAdoption(p,current,descriptor,choice),/TEXT_TREATMENT_SHAPE/);
 assert.deepEqual({p,current,descriptor,choice},before);
});
test('placement descriptor refuses proof fields and malformed metadata instead of accepting a partial raster decision',()=>{
 const p=plan(),proof=candidate(p);
 for(const field of ['assetId','pixels','preparationIdentity']){
  const descriptor={...placementCandidate(p),[field]:structuredClone(proof[field])};assert.throws(()=>planTextTreatmentPlacement(p,p.inventory,descriptor,adoption()),/TEXT_TREATMENT_SHAPE/);
 }
 for(const mutate of [c=>{delete c.candidateId;},c=>{c.candidateId='not an id';},c=>{c.grid.width=0;},c=>{c.sourcePixels=null;},c=>{c.effectiveMask=null;},c=>{c.preparation='encoded-rebuild';},c=>{c.preparation='full-candidate';}]){
  const descriptor=placementCandidate(p);mutate(descriptor);assert.throws(()=>planTextTreatmentPlacement(p,p.inventory,descriptor,adoption()),/TEXT_TREATMENT_/);
 }
});
test('strict adoption still rejects absent and invalid raster pixels or preparation identity',()=>{
 const p=plan();
 for(const mutate of [c=>{delete c.assetId;},c=>{delete c.pixels;},c=>{delete c.preparationIdentity;},c=>{c.assetId='';},c=>{c.pixels.hash='missing';},c=>{c.pixels.byteLength='12';},c=>{c.pixels.mediaType='image/png';},c=>{c.preparationIdentity=null;},c=>{c.preparationIdentity=ref('untyped preparation');},c=>{c.preparationIdentity.byteLength='65537';},c=>{c.preparationIdentity.extra=true;}]){
  const prepared=candidate(p);mutate(prepared);assert.throws(()=>planTextTreatmentAdoption(p,p.inventory,prepared,adoption()),/TEXT_TREATMENT_(SHAPE|REF|CANDIDATE)/);
 }
});
test('placement rechecks frozen original and native inventory for both current and new documents',()=>{
 const p=plan(),choices=[adoption(),{...adoption('new-document','none'),nativeCopies:[{sourceLayerId:'label',newLayerId:'copied-label',transform:[1,0,0,1,4,8]}]}];
 for(const choice of choices)for(const mutate of [v=>{v.documentRevision='12';},v=>{v.imageState=json({changedOriginal:true});},v=>{v.layers.reverse();},v=>{v.layers[0].stateHash=hash('changed-original-transform');},v=>{v.layers[0].contribution.pixels=pixels('changed-original-pixels');},v=>{v.layers[1].version='8';},v=>{v.layers[1].visible=false;},v=>{v.layers[1].locked=true;},v=>{v.layers[1].native.source=json({changedFont:true});},v=>{v.layers[1].native.literal=ref('Changed literal');},v=>{v.layers[1].native.textVersion=hash('changed-native-text');},v=>{v.layers[1].native.renderVersion=hash('changed-native-render');},v=>{v.layers[1].native.dependencyHash=hash('changed-native-dependencies');}]){
  const current=structuredClone(p.inventory);mutate(current);assert.throws(()=>planTextTreatmentPlacement(p,current,placementCandidate(p),choice),/TEXT_TREATMENT_STALE/);
 }
});
test('metadata placement cannot claim preserved exterior with a different source, mask, grid or preparation',()=>{
 const p=plan();
 for(const mutate of [c=>{c.sourcePixels=pixels('unreviewed-source');},c=>{c.effectiveMask={...mask,hash:hash('unreviewed-mask')};},c=>{c.grid.width=3;},c=>{c.preparation='full-candidate';c.sourcePixels=null;c.effectiveMask=null;}]){
  const descriptor=placementCandidate(p);mutate(descriptor);assert.throws(()=>planTextTreatmentPlacement(p,p.inventory,descriptor,adoption()),/TEXT_TREATMENT_PRESERVATION_PROOF_REQUIRED/);
 }
});
test('metadata placement preserves explicit hide, duplication and choice declaration fences',()=>{
 const p=plan('baked-lettering'),descriptor=placementCandidate(p,'full-candidate'),hide={...adoption('hide-native-originals','none'),hideNativeIds:['label']};
 const intent=planTextTreatmentPlacement(p,p.inventory,descriptor,hide);assert.deepEqual(intent.hiddenOriginalIds,['label']);assert.deepEqual(intent.afterOrder,[{id:'background',version:'7',visible:true},{id:'label',version:'8',visible:false},{id:'candidate-layer',version:'1',visible:true}]);assert.equal(intent.requestedPreservation,'none');
 assert.throws(()=>planTextTreatmentPlacement(p,p.inventory,descriptor,{...hide,hideNativeIds:['background']}),/TEXT_TREATMENT_HIDE_NOT_REVIEWED/);
 assert.throws(()=>planTextTreatmentPlacement(p,p.inventory,descriptor,{...hide,hideNativeIds:[]}),/TEXT_TREATMENT_HIDE_TARGET_REQUIRED/);
 assert.throws(()=>planTextTreatmentPlacement(p,p.inventory,descriptor,{...hide,action:'keep-native-overlay'}),/TEXT_TREATMENT_UNREVIEWED_VISIBILITY_CHANGE/);
 const both=adoption('keep-both','none');assert.throws(()=>planTextTreatmentPlacement(p,p.inventory,descriptor,both),/TEXT_TREATMENT_DUPLICATION_ACK/);
 both.duplicationAcknowledgement='accept-duplicates';assert.deepEqual(planTextTreatmentPlacement(p,p.inventory,descriptor,both).hiddenOriginalIds,[]);
 for(const mutate of [c=>{delete c.approvalId;},c=>{c.approvalId='';},c=>{c.preservation='assumed';},c=>{c.extra=true;},c=>{c.nativeCopies=[{sourceLayerId:'label',newLayerId:'copied-label',transform:[1,0,0,1,0,0]}];}]){
  const choice=structuredClone(hide);mutate(choice);assert.throws(()=>planTextTreatmentPlacement(p,p.inventory,descriptor,choice),/TEXT_TREATMENT_(SHAPE|ADOPTION_CHOICE|UNREVIEWED_VISIBILITY_CHANGE)/);
 }
});
test('new-document placement retains explicit copy transforms and frozen native metadata independently of inputs',()=>{
 const p=plan(),current=structuredClone(p.inventory),descriptor=placementCandidate(p,'full-candidate'),choice={...adoption('new-document','none'),nativeCopies:[{sourceLayerId:'label',newLayerId:'copied-label',transform:[1,0,0,1,4,8]}]},before=structuredClone({p,current,descriptor,choice});
 const intent=planTextTreatmentPlacement(p,current,descriptor,choice);
 assert.equal(intent.sourceDocumentUnchanged,true);assert.equal(intent.requestedPreservation,'none');assert.deepEqual(intent.hiddenOriginalIds,[]);assert.deepEqual(intent.afterOrder,[{id:'candidate-layer',version:'1',visible:true},{id:'copied-label',version:'1',visible:true}]);
 assert.deepEqual(intent.copiedNative,[{sourceLayerId:'label',newLayerId:'copied-label',transform:[1,0,0,1,4,8],sourceStateHash:p.inventory.layers[1].stateHash,...p.inventory.layers[1].native}]);
 assert.deepEqual(placementGraph(intent),placementGraph(planTextTreatmentAdoption(p,current,candidate(p,'full-candidate'),choice)));assert.deepEqual({p,current,descriptor,choice},before);
 const alone=planTextTreatmentPlacement(p,current,descriptor,{...choice,nativeCopies:[]});assert.deepEqual(alone.copiedNative,[]);assert.deepEqual(alone.afterOrder,[{id:'candidate-layer',version:'1',visible:true}]);
 const retained=structuredClone(intent);choice.nativeCopies[0].transform[4]=99;current.layers[1].native.source.hash=hash('later-live-native');descriptor.grid.width=3;assert.deepEqual(intent,retained);
});
test('new-document placement refuses implicit or colliding copy identities and invalid transforms',()=>{
 const p=plan(),descriptor=placementCandidate(p,'full-candidate'),base={...adoption('new-document','none'),nativeCopies:[{sourceLayerId:'label',newLayerId:'copied-label',transform:[1,0,0,1,4,8]}]};
 for(const mutate of [c=>{delete c.nativeCopies[0].newLayerId;},c=>{c.nativeCopies[0].newLayerId='candidate-layer';},c=>{c.nativeCopies[0].newLayerId='label';},c=>{c.newLayerId='background';},c=>{c.nativeCopies[0].sourceLayerId='background';},c=>{c.nativeCopies[0].transform=[1,0,0,0,4,8];},c=>{c.nativeCopies[0].transform[4]=Infinity;},c=>{c.preservation='single-original-contribution';}]){
  const choice=structuredClone(base);mutate(choice);assert.throws(()=>planTextTreatmentPlacement(p,p.inventory,descriptor,choice),/TEXT_TREATMENT_/);
 }
});

// These are pure contract fixtures. The mapping constructor and derived R16
// samples make the positive case real; only the writer can prove that retained
// mask bytes and prepared pixels actually match these references.
function successorFixture(kind='native-overlay',configure=()=>{}){
 const i=input(kind);i.inventory.grid={width:8,height:8};
 for(const l of i.inventory.layers)l.contribution.pixels=pixels(l.id,8,8);
 const capture=(ids,scope)=>{
  const value=source(i.inventory,ids,scope);value.source.width=8;value.source.height=8;
  value.source.pixels=ids.length===1?structuredClone(i.inventory.layers.find(l=>l.id===ids[0]).contribution.pixels):pixels('composite-'+ids.join('-'),8,8);return value;
 };
 i.beforeSource=kind==='no-native-text'?capture(['background']):capture(['background','label'],'visible-document');
 i.afterSource=kind==='baked-lettering'?structuredClone(i.beforeSource):capture(['background']);
 configure(i,capture);
 const originalBytes=Buffer.alloc(8*8*2);originalBytes.writeUInt16LE(65535,0);originalBytes.writeUInt16LE(32768,(4*8+4)*2);
 const originalMask=ref(originalBytes,'application/x-ideogram-r16le');
 const requestPlan=createRequestRasterPlan({document:{width:8,height:8},crop:{x:0,y:0,width:8,height:8},padding:{left:0,top:0,right:0,bottom:0},requestGrid:{width:8,height:8},sourcePixels:i.afterSource.source.pixels,authoredMask:originalMask,effectiveMask:originalMask,dependenciesHash:hash('successor-dependencies'),resolution:'already-contained',approvalId:'original-raster-approval'});
 const provisional=createActualOutputMapping(requestPlan,{actualOutput:{width:4,height:4},effectiveMask:originalMask,resolution:'already-contained',approvalId:'successor-output-approval'});
 const originalCoverage={width:8,height:8,get(x,y){return originalBytes.readUInt16LE((y*8+x)*2);}},clipped=clipRequestCoverage(requestPlan,originalCoverage,provisional),finalBytes=Buffer.alloc(originalBytes.length);
 for(let y=0;y<8;y++)for(let x=0;x<8;x++)finalBytes.writeUInt16LE(clipped.get(x,y),(y*8+x)*2);
 const finalMask=ref(finalBytes,'application/x-ideogram-r16le'),outputMapping=createActualOutputMapping(requestPlan,{actualOutput:{width:4,height:4},effectiveMask:finalMask,resolution:'clipped-and-approved',approvalId:'successor-output-approval'});
 i.edit={effectiveMask:originalMask,requestPlan:json(requestPlan)};const p=planTextTreatment(i);
 const identity={candidateId:'candidate',candidateVersion:'1',documentId:'doc',jobId:'job',attemptId:'attempt',requestId:'request',outputIdentity:hash('provider-output'),preparedAssetId:'provider-raster',preparedAssetVersion:'1',preparedAssetHash:hash('provider-raster-bytes'),requestHash:hash('accepted-request'),jobVersion:'1',writerEpoch:'1'};
 const bindings={identity,requestPlan,outputMapping},choice=adoption(),witness=createTextTreatmentMaskSuccessor(p,bindings,choice);
 const descriptor={candidateId:identity.candidateId,grid:{width:8,height:8},preparation:'safe-region',sourcePixels:structuredClone(requestPlan.sourcePixels),effectiveMask:structuredClone(finalMask)};
 const prepared={...structuredClone(descriptor),assetId:'prepared-raster',pixels:pixels('prepared-q',8,8),preparationIdentity:json({immutablePreparation:'safe-region',mapping:outputMapping,effectiveMask:finalMask})};
 return {i,p,bindings,choice,witness,descriptor,prepared,originalBytes,finalBytes,originalCoverage,clipped};
}
function successorCalls(f,{p=f.p,current=f.p.inventory,descriptor=f.descriptor,prepared=f.prepared,choice=f.choice,bindings=f.bindings,witness=f.witness}={}){
 return [()=>planTextTreatmentSuccessorPlacement(p,current,descriptor,choice,bindings,witness),()=>planTextTreatmentSuccessorAdoption(p,current,prepared,choice,bindings,witness)];
}
function rejectSuccessor(f,overrides={},pattern=/TEXT_TREATMENT_/){for(const call of successorCalls(f,overrides))assert.throws(call,pattern);}

test('clipped lettering successor binds a real resized mapping without rewriting accepted treatment or its F04 slot',()=>{
 const f=successorFixture(),before=structuredClone({p:f.p,bindings:f.bindings,choice:f.choice,descriptor:f.descriptor,prepared:f.prepared,witness:f.witness}),envelope=bindTextTreatmentEnvelope(f.p,textTreatmentPlanRef(f.p));
 assert.deepEqual(f.bindings.requestPlan.requestGrid,{width:8,height:8});assert.deepEqual(f.bindings.outputMapping.actualOutput,{width:4,height:4});assert.deepEqual(f.descriptor.grid,{width:8,height:8});
 assert.equal(inspectRequestCoverage(f.bindings.requestPlan,f.originalCoverage,f.bindings.outputMapping).lostPixels,1);
 assert.deepEqual(inspectRequestCoverage(f.bindings.requestPlan,f.clipped,f.bindings.outputMapping),{effectivePixels:1,lostPixels:0,fullDocument:false,fullDomain:false,contained:true});
 assert.equal(f.finalBytes.readUInt16LE(0),0);assert.equal(f.finalBytes.readUInt16LE((4*8+4)*2),32768);assert.notEqual(f.p.edit.effectiveMask.hash,f.descriptor.effectiveMask.hash);
 assert.deepEqual(f.witness,{kind:'text-treatment-mask-successor-1',acceptedTreatmentPlan:textTreatmentPlanRef(f.p),originalRequestPlan:json(f.bindings.requestPlan),originalEffectiveMask:f.p.edit.effectiveMask,finalEffectiveMask:f.bindings.outputMapping.effectiveMask,candidateIdentityHash:hash(canonical(f.bindings.identity)),outputMappingHash:hash(canonical(f.bindings.outputMapping)),adoptionChoiceHash:hash(canonical(f.choice))});
 const [intent,decision]=successorCalls(f).map(call=>call());assert.equal(intent.kind,'text-treatment-successor-placement-intent-1');assert.equal(decision.kind,'text-treatment-successor-adoption-decision-1');
 for(const value of [intent,decision]){
  assert.deepEqual(value.hiddenOriginalIds,['background']);assert.deepEqual(value.beforeOrder,[{id:'background',version:'7',visible:true},{id:'label',version:'7',visible:true}]);assert.deepEqual(value.afterOrder,[{id:'background',version:'8',visible:false},{id:'candidate-layer',version:'1',visible:true},{id:'label',version:'7',visible:true}]);
  assert.deepEqual(value.maskSuccessor,f.witness);assert.deepEqual(value.candidate.effectiveMask,f.bindings.outputMapping.effectiveMask);assert.deepEqual(value.copiedNative,[]);const {fingerprint,...body}=value;assert.equal(fingerprint,hash(canonical(body)));
 }
 assert.equal(intent.requestedPreservation,'single-original-contribution');assert.equal(decision.preservedExterior,'single-original-contribution');assert.deepEqual(placementGraph(intent),placementGraph(decision));validateTextTreatmentSuccessorAdoptionDecision(decision,f.p,f.p.inventory,f.bindings);assertTextTreatmentEnvelope(envelope,f.p);
 assert.deepEqual({p:f.p,bindings:f.bindings,choice:f.choice,descriptor:f.descriptor,prepared:f.prepared,witness:f.witness},before);
});
test('ordinary treatment entry points never acquire successor authority, even when clipped metadata retains the original mask',()=>{
 const f=successorFixture();assert.throws(()=>planTextTreatmentPlacement(f.p,f.p.inventory,f.descriptor,f.choice),/PRESERVATION_PROOF_REQUIRED/);assert.throws(()=>planTextTreatmentAdoption(f.p,f.p.inventory,f.prepared,f.choice),/PRESERVATION_PROOF_REQUIRED/);
 const changed=planTextTreatmentSuccessorAdoption(f.p,f.p.inventory,f.prepared,f.choice,f.bindings,f.witness);assert.throws(()=>validateTextTreatmentAdoptionDecision(changed,f.p,f.p.inventory),/TEXT_TREATMENT_/);
 // A pure witness does not prove that clipping removed any sample. Even in
 // this equal-mask case, an ordinary verifier must reject the successor kind.
 const bindings=structuredClone(f.bindings);bindings.outputMapping=createActualOutputMapping(bindings.requestPlan,{actualOutput:{width:4,height:4},effectiveMask:f.p.edit.effectiveMask,resolution:'clipped-and-approved',approvalId:'equal-mask-review'});
 const prepared={...f.prepared,effectiveMask:structuredClone(f.p.edit.effectiveMask)},witness=createTextTreatmentMaskSuccessor(f.p,bindings,f.choice),successor=planTextTreatmentSuccessorAdoption(f.p,f.p.inventory,prepared,f.choice,bindings,witness);
 validateTextTreatmentSuccessorAdoptionDecision(successor,f.p,f.p.inventory,bindings);assert.throws(()=>validateTextTreatmentAdoptionDecision(successor,f.p,f.p.inventory),/ADOPTION_IDENTITY/);
 const ordinary=planTextTreatmentAdoption(f.p,f.p.inventory,prepared,f.choice);validateTextTreatmentAdoptionDecision(ordinary,f.p,f.p.inventory);assert.throws(()=>validateTextTreatmentSuccessorAdoptionDecision({...ordinary,maskSuccessor:witness},f.p,f.p.inventory,bindings),/ADOPTION_IDENTITY/);
});
test('successor creation requires the exact accepted parent plan, source, grid, original mask and explicit clipped approval',()=>{
 const f=successorFixture();
 for(const mutate of [b=>{b.identity.documentId='another-document';},b=>{b.outputMapping.approvalId=b.requestPlan.approvalId;},b=>{b.outputMapping.outputToDocument[0]=1;},b=>{b.outputMapping.requestPlan.dependenciesHash=hash('another-parent');},b=>{b.outputMapping=createActualOutputMapping(b.requestPlan,{actualOutput:{width:4,height:4},effectiveMask:b.requestPlan.effectiveMask,resolution:'already-contained',approvalId:'contained-review'});},b=>{b.requestPlan.sourcePixels=pixels('another-source',8,8);b.outputMapping.requestPlan=structuredClone(b.requestPlan);},b=>{b.requestPlan.effectiveMask={...b.requestPlan.effectiveMask,hash:hash('another-original-mask')};b.outputMapping.requestPlan=structuredClone(b.requestPlan);},b=>{b.requestPlan.document.width=9;b.requestPlan.sourcePixels=pixels('larger-source',9,8);b.requestPlan.authoredMask={...b.requestPlan.authoredMask,byteLength:'144'};b.requestPlan.effectiveMask={...b.requestPlan.effectiveMask,byteLength:'144'};b.outputMapping.requestPlan=structuredClone(b.requestPlan);b.outputMapping.effectiveMask.byteLength='144';}]){
  const bindings=structuredClone(f.bindings);mutate(bindings);assert.throws(()=>createTextTreatmentMaskSuccessor(f.p,bindings,f.choice),/TEXT_TREATMENT_SUCCESSOR_/);
 }
 for(const mutate of [i=>{i.edit=null;},i=>{i.edit.requestPlan={...i.edit.requestPlan,hash:hash('other-plan')};},i=>{i.edit.requestPlan={...i.edit.requestPlan,byteLength:'1'};},i=>{i.edit.effectiveMask={...i.edit.effectiveMask,hash:hash('other-accepted-mask')};}]){
  const i=structuredClone(f.i);mutate(i);const p=planTextTreatment(i);assert.throws(()=>createTextTreatmentMaskSuccessor(p,f.bindings,f.choice),/TEXT_TREATMENT_SUCCESSOR_PARENT/);
 }
});
test('successor witness is bound to every immutable candidate and job identity field and to valid different mappings',()=>{
 const f=successorFixture();
 for(const field of ['candidateId','candidateVersion','jobId','attemptId','requestId','outputIdentity','preparedAssetId','preparedAssetVersion','preparedAssetHash','requestHash','jobVersion','writerEpoch']){
  const bindings=structuredClone(f.bindings),value=bindings.identity[field];bindings.identity[field]=value.startsWith('sha256:')?hash('changed-'+field):/^\d+$/.test(value)?'2':'changed-'+value;
  assert.notDeepEqual(createTextTreatmentMaskSuccessor(f.p,bindings,f.choice),f.witness);rejectSuccessor(f,{bindings},/SUCCESSOR_IDENTITY/);
 }
 for(const input of [{actualOutput:{width:8,height:8},effectiveMask:f.bindings.outputMapping.effectiveMask,resolution:'clipped-and-approved',approvalId:'other-size-review'},{actualOutput:{width:4,height:4},effectiveMask:{...f.bindings.outputMapping.effectiveMask,hash:hash('other-approved-mask')},resolution:'clipped-and-approved',approvalId:'other-mask-review'}]){
  const bindings={...structuredClone(f.bindings),outputMapping:createActualOutputMapping(f.bindings.requestPlan,input)};assert.notDeepEqual(createTextTreatmentMaskSuccessor(f.p,bindings,f.choice),f.witness);rejectSuccessor(f,{bindings},/SUCCESSOR_IDENTITY/);
 }
});
test('successor witness rejects altered or omitted parent, original mask, final mask and choice identities',()=>{
 const f=successorFixture();
 for(const field of ['acceptedTreatmentPlan','originalRequestPlan','originalEffectiveMask','finalEffectiveMask','candidateIdentityHash','outputMappingHash','adoptionChoiceHash']){
  const witness=structuredClone(f.witness);if(typeof witness[field]==='string')witness[field]=hash('forged-'+field);else witness[field].hash=hash('forged-'+field);rejectSuccessor(f,{witness},/SUCCESSOR_IDENTITY/);
  const missing=structuredClone(f.witness);delete missing[field];rejectSuccessor(f,{witness:missing},/SUCCESSOR_IDENTITY/);
 }
 rejectSuccessor(f,{witness:{...f.witness,extra:true}},/SUCCESSOR_IDENTITY/);rejectSuccessor(f,{witness:{...f.witness,kind:'text-treatment-mask-successor-2'}},/SUCCESSOR_IDENTITY/);
 const i=structuredClone(f.i);i.id='separately-reviewed-treatment';const p=planTextTreatment(i);rejectSuccessor(f,{p,current:p.inventory},/SUCCESSOR_IDENTITY/);
});
test('successor descriptors require matching candidate, final mask, source and full document grid while adoption still requires raster proof fields',()=>{
 const f=successorFixture();
 for(const mutate of [c=>{c.candidateId='another-candidate';},c=>{c.effectiveMask=structuredClone(f.p.edit.effectiveMask);},c=>{c.effectiveMask=null;},c=>{c.sourcePixels=pixels('different-source',8,8);},c=>{c.sourcePixels=null;},c=>{c.grid={width:4,height:4};},c=>{c.preparation='full-candidate';}]){
  const descriptor=structuredClone(f.descriptor),prepared=structuredClone(f.prepared);mutate(descriptor);mutate(prepared);if(prepared.grid.width===4)prepared.pixels=pixels('wrong-grid',4,4);rejectSuccessor(f,{descriptor,prepared},/SUCCESSOR_IDENTITY/);
 }
 for(const field of ['assetId','pixels','preparationIdentity']){
  const descriptor={...f.descriptor,[field]:structuredClone(f.prepared[field])};assert.throws(()=>planTextTreatmentSuccessorPlacement(f.p,f.p.inventory,descriptor,f.choice,f.bindings,f.witness),/SHAPE/);
  const prepared=structuredClone(f.prepared);delete prepared[field];assert.throws(()=>planTextTreatmentSuccessorAdoption(f.p,f.p.inventory,prepared,f.choice,f.bindings,f.witness),/SHAPE/);
 }
 for(const mutate of [c=>{c.pixels.byteLength='16';},c=>{c.pixels.mediaType='image/png';},c=>{c.preparationIdentity=null;},c=>{c.preparationIdentity.byteLength='65537';}]){
  const prepared=structuredClone(f.prepared);mutate(prepared);assert.throws(()=>planTextTreatmentSuccessorAdoption(f.p,f.p.inventory,prepared,f.choice,f.bindings,f.witness),/TEXT_TREATMENT_(SHAPE|REF|CANDIDATE)/);
 }
 const intent=successorCalls(f)[0]();for(const field of ['assetId','pixels','preparationIdentity'])assert.equal(Object.hasOwn(intent.candidate,field),false);assert.throws(()=>planTextTreatmentSuccessorAdoption(f.p,f.p.inventory,intent.candidate,f.choice,f.bindings,f.witness),/SHAPE/);
});
test('successor witnesses cannot authorize a different adoption approval, hide choice or native copy transform',()=>{
 const f=successorFixture();
 for(const mutate of [c=>{c.approvalId='new-adoption-review';},c=>{c.newLayerId='new-result-layer';},c=>{c.preservation='none';},c=>{c.action='hide-native-originals';c.hideNativeIds=['label'];},c=>{c.action='new-document';c.preservation='none';c.nativeCopies=[{sourceLayerId:'label',newLayerId:'copied-label',transform:[1,0,0,1,4,8]}];}]){
  const choice=structuredClone(f.choice);mutate(choice);assert.notDeepEqual(createTextTreatmentMaskSuccessor(f.p,f.bindings,choice),f.witness);rejectSuccessor(f,{choice},/SUCCESSOR_IDENTITY/);
 }
 const choice={...adoption('new-document','none'),nativeCopies:[{sourceLayerId:'label',newLayerId:'copied-label',transform:[1,0,0,1,4,8]}]},witness=createTextTreatmentMaskSuccessor(f.p,f.bindings,choice);choice.nativeCopies[0].transform[4]=5;rejectSuccessor(f,{choice,witness},/SUCCESSOR_IDENTITY/);
});
test('successor placement and adoption retain all current and new-document native and stack freshness fences',()=>{
 const f=successorFixture(),choices=[f.choice,{...adoption('new-document','none'),nativeCopies:[{sourceLayerId:'label',newLayerId:'copied-label',transform:[1,0,0,1,4,8]}]}];
 for(const choice of choices){const witness=createTextTreatmentMaskSuccessor(f.p,f.bindings,choice);
  for(const mutate of [v=>{v.documentRevision='12';},v=>{v.layers.reverse();},v=>{v.layers[0].stateHash=hash('changed-transform');},v=>{v.layers[0].contribution.pixels=pixels('changed-original',8,8);},v=>{v.layers[1].version='8';},v=>{v.layers[1].visible=false;},v=>{v.layers[1].locked=true;},v=>{v.layers[1].native.source=json({differentNative:true});},v=>{v.layers[1].native.literal=ref('Changed lettering');},v=>{v.layers[1].native.textVersion=hash('changed-text');},v=>{v.layers[1].native.renderVersion=hash('changed-render');},v=>{v.layers[1].native.dependencyHash=hash('changed-font-layout');},v=>{v.imageState=json({changedImage:true});}]){
   const current=structuredClone(f.p.inventory);mutate(current);rejectSuccessor(f,{current,choice,witness},/TEXT_TREATMENT_STALE/);
  }
 }
});
test('successor approval preserves F04 exclusions, explicit hide and duplication choices',()=>{
 const overlay=successorFixture(),fullRoot=adoption('keep-native-overlay','full-visible-root');rejectSuccessor(overlay,{choice:fullRoot,witness:createTextTreatmentMaskSuccessor(overlay.p,overlay.bindings,fullRoot)},/NEW_DOCUMENT_REQUIRED/);
 for(const ids of [['background'],['lower-background','background']]){
  const f=successorFixture('native-overlay',(i,capture)=>{if(ids.length>1){const l=layer('lower-background');l.contribution.pixels=pixels(l.id,8,8);i.inventory.layers.unshift(l);}i.beforeSource=capture([...ids,'label'],'visible-document');i.afterSource=capture(ids,'selected-layers');i.choice.placement='new-document';});
  rejectSuccessor(f,{},/NEW_DOCUMENT_REQUIRED/);
 }
 const single=successorFixture('baked-lettering',(i,capture)=>{i.beforeSource=capture(['background']);i.afterSource=structuredClone(i.beforeSource);}),extraHide={...adoption('hide-native-originals'),hideNativeIds:['label']};rejectSuccessor(single,{choice:extraHide,witness:createTextTreatmentMaskSuccessor(single.p,single.bindings,extraHide)},/EXTRA_HIDE_BREAKS_PRESERVATION/);
 const baked=successorFixture('baked-lettering'),both=adoption('keep-both','none');rejectSuccessor(baked,{choice:both,witness:createTextTreatmentMaskSuccessor(baked.p,baked.bindings,both)},/DUPLICATION_ACK/);
 both.duplicationAcknowledgement='accept-both';for(const call of successorCalls(baked,{choice:both,witness:createTextTreatmentMaskSuccessor(baked.p,baked.bindings,both)})){const value=call();assert.deepEqual(value.hiddenOriginalIds,[]);assert.equal(value.afterOrder.find(l=>l.id==='label').visible,true);}
 const hide={...adoption('hide-native-originals','full-visible-root'),hideNativeIds:['label']};for(const call of successorCalls(baked,{choice:hide,witness:createTextTreatmentMaskSuccessor(baked.p,baked.bindings,hide)})){const value=call();assert.deepEqual(value.hiddenOriginalIds,['background','label']);assert.deepEqual(value.afterOrder.filter(l=>l.visible).map(l=>l.id),['candidate-layer']);}
});
test('successor new-document copies retain frozen native identities and explicit transforms without an exterior equality claim',()=>{
 const f=successorFixture(),choice={...adoption('new-document','none'),nativeCopies:[{sourceLayerId:'label',newLayerId:'copied-label',transform:[1,0,0,1,4,8]}]},witness=createTextTreatmentMaskSuccessor(f.p,f.bindings,choice),before=structuredClone({p:f.p,bindings:f.bindings,choice,witness});
 const results=successorCalls(f,{choice,witness}).map(call=>call());for(const value of results){assert.equal(value.sourceDocumentUnchanged,true);assert.deepEqual(value.hiddenOriginalIds,[]);assert.deepEqual(value.afterOrder,[{id:'candidate-layer',version:'1',visible:true},{id:'copied-label',version:'1',visible:true}]);assert.deepEqual(value.copiedNative,[{...choice.nativeCopies[0],sourceStateHash:f.p.inventory.layers[1].stateHash,...f.p.inventory.layers[1].native}]);}
 assert.deepEqual(placementGraph(results[0]),placementGraph(results[1]));assert.deepEqual({p:f.p,bindings:f.bindings,choice,witness},before);
 for(const mutate of [c=>{c.preservation='single-original-contribution';},c=>{c.nativeCopies[0].newLayerId='label';},c=>{c.nativeCopies[0].sourceLayerId='background';}]){const altered=structuredClone(choice);mutate(altered);const proof=createTextTreatmentMaskSuccessor(f.p,f.bindings,altered);rejectSuccessor(f,{choice:altered,witness:proof});}
 for(const mutate of [c=>{c.nativeCopies[0].newLayerId='candidate-layer';},c=>{c.nativeCopies[0].transform=[1,0,0,0,4,8];},c=>{c.nativeCopies[0].transform[4]=Infinity;}]){const altered=structuredClone(choice);mutate(altered);assert.throws(()=>createTextTreatmentMaskSuccessor(f.p,f.bindings,altered),/TEXT_TREATMENT_(IDS|COPY_TRANSFORM)/);}
 const retained=structuredClone(results);choice.nativeCopies[0].transform[4]=99;witness.finalEffectiveMask.hash=hash('later-witness');f.bindings.outputMapping.effectiveMask.hash=hash('later-mapping');f.descriptor.grid.width=9;f.p.inventory.layers[1].native.source.hash=hash('later-native');assert.deepEqual(results,retained);
});
test('successor decision verification replays exact graph, witness and joined inputs rather than trusting a rehashed record',()=>{
 const f=successorFixture(),decision=successorCalls(f)[1]();
 for(const mutate of [d=>{d.afterOrder[2].visible=false;},d=>{d.afterOrder.reverse();},d=>{d.hiddenOriginalIds.push('label');},d=>{d.candidate.effectiveMask=structuredClone(f.p.edit.effectiveMask);},d=>{d.maskSuccessor.finalEffectiveMask.hash=hash('forged-mask');},d=>{d.kind='text-treatment-adoption-decision-1';},d=>{delete d.maskSuccessor;},d=>{d.extra=true;}]){
  const altered=structuredClone(decision);mutate(altered);const {fingerprint,...body}=altered;altered.fingerprint=hash(canonical(body));assert.throws(()=>validateTextTreatmentSuccessorAdoptionDecision(altered,f.p,f.p.inventory,f.bindings));
 }
 const bindings=structuredClone(f.bindings);bindings.identity.jobVersion='2';assert.throws(()=>validateTextTreatmentSuccessorAdoptionDecision(decision,f.p,f.p.inventory,bindings),/SUCCESSOR_IDENTITY/);
});
test('pure successor metadata cannot establish retained R16 subset or prepared-pixel byte authority',()=>{
 const f=successorFixture(),bindings=structuredClone(f.bindings),unreadMask={...f.bindings.outputMapping.effectiveMask,hash:hash('unread-mask-bytes')};
 bindings.outputMapping=createActualOutputMapping(bindings.requestPlan,{actualOutput:{width:4,height:4},effectiveMask:unreadMask,resolution:'clipped-and-approved',approvalId:'metadata-only-review'});
 // Deliberately no buffer corresponds to unreadMask. Pure planning can bind
 // that proposal, but neither reads it nor confers the writer's subset proof.
 const witness=createTextTreatmentMaskSuccessor(f.p,bindings,f.choice),descriptor={...f.descriptor,effectiveMask:unreadMask},intent=planTextTreatmentSuccessorPlacement(f.p,f.p.inventory,descriptor,f.choice,bindings,witness);
 assert.equal(intent.kind,'text-treatment-successor-placement-intent-1');assert.deepEqual(intent.maskSuccessor.finalEffectiveMask,unreadMask);for(const field of ['assetId','pixels','preparationIdentity'])assert.equal(Object.hasOwn(intent.candidate,field),false);
 assert.throws(()=>planTextTreatmentSuccessorAdoption(f.p,f.p.inventory,intent.candidate,f.choice,bindings,witness),/SHAPE/);assert.throws(()=>planTextTreatmentPlacement(f.p,f.p.inventory,descriptor,f.choice),/PRESERVATION_PROOF_REQUIRED/);
});

// Same-call composition has no retained validation authority. These controls use
// the unchanged public validators and actual later placement planner as bounds.
import {assertTextTreatmentPlanEnvelope} from '../../dist/local/src/request/text-treatment.js';
function composedErrorCode(work){let caught;try{work();}catch(error){caught=error;}assert(caught,'Expected treatment refusal');return caught.code;}

test('composed plan and envelope validation agrees with both public validators without changing its inputs',()=>{
 for(const kind of ['native-overlay','baked-lettering','no-native-text']){
  const p=plan(kind),envelope=bindTextTreatmentEnvelope(p,textTreatmentPlanRef(p)),before=structuredClone({p,envelope});
  validateTextTreatmentPlan(p);assertTextTreatmentEnvelope(envelope,p);assert.equal(assertTextTreatmentPlanEnvelope(envelope,p),undefined);
  assert.deepEqual({p,envelope},before);assert.deepEqual(textTreatmentPlanRef(p),envelope.plan);
 }
});

test('composed validation preserves plan-first error precedence while the original public envelope API remains envelope-first',()=>{
 const p=plan(),envelope=bindTextTreatmentEnvelope(p,textTreatmentPlanRef(p)),bad=structuredClone(p);bad.retainedNativeIds=[];
 const malformed={...envelope,unreviewed:true};
 assert.equal(composedErrorCode(()=>validateTextTreatmentPlan(bad)),'TEXT_TREATMENT_PLAN_IDENTITY');
 assert.equal(composedErrorCode(()=>assertTextTreatmentPlanEnvelope(malformed,bad)),'TEXT_TREATMENT_PLAN_IDENTITY');
 assert.equal(composedErrorCode(()=>assertTextTreatmentEnvelope(malformed,bad)),'TEXT_TREATMENT_SHAPE');
 assert.equal(composedErrorCode(()=>assertTextTreatmentEnvelope({...envelope,planHash:hash('other fingerprint')},bad)),'TEXT_TREATMENT_ENVELOPE_IDENTITY');
 assert.equal(composedErrorCode(()=>assertTextTreatmentEnvelope(envelope,bad)),'TEXT_TREATMENT_PLAN_IDENTITY');
 assert.equal(composedErrorCode(()=>textTreatmentPlanRef(bad)),'TEXT_TREATMENT_PLAN_IDENTITY');
});

test('composed validation retains malformed envelope and exact fingerprint hash length and media refusals',()=>{
 const p=plan(),envelope=bindTextTreatmentEnvelope(p,textTreatmentPlanRef(p));
 for(const alter of [e=>{e.extra=true;},e=>{e.kind='other';},e=>{e.planHash=hash('other');},e=>{e.plan.hash=hash('different bytes');},e=>{e.plan.byteLength=String(Number(e.plan.byteLength)+1);},e=>{e.plan.mediaType='text/plain';}]){
  const changed=structuredClone(envelope);alter(changed);const before=structuredClone(changed),expected=composedErrorCode(()=>assertTextTreatmentEnvelope(changed,p));
  assert.equal(composedErrorCode(()=>assertTextTreatmentPlanEnvelope(changed,p)),expected);assert.deepEqual(changed,before);
 }
});

test('a successful composed call cannot authorize a later mutated plan source or treatment choice',()=>{
 const original=plan(),envelope=bindTextTreatmentEnvelope(original,textTreatmentPlanRef(original));
 for(const change of [p=>{p.retainedNativeIds=[];},p=>{p.afterSource.source.pixels.hash=hash('changed source');},p=>{p.choice.approvalId='later choice';}]){
  const p=structuredClone(original);assertTextTreatmentPlanEnvelope(envelope,p);change(p);
  assert.equal(composedErrorCode(()=>assertTextTreatmentPlanEnvelope(envelope,p)),composedErrorCode(()=>validateTextTreatmentPlan(p)));
  assertTextTreatmentPlanEnvelope(envelope,structuredClone(original));
 }
});

test('later public placement still fully validates the plan current inventory and adoption choice after composition',()=>{
 const p=plan(),envelope=bindTextTreatmentEnvelope(p,textTreatmentPlanRef(p)),current=structuredClone(p.inventory),c=placementCandidate(p),choice=adoption();
 assertTextTreatmentPlanEnvelope(envelope,p);const expected=planTextTreatmentPlacement(p,current,c,choice);
 const changed=structuredClone(current);changed.layers[1].native.renderVersion=hash('later native render');
 assert.equal(composedErrorCode(()=>planTextTreatmentPlacement(p,changed,c,choice)),'TEXT_TREATMENT_STALE');
 const bad=structuredClone(p);bad.retainedNativeIds=[];
 assert.equal(composedErrorCode(()=>planTextTreatmentPlacement(bad,current,c,choice)),'TEXT_TREATMENT_PLAN_IDENTITY');
 assert.equal(composedErrorCode(()=>planTextTreatmentPlacement(p,current,c,{...choice,approvalId:''})),'TEXT_TREATMENT_ADOPTION_CHOICE');
 assert.deepEqual(planTextTreatmentPlacement(p,current,c,choice),expected);
});
