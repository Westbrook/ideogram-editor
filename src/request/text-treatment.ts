import type { BlobRef } from '../protocol/store.js';
import type { Source } from './core.js';
import type { RequestSourceCapture } from '../protocol/request-edits.js';
import type {CandidateAdoptionIdentity} from '../protocol/candidates.js';
import {requireOutputMapping,type RequestRasterPlan,type RequestOutputMapping} from './raster-plan.js';
import { canonical } from '../protocol/json.js';
import { SHA256 } from '../protocol/sha256.js';

/** An adjunct contract. Existing request drafts, reviews and provider bodies do not change. */
export const TEXT_TREATMENT_CONTRACT = 'text-treatment-plan-1' as const;
export const TEXT_TREATMENT_LIMITS = Object.freeze({ layers:100, semanticElements:256, manifestBytes:524288 });
type Grid = {width:number;height:number};
export type TreatmentContribution = {manifest:BlobRef;pixels:BlobRef;pixelIdentity:string};
/** source is the complete retained TextSource, including style/font/layout/profile dependencies. */
export type TreatmentNativeVersion = {source:BlobRef;literal:BlobRef;textVersion:string;renderVersion:string;dependencyHash:string};
export type TreatmentLayer = {
 id:string;version:string;kind:'image'|'text';visible:boolean;locked:boolean;
 stateHash:string;contribution:TreatmentContribution|null;native:TreatmentNativeVersion|null;
};
export type TreatmentSemanticBinding = {
 field:'text'|'description'|'bounds';bindingLayerId:string;layerId:string;
 reviewedLayerVersion:string;reviewedValue:BlobRef;
};
/** Literal/description/bounds references name complete values, never display truncations. */
export type TreatmentSemanticText = {
 id:string;literal:BlobRef;description:BlobRef;bounds:BlobRef|null;
 bindings:TreatmentSemanticBinding[];
};
export type TextTreatmentInventory = {
 schemaVersion:1;kind:'text-treatment-inventory-1';documentId:string;documentRevision:string;
 grid:Grid;imageState:BlobRef;layers:TreatmentLayer[];
 composition:null|{id:string;value:BlobRef;bindingsHash:string;frameHash:string};
 semanticText:TreatmentSemanticText[];
};
/** capture is decoded from source.capture's RasterManifest.plan.capture, never an invented subgroup. */
export type TreatmentSource = {source:Source;capture:RequestSourceCapture|null};
/** composition-text is app-owned reviewed prose provenance, not a provider caption mode. */
export type TreatmentPrompt = {mode:'plain'|'raw'|'composition'|'composition-text';bytes:BlobRef;projection:BlobRef|null};
type ChoiceCommon = {excludedSemanticIds:string[];approvalId:string};
export type TextTreatmentChoice =
 | (ChoiceCommon & {kind:'native-overlay';retainedNativeIds:string[];placement:'current-document'|'new-document'})
 | (ChoiceCommon & {kind:'baked-lettering';allowedHideNativeIds:string[];duplicationAcknowledgement:string})
 | (ChoiceCommon & {kind:'no-native-text'});
export type TextTreatmentInput = {
 id:string;inventory:TextTreatmentInventory;choice:TextTreatmentChoice;
 beforeSource:TreatmentSource|null;afterSource:TreatmentSource|null;prompt:TreatmentPrompt;
 /** Immutable effective mask and complete request-plan identity, when used. */
 edit:null|{effectiveMask:BlobRef;requestPlan:BlobRef};
};
export type TreatmentPlacementEligibility =
 | {eligible:true;kind:'single-original-contribution';layerId:string;layerVersion:string;stackIndex:number;contribution:TreatmentContribution}
 | {eligible:true;kind:'new-document';reason:'explicit-new-document'|'no-source'|'multiple-original-contributions'|'external-source'|'non-single-layer-source'}
 | {eligible:false;kind:'adoption-review-required';reason:'baked-lettering-placement'|'ordinary-placement'}
 | {eligible:false;kind:'new-review-required';reason:'source-unavailable'|'source-hidden-or-locked'|'source-is-retained-native'};
