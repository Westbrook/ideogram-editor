// Additive staged tests; run only after the coordinated overlay is promoted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,bindRequestMask,requestMaskDependencies,newDraft,resolve} from '../../dist/local/src/request/core.js';
import {createRequestRasterPlan} from '../../dist/local/src/request/raster-plan.js';
import {resolveV45Edit,newV45EditFields} from '../../dist/local/src/request/v45-edit.js';
import {bodyTemplate} from '../../dist/local/src/request/family.js';
import {requestPreparedStages} from '../../dist/local/src/request/v45-stages.js';
import {materializeTransportTemplate} from '../../dist/local/server/storage/queue-transport.js';

const text='Keep the lettering exactly: Café 東京';
const ref=(label,mediaType='application/json',byteLength='32')=>({hash:hash(label),mediaType,byteLength});
const prepared=(label,width=8,height=2)=>({blob:ref(label+'-png','image/png'),pixels:ref(label+'-pixels','application/x-ideogram-rgba8',String(width*height*4)),manifest:ref(label+'-manifest'),pixelIdentity:hash(label+'-identity'),width,height});
const original=(label)=>({assetId:label,version:'2',blob:ref(label+'-png','image/png'),pixels:ref(label+'-pixels','application/x-ideogram-rgba8','64'),width:8,height:2,scope:'single-layer',documentRevision:'3',capture:ref(label+'-capture')});
function fixture(masked=false,references=2){
 const source=original('original_source'),attached=masked?prepared('mapped_source',4,2):prepared('identity_source');
 if(!masked)attached.pixels=structuredClone(source.pixels);
 let mask=null,black=null;
 if(masked){
  mask={assetId:'original_mask',version:'4',blob:ref('original-white-mask','image/png'),pixels:ref('original-white-pixels','application/x-ideogram-rgba8','64'),width:8,height:2,sourceHash:source.pixels.hash,polarity:'white-edit',empty:false,full:false,fullAcknowledged:false,binding:bindRequestMask(source),plan:ref('authored-mask-plan')};
  mask.requestPlan=createRequestRasterPlan({document:{width:8,height:2},crop:{x:0,y:0,width:8,height:2},padding:{left:0,top:0,right:0,bottom:0},requestGrid:{width:4,height:2},sourcePixels:source.pixels,authoredMask:ref('hard-mask','application/x-ideogram-r16le','32'),effectiveMask:ref('effective-mask','application/x-ideogram-r16le','32'),dependenciesHash:requestMaskDependencies(source,mask),resolution:'already-contained',approvalId:'approved_mapping'});
  black={...prepared('black_mask',4,2),polarity:'black-edit',editPixels:2,keepPixels:6,sourcePixels:structuredClone(attached.pixels)};
 }
 const originals=Array.from({length:references},(_,index)=>original('reference_'+index)),inputs=originals.map((original,index)=>({...prepared('prepared_reference_'+index),pixels:structuredClone(original.pixels)}));
 const pure=resolveV45Edit({operation:masked?'inpaint-v45':'transform-v45',prompt:text,promptMode:'plain',fields:{...newV45EditFields(masked?'inpaint-v45':'transform-v45'),seed:'900719925474099312345'},source:attached,mask:black,references:inputs});
 const {source:ignoredSource,mask:ignoredMask,references:ignoredReferences,seed,body,...model}=pure;
 const {prompt:ignoredPrompt,image_url:ignoredImage,mask_url:ignoredMaskURL,reference_image_urls:ignoredReferenceURLs,...modelBody}=body;
 return {kind:pure.kind,modelRequest:{...model,body:modelBody},settings:{prompt:{mode:'plain',text:{hash:hash(text),byteLength:String(Buffer.byteLength(text)),mediaType:'text/plain'},projection:null,composition:null},count:1,seed},source,...(mask?{mask}:{}),references:originals,preparedInputs:{assetId:'prepared_inputs',version:'1',manifest:attached.manifest,source:attached,mask:black,references:inputs}};
}
const urls=stages=>Object.fromEntries(stages.map(stage=>[stage.role,'https://fixture.invalid/upload/'+stage.role.replace(':','-')]));

