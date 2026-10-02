import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {terminalWithDiagnostics} from './native-failure-diagnostics.mjs';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {rootFor,command,pair,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {operate,terminal} from '../raster/helpers.mjs';
import {upload,copy,preview} from '../portable/helpers.mjs';
import {unpack} from '../portable/archive-fixture.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {newDraft} from '../../dist/local/src/request/core.js';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {verificationBudget} from '../../dist/local/src/protocol/text-budget.js';
import {inspectReturnedDescription,makeReturnedDescriptionReview} from '../../dist/local/src/text/returned-description.js';

// Real writer, durable objects, native layout/render verifier, observer and
// portable import. Only the existing literal-loopback provider is a substitute.
const documentId='document_1',sessionId='returned_description_j19';
const returnedLiteral='Returned Cafe\u0301 東京 <b>literal</b>';
const returnedCaption=JSON.stringify({high_level_description:'A poster with a title',compositional_deconstruction:{background:'plain',elements:[{type:'obj',desc:'A poster'},{type:'text',bbox:[100,200,350,850],text:returnedLiteral,desc:'Blue title lettering'}]}});
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const identify=value=>({...value,id:sha(canonical(value))});
const document=async(f,id=documentId)=>(await f.read('/api/v1/documents/'+id)).json.projection.value;
const image=async(f,id=documentId)=>(await f.read('/api/v1/documents/'+id+'/image')).json;
const objectPath=(f,ref)=>join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
async function retained(f,ref){const bytes=await readFile(objectPath(f,ref));assert.equal(sha(bytes),ref.hash);assert.equal(String(bytes.length),ref.byteLength);return bytes;}
async function object(f,ref){return JSON.parse(await retained(f,ref));}
async function asset(f,id){const response=await f.read('/api/v1/assets/'+id);assert.equal(response.status,200,response.text);return response.json.projection.value;}
async function events(f,receipt){
 const response=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));assert.equal(response.status,200,response.text);const batch=response.json.batches[0];
 if(batch.kind==='inline')return batch.events;const content=await f.read(batch.content.url);assert.equal(content.status,200,content.text);assert.equal(sha(content.text),batch.content.blob.hash);return content.text.split('\n').filter(Boolean).map(JSON.parse);
}
async function run(f,body,id=documentId){
 const before=await document(f,id),request=f.command({documentId:id,expectedDocumentRevision:before.revision,body}),result=await terminal(f,request);
 assert.equal(result.json.receipt.status,'accepted',result.text);return {request,receipt:result.json.receipt,events:await events(f,result.json.receipt),document:await document(f,id)};
}
async function stage(f,bytes,purpose='caption',mediaType='text/plain'){
 const staged=await upload(f,bytes,purpose,mediaType);return (await operate(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;
}
async function ui(f,body){
 const current=(await f.read('/api/v1/ui/'+sessionId)).json,request={protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:current.uiSeq,body},response=await f.post('/api/v1/ui/'+sessionId,request);
 assert.equal(response.json.status,'accepted',response.text);return {request,value:response.json};
}
async function fixture(t){
 // Close the writer and its provider before rootFor removes diagnostic files.
 let server;t.after(()=>server?.close());const root=await rootFor(t);server=await startLocalServer({root},{writer:{setupModule:new URL('./returned-description-observer-fixture.mjs',import.meta.url).href}});
 const paired=await pair(server);assert.equal(paired.status,200,paired.text);
 const f={root,server,paired,generation:0,
  read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),
  post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),
  command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body),
  effects:async()=>{const value=JSON.parse(await readFile(join(root,'candidate-fixture.json'),'utf8'));assert.deepEqual(value.errors,[]);return value.effects;},
 };
 assert.equal((await terminal(f,f.command({}, {width:64,height:32}))).json.receipt.status,'accepted');return f;
}
async function observedCaption(f){
 const prompt=await stage(f,Buffer.from(returnedCaption)),draft=newDraft(prompt.blob);draft.prompt.mode='raw';draft.guidanceAcknowledged=true;Object.assign(draft.fields,{width:'512',height:'512',expansion:'None'});
 const saved=await stage(f,Buffer.from(canonical(draft)));await ui(f,{type:'SaveDraft',draft:{id:'caption-request',generation:'1',kind:'request',documentId,targetLayerId:null,expectedDocumentRevision:(await document(f)).revision,assetId:saved.id,composing:false}});
 const review=(await ui(f,{type:'PrepareRequestReview',draftId:'caption-request',generation:'1'})).value.review,accepted=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});
 const queued=await operate(f,{type:'QueueInference',reviewId:review.id,token:review.token,acceptanceId:accepted.request.requestId}),jobId=queued.event.payload.id;
 let value;const deadline=Date.now()+20000;
 do{const response=await f.read('/api/v1/jobs/'+jobId+'/candidates');if(response.status===200)value=response.json;if(value?.items[0]?.state==='prepared'&&value.provenance?.inspection==='supported')break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
 assert.equal(value?.items[0]?.state,'prepared',JSON.stringify(value));assert.equal(value.provenance?.inspection,'supported');assert.equal(value.provenance.complete,true);
 const bytes=await retained(f,value.provenance.returnedPrompt);assert.equal(bytes.toString(),returnedCaption);
 const inspection=inspectReturnedDescription(bytes);assert.equal(inspection.state,'available');assert.equal(inspection.elements.length,1);assert.equal(inspection.elements[0].index,1);assert.equal(inspection.elements[0].literal,returnedLiteral);
 return {view:value,candidate:value.items[0],bytes,selected:inspection.elements[0],prompt:value.provenance.returnedPrompt};
}
async function importLocalFont(f){
 const profileBytes=await readFile('src/text/profile.json'),profile=JSON.parse(profileBytes),fontProfile=profile.fonts.find(font=>font.id==='NotoSans');assert(fontProfile);
 const source=await stage(f,await readFile('vendor/text/'+fontProfile.file),'font','application/octet-stream'),license=await stage(f,await readFile('vendor/text/'+fontProfile.licenseFile));
 const font=(await run(f,{type:'ImportFont',source:source.blob,license:license.blob,origin:'local-file',embeddingReviewed:true})).events[0].payload.asset.font;assert.equal(font.origin,'local-file');return {font,profile,profileBytes};
}
async function nativeLayout(request,fonts){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('../../dist/local/server/text/render-worker.mjs',import.meta.url),{workerData:{request,fonts},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});
  let result,error;const timer=setTimeout(()=>{error=Error('J19 native text fixture render deadline');void worker.terminate();},20000);
  worker.on('message',message=>{if(message.type==='ready')worker.postMessage({type:'admit'});else if(message.type==='result')result=message;else error=Error(JSON.stringify(message));});
  worker.on('error',value=>{error=value;});worker.on('exit',code=>{clearTimeout(timer);if(error)reject(error);else if(code||!result)reject(Error('J19 native fixture did not render'));else resolve(result);});
 });
}
async function prepareNative(f,local,{layerId='returned_text',literal='User confirmed Cafe\u0301',frame={width:48,height:24},placement={x:5,y:3},existing=null}={}){
 const {font,profile,profileBytes}=local,current=await document(f),generation=String(++f.generation),draftId='native-'+generation;
 // Transparent paint keeps the canonical fixture pixels directly reproducible;
 // glyph shaping/layout and final writer re-verification still use real workers.
 const style={primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:8,lineHeightMultiplier:1.2,fill:[40,90,190,0],align:'start',direction:'auto'};
 const token={documentId,documentRevision:current.revision,layerId,layerVersion:existing?.version??'0',sessionId,generation:Number(generation)};
 const rendered=await nativeLayout({text:literal,style,frame,token},[{path:objectPath(f,font.bytes),length:Number(font.bytes.byteLength),hash:font.bytes.hash,origin:font.origin,licenseHash:font.licenseRecord.hash}]);
 const put=async bytes=>(await stage(f,bytes,'text','application/octet-stream')).blob;
 const textUtf8=(await stage(f,Buffer.from(literal))).blob,layout={...await put(Buffer.from(rendered.layout)),mediaType:'application/json'},pixels={...await put(Buffer.alloc(Math.ceil(frame.width)*Math.ceil(frame.height)*4)),mediaType:'application/x-ideogram-rgba8'};
 assert.equal(rendered.rasterHash,pixels.hash);assert.equal(rendered.layoutHash,layout.hash);assert.equal(rendered.textHash,textUtf8.hash);assert(JSON.parse(rendered.layout).paragraphs.some(p=>p.runs.length>0));
 const manifest={...await put(profileBytes),mediaType:'application/json'},text=identify({schemaVersion:1,textUtf8,style,frame,layoutPolicy:'text-layout-1',fonts:[font]});
 const dependencyHash=sha(JSON.stringify({rendererProfile:profile.id,textHash:textUtf8.hash,style,frame,fonts:[{hash:font.bytes.hash,licenseHash:font.licenseRecord.hash,faceIndex:0,format:font.format,parserProfile:font.parserProfile,fsType:font.fsType}]}));
 const render=identify({schemaVersion:1,textVersion:text.id,rendererProfile:{schemaVersion:1,id:profile.id,manifest},dependencyHash,layout,pixels,width:rendered.width,height:rendered.height,overflow:rendered.overflow,resolvedFonts:[font.id]}),source={schemaVersion:1,text,render};
 const candidate={...await put(Buffer.from(canonical({schemaVersion:1,token,source}))),mediaType:'application/json'};
 const draftValue=existing?{schemaVersion:1,kind:'text-draft-1',textUtf8,style,frame,fonts:[font]}:{schemaVersion:2,kind:'text-draft-2',textUtf8,style,frame,fonts:[font],placement};
 const draft=await stage(f,Buffer.from(canonical(draftValue)));await ui(f,{type:'SaveDraft',draft:{id:draftId,generation,kind:'text',documentId,targetLayerId:existing?.id??null,expectedDocumentRevision:current.revision,assetId:draft.id,composing:false}});
 return {layerId,literal,source,candidate,placement,document:current,generation,draft:{sessionId,draftId,generation},budget:verificationBudget(literal,frame.width,frame.height,Number(font.bytes.byteLength),profile.engine.wasm.bytes)};
}
function descriptionReview(observed,prepared,patch={}){
 return makeReturnedDescriptionReview({id:randomUUID(),jobId:observed.candidate.jobId,attemptId:observed.candidate.attemptId,returnedPrompt:observed.prompt,elementIndex:observed.selected.index,elementHash:observed.selected.elementHash,documentId,documentRevision:prepared.document.revision,literal:prepared.source.text.textUtf8,frame:prepared.source.text.frame,placement:prepared.placement,style:prepared.source.text.style,fonts:prepared.source.text.fonts,placementChoice:'separate-placement',duplicationAcknowledged:true,...patch});
}
async function submitNative(f,prepared,body,{accepted=true,code,reason}={}){
 const admissionId=randomUUID()+'_'+prepared.generation+'_'+prepared.budget.bytes;assert.equal((await f.post('/api/v1/text-admission/'+admissionId,{protocolVersion:1})).status,200);
 try{
  const before=await document(f),beforeImage=await image(f),request=f.command({sessionId,documentId,expectedDocumentRevision:before.revision,body:{layerId:prepared.layerId,candidate:prepared.candidate,draft:prepared.draft,admissionId,...body}}),response=await terminalWithDiagnostics(f,request,{documentId:before.id,documentRevision:before.revision,layerId:prepared.layerId,generation:prepared.generation,admissionId,admissionBudgetBytes:prepared.budget.bytes,rendererProfile:prepared.source.render.rendererProfile.id,frame:prepared.source.text.frame});
  assert.equal(response.json.receipt.status,accepted?'accepted':'rejected',response.text);
  if(accepted)return {receipt:response.json.receipt,events:await events(f,response.json.receipt),document:await document(f),layer:(await image(f)).layers.find(l=>l.id===prepared.layerId)};
  if(code)assert.equal(response.json.receipt.code,code,response.text);if(reason)assert.equal((await object(f,response.json.receipt.details)).issues[0].code,reason);
  assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeImage);return response.json.receipt;
 }finally{assert.equal((await f.post('/api/v1/text-admission/'+admissionId+'/release',{protocolVersion:1})).status,200);}
}
function createBody(prepared,description){return {type:'CreateTextFromReturnedDescription',name:'User-confirmed lettering',placement:prepared.placement,description};}
async function terminalOrigin(f,layer){
 const owned=await asset(f,layer.assetId),seen=new Set();let ref=owned.retainedMetadata;assert(ref,'Native asset retains description origin');
 while(ref){assert(!seen.has(ref.hash));seen.add(ref.hash);assert(seen.size<=16);const value=await object(f,ref);if(value.kind==='created-text-description-1')return {asset:owned,ref,value};assert.equal(value.kind,'retained-raster-metadata-1');ref=value.previous;}
 assert.fail('No terminal returned-description origin');
}
async function assertArchiveRefs(f,bytes,expected){const entries=await unpack(f.root,bytes);for(const [ref,data]of expected){const member=entries.get('objects/'+ref.hash.slice(7));assert(member,'Archive retains '+ref.hash);assert.deepEqual(member,data);}return entries;}
async function importBundle(f,review){
 const request=f.command({documentId:null,expectedDocumentRevision:null,body:{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash}}),deadline=Date.now()+30000;
 let response=await f.post('/api/v1/commands',request);
 while(response.status===202&&Date.now()<deadline){assert.equal(response.headers.location,response.json.receiptUrl);await new Promise(resolve=>setTimeout(resolve,10));response=await f.read('/api/v1/commands/'+request.command.commandId);}
 assert.equal(response.status,200,response.text);assert.equal(response.json.receipt.status,'accepted',response.text);
}