export type TreatmentSourceSubset = {
 kind:'text-treatment-source-subset-1';beforeSourceHash:string|null;afterSourceHash:string|null;
 includedLayerIds:string[];excludedNativeIds:string[];beforeLayerIds:string[];fingerprint:string;
};
export type TextTreatmentPlan = {
 schemaVersion:1;kind:typeof TEXT_TREATMENT_CONTRACT;id:string;
 inventory:TextTreatmentInventory;choice:TextTreatmentChoice;
 beforeSource:TreatmentSource|null;afterSource:TreatmentSource|null;prompt:TreatmentPrompt;
 edit:TextTreatmentInput['edit'];stackFingerprint:string;sourceSubset:TreatmentSourceSubset;
 includedSemanticIds:string[];excludedSemanticIds:string[];
 rasterIncludedNativeIds:string[];rasterExcludedNativeIds:string[];
 retainedNativeIds:string[];allowedHideNativeIds:string[];
 placement:TreatmentPlacementEligibility;fingerprint:string;
};
export type RequestTextTreatmentEnvelope = {kind:'request-text-treatment-1';plan:BlobRef;planHash:string};
/** Placement metadata describes intended inputs; it cannot prove a prepared output. */
export type TreatmentPlacementCandidate = {
 candidateId:string;grid:Grid;preparation:'full-candidate'|'safe-region';
 sourcePixels:BlobRef|null;effectiveMask:BlobRef|null;
};
export type TreatmentAdoptionCandidate = {
 candidateId:string;assetId:string;pixels:BlobRef;grid:Grid;
 preparation:'full-candidate'|'safe-region';preparationIdentity:BlobRef;
 sourcePixels:BlobRef|null;effectiveMask:BlobRef|null;
};
export type TreatmentAdoptionChoice = {
 kind:'text-treatment-adoption-choice-1';action:'keep-native-overlay'|'hide-native-originals'|'keep-both'|'new-document';
 approvalId:string;duplicationAcknowledgement:string|null;newLayerId:string;
 hideNativeIds:string[];
 nativeCopies:{sourceLayerId:string;newLayerId:string;transform:[number,number,number,number,number,number]}[];
 preservation:'none'|'single-original-contribution'|'full-visible-root';
};
export type TextTreatmentAdoptionDecision = {
 kind:'text-treatment-adoption-decision-1';planHash:string;approvalId:string;
 choice:TreatmentAdoptionChoice;candidate:TreatmentAdoptionCandidate;stackFingerprint:string;
 sourceDocumentUnchanged:boolean;hiddenOriginalIds:string[];
 beforeOrder:{id:string;version:string;visible:boolean}[];
 afterOrder:{id:string;version:string;visible:boolean}[];
 preservedExterior:'none'|'single-original-contribution'|'full-visible-root';
 copiedNative:({sourceLayerId:string;newLayerId:string;transform:[number,number,number,number,number,number];sourceStateHash:string}&TreatmentNativeVersion)[];
 fingerprint:string;
};
/** A graph intent is deliberately distinct from an adoption decision with pixel proof. */
export type TextTreatmentPlacementIntent = Omit<TextTreatmentAdoptionDecision,'kind'|'candidate'|'preservedExterior'> & {
 kind:'text-treatment-placement-intent-1';candidate:TreatmentPlacementCandidate;
 requestedPreservation:TreatmentAdoptionChoice['preservation'];
};
/** Metadata witness only. The writer owes exact derived-mask byte proofs. */
export type TextTreatmentMaskSuccessor = {
 kind:'text-treatment-mask-successor-1';acceptedTreatmentPlan:BlobRef;originalRequestPlan:BlobRef;
 originalEffectiveMask:BlobRef;finalEffectiveMask:BlobRef;candidateIdentityHash:string;outputMappingHash:string;adoptionChoiceHash:string;
};
export type TextTreatmentMaskSuccessorInputs = {identity:CandidateAdoptionIdentity;requestPlan:RequestRasterPlan;outputMapping:RequestOutputMapping};
export type TextTreatmentSuccessorPlacementIntent = Omit<TextTreatmentPlacementIntent,'kind'> & {kind:'text-treatment-successor-placement-intent-1';maskSuccessor:TextTreatmentMaskSuccessor};
export type TextTreatmentSuccessorAdoptionDecision = Omit<TextTreatmentAdoptionDecision,'kind'> & {kind:'text-treatment-successor-adoption-decision-1';maskSuccessor:TextTreatmentMaskSuccessor};
export type TextTreatmentProvenance = {
 kind:'text-treatment-provenance-1';planId:string;planHash:string;treatment:TextTreatmentChoice['kind'];
 stackFingerprint:string;sourceSubsetFingerprint:string;
 rasterIncludedNative:({layerId:string;layerVersion:string}&TreatmentNativeVersion)[];
 rasterExcludedNative:({layerId:string;layerVersion:string}&TreatmentNativeVersion)[];
 retainedNative:({layerId:string;layerVersion:string}&TreatmentNativeVersion)[];
 allowedHideNative:({layerId:string;layerVersion:string}&TreatmentNativeVersion)[];
 includedSemantic:TreatmentSemanticText[];excludedSemantic:TreatmentSemanticText[];
 unlinkedIncludedSemanticIds:string[];placement:TreatmentPlacementEligibility;
 limitations:{metadataExclusionRemovesPixels:false;generatedLetteringGuaranteed:false;spellingGuaranteed:false;opaquePromptMayDescribeText:boolean};
};
export class TextTreatmentError extends Error {constructor(readonly code:string){super(code);}}
function fail(code:string):never{throw new TextTreatmentError(code);}
function exact(v:any,fields:readonly string[]){if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v))||Object.keys(v).length!==fields.length||fields.some(k=>!Object.hasOwn(v,k)))fail('TEXT_TREATMENT_SHAPE');}
const digest=(v:unknown):v is string=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const sequence=(v:unknown):v is string=>typeof v==='string'&&v.length<=128&&/^(0|[1-9][0-9]*)$/.test(v);
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function ref(v:any,media?:string,max?:number):asserts v is BlobRef {
 exact(v,['hash','byteLength','mediaType']);if(!digest(v.hash)||!sequence(v.byteLength)||typeof v.mediaType!=='string'||v.mediaType.length>128||(media!==undefined&&v.mediaType!==media)||(max!==undefined&&BigInt(v.byteLength)>BigInt(max)))fail('TEXT_TREATMENT_REF');
}
function textRef(v:any,max=16384){ref(v,undefined,max);if(!['text/plain','text/plain;charset=utf-8'].includes(v.mediaType))fail('TEXT_TREATMENT_TEXT_REF');}
function grid(v:any){exact(v,['width','height']);if(![v.width,v.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)||v.width*v.height>25000000)fail('TEXT_TREATMENT_GRID');}
function ids(v:any,max=100):asserts v is string[]{if(!Array.isArray(v)||v.length>max||!v.every(identifier)||new Set(v).size!==v.length)fail('TEXT_TREATMENT_IDS');}
function hash(value:unknown){const sha=new SHA256();sha.update(new TextEncoder().encode(canonical(value)));return sha.digest();}
function bounded(v:unknown){if(new TextEncoder().encode(canonical(v)).byteLength>TEXT_TREATMENT_LIMITS.manifestBytes)fail('TEXT_TREATMENT_MANIFEST_LIMIT');}
function native(v:any){exact(v,['source','literal','textVersion','renderVersion','dependencyHash']);ref(v.source,'application/json',65536);textRef(v.literal);if(![v.textVersion,v.renderVersion,v.dependencyHash].every(digest))fail('TEXT_TREATMENT_NATIVE_IDENTITY');}
function contribution(v:any,g:Grid){exact(v,['manifest','pixels','pixelIdentity']);ref(v.manifest,'application/json',65536);ref(v.pixels,'application/x-ideogram-rgba8');if(!digest(v.pixelIdentity)||v.pixels.byteLength!==String(g.width*g.height*4))fail('TEXT_TREATMENT_CONTRIBUTION_GRID');}

