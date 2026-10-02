// Source fixture for the promoted integration. Not executed in the staging campaign.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as v4 from '../../dist/local/src/request/core.js';
import * as family from '../../dist/local/src/request/family.js';
import {providerReviewV45,verifyRequestReviewV45,validateRequestReviewV45Identity} from '../../dist/local/src/request/review.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {emptyComposition,serialize} from '../../dist/local/src/composition/core.js';
import {exportCompositionText} from '../../dist/local/src/composition/text-export.js';
import {resolveV45Generate,newV45GenerateFields} from '../../dist/local/src/request/v45.js';
const text=' {"lettering":"Café 東京", "raw":true} \n';
const ref=(value,mediaType='text/plain')=>({hash:v4.hash(value),byteLength:String(Buffer.byteLength(value)),mediaType});
const validateRequestReviewV45=value=>verifyRequestReviewV45(value,text);
const make=()=>({...family.newV45Draft(ref(text),'raw'),guidanceAcknowledged:true,rewriteAcknowledged:true});

test('V4 factories, identities and resolved wire bytes stay in their original family',()=>{
 const draft=v4.newDraft(ref(text));draft.guidanceAcknowledged=true;draft.rewriteAcknowledged=true;draft.prompt.mode='raw';draft.fields.seed='-900719925474099312345';
 const serialized=canonical(draft),legacy=v4.resolve(draft,text),resolved=family.resolve(draft,text);
 family.draftShape(draft);assert.equal(canonical(draft),serialized);assert.deepEqual(resolved,legacy);assert.equal(family.bodyTemplate(resolved,text),v4.bodyTemplate(legacy,text));assert.deepEqual(family.refs(draft),v4.refs(draft));assert.deepEqual(family.operations.slice(0,8),v4.operations);assert.deepEqual(family.newDraft(ref(text)),v4.newDraft(ref(text)));
});
test('new family defaults never inherit V4 fields or approvals',()=>{
 const draft=make();family.draftShape(draft);assert.equal(draft.kind,'request-draft-v45-1');assert.equal(draft.operation,'generate-v45');assert.deepEqual(draft.fields,{quality:'medium',promptExpansion:'enabled',count:'1',seed:'',size:'square_hd',width:'1024',height:'1024'});
 for(const forbidden of ['source','mask','adapters','inactive','conversion'])assert(!Object.hasOwn(draft,forbidden));
 assert.throws(()=>v4.draftShape(draft));assert.deepEqual(family.refs(draft),[ref(text)]);
});
for(const mutate of [d=>d.kind='request-draft-2',d=>d.operation='generate',d=>d.fields.expansion='Medium',d=>d.source=null,d=>d.prompt.mode='composition',d=>d.prompt.projection={},d=>delete d.fields.seed])test('strict discriminated draft rejects cross-family fields without rewriting them',()=>{const draft=make();mutate(draft);const before=structuredClone(draft);assert.throws(()=>family.draftShape(draft));assert.deepEqual(draft,before);});
test('unfinished field strings survive persistence and produce a field-targetable resolution error',()=>{const draft=make();draft.fields.count='1?';const before=canonical(draft);family.draftShape(draft);assert.throws(()=>family.resolve(draft,text),error=>error instanceof v4.RequestError&&error.issues[0].field==='count');assert.equal(canonical(draft),before);});
test('reviewed generation preserves exact prompt mode, bytes and integer seed without V4 wire fields',()=>{
 const draft=make();draft.fields.seed='900719925474099312345678901';const request=family.resolve(draft,text),wire=family.bodyTemplate(request,text);family.validateV45Request(request);
 assert.equal(request.settings.prompt.mode,'raw');assert.deepEqual(request.settings.prompt.text,ref(text));assert.equal(request.modelRequest.promptMode,'raw');assert(!Object.hasOwn(request.modelRequest.body,'prompt'));assert(!Object.hasOwn(request.modelRequest,'seed'));assert.equal(JSON.parse(wire).prompt,text);assert(wire.includes('"seed":900719925474099312345678901'));assert(!wire.includes('"seed":"'));
 assert.deepEqual(Object.keys(JSON.parse(wire)).sort(),['prompt','image_size','quality','enable_prompt_expansion','num_images','sync_mode','seed'].sort());assert.equal(request.modelRequest.safetyAdmission,'blocked-unavailable-evidence');assert.throws(()=>family.resolve(draft,text+' '));assert.throws(()=>family.bodyTemplate(request,text+' '));
});
for(const mutate of [r=>r.settings.count=4,r=>r.modelRequest.promptMode='plain',r=>r.modelRequest.estimate.cents=0,r=>r.modelRequest.safetyAdmission='safe',r=>r.modelRequest.body.enable_safety_checker=true])test('resolved envelope rejects forged duplicate and derived identities',()=>{const request=family.resolve(make(),text);mutate(request);assert.throws(()=>family.validateV45Request(request));});
function reviewed(){const request=family.resolve(make(),text),route=family.requestRoute(request),wire=family.bodyTemplate(request,text),value={kind:'request-review-v45-1',id:'review',owner:v4.hash('owner'),draft:{sessionId:'session',draftId:'draft',generation:'2'},draftAsset:'draft-asset',documentId:'document',documentRevision:'7',request,endpoint:route.endpoint,schemaHash:route.schemaHash,routeHash:v4.hash(canonical(route)),dependencyHash:v4.hash('dependencies'),template:ref(wire,'application/json'),prompt:ref(text),conversion:null,inactive:{},destination:'retained-candidates',privacy:'minimum-retention-unqualified',estimate:request.modelRequest.estimate,providerReview:providerReviewV45(request),dispatch:false};return {...value,token:v4.hash(canonical(value))};}
test('immutable provider review binds unavailable safety and has no privacy or dispatch grant',()=>{const review=reviewed();validateRequestReviewV45(review);assert.equal(review.providerReview.resultContract,'ideogram-v45-result-1');assert.equal(review.providerReview.privacyProfile,null);assert.deepEqual(review.providerReview.admission,{policy:'unknown-withheld-1',state:'blocked',reason:'provider-safety-evidence-unavailable',ordinaryDisplay:false,adoption:false,export:false});assert.equal(review.dispatch,false);});
for(const mutate of [r=>r.kind='request-review-1',r=>r.providerReview.resultContract='ideogram-v4-result-1',r=>r.providerReview.admission.state='allowed',r=>r.providerReview.privacyProfile={id:'trusted'},r=>r.schemaHash=v4.hash('other'),r=>r.request.settings.prompt.mode='plain',r=>r.request.settings.seed={kind:'integer',decimal:'9'},r=>r.request.settings.prompt.text=ref('other'),r=>r.documentRevision='8'])test('tampering with a frozen v4.5 review never grants authority',()=>{const review=reviewed();mutate(review);assert.throws(()=>validateRequestReviewV45(review));});
test('even a recomputed token cannot relabel the provider admission profile',()=>{const review=reviewed();review.providerReview.admission.ordinaryDisplay=true;review.providerReview.admissionHash=v4.hash(canonical(review.providerReview.admission));const {token,...value}=review;review.token=v4.hash(canonical(value));assert.throws(()=>validateRequestReviewV45(review));});
test('a recomputed token cannot bind a different stored template to the reviewed request',()=>{const review=reviewed();review.template=ref('{}','application/json');const {token,...value}=review;review.token=v4.hash(canonical(value));assert.throws(()=>validateRequestReviewV45(review));});

