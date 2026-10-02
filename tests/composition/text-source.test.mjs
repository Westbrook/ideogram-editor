import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {emptyComposition,emptyElement,linkField,serialize} from '../../dist/local/src/composition/core.js';
import {exportCompositionText} from '../../dist/local/src/composition/text-export.js';
import {newV45Draft,resolve as resolveRequest,bodyTemplate} from '../../dist/local/src/request/family.js';
import {providerReviewV45} from '../../dist/local/src/request/review.js';
import {newDraft,RequestError} from '../../dist/local/src/request/core.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {readCompositionTextSource,compositionTextOriginRefs,assertCurrentCompositionText as checkCurrentCompositionText} from '../../dist/local/server/storage/composition-text.js';
import {AssetRejection} from '../../dist/local/server/storage/assets.js';
import {StoreError} from '../../dist/local/server/storage/errors.js';
import {portableRequestRecord,verifyPortableRequest} from '../../dist/local/server/portable/candidates.js';

import {CompositionMemory} from '../../dist/local/server/storage/composition-memory.js';
let memory;memory=new CompositionMemory(()=>memory.bytes,()=>0);
const assertCurrentCompositionText=(...args)=>checkCurrentCompositionText(...args,memory);
test.afterEach(()=>assert.equal(memory.bytes,0));

const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const evidenceMismatch=error=>error instanceof AssetRejection&&error.code==='INVALID_INPUT'&&error.reason==='COMPOSITION_TEXT_EVIDENCE_MISMATCH';
const currentMismatch=error=>error instanceof RequestError&&error.issues.length===1&&error.issues[0].field==='prompt'&&error.issues[0].code==='COMPOSITION_TEXT_CHANGED';
function fixture({linked=false,text=false,excluded=false}={}){
 const objects=new Map(),reads=[];
 const put=(value,mediaType='application/json')=>{const bytes=Buffer.from(value),ref={hash:digest(bytes),byteLength:String(bytes.length),mediaType};objects.set(ref.hash,bytes);return ref;};
 // Model the object-store reader's immutable hash/length contract. The helper
 // separately proves semantic evidence; it does not replace object verification.
 const read=ref=>{reads.push(structuredClone(ref));const bytes=objects.get(ref.hash);if(!bytes)throw new StoreError('MISSING_OBJECT');if(String(bytes.length)!==ref.byteLength||digest(bytes)!==ref.hash)throw new StoreError('CORRUPT_OBJECT');return Uint8Array.from(bytes);};
 const c=emptyComposition(1024,1024,'source_composition');c.scene='Café 東京';
 const e=emptyElement(text?'text':'obj','element_1');e.desc.value='Retained description';e.text.value='A literal heading';e.excluded=excluded;
 const layer={id:'logical_layer',version:'7',kind:text?'text':'image',text:'Exact native text',appearance:'Exact native appearance',bounds:{rect:[0,0,80,40],transform:[1,0,0,1,12,16]}};
 const bindings=linked?{logical_layer:'physical_layer'}:{};
 if(linked){if(text)e.text=linkField('text-content',layer);else e.desc=linkField('appearance-description',layer);e.bounds=linkField('frame-bounds',layer);}
 c.elements=[e];
 const raw=put(Buffer.from([0xff,0,10,0xc3]),'application/octet-stream');c.raw=[raw,structuredClone(raw)];
 const live={...layer,id:'physical_layer'},projection=serialize(c,linked?[live]:[],bindings);
 c.review={serializer:'caption-json-1',sourceId:c.id,frame:structuredClone(c.frame),request:structuredClone(c.request),dependencies:projection.dependencies,boxes:projection.boxes,prompt:put(projection.prompt,'text/plain')};
 const exported=exportCompositionText(c,linked?[live]:[],bindings),prompt={mode:'plain',text:put(exported.prompt,'text/plain'),projection:exported.review,composition:{id:c.id,value:put(canonical(c)),bindings}};
 const draft=newV45Draft(prompt.text);draft.prompt=structuredClone(prompt);
 const source=text?put(canonical({text:{frame:{width:80,height:40},textUtf8:put(layer.text,'text/plain')}})):null;
 const imageLayer={id:'physical_layer',version:layer.version,name:'Current layer',assetId:'layer_asset',kind:layer.kind,layerToDocument:layer.bounds.transform,opacity:1,visible:true,locked:false,appearanceDescription:layer.appearance,blend:'normal',mask:null,...(text?{source}:{})};
 const state={schemaVersion:5,width:1024,height:1024,composition:structuredClone(prompt.composition),layers:linked?[imageLayer]:[]};
 const asset=id=>id==='layer_asset'?{id,raster:{width:80,height:40}}:null;
 return {c,raw,exported,prompt,draft,state,objects,reads,put,read,asset};
}