/** Structural validation is not proof that the rows match retained source/composition bytes. */
export function validateTextTreatmentInventory(v:any):asserts v is TextTreatmentInventory {
 exact(v,['schemaVersion','kind','documentId','documentRevision','grid','imageState','layers','composition','semanticText']);
 if(v.schemaVersion!==1||v.kind!=='text-treatment-inventory-1'||!identifier(v.documentId)||!sequence(v.documentRevision))fail('TEXT_TREATMENT_INVENTORY');
 grid(v.grid);ref(v.imageState,'application/json',65536);
 if(!Array.isArray(v.layers)||v.layers.length>TEXT_TREATMENT_LIMITS.layers)fail('TEXT_TREATMENT_LAYER_LIMIT');
 ids(v.layers.map((l:any)=>l?.id));
 for(const l of v.layers){
  exact(l,['id','version','kind','visible','locked','stateHash','contribution','native']);
  if(!sequence(l.version)||!['image','text'].includes(l.kind)||typeof l.visible!=='boolean'||typeof l.locked!=='boolean'||!digest(l.stateHash))fail('TEXT_TREATMENT_LAYER');
  if(l.contribution!==null)contribution(l.contribution,v.grid);else if(l.visible)fail('TEXT_TREATMENT_APPEARANCE_UNAVAILABLE');
  if(l.kind==='text')native(l.native);else if(l.native!==null)fail('TEXT_TREATMENT_NATIVE_IDENTITY');
 }
 if(v.composition!==null){exact(v.composition,['id','value','bindingsHash','frameHash']);ref(v.composition.value,'application/json',1048576);if(!identifier(v.composition.id)||!digest(v.composition.bindingsHash)||!digest(v.composition.frameHash))fail('TEXT_TREATMENT_COMPOSITION');}
 if(!Array.isArray(v.semanticText)||v.semanticText.length>TEXT_TREATMENT_LIMITS.semanticElements||v.composition===null&&v.semanticText.length)fail('TEXT_TREATMENT_SEMANTIC_LIMIT');
 ids(v.semanticText.map((s:any)=>s?.id),256);
 for(const s of v.semanticText){
  exact(s,['id','literal','description','bounds','bindings']);textRef(s.literal);textRef(s.description);if(s.bounds!==null)ref(s.bounds,'application/json',65536);
  if(!Array.isArray(s.bindings)||s.bindings.length>3||new Set(s.bindings.map((b:any)=>b?.field)).size!==s.bindings.length)fail('TEXT_TREATMENT_BINDINGS');
  for(const b of s.bindings){exact(b,['field','bindingLayerId','layerId','reviewedLayerVersion','reviewedValue']);if(!['text','description','bounds'].includes(b.field)||!identifier(b.bindingLayerId)||!identifier(b.layerId)||!sequence(b.reviewedLayerVersion))fail('TEXT_TREATMENT_BINDINGS');if(b.field==='bounds')ref(b.reviewedValue,'application/json',65536);else textRef(b.reviewedValue);const value=b.field==='text'?s.literal:b.field==='description'?s.description:s.bounds;if(value===null||!same(value,b.reviewedValue))fail('TEXT_TREATMENT_BINDING_VALUE');}
 }
 bounded(v);
}

function validateSource(v:any,inventory:TextTreatmentInventory):asserts v is TreatmentSource {
 exact(v,['source','capture']);const s=v.source;
 exact(s,['assetId','version','blob','pixels','width','height','scope','documentRevision',...(Object.hasOwn(s??{},'capture')?['capture']:[])]);
 if(!identifier(s.assetId)||!sequence(s.version)||!sequence(s.documentRevision)||!['asset','single-layer','selected-layers','visible-document'].includes(s.scope))fail('TEXT_TREATMENT_SOURCE');
 grid({width:s.width,height:s.height});ref(s.blob);ref(s.pixels,'application/x-ideogram-rgba8');if(s.pixels.byteLength!==String(s.width*s.height*4))fail('TEXT_TREATMENT_SOURCE');
 if(s.scope==='asset'){if(v.capture!==null||Object.hasOwn(s,'capture'))fail('TEXT_TREATMENT_SOURCE');return;}
 if(s.documentRevision!==inventory.documentRevision||s.width!==inventory.grid.width||s.height!==inventory.grid.height)fail('TEXT_TREATMENT_SOURCE_STALE');
 ref(s.capture,'application/json',65536);const c=v.capture;exact(c,['schemaVersion','documentId','documentRevision','image','scope','layerIds']);ids(c.layerIds);
 exact(c.image,['state','semanticDigest','compositeAssetId']);ref(c.image.state,'application/json',65536);
 if(c.schemaVersion!==1||c.documentId!==inventory.documentId||c.documentRevision!==inventory.documentRevision||c.scope!==s.scope||!same(c.image.state,inventory.imageState)||!digest(c.image.semanticDigest)||!(c.image.compositeAssetId===null||identifier(c.image.compositeAssetId)))fail('TEXT_TREATMENT_SOURCE_STALE');
 if(!c.layerIds.length||s.scope==='single-layer'&&c.layerIds.length!==1)fail('TEXT_TREATMENT_SOURCE_SUBSET');
 const ordered=inventory.layers.filter(l=>c.layerIds.includes(l.id));if(!same(ordered.map(l=>l.id),c.layerIds)||ordered.some(l=>!l.visible))fail('TEXT_TREATMENT_SOURCE_SUBSET');
 if(s.scope==='visible-document'&&!same(inventory.layers.filter(l=>l.visible).map(l=>l.id),c.layerIds))fail('TEXT_TREATMENT_SOURCE_SUBSET');
 if(s.scope==='single-layer'&&!same(ordered[0].contribution!.pixels,s.pixels))fail('TEXT_TREATMENT_ORIGINAL_CONTRIBUTION_REQUIRED');
}
function semanticPrompt(mode:TreatmentPrompt['mode']){return mode==='composition'||mode==='composition-text';}
function validatePrompt(v:any){exact(v,['mode','bytes','projection']);if(!['plain','raw','composition','composition-text'].includes(v.mode))fail('TEXT_TREATMENT_PROMPT');textRef(v.bytes,1572864);if(semanticPrompt(v.mode))ref(v.projection,'application/json',524288);else if(v.projection!==null)fail('TEXT_TREATMENT_PROMPT');}
function validateChoice(v:any,inventory:TextTreatmentInventory):asserts v is TextTreatmentChoice {
 const extra=v?.kind==='native-overlay'?['retainedNativeIds','placement']:v?.kind==='baked-lettering'?['allowedHideNativeIds','duplicationAcknowledgement']:v?.kind==='no-native-text'?[]:fail('TEXT_TREATMENT_KIND');
 exact(v,['kind','excludedSemanticIds','approvalId',...extra]);ids(v.excludedSemanticIds,256);if(!identifier(v.approvalId)||v.excludedSemanticIds.some((id:string)=>!inventory.semanticText.some(s=>s.id===id)))fail('TEXT_TREATMENT_APPROVAL');
 if(v.kind==='native-overlay'){ids(v.retainedNativeIds);if(!v.retainedNativeIds.length||!['current-document','new-document'].includes(v.placement))fail('TEXT_TREATMENT_OVERLAY');}
 if(v.kind==='baked-lettering'){ids(v.allowedHideNativeIds);if(!identifier(v.duplicationAcknowledgement))fail('TEXT_TREATMENT_DUPLICATION_ACK');}
 const targets=v.kind==='native-overlay'?v.retainedNativeIds:v.kind==='baked-lettering'?v.allowedHideNativeIds:[];
 for(const id of targets){const l=inventory.layers.find(x=>x.id===id);if(!l||l.kind!=='text')fail('TEXT_TREATMENT_NATIVE_TARGET');if(!l.visible||l.locked)fail('TEXT_TREATMENT_NATIVE_HIDDEN_OR_LOCKED');}
}
const sourceIds=(s:TreatmentSource|null)=>s?.capture?.layerIds??[];
const sourceIdentity=(s:TreatmentSource|null)=>s===null?null:hash(s);
function orderedNative(inventory:TextTreatmentInventory,selected:readonly string[]){return inventory.layers.filter(l=>l.kind==='text'&&selected.includes(l.id)).map(l=>l.id);}