test('J19 real writer creates reviewed text, retains immutable caption through edit/Undo/Redo and imports complete inert provenance',{timeout:180000},async t=>{
 const f=await fixture(t),observed=await observedCaption(f),effects=await f.effects(),local=await importLocalFont(f),before=await image(f);
 const prepared=await prepareNative(f,local,{literal:'User confirmed Cafe\u0301\nlocal draft',frame:{width:48,height:24},placement:{x:5,y:3}}),review=descriptionReview(observed,prepared),created=await submitNative(f,prepared,createBody(prepared,review));
 assert.equal(created.layer.kind,'text');assert.deepEqual(created.layer.layerToDocument,[1,0,0,1,5,3]);assert.equal((await image(f)).layers.length,before.layers.length+1);
 const accepted=await object(f,created.layer.source),origin=await terminalOrigin(f,created.layer);
 assert.deepEqual(accepted,prepared.source);assert.equal((await retained(f,accepted.text.textUtf8)).toString(),prepared.literal);assert.notEqual(prepared.literal,observed.selected.literal);
 assert.equal(accepted.text.fonts[0].origin,'local-file');assert.deepEqual(accepted.text.frame,{width:48,height:24});assert.deepEqual(origin.value.review,review);assert.equal(origin.value.createdLayerId,created.layer.id);assert.deepEqual(origin.value.createdSource,created.layer.source);
 assert.deepEqual(await retained(f,observed.prompt),observed.bytes);assert.equal((await image(f)).layers.some(l=>l.kind==='image'),false,'Creating editable text does not adopt or erase generated pixels');
 const createdState=await image(f),later=await prepareNative(f,local,{layerId:created.layer.id,literal:'Later editable revision',frame:{width:52,height:24},existing:created.layer}),edited=await submitNative(f,later,{type:'CommitTextEdit',layerVersion:created.layer.version,reviewedDependencyHash:later.source.render.dependencyHash});
 const editedState=await image(f),editedSource=await object(f,edited.layer.source),editedOrigin=await terminalOrigin(f,edited.layer);
 assert.equal((await retained(f,editedSource.text.textUtf8)).toString(),'Later editable revision');assert.notEqual(edited.layer.source.hash,created.layer.source.hash);assert.deepEqual(editedOrigin.value,origin.value);assert.deepEqual(editedOrigin.ref,origin.ref);
 assert.deepEqual(await retained(f,observed.prompt),observed.bytes);assert.deepEqual(await object(f,origin.value.createdSource),accepted);
 await run(f,{type:'Undo',historyHead:edited.document.historyHead});assert.deepEqual(await image(f),createdState);
 await run(f,{type:'Redo',historyNode:edited.document.historyHead});assert.deepEqual(await image(f),editedState);assert.deepEqual(await f.effects(),effects);

 const retainedRefs=[origin.ref,observed.prompt,created.layer.source,accepted.text.textUtf8,accepted.render.layout,accepted.render.pixels,accepted.render.rendererProfile.manifest,edited.layer.source,editedSource.text.textUtf8,editedSource.render.layout,editedSource.render.pixels,...accepted.text.fonts.flatMap(font=>[font.bytes,font.licenseRecord])];
 const expected=await Promise.all([...new Map(retainedRefs.map(ref=>[ref.hash,ref])).values()].map(async ref=>[ref,await retained(f,ref)]));
 const saved=await copy(f,documentId);await assertArchiveRefs(f,saved.bytes,expected);
 const inspected=(await preview(f,saved.bytes)).review;assert.equal(inspected.editable,true,JSON.stringify(inspected));assert.notEqual(inspected.documentId,documentId);
 await importBundle(f,inspected);
 const importedState=await image(f,inspected.documentId),importedLayer=importedState.layers.find(l=>l.kind==='text');assert(importedLayer);assert.notEqual(importedLayer.id,created.layer.id);
 const importedOrigin=await terminalOrigin(f,importedLayer);assert.deepEqual(importedOrigin.value,origin.value,'Imported observations retain their original namespace and do not become a new review');
 const importedSource=await object(f,importedLayer.source);assert.equal((await retained(f,importedSource.text.textUtf8)).toString(),'Later editable revision');
 const queue=(await f.read('/api/v1/queue')).json;assert(!queue.jobs.some(job=>job.documentId===inspected.documentId));
 const history=(await f.read('/api/v1/documents/'+inspected.documentId+'/candidates')).json.items;assert(history.length>0);assert(history.every(entry=>entry.inert));
 for(const entry of history){const response=await f.read('/api/v1/jobs/'+entry.jobId+'/candidates?attempt='+entry.attemptId);assert.equal(response.status,200,response.text);assert.equal(response.json.inert,true);assert.deepEqual(response.json.provenance.returnedPrompt,observed.prompt);}
 const recopied=await copy(f,inspected.documentId);await assertArchiveRefs(f,recopied.bytes,expected);assert.deepEqual(await f.effects(),effects);assert.deepEqual(await retained(f,observed.prompt),observed.bytes);
});