test('plain/raw V45 prompts and V4 drafts never read Composition evidence or current layers',()=>{
 const f=fixture(),never=()=>{throw Error('Unexpected retained-source read');};
 for(const mode of ['plain','raw']){const draft=newV45Draft(f.prompt.text,mode);assert.equal(readCompositionTextSource(draft.prompt,never),null);assert.deepEqual(compositionTextOriginRefs(draft,never),[]);assert.doesNotThrow(()=>assertCurrentCompositionText(draft,null,never,never));}
 const legacy=newDraft(f.c.review.prompt);legacy.prompt={mode:'composition',text:f.c.review.prompt,projection:f.c.review,composition:f.prompt.composition};
 assert.deepEqual(compositionTextOriginRefs(legacy,never),[]);assert.doesNotThrow(()=>assertCurrentCompositionText(legacy,null,never,never));
});

test('frozen source returns exact prose and deduplicated graph, source projection and opaque raw leaves',()=>{
 const f=fixture(),before=canonical(f.prompt),result=readCompositionTextSource(f.prompt,f.read);
 assert.deepEqual(result.composition,f.c);assert.equal(result.prompt,f.exported.prompt);assert.equal(canonical(f.prompt),before);
 assert.deepEqual(result.refs,[f.prompt.composition.value,f.prompt.text,f.raw,f.c.review.prompt]);
 assert.deepEqual(f.reads,[f.prompt.composition.value,f.c.review.prompt,f.prompt.text]);
 assert.deepEqual(compositionTextOriginRefs(f.draft,f.read),result.refs);
 assert(!result.prompt.includes(f.raw.hash));assert(!result.prompt.includes('high_level_description'));
});

test('origin closure deduplicates exact refs without collapsing distinct media interpretations',()=>{
 const f=fixture(),otherMedia={...f.c.review.prompt,mediaType:'application/octet-stream'};
 f.c.raw.push(otherMedia);f.prompt.composition.value=f.put(canonical(f.c));f.draft.prompt=structuredClone(f.prompt);
 const refs=compositionTextOriginRefs(f.draft,f.read);assert.equal(refs.length,5);assert(refs.some(ref=>canonical(ref)===canonical(otherMedia)));assert(refs.some(ref=>canonical(ref)===canonical(f.c.review.prompt)));
});

test('frozen source and raw origin closure survive absent current Composition without creating review authority',()=>{
 const f=fixture({linked:true});f.state.composition=null;f.state.layers=[];
 assert.equal(readCompositionTextSource(f.prompt,f.read).prompt,f.exported.prompt);assert(compositionTextOriginRefs(f.draft,f.read).some(ref=>canonical(ref)===canonical(f.raw)));
 assert.throws(()=>assertCurrentCompositionText(f.draft,f.state,f.read,f.asset),currentMismatch);
});

test('source identity, complete projection review and exact exported bytes are independently checked',()=>{
 const mutations=[
  f=>{f.prompt.composition.id='different';},
  f=>{f.prompt.projection.sourceId='different';},
  f=>{f.prompt.projection.sourceProjection.prompt=f.put('invented source JSON','text/plain');},
  f=>{f.prompt.projection.sourceProjection.boxes=[];},
  f=>{f.prompt.text=f.put(f.exported.prompt+'\n','text/plain');f.prompt.projection.prompt=structuredClone(f.prompt.text);},
  f=>{f.c.scene='Changed after approval';f.prompt.composition.value=f.put(canonical(f.c));},
  f=>{f.c.review=null;f.prompt.composition.value=f.put(canonical(f.c));},
  f=>{f.c.id='different';f.prompt.composition.value=f.put(canonical(f.c));},
 ];
 for(const change of mutations){const f=fixture();change(f);const before=canonical(f.prompt);assert.throws(()=>readCompositionTextSource(f.prompt,f.read),evidenceMismatch);assert.equal(canonical(f.prompt),before);}
});