/** Metadata-only selection. The caller must explicitly prepare/prove the alternate pixels. */
export function textTreatmentSourceSelection(inventory:TextTreatmentInventory,beforeSource:TreatmentSource|null,choice:TextTreatmentChoice):{includedLayerIds:string[];excludedNativeIds:string[]} {
 validateTextTreatmentInventory(inventory);validateChoice(choice,inventory);if(beforeSource!==null)validateSource(beforeSource,inventory);
 const before=sourceIds(beforeSource),excluded=choice.kind==='native-overlay'?orderedNative(inventory,before.filter(id=>choice.retainedNativeIds.includes(id))):[];
 return {includedLayerIds:before.filter(id=>!excluded.includes(id)),excludedNativeIds:excluded};
}

/** Positive structural eligibility only; writer rechecks provenance, bytes and current stack. */
export function textTreatmentPlacementEligibility(inventory:TextTreatmentInventory,source:TreatmentSource|null,retainedNativeIds:readonly string[],requested:'current-document'|'new-document'):TreatmentPlacementEligibility {
 validateTextTreatmentInventory(inventory);if(source!==null)validateSource(source,inventory);ids(retainedNativeIds);
 for(const id of retainedNativeIds){const layer=inventory.layers.find(l=>l.id===id);if(!layer||layer.kind!=='text')fail('TEXT_TREATMENT_NATIVE_TARGET');if(!layer.visible||layer.locked)fail('TEXT_TREATMENT_NATIVE_HIDDEN_OR_LOCKED');}
 if(requested!=='current-document'&&requested!=='new-document')fail('TEXT_TREATMENT_PLACEMENT');
 if(requested==='new-document')return {eligible:true,kind:'new-document',reason:'explicit-new-document'};
 if(source===null)return {eligible:true,kind:'new-document',reason:'no-source'};
 if(source.capture===null)return {eligible:true,kind:'new-document',reason:'external-source'};
 const capture=source.capture;if(capture.layerIds.length>1)return {eligible:true,kind:'new-document',reason:'multiple-original-contributions'};
 if(capture.scope!=='single-layer')return {eligible:true,kind:'new-document',reason:'non-single-layer-source'};
 const stackIndex=inventory.layers.findIndex(l=>l.id===capture.layerIds[0]),layer=inventory.layers[stackIndex];
 if(!layer||layer.contribution===null)return {eligible:false,kind:'new-review-required',reason:'source-unavailable'};
 if(!layer.visible||layer.locked)return {eligible:false,kind:'new-review-required',reason:'source-hidden-or-locked'};
 if(retainedNativeIds.includes(layer.id))return {eligible:false,kind:'new-review-required',reason:'source-is-retained-native'};
 return {eligible:true,kind:'single-original-contribution',layerId:layer.id,layerVersion:layer.version,stackIndex,contribution:structuredClone(layer.contribution)};
}

function derive(input:TextTreatmentInput):Omit<TextTreatmentPlan,'fingerprint'> {
 exact(input,['id','inventory','choice','beforeSource','afterSource','prompt','edit']);
 if(!identifier(input.id))fail('TEXT_TREATMENT_ID');const {inventory,choice,beforeSource,afterSource,prompt,edit}=input;
 validateTextTreatmentInventory(inventory);validateChoice(choice,inventory);validatePrompt(prompt);
 if(prompt.mode==='composition-text'&&inventory.composition===null)fail('TEXT_TREATMENT_SEMANTIC_PROJECTION_REQUIRED');
 if(beforeSource!==null)validateSource(beforeSource,inventory);if(afterSource!==null)validateSource(afterSource,inventory);
 if(edit!==null){exact(edit,['effectiveMask','requestPlan']);ref(edit.effectiveMask,'application/x-ideogram-r16le');ref(edit.requestPlan,'application/json',65536);if(afterSource===null||edit.effectiveMask.byteLength!==String(inventory.grid.width*inventory.grid.height*2))fail('TEXT_TREATMENT_MASK');}
 const selected=textTreatmentSourceSelection(inventory,beforeSource,choice),afterIds=sourceIds(afterSource);
 if(!same(selected.includedLayerIds,afterIds))fail('TEXT_TREATMENT_SOURCE_SUBSET');
 if(selected.excludedNativeIds.length){
  if(afterSource===null&&selected.includedLayerIds.length||afterSource!==null&&sourceIdentity(beforeSource)===sourceIdentity(afterSource))fail('TEXT_TREATMENT_ALTERNATE_CAPTURE_REQUIRED');
  if(afterSource!==null&&afterSource.source.scope==='visible-document')fail('TEXT_TREATMENT_ALTERNATE_CAPTURE_REQUIRED');
 }else if(!same(beforeSource,afterSource))fail('TEXT_TREATMENT_UNREVIEWED_SOURCE_CHANGE');
 const includedSemantic=inventory.semanticText.filter(s=>!choice.excludedSemanticIds.includes(s.id));
 if(includedSemantic.length&&!semanticPrompt(prompt.mode))fail('TEXT_TREATMENT_SEMANTIC_PROJECTION_REQUIRED');
 for(const s of includedSemantic)for(const b of s.bindings){const l=inventory.layers.find(x=>x.id===b.layerId);if(!l||l.version!==b.reviewedLayerVersion||b.field==='text'&&(l.kind!=='text'||l.native!.literal.hash!==b.reviewedValue.hash||l.native!.literal.byteLength!==b.reviewedValue.byteLength))fail('TEXT_TREATMENT_SEMANTIC_LINK_STALE');}
 const retained=choice.kind==='native-overlay'?orderedNative(inventory,choice.retainedNativeIds):[],hide=choice.kind==='baked-lettering'?orderedNative(inventory,choice.allowedHideNativeIds):[];
 const rasterIncluded=orderedNative(inventory,afterIds),rasterExcluded=orderedNative(inventory,selected.excludedNativeIds);
 if(choice.kind==='native-overlay'&&rasterIncluded.some(id=>retained.includes(id)))fail('TEXT_TREATMENT_OVERLAY_SOURCE_DUPLICATION');
 if(choice.kind==='no-native-text'&&rasterIncluded.length)fail('TEXT_TREATMENT_NATIVE_INPUT_PRESENT');
 // Every still-included semantic literal remains explicit, even if linked to an excluded native layer.
 const subset={kind:'text-treatment-source-subset-1' as const,beforeSourceHash:sourceIdentity(beforeSource),afterSourceHash:sourceIdentity(afterSource),includedLayerIds:afterIds,excludedNativeIds:rasterExcluded,beforeLayerIds:sourceIds(beforeSource)};
 const stackFingerprint=hash(inventory),sourceSubset={...subset,fingerprint:hash({stackFingerprint,...subset})};
 const placement:TreatmentPlacementEligibility=choice.kind==='native-overlay'?textTreatmentPlacementEligibility(inventory,afterSource,retained,choice.placement):{eligible:false,kind:'adoption-review-required',reason:choice.kind==='baked-lettering'?'baked-lettering-placement':'ordinary-placement'};
 if(choice.kind==='native-overlay'&&choice.placement==='current-document'&&(!placement.eligible||placement.kind!=='single-original-contribution'))fail('TEXT_TREATMENT_NEW_DOCUMENT_REQUIRED');
 return {schemaVersion:1,kind:TEXT_TREATMENT_CONTRACT,id:input.id,inventory:structuredClone(inventory),choice:structuredClone(choice),beforeSource:structuredClone(beforeSource),afterSource:structuredClone(afterSource),prompt:structuredClone(prompt),edit:structuredClone(edit),stackFingerprint,sourceSubset,includedSemanticIds:includedSemantic.map(s=>s.id),excludedSemanticIds:inventory.semanticText.filter(s=>choice.excludedSemanticIds.includes(s.id)).map(s=>s.id),rasterIncludedNativeIds:rasterIncluded,rasterExcludedNativeIds:rasterExcluded,retainedNativeIds:retained,allowedHideNativeIds:hide,placement};
}

