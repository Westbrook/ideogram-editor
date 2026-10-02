import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {emptyComposition,emptyElement,emptyStyle,serialize,linkField} from '../../dist/local/src/composition/core.js';
import {COMPOSITION_TEXT_LIMIT,exportCompositionText,replayCompositionText,assertCompositionTextReview,verifyCompositionTextReview,validateCompositionTextReview} from '../../dist/local/src/composition/text-export.js';

const ref=text=>({hash:'sha256:'+createHash('sha256').update(text).digest('hex'),byteLength:String(Buffer.byteLength(text)),mediaType:'text/plain'});
function approve(c,layers=[],bindings={}){const p=serialize(c,layers,bindings);c.review={serializer:'caption-json-1',sourceId:c.id,frame:structuredClone(c.frame),request:structuredClone(c.request),dependencies:p.dependencies,boxes:p.boxes,prompt:ref(p.prompt)};return c;}
const fresh=()=>emptyComposition(1600,900,'source_1');
const count=text=>Array.from(text).length;

test('deterministic model-independent prose preserves literal text, active style, palettes and included order',()=>{
 const c=fresh();c.scene='Café 東京';c.background='Paper\nwhite';c.style={...emptyStyle(),kind:'art',aesthetics:'ink',lighting:'soft',medium:'paper',photo:'INACTIVE PHOTO',artStyle:'line art',palette:['#AABBCC','#112233','#AABBCC']};
 const a=emptyElement('obj','object_1');a.desc.value='Book';a.text.value='INACTIVE OBJECT TEXT';a.palette=[];
 const b=emptyElement('text','text_1');b.desc.value='Heading';b.text.value='عربي\n👩🏾‍🔬\r\nCafe\u0301 "quoted" \\ literal';
 const excluded=emptyElement('text','excluded');excluded.text.value='EXCLUDED SECRET';excluded.excluded=true;c.elements=[a,b,excluded];approve(c);
 const before=structuredClone(c),oldJSON=serialize(c,[],{}).prompt,result=exportCompositionText(c,[],{});
 assert.deepEqual(result,exportCompositionText(c,[],{}));assert.deepEqual(c,before);assert.equal(serialize(c,[],{}).prompt,oldJSON);
 assert(result.prompt.includes('Scene: '+JSON.stringify(c.scene)));assert(result.prompt.includes('Background: '+JSON.stringify(c.background)));assert(result.prompt.includes('Requested visible text: '+JSON.stringify(b.text.value)));
 assert(result.prompt.includes('Style palette: ["#AABBCC","#112233","#AABBCC"]'));assert(result.prompt.includes('Element palette: []'));assert(result.prompt.indexOf('Description: "Book"')<result.prompt.indexOf('Description: "Heading"'));
 for(const absent of ['EXCLUDED SECRET','INACTIVE PHOTO','INACTIVE OBJECT TEXT','high_level_description','ideogram/v4','source_1'])assert(!result.prompt.includes(absent));
 assert.deepEqual(result.review.prompt,ref(result.prompt));assert.deepEqual(result.review.sourceProjection,c.review);assert.equal(result.review.serializer,'composition-text-1');
 result.review.sourceProjection.frame.width=9;assert.equal(c.frame.width,1600);assert.equal(c.review.frame.width,1600);
});

test('approved source bytes, complete source projection and exact export bytes are authority',()=>{
 const c=approve(fresh()),result=exportCompositionText(c,[],{});
 assert.doesNotThrow(()=>assertCompositionTextReview(c,[],{},result.review,result.prompt));assert.doesNotThrow(()=>verifyCompositionTextReview(c,result.review,result.prompt));
 for(const change of [c=>c.scene='changed',c=>c.review.prompt.hash='sha256:'+'a'.repeat(64),c=>c.review.prompt.byteLength='1',c=>c.review.prompt.mediaType='application/json',c=>c.review.boxes.push({elementId:'forged',projection:null}),c=>c.request.operation='changed']){
  const changed=structuredClone(c);change(changed);assert.throws(()=>exportCompositionText(changed,[],{}));
 }
 assert.throws(()=>exportCompositionText(fresh(),[],{}),/COMPOSITION_TEXT_APPROVAL_REQUIRED/);
 assert.throws(()=>assertCompositionTextReview(c,[],{},result.review,result.prompt+' '),/COMPOSITION_TEXT_REVIEW_CHANGED/);
 const changed=structuredClone(result.review);changed.prompt=ref('different');assert.throws(()=>verifyCompositionTextReview(c,changed),/COMPOSITION_TEXT_REVIEW_CHANGED/);
});

