// Staged source fixtures; execution belongs to the coordinated root gate.
import test from 'node:test';import assert from 'node:assert/strict';
import {newV45EditDraft,draftShape,resolve,bodyTemplate,validateV45Request,hash,refs} from '../../dist/local/src/request/family.js';
import {bindRequestMask,confirmRequestMask} from '../../dist/local/src/request/core.js';
import {emptyComposition,serialize} from '../../dist/local/src/composition/core.js';
import {exportCompositionText} from '../../dist/local/src/composition/text-export.js';
import {resolveV45Edit} from '../../dist/local/src/request/v45-edit.js';
const text='Keep Café 東京 exactly';
const ref=(label,mediaType='application/json',byteLength='32')=>({hash:hash(label),byteLength,mediaType});
const source=(name)=>({assetId:name,version:'1',blob:ref(name+'png','image/png'),pixels:ref(name+'rgba','application/x-ideogram-rgba8','64'),width:8,height:2,scope:'single-layer',documentRevision:'1',capture:ref(name+'capture')});
const prepared=(name,pixels)=>({blob:ref(name+'png','image/png'),pixels:structuredClone(pixels),manifest:ref(name+'manifest'),pixelIdentity:hash(name+'identity'),width:8,height:2});
function fixture(masked=false){
 const draft=newV45EditDraft(ref(text,'text/plain',String(Buffer.byteLength(text))),masked?'inpaint-v45':'transform-v45');draft.source=source('source');draft.references=[source('reference'),source('reference')];const raster=prepared('input',draft.source.pixels);
 let mask=null;if(masked){const author=ref('hard','application/x-ideogram-r16le','32'),effective=ref('effective','application/x-ideogram-r16le','32');draft.mask={assetId:'mask',version:'1',blob:ref('white','image/png'),pixels:ref('whitergba','application/x-ideogram-rgba8','64'),width:8,height:2,sourceHash:draft.source.pixels.hash,polarity:'white-edit',empty:false,full:false,fullAcknowledged:false,plan:ref('authoring'),binding:bindRequestMask(draft.source)};draft.mask.requestPlan=confirmRequestMask(draft.source,draft.mask,author,effective,'approval');mask={...prepared('black',ref('blackrgba','application/x-ideogram-rgba8','64')),polarity:'black-edit',sourcePixels:structuredClone(raster.pixels),editPixels:4,keepPixels:12};}
 draft.preparedInputs={assetId:'inputs',version:'1',manifest:raster.manifest,source:raster,mask,references:draft.references.map((r,i)=>prepared('ref'+i,r.pixels))};return draft;
}
for(const masked of [false,true])test('versioned edit draft resolves exact original identities and prepared provider inputs',()=>{const draft=fixture(masked),before=structuredClone(draft);draftShape(draft);const request=resolve(draft,text);validateV45Request(request);assert.deepEqual(request.source,draft.source);assert.deepEqual(request.references,draft.references);assert.deepEqual(request.preparedInputs,draft.preparedInputs);assert.equal(Object.hasOwn(request,'mask'),masked);assert(!Object.hasOwn(request.modelRequest,'source'));assert(!Object.hasOwn(request.modelRequest,'seed'));assert(!Object.hasOwn(request.modelRequest.body,'prompt'));const wire=JSON.parse(bodyTemplate(request,text));assert.equal(wire.edit_precision,masked?'high':'regular');assert.equal(wire.quality,'medium');assert.equal(wire.image_size,'auto');assert.deepEqual(wire.reference_image_urls,draft.preparedInputs.references.map(r=>'asset:'+r.blob.hash));if(masked)assert.equal(wire.mask_url,'asset:'+draft.preparedInputs.mask.blob.hash);assert.deepEqual(draft,before);assert(refs(draft).some(r=>r.hash===draft.preparedInputs.manifest.hash));});
for(const change of [d=>d.preparedInputs=null,d=>d.source=null,d=>d.fields.precision='very_high',d=>d.fields.quality='high',d=>d.references.reverse(),d=>d.preparedInputs.references.pop(),d=>d.preparedInputs.source.pixels=ref('changed','application/x-ideogram-rgba8','64')])test('ineligible edit fields and changed prepared byte grids never silently repair the draft',()=>{const draft=fixture();draft.references[1]=source('different-reference');draft.preparedInputs.references[1]=prepared('different-ref',draft.references[1].pixels);change(draft);const before=structuredClone(draft);assert.throws(()=>resolve(draft,text));assert.deepEqual(draft,before);});
test('unprepared editable input is retained but cannot be reviewed as a model request',()=>{const draft=newV45EditDraft(ref(text,'text/plain',String(Buffer.byteLength(text))),'inpaint-v45');draft.fields.width='unfinished';draftShape(draft);assert.equal(draft.preparedInputs,null);assert.throws(()=>resolve(draft,text),/SOURCE_REQUIRED/);});
test('masked operation does not borrow regular precision, output sizes or grayscale preview bytes',()=>{for(const mutate of [d=>d.fields.precision='regular',d=>d.fields.size='square_hd',d=>d.preparedInputs.mask=null,d=>d.preparedInputs.mask.polarity='white-edit',d=>d.preparedInputs.mask.editPixels=0,d=>d.preparedInputs.mask.sourcePixels=ref('other','application/x-ideogram-rgba8','64')]){const draft=fixture(true);mutate(draft);assert.throws(()=>resolve(draft,text));}});
test('edit raw mode needs the app acknowledgment and never gains wire safety fields',()=>{const draft=fixture();draft.prompt.mode='raw';assert.throws(()=>resolve(draft,text),/OPAQUE_ACK/);draft.guidanceAcknowledged=true;const wire=JSON.parse(bodyTemplate(resolve(draft,text),text));assert(!Object.hasOwn(wire,'enable_safety_checker'));assert(!Object.hasOwn(wire,'output_format'));});