export function planTextTreatment(input:TextTreatmentInput):TextTreatmentPlan {const body=derive(input),result={...body,fingerprint:hash(body)};bounded(result);return result;}
export function validateTextTreatmentPlan(v:any):asserts v is TextTreatmentPlan {
 exact(v,['schemaVersion','kind','id','inventory','choice','beforeSource','afterSource','prompt','edit','stackFingerprint','sourceSubset','includedSemanticIds','excludedSemanticIds','rasterIncludedNativeIds','rasterExcludedNativeIds','retainedNativeIds','allowedHideNativeIds','placement','fingerprint']);
 const {id,inventory,choice,beforeSource,afterSource,prompt,edit}=v,expected=planTextTreatment({id,inventory,choice,beforeSource,afterSource,prompt,edit});
 if(!same(v,expected))fail('TEXT_TREATMENT_PLAN_IDENTITY');
}
/** Recheck in the writer transaction. A prior review never authorizes unlock, repair or rebinding. */
export function assertTextTreatmentFresh(plan:TextTreatmentPlan,current:TextTreatmentInventory):void {
 validateTextTreatmentPlan(plan);validateTextTreatmentInventory(current);
 if(hash(current)!==plan.stackFingerprint)fail('TEXT_TREATMENT_STALE');
}

/** Pure graph review before preparation. The caller still owes real comparison
 * pixels, retained-input proof and strict adoption validation after preparation. */
export function planTextTreatmentPlacement(plan:TextTreatmentPlan,current:TextTreatmentInventory,candidate:TreatmentPlacementCandidate,choice:TreatmentAdoptionChoice):TextTreatmentPlacementIntent {
 assertTextTreatmentFresh(plan,current);
 exact(candidate,['candidateId','grid','preparation','sourcePixels','effectiveMask']);grid(candidate.grid);
 if(!identifier(candidate.candidateId)||!['full-candidate','safe-region'].includes(candidate.preparation))fail('TEXT_TREATMENT_CANDIDATE');
 if(candidate.sourcePixels!==null)ref(candidate.sourcePixels,'application/x-ideogram-rgba8');if(candidate.effectiveMask!==null)ref(candidate.effectiveMask,'application/x-ideogram-r16le');
 if(candidate.preparation==='full-candidate'&&(candidate.sourcePixels!==null||candidate.effectiveMask!==null))fail('TEXT_TREATMENT_CANDIDATE');
 if(candidate.preparation==='safe-region'&&(candidate.sourcePixels===null||candidate.effectiveMask===null))fail('TEXT_TREATMENT_CANDIDATE');
 const {preservedExterior,...body}=placementBody('text-treatment-placement-intent-1',plan,current,candidate,choice);
 const intent={...body,requestedPreservation:preservedExterior};return {...intent,fingerprint:hash(intent)};
}

/** Pure proposed patch; acceptance still needs candidate safety/adoption proof and an atomic writer. */
export function planTextTreatmentAdoption(plan:TextTreatmentPlan,current:TextTreatmentInventory,candidate:TreatmentAdoptionCandidate,choice:TreatmentAdoptionChoice):TextTreatmentAdoptionDecision {
 assertTextTreatmentFresh(plan,current);
 exact(candidate,['candidateId','assetId','pixels','grid','preparation','preparationIdentity','sourcePixels','effectiveMask']);grid(candidate.grid);
 if(!identifier(candidate.candidateId)||!identifier(candidate.assetId)||!['full-candidate','safe-region'].includes(candidate.preparation))fail('TEXT_TREATMENT_CANDIDATE');
 ref(candidate.pixels,'application/x-ideogram-rgba8');ref(candidate.preparationIdentity,'application/json',65536);
 if(candidate.pixels.byteLength!==String(candidate.grid.width*candidate.grid.height*4))fail('TEXT_TREATMENT_CANDIDATE');
 if(candidate.sourcePixels!==null)ref(candidate.sourcePixels,'application/x-ideogram-rgba8');if(candidate.effectiveMask!==null)ref(candidate.effectiveMask,'application/x-ideogram-r16le');
 if(candidate.preparation==='full-candidate'&&(candidate.sourcePixels!==null||candidate.effectiveMask!==null))fail('TEXT_TREATMENT_CANDIDATE');
 if(candidate.preparation==='safe-region'&&(candidate.sourcePixels===null||candidate.effectiveMask===null))fail('TEXT_TREATMENT_CANDIDATE');
 const body=placementBody('text-treatment-adoption-decision-1',plan,current,candidate,choice);return {...body,fingerprint:hash(body)};
}

/** Both public contracts validate freshness and their exact candidate shape
 * before sharing graph decisions. This helper invents no prepared identity. */