test('current links must be present and current; archival replay uses only approved retained values',()=>{
 const layer={id:'native',version:'1',kind:'text',text:'Original',appearance:'Heading',bounds:{rect:[0,0,100,100],transform:[1,0,0,1,0,0]}},bindings={native:'native'},c=fresh(),e=emptyElement('text','linked');e.text=linkField('text-content',layer);c.elements=[e];approve(c,[layer],bindings);
 const result=exportCompositionText(c,[layer],bindings);assert.deepEqual(replayCompositionText(c),result);
 assert.throws(()=>exportCompositionText(c,[],bindings),/MISSING_LINK/);assert.throws(()=>exportCompositionText(c,[{...layer,version:'2',text:'New'}],bindings),/STALE_LINK/);
 assert.throws(()=>exportCompositionText(c,[layer],{native:'other'}),/MISSING_LINK/);assert.throws(()=>exportCompositionText(c,[layer],{}),/BINDING_MAP/);
 const reapproved=structuredClone(c);reapproved.elements[0].text.lastReviewedValue='New';approve(reapproved,[layer],bindings);assert.throws(()=>verifyCompositionTextReview(reapproved,result.review,result.prompt),/COMPOSITION_TEXT_REVIEW_CHANGED/);
});

test('bounds use explicit normalized directions and retain clipping, omission and transformed approximation evidence',()=>{
 const c=fresh(),inside=emptyElement('obj','inside'),clipped=emptyElement('obj','clipped'),omitted=emptyElement('obj','omitted'),transformed=emptyElement('obj','transformed');
 inside.bounds={mode:'literal',value:{rect:[160,90,1280,180],transform:[1,0,0,1,0,0]}};
 clipped.bounds={mode:'literal',value:{rect:[-10,0,100,100],transform:[1,0,0,1,0,0]}};clipped.boundsPolicy='clip';
 omitted.bounds={mode:'literal',value:{rect:[0,0,100,100],transform:[1,0,0,1,0,0]}};omitted.boundsPolicy='omit';
 transformed.bounds={mode:'literal',value:{rect:[0,0,100,100],transform:[1,.5,.3,1,100,100]}};
 c.elements=[inside,clipped,omitted,transformed];approve(c);const result=exportCompositionText(c,[],{});
 assert(result.prompt.includes('left 100, top 100, right 900, bottom 300 on a normalized 0-1000 scale'));
 assert(result.prompt.includes('not exact pixel positions'));assert(result.prompt.includes('clipped to the reviewed frame'));assert(result.prompt.includes('omitted by the reviewed choice'));assert(result.prompt.includes('axis-aligned approximation'));
 assert.deepEqual(result.review.sourceProjection.boxes,c.review.boxes);assert.equal(result.review.sourceProjection.boxes[2].projection,null);
 const changed=structuredClone(c);changed.frame.documentToRequest[4]=1;assert.throws(()=>exportCompositionText(changed,[],{}));
});

test('the complete formatted prompt has exact 9999/10000/10001 Unicode-scalar boundaries without truncation',()=>{
 const overhead=count(exportCompositionText(approve(fresh()),[],{}).prompt);
 for(const length of [9999,10000]){const c=fresh();c.scene='a'.repeat(length-overhead);approve(c);const result=exportCompositionText(c,[],{});assert.equal(count(result.prompt),length);assert(result.prompt.includes(c.scene));}
 const c=fresh();c.scene='a'.repeat(COMPOSITION_TEXT_LIMIT+1-overhead);approve(c);const before=structuredClone(c);assert.throws(()=>exportCompositionText(c,[],{}),/COMPOSITION_TEXT_LIMIT/);assert.deepEqual(c,before);
 const astral=fresh();astral.scene='a'.repeat(10000-overhead-1)+'🦋';approve(astral);assert.equal(count(exportCompositionText(astral,[],{}).prompt),10000);
 const invalid=approve(fresh());invalid.scene='\ud800';assert.throws(()=>exportCompositionText(invalid,[],{}),/STRING_LIMIT/);
 const controls=fresh();controls.scene='\u0000'.repeat(2000);approve(controls);assert.throws(()=>exportCompositionText(controls,[],{}),/COMPOSITION_TEXT_LIMIT/);
});

test('shape validation refuses aliases, unknown fields and malformed nested evidence without conferring source authority',()=>{
 const result=exportCompositionText(approve(fresh()),[],{});assert.doesNotThrow(()=>validateCompositionTextReview(result.review));
 for(const change of [r=>r.serializer='caption-json-1',r=>r.extra=true,r=>r.sourceId='different',r=>r.prompt.byteLength='40001',r=>r.sourceProjection.extra=true,r=>r.sourceProjection.dependencies=[{elementId:'e',field:'unknown',layerId:'l',version:'1'}],r=>r.sourceProjection.boxes=[{elementId:'e',projection:{corners:[],unclipped:[],clipped:[],normalized:[],quantized:[],approximation:false,policy:'inside'}}]]){
  const changed=structuredClone(result.review);change(changed);assert.throws(()=>validateCompositionTextReview(changed));
 }
 const forged=structuredClone(result.review);forged.prompt=ref('well-shaped but unrelated');assert.doesNotThrow(()=>validateCompositionTextReview(forged));assert.throws(()=>verifyCompositionTextReview(approve(fresh()),forged),/COMPOSITION_TEXT_REVIEW_CHANGED/);
});