function textRef(value,mediaType='text/plain'){return {hash:hash(value),byteLength:String(Buffer.byteLength(value)),mediaType};}
function exportedEditPrompt(operation){
 const c=emptyComposition(8,2,'edit-composition-source');c.scene='Keep Café 東京 exactly';c.request.operation=operation==='inpaint-v45'?'Edit masked region with Ideogram v4.5':'Transform with Ideogram v4.5';
 const caption=serialize(c,[],{});c.review={serializer:'caption-json-1',sourceId:c.id,frame:structuredClone(c.frame),request:structuredClone(c.request),dependencies:caption.dependencies,boxes:caption.boxes,prompt:textRef(caption.prompt)};
 const exported=exportCompositionText(c,[],{});return {text:exported.prompt,prompt:{mode:'plain',text:textRef(exported.prompt),projection:exported.review,composition:{id:c.id,value:textRef(JSON.stringify(c),'application/json'),bindings:{}}}};
}
for(const masked of [false,true])test('V4.5 '+(masked?'masked':'transform')+' edit preserves explicit Composition text provenance without changing plain wire bytes',()=>{
 const draft=fixture(masked),exported=exportedEditPrompt(draft.operation);draft.prompt=exported.prompt;const before=structuredClone(draft);
 draftShape(draft);const request=resolve(draft,exported.text);validateV45Request(request);assert.deepEqual(draft,before);assert.deepEqual(request.settings.prompt,exported.prompt);
 const plain=structuredClone(draft);plain.prompt={mode:'plain',text:exported.prompt.text,projection:null,composition:null};
 assert.equal(bodyTemplate(request,exported.text),bodyTemplate(resolve(plain,exported.text),exported.text));
 const dependencies=refs(draft);assert.deepEqual(dependencies.slice(0,3),[exported.prompt.text,exported.prompt.composition.value,exported.prompt.projection.sourceProjection.prompt]);assert(dependencies.some(r=>r.hash===draft.preparedInputs.manifest.hash));
 assert.throws(()=>bodyTemplate(request,exported.text+' '),/PROMPT_BYTES/);
 assert.throws(()=>resolveV45Edit({operation:draft.operation,prompt:exported.text,promptMode:'composition',fields:draft.fields,source:draft.preparedInputs.source,mask:draft.preparedInputs.mask,references:draft.preparedInputs.references}));
});
for(const change of [p=>p.mode='raw',p=>p.composition=null,p=>p.projection=null,p=>p.composition.id='other',p=>p.projection.sourceProjection.sourceId='other',p=>p.projection.prompt=textRef('changed')])test('V4.5 edit uses the same strict exported-prompt validation for saved drafts and frozen requests',()=>{
 const draft=fixture(),exported=exportedEditPrompt(draft.operation);draft.prompt=exported.prompt;const request=resolve(draft,exported.text);
 change(draft.prompt);change(request.settings.prompt);const before=structuredClone(draft),frozen=structuredClone(request);
 assert.throws(()=>draftShape(draft));assert.throws(()=>validateV45Request(request));assert.deepEqual(draft,before);assert.deepEqual(request,frozen);
});