function placementBody<C extends TreatmentPlacementCandidate,K extends TextTreatmentAdoptionDecision['kind']|TextTreatmentPlacementIntent['kind']>(kind:K,plan:TextTreatmentPlan,current:TextTreatmentInventory,candidate:C,choice:TreatmentAdoptionChoice,approvedMask:BlobRef|null=plan.edit?.effectiveMask??null) {
 exact(choice,['kind','action','approvalId','duplicationAcknowledgement','newLayerId','hideNativeIds','nativeCopies','preservation']);
 if(choice.kind!=='text-treatment-adoption-choice-1'||!['keep-native-overlay','hide-native-originals','keep-both','new-document'].includes(choice.action)||!identifier(choice.approvalId)||!identifier(choice.newLayerId)||!['none','single-original-contribution','full-visible-root'].includes(choice.preservation)||!(choice.duplicationAcknowledgement===null||identifier(choice.duplicationAcknowledgement)))fail('TEXT_TREATMENT_ADOPTION_CHOICE');
 ids(choice.hideNativeIds);if(!Array.isArray(choice.nativeCopies)||choice.nativeCopies.length>100)fail('TEXT_TREATMENT_NATIVE_COPIES');
 ids(choice.nativeCopies.map(x=>x?.sourceLayerId));ids([choice.newLayerId,...choice.nativeCopies.map(x=>x?.newLayerId)],100);
 if(choice.action==='keep-both'&&choice.duplicationAcknowledgement===null)fail('TEXT_TREATMENT_DUPLICATION_ACK');
 if(choice.action!=='hide-native-originals'&&choice.hideNativeIds.length||choice.action!=='new-document'&&choice.nativeCopies.length)fail('TEXT_TREATMENT_UNREVIEWED_VISIBILITY_CHANGE');
 if(choice.action==='hide-native-originals'&&!choice.hideNativeIds.length)fail('TEXT_TREATMENT_HIDE_TARGET_REQUIRED');
 for(const id of choice.hideNativeIds){const l=current.layers.find(x=>x.id===id);if(!l||l.kind!=='text'||!plan.allowedHideNativeIds.includes(id))fail('TEXT_TREATMENT_HIDE_NOT_REVIEWED');if(!l.visible||l.locked)fail('TEXT_TREATMENT_NATIVE_HIDDEN_OR_LOCKED');}
 const copiedNative:TextTreatmentAdoptionDecision['copiedNative']=[];
 for(const copy of choice.nativeCopies){
  exact(copy,['sourceLayerId','newLayerId','transform']);if(!Array.isArray(copy.transform)||copy.transform.length!==6||!copy.transform.every(Number.isFinite)||copy.transform[0]*copy.transform[3]-copy.transform[1]*copy.transform[2]===0)fail('TEXT_TREATMENT_COPY_TRANSFORM');
  const l=current.layers.find(x=>x.id===copy.sourceLayerId);if(!l||l.kind!=='text'||!l.visible||l.locked)fail('TEXT_TREATMENT_NATIVE_HIDDEN_OR_LOCKED');
  if(plan.choice.kind==='native-overlay'&&!plan.retainedNativeIds.includes(l.id))fail('TEXT_TREATMENT_COPY_NOT_REVIEWED');
  copiedNative.push({...structuredClone(copy),sourceStateHash:l.stateHash,...structuredClone(l.native!)});
 }
 const beforeOrder=current.layers.map(l=>({id:l.id,version:l.version,visible:l.visible}));
 let hiddenOriginalIds:string[]=[],afterOrder:TextTreatmentAdoptionDecision['afterOrder'];
 if(choice.action==='new-document'){
  if(choice.preservation!=='none')fail('TEXT_TREATMENT_NEW_DOCUMENT_NO_EQUALITY_CLAIM');
  if([choice.newLayerId,...choice.nativeCopies.map(x=>x.newLayerId)].some(id=>current.layers.some(l=>l.id===id)))fail('TEXT_TREATMENT_FRESH_LAYER_IDS_REQUIRED');
  afterOrder=[{id:choice.newLayerId,version:'1',visible:true},...choice.nativeCopies.map(x=>({id:x.newLayerId,version:'1',visible:true}))];
 }else{
  if(current.layers.some(l=>l.id===choice.newLayerId)||current.layers.length>=100)fail('TEXT_TREATMENT_NEW_LAYER_UNAVAILABLE');
  if(plan.choice.kind==='native-overlay'&&(plan.choice.placement!=='current-document'||choice.preservation!=='single-original-contribution'))fail('TEXT_TREATMENT_NEW_DOCUMENT_REQUIRED');
  let insertion=current.layers.length;
  if(choice.preservation!=='none'){
   const source=plan.afterSource;
   if(candidate.preparation!=='safe-region'||source===null||plan.edit===null||!same(candidate.grid,current.grid)||!same(candidate.sourcePixels,source.source.pixels)||!same(candidate.effectiveMask,approvedMask))fail('TEXT_TREATMENT_PRESERVATION_PROOF_REQUIRED');
   if(choice.preservation==='single-original-contribution'){
    const eligibility=textTreatmentPlacementEligibility(current,source,plan.retainedNativeIds,'current-document');
    if(!eligibility.eligible||eligibility.kind!=='single-original-contribution')fail('TEXT_TREATMENT_NEW_DOCUMENT_REQUIRED');
    hiddenOriginalIds=[eligibility.layerId];insertion=eligibility.stackIndex+1;
   }else{
    if(plan.choice.kind==='native-overlay'||source.capture?.scope!=='visible-document'||!same(sourceIds(source),current.layers.filter(l=>l.visible).map(l=>l.id)))fail('TEXT_TREATMENT_ROOT_OVERLAY_FORBIDDEN');
    hiddenOriginalIds=sourceIds(source);
   }
   for(const id of hiddenOriginalIds){const layer=current.layers.find(l=>l.id===id)!;if(!layer.visible||layer.locked)fail('TEXT_TREATMENT_NATIVE_HIDDEN_OR_LOCKED');if(layer.kind==='text'&&!choice.hideNativeIds.includes(id))fail('TEXT_TREATMENT_HIDE_NOT_REVIEWED');}
   if(choice.hideNativeIds.some(id=>!hiddenOriginalIds.includes(id)))fail('TEXT_TREATMENT_EXTRA_HIDE_BREAKS_PRESERVATION');
  }else hiddenOriginalIds=current.layers.filter(l=>choice.hideNativeIds.includes(l.id)).map(l=>l.id);
  afterOrder=beforeOrder.map(l=>hiddenOriginalIds.includes(l.id)?{...l,version:String(BigInt(l.version)+1n),visible:false}:structuredClone(l));
  afterOrder.splice(insertion,0,{id:choice.newLayerId,version:'1',visible:true});
 }
 return {kind,planHash:plan.fingerprint,approvalId:choice.approvalId,choice:structuredClone(choice),candidate:structuredClone(candidate),stackFingerprint:plan.stackFingerprint,sourceDocumentUnchanged:choice.action==='new-document',hiddenOriginalIds,beforeOrder,afterOrder,preservedExterior:choice.preservation,copiedNative};
}
/** Bind the original accepted treatment to an already proved clipping result.
 * This does not read M/M' and cannot establish that M' is a subset. Only the
 * writer's frozen clipping/replay proof or encoded review lease can do that. */