for(const masked of [false,true])test('reviewed '+(masked?'masked':'regular')+' input stages bind prepared bytes and ordered references without conversion',()=>{
 const request=fixture(masked),before=structuredClone(request),stages=requestPreparedStages(request),mapping=urls(stages),template=bodyTemplate(request,text);
 assert.deepEqual(stages.map(stage=>stage.role),['source',...(masked?['mask']:[]),'reference:0','reference:1']);
 assert.deepEqual(stages[0].original,request.source.blob);assert.deepEqual(stages[0].transport,request.preparedInputs.source.blob);
 assert.deepEqual(stages[0].prepared,request.preparedInputs.source);assert.equal(stages[0].assetVersion,request.source.version);assert.equal('versionId' in stages[0],false);
 if(masked){const stage=stages[1];assert.deepEqual(stage.original,request.mask.blob);assert.deepEqual(stage.transport,request.preparedInputs.mask.blob);assert.equal(stage.prepared.polarity,'black-edit');assert.deepEqual([stage.width,stage.height],[4,2]);assert.deepEqual([request.mask.width,request.mask.height],[8,2]);}
 const wire=materializeTransportTemplate(template,request,stages,mapping,text),parsed=JSON.parse(wire);
 assert.equal(parsed.image_url,mapping.source);assert.deepEqual(parsed.reference_image_urls,[mapping['reference:0'],mapping['reference:1']]);if(masked)assert.equal(parsed.mask_url,mapping.mask);
 assert.match(wire,/"seed":900719925474099312345(?:,|})/);assert.deepEqual(request,before);
 stages[0].prepared.blob.hash=hash('mutated-stage-output');assert.deepEqual(request,before);
});

test('stage identities reject changed bytes, descriptors, source versions and reference ordering',()=>{
 const request=fixture(true),template=bodyTemplate(request,text),originalStages=requestPreparedStages(request),mapping=urls(originalStages);
 for(const mutate of [s=>s.reverse(),s=>s.pop(),s=>s.push(structuredClone(s[0])),s=>s[0].transport.byteLength='1',s=>s[0].original.hash=hash('other-original'),s=>s[0].assetVersion='99',s=>s[1].transport=structuredClone(request.mask.blob),s=>s[1].prepared.polarity='white-edit',s=>s[2].prepared.manifest.hash=hash('other-reference-manifest'),s=>s[3].role='reference:3']){
  const changed=structuredClone(originalStages);mutate(changed);
  assert.throws(()=>materializeTransportTemplate(template,request,changed,mapping,text),error=>error.code==='CORRUPT_OBJECT');
 }
 for(const mapping of [{},{...urls(originalStages),extra:'https://fixture.invalid/extra'},{...urls(originalStages),'reference:0':''},{...urls(originalStages),'reference:1':null}])assert.throws(()=>materializeTransportTemplate(template,request,originalStages,mapping,text),error=>error.code==='MALFORMED_REQUEST');
});

test('materialization binds exact prompt bytes and the entire original serializer before substituting URLs',()=>{
 const request=fixture(true),stages=requestPreparedStages(request),mapping=urls(stages),template=bodyTemplate(request,text);
 assert.throws(()=>materializeTransportTemplate(template,request,stages,mapping),error=>error.code==='CORRUPT_OBJECT');
 assert.throws(()=>materializeTransportTemplate(template,request,stages,mapping,text+' changed'));
 assert.throws(()=>materializeTransportTemplate(template.replace('"quality":"medium"','"quality":"high"'),request,stages,mapping,text),error=>error.code==='CORRUPT_OBJECT');
 assert.throws(()=>materializeTransportTemplate(template.replace(request.preparedInputs.mask.blob.hash,request.mask.blob.hash),request,stages,mapping,text),error=>error.code==='CORRUPT_OBJECT');
});

test('empty references omit the wire field while repeated content retains distinct ordered stages',()=>{
 const empty=fixture(false,0),emptyStages=requestPreparedStages(empty),wire=materializeTransportTemplate(bodyTemplate(empty,text),empty,emptyStages,urls(emptyStages),text);
 assert.deepEqual(emptyStages.map(stage=>stage.role),['source']);assert.equal(Object.hasOwn(JSON.parse(wire),'reference_image_urls'),false);
 const repeated=fixture(false,2);repeated.references[1]=structuredClone(repeated.references[0]);repeated.preparedInputs.references[1]=structuredClone(repeated.preparedInputs.references[0]);
 const stages=requestPreparedStages(repeated),mapping=urls(stages),result=materializeTransportTemplate(bodyTemplate(repeated,text),repeated,stages,mapping,text);
 assert.deepEqual(stages.map(stage=>stage.role),['source','reference:0','reference:1']);assert.deepEqual(JSON.parse(result).reference_image_urls,[mapping['reference:0'],mapping['reference:1']]);
});