test('new family retains raw disclosure policy without inheriting the V4 expansion guide claim',()=>{const draft=family.newV45Draft(ref(text),'raw');assert.throws(()=>family.resolve(draft,text),/OPAQUE_ACK/);draft.guidanceAcknowledged=true;assert.throws(()=>family.resolve(draft,text),/REWRITE_ACK/);draft.rewriteAcknowledged=true;family.resolve(draft,text);const plain=family.newV45Draft(ref(text));plain.fields.promptExpansion='disabled';family.resolve(plain,text);assert.throws(()=>family.resolve(family.newV45Draft(ref(' \n')), ' \n'),/EMPTY_PROMPT/);});

test('ref-only review admits exact 10000 control or Unicode scalars and one maximum-length seed without growing control records',()=>{
 for(const prompt of ['A'+'\u0001'.repeat(9999),'𠮷'.repeat(10000)]){
  const draft=family.newV45Draft(ref(prompt));draft.fields.seed='9'.repeat(16384);const request=family.resolve(draft,prompt),wire=family.bodyTemplate(request,prompt);family.validateV45Request(request);
  assert.equal(JSON.parse(wire).prompt,prompt);assert(wire.includes('"seed":'+'9'.repeat(16384)));assert.equal(request.settings.seed.decimal.length,16384);assert(!Object.hasOwn(request.modelRequest,'seed'));assert(!Object.hasOwn(request.modelRequest.body,'prompt'));
  const value=reviewed();value.request=request;value.prompt=ref(prompt);value.template=ref(wire,'application/json');value.estimate=request.modelRequest.estimate;value.providerReview=providerReviewV45(request);const {token,...binding}=value;value.token=v4.hash(canonical(binding));
  assert(Buffer.byteLength(canonical(value))<60000);verifyRequestReviewV45(value,prompt);assert.throws(()=>verifyRequestReviewV45(value,prompt+' '));
 }
});
test('structural response identity validation never substitutes for exact template verification',()=>{const review=reviewed();review.template=ref('{}','application/json');const {token,...binding}=review;review.token=v4.hash(canonical(binding));validateRequestReviewV45Identity(review);assert.throws(()=>verifyRequestReviewV45(review,text));assert.equal(review.providerReview.admission.ordinaryDisplay,false);});
test('frozen seed limit matches the saved draft limit',()=>{const request=family.resolve(make(),text);request.settings.seed={kind:'integer',decimal:'9'.repeat(16385)};assert.throws(()=>family.validateV45Request(request));});