export function createTextTreatmentMaskSuccessor(plan:TextTreatmentPlan,bindings:TextTreatmentMaskSuccessorInputs,choice:TreatmentAdoptionChoice):TextTreatmentMaskSuccessor {
 validateTextTreatmentPlan(plan);validateTextTreatmentAdoptionChoice(choice);exact(bindings,['identity','requestPlan','outputMapping']);
 const {identity,requestPlan,outputMapping}=bindings;
 exact(identity,['candidateId','candidateVersion','documentId','jobId','attemptId','requestId','outputIdentity','preparedAssetId','preparedAssetVersion','preparedAssetHash','requestHash','jobVersion','writerEpoch']);
 for(const field of ['candidateId','documentId','jobId','attemptId','requestId','preparedAssetId'] as const)if(!identifier(identity[field]))fail('TEXT_TREATMENT_SUCCESSOR_IDENTITY');
 for(const field of ['candidateVersion','preparedAssetVersion','jobVersion','writerEpoch'] as const)if(!sequence(identity[field]))fail('TEXT_TREATMENT_SUCCESSOR_IDENTITY');
 for(const field of ['outputIdentity','preparedAssetHash','requestHash'] as const)if(!digest(identity[field]))fail('TEXT_TREATMENT_SUCCESSOR_IDENTITY');
 try{requireOutputMapping(requestPlan,outputMapping,outputMapping.actualOutput.width,outputMapping.actualOutput.height);}catch{fail('TEXT_TREATMENT_SUCCESSOR_MAPPING');}
 const requestRef={hash:hash(requestPlan),byteLength:String(new TextEncoder().encode(canonical(requestPlan)).byteLength),mediaType:'application/json'};
 if(!plan.edit||!plan.afterSource||identity.documentId!==plan.inventory.documentId||outputMapping.resolution!=='clipped-and-approved'||!same(requestRef,plan.edit.requestPlan)||!same(requestPlan.effectiveMask,plan.edit.effectiveMask)||!same(requestPlan.sourcePixels,plan.afterSource.source.pixels)||!same(requestPlan.document,plan.inventory.grid))fail('TEXT_TREATMENT_SUCCESSOR_PARENT');
 return {kind:'text-treatment-mask-successor-1',acceptedTreatmentPlan:textTreatmentPlanRef(plan),originalRequestPlan:structuredClone(plan.edit.requestPlan),originalEffectiveMask:structuredClone(plan.edit.effectiveMask),finalEffectiveMask:structuredClone(outputMapping.effectiveMask),candidateIdentityHash:hash(identity),outputMappingHash:hash(outputMapping),adoptionChoiceHash:hash(choice)};
}
function successorMask(plan:TextTreatmentPlan,candidate:TreatmentPlacementCandidate,choice:TreatmentAdoptionChoice,bindings:TextTreatmentMaskSuccessorInputs,witness:TextTreatmentMaskSuccessor):BlobRef {
 const expected=createTextTreatmentMaskSuccessor(plan,bindings,choice);
 if(!same(witness,expected)||candidate.candidateId!==bindings.identity.candidateId||candidate.preparation!=='safe-region'||!same(candidate.grid,plan.inventory.grid)||!same(candidate.sourcePixels,bindings.requestPlan.sourcePixels)||!same(candidate.effectiveMask,expected.finalEffectiveMask))fail('TEXT_TREATMENT_SUCCESSOR_IDENTITY');
 return expected.finalEffectiveMask;
}
export function planTextTreatmentSuccessorPlacement(plan:TextTreatmentPlan,current:TextTreatmentInventory,candidate:TreatmentPlacementCandidate,choice:TreatmentAdoptionChoice,bindings:TextTreatmentMaskSuccessorInputs,witness:TextTreatmentMaskSuccessor):TextTreatmentSuccessorPlacementIntent {
 assertTextTreatmentFresh(plan,current);exact(candidate,['candidateId','grid','preparation','sourcePixels','effectiveMask']);grid(candidate.grid);
 const approved=successorMask(plan,candidate,choice,bindings,witness),{preservedExterior,...body}=placementBody('text-treatment-placement-intent-1',plan,current,candidate,choice,approved);
 const intent={...body,kind:'text-treatment-successor-placement-intent-1' as const,requestedPreservation:preservedExterior,maskSuccessor:structuredClone(witness)};return {...intent,fingerprint:hash(intent)};
}
export function planTextTreatmentSuccessorAdoption(plan:TextTreatmentPlan,current:TextTreatmentInventory,candidate:TreatmentAdoptionCandidate,choice:TreatmentAdoptionChoice,bindings:TextTreatmentMaskSuccessorInputs,witness:TextTreatmentMaskSuccessor):TextTreatmentSuccessorAdoptionDecision {
 assertTextTreatmentFresh(plan,current);exact(candidate,['candidateId','assetId','pixels','grid','preparation','preparationIdentity','sourcePixels','effectiveMask']);grid(candidate.grid);
 if(!identifier(candidate.assetId))fail('TEXT_TREATMENT_CANDIDATE');ref(candidate.pixels,'application/x-ideogram-rgba8');ref(candidate.preparationIdentity,'application/json',65536);
 if(candidate.pixels.byteLength!==String(candidate.grid.width*candidate.grid.height*4))fail('TEXT_TREATMENT_CANDIDATE');
 const approved=successorMask(plan,candidate,choice,bindings,witness),body=placementBody('text-treatment-adoption-decision-1',plan,current,candidate,choice,approved);
 const decision={...body,kind:'text-treatment-successor-adoption-decision-1' as const,maskSuccessor:structuredClone(witness)};return {...decision,fingerprint:hash(decision)};
}
/** A successor can only be validated with its complete joined frozen inputs. */
export function validateTextTreatmentSuccessorAdoptionDecision(value:TextTreatmentSuccessorAdoptionDecision,plan:TextTreatmentPlan,current:TextTreatmentInventory,bindings:TextTreatmentMaskSuccessorInputs):void {
 const expected=planTextTreatmentSuccessorAdoption(plan,current,value.candidate,value.choice,bindings,value.maskSuccessor);if(!same(value,expected))fail('TEXT_TREATMENT_ADOPTION_IDENTITY');
}
export function validateTextTreatmentAdoptionDecision(value:TextTreatmentAdoptionDecision,plan:TextTreatmentPlan,current:TextTreatmentInventory):void {
 const expected=planTextTreatmentAdoption(plan,current,value.candidate,value.choice);
 if(!same(value,expected))fail('TEXT_TREATMENT_ADOPTION_IDENTITY');
}
export function validateRequestTextTreatmentEnvelope(v:any):asserts v is RequestTextTreatmentEnvelope {exact(v,['kind','plan','planHash']);ref(v.plan,'application/json',TEXT_TREATMENT_LIMITS.manifestBytes);if(v.kind!=='request-text-treatment-1'||!digest(v.planHash))fail('TEXT_TREATMENT_ENVELOPE');}
/** New plan objects are stored as canonical JSON. This proves the passed ref's exact bytes. */
function textTreatmentPlanRefValidated(plan:TextTreatmentPlan):BlobRef {return {hash:hash(plan),byteLength:String(new TextEncoder().encode(canonical(plan)).byteLength),mediaType:'application/json'};}
export function textTreatmentPlanRef(plan:TextTreatmentPlan):BlobRef {validateTextTreatmentPlan(plan);return textTreatmentPlanRefValidated(plan);}
export function bindTextTreatmentEnvelope(plan:TextTreatmentPlan,stored:BlobRef):RequestTextTreatmentEnvelope {if(!same(textTreatmentPlanRef(plan),stored))fail('TEXT_TREATMENT_ENVELOPE_BYTES');return {kind:'request-text-treatment-1',plan:structuredClone(stored),planHash:plan.fingerprint};}
export function assertTextTreatmentEnvelope(envelope:RequestTextTreatmentEnvelope,plan:TextTreatmentPlan):void {validateRequestTextTreatmentEnvelope(envelope);if(envelope.planHash!==plan.fingerprint||!same(envelope.plan,textTreatmentPlanRef(plan)))fail('TEXT_TREATMENT_ENVELOPE_IDENTITY');}
/** One plan-first check; no validation authority survives this synchronous call. */
export function assertTextTreatmentPlanEnvelope(envelope:RequestTextTreatmentEnvelope,plan:TextTreatmentPlan):asserts plan is TextTreatmentPlan {validateTextTreatmentPlan(plan);validateRequestTextTreatmentEnvelope(envelope);if(envelope.planHash!==plan.fingerprint||!same(envelope.plan,textTreatmentPlanRefValidated(plan)))fail('TEXT_TREATMENT_ENVELOPE_IDENTITY');}