test('original caption JSON is verified independently of valid exported prose and review',()=>{
 const f=fixture(),original=f.c.review.prompt;
 // Supply valid UTF-8 bytes with a different caption through the injected
 // reader to exercise semantic verification rather than its hash precondition.
 assert.throws(()=>readCompositionTextSource(f.prompt,ref=>ref.hash===original.hash?Buffer.from('{}'):f.read(ref)),evidenceMismatch);
 assert.throws(()=>readCompositionTextSource(f.prompt,ref=>ref.hash===original.hash?Buffer.from([0xff]):f.read(ref)),evidenceMismatch);
});

test('malformed graph JSON and malformed exported UTF-8 reject without accepting partial evidence',()=>{
 for(const body of [Buffer.from('{'),Buffer.from([0xff]),Buffer.from('null')]){const f=fixture();f.prompt.composition.value=f.put(body);assert.throws(()=>readCompositionTextSource(f.prompt,f.read),evidenceMismatch);}
 const f=fixture();f.prompt.text=f.put(Buffer.from([0xff]),'text/plain');f.prompt.projection.prompt=structuredClone(f.prompt.text);assert.throws(()=>readCompositionTextSource(f.prompt,f.read),evidenceMismatch);
});

test('storage failures preserve their identity across frozen evidence and current-source checks',()=>{
 for(const code of ['MISSING_OBJECT','CORRUPT_OBJECT','STORAGE_FAILURE']){const f=fixture(),failure=new StoreError(code),read=()=>{throw failure;};assert.throws(()=>readCompositionTextSource(f.prompt,read),error=>error===failure);assert.throws(()=>compositionTextOriginRefs(f.draft,read),error=>error===failure);assert.throws(()=>assertCurrentCompositionText(f.draft,f.state,read,f.asset),error=>error===failure);}
});

test('current authority requires the exact CompositionRef before reading its graph or assets',()=>{
 for(const change of [state=>delete state.composition,state=>state.composition=null,state=>state.composition.id='successor',state=>state.composition.value.hash='sha256:'+'a'.repeat(64),state=>state.composition.bindings.logical_layer='other']){
  const f=fixture({linked:true});let reads=0,assets=0;change(f.state);assert.throws(()=>assertCurrentCompositionText(f.draft,f.state,ref=>{reads++;return f.read(ref);},id=>{assets++;return f.asset(id);}),currentMismatch);assert.equal(reads,0);assert.equal(assets,0);
 }
});

test('current mapped image and native-text links are accepted with their exact reviewed version',()=>{
 for(const text of [false,true]){const f=fixture({linked:true,text}),before=canonical({draft:f.draft,state:f.state});assert.doesNotThrow(()=>assertCurrentCompositionText(f.draft,f.state,f.read,f.asset));assert.equal(canonical({draft:f.draft,state:f.state}),before);}
});

test('a frozen source remains readable when current included links become stale or disappear',()=>{
 for(const change of [state=>state.layers[0].version='8',state=>state.layers=[],state=>state.layers[0].id='different']){
  const f=fixture({linked:true});change(f.state);assert.equal(readCompositionTextSource(f.prompt,f.read).prompt,f.exported.prompt);assert.throws(()=>assertCurrentCompositionText(f.draft,f.state,f.read,f.asset),currentMismatch);
 }
});

test('current asset availability and native text object failures are checked through actual layerValues',()=>{
 const image=fixture({linked:true});assert.throws(()=>assertCurrentCompositionText(image.draft,image.state,image.read,()=>null),currentMismatch);
 const text=fixture({linked:true,text:true}),failure=new StoreError('MISSING_OBJECT'),source=text.state.layers[0].source;
 assert.throws(()=>assertCurrentCompositionText(text.draft,text.state,ref=>ref.hash===source.hash?(()=>{throw failure;})():text.read(ref),text.asset),error=>error===failure);
 text.objects.set(source.hash,Buffer.from('{}'));assert.throws(()=>assertCurrentCompositionText(text.draft,text.state,text.read,text.asset),error=>error instanceof StoreError&&error.code==='CORRUPT_OBJECT');
});