test('new sole prompt or seed identities are structural but cannot reuse a reviewed wire template',()=>{
 for(const field of ['prompt','seed']){
  const review=reviewed();
  if(field==='prompt'){review.request.settings.prompt.text=ref('other');review.prompt=ref('other');}
  else review.request.settings.seed={kind:'integer',decimal:'9'};
  family.validateV45Request(review.request);
  const {token,...binding}=review;review.token=v4.hash(canonical(binding));validateRequestReviewV45Identity(review);
  assert.throws(()=>verifyRequestReviewV45(review,field==='prompt'?'other':text));
 }
});

function exportedCompositionPrompt(){
 const c=emptyComposition(1024,1024,'composition-text-source');c.scene='Café 東京 under a blue sky';c.background='Quiet hillside';c.request.operation='Generate with Ideogram v4.5';
 const caption=serialize(c,[],{});c.review={serializer:'caption-json-1',sourceId:c.id,frame:structuredClone(c.frame),request:structuredClone(c.request),dependencies:caption.dependencies,boxes:caption.boxes,prompt:ref(caption.prompt)};
 const exported=exportCompositionText(c,[],{});return {text:exported.prompt,prompt:{mode:'plain',text:ref(exported.prompt),projection:exported.review,composition:{id:c.id,value:ref(JSON.stringify(c),'application/json'),bindings:{}}}};
}
test('explicit Composition text export retains its review and source closure while using ordinary V4.5 plain wire bytes',()=>{
 const exported=exportedCompositionPrompt(),draft=family.newV45Draft(exported.prompt.text);draft.prompt=exported.prompt;const before=structuredClone(draft);
 family.draftShape(draft);const request=family.resolve(draft,exported.text);family.validateV45Request(request);
 assert.deepEqual(request.settings.prompt,exported.prompt);assert.deepEqual(draft,before);assert.equal(request.modelRequest.promptMode,'plain');
 assert.deepEqual(family.refs(draft),[exported.prompt.text,exported.prompt.composition.value,exported.prompt.projection.sourceProjection.prompt]);
 const plain=family.newV45Draft(exported.prompt.text),plainRequest=family.resolve(plain,exported.text);
 assert.equal(family.bodyTemplate(request,exported.text),family.bodyTemplate(plainRequest,exported.text));assert.equal(JSON.parse(family.bodyTemplate(request,exported.text)).prompt,exported.text);
 assert.throws(()=>family.bodyTemplate(request,exported.text+' '),/PROMPT_BYTES/);
});
for(const [label,change] of [
 ['raw mode',p=>p.mode='raw'],['direct composition mode',p=>p.mode='composition'],['missing origin',p=>p.composition=null],['missing review',p=>p.projection=null],
 ['foreign source ID',p=>p.composition.id='foreign'],['foreign source projection',p=>p.projection.sourceProjection.sourceId='foreign'],
 ['different exported bytes',p=>p.projection.prompt=ref('different')],['unknown serializer',p=>p.projection.serializer='caption-json-1'],
 ['authority field',p=>p.projection.dispatch=true],['non-JSON origin',p=>p.composition.value.mediaType='text/plain'],
])test('Composition text origin rejects '+label+' in saved and frozen generation without mutating input',()=>{
 const exported=exportedCompositionPrompt(),draft=family.newV45Draft(exported.prompt.text);draft.prompt=exported.prompt;
 const request=family.resolve(draft,exported.text);change(draft.prompt);change(request.settings.prompt);const before=structuredClone(draft),frozen=structuredClone(request);
 assert.throws(()=>family.draftShape(draft));assert.throws(()=>family.validateV45Request(request));assert.deepEqual(draft,before);assert.deepEqual(request,frozen);
});
test('local text export does not enable direct Composition mode in the V4.5 generation contract',()=>{
 assert.throws(()=>resolveV45Generate({operation:'generate-v45',prompt:'a caption',promptMode:'composition',fields:newV45GenerateFields()}));
});