export function textTreatmentProvenance(plan:TextTreatmentPlan):TextTreatmentProvenance {
 validateTextTreatmentPlan(plan);const nativeRows=(selected:readonly string[])=>plan.inventory.layers.filter(l=>selected.includes(l.id)).map(l=>({layerId:l.id,layerVersion:l.version,...structuredClone(l.native!)}));
 const included=plan.inventory.semanticText.filter(s=>plan.includedSemanticIds.includes(s.id)),excluded=plan.inventory.semanticText.filter(s=>plan.excludedSemanticIds.includes(s.id));
 return {kind:'text-treatment-provenance-1',planId:plan.id,planHash:plan.fingerprint,treatment:plan.choice.kind,stackFingerprint:plan.stackFingerprint,sourceSubsetFingerprint:plan.sourceSubset.fingerprint,rasterIncludedNative:nativeRows(plan.rasterIncludedNativeIds),rasterExcludedNative:nativeRows(plan.rasterExcludedNativeIds),retainedNative:nativeRows(plan.retainedNativeIds),allowedHideNative:nativeRows(plan.allowedHideNativeIds),includedSemantic:structuredClone(included),excludedSemantic:structuredClone(excluded),unlinkedIncludedSemanticIds:included.filter(s=>!s.bindings.some(b=>b.field==='text')).map(s=>s.id),placement:structuredClone(plan.placement),limitations:{metadataExclusionRemovesPixels:false,generatedLetteringGuaranteed:false,spellingGuaranteed:false,opaquePromptMayDescribeText:!semanticPrompt(plan.prompt.mode)}};
}

/** Direct immutable roots only: storage must traverse TextSource, composition, captures and plans. */
export function textTreatmentRefs(plan:TextTreatmentPlan):BlobRef[] {
 validateTextTreatmentPlan(plan);const refs:BlobRef[]=[plan.inventory.imageState,plan.prompt.bytes];
 if(plan.prompt.projection)refs.push(plan.prompt.projection);if(plan.inventory.composition)refs.push(plan.inventory.composition.value);
 for(const l of plan.inventory.layers){if(l.contribution)refs.push(l.contribution.manifest,l.contribution.pixels);if(l.native)refs.push(l.native.source,l.native.literal);}
 for(const s of plan.inventory.semanticText){refs.push(s.literal,s.description);if(s.bounds)refs.push(s.bounds);for(const b of s.bindings)refs.push(b.reviewedValue);}
 for(const s of [plan.beforeSource,plan.afterSource])if(s){refs.push(s.source.blob,s.source.pixels);if(s.source.capture)refs.push(s.source.capture);if(s.capture)refs.push(s.capture.image.state);}
 if(plan.edit)refs.push(plan.edit.effectiveMask,plan.edit.requestPlan);
 const unique=new Map<string,BlobRef>();for(const value of refs)unique.set(canonical(value),value);return [...unique.values()].map(value=>structuredClone(value));
}

/** Explicit review intent; baseline proves the full visible stack, never changes source selection. */
export type TextTreatmentReviewIntent={kind:'text-treatment-review-intent-1';choice:TextTreatmentChoice;baseline:Source|null;beforeSource:Source|null};

/** Command shape only; plan/candidate/current-state authority is checked by adoption. */
export function validateTextTreatmentAdoptionChoice(choice:any):asserts choice is TreatmentAdoptionChoice {
 exact(choice,['kind','action','approvalId','duplicationAcknowledgement','newLayerId','hideNativeIds','nativeCopies','preservation']);
 if(choice.kind!=='text-treatment-adoption-choice-1'||!['keep-native-overlay','hide-native-originals','keep-both','new-document'].includes(choice.action)||!identifier(choice.approvalId)||!identifier(choice.newLayerId)||!['none','single-original-contribution','full-visible-root'].includes(choice.preservation)||!(choice.duplicationAcknowledgement===null||identifier(choice.duplicationAcknowledgement)))fail('TEXT_TREATMENT_ADOPTION_CHOICE');
 ids(choice.hideNativeIds);if(!Array.isArray(choice.nativeCopies)||choice.nativeCopies.length>100)fail('TEXT_TREATMENT_NATIVE_COPIES');
 ids(choice.nativeCopies.map((copy:any)=>copy?.sourceLayerId));ids([choice.newLayerId,...choice.nativeCopies.map((copy:any)=>copy?.newLayerId)],100);
 for(const copy of choice.nativeCopies){exact(copy,['sourceLayerId','newLayerId','transform']);if(!Array.isArray(copy.transform)||copy.transform.length!==6||!copy.transform.every(Number.isFinite)||copy.transform[0]*copy.transform[3]-copy.transform[1]*copy.transform[2]===0)fail('TEXT_TREATMENT_COPY_TRANSFORM');}
}
