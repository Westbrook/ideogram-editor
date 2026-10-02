import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {newDraft,resolve,bodyTemplate} from '../../dist/local/src/request/core.js';
import {
 planTextTreatment,validateTextTreatmentInventory,validateTextTreatmentPlan,
 textTreatmentSourceSelection,textTreatmentPlacementEligibility,assertTextTreatmentFresh,
 textTreatmentProvenance,textTreatmentRefs,textTreatmentPlanRef,bindTextTreatmentEnvelope,
 assertTextTreatmentEnvelope,planTextTreatmentAdoption,validateTextTreatmentAdoptionDecision,planTextTreatmentPlacement,
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