test('excluded linked content retains provenance but does not manufacture an active dependency',()=>{
 const f=fixture({linked:true,excluded:true});f.state.layers=[];
 assert.deepEqual(f.prompt.projection.sourceProjection.dependencies,[]);assert.deepEqual(f.prompt.projection.sourceProjection.boxes,[]);
 assert.doesNotThrow(()=>assertCurrentCompositionText(f.draft,f.state,f.read,f.asset));assert(compositionTextOriginRefs(f.draft,f.read).some(ref=>canonical(ref)===canonical(f.raw)));
});

function portable(f,text=f.exported.prompt){
 const draft=structuredClone(f.draft);draft.prompt=structuredClone(f.prompt);const specification=resolveRequest(draft,text);
 return {endpoint:'ideogram/v4.5',prompt:structuredClone(f.prompt.text),seed:null,specification,assetBindings:{},template:f.put(bodyTemplate(specification,text),'application/json'),providerReview:providerReviewV45(specification)};
}
test('portable request verification returns detached Composition provenance while preserving exact plain wire bytes',async()=>{
 const f=fixture({linked:true}),record=portable(f),before=canonical(record);f.state.composition=null;f.state.layers=[];
 portableRequestRecord(record);const refs=await verifyPortableRequest(record,async ref=>f.read(ref));
 for(const required of [f.prompt.composition.value,f.prompt.text,f.c.review.prompt,f.raw])assert(refs.some(ref=>canonical(ref)===canonical(required)));
 assert.equal(canonical(record),before);assert.equal(JSON.parse(Buffer.from(f.read(record.template)).toString()).prompt,f.exported.prompt);assert.equal(record.specification.settings.prompt.mode,'plain');assert.equal(record.providerReview.admission.state,'blocked');
});

test('portable format10 semantics refuse the Composition text subtype while ordinary V45 remains valid',async()=>{
 const f=fixture(),record=portable(f),before=canonical(record);await assert.rejects(()=>verifyPortableRequest(record,async ref=>f.read(ref),false),/Composition text requires portable format 12/);assert.equal(canonical(record),before);
 const draft=newV45Draft(f.prompt.text),specification=resolveRequest(draft,f.exported.prompt),ordinary={endpoint:'ideogram/v4.5',prompt:structuredClone(f.prompt.text),seed:null,specification,assetBindings:{},template:f.put(bodyTemplate(specification,f.exported.prompt),'application/json'),providerReview:providerReviewV45(specification)};
 assert.deepEqual(await verifyPortableRequest(ordinary,async ref=>f.read(ref),false),[]);assert.equal(ordinary.specification.settings.prompt.projection,null);assert.equal(ordinary.specification.settings.prompt.composition,null);
});

test('portable verifier refuses missing detached graph and original projection bytes with their actual storage error',async()=>{
 for(const select of [f=>f.prompt.composition.value,f=>f.c.review.prompt]){const f=fixture(),record=portable(f),ref=select(f);f.objects.delete(ref.hash);await assert.rejects(()=>verifyPortableRequest(record,async ref=>f.read(ref)),error=>error instanceof StoreError&&error.code==='MISSING_OBJECT');}
});

test('portable verifier rejects hash-valid substituted graph or prose even when request and wire references agree',async()=>{
 const source=fixture();source.c.scene='Substituted retained source';source.prompt.composition.value=source.put(canonical(source.c));const changedSource=portable(source);portableRequestRecord(changedSource);await assert.rejects(()=>verifyPortableRequest(changedSource,async ref=>source.read(ref)));
 const prose=fixture(),text=prose.exported.prompt+'\n';prose.prompt.text=prose.put(text,'text/plain');prose.prompt.projection.prompt=structuredClone(prose.prompt.text);const changedProse=portable(prose,text);portableRequestRecord(changedProse);await assert.rejects(()=>verifyPortableRequest(changedProse,async ref=>prose.read(ref)));
});