test('J19 real writer refuses forged caption, selected element, local source and stale review without creating text',{timeout:180000},async t=>{
 const f=await fixture(t),observed=await observedCaption(f),effects=await f.effects(),local=await importLocalFont(f),prepared=await prepareNative(f,local),review=descriptionReview(observed,prepared);
 const reseal=value=>{const {hash,...binding}=value;return {...binding,hash:sha(canonical(binding))};};
 const unrelated=(await stage(f,Buffer.from(returnedCaption.replace('Blue title lettering','A different retained description')))).blob;
 const literal=(await stage(f,Buffer.from('A literal absent from the prepared native source'))).blob;
 const cases=[
  {patch:{returnedPrompt:unrelated},code:'INCOMPATIBLE',reason:'SUPPORTED_RETURNED_DESCRIPTION_REQUIRED'},
  {patch:{elementHash:sha('forged selected text element')},code:'INVALID_INPUT',reason:'RETURNED_DESCRIPTION_REVIEW_CHANGED'},
  {patch:{literal},code:'INVALID_INPUT',reason:'RETURNED_DESCRIPTION_REVIEW_CHANGED'},
  {patch:{styleHash:sha('another local style')},code:'INVALID_INPUT',reason:'RETURNED_DESCRIPTION_REVIEW_CHANGED'},
  {patch:{documentRevision:'0'},code:'STALE_REVISION',reason:'RETURNED_TEXT_TARGET_CHANGED'},
 ];
 for(const {patch,code,reason}of cases){await submitNative(f,prepared,createBody(prepared,reseal({...review,...patch})),{accepted:false,code,reason});assert.equal((await image(f)).layers.length,0);assert.deepEqual(await retained(f,observed.prompt),observed.bytes);}
 // The same genuine prepared source remains usable after rejected reviews.
 const created=await submitNative(f,prepared,createBody(prepared,review));assert.equal(created.layer.kind,'text');assert.deepEqual((await terminalOrigin(f,created.layer)).value.review,review);assert.deepEqual(await f.effects(),effects);
});