// Uploaded URLs are data, including JavaScript replacement-pattern spellings.
const dollarTokens=['$$','$&','$`',"$'"];
const literalURLs=(stages,token)=>Object.fromEntries(stages.map(stage=>{
 // Backticks remain literal in a query; apostrophes remain literal in a path.
 const value='https://fixture.invalid/upload/'+stage.role.replace(':','-')+(token==='$`'?'?exact='+token:'/'+token);
 assert.equal(new URL(value).href,value);return [stage.role,value];
}));
const fieldToken=(key,value)=>JSON.stringify(key)+':'+JSON.stringify(value);
function literalField(template,key,before,after){
 const pieces=template.split(fieldToken(key,before));assert.equal(pieces.length,2);
 return pieces[0]+fieldToken(key,after)+pieces[1];
}
for(const masked of [false,true])for(const token of dollarTokens)test('V45 '+(masked?'masked':'regular')+' transport preserves literal '+JSON.stringify(token)+' URLs, repeated reference order and exact seed bytes',()=>{
 const request=fixture(masked,masked?3:4);
 request.references[2]=structuredClone(request.references[0]);request.preparedInputs.references[2]=structuredClone(request.preparedInputs.references[0]);
 const stages=requestPreparedStages(request),mapping=literalURLs(stages,token),template=bodyTemplate(request,text),before=structuredClone({request,stages,mapping});
 let expected=literalField(template,'image_url','asset:'+request.preparedInputs.source.blob.hash,mapping.source);
 if(masked)expected=literalField(expected,'mask_url','asset:'+request.preparedInputs.mask.blob.hash,mapping.mask);
 const referenceURLs=request.references.map((_,index)=>mapping['reference:'+index]);
 expected=literalField(expected,'reference_image_urls',request.preparedInputs.references.map(input=>'asset:'+input.blob.hash),referenceURLs);
 const wire=materializeTransportTemplate(template,request,stages,mapping,text),parsed=JSON.parse(wire);
 assert.equal(wire,expected);assert.equal(parsed.image_url,mapping.source);if(masked)assert.equal(parsed.mask_url,mapping.mask);
 assert.deepEqual(parsed.reference_image_urls,referenceURLs);assert.notEqual(referenceURLs[0],referenceURLs[2]);assert.deepEqual(stages[masked?2:1].transport,stages[masked?4:3].transport);
 assert.match(wire,/"seed":900719925474099312345(?:,|})/);assert.equal(parsed.prompt,text);assert.deepEqual({request,stages,mapping},before);
});
for(const token of dollarTokens)test('V4 masked adapter transport preserves literal '+JSON.stringify(token)+' URLs and all other serialized bytes',()=>{
 const inputs=fixture(true,0),draft=newDraft(inputs.settings.prompt.text);draft.operation='inpaint-adapters';draft.source=inputs.source;draft.mask=inputs.mask;
 Object.assign(draft.fields,{size:'auto',strength:'1',seed:'900719925474099312345'});
 draft.adapters=[{version:'adapter_one',hash:hash('same-weight'),scale:'0',runtimeAcknowledged:true},{version:'adapter_two',hash:hash('same-weight'),scale:'4',runtimeAcknowledged:true}];
 const eligible={adapters:new Map(draft.adapters.map(adapter=>[adapter.version,{hash:adapter.hash,available:true,profile:'v4-safe-1',runtimeVerified:false}]))},request=resolve(draft,text,eligible),template=bodyTemplate(request,text);
 const stages=[...['source','mask'].map(role=>({role,original:request[role].blob,transport:request[role].blob,width:request[role].width,height:request[role].height,conversion:null})),...draft.adapters.map((adapter,index)=>({role:'adapter:'+index,versionId:adapter.version,original:{hash:adapter.hash,byteLength:'32',mediaType:'application/octet-stream'},transport:{hash:adapter.hash,byteLength:'32',mediaType:'application/octet-stream'}}))];
 const mapping=literalURLs(stages,token),before=structuredClone({request,stages,mapping});
 let expected=literalField(template,'image_url','asset:'+request.source.blob.hash,mapping.source);
 expected=literalField(expected,'mask_url','asset:'+request.mask.blob.hash,mapping.mask);
 const loras=request.adapters.map((adapter,index)=>({path:mapping['adapter:'+index],scale:Number(adapter.scale)}));
 expected=literalField(expected,'loras',request.adapters.map(adapter=>({path:'asset:'+adapter.hash,scale:Number(adapter.scale)})),loras);
 const wire=materializeTransportTemplate(template,request,stages,mapping),parsed=JSON.parse(wire);
 assert.equal(wire,expected);assert.equal(parsed.image_url,mapping.source);assert.equal(parsed.mask_url,mapping.mask);assert.deepEqual(parsed.loras,loras);
 assert.match(wire,/"seed":900719925474099312345(?:,|})/);assert.equal(parsed.prompt,text);assert.deepEqual({request,stages,mapping},before);
});
